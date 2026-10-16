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
 *   AGENT_INVENTORY_INTERVAL_SEC / AGENT_USB_EVENTS   主機下發給 Agent 的設定(hello_ack.settings;PLATFORM-PLAN §4.2),預設 3600 / 1
 *   AGENT_MAX_INFLIGHT / AGENT_BUSY_RETRY_AFTER_SEC  HTTPS 回報同時處理上限,超過回 429 + Retry-After(A3),預設 32 / 30
 *   COMMAND_FILES_DIR         指令附檔(logs.collect 日誌 zip)存放目錄;test / prod 必填(容器 /data/command-files),dev 預設 data/dev/command-files
 *   COMMAND_FILE_KEEP_DAYS    指令附檔保存天數 14–30,預設 14(PLATFORM-PLAN B5)
 *   ENDPOINT_SCOPE_ALL_ROLES  可管理所有公司的角色代碼(逗號分隔;內部 Token 的 roles 有任一個即全部公司;E6)。test / prod 必須設定,
 *                             要沒有人能看全部時明確設為空字串;dev 預設空
 *   ENDPOINT_COMPANY_DOMAINS  網域 → 公司(`公司=網域,網域;公司=網域`,公司名稱同 Gateway comp_name);省略 = 不自動判定(E6 §3.2)
 */
import { readFileSync } from 'node:fs';
import { isGatewayPort, loadGatewayEnv, loadMonitorEnv, type GatewayEnv, type MonitorEnv } from '@giganexus/backend-sdk';
import type { AgentSettings } from './contracts.js';
import { parseCompanyDomains } from './services/company.js';

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
  /** 主機下發設定(全部裝置相同;逐台設定待 GigaItApp 畫面) */
  agentSettings: AgentSettings;
  /** HTTPS 回報同時處理上限;超過回 429(A3) */
  agentMaxInflight: number;
  /** 429 的 Retry-After(秒) */
  busyRetryAfterSec: number;
  /** 指令附檔存放目錄(P4-2) */
  commandFilesDir: string;
  /** 指令附檔保存天數(B5) */
  commandFileKeepDays: number;
  /** 可管理所有公司的角色代碼(E6) */
  scopeAllRoles: string[];
  /** 網域(小寫)→ 公司(E6) */
  companyDomains: Map<string, string>;
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

function int(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} 必須是 ${min}–${max} 的整數:${raw}`);
  return n;
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

  // 資料範圍(E6):漏設會讓所有人看不到未指定公司的電腦而誤以為故障,test / prod 必須明確設定(可為空字串)
  if (!isDev && env.ENDPOINT_SCOPE_ALL_ROLES === undefined)
    throw new ConfigError('ENDPOINT_SCOPE_ALL_ROLES 未設定(可管理所有公司的角色代碼,逗號分隔;要沒有人能看全部請明確設為空字串)');
  const scopeAllRoles = [
    ...new Set(
      (env.ENDPOINT_SCOPE_ALL_ROLES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  let companyDomains: Map<string, string>;
  try {
    companyDomains = parseCompanyDomains(env.ENDPOINT_COMPANY_DOMAINS);
  } catch (err) {
    throw new ConfigError(`ENDPOINT_COMPANY_DOMAINS 格式錯誤:${(err as Error).message}`);
  }

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
    agentSettings: {
      inventory_interval_sec: int('AGENT_INVENTORY_INTERVAL_SEC', env.AGENT_INVENTORY_INTERVAL_SEC, 3600, 300, 86400),
      usb_events: env.AGENT_USB_EVENTS === undefined ? true : flag(env.AGENT_USB_EVENTS),
    },
    agentMaxInflight: int('AGENT_MAX_INFLIGHT', env.AGENT_MAX_INFLIGHT, 32, 1, 10000),
    busyRetryAfterSec: int('AGENT_BUSY_RETRY_AFTER_SEC', env.AGENT_BUSY_RETRY_AFTER_SEC, 30, 1, 3600),
    commandFilesDir: isDev ? env.COMMAND_FILES_DIR || 'data/dev/command-files' : required('COMMAND_FILES_DIR', env.COMMAND_FILES_DIR),
    commandFileKeepDays: int('COMMAND_FILE_KEEP_DAYS', env.COMMAND_FILE_KEEP_DAYS, 14, 14, 30),
    scopeAllRoles,
    companyDomains,
  };
}
