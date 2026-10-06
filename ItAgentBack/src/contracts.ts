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
} as const;

export function contractsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONTRACTS_DIR ?? path.resolve(process.cwd(), '../docs/contracts');
}

export function loadContract(name: 'inventory' | 'ws-envelope' | 'sync', dir = contractsDir()): Record<string, unknown> {
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
