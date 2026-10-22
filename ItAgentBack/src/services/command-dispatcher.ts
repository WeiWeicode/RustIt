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
 *   批次第二人核可(B1,P7-SOFTWARE-DESIGN §6):admin 批次超過 approvalThreshold 台 → pending_approval,指令留在 queued 不送出;
 *     建立人以外、資料範圍涵蓋全部裝置的人核可後 running(指令有效期限自核可時起算);駁回或 24 小時無人核可 → 指令 canceled。
 *   全域並行上限(limitedKinds,P7 software.*):這些類型 sent / acked / running 的總數達上限時留在 queued,有一筆結束再補送(軟上限)。
 */
import { randomUUID } from 'node:crypto';
import type { GatewayIdentity } from '@giganexus/backend-sdk';
import { EXPIRES_MAX_SEC, EXPIRES_MIN_SEC, kindOf, paramErrors, SOFTWARE_KINDS, type CommandKind } from '../commands/kinds.js';
import { AppError, storageUnavailable } from '../errors.js';
import type {
  BatchRecord,
  BatchState,
  CommandLevel,
  CommandPatch,
  CommandRecord,
  CommandState,
  CommandStore,
  DeviceRow,
  DeviceStore,
  NewBatch,
} from '../stores/types.js';
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
  /** 所屬批次的狀態(單台累計超過門檻時為 pending_approval,D2-1);不屬於批次為 null */
  batchState: BatchState | null;
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
  /** running 且全部指令已結束時顯示 done */
  state: BatchState;
  requiresApproval: boolean;
  /** pending_approval 的核可期限 */
  approvalExpiresAt: string | null;
  approvedBy: { emp: string; name: string | null } | null;
  approvedAt: string | null;
  rejectedBy: { emp: string; name: string | null } | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  createdBy: { emp: string; name: string | null };
  createdAt: string;
  counts: Partial<Record<CommandState, number>>;
}

/** 指令類型的建立前檢查與建立後處理(P6 agent.upgrade:ReleaseService 檢查版本、記錄強制版本;P7 software.*:目錄快照、授權數) */
export interface KindHook {
  /** 不符時丟 AppError,整筆(批次為整批)不建立;回傳物件時以它取代寫入指令的 params(P7 目錄快照) */
  check(ctx: Ctx, deviceRef: number, params: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  /** 每台都通過 check 之後的整批檢查(單台也呼叫,deviceRefs 只有一台;P7 授權數) */
  checkBatch?(ctx: Ctx, deviceRefs: number[], params: Record<string, unknown>): Promise<void>;
  /** 檢查通過後、寫入指令前(失敗則不建立指令;批次為全部檢查通過後逐台套用);params 為管理 API 送來的原始參數 */
  apply?(ctx: Ctx, deviceRef: number, params: Record<string, unknown>, actor: { emp: string; name: string | null }): Promise<void>;
  /** Agent 回報終態、不支援、執行逾時之後(P7 告警);例外只記 warn,不影響指令狀態 */
  onFinal?(ctx: Ctx, cmd: CommandRecord, fin: FinalInfo): Promise<void>;
}

/** 指令進入終態的結果(kindHooks.onFinal) */
export interface FinalInfo {
  state: CommandState;
  errorCode: string | null;
  /** Agent 的 result(JSON 字串) */
  resultSummary: string | null;
}

export interface CommandDispatcherOptions {
  now?: () => Date;
  /** 批次同時執行上限(指南 §8.4) */
  batchMaxConcurrent?: number;
  /** 依指令類型的建立前後處理 */
  kindHooks?: Record<string, KindHook>;
  /** admin 批次超過幾台需第二人核可(B1,BATCH_APPROVAL_THRESHOLD) */
  approvalThreshold?: number;
  /** 跨批次的全域並行上限(P7 software.*,SOFTWARE_MAX_CONCURRENT) */
  limitedKinds?: { kinds: readonly string[]; max: number };
}

export interface CreateBatchResult {
  batchId: string;
  state: BatchState;
  requiresApproval: boolean;
  commands: { deviceId: string; commandId: string; state: CommandState }[];
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
/** 待核可批次的核可期限(B1:24 小時無人核可 → expired) */
export const APPROVAL_WINDOW_MS = 24 * 3_600_000;
/** D2-1:累計核可門檻的時間窗 */
export const GATE_WINDOW_MS = 24 * 3_600_000;
/**
 * 核可路由(需求方 2026-10-21 決定):軟體派送批次由 /approve、/reject(endpoint.software.manage)核可;
 * 其他類型(system.reboot 等)由 /approve-command、/reject-command(endpoint.command.admin)核可;路由與類型不符回 403
 */
export type ApprovalRoute = 'software' | 'command';
/**
 * D2-1:同一人 24 小時內累計台數超過門檻需第二人核可的類型;同一組共用計數。
 * 軟體安裝 / 移除(以 SYSTEM 執行程式)一組,重開機(可用性)另一組
 */
export const GATED_GROUPS: Record<string, readonly string[]> = {
  'software.install': ['software.install', 'software.uninstall'],
  'software.uninstall': ['software.install', 'software.uninstall'],
  'system.reboot': ['system.reboot'],
};
/** 全域並行上限補送一次最多掃幾頁(每頁 BATCH_MAX_DEVICES 筆) */
const LIMITED_MAX_PAGES = 50;
/** 會送出指令的批次狀態 */
const SENDABLE: readonly BatchState[] = ['running', 'done'];

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
    batchState: c.batchState,
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

export function batchView(b: BatchRecord): BatchView {
  // 0008 之前的批次沒有 done:running 且全部指令已結束就顯示 done
  const open = NOT_FINAL.some((s) => (b.counts[s] ?? 0) > 0);
  return {
    batchId: b.batchId,
    kind: b.kind,
    level: b.level,
    params: parse(b.params) ?? {},
    targetCount: b.targetCount,
    maxConcurrent: b.maxConcurrent,
    state: b.state === 'running' && !open ? 'done' : b.state,
    requiresApproval: b.requiresApproval,
    approvalExpiresAt: b.state === 'pending_approval' ? new Date(b.createdAt.getTime() + APPROVAL_WINDOW_MS).toISOString() : null,
    approvedBy: b.approvedByEmp ? { emp: b.approvedByEmp, name: b.approvedByName } : null,
    approvedAt: b.approvedAt?.toISOString() ?? null,
    rejectedBy: b.rejectedByEmp ? { emp: b.rejectedByEmp, name: b.rejectedByName } : null,
    rejectedAt: b.rejectedAt?.toISOString() ?? null,
    rejectReason: b.rejectReason,
    createdBy: { emp: b.createdByEmp, name: b.createdByName },
    createdAt: b.createdAt.toISOString(),
    counts: b.counts,
  };
}

const isDuplicateKey = (err: unknown) => [2627, 2601].includes((err as { number?: number }).number ?? 0);

export class CommandDispatcher {
  private readonly now: () => Date;
  private readonly batchMaxConcurrent: number;
  private readonly kindHooks: Record<string, KindHook>;
  private readonly approvalThreshold: number;
  private readonly limited: { kinds: readonly string[]; max: number } | null;
  /** 進行中的批次補送(同一批次串行) */
  private readonly refilling = new Map<number, Promise<void>>();
  /** 全域並行上限類型的補送(串行) */
  private limitedRefill: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: CommandStore,
    private readonly devices: Pick<DeviceStore, 'getDevice'>,
    private readonly channel: CommandChannel,
    opts: CommandDispatcherOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.batchMaxConcurrent = opts.batchMaxConcurrent ?? 20;
    this.kindHooks = opts.kindHooks ?? {};
    this.approvalThreshold = opts.approvalThreshold ?? 20;
    this.limited = opts.limitedKinds ?? null;
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

  /** 同一人同一組管控類型的「計數 → 建立」序列化(單一實例;D2-1 競態) */
  private readonly gateLocks = new Map<string, Promise<unknown>>();

  private serialized<T>(emp: string, kind: string, fn: () => Promise<T>): Promise<T> {
    const group = Object.hasOwn(GATED_GROUPS, kind) ? GATED_GROUPS[kind] : undefined;
    if (!group) return fn();
    const key = `${emp.toUpperCase()}|${group.join(',')}`;
    const prev = this.gateLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.gateLocks.set(key, tail);
    void tail.then(() => {
      if (this.gateLocks.get(key) === tail) this.gateLocks.delete(key);
    });
    return run;
  }

  /** D2-1:加上這次的台數後,此人 24 小時內累計是否超過門檻 */
  private async overGate(ctx: Ctx, emp: string, kind: string, adding: number): Promise<{ over: boolean; recent: number }> {
    const group = Object.hasOwn(GATED_GROUPS, kind) ? GATED_GROUPS[kind] : undefined;
    if (!group) return { over: false, recent: 0 };
    const since = new Date(this.now().getTime() - GATE_WINDOW_MS);
    const recent = await this.sqlDo(ctx, 'command.recentGated', () => this.store.recentGatedTargets(emp, group, since));
    return { over: recent + adding > this.approvalThreshold, recent };
  }

  async create(ctx: MgmtCtx, who: GatewayIdentity, level: CommandLevel, deviceId: string, input: CreateCommandInput): Promise<CommandView> {
    return this.serialized(who.emp ?? who.sub, level === 'admin' ? input.kind : '', () => this.createOne(ctx, who, level, deviceId, input));
  }

  private async createOne(ctx: MgmtCtx, who: GatewayIdentity, level: CommandLevel, deviceId: string, input: CreateCommandInput): Promise<CommandView> {
    const emp = who.emp ?? who.sub;
    const key = input.idempotencyKey;
    const same = (c: CommandRecord) => {
      this.assertScoped(ctx, c.deviceCompany, `command ${c.commandId}`);
      // 同一個 key 用在不同電腦或類型:不可回傳舊的那筆(稽核會看不出沒有建立)
      const pkg = typeof input.params?.packageId === 'string' ? input.params.packageId.toLowerCase() : undefined;
      if (c.deviceId !== deviceId || c.kind !== input.kind || c.level !== level || (pkg !== undefined && parse(c.params)?.package_id !== pkg))
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
    const hook = this.kindHooks[def.kind];
    let stored = params;
    if (hook) {
      stored = (await hook.check(ctx, device.id, params)) ?? params;
      await hook.checkBatch?.(ctx, [device.id], params);
      await hook.apply?.(ctx, device.id, params, { emp, name: who.name ?? null });
    }
    const at = this.now();
    const commandId = randomUUID();
    // D2-1:逐台派送也累計;超過門檻時這一台放進一個待核可的單台批次
    const gate = level === 'admin' ? await this.overGate(ctx, emp, def.kind, 1) : { over: false, recent: 0 };
    const gatedBatch: NewBatch | null = gate.over
      ? {
          batchId: randomUUID(),
          kind: def.kind,
          level,
          params: JSON.stringify(stored),
          maxConcurrent: 1,
          requiresApproval: true,
          idempotencyKey: null,
          createdByEmp: emp,
          createdByName: who.name ?? null,
          requestId: ctx.requestId,
          createdAt: at,
        }
      : null;
    try {
      await this.sqlDo(ctx, 'command.create', () =>
        this.store.createCommands(gatedBatch, [
          {
            commandId,
            deviceRef: device.id,
            certDn: device.certDn,
            kind: def.kind,
            level,
            params: JSON.stringify(stored),
            expiresAt: new Date(at.getTime() + expiresSec * 1000 + (gatedBatch ? APPROVAL_WINDOW_MS : 0)),
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
    ctx.log.info(
      { commandId, deviceId, kind: def.kind, emp, ...(gatedBatch ? { batchId: gatedBatch.batchId, recentDevices: gate.recent } : {}) },
      gatedBatch ? '建立指令(24 小時內累計超過門檻,待第二人核可)' : '建立指令',
    );
    const cmd = await this.sqlDo(ctx, 'command.get', () => this.store.getCommand(commandId));
    if (!cmd) throw storageUnavailable();
    if (gatedBatch) return toView(cmd);
    return toView((await this.trySend(ctx, cmd)) ?? cmd);
  }

  /** maxConcurrent:這個批次的同時執行上限(1 – batchMaxConcurrent;省略用 batchMaxConcurrent) */
  async createBatch(
    ctx: MgmtCtx,
    who: GatewayIdentity,
    level: CommandLevel,
    deviceIds: string[],
    input: CreateCommandInput,
    opts: { maxConcurrent?: number } = {},
  ): Promise<CreateBatchResult> {
    return this.serialized(who.emp ?? who.sub, level === 'admin' ? input.kind : '', () => this.createMany(ctx, who, level, deviceIds, input, opts));
  }

  private async createMany(
    ctx: MgmtCtx,
    who: GatewayIdentity,
    level: CommandLevel,
    deviceIds: string[],
    input: CreateCommandInput,
    opts: { maxConcurrent?: number },
  ): Promise<CreateBatchResult> {
    const emp = who.emp ?? who.sub;
    const key = input.idempotencyKey;
    const result = async (b: BatchRecord): Promise<CreateBatchResult> => {
      const cmds = await this.sqlDo(ctx, 'command.list(batch)', () => this.store.listCommands({ batchRef: b.id, limit: BATCH_MAX_DEVICES }));
      return {
        batchId: b.batchId,
        state: batchView(b).state,
        requiresApproval: b.requiresApproval,
        commands: cmds.reverse().map((c) => ({ deviceId: c.deviceId, commandId: c.commandId, state: c.state })),
      };
    };
    const sameBatch = async (b: BatchRecord) => {
      if (!(await this.batchInScope(ctx, b.id))) {
        ctx.log.info({ batchId: b.batchId, scopeDenied: true }, '既有批次含資料範圍外的裝置');
        throw new AppError(404, 'ITA_DEVICE_NOT_FOUND', '找不到此電腦');
      }
      // 軟體派送:同一個 key 用在另一個套件也算不同的批次(否則會以為派了新套件,實際回傳舊的那批)
      const pkg = typeof input.params?.packageId === 'string' ? input.params.packageId.toLowerCase() : undefined;
      if (b.kind !== input.kind || b.level !== level || (pkg !== undefined && parse(b.params)?.package_id !== pkg))
        throw new AppError(422, 'ITA_IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key 已用於另一筆不同的批次');
      return result(b);
    };
    if (key) {
      const existing = await this.sqlDo(ctx, 'batch.findByIdempotency', () => this.store.findBatchByIdempotency(emp, key));
      if (existing) return sameBatch(existing);
    }
    const unique = [...new Set(deviceIds.map((d) => d.toLowerCase()))];
    if (unique.length === 0 || unique.length > BATCH_MAX_DEVICES) throw new AppError(400, 'VALIDATION_FAILED', `deviceIds 需 1–${BATCH_MAX_DEVICES} 台`);
    const { def, params, expiresSec } = this.validate(level, input);
    const maxConcurrent = opts.maxConcurrent ?? this.batchMaxConcurrent;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > this.batchMaxConcurrent)
      throw new AppError(400, 'VALIDATION_FAILED', `maxConcurrent 需介於 1–${this.batchMaxConcurrent}`);
    // 任一台不存在或不是 active 就整批拒絕,避免部分建立
    const hook = this.kindHooks[def.kind];
    const targets: { device: DeviceRow; params: Record<string, unknown> }[] = [];
    for (const id of unique) {
      const d = await this.activeDevice(ctx, id);
      await this.checkPending(ctx, def, d.id, d.computerName);
      targets.push({ device: d, params: (await hook?.check(ctx, d.id, params)) ?? params });
    }
    await hook?.checkBatch?.(
      ctx,
      targets.map((t) => t.device.id),
      params,
    );
    if (hook?.apply) for (const t of targets) await hook.apply(ctx, t.device.id, params, { emp, name: who.name ?? null });
    const at = this.now();
    const batchId = randomUUID();
    // 第二人核可(B1):待核可期間的有效期限另加核可期限,核可時重設為核可時間 + 類型有效期限
    // D2-1:同一人 24 小時內累計(含逐台、多批小批次)超過門檻也要核可
    const requiresApproval =
      level === 'admin' && (targets.length > this.approvalThreshold || (await this.overGate(ctx, emp, def.kind, targets.length)).over);
    const expiresAt = new Date(at.getTime() + expiresSec * 1000 + (requiresApproval ? APPROVAL_WINDOW_MS : 0));
    try {
      await this.sqlDo(ctx, 'batch.create', () =>
        this.store.createCommands(
          {
            batchId,
            kind: def.kind,
            level,
            // 批次層記第一台的參數(快照對每台相同:同一套件)
            params: JSON.stringify(targets[0]!.params),
            maxConcurrent,
            requiresApproval,
            idempotencyKey: key ?? null,
            createdByEmp: emp,
            createdByName: who.name ?? null,
            requestId: ctx.requestId,
            createdAt: at,
          },
          targets.map(({ device: d, params: p }) => ({
            commandId: randomUUID(),
            deviceRef: d.id,
            certDn: d.certDn,
            kind: def.kind,
            level,
            params: JSON.stringify(p),
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
    ctx.log.info({ batchId, kind: def.kind, devices: targets.length, emp, requiresApproval }, requiresApproval ? '建立批次指令(待第二人核可)' : '建立批次指令');
    const batch = await this.sqlDo(ctx, 'batch.get', () => this.store.getBatch(batchId));
    if (!batch) throw storageUnavailable();
    if (requiresApproval) return result(batch);
    await this.refillBatch(ctx, batch.id);
    return result((await this.rereadBatch(ctx, batchId)) ?? batch);
  }

  // ---------- 批次第二人核可(B1;P7-SOFTWARE-DESIGN §6) ----------

  /** 範圍內的批次;不存在或含範圍外裝置回相同的 404 */
  private async scopedBatch(ctx: MgmtCtx, batchId: string): Promise<BatchRecord> {
    const b = await this.sqlDo(ctx, 'batch.get', () => this.store.getBatch(batchId));
    if (!b || !(await this.batchInScope(ctx, b.id))) {
      if (b) ctx.log.info({ batchId, scopeDenied: true }, '批次含資料範圍外的裝置');
      throw new AppError(404, 'ITA_BATCH_NOT_FOUND', '找不到此批次');
    }
    return b;
  }

  /** 寫入後重讀批次;讀取失敗記 warn,由呼叫端退回寫入前的紀錄(寫入已成功,不回 503) */
  private async rereadBatch(ctx: Ctx, batchId: string): Promise<BatchRecord | null> {
    try {
      return await this.store.getBatch(batchId);
    } catch (err) {
      ctx.log.warn({ err, batchId }, '重讀批次失敗,回應以寫入前的狀態為準');
      return null;
    }
  }

  private assertPending(b: BatchRecord, at: Date): void {
    if (b.state !== 'pending_approval') throw new AppError(409, 'ITA_BATCH_NOT_PENDING', `此批次目前為 ${batchView(b).state},不是待核可`);
    if (at.getTime() - b.createdAt.getTime() >= APPROVAL_WINDOW_MS) throw new AppError(409, 'ITA_BATCH_NOT_PENDING', '此批次已超過 24 小時核可期限');
  }

  /** 核可人不可是建立人;核可後指令有效期限自核可時起算並開始補送 */
  /** 核可 / 駁回的路由要與批次類型相符(核可人的權限依類型而定) */
  private assertRoute(b: BatchRecord, route: ApprovalRoute): void {
    const software = SOFTWARE_KINDS.includes(b.kind);
    if (software !== (route === 'software'))
      throw new AppError(
        403,
        'ITA_APPROVAL_ROUTE_MISMATCH',
        software ? '軟體派送批次請由 /batches/{id}/approve、/reject 核可' : `${b.kind} 批次請由 /batches/{id}/approve-command、/reject-command 核可`,
      );
  }

  async approveBatch(ctx: MgmtCtx, who: GatewayIdentity, batchId: string, route: ApprovalRoute): Promise<BatchView> {
    const emp = who.emp ?? who.sub;
    const b = await this.scopedBatch(ctx, batchId);
    this.assertRoute(b, route);
    const at = this.now();
    this.assertPending(b, at);
    if (b.createdByEmp === emp) throw new AppError(403, 'ITA_APPROVER_SAME_AS_CREATOR', '核可人不可是批次建立人,請由另一位 IT 核可');
    // 批次一律用類型預設的有效期限(批次路由不開放 expiresInSec);開放覆寫時需改為記在批次上
    const expiresAt = new Date(at.getTime() + (kindOf(b.kind)?.expiresSec ?? 3600) * 1000);
    const ok = await this.sqlDo(ctx, 'batch.approve', () => this.store.approveBatch(b.id, { emp, name: who.name ?? null }, at, expiresAt));
    if (!ok) throw new AppError(409, 'ITA_BATCH_NOT_PENDING', '批次狀態已被變更,請重新整理');
    ctx.log.info({ batchId, kind: b.kind, devices: b.targetCount, createdBy: b.createdByEmp, approvedBy: emp }, '批次已核可');
    await this.refillBatch(ctx, b.id);
    if (this.limited?.kinds.includes(b.kind)) await this.refillLimited(ctx);
    return batchView((await this.rereadBatch(ctx, batchId)) ?? b);
  }

  /** 駁回(建立人也可撤回自己的批次):指令全部 canceled */
  async rejectBatch(ctx: MgmtCtx, who: GatewayIdentity, batchId: string, reason: string, route: ApprovalRoute): Promise<BatchView> {
    const emp = who.emp ?? who.sub;
    const b = await this.scopedBatch(ctx, batchId);
    this.assertRoute(b, route);
    const at = this.now();
    this.assertPending(b, at);
    const ok = await this.sqlDo(ctx, 'batch.reject', () => this.store.rejectBatch(b.id, { emp, name: who.name ?? null }, at, reason));
    if (!ok) throw new AppError(409, 'ITA_BATCH_NOT_PENDING', '批次狀態已被變更,請重新整理');
    ctx.log.info({ batchId, kind: b.kind, devices: b.targetCount, rejectedBy: emp }, '批次已駁回');
    return batchView((await this.rereadBatch(ctx, batchId)) ?? b);
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
    await this.afterFinal(ctx, cmd, { state: 'canceled', errorCode: null, resultSummary: null });
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
    return batchView(await this.scopedBatch(ctx, batchId));
  }

  // ---------- 推送 ----------

  /** 有上限的指令(批次、軟體派送)送出前的「計數 → 改為 sent」序列化鏈(單一實例;M3) */
  private sendGate: Promise<unknown> = Promise.resolve();

  /** 在序列化鏈上執行 fn;fn 失敗不會卡住後面的送出 */
  private reserve(fn: () => Promise<boolean>): Promise<boolean> {
    const run = this.sendGate.then(fn, fn);
    this.sendGate = run.catch(() => undefined);
    return run;
  }

  /** queued 且未逾期、裝置在線、批次未達上限 → 改 sent 後送出;回傳送出後的紀錄(沒送回 null)。失敗只記錄,留在 queued */
  private async trySend(ctx: Ctx, cmd: CommandRecord): Promise<CommandRecord | null> {
    const at = this.now();
    if (cmd.state !== 'queued' || cmd.expiresAt <= at || !this.channel.isOnline(cmd.deviceId)) return null;
    // 待核可、駁回、逾期的批次不送出(B1)
    if (cmd.batchState && !SENDABLE.includes(cmd.batchState)) return null;
    try {
      const claim = async () => {
        if (cmd.batchRef && cmd.batchMaxConcurrent && (await this.store.activeInBatch(cmd.batchRef)) >= cmd.batchMaxConcurrent) return false;
        // 全域並行上限
        if (this.limited?.kinds.includes(cmd.kind) && (await this.store.activeOfKinds(this.limited.kinds)) >= this.limited.max) return false;
        return this.store.transition(cmd.id, ['queued'], { state: 'sent', at });
      };
      // 有上限的(批次、軟體派送):「計數 → 改為 sent」在本行程內序列化,大量電腦同時重連時不會超過上限(單一實例;資安稽核 M3)
      const limited = !!cmd.batchRef || !!this.limited?.kinds.includes(cmd.kind);
      if (!(await (limited ? this.reserve(claim) : claim()))) return null;
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
        await this.store.finishBatchIfDone(batchRef);
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

  /** 全域並行上限類型的補送(有一筆結束、核可、每分鐘掃描時);串行執行 */
  private refillLimited(ctx: Ctx): Promise<void> {
    const limited = this.limited;
    if (!limited) return Promise.resolve();
    const run = async () => {
      try {
        // 依 id 分頁掃到底:最舊的一頁全是離線電腦時,後面在線的仍補送得到;名額已滿就提早結束
        let afterId = 0;
        for (let page = 0; page < LIMITED_MAX_PAGES; page++) {
          if ((await this.store.activeOfKinds(limited.kinds)) >= limited.max) return;
          const queued = await this.store.queuedOfKinds(limited.kinds, this.now(), BATCH_MAX_DEVICES, afterId);
          for (const cmd of queued) if (this.channel.isOnline(cmd.deviceId)) await this.trySend(ctx, cmd);
          if (queued.length < BATCH_MAX_DEVICES) return;
          afterId = queued[queued.length - 1]!.id;
        }
      } catch (err) {
        ctx.log.warn({ err }, '軟體派送補送失敗,下次掃描再試');
      }
    };
    this.limitedRefill = this.limitedRefill.then(run);
    return this.limitedRefill;
  }

  /** 依指令類型的終態處理(P7 告警);失敗只記 warn */
  private async finalHook(ctx: Ctx, cmd: CommandRecord, fin: FinalInfo): Promise<void> {
    const hook = this.kindHooks[cmd.kind]?.onFinal;
    if (!hook) return;
    try {
      await hook(ctx, cmd, fin);
    } catch (err) {
      ctx.log.warn({ err, commandId: cmd.commandId, kind: cmd.kind }, '指令終態處理失敗');
    }
  }

  /** 終態後:依類型處理,再補送(批次與全域並行上限) */
  private async afterFinal(ctx: Ctx, cmd: CommandRecord, fin: FinalInfo): Promise<void> {
    await this.finalHook(ctx, cmd, fin);
    if (cmd.batchRef) await this.refillBatch(ctx, cmd.batchRef);
    if (this.limited?.kinds.includes(cmd.kind)) await this.refillLimited(ctx);
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
    if (isFinal(target)) await this.afterFinal(ctx, cmd, { state: target, errorCode: patch.errorCode ?? null, resultSummary: patch.resultSummary ?? null });
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
      await this.afterFinal(ctx, cmd, { state: 'failed', errorCode: 'UNSUPPORTED_COMMAND', resultSummary: null });
    }
  }

  // ---------- 逾期與逾時 ----------

  /** 每分鐘呼叫:queued / sent 逾期 → expired;acked / running 逾時 → failed TIMEOUT;待核可超過 24 小時的批次 → expired(B1) */
  async sweep(ctx: Ctx): Promise<{ expired: number; timedOut: number }> {
    const at = this.now();
    try {
      const n = await this.store.expirePendingBatches(new Date(at.getTime() - APPROVAL_WINDOW_MS), at);
      if (n) ctx.log.info({ batches: n }, '待核可批次超過 24 小時,已逾期(指令取消)');
    } catch (err) {
      ctx.log.warn({ err }, '待核可批次逾期掃描失敗,下次再試');
    }
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
        ) {
          timedOut++;
          await this.finalHook(ctx, cmd, { state: 'failed', errorCode: 'TIMEOUT', resultSummary: null });
        }
        if (cmd.batchRef) batches.add(cmd.batchRef);
      } catch (err) {
        ctx.log.warn({ err, commandId: cmd.commandId }, '指令逾期處理失敗');
      }
    }
    for (const b of batches) await this.refillBatch(ctx, b);
    // 全域並行上限:等待中的指令(名額釋出、離線後上線)
    await this.refillLimited(ctx);
    if (expired || timedOut) ctx.log.info({ expired, timedOut }, '指令逾期 / 逾時');
    return { expired, timedOut };
  }
}
