/**
 * 版本檔目錄(P6-UPGRADE-DESIGN §4):RELEASES_DIR 底下 {component}/{version}/{檔名},唯讀掛載(正式 NAS RustIT\releases\,測試區主機 2 本機目錄)。
 *   - 路徑只由已驗證格式的三段組成,並確認實際位置(含符號連結)仍在根目錄內,防路徑穿越
 *   - SHA-256 以 (路徑, 大小, 修改時間) 快取,檔案被換掉時重新計算(登錄時寫入 SQL,下載前再比對)
 */
import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ReleaseComponent } from '../stores/types.js';

export const RELEASE_COMPONENTS: readonly ReleaseComponent[] = ['agent', 'watchdog'];
/** 版本號:x.y.z,可帶 -後綴(例:0.7.2-broken) */
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,20})?$/;
/** 檔名:不以 . 開頭(排除 . 與 ..) */
export const FILE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
/** 版本檔上限(exe 約 7–10 MB;留餘裕給之後的 desktop) */
export const RELEASE_FILE_MAX = 200 * 1024 * 1024;

export interface ResolvedFile {
  file: string;
  size: number;
  mtimeMs: number;
  /** 快取鍵:大小、修改時間、狀態變更時間、inode(內容被換掉時至少有一項改變) */
  key: string;
}

export interface ReleaseFileInfo {
  component: ReleaseComponent;
  version: string;
  fileName: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export class ReleaseFiles {
  private readonly hashes = new Map<string, { key: string; sha256: Promise<string> }>();

  constructor(private readonly root: string) {}

  /** 檔案的絕對路徑;格式不符、不在根目錄內、不是一般檔案回 null */
  async resolve(component: string, version: string, fileName: string): Promise<ResolvedFile | null> {
    if (!RELEASE_COMPONENTS.includes(component as ReleaseComponent) || !VERSION_RE.test(version) || !FILE_NAME_RE.test(fileName)) return null;
    try {
      const rootReal = await realpath(this.root);
      const real = await realpath(path.join(rootReal, component, version, fileName));
      if (!real.startsWith(rootReal + path.sep)) return null;
      const s = await stat(real);
      if (!s.isFile() || s.size <= 0 || s.size > RELEASE_FILE_MAX) return null;
      return { file: real, size: s.size, mtimeMs: s.mtimeMs, key: `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}` };
    } catch {
      return null;
    }
  }

  /** 同一檔案同時多個請求只算一次(計算中的 Promise 共用);失敗不快取 */
  sha256(file: ResolvedFile): Promise<string> {
    const cached = this.hashes.get(file.file);
    if (cached?.key === file.key) return cached.sha256;
    const sha256 = (async () => {
      const h = createHash('sha256');
      for await (const chunk of createReadStream(file.file)) h.update(chunk as Buffer);
      return h.digest('hex');
    })();
    this.hashes.set(file.file, { key: file.key, sha256 });
    sha256.catch(() => this.hashes.delete(file.file));
    return sha256;
  }

  open(file: string, range?: { start: number; end: number }): ReadStream {
    return createReadStream(file, range);
  }

  /** 目錄內所有符合格式的檔案(登錄畫面挑選用);目錄不存在回空 */
  async list(): Promise<ReleaseFileInfo[]> {
    const out: ReleaseFileInfo[] = [];
    for (const component of RELEASE_COMPONENTS) {
      const versions = await this.dirs(path.join(this.root, component));
      for (const version of versions.filter((v) => VERSION_RE.test(v))) {
        let names: string[];
        try {
          names = await readdir(path.join(this.root, component, version));
        } catch {
          continue;
        }
        for (const fileName of names.filter((n) => FILE_NAME_RE.test(n))) {
          const f = await this.resolve(component, version, fileName);
          if (f) out.push({ component, version, fileName, sizeBytes: f.size, modifiedAt: new Date(f.mtimeMs) });
        }
      }
    }
    return out;
  }

  private async dirs(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }
}

/** Range 標頭(只支援單一範圍 bytes=a-b、bytes=a-、bytes=-n);不支援或語法錯誤(a > b)回 undefined(整個檔案,RFC 9110 §14.2),起點超出檔案回 'unsatisfiable' */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  if (m[1] !== '' && m[2] !== '' && Number(m[1]) > Number(m[2])) return undefined;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}
