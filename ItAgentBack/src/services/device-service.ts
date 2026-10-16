/**
 * 裝置服務:寫入順序與降級集中在這裡(INTEGRATION-PLAN §3.1、AGENT.md §7.2),路由不直接操作任何儲存。
 *
 *   回報 POST /agent/v1/inventory:比對 content_hash(Redis → SQL)→ 沒變只更新最後回報時間
 *     → 比目前資料舊(補傳)只進 Mongo 歷史 → 變了在一個交易寫 SQL → 成功後寫 Mongo 快照 → 更新 Redis → 回 200。
 *     SQL 失敗回 503(不寫其他兩者);Mongo / Redis 失敗只記 warn,不擋回報。
 *   在線狀態只由 WebSocket 與心跳決定(指南 §5.3):連線即在線,每則心跳續期 3 個間隔(90 秒),關閉或逾時即離線。
 *     Redis 是在線狀態的來源(之後多實例共用);Redis 無法使用時退回本實例的連線表。
 *     SQL 的 last_seen_at 每 5 分鐘最多落盤一次,避免每次心跳都寫庫。
 *   離線補傳 POST /agent/v1/sync(PLATFORM-PLAN §4.2、INTEGRATION-PLAN §4.2):與目前資料同 hash、或 Mongo 已有同 agent_seq 的列入 skip;
 *     其餘同 hash 只取最新一份,依 collected_at 由舊到新列入 need(單次最多 20 筆,A3),Agent 再逐筆 POST /inventory。
 *   端點事件 POST /agent/v1/events:以 (裝置, event_id) 去重寫入 ita.device_event(occurred_at = 端點時間,另記 received_at)。
 *   hello:記錄時鐘偏差(超過 ±5 分鐘寫 clock_skew 事件,A2)、硬體指紋(與其他裝置相同時寫 suspected_duplicate,不自動合併,A1)。
 *   管理 API(P3,docs/P3-DATA-DESIGN.md):清單篩選在 SQL、在線篩選與分頁在這裡(在線狀態在 Redis);
 *     停用 / 退役立即關閉 WebSocket;合併(A1)由 SQL 交易搬資料,交易後改 Mongo 歷史、清 Redis 快取、關閉來源的 WebSocket(Agent 重連即對到目標)。
 */
import type { FastifyBaseLogger } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import {
  type AgentSettings,
  type ComputerInfo,
  type EventsRequest,
  type EventsResponse,
  type HelloAckBody,
  type HelloBody,
  type InventoryRequest,
  type InventoryResponse,
  type SyncRequest,
  type SyncResponse,
} from '../contracts.js';
import { AppError, storageUnavailable } from '../errors.js';
import type { CommandChannel } from './command-dispatcher.js';
import type {
  Actor,
  AgentEvent,
  DeviceFilter,
  DeviceRecord,
  DeviceRow,
  DeviceStatus,
  DeviceStore,
  MergeResult,
  OnlineInfo,
  SnapshotStore,
  StateStore,
  TouchPatch,
} from '../stores/types.js';

/** 一則請求或一條 WebSocket 的日誌與追蹤(指南 §5.7:x-request-id、DN、指紋) */
export interface Ctx {
  log: FastifyBaseLogger;
  requestId: string;
}

/** WebSocket 連線的最小介面(測試可用假物件) */
export interface AgentConnection {
  /** 送出一則 JSON 文字訊息(指令推送,P4) */
  send(text: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

interface LiveConnection {
  conn: AgentConnection;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  agentVersion: string | null;
}

export interface DeviceSummary {
  deviceId: string;
  computerName: string;
  certDn: string;
  certFingerprint: string;
  online: boolean;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  userName: string | null;
  domain: string | null;
  osName: string | null;
  osVersion: string | null;
  manufacturer: string | null;
  model: string | null;
  cpuName: string | null;
  memoryTotal: number | null;
  ips: string[];
  agentVersion: string | null;
  lastInventoryAt: string | null;
  /** 有其他裝置硬體指紋相同(疑似同一台,A1) */
  suspectedDuplicate: boolean;
  /** 已併入的目標裝置 deviceId */
  mergedInto: string | null;
  retiredAt: string | null;
}

/** 疑似同一台的另一台裝置(詳情用) */
export interface DuplicateCandidate {
  deviceId: string;
  computerName: string;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DeviceDetail extends DeviceSummary {
  /** 最新一份完整快照(Agent 的 ComputerInfo,鍵名轉 camelCase);尚未回報資產時為 null */
  inventory: Record<string, unknown> | null;
  collectedAt: string | null;
  clockSkewMs: number | null;
  suspectedDuplicates: DuplicateCandidate[];
}

export interface DeviceListQuery extends DeviceFilter {
  online?: boolean;
  page: number;
  pageSize: number;
}

export interface DeviceListPage {
  items: DeviceSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DeviceEventView {
  id: number;
  type: string;
  occurredAt: string;
  receivedAt: string | null;
  detail: string | null;
  data: unknown;
}

export interface MergeView extends MergeResult {
  deviceId: string;
  sourceDeviceId: string;
  /** 重送:來源早已併入此目標,未再處理 */
  alreadyMerged: boolean;
}

export interface DeviceServiceOptions {
  heartbeatIntervalSec: number;
  /** 主機下發設定(hello_ack.settings);省略用預設值 */
  settings?: AgentSettings;
  /** SQL last_seen_at 落盤間隔(毫秒) */
  touchIntervalMs?: number;
  now?: () => Date;
}

/** RFC 2253 DN 取 CN,作為登錄時的電腦名稱(收到 hello / inventory 後改為實際電腦名稱) */
export function cnOf(dn: string): string {
  return /(?:^|,)\s*CN=([^,]+)/i.exec(dn)?.[1]?.trim() || dn;
}

export const DEFAULT_SETTINGS: AgentSettings = { inventory_interval_sec: 3600, usb_events: true };
/** 時鐘偏差告警門檻 ±5 分鐘(A2) */
export const CLOCK_SKEW_ALERT_MS = 5 * 60_000;
/** /sync 單次最多要求上傳的快照數(A3) */
export const SYNC_NEED_LIMIT = 20;
/** device_event.data 上限 */
const EVENT_DATA_MAX = 4000;
/** 主機停用 / 退役 / 合併時關閉 WebSocket 的代碼(Agent 照一般斷線重連,重連時由 identify 回 403 或對到合併後的裝置) */
export const WS_CLOSE_DEVICE_CHANGED = 4403;
/** 回填軟體清單:每批台數與上限批數(避免異常資料造成無窮迴圈) */
const BACKFILL_BATCH = 100;
const BACKFILL_MAX_ROUNDS = 50;
/** 合併的時間順序容許重疊(舊裝置最後回報在 SQL 每 5 分鐘落盤,再加時鐘誤差) */
const MERGE_OVERLAP_MS = 15 * 60_000;

/** 下載檔名:只留安全字元,日期為台北時間(UTC+8) */
export function inventoryFileName(computerName: string, collectedAt: Date | null): string {
  const name = computerName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'device';
  const day = collectedAt ? new Date(collectedAt.getTime() + 8 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '') : 'unknown';
  return `${name}-${day}.json`;
}

/** 設定內容的版本號:內容不變則版本不變(Agent 依此判斷是否要更新本機保存的設定) */
export function settingsVersion(settings: AgentSettings): number {
  const keys = Object.keys(settings).sort();
  const digest = createHash('sha256').update(JSON.stringify(settings, keys)).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** 快照鍵名 snake_case → camelCase(管理 API 對外 camelCase,AGENT.md §8) */
export function camelize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelize(x)]));
  return v;
}

export class DeviceService implements CommandChannel {
  private readonly connections = new Map<string, LiveConnection>();
  private readonly lastTouch = new Map<number, number>();
  private readonly now: () => Date;
  private readonly touchIntervalMs: number;
  readonly heartbeatIntervalSec: number;
  private readonly settings: AgentSettings;
  private readonly settingsVersion: number;

  /** 目前在線的 WebSocket 連線數(本行程;監控心跳回報) */
  get onlineCount(): number {
    return this.connections.size;
  }

  constructor(
    private readonly sql: DeviceStore,
    private readonly snapshots: SnapshotStore,
    private readonly state: StateStore,
    opts: DeviceServiceOptions,
  ) {
    this.heartbeatIntervalSec = opts.heartbeatIntervalSec;
    this.settings = opts.settings ?? DEFAULT_SETTINGS;
    this.settingsVersion = settingsVersion(this.settings);
    this.touchIntervalMs = opts.touchIntervalMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** 連續 3 個心跳間隔沒收到即離線(指南 §5.3) */
  get offlineAfterSec(): number {
    return this.heartbeatIntervalSec * 3;
  }

  // ---------- 儲存呼叫的降級規則 ----------

  /** SQL:唯一真相,失敗一律 503 */
  private async sqlDo<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      ctx.log.error({ err, what }, 'SQL Server 操作失敗,回 503');
      throw storageUnavailable();
    }
  }

  /** Mongo / Redis:失敗只記 warn,不擋流程 */
  private async soft<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      ctx.log.warn({ err, what }, '非關鍵儲存失敗,略過');
      return undefined;
    }
  }

  // ---------- 裝置身分(指南 §3.3、§5.2) ----------

  /** 以完整 DN 查登錄表:新裝置登錄、新指紋更新並寫稽核、停用回 403 */
  async identify(ctx: Ctx, certDn: string, certFp: string): Promise<DeviceRecord> {
    let device = await this.sqlDo(ctx, 'device.findByDn', () => this.sql.findByDn(certDn));
    if (!device) {
      device = await this.sqlDo(ctx, 'device.register', () =>
        this.sql.register({ certDn, certFp, computerName: cnOf(certDn), requestId: ctx.requestId, at: this.now() }),
      );
      ctx.log.info({ deviceId: device.deviceId }, '新裝置登錄');
    } else if (device.certFp !== certFp) {
      const d = device;
      await this.sqlDo(ctx, 'device.updateFingerprint', () => this.sql.updateFingerprint(d, certFp, ctx.requestId));
      ctx.log.warn({ deviceId: d.deviceId, oldFp: d.certFp }, '同一 DN 出現新指紋(憑證續約或被複製),已更新並寫稽核');
      device = { ...d, certFp };
    }
    if (device.status === 'disabled') throw new AppError(403, 'ITA_DEVICE_DISABLED', '此裝置已停用');
    // 退役(A1;操作在 P3):與停用相同拒絕回報,重新啟用需 IT 處理
    if (device.status === 'retired') throw new AppError(403, 'ITA_DEVICE_RETIRED', '此裝置已退役');
    return device;
  }

  // ---------- 資產回報 ----------

  async ingestInventory(ctx: Ctx, device: DeviceRecord, req: InventoryRequest): Promise<InventoryResponse> {
    const receivedAt = this.now();
    const reply = (result: InventoryResponse['result']): InventoryResponse => ({
      device_id: device.deviceId,
      agent_seq: req.agent_seq,
      result,
      server_time: receivedAt.toISOString(),
    });

    const cached = await this.soft(ctx, 'redis.getHash', () => this.state.getHash(device.deviceId));
    if (cached === req.content_hash) {
      await this.sqlDo(ctx, 'inventory.unchanged', () => this.sql.markInventoryUnchanged(device.id, receivedAt));
      return reply('unchanged');
    }

    const current = await this.sqlDo(ctx, 'inventory.current', () => this.sql.currentInventory(device.id));
    if (current?.contentHash === req.content_hash) {
      await this.sqlDo(ctx, 'inventory.unchanged', () => this.sql.markInventoryUnchanged(device.id, receivedAt));
      await this.soft(ctx, 'redis.setHash', () => this.state.setHash(device.deviceId, req.content_hash));
      return reply('unchanged');
    }

    const snapshot = {
      agentVersion: req.agent_version,
      agentSeq: req.agent_seq,
      collectedAt: new Date(req.collected_at),
      receivedAt,
      contentHash: req.content_hash,
      inventory: req.inventory,
      payload: JSON.stringify(req.inventory),
    };

    // 補傳的較舊快照:不覆蓋目前資料,只進歷史(§4.2 第 3 點)
    if (current && snapshot.collectedAt < current.collectedAt) {
      await this.sqlDo(ctx, 'device.touch', () => this.sql.touch(device.id, receivedAt));
      await this.soft(ctx, 'mongo.insertSnapshot', () => this.snapshots.insertSnapshot({ deviceId: device.deviceId, snapshot }));
      return reply('archived');
    }

    await this.sqlDo(ctx, 'inventory.save', () => this.sql.saveInventory(device, snapshot));
    this.lastTouch.set(device.id, receivedAt.getTime());
    await this.soft(ctx, 'mongo.insertSnapshot', () => this.snapshots.insertSnapshot({ deviceId: device.deviceId, snapshot }));
    await this.soft(ctx, 'redis.setHash', () => this.state.setHash(device.deviceId, req.content_hash));
    ctx.log.info({ deviceId: device.deviceId, agentSeq: req.agent_seq, software: req.inventory.software.length }, '資產快照已寫入');
    return reply('stored');
  }

  // ---------- WebSocket 與心跳 ----------

  private onlineInfo(live: LiveConnection): OnlineInfo {
    return { connectedAt: live.connectedAt.toISOString(), lastHeartbeatAt: live.lastHeartbeatAt.toISOString(), agentVersion: live.agentVersion };
  }

  async connected(ctx: Ctx, device: DeviceRecord, conn: AgentConnection): Promise<void> {
    const prev = this.connections.get(device.deviceId);
    if (prev) {
      // 每台 Agent 只維持一條(指南 §5.3);第二條通常是憑證或電腦被複製,保留新的並告警
      ctx.log.warn({ deviceId: device.deviceId }, '同一裝置出現第二條 WebSocket,關閉舊連線');
      prev.conn.close(4409, 'replaced by a newer connection');
      await this.soft(ctx, 'sql.addEvent', () => this.sql.addEvent(device, 'duplicate_connection', '同一裝置第二條 WebSocket', ctx.requestId));
    }
    const at = this.now();
    const live: LiveConnection = { conn, connectedAt: at, lastHeartbeatAt: at, agentVersion: device.agentVersion };
    this.connections.set(device.deviceId, live);
    await this.soft(ctx, 'redis.setOnline', () => this.state.setOnline(device.deviceId, this.onlineInfo(live), this.offlineAfterSec));
  }

  async hello(ctx: Ctx, device: DeviceRecord, body: HelloBody): Promise<HelloAckBody> {
    const at = this.now();
    const live = this.connections.get(device.deviceId);
    if (live) {
      live.agentVersion = body.agent_version;
      live.lastHeartbeatAt = at;
      await this.soft(ctx, 'redis.setOnline', () => this.state.setOnline(device.deviceId, this.onlineInfo(live), this.offlineAfterSec));
    }
    // 比對用的舊值在寫入前取出
    const prevSkew = device.clockSkewMs;
    const patch: TouchPatch = { computerName: body.host_name, agentVersion: body.agent_version };
    const agentTime = body.agent_time ? Date.parse(body.agent_time) : NaN;
    if (Number.isFinite(agentTime)) patch.clockSkewMs = Math.max(-2_147_483_648, Math.min(2_147_483_647, agentTime - at.getTime()));
    const hw = body.hw_fingerprint || undefined;
    if (hw && hw !== device.hwFingerprint) patch.hwFingerprint = hw;
    // WebSocket 無法回 503,SQL 失敗只記錄;電腦名稱與版本下次 hello / inventory 再更新
    const saved = await this.soft(ctx, 'sql.touch(hello)', async () => {
      await this.sql.touch(device.id, at, patch);
      return true;
    });
    this.lastTouch.set(device.id, at.getTime());
    // 偏差與指紋沒寫入時不寫事件,否則每次 hello 都會重複寫(下次 hello 再判斷)
    if (saved) {
      await this.checkClock(ctx, device, prevSkew, patch.clockSkewMs);
      if (patch.hwFingerprint) await this.checkHwFingerprint(ctx, device, patch.hwFingerprint);
    }
    ctx.log.info({ deviceId: device.deviceId, agentVersion: body.agent_version, clockSkewMs: patch.clockSkewMs }, 'Agent hello');
    return {
      device_id: device.deviceId,
      heartbeat_interval_sec: this.heartbeatIntervalSec,
      server_time: at.toISOString(),
      ...(patch.clockSkewMs === undefined ? {} : { clock_skew_ms: patch.clockSkewMs }),
      settings_version: this.settingsVersion,
      settings: this.settings,
    };
  }

  /** 偏差由正常變成超過 ±5 分鐘時寫一筆事件(之後每次 hello 不重複寫,恢復正常再超過才再寫) */
  private async checkClock(ctx: Ctx, device: DeviceRecord, prev: number | null, skew: number | undefined): Promise<void> {
    if (skew === undefined || Math.abs(skew) <= CLOCK_SKEW_ALERT_MS) return;
    if (prev !== null && Math.abs(prev) > CLOCK_SKEW_ALERT_MS) return;
    const detail = `端點時鐘與主機相差 ${Math.round(skew / 1000)} 秒(端點 − 主機)`;
    ctx.log.warn({ deviceId: device.deviceId, clockSkewMs: skew }, '端點時鐘偏差超過 5 分鐘');
    await this.soft(ctx, 'sql.addEvent(clock_skew)', () => this.sql.addEvent(device, 'clock_skew', detail, ctx.requestId));
  }

  /** 指紋與其他裝置相同:疑似同一台(重灌、改名、換憑證),只寫事件由 IT 確認,不自動合併(A1) */
  private async checkHwFingerprint(ctx: Ctx, device: DeviceRecord, hw: string): Promise<void> {
    const same = await this.soft(ctx, 'sql.findByHwFingerprint', () => this.sql.findByHwFingerprint(hw, device.id));
    for (const other of same ?? []) {
      ctx.log.warn({ deviceId: device.deviceId, other: other.deviceId }, '硬體指紋與另一台裝置相同,疑似同一台');
      await this.soft(ctx, 'sql.addEvent(suspected_duplicate)', () =>
        this.sql.addEvent(device, 'suspected_duplicate', `與 ${other.computerName}(${other.deviceId})硬體指紋相同`, ctx.requestId),
      );
    }
  }

  // ---------- 離線補傳與端點事件(PLATFORM-PLAN §4.2) ----------

  async sync(ctx: Ctx, device: DeviceRecord, req: SyncRequest): Promise<SyncResponse> {
    const current = await this.sqlDo(ctx, 'inventory.current', () => this.sql.currentInventory(device.id));
    // Mongo 無法使用時不去重,交給 /inventory 的 hash 比對與 Mongo 唯一索引
    const items = req.pending.map((p) => ({ seq: p.agent_seq, hash: p.content_hash }));
    const seen = (await this.soft(ctx, 'mongo.seenSnapshots', () => this.snapshots.seenSnapshots(device.deviceId, items))) ?? new Set<string>();
    const skip: number[] = [];
    const newest = new Map<string, { seq: number; at: number }>();
    for (const p of req.pending) {
      if (p.content_hash === current?.contentHash || seen.has(`${p.agent_seq}:${p.content_hash}`)) {
        skip.push(p.agent_seq);
        continue;
      }
      // 同內容只需要最新一份
      const at = Date.parse(p.collected_at);
      const prev = newest.get(p.content_hash);
      if (!prev) newest.set(p.content_hash, { seq: p.agent_seq, at });
      else if (at > prev.at || (at === prev.at && p.agent_seq > prev.seq)) {
        skip.push(prev.seq);
        newest.set(p.content_hash, { seq: p.agent_seq, at });
      } else skip.push(p.agent_seq);
    }
    const need = [...newest.values()]
      .sort((a, b) => a.at - b.at || a.seq - b.seq)
      .slice(0, SYNC_NEED_LIMIT)
      .map((x) => x.seq);
    ctx.log.info({ deviceId: device.deviceId, pending: req.pending.length, need: need.length, skip: skip.length }, '離線補傳比對');
    return {
      device_id: device.deviceId,
      need,
      skip,
      server_state: { status: device.status, last_hash: current?.contentHash ?? '', ...(current ? { last_seq: current.agentSeq } : {}) },
    };
  }

  async ingestEvents(ctx: Ctx, device: DeviceRecord, req: EventsRequest): Promise<EventsResponse> {
    const receivedAt = this.now();
    const events: AgentEvent[] = req.events.map((e) => {
      let data = JSON.stringify(e.data ?? {});
      if (data.length > EVENT_DATA_MAX) data = JSON.stringify({ truncated: true, size: data.length });
      return { eventUid: e.event_id.toLowerCase(), type: e.type, occurredAt: new Date(e.occurred_at), data };
    });
    await this.sqlDo(ctx, 'event.add', () => this.sql.addAgentEvents(device, events, receivedAt, ctx.requestId));
    const types: Record<string, number> = {};
    for (const e of events) types[e.type] = (types[e.type] ?? 0) + 1;
    ctx.log.info({ deviceId: device.deviceId, types }, '端點事件已寫入');
    return { accepted: req.events.map((e) => e.event_id), server_time: receivedAt.toISOString() };
  }

  async heartbeat(ctx: Ctx, device: DeviceRecord, body: Record<string, unknown>): Promise<{ server_time: string }> {
    const at = this.now();
    const live = this.connections.get(device.deviceId);
    if (live) {
      live.lastHeartbeatAt = at;
      await this.soft(ctx, 'redis.setOnline', () => this.state.setOnline(device.deviceId, this.onlineInfo(live), this.offlineAfterSec));
    }
    await this.soft(ctx, 'mongo.recordHeartbeat', () => this.snapshots.recordHeartbeat({ deviceId: device.deviceId, at, body }));
    if (at.getTime() - (this.lastTouch.get(device.id) ?? 0) >= this.touchIntervalMs) {
      this.lastTouch.set(device.id, at.getTime());
      await this.soft(ctx, 'sql.touch(heartbeat)', () => this.sql.touch(device.id, at));
    }
    return { server_time: at.toISOString() };
  }

  /** 該裝置已有另一條較新的連線(conn 被取代) */
  replaced(deviceId: string, conn: AgentConnection): boolean {
    const current = this.connections.get(deviceId);
    return !!current && current.conn !== conn;
  }

  async disconnected(ctx: Ctx, device: DeviceRecord, conn: AgentConnection): Promise<void> {
    // 被新連線取代的舊連線關閉時,不影響新連線的在線狀態
    if (this.connections.get(device.deviceId)?.conn !== conn) return;
    this.connections.delete(device.deviceId);
    const at = this.now();
    await this.soft(ctx, 'redis.clearOnline', () => this.state.clearOnline(device.deviceId));
    await this.soft(ctx, 'sql.touch(close)', () => this.sql.touch(device.id, at));
    this.lastTouch.set(device.id, at.getTime());
  }

  /** 定期呼叫:超過 3 個心跳間隔沒有心跳的連線判定離線並中斷(半開的 TCP 不會觸發 close) */
  async sweep(ctx: Ctx): Promise<number> {
    const limit = this.now().getTime() - this.offlineAfterSec * 1000;
    let n = 0;
    for (const [deviceId, live] of this.connections) {
      if (live.lastHeartbeatAt.getTime() >= limit) continue;
      this.connections.delete(deviceId);
      live.conn.terminate();
      await this.soft(ctx, 'redis.clearOnline', () => this.state.clearOnline(deviceId));
      ctx.log.warn({ deviceId }, '心跳逾時,判定離線並中斷連線');
      n++;
    }
    return n;
  }

  /** 主機端變更裝置(停用、退役、合併):關閉該裝置的 WebSocket */
  private kick(ctx: Ctx, deviceId: string, reason: string): void {
    const live = this.connections.get(deviceId);
    if (!live) return;
    ctx.log.info({ deviceId, reason }, '裝置狀態變更,關閉 WebSocket');
    live.conn.close(WS_CLOSE_DEVICE_CHANGED, reason);
  }

  /** 指令推送通道(CommandChannel):只對本行程握有的連線(單一實例,指南 §8.4) */
  isOnline(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  send(deviceId: string, type: string, id: string, body: object): boolean {
    const live = this.connections.get(deviceId);
    if (!live) return false;
    try {
      live.conn.send(JSON.stringify({ v: 1, type, id, body }));
      return true;
    } catch {
      // 連線正在關閉:回 false,呼叫端留在 queued 重連後再送
      return false;
    }
  }

  /**
   * 關閉服務時:先送 prepare_shutdown(Agent 送完待送結果、以 1000 關閉、隨機延遲後重連,P4),
   * 等 graceMs 讓 Agent 送出與關閉,再中斷仍未關閉的連線
   */
  async closeAll(graceMs = 1000): Promise<void> {
    const ids = [...this.connections.keys()];
    for (const id of ids) this.send(id, 'prepare_shutdown', randomUUID(), { reason: 'server_restart' });
    if (ids.length && graceMs > 0) await new Promise((r) => setTimeout(r, graceMs));
    for (const live of this.connections.values()) live.conn.close(1001, 'server shutting down');
    this.connections.clear();
  }

  // ---------- 管理 API ----------

  private async onlineMap(ctx: Ctx, deviceIds: string[]): Promise<Map<string, OnlineInfo>> {
    const fromRedis = await this.soft(ctx, 'redis.onlineOf', () => this.state.onlineOf(deviceIds));
    if (fromRedis) return fromRedis;
    const limit = this.now().getTime() - this.offlineAfterSec * 1000;
    const local = new Map<string, OnlineInfo>();
    for (const id of deviceIds) {
      const live = this.connections.get(id);
      if (live && live.lastHeartbeatAt.getTime() >= limit) local.set(id, this.onlineInfo(live));
    }
    return local;
  }

  private summary(row: DeviceRow, online: OnlineInfo | undefined): DeviceSummary {
    // 在線時以最後一次心跳為「最後回報」(SQL 的 last_seen_at 每 5 分鐘才落盤)
    const lastSeen = online && new Date(online.lastHeartbeatAt) > row.lastSeenAt ? new Date(online.lastHeartbeatAt) : row.lastSeenAt;
    return {
      deviceId: row.deviceId,
      computerName: row.computerName,
      certDn: row.certDn,
      certFingerprint: row.certFp,
      online: !!online,
      status: row.status,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: lastSeen.toISOString(),
      userName: row.userName,
      domain: row.domain,
      osName: row.osName,
      osVersion: row.osVersion,
      manufacturer: row.manufacturer,
      model: row.model,
      cpuName: row.cpuName,
      memoryTotal: row.memoryTotal,
      ips: row.ips,
      agentVersion: online?.agentVersion ?? row.agentVersion,
      lastInventoryAt: row.lastInventoryAt?.toISOString() ?? null,
      suspectedDuplicate: row.suspectedDuplicate,
      mergedInto: row.mergedIntoId,
      retiredAt: row.retiredAt?.toISOString() ?? null,
    };
  }

  /** 篩選在 SQL;在線篩選與分頁在這裡(在線狀態在 Redis,無法在 SQL 篩選) */
  async listDevices(ctx: Ctx, q: DeviceListQuery): Promise<DeviceListPage> {
    const rows = await this.sqlDo(ctx, 'device.list', () => this.sql.listDevices(q));
    const online = await this.onlineMap(
      ctx,
      rows.map((r) => r.deviceId),
    );
    const all = rows.map((r) => this.summary(r, online.get(r.deviceId))).filter((d) => q.online === undefined || d.online === q.online);
    const start = (q.page - 1) * q.pageSize;
    return { items: all.slice(start, start + q.pageSize), total: all.length, page: q.page, pageSize: q.pageSize };
  }

  private async found(ctx: Ctx, deviceId: string) {
    const found = await this.sqlDo(ctx, 'device.get', () => this.sql.getDevice(deviceId));
    if (!found) throw new AppError(404, 'ITA_DEVICE_NOT_FOUND', '找不到此電腦');
    return found;
  }

  async getDevice(ctx: Ctx, deviceId: string): Promise<DeviceDetail> {
    const found = await this.found(ctx, deviceId);
    const online = await this.onlineMap(ctx, [deviceId]);
    let inventory: Record<string, unknown> | null = null;
    if (found.payload) inventory = camelize(JSON.parse(found.payload) as ComputerInfo) as Record<string, unknown>;
    const row = found.row;
    const same = row.hwFingerprint && !row.mergedIntoId ? await this.sqlDo(ctx, 'device.sameHw', () => this.sql.findByHwFingerprint(row.hwFingerprint!, row.id)) : [];
    return {
      ...this.summary(row, online.get(deviceId)),
      inventory,
      collectedAt: found.collectedAt?.toISOString() ?? null,
      clockSkewMs: row.clockSkewMs,
      suspectedDuplicates: same
        .filter((d) => d.status !== 'retired')
        .map((d) => ({
          deviceId: d.deviceId,
          computerName: d.computerName,
          status: d.status,
          firstSeenAt: d.firstSeenAt.toISOString(),
          lastSeenAt: d.lastSeenAt.toISOString(),
        })),
    };
  }

  /** 事件新到舊(依寫入順序;離線補傳的端點事件 occurredAt 可能較早) */
  async listEvents(ctx: Ctx, deviceId: string, beforeId: number | undefined, limit: number): Promise<{ items: DeviceEventView[]; nextCursor: string | null }> {
    const { row } = await this.found(ctx, deviceId);
    const rows = await this.sqlDo(ctx, 'event.list', () => this.sql.listEvents(row.id, beforeId, limit));
    const items = rows.map((e) => {
      let data: unknown = null;
      if (e.data) {
        try {
          data = JSON.parse(e.data);
        } catch {
          data = e.data;
        }
      }
      return { id: e.id, type: e.type, occurredAt: e.occurredAt.toISOString(), receivedAt: e.receivedAt?.toISOString() ?? null, detail: e.detail, data };
    });
    return { items, nextCursor: rows.length === limit ? String(rows[rows.length - 1]!.id) : null };
  }

  /** 最新資產原樣(資料契約 snake_case) */
  async inventoryJson(ctx: Ctx, deviceId: string): Promise<{ fileName: string; body: string }> {
    const found = await this.found(ctx, deviceId);
    if (!found.payload) throw new AppError(404, 'ITA_INVENTORY_NOT_FOUND', '此電腦尚未回報資產');
    return { fileName: inventoryFileName(found.row.computerName, found.collectedAt), body: found.payload };
  }

  async setStatus(ctx: Ctx, actor: Actor, deviceId: string, status: DeviceStatus, reason: string): Promise<{ deviceId: string; status: DeviceStatus; changed: boolean }> {
    const { row } = await this.found(ctx, deviceId);
    if (row.mergedIntoId) throw new AppError(409, 'ITA_DEVICE_STATUS_INVALID', '此裝置已併入其他裝置,不能變更狀態', { mergedInto: row.mergedIntoId });
    if (row.status === status) return { deviceId, status, changed: false };
    const ok = await this.sqlDo(ctx, 'device.setStatus', () => this.sql.setStatus(row.id, status, reason ? `原因:${reason}` : '', ctx.requestId, actor));
    if (!ok) throw new AppError(409, 'ITA_DEVICE_STATUS_INVALID', '此裝置已併入其他裝置,不能變更狀態');
    ctx.log.info({ deviceId, from: row.status, to: status, emp: actor.emp }, '裝置狀態變更');
    if (status !== 'active') this.kick(ctx, deviceId, `device ${status}`);
    return { deviceId, status, changed: true };
  }

  /** 來源(重灌後的新登錄)併入目標(舊裝置,deviceId 保留);重送同一請求回 alreadyMerged */
  async merge(ctx: Ctx, actor: Actor, targetId: string, sourceId: string, reason: string, force: boolean): Promise<MergeView> {
    if (targetId === sourceId) throw new AppError(400, 'ITA_MERGE_INVALID', '不能與自己合併', { reason: 'same_device' });
    const target = (await this.found(ctx, targetId)).row;
    const source = (await this.found(ctx, sourceId)).row;
    const view = (r: MergeResult, alreadyMerged: boolean): MergeView => ({ deviceId: targetId, sourceDeviceId: sourceId, alreadyMerged, ...r });
    const already = view({ events: 0, commands: 0, canceledCommands: 0, inventoryFrom: 'none' }, true);
    if (source.mergedIntoId === targetId) return already;
    if (target.status === 'retired') throw new AppError(409, 'ITA_MERGE_INVALID', '目標裝置已退役,請先改回使用中再合併', { reason: 'target_retired' });
    if (source.status !== 'active') throw new AppError(409, 'ITA_MERGE_INVALID', '來源裝置已停用或退役,不能合併', { reason: 'source_not_active' });
    // 硬體指紋由端點自行回報,只是提示;再要求「來源在舊裝置最後回報之後才登錄」(重灌的時間順序),不符時需 IT 確認後以 force 合併
    if (!force && (!target.hwFingerprint || target.hwFingerprint !== source.hwFingerprint))
      throw new AppError(409, 'ITA_MERGE_INVALID', '兩台硬體指紋不同(或未回報),確認是同一台後以 force 合併', { reason: 'fingerprint_mismatch' });
    if (!force && source.firstSeenAt.getTime() < target.lastSeenAt.getTime() - MERGE_OVERLAP_MS)
      throw new AppError(409, 'ITA_MERGE_INVALID', '新登錄的時間早於舊裝置最後回報,兩台曾同時使用,確認是同一台後以 force 合併', { reason: 'overlap' });
    // 舊裝置還在線:舊憑證仍在使用,通常不是重灌,不能合併
    if ((await this.onlineMap(ctx, [targetId])).has(targetId))
      throw new AppError(409, 'ITA_MERGE_INVALID', '目標裝置目前在線,不能合併', { reason: 'target_online' });

    let result: MergeResult;
    try {
      result = await this.sqlDo(ctx, 'device.merge', () => this.sql.merge(target.id, source.id, reason ? `原因:${reason}` : '', ctx.requestId, actor));
    } catch (err) {
      // 同一請求並行送達:另一個已完成
      if (err instanceof AppError && (err.details as { reason?: string } | undefined)?.reason === 'already_merged') return already;
      throw err;
    }
    ctx.log.info({ target: targetId, source: sourceId, emp: actor.emp, ...result }, '裝置已合併');
    // 先關閉來源的 WebSocket:避免 Agent 在 Mongo / Redis 清理期間仍以來源身分寫入
    this.kick(ctx, sourceId, 'device merged');
    // 檢查之後目標才上線(競態):一併關閉,讓它以自己的憑證重新識別
    this.kick(ctx, targetId, 'device merged');
    await this.soft(ctx, `mongo.reassign(${sourceId} → ${targetId})`, () => this.snapshots.reassign(sourceId, targetId));
    await this.soft(ctx, 'redis.clearHash', () => this.state.clearHash(targetId));
    await this.soft(ctx, 'redis.clearHash', () => this.state.clearHash(sourceId));
    await this.soft(ctx, 'redis.clearOnline', () => this.state.clearOnline(sourceId));
    return view(result, false);
  }

  /** 啟動時:既有資產回填軟體清單(migration 0004 之前寫入的);SQL 失敗只記 warn,下次啟動再試 */
  async backfillSoftware(ctx: Ctx): Promise<number> {
    let total = 0;
    let after = 0;
    for (let round = 0; round < BACKFILL_MAX_ROUNDS; round++) {
      const r = await this.soft(ctx, 'sql.backfillSoftware', () => this.sql.backfillSoftware(after, BACKFILL_BATCH));
      if (!r) break;
      total += r.done;
      if (r.failed.length) ctx.log.warn({ deviceRefs: r.failed }, '資產 payload 無法解析,略過軟體清單回填');
      if (r.lastRef === null) break;
      after = r.lastRef;
    }
    if (total) ctx.log.info({ devices: total }, '軟體清單回填完成');
    return total;
  }
}
