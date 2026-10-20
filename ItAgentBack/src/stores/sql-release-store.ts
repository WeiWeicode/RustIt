/**
 * 升級儲存(SQL Server 2012,migration 0007;PLATFORM-PLAN P6 §4.5、P6-UPGRADE-DESIGN §1):
 * ita.agent_release(版本登錄)、ita.release_ring(各環目標版本)、ita.device_upgrade(裝置 × 元件的升級進度)、ita.device.ring。
 * 與 SqlDeviceStore 共用連線池。
 */
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { AppError } from '../errors.js';
import { companyIn } from './sql-store.js';
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
  UpgradeState,
  UpgradeTargetRow,
} from './types.js';

type Row = Record<string, unknown>;

const cut = (s: string | null | undefined, n: number): string | null => (s == null || s === '' ? null : s.length > n ? s.slice(0, n) : s);
const str = (v: unknown): string | null => (v == null ? null : String(v));
const date = (v: unknown): Date | null => (v as Date | null) ?? null;
const isDuplicateKey = (err: unknown) => [2627, 2601].includes((err as { number?: number }).number ?? 0);

const RELEASE_COLS = `id, release_id, component, version, file_name, sha256, size_bytes, signer_thumbprints, status, notes,
  created_by_emp, created_by_name, created_at, published_by_emp, published_at, revoked_by_emp, revoked_at`;
const UPGRADE_COLS = `u.device_ref, u.component, u.target_version, u.from_version, u.state, u.attempts, u.error_code, u.error_message,
  u.forced_version, u.forced_by_emp, u.forced_at, u.started_at, u.updated_at`;
/** 計入同時升級上限的狀態 */
const UPGRADE_RULES: readonly AlertRule[] = ['upgrade_failed', 'version_mismatch'];

function toRelease(r: Row): ReleaseRecord {
  return {
    id: Number(r.id),
    releaseId: String(r.release_id).toLowerCase(),
    component: String(r.component) as ReleaseComponent,
    version: String(r.version),
    fileName: String(r.file_name),
    sha256: String(r.sha256).toLowerCase(),
    sizeBytes: Number(r.size_bytes),
    signerThumbprints: String(r.signer_thumbprints)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    status: String(r.status) as ReleaseStatus,
    notes: str(r.notes),
    createdByEmp: String(r.created_by_emp),
    createdByName: str(r.created_by_name),
    createdAt: r.created_at as Date,
    publishedByEmp: str(r.published_by_emp),
    publishedAt: date(r.published_at),
    revokedByEmp: str(r.revoked_by_emp),
    revokedAt: date(r.revoked_at),
  };
}

function toRing(r: Row): RingRecord {
  return {
    ring: String(r.ring) as Ring,
    component: String(r.component) as ReleaseComponent,
    targetVersion: str(r.target_version),
    targetSetAt: date(r.target_set_at),
    updatedByEmp: str(r.updated_by_emp),
    updatedByName: str(r.updated_by_name),
    updatedAt: r.updated_at as Date,
  };
}

function toUpgrade(r: Row): DeviceUpgradeRecord {
  return {
    deviceRef: Number(r.device_ref),
    component: String(r.component) as ReleaseComponent,
    targetVersion: str(r.target_version),
    fromVersion: str(r.from_version),
    state: String(r.state) as UpgradeState,
    attempts: Number(r.attempts ?? 0),
    errorCode: str(r.error_code),
    errorMessage: str(r.error_message),
    forcedVersion: str(r.forced_version),
    forcedByEmp: str(r.forced_by_emp),
    forcedAt: date(r.forced_at),
    startedAt: date(r.started_at),
    updatedAt: r.updated_at as Date,
  };
}

export class SqlReleaseStore implements ReleaseStore {
  constructor(private readonly pool: () => Promise<sql.ConnectionPool>) {}

  private async request(): Promise<sql.Request> {
    return (await this.pool()).request();
  }

  async listReleases(f: { component?: ReleaseComponent; status?: ReleaseStatus }): Promise<ReleaseRecord[]> {
    const req = await this.request();
    const where: string[] = [];
    if (f.component) where.push(`component = ${(req.input('c', sql.VarChar(16), f.component), '@c')}`);
    if (f.status) where.push(`status = ${(req.input('s', sql.VarChar(16), f.status), '@s')}`);
    const r = await req.query(
      `SELECT ${RELEASE_COLS} FROM ita.agent_release ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`,
    );
    return (r.recordset as Row[]).map(toRelease);
  }

  async getRelease(releaseId: string): Promise<ReleaseRecord | null> {
    const r = await (
      await this.request()
    )
      .input('rid', sql.UniqueIdentifier, releaseId)
      .query(`SELECT ${RELEASE_COLS} FROM ita.agent_release WHERE release_id = @rid`);
    const row = r.recordset[0] as Row | undefined;
    return row ? toRelease(row) : null;
  }

  async findRelease(component: ReleaseComponent, version: string): Promise<ReleaseRecord | null> {
    const r = await (
      await this.request()
    )
      .input('c', sql.VarChar(16), component)
      .input('v', sql.VarChar(32), version)
      .query(`SELECT ${RELEASE_COLS} FROM ita.agent_release WHERE component = @c AND version = @v`);
    const row = r.recordset[0] as Row | undefined;
    return row ? toRelease(row) : null;
  }

  async addRelease(n: NewRelease): Promise<ReleaseRecord> {
    const releaseId = randomUUID();
    try {
      await (
        await this.request()
      )
        .input('rid', sql.UniqueIdentifier, releaseId)
        .input('c', sql.VarChar(16), n.component)
        .input('v', sql.VarChar(32), n.version)
        .input('f', sql.NVarChar(128), n.fileName)
        .input('sha', sql.Char(64), n.sha256)
        .input('size', sql.BigInt, n.sizeBytes)
        .input('signers', sql.VarChar(400), n.signerThumbprints.join(','))
        .input('notes', sql.NVarChar(1000), cut(n.notes, 1000))
        .input('emp', sql.NVarChar(64), cut(n.actor.emp, 64))
        .input('name', sql.NVarChar(100), cut(n.actor.name, 100))
        .input('at', sql.DateTime2(3), n.at)
        .input('req', sql.VarChar(64), cut(n.requestId, 64)).query(`
          INSERT INTO ita.agent_release (release_id, component, version, file_name, sha256, size_bytes, signer_thumbprints, status, notes,
            created_by_emp, created_by_name, created_at, request_id)
          VALUES (@rid, @c, @v, @f, @sha, @size, @signers, 'draft', @notes, @emp, @name, @at, @req)`);
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError(409, 'ITA_RELEASE_EXISTS', `${n.component} ${n.version} 已登錄`);
      throw err;
    }
    const saved = await this.getRelease(releaseId);
    if (!saved) throw new Error('版本登錄後讀不到');
    return saved;
  }

  async setReleaseStatus(
    releaseId: string,
    from: ReleaseStatus[],
    to: ReleaseStatus,
    actor: Actor,
    at: Date,
    requestId: string,
  ): Promise<{ ok: boolean; clearedRings: Ring[] }> {
    const req = (await this.request())
      .input('rid', sql.UniqueIdentifier, releaseId)
      .input('to', sql.VarChar(16), to)
      .input('emp', sql.NVarChar(64), cut(actor.emp, 64))
      .input('name', sql.NVarChar(100), cut(actor.name, 100))
      .input('at', sql.DateTime2(3), at)
      .input('req', sql.VarChar(64), cut(requestId, 64));
    const fromIn = from.map((s, k) => (req.input(`f${k}`, sql.VarChar(16), s), `@f${k}`)).join(', ');
    const r = await req.query(`
      SET XACT_ABORT ON;
      BEGIN TRAN;
      -- 先宣告:DECLARE 帶初值會改變 @@ROWCOUNT
      DECLARE @c VARCHAR(16), @v VARCHAR(32), @n INT, @ok BIT;
      DECLARE @cleared TABLE (ring VARCHAR(16));
      UPDATE ita.agent_release SET status = @to,
        published_by_emp = CASE WHEN @to = 'published' THEN @emp ELSE published_by_emp END,
        published_at = CASE WHEN @to = 'published' THEN @at ELSE published_at END,
        revoked_by_emp = CASE WHEN @to = 'revoked' THEN @emp ELSE revoked_by_emp END,
        revoked_at = CASE WHEN @to = 'revoked' THEN @at ELSE revoked_at END,
        @c = component, @v = version
      WHERE release_id = @rid AND status IN (${fromIn});
      SET @n = @@ROWCOUNT;
      SET @ok = CASE WHEN @n > 0 THEN 1 ELSE 0 END;
      IF @ok = 1 AND @to = 'revoked'
      BEGIN
        -- 撤回的版本不能再是任何環的目標,也不再強制升級到它
        UPDATE ita.release_ring SET target_version = NULL, target_set_at = @at, updated_by_emp = @emp, updated_by_name = @name, updated_at = @at, request_id = @req
        OUTPUT INSERTED.ring INTO @cleared
        WHERE component = @c AND target_version = @v;
        UPDATE ita.device_upgrade SET forced_version = NULL, forced_by_emp = NULL, forced_at = NULL, updated_at = @at
        WHERE component = @c AND forced_version = @v;
      END
      COMMIT;
      SELECT @ok AS ok;
      SELECT ring FROM @cleared;`);
    const [okRows, cleared] = r.recordsets as unknown as [Row[], Row[]];
    return { ok: okRows[0]?.ok === true, clearedRings: cleared.map((x) => String(x.ring) as Ring) };
  }

  async listRings(): Promise<RingRecord[]> {
    const r = await (
      await this.request()
    ).query(
      `SELECT ring, component, target_version, target_set_at, updated_by_emp, updated_by_name, updated_at FROM ita.release_ring ORDER BY ring, component`,
    );
    return (r.recordset as Row[]).map(toRing);
  }

  async setRingTarget(ring: Ring, component: ReleaseComponent, version: string | null, actor: Actor, at: Date, requestId: string): Promise<void> {
    await (
      await this.request()
    )
      .input('ring', sql.VarChar(16), ring)
      .input('c', sql.VarChar(16), component)
      .input('v', sql.VarChar(32), version)
      .input('emp', sql.NVarChar(64), cut(actor.emp, 64))
      .input('name', sql.NVarChar(100), cut(actor.name, 100))
      .input('at', sql.DateTime2(3), at)
      .input('req', sql.VarChar(64), cut(requestId, 64)).query(`
        UPDATE ita.release_ring SET
          target_set_at = CASE WHEN (target_version IS NULL AND @v IS NULL) OR target_version = @v THEN target_set_at ELSE @at END,
          target_version = @v, updated_by_emp = @emp, updated_by_name = @name, updated_at = @at, request_id = @req
        WHERE ring = @ring AND component = @c;
        IF @@ROWCOUNT = 0
          INSERT INTO ita.release_ring (ring, component, target_version, target_set_at, updated_by_emp, updated_by_name, updated_at, request_id)
          VALUES (@ring, @c, @v, @at, @emp, @name, @at, @req);`);
  }

  async setDeviceRing(deviceRef: number, ring: Ring): Promise<void> {
    await (
      await this.request()
    )
      .input('id', sql.Int, deviceRef)
      .input('ring', sql.VarChar(16), ring)
      .query(`UPDATE ita.device SET ring = @ring WHERE id = @id`);
  }

  async deviceRing(deviceRef: number): Promise<Ring | null> {
    const r = await (await this.request()).input('id', sql.Int, deviceRef).query(`SELECT ring FROM ita.device WHERE id = @id`);
    const row = r.recordset[0] as Row | undefined;
    return row ? (String(row.ring) as Ring) : null;
  }

  async deviceUpgrades(deviceRef: number): Promise<DeviceUpgradeRecord[]> {
    const r = await (
      await this.request()
    )
      .input('id', sql.Int, deviceRef)
      .query(`SELECT ${UPGRADE_COLS} FROM ita.device_upgrade u WHERE u.device_ref = @id ORDER BY u.component`);
    return (r.recordset as Row[]).map(toUpgrade);
  }

  async saveUpgrade(deviceRef: number, component: ReleaseComponent, p: UpgradePatch, at: Date): Promise<void> {
    await (
      await this.request()
    )
      .input('id', sql.Int, deviceRef)
      .input('c', sql.VarChar(16), component)
      .input('tv', sql.VarChar(32), cut(p.targetVersion, 32))
      .input('fv', sql.VarChar(32), cut(p.fromVersion, 32))
      .input('st', sql.VarChar(16), p.state)
      .input('att', sql.Int, Math.max(0, Math.min(1000, Math.round(p.attempts))))
      .input('ec', sql.VarChar(32), cut(p.errorCode, 32))
      .input('em', sql.NVarChar(300), cut(p.errorMessage, 300))
      .input('forced', sql.VarChar(32), cut(p.forcedVersion, 32))
      .input('femp', sql.NVarChar(64), cut(p.forcedByEmp, 64))
      .input('fat', sql.DateTime2(3), p.forcedAt)
      .input('sat', sql.DateTime2(3), p.startedAt)
      .input('at', sql.DateTime2(3), at).query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        -- 同一台的 Watchdog 上報與 Agent 事件同時寫入:先鎖再判斷,不會兩邊都 INSERT 撞主鍵
        UPDATE ita.device_upgrade WITH (UPDLOCK, HOLDLOCK) SET target_version = @tv, from_version = @fv, state = @st, attempts = @att, error_code = @ec, error_message = @em,
          forced_version = @forced, forced_by_emp = @femp, forced_at = @fat, started_at = @sat, updated_at = @at
        WHERE device_ref = @id AND component = @c;
        IF @@ROWCOUNT = 0
          INSERT INTO ita.device_upgrade (device_ref, component, target_version, from_version, state, attempts, error_code, error_message,
            forced_version, forced_by_emp, forced_at, started_at, updated_at)
          VALUES (@id, @c, @tv, @fv, @st, @att, @ec, @em, @forced, @femp, @fat, @sat, @at);
        COMMIT;`);
  }

  async activeUpgrades(pendingSince: Date, activeSince: Date): Promise<number> {
    const r = await (await this.request()).input('ps', sql.DateTime2(3), pendingSince).input('as', sql.DateTime2(3), activeSince).query(`
      SELECT COUNT(DISTINCT u.device_ref) AS n FROM ita.device_upgrade u JOIN ita.device d ON d.id = u.device_ref
      WHERE u.target_version IS NOT NULL AND d.status = 'active' AND d.merged_into IS NULL
        AND ((u.state = 'pending' AND u.updated_at >= @ps) OR (u.state IN ('downloading', 'verifying', 'installing') AND u.updated_at >= @as))`);
    return Number((r.recordset[0] as Row | undefined)?.n ?? 0);
  }

  async upgradeTargets(companies?: string[], deviceRef?: number): Promise<UpgradeTargetRow[]> {
    const req = await this.request();
    let scope = companies ? ` AND ${companyIn(req, companies)}` : '';
    if (deviceRef !== undefined) scope += ` AND d.id = ${(req.input('dref', sql.Int, deviceRef), '@dref')}`;
    const rules = UPGRADE_RULES.map((x, k) => (req.input(`ar${k}`, sql.VarChar(32), x), `@ar${k}`)).join(', ');
    const r = await req.query(`
      SELECT d.id, d.device_id, d.company, d.ring, d.last_seen_at, d.agent_version, h.watchdog_version, h.watchdog_report_at
      FROM ita.device d LEFT JOIN ita.device_health h ON h.device_ref = d.id
      WHERE d.status = 'active' AND d.merged_into IS NULL${scope};
      SELECT ${UPGRADE_COLS} FROM ita.device_upgrade u JOIN ita.device d ON d.id = u.device_ref
      WHERE d.status = 'active' AND d.merged_into IS NULL${scope};
      SELECT a.device_ref, a.[rule] FROM ita.device_alert a JOIN ita.device d ON d.id = a.device_ref
      WHERE a.state = 'open' AND a.[rule] IN (${rules})${scope};`);
    const [devices, upgrades, alerts] = r.recordsets as unknown as [Row[], Row[], Row[]];
    const ups = new Map<number, DeviceUpgradeRecord[]>();
    for (const u of upgrades) {
      const x = toUpgrade(u);
      ups.set(x.deviceRef, [...(ups.get(x.deviceRef) ?? []), x]);
    }
    const open = new Map<number, AlertRule[]>();
    for (const a of alerts) open.set(Number(a.device_ref), [...(open.get(Number(a.device_ref)) ?? []), String(a.rule) as AlertRule]);
    return devices.map((d) => ({
      deviceRef: Number(d.id),
      deviceId: String(d.device_id).toLowerCase(),
      company: str(d.company),
      ring: String(d.ring) as Ring,
      lastSeenAt: d.last_seen_at as Date,
      agentVersion: str(d.agent_version),
      watchdogVersion: str(d.watchdog_version),
      watchdogReportAt: date(d.watchdog_report_at),
      upgrades: ups.get(Number(d.id)) ?? [],
      openRules: open.get(Number(d.id)) ?? [],
    }));
  }
}
