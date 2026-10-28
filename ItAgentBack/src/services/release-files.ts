/**
 * 版本檔目錄(P6-UPGRADE-DESIGN §4):RELEASES_DIR 底下 {component}/{version}/{檔名},唯讀掛載(NAS 測試 / 正式分開:測試區 RustIT\test\releases\、正式區 RustIT\prod\releases\)。
 *   - 路徑只由已驗證格式的三段組成,並確認實際位置(含符號連結)仍在根目錄內,防路徑穿越
 *   - SHA-256 以 (路徑, 大小, 修改時間) 快取,檔案被換掉時重新計算(登錄時寫入 SQL,下載前再比對)
 * 路徑檢查、雜湊快取與 Range 解析與軟體庫共用(rooted-files.ts,P7)。
 */
import path from 'node:path';
import type { ReleaseComponent } from '../stores/types.js';
import { RootedFiles, type ResolvedFile } from './rooted-files.js';

export { parseRange, type ResolvedFile } from './rooted-files.js';

export const RELEASE_COMPONENTS: readonly ReleaseComponent[] = ['agent', 'watchdog'];
/** 版本號:x.y.z,可帶 -後綴(例:0.7.2-broken) */
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,20})?$/;
/** 檔名:不以 . 開頭(排除 . 與 ..) */
export const FILE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
/** 版本檔上限(exe 約 7–10 MB;留餘裕給之後的 desktop) */
export const RELEASE_FILE_MAX = 200 * 1024 * 1024;

export interface ReleaseFileInfo {
  component: ReleaseComponent;
  version: string;
  fileName: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export class ReleaseFiles extends RootedFiles {
  /** 檔案的絕對路徑;格式不符、不在根目錄內、不是一般檔案回 null */
  async resolve(component: string, version: string, fileName: string): Promise<ResolvedFile | null> {
    if (!RELEASE_COMPONENTS.includes(component as ReleaseComponent) || !VERSION_RE.test(version) || !FILE_NAME_RE.test(fileName)) return null;
    return this.resolveSegments([component, version, fileName], RELEASE_FILE_MAX);
  }

  /** 目錄內所有符合格式的檔案(登錄畫面挑選用);目錄不存在回空 */
  async list(): Promise<ReleaseFileInfo[]> {
    const out: ReleaseFileInfo[] = [];
    for (const component of RELEASE_COMPONENTS) {
      const versions = await this.dirs(path.join(this.root, component));
      for (const version of versions.filter((v) => VERSION_RE.test(v))) {
        for (const fileName of (await this.names(path.join(this.root, component, version))).filter((n) => FILE_NAME_RE.test(n))) {
          const f = await this.resolve(component, version, fileName);
          if (f) out.push({ component, version, fileName, sizeBytes: f.size, modifiedAt: new Date(f.mtimeMs) });
        }
      }
    }
    return out;
  }
}
