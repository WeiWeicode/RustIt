/**
 * 上傳與送簽的檔案目錄(S1-3;S1-SIGNING-DESIGN §1、§4):兩個目錄都是 endpoint-server 唯一可寫的 NAS 位置,軟體庫 software\ 仍唯讀。
 *   - incoming\:原始安裝檔 {軟體}/{版本}/{檔名}(路徑規則與軟體庫相同,SoftwareFiles 讀取);串流上傳寫到同目錄的 .{檔名}.part-{uuid},
 *     收完、大小與雜湊確定後才改名,目的地已存在就拒絕(不覆蓋)
 *   - sign-queue\:送簽工作單 {uploadId}.json(sign-job/1)與工作站結果 {uploadId}.result.json(sign-result/1);
 *     工作單先寫暫存檔再改名(工作站不會讀到寫一半的檔案),已存在就拒絕
 * 安全判斷不採信 sign-queue 的結果檔:主機以軟體庫實際檔案重算雜湊(upload-service.ts)。
 * 刪除 incoming\ 的檔案(deleteIncoming,§4.4):只刪一般檔案,不跟隨符號連結;啟動時檢查兩個目錄可寫(assertWritableDir)。
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream, type WriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { AppError } from '../errors.js';
import { splitSoftwarePath } from './software-files.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 結果檔大小上限(防止工作站以外的人放大檔案拖垮掃描) */
const RESULT_MAX_BYTES = 64 * 1024;

// 原始錯誤放在 cause,供呼叫端記錄日誌(syscall、path、errno)
const unavailable = (err: unknown) =>
  Object.assign(new AppError(503, 'ITA_FILES_UNAVAILABLE', `上傳目錄暫時無法寫入(${(err as NodeJS.ErrnoException).code ?? 'unknown'}),請稍後重試`), { cause: err });

/** 實際位置必須在根目錄內(含符號連結);dir 不存在時建立 */
async function ensureInside(root: string, dir: string): Promise<string> {
  const rootReal = await realpath(root);
  await mkdir(dir, { recursive: true });
  const real = await realpath(dir);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new AppError(400, 'VALIDATION_FAILED', '路徑不在上傳目錄內');
  return real;
}

/** 上傳閒置(沒有收到資料)超過這個時間就中止(資安審查 M3:慢速上傳佔住連線與 NAS 檔案代號) */
export const UPLOAD_IDLE_MS = 120_000;

/**
 * 串流寫入 incoming\{軟體}/{版本}/{檔名}:超過 maxBytes 中止(413)、閒置超過 idleMs 中止(408);目的地已存在回 409 ITA_UPLOAD_FILE_EXISTS。
 * 同一路徑同時上傳時,改名前的再確認與改名之間仍有空窗(rename 會覆蓋;資安審查 L1):核可前會重算雜湊,換掉的檔案不會被簽
 */
export async function receiveIncoming(
  root: string,
  fileName: string,
  body: Readable,
  maxBytes: number,
  idleMs = UPLOAD_IDLE_MS,
): Promise<{ fileName: string; sha256: string; size: number }> {
  const parts = splitSoftwarePath(fileName);
  if (!parts) throw new AppError(400, 'VALIDATION_FAILED', '路徑需為 {軟體}/{版本}/{安裝檔}(.msi / .exe),每段只接受英數與 . _ 空白 + -');
  const normalized = parts.join('/');
  let dir: string;
  try {
    dir = await ensureInside(root, path.join(root, parts[0], parts[1]));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unavailable(err);
  }
  const dest = path.join(dir, parts[2]);
  if (await exists(dest)) throw new AppError(409, 'ITA_UPLOAD_FILE_EXISTS', `incoming 已有 ${normalized}(不覆蓋)`);
  const tmp = path.join(dir, `.${parts[2]}.part-${randomUUID()}`);
  const hash = createHash('sha256');
  let size = 0;
  let out: WriteStream | undefined;
  let idle: NodeJS.Timeout | undefined;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => body.destroy(new AppError(408, 'ITA_UPLOAD_TIMEOUT', `上傳閒置超過 ${idleMs / 1000} 秒,已中止`)), idleMs);
  };
  try {
    out = createWriteStream(tmp, { flags: 'wx' });
    kick();
    await pipeline(
      body,
      async function* (src) {
        for await (const chunk of src) {
          kick();
          const b = chunk as Buffer;
          size += b.length;
          if (size > maxBytes) throw new AppError(413, 'ITA_UPLOAD_TOO_LARGE', `安裝檔超過上限 ${maxBytes} 位元組`);
          hash.update(b);
          yield b;
        }
      },
      out,
    );
    if (size === 0) throw new AppError(400, 'VALIDATION_FAILED', '安裝檔是空的');
    // rename 會覆蓋:放置前再確認一次;兩個請求同時放同一路徑時,後放的會被 SQL 唯一索引(進行中的上傳)擋下,且核可前會重算雜湊
    if (await exists(dest)) throw new AppError(409, 'ITA_UPLOAD_FILE_EXISTS', `incoming 已有 ${normalized}(不覆蓋)`);
    await rename(tmp, dest);
  } catch (err) {
    clearTimeout(idle);
    // 等檔案代號關閉再刪除(Windows 不能刪除開啟中的檔案)
    if (out && !out.closed) await finished(out).catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    if (err instanceof AppError) throw err;
    // 用戶端中斷(上傳到一半關掉畫面)
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') throw new AppError(400, 'ITA_UPLOAD_ABORTED', '上傳中斷');
    throw unavailable(err);
  }
  clearTimeout(idle);
  return { fileName: normalized, sha256: hash.digest('hex'), size };
}

/** 刪除 incoming 內剛放好的檔案(建立上傳紀錄失敗時,資安審查 M3);失敗只回 false */
export async function removeIncoming(root: string, fileName: string): Promise<boolean> {
  const parts = splitSoftwarePath(fileName);
  if (!parts) return false;
  try {
    const rootReal = await realpath(root);
    const real = await realpath(path.join(rootReal, ...parts));
    if (!real.startsWith(rootReal + path.sep)) return false;
    await unlink(real);
    return true;
  } catch {
    return false;
  }
}

/** 中斷的上傳留下的暫存檔閒置超過這個時間才刪(進行中的上傳每收到資料就更新修改時間,閒置 UPLOAD_IDLE_MS 就中止) */
export const STALE_PART_MS = 10 * 60_000;

/**
 * 刪除 incoming\{軟體}/{版本}/{檔名}(S1-SIGNING-DESIGN §4.4):資料夾以 realpath 確認在根目錄內;檔案本身以 lstat 確認是一般檔案
 * (符號連結、資料夾回 409 ITA_UPLOAD_NOT_FILE,不跟隨),刪除前再 realpath 一次確認路徑沒被換掉(資安審查 L2,縮小空窗);
 * expectSize 指定時大小不同回 409 ITA_UPLOAD_FILE_MISMATCH(資安審查 L4:不是那筆上傳的檔案)。
 * 同資料夾同檔名、閒置超過 STALE_PART_MS 的上傳暫存檔盡力刪除(失敗不影響結果,L5)。
 * 檔案不存在回 deleted: false;不建立資料夾、不刪空資料夾(避免與同時進行的上傳互相影響)
 */
export async function deleteIncoming(
  root: string,
  fileName: string,
  opts: { expectSize?: number; now?: number } = {},
): Promise<{ fileName: string; deleted: boolean; sizeBytes: number | null; partsRemoved: number }> {
  const now = opts.now ?? Date.now();
  const parts = splitSoftwarePath(fileName);
  if (!parts) throw new AppError(400, 'VALIDATION_FAILED', '路徑需為 {軟體}/{版本}/{安裝檔}(.msi / .exe),每段只接受英數與 . _ 空白 + -');
  const normalized = parts.join('/');
  let dir: string;
  try {
    const rootReal = await realpath(root);
    dir = await realpath(path.join(rootReal, parts[0], parts[1]));
    if (!dir.startsWith(rootReal + path.sep)) throw new AppError(400, 'VALIDATION_FAILED', '路徑不在上傳目錄內');
  } catch (err) {
    if (err instanceof AppError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { fileName: normalized, deleted: false, sizeBytes: null, partsRemoved: 0 };
    throw unavailable(err);
  }
  let deleted = false;
  let sizeBytes: number | null = null;
  const file = path.join(dir, parts[2]);
  try {
    const s = await lstat(file);
    if (!s.isFile()) throw new AppError(409, 'ITA_UPLOAD_NOT_FILE', `incoming 的 ${normalized} 不是一般檔案(符號連結或資料夾),請由管理員處理`);
    if (opts.expectSize !== undefined && s.size !== opts.expectSize)
      throw new AppError(409, 'ITA_UPLOAD_FILE_MISMATCH', `incoming 的 ${normalized} 與這筆上傳的大小不同(可能是之後放進來的檔案),請從上傳區清單刪除`);
    if ((await realpath(file)) !== file) throw new AppError(409, 'ITA_UPLOAD_NOT_FILE', `incoming 的 ${normalized} 路徑已改變,請重新整理後再試`);
    await unlink(file);
    deleted = true;
    sizeBytes = s.size;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(err);
  }
  let partsRemoved = 0;
  const prefix = `.${parts[2]}.part-`;
  // 暫存檔清理是附帶的:讀不到資料夾不影響主檔結果(主檔已刪,回錯會讓刪除紀錄寫不進去,L5)
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(prefix) || !UUID_RE.test(name.slice(prefix.length))) continue;
    const part = path.join(dir, name);
    // 單一暫存檔刪不掉(上傳剛好結束改名、權限)不影響主檔的結果
    const s = await lstat(part).catch(() => null);
    if (!s?.isFile() || now - s.mtimeMs <= STALE_PART_MS) continue;
    if (await unlink(part).then(() => true).catch(() => false)) partsRemoved++;
  }
  return { fileName: normalized, deleted, sizeBytes, partsRemoved };
}

/** 啟動檢查(INCOMING_DIR、SIGN_QUEUE_DIR):存在、是資料夾、可建立與刪除檔案(.ita-write-check-{uuid});不符丟 Error,服務啟動失敗 */
export async function assertWritableDir(name: string, dir: string): Promise<void> {
  const probe = path.join(dir, `.ita-write-check-${randomUUID()}`);
  try {
    if (!(await stat(dir)).isDirectory()) throw Object.assign(new Error('不是資料夾'), { code: 'ENOTDIR' });
    await (await open(probe, 'wx')).close();
    await unlink(probe);
  } catch (err) {
    await unlink(probe).catch(() => undefined);
    const why = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    throw new Error(`${name}=${dir} 無法寫入(${why}):請檢查 NAS 掛載與 ita.env 的路徑`, { cause: err });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw unavailable(err);
  }
}

/** 送簽工作單(檔案契約 docs/contracts/sign-job.schema.json) */
export interface SignJob {
  schema: 'sign-job/1';
  upload_id: string;
  environment: string;
  /** {軟體}/{版本}/{檔名}:incoming\ 的來源與 software\ 的目的地 */
  file_name: string;
  sha256: string;
  size_bytes: number;
  uploaded_by: string;
  approved_by: string;
  approved_at: string;
}

/** 工作站結果(docs/contracts/sign-result.schema.json);格式不符回 null */
export interface SignResult {
  schema: 'sign-result/1';
  upload_id: string;
  state: 'signed' | 'rejected';
  vendor_signer: string | null;
  vendor_signer_subject: string | null;
  vendor_check: 'allowlist' | 'manual' | null;
  signed_file: string | null;
  signed_sha256: string | null;
  signed_signer: string | null;
  signed_at: string | null;
  operator: string | null;
  reject_code: string | null;
  reject_reason: string | null;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isStrOrNull = (v: unknown, max: number) => v === null || (typeof v === 'string' && v.length <= max);

/** 結果檔欄位檢查(不採信內容作安全判斷,只確認格式) */
export function parseSignResult(raw: unknown, uploadId: string): SignResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 'sign-result/1' || r.upload_id !== uploadId || (r.state !== 'signed' && r.state !== 'rejected')) return null;
  const fields: [string, number][] = [
    ['vendor_signer_subject', 400],
    ['signed_file', 260],
    ['signed_at', 40],
    ['operator', 100],
    ['reject_code', 40],
    ['reject_reason', 500],
  ];
  for (const [k, max] of fields) if (!isStrOrNull(r[k] ?? null, max)) return null;
  const vendor = r.vendor_signer ?? null;
  if (vendor !== null && (typeof vendor !== 'string' || !HEX40.test(vendor))) return null;
  const check = r.vendor_check ?? null;
  if (check !== null && check !== 'allowlist' && check !== 'manual') return null;
  if (r.state === 'signed') {
    if (typeof r.signed_file !== 'string' || typeof r.signed_sha256 !== 'string' || !HEX64.test(r.signed_sha256)) return null;
    if (typeof r.signed_signer !== 'string' || !HEX40.test(r.signed_signer)) return null;
  } else if (typeof r.reject_code !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(r.reject_code)) return null;
  return {
    schema: 'sign-result/1',
    upload_id: uploadId,
    state: r.state,
    vendor_signer: vendor as string | null,
    vendor_signer_subject: (r.vendor_signer_subject as string | null) ?? null,
    vendor_check: check as SignResult['vendor_check'],
    signed_file: (r.signed_file as string | null) ?? null,
    signed_sha256: (r.signed_sha256 as string | null) ?? null,
    signed_signer: (r.signed_signer as string | null) ?? null,
    signed_at: (r.signed_at as string | null) ?? null,
    operator: (r.operator as string | null) ?? null,
    reject_code: (r.reject_code as string | null) ?? null,
    reject_reason: (r.reject_reason as string | null) ?? null,
  };
}

export class SignQueue {
  constructor(readonly root: string) {}

  /** 寫工作單 {uploadId}.json:暫存檔 → 改名;已存在回 409 ITA_SIGN_JOB_EXISTS */
  async writeJob(job: SignJob): Promise<void> {
    if (!UUID_RE.test(job.upload_id)) throw new AppError(400, 'VALIDATION_FAILED', 'uploadId 格式錯誤');
    const dest = path.join(this.root, `${job.upload_id}.json`);
    const tmp = path.join(this.root, `.${job.upload_id}.json.tmp-${randomUUID()}`);
    try {
      if (await exists(dest)) throw new AppError(409, 'ITA_SIGN_JOB_EXISTS', '送簽工作單已存在');
      const h = await open(tmp, 'wx');
      try {
        await h.writeFile(JSON.stringify(job, null, 2) + '\n', 'utf8');
      } finally {
        await h.close();
      }
      if (await exists(dest)) throw new AppError(409, 'ITA_SIGN_JOB_EXISTS', '送簽工作單已存在');
      await rename(tmp, dest);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      if (err instanceof AppError) throw err;
      throw unavailable(err);
    }
  }

  /** 駁回送簽中的上傳時移除工作單(盡力而為;工作站已在處理時,主機也不採用其結果) */
  async removeJob(uploadId: string): Promise<boolean> {
    if (!UUID_RE.test(uploadId)) return false;
    try {
      await unlink(path.join(this.root, `${uploadId}.json`));
      return true;
    } catch {
      return false;
    }
  }

  /** 工作站結果;沒有結果檔回 'none',格式錯誤或過大回 'invalid' */
  async readResult(uploadId: string): Promise<SignResult | 'none' | 'invalid'> {
    if (!UUID_RE.test(uploadId)) return 'invalid';
    const file = path.join(this.root, `${uploadId}.result.json`);
    try {
      // 以同一個檔案代號 fstat 與讀取,最多讀 RESULT_MAX_BYTES + 1(資安審查 L3:stat 後換成大檔、符號連結指到其他檔案)
      const h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let text: string;
      try {
        const s = await h.stat();
        if (!s.isFile() || s.size > RESULT_MAX_BYTES) return 'invalid';
        const buf = Buffer.alloc(RESULT_MAX_BYTES + 1);
        const { bytesRead } = await h.read(buf, 0, buf.length, 0);
        if (bytesRead > RESULT_MAX_BYTES) return 'invalid';
        text = buf.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
      } finally {
        await h.close();
      }
      return parseSignResult(JSON.parse(text), uploadId) ?? 'invalid';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') return 'invalid';
      if (err instanceof SyntaxError) return 'invalid';
      throw unavailable(err);
    }
  }
}
