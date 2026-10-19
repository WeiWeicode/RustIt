/**
 * 指令派送器(PLATFORM-PLAN P4 §4.4;ENDPOINT-AGENT-GUIDE §8.3–§8.5;狀態機 docs/contracts/command-kinds.md):
 *
 *   建立:驗證類型、等級與參數 → 寫 SQL(queued)→ 該裝置在線就推送。SQL 失敗回 503。同一工號 + Idempotency-Key 回傳既有的那筆。
 *   推送:先把 SQL 條件更新為 sent(WHERE state = 'queued')再從 WebSocket 送出;信封 id = command_id。
 *     批次內 sent + acked + running 達 max_concurrent 時留在 queued,有一筆進終態再補送。
 *   Agent 重連(hello_ack 之後):依建立順序補送該裝置未逾期的 queued。WebSocket 斷線:sent 改回 queued(Agent 以 command_id 去重)。
 *   command_update:只接受屬於這台裝置、狀態往前的更新;回 command_update_ack。SQL 失敗不回 ack(Agent 稍後重送)。
 *   舊版 Agent 回 unsupported(信封 id = command_id):設為 failed UNSUPPORTED_COMMAND。
 *   每分鐘掃描:queued / sent 超過 expires_at → expired;acked / running 超過 timeout_at → failed TIMEOUT。
 *   單一實例(連線表在本行程,指南 §8.4);多實例需改為 Redis pub/sub 轉送。
 *   資料範圍(E6):管理方法收 MgmtCtx;指令跟著裝置目前的公司,範圍外一律回與不存在相同的 404。
 */
import { randomUUID } from 'node:crypto';
import type { GatewayIdentity } from '@giganexus/backend-sdk';
import { EXPIRES_MAX_SEC, EXPIRES_MIN_SEC, kindOf, paramErrors, type CommandKind } from '../commands/kinds.js';
import { AppError, storageUnavailable } from '../errors.js';
import type { BatchRecord, CommandLevel, CommandPatch, CommandRecord, CommandState, CommandStore, DeviceRow, DeviceStore } from '../stores/types.js';
import type { Ctx } from './device-service.js';
import { inScope, scopeCompanies, type MgmtCtx } from './scope.js';

/** 推送到 Agent 的通道(DeviceService 的連線表) */
export interface CommandChannel {
  isOnline(deviceId: string): boolean;
  /** 送出一則信封;沒有連線或送出失敗回 false */
  send(deviceId: string, type: string, id: string, body: object): boolean;
}

/** command_update 的 body(ws-envelope CommandUpdateBody) */
export interface CommandUpdateBody {
  command_id: string;
  state: 'acked' | 'running' | 'succeeded' | 'failed';
  progress?: number;
  result?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
  occurred_at?: string;
}

export interface CommandUpdateAckBody {
  command_id: string;
  accepted: boolean;
  state?: CommandState;
}

export interface CreateCommandInput {
  kind: string;
  params?: Record<string, unknown>;
  expiresInSec?: number;
  idempotencyKey?: string;
}

/** 管理 API 對外格式(camelCase) */
export interface CommandView {
  commandId: string;
  batchId: string | null;
  deviceId: string;
  computerName: string;
  kind: string;
  level: CommandLevel;
  params: Record<string, unknown>;
  state: CommandState;
  progress: number | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAt: string;
  sendCount: number;
  createdBy: { emp: string; name: string | null };
  requestId: string | null;
  createdAt: string;
  sentAt: string | null;
  ackedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BatchView {
  batchId: string;
  kind: string;
  level: CommandLevel;
  params: Record<string, unknown>;
  targetCount: number;
  maxConcurrent: number;
  createdBy: { emp: string; name: string | null };
  createdAt: string;
  counts: Partial<Record<CommandState, number>>;
}

export interface CommandDispatcherOptions {
  now?: () => Date;
  /** 批次同時執行上限(指南 §8.4) */
  batchMaxConcurrent?: number;
}

/** 狀態先後;終態同為 4,不可再變 */
const RANK: Record<CommandState, number> = { queued: 0, sent: 1, acked: 2, running: 3, succeeded: 4, failed: 4, canceled: 4, expired: 4 };
const NOT_FINAL: CommandState[] = ['queued', 'sent', 'acked', 'running'];
const isFinal = (s: CommandState) => RANK[s] === 4;
/** Agent 沒有開始執行就失敗的錯誤代碼(不補 started_at) */
const NOT_STARTED_CODES = new Set(['UNSUPPORTED_COMMAND', 'EXPIRED', 'INVALID_PARAMS', 'NOT_RUNNING_AS_SERVICE']);
/** result_summary 上限(NVARCHAR(4000)) */
const RESULT_MAX = 4000;
export const BATCH_MAX_DEVICES = 200;
const SWEEP_LIMIT = 500;

const parse = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { raw: s };
  }
};

export function toView(c: CommandRecord): CommandView {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    commandId: c.commandId,
    batchId: c.batchId,
    deviceId: c.deviceId,
    computerName: c.computerName,
    kind: c.kind,
    level: c.level,
    params: parse(c.params) ?? {},
    state: c.state,
    progress: c.progress,
    result: parse(c.resultSummary),
    errorCode: c.errorCode,
    errorMessage: c.errorMessage,
    expiresAt: c.expiresAt.toISOString(),
    sendCount: c.sendCount,
    createdBy: { emp: c.createdByEmp, name: c.createdByName },
    requestId: c.requestId,
    createdAt: c.createdAt.toISOString(),
    sentAt: iso(c.sentAt),
    ackedAt: iso(c.ackedAt),
    startedAt: iso(c.startedAt),
    finishedAt: iso(c.finishedAt),
  };
}

function batchView(b: BatchRecord): BatchView {
  return {
    batchId: b.batchId,
    kind: b.kind,
    level: b.level,
    params: parse(b.params) ?? {},
    targetCount: b.targetCount,
    maxConcurrent: b.maxConcurrent,
    createdBy: { emp: b.createdByEmp, name: b.createdByName },
    createdAt: b.createdAt.toISOString(),
    counts: b.counts,
  };
}

const isDuplicateKey = (err: unknown) => [2627, 2601].includes((err as { number?: number }).number ?? 0);

export class CommandDispatcher {
  private readonly now: () => Date;
  private readonly batchMaxConcurrent: number;
  /** 進行中的批次補送(同一批次串行) */
  private readonly refilling = new Map<number, Promise<void>>();

  constructor(
    private readonly store: CommandStore,
    private readonly devices: Pick<DeviceStore, 'getDevice'>,
    private readonly channel: CommandChannel,
    opts: CommandDispatcherOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.batchMaxConcurrent = opts.batchMaxConcurrent ?? 20;
  }

  private async sqlDo<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      ctx.log.error({ err, what }, 'SQL Server 操作失敗(指令)');
      throw storageUnavailable();
    }
  }

  // ---------- 建立(管理 API) ----------

  /** 類型存在、等級與路徑相符(指南 §8.3:否則等於繞過 BFF 的權限)、參數與有效期限正確 */
  private validate(level: CommandLevel, input: CreateCommandInput): { def: CommandKind; params: Record<string, unknown>; expiresSec: number } {
    const def = kindOf(input.kind);
    if (!def) throw new AppError(400, 'ITA_COMMAND_KIND_UNKNOWN', `不支援的指令類型:${input.kind}`);
    if (def.level !== level)
      throw new AppError(400, 'ENDPOINT_COMMAND_LEVEL_MISMATCH', `指令 ${input.kind} 屬於 ${def.level} 等級,不能從 ${level}-commands 建立`);
    const params = input.params ?? {};
    const errors = paramErrors(def.kind, params);
    if (errors) throw new AppError(400, 'VALIDATION_FAILED', '指令參數不正確', errors);
    const expiresSec = input.expiresInSec ?? def.expiresSec;
    if (!Number.isInteger(expiresSec) || expiresSec < EXPIRES_MIN_SEC || expiresSec > EXPIRES_MAX_SEC)
      throw new AppError(400, 'VALIDATION_FAILED', `expiresInSec 需介於 ${EXPIRES_MIN_SEC}–${EXPIRES_MAX_SEC}`);
    return { def, params, expiresSec };
  }

  /** 同一台尚未結束的同類型指令上限(message.show 洗版、agent.restart 反覆重啟) */
  private async checkPending(ctx: Ctx, def: CommandKind, deviceRef: number, computerName: string): Promise<void> {
    if (!def.maxPending) return;
    const n = await this.sqlDo(ctx, 'command.pendingCount', () => this.store.pendingCount(deviceRef, def.kind));
    if (n >= def.maxPending) throw new AppError(409, 'ITA_COMMAND_LIMIT', `${computerName} 已有 ${n} 筆尚未結束的 ${def.kind},請等待完成或取消後再送`);
  }

  /** 範圍內的裝置;不存在或範圍外回相同的 404(E6) */
  private async scopedDevice(ctx: MgmtCtx, deviceId: string): Promise<DeviceRow> {
    const found = await this.sqlDo(ctx, 'device.get', () => this.devices.getDevice(deviceId));
    if (!found || !inScope(ctx.scope, found.row.company)) {
      if (found) ctx.log.info({ deviceId, scopeDenied: true }, '裝置不在資料範圍內');
      throw new AppError(404, 'ITA_DEVICE_NOT_FOUND', '找不到此電腦');
    }
    return found.row;
  }

  private async activeDevice(ctx: MgmtCtx, deviceId: string) {
    const row = await this.scopedDevice(ctx, deviceId);
    if (row.status !== 'active') throw new AppError(409, 'ITA_DEVICE_NOT_ACTIVE', '此電腦已停用或退役,不能下指令');
    return row;
  }

  /** Idempotency-Key 找到的既有紀錄也要在範圍內(裝置之後改了公司) */
  private assertScoped(ctx: MgmtCtx, company: string | null, what: string): void {
    if (inScope(ctx.scope, company)) return;
    ctx.log.info({ what, scopeDenied: true }, '既有指令不在資料範圍內');
    throw new AppError(404, 'ITA_DEVICE_NOT_FOUND', '找不到此電腦');
  }

  private async batchInScope(ctx: MgmtCtx, batchRef: number): Promise<boolean> {
    if (ctx.scope.all) return true;
    const companies = await this.sqlDo(ctx, 'batch.companies', () => this.store.batchCompanies(batchRef));
    return companies.every((c) => inScope(ctx.scope, c));
  }

  async create(ctx: MgmtCtx, who: GatewayIdentity, level: CommandLevel, deviceId: string, input: CreateCommandInput): Promise<CommandView> {
    const emp = who.emp ?? who.sub;
    const key = input.idempotencyKey;
    const same = (c: CommandRecord) => {
      this.assertScoped(ctx, c.deviceCompany, `command ${c.commandId}`);
      // 同一個 key 用在不同電腦或類型:不可回傳舊的那筆(稽核會看不出沒有建立)
      if (c.deviceId !== deviceId || c.kind !== input.kind || c.level !== level)
        throw new AppError(422, 'ITA_IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key 已用於另一筆不同的指令');
      return toView(c);
    };
    if (key) {
      const existing = await this.sqlDo(ctx, 'command.findByIdempotency', () => this.store.findByIdempotency(emp, key));
      if (existing) return same(existing);
    }
    const { def, params, expiresSec } = this.validate(level, input);
    const device = await this.activeDevice(ctx, deviceId);
    await this.checkPending(ctx, def, device.id, device.computerName);
    const at = this.now();
    const commandId = randomUUID();
    try {
      await this.sqlDo(ctx, 'command.create', () =>
        this.store.createCommands(null, [
          {
            commandId,
            deviceRef: device.id,
            certDn: device.certDn,
            kind: def.kind,
            level,
            params: JSON.stringify(params),
            expiresAt: new Date(at.getTime() + expiresSec * 1000),
            idempotencyKey: key ?? null,
            createdByEmp: emp,
            createdByName: who.name ?? null,
            requestId: ctx.requestId,
            createdAt: at,
          },
        ]),
      );
    } catch (err) {
      // 同一個 Idempotency-Key 同時送達:另一個請求已建立
      if (key && isDuplicateKey(err)) {
        const existing = await this.sqlDo(ctx, 'command.findByIdempotency', () => this.store.findByIdempotency(emp, key));
        if (existing) return same(existing);
      }
      throw err;
    }
    ctx.log.info({ commandId, deviceId, kind: def.kind, emp }, '建立指令');
    const cmd = await this.sqlDo(ctx, 'command.get', () => this.store.getCommand(commandId));
    if (!cmd) throw storageUnavailable();
    return toView((await this.trySend(ctx, cmd)) ?? cmd);
  }

  async createBatch(
    ctx: MgmtCtx,
    who: GatewayIdentity,
    level: CommandLevel,
    deviceIds: string[],
    input: CreateCommandInput,
  ): Promise<{ batchId: string; commands: { deviceId: string; commandId: string; state: CommandState }[] }> {
    const emp = who.emp ?? who.sub;
    const key = input.idempotencyKey;
    const result = async (b: BatchRecord) => {
      const cmds = await this.sqlDo(ctx, 'command.list(batch)', () => this.store.listCommands({ batchRef: b.id, limit: BATCH_MAX_DEVICES }));
      return { batchId: b.batchId, commands: cmds.reverse().map((c) => ({ deviceId: c.deviceId, commandId: c.commandId, state: c.state })) };
    };
    const sameBatch = async (b: BatchRecord) => {
      if (!(await this.batchInScope(ctx, b.id))) {
        ctx.log.info({ batchId: b.batchId, scopeDenied: true }, '既有批次含資料範圍外的裝置');
        throw new AppError(404, 'ITA_DEVICE_NOT_FOUND', '找不到此電腦');
      }
      if (b.kind !== input.kind || b.level !== level) throw new AppError(422, 'ITA_IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key 已用於另一筆不同的批次');
      return result(b);
    };
    if (key) {
      const existing = await this.sqlDo(ctx, 'batch.findByIdempotency', () => this.store.findBatchByIdempotency(emp, key));
      if (existing) return sameBatch(existing);
    }
    const unique = [...new Set(deviceIds.map((d) => d.toLowerCase()))];
    if (unique.length === 0 || unique.length > BATCH_MAX_DEVICES) throw new AppError(400, 'VALIDATION_FAILED', `deviceIds 需 1–${BATCH_MAX_DEVICES} 台`);
    const { def, params, expiresSec } = this.validate(level, input);
    // 任一台不存在或不是 active 就整批拒絕,避免部分建立
    const targets: DeviceRow[] = [];
    for (const id of unique) {
      const d = await this.activeDevice(ctx, id);
      await this.checkPending(ctx, def, d.id, d.computerName);
      targets.push(d);
    }
    const at = this.now();
    const batchId = randomUUID();
    const paramsJson = JSON.stringify(params);
    const expiresAt = new Date(at.getTime() + expiresSec * 1000);
    try {
      await this.sqlDo(ctx, 'batch.create', () =>
        this.store.createCommands(
          {
            batchId,
            kind: def.kind,
            level,
            params: paramsJson,
            maxConcurrent: this.batchMaxConcurrent,
            idempotencyKey: key ?? null,
            createdByEmp: emp,
            createdByName: who.name ?? null,
            requestId: ctx.requestId,
            createdAt: at,
          },
          targets.map((d) => ({
            commandId: randomUUID(),
            deviceRef: d.id,
            certDn: d.certDn,
            kind: def.kind,
            level,
            params: paramsJson,
            expiresAt,
            idempotencyKey: null,
            createdByEmp: emp,
            createdByName: who.name ?? null,
            requestId: ctx.requestId,
            createdAt: at,
          })),
        ),
      );
    } catch (err) {
      if (key && isDuplicateKey(err)) {
        const existing = await this.sqlDo(ctx, 'batch.findByIdempotency', () => this.store.findBatchByIdempotency(emp, key));
        if (existing) return sameBatch(existing);
      }
      throw err;
    }
    ctx.log.info({ batchId, kind: def.kind, devices: targets.length, emp }, '建立批次指令');
    const batch = await this.sqlDo(ctx, 'batch.get', () => this.store.getBatch(batchId));
    if (!batch) throw storageUnavailable();
    await this.refillBatch(ctx, batch.id);
    return result(batch);
  }

  /** 只能取消自己建立、仍是 queued 的指令(指南 §8.3) */
  async cancel(ctx: MgmtCtx, who: GatewayIdentity, commandId: string): Promise<CommandView> {
    const cmd = await this.getRecord(ctx, commandId);
    if (cmd.createdByEmp !== (who.emp ?? who.sub)) throw new AppError(403, 'ITA_COMMAND_NOT_OWNER', '只能取消自己建立的指令');
    const ok =
      cmd.state === 'queued' &&
      (await this.sqlDo(ctx, 'command.cancel', () => this.store.transition(cmd.id, ['queued'], { state: 'canceled', at: this.now() })));
    if (!ok) throw new AppError(409, 'ITA_COMMAND_NOT_CANCELABLE', '指令已送出或已結束,無法取消');
    ctx.log.info({ commandId }, '取消指令');
    if (cmd.batchRef) await this.refillBatch(ctx, cmd.batchRef);
    return toView((await this.store.getCommand(commandId)) ?? cmd);
  }

  // ---------- 查詢(管理 API) ----------

  /** 不存在或裝置不在範圍內回相同的 404(E6) */
  private async getRecord(ctx: MgmtCtx, commandId: string): Promise<CommandRecord> {
    const cmd = await this.sqlDo(ctx, 'command.get', () => this.store.getCommand(commandId));
    if (!cmd || !inScope(ctx.scope, cmd.deviceCompany)) {
      if (cmd) ctx.log.info({ commandId, scopeDenied: true }, '指令的裝置不在資料範圍內');
      throw new AppError(404, 'ITA_COMMAND_NOT_FOUND', '找不到此指令');
    }
    return cmd;
  }

  async get(ctx: MgmtCtx, commandId: string): Promise<CommandView> {
    return toView(await this.getRecord(ctx, commandId));
  }

  /** 新到舊;nextCursor 為下一頁的游標(內部序號) */
  async list(
    ctx: MgmtCtx,
    q: { deviceId?: string; batchId?: string; state?: CommandState; kind?: string; cursor?: string; limit?: number },
  ): Promise<{ items: CommandView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    let deviceRef: number | undefined;
    if (q.deviceId) deviceRef = (await this.scopedDevice(ctx, q.deviceId)).id;
    const companies = scopeCompanies(ctx.scope);
    if (companies?.length === 0) return { items: [], nextCursor: null };
    let batchRef: number | undefined;
    if (q.batchId) {
      const b = await this.sqlDo(ctx, 'batch.get', () => this.store.getBatch(q.batchId!));
      // 與 getBatch 一致:批次含範圍外的裝置視同不存在(E6)
      if (!b || !(await this.batchInScope(ctx, b.id))) return { items: [], nextCursor: null };
      batchRef = b.id;
    }
    const beforeId = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : undefined;
    const rows = await this.sqlDo(ctx, 'command.list', () =>
      this.store.listCommands({ deviceRef, batchRef, state: q.state, kind: q.kind, beforeId, companies, limit: limit + 1 }),
    );
    const page = rows.slice(0, limit);
    return { items: page.map(toView), nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
  }

  /** 批次內所有裝置都在範圍內才看得到(避免從台數推知其他公司的電腦;E6 §1.4) */
  async getBatch(ctx: MgmtCtx, batchId: string): Promise<BatchView> {
    const b = await this.sqlDo(ctx, 'batch.get', () => this.store.getBatch(batchId));
    if (!b || !(await this.batchInScope(ctx, b.id))) {
      if (b) ctx.log.info({ batchId, scopeDenied: true }, '批次含資料範圍外的裝置');
      throw new AppError(404, 'ITA_BATCH_NOT_FOUND', '找不到此批次');
    }
    return batchView(b);
  }

  // ---------- 推送 ----------

  /** queued 且未逾期、裝置在線、批次未達上限 → 改 sent 後送出;回傳送出後的紀錄(沒送回 null)。失敗只記錄,留在 queued */
  private async trySend(ctx: Ctx, cmd: CommandRecord): Promise<CommandRecord | null> {
    const at = this.now();
    if (cmd.state !== 'queued' || cmd.expiresAt <= at || !this.channel.isOnline(cmd.deviceId)) return null;
    try {
      if (cmd.batchRef && cmd.batchMaxConcurrent && (await this.store.activeInBatch(cmd.batchRef)) >= cmd.batchMaxConcurrent) return null;
      if (!(await this.store.transition(cmd.id, ['queued'], { state: 'sent', at }))) return null;
      const body = {
        command_id: cmd.commandId,
        kind: cmd.kind,
        params: parse(cmd.params) ?? {},
        expires_at: cmd.expiresAt.toISOString(),
        issued_by: cmd.createdByEmp,
        issued_at: cmd.createdAt.toISOString(),
      };
      if (!this.channel.send(cmd.deviceId, 'command', cmd.commandId, body)) {
        await this.store.transition(cmd.id, ['sent'], { state: 'queued', at });
        return null;
      }
      ctx.log.info({ commandId: cmd.commandId, deviceId: cmd.deviceId, kind: cmd.kind, sendCount: cmd.sendCount + 1 }, '指令已推送');
      return { ...cmd, state: 'sent', sentAt: at, sendCount: cmd.sendCount + 1 };
    } catch (err) {
      ctx.log.warn({ err, commandId: cmd.commandId }, '指令推送失敗,留在 queued 稍後再送');
      return null;
    }
  }

  /** 批次補送到上限;同一批次在本行程內依序執行,避免同時補送超過上限(單一實例,指南 §8.4) */
  private refillBatch(ctx: Ctx, batchRef: number): Promise<void> {
    const run = async () => {
      try {
        const queued = await this.store.queuedForBatch(batchRef, this.now(), BATCH_MAX_DEVICES);
        // 上限在 trySend 送出前計數
        for (const cmd of queued) if (this.channel.isOnline(cmd.deviceId)) await this.trySend(ctx, cmd);
      } catch (err) {
        ctx.log.warn({ err, batchRef }, '批次補送失敗,下次掃描再試');
      }
    };
    const next = (this.refilling.get(batchRef) ?? Promise.resolve()).then(run);
    this.refilling.set(batchRef, next);
    void next.then(() => {
      if (this.refilling.get(batchRef) === next) this.refilling.delete(batchRef);
    });
    return next;
  }

  /**
   * Agent 重連並收到 hello_ack 之後:依建立順序補送(指南 §8.4)。
   * 先把 sent 改回 queued:上一條連線被新連線取代或半開時,未確認的指令沒有經過斷線處理(Agent 以 command_id 去重,重送無害)
   */
  async onHello(ctx: Ctx, deviceRef: number): Promise<void> {
    let queued: CommandRecord[];
    try {
      await this.store.requeueSent(deviceRef);
      queued = await this.store.queuedForDevice(deviceRef, this.now());
    } catch (err) {
      ctx.log.warn({ err }, '查詢待送指令失敗,下次掃描再送');
      return;
    }
    for (const cmd of queued) await this.trySend(ctx, cmd);
  }

  /** WebSocket 斷線:未確認的 sent 改回 queued(重連後重送) */
  async onDisconnected(ctx: Ctx, deviceRef: number): Promise<void> {
    try {
      const n = await this.store.requeueSent(deviceRef);
      if (n) ctx.log.info({ requeued: n }, 'WebSocket 中斷,未確認的指令改回 queued');
    } catch (err) {
      ctx.log.warn({ err }, '未確認指令改回 queued 失敗(逾期掃描仍會處理)');
    }
  }

  // ---------- Agent 回報 ----------

  /** 回傳 command_update_ack;SQL 失敗回 null(不回 ack,Agent 稍後重送) */
  async onUpdate(ctx: Ctx, deviceRef: number, body: CommandUpdateBody): Promise<CommandUpdateAckBody | null> {
    const commandId = body.command_id.toLowerCase();
    let cmd: CommandRecord | null;
    try {
      cmd = await this.store.getCommand(commandId);
    } catch (err) {
      ctx.log.warn({ err, commandId }, '查詢指令失敗,不回 ack');
      return null;
    }
    const reject = (why: string): CommandUpdateAckBody => {
      ctx.log.warn({ commandId, state: body.state, current: cmd?.state }, why);
      return { command_id: body.command_id, accepted: false, ...(cmd && cmd.deviceRef === deviceRef ? { state: cmd.state } : {}) };
    };
    // 不屬於這台裝置的指令一律拒絕(防止一台電腦改別台的結果)
    if (!cmd || cmd.deviceRef !== deviceRef) return reject('command_update 的指令不存在或不屬於此裝置');
    if (isFinal(cmd.state)) return reject('指令已是終態,不採用此更新');
    const target: CommandState = body.state;
    // 狀態只能往前;running 可重複(更新進度)
    const from = NOT_FINAL.filter((s) => RANK[s] < RANK[target] || (target === 'running' && s === 'running'));
    if (!from.includes(cmd.state)) return { command_id: body.command_id, accepted: true, state: cmd.state };
    const at = this.now();
    const patch: CommandPatch = { state: target, at };
    if (body.progress !== undefined) patch.progress = body.progress;
    if (target === 'acked' || target === 'running') {
      const def = kindOf(cmd.kind);
      patch.timeoutAt = new Date(at.getTime() + (def?.timeoutSec ?? 600) * 1000);
    }
    if (isFinal(target)) {
      if (body.result !== undefined) {
        let s = JSON.stringify(body.result);
        if (s.length > RESULT_MAX) s = JSON.stringify({ truncated: true, size: s.length });
        patch.resultSummary = s;
      }
      if (target === 'succeeded') patch.progress = 100;
      if (target === 'failed') {
        patch.errorCode = body.error_code ?? 'EXECUTION_FAILED';
        patch.errorMessage = body.error_message ?? null;
      }
      // 瞬間完成的指令 Agent 只送出最後狀態(running 被覆蓋),開始時間以確認收到的時間補上
      patch.markStarted = target === 'succeeded' || !NOT_STARTED_CODES.has(patch.errorCode ?? '');
    }
    let ok: boolean;
    try {
      ok = await this.store.transition(cmd.id, from, patch);
    } catch (err) {
      ctx.log.warn({ err, commandId }, '寫入指令狀態失敗,不回 ack');
      return null;
    }
    if (!ok) {
      // 同時有其他更新(例如逾期掃描):回目前狀態
      const now = await this.store.getCommand(commandId).catch(() => null);
      return { command_id: body.command_id, accepted: false, ...(now ? { state: now.state } : {}) };
    }
    ctx.log.info({ commandId, kind: cmd.kind, state: target, errorCode: patch.errorCode }, '指令狀態更新');
    if (isFinal(target) && cmd.batchRef) await this.refillBatch(ctx, cmd.batchRef);
    return { command_id: body.command_id, accepted: true, state: target };
  }

  /** 舊版 Agent 不認得 command 訊息:回 unsupported,信封 id = command_id(指南 §5.6) */
  async onUnsupported(ctx: Ctx, deviceRef: number, envelopeId: string, type: string): Promise<void> {
    if (type !== 'command') return;
    const cmd = await this.store.getCommand(envelopeId.toLowerCase()).catch(() => null);
    if (!cmd || cmd.deviceRef !== deviceRef || isFinal(cmd.state)) return;
    const ok = await this.store
      .transition(cmd.id, ['queued', 'sent', 'acked'], {
        state: 'failed',
        at: this.now(),
        errorCode: 'UNSUPPORTED_COMMAND',
        errorMessage: 'Agent 版本不支援指令',
      })
      .catch((err: unknown) => {
        ctx.log.warn({ err }, '寫入 UNSUPPORTED_COMMAND 失敗');
        return false;
      });
    if (ok) {
      ctx.log.warn({ commandId: cmd.commandId }, 'Agent 不支援指令訊息(舊版),設為 failed UNSUPPORTED_COMMAND');
      if (cmd.batchRef) await this.refillBatch(ctx, cmd.batchRef);
    }
  }

  // ---------- 逾期與逾時 ----------

  /** 每分鐘呼叫:queued / sent 逾期 → expired;acked / running 逾時 → failed TIMEOUT */
  async sweep(ctx: Ctx): Promise<{ expired: number; timedOut: number }> {
    const at = this.now();
    let due: CommandRecord[];
    try {
      due = await this.store.dueForSweep(at, SWEEP_LIMIT);
    } catch (err) {
      ctx.log.warn({ err }, '指令逾期掃描失敗,下次再試');
      return { expired: 0, timedOut: 0 };
    }
    let expired = 0;
    let timedOut = 0;
    const batches = new Set<number>();
    for (const cmd of due) {
      try {
        if (cmd.state === 'queued' || cmd.state === 'sent') {
          if (await this.store.transition(cmd.id, ['queued', 'sent'], { state: 'expired', at })) expired++;
        } else if (
          await this.store.transition(cmd.id, ['acked', 'running'], { state: 'failed', at, errorCode: 'TIMEOUT', errorMessage: 'Agent 未在執行逾時內回報結果' })
        )
          timedOut++;
        if (cmd.batchRef) batches.add(cmd.batchRef);
      } catch (err) {
        ctx.log.warn({ err, commandId: cmd.commandId }, '指令逾期處理失敗');
      }
    }
    for (const b of batches) await this.refillBatch(ctx, b);
    if (expired || timedOut) ctx.log.info({ expired, timedOut }, '指令逾期 / 逾時');
    return { expired, timedOut };
  }
}
