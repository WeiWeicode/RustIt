/**
 * 三種儲存的介面(INTEGRATION-PLAN §3.1)。service 層只依賴這些介面,寫入順序與降級集中在 DeviceService(AGENT.md §7.2)。
 *   DeviceStore   SQL Server:唯一真相;失敗 → 503,Agent 留在本機暫存重試
 *   SnapshotStore MongoDB:快照歷史、心跳記錄;失敗只記 warn
 *   StateStore    Redis:在線狀態、content_hash 快取;失敗只記 warn,在線狀態退回本機連線表
 */
import type { ComputerInfo } from '../contracts.js';

/** retired:報廢 / 退役(PLATFORM-PLAN A1;畫面在 P3) */
export type DeviceStatus = 'active' | 'disabled' | 'retired';

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
  /** 硬體指紋(hello 的 hw_fingerprint;A1);未回報時為 null */
  hwFingerprint: string | null;
  /** 最近一次 hello 的時鐘偏差(端點 − 主機,毫秒;A2) */
  clockSkewMs: number | null;
}

/** 主機產生的稽核事件;Agent 回報的端點事件另走 addAgentEvents */
export type DeviceEventType =
  | 'registered'
  | 'fingerprint_changed'
  | 'disabled'
  | 'enabled'
  | 'duplicate_connection'
  /** 時鐘偏差超過 ±5 分鐘(A2) */
  | 'clock_skew'
  /** 硬體指紋與另一台裝置相同,疑似同一台(重灌、改名、換憑證;A1),由 IT 確認合併 */
  | 'suspected_duplicate'
  /** IT 設為退役(P3) */
  | 'retired'
  /** IT 合併:目標裝置記一筆(detail 帶來源 deviceId 與舊 DN;P3、A1) */
  | 'merged';

/** Agent 回報的端點事件(event.schema.json;PLATFORM-PLAN §4.2) */
export interface AgentEvent {
  eventUid: string;
  type: string;
  /** 端點上的發生時間 */
  occurredAt: Date;
  /** data 序列化後的 JSON(上限 4,000 字元) */
  data: string;
}

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
  /** 有其他未合併、未退役的裝置硬體指紋相同(A1) */
  suspectedDuplicate: boolean;
  /** 已併入的目標裝置 deviceId(P3) */
  mergedIntoId: string | null;
  retiredAt: Date | null;
}

/** 清單篩選(P3;皆為部分比對,大小寫不分依資料庫定序) */
export interface DeviceFilter {
  /** 電腦名稱、使用者、IP、MAC、裝置代碼 */
  q?: string;
  /** 軟體名稱 */
  software?: string;
  os?: string;
  statuses: DeviceStatus[];
}

/** 裝置事件(主機稽核 + Agent 端點事件;ita.device_event) */
export interface DeviceEventRecord {
  id: number;
  type: string;
  occurredAt: Date;
  /** 端點事件的收到時間;主機稽核為 null */
  receivedAt: Date | null;
  detail: string | null;
  /** 端點事件的 data(JSON 字串) */
  data: string | null;
}

/** 管理操作的操作人(內部 Token) */
export interface Actor {
  emp: string;
  name: string | null;
}

export interface BackfillResult {
  /** 下一批的游標;null = 已到最後 */
  lastRef: number | null;
  done: number;
  /** payload 無法解析的裝置(內部 id) */
  failed: number[];
}

export interface MergeResult {
  /** 搬到目標裝置的事件數、指令數 */
  events: number;
  commands: number;
  /** 兩台尚未結束、因合併取消的指令數 */
  canceledCommands: number;
  /** 保留哪一邊的資產('source' = 來源較新) */
  inventoryFrom: 'source' | 'target' | 'none';
}

export interface TouchPatch {
  computerName?: string;
  agentVersion?: string;
  hwFingerprint?: string;
  clockSkewMs?: number;
}

export interface DeviceStore {
  ping(): Promise<void>;
  findByDn(certDn: string): Promise<DeviceRecord | null>;
  /** 新裝置:建立登錄並寫稽核 registered */
  register(input: { certDn: string; certFp: string; computerName: string; requestId: string; at: Date }): Promise<DeviceRecord>;
  /** 同一 DN 出現新指紋(憑證續約):更新並寫稽核 fingerprint_changed(指南 §3.3) */
  updateFingerprint(device: DeviceRecord, certFp: string, requestId: string): Promise<void>;
  addEvent(device: DeviceRecord | null, type: DeviceEventType, detail: string, requestId: string): Promise<void>;
  /** Agent 端點事件:以 (裝置, eventUid) 去重,已存在的略過(重送不重複) */
  addAgentEvents(device: DeviceRecord, events: AgentEvent[], receivedAt: Date, requestId: string): Promise<void>;
  /** 更新最後回報時間;有值時一併更新電腦名稱、Agent 版本、硬體指紋、時鐘偏差 */
  touch(deviceRef: number, at: Date, patch?: TouchPatch): Promise<void>;
  /** 硬體指紋相同的其他裝置(不含已合併者;A1) */
  findByHwFingerprint(hwFingerprint: string, excludeRef: number): Promise<DeviceRecord[]>;
  currentInventory(deviceRef: number): Promise<CurrentInventory | null>;
  /** 一個交易:device_inventory upsert、device_nic 整批替換、device 的名稱 / 版本 / 時間 */
  saveInventory(device: DeviceRecord, snapshot: InventorySnapshot): Promise<void>;
  /** 內容沒變:只更新 last_seen_at、last_inventory_at */
  markInventoryUnchanged(deviceRef: number, at: Date): Promise<void>;
  /** 符合篩選的全部裝置,依電腦名稱排序(在線篩選與分頁在 service,在線狀態在 Redis) */
  listDevices(filter: DeviceFilter): Promise<DeviceRow[]>;
  getDevice(deviceId: string): Promise<{ row: DeviceRow; payload: string | null; collectedAt: Date | null } | null>;
  /** 事件新到舊(依寫入順序);beforeId 為游標 */
  listEvents(deviceRef: number, beforeId: number | undefined, limit: number): Promise<DeviceEventRecord[]>;
  /** 變更狀態並寫稽核(disabled / enabled / retired);retired 設 retired_at,改回 active 清除。已合併(並行)時不變更並回 false */
  setStatus(deviceRef: number, status: DeviceStatus, detail: string, requestId: string, actor: Actor): Promise<boolean>;
  /** 一個交易:來源併入目標(P3-DATA-DESIGN §4);檢查失敗丟 AppError */
  merge(targetRef: number, sourceRef: number, detail: string, requestId: string, actor: Actor): Promise<MergeResult>;
  /** 有資產但沒有軟體列的裝置(device_ref > afterRef),從 payload 回填 device_software;每次最多 limit 台 */
  backfillSoftware(afterRef: number, limit: number): Promise<BackfillResult>;
  close(): Promise<void>;
}

export interface SnapshotStore {
  ping(): Promise<void>;
  insertSnapshot(s: { deviceId: string; snapshot: InventorySnapshot }): Promise<void>;
  recordHeartbeat(h: { deviceId: string; at: Date; body: Record<string, unknown> }): Promise<void>;
  /** /sync 去重:已有快照的 (agent_seq, content_hash),回傳 `${seq}:${hash}`(與 Mongo 唯一索引相同;本機暫存重建後 seq 會重來) */
  seenSnapshots(deviceId: string, items: { seq: number; hash: string }[]): Promise<Set<string>>;
  /** 合併:來源裝置的快照與心跳改掛到目標(P3) */
  reassign(fromDeviceId: string, toDeviceId: string): Promise<void>;
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
  /** 合併後目標的資產可能換成來源的:清除 hash 快取,下次回報改比對 SQL */
  clearHash(deviceId: string): Promise<void>;
  close(): Promise<void>;
}

// ---------- 指令(PLATFORM-PLAN P4 §4.4;ENDPOINT-AGENT-GUIDE §8.4、§8.5;migration 0003) ----------

export type CommandState = 'queued' | 'sent' | 'acked' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired';
export type CommandLevel = 'basic' | 'admin';

export interface CommandRecord {
  id: number;
  commandId: string;
  batchRef: number | null;
  batchId: string | null;
  /** 批次同時執行上限;不屬於批次為 null */
  batchMaxConcurrent: number | null;
  deviceRef: number;
  deviceId: string;
  computerName: string;
  /** 建立當下的 DN(稽核) */
  certDn: string;
  kind: string;
  level: CommandLevel;
  /** JSON 字串 */
  params: string;
  state: CommandState;
  progress: number | null;
  /** Agent 的 result(JSON 字串) */
  resultSummary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAt: Date;
  timeoutAt: Date | null;
  sendCount: number;
  createdByEmp: string;
  createdByName: string | null;
  requestId: string | null;
  createdAt: Date;
  sentAt: Date | null;
  ackedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface NewCommand {
  commandId: string;
  deviceRef: number;
  certDn: string;
  kind: string;
  level: CommandLevel;
  params: string;
  expiresAt: Date;
  idempotencyKey: string | null;
  createdByEmp: string;
  createdByName: string | null;
  requestId: string;
  createdAt: Date;
}

export interface NewBatch {
  batchId: string;
  kind: string;
  level: CommandLevel;
  params: string;
  maxConcurrent: number;
  idempotencyKey: string | null;
  createdByEmp: string;
  createdByName: string | null;
  requestId: string;
  createdAt: Date;
}

export interface BatchRecord {
  id: number;
  batchId: string;
  kind: string;
  level: CommandLevel;
  params: string;
  targetCount: number;
  maxConcurrent: number;
  createdByEmp: string;
  createdByName: string | null;
  createdAt: Date;
  /** 各狀態台數 */
  counts: Partial<Record<CommandState, number>>;
}

/** 狀態轉換時一併寫入的欄位(各階段時間依 state 決定) */
export interface CommandPatch {
  state: CommandState;
  at: Date;
  progress?: number | null;
  resultSummary?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** acked / running 時設定(已有值不覆寫) */
  timeoutAt?: Date;
  /** 終態但沒收到 running(瞬間完成,Agent 只送最後狀態):started_at 以 acked_at(沒有則本次時間)補上 */
  markStarted?: boolean;
}

export interface CommandFilter {
  deviceRef?: number;
  batchRef?: number;
  state?: CommandState;
  kind?: string;
  /** 游標:內部 id 小於此值(新到舊) */
  beforeId?: number;
  limit: number;
}

export interface CommandStore {
  /** 一個交易:批次(可為 null)+ 各台指令 */
  createCommands(batch: NewBatch | null, commands: NewCommand[]): Promise<void>;
  getCommand(commandId: string): Promise<CommandRecord | null>;
  findByIdempotency(emp: string, key: string): Promise<CommandRecord | null>;
  findBatchByIdempotency(emp: string, key: string): Promise<BatchRecord | null>;
  getBatch(batchId: string): Promise<BatchRecord | null>;
  listCommands(filter: CommandFilter): Promise<CommandRecord[]>;
  /** 條件更新:目前狀態在 from 之內才更新,回傳是否更新(狀態只能往前,指南 §8.4) */
  transition(id: number, from: CommandState[], patch: CommandPatch): Promise<boolean>;
  /** WebSocket 斷線:該裝置 sent(尚未 acked)改回 queued */
  requeueSent(deviceRef: number): Promise<number>;
  /** 該裝置未逾期的 queued,依建立順序 */
  queuedForDevice(deviceRef: number, now: Date): Promise<CommandRecord[]>;
  /** 該批次未逾期的 queued,依建立順序 */
  queuedForBatch(batchRef: number, now: Date, limit: number): Promise<CommandRecord[]>;
  /** 批次中 sent / acked / running 的台數 */
  activeInBatch(batchRef: number): Promise<number>;
  /** 該裝置尚未結束(queued / sent / acked / running)的同類型指令數 */
  pendingCount(deviceRef: number, kind: string): Promise<number>;
  /** 逾期(queued / sent 超過 expires_at)與逾時(acked / running 超過 timeout_at)的指令 */
  dueForSweep(now: Date, limit: number): Promise<CommandRecord[]>;
}

// ---------- 指令附檔(logs.collect;PLATFORM-PLAN A4、B5;migration 0003 ita.command_file) ----------

export interface CommandFileRecord {
  id: number;
  fileId: string;
  commandRef: number;
  commandId: string;
  /** 下載顯示名稱(主機產生) */
  fileName: string;
  sizeBytes: number;
  sha256: string;
  /** 相對於 COMMAND_FILES_DIR 的路徑(主機產生) */
  storagePath: string;
  createdAt: Date;
  expiresAt: Date;
}

export type NewCommandFile = Omit<CommandFileRecord, 'id' | 'commandId'>;

export interface CommandFileStore {
  addFile(f: NewCommandFile): Promise<void>;
  /** 該指令的附檔,依建立順序 */
  listFiles(commandRef: number): Promise<CommandFileRecord[]>;
  getFile(fileId: string): Promise<CommandFileRecord | null>;
  /** 保存期限已到的附檔(清除用) */
  expiredFiles(now: Date, limit: number): Promise<CommandFileRecord[]>;
  deleteFile(id: number): Promise<void>;
}
