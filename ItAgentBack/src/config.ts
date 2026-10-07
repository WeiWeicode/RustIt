/**
 * 設定(RustIt AGENT.md §6):Gateway 相關(GW_ENV、SERVICE_CODE=endpoint-api、GW_BASE_URL、API Key…)由 SDK loadGatewayEnv 讀取,
 * 本檔補上兩個 listener、三種儲存與 dev 旁路。缺少必要設定時啟動失敗,不加預設值繞過檢查。
 *
 *   PORT                      管理 API(endpoint-api,51240);AGENT_PORT Agent 通道(endpoint-agent,51241)
 *   HOST                      監聽位址;dev 預設 127.0.0.1(旁路開著時不可讓同網段的電腦連入),test / prod 預設 0.0.0.0(容器)
 *   ITA_DB_*                  SQL Server(唯一真相);密碼 test / prod 只接受 ITA_DB_PASSWORD_FILE
 *   MONGO_URL / REDIS_URL     含密碼的連線字串;test / prod 只接受 *_FILE
 *   AGENT_TLS_CERT_FILE / _KEY_FILE   :51241 的伺服器憑證(test / prod 必填,SAN 含 endpoint-server;指南 §5.1)
 *   AGENT_TRUSTED_PROXIES     可送 x-client-cert-* 標頭的來源(Nginx 所在網段,逗號分隔 IP 或 CIDR;test / prod 必填)
 *   DEV_TRUST_CLIENT_HEADERS  dev 專用:任何來源送的 x-client-cert-* 都採信(本機 Agent 直連,不經 Nginx)
 *   DEV_SKIP_TOKEN            dev 專用:管理 API 不驗證 X-Internal-Token(本機 GigaItApp proxy 直連)
 *   MONITOR_URL + MONITOR_API_KEY_FILE        管理 API 的監控(giga-observe 服務 endpoint-api)
 *   AGENT_MONITOR_API_KEY_FILE(或 _KEY)      Agent 通道的監控(服務 endpoint-agent,另一把 Key;同一個 MONITOR_URL)
 */
import { readFileSync } from 'node:fs';
import { isGatewayPort, loadGatewayEnv, loadMonitorEnv, type GatewayEnv, type MonitorEnv } from '@giganexus/backend-sdk';

export interface SqlConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface Config {
  gateway: GatewayEnv;
  host: string;
  monitor: MonitorEnv;
  /** Agent 通道 :51241 的監控(giga-observe 服務 endpoint-agent) */
  agentMonitor: MonitorEnv;
  /** 管理 API(:51240) */
  port: number;
  /** Agent 通道(:51241) */
  agentPort: number;
  logLevel: string;
  sql: SqlConfig;
  mongoUrl: string;
  /** Mongo 資料庫名稱,依部署區分開(ita_dev / ita_test / ita_prod) */
  mongoDb: string;
  redisUrl: string;
  /** Redis key 前綴 ita:{env}:(AGENT.md §7.2) */
  redisPrefix: string;
  /** null = 不啟用 TLS(只允許 dev) */
  agentTls: { cert: Buffer; key: Buffer } | null;
  /** null = 不檢查來源(只允許 dev 且 DEV_TRUST_CLIENT_HEADERS=1) */
  trustedProxies: string[] | null;
  devSkipToken: boolean;
  /** 心跳間隔(秒,hello_ack 告訴 Agent);連續 3 次沒收到判定離線(指南 §5.3) */
  heartbeatIntervalSec: number;
  /** Mongo 快照保留天數 */
  snapshotRetentionDays: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** 讀 NAME 或 NAME_FILE(Docker secret);strictFile:test / prod 只接受 _FILE(AGENT.md §6) */
function secret(env: NodeJS.ProcessEnv, name: string, strictFile: boolean): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new ConfigError(`無法讀取 ${name}_FILE:${(err as Error).message}`);
    }
  }
  if (env[name] && strictFile) throw new ConfigError(`${name} 在 test / prod 只接受 ${name}_FILE(Docker secret)`);
  return env[name] || undefined;
}

function required<T>(name: string, v: T | undefined | null | ''): T {
  if (v === undefined || v === null || v === '') throw new ConfigError(`${name} 未設定`);
  return v;
}

function port(name: string, raw: string | undefined, fallback: number): number {
  const p = Number(raw ?? fallback);
  if (!isGatewayPort(p)) throw new ConfigError(`${name} 必須在 51200–51300(BACKEND-GUIDE.md §3):${raw}`);
  return p;
}

const flag = (v: string | undefined) => v === '1' || v === 'true';

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd?: string): Config {
  const gateway = loadGatewayEnv(env, cwd);
  const isDev = gateway.gwEnv === 'dev';

  // dev 旁路:非 dev 有設定就啟動失敗(INTEGRATION-PLAN M1、AGENT.md §6)
  for (const name of ['DEV_TRUST_CLIENT_HEADERS', 'DEV_SKIP_TOKEN'])
    if (!isDev && env[name] !== undefined) throw new ConfigError(`${name} 只能在 GW_ENV=dev 使用,${gateway.gwEnv} 不可設定`);
  const devTrustHeaders = isDev && flag(env.DEV_TRUST_CLIENT_HEADERS);

  const strict = !isDev;
  const sql: SqlConfig = {
    server: required('ITA_DB_HOST', env.ITA_DB_HOST),
    port: Number(env.ITA_DB_PORT ?? 1433),
    database: required('ITA_DB_NAME', env.ITA_DB_NAME),
    user: required('ITA_DB_USER', env.ITA_DB_USER),
    password: required('ITA_DB_PASSWORD(或 ITA_DB_PASSWORD_FILE)', secret(env, 'ITA_DB_PASSWORD', strict)),
  };

  let agentTls: Config['agentTls'] = null;
  if (env.AGENT_TLS_CERT_FILE || env.AGENT_TLS_KEY_FILE || !isDev) {
    try {
      agentTls = {
        cert: readFileSync(required('AGENT_TLS_CERT_FILE', env.AGENT_TLS_CERT_FILE)),
        key: readFileSync(required('AGENT_TLS_KEY_FILE', env.AGENT_TLS_KEY_FILE)),
      };
    } catch (err) {
      throw err instanceof ConfigError ? err : new ConfigError(`無法讀取 :51241 伺服器憑證:${(err as Error).message}`);
    }
  }

  const proxies = (env.AGENT_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!devTrustHeaders && proxies.length === 0)
    throw new ConfigError('AGENT_TRUSTED_PROXIES 未設定(Nginx 所在 IP / 網段);本機 Agent 直連開發時改設 DEV_TRUST_CLIENT_HEADERS=1');

  return {
    gateway,
    monitor: loadMonitorEnv(gateway.gwEnv, env),
    agentMonitor: loadMonitorEnv(gateway.gwEnv, { ...env, MONITOR_API_KEY: env.AGENT_MONITOR_API_KEY, MONITOR_API_KEY_FILE: env.AGENT_MONITOR_API_KEY_FILE }),
    host: env.HOST ?? (isDev ? '127.0.0.1' : '0.0.0.0'),
    port: port('PORT', env.PORT, 51240),
    agentPort: port('AGENT_PORT', env.AGENT_PORT, 51241),
    logLevel: env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    sql,
    mongoUrl: required('MONGO_URL(或 MONGO_URL_FILE)', secret(env, 'MONGO_URL', strict)),
    mongoDb: `ita_${gateway.gwEnv}`,
    redisUrl: required('REDIS_URL(或 REDIS_URL_FILE)', secret(env, 'REDIS_URL', strict)),
    redisPrefix: `ita:${gateway.gwEnv}:`,
    agentTls,
    trustedProxies: devTrustHeaders ? null : proxies,
    devSkipToken: isDev && flag(env.DEV_SKIP_TOKEN),
    heartbeatIntervalSec: 30,
    snapshotRetentionDays: Number(env.SNAPSHOT_RETENTION_DAYS ?? 90),
  };
}
