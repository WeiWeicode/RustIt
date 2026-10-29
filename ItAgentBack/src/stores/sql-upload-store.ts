/**
 * 軟體套件上傳與送簽儲存(SQL Server 2012,migration 0011;S1-SIGNING-DESIGN §4):ita.software_upload。
 * 與 SqlDeviceStore 共用連線池。狀態轉換一律條件更新(WHERE state = …);核可人 ≠ 上傳者在 UPDATE 條件與 CHECK 各擋一次。
 */
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { AppError } from '../errors.js';
import type { Actor, NewUpload, UploadRecord, UploadSignedPatch, UploadSource, UploadState, UploadStore } from './types.js';

type Row = Record<string, unknown>;

const cut = (s: string | null | undefined, n: number): string | null => (s == null || s === '' ? null : s.length > n ? s.slice(0, n) : s);
const str = (v: unknown): string | null => (v == null ? null : String(v));
const date = (v: unknown): Date | null => (v as Date | null) ?? null;
const isDuplicateKey = (err: unknown) => [2627, 2601].includes((err as { number?: number }).number ?? 0);

const COLS = `id, upload_id, file_name, sha256, size_bytes, state, source, notes, uploaded_by_emp, uploaded_by_name, uploaded_at,
  approved_by_emp, approved_by_name, approved_at, reject_code, reject_reason, rejected_by_emp, rejected_at,
  vendor_signer, vendor_signer_subject, vendor_check, signed_signer, sign_operator, signed_sha256, signed_at`;

function toUpload(r: Row): UploadRecord {
  return {
    id: Number(r.id),
    uploadId: String(r.upload_id).toLowerCase(),
    fileName: String(r.file_name),
    sha256: String(r.sha256).toLowerCase(),
    sizeBytes: Number(r.size_bytes),
    state: String(r.state) as UploadState,
    source: String(r.source) as UploadSource,
    notes: str(r.notes),
    uploadedByEmp: String(r.uploaded_by_emp),
    uploadedByName: str(r.uploaded_by_name),
    uploadedAt: r.uploaded_at as Date,
    approvedByEmp: str(r.approved_by_emp),
    approvedByName: str(r.approved_by_name),
    approvedAt: date(r.approved_at),
    rejectCode: str(r.reject_code),
    rejectReason: str(r.reject_reason),
    rejectedByEmp: str(r.rejected_by_emp),
    rejectedAt: date(r.rejected_at),
    vendorSigner: str(r.vendor_signer)?.toLowerCase() ?? null,
    vendorSignerSubject: str(r.vendor_signer_subject),
    vendorCheck: str(r.vendor_check),
    signedSigner: str(r.signed_signer)?.toLowerCase() ?? null,
    signOperator: str(r.sign_operator),
    signedSha256: str(r.signed_sha256)?.toLowerCase() ?? null,
    signedAt: date(r.signed_at),
  };
}

export class SqlUploadStore implements UploadStore {
  constructor(private readonly pool: () => Promise<sql.ConnectionPool>) {}

  private async request(): Promise<sql.Request> {
    return (await this.pool()).request();
  }

  async listUploads(f: { state?: UploadState }): Promise<UploadRecord[]> {
    const req = await this.request();
    const where = f.state ? `WHERE state = ${(req.input('s', sql.VarChar(16), f.state), '@s')}` : '';
    const r = await req.query(`SELECT TOP (500) ${COLS} FROM ita.software_upload ${where} ORDER BY uploaded_at DESC, id DESC`);
    return (r.recordset as Row[]).map(toUpload);
  }

  async getUpload(uploadId: string): Promise<UploadRecord | null> {
    const r = await (await this.request()).input('uid', sql.UniqueIdentifier, uploadId).query(`SELECT ${COLS} FROM ita.software_upload WHERE upload_id = @uid`);
    const row = r.recordset[0] as Row | undefined;
    return row ? toUpload(row) : null;
  }

  // 不依賴資料庫定序:NAS 路徑不分大小寫,定序若為 CS 會漏掉紀錄而繞過登錄檢查(資安審查 L2;表小,不需索引)
  async uploadsForFile(fileName: string): Promise<UploadRecord[]> {
    const r = await (await this.request())
      .input('file', sql.NVarChar(260), fileName)
      .query(`SELECT TOP (20) ${COLS} FROM ita.software_upload WHERE LOWER(file_name) = LOWER(@file) ORDER BY uploaded_at DESC, id DESC`);
    return (r.recordset as Row[]).map(toUpload);
  }

  async addUpload(n: NewUpload): Promise<UploadRecord> {
    const uploadId = randomUUID();
    try {
      await (
        await this.request()
      )
        .input('uid', sql.UniqueIdentifier, uploadId)
        .input('file', sql.NVarChar(260), n.fileName)
        .input('sha', sql.Char(64), n.sha256)
        .input('size', sql.BigInt, n.sizeBytes)
        .input('src', sql.VarChar(16), n.source)
        .input('notes', sql.NVarChar(1000), cut(n.notes, 1000))
        .input('emp', sql.NVarChar(64), cut(n.actor.emp, 64))
        .input('ename', sql.NVarChar(100), cut(n.actor.name, 100))
        .input('at', sql.DateTime2(3), n.at)
        .input('req', sql.VarChar(64), cut(n.requestId, 64)).query(`
          INSERT INTO ita.software_upload (upload_id, file_name, sha256, size_bytes, state, source, notes, uploaded_by_emp, uploaded_by_name, uploaded_at, request_id)
          VALUES (@uid, @file, @sha, @size, 'uploaded', @src, @notes, @emp, @ename, @at, @req)`);
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError(409, 'ITA_UPLOAD_EXISTS', `${n.fileName} 已有進行中的上傳(待核可或送簽中)`);
      throw err;
    }
    return (await this.getUpload(uploadId))!;
  }

  async approveUpload(uploadId: string, actor: Actor, at: Date, requestId: string): Promise<boolean> {
    const r = await (
      await this.request()
    )
      .input('uid', sql.UniqueIdentifier, uploadId)
      .input('emp', sql.NVarChar(64), cut(actor.emp, 64))
      .input('ename', sql.NVarChar(100), cut(actor.name, 100))
      .input('at', sql.DateTime2(3), at)
      .input('req', sql.VarChar(64), cut(requestId, 64)).query(`
        UPDATE ita.software_upload SET state = 'queued', approved_by_emp = @emp, approved_by_name = @ename, approved_at = @at, request_id = @req
        WHERE upload_id = @uid AND state = 'uploaded' AND uploaded_by_emp <> @emp`);
    return r.rowsAffected[0] === 1;
  }

  async rejectUpload(uploadId: string, expect: UploadState[], code: string, reason: string | null, actor: Actor | null, at: Date): Promise<boolean> {
    const req = (await this.request())
      .input('uid', sql.UniqueIdentifier, uploadId)
      .input('code', sql.VarChar(40), cut(code, 40))
      .input('reason', sql.NVarChar(500), cut(reason, 500))
      .input('emp', sql.NVarChar(64), actor ? cut(actor.emp, 64) : null)
      .input('at', sql.DateTime2(3), at);
    const states = expect.map((s, i) => (req.input(`e${i}`, sql.VarChar(16), s), `@e${i}`)).join(', ');
    const r = await req.query(`
      UPDATE ita.software_upload SET state = 'rejected', reject_code = @code, reject_reason = @reason, rejected_by_emp = @emp, rejected_at = @at
      WHERE upload_id = @uid AND state IN (${states})`);
    return r.rowsAffected[0] === 1;
  }

  async markSigned(uploadId: string, p: UploadSignedPatch): Promise<boolean> {
    const r = await (
      await this.request()
    )
      .input('uid', sql.UniqueIdentifier, uploadId)
      .input('vs', sql.Char(40), p.vendorSigner)
      .input('vss', sql.NVarChar(400), cut(p.vendorSignerSubject, 400))
      .input('vc', sql.VarChar(16), cut(p.vendorCheck, 16))
      .input('ss', sql.Char(40), p.signedSigner)
      .input('op', sql.NVarChar(100), cut(p.signOperator, 100))
      .input('sha', sql.Char(64), p.signedSha256)
      .input('at', sql.DateTime2(3), p.at).query(`
        UPDATE ita.software_upload SET state = 'signed', vendor_signer = @vs, vendor_signer_subject = @vss, vendor_check = @vc,
          signed_signer = @ss, sign_operator = @op, signed_sha256 = @sha, signed_at = @at
        WHERE upload_id = @uid AND state = 'queued'`);
    return r.rowsAffected[0] === 1;
  }
}
