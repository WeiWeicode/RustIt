/**
 * 軟體派送(PLATFORM-PLAN P7 §4.6;P7-SOFTWARE-DESIGN §1–§4、§6):軟體目錄、狀態機與兩人覆核、派送前檢查(目錄快照)、授權數、套件下載。
 *   - 狀態機:draft →(pilot 測試機安裝成功、IT 確認簽章者)tested →(第二人)published → revoked;改安裝參數 / 偵測規則退回 draft
 *   - 覆核:published_by ≠ created_by(§9-4),也 ≠ 最後修改安裝參數 / 偵測規則的人(D2-2);tested_by 可以是建立人
 *   - 目錄是全公司共用:登錄 / 修改 / 測試完成 / 發佈 / 撤回需 endpoint.software.manage(BFF)且全部公司角色(§9-5)
 *   - draft / tested 只能派到 pilot 環的電腦(放進 / 移出 pilot 需全部公司角色,P6);revoked 不可再安裝(可移除)
 *   - software.install / software.uninstall 的 params 由這裡換成目錄快照(Agent 只信任快照,§2.2);授權數只檢查已發佈套件的安裝(§3.4)
 *   - 安裝參數字元白名單、不可指到其他檔案、不可含機密字樣(§2.3、§5.6);主機登錄、修改、建立指令時都驗
 *   - 下載只給「這台有尚未結束的此套件 software.install」的裝置;回應前複驗 SHA-256(§3.3),雜湊與內容讀同一個檔案代號(L4);
 *     同一台同時最多 DOWNLOADS_PER_DEVICE 條(L5)
 *   - 定期複驗(verifyFiles,M1):不符或找不到檔案時取消排隊中的安裝、開告警,之後新的安裝指令拒絕建立直到恢復一致
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
import { parseRange, type OpenedFile } from './rooted-files.js';
import { inScope, scopeCompanies, type MgmtCtx } from './scope.js';
import { extensionMatches, splitSoftwarePath, type SoftwareFileInfo, type SoftwareFiles } from './software-files.js';

export const INSTALLER_TYPES: readonly InstallerType[] = ['msi', 'inno', 'nsis', 'burn', 'exe'];
export const DETECT_TYPES: readonly DetectType[] = ['msi_product_code', 'display_name'];
export const REBOOT_POLICIES: readonly RebootPolicy[] = ['never', 'required'];
export const PACKAGE_STATUSES: readonly PackageStatus[] = ['draft', 'tested', 'published', 'revoked'];

/** 安裝 / 移除額外參數的字元白名單(§2.3):不含 & | ; < > ^ ` $ \ @ [ ] ~ ? 與換行;路徑用 /;( ) 只為 Program Files (x86);+ 為資料夾名稱(Notepad++) */
export const ARGS_RE = /^[A-Za-z0-9 /\-_=.:,"{}()+]*$/;
export const ARGS_MAX = 500;
/** 參數不可指到其他可執行檔、轉換檔、回應檔、設定檔(§2.3、D3) */
const ARGS_FILE = /\.(msi|msp|mst|exe|dll|bat|cmd|ps1|vbs|js|inf|iss|ini|xml|txt|log|reg|cfg|json)\b/i;
/**
 * 禁止的屬性(D3;資安稽核 H2):讀外部檔(轉換、修補、來源)、改變安裝方式(含 ACTION=ADMIN 等,P7-2 L2)、隱藏於「新增 / 移除程式」、
 * 繞過重開機政策(REBOOT*、Restart Manager 關閉程式;L2);以及名稱看起來是檔案或設定檔(*FILE、CONFIG*、INI*)
 */
const BANNED_PROPS =
  /^(TRANSFORMS|TRANSFORMSATSOURCE|TRANSFORMSSECURE|PATCH|MSIPATCHREMOVE|PATCHNEWPACKAGECODE|SOURCELIST|INSTALLSOURCE|SOURCEDIR|ADDSOURCE|ADVERTISE|MSINEWINSTANCE|MSIINSTANCEGUID|REINSTALL|REINSTALLMODE|ACTION|EXECUTEACTION|REBOOT.*|MSIRMSHUTDOWN|MSIRESTARTMANAGERCONTROL|MSIDISABLERMRESTART|MSILOGGINGMODE|LIMITUI|ARPSYSTEMCOMPONENT|ARPNOREMOVE|MSIINSTALLPERUSER|ROOTDRIVE|SETTINGS|XML|CONFIG.*|INI.*|.*FILE)$/i;
/**
 * 禁止的開關(去掉開頭的 / - --、比對 = 或 : 之前的名稱,不分大小寫;D3、H2):
 * 記錄 / 回應檔 / 設定檔(log、l*、loadinf、saveinf、f1、f2、r、config…)、轉交 msiexec(v)、另一個套件或修補(i、p、update、package、y、z、t、a、j、x)、
 * 改變動作(uninstall、repair、modify、layout)、Burn 內部參數(parent*、burn.*)、Inno 會跳視窗的 /SILENT、/PASSWORD、/DEBUGWND、/RESTARTEXITCODE、NSIS /NCRC、/INI
 */
const BANNED_SWITCH =
  /^(log|l[*!+voiwearucmpx]*|loadinf|saveinf|f1|f2|r|v|b|z|y|i|p|t|a|j.*|x|update|package|uninstall|repair|modify|layout|parent.*|burn\..*|config|configure|settings|response|unattend|answerfile|password|restartexitcode|debugwnd|silent|ncrc|ini)$/i;
/**
 * 重開機與強制關閉程式類開關(/forcerestart、/promptrestart、-reboot、/RESTARTAPPLICATIONS、/FORCECLOSEAPPLICATIONS…):
 * 重開機由 Agent 依 reboot_policy 處理,只允許 no 開頭的(/norestart、/NOCLOSEAPPLICATIONS;P7-2 L2)
 */
const RESTART_SWITCH = /^(?!no).*(restart|reboot|closeapplications)/i;
/** exe / burn / 未指定類型:名稱含這些字的開關多半是寫檔(記錄、輸出、傾印)或指定路徑,一律拒絕(/DIR、/D 由路徑規則處理) */
const WRITE_SWITCH = /(log|out|file|dump|trace|save|path|report)/i;
/** 屬性名稱 */
const PROP_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
/** 一個參數:名稱(不含引號與 =)+ 可選的 =值(值可用引號包住整個值) */
const ARGS_TOKEN = /([^\s"=]+)(?:=("[^"]*"|[^\s"]*))?(?=\s|$)/y;
/** 磁碟機路徑只允許 C:/Program Files/ 與 C:/Program Files (x86)/ 底下(D3) */
const ARGS_DRIVE_OK = /^[Cc]:\/Program Files( \(x86\))?\/[^:]*$/i;
const ARGS_GUID = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
const PATH_MSG = '路徑只允許 C:/Program Files/ 或 C:/Program Files (x86)/ 底下(路徑用 /,不可含 :、..)';

/** D3:值的檢查(路徑、UNC、{ }、( ));回傳錯誤訊息或 null */
function argsValueError(value: string): string | null {
  if (value === '') return null;
  if (value.includes('//')) return '不可使用網路路徑(UNC)';
  if (value.includes('..')) return '路徑不可含 ..';
  if (/[{}]/.test(value) && !ARGS_GUID.test(value)) return '{ } 只能用於 GUID(MSI 產品代碼)';
  if (/^[A-Za-z]:/.test(value)) return ARGS_DRIVE_OK.test(value) ? null : PATH_MSG;
  // 不是磁碟機路徑:不可含 / : ( )(根目錄、相對路徑、替代資料流)
  if (/[/:()]/.test(value)) return PATH_MSG;
  return null;
}

/** D3:依安裝程式類型檢查每個參數;回傳錯誤訊息或 null */
function argsGrammarError(v: string, installerType: InstallerType | undefined): string | null {
  let rest = v.trim();
  // NSIS 的 /D= 必須放最後、不可加引號,值可含空白
  if (installerType === 'nsis') {
    const m = /(^|\s)\/D=([^"]*)$/i.exec(rest);
    if (m) {
      // 值裡不可再夾開關(類型標錯時,不是 NSIS 的安裝程式會把它當成開關)
      if (/\s[/-]/.test(m[2]!)) return '/D= 的路徑裡不可再含 / 或 - 開頭的參數(/D= 必須放最後)';
      const err = argsValueError(m[2]!.trim());
      if (err) return err;
      rest = rest.slice(0, m.index).trim();
    }
  }
  let pos = 0;
  while (pos < rest.length) {
    if (rest[pos] === ' ') {
      pos++;
      continue;
    }
    ARGS_TOKEN.lastIndex = pos;
    const m = ARGS_TOKEN.exec(rest);
    if (!m) return '引號只能包住整個值(例如 NAME="C:/Program Files/App")';
    pos = ARGS_TOKEN.lastIndex;
    const name = m[1]!;
    const value = (m[2] ?? '').replace(/^"(.*)"$/, '$1');
    if (/^[/-]/.test(name)) {
      if (installerType === 'msi') return 'MSI 只接受「屬性=值」;/qn /norestart 與記錄檔由 Agent 加上';
      const sw = name.replace(/^(--|[/-])/, '');
      const swName = sw.split(':')[0]!;
      if (BANNED_SWITCH.test(swName)) return `不可使用 ${name}(會讀寫外部檔案、轉交其他安裝程式或改變安裝方式)`;
      if (RESTART_SWITCH.test(swName)) return `不可使用 ${name}(重開機由 Agent 依重開機政策處理,只允許 /norestart 這類)`;
      if (installerType !== 'inno' && installerType !== 'nsis' && WRITE_SWITCH.test(swName)) return `不可使用 ${name}(可能以 SYSTEM 寫檔)`;
      // /switch:value 的值同樣檢查
      const err = argsValueError(sw.includes(':') ? sw.slice(sw.indexOf(':') + 1) : '') ?? argsValueError(value);
      if (err) return err;
    } else if (m[2] !== undefined) {
      if (!PROP_NAME.test(name)) return `屬性名稱 ${name} 不正確`;
      if (BANNED_PROPS.test(name)) return `不可設定 ${name}(讀外部檔案、改變安裝方式或隱藏安裝)`;
      const err = argsValueError(value);
      if (err) return err;
    } else {
      if (installerType === 'msi') return 'MSI 只接受「屬性=值」';
      const err = argsValueError(name);
      if (err) return err;
    }
  }
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
/** 同一台同時下載上限(資安稽核 L5;Agent 依序執行,1 條 + 斷線後重試時上一條尚未關閉) */
export const DOWNLOADS_PER_DEVICE = 2;
/** 定期複驗發現不符時,最多在幾台(被取消安裝的裝置)開告警 */
const TAMPER_ALERT_MAX = 20;
/** 詳情顯示的測試結果 / 已安裝電腦筆數 */
const DETAIL_LIMIT = 200;

type Field = { field: string; message: string };

/** 純函式:安裝 / 移除參數的錯誤(通過回空陣列);installerType 省略時套用通用規則(Agent 端 P7-2 用同一份測試向量) */
export function argsErrors(field: string, v: string | null | undefined, installerType?: InstallerType): Field[] {
  if (v == null || v === '') return [];
  if (v.length > ARGS_MAX) return [{ field, message: `最多 ${ARGS_MAX} 字` }];
  if (!ARGS_RE.test(v)) return [{ field, message: '只允許英數字、空白與 / - _ = . : , " { } % ( ) +(不可含 & | ; < > ^ ` $ \\ @ [ ] 與換行;路徑請用 /)' }];
  if (ARGS_FILE.test(v)) return [{ field, message: '不可指到其他檔案(.msi / .exe / .mst / .dll / 指令檔 / 回應檔 / 設定檔)' }];
  const grammar = argsGrammarError(v, installerType);
  if (grammar) return [{ field, message: grammar }];
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
    // C1:從 published 撤回的移除參數經過覆核,可派所有電腦;draft / tested 撤回的只限 pilot
    if (action === 'uninstall') return pkg.revokedFrom === 'published' || ring === 'pilot' ? null : new AppError(409, 'ITA_PACKAGE_NOT_PUBLISHED', `${pkg.name} ${pkg.version} 未曾發佈就撤回,移除只能派送到 pilot 環的測試機`);
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

/** 純函式:指令的安裝快照與目前目錄一致(檔案、安裝參數、偵測規則、重開機政策) */
export function snapshotCurrent(pkg: PackageRecord, p: Record<string, unknown>): boolean {
  const d = p.detect as { type?: unknown; value?: unknown } | undefined;
  return (
    p.sha256 === pkg.sha256 &&
    (p.install_args ?? '') === (pkg.installArgs ?? '') &&
    d?.type === pkg.detectType &&
    d?.value === pkg.detectValue &&
    p.reboot_policy === pkg.rebootPolicy
  );
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
    // 偵測結果必須明確通過(L7)
    if (res.detected !== true) continue;
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
  editors: string[];
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
    editors: p.editors,
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
  /** 安裝檔與登錄雜湊不符時(D4 告警 software_file_tampered);例外由呼叫端自行處理 */
  onPackageTampered?: (ctx: Ctx, deviceRef: number, detail: Record<string, unknown>) => Promise<void>;
}

const actorOf = (who: GatewayIdentity): Actor => ({ emp: who.emp ?? who.sub, name: who.name ?? null });
/** 工號比對不分大小寫(與 SQL 預設定序一致,L2) */
const sameEmp = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toUpperCase() === b.toUpperCase();
const trimOrNull = (s: string | undefined | null) => (s == null ? null : s.trim() || null);

export class SoftwareService {
  private readonly now: () => Date;
  private readonly commands: () => CommandDispatcher | undefined;
  private readonly onPackageTampered: NonNullable<SoftwareServiceOptions['onPackageTampered']>;
  /** 下載稽核事件的最後記錄時間(裝置:套件 → 毫秒) */
  private readonly downloadLogged = new Map<string, number>();
  /** 進行中的下載數(裝置內部 id → 條數;L5) */
  private readonly downloading = new Map<number, number>();
  /** 安裝檔與登錄不符或找不到的套件(packageId → 原因);新的安裝指令拒絕建立,恢復一致時解除(M1;單一實例,重啟後由下一輪複驗重建) */
  private readonly fileChanged = new Map<string, 'changed' | 'missing'>();
  /** 定期複驗第一次找不到檔案的套件(連續兩輪才處理,避免掛載短暫中斷就取消排隊中的安裝) */
  private readonly missingSeen = new Set<string>();
  /** 取消排隊中的安裝失敗、下一輪要再試的套件 */
  private readonly cancelRetry = new Set<string>();
  private verifying = false;

  constructor(
    private readonly store: SoftwareStore,
    private readonly files: SoftwareFiles,
    private readonly devices: Pick<DeviceStore, 'addEvent'>,
    opts: SoftwareServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.commands = opts.commands ?? (() => undefined);
    this.onPackageTampered = opts.onPackageTampered ?? (() => Promise.resolve());
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
    const errors = [
      ...argsErrors('installArgs', f.installArgs, f.installerType),
      ...argsErrors('uninstallArgs', f.uninstallArgs, f.installerType), ...detectErrors(f.detectType, f.detectValue)];
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
    // 已安裝台數是前置萬用字元的 LIKE(無法用索引):清單只算已發佈的套件,其他看詳情(資安稽核 M6)
    const published = rows.filter((p) => p.status === 'published');
    const counts = await this.installedCount(ctx, published);
    const byId = new Map(published.map((p, i) => [p.packageId, counts[i] ?? null]));
    return { items: rows.map((p) => packageView(p, byId.get(p.packageId) ?? null)) };
  }

  /** 軟體庫內尚未登錄的安裝檔 */
  async unregisteredFiles(ctx: MgmtCtx): Promise<{ items: (Omit<SoftwareFileInfo, 'modifiedAt'> & { modifiedAt: string })[] }> {
    const [files, rows] = await Promise.all([this.files.list(), this.sqlDo(ctx, 'package.list', () => this.store.listPackages({}))]);
    const known = new Set(rows.map((r) => r.fileName.toLowerCase()));
    return { items: files.filter((f) => !known.has(f.fileName.toLowerCase())).map((f) => ({ ...f, modifiedAt: f.modifiedAt.toISOString() })) };
  }

  async register(ctx: MgmtCtx, who: GatewayIdentity, input: RegisterPackageInput): Promise<PackageView> {
    this.requireAll(ctx);
    // 名稱 / 版本會顯示在覆核畫面:不可含控制字元與雙向文字控制字元(資安稽核 L8)
    const plain = [['name', input.name], ['version', input.version]].filter(([, s]) => !DISPLAY_NAME_RE.test(s!));
    if (plain.length)
      throw new AppError(400, 'VALIDATION_FAILED', '名稱 / 版本不可含控制字元', plain.map(([field]) => ({ field: field!, message: '不可含控制字元或雙向文字控制字元' })));
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
      next.detectValue !== pkg.detectValue ||
      // 重開機政策在快照內,改了也要重新覆核(L1)
      (input.rebootPolicy !== undefined && input.rebootPolicy !== pkg.rebootPolicy);
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
    // 稽核:受覆核欄位的新舊值(目錄規定不得含機密,§5.6;資安稽核 M4)
    const changed = (['installArgs', 'uninstallArgs', 'detectType', 'detectValue', 'rebootPolicy', 'licenseLimit'] as const).filter(
      (k) => patch[k] !== undefined && patch[k] !== pkg[k],
    );
    ctx.log.info(
      {
        packageId,
        reviewed,
        revertedFrom: patch.revertToDraft ? pkg.status : undefined,
        emp: actorOf(who).emp,
        changes: Object.fromEntries(changed.map((k) => [k, { from: pkg[k], to: patch[k] }])),
      },
      '修改軟體套件',
    );
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
    // 覆核人必須是有工號的人(系統 client 不算第二人,L2)
    if (!who.emp) throw new AppError(403, 'ITA_REVIEWER_NOT_PERSON', '發佈需由有工號的 IT 人員執行');
    if (sameEmp(actor.emp, pkg.createdByEmp)) throw new AppError(403, 'ITA_REVIEWER_SAME_AS_CREATOR', '發佈人不可是登錄人,請由另一位 IT 覆核後發佈');
    if (pkg.editors.some((e) => sameEmp(e, actor.emp)))
      throw new AppError(403, 'ITA_REVIEWER_SAME_AS_EDITOR', '發佈人不可是上次發佈以來修改過安裝參數 / 偵測規則 / 重開機政策的人,請由另一位 IT 覆核後發佈');
    const ok = await this.sqlDo(ctx, 'package.publish', () => this.store.publish(packageId, actor, this.now(), ctx.requestId));
    if (!ok) throw new AppError(409, 'ITA_PACKAGE_STATUS', '套件狀態已被變更,請重新整理');
    ctx.log.info({ packageId, name: pkg.name, version: pkg.version, createdBy: pkg.createdByEmp, editors: pkg.editors, publishedBy: actor.emp }, '發佈軟體套件');
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
    const reviewed = pkg.status === 'published' || (pkg.status === 'revoked' && pkg.revokedFrom === 'published');
    const ring = reviewed ? null : await this.sqlDo(ctx, 'device.ring', () => this.store.deviceRing(deviceRef));
    const denied = deployDenied(pkg, ring, action);
    if (denied) throw denied;
    // 未經覆核的套件派到測試機:路由只能掛 endpoint.command.admin,另要求全部公司角色(與目錄管理同一群人;資安稽核 M5)
    if (!reviewed && !(ctx as Partial<MgmtCtx>).scope?.all)
      throw new AppError(403, 'ITA_SCOPE_ALL_REQUIRED', '尚未發佈的套件只能由可管理所有公司的角色派送到測試機');
    // 目錄內的參數在登錄 / 修改時已驗;建立指令前再驗一次(資料庫被直接修改時擋下)
    const bad = action === 'install' ? argsErrors('installArgs', pkg.installArgs, pkg.installerType) : argsErrors('uninstallArgs', pkg.uninstallArgs, pkg.installerType);
    if (bad.length) {
      ctx.log.error({ packageId: pkg.packageId, bad }, '目錄內的安裝參數不符白名單,拒絕派送');
      throw new AppError(409, 'ITA_PACKAGE_INVALID', '套件的安裝參數不符規定,請修改後重新覆核');
    }
    if (action === 'install' && pkg.status !== 'draft' && pkg.signerThumbprints.length === 0)
      throw new AppError(409, 'ITA_PACKAGE_INVALID', '套件沒有預期簽章者');
    const changed = action === 'install' ? this.fileChanged.get(pkg.packageId) : undefined;
    if (changed)
      throw new AppError(
        409,
        'ITA_PACKAGE_CHANGED',
        changed === 'missing' ? '軟體庫找不到此套件的安裝檔,請確認檔案或重新登錄' : '安裝檔內容與登錄不符,請重新登錄新版本',
      );
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
      // 不回全公司已安裝台數(資料範圍受限的使用者也會看到,資安稽核 L6)
      throw new AppError(409, 'ITA_LICENSE_EXCEEDED', `${pkg.name} 授權數 ${pkg.licenseLimit},本次新增 ${adding} 台會超過`, [
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
    // 只給被指派(有尚未結束的此套件 software.install)的裝置;端點不能任意下載軟體庫的檔案。
    // 指令快照必須與目前目錄一致:套件改過參數(退回 draft 再發佈)之前送出的舊快照不給(資安稽核 M2)
    const assigned = active.some((a) => a.packageId === id);
    const current = !!pkg && active.some((a) => a.packageId === id && snapshotCurrent(pkg, a.params));
    if (!pkg || !current || deployDenied(pkg, ring, 'install')) {
      ctx.log.warn(
        { deviceId: device.deviceId, packageId: id, status: pkg?.status ?? 'missing', assigned, current, ring },
        '下載的套件不是這台被指派的安裝,拒絕',
      );
      throw notFound();
    }
    const f = await this.files.resolve(pkg.fileName);
    if (!f) {
      ctx.log.error({ packageId: id, fileName: pkg.fileName }, '軟體庫找不到已登錄的安裝檔(掛載中斷或檔案被移走)');
      throw new AppError(503, 'ITA_PACKAGE_UNAVAILABLE', '安裝檔暫時無法讀取,請稍後重試');
    }
    // 單台同時下載上限(資安稽核 L5):Agent 依序執行軟體指令,正常只有一條;超過回 429 讓 Agent 稍後重試
    // 檢查後立即預留名額(之後有 await,同時進來的請求才不會都通過檢查);沒有交出串流的路徑都歸還,串流交出後由 close 歸還
    const busy = this.downloading.get(device.id) ?? 0;
    if (busy >= DOWNLOADS_PER_DEVICE) {
      ctx.log.warn({ deviceId: device.deviceId, packageId: id, busy }, '同一台同時下載超過上限,拒絕');
      throw new AppError(429, 'ITA_DOWNLOAD_BUSY', '此電腦已有下載進行中,請稍後重試');
    }
    this.downloading.set(device.id, busy + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.downloading.get(device.id) ?? 1) - 1;
      if (n > 0) this.downloading.set(device.id, n);
      else this.downloading.delete(device.id);
    };
    let opened: OpenedFile | undefined;
    try {
      // 雜湊與回應內容讀同一個檔案代號(L4)
      opened = await this.files.openChecked(f);
      const d = await this.serve(ctx, device, pkg, opened, f.size, range);
      if (d.stream) d.stream.once('close', release);
      else {
        await opened.close();
        release();
      }
      return d;
    } catch (err) {
      await opened?.close();
      release();
      throw err;
    }
  }

  /** download 的後半:複驗雜湊、Range、稽核事件、串流(名額與檔案代號由呼叫端處理) */
  private async serve(ctx: Ctx, device: DeviceRecord, pkg: PackageRecord, opened: OpenedFile, size: number, range: string | undefined): Promise<Download> {
    const id = pkg.packageId;
    const f = { size };
    const sha = await opened.sha256();
    if (sha !== pkg.sha256 || f.size !== pkg.sizeBytes) {
      await this.packageFileChanged(ctx, pkg, { actualSha256: sha, actualSize: f.size }, device.id);
      throw new AppError(503, 'ITA_PACKAGE_CHANGED', '安裝檔內容與登錄不符');
    }
    this.fileChanged.delete(id);
    this.missingSeen.delete(id);
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
    const stream = opened.stream(r);
    if (!r) return { status: 200, headers: { ...headers, 'content-length': String(f.size) }, stream };
    return {
      status: 206,
      headers: { ...headers, 'content-length': String(r.end - r.start + 1), 'content-range': `bytes ${r.start}-${r.end}/${f.size}` },
      stream,
    };
  }

  /**
   * 安裝檔與登錄不符(下載時複驗或定期複驗,M1):記住此套件(新的安裝指令拒絕建立)、取消尚未送出的安裝,
   * 在要求下載的裝置(定期複驗時為被取消安裝的裝置,最多 TAMPER_ALERT_MAX 台)開 software_file_tampered 告警。
   * 告警必須綁裝置:定期複驗時沒有排隊中的安裝就只記 error 日誌(新的安裝指令一律 409,不會有裝置下載到被換的檔案)。
   * 取消失敗時記入 cancelRetry,下一輪定期複驗再處理
   */
  private async packageFileChanged(
    ctx: Ctx,
    pkg: PackageRecord,
    actual: { actualSha256: string | null; actualSize: number | null },
    deviceRef?: number,
  ): Promise<void> {
    const id = pkg.packageId;
    this.fileChanged.set(id, actual.actualSha256 === null ? 'missing' : 'changed');
    ctx.log.error(
      { packageId: id, fileName: pkg.fileName, expected: pkg.sha256, actual: actual.actualSha256, expectedSize: pkg.sizeBytes, actualSize: actual.actualSize },
      actual.actualSha256 === null ? '軟體庫找不到已登錄的安裝檔' : '安裝檔內容與登錄不符,拒絕下發(需重新登錄新版本)',
    );
    // 其餘尚未送出的安裝一併取消(會一台一台下載失敗),需重新登錄新版本(M1)
    const canceled = await this.store.cancelQueuedInstalls(id, 'PACKAGE_FILE_CHANGED', this.now()).then(
      (refs) => {
        this.cancelRetry.delete(id);
        return refs;
      },
      (err: unknown) => {
        ctx.log.warn({ err, packageId: id }, '取消此套件排隊中的安裝失敗,下一輪定期複驗再試');
        this.cancelRetry.add(id);
        return [] as number[];
      },
    );
    const detail = {
      canceledCommands: canceled.length,
      packageId: id,
      name: pkg.name,
      version: pkg.version,
      fileName: pkg.fileName,
      expectedSha256: pkg.sha256,
      expectedSize: pkg.sizeBytes,
      ...actual,
    };
    const targets = deviceRef !== undefined ? [deviceRef] : [...new Set(canceled)].slice(0, TAMPER_ALERT_MAX);
    for (const ref of targets) await this.onPackageTampered(ctx, ref, detail);
    // 取消的指令可能屬於批次:由指令派送器的每分鐘掃描收尾(finishIdleBatches)
  }

  /**
   * 定期複驗軟體庫(資安稽核 M1):未撤回的套件逐一重新計算 SHA-256(不用快取),不符或找不到檔案時同下載複驗的處理;
   * 恢復一致時解除。同一時間只跑一輪;回傳檢查與不符的套件數。
   * 掛載中斷時根目錄可能看起來是空的:軟體庫一個檔案都沒有就整輪略過;找不到檔案要連續兩輪才處理
   */
  async verifyFiles(ctx: Ctx): Promise<{ checked: number; changed: number }> {
    const result = { checked: 0, changed: 0 };
    if (this.verifying) return result;
    this.verifying = true;
    try {
      const pkgs = (await this.store.listPackages({})).filter((p) => p.status !== 'revoked');
      if (pkgs.length && (await this.files.list()).length === 0) {
        ctx.log.warn({ packages: pkgs.length, root: this.files.root }, '軟體庫沒有任何檔案(掛載中斷?),這一輪定期複驗略過');
        return result;
      }
      for (const pkg of pkgs) {
        const id = pkg.packageId;
        result.checked++;
        try {
          const f = await this.files.resolve(pkg.fileName);
          const sha = f ? await this.files.sha256Fresh(f) : null;
          if (f && sha === pkg.sha256 && f.size === pkg.sizeBytes) {
            this.missingSeen.delete(id);
            this.cancelRetry.delete(id);
            if (this.fileChanged.delete(id)) ctx.log.info({ packageId: id }, '安裝檔已恢復與登錄一致');
            continue;
          }
          result.changed++;
          if (!f && !this.fileChanged.has(id) && !this.missingSeen.has(id)) {
            this.missingSeen.add(id);
            ctx.log.warn({ packageId: id, fileName: pkg.fileName }, '軟體庫找不到已登錄的安裝檔,下一輪仍找不到才處理');
            continue;
          }
          // 已知不符的不重複取消與開告警(上一次取消失敗的再試)
          if (!this.fileChanged.has(id) || this.cancelRetry.has(id))
            await this.packageFileChanged(ctx, pkg, { actualSha256: sha, actualSize: f?.size ?? null });
        } catch (err) {
          // 掛載中斷等(503):這一輪略過,不當成被竄改
          ctx.log.warn({ err, packageId: id }, '定期複驗安裝檔失敗,下次再試');
        }
      }
      // 已撤回或刪除的套件不再追蹤
      const live = new Set(pkgs.map((p) => p.packageId));
      for (const m of [this.fileChanged, this.missingSeen, this.cancelRetry]) for (const k of m.keys()) if (!live.has(k)) m.delete(k);
      ctx.log.info(result, '軟體庫定期複驗完成');
    } catch (err) {
      ctx.log.warn({ err }, '軟體庫定期複驗失敗,下次再試');
    } finally {
      this.verifying = false;
    }
    return result;
  }
}
