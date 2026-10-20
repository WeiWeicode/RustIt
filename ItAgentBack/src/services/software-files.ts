/**
 * 軟體庫(P7-SOFTWARE-DESIGN §4):SOFTWARE_DIR 底下 {軟體}/{版本}/{安裝檔},唯讀掛載(正式 NAS RustIT\software\,測試區主機 2 /srv/giganexus/ita-software/)。
 *   - 相對路徑固定三段,每段只允許 [A-Za-z0-9._ +-]、不以 . 開頭、不以 . 或空白結尾(排除 . / ..、Windows 會截掉的結尾);
 *     IT 輸入的 \ 視同 /。實際位置(含符號連結)必須在根目錄內(rooted-files.ts,與 P6 版本檔目錄共用)
 *   - 安裝檔副檔名:.msi(installer_type = msi)或 .exe(其他類型);大小上限 SOFTWARE_MAX_BYTES
 *   - SHA-256 登錄時計算寫入 SQL,下載前再比對(快取鍵含 ctime、inode)
 * 設計 §1 的白名單沒有 +,但範例目錄 Notepad++ 需要;+ 不是路徑或 shell 的特殊字元,一併允許(§8.1)。
 */
import path from 'node:path';
import type { InstallerType } from '../stores/types.js';
import { RootedFiles, type ResolvedFile } from './rooted-files.js';

/** 一段路徑:1–100 字,不以 . 開頭,不以 . 或空白結尾 */
export const SEGMENT_RE = /^(?:[A-Za-z0-9_+-]|[A-Za-z0-9_+-][A-Za-z0-9._ +-]{0,98}[A-Za-z0-9_+-])$/;
/** 安裝檔副檔名 */
export const INSTALLER_EXT = /\.(msi|exe)$/i;
/** SOFTWARE_MAX_BYTES 預設 4 GB */
export const SOFTWARE_DEFAULT_MAX_BYTES = 4 * 1024 ** 3;

export interface SoftwareFileInfo {
  /** {軟體}/{版本}/{檔名} */
  fileName: string;
  software: string;
  version: string;
  sizeBytes: number;
  modifiedAt: Date;
}

/** 正規化並驗證相對路徑;回傳三段或 null(\ 視同 /) */
export function splitSoftwarePath(fileName: string): [string, string, string] | null {
  if (fileName.length > 260) return null;
  const parts = fileName.replace(/\\/g, '/').split('/');
  if (parts.length !== 3 || !parts.every((p) => SEGMENT_RE.test(p)) || !INSTALLER_EXT.test(parts[2]!)) return null;
  return parts as [string, string, string];
}

/** installer_type 與副檔名相符:msi ↔ .msi,其他 ↔ .exe */
export function extensionMatches(installerType: InstallerType, fileName: string): boolean {
  const msi = /\.msi$/i.test(fileName);
  return installerType === 'msi' ? msi : /\.exe$/i.test(fileName);
}

export class SoftwareFiles extends RootedFiles {
  constructor(
    root: string,
    readonly maxBytes = SOFTWARE_DEFAULT_MAX_BYTES,
  ) {
    super(root);
  }

  /** 格式不符、不在根目錄內、不是一般檔案、超過大小上限回 null */
  async resolve(fileName: string): Promise<ResolvedFile | null> {
    const parts = splitSoftwarePath(fileName);
    return parts ? this.resolveSegments(parts, this.maxBytes) : null;
  }

  /** 軟體庫內所有符合格式的安裝檔(登錄畫面挑選用);目錄不存在回空 */
  async list(): Promise<SoftwareFileInfo[]> {
    const out: SoftwareFileInfo[] = [];
    for (const software of (await this.dirs(this.root)).filter((s) => SEGMENT_RE.test(s))) {
      for (const version of (await this.dirs(path.join(this.root, software))).filter((v) => SEGMENT_RE.test(v))) {
        for (const name of await this.names(path.join(this.root, software, version))) {
          const fileName = `${software}/${version}/${name}`;
          if (!splitSoftwarePath(fileName)) continue;
          const f = await this.resolve(fileName);
          if (f) out.push({ fileName, software, version, sizeBytes: f.size, modifiedAt: new Date(f.mtimeMs) });
        }
      }
    }
    return out;
  }
}
