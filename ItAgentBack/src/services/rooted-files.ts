/**
 * 唯讀檔案目錄的共用部分(P6 版本檔目錄 release-files.ts、P7 軟體庫 software-files.ts):
 *   - 路徑由呼叫端以已驗證格式的各段組成,這裡再以 realpath 確認實際位置(含符號連結)仍在根目錄內,防路徑穿越
 *   - SHA-256 以 (路徑, 大小, 修改時間, 狀態變更時間, inode) 快取,檔案被換掉時重新計算;同一檔案同時多個請求只算一次
 *   - Range 標頭解析(單一範圍)
 *   - 檔案或目錄不存在視為「沒有」;其他錯誤(權限、NAS 掛載中斷)回 503 ITA_FILES_UNAVAILABLE,不當成不存在(AGENT.md §5)
 */
import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';

export interface ResolvedFile {
  file: string;
  size: number;
  mtimeMs: number;
  /** 快取鍵:大小、修改時間、狀態變更時間、inode(內容被換掉時至少有一項改變) */
  key: string;
}

/** 不存在(含路徑中間是檔案)視為沒有;其他錯誤丟 503 */
function missingOrThrow(err: unknown): null {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return null;
  throw new AppError(503, 'ITA_FILES_UNAVAILABLE', `檔案目錄暫時無法讀取(${code ?? 'unknown'}),請稍後重試`);
}

export class RootedFiles {
  private readonly hashes = new Map<string, { key: string; sha256: Promise<string> }>();

  constructor(readonly root: string) {}

  /** 根目錄下 segments 組成的檔案;不在根目錄內、不是一般檔案、大小為 0 或超過 maxBytes 回 null。segments 的格式由呼叫端先驗證 */
  protected async resolveSegments(segments: string[], maxBytes: number): Promise<ResolvedFile | null> {
    try {
      const rootReal = await realpath(this.root);
      const real = await realpath(path.join(rootReal, ...segments));
      if (!real.startsWith(rootReal + path.sep)) return null;
      const s = await stat(real);
      if (!s.isFile() || s.size <= 0 || s.size > maxBytes) return null;
      return { file: real, size: s.size, mtimeMs: s.mtimeMs, key: `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}` };
    } catch (err) {
      return missingOrThrow(err);
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

  /** 子目錄名稱;目錄不存在回空 */
  protected async dirs(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      return missingOrThrow(err) ?? [];
    }
  }

  /** 目錄內的名稱;目錄不存在回空 */
  protected async names(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch (err) {
      return missingOrThrow(err) ?? [];
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
