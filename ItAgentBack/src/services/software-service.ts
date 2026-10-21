/**
 * 軟體派送(PLATFORM-PLAN P7 §4.6;P7-SOFTWARE-DESIGN §1–§4、§6):軟體目錄、狀態機與兩人覆核、派送前檢查(目錄快照)、授權數、套件下載。
 *   - 狀態機:draft →(pilot 測試機安裝成功、IT 確認簽章者)tested →(第二人)published → revoked;改安裝參數 / 偵測規則退回 draft
 *   - 覆核:published_by ≠ created_by(§9-4),也 ≠ 最後修改安裝參數 / 偵測規則的人(D2-2);tested_by 可以是建立人
 *   - 目錄是全公司共用:登錄 / 修改 / 測試完成 / 發佈 / 撤回需 endpoint.software.manage(BFF)且全部公司角色(§9-5)
 *   - draft / tested 只能派到 pilot 環的電腦(放進 / 移出 pilot 需全部公司角色,P6);revoked 不可再安裝(可移除)
 *   - software.install / software.uninstall 的 params 由這裡換成目錄快照(Agent 只信任快照,§2.2);授權數只檢查已發佈套件的安裝(§3.4)
 *   - 安裝參數字元白名單、不可指到其他檔案、不可含機密字樣(§2.3、§5.6);主機登錄、修改、建立指令時都驗
 *   - 下載只給「這台有尚未結束的此套件 software.install」的裝置;回應前複驗 SHA-256(§3.3)
 * SQL 是唯一真相;下載稽核每台每套件每小時一筆。
 */
import type { ReadStream } from 'node:fs';
import type { GatewayIdentity } from '@giganexus/backend-sdk';
import { AppError, storageUnavailable } from '../errors.js';
import type {
  Actor,
  DetectType,
  DeviceRecord,
  DeviceStore,
  InstallerType,
  InstallResultRow,
  PackagePatch,
  PackageRecord,
  PackageStatus,
  RebootPolicy,
  SoftwareStore,
} from '../stores/types.js';
import type { CommandDispatcher, CreateBatchResult } from './command-dispatcher.js';
import type { Ctx } from './device-service.js';
import { parseRange } from './rooted-files.js';
import { inScope, scopeCompanies, type MgmtCtx } from './scope.js';
import { extensionMatches, splitSoftwarePath, type SoftwareFileInfo, type SoftwareFiles } from './software-files.js';

export const INSTALLER_TYPES: readonly InstallerType[] = ['msi', 'inno', 'nsis', 'burn', 'exe'];
export const DETECT_TYPES: readonly DetectType[] = ['msi_product_code', 'display_name'];
export const REBOOT_POLICIES: readonly RebootPolicy[] = ['never', 'required'];
export const PACKAGE_STATUSES: readonly PackageStatus[] = ['draft', 'tested', 'published', 'revoked'];

/** 安裝 / 移除額外參數的字元白名單(§2.3):不含 & | ; < > ^ ` $ \ @ [ ] 與換行;路徑用 /;( ) 只為 Program Files (x86);+ 為資料夾名稱(Notepad++) */
export const ARGS_RE = /^[A-Za-z0-9 /\-_=.:,"{}%()+]*$/;
export const ARGS_MAX = 500;
/** 參數不可指到其他可執行檔、轉換檔、回應檔(MSI 的 TRANSFORMS、PATCH,Inno 的 /LOADINF 等;§2.3、D3) */
const ARGS_FILE = /\.(msi|msp|mst|exe|dll|bat|cmd|ps1|vbs|js|inf|iss|ini|xml|txt|log|reg|cfg|json)\b/i;
/**
 * 會讓安裝程式讀寫外部檔案的參數(D3;安裝程式以 SYSTEM 執行):
 * MSI 屬性 TRANSFORMS / PATCH / MSIPATCHREMOVE、msiexec /l* 記錄 /p /update /t /a /j、
 * Inno /LOADINF /SAVEINF /LOG、InstallShield /f1 /f2、Burn / 通用 -log /log /config CONFIGFILE
 */
const ARGS_FILE_SWITCH =
  /(^|[\s"])(TRANSFORMS|PATCH|MSIPATCHREMOVE|CONFIGFILE)\s*=|(^|[\s"])[/-](LOADINF|SAVEINF|LOG|CONFIG|UPDATE|F1|F2|P|T|A|J)(?=[\s=:"]|$)|(^|[\s"])[/-]L[*!+voiwearucmpx]*(?=[\s=:"]|$)/i;
/** 磁碟機路徑只允許 C:/Program Files/ 與 C:/Program Files (x86)/ 底下(D3) */
const ARGS_DRIVE = /(^|[\s="])[A-Za-z]:/g;
const ARGS_DRIVE_OK = /^[Cc]:\/Program Files( \(x86\))?\//i;
/** { } 只用於 GUID(MSI 產品代碼);Inno 常數 {sys} {tmp} {src} 等會展開成系統路徑 */
const ARGS_BRACE = /\{[^}]*\}?/g;
const ARGS_GUID = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;

/** D3:路徑類檢查(字元白名單通過後);回傳錯誤訊息或 null */
function argsPathError(v: string): string | null {
  if (v.includes('//')) return '不可使用網路路徑(UNC)';
  if (v.includes('..')) return '路徑不可含 ..';
  if (/=\s*"?\//.test(v)) return '參數值不可以 / 開頭(根目錄路徑);路徑需為 C:/Program Files/ 或 C:/Program Files (x86)/ 底下';
  for (const m of v.matchAll(ARGS_DRIVE)) {
    const at = (m.index ?? 0) + m[1]!.length;
    if (!ARGS_DRIVE_OK.test(v.slice(at))) return '磁碟機路徑只允許 C:/Program Files/ 或 C:/Program Files (x86)/ 底下(路徑用 /)';
  }
  for (const m of v.matchAll(ARGS_BRACE)) if (!ARGS_GUID.test(m[0])) return '{ } 只能用於 GUID(MSI 產品代碼)';
  if (/[()]/.test(v.replace(/Program Files \(x86\)/gi, ''))) return '( ) 只能出現在 Program Files (x86)';
  return null;
}
/** 參數不可含機密(序號、密碼;沿用 logs.collect 遮罩關鍵字,§5.6、§7);不加字首邊界,PIDKEY= / PRODUCTKEY= 也擋 */
const ARGS_SECRET = /(token|password|passwd|pwd|secret|api[_-]?key|key)\s*[=:]/i;
export const MSI_PRODUCT_CODE_RE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
/** DisplayName 樣式:單行、不含控制字元;% 為萬用字元,至少 3 個非 % 字元(避免 % 對到所有軟體) */
const DISPLAY_NAME_RE = /^[^\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]{1,400}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNER_RE = /^[0-9a-f]{40}$/;
/** 安裝逾時(Agent 端;指令整體逾時 4 小時含下載,§2.1) */
export const INSTALL_TIMEOUT_SEC = 1800;
/** 下載稽核事件:同一台同一套件多久記一次 */
const DOWNLOAD_EVENT_MS = 3_600_000;
/** 詳情顯示的測試結果 / 已安裝電腦筆數 */
const DETAIL_LIMIT = 200;

type Field = { field: string; message: string };

/** 純函式:安裝 / 移除參數的錯誤(通過回空陣列) */
export function argsErrors(field: string, v: string | null | undefined): Field[] {
  if (v == null || v === '') return [];
  if (v.length > ARGS_MAX) return [{ field, message: `最多 ${ARGS_MAX} 字` }];
  if (!ARGS_RE.test(v)) return [{ field, message: '只允許英數字、空白與 / - _ = . : , " { } % ( ) +(不可含 & | ; < > ^ ` $ \\ @ 與換行;路徑請用 /)' }];
  if (ARGS_FILE.test(v)) return [{ field, message: '不可指到其他檔案(.msi / .exe / .mst / .dll / 指令檔 / 回應檔 / 設定檔)' }];
  if (ARGS_FILE_SWITCH.test(v)) return [{ field, message: '不可使用讀寫外部檔案的參數(TRANSFORMS、PATCH、/l*、/LOADINF、/SAVEINF、/LOG、/f1 等)' }];
  const pathErr = argsPathError(v);
  if (pathErr) return [{ field, message: pathErr }];
  if (ARGS_SECRET.test(v)) return [{ field, message: '不可含序號、密碼、金鑰類參數(需要序號的軟體不在派送支援範圍)' }];
  return [];
}

/** 純函式:偵測規則的錯誤 */
export function detectErrors(type: DetectType, value: string): Field[] {
  if (type === 'msi_product_code')
    return MSI_PRODUCT_CODE_RE.test(value) ? [] : [{ field: 'detectValue', message: 'MSI 產品代碼格式為 {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}' }];
  if (!DISPLAY_NAME_RE.test(value)) return [{ field: 'detectValue', message: 'DisplayName 樣式需 1–400 字、單行、不含控制字元' }];
  if (value.replace(/%/g, '').trim().length < 3) return [{ field: 'detectValue', message: 'DisplayName 樣式至少要有 3 個 % 以外的字元' }];
  return [];
}

/** 純函式:DisplayName 樣式轉 SQL LIKE(% 保留為萬用字元,其餘萬用字元跳脫,搭配 ESCAPE '\\') */
export function displayNameLike(value: string): string {
  return value.replace(/[\\_[]/g, (c) => `\\${c}`);
}

/** 純函式:這台(所屬環)可不可以派送此套件;不可回錯誤 */
export function deployDenied(pkg: PackageRecord, ring: string | null, action: 'install' | 'uninstall'): AppError | null {
  if (pkg.status === 'revoked') {
    if (action === 'uninstall') return null;
    return new AppError(409, 'ITA_PACKAGE_REVOKED', `${pkg.name} ${pkg.version} 已撤回,不能再安裝`);
  }
  if (pkg.status !== 'published' && ring !== 'pilot')
    return new AppError(409, 'ITA_PACKAGE_NOT_PUBLISHED', `${pkg.name} ${pkg.version} 尚未發佈(${pkg.status}),只能派送到 pilot 環的測試機`);
  return null;
}

/** 純函式:software.install 參數快照(§2.2) */
export function installSnapshot(pkg: PackageRecord, opts: { ignorePower?: boolean } = {}): Record<string, unknown> {
  return {
    package_id: pkg.packageId,
    name: pkg.name,
    version: pkg.version,
    url: `/agent/v1/packages/${pkg.packageId}`,
    sha256: pkg.sha256,
    size_bytes: pkg.sizeBytes,
    installer_type: pkg.installerType,
    install_args: pkg.installArgs ?? '',
    // draft 在測試機上為空:Agent 仍須簽章有效並回報實際簽章者,不採信空清單放行(§2.2、§5.2)
    signer_thumbprints: pkg.signerThumbprints,
    detect: { type: pkg.detectType, value: pkg.detectValue },
    timeout_sec: INSTALL_TIMEOUT_SEC,
    reboot_policy: pkg.rebootPolicy,
    ...(opts.ignorePower ? { ignore_power: true } : {}),
  };
}

/** 純函式:software.uninstall 參數快照 */
export function uninstallSnapshot(pkg: PackageRecord): Record<string, unknown> {
  return {
    package_id: pkg.packageId,
    name: pkg.name,
    version: pkg.version,
    installer_type: pkg.installerType,
    uninstall_args: pkg.uninstallArgs ?? '',
    detect: { type: pkg.detectType, value: pkg.detectValue },
    timeout_sec: INSTALL_TIMEOUT_SEC,
  };
}

/** 純函式:可作為 tested 依據的測試結果:pilot 裝置、succeeded、偵測通過、快照與目前目錄一致(檔案、安裝參數、偵測規則) */
export function qualifyingSigners(pkg: PackageRecord, rows: InstallResultRow[]): { commandIds: string[]; signers: string[] } {
  const commandIds: string[] = [];
  const signers = new Set<string>();
  for (const r of rows) {
    if (r.state !== 'succeeded' || r.ring !== 'pilot') continue;
    let p: Record<string, unknown>;
    let res: Record<string, unknown>;
    try {
      p = JSON.parse(r.params) as Record<string, unknown>;
      res = JSON.parse(r.resultSummary ?? '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    const d = p.detect as { type?: unknown; value?: unknown } | undefined;
    if (p.sha256 !== pkg.sha256 || (p.install_args ?? '') !== (pkg.installArgs ?? '') || d?.type !== pkg.detectType || d?.value !== pkg.detectValue) continue;
    if (res.detected === false) continue;
    const signer = typeof res.signer === 'string' ? res.signer.toLowerCase() : '';
    if (!SIGNER_RE.test(signer)) continue;
    commandIds.push(r.commandId);
    signers.add(signer);
  }
  return { commandIds, signers: [...signers] };
}

export interface PackageView {
  packageId: string;
  name: string;
  version: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  installerType: InstallerType;
  installArgs: string | null;
  uninstallArgs: string | null;
  detectType: DetectType;
  detectValue: string;
  rebootPolicy: RebootPolicy;
  signerThumbprints: string[];
  observedSigners: string[];
  licenseLimit: number | null;
  /** 資料範圍內已安裝的台數(DisplayName 樣式比對;MSI 產品代碼無法計算為 null) */
  installedCount: number | null;
  status: PackageStatus;
  notes: string | null;
  createdBy: { emp: string; name: string | null };
  createdAt: string;
  updatedByEmp: string | null;
  updatedAt: string | null;
  argsChangedByEmp: string | null;
  testedByEmp: string | null;
  testedAt: string | null;
  publishedBy: { emp: string; name: string | null } | null;
  publishedAt: string | null;
  revokedByEmp: string | null;
  revokedAt: string | null;
}

export function packageView(p: PackageRecord, installedCount: number | null): PackageView {
  return {
    packageId: p.packageId,
    name: p.name,
    version: p.version,
    fileName: p.fileName,
    sha256: p.sha256,
    sizeBytes: p.sizeBytes,
    installerType: p.installerType,
    installArgs: p.installArgs,
    uninstallArgs: p.uninstallArgs,
    detectType: p.detectType,
    detectValue: p.detectValue,
    rebootPolicy: p.rebootPolicy,
    signerThumbprints: p.signerThumbprints,
    observedSigners: p.observedSigners,
    licenseLimit: p.licenseLimit,
    installedCount,
    status: p.status,
    notes: p.notes,
    createdBy: { emp: p.createdByEmp, name: p.createdByName },
    createdAt: p.createdAt.toISOString(),
    updatedByEmp: p.updatedByEmp,
    updatedAt: p.updatedAt?.toISOString() ?? null,
    argsChangedByEmp: p.argsChangedByEmp,
    testedByEmp: p.testedByEmp,
    testedAt: p.testedAt?.toISOString() ?? null,
    publishedBy: p.publishedByEmp ? { emp: p.publishedByEmp, name: p.publishedByName } : null,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    revokedByEmp: p.revokedByEmp,
    revokedAt: p.revokedAt?.toISOString() ?? null,
  };
}

export interface RegisterPackageInput {
  name: string;
  version: string;
  fileName: string;
  installerType: InstallerType;
  installArgs?: string;
  uninstallArgs?: string;
  detectType: DetectType;
  detectValue: string;
  rebootPolicy?: RebootPolicy;
  licenseLimit?: number | null;
  notes?: string;
}

export type UpdatePackageInput = Partial<
  Pick<RegisterPackageInput, 'installArgs' | 'uninstallArgs' | 'detectType' | 'detectValue' | 'rebootPolicy' | 'notes'>
> & {
  licenseLimit?: number | null;
};

export interface DeployInput {
  action: 'install' | 'uninstall';
  deviceIds: string[];
  maxConcurrent?: number;
  ignorePower?: boolean;
}

export interface Download {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  stream: ReadStream | null;
}

export interface SoftwareServiceOptions {
  now?: () => Date;
  /** 批次派送用的指令派送器(與 kindHooks 互相參照,建立後再接上) */
  commands?: () => CommandDispatcher | undefined;
}

const actorOf = (who: GatewayIdentity): Actor => ({ emp: who.emp ?? who.sub, name: who.name ?? null });
const trimOrNull = (s: string | undefined | null) => (s == null ? null : s.trim() || null);

export class SoftwareService {
  private readonly now: () => Date;
  private readonly commands: () => CommandDispatcher | undefined;
  /** 下載稽核事件的最後記錄時間(裝置:套件 → 毫秒) */
  private readonly downloadLogged = new Map<string, number>();

  constructor(
    private readonly store: SoftwareStore,
    private readonly files: SoftwareFiles,
    private readonly devices: Pick<DeviceStore, 'addEvent'>,
    opts: SoftwareServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.commands = opts.commands ?? (() => undefined);
  }

  private async sqlDo<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      ctx.log.error({ err, what }, 'SQL Server 操作失敗(軟體派送)');
      throw storageUnavailable();
    }
  }

  /** 軟體目錄是全公司共用:只有全部公司角色可變更(§9-5) */
  private requireAll(ctx: MgmtCtx): void {
    if (!ctx.scope.all) throw new AppError(403, 'ITA_SCOPE_ALL_REQUIRED', '軟體目錄是全公司共用設定,只有可管理所有公司的角色能變更');
  }

  private async found(ctx: Ctx, packageId: string): Promise<PackageRecord> {
    const pkg = UUID_RE.test(packageId) ? await this.sqlDo(ctx, 'package.get', () => this.store.getPackage(packageId)) : null;
    if (!pkg) throw new AppError(404, 'ITA_PACKAGE_NOT_FOUND', '找不到此軟體套件');
    return pkg;
  }

  /** 安裝參數、偵測規則、授權數的組合檢查 */
  private validateFields(f: {
    installerType: InstallerType;
    installArgs: string | null;
    uninstallArgs: string | null;
    detectType: DetectType;
    detectValue: string;
    licenseLimit: number | null;
  }): void {
    const errors = [...argsErrors('installArgs', f.installArgs), ...argsErrors('uninstallArgs', f.uninstallArgs), ...detectErrors(f.detectType, f.detectValue)];
    // 授權數以 device_software 的 DisplayName 計數;P3 的軟體清單沒有 MSI 產品代碼(§3.4、§9-10)
    if (f.licenseLimit !== null && f.detectType !== 'display_name')
      errors.push({ field: 'licenseLimit', message: '設定授權數時偵測規則需為 display_name(MSI 產品代碼無法計算已安裝台數)' });
    if (errors.length) throw new AppError(400, 'VALIDATION_FAILED', '軟體套件欄位不正確', errors);
  }

  private async installedCount(ctx: MgmtCtx, pkgs: PackageRecord[]): Promise<(number | null)[]> {
    const idx = pkgs.map((p, i) => (p.detectType === 'display_name' ? i : -1)).filter((i) => i >= 0);
    const counts = await this.sqlDo(ctx, 'software.installedCounts', () =>
      this.store.installedCounts(
        idx.map((i) => displayNameLike(pkgs[i]!.detectValue)),
        scopeCompanies(ctx.scope),
      ),
    );
    const out: (number | null)[] = pkgs.map(() => null);
    idx.forEach((i, k) => (out[i] = counts[k] ?? 0));
    return out;
  }

  // ---------- 管理 API ----------

  async list(ctx: MgmtCtx, f: { status?: PackageStatus; q?: string }): Promise<{ items: PackageView[] }> {
    const rows = await this.sqlDo(ctx, 'package.list', () => this.store.listPackages({ status: f.status, q: f.q?.trim() || undefined }));
    const counts = await this.installedCount(ctx, rows);
    return { items: rows.map((p, i) => packageView(p, counts[i] ?? null)) };
  }

  /** 軟體庫內尚未登錄的安裝檔 */
  async unregisteredFiles(ctx: MgmtCtx): Promise<{ items: (Omit<SoftwareFileInfo, 'modifiedAt'> & { modifiedAt: string })[] }> {
    const [files, rows] = await Promise.all([this.files.list(), this.sqlDo(ctx, 'package.list', () => this.store.listPackages({}))]);
    const known = new Set(rows.map((r) => r.fileName.toLowerCase()));
    return { items: files.filter((f) => !known.has(f.fileName.toLowerCase())).map((f) => ({ ...f, modifiedAt: f.modifiedAt.toISOString() })) };
  }

  async register(ctx: MgmtCtx, who: GatewayIdentity, input: RegisterPackageInput): Promise<PackageView> {
    this.requireAll(ctx);
    const parts = splitSoftwarePath(input.fileName);
    if (!parts) throw new AppError(400, 'VALIDATION_FAILED', '檔案路徑需為 {軟體}/{版本}/{檔名}.msi 或 .exe', [{ field: 'fileName', message: '格式不符' }]);
    const fileName = parts.join('/');
    if (!extensionMatches(input.installerType, fileName))
      throw new AppError(400, 'VALIDATION_FAILED', 'installerType 與副檔名不符', [{ field: 'installerType', message: 'msi 需為 .msi,其他類型需為 .exe' }]);
    const fields = {
      installerType: input.installerType,
      installArgs: trimOrNull(input.installArgs),
      uninstallArgs: trimOrNull(input.uninstallArgs),
      detectType: input.detectType,
      detectValue: input.detectValue.trim(),
      licenseLimit: input.licenseLimit ?? null,
    };
    this.validateFields(fields);
    const f = await this.files.resolve(fileName);
    if (!f) throw new AppError(404, 'ITA_PACKAGE_FILE_NOT_FOUND', `軟體庫找不到 ${fileName}(或超過大小上限)`);
    const sha256 = await this.files.sha256(f);
    const pkg = await this.sqlDo(ctx, 'package.add', () =>
      this.store.addPackage({
        ...fields,
        name: input.name.trim(),
        version: input.version.trim(),
        fileName,
        sha256,
        sizeBytes: f.size,
        rebootPolicy: input.rebootPolicy ?? 'never',
        notes: trimOrNull(input.notes),
        actor: actorOf(who),
        at: this.now(),
        requestId: ctx.requestId,
      }),
    );
    ctx.log.info({ packageId: pkg.packageId, name: pkg.name, version: pkg.version, fileName, sha256, emp: actorOf(who).emp }, '登錄軟體套件');
    return packageView(pkg, null);
  }

  /** 改安裝參數 / 偵測規則:tested / published 退回 draft(§3.2);改授權數、重開機政策、說明不退回 */
  async update(ctx: MgmtCtx, who: GatewayIdentity, packageId: string, input: UpdatePackageInput): Promise<PackageView> {
    this.requireAll(ctx);
    const pkg = await this.found(ctx, packageId);
    if (pkg.status === 'revoked') throw new AppError(409, 'ITA_PACKAGE_REVOKED', '已撤回的套件不能修改,請登錄新版本');
    const next = {
      installerType: pkg.installerType,
      installArgs: input.installArgs !== undefined ? trimOrNull(input.installArgs) : pkg.installArgs,
      uninstallArgs: input.uninstallArgs !== undefined ? trimOrNull(input.uninstallArgs) : pkg.uninstallArgs,
      detectType: input.detectType ?? pkg.detectType,
      detectValue: input.detectValue !== undefined ? input.detectValue.trim() : pkg.detectValue,
      licenseLimit: input.licenseLimit !== undefined ? input.licenseLimit : pkg.licenseLimit,
    };
    this.validateFields(next);
    const reviewed =
      next.installArgs !== pkg.installArgs ||
      next.uninstallArgs !== pkg.uninstallArgs ||
      next.detectType !== pkg.detectType ||
      next.detectValue !== pkg.detectValue;
    const patch: PackagePatch = {
      installArgs: next.installArgs,
      uninstallArgs: next.uninstallArgs,
      detectType: next.detectType,
      detectValue: next.detectValue,
      licenseLimit: next.licenseLimit,
      ...(input.rebootPolicy !== undefined ? { rebootPolicy: input.rebootPolicy } : {}),
      ...(input.notes !== undefined ? { notes: trimOrNull(input.notes) } : {}),
      argsChanged: reviewed,
      revertToDraft: reviewed && pkg.status !== 'draft',
    };
    const ok = await this.sqlDo(ctx, 'package.update', () => this.store.updatePackage(packageId, pkg.status, patch, actorOf(who), this.now(), ctx.requestId));
    if (!ok) throw new AppError(409, 'ITA_PACKAGE_STATUS', '套件狀態已被變更,請重新整理');
    ctx.log.info({ packageId, reviewed, revertedFrom: patch.revertToDraft ? pkg.status : undefined, emp: actorOf(who).emp }, '修改軟體套件');
    return this.view(ctx, packageId);
  }

  private async view(ctx: MgmtCtx, packageId: string): Promise<PackageView> {
    const pkg = await this.found(ctx, packageId);
    return packageView(pkg, (await this.installedCount(ctx, [pkg]))[0] ?? null);
  }

  /** 詳情:測試機結果(pilot 裝置的 software.install)、已安裝電腦(皆依資料範圍過濾) */
  async get(ctx: MgmtCtx, packageId: string) {
    const pkg = await this.found(ctx, packageId);
    const [rows, installed, counts] = await Promise.all([
      this.sqlDo(ctx, 'package.installResults', () => this.store.installResults(packageId, DETAIL_LIMIT)),
      pkg.detectType === 'display_name'
        ? this.sqlDo(ctx, 'package.installedDevices', () =>
            this.store.installedDevices(displayNameLike(pkg.detectValue), { companies: scopeCompanies(ctx.scope), limit: DETAIL_LIMIT }),
          )
        : Promise.resolve([]),
      this.installedCount(ctx, [pkg]),
    ]);
    const qualifying = new Set(qualifyingSigners(pkg, rows).commandIds);
    const parse = (s: string | null) => {
      try {
        return s ? (JSON.parse(s) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    return {
      ...packageView(pkg, counts[0] ?? null),
      testResults: rows
        .filter((r) => r.ring === 'pilot' && inScope(ctx.scope, r.deviceCompany))
        .map((r) => {
          const res = parse(r.resultSummary);
          return {
            commandId: r.commandId,
            deviceId: r.deviceId,
            computerName: r.computerName,
            state: r.state,
            errorCode: r.errorCode,
            exitCode: typeof res?.exit_code === 'number' ? res.exit_code : null,
            signer: typeof res?.signer === 'string' ? res.signer : null,
            signerSubject: typeof res?.signer_subject === 'string' ? res.signer_subject : null,
            detected: typeof res?.detected === 'boolean' ? res.detected : null,
            /** 可作為 mark-tested 依據(快照與目前目錄一致) */
            qualifies: qualifying.has(r.commandId),
            createdByEmp: r.createdByEmp,
            finishedAt: r.finishedAt?.toISOString() ?? null,
          };
        }),
      installedDevices: installed.map(({ deviceRef: _ref, company: _c, ...d }) => d),
    };
  }

  /** draft → tested:pilot 測試機安裝成功且偵測通過;IT 填的簽章者必須是該次回報的實際簽章者(§3.2) */
  async markTested(ctx: MgmtCtx, who: GatewayIdentity, packageId: string, signerThumbprints: string[]): Promise<PackageView> {
    this.requireAll(ctx);
    const pkg = await this.found(ctx, packageId);
    if (pkg.status !== 'draft') throw new AppError(409, 'ITA_PACKAGE_STATUS', `此套件目前為 ${pkg.status},只有 draft 可標記測試完成`);
    const rows = await this.sqlDo(ctx, 'package.installResults', () => this.store.installResults(packageId, DETAIL_LIMIT));
    const q = qualifyingSigners(pkg, rows);
    if (q.commandIds.length === 0)
      throw new AppError(409, 'ITA_PACKAGE_NOT_TESTED', '尚無 pilot 測試機以目前的檔案與參數安裝成功(且偵測通過)的紀錄,請先派送到測試機');
    const signers = [...new Set(signerThumbprints.map((s) => s.toLowerCase()))];
    if (signers.length === 0 || signers.length > 8 || !signers.every((s) => SIGNER_RE.test(s)))
      throw new AppError(400, 'VALIDATION_FAILED', '簽章者指紋需 1–8 個 40 碼十六進位', [{ field: 'signerThumbprints', message: '格式不符' }]);
    const unknown = signers.filter((s) => !q.signers.includes(s));
    if (unknown.length)
      throw new AppError(
        409,
        'ITA_SIGNER_NOT_OBSERVED',
        '簽章者指紋必須是測試機回報的實際簽章者',
        unknown.map((s) => ({ field: 'signerThumbprints', message: `${s} 不在測試機回報的簽章者中` })),
      );
    const ok = await this.sqlDo(ctx, 'package.markTested', () => this.store.markTested(packageId, signers, q.signers, actorOf(who), this.now(), ctx.requestId));
    if (!ok) throw new AppError(409, 'ITA_PACKAGE_STATUS', '套件狀態已被變更,請重新整理');
    ctx.log.info({ packageId, signers, evidence: q.commandIds.slice(0, 5), emp: actorOf(who).emp }, '軟體套件測試完成');
    return this.view(ctx, packageId);
  }

  /** tested → published:第二人(published_by ≠ created_by,§9-4;≠ 最後修改安裝參數 / 偵測規則的人,D2-2) */
  async publish(ctx: MgmtCtx, who: GatewayIdentity, packageId: string): Promise<PackageView> {
    this.requireAll(ctx);
    const pkg = await this.found(ctx, packageId);
    if (pkg.status !== 'tested') throw new AppError(409, 'ITA_PACKAGE_STATUS', `此套件目前為 ${pkg.status},只有 tested 可發佈`);
    const actor = actorOf(who);
    if (actor.emp === pkg.createdByEmp) throw new AppError(403, 'ITA_REVIEWER_SAME_AS_CREATOR', '發佈人不可是登錄人,請由另一位 IT 覆核後發佈');
    if (actor.emp === pkg.argsChangedByEmp)
      throw new AppError(403, 'ITA_REVIEWER_SAME_AS_EDITOR', '發佈人不可是最後修改安裝參數 / 偵測規則的人,請由另一位 IT 覆核後發佈');
    const ok = await this.sqlDo(ctx, 'package.publish', () => this.store.publish(packageId, actor, this.now(), ctx.requestId));
    if (!ok) throw new AppError(409, 'ITA_PACKAGE_STATUS', '套件狀態已被變更,請重新整理');
    ctx.log.info({ packageId, name: pkg.name, version: pkg.version, createdBy: pkg.createdByEmp, argsChangedBy: pkg.argsChangedByEmp, publishedBy: actor.emp }, '發佈軟體套件');
    return this.view(ctx, packageId);
  }

  /** 撤回:不能再安裝;尚未送出的安裝指令取消(已送出的不受影響,下載會被拒) */
  async revoke(ctx: MgmtCtx, who: GatewayIdentity, packageId: string): Promise<PackageView & { canceledCommands: number }> {
    this.requireAll(ctx);
    const pkg = await this.found(ctx, packageId);
    if (pkg.status === 'revoked') throw new AppError(409, 'ITA_PACKAGE_STATUS', '此套件已撤回');
    const r = await this.sqlDo(ctx, 'package.revoke', () => this.store.revoke(packageId, actorOf(who), this.now(), ctx.requestId));
    if (!r.ok) throw new AppError(409, 'ITA_PACKAGE_STATUS', '套件狀態已被變更,請重新整理');
    ctx.log.warn({ packageId, name: pkg.name, version: pkg.version, canceledCommands: r.canceledCommands, emp: actorOf(who).emp }, '撤回軟體套件');
    return { ...(await this.view(ctx, packageId)), canceledCommands: r.canceledCommands };
  }

  /** 批次派送:建立 command_batch(> BATCH_APPROVAL_THRESHOLD 台需第二人核可,§6);檢查在 kindHooks */
  async deploy(ctx: MgmtCtx, who: GatewayIdentity, packageId: string, input: DeployInput, idempotencyKey?: string): Promise<CreateBatchResult> {
    const commands = this.commands();
    if (!commands) throw new AppError(503, 'ITA_COMMANDS_UNAVAILABLE', '指令通道未啟用');
    await this.found(ctx, packageId);
    const params: Record<string, unknown> = { packageId };
    if (input.action === 'install' && input.ignorePower) params.ignorePower = true;
    return commands.createBatch(
      ctx,
      who,
      'admin',
      input.deviceIds,
      { kind: input.action === 'install' ? 'software.install' : 'software.uninstall', params, idempotencyKey },
      { maxConcurrent: input.maxConcurrent },
    );
  }

  // ---------- software.install / software.uninstall 指令(CommandDispatcher 的 kindHooks) ----------

  /** 建立前檢查:套件狀態與裝置所屬環;回傳參數快照(取代 IT 送來的 packageId) */
  async checkCommand(ctx: Ctx, deviceRef: number, params: Record<string, unknown>, action: 'install' | 'uninstall'): Promise<Record<string, unknown>> {
    const pkg = await this.found(ctx, String(params.packageId).toLowerCase());
    const ring = pkg.status === 'published' || pkg.status === 'revoked' ? null : await this.sqlDo(ctx, 'device.ring', () => this.store.deviceRing(deviceRef));
    const denied = deployDenied(pkg, ring, action);
    if (denied) throw denied;
    // 目錄內的參數在登錄 / 修改時已驗;建立指令前再驗一次(資料庫被直接修改時擋下)
    const bad = action === 'install' ? argsErrors('installArgs', pkg.installArgs) : argsErrors('uninstallArgs', pkg.uninstallArgs);
    if (bad.length) {
      ctx.log.error({ packageId: pkg.packageId, bad }, '目錄內的安裝參數不符白名單,拒絕派送');
      throw new AppError(409, 'ITA_PACKAGE_INVALID', '套件的安裝參數不符規定,請修改後重新覆核');
    }
    if (action === 'install' && pkg.status !== 'draft' && pkg.signerThumbprints.length === 0)
      throw new AppError(409, 'ITA_PACKAGE_INVALID', '套件沒有預期簽章者');
    return action === 'install' ? installSnapshot(pkg, { ignorePower: params.ignorePower === true }) : uninstallSnapshot(pkg);
  }

  /** 授權數(§3.4):已發佈套件的安裝,已安裝數 + 本批新增台數(排除已安裝)> license_limit → 409。全公司計數,不受資料範圍限制 */
  async checkLicense(ctx: Ctx, deviceRefs: number[], params: Record<string, unknown>): Promise<void> {
    const pkg = await this.found(ctx, String(params.packageId).toLowerCase());
    if (pkg.licenseLimit === null || pkg.status !== 'published') return;
    if (pkg.detectType !== 'display_name') throw new AppError(409, 'ITA_LICENSE_UNCOUNTABLE', '此套件以 MSI 產品代碼偵測,無法計算授權數');
    const pattern = displayNameLike(pkg.detectValue);
    const [counts, hits] = await this.sqlDo(ctx, 'software.license', () =>
      Promise.all([this.store.installedCounts([pattern]), this.store.installedDevices(pattern, { onlyRefs: deviceRefs, limit: deviceRefs.length * 10 })]),
    );
    const installed = counts[0] ?? 0;
    const already = new Set(hits.map((h) => h.deviceRef));
    const adding = deviceRefs.filter((r) => !already.has(r)).length;
    if (installed + adding > pkg.licenseLimit)
      throw new AppError(409, 'ITA_LICENSE_EXCEEDED', `${pkg.name} 授權數 ${pkg.licenseLimit},已安裝 ${installed} 台,本次新增 ${adding} 台會超過`, [
        { field: 'deviceIds', message: `可再安裝 ${Math.max(0, pkg.licenseLimit - installed)} 台` },
      ]);
  }

  // ---------- 下載(agent-app GET /agent/v1/packages/:packageId) ----------

  async download(ctx: Ctx, device: DeviceRecord, packageId: string, range: string | undefined): Promise<Download> {
    const notFound = () => new AppError(404, 'ITA_PACKAGE_NOT_FOUND', '找不到此軟體套件');
    const id = packageId.toLowerCase();
    if (!UUID_RE.test(id)) throw notFound();
    const [pkg, active, ring] = await this.sqlDo(ctx, 'package.download', () =>
      Promise.all([this.store.getPackage(id), this.store.activeInstallPackages(device.id), this.store.deviceRing(device.id)]),
    );
    // 只給被指派(有尚未結束的此套件 software.install)的裝置;端點不能任意下載軟體庫的檔案
    if (!pkg || !active.includes(id) || deployDenied(pkg, ring, 'install')) {
      ctx.log.warn(
        { deviceId: device.deviceId, packageId: id, status: pkg?.status ?? 'missing', assigned: active.includes(id), ring },
        '下載的套件不是這台被指派的安裝,拒絕',
      );
      throw notFound();
    }
    const f = await this.files.resolve(pkg.fileName);
    if (!f) {
      ctx.log.error({ packageId: id, fileName: pkg.fileName }, '軟體庫找不到已登錄的安裝檔(掛載中斷或檔案被移走)');
      throw new AppError(503, 'ITA_PACKAGE_UNAVAILABLE', '安裝檔暫時無法讀取,請稍後重試');
    }
    const sha = await this.files.sha256(f);
    if (sha !== pkg.sha256 || f.size !== pkg.sizeBytes) {
      ctx.log.error({ packageId: id, fileName: pkg.fileName, expected: pkg.sha256, actual: sha }, '安裝檔內容與登錄不符,拒絕下發(需重新登錄新版本)');
      throw new AppError(503, 'ITA_PACKAGE_CHANGED', '安裝檔內容與登錄不符');
    }
    const r = parseRange(range, f.size);
    if (r === 'unsatisfiable') return { status: 416, headers: { 'content-range': `bytes */${f.size}` }, stream: null };
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes',
      // 僅供除錯,端點以指令快照的 sha256 驗證(§3.3)
      'x-file-sha256': pkg.sha256,
      'cache-control': 'no-store',
    };
    // 稽核:從第 0 位元組起的請求記一筆,同一台同一套件每小時最多一筆
    const key = `${device.id}:${id}`;
    const last = this.downloadLogged.get(key) ?? 0;
    if ((!r || r.start === 0) && Date.now() - last >= DOWNLOAD_EVENT_MS) {
      this.downloadLogged.set(key, Date.now());
      if (this.downloadLogged.size > 10_000) this.downloadLogged.clear();
      await this.sqlDo(ctx, 'event.add(package_download)', () =>
        this.devices.addEvent(device, 'package_download', `下載 ${pkg.name} ${pkg.version}(${id},${f.size} bytes)`, ctx.requestId),
      );
    }
    ctx.log.info({ deviceId: device.deviceId, packageId: id, start: r?.start ?? 0, end: r?.end ?? f.size - 1 }, '下載軟體套件');
    if (!r) return { status: 200, headers: { ...headers, 'content-length': String(f.size) }, stream: this.files.open(f.file) };
    return {
      status: 206,
      headers: { ...headers, 'content-length': String(r.end - r.start + 1), 'content-range': `bytes ${r.start}-${r.end}/${f.size}` },
      stream: this.files.open(f.file, r),
    };
  }
}
