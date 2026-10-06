/**
 * 測試用的記憶體儲存(實作 stores/types.ts 介面):fail = true 時每個方法丟錯,模擬該儲存無法使用;calls 記錄呼叫順序。
 * 真實的 SQL Server / Mongo / Redis 由整合測試(test/int/,npm run test:int)涵蓋。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { primaryIpv4, type InventoryRequest } from '../src/contracts.js';
import { DeviceService } from '../src/services/device-service.js';
import type {
  CurrentInventory,
  DeviceEventType,
  DeviceRecord,
  DeviceRow,
  DeviceStore,
  InventorySnapshot,
  OnlineInfo,
  SnapshotStore,
  StateStore,
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

export class MemoryDeviceStore extends Failable implements DeviceStore {
  devices: DeviceRecord[] = [];
  inventories = new Map<number, InventorySnapshot>();
  events: { deviceRef: number | null; type: DeviceEventType; detail: string }[] = [];

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
    };
    this.devices.push(d);
    this.events.push({ deviceRef: d.id, type: 'registered', detail: '' });
    return { ...d };
  }
  async updateFingerprint(device: DeviceRecord, certFp: string) {
    this.hit('updateFingerprint');
    this.byId(device.id).certFp = certFp;
    this.events.push({ deviceRef: device.id, type: 'fingerprint_changed', detail: device.certFp });
  }
  async addEvent(device: DeviceRecord | null, type: DeviceEventType, detail: string) {
    this.hit('addEvent');
    this.events.push({ deviceRef: device?.id ?? null, type, detail });
  }
  async touch(deviceRef: number, at: Date, patch: { computerName?: string; agentVersion?: string } = {}) {
    this.hit('touch');
    const d = this.byId(deviceRef);
    if (d.lastSeenAt < at) d.lastSeenAt = at;
    if (patch.computerName) d.computerName = patch.computerName;
    if (patch.agentVersion) d.agentVersion = patch.agentVersion;
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
  private row(d: DeviceRecord): DeviceRow {
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
    };
  }
  async listDevices() {
    this.hit('listDevices');
    return this.devices.map((d) => this.row(d));
  }
  async getDevice(deviceId: string) {
    this.hit('getDevice');
    const d = this.devices.find((x) => x.deviceId === deviceId);
    if (!d) return null;
    const s = this.inventories.get(d.id);
    return { row: this.row(d), payload: s?.payload ?? null, collectedAt: s?.collectedAt ?? null };
  }
  async close() {}
  byId(id: number): DeviceRecord {
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
