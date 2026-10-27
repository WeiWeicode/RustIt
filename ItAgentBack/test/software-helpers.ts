/**
 * 軟體派送測試用:記憶體版 SoftwareStore(與 SqlSoftwareStore 相同語意)、暫存軟體庫、組好的 SoftwareService + CommandDispatcher(kindHooks 與 server.ts 相同接法)。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SOFTWARE_KINDS } from '../src/commands/kinds.js';
import { AppError } from '../src/errors.js';
import { CommandDispatcher } from '../src/services/command-dispatcher.js';
import { SoftwareFiles } from '../src/services/software-files.js';
import { SoftwareService } from '../src/services/software-service.js';
import type { Actor, InstallResultRow, NewPackage, PackagePatch, PackageRecord, PackageStatus, Ring, SoftwareStore } from '../src/stores/types.js';
import { MemoryCommandStore, MemoryDeviceStore, setup } from './helpers.js';

/** SQL LIKE(ESCAPE '\\',不分大小寫)→ RegExp */
function likeToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is');
}

export class MemorySoftwareStore implements SoftwareStore {
  packages: PackageRecord[] = [];
  ringOf = new Map<number, Ring>();
  private seq = 0;

  constructor(
    private readonly devices: MemoryDeviceStore,
    private readonly commands: MemoryCommandStore,
  ) {}

  private pkgParam = (params: string) => {
    try {
      return String((JSON.parse(params) as { package_id?: unknown }).package_id ?? '');
    } catch {
      return '';
    }
  };

  async listPackages(f: { status?: PackageStatus; q?: string }) {
    return this.packages
      .filter((p) => (!f.status || p.status === f.status) && (!f.q || p.name.toLowerCase().includes(f.q.toLowerCase())))
      .map((p) => ({ ...p }));
  }
  async getPackage(packageId: string) {
    const p = this.packages.find((x) => x.packageId === packageId);
    return p ? { ...p } : null;
  }
  async addPackage(n: NewPackage) {
    if (this.packages.some((x) => (x.name === n.name && x.version === n.version) || x.fileName === n.fileName))
      throw new AppError(409, 'ITA_PACKAGE_EXISTS', `${n.name} ${n.version} 或檔案 ${n.fileName} 已登錄`);
    const p: PackageRecord = {
      id: ++this.seq,
      packageId: randomUUID(),
      name: n.name,
      version: n.version,
      fileName: n.fileName,
      sha256: n.sha256,
      sizeBytes: n.sizeBytes,
      installerType: n.installerType,
      installArgs: n.installArgs,
      uninstallArgs: n.uninstallArgs,
      detectType: n.detectType,
      detectValue: n.detectValue,
      rebootPolicy: n.rebootPolicy,
      timeoutSec: n.timeoutSec,
      signerThumbprints: [],
      observedSigners: [],
      licenseLimit: n.licenseLimit,
      status: 'draft',
      notes: n.notes,
      createdByEmp: n.actor.emp,
      createdByName: n.actor.name,
      createdAt: n.at,
      updatedByEmp: null,
      updatedAt: null,
      editors: [],
      testedByEmp: null,
      testedAt: null,
      publishedByEmp: null,
      publishedByName: null,
      publishedAt: null,
      revokedByEmp: null,
      revokedAt: null,
      revokedFrom: null,
    };
    this.packages.push(p);
    return { ...p };
  }
  async updatePackage(packageId: string, expect: PackageStatus, patch: PackagePatch, actor: Actor, at: Date) {
    const p = this.packages.find((x) => x.packageId === packageId);
    if (!p || p.status !== expect) return false;
    const { revertToDraft, argsChanged, ...fields } = patch;
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) (p as unknown as Record<string, unknown>)[k] = v;
    Object.assign(p, { updatedByEmp: actor.emp, updatedAt: at });
    if (argsChanged) p.editors = expect === 'published' ? [actor.emp] : [...new Set([...p.editors, actor.emp])];
    if (revertToDraft)
      for (const c of this.commands.commands)
        if (c.kind.startsWith('software.') && c.state === 'queued' && this.pkgParam(c.params) === packageId)
          Object.assign(c, { state: 'canceled', errorCode: 'PACKAGE_CHANGED', finishedAt: at });
    if (revertToDraft)
      Object.assign(p, {
        status: 'draft',
        signerThumbprints: [],
        testedByEmp: null,
        testedAt: null,
        publishedByEmp: null,
        publishedByName: null,
        publishedAt: null,
      });
    return true;
  }
  async markTested(packageId: string, signers: string[], observed: string[], actor: Actor, at: Date) {
    const p = this.packages.find((x) => x.packageId === packageId);
    if (!p || p.status !== 'draft') return false;
    Object.assign(p, { status: 'tested', signerThumbprints: signers, observedSigners: observed, testedByEmp: actor.emp, testedAt: at });
    return true;
  }
  async publish(packageId: string, actor: Actor, at: Date) {
    const p = this.packages.find((x) => x.packageId === packageId);
    if (!p || p.status !== 'tested' || p.createdByEmp === actor.emp || p.editors.includes(actor.emp) || p.signerThumbprints.length === 0) return false;
    Object.assign(p, { status: 'published', publishedByEmp: actor.emp, publishedByName: actor.name, publishedAt: at });
    return true;
  }
  async cancelQueuedInstalls(packageId: string, errorCode: string, at: Date) {
    const refs: number[] = [];
    for (const c of this.commands.commands)
      if (c.kind === 'software.install' && c.state === 'queued' && this.pkgParam(c.params) === packageId) {
        Object.assign(c, { state: 'canceled', errorCode, finishedAt: at });
        refs.push(c.deviceRef);
      }
    return refs;
  }
  async revoke(packageId: string, actor: Actor, at: Date) {
    const p = this.packages.find((x) => x.packageId === packageId);
    if (!p || p.status === 'revoked') return { ok: false, canceledCommands: 0 };
    Object.assign(p, { status: 'revoked', revokedFrom: p.status, revokedByEmp: actor.emp, revokedAt: at });
    let n = 0;
    for (const c of this.commands.commands)
      if (c.kind === 'software.install' && c.state === 'queued' && this.pkgParam(c.params) === packageId) {
        Object.assign(c, { state: 'canceled', errorCode: 'PACKAGE_REVOKED', finishedAt: at });
        n++;
      }
    return { ok: true, canceledCommands: n };
  }
  async installResults(packageId: string, limit: number): Promise<InstallResultRow[]> {
    return this.commands.commands
      .filter((c) => c.kind === 'software.install' && this.pkgParam(c.params) === packageId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((c) => {
        const d = this.devices.byId(c.deviceRef);
        return {
          commandId: c.commandId,
          deviceId: d.deviceId,
          computerName: d.computerName,
          deviceCompany: d.company,
          ring: this.ringOf.get(d.id) ?? 'all',
          state: c.state,
          params: c.params,
          resultSummary: c.resultSummary ?? null,
          errorCode: c.errorCode ?? null,
          createdByEmp: c.createdByEmp,
          finishedAt: c.finishedAt ?? null,
        };
      });
  }
  async activeInstallPackages(deviceRef: number) {
    return this.commands.commands
      .filter((c) => c.deviceRef === deviceRef && c.kind === 'software.install' && ['sent', 'acked', 'running'].includes(c.state))
      .map((c) => ({ packageId: this.pkgParam(c.params), params: JSON.parse(c.params) as Record<string, unknown> }));
  }
  async deviceRing(deviceRef: number) {
    return this.devices.devices.some((d) => d.id === deviceRef) ? (this.ringOf.get(deviceRef) ?? 'all') : null;
  }
  private matches(pattern: string, companies?: string[]) {
    const re = likeToRegExp(pattern);
    const out: { d: MemoryDeviceStore['devices'][number]; name: string; version: string | null }[] = [];
    for (const d of this.devices.devices) {
      if (d.status !== 'active' || d.mergedInto) continue;
      if (companies && (d.company === null || !companies.includes(d.company))) continue;
      for (const s of this.devices.inventories.get(d.id)?.inventory.software ?? [])
        if (re.test(s.name)) out.push({ d, name: s.name, version: s.version ?? null });
    }
    return out;
  }
  async installedCounts(patterns: string[], companies?: string[]) {
    return patterns.map((p) => new Set(this.matches(p, companies).map((m) => m.d.id)).size);
  }
  async installedDevices(pattern: string, opts: { companies?: string[]; onlyRefs?: number[]; limit: number }) {
    return this.matches(pattern, opts.companies)
      .filter((m) => !opts.onlyRefs || opts.onlyRefs.includes(m.d.id))
      .slice(0, opts.limit)
      .map((m) => ({ deviceRef: m.d.id, deviceId: m.d.deviceId, computerName: m.d.computerName, company: m.d.company, name: m.name, version: m.version }));
  }
}

/** 測試用簽章者指紋 */
export const PKG_SIGNER = 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678';

/** 暫存軟體庫;寫入檔案回傳 SHA-256 */
export function softwareDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'ita-software-'));
  const put = (rel: string, content: string | Buffer) => {
    const file = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return createHash('sha256').update(content).digest('hex');
  };
  return { root, put };
}

export function setupSoftware(opts: { approvalThreshold?: number; maxConcurrent?: number; maxBytes?: number } = {}) {
  const base = setup();
  const commandStore = new MemoryCommandStore(base.sql);
  const store = new MemorySoftwareStore(base.sql, commandStore);
  const dir = softwareDir();
  let commands: CommandDispatcher | undefined;
  const software = new SoftwareService(store, new SoftwareFiles(dir.root, opts.maxBytes), base.sql, {
    now: base.clock.now,
    commands: () => commands,
    onPackageTampered: (c, ref, d) => base.alerts.onPackageTampered(c, ref, d),
  });
  commands = new CommandDispatcher(commandStore, base.sql, base.service, {
    now: base.clock.now,
    approvalThreshold: opts.approvalThreshold,
    limitedKinds: { kinds: SOFTWARE_KINDS, max: opts.maxConcurrent ?? 20 },
    kindHooks: {
      'software.install': {
        check: (c, ref, p) => software.checkCommand(c, ref, p, 'install'),
        checkBatch: (c, refs, p) => software.checkLicense(c, refs, p),
        onFinal: (c, cmd, fin) =>
          fin.state === 'succeeded' || fin.state === 'failed'
            ? base.alerts.onSoftwareFinal(c, { deviceRef: cmd.deviceRef, commandId: cmd.commandId, params: cmd.params, ...fin, state: fin.state })
            : Promise.resolve(),
      },
      'software.uninstall': { check: (c, ref, p) => software.checkCommand(c, ref, p, 'uninstall') },
    },
  });
  return { ...base, commandStore, store, dir, software, commands };
}
