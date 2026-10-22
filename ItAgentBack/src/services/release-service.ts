/**
 * 升級(PLATFORM-PLAN P6 §4.5;P6-UPGRADE-DESIGN §1–§3):版本登錄、發佈環、裝置所屬環、Watchdog 上報的目標版本、下載授權、升級告警。
 *   - 目標版本:agent.upgrade 指定的版本(forced)優先,否則所屬環的目標;已是目標、同一目標失敗 2 次、超過同時升級上限 → null
 *   - draft 只能給 pilot(環目標或 pilot 裝置的強制版本);revoked 一律不下發
 *   - 推進限制:it / all 設定的版本必須已是 pilot 目標滿 24 小時,否則 409(force 略過並記稽核)
 *   - 版本與環是全公司共用設定:管理需 endpoint.software.manage(BFF)且全部公司角色(需求方 2026-10-20,§9-5)
 *   - 下載只給「這台目前被指派的目標」;檔案的 SHA-256 與登錄時不符就拒絕
 *   - 告警:upgrade_failed(同一目標失敗 2 次或還原失敗;成功或目標改變時自動關閉)、version_mismatch(目標生效超過 24 小時仍未到)
 * SQL 是唯一真相;Watchdog 上報時的升級處理失敗只記 warn、target 回 null(不擋上報)。
 */
import type { ReadStream } from 'node:fs';
import type { GatewayIdentity } from '@giganexus/backend-sdk';
import type { WatchdogReportRequest, WatchdogTargets, UpgradeTarget } from '../contracts.js';
import { AppError, storageUnavailable } from '../errors.js';
import type {
  Actor,
  AlertRule,
  DeviceRecord,
  DeviceStore,
  DeviceUpgradeRecord,
  MonitorStore,
  ReleaseComponent,
  ReleaseRecord,
  ReleaseStatus,
  ReleaseStore,
  Ring,
  RingRecord,
  UpgradePatch,
  UpgradeState,
  UpgradeTargetRow,
} from '../stores/types.js';
import type { Ctx } from './device-service.js';
import { parseRange, RELEASE_COMPONENTS, VERSION_RE, type ReleaseFileInfo, type ReleaseFiles } from './release-files.js';
import type { OpenedFile } from './rooted-files.js';
import { inScope, scopeCompanies, type MgmtCtx } from './scope.js';

export const RINGS: readonly Ring[] = ['pilot', 'it', 'all'];
/** 同一目標版本失敗幾次後不再自動下發 */
export const MAX_ATTEMPTS = 2;
/** pilot 觀察多久才能往下一環(需求方 2026-10-20,§9-4) */
export const RING_OBSERVE_MS = 24 * 3_600_000;
/** 進行中(downloading ~ installing)的升級多久沒更新就不再計入同時升級上限 */
export const ACTIVE_WINDOW_MS = 30 * 60_000;
/** 已下發目標(pending)但 Watchdog 尚未開始:只佔名額 10 分鐘(離線或不理會 target 的裝置不會長期佔住) */
export const PENDING_WINDOW_MS = 10 * 60_000;
/** 支援升級(會處理 target)的最低 Watchdog 版本;更舊的 Watchdog 不下發、不佔名額 */
export const MIN_UPGRADE_WATCHDOG = '0.2.0';
/** 下載稽核事件:同一台同一版本多久記一次 */
const DOWNLOAD_EVENT_MS = 3_600_000;
/** version_mismatch:目標生效多久後仍未到才告警 */
export const MISMATCH_AFTER_MS = 24 * 3_600_000;
/** version_mismatch 只評估最近有回報的電腦(離線過久交給 offline_long) */
const RECENT_MS = 3_600_000;
const ACTIVE_STATES: readonly UpgradeState[] = ['pending', 'downloading', 'verifying', 'installing'];
const FAILED_STATES: readonly UpgradeState[] = ['failed', 'rolled_back'];

export interface Desired {
  version: string;
  source: 'forced' | 'ring';
  /** 目標開始生效的時間(強制版本為下指令時間) */
  since: Date | null;
}

/** 純函式:某元件這台應該是哪個版本;沒有目標回 null */
export function desiredVersion(component: ReleaseComponent, ring: Ring, rings: RingRecord[], up: DeviceUpgradeRecord | undefined): Desired | null {
  if (up?.forcedVersion) return { version: up.forcedVersion, source: 'forced', since: up.forcedAt };
  const r = rings.find((x) => x.ring === ring && x.component === component);
  return r?.targetVersion ? { version: r.targetVersion, source: 'ring', since: r.targetSetAt } : null;
}

/** 純函式:x.y.z 數字部分是否 ≥ min(後綴不比較);格式不符視為否 */
export function versionAtLeast(v: string | null | undefined, min: string): boolean {
  const parse = (x: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(x)?.slice(1).map(Number);
  const a = v ? parse(v) : undefined;
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  return true;
}

/** 純函式:版本狀態是否可下發給此環的裝置 */
export function releaseUsable(rel: ReleaseRecord | null, ring: Ring): boolean {
  if (!rel || rel.status === 'revoked') return false;
  return rel.status === 'published' || ring === 'pilot';
}

/** 純函式:Watchdog 回報的 upgrade 進度合併到既有紀錄(失敗次數:同一目標進入失敗才加一;重送同一個結果不重複計) */
export function mergeProgress(prev: DeviceUpgradeRecord | undefined, p: NonNullable<WatchdogReportRequest['upgrade']>, at: Date): UpgradePatch {
  const sameTarget = prev?.targetVersion === p.target_version;
  const prevAttempts = sameTarget ? (prev?.attempts ?? 0) : 0;
  const failed = FAILED_STATES.includes(p.state);
  const alreadyFailed = sameTarget && !!prev && FAILED_STATES.includes(prev.state);
  let attempts = prevAttempts;
  if (failed && !alreadyFailed) attempts = prevAttempts + 1;
  if (p.attempts !== undefined && failed) attempts = Math.max(attempts, p.attempts);
  const succeeded = p.state === 'succeeded';
  return {
    targetVersion: p.target_version,
    fromVersion: p.from_version ?? (sameTarget ? (prev?.fromVersion ?? null) : null),
    state: p.state,
    attempts,
    errorCode: failed ? (p.error_code ?? null) : null,
    errorMessage: failed ? (p.error_message ?? null) : null,
    // 到達強制版本後清除,之後回到所屬環的目標
    forcedVersion: succeeded && prev?.forcedVersion === p.target_version ? null : (prev?.forcedVersion ?? null),
    forcedByEmp: succeeded && prev?.forcedVersion === p.target_version ? null : (prev?.forcedByEmp ?? null),
    forcedAt: succeeded && prev?.forcedVersion === p.target_version ? null : (prev?.forcedAt ?? null),
    startedAt: sameTarget && prev?.startedAt ? prev.startedAt : at,
  };
}

/** 純函式:這台目前成立的 version_mismatch(各元件) */
export function mismatchOf(row: UpgradeTargetRow, rings: RingRecord[], now: Date): { component: ReleaseComponent; current: string | null; target: string }[] {
  const at = now.getTime();
  const recent = at - row.lastSeenAt.getTime() < RECENT_MS || (!!row.watchdogReportAt && at - row.watchdogReportAt.getTime() < RECENT_MS);
  if (!recent) return [];
  const out: { component: ReleaseComponent; current: string | null; target: string }[] = [];
  for (const component of RELEASE_COMPONENTS) {
    const up = row.upgrades.find((u) => u.component === component);
    const d = desiredVersion(component, row.ring, rings, up);
    if (!d?.since || at - d.since.getTime() < MISMATCH_AFTER_MS) continue;
    const current = component === 'agent' ? row.agentVersion : row.watchdogVersion;
    // 舊版 Watchdog 不存在(未安裝)時不比對 Watchdog
    if (component === 'watchdog' && !row.watchdogReportAt) continue;
    if (current !== d.version) out.push({ component, current, target: d.version });
  }
  return out;
}

export interface ReleaseView {
  releaseId: string;
  component: ReleaseComponent;
  version: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  signerThumbprints: string[];
  status: ReleaseStatus;
  notes: string | null;
  createdBy: { emp: string; name: string | null };
  createdAt: string;
  publishedByEmp: string | null;
  publishedAt: string | null;
  revokedByEmp: string | null;
  revokedAt: string | null;
}

export function releaseView(r: ReleaseRecord): ReleaseView {
  return {
    releaseId: r.releaseId,
    component: r.component,
    version: r.version,
    fileName: r.fileName,
    sha256: r.sha256,
    sizeBytes: r.sizeBytes,
    signerThumbprints: r.signerThumbprints,
    status: r.status,
    notes: r.notes,
    createdBy: { emp: r.createdByEmp, name: r.createdByName },
    createdAt: r.createdAt.toISOString(),
    publishedByEmp: r.publishedByEmp,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    revokedByEmp: r.revokedByEmp,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}

export interface RingProgress {
  total: number;
  atTarget: number;
  inProgress: number;
  failed: number;
  /** 尚未開始(含未回報、等待同時升級上限) */
  waiting: number;
}

export interface RingView {
  ring: Ring;
  component: ReleaseComponent;
  targetVersion: string | null;
  targetSetAt: string | null;
  updatedBy: { emp: string | null; name: string | null };
  updatedAt: string;
  /** 只計資料範圍內的電腦 */
  progress: RingProgress;
}

export interface UpgradeView {
  component: ReleaseComponent;
  currentVersion: string | null;
  targetVersion: string | null;
  targetSource: 'forced' | 'ring' | null;
  state: UpgradeState | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  forcedBy: string | null;
  updatedAt: string | null;
}

export interface RegisterInput {
  component: ReleaseComponent;
  version: string;
  fileName: string;
  signerThumbprints: string[];
  notes?: string;
}

/** 依 deviceId 查內部 id 與公司(資料範圍檢查) */
export type DeviceLookup = (deviceId: string) => Promise<{ id: number; company: string | null } | null>;

export interface ReleaseServiceOptions {
  maxConcurrent?: number;
  now?: () => Date;
}

export interface Download {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  /** 416 時為 null */
  stream: ReadStream | null;
}

const actorOf = (who: GatewayIdentity): Actor => ({ emp: who.emp ?? who.sub, name: who.name ?? null });

export class ReleaseService {
  private readonly now: () => Date;
  private readonly maxConcurrent: number;
  private sweeping = false;
  /** 下載稽核事件的最後記錄時間(裝置:元件:版本 → 毫秒) */
  private readonly downloadLogged = new Map<string, number>();

  constructor(
    private readonly store: ReleaseStore,
    private readonly files: ReleaseFiles,
    private readonly monitor: MonitorStore,
    private readonly devices: Pick<DeviceStore, 'addEvent'>,
    private readonly lookup: DeviceLookup,
    opts: ReleaseServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.maxConcurrent = opts.maxConcurrent ?? 20;
  }

  private async sqlDo<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      ctx.log.error({ err, what }, 'SQL Server 操作失敗(升級)');
      throw storageUnavailable();
    }
  }

  /** 版本與環的維護:全公司共用設定,只有全部公司角色可改(§9-5) */
  private requireAll(ctx: MgmtCtx): void {
    if (!ctx.scope.all) throw new AppError(403, 'ITA_SCOPE_ALL_REQUIRED', '版本與發佈環是全公司共用設定,只有可管理所有公司的角色能變更');
  }

  // ---------- Watchdog 上報(agent-app → DeviceService.watchdogReport) ----------

  /** 記錄升級進度,回傳各元件的目標版本 */
  async onWatchdogReport(ctx: Ctx, device: DeviceRecord, req: WatchdogReportRequest): Promise<WatchdogTargets> {
    const at = this.now();
    let ups = await this.store.deviceUpgrades(device.id);
    const current: Record<ReleaseComponent, string | null> = { agent: req.agent.version ?? device.agentVersion, watchdog: req.watchdog_version };

    // 端點自報「成功」只在回報的目前版本確實是該目標時採用(不能靠假的 succeeded 關閉告警、歸零失敗次數)
    const claimedOk = req.upgrade?.state === 'succeeded' && current[req.upgrade.component] !== req.upgrade.target_version;
    if (claimedOk) ctx.log.warn({ deviceId: device.deviceId, upgrade: req.upgrade, current }, '回報升級成功但目前版本不是目標,略過');
    if (req.upgrade && !claimedOk) {
      const p = req.upgrade;
      const prev = ups.find((u) => u.component === p.component);
      const patch = mergeProgress(prev, p, at);
      await this.store.saveUpgrade(device.id, p.component, patch, at);
      ctx.log.info({ deviceId: device.deviceId, component: p.component, target: p.target_version, state: p.state, attempts: patch.attempts }, '升級進度');
      await this.afterProgress(ctx, device.id, p.component, patch);
      ups = await this.store.deviceUpgrades(device.id);
    }
    // 已在目標版本但紀錄仍停在進行中(例如 Watchdog 由 Agent 替換、新版不帶 upgrade):補記成功
    let changed = false;
    for (const u of ups)
      if (u.targetVersion && current[u.component] === u.targetVersion && u.state !== 'succeeded') {
        changed = true;
        const patch: UpgradePatch = { ...u, state: 'succeeded', errorCode: null, errorMessage: null };
        if (u.forcedVersion === u.targetVersion) Object.assign(patch, { forcedVersion: null, forcedByEmp: null, forcedAt: null });
        await this.store.saveUpgrade(device.id, u.component, patch, at);
        await this.afterProgress(ctx, device.id, u.component, patch);
      }
    if (changed) ups = await this.store.deviceUpgrades(device.id);

    const ring = (await this.store.deviceRing(device.id)) ?? 'all';
    const rings = await this.store.listRings();
    const target: WatchdogTargets = { agent: null, watchdog: null };
    // 舊版 Watchdog(0.1.0)不處理 target:不下發,也不佔同時升級名額
    if (!versionAtLeast(req.watchdog_version, MIN_UPGRADE_WATCHDOG)) return target;
    for (const component of RELEASE_COMPONENTS) target[component] = await this.targetFor(ctx, device, component, ring, rings, ups, current[component], at);
    return target;
  }

  private async targetFor(
    ctx: Ctx,
    device: DeviceRecord,
    component: ReleaseComponent,
    ring: Ring,
    rings: RingRecord[],
    ups: DeviceUpgradeRecord[],
    current: string | null,
    at: Date,
  ): Promise<UpgradeTarget | null> {
    const up = ups.find((u) => u.component === component);
    const d = desiredVersion(component, ring, rings, up);
    if (!d || d.version === current) return null;
    const sameTarget = up?.targetVersion === d.version;
    // 同一目標失敗 2 次、或還原失敗(電腦狀態不明,要 IT 處理):不再自動下發
    if (sameTarget && (up.attempts >= MAX_ATTEMPTS || up.errorCode === 'ROLLBACK_FAILED')) return null;
    const rel = await this.store.findRelease(component, d.version);
    if (!releaseUsable(rel, ring)) {
      ctx.log.warn({ deviceId: device.deviceId, component, version: d.version, status: rel?.status ?? 'missing' }, '目標版本不存在或不可下發給此環,略過');
      return null;
    }
    // 同一目標失敗 1 次:照樣下發讓 Watchdog 重試,但不覆寫失敗狀態與錯誤(畫面看得到、重送不重複計次)
    const retrying = sameTarget && FAILED_STATES.includes(up.state);
    // 同時升級上限(軟上限:並行上報之間不加鎖,可能略為超過):這台已在進行同一目標不受限(計入的就是它自己)
    const age = up ? at.getTime() - up.updatedAt.getTime() : Infinity;
    const inProgress =
      sameTarget &&
      ((up.state === 'pending' && age < PENDING_WINDOW_MS) || (ACTIVE_STATES.includes(up.state) && up.state !== 'pending' && age < ACTIVE_WINDOW_MS));
    if (!inProgress && !retrying) {
      const active = await this.store.activeUpgrades(new Date(at.getTime() - PENDING_WINDOW_MS), new Date(at.getTime() - ACTIVE_WINDOW_MS));
      if (active >= this.maxConcurrent) {
        ctx.log.info({ deviceId: device.deviceId, component, active }, '同時升級台數已達上限,下次上報再排');
        return null;
      }
      await this.store.saveUpgrade(
        device.id,
        component,
        {
          targetVersion: d.version,
          fromVersion: current,
          state: 'pending',
          attempts: sameTarget ? up.attempts : 0,
          errorCode: null,
          errorMessage: null,
          forcedVersion: up?.forcedVersion ?? null,
          forcedByEmp: up?.forcedByEmp ?? null,
          forcedAt: up?.forcedAt ?? null,
          startedAt: at,
        },
        at,
      );
    }
    const r = rel!;
    return {
      version: r.version,
      url: `/agent/v1/releases/${component}/${encodeURIComponent(r.version)}/${encodeURIComponent(r.fileName)}`,
      sha256: r.sha256,
      size_bytes: r.sizeBytes,
      signer_thumbprints: r.signerThumbprints,
    };
  }

  /** 進度寫入後:失敗 2 次或還原失敗開告警;成功關閉 */
  private async afterProgress(ctx: Ctx, deviceRef: number, component: ReleaseComponent, p: UpgradePatch): Promise<void> {
    try {
      if (p.state === 'succeeded') {
        // 另一個元件仍停在失敗(達 2 次或還原失敗)時不關閉
        const others = (await this.store.deviceUpgrades(deviceRef)).filter((u) => u.component !== component);
        if (others.some((u) => FAILED_STATES.includes(u.state) && (u.attempts >= MAX_ATTEMPTS || u.errorCode === 'ROLLBACK_FAILED'))) return;
        if (await this.monitor.resolveAuto(deviceRef, 'upgrade_failed', this.now(), '升級已成功'))
          ctx.log.info({ deviceRef, component }, '升級成功,關閉 upgrade_failed');
        return;
      }
      if (!FAILED_STATES.includes(p.state)) return;
      const rollbackFailed = p.errorCode === 'ROLLBACK_FAILED';
      if (p.attempts < MAX_ATTEMPTS && !rollbackFailed) return;
      const r = await this.monitor.openAlert({
        deviceRef,
        rule: 'upgrade_failed',
        severity: rollbackFailed ? 'critical' : 'warn',
        detail: JSON.stringify({
          component,
          targetVersion: p.targetVersion,
          fromVersion: p.fromVersion,
          attempts: p.attempts,
          errorCode: p.errorCode,
          errorMessage: p.errorMessage,
        }),
        at: this.now(),
      });
      ctx.log.warn({ deviceRef, component, alertId: r.alertId, errorCode: p.errorCode }, '升級失敗,已開告警');
    } catch (err) {
      ctx.log.warn({ err, deviceRef }, 'upgrade_failed 告警寫入失敗');
    }
  }

  /** Agent 經 /agent/v1/events 回報替換 Watchdog 的結果(component = watchdog;P6-3) */
  async onAgentUpgradeEvents(ctx: Ctx, deviceRef: number, events: { type: string; data?: Record<string, unknown> }[]): Promise<void> {
    for (const e of events) {
      if (e.type !== 'upgrade_succeeded' && e.type !== 'upgrade_failed') continue;
      const d = e.data ?? {};
      if (d.component !== 'watchdog' || typeof d.to !== 'string') continue;
      try {
        const at = this.now();
        const prev = (await this.store.deviceUpgrades(deviceRef)).find((u) => u.component === 'watchdog');
        const patch = mergeProgress(
          prev,
          {
            component: 'watchdog',
            target_version: d.to,
            from_version: typeof d.from === 'string' ? d.from : undefined,
            state: e.type === 'upgrade_succeeded' ? 'succeeded' : d.rolled_back === true ? 'rolled_back' : 'failed',
            error_code: typeof d.error_code === 'string' ? (d.error_code as NonNullable<WatchdogReportRequest['upgrade']>['error_code']) : undefined,
            error_message: typeof d.error_message === 'string' ? d.error_message : undefined,
          },
          at,
        );
        await this.store.saveUpgrade(deviceRef, 'watchdog', patch, at);
        await this.afterProgress(ctx, deviceRef, 'watchdog', patch);
      } catch (err) {
        ctx.log.warn({ err, deviceRef }, 'Watchdog 升級結果寫入失敗(事件已保存)');
      }
    }
  }

  // ---------- 下載(agent-app GET /agent/v1/releases/...) ----------

  async download(ctx: Ctx, device: DeviceRecord, component: string, version: string, fileName: string, range: string | undefined): Promise<Download> {
    const notFound = () => new AppError(404, 'ITA_RELEASE_NOT_FOUND', '找不到此版本檔');
    if (!RELEASE_COMPONENTS.includes(component as ReleaseComponent) || !VERSION_RE.test(version)) throw notFound();
    const c = component as ReleaseComponent;
    const [ups, ring, rings, rel] = await this.sqlDo(ctx, 'release.download', () =>
      Promise.all([this.store.deviceUpgrades(device.id), this.store.deviceRing(device.id), this.store.listRings(), this.store.findRelease(c, version)]),
    );
    const d = desiredVersion(
      c,
      ring ?? 'all',
      rings,
      ups.find((u) => u.component === c),
    );
    // 只給這台目前被指派的目標:端點不能任意下載其他版本
    if (!d || d.version !== version || !rel || rel.fileName !== fileName || !releaseUsable(rel, ring ?? 'all')) {
      ctx.log.warn({ deviceId: device.deviceId, component, version, fileName, assigned: d?.version ?? null }, '下載的版本不是這台的目標,拒絕');
      throw notFound();
    }
    const f = await this.files.resolve(c, version, fileName);
    if (!f) {
      ctx.log.error({ component, version, fileName }, '版本檔不在版本檔目錄(已登錄卻找不到)');
      throw notFound();
    }
    // 雜湊與回應內容讀同一個檔案代號(P7 資安稽核 L4,與軟體套件下載相同)
    const opened = await this.files.openChecked(f);
    try {
      return await this.respond(ctx, device, opened, rel, { component, version, fileName, range });
    } catch (err) {
      await opened.close();
      throw err;
    }
  }

  private async respond(
    ctx: Ctx,
    device: DeviceRecord,
    opened: OpenedFile,
    rel: { sha256: string; sizeBytes: number },
    q: { component: string; version: string; fileName: string; range: string | undefined },
  ): Promise<Download> {
    const { component, version, fileName, range } = q;
    const f = { size: opened.size };
    const sha = await opened.sha256();
    if (sha !== rel.sha256 || f.size !== rel.sizeBytes) {
      ctx.log.error({ component, version, fileName, expected: rel.sha256, actual: sha }, '版本檔內容與登錄不符,拒絕下發');
      throw new AppError(409, 'ITA_RELEASE_FILE_CHANGED', '版本檔內容與登錄不符');
    }
    const r = parseRange(range, f.size);
    if (r === 'unsatisfiable') {
      await opened.close();
      return { status: 416, headers: { 'content-range': `bytes */${f.size}` }, stream: null };
    }
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes',
      'x-file-sha256': rel.sha256,
      'cache-control': 'no-store',
    };
    // 稽核:開始下載(從第 0 位元組起)時記一筆,同一台同一版本每小時最多一筆(避免反覆請求灌爆事件表)
    const key = `${device.id}:${component}:${version}`;
    const last = this.downloadLogged.get(key) ?? 0;
    if ((!r || r.start === 0) && Date.now() - last >= DOWNLOAD_EVENT_MS) {
      this.downloadLogged.set(key, Date.now());
      if (this.downloadLogged.size > 10_000) this.downloadLogged.clear();
      await this.sqlDo(ctx, 'event.add(release_download)', () =>
        this.devices.addEvent(device, 'release_download', `下載 ${component} ${version}(${f.size} bytes)`, ctx.requestId),
      );
    }
    ctx.log.info({ deviceId: device.deviceId, component, version, start: r?.start ?? 0, end: r?.end ?? f.size - 1 }, '下載版本檔');
    if (!r) return { status: 200, headers: { ...headers, 'content-length': String(f.size) }, stream: opened.stream() };
    return {
      status: 206,
      headers: { ...headers, 'content-length': String(r.end - r.start + 1), 'content-range': `bytes ${r.start}-${r.end}/${f.size}` },
      stream: opened.stream(r),
    };
  }

  // ---------- 管理 API ----------

  async list(ctx: MgmtCtx, f: { component?: ReleaseComponent; status?: ReleaseStatus }): Promise<{ items: ReleaseView[] }> {
    const rows = await this.sqlDo(ctx, 'release.list', () => this.store.listReleases(f));
    return { items: rows.map(releaseView) };
  }

  /** 版本檔目錄內尚未登錄的檔案 */
  async unregisteredFiles(ctx: MgmtCtx): Promise<{ items: (Omit<ReleaseFileInfo, 'modifiedAt'> & { modifiedAt: string })[] }> {
    const [files, rows] = await Promise.all([this.files.list(), this.sqlDo(ctx, 'release.list', () => this.store.listReleases({}))]);
    const known = new Set(rows.map((r) => `${r.component}/${r.version}`));
    return {
      items: files.filter((f) => !known.has(`${f.component}/${f.version}`)).map((f) => ({ ...f, modifiedAt: f.modifiedAt.toISOString() })),
    };
  }

  async register(ctx: MgmtCtx, who: GatewayIdentity, input: RegisterInput): Promise<ReleaseView> {
    this.requireAll(ctx);
    const f = await this.files.resolve(input.component, input.version, input.fileName);
    if (!f) throw new AppError(404, 'ITA_RELEASE_FILE_NOT_FOUND', `版本檔目錄找不到 ${input.component}/${input.version}/${input.fileName}`);
    const sha256 = await this.files.sha256(f);
    const signers = [...new Set(input.signerThumbprints.map((s) => s.toLowerCase()))];
    const rel = await this.sqlDo(ctx, 'release.add', () =>
      this.store.addRelease({
        component: input.component,
        version: input.version,
        fileName: input.fileName,
        sha256,
        sizeBytes: f.size,
        signerThumbprints: signers,
        notes: input.notes?.trim() || null,
        actor: actorOf(who),
        at: this.now(),
        requestId: ctx.requestId,
      }),
    );
    ctx.log.info({ releaseId: rel.releaseId, component: rel.component, version: rel.version, sha256, emp: actorOf(who).emp }, '登錄版本');
    return releaseView(rel);
  }

  async setStatus(ctx: MgmtCtx, who: GatewayIdentity, releaseId: string, to: 'published' | 'revoked'): Promise<ReleaseView & { clearedRings: Ring[] }> {
    this.requireAll(ctx);
    const found = await this.sqlDo(ctx, 'release.get', () => this.store.getRelease(releaseId));
    if (!found) throw new AppError(404, 'ITA_RELEASE_NOT_FOUND', '找不到此版本');
    const from: ReleaseStatus[] = to === 'published' ? ['draft'] : ['draft', 'published'];
    if (!from.includes(found.status)) throw new AppError(409, 'ITA_RELEASE_STATUS', `此版本目前為 ${found.status},不能改為 ${to}`);
    const r = await this.sqlDo(ctx, 'release.setStatus', () => this.store.setReleaseStatus(releaseId, from, to, actorOf(who), this.now(), ctx.requestId));
    if (!r.ok) throw new AppError(409, 'ITA_RELEASE_STATUS', '版本狀態已被變更,請重新整理');
    ctx.log.info({ releaseId, to, clearedRings: r.clearedRings, emp: actorOf(who).emp }, '版本狀態變更');
    const after = await this.sqlDo(ctx, 'release.get', () => this.store.getRelease(releaseId));
    return { ...releaseView(after ?? found), clearedRings: r.clearedRings };
  }

  async rings(ctx: MgmtCtx): Promise<{ items: RingView[] }> {
    const [rings, rows] = await this.sqlDo(ctx, 'ring.list', () => Promise.all([this.store.listRings(), this.store.upgradeTargets(scopeCompanies(ctx.scope))]));
    const items = RINGS.flatMap((ring) =>
      RELEASE_COMPONENTS.map((component) => {
        const r = rings.find((x) => x.ring === ring && x.component === component);
        const progress: RingProgress = { total: 0, atTarget: 0, inProgress: 0, failed: 0, waiting: 0 };
        for (const row of rows.filter((x) => x.ring === ring)) {
          const up = row.upgrades.find((u) => u.component === component);
          // 被強制指定版本的電腦不算在環的進度內
          if (up?.forcedVersion || !r?.targetVersion) continue;
          progress.total++;
          const current = component === 'agent' ? row.agentVersion : row.watchdogVersion;
          if (current === r.targetVersion) progress.atTarget++;
          else if (up?.targetVersion === r.targetVersion && FAILED_STATES.includes(up.state)) progress.failed++;
          else if (up?.targetVersion === r.targetVersion && ACTIVE_STATES.includes(up.state)) progress.inProgress++;
          else progress.waiting++;
        }
        return {
          ring,
          component,
          targetVersion: r?.targetVersion ?? null,
          targetSetAt: r?.targetSetAt?.toISOString() ?? null,
          updatedBy: { emp: r?.updatedByEmp ?? null, name: r?.updatedByName ?? null },
          updatedAt: (r?.updatedAt ?? new Date(0)).toISOString(),
          progress,
        };
      }),
    );
    return { items };
  }

  async setRing(ctx: MgmtCtx, who: GatewayIdentity, ring: Ring, component: ReleaseComponent, version: string | null, force: boolean): Promise<RingView> {
    this.requireAll(ctx);
    const at = this.now();
    if (version !== null) {
      const rel = await this.sqlDo(ctx, 'release.find', () => this.store.findRelease(component, version));
      if (!rel) throw new AppError(404, 'ITA_RELEASE_NOT_FOUND', `${component} ${version} 尚未登錄`);
      if (rel.status === 'revoked') throw new AppError(409, 'ITA_RELEASE_REVOKED', `${component} ${version} 已撤回`);
      if (rel.status === 'draft' && ring !== 'pilot') throw new AppError(409, 'ITA_RELEASE_NOT_PUBLISHED', `${component} ${version} 尚未發佈,只能設給 pilot`);
      if (ring !== 'pilot') {
        const rings = await this.sqlDo(ctx, 'ring.list', () => this.store.listRings());
        const pilot = rings.find((x) => x.ring === 'pilot' && x.component === component);
        const observed = pilot?.targetVersion === version && !!pilot.targetSetAt && at.getTime() - pilot.targetSetAt.getTime() >= RING_OBSERVE_MS;
        if (!observed && !force)
          throw new AppError(409, 'ITA_RING_TOO_EARLY', `${component} ${version} 尚未在 pilot 環觀察滿 24 小時;確定要推進請帶 force`, [
            { field: 'force', message: pilot?.targetVersion === version ? `pilot 自 ${pilot.targetSetAt?.toISOString()} 起` : 'pilot 目前不是此版本' },
          ]);
        if (!observed) ctx.log.warn({ ring, component, version, emp: actorOf(who).emp }, '略過 pilot 觀察期推進(force)');
      }
    }
    await this.sqlDo(ctx, 'ring.set', () => this.store.setRingTarget(ring, component, version, actorOf(who), at, ctx.requestId));
    ctx.log.info({ ring, component, version, force, emp: actorOf(who).emp }, '設定發佈環目標版本');
    const view = (await this.rings(ctx)).items.find((x) => x.ring === ring && x.component === component);
    if (!view) throw storageUnavailable();
    return view;
  }

  /** 範圍內的裝置;不存在或範圍外回相同的 404(E6) */
  private async scopedDevice(ctx: MgmtCtx, deviceId: string): Promise<{ id: number; company: string | null }> {
    const d = await this.sqlDo(ctx, 'device.lookup', () => this.lookup(deviceId));
    if (!d || !inScope(ctx.scope, d.company)) throw new AppError(404, 'ITA_DEVICE_NOT_FOUND', '找不到此電腦');
    return d;
  }

  async setDeviceRing(ctx: MgmtCtx, who: GatewayIdentity, deviceId: string, ring: Ring): Promise<{ deviceId: string; ring: Ring; upgrades: UpgradeView[] }> {
    const d = await this.scopedDevice(ctx, deviceId);
    // pilot 會收到尚未發佈(draft)的版本:放進或移出 pilot 與改環目標同級,需全部公司角色(資安稽核 M1)
    const before = await this.sqlDo(ctx, 'device.ring', () => this.store.deviceRing(d.id));
    if ((ring === 'pilot' || before === 'pilot') && ring !== before) this.requireAll(ctx);
    await this.sqlDo(ctx, 'device.setRing', () => this.store.setDeviceRing(d.id, ring));
    ctx.log.info({ deviceId, ring, emp: actorOf(who).emp }, '調整裝置所屬環');
    return this.deviceUpgrade(ctx, deviceId);
  }

  async deviceUpgrade(ctx: MgmtCtx, deviceId: string): Promise<{ deviceId: string; ring: Ring; upgrades: UpgradeView[] }> {
    const d = await this.scopedDevice(ctx, deviceId);
    const [rows, rings] = await this.sqlDo(ctx, 'device.upgrade', () => Promise.all([this.store.upgradeTargets(undefined, d.id), this.store.listRings()]));
    const row = rows[0];
    const ring = row?.ring ?? (await this.sqlDo(ctx, 'device.ring', () => this.store.deviceRing(d.id))) ?? 'all';
    const ups = row?.upgrades ?? (await this.sqlDo(ctx, 'device.upgrades', () => this.store.deviceUpgrades(d.id)));
    return {
      deviceId,
      ring,
      upgrades: RELEASE_COMPONENTS.map((component) => {
        const up = ups.find((u) => u.component === component);
        const desired = desiredVersion(component, ring, rings, up);
        return {
          component,
          currentVersion: row ? (component === 'agent' ? row.agentVersion : row.watchdogVersion) : null,
          targetVersion: desired?.version ?? null,
          targetSource: desired?.source ?? null,
          state: up?.state ?? null,
          attempts: up?.attempts ?? 0,
          errorCode: up?.errorCode ?? null,
          errorMessage: up?.errorMessage ?? null,
          forcedBy: up?.forcedByEmp ?? null,
          updatedAt: up?.updatedAt.toISOString() ?? null,
        };
      }),
    };
  }

  // ---------- agent.upgrade 指令(CommandDispatcher 的 kindHooks) ----------

  /** 建立前檢查:指定的版本必須已登錄且 published(draft 只能經 pilot 環目標下發,資安稽核 M1) */
  async checkUpgradeCommand(ctx: Ctx, deviceRef: number, params: Record<string, unknown>): Promise<void> {
    const version = params.version;
    if (typeof version !== 'string') return;
    const component = params.component as ReleaseComponent;
    const rel = await this.sqlDo(ctx, 'release.find', () => this.store.findRelease(component, version));
    if (!rel) throw new AppError(404, 'ITA_RELEASE_NOT_FOUND', `${component} ${version} 尚未登錄`);
    if (rel.status !== 'published')
      throw new AppError(
        409,
        rel.status === 'revoked' ? 'ITA_RELEASE_REVOKED' : 'ITA_RELEASE_NOT_PUBLISHED',
        `${component} ${version} 為 ${rel.status},只能指定已發佈的版本`,
      );
    void deviceRef;
  }

  /** 建立指令前:指定版本時設為強制版本並重設失敗次數;未指定時只重設失敗次數(立即依所屬環重新檢查)。不改進度狀態(不佔同時升級名額) */
  async applyUpgradeCommand(ctx: Ctx, deviceRef: number, params: Record<string, unknown>, actor: Actor): Promise<void> {
    const component = params.component as ReleaseComponent;
    const version = typeof params.version === 'string' ? params.version : null;
    const at = this.now();
    const prev = (await this.sqlDo(ctx, 'device.upgrades', () => this.store.deviceUpgrades(deviceRef))).find((u) => u.component === component);
    if (!prev && !version) return;
    await this.sqlDo(ctx, 'device.saveUpgrade', () =>
      this.store.saveUpgrade(
        deviceRef,
        component,
        {
          targetVersion: prev?.targetVersion ?? null,
          fromVersion: prev?.fromVersion ?? null,
          // 沒有紀錄時記 succeeded(目標 NULL,不計入名額);失敗狀態保留,下次上報依新的次數重試
          state: prev?.state ?? 'succeeded',
          attempts: 0,
          errorCode: null,
          errorMessage: null,
          forcedVersion: version ?? prev?.forcedVersion ?? null,
          forcedByEmp: version ? actor.emp : (prev?.forcedByEmp ?? null),
          forcedAt: version ? at : (prev?.forcedAt ?? null),
          startedAt: prev?.startedAt ?? null,
        },
        at,
      ),
    );
    ctx.log.info({ deviceRef, component, version, emp: actor.emp }, 'agent.upgrade:重設升級狀態');
  }

  // ---------- 告警掃描(與 AlertService 同一個 5 分鐘計時器) ----------

  async sweep(ctx: Ctx): Promise<{ opened: number; resolved: number }> {
    const result = { opened: 0, resolved: 0 };
    if (this.sweeping) return result;
    this.sweeping = true;
    try {
      const now = this.now();
      const [rows, rings] = await Promise.all([this.store.upgradeTargets(), this.store.listRings()]);
      for (const row of rows) {
        try {
          const hits = mismatchOf(row, rings, now);
          if (hits.length && !row.openRules.includes('upgrade_failed')) {
            const r = await this.monitor.openAlert({
              deviceRef: row.deviceRef,
              rule: 'version_mismatch',
              severity: 'warn',
              detail: JSON.stringify({ items: hits }),
              at: now,
            });
            if (r.created) result.opened++;
          } else if (
            row.openRules.includes('version_mismatch') &&
            (await this.monitor.resolveAuto(row.deviceRef, 'version_mismatch', now, '已到目標版本或目標已變更'))
          )
            result.resolved++;
          // 失敗的目標已不是目前目標(改環、改版本、撤回):關閉 upgrade_failed
          if (row.openRules.includes('upgrade_failed')) {
            const stillFailing = row.upgrades.some((u) => {
              const d = desiredVersion(u.component, row.ring, rings, u);
              return FAILED_STATES.includes(u.state) && !!d && d.version === u.targetVersion;
            });
            if (!stillFailing && (await this.monitor.resolveAuto(row.deviceRef, 'upgrade_failed', now, '目標版本已變更'))) result.resolved++;
          }
        } catch (err) {
          ctx.log.warn({ err, deviceRef: row.deviceRef }, '單台裝置升級告警評估失敗,下次再試');
        }
      }
      if (result.opened || result.resolved) ctx.log.info({ ...result, devices: rows.length }, '升級告警評估完成');
    } catch (err) {
      ctx.log.warn({ err }, '升級告警評估失敗,下次再試');
    } finally {
      this.sweeping = false;
    }
    return result;
  }
}
