/**
 * 啟動:兩個 listener、兩套信任來源,不可混用(AGENT.md §7.2)
 *   :51240 管理 API(X-Internal-Token)— 開始服務後由 setupGateway 依部署區自動註冊 OpenAPI(dev 不註冊)
 *   :51241 Agent 通道(Nginx 的 x-client-cert-*;test / prod 為 HTTPS)
 * SQL Server / Mongo / Redis 連不上時仍啟動:回報由 service 回 503 或降級,/readyz 回報狀態。
 */
import { loadConfig } from './config.js';
import { buildAgentApp } from './agent-app.js';
import { buildMgmtApp } from './mgmt-app.js';
import { DeviceService } from './services/device-service.js';
import { MongoSnapshotStore } from './stores/mongo-store.js';
import { RedisStateStore } from './stores/redis-store.js';
import { SqlDeviceStore } from './stores/sql-store.js';

const config = loadConfig();
const sql = new SqlDeviceStore(config.sql);
const mongo = new MongoSnapshotStore(config.mongoUrl, config.mongoDb, config.snapshotRetentionDays);
const redis = new RedisStateStore(config.redisUrl, config.redisPrefix);
const service = new DeviceService(sql, mongo, redis, { heartbeatIntervalSec: config.heartbeatIntervalSec });

const check = async (fn: () => Promise<void>) => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return `unavailable: ${(err as Error).message}`;
  }
};
const readiness = async () => {
  const checks = { sql: await check(() => sql.ping()), mongo: await check(() => mongo.ping()), redis: await check(() => redis.ping()) };
  return { ok: checks.sql === 'ok', checks };
};

const mgmt = await buildMgmtApp({ config, service, readiness });
const agent = await buildAgentApp({ config, service });

await mgmt.listen({ host: config.host, port: config.port });
await agent.listen({ host: config.host, port: config.agentPort });
mgmt.log.info(
  {
    gwEnv: config.gateway.gwEnv,
    serviceCode: config.gateway.serviceCode,
    agentPort: config.agentPort,
    agentTls: !!config.agentTls,
    devTrustClientHeaders: config.trustedProxies === null,
    devSkipToken: config.devSkipToken,
    monitor: config.monitor.enabled,
  },
  '服務已啟動',
);

mongo.ensureIndexes().catch((err: unknown) => mgmt.log.warn({ err }, 'MongoDB 索引建立失敗(保留期限與去重暫不生效),稍後重啟再試'));
const ready = await readiness();
if (!ready.ok) mgmt.log.error({ checks: ready.checks }, 'SQL Server 無法連線:Agent 回報將回 503,請檢查 ITA_DB_* 設定');
else if (Object.values(ready.checks).some((c) => c !== 'ok')) mgmt.log.warn({ checks: ready.checks }, 'Mongo / Redis 無法連線,以降級模式運作');

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    // 先關 Agent 通道(關閉所有 WebSocket),再關管理 API(送出監控緩衝),最後關閉儲存連線
    void (async () => {
      await agent.close();
      await mgmt.close();
      await Promise.allSettled([sql.close(), mongo.close(), redis.close()]);
      process.exit(0);
    })();
  });
