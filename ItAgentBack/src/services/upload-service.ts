/**
 * 軟體套件上傳與送簽(S1-3;S1-SIGNING-DESIGN §4、ADR 0005):
 *   uploaded →(第二人核可)queued →(工作站結果、主機重算相符)signed;uploaded / queued 可駁回;工作站拒絕或結果不符 → rejected
 *   - 來源:API 串流上傳(upload),或網路芳鄰放進 incoming\ 後登錄(incoming,過渡期 §9-2);兩者都由主機讀檔算 SHA-256
 *   - 全部操作需 endpoint.software.manage(BFF)且全部公司角色(軟體庫是全公司共用,與 P7 目錄相同)
 *   - 核可人 ≠ 上傳者(程式、SQL 條件、CHECK 三道);核可前重算 incoming\ 檔案雜湊,與上傳時不同就拒絕(檔案被換掉)
 *   - 核可寫送簽工作單到 sign-queue\;工作站結果檔只當通知:signed 時主機以軟體庫(software\,唯讀)實際檔案重算,
 *     路徑必須等於上傳的路徑、雜湊必須等於結果檔回報值,否則 rejected / RESULT_MISMATCH(不採信結果檔作安全判斷)
 *   - 簽章者是否為公司軟體發佈憑證,在 P7 登錄 / 標記 tested 時照現有規則由 IT 確認(Agent 回報實際簽章者),這裡只記錄
 * 之後的 P7 登錄(draft → tested → published)不變:signed 的檔案出現在「尚未登錄的安裝檔」。
 */
import type { Readable } from 'node:stream';
import type { GatewayIdentity } from '@giganexus/backend-sdk';
import { AppError, storageUnavailable } from '../errors.js';
import type { Actor, UploadRecord, UploadState, UploadStore } from '../stores/types.js';
import type { Ctx } from './device-service.js';
import type { MgmtCtx } from './scope.js';
import { splitSoftwarePath, type SoftwareFileInfo, type SoftwareFiles } from './software-files.js';
import { receiveIncoming, removeIncoming, type SignQueue } from './upload-files.js';

export const UPLOAD_STATES: readonly UploadState[] = ['uploaded', 'queued', 'signed', 'rejected'];
/** 同時收檔的上限(資安審查 M3:塞滿 NAS) */
export const UPLOAD_MAX_CONCURRENT = 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const actorOf = (who: GatewayIdentity): Actor => ({ emp: who.emp ?? who.sub, name: who.name ?? null });
const trimOrNull = (s: string | undefined | null) => (s == null ? null : s.trim() || null);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface UploadView {
  uploadId: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  state: UploadState;
  source: UploadRecord['source'];
  notes: string | null;
  uploadedBy: { emp: string; name: string | null };
  uploadedAt: string;
  approvedBy: { emp: string; name: string | null } | null;
  approvedAt: string | null;
  rejectCode: string | null;
  rejectReason: string | null;
  rejectedByEmp: string | null;
  rejectedAt: string | null;
  vendorSigner: string | null;
  vendorSignerSubject: string | null;
  vendorCheck: string | null;
  signedSigner: string | null;
  signOperator: string | null;
  signedSha256: string | null;
  signedAt: string | null;
}

export function uploadView(u: UploadRecord): UploadView {
  return {
    uploadId: u.uploadId,
    fileName: u.fileName,
    sha256: u.sha256,
    sizeBytes: u.sizeBytes,
    state: u.state,
    source: u.source,
    notes: u.notes,
    uploadedBy: { emp: u.uploadedByEmp, name: u.uploadedByName },
    uploadedAt: u.uploadedAt.toISOString(),
    approvedBy: u.approvedByEmp ? { emp: u.approvedByEmp, name: u.approvedByName } : null,
    approvedAt: iso(u.approvedAt),
    rejectCode: u.rejectCode,
    rejectReason: u.rejectReason,
    rejectedByEmp: u.rejectedByEmp,
    rejectedAt: iso(u.rejectedAt),
    vendorSigner: u.vendorSigner,
    vendorSignerSubject: u.vendorSignerSubject,
    vendorCheck: u.vendorCheck,
    signedSigner: u.signedSigner,
    signOperator: u.signOperator,
    signedSha256: u.signedSha256,
    signedAt: iso(u.signedAt),
  };
}

export interface UploadServiceOptions {
  now?: () => Date;
  /** 部署區(GW_ENV),寫入工作單;工作站以此確認佇列屬於哪一區 */
  environment: string;
  maxBytes: number;
  /** 同時收檔的上限,預設 UPLOAD_MAX_CONCURRENT */
  maxConcurrentUploads?: number;
  /** 上傳閒置逾時(毫秒),預設 UPLOAD_IDLE_MS */
  idleMs?: number;
}

export class UploadService {
  private readonly now: () => Date;
  private scanning = false;
  /** 收檔中的上傳數(單一實例) */
  private receiving = 0;

  constructor(
    private readonly store: UploadStore,
    /** incoming\(讀寫;讀取規則與軟體庫相同) */
    private readonly incoming: SoftwareFiles,
    private readonly queue: SignQueue,
    /** 軟體庫 software\(唯讀),確認工作站放好的檔案 */
    private readonly software: SoftwareFiles,
    private readonly opts: UploadServiceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  private async sqlDo<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      ctx.log.error({ err, what }, 'SQL Server 操作失敗(軟體上傳)');
      throw storageUnavailable();
    }
  }

  private requireAll(ctx: MgmtCtx): void {
    if (!ctx.scope.all) throw new AppError(403, 'ITA_SCOPE_ALL_REQUIRED', '軟體庫是全公司共用,只有可管理所有公司的角色能上傳與核可');
  }

  private async found(ctx: Ctx, uploadId: string): Promise<UploadRecord> {
    const u = UUID_RE.test(uploadId) ? await this.sqlDo(ctx, 'upload.get', () => this.store.getUpload(uploadId)) : null;
    if (!u) throw new AppError(404, 'ITA_UPLOAD_NOT_FOUND', '找不到此上傳紀錄');
    return u;
  }

  async list(ctx: MgmtCtx, f: { state?: UploadState }): Promise<{ items: UploadView[] }> {
    this.requireAll(ctx);
    return { items: (await this.sqlDo(ctx, 'upload.list', () => this.store.listUploads(f))).map(uploadView) };
  }

  async get(ctx: MgmtCtx, uploadId: string): Promise<UploadView> {
    this.requireAll(ctx);
    return uploadView(await this.found(ctx, uploadId));
  }

  /** incoming\ 內尚未登錄(沒有進行中或已簽章的上傳紀錄)的檔案:網路芳鄰放好後在畫面挑選登錄 */
  async unregisteredIncoming(ctx: MgmtCtx): Promise<{ items: (Omit<SoftwareFileInfo, 'modifiedAt'> & { modifiedAt: string })[] }> {
    this.requireAll(ctx);
    const [files, rows] = await Promise.all([this.incoming.list(), this.sqlDo(ctx, 'upload.list', () => this.store.listUploads({}))]);
    const known = new Set(rows.filter((r) => r.state !== 'rejected').map((r) => r.fileName));
    return { items: files.filter((f) => !known.has(f.fileName)).map((f) => ({ ...f, modifiedAt: f.modifiedAt.toISOString() })) };
  }

  /**
   * API 串流上傳:寫入 incoming\(不覆蓋),建立 uploaded 紀錄。
   * 收檔前先擋(資安審查 M3):Content-Length 缺少或超過上限、同時上傳數已達上限、軟體庫已有同路徑、同路徑已有進行中的上傳;
   * 建立紀錄失敗時刪掉剛放好的檔案
   */
  async upload(ctx: MgmtCtx, who: GatewayIdentity, input: { fileName: string; contentLength: number | null }, body: Readable): Promise<UploadView> {
    this.requireAll(ctx);
    const parts = splitSoftwarePath(input.fileName);
    if (!parts) throw new AppError(400, 'VALIDATION_FAILED', '檔案路徑需為 {軟體}/{版本}/{檔名}.msi 或 .exe', [{ field: 'fileName', message: '格式不符' }]);
    const fileName = parts.join('/');
    if (input.contentLength === null) throw new AppError(411, 'ITA_UPLOAD_LENGTH_REQUIRED', '上傳需帶 Content-Length');
    if (input.contentLength > this.opts.maxBytes) throw new AppError(413, 'ITA_UPLOAD_TOO_LARGE', `安裝檔超過上限 ${this.opts.maxBytes} 位元組`);
    if (this.receiving >= (this.opts.maxConcurrentUploads ?? UPLOAD_MAX_CONCURRENT))
      throw new AppError(429, 'ITA_UPLOAD_BUSY', '同時上傳的檔案太多,請稍後再試');
    // 先佔名額再做非同步檢查(檢查期間的其他請求也算在內)
    this.receiving++;
    let r: Awaited<ReturnType<typeof receiveIncoming>>;
    try {
      await this.checkTarget(ctx, fileName);
      r = await receiveIncoming(this.incoming.root, fileName, body, this.opts.maxBytes, this.opts.idleMs);
    } finally {
      this.receiving--;
    }
    try {
      return await this.add(ctx, who, { fileName: r.fileName, sha256: r.sha256, sizeBytes: r.size, source: 'upload' });
    } catch (err) {
      if (!(await removeIncoming(this.incoming.root, r.fileName))) ctx.log.warn({ fileName: r.fileName }, '建立上傳紀錄失敗後無法刪除 incoming 檔案');
      throw err;
    }
  }

  /** 軟體庫已有同路徑、或同路徑已有進行中的上傳:不收檔 */
  private async checkTarget(ctx: Ctx, fileName: string): Promise<void> {
    if (await this.software.resolve(fileName)) throw new AppError(409, 'ITA_UPLOAD_FILE_EXISTS', `軟體庫已有 ${fileName}:換新的版本資料夾再上傳`);
    const active = await this.sqlDo(ctx, 'upload.list', () => this.store.listUploads({}));
    if (active.some((u) => u.fileName === fileName && (u.state === 'uploaded' || u.state === 'queued')))
      throw new AppError(409, 'ITA_UPLOAD_EXISTS', `${fileName} 已有進行中的上傳(待核可或送簽中)`);
  }

  /** 登錄已放在 incoming\ 的檔案(網路芳鄰,過渡期) */
  async registerIncoming(ctx: MgmtCtx, who: GatewayIdentity, input: { fileName: string; notes?: string }): Promise<UploadView> {
    this.requireAll(ctx);
    const parts = splitSoftwarePath(input.fileName);
    if (!parts) throw new AppError(400, 'VALIDATION_FAILED', '檔案路徑需為 {軟體}/{版本}/{檔名}.msi 或 .exe', [{ field: 'fileName', message: '格式不符' }]);
    const fileName = parts.join('/');
    const f = await this.incoming.resolve(fileName);
    if (!f) throw new AppError(404, 'ITA_UPLOAD_FILE_NOT_FOUND', `incoming 找不到 ${fileName}(或超過大小上限)`);
    const sha256 = await this.incoming.sha256Fresh(f);
    return this.add(ctx, who, { fileName, sha256, sizeBytes: f.size, source: 'incoming', notes: input.notes });
  }

  private async add(
    ctx: MgmtCtx,
    who: GatewayIdentity,
    n: { fileName: string; sha256: string; sizeBytes: number; source: UploadRecord['source']; notes?: string },
  ): Promise<UploadView> {
    // 軟體庫已有同路徑(已簽好或 IT 直接放的)就不必再送簽:避免工作站放置時因不覆蓋而失敗;同路徑進行中由 SQL 唯一索引擋
    if (await this.software.resolve(n.fileName)) throw new AppError(409, 'ITA_UPLOAD_FILE_EXISTS', `軟體庫已有 ${n.fileName}:換新的版本資料夾再上傳`);
    const actor = actorOf(who);
    const u = await this.sqlDo(ctx, 'upload.add', () =>
      this.store.addUpload({ ...n, notes: trimOrNull(n.notes), actor, at: this.now(), requestId: ctx.requestId }),
    );
    ctx.log.info({ uploadId: u.uploadId, fileName: u.fileName, sha256: u.sha256, source: u.source, emp: actor.emp }, '軟體套件上傳');
    return uploadView(u);
  }

  /** 第二人核可送簽:重算 incoming\ 雜湊 → 寫工作單 → queued */
  async approve(ctx: MgmtCtx, who: GatewayIdentity, uploadId: string): Promise<UploadView> {
    this.requireAll(ctx);
    const u = await this.found(ctx, uploadId);
    const actor = actorOf(who);
    if (u.state !== 'uploaded') throw new AppError(409, 'ITA_UPLOAD_STATE', `狀態為 ${u.state},只有 uploaded 可核可送簽`);
    if (actor.emp === u.uploadedByEmp) throw new AppError(403, 'ITA_UPLOAD_SAME_PERSON', '送簽要兩個人:核可人不可是上傳者');
    const f = await this.incoming.resolve(u.fileName);
    const sha = f ? await this.incoming.sha256Fresh(f) : null;
    if (!f || sha !== u.sha256 || f.size !== u.sizeBytes) {
      const reason = f ? '核可時 incoming 檔案的雜湊與上傳時不同(檔案被換掉)' : '核可時 incoming 找不到檔案';
      await this.sqlDo(ctx, 'upload.reject', () => this.store.rejectUpload(u.uploadId, ['uploaded'], 'INCOMING_CHANGED', reason, null, this.now()));
      ctx.log.error({ uploadId: u.uploadId, fileName: u.fileName, expected: u.sha256, actual: sha }, reason);
      throw new AppError(409, 'ITA_UPLOAD_FILE_CHANGED', `${reason};已標記 rejected,請重新上傳`);
    }
    const at = this.now();
    // 先改狀態再寫工作單:寫工作單失敗時改回(只有 queued 的紀錄會被掃描)
    const ok = await this.sqlDo(ctx, 'upload.approve', () => this.store.approveUpload(u.uploadId, actor, at, ctx.requestId));
    if (!ok) throw new AppError(409, 'ITA_UPLOAD_STATE', '狀態已改變(可能已被核可或駁回),請重新整理');
    try {
      await this.queue.writeJob({
        schema: 'sign-job/1',
        upload_id: u.uploadId,
        environment: this.opts.environment,
        file_name: u.fileName,
        sha256: u.sha256,
        size_bytes: u.sizeBytes,
        uploaded_by: u.uploadedByEmp,
        approved_by: actor.emp,
        approved_at: at.toISOString(),
      });
    } catch (err) {
      // 底層錯誤(NAS 掛載、權限)只在這裡記錄;回應只帶錯誤碼(2026-10-29 測試區實測時查不到原因)
      ctx.log.error({ err, cause: (err as { cause?: unknown }).cause, uploadId: u.uploadId, fileName: u.fileName }, '送簽工作單寫入失敗');
      await this.store
        .rejectUpload(u.uploadId, ['queued'], 'SIGN_JOB_WRITE_FAILED', '送簽工作單寫入失敗,請重新上傳', null, this.now())
        .catch((e: unknown) => ctx.log.error({ err: e, uploadId: u.uploadId }, '送簽工作單寫入失敗後無法改為 rejected'));
      throw err;
    }
    // 寫工作單期間被駁回(資安審查 M1):狀態已不是 queued 就移除工作單;工作站簽章前也會向主機確認狀態(signStatus)
    const after = (await this.store.getUpload(u.uploadId))!;
    if (after.state !== 'queued') {
      await this.queue.removeJob(u.uploadId);
      throw new AppError(409, 'ITA_UPLOAD_STATE', `核可期間狀態已改為 ${after.state}`);
    }
    ctx.log.info({ uploadId: u.uploadId, fileName: u.fileName, approvedBy: actor.emp, uploadedBy: u.uploadedByEmp }, '核可送簽');
    return uploadView(after);
  }

  /** 駁回(uploaded / queued) */
  async reject(ctx: MgmtCtx, who: GatewayIdentity, uploadId: string, reason: string): Promise<UploadView> {
    this.requireAll(ctx);
    const u = await this.found(ctx, uploadId);
    const ok = await this.sqlDo(ctx, 'upload.reject', () =>
      this.store.rejectUpload(u.uploadId, ['uploaded', 'queued'], 'REJECTED', reason.trim(), actorOf(who), this.now()),
    );
    if (!ok) throw new AppError(409, 'ITA_UPLOAD_STATE', `狀態為 ${u.state},只有 uploaded / queued 可駁回`);
    // 不論讀到的舊狀態,一律移除工作單(資安審查 M1:與核可同時發生時舊狀態不準);工作站簽章前也會向主機確認狀態是 queued
    await this.queue.removeJob(u.uploadId);
    ctx.log.info({ uploadId: u.uploadId, emp: actorOf(who).emp }, '駁回上傳');
    return uploadView((await this.store.getUpload(u.uploadId))!);
  }

  /**
   * 簽章工作站簽章前確認(API Key,資安審查 M1 / M2):工作單可被能寫 sign-queue\ 的人偽造,工作站以此確認主機上這筆確實是
   * queued、經兩人(核可人 ≠ 上傳者)、路徑與雜湊與工作單相同。找不到與其他狀態都回 200 + state,讓工作站寫 rejected。
   */
  async signStatus(ctx: Ctx, uploadId: string): Promise<{
    environment: string;
    uploadId: string;
    state: UploadState | 'not_found';
    fileName: string | null;
    sha256: string | null;
    sizeBytes: number | null;
    uploadedBy: string | null;
    approvedBy: string | null;
  }> {
    const u = UUID_RE.test(uploadId) ? await this.sqlDo(ctx, 'upload.get', () => this.store.getUpload(uploadId)) : null;
    return {
      environment: this.opts.environment,
      uploadId,
      state: u?.state ?? 'not_found',
      fileName: u?.fileName ?? null,
      sha256: u?.sha256 ?? null,
      sizeBytes: u?.sizeBytes ?? null,
      uploadedBy: u?.uploadedByEmp ?? null,
      approvedBy: u?.approvedByEmp ?? null,
    };
  }

  /**
   * 每分鐘:讀 queued 紀錄的工作站結果。signed → 以軟體庫實際檔案重算確認;rejected → 記錄工作站的原因。
   * 結果檔格式錯誤只記 warn、保持 queued(工作站可能還在寫;工作站最後才寫結果檔)。
   */
  async scanResults(ctx: Ctx): Promise<{ signed: number; rejected: number }> {
    const result = { signed: 0, rejected: 0 };
    if (this.scanning) return result;
    this.scanning = true;
    try {
      const queued = await this.store.listUploads({ state: 'queued' });
      for (const u of queued) {
        try {
          const r = await this.queue.readResult(u.uploadId);
          if (r === 'none') continue;
          if (r === 'invalid') {
            ctx.log.warn({ uploadId: u.uploadId }, '簽章結果檔格式不符,略過(保持 queued)');
            continue;
          }
          if (r.state === 'rejected') {
            if (await this.store.rejectUpload(u.uploadId, ['queued'], r.reject_code!, r.reject_reason, null, this.now())) result.rejected++;
            ctx.log.warn({ uploadId: u.uploadId, code: r.reject_code, operator: r.operator }, '簽章工作站拒絕');
            continue;
          }
          const mismatch = await this.checkSigned(u, r.signed_file!, r.signed_sha256!);
          if (mismatch === 'missing') {
            // NAS 快取可能還看不到剛放好的檔案:下一輪再試(資安審查順帶)
            ctx.log.warn({ uploadId: u.uploadId, fileName: u.fileName }, '有簽章結果但軟體庫還讀不到檔案,下一輪再試');
            continue;
          }
          if (mismatch) {
            if (await this.store.rejectUpload(u.uploadId, ['queued'], 'RESULT_MISMATCH', mismatch, null, this.now())) result.rejected++;
            ctx.log.error({ uploadId: u.uploadId, fileName: u.fileName, signedFile: r.signed_file, reported: r.signed_sha256 }, `簽章結果與軟體庫不符:${mismatch}`);
            continue;
          }
          const ok = await this.store.markSigned(u.uploadId, {
            vendorSigner: r.vendor_signer,
            vendorSignerSubject: r.vendor_signer_subject,
            vendorCheck: r.vendor_check,
            signedSigner: r.signed_signer!,
            signOperator: r.operator,
            signedSha256: r.signed_sha256!,
            at: this.now(),
          });
          if (ok) {
            result.signed++;
            ctx.log.info({ uploadId: u.uploadId, fileName: u.fileName, signedSha256: r.signed_sha256, signer: r.signed_signer }, '簽章完成,已放進軟體庫');
          }
        } catch (err) {
          // 單筆失敗(NAS 暫時讀不到)不影響其他筆,下一輪再試
          ctx.log.warn({ err, uploadId: u.uploadId }, '讀取簽章結果失敗,下一輪再試');
        }
      }
    } catch (err) {
      ctx.log.warn({ err }, '掃描簽章結果失敗(SQL Server),下一輪再試');
    } finally {
      this.scanning = false;
    }
    return result;
  }

  /** 工作站放進軟體庫的檔案:路徑必須是上傳的路徑,實際雜湊必須等於結果檔回報值;相符回 null,否則回原因 */
  private async checkSigned(u: UploadRecord, signedFile: string, reported: string): Promise<string | 'missing' | null> {
    const parts = splitSoftwarePath(signedFile);
    if (!parts || parts.join('/') !== u.fileName) return `結果檔的路徑 ${signedFile} 與上傳的 ${u.fileName} 不同`;
    const f = await this.software.resolve(u.fileName);
    if (!f) return 'missing';
    const sha = await this.software.sha256Fresh(f);
    if (sha !== reported) return '軟體庫檔案的雜湊與結果檔回報值不同';
    if (sha === u.sha256) return '軟體庫檔案與上傳的原始檔相同(沒有重新簽章)';
    return null;
  }
}
