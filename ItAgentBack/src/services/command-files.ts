/**
 * 指令附檔(PLATFORM-PLAN A4、B5;docs/contracts/command-kinds.md「指令附檔」、command-file.schema.json):logs.collect 的日誌 zip。
 *
 *   上傳(Agent 通道):指令屬於此裝置、類型允許附檔、狀態 acked / running → 串流寫入暫存檔並計算 SHA-256、檢查大小
 *     → 與 x-file-sha256 相符才搬到 <dir>/<yyyy>/<MM>/<file_id>.zip → 寫 ita.command_file(SQL 失敗刪檔、回 503,Agent 重試)。
 *     檔名與存放路徑由主機產生,不採用 Agent 給的名稱。每筆指令一個檔:重送相同內容回既有 file_id,不同內容 409。
 *   下載(管理 API):fileId 必須屬於 commandId;保存期限已到 410。
 *   清除:每小時刪除到期的檔案與索引列;指令紀錄與 result 保留(B5)。檔案只存在本機磁碟(Docker volume),遺失只影響下載。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { kindOf } from '../commands/kinds.js';
import { AppError, storageUnavailable } from '../errors.js';
import type { CommandFileRecord, CommandFileStore, CommandStore, DeviceRecord } from '../stores/types.js';
import type { Ctx } from './device-service.js';
import { inScope, type MgmtCtx } from './scope.js';

/** 單檔上限(command-kinds.md;Agent 壓縮後超過會捨棄最舊的日期) */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SWEEP_LIMIT = 200;
const TMP = 'tmp';
/** 上傳中斷留下的暫存檔,超過此時間清除 */
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

/** command-file.schema.json */
export interface UploadResult {
  file_id: string;
  sha256: string;
  size_bytes: number;
  expires_at: string;
}

/** 管理 API GET /commands/{id} 的 files(camelCase) */
export interface CommandFileView {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface CommandFileServiceOptions {
  /** 保存天數(COMMAND_FILE_KEEP_DAYS,14–30) */
  keepDays: number;
  now?: () => Date;
}

/** 下載顯示名稱只留英數、- 與 _(避免標頭注入與路徑字元) */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'device';
/** 2026-10-06T08:00:02.500Z → 20261006-080002 */
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function result(f: Pick<CommandFileRecord, 'fileId' | 'sha256' | 'sizeBytes' | 'expiresAt'>): UploadResult {
  return { file_id: f.fileId, sha256: f.sha256, size_bytes: f.sizeBytes, expires_at: f.expiresAt.toISOString() };
}

export class CommandFileService {
  private readonly now: () => Date;
  private readonly keepMs: number;
  /** 上傳中的指令(同一指令同時只處理一個上傳,避免重送並行產生兩個檔) */
  private readonly uploading = new Set<string>();

  constructor(
    private readonly store: CommandStore & CommandFileStore,
    private readonly dir: string,
    opts: CommandFileServiceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.keepMs = opts.keepDays * 86_400_000;
  }

  private async sqlDo<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      ctx.log.error({ err, what }, 'SQL Server 操作失敗(指令附檔)');
      throw storageUnavailable();
    }
  }

  /** 存放路徑一律在 dir 之下(storage_path 由主機產生,仍防止被竄改的資料指到外面) */
  private abs(rel: string): string {
    const root = path.resolve(this.dir);
    const p = path.resolve(root, rel);
    if (!p.startsWith(root + path.sep)) throw new Error(`附檔路徑不在存放目錄內:${rel}`);
    return p;
  }

  async upload(
    ctx: Ctx,
    device: DeviceRecord,
    commandId: string,
    sha256: string | undefined,
    contentLength: number | undefined,
    body: Readable,
  ): Promise<UploadResult> {
    const sha = (sha256 ?? '').trim().toLowerCase();
    if (!SHA256.test(sha)) throw new AppError(400, 'VALIDATION_FAILED', 'x-file-sha256 必須是 64 位 hex');
    // 必須帶 Content-Length:提早拒絕時丟棄的本體也受限於宣告的長度(未計量的分段傳送不接受)
    if (contentLength === undefined || !Number.isSafeInteger(contentLength) || contentLength < 0)
      throw new AppError(411, 'ITA_LENGTH_REQUIRED', '附檔上傳需要 Content-Length');
    if (contentLength > FILE_MAX_BYTES) throw new AppError(413, 'ITA_FILE_TOO_LARGE', `附檔超過上限 ${FILE_MAX_BYTES} bytes`);
    const cmd = await this.sqlDo(ctx, 'command.get', () => this.store.getCommand(commandId));
    // 不屬於這台裝置的指令一律當作不存在(防止一台電腦替別台上傳)
    if (!cmd || cmd.deviceRef !== device.id) throw new AppError(404, 'ITA_COMMAND_NOT_FOUND', '找不到此指令');
    if (!kindOf(cmd.kind)?.files) throw new AppError(400, 'ITA_COMMAND_FILE_NOT_ALLOWED', `指令 ${cmd.kind} 不接受附檔`);
    if (cmd.state !== 'acked' && cmd.state !== 'running') throw new AppError(409, 'ITA_COMMAND_NOT_RUNNING', `指令狀態為 ${cmd.state},不接受附檔`);
    if (this.uploading.has(cmd.commandId)) throw new AppError(409, 'ITA_COMMAND_FILE_EXISTS', '此指令的附檔正在上傳');
    this.uploading.add(cmd.commandId);
    try {
      const [existing] = await this.sqlDo(ctx, 'commandFile.list', () => this.store.listFiles(cmd.id));
      if (existing) {
        if (existing.sha256 !== sha) throw new AppError(409, 'ITA_COMMAND_FILE_EXISTS', '此指令已有不同內容的附檔');
        // 重送(Agent 沒收到上次的回應):回同一個 file_id
        body.resume();
        return result(existing);
      }
      const fileId = randomUUID();
      const at = this.now();
      const rel = path.posix.join(String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), `${fileId}.zip`);
      const tmp = this.abs(path.join(TMP, `${fileId}.part`));
      const final = this.abs(rel);
      await mkdir(path.dirname(tmp), { recursive: true });
      await mkdir(path.dirname(final), { recursive: true });
      const hash = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          if (size > FILE_MAX_BYTES) return done(new AppError(413, 'ITA_FILE_TOO_LARGE', `附檔超過上限 ${FILE_MAX_BYTES} bytes`));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      try {
        await pipeline(body, meter, createWriteStream(tmp));
      } catch (err) {
        await rm(tmp, { force: true });
        if (err instanceof AppError) throw err;
        ctx.log.warn({ err, commandId }, '附檔接收中斷');
        throw new AppError(400, 'VALIDATION_FAILED', '附檔接收中斷');
      }
      const digest = hash.digest('hex');
      if (size === 0) {
        await rm(tmp, { force: true });
        throw new AppError(400, 'VALIDATION_FAILED', '附檔是空的');
      }
      if (digest !== sha) {
        await rm(tmp, { force: true });
        throw new AppError(400, 'ITA_FILE_HASH_MISMATCH', '附檔的 SHA-256 與 x-file-sha256 不符');
      }
      await rename(tmp, final);
      const rec = {
        fileId,
        commandRef: cmd.id,
        fileName: `${safeName(cmd.computerName)}-logs-${stamp(at)}Z.zip`,
        sizeBytes: size,
        sha256: digest,
        storagePath: rel,
        createdAt: at,
        expiresAt: new Date(at.getTime() + this.keepMs),
      };
      try {
        await this.store.addFile(rec);
      } catch (err) {
        await rm(final, { force: true });
        ctx.log.error({ err, commandId }, 'SQL Server 寫入附檔索引失敗,已刪除檔案');
        throw storageUnavailable();
      }
      ctx.log.info({ commandId, fileId, sizeBytes: size }, '收到指令附檔');
      return result(rec);
    } finally {
      this.uploading.delete(cmd.commandId);
    }
  }

  /** 指令的附檔清單(GET /commands/{id});指令的裝置不在資料範圍內回空(E6) */
  async forCommand(ctx: MgmtCtx, commandId: string): Promise<CommandFileView[]> {
    const cmd = await this.sqlDo(ctx, 'command.get', () => this.store.getCommand(commandId));
    if (!cmd || !inScope(ctx.scope, cmd.deviceCompany)) return [];
    const now = this.now();
    const files = await this.sqlDo(ctx, 'commandFile.list', () => this.store.listFiles(cmd.id));
    return files.map((f) => ({
      fileId: f.fileId,
      fileName: f.fileName,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      createdAt: f.createdAt.toISOString(),
      expiresAt: f.expiresAt.toISOString(),
      expired: f.expiresAt <= now,
    }));
  }

  /** 下載:fileId 屬於 commandId、指令的裝置在資料範圍內(E6,否則與不存在相同回 404);過期或檔案已不在回 410 */
  async open(ctx: MgmtCtx, commandId: string, fileId: string): Promise<{ file: CommandFileRecord; stream: ReadStream }> {
    const f = await this.sqlDo(ctx, 'commandFile.get', () => this.store.getFile(fileId));
    if (!f || f.commandId !== commandId) throw new AppError(404, 'ITA_COMMAND_FILE_NOT_FOUND', '找不到此附檔');
    const cmd = await this.sqlDo(ctx, 'command.get', () => this.store.getCommand(commandId));
    if (!cmd || !inScope(ctx.scope, cmd.deviceCompany)) {
      ctx.log.info({ commandId, fileId, scopeDenied: true }, '附檔的裝置不在資料範圍內');
      throw new AppError(404, 'ITA_COMMAND_FILE_NOT_FOUND', '找不到此附檔');
    }
    const gone = () => new AppError(410, 'ITA_COMMAND_FILE_EXPIRED', '附檔已超過保存期限並刪除');
    if (f.expiresAt <= this.now()) throw gone();
    const p = this.abs(f.storagePath);
    try {
      await stat(p);
    } catch {
      ctx.log.warn({ fileId, storagePath: f.storagePath }, '附檔索引存在但檔案不在');
      throw gone();
    }
    ctx.log.info({ commandId, fileId }, '下載指令附檔');
    return { file: f, stream: createReadStream(p) };
  }

  /** 每小時:刪除到期的附檔(先刪檔再刪索引;失敗留到下次)與中斷上傳留下的暫存檔 */
  async sweep(ctx: Ctx): Promise<number> {
    let deleted = 0;
    try {
      const due = await this.store.expiredFiles(this.now(), SWEEP_LIMIT);
      for (const f of due) {
        try {
          await rm(this.abs(f.storagePath), { force: true });
          await this.store.deleteFile(f.id);
          deleted++;
        } catch (err) {
          ctx.log.warn({ err, fileId: f.fileId }, '刪除到期附檔失敗,下次再試');
        }
      }
    } catch (err) {
      ctx.log.warn({ err }, '附檔清除掃描失敗,下次再試');
    }
    await this.sweepTmp(ctx);
    if (deleted) ctx.log.info({ deleted }, '刪除到期的指令附檔');
    return deleted;
  }

  private async sweepTmp(ctx: Ctx): Promise<void> {
    const dir = this.abs(TMP);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // 目錄不存在:尚未有任何上傳
      return;
    }
    const cutoff = Date.now() - TMP_MAX_AGE_MS;
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if ((await stat(p)).mtimeMs < cutoff) await rm(p, { force: true });
      } catch (err) {
        ctx.log.warn({ err, file: n }, '清除附檔暫存檔失敗');
      }
    }
  }
}
