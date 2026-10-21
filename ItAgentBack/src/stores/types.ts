/**
 * 三種儲存的介面(INTEGRATION-PLAN §3.1)。service 層只依賴這些介面,寫入順序與降級集中在 DeviceService(AGENT.md §7.2)。
 *   DeviceStore   SQL Server:唯一真相;失敗 → 503,Agent 留在本機暫存重試
 *   SnapshotStore MongoDB:快照歷史、心跳記錄;失敗只記 warn
 *   StateStore    Redis:在線狀態、content_hash 快取;失敗只記 warn,在線狀態退回本機連線表
 */
import type { ComputerInfo } from '../contracts.js';

/** retired:報廢 / 退役(PLATFORM-PLAN A1;畫面在 P3) */
export type DeviceStatus = 'active' | 'disabled' | 'retired';

/** 所屬公司的判定來源(E6-COMPANY-SCOPE-DESIGN §3.3):cert 憑證 DN、domain Agent 回報的網域、manual IT 指定(之後不自動改) */
export type CompanySource = 'cert' | 'domain' | 'manual';

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
  /** 所屬公司(Gateway 公司名稱,同內部 Token 的 cos;E6);null = 未指定 */
  company: string | null;
  companySource: CompanySource | null;
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
  | 'merged'
  /** 所屬公司變更(自動判定或 IT 指定;E6) */
  | 'company_changed'
  /** 開始下載版本檔(從第 0 位元組起的請求;P6) */
  | 'release_download'
  /** 開始下載軟體套件(從第 0 位元組起的請求,每台每套件每小時一筆;P7) */
  | 'package_download';

/** Agent 回報的端點事件(event.schema.json;PLATFORM-PLAN §4.2) */
export interface AgentEvent {
  eventUid: string;
  type: string;
  /** 端點上的發生時間 */
  occurredAt: Date;
  /** data 序列化後的 JSON(上限 4,000 字元) */
  data: string;
}

/** 主機比對產生的事件(軟硬體變更;event_uid NULL,內容在 data) */
export interface HostEventInput {
  type: string;
  data: Record<string, unknown>;
}

export interface SavedHostEvent extends HostEventInput {
  /** device_event.id */
  id: number;
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
  /** 最新資產的 part_of_domain(公司自動判定用) */
  partOfDomain: boolean | null;
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
  /** 資料範圍(E6):只列這些公司;undefined = 不限(全部公司角色)。不含未指定公司的裝置 */
  companies?: string[];
  /** 指定一家公司;null = 只列未指定公司的裝置;undefined = 不篩選 */
  company?: string | null;
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

/** 變更所屬公司(E6) */
export interface CompanyChange {
  company: string | null;
  source: CompanySource | null;
  /** auto:只在目前來源為未判定或 domain 時變更(收到資產、啟動回填);manual:IT 指定 */
  mode: 'auto' | 'manual';
  detail: string;
  requestId: string;
  /** 寫入 updated_by:工號或 agent */
  by: string;
}

/** 啟動回填用:尚未判定公司的裝置 */
export interface CompanyCandidate {
  id: number;
  deviceId: string;
  certDn: string;
  domain: string | null;
  partOfDomain: boolean | null;
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
  register(input: {
    certDn: string;
    certFp: string;
    computerName: string;
    requestId: string;
    at: Date;
    company?: string | null;
    companySource?: CompanySource | null;
  }): Promise<DeviceRecord>;
  /** 同一 DN 出現新指紋(憑證續約):更新並寫稽核 fingerprint_changed(指南 §3.3) */
  updateFingerprint(device: DeviceRecord, certFp: string, requestId: string): Promise<void>;
  addEvent(device: DeviceRecord | null, type: DeviceEventType, detail: string, requestId: string): Promise<void>;
  /** Agent 端點事件:以 (裝置, eventUid) 去重,已存在的略過(重送不重複);回傳這次真正新增的 eventUid */
  addAgentEvents(device: DeviceRecord, events: AgentEvent[], receivedAt: Date, requestId: string): Promise<string[]>;
  /** 更新最後回報時間;有值時一併更新電腦名稱、Agent 版本、硬體指紋、時鐘偏差 */
  touch(deviceRef: number, at: Date, patch?: TouchPatch): Promise<void>;
  /** 硬體指紋相同的其他裝置(不含已合併者;A1) */
  findByHwFingerprint(hwFingerprint: string, excludeRef: number): Promise<DeviceRecord[]>;
  currentInventory(deviceRef: number): Promise<CurrentInventory | null>;
  /**
   * 一個交易:device_inventory upsert、device_nic 整批替換、device 的名稱 / 版本 / 時間。
   * 有 diff 時在同一交易讀出舊 payload(鎖定)交給 diff 比對,回傳的主機事件一併寫入 device_event(P5,PLATFORM-PLAN §4.3);回傳已寫入的事件
   */
  saveInventory(device: DeviceRecord, snapshot: InventorySnapshot, diff?: (prevPayload: string | null) => HostEventInput[]): Promise<SavedHostEvent[]>;
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
  /**
   * 變更所屬公司並寫稽核 company_changed(manual 一律寫,auto 只在公司有變時寫);已合併、或 auto 但來源已是 cert / manual 時不變更。
   * 回傳是否變更;找不到或不符條件回 false
   */
  setCompany(deviceRef: number, change: CompanyChange): Promise<boolean>;
  /** 尚未判定公司(company_source IS NULL)、未合併的裝置(id > afterRef),附最新資產的網域;依 id 排序 */
  companyCandidates(afterRef: number, limit: number): Promise<CompanyCandidate[]>;
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
  /** 健康走勢:since 之後的心跳健康摘要,依時間排序(P5;心跳保留 1 天) */
  healthSince(deviceId: string, since: Date, limit: number): Promise<{ at: Date; health: Record<string, unknown> }[]>;
  close(): Promise<void>;
}

export interface OnlineInfo {
  connectedAt: string;
  lastHeartbeatAt: string;
  agentVersion: string | null;
  /** 最近一則心跳的健康摘要(P5;舊版 Agent 沒有) */
  health?: HealthSample;
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
/** 批次狀態(migration 0008;P7 B1 第二人核可) */
export type BatchState = 'pending_approval' | 'running' | 'done' | 'rejected' | 'expired';

export interface CommandRecord {
  id: number;
  commandId: string;
  batchRef: number | null;
  batchId: string | null;
  /** 批次同時執行上限;不屬於批次為 null */
  batchMaxConcurrent: number | null;
  /** 批次狀態(B1 第二人核可);不屬於批次為 null。pending_approval / rejected / expired 的批次指令不送出 */
  batchState: BatchState | null;
  deviceRef: number;
  deviceId: string;
  computerName: string;
  /** 裝置目前的所屬公司(資料範圍檢查用;E6 §2 第 7 項:指令跟著裝置) */
  deviceCompany: string | null;
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
  /** 需第二人核可(> BATCH_APPROVAL_THRESHOLD 台):state = pending_approval */
  requiresApproval: boolean;
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
  state: BatchState;
  requiresApproval: boolean;
  approvedByEmp: string | null;
  approvedByName: string | null;
  approvedAt: Date | null;
  rejectedByEmp: string | null;
  rejectedByName: string | null;
  rejectedAt: Date | null;
  rejectReason: string | null;
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
  /** 資料範圍(E6):只列這些公司的裝置的指令;undefined = 不限 */
  companies?: string[];
  limit: number;
}

export interface CommandStore {
  /** 一個交易:批次(可為 null)+ 各台指令 */
  createCommands(batch: NewBatch | null, commands: NewCommand[]): Promise<void>;
  getCommand(commandId: string): Promise<CommandRecord | null>;
  findByIdempotency(emp: string, key: string): Promise<CommandRecord | null>;
  findBatchByIdempotency(emp: string, key: string): Promise<BatchRecord | null>;
  getBatch(batchId: string): Promise<BatchRecord | null>;
  /** 批次內各裝置目前的所屬公司(去重;資料範圍檢查用,E6) */
  batchCompanies(batchRef: number): Promise<(string | null)[]>;
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
  /**
   * 第二人核可(B1):pending_approval → running,核可人 ≠ 建立人才更新;同一交易把批次內 queued 指令的 expires_at 改為 expiresAt
   * (待核可期間不倒數)。回傳是否更新
   */
  approveBatch(batchRef: number, actor: Actor, at: Date, expiresAt: Date): Promise<boolean>;
  /** pending_approval → rejected;同一交易取消批次內 queued 指令 */
  rejectBatch(batchRef: number, actor: Actor, at: Date, reason: string): Promise<boolean>;
  /** created_at 早於 createdBefore 的 pending_approval → expired,批次內 queued 指令取消;回傳逾期的批次數 */
  expirePendingBatches(createdBefore: Date, at: Date): Promise<number>;
  /** running 且所有指令都已結束 → done */
  finishBatchIfDone(batchRef: number): Promise<void>;
  /** 這些類型 sent / acked / running 的總數(全域並行上限) */
  activeOfKinds(kinds: readonly string[]): Promise<number>;
  /** 這些類型未逾期的 queued(不屬於批次、或批次 running),內部 id 大於 afterId,依 id(建立順序) */
  queuedOfKinds(kinds: readonly string[], now: Date, limit: number, afterId?: number): Promise<CommandRecord[]>;
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

// ---------- 監測(PLATFORM-PLAN P5 §4.3、A5;P5-MONITOR-DESIGN;migration 0006) ----------

/** 心跳的健康摘要(ws-envelope HeartbeatBody.health;取不到的欄位省略) */
export interface HealthSample {
  cpuPct?: number;
  memUsedPct?: number;
  diskMinFreePct?: number;
  diskMinFreeDrive?: string;
  uptimeS?: number;
  agentRssMb?: number;
}

/** ita.device_health 一列 */
export interface DeviceHealthRecord extends HealthSample {
  deviceRef: number;
  healthAt: Date | null;
  certNotAfter: Date | null;
  watchdogVersion: string | null;
  watchdogReportAt: Date | null;
  agentServiceState: string | null;
  agentStartType: string | null;
  agentStatusOk: boolean | null;
  agentLastError: string | null;
  agentRestarts24h: number | null;
}

export type AlertRule =
  | 'offline_long'
  | 'disk_low'
  | 'hardware_changed'
  | 'agent_restarts'
  | 'cert_expiring'
  | 'clock_skew'
  | 'agent_tampered'
  | 'agent_silent'
  /** P6:同一目標版本升級失敗 2 次或還原失敗 */
  | 'upgrade_failed'
  /** P6:發佈環目標設定超過 24 小時仍未到目標版本 */
  | 'version_mismatch'
  /** P7:software.install 失敗(同一台再派送同一套件成功時自動關閉) */
  | 'software_install_failed'
  /** P7:安裝回報需要重新開機(3010 / 1641)超過 7 天仍未重開機 */
  | 'reboot_pending'
  /** P7(D4):軟體庫的安裝檔與登錄的雜湊不符(檔案被換掉);開在要求下載的那台裝置 */
  | 'software_file_tampered';
export type AlertSeverity = 'warn' | 'critical';
export type AlertState = 'open' | 'resolved';

export interface AlertRecord {
  id: number;
  alertId: string;
  deviceRef: number;
  deviceId: string;
  computerName: string;
  /** 資料範圍檢查用(E6) */
  deviceCompany: string | null;
  rule: AlertRule;
  severity: AlertSeverity;
  state: AlertState;
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolvedBy: 'auto' | 'manual' | null;
  resolvedByEmp: string | null;
  resolvedByName: string | null;
  resolveNote: string | null;
  /** JSON 字串 */
  detail: string | null;
  eventRef: number | null;
}

/** 開告警;同一台同一規則已有未結束的就更新 last_seen_at / detail / severity */
export interface AlertOpen {
  deviceRef: number;
  rule: AlertRule;
  severity: AlertSeverity;
  detail: string;
  eventRef?: number | null;
  /** 已有未結束的告警時保留原本的 detail(事件類:第一次的變更前後不被後來的覆蓋) */
  keepDetail?: boolean;
  at: Date;
}

export interface AlertFilter {
  state?: AlertState;
  rule?: AlertRule;
  severity?: AlertSeverity;
  deviceRef?: number;
  beforeId?: number;
  companies?: string[];
  limit: number;
}

/** 規則評估用:一台 active、未合併的裝置目前的狀態 */
export interface MonitorTarget {
  deviceRef: number;
  lastSeenAt: Date;
  clockSkewMs: number | null;
  health: DeviceHealthRecord | null;
  /** 24 小時內 agent_started.previous_exit = unexpected 的筆數 */
  unexpectedRestarts24h: number;
  /** 目前未結束的告警規則 */
  openRules: AlertRule[];
  /** P7:最早一筆「成功且 reboot_required」且晚於開機時間的 software.* 指令完成時間;沒有為 null */
  rebootRequiredSince: Date | null;
}

/** Watchdog 回報的 Agent 狀態(P5-2;ita.device_health 的 Watchdog 欄位) */
export interface WatchdogState {
  version: string;
  reportAt: Date;
  agentServiceState: string;
  agentStartType: string;
  agentStatusOk: boolean | null;
  agentLastError: string | null;
  agentRestarts24h: number | null;
}

export interface MonitorStore {
  /** Watchdog 回報(upsert,P5-2) */
  saveWatchdog(deviceRef: number, w: WatchdogState): Promise<void>;
  /** 健康摘要落盤(upsert) */
  saveHealth(deviceRef: number, at: Date, sample: HealthSample): Promise<void>;
  /** 裝置憑證到期日(hello;upsert) */
  saveCertNotAfter(deviceRef: number, notAfter: Date): Promise<void>;
  healthOf(deviceRefs: number[]): Promise<Map<number, DeviceHealthRecord>>;
  /** active、未合併的裝置與評估所需資料(since:重啟次數的起算時間) */
  monitorTargets(since: Date): Promise<MonitorTarget[]>;
  /** 回傳 alertId 與是否新開 */
  openAlert(a: AlertOpen): Promise<{ alertId: string; created: boolean }>;
  /** 條件消失:自動關閉;回傳是否有關閉 */
  resolveAuto(deviceRef: number, rule: AlertRule, at: Date, note: string): Promise<boolean>;
  /** 停用 / 退役 / 已合併裝置的未結束告警一律自動關閉,回傳筆數 */
  resolveInactive(at: Date): Promise<number>;
  /** 手動關閉:只關 open 的,回傳是否關閉 */
  resolveManual(alertId: string, at: Date, actor: Actor, note: string, requestId: string): Promise<boolean>;
  getAlert(alertId: string): Promise<AlertRecord | null>;
  listAlerts(filter: AlertFilter): Promise<AlertRecord[]>;
  /** 各裝置未結束告警數 */
  openAlertCounts(deviceRefs: number[]): Promise<Map<number, number>>;
}

// ---------- 升級(PLATFORM-PLAN P6 §4.5;P6-UPGRADE-DESIGN;migration 0007) ----------

/** 這一階段可升級的元件(desktop 到 P8,資料表先允許) */
export type ReleaseComponent = 'agent' | 'watchdog';
export type ReleaseStatus = 'draft' | 'published' | 'revoked';
export type Ring = 'pilot' | 'it' | 'all';
export type UpgradeState = 'pending' | 'downloading' | 'verifying' | 'installing' | 'succeeded' | 'failed' | 'rolled_back';

export interface ReleaseRecord {
  id: number;
  releaseId: string;
  component: ReleaseComponent;
  version: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  signerThumbprints: string[];
  status: ReleaseStatus;
  notes: string | null;
  createdByEmp: string;
  createdByName: string | null;
  createdAt: Date;
  publishedByEmp: string | null;
  publishedAt: Date | null;
  revokedByEmp: string | null;
  revokedAt: Date | null;
}

export interface NewRelease {
  component: ReleaseComponent;
  version: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  signerThumbprints: string[];
  notes: string | null;
  actor: Actor;
  at: Date;
  requestId: string;
}

export interface RingRecord {
  ring: Ring;
  component: ReleaseComponent;
  targetVersion: string | null;
  /** 目前目標開始生效的時間(版本變更時才更新) */
  targetSetAt: Date | null;
  updatedByEmp: string | null;
  updatedByName: string | null;
  updatedAt: Date;
}

/** ita.device_upgrade 一列(裝置 × 元件) */
export interface DeviceUpgradeRecord {
  deviceRef: number;
  component: ReleaseComponent;
  targetVersion: string | null;
  fromVersion: string | null;
  state: UpgradeState;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  forcedVersion: string | null;
  forcedByEmp: string | null;
  forcedAt: Date | null;
  startedAt: Date | null;
  updatedAt: Date;
}

export type UpgradePatch = Omit<DeviceUpgradeRecord, 'deviceRef' | 'component' | 'updatedAt'>;

/** 版本選擇與告警評估用:一台 active、未合併的裝置 */
export interface UpgradeTargetRow {
  deviceRef: number;
  deviceId: string;
  company: string | null;
  ring: Ring;
  lastSeenAt: Date;
  agentVersion: string | null;
  watchdogVersion: string | null;
  watchdogReportAt: Date | null;
  upgrades: DeviceUpgradeRecord[];
  /** 目前未結束的升級類告警(upgrade_failed / version_mismatch) */
  openRules: AlertRule[];
}

export interface ReleaseStore {
  listReleases(f: { component?: ReleaseComponent; status?: ReleaseStatus }): Promise<ReleaseRecord[]>;
  getRelease(releaseId: string): Promise<ReleaseRecord | null>;
  findRelease(component: ReleaseComponent, version: string): Promise<ReleaseRecord | null>;
  /** 同一元件同一版本已存在丟 AppError 409 ITA_RELEASE_EXISTS */
  addRelease(r: NewRelease): Promise<ReleaseRecord>;
  /**
   * 條件更新狀態(from 之內才更新);revoked 時同一交易把以此版本為目標的環改為 NULL、清除指定此版本的強制升級。
   * 回傳是否更新與被清除目標的環
   */
  setReleaseStatus(releaseId: string, from: ReleaseStatus[], to: ReleaseStatus, actor: Actor, at: Date, requestId: string): Promise<{ ok: boolean; clearedRings: Ring[] }>;
  listRings(): Promise<RingRecord[]>;
  /** 版本不變時只更新操作人,不更新 target_set_at */
  setRingTarget(ring: Ring, component: ReleaseComponent, version: string | null, actor: Actor, at: Date, requestId: string): Promise<void>;
  setDeviceRing(deviceRef: number, ring: Ring): Promise<void>;
  deviceRing(deviceRef: number): Promise<Ring | null>;
  deviceUpgrades(deviceRef: number): Promise<DeviceUpgradeRecord[]>;
  /** upsert(裝置 × 元件) */
  saveUpgrade(deviceRef: number, component: ReleaseComponent, patch: UpgradePatch, at: Date): Promise<void>;
  /** 有目標版本、pending 且 pendingSince 之後更新,或 downloading ~ installing 且 activeSince 之後更新的台數(同時升級上限) */
  activeUpgrades(pendingSince: Date, activeSince: Date): Promise<number>;
  /** active、未合併的裝置(companies:資料範圍,undefined = 全部;deviceRef:只查這一台) */
  upgradeTargets(companies?: string[], deviceRef?: number): Promise<UpgradeTargetRow[]>;
}

// ---------- 軟體派送(PLATFORM-PLAN P7 §4.6;P7-SOFTWARE-DESIGN;migration 0008) ----------

export type InstallerType = 'msi' | 'inno' | 'nsis' | 'burn' | 'exe';
export type DetectType = 'msi_product_code' | 'display_name';
export type RebootPolicy = 'never' | 'required';
export type PackageStatus = 'draft' | 'tested' | 'published' | 'revoked';

export interface PackageRecord {
  id: number;
  packageId: string;
  name: string;
  version: string;
  /** 軟體庫內相對路徑 {軟體}/{版本}/{檔名} */
  fileName: string;
  sha256: string;
  sizeBytes: number;
  installerType: InstallerType;
  installArgs: string | null;
  uninstallArgs: string | null;
  detectType: DetectType;
  detectValue: string;
  rebootPolicy: RebootPolicy;
  signerThumbprints: string[];
  observedSigners: string[];
  licenseLimit: number | null;
  status: PackageStatus;
  notes: string | null;
  createdByEmp: string;
  createdByName: string | null;
  createdAt: Date;
  updatedByEmp: string | null;
  updatedAt: Date | null;
  /** 最後修改安裝參數 / 偵測規則的人(發佈人不可是此人,D2-2) */
  argsChangedByEmp: string | null;
  testedByEmp: string | null;
  testedAt: Date | null;
  publishedByEmp: string | null;
  publishedByName: string | null;
  publishedAt: Date | null;
  revokedByEmp: string | null;
  revokedAt: Date | null;
}

export interface NewPackage {
  name: string;
  version: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  installerType: InstallerType;
  installArgs: string | null;
  uninstallArgs: string | null;
  detectType: DetectType;
  detectValue: string;
  rebootPolicy: RebootPolicy;
  licenseLimit: number | null;
  notes: string | null;
  actor: Actor;
  at: Date;
  requestId: string;
}

/** 可修改的欄位(undefined = 不改);revertToDraft:改到安裝參數 / 偵測規則時退回 draft 並清除 tested_* / published_* 與簽章者 */
export interface PackagePatch {
  installArgs?: string | null;
  uninstallArgs?: string | null;
  detectType?: DetectType;
  detectValue?: string;
  rebootPolicy?: RebootPolicy;
  licenseLimit?: number | null;
  notes?: string | null;
  /** 改到安裝參數 / 偵測規則:記錄修改人(args_changed_by_emp) */
  argsChanged: boolean;
  revertToDraft: boolean;
}

/** 某套件的 software.install 指令(測試機結果、標記 tested 的依據) */
export interface InstallResultRow {
  commandId: string;
  deviceId: string;
  computerName: string;
  deviceCompany: string | null;
  ring: Ring;
  state: CommandState;
  /** 參數快照(JSON 字串) */
  params: string;
  resultSummary: string | null;
  errorCode: string | null;
  createdByEmp: string;
  finishedAt: Date | null;
}

export interface SoftwareStore {
  /** q:名稱關鍵字(部分比對) */
  listPackages(f: { status?: PackageStatus; q?: string }): Promise<PackageRecord[]>;
  getPackage(packageId: string): Promise<PackageRecord | null>;
  /** 同名同版本或同一檔案已登錄丟 AppError 409 ITA_PACKAGE_EXISTS */
  addPackage(p: NewPackage): Promise<PackageRecord>;
  /** 條件更新:status 仍為 expect 才更新 */
  updatePackage(packageId: string, expect: PackageStatus, patch: PackagePatch, actor: Actor, at: Date, requestId: string): Promise<boolean>;
  /** draft → tested(寫入預期與實際簽章者) */
  markTested(packageId: string, signers: string[], observed: string[], actor: Actor, at: Date, requestId: string): Promise<boolean>;
  /** tested → published,且發佈人 ≠ created_by_emp、≠ args_changed_by_emp */
  publish(packageId: string, actor: Actor, at: Date, requestId: string): Promise<boolean>;
  /** 非 revoked → revoked;同一交易取消此套件尚未送出(queued)的 software.install */
  revoke(packageId: string, actor: Actor, at: Date, requestId: string): Promise<{ ok: boolean; canceledCommands: number }>;
  /** 此套件的 software.install 指令(新到舊) */
  installResults(packageId: string, limit: number): Promise<InstallResultRow[]>;
  /** 這台尚未結束(sent / acked / running)的 software.install 的 package_id(下載授權) */
  activeInstallPackages(deviceRef: number): Promise<string[]>;
  deviceRing(deviceRef: number): Promise<Ring | null>;
  /** 各樣式(LIKE,已跳脫)的已安裝台數:active、未合併的裝置;companies 為資料範圍(undefined = 全部) */
  installedCounts(patterns: string[], companies?: string[]): Promise<number[]>;
  /** 已安裝此樣式的裝置(active、未合併);onlyRefs 指定時只查這些裝置 */
  installedDevices(
    pattern: string,
    opts: { companies?: string[]; onlyRefs?: number[]; limit: number },
  ): Promise<{ deviceRef: number; deviceId: string; computerName: string; company: string | null; name: string; version: string | null }[]>;
}
