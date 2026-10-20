/**
 * 軟體派送儲存(SQL Server 2012,migration 0008;PLATFORM-PLAN P7 §4.6、P7-SOFTWARE-DESIGN §1):
 * ita.software_package(軟體目錄);查 ita.command(此套件的 software.install)、ita.device_software(已安裝台數)、ita.device.ring。
 * 與 SqlDeviceStore 共用連線池。狀態轉換一律條件更新(WHERE status = …);兩人覆核(published_by ≠ created_by)在 UPDATE 條件與 CHECK 各擋一次。
 * SQL 2012 沒有 JSON 函式:指令參數快照以 `"package_id":"<uuid>"` 字串比對(快照由本服務 JSON.stringify 產生,格式固定;uuid 已驗證)。
 */
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { AppError } from '../errors.js';
import { companyIn, likeContains } from './sql-store.js';
import type {
  Actor,
  CommandState,
  DetectType,
  InstallerType,
  InstallResultRow,
  NewPackage,
  PackagePatch,
  PackageRecord,
  PackageStatus,
  RebootPolicy,
  Ring,
  SoftwareStore,
} from './types.js';

type Row = Record<string, unknown>;

const cut = (s: string | null | undefined, n: number): string | null => (s == null || s === '' ? null : s.length > n ? s.slice(0, n) : s);
const str = (v: unknown): string | null => (v == null ? null : String(v));
const date = (v: unknown): Date | null => (v as Date | null) ?? null;
const list = (v: unknown): string[] =>
  v == null
    ? []
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
const isDuplicateKey = (err: unknown) => [2627, 2601].includes((err as { number?: number }).number ?? 0);

/** 指令參數快照中的 package_id(LIKE,搭配 ESCAPE '\\') */
export const packageParamLike = (packageId: string) => `%"package\\_id":"${packageId.toLowerCase()}"%`;

const COLS = `id, package_id, name, version, file_name, sha256, size_bytes, installer_type, install_args, uninstall_args, detect_type, detect_value,
  reboot_policy, signer_thumbprints, observed_signers, license_limit, status, notes, created_by_emp, created_by_name, created_at, updated_by_emp, updated_at,
  tested_by_emp, tested_at, published_by_emp, published_by_name, published_at, revoked_by_emp, revoked_at`;

function toPackage(r: Row): PackageRecord {
  return {
    id: Number(r.id),
    packageId: String(r.package_id).toLowerCase(),
    name: String(r.name),
    version: String(r.version),
    fileName: String(r.file_name),
    sha256: String(r.sha256).toLowerCase(),
    sizeBytes: Number(r.size_bytes),
    installerType: String(r.installer_type) as InstallerType,
    installArgs: str(r.install_args),
    uninstallArgs: str(r.uninstall_args),
    detectType: String(r.detect_type) as DetectType,
    detectValue: String(r.detect_value),
    rebootPolicy: String(r.reboot_policy) as RebootPolicy,
    signerThumbprints: list(r.signer_thumbprints),
    observedSigners: list(r.observed_signers),
    licenseLimit: r.license_limit == null ? null : Number(r.license_limit),
    status: String(r.status) as PackageStatus,
    notes: str(r.notes),
    createdByEmp: String(r.created_by_emp),
    createdByName: str(r.created_by_name),
    createdAt: r.created_at as Date,
    updatedByEmp: str(r.updated_by_emp),
    updatedAt: date(r.updated_at),
    testedByEmp: str(r.tested_by_emp),
    testedAt: date(r.tested_at),
    publishedByEmp: str(r.published_by_emp),
    publishedByName: str(r.published_by_name),
    publishedAt: date(r.published_at),
    revokedByEmp: str(r.revoked_by_emp),
    revokedAt: date(r.revoked_at),
  };
}

export class SqlSoftwareStore implements SoftwareStore {
  constructor(private readonly pool: () => Promise<sql.ConnectionPool>) {}

  private async request(): Promise<sql.Request> {
    return (await this.pool()).request();
  }

  async listPackages(f: { status?: PackageStatus; q?: string }): Promise<PackageRecord[]> {
    const req = await this.request();
    const where: string[] = [];
    if (f.status) where.push(`status = ${(req.input('s', sql.VarChar(16), f.status), '@s')}`);
    if (f.q) where.push(`name LIKE ${(req.input('q', sql.NVarChar(210), likeContains(f.q)), '@q')} ESCAPE '\\'`);
    const r = await req.query(
      `SELECT TOP (500) ${COLS} FROM ita.software_package ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name, created_at DESC, id DESC`,
    );
    return (r.recordset as Row[]).map(toPackage);
  }

  async getPackage(packageId: string): Promise<PackageRecord | null> {
    const r = await (
      await this.request()
    )
      .input('pid', sql.UniqueIdentifier, packageId)
      .query(`SELECT ${COLS} FROM ita.software_package WHERE package_id = @pid`);
    const row = r.recordset[0] as Row | undefined;
    return row ? toPackage(row) : null;
  }

  async addPackage(n: NewPackage): Promise<PackageRecord> {
    const packageId = randomUUID();
    try {
      await (
        await this.request()
      )
        .input('pid', sql.UniqueIdentifier, packageId)
        .input('name', sql.NVarChar(100), n.name)
        .input('ver', sql.NVarChar(50), n.version)
        .input('file', sql.NVarChar(260), n.fileName)
        .input('sha', sql.Char(64), n.sha256)
        .input('size', sql.BigInt, n.sizeBytes)
        .input('itype', sql.VarChar(16), n.installerType)
        .input('iargs', sql.NVarChar(500), n.installArgs)
        .input('uargs', sql.NVarChar(500), n.uninstallArgs)
        .input('dtype', sql.VarChar(16), n.detectType)
        .input('dval', sql.NVarChar(400), n.detectValue)
        .input('reboot', sql.VarChar(16), n.rebootPolicy)
        .input('lic', sql.Int, n.licenseLimit)
        .input('notes', sql.NVarChar(1000), cut(n.notes, 1000))
        .input('emp', sql.NVarChar(64), cut(n.actor.emp, 64))
        .input('ename', sql.NVarChar(100), cut(n.actor.name, 100))
        .input('at', sql.DateTime2(3), n.at)
        .input('req', sql.VarChar(64), cut(n.requestId, 64)).query(`
          INSERT INTO ita.software_package (package_id, name, version, file_name, sha256, size_bytes, installer_type, install_args, uninstall_args,
            detect_type, detect_value, reboot_policy, license_limit, status, notes, created_by_emp, created_by_name, created_at, request_id)
          VALUES (@pid, @name, @ver, @file, @sha, @size, @itype, @iargs, @uargs, @dtype, @dval, @reboot, @lic, 'draft', @notes, @emp, @ename, @at, @req)`);
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError(409, 'ITA_PACKAGE_EXISTS', `${n.name} ${n.version} 或檔案 ${n.fileName} 已登錄`);
      throw err;
    }
    const saved = await this.getPackage(packageId);
    if (!saved) throw new Error('套件登錄後讀不到');
    return saved;
  }

  async updatePackage(packageId: string, expect: PackageStatus, p: PackagePatch, actor: Actor, at: Date, requestId: string): Promise<boolean> {
    const req = (await this.request())
      .input('pid', sql.UniqueIdentifier, packageId)
      .input('expect', sql.VarChar(16), expect)
      .input('emp', sql.NVarChar(64), cut(actor.emp, 64))
      .input('at', sql.DateTime2(3), at)
      .input('req', sql.VarChar(64), cut(requestId, 64))
      .input('revert', sql.Bit, p.revertToDraft);
    const sets: string[] = [];
    const set = (col: string, name: string, type: sql.ISqlType | (() => sql.ISqlType), v: unknown) => {
      req.input(name, type, v);
      sets.push(`${col} = @${name}`);
    };
    if (p.installArgs !== undefined) set('install_args', 'iargs', sql.NVarChar(500), p.installArgs);
    if (p.uninstallArgs !== undefined) set('uninstall_args', 'uargs', sql.NVarChar(500), p.uninstallArgs);
    if (p.detectType !== undefined) set('detect_type', 'dtype', sql.VarChar(16), p.detectType);
    if (p.detectValue !== undefined) set('detect_value', 'dval', sql.NVarChar(400), p.detectValue);
    if (p.rebootPolicy !== undefined) set('reboot_policy', 'reboot', sql.VarChar(16), p.rebootPolicy);
    if (p.licenseLimit !== undefined) set('license_limit', 'lic', sql.Int, p.licenseLimit);
    if (p.notes !== undefined) set('notes', 'notes', sql.NVarChar(1000), cut(p.notes, 1000));
    // 退回 draft:已發佈版本改安裝參數等於新的覆核,清除簽章者與 tested_* / published_*(設計 §3.2)
    const revert = p.revertToDraft
      ? `, status = 'draft', signer_thumbprints = NULL, tested_by_emp = NULL, tested_at = NULL, published_by_emp = NULL, published_by_name = NULL, published_at = NULL`
      : '';
    const r = await req.query(`
      UPDATE ita.software_package SET ${[...sets, 'updated_by_emp = @emp', 'updated_at = @at', 'request_id = @req'].join(', ')}${revert}
      WHERE package_id = @pid AND status = @expect`);
    return (r.rowsAffected[0] ?? 0) > 0;
  }

  async markTested(packageId: string, signers: string[], observed: string[], actor: Actor, at: Date, requestId: string): Promise<boolean> {
    const r = await (
      await this.request()
    )
      .input('pid', sql.UniqueIdentifier, packageId)
      .input('signers', sql.VarChar(400), signers.join(','))
      // 測試結果最多 200 筆,實際簽章者通常 1–2 個;超過 9 個(40 字 + 逗號)才會被截斷,截斷時只保留完整的指紋
      .input('observed', sql.VarChar(400), observed.slice(0, 9).join(','))
      .input('emp', sql.NVarChar(64), cut(actor.emp, 64))
      .input('at', sql.DateTime2(3), at)
      .input('req', sql.VarChar(64), cut(requestId, 64)).query(`
        UPDATE ita.software_package SET status = 'tested', signer_thumbprints = @signers, observed_signers = @observed,
          tested_by_emp = @emp, tested_at = @at, request_id = @req
        WHERE package_id = @pid AND status = 'draft'`);
    return (r.rowsAffected[0] ?? 0) > 0;
  }

  async publish(packageId: string, actor: Actor, at: Date, requestId: string): Promise<boolean> {
    const r = await (
      await this.request()
    )
      .input('pid', sql.UniqueIdentifier, packageId)
      .input('emp', sql.NVarChar(64), cut(actor.emp, 64))
      .input('name', sql.NVarChar(100), cut(actor.name, 100))
      .input('at', sql.DateTime2(3), at)
      .input('req', sql.VarChar(64), cut(requestId, 64)).query(`
        UPDATE ita.software_package SET status = 'published', published_by_emp = @emp, published_by_name = @name, published_at = @at, request_id = @req
        WHERE package_id = @pid AND status = 'tested' AND created_by_emp <> @emp AND signer_thumbprints IS NOT NULL`);
    return (r.rowsAffected[0] ?? 0) > 0;
  }

  async revoke(packageId: string, actor: Actor, at: Date, requestId: string): Promise<{ ok: boolean; canceledCommands: number }> {
    const r = await (
      await this.request()
    )
      .input('pid', sql.UniqueIdentifier, packageId)
      .input('pat', sql.NVarChar(100), packageParamLike(packageId))
      .input('emp', sql.NVarChar(64), cut(actor.emp, 64))
      .input('at', sql.DateTime2(3), at)
      .input('req', sql.VarChar(64), cut(requestId, 64)).query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @ok BIT, @n INT;
        UPDATE ita.software_package SET status = 'revoked', revoked_by_emp = @emp, revoked_at = @at, request_id = @req
        WHERE package_id = @pid AND status <> 'revoked';
        SET @ok = CASE WHEN @@ROWCOUNT > 0 THEN 1 ELSE 0 END;
        SET @n = 0;
        IF @ok = 1
        BEGIN
          -- 撤回後不能再被派送:尚未送出的安裝取消;已送出的指令不受影響(下載會被拒,設計 §3.2、§3.3)
          UPDATE ita.command SET state = 'canceled', error_code = 'PACKAGE_REVOKED', finished_at = @at, updated_at = SYSUTCDATETIME()
          -- queued 最長存活 48 小時(有效期限 24 小時 + 待核可 24 小時):只掃最近 7 天,避免全表掃描
          WHERE created_at >= DATEADD(DAY, -7, @at) AND kind = 'software.install' AND state = 'queued' AND params LIKE @pat ESCAPE '\\';
          SET @n = @@ROWCOUNT;
        END
        COMMIT;
        SELECT @ok AS ok, @n AS n;`);
    const row = r.recordset[0] as Row | undefined;
    return { ok: row?.ok === true, canceledCommands: Number(row?.n ?? 0) };
  }

  async installResults(packageId: string, limit: number): Promise<InstallResultRow[]> {
    const r = await (await this.request()).input('pat', sql.NVarChar(100), packageParamLike(packageId)).input('limit', sql.Int, limit).query(`
      SELECT TOP (@limit) c.command_id, d.device_id, d.computer_name, d.company, d.ring, c.state, c.params, c.result_summary, c.error_code, c.created_by_emp, c.finished_at
      FROM ita.command c JOIN ita.device d ON d.id = c.device_ref
      -- 測試依據只看最近 180 天(前置萬用字元的 LIKE 無法用索引,以 created_at 收斂掃描範圍)
      WHERE c.created_at >= DATEADD(DAY, -180, SYSUTCDATETIME()) AND c.kind = 'software.install' AND c.params LIKE @pat ESCAPE '\\'
      ORDER BY c.id DESC`);
    return (r.recordset as Row[]).map((x) => ({
      commandId: String(x.command_id).toLowerCase(),
      deviceId: String(x.device_id).toLowerCase(),
      computerName: String(x.computer_name),
      deviceCompany: str(x.company),
      ring: String(x.ring) as Ring,
      state: String(x.state) as CommandState,
      params: String(x.params),
      resultSummary: str(x.result_summary),
      errorCode: str(x.error_code),
      createdByEmp: String(x.created_by_emp),
      finishedAt: date(x.finished_at),
    }));
  }

  async activeInstallPackages(deviceRef: number): Promise<string[]> {
    const r = await (
      await this.request()
    )
      .input('dev', sql.Int, deviceRef)
      .query(`SELECT params FROM ita.command WHERE device_ref = @dev AND kind = 'software.install' AND state IN ('sent', 'acked', 'running')`);
    const out: string[] = [];
    for (const row of r.recordset as Row[]) {
      try {
        const id = (JSON.parse(String(row.params)) as { package_id?: unknown }).package_id;
        if (typeof id === 'string') out.push(id.toLowerCase());
      } catch {
        // 參數不是 JSON(不會發生:由本服務寫入);略過
      }
    }
    return out;
  }

  async deviceRing(deviceRef: number): Promise<Ring | null> {
    const r = await (await this.request()).input('id', sql.Int, deviceRef).query(`SELECT ring FROM ita.device WHERE id = @id`);
    const row = r.recordset[0] as Row | undefined;
    return row ? (String(row.ring) as Ring) : null;
  }

  async installedCounts(patterns: string[], companies?: string[]): Promise<number[]> {
    if (patterns.length === 0) return [];
    const out = patterns.map(() => 0);
    // 每批 200 個樣式(參數上限 2100)
    for (let i = 0; i < patterns.length; i += 200) {
      const req = await this.request();
      // 跳脫後最長 800 字(detect_value 400 字,每字最多加一個 \)
      const values = patterns.slice(i, i + 200).map((p, k) => (req.input(`p${k}`, sql.NVarChar(800), p), `(${i + k}, @p${k})`));
      const scope = companies ? ` AND ${companyIn(req, companies)}` : '';
      const r = await req.query(`
        SELECT p.k, COUNT(DISTINCT s.device_ref) AS n
        FROM (VALUES ${values.join(', ')}) AS p (k, pat)
        JOIN ita.device_software s ON s.name LIKE p.pat ESCAPE '\\'
        JOIN ita.device d ON d.id = s.device_ref
        WHERE d.status = 'active' AND d.merged_into IS NULL${scope}
        GROUP BY p.k`);
      for (const row of r.recordset as Row[]) out[Number(row.k)] = Number(row.n);
    }
    return out;
  }

  async installedDevices(pattern: string, opts: { companies?: string[]; onlyRefs?: number[]; limit: number }) {
    const req = (await this.request()).input('pat', sql.NVarChar(800), pattern).input('limit', sql.Int, opts.limit);
    let where = `s.name LIKE @pat ESCAPE '\\' AND d.status = 'active' AND d.merged_into IS NULL`;
    if (opts.companies) where += ` AND ${companyIn(req, opts.companies)}`;
    if (opts.onlyRefs) {
      if (opts.onlyRefs.length === 0) return [];
      where += ` AND d.id IN (${opts.onlyRefs.map((id, k) => (req.input(`r${k}`, sql.Int, id), `@r${k}`)).join(', ')})`;
    }
    const r = await req.query(`
      SELECT TOP (@limit) d.id, d.device_id, d.computer_name, d.company, s.name, s.version
      FROM ita.device_software s JOIN ita.device d ON d.id = s.device_ref
      WHERE ${where}
      ORDER BY d.computer_name, d.id`);
    return (r.recordset as Row[]).map((x) => ({
      deviceRef: Number(x.id),
      deviceId: String(x.device_id).toLowerCase(),
      computerName: String(x.computer_name),
      company: str(x.company),
      name: String(x.name),
      version: str(x.version),
    }));
  }
}
