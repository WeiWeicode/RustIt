/**
 * 裝置服務:寫入順序與降級集中在這裡(INTEGRATION-PLAN §3.1、AGENT.md §7.2),路由不直接操作任何儲存。
 *
 *   回報 POST /agent/v1/inventory:比對 content_hash(Redis → SQL)→ 沒變只更新最後回報時間
 *     → 比目前資料舊(補傳)只進 Mongo 歷史 → 變了在一個交易寫 SQL → 成功後寫 Mongo 快照 → 更新 Redis → 回 200。
 *     SQL 失敗回 503(不寫其他兩者);Mongo / Redis 失敗只記 warn,不擋回報。
 *   在線狀態只由 WebSocket 與心跳決定(指南 §5.3):連線即在線,每則心跳續期 3 個間隔(90 秒),關閉或逾時即離線。
 *     Redis 是在線狀態的來源(之後多實例共用);Redis 無法使用時退回本實例的連線表。
 *     SQL 的 last_seen_at 每 5 分鐘最多落盤一次,避免每次心跳都寫庫。
 */
import type { FastifyBaseLogger } from 'fastify';
import { type ComputerInfo, type HelloBody, type InventoryRequest, type InventoryResponse } from '../contracts.js';
import { AppError, storageUnavailable } from '../errors.js';
import type { DeviceRecord, DeviceRow, DeviceStore, OnlineInfo, SnapshotStore, StateStore } from '../stores/types.js';

/** 一則請求或一條 WebSocket 的日誌與追蹤(指南 §5.7:x-request-id、DN、指紋) */
export interface Ctx {
  log: FastifyBaseLogger;
  requestId: string;
}

/** WebSocket 連線的最小介面(測試可用假物件) */
export interface AgentConnection {
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
}

export interface DeviceDetail extends DeviceSummary {
  /** 最新一份完整快照(Agent 的 ComputerInfo,鍵名轉 camelCase);尚未回報資產時為 null */
  inventory: Record<string, unknown> | null;
  collectedAt: string | null;
}

export interface DeviceServiceOptions {
  heartbeatIntervalSec: number;
  /** SQL last_seen_at 落盤間隔(毫秒) */
  touchIntervalMs?: number;
  now?: () => Date;
}

/** RFC 2253 DN 取 CN,作為登錄時的電腦名稱(收到 hello / inventory 後改為實際電腦名稱) */
export function cnOf(dn: string): string {
  return /(?:^|,)\s*CN=([^,]+)/i.exec(dn)?.[1]?.trim() || dn;
}

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** 快照鍵名 snake_case → camelCase(管理 API 對外 camelCase,AGENT.md §8) */
export function camelize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelize(x)]));
  return v;
}

export class DeviceService {
  private readonly connections = new Map<string, LiveConnection>();
  private readonly lastTouch = new Map<number, number>();
  private readonly now: () => Date;
  private readonly touchIntervalMs: number;
  readonly heartbeatIntervalSec: number;

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

  async hello(ctx: Ctx, device: DeviceRecord, body: HelloBody): Promise<{ device_id: string; heartbeat_interval_sec: number; server_time: string }> {
    const at = this.now();
    const live = this.connections.get(device.deviceId);
    if (live) {
      live.agentVersion = body.agent_version;
      live.lastHeartbeatAt = at;
      await this.soft(ctx, 'redis.setOnline', () => this.state.setOnline(device.deviceId, this.onlineInfo(live), this.offlineAfterSec));
    }
    // WebSocket 無法回 503,SQL 失敗只記錄;電腦名稱與版本下次 hello / inventory 再更新
    await this.soft(ctx, 'sql.touch(hello)', () => this.sql.touch(device.id, at, { computerName: body.host_name, agentVersion: body.agent_version }));
    this.lastTouch.set(device.id, at.getTime());
    ctx.log.info({ deviceId: device.deviceId, agentVersion: body.agent_version }, 'Agent hello');
    return { device_id: device.deviceId, heartbeat_interval_sec: this.heartbeatIntervalSec, server_time: at.toISOString() };
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

  /** 關閉服務時中斷所有 Agent 連線(Agent 會退避重連) */
  closeAll(): void {
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
    };
  }

  async listDevices(ctx: Ctx): Promise<DeviceSummary[]> {
    const rows = await this.sqlDo(ctx, 'device.list', () => this.sql.listDevices());
    const online = await this.onlineMap(
      ctx,
      rows.map((r) => r.deviceId),
    );
    return rows.map((r) => this.summary(r, online.get(r.deviceId)));
  }

  async getDevice(ctx: Ctx, deviceId: string): Promise<DeviceDetail> {
    const found = await this.sqlDo(ctx, 'device.get', () => this.sql.getDevice(deviceId));
    if (!found) throw new AppError(404, 'ITA_DEVICE_NOT_FOUND', '找不到此電腦');
    const online = await this.onlineMap(ctx, [deviceId]);
    let inventory: Record<string, unknown> | null = null;
    if (found.payload) inventory = camelize(JSON.parse(found.payload) as ComputerInfo) as Record<string, unknown>;
    return { ...this.summary(found.row, online.get(deviceId)), inventory, collectedAt: found.collectedAt?.toISOString() ?? null };
  }
}
