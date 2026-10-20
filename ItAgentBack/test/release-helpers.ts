/**
 * 升級測試用:記憶體版 ReleaseStore(與 SqlReleaseStore 相同語意)、暫存版本檔目錄、組好的 ReleaseService。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../src/errors.js';
import { ReleaseFiles } from '../src/services/release-files.js';
import { ReleaseService } from '../src/services/release-service.js';
import type {
  Actor,
  AlertRule,
  DeviceUpgradeRecord,
  NewRelease,
  ReleaseComponent,
  ReleaseRecord,
  ReleaseStatus,
  ReleaseStore,
  Ring,
  RingRecord,
  UpgradePatch,
  UpgradeTargetRow,
} from '../src/stores/types.js';
import { MemoryDeviceStore, MemoryMonitorStore, setup } from './helpers.js';

const ACTIVE = ['pending', 'downloading', 'verifying', 'installing'];

export class MemoryReleaseStore implements ReleaseStore {
  releases: ReleaseRecord[] = [];
  rings: RingRecord[] = [];
  ringOf = new Map<number, Ring>();
  upgrades: DeviceUpgradeRecord[] = [];
  private seq = 0;

  constructor(
    private readonly devices: MemoryDeviceStore,
    private readonly monitor: MemoryMonitorStore,
  ) {
    for (const ring of ['pilot', 'it', 'all'] as Ring[])
      for (const component of ['agent', 'watchdog'] as ReleaseComponent[])
        this.rings.push({ ring, component, targetVersion: null, targetSetAt: null, updatedByEmp: null, updatedByName: null, updatedAt: new Date(0) });
  }

  async listReleases(f: { component?: ReleaseComponent; status?: ReleaseStatus }) {
    return this.releases.filter((r) => (!f.component || r.component === f.component) && (!f.status || r.status === f.status)).map((r) => ({ ...r }));
  }
  async getRelease(releaseId: string) {
    const r = this.releases.find((x) => x.releaseId === releaseId);
    return r ? { ...r } : null;
  }
  async findRelease(component: ReleaseComponent, version: string) {
    const r = this.releases.find((x) => x.component === component && x.version === version);
    return r ? { ...r } : null;
  }
  async addRelease(n: NewRelease) {
    if (this.releases.some((x) => x.component === n.component && x.version === n.version))
      throw new AppError(409, 'ITA_RELEASE_EXISTS', `${n.component} ${n.version} 已登錄`);
    const r: ReleaseRecord = {
      id: ++this.seq,
      releaseId: randomUUID(),
      component: n.component,
      version: n.version,
      fileName: n.fileName,
      sha256: n.sha256,
      sizeBytes: n.sizeBytes,
      signerThumbprints: n.signerThumbprints,
      status: 'draft',
      notes: n.notes,
      createdByEmp: n.actor.emp,
      createdByName: n.actor.name,
      createdAt: n.at,
      publishedByEmp: null,
      publishedAt: null,
      revokedByEmp: null,
      revokedAt: null,
    };
    this.releases.push(r);
    return { ...r };
  }
  async setReleaseStatus(releaseId: string, from: ReleaseStatus[], to: ReleaseStatus, actor: Actor, at: Date) {
    const r = this.releases.find((x) => x.releaseId === releaseId);
    if (!r || !from.includes(r.status)) return { ok: false, clearedRings: [] };
    r.status = to;
    if (to === 'published') Object.assign(r, { publishedByEmp: actor.emp, publishedAt: at });
    const clearedRings: Ring[] = [];
    if (to === 'revoked') {
      Object.assign(r, { revokedByEmp: actor.emp, revokedAt: at });
      for (const g of this.rings)
        if (g.component === r.component && g.targetVersion === r.version) {
          Object.assign(g, { targetVersion: null, targetSetAt: at });
          clearedRings.push(g.ring);
        }
      for (const u of this.upgrades)
        if (u.component === r.component && u.forcedVersion === r.version) Object.assign(u, { forcedVersion: null, forcedByEmp: null, forcedAt: null });
    }
    return { ok: true, clearedRings };
  }
  async listRings() {
    return this.rings.map((r) => ({ ...r }));
  }
  async setRingTarget(ring: Ring, component: ReleaseComponent, version: string | null, actor: Actor, at: Date) {
    const g = this.rings.find((x) => x.ring === ring && x.component === component)!;
    if (g.targetVersion !== version) g.targetSetAt = at;
    Object.assign(g, { targetVersion: version, updatedByEmp: actor.emp, updatedByName: actor.name, updatedAt: at });
  }
  async setDeviceRing(deviceRef: number, ring: Ring) {
    this.ringOf.set(deviceRef, ring);
  }
  async deviceRing(deviceRef: number) {
    return this.devices.devices.some((d) => d.id === deviceRef) ? (this.ringOf.get(deviceRef) ?? 'all') : null;
  }
  async deviceUpgrades(deviceRef: number) {
    return this.upgrades.filter((u) => u.deviceRef === deviceRef).map((u) => ({ ...u }));
  }
  async saveUpgrade(deviceRef: number, component: ReleaseComponent, p: UpgradePatch, at: Date) {
    const clean: UpgradePatch = {
      targetVersion: p.targetVersion,
      fromVersion: p.fromVersion,
      state: p.state,
      attempts: p.attempts,
      errorCode: p.errorCode,
      errorMessage: p.errorMessage,
      forcedVersion: p.forcedVersion,
      forcedByEmp: p.forcedByEmp,
      forcedAt: p.forcedAt,
      startedAt: p.startedAt,
    };
    const u = this.upgrades.find((x) => x.deviceRef === deviceRef && x.component === component);
    if (u) Object.assign(u, clean, { updatedAt: at });
    else this.upgrades.push({ deviceRef, component, ...clean, updatedAt: at });
  }
  async activeUpgrades(pendingSince: Date, activeSince: Date) {
    return new Set(
      this.upgrades
        .filter((u) => u.targetVersion !== null)
        .filter(
          (u) => (u.state === 'pending' && u.updatedAt >= pendingSince) || (ACTIVE.includes(u.state) && u.state !== 'pending' && u.updatedAt >= activeSince),
        )
        .map((u) => u.deviceRef),
    ).size;
  }
  async upgradeTargets(companies?: string[], deviceRef?: number): Promise<UpgradeTargetRow[]> {
    return this.devices.devices
      .filter((d) => d.status === 'active' && !d.mergedInto && (deviceRef === undefined || d.id === deviceRef))
      .filter((d) => !companies || (d.company !== null && companies.includes(d.company)))
      .map((d) => {
        const h = this.monitor.health.get(d.id);
        return {
          deviceRef: d.id,
          deviceId: d.deviceId,
          company: d.company,
          ring: this.ringOf.get(d.id) ?? 'all',
          lastSeenAt: d.lastSeenAt,
          agentVersion: d.agentVersion,
          watchdogVersion: h?.watchdogVersion ?? null,
          watchdogReportAt: h?.watchdogReportAt ?? null,
          upgrades: this.upgrades.filter((u) => u.deviceRef === d.id).map((u) => ({ ...u })),
          openRules: this.monitor.alerts
            .filter((a) => a.deviceRef === d.id && a.state === 'open' && (a.rule === 'upgrade_failed' || a.rule === 'version_mismatch'))
            .map((a) => a.rule as AlertRule),
        };
      });
  }
}

/** 測試用簽章者指紋 */
export const SIGNER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** 暫存版本檔目錄;寫入檔案回傳 SHA-256 */
export function releasesDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'ita-releases-'));
  const put = (component: string, version: string, fileName: string, content: string | Buffer) => {
    mkdirSync(path.join(root, component, version), { recursive: true });
    writeFileSync(path.join(root, component, version, fileName), content);
    return createHash('sha256').update(content).digest('hex');
  };
  return { root, put };
}

export function setupReleases(opts: { maxConcurrent?: number } = {}) {
  const base = setup();
  const store = new MemoryReleaseStore(base.sql, base.monitor);
  const dir = releasesDir();
  const releases = new ReleaseService(store, new ReleaseFiles(dir.root), base.monitor, base.sql, (id) => base.service.lookup(id), {
    now: base.clock.now,
    maxConcurrent: opts.maxConcurrent,
  });
  return { ...base, store, dir, releases };
}
