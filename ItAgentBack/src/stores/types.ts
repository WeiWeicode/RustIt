/**
 * 三種儲存的介面(INTEGRATION-PLAN §3.1)。service 層只依賴這些介面,寫入順序與降級集中在 DeviceService(AGENT.md §7.2)。
 *   DeviceStore   SQL Server:唯一真相;失敗 → 503,Agent 留在本機暫存重試
 *   SnapshotStore MongoDB:快照歷史、心跳記錄;失敗只記 warn
 *   StateStore    Redis:在線狀態、content_hash 快取;失敗只記 warn,在線狀態退回本機連線表
 */
import type { ComputerInfo } from '../contracts.js';

export type DeviceStatus = 'active' | 'disabled';

export interface DeviceRecord {
  /** SQL 內部主鍵 */
  id: number;
  deviceId: string;
  certDn: string;
  certFp: string;
  computerName: string;
  status: DeviceStatus;
  agentVersion: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastInventoryAt: Date | null;
}

export type DeviceEventType = 'registered' | 'fingerprint_changed' | 'disabled' | 'enabled' | 'duplicate_connection';

export interface CurrentInventory {
  agentSeq: number;
  contentHash: string;
  collectedAt: Date;
}

export interface InventorySnapshot {
  agentVersion: string;
  agentSeq: number;
  collectedAt: Date;
  receivedAt: Date;
  contentHash: string;
  inventory: ComputerInfo;
  /** 原始 JSON 字串(寫入 payload 欄位) */
  payload: string;
}

/** 清單一列(SQL 讀出,尚未合併在線狀態) */
export interface DeviceRow extends DeviceRecord {
  userName: string | null;
  domain: string | null;
  osName: string | null;
  osVersion: string | null;
  manufacturer: string | null;
  model: string | null;
  cpuName: string | null;
  memoryTotal: number | null;
  /** IPv4,依網卡順序、有閘道者優先 */
  ips: string[];
}

export interface DeviceStore {
  ping(): Promise<void>;
  findByDn(certDn: string): Promise<DeviceRecord | null>;
  /** 新裝置:建立登錄並寫稽核 registered */
  register(input: { certDn: string; certFp: string; computerName: string; requestId: string; at: Date }): Promise<DeviceRecord>;
  /** 同一 DN 出現新指紋(憑證續約):更新並寫稽核 fingerprint_changed(指南 §3.3) */
  updateFingerprint(device: DeviceRecord, certFp: string, requestId: string): Promise<void>;
  addEvent(device: DeviceRecord | null, type: DeviceEventType, detail: string, requestId: string): Promise<void>;
  /** 更新最後回報時間;有值時一併更新電腦名稱與 Agent 版本 */
  touch(deviceRef: number, at: Date, patch?: { computerName?: string; agentVersion?: string }): Promise<void>;
  currentInventory(deviceRef: number): Promise<CurrentInventory | null>;
  /** 一個交易:device_inventory upsert、device_nic 整批替換、device 的名稱 / 版本 / 時間 */
  saveInventory(device: DeviceRecord, snapshot: InventorySnapshot): Promise<void>;
  /** 內容沒變:只更新 last_seen_at、last_inventory_at */
  markInventoryUnchanged(deviceRef: number, at: Date): Promise<void>;
  listDevices(): Promise<DeviceRow[]>;
  getDevice(deviceId: string): Promise<{ row: DeviceRow; payload: string | null; collectedAt: Date | null } | null>;
  close(): Promise<void>;
}

export interface SnapshotStore {
  ping(): Promise<void>;
  insertSnapshot(s: { deviceId: string; snapshot: InventorySnapshot }): Promise<void>;
  recordHeartbeat(h: { deviceId: string; at: Date; body: Record<string, unknown> }): Promise<void>;
  close(): Promise<void>;
}

export interface OnlineInfo {
  connectedAt: string;
  lastHeartbeatAt: string;
  agentVersion: string | null;
}

export interface StateStore {
  ping(): Promise<void>;
  setOnline(deviceId: string, info: OnlineInfo, ttlSec: number): Promise<void>;
  clearOnline(deviceId: string): Promise<void>;
  /** 回傳在線的裝置(deviceId → 在線資訊) */
  onlineOf(deviceIds: string[]): Promise<Map<string, OnlineInfo>>;
  getHash(deviceId: string): Promise<string | null>;
  setHash(deviceId: string, hash: string): Promise<void>;
  close(): Promise<void>;
}
