/**
 * 資料契約(RustIt docs/contracts/,AGENT.md §7.3):Agent 與 Server 的唯一共同依據,本服務只讀、不複製。
 * 位置預設為 <服務根目錄>/../docs/contracts(npm 指令與容器都以服務根目錄為工作目錄),可用 CONTRACTS_DIR 覆寫。
 * 型別對應 rustit-collector 的 ComputerInfo(serde 輸出,snake_case);只新增欄位,舊欄位不改意義。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

export const CONTRACT_IDS = {
  inventory: 'https://giganexus.local/rustit/contracts/inventory.schema.json',
  wsEnvelope: 'https://giganexus.local/rustit/contracts/ws-envelope.schema.json',
  sync: 'https://giganexus.local/rustit/contracts/sync.schema.json',
  event: 'https://giganexus.local/rustit/contracts/event.schema.json',
  watchdog: 'https://giganexus.local/rustit/contracts/watchdog.schema.json',
} as const;

export function contractsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONTRACTS_DIR ?? path.resolve(process.cwd(), '../docs/contracts');
}

export function loadContract(name: 'inventory' | 'ws-envelope' | 'sync' | 'event' | 'watchdog', dir = contractsDir()): Record<string, unknown> {
  const file = path.join(dir, `${name}.schema.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`無法讀取資料契約 ${file}:${(err as Error).message}(CONTRACTS_DIR)`);
  }
}

/** WebSocket 信封驗證(HTTP body 由 Fastify 以 addSchema 的契約驗證) */
export function compileWsEnvelope(dir = contractsDir()): ValidateFunction<WsEnvelope> {
  const ajv = new Ajv({ allErrors: false, strict: true });
  // ajv-formats 是 CJS,ESM 匯入時 default 可能再包一層
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv) => Ajv;
  addFormats(ajv);
  return ajv.compile<WsEnvelope>(loadContract('ws-envelope', dir));
}

export interface WsEnvelope {
  v: 1;
  type: string;
  id: string;
  body?: Record<string, unknown>;
}

export interface HelloBody {
  agent_version: string;
  host_name: string;
  os_name?: string;
  os_version?: string;
  ips?: string[];
  boot_time?: number;
  /** 端點時間(A2) */
  agent_time?: string;
  /** 硬體指紋,空字串 = 無法取得(A1) */
  hw_fingerprint?: string;
  /** 裝置憑證到期日(P5 告警 cert_expiring) */
  cert_not_after?: string;
}

/** heartbeat.body.health(P5,PLATFORM-PLAN §4.3);取不到的欄位省略 */
export interface HeartbeatHealth {
  cpu_pct?: number;
  mem_used_pct?: number;
  disk_min_free_pct?: number;
  disk_min_free_drive?: string;
  uptime_s?: number;
  agent_rss_mb?: number;
}

/** 主機下發設定(ws-envelope AgentSettings;PLATFORM-PLAN §4.2) */
export interface AgentSettings {
  inventory_interval_sec: number;
  usb_events: boolean;
  /** 心跳是否附健康摘要(P5;舊版 Agent 忽略) */
  health_enabled?: boolean;
}

export interface HelloAckBody {
  device_id: string;
  heartbeat_interval_sec: number;
  server_time: string;
  clock_skew_ms?: number;
  settings_version: number;
  settings: AgentSettings;
}

/** POST /agent/v1/sync(sync.schema.json) */
export interface SyncRequest {
  last_acked_seq?: number;
  last_acked_hash?: string;
  pending: { agent_seq: number; collected_at: string; content_hash: string }[];
}

export interface SyncResponse {
  device_id: string;
  need: number[];
  skip: number[];
  server_state: { status: 'active' | 'disabled' | 'retired'; last_hash: string; last_seq?: number };
}

/** POST /agent/v1/events(event.schema.json) */
export interface EventsRequest {
  events: { event_id: string; type: string; occurred_at: string; data?: Record<string, unknown> }[];
}

/** POST /agent/v1/watchdog/report(watchdog.schema.json;P5-2) */
export interface WatchdogReportRequest {
  watchdog_version: string;
  reported_at: string;
  agent: {
    service_state: string;
    start_type: string;
    pid?: number;
    exe_present?: boolean;
    status_ok?: boolean;
    status_at?: string;
    version?: string;
    ws_connected?: boolean;
    last_heartbeat_ack?: string;
    last_error?: string;
  };
  agent_restarts_24h?: number;
  cert_not_after?: string;
  events?: EventsRequest['events'];
}

export interface WatchdogReportResponse {
  server_time: string;
  accepted: string[];
  report_interval_sec: number;
  target: null;
}

export interface EventsResponse {
  accepted: string[];
  server_time: string;
}

export interface InventoryRequest {
  agent_version: string;
  agent_seq: number;
  collected_at: string;
  content_hash: string;
  inventory: ComputerInfo;
}

export interface InventoryResponse {
  device_id: string;
  agent_seq: number;
  result: 'stored' | 'unchanged' | 'archived';
  server_time: string;
}

export interface ComputerInfo {
  system: {
    host_name: string;
    user_name: string;
    domain: string;
    part_of_domain: boolean;
    manufacturer: string;
    model: string;
    os_name: string;
    os_version: string;
    os_display_version: string;
    os_build: string;
    arch: string;
    boot_time: number;
  };
  identity: {
    bios_serial: string;
    bios_vendor: string;
    bios_version: string;
    board_manufacturer: string;
    board_product: string;
    board_serial: string;
    system_uuid: string;
  };
  cpu: { name: string; cores: number; logical: number; max_mhz: number };
  memory_total: number;
  memory_modules: { slot: string; capacity: number; speed_mhz: number; manufacturer: string; part_number: string }[];
  physical_disks: { model: string; serial: string; size: number; interface: string; media_type: string }[];
  volumes: { mount_point: string; label: string; file_system: string; total: number; available: number; removable: boolean }[];
  gpus: { name: string; driver_version: string; resolution: string }[];
  network: NetAdapter[];
  software: { name: string; version: string; publisher: string; install_date: string }[];
  security: {
    antivirus: { name: string; enabled: boolean; up_to_date: boolean }[];
    recent_hotfixes: { id: string; description: string; installed_on: string }[];
  };
  usb: { storage_policy: 'Allowed' | 'Blocked' | 'Unknown'; storage_history: { friendly_name: string; serial: string }[] };
  rustdesk: { installed: boolean; version: string; exe_path: string; id: string; custom_server: string };
  collect_ms: number;
  warnings: string[];
}

export interface NetAdapter {
  description: string;
  mac: string;
  ips: string[];
  gateways: string[];
  dns: string[];
  dhcp_enabled: boolean;
}

/** 與 collector 的 ComputerInfo::primary_ipv4 相同:第一張有閘道的網卡的 IPv4,沒有就取任一 IPv4 */
export function primaryIpv4(network: NetAdapter[]): string | null {
  const isV4 = (ip: string) => ip.includes('.');
  const ordered = [...network.filter((n) => n.gateways.length > 0), ...network];
  for (const n of ordered) {
    const ip = n.ips.find(isV4);
    if (ip) return ip;
  }
  return null;
}
