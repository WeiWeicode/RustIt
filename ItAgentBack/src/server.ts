/**
 * 啟動:兩個 listener、兩套信任來源,不可混用(AGENT.md §7.2)
 *   :51240 管理 API(X-Internal-Token)— 開始服務後由 setupGateway 依部署區自動註冊 OpenAPI(dev 不註冊)
 *   :51241 Agent 通道(Nginx 的 x-client-cert-*;test / prod 為 HTTPS)
 * SQL Server / Mongo / Redis 連不上時仍啟動:回報由 service 回 503 或降級,/readyz 回報狀態。
 */
import type { DepStatus } from '@giganexus/backend-sdk';
import { loadConfig } from './config.js';
import { buildAgentApp } from './agent-app.js';
import { buildMgmtApp } from './mgmt-app.js';
import { AlertService } from './services/alert-service.js';
import { CommandDispatcher, type KindHook } from './services/command-dispatcher.js';
import { AppError } from './errors.js';
import { CommandFileService } from './services/command-files.js';
import { DeviceService } from './services/device-service.js';
import { ReleaseFiles } from './services/release-files.js';
import { ReleaseService } from './services/release-service.js';
import { SoftwareFiles } from './services/software-files.js';
import { SoftwareService } from './services/software-service.js';
import { assertWritableDir, SignQueue } from './services/upload-files.js';
import { UploadService } from './services/upload-service.js';
import { SOFTWARE_KINDS } from './commands/kinds.js';
import { MongoSnapshotStore } from './stores/mongo-store.js';
import { RedisStateStore } from './stores/redis-store.js';
import { SqlCommandStore } from './stores/sql-command-store.js';
import { SqlMonitorStore } from './stores/sql-monitor-store.js';
import { SqlReleaseStore } from './stores/sql-release-store.js';
import { SqlSoftwareStore } from './stores/sql-software-store.js';
import { SqlUploadStore } from './stores/sql-upload-store.js';
import { SqlDeviceStore } from './stores/sql-store.js';

const config = loadConfig();
const sql = new SqlDeviceStore(config.sql);
const mongo = new MongoSnapshotStore(config.mongoUrl, config.mongoDb, config.snapshotRetentionDays);
const redis = new RedisStateStore(config.redisUrl, config.redisPrefix);
// 監測(P5):健康、告警與裝置共用連線池;資產比對產生的硬體變更事件交給告警
const monitorStore = new SqlMonitorStore(() => sql.connection());
let alerts: AlertService | undefined;
// 升級(P6):RELEASES_DIR 未設定時不啟用(版本 API 不註冊、Watchdog 的 target 一律 null)
let releases: ReleaseService | undefined;
const service = new DeviceService(sql, mongo, redis, {
  heartbeatIntervalSec: config.heartbeatIntervalSec,
  settings: config.agentSettings,
  companyDomains: config.companyDomains,
  monitor: monitorStore,
  onHostEvents: (ctx, deviceRef, events) => alerts?.onHostEvents(ctx, deviceRef, events) ?? Promise.resolve(),
  // 兩者各自容錯(內部只記 warn),一邊失敗不影響另一邊
  onAgentEvents: async (ctx, deviceRef, events) => {
    await Promise.allSettled([alerts?.onAgentEvents(ctx, deviceRef, events), releases?.onAgentUpgradeEvents(ctx, deviceRef, events)]);
  },
  upgrades: config.releasesDir ? { onWatchdogReport: (ctx, device, req) => releases!.onWatchdogReport(ctx, device, req) } : undefined,
});
alerts = new AlertService(monitorStore, (deviceId) => service.lookup(deviceId), config.alertThresholds);
if (config.releasesDir)
  releases = new ReleaseService(
    new SqlReleaseStore(() => sql.connection()),
    new ReleaseFiles(config.releasesDir),
    monitorStore,
    sql,
    (deviceId) => service.lookup(deviceId),
    { maxConcurrent: config.releaseMaxConcurrent },
  );
// 軟體派送(P7):SOFTWARE_DIR 未設定時不啟用(軟體 API 與套件下載不註冊;software.* 指令沒有 kindHook 會被拒絕)
let commands: CommandDispatcher | undefined;
// 上傳與送簽(S1-3):INCOMING_DIR、SIGN_QUEUE_DIR 都設定且已啟用軟體派送才啟用(才需要 migration 0011);登錄時也據此檢查上傳紀錄(M1)
const uploadStore = config.softwareDir && config.incomingDir && config.signQueueDir ? new SqlUploadStore(() => sql.connection()) : undefined;
const software = config.softwareDir
  ? new SoftwareService(new SqlSoftwareStore(() => sql.connection()), new SoftwareFiles(config.softwareDir, config.softwareMaxBytes), sql, {
      commands: () => commands,
      onPackageTampered: (ctx, deviceRef, detail) => alerts!.onPackageTampered(ctx, deviceRef, detail),
      uploads: uploadStore,
    })
  : undefined;
// 啟用上傳送簽時兩個目錄要存在且可寫,否則啟動失敗(NAS 未掛載、路徑誤植時不要到核可才 ENOENT)
if (uploadStore) {
  await assertWritableDir('INCOMING_DIR', config.incomingDir!);
  await assertWritableDir('SIGN_QUEUE_DIR', config.signQueueDir!);
}
// incoming\ 讀取規則與軟體庫相同
const uploads =
  uploadStore && config.softwareDir && config.incomingDir && config.signQueueDir
    ? new UploadService(
        uploadStore,
        new SoftwareFiles(config.incomingDir, config.softwareMaxBytes),
        new SignQueue(config.signQueueDir),
        new SoftwareFiles(config.softwareDir, config.softwareMaxBytes),
        { environment: config.gateway.gwEnv, maxBytes: config.softwareMaxBytes },
      )
    : undefined;
// 指令派送(P4):SQL 與裝置共用連線池,推送經 DeviceService 的 WebSocket 連線表;agent.upgrade 建立前後交給 ReleaseService(P6);
// software.install / uninstall 由 SoftwareService 檢查並換成目錄快照、授權數(P7);admin 批次超過門檻待第二人核可(B1)
const commandStore = new SqlCommandStore(() => sql.connection());
const releaseSvc = releases;
const kindHooks: Record<string, KindHook> = {
  // 未啟用軟體派送時一律拒絕(沒有目錄快照的 software.* 不可送到 Agent)
  'software.install': { check: () => Promise.reject(softwareDisabled()) },
  'software.uninstall': { check: () => Promise.reject(softwareDisabled()) },
};
if (releaseSvc)
  kindHooks['agent.upgrade'] = {
    check: (ctx, ref, params) => releaseSvc.checkUpgradeCommand(ctx, ref, params),
    apply: (ctx, ref, params, actor) => releaseSvc.applyUpgradeCommand(ctx, ref, params, actor),
  };
if (software) {
  kindHooks['software.install'] = {
    check: (ctx, ref, params) => software.checkCommand(ctx, ref, params, 'install'),
    checkBatch: (ctx, refs, params) => software.checkLicense(ctx, refs, params),
    onFinal: (ctx, cmd, fin) =>
      fin.state === 'succeeded' || fin.state === 'failed'
        ? alerts!.onSoftwareFinal(ctx, { deviceRef: cmd.deviceRef, commandId: cmd.commandId, params: cmd.params, ...fin, state: fin.state })
        : Promise.resolve(),
  };
  kindHooks['software.uninstall'] = { check: (ctx, ref, params) => software.checkCommand(ctx, ref, params, 'uninstall') };
}
commands = new CommandDispatcher(commandStore, sql, service, {
  kindHooks,
  approvalThreshold: config.batchApprovalThreshold,
  limitedKinds: { kinds: SOFTWARE_KINDS, max: config.softwareMaxConcurrent },
});
// 指令附檔(logs.collect 日誌,P4-2):檔案在 COMMAND_FILES_DIR,索引在 ita.command_file
const files = new CommandFileService(commandStore, config.commandFilesDir, { keepDays: config.commandFileKeepDays });

function softwareDisabled(): AppError {
  return new AppError(404, 'ITA_PACKAGE_NOT_FOUND', '軟體派送未啟用(SOFTWARE_DIR 未設定)');
}

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

// 監控心跳附帶三種儲存的狀態(giga-observe 詳情面板顯示相依服務)
const deps = (): Promise<DepStatus[]> =>
  Promise.all(
    ([['mssql', sql], ['mongo', mongo], ['redis', redis]] as const).map(async ([name, store]) => {
      const t = Date.now();
      try {
        await store.ping();
        return { name, ok: true, latencyMs: Date.now() - t };
      } catch {
        return { name, ok: false, latencyMs: null };
      }
    }),
  );

const mgmt = await buildMgmtApp({ config, service, commands, files, alerts, releases, software, uploads, readiness, deps });
const agent = await buildAgentApp({ config, service, commands, files, alerts, releases, software, monitor: config.agentMonitor, deps });

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
    scopeAllRoles: config.scopeAllRoles,
    companyDomains: config.companyDomains.size,
    monitor: config.monitor.enabled,
    agentMonitor: config.agentMonitor.enabled,
    releases: !!config.releasesDir,
    software: !!config.softwareDir,
    uploads: !!uploads,
    softwareMaxConcurrent: config.softwareMaxConcurrent,
    batchApprovalThreshold: config.batchApprovalThreshold,
  },
  '服務已啟動',
);

mongo.ensureIndexes().catch((err: unknown) => mgmt.log.warn({ err }, 'MongoDB 索引建立失敗(保留期限與去重暫不生效),稍後重啟再試'));
const ready = await readiness();
if (!ready.ok) mgmt.log.error({ checks: ready.checks }, 'SQL Server 無法連線:Agent 回報將回 503,請檢查 ITA_DB_* 設定');
else if (Object.values(ready.checks).some((c) => c !== 'ok')) mgmt.log.warn({ checks: ready.checks }, 'Mongo / Redis 無法連線,以降級模式運作');
// migration 0004 之前寫入的資產回填軟體清單(P3);失敗只記 warn,下次啟動再試
if (ready.ok) void service.backfillSoftware({ log: mgmt.log, requestId: 'startup' });
// migration 0005 之前登錄的裝置判定所屬公司(E6);失敗只記 warn,下次啟動再試
if (ready.ok) void service.backfillCompany({ log: mgmt.log, requestId: 'startup' });

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
