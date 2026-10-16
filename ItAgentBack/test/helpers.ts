/**
 * 測試用的記憶體儲存(實作 stores/types.ts 介面):fail = true 時每個方法丟錯,模擬該儲存無法使用;calls 記錄呼叫順序。
 * 真實的 SQL Server / Mongo / Redis 由整合測試(test/int/,npm run test:int)涵蓋。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { primaryIpv4, type InventoryRequest } from '../src/contracts.js';
import { AppError } from '../src/errors.js';
import { CommandDispatcher } from '../src/services/command-dispatcher.js';
import { CommandFileService } from '../src/services/command-files.js';
import { DeviceService } from '../src/services/device-service.js';
import type {
  Actor,
  AgentEvent,
  BatchRecord,
  CommandFileRecord,
  CommandFileStore,
  CommandFilter,
  CommandPatch,
  CommandRecord,
  CommandState,
  CommandStore,
  CurrentInventory,
  DeviceEventRecord,
  DeviceEventType,
  DeviceFilter,
  DeviceRecord,
  DeviceRow,
  DeviceStatus,
  DeviceStore,
  InventorySnapshot,
  MergeResult,
  NewBatch,
  NewCommand,
  NewCommandFile,
  OnlineInfo,
  SnapshotStore,
  StateStore,
  TouchPatch,
} from '../src/stores/types.js';

export const CONTRACTS_DIR = path.resolve(import.meta.dirname, '../../docs/contracts');

export function example<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.join(CONTRACTS_DIR, 'examples', name), 'utf8')) as T;
}

export const DN = 'O=GigaNexus Dev,CN=PC-EXAMPLE-01';
export const FP = '574f45a0357c7d134a9e2f78cd7ed4dc0444ee77';

class Failable {
  fail = false;
  calls: string[] = [];
  protected hit(name: string) {
    this.calls.push(name);
    if (this.fail) throw new Error(`${this.constructor.name} 模擬故障`);
  }
}

/** 清單不篩選、第一頁(測試用) */
export const LIST_ALL = { statuses: [], page: 1, pageSize: 50 };

export class MemoryDeviceStore extends Failable implements DeviceStore {
  devices: (DeviceRecord & { mergedInto?: number | null; retiredAt?: Date | null })[] = [];
  inventories = new Map<number, InventorySnapshot>();
  events: { id?: number; deviceRef: number | null; type: DeviceEventType; detail: string }[] = [];
  agentEvents: (AgentEvent & { id?: number; deviceRef: number; receivedAt: Date })[] = [];
  /** 主機稽核與端點事件共用的寫入順序(對應 device_event.id) */
  private eventSeq = 0;

  async ping() {
    this.hit('ping');
  }
  async findByDn(certDn: string) {
    this.hit('findByDn');
    const d = this.devices.find((x) => x.certDn === certDn);
    return d ? { ...d } : null;
  }
  async register(input: { certDn: string; certFp: string; computerName: string; requestId: string; at: Date }) {
    this.hit('register');
    const d: DeviceRecord = {
      id: this.devices.length + 1,
      deviceId: randomUUID(),
      certDn: input.certDn,
      certFp: input.certFp,
      computerName: input.computerName,
      status: 'active',
      agentVersion: null,
      firstSeenAt: input.at,
      lastSeenAt: input.at,
      lastInventoryAt: null,
      hwFingerprint: null,
      clockSkewMs: null,
    };
    this.devices.push(d);
    this.events.push({ id: ++this.eventSeq, deviceRef: d.id, type: 'registered', detail: '' });
    return { ...d };
  }
  async updateFingerprint(device: DeviceRecord, certFp: string) {
    this.hit('updateFingerprint');
    this.byId(device.id).certFp = certFp;
    this.events.push({ id: ++this.eventSeq, deviceRef: device.id, type: 'fingerprint_changed', detail: device.certFp });
  }
  async addEvent(device: DeviceRecord | null, type: DeviceEventType, detail: string) {
    this.hit('addEvent');
    this.events.push({ id: ++this.eventSeq, deviceRef: device?.id ?? null, type, detail });
  }
  async addAgentEvents(device: DeviceRecord, events: AgentEvent[], receivedAt: Date) {
    this.hit('addAgentEvents');
    for (const e of events)
      if (!this.agentEvents.some((x) => x.deviceRef === device.id && x.eventUid === e.eventUid)) this.agentEvents.push({ ...e, id: ++this.eventSeq, deviceRef: device.id, receivedAt });
  }
  async touch(deviceRef: number, at: Date, patch: TouchPatch = {}) {
    this.hit('touch');
    const d = this.byId(deviceRef);
    if (d.lastSeenAt < at) d.lastSeenAt = at;
    if (patch.computerName) d.computerName = patch.computerName;
    if (patch.agentVersion) d.agentVersion = patch.agentVersion;
    if (patch.hwFingerprint) d.hwFingerprint = patch.hwFingerprint;
    if (patch.clockSkewMs !== undefined) d.clockSkewMs = patch.clockSkewMs;
  }
  async findByHwFingerprint(hwFingerprint: string, excludeRef: number) {
    this.hit('findByHwFingerprint');
    return this.devices.filter((d) => d.hwFingerprint === hwFingerprint && d.id !== excludeRef && !d.mergedInto).map((d) => ({ ...d }));
  }
  async currentInventory(deviceRef: number): Promise<CurrentInventory | null> {
    this.hit('currentInventory');
    const s = this.inventories.get(deviceRef);
    return s ? { agentSeq: s.agentSeq, contentHash: s.contentHash, collectedAt: s.collectedAt } : null;
  }
  async saveInventory(device: DeviceRecord, s: InventorySnapshot) {
    this.hit('saveInventory');
    this.inventories.set(device.id, s);
    const d = this.byId(device.id);
    d.computerName = s.inventory.system.host_name;
    d.agentVersion = s.agentVersion;
    d.lastSeenAt = s.receivedAt;
    d.lastInventoryAt = s.receivedAt;
  }
  async markInventoryUnchanged(deviceRef: number, at: Date) {
    this.hit('markInventoryUnchanged');
    const d = this.byId(deviceRef);
    d.lastSeenAt = at;
    d.lastInventoryAt = at;
  }
  private row(d: MemoryDeviceStore["devices"][number]): DeviceRow {
    const s = this.inventories.get(d.id)?.inventory;
    const ip = s ? primaryIpv4(s.network) : null;
    return {
      ...d,
      userName: s?.system.user_name ?? null,
      domain: s?.system.domain ?? null,
      osName: s?.system.os_name ?? null,
      osVersion: s ? `${s.system.os_display_version} / ${s.system.os_build}` : null,
      manufacturer: s?.system.manufacturer ?? null,
      model: s?.system.model ?? null,
      cpuName: s?.cpu.name ?? null,
      memoryTotal: s?.memory_total ?? null,
      ips: ip ? [ip] : [],
      suspectedDuplicate:
        !!d.hwFingerprint && this.devices.some((o) => o.id !== d.id && o.hwFingerprint === d.hwFingerprint && !o.mergedInto && o.status !== 'retired'),
      mergedIntoId: d.mergedInto ? this.byId(d.mergedInto).deviceId : null,
      retiredAt: d.retiredAt ?? null,
    };
  }
  async listDevices(f: DeviceFilter) {
    this.hit('listDevices');
    const statuses: DeviceStatus[] = f.statuses.length ? f.statuses : ['active', 'disabled'];
    const has = (v: string | null | undefined, q: string) => !!v && v.toLowerCase().includes(q.toLowerCase());
    return this.devices
      .filter((d) => statuses.includes(d.status))
      .filter((d) => {
        const inv = this.inventories.get(d.id)?.inventory;
        if (f.q) {
          const q = f.q;
          const nics = inv?.network ?? [];
          const hit =
            has(d.computerName, q) ||
            has(inv?.system.user_name, q) ||
            has(d.deviceId, q) ||
            nics.some((n) => n.ips.some((ip) => has(ip, q)) || has(n.mac, q.replace(/-/g, ':')));
          if (!hit) return false;
        }
        if (f.software && !(inv?.software ?? []).some((x) => has(x.name, f.software!))) return false;
        if (f.os && !(has(inv?.system.os_name, f.os) || has(inv?.system.os_display_version, f.os))) return false;
        return true;
      })
      .sort((a, b) => a.computerName.localeCompare(b.computerName) || a.id - b.id)
      .map((d) => this.row(d));
  }
  async listEvents(deviceRef: number, beforeId: number | undefined, limit: number): Promise<DeviceEventRecord[]> {
    this.hit('listEvents');
    const all: DeviceEventRecord[] = [
      ...this.events
        .filter((e) => e.deviceRef === deviceRef)
        .map((e) => ({ id: e.id ?? 0, type: e.type, occurredAt: new Date(0), receivedAt: null, detail: e.detail, data: null })),
      ...this.agentEvents
        .filter((e) => e.deviceRef === deviceRef)
        .map((e) => ({ id: e.id ?? 0, type: e.type, occurredAt: e.occurredAt, receivedAt: e.receivedAt, detail: null, data: e.data })),
    ];
    return all
      .filter((e) => beforeId === undefined || e.id < beforeId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
  async setStatus(deviceRef: number, status: DeviceStatus, detail: string, _requestId: string, actor: Actor) {
    this.hit('setStatus');
    const d = this.byId(deviceRef);
    if (d.mergedInto) return false;
    d.status = status;
    d.retiredAt = status === 'retired' ? (d.retiredAt ?? new Date()) : status === 'active' ? null : (d.retiredAt ?? null);
    this.events.push({ id: ++this.eventSeq, deviceRef, type: status === 'active' ? 'enabled' : status, detail: `${actor.emp};${detail}` });
    return true;
  }
  async merge(targetRef: number, sourceRef: number, detail: string, _requestId: string, actor: Actor): Promise<MergeResult> {
    this.hit('merge');
    const t = this.byId(targetRef);
    const src = this.byId(sourceRef);
    if (t.mergedInto) throw new AppError(409, 'ITA_MERGE_INVALID', '目標裝置已併入其他裝置', { reason: 'target_merged' });
    if (src.mergedInto === targetRef) throw new AppError(409, 'ITA_MERGE_INVALID', '來源裝置已併入此裝置', { reason: 'already_merged' });
    if (src.mergedInto) throw new AppError(409, 'ITA_MERGE_INVALID', '來源裝置已合併過', { reason: 'source_merged' });
    const tInv = this.inventories.get(targetRef);
    const sInv = this.inventories.get(sourceRef);
    const inventoryFrom: MergeResult['inventoryFrom'] = !tInv && !sInv ? 'none' : !tInv || (sInv && sInv.collectedAt > tInv.collectedAt) ? 'source' : 'target';
    if (inventoryFrom === 'source') this.inventories.set(targetRef, sInv!);
    this.inventories.delete(sourceRef);
    let events = 0;
    for (const e of [...this.events, ...this.agentEvents])
      if (e.deviceRef === sourceRef) {
        e.deviceRef = targetRef;
        events++;
      }
    const oldDn = t.certDn;
    Object.assign(t, {
      certDn: src.certDn,
      certFp: src.certFp,
      computerName: src.computerName,
      agentVersion: src.agentVersion ?? t.agentVersion,
      hwFingerprint: src.hwFingerprint ?? t.hwFingerprint,
    });
    Object.assign(src, { certDn: `merged:${src.deviceId}`, status: 'retired', mergedInto: targetRef, retiredAt: new Date() });
    this.events.push({ id: ++this.eventSeq, deviceRef: targetRef, type: 'merged', detail: `${actor.emp};${src.deviceId};${oldDn};${detail}` });
    return { events, commands: this.mergedCommands?.(sourceRef, targetRef) ?? 0, canceledCommands: 0, inventoryFrom };
  }
  /** 指令儲存掛上時搬指令(MemoryCommandStore 設定) */
  mergedCommands?: (from: number, to: number) => number;
  softwareBackfilled: number[] = [];
  async backfillSoftware(afterRef: number, limit: number) {
    this.hit('backfillSoftware');
    const todo = [...this.inventories.keys()]
      .filter((ref) => ref > afterRef && !this.softwareBackfilled.includes(ref))
      .sort((a, b) => a - b)
      .slice(0, limit);
    this.softwareBackfilled.push(...todo);
    return { lastRef: todo.length === limit ? todo[todo.length - 1]! : null, done: todo.length, failed: [] };
  }
  async getDevice(deviceId: string) {
    this.hit('getDevice');
    const d = this.devices.find((x) => x.deviceId === deviceId);
    if (!d) return null;
    const s = this.inventories.get(d.id);
    return { row: this.row(d), payload: s?.payload ?? null, collectedAt: s?.collectedAt ?? null };
  }
  async close() {}
  byId(id: number): MemoryDeviceStore["devices"][number] {
    const d = this.devices.find((x) => x.id === id);
    if (!d) throw new Error(`no device ${id}`);
    return d;
  }
}

export class MemorySnapshotStore extends Failable implements SnapshotStore {
  snapshots: { deviceId: string; agentSeq: number; contentHash: string }[] = [];
  heartbeats: { deviceId: string; at: Date }[] = [];
  async ping() {
    this.hit('ping');
  }
  async insertSnapshot({ deviceId, snapshot }: { deviceId: string; snapshot: InventorySnapshot }) {
    this.hit('insertSnapshot');
    if (!this.snapshots.some((s) => s.deviceId === deviceId && s.agentSeq === snapshot.agentSeq && s.contentHash === snapshot.contentHash))
      this.snapshots.push({ deviceId, agentSeq: snapshot.agentSeq, contentHash: snapshot.contentHash });
  }
  async recordHeartbeat({ deviceId, at }: { deviceId: string; at: Date }) {
    this.hit('recordHeartbeat');
    this.heartbeats.push({ deviceId, at });
  }
  async reassign(fromDeviceId: string, toDeviceId: string) {
    this.hit('reassign');
    for (const x of this.snapshots) if (x.deviceId === fromDeviceId) x.deviceId = toDeviceId;
    for (const x of this.heartbeats) if (x.deviceId === fromDeviceId) x.deviceId = toDeviceId;
  }
  async seenSnapshots(deviceId: string, items: { seq: number; hash: string }[]) {
    this.hit('seenSnapshots');
    const keys = new Set(items.map((i) => `${i.seq}:${i.hash}`));
    return new Set(this.snapshots.filter((x) => x.deviceId === deviceId).map((x) => `${x.agentSeq}:${x.contentHash}`).filter((k) => keys.has(k)));
  }
  async close() {}
}

export class MemoryStateStore extends Failable implements StateStore {
  online = new Map<string, OnlineInfo>();
  hashes = new Map<string, string>();
  async ping() {
    this.hit('ping');
  }
  async setOnline(deviceId: string, info: OnlineInfo) {
    this.hit('setOnline');
    this.online.set(deviceId, info);
  }
  async clearOnline(deviceId: string) {
    this.hit('clearOnline');
    this.online.delete(deviceId);
  }
  async onlineOf(deviceIds: string[]) {
    this.hit('onlineOf');
    return new Map(deviceIds.filter((id) => this.online.has(id)).map((id) => [id, this.online.get(id)!]));
  }
  async getHash(deviceId: string) {
    this.hit('getHash');
    return this.hashes.get(deviceId) ?? null;
  }
  async setHash(deviceId: string, hash: string) {
    this.hit('setHash');
    this.hashes.set(deviceId, hash);
  }
  async clearHash(deviceId: string) {
    this.hit('clearHash');
    this.hashes.delete(deviceId);
  }
  async close() {}
}

/** 可手動前進的時鐘 */
export class Clock {
  t = new Date('2026-10-06T08:00:00Z').getTime();
  now = () => new Date(this.t);
  advance(sec: number) {
    this.t += sec * 1000;
  }
}

export function setup() {
  const sql = new MemoryDeviceStore();
  const mongo = new MemorySnapshotStore();
  const redis = new MemoryStateStore();
  const clock = new Clock();
  const service = new DeviceService(sql, mongo, redis, { heartbeatIntervalSec: 30, now: clock.now });
  return { sql, mongo, redis, clock, service };
}

/** 範例回報,可覆寫序號、時間、hash */
export function inventoryRequest(patch: Partial<InventoryRequest> = {}): InventoryRequest {
  return { ...example<InventoryRequest>('inventory.sample.json'), ...patch };
}

export const certHeaders = (fp = FP) => ({ 'x-client-cert-dn': DN, 'x-client-cert-fp': fp, 'x-client-verify': 'SUCCESS', 'x-request-id': 'req-agent-1' });

/** 指令儲存(記憶體版,與 SqlCommandStore 相同的條件更新語意) */
export class MemoryCommandStore extends Failable implements CommandStore, CommandFileStore {
  commands: (NewCommand & { id: number; batchRef: number | null; state: CommandState } & Partial<CommandRecord>)[] = [];
  batches: (NewBatch & { id: number; targetCount: number })[] = [];
  files: (NewCommandFile & { id: number })[] = [];
  constructor(private readonly devices: MemoryDeviceStore) {
    super();
  }
  private rec(c: MemoryCommandStore['commands'][number]): CommandRecord {
    const d = this.devices.byId(c.deviceRef);
    const b = this.batches.find((x) => x.id === c.batchRef);
    return {
      progress: null,
      resultSummary: null,
      errorCode: null,
      errorMessage: null,
      timeoutAt: null,
      sendCount: 0,
      sentAt: null,
      ackedAt: null,
      startedAt: null,
      finishedAt: null,
      ...c,
      batchId: b?.batchId ?? null,
      batchMaxConcurrent: b?.maxConcurrent ?? null,
      deviceId: d.deviceId,
      computerName: d.computerName,
      requestId: c.requestId,
    } as CommandRecord;
  }
  private batchRec(b: MemoryCommandStore['batches'][number]): BatchRecord {
    const counts: BatchRecord['counts'] = {};
    for (const c of this.commands.filter((x) => x.batchRef === b.id)) counts[c.state] = (counts[c.state] ?? 0) + 1;
    return { ...b, counts };
  }
  async createCommands(batch: NewBatch | null, commands: NewCommand[]) {
    this.hit('createCommands');
    for (const c of commands)
      if (c.idempotencyKey && this.commands.some((x) => x.createdByEmp === c.createdByEmp && x.idempotencyKey === c.idempotencyKey))
        throw Object.assign(new Error('duplicate'), { number: 2601 });
    let batchRef: number | null = null;
    if (batch) {
      batchRef = this.batches.length + 1;
      this.batches.push({ ...batch, id: batchRef, targetCount: commands.length });
    }
    for (const c of commands) this.commands.push({ ...c, id: this.commands.length + 1, batchRef, state: 'queued' });
  }
  async getCommand(commandId: string) {
    this.hit('getCommand');
    const c = this.commands.find((x) => x.commandId === commandId);
    return c ? this.rec(c) : null;
  }
  async findByIdempotency(emp: string, key: string) {
    this.hit('findByIdempotency');
    const c = this.commands.find((x) => x.createdByEmp === emp && x.idempotencyKey === key && x.batchRef === null);
    return c ? this.rec(c) : null;
  }
  async findBatchByIdempotency(emp: string, key: string) {
    this.hit('findBatchByIdempotency');
    const b = this.batches.find((x) => x.createdByEmp === emp && x.idempotencyKey === key);
    return b ? this.batchRec(b) : null;
  }
  async getBatch(batchId: string) {
    this.hit('getBatch');
    const b = this.batches.find((x) => x.batchId === batchId);
    return b ? this.batchRec(b) : null;
  }
  async listCommands(f: CommandFilter) {
    this.hit('listCommands');
    return this.commands
      .filter(
        (c) =>
          (f.deviceRef === undefined || c.deviceRef === f.deviceRef) &&
          (f.batchRef === undefined || c.batchRef === f.batchRef) &&
          (!f.state || c.state === f.state) &&
          (!f.kind || c.kind === f.kind) &&
          (f.beforeId === undefined || c.id < f.beforeId),
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, f.limit)
      .map((c) => this.rec(c));
  }
  async transition(id: number, from: CommandState[], p: CommandPatch) {
    this.hit('transition');
    const c = this.commands.find((x) => x.id === id);
    if (!c || !from.includes(c.state)) return false;
    c.state = p.state;
    if (p.progress !== undefined) c.progress = p.progress;
    if (p.resultSummary !== undefined) c.resultSummary = p.resultSummary;
    if (p.errorCode) c.errorCode = p.errorCode;
    if (p.errorMessage) c.errorMessage = p.errorMessage;
    c.timeoutAt ??= p.timeoutAt ?? null;
    if (p.state === 'sent') {
      c.sendCount = (c.sendCount ?? 0) + 1;
      c.sentAt = p.at;
    }
    if (['acked', 'running', 'succeeded', 'failed'].includes(p.state) && !c.ackedAt && c.sentAt) c.ackedAt = p.at;
    if (p.state === 'running') c.startedAt ??= p.at;
    if (p.markStarted) c.startedAt ??= c.ackedAt ?? p.at;
    if (['succeeded', 'failed', 'canceled', 'expired'].includes(p.state)) c.finishedAt = p.at;
    return true;
  }
  async requeueSent(deviceRef: number) {
    this.hit('requeueSent');
    let n = 0;
    for (const c of this.commands)
      if (c.deviceRef === deviceRef && c.state === 'sent') {
        c.state = 'queued';
        n++;
      }
    return n;
  }
  async queuedForDevice(deviceRef: number, now: Date) {
    this.hit('queuedForDevice');
    return this.commands.filter((c) => c.deviceRef === deviceRef && c.state === 'queued' && c.expiresAt > now).map((c) => this.rec(c));
  }
  async queuedForBatch(batchRef: number, now: Date, limit: number) {
    this.hit('queuedForBatch');
    return this.commands
      .filter((c) => c.batchRef === batchRef && c.state === 'queued' && c.expiresAt > now)
      .slice(0, limit)
      .map((c) => this.rec(c));
  }
  async activeInBatch(batchRef: number) {
    this.hit('activeInBatch');
    return this.commands.filter((c) => c.batchRef === batchRef && ['sent', 'acked', 'running'].includes(c.state)).length;
  }
  async pendingCount(deviceRef: number, kind: string) {
    this.hit('pendingCount');
    return this.commands.filter((c) => c.deviceRef === deviceRef && c.kind === kind && ['queued', 'sent', 'acked', 'running'].includes(c.state)).length;
  }
  async dueForSweep(now: Date, limit: number) {
    this.hit('dueForSweep');
    return this.commands
      .filter((c) => (['queued', 'sent'].includes(c.state) && c.expiresAt <= now) || (['acked', 'running'].includes(c.state) && c.timeoutAt && c.timeoutAt <= now))
      .slice(0, limit)
      .map((c) => this.rec(c));
  }
  private fileRec(f: MemoryCommandStore['files'][number]): CommandFileRecord {
    return { ...f, commandId: this.commands.find((c) => c.id === f.commandRef)!.commandId };
  }
  async addFile(f: NewCommandFile) {
    this.hit('addFile');
    this.files.push({ ...f, id: this.files.length + 1 });
  }
  async listFiles(commandRef: number) {
    this.hit('listFiles');
    return this.files.filter((f) => f.commandRef === commandRef).map((f) => this.fileRec(f));
  }
  async getFile(fileId: string) {
    this.hit('getFile');
    const f = this.files.find((x) => x.fileId === fileId);
    return f ? this.fileRec(f) : null;
  }
  async expiredFiles(now: Date, limit: number) {
    this.hit('expiredFiles');
    return this.files
      .filter((f) => f.expiresAt <= now)
      .slice(0, limit)
      .map((f) => this.fileRec(f));
  }
  async deleteFile(id: number) {
    this.hit('deleteFile');
    this.files = this.files.filter((f) => f.id !== id);
  }
}

/** 假的 WebSocket 連線:記錄送出的信封 */
export class FakeConnection {
  sent: { type: string; id: string; body: Record<string, unknown> }[] = [];
  closed: number | null = null;
  broken = false;
  send(text: string) {
    if (this.broken) throw new Error('socket closed');
    this.sent.push(JSON.parse(text) as FakeConnection['sent'][number]);
  }
  close(code: number) {
    this.closed = code;
  }
  terminate() {
    this.closed = 1006;
  }
}

export function setupCommands(opts: { batchMaxConcurrent?: number } = {}) {
  const base = setup();
  const store = new MemoryCommandStore(base.sql);
  const commands = new CommandDispatcher(store, base.sql, base.service, { now: base.clock.now, ...opts });
  // 指令附檔放在每次測試各自的暫存目錄
  const filesDir = mkdtempSync(path.join(tmpdir(), 'ita-files-'));
  const files = new CommandFileService(store, filesDir, { keepDays: 14, now: base.clock.now });
  return { ...base, store, commands, files, filesDir };
}
