/**
 * 軟體套件上傳與送簽(S1-3;S1-SIGNING-DESIGN §4):記憶體版 UploadStore(與 SqlUploadStore 相同語意)、暫存 incoming / sign-queue / 軟體庫。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv, type GatewayIdentity } from '@giganexus/backend-sdk';
import Fastify from 'fastify';
import { AppError } from '../src/errors.js';
import { buildMgmtApp } from '../src/mgmt-app.js';
import { SoftwareFiles } from '../src/services/software-files.js';
import { SoftwareService } from '../src/services/software-service.js';
import { assertWritableDir, parseSignResult, SignQueue } from '../src/services/upload-files.js';
import { UploadService } from '../src/services/upload-service.js';
import type { Actor, NewUpload, UploadRecord, UploadSignedPatch, UploadState, UploadStore } from '../src/stores/types.js';
import { ALL, CONTRACTS_DIR, MemoryCommandStore, only, setup } from './helpers.js';
import { MemorySoftwareStore, softwareDir } from './software-helpers.js';

const log = Fastify({ logger: { level: 'silent' } }).log;
const ctx = { log, requestId: 'req-up-1', scope: ALL };
const IT: GatewayIdentity = { sub: '1', emp: 'S000001', name: '上傳人' };
const IT2: GatewayIdentity = { sub: '2', emp: 'S000002', name: '核可人' };
const FILE = 'Notepad++/8.7.1/npp.8.7.1.Installer.x64.exe';
const SIGNER = 'c1c2d3e4f5a60718293a4b5c6d7e8f9012345678';

/** 記憶體版:與 SqlUploadStore 相同的條件更新與唯一限制 */
class MemoryUploadStore implements UploadStore {
  rows: UploadRecord[] = [];
  async listUploads(f: { state?: UploadState }) {
    return this.rows.filter((r) => !f.state || r.state === f.state).toReversed();
  }
  async uploadsForFile(fileName: string) {
    return this.rows.filter((r) => r.fileName.toLowerCase() === fileName.toLowerCase()).toReversed().slice(0, 20).map((r) => ({ ...r }));
  }
  async getUpload(uploadId: string) {
    const r = this.rows.find((x) => x.uploadId === uploadId);
    return r ? { ...r } : null;
  }
  async addUpload(n: NewUpload) {
    if (this.rows.some((r) => r.fileName === n.fileName && (r.state === 'uploaded' || r.state === 'queued')))
      throw new AppError(409, 'ITA_UPLOAD_EXISTS', '已有進行中的上傳');
    const r: UploadRecord = {
      id: this.rows.length + 1,
      uploadId: randomUUID(),
      fileName: n.fileName,
      sha256: n.sha256,
      sizeBytes: n.sizeBytes,
      state: 'uploaded',
      source: n.source,
      notes: n.notes,
      uploadedByEmp: n.actor.emp,
      uploadedByName: n.actor.name,
      uploadedAt: n.at,
      approvedByEmp: null,
      approvedByName: null,
      approvedAt: null,
      rejectCode: null,
      rejectReason: null,
      rejectedByEmp: null,
      rejectedAt: null,
      vendorSigner: null,
      vendorSignerSubject: null,
      vendorCheck: null,
      signedSigner: null,
      signOperator: null,
      signedSha256: null,
      signedAt: null,
      fileDeletedByEmp: null,
      fileDeletedAt: null,
    };
    this.rows.push(r);
    return { ...r };
  }
  private row(id: string) {
    return this.rows.find((x) => x.uploadId === id);
  }
  async approveUpload(uploadId: string, actor: Actor, at: Date) {
    const r = this.row(uploadId);
    if (!r || r.state !== 'uploaded' || r.uploadedByEmp === actor.emp) return false;
    Object.assign(r, { state: 'queued', approvedByEmp: actor.emp, approvedByName: actor.name, approvedAt: at });
    return true;
  }
  async rejectUpload(uploadId: string, expect: UploadState[], code: string, reason: string | null, actor: Actor | null, at: Date) {
    const r = this.row(uploadId);
    if (!r || !expect.includes(r.state)) return false;
    Object.assign(r, { state: 'rejected', rejectCode: code, rejectReason: reason, rejectedByEmp: actor?.emp ?? null, rejectedAt: at });
    return true;
  }
  async markSigned(uploadId: string, p: UploadSignedPatch) {
    const r = this.row(uploadId);
    if (!r || r.state !== 'queued') return false;
    Object.assign(r, { ...p, state: 'signed', signedAt: p.at });
    return true;
  }
  private sameFile(fileName: string) {
    return this.rows.filter((r) => r.fileName.toLowerCase() === fileName.toLowerCase());
  }
  async fileStates(fileName: string) {
    return [...new Set(this.sameFile(fileName).map((r) => r.state))];
  }
  async markFilesDeleted(fileName: string, emp: string, at: Date) {
    const rows = this.sameFile(fileName).filter((r) => r.state === 'rejected' && !r.fileDeletedAt);
    for (const r of rows) Object.assign(r, { fileDeletedByEmp: emp, fileDeletedAt: at });
    return rows.length;
  }
}

/** 串流上傳(帶 Content-Length) */
const send = (env: ReturnType<typeof setupUploads>, who: GatewayIdentity, fileName: string, b: Buffer) =>
  env.uploads.upload(ctx, who, { fileName, contentLength: b.length }, Readable.from([b]));

function setupUploads(opts: { maxConcurrentUploads?: number; idleMs?: number } = {}) {
  const base = setup();
  const store = new MemoryUploadStore();
  const incoming = softwareDir();
  const software = softwareDir();
  const queueRoot = mkdtempSync(path.join(tmpdir(), 'ita-sign-queue-'));
  const queue = new SignQueue(queueRoot);
  const uploads = new UploadService(store, new SoftwareFiles(incoming.root), queue, new SoftwareFiles(software.root), {
    now: base.clock.now,
    environment: 'test',
    maxBytes: 1024 * 1024,
    ...opts,
  });
  /** 模擬簽章工作站:讀工作單、把「重簽後」的檔案放進軟體庫、寫結果檔 */
  const workstation = (uploadId: string, patch: Record<string, unknown> = {}, signed = 'MZ-signed-by-company') => {
    const job = JSON.parse(readFileSync(path.join(queueRoot, `${uploadId}.json`), 'utf8')) as { file_name: string };
    const sha = software.put(job.file_name, signed);
    const result = {
      schema: 'sign-result/1',
      upload_id: uploadId,
      state: 'signed',
      vendor_signer: 'a'.repeat(40),
      vendor_signer_subject: 'CN=Don HO',
      vendor_check: 'allowlist',
      signed_file: job.file_name,
      signed_sha256: sha,
      signed_signer: SIGNER,
      signed_at: '2026-10-28T08:00:00Z',
      operator: 'GSMC\\signer',
      reject_code: null,
      reject_reason: null,
      ...patch,
    };
    writeFileSync(path.join(queueRoot, `${uploadId}.result.json`), JSON.stringify(result));
    return sha;
  };
  // P7 目錄共用同一個軟體庫與上傳紀錄(登錄時檢查上傳紀錄,資安審查 M1)
  const catalog = new SoftwareService(new MemorySoftwareStore(base.sql, new MemoryCommandStore(base.sql)), new SoftwareFiles(software.root), base.sql, {
    now: base.clock.now,
    uploads: store,
  });
  const register = (fileName: string, who = IT) =>
    catalog.register(ctx, who, { name: fileName.split('/')[0]!, version: fileName.split('/')[1]!, fileName, installerType: 'nsis', detectType: 'display_name', detectValue: 'Setup%' });
  return { ...base, store, incoming, software, queueRoot, queue, uploads, workstation, catalog, register };
}

describe('上傳與送簽(UploadService)', () => {
  let env: ReturnType<typeof setupUploads>;
  beforeEach(() => {
    env = setupUploads();
  });

  it('串流上傳:寫入 incoming、主機算雜湊、不覆蓋;超過上限 413;路徑格式錯誤 400', async () => {
    const body = Buffer.from('MZ-npp-original');
    const u = await send(env, IT, FILE, body);
    assert.equal(u.state, 'uploaded');
    assert.equal(u.source, 'upload');
    assert.equal(u.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(readFileSync(path.join(env.incoming.root, ...FILE.split('/'))).toString(), 'MZ-npp-original');
    // 暫存檔不留下
    assert.deepEqual(readdirSync(path.join(env.incoming.root, 'Notepad++', '8.7.1')), ['npp.8.7.1.Installer.x64.exe']);
    // 同路徑已有進行中的上傳:收檔前就擋
    await assert.rejects(send(env, IT, FILE, body), { code: 'ITA_UPLOAD_EXISTS' });
    // Content-Length 超過上限:收檔前就擋(不建目錄)
    await assert.rejects(send(env, IT, 'Big/1.0/big.exe', Buffer.alloc(1024 * 1024 + 1)), { code: 'ITA_UPLOAD_TOO_LARGE' });
    assert.equal(existsSync(path.join(env.incoming.root, 'Big')), false);
    // Content-Length 謊報:邊收邊數,超過就中止並刪暫存檔
    const big = Buffer.alloc(1024 * 1024 + 1);
    await assert.rejects(env.uploads.upload(ctx, IT, { fileName: 'Big/1.0/big.exe', contentLength: 10 }, Readable.from([big])), { code: 'ITA_UPLOAD_TOO_LARGE' });
    assert.deepEqual(readdirSync(path.join(env.incoming.root, 'Big', '1.0')), []);
    // 沒有 Content-Length
    await assert.rejects(env.uploads.upload(ctx, IT, { fileName: 'X/1.0/x.exe', contentLength: null }, Readable.from([body])), {
      code: 'ITA_UPLOAD_LENGTH_REQUIRED',
    });
    for (const bad of ['../x/1.0/a.exe', 'a/b.exe', 'a/1.0/a.txt', 'a/1.0/.hidden.exe'])
      await assert.rejects(send(env, IT, bad, body), { code: 'VALIDATION_FAILED' }, bad);
  });

  it('同時上傳上限 429;閒置逾時 408(暫存檔刪除)', async () => {
    const busy = setupUploads({ maxConcurrentUploads: 1, idleMs: 100 });
    const slow = new PassThrough();
    const first = busy.uploads.upload(ctx, IT, { fileName: 'Slow/1.0/slow.exe', contentLength: 10 }, slow);
    await new Promise((r) => setImmediate(r));
    await assert.rejects(send(busy, IT, 'Other/1.0/other.exe', Buffer.from('MZ')), { code: 'ITA_UPLOAD_BUSY' });
    slow.write('MZ');
    await assert.rejects(first, { code: 'ITA_UPLOAD_TIMEOUT' });
    assert.deepEqual(readdirSync(path.join(busy.incoming.root, 'Slow', '1.0')), []);
    // 逾時後名額釋放
    assert.equal((await send(busy, IT, 'Other/1.0/other.exe', Buffer.from('MZ'))).state, 'uploaded');
  });

  it('簽章工作站確認送簽狀態(signStatus):queued、上傳者與核可人、路徑與雜湊;找不到回 not_found', async () => {
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    assert.equal((await env.uploads.signStatus(ctx, u.uploadId)).state, 'uploaded');
    await env.uploads.approve(ctx, IT2, u.uploadId);
    assert.deepEqual(await env.uploads.signStatus(ctx, u.uploadId), {
      environment: 'test',
      uploadId: u.uploadId,
      state: 'queued',
      fileName: FILE,
      sha256: u.sha256,
      sizeBytes: 6,
      uploadedBy: 'S000001',
      approvedBy: 'S000002',
    });
    const none = randomUUID();
    assert.equal((await env.uploads.signStatus(ctx, none)).state, 'not_found');
    assert.equal((await env.uploads.signStatus(ctx, 'x')).state, 'not_found');
  });

  it('軟體庫已有同路徑 409;非全部公司角色 403', async () => {
    env.software.put(FILE, 'MZ-already');
    await assert.rejects(send(env, IT, FILE, Buffer.from('x')), { code: 'ITA_UPLOAD_FILE_EXISTS' });
    await assert.rejects(env.uploads.list({ ...ctx, scope: only('甲公司') }, {}), { code: 'ITA_SCOPE_ALL_REQUIRED' });
  });

  it('網路芳鄰放進 incoming 後登錄;未登錄清單只列沒有進行中紀錄的檔案;同路徑進行中再登錄 409', async () => {
    const sha = env.incoming.put('7-Zip/24.09/7z2409-x64.msi', 'MSI-7zip');
    assert.deepEqual(
      (await env.uploads.unregisteredIncoming(ctx)).items.map((f) => f.fileName),
      ['7-Zip/24.09/7z2409-x64.msi'],
    );
    const u = await env.uploads.registerIncoming(ctx, IT, { fileName: '7-Zip\\24.09\\7z2409-x64.msi', notes: ' 7-Zip 沒有廠商簽章 ' });
    assert.deepEqual([u.fileName, u.sha256, u.source, u.notes], ['7-Zip/24.09/7z2409-x64.msi', sha, 'incoming', '7-Zip 沒有廠商簽章']);
    assert.deepEqual((await env.uploads.unregisteredIncoming(ctx)).items, []);
    await assert.rejects(env.uploads.registerIncoming(ctx, IT, { fileName: '7-Zip/24.09/7z2409-x64.msi' }), { code: 'ITA_UPLOAD_EXISTS' });
    await assert.rejects(env.uploads.registerIncoming(ctx, IT, { fileName: 'None/1.0/none.exe' }), { code: 'ITA_UPLOAD_FILE_NOT_FOUND' });
  });

  it('核可送簽:上傳者不可核可;第二人核可寫工作單 → queued;重複核可 409', async () => {
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    await assert.rejects(env.uploads.approve(ctx, IT, u.uploadId), { code: 'ITA_UPLOAD_SAME_PERSON' });
    const q = await env.uploads.approve(ctx, IT2, u.uploadId);
    assert.equal(q.state, 'queued');
    assert.deepEqual(q.approvedBy, { emp: 'S000002', name: '核可人' });
    const job = JSON.parse(readFileSync(path.join(env.queueRoot, `${u.uploadId}.json`), 'utf8'));
    assert.deepEqual(job, {
      schema: 'sign-job/1',
      upload_id: u.uploadId,
      environment: 'test',
      file_name: FILE,
      sha256: u.sha256,
      size_bytes: 6,
      uploaded_by: 'S000001',
      approved_by: 'S000002',
      approved_at: '2026-10-06T08:00:00.000Z',
    });
    await assert.rejects(env.uploads.approve(ctx, IT2, u.uploadId), { code: 'ITA_UPLOAD_STATE' });
    await assert.rejects(env.uploads.approve(ctx, IT2, randomUUID()), { code: 'ITA_UPLOAD_NOT_FOUND' });
  });

  it('核可前 incoming 檔案被換掉 → 409 並標記 rejected / INCOMING_CHANGED,不寫工作單', async () => {
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    env.incoming.put(FILE, 'MZ-evil!');
    await assert.rejects(env.uploads.approve(ctx, IT2, u.uploadId), { code: 'ITA_UPLOAD_FILE_CHANGED' });
    assert.deepEqual([(await env.uploads.get(ctx, u.uploadId)).state, (await env.uploads.get(ctx, u.uploadId)).rejectCode], ['rejected', 'INCOMING_CHANGED']);
    assert.deepEqual(readdirSync(env.queueRoot), []);
  });

  it('駁回:uploaded / queued 可駁回(queued 時移除工作單);其他狀態 409', async () => {
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    await env.uploads.approve(ctx, IT2, u.uploadId);
    const r = await env.uploads.reject(ctx, IT2, u.uploadId, ' 版本錯誤 ');
    assert.deepEqual([r.state, r.rejectCode, r.rejectReason, r.rejectedByEmp], ['rejected', 'REJECTED', '版本錯誤', 'S000002']);
    assert.deepEqual(readdirSync(env.queueRoot), []);
    await assert.rejects(env.uploads.reject(ctx, IT2, u.uploadId, 'x'), { code: 'ITA_UPLOAD_STATE' });
  });

  it('刪除已駁回上傳的原始檔:紀錄保留並記錄刪除人;中斷上傳的舊暫存檔一併刪除;再刪 409;同路徑可重新上傳', async () => {
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    await env.uploads.reject(ctx, IT2, u.uploadId, '版本錯誤');
    const dir = path.join(env.incoming.root, 'Notepad++', '8.7.1');
    const stale = `.npp.8.7.1.Installer.x64.exe.part-${randomUUID()}`;
    const fresh = `.npp.8.7.1.Installer.x64.exe.part-${randomUUID()}`;
    writeFileSync(path.join(dir, stale), 'x');
    writeFileSync(path.join(dir, fresh), 'x');
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(path.join(dir, stale), old, old);
    const d = await env.uploads.deleteFile(ctx, IT2, u.uploadId);
    assert.deepEqual([d.state, d.fileDeletedByEmp, d.fileDeletedAt], ['rejected', 'S000002', '2026-10-06T08:00:00.000Z']);
    // 進行中的上傳(暫存檔剛寫入)不刪
    assert.deepEqual(readdirSync(dir), [fresh]);
    await assert.rejects(env.uploads.deleteFile(ctx, IT2, u.uploadId), { code: 'ITA_UPLOAD_FILE_DELETED' });
    assert.equal((await send(env, IT, FILE, Buffer.from('MZ-npp-2'))).state, 'uploaded');
  });

  it('刪除原始檔:同路徑換成大小不同的檔案 409 ITA_UPLOAD_FILE_MISMATCH(改從上傳區清單刪);檔案已不在但紀錄未記錄時補記錄', async () => {
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    await env.uploads.reject(ctx, IT2, u.uploadId, '版本錯誤');
    env.incoming.put(FILE, 'MZ-another-file');
    await assert.rejects(env.uploads.deleteFile(ctx, IT2, u.uploadId), { code: 'ITA_UPLOAD_FILE_MISMATCH' });
    assert.ok(existsSync(path.join(env.incoming.root, ...FILE.split('/'))));
    // 管理員已從主機刪掉檔案:從上傳區清單刪除時仍補記錄已駁回的紀錄;沒有可記錄的才 404
    unlinkSync(path.join(env.incoming.root, ...FILE.split('/')));
    assert.equal((await env.uploads.deleteIncomingFile(ctx, IT2, { fileName: FILE })).markedUploads, 1);
    assert.equal((await env.uploads.get(ctx, u.uploadId)).fileDeletedByEmp, 'S000002');
    await assert.rejects(env.uploads.deleteIncomingFile(ctx, IT2, { fileName: FILE }), { code: 'ITA_UPLOAD_FILE_NOT_FOUND' });
  });

  it('刪除原始檔的限制:uploaded / queued / signed 409;同路徑有進行中的上傳 409;非全部公司角色 403', async () => {
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    await assert.rejects(env.uploads.deleteFile(ctx, IT2, u.uploadId), { code: 'ITA_UPLOAD_STATE' });
    await assert.rejects(env.uploads.deleteIncomingFile(ctx, IT2, { fileName: FILE }), { code: 'ITA_UPLOAD_FILE_IN_USE' });
    await env.uploads.approve(ctx, IT2, u.uploadId);
    await assert.rejects(env.uploads.deleteFile(ctx, IT2, u.uploadId), { code: 'ITA_UPLOAD_STATE' });
    env.workstation(u.uploadId);
    await env.uploads.scanResults(ctx);
    assert.equal((await env.uploads.get(ctx, u.uploadId)).state, 'signed');
    await assert.rejects(env.uploads.deleteFile(ctx, IT2, u.uploadId), { code: 'ITA_UPLOAD_STATE' });
    // signed 的原始檔保留(保留期限待決,ADR 0005)
    await assert.rejects(env.uploads.deleteIncomingFile(ctx, IT2, { fileName: FILE }), { code: 'ITA_UPLOAD_FILE_IN_USE' });
    assert.ok(existsSync(path.join(env.incoming.root, ...FILE.split('/'))));
    await assert.rejects(env.uploads.deleteFile({ ...ctx, scope: only('甲公司') }, IT2, u.uploadId), { code: 'ITA_SCOPE_ALL_REQUIRED' });
    await assert.rejects(env.uploads.deleteFile(ctx, IT2, randomUUID()), { code: 'ITA_UPLOAD_NOT_FOUND' });
  });

  it('刪除 incoming 內的檔案:未登錄的直接刪;已駁回的紀錄一併記錄;找不到 404;路徑格式 400;資料夾 409', async () => {
    env.incoming.put('7-Zip/24.09/7z2409-x64.msi', 'MSI-7zip');
    assert.deepEqual(await env.uploads.deleteIncomingFile(ctx, IT, { fileName: '7-Zip\\24.09\\7z2409-x64.msi' }), {
      fileName: '7-Zip/24.09/7z2409-x64.msi',
      partsRemoved: 0,
      markedUploads: 0,
    });
    assert.deepEqual((await env.uploads.unregisteredIncoming(ctx)).items, []);
    await assert.rejects(env.uploads.deleteIncomingFile(ctx, IT, { fileName: '7-Zip/24.09/7z2409-x64.msi' }), { code: 'ITA_UPLOAD_FILE_NOT_FOUND' });
    await assert.rejects(env.uploads.deleteIncomingFile(ctx, IT, { fileName: 'None/1.0/none.exe' }), { code: 'ITA_UPLOAD_FILE_NOT_FOUND' });
    for (const bad of ['../x/1.0/a.exe', 'a/b.exe', 'a/1.0/a.txt', 'a/1.0/.npp.exe.part-x'])
      await assert.rejects(env.uploads.deleteIncomingFile(ctx, IT, { fileName: bad }), { code: 'VALIDATION_FAILED' }, bad);
    // 已駁回後檔案仍在(出現在未登錄清單):從清單刪除時,紀錄也記為已刪除
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    await env.uploads.reject(ctx, IT2, u.uploadId, '版本錯誤');
    assert.deepEqual((await env.uploads.unregisteredIncoming(ctx)).items.map((f) => f.fileName), [FILE]);
    assert.equal((await env.uploads.deleteIncomingFile(ctx, IT, { fileName: FILE })).markedUploads, 1);
    assert.equal((await env.uploads.get(ctx, u.uploadId)).fileDeletedByEmp, 'S000001');
    // 不是一般檔案(資料夾)不刪
    mkdirSync(path.join(env.incoming.root, 'Dir', '1.0', 'dir.exe'), { recursive: true });
    await assert.rejects(env.uploads.deleteIncomingFile(ctx, IT, { fileName: 'Dir/1.0/dir.exe' }), { code: 'ITA_UPLOAD_NOT_FILE' });
    assert.ok(existsSync(path.join(env.incoming.root, 'Dir', '1.0', 'dir.exe')));
  });

  it('啟動檢查:目錄存在且可寫才通過(探測檔不留下);不存在或不是資料夾丟錯', async () => {
    await assertWritableDir('SIGN_QUEUE_DIR', env.queueRoot);
    assert.deepEqual(readdirSync(env.queueRoot), []);
    await assert.rejects(assertWritableDir('SIGN_QUEUE_DIR', path.join(env.queueRoot, 'sign-queue01~')), /SIGN_QUEUE_DIR=.*ENOENT/);
    writeFileSync(path.join(env.queueRoot, 'file'), 'x');
    await assert.rejects(assertWritableDir('INCOMING_DIR', path.join(env.queueRoot, 'file')), /INCOMING_DIR=.*ENOTDIR/);
  });

  it('簽章結果:主機以軟體庫實際檔案重算,相符才 signed;之後 P7 登錄沿用(檔案在軟體庫)', async () => {
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    await env.uploads.approve(ctx, IT2, u.uploadId);
    assert.deepEqual(await env.uploads.scanResults(ctx), { signed: 0, rejected: 0 }, '還沒有結果檔');
    const sha = env.workstation(u.uploadId);
    assert.deepEqual(await env.uploads.scanResults(ctx), { signed: 1, rejected: 0 });
    const s = await env.uploads.get(ctx, u.uploadId);
    assert.deepEqual([s.state, s.signedSha256, s.signedSigner, s.vendorCheck, s.signOperator], ['signed', sha, SIGNER, 'allowlist', 'GSMC\\signer']);
    // 已 signed 的不再處理
    assert.deepEqual(await env.uploads.scanResults(ctx), { signed: 0, rejected: 0 });
  });

  it('簽章結果不符:回報雜湊與軟體庫不同、路徑不同、沒有重簽(與原始檔相同)→ rejected / RESULT_MISMATCH', async () => {
    const cases: [string, (id: string) => void][] = [
      ['雜湊不同', (id) => env.workstation(id, { signed_sha256: 'f'.repeat(64) })],
      ['路徑不同', (id) => env.workstation(id, { signed_file: 'Other/1.0/other.exe' })],
      ['沒有重簽', (id) => env.workstation(id, {}, 'MZ-npp')],
    ];
    for (const [name, act] of cases) {
      const file = `Case${cases.findIndex((c) => c[0] === name)}/1.0/setup.exe`;
      const u = await send(env, IT, file, Buffer.from('MZ-npp'));
      await env.uploads.approve(ctx, IT2, u.uploadId);
      act(u.uploadId);
      assert.deepEqual(await env.uploads.scanResults(ctx), { signed: 0, rejected: 1 }, name);
      assert.equal((await env.uploads.get(ctx, u.uploadId)).rejectCode, 'RESULT_MISMATCH', name);
    }
  });

  it('工作站拒絕 → rejected 並記錄代碼;結果檔格式錯誤保持 queued', async () => {
    const u = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    await env.uploads.approve(ctx, IT2, u.uploadId);
    writeFileSync(path.join(env.queueRoot, `${u.uploadId}.result.json`), '{ "schema": "sign-result/1", ');
    assert.deepEqual(await env.uploads.scanResults(ctx), { signed: 0, rejected: 0 });
    assert.equal((await env.uploads.get(ctx, u.uploadId)).state, 'queued');
    writeFileSync(
      path.join(env.queueRoot, `${u.uploadId}.result.json`),
      '\uFEFF' + JSON.stringify({ schema: 'sign-result/1', upload_id: u.uploadId, state: 'rejected', reject_code: 'VENDOR_NOT_ALLOWED', reject_reason: '原廠簽章者不在白名單' }),
    );
    assert.deepEqual(await env.uploads.scanResults(ctx), { signed: 0, rejected: 1 });
    const r = await env.uploads.get(ctx, u.uploadId);
    assert.deepEqual([r.state, r.rejectCode, r.rejectReason, r.rejectedByEmp], ['rejected', 'VENDOR_NOT_ALLOWED', '原廠簽章者不在白名單', null]);
  });

  it('P7 登錄對照上傳紀錄(M1):signed 且雜湊相符才可登錄;送簽中 / 已駁回 / 簽章後被換檔 409;沒有紀錄(過渡期)可登錄', async () => {
    // 送簽中:簽章人員提早把檔案放進軟體庫也不能登錄
    const q = await send(env, IT, FILE, Buffer.from('MZ-npp'));
    await env.uploads.approve(ctx, IT2, q.uploadId);
    env.software.put(FILE, 'MZ-early');
    await assert.rejects(env.register(FILE), { code: 'ITA_UPLOAD_NOT_SIGNED' });
    // 未登錄清單帶最新一筆上傳紀錄
    let files = await env.catalog.unregisteredFiles(ctx);
    assert.deepEqual(files.items.map((f) => [f.fileName, f.upload?.state]), [[FILE, 'queued']]);
    // 工作站拒絕:仍不能登錄
    writeFileSync(path.join(env.queueRoot, `${q.uploadId}.result.json`), JSON.stringify({ schema: 'sign-result/1', upload_id: q.uploadId, state: 'rejected', reject_code: 'VENDOR_NOT_ALLOWED' }));
    await env.uploads.scanResults(ctx);
    await assert.rejects(env.register(FILE), { code: 'ITA_UPLOAD_NOT_SIGNED' });

    // signed:可登錄,詳情帶上傳者、核可人、工作站回報的原廠簽章者
    const other = 'Other/2.0/setup.exe';
    const u = await send(env, IT, other, Buffer.from('MZ-other'));
    await env.uploads.approve(ctx, IT2, u.uploadId);
    env.workstation(u.uploadId);
    await env.uploads.scanResults(ctx);
    files = await env.catalog.unregisteredFiles(ctx);
    const ref = files.items.find((f) => f.fileName === other)!.upload!;
    assert.deepEqual([ref.state, ref.uploadedBy.emp, ref.approvedBy?.emp, ref.signedSigner], ['signed', IT.emp, IT2.emp, SIGNER]);
    const pkg = await env.register(other);
    const detail = await env.catalog.get(ctx, pkg.packageId);
    assert.deepEqual([detail.upload?.uploadId, detail.upload?.vendorSignerSubject], [u.uploadId, 'CN=Don HO']);

    // signed 之後軟體庫檔案被換掉:409
    const third = 'Third/3.0/setup.exe';
    const t = await send(env, IT, third, Buffer.from('MZ-third'));
    await env.uploads.approve(ctx, IT2, t.uploadId);
    env.workstation(t.uploadId);
    await env.uploads.scanResults(ctx);
    env.software.put(third, 'MZ-swapped');
    await assert.rejects(env.register(third), { code: 'ITA_UPLOAD_NOT_SIGNED' });

    // 沒有上傳紀錄(簽章人員直接放進軟體庫,S1 過渡期):可登錄,詳情 upload 為 null
    env.software.put('Direct/1.0/setup.exe', 'MZ-direct');
    const d = await env.register('Direct/1.0/setup.exe');
    assert.equal((await env.catalog.get(ctx, d.packageId)).upload, null);
  });

  it('parseSignResult:upload_id 必須一致、指紋與雜湊格式、reject_code 格式', () => {
    const id = randomUUID();
    const ok = { schema: 'sign-result/1', upload_id: id, state: 'signed', signed_file: FILE, signed_sha256: 'a'.repeat(64), signed_signer: SIGNER };
    assert.ok(parseSignResult(ok, id));
    assert.equal(parseSignResult(ok, randomUUID()), null);
    assert.equal(parseSignResult({ ...ok, signed_signer: 'XYZ' }, id), null);
    assert.equal(parseSignResult({ ...ok, signed_sha256: 'A'.repeat(64) }, id), null);
    assert.equal(parseSignResult({ ...ok, vendor_check: 'auto' }, id), null);
    assert.equal(parseSignResult({ schema: 'sign-result/1', upload_id: id, state: 'rejected', reject_code: 'bad code' }, id), null);
    assert.equal(parseSignResult([], id), null);
  });

  it('契約範例:sign-job / sign-result 範例與程式產生的欄位一致', () => {
    const job = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, 'examples', 'sign-job.sample.json'), 'utf8'));
    const result = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, 'examples', 'sign-result.sample.json'), 'utf8'));
    assert.deepEqual(Object.keys(job).sort(), ['approved_at', 'approved_by', 'environment', 'file_name', 'schema', 'sha256', 'size_bytes', 'upload_id', 'uploaded_by']);
    assert.ok(parseSignResult(result, result.upload_id), 'sign-result 範例要能通過 parseSignResult');
  });
});

describe('上傳與送簽 API(mgmt-app)', () => {
  it('串流上傳(application/octet-stream)、清單、OpenAPI 權限與擴充欄位', async () => {
    const env = setupUploads();
    const gateway = loadGatewayEnv({ GW_ENV: 'dev', SERVICE_CODE: 'endpoint-api', GW_JWKS_URL: 'http://127.0.0.1:1/jwks' });
    const app = await buildMgmtApp({
      config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken: true, scopeAllRoles: [] },
      service: env.service,
      uploads: env.uploads,
    });
    try {
      const url = `/v1/software/uploads?fileName=${encodeURIComponent(FILE)}`;
      let res = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('MZ-npp') });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().uploadedBy.emp, 'dev');
      res = await app.inject({ method: 'POST', url: `/v1/software/uploads?fileName=${encodeURIComponent('X/1.0/x.exe')}`, headers: { 'content-type': 'application/json' }, payload: '{}' });
      assert.equal(res.statusCode, 415);
      res = await app.inject('/v1/software/uploads?state=uploaded');
      assert.deepEqual(res.json().items.map((i: { fileName: string }) => i.fileName), [FILE]);
      const uploadId = res.json().items[0].uploadId as string;
      // 開發身分(devSkipToken)是上傳者,不能核可
      res = await app.inject({ method: 'POST', url: `/v1/software/uploads/${uploadId}/approve` });
      assert.deepEqual([res.statusCode, res.json().code], [403, 'ITA_UPLOAD_SAME_PERSON']);
      // 刪除原始檔(DELETE 不帶本體):待核可 409;駁回後 200
      res = await app.inject({ method: 'DELETE', url: `/v1/software/uploads/${uploadId}/file` });
      assert.deepEqual([res.statusCode, res.json().code], [409, 'ITA_UPLOAD_STATE']);
      await app.inject({ method: 'POST', url: `/v1/software/uploads/${uploadId}/reject`, payload: { reason: '測試' } });
      res = await app.inject({ method: 'DELETE', url: `/v1/software/uploads/${uploadId}/file` });
      assert.deepEqual([res.statusCode, res.json().fileDeletedByEmp], [200, 'dev'], res.body);
      env.incoming.put('7-Zip/24.09/7z2409-x64.msi', 'MSI-7zip');
      res = await app.inject({ method: 'DELETE', url: `/v1/software/uploads/incoming?fileName=${encodeURIComponent('7-Zip/24.09/7z2409-x64.msi')}` });
      assert.deepEqual([res.statusCode, res.json()], [200, { fileName: '7-Zip/24.09/7z2409-x64.msi', partsRemoved: 0, markedUploads: 0 }]);
      res = await app.inject({ method: 'DELETE', url: '/v1/software/uploads/incoming' });
      assert.equal(res.statusCode, 400);
      const doc = (await app.inject('/openapi.json')).json();
      const ops = Object.entries(doc.paths as Record<string, Record<string, Record<string, unknown>>>)
        .filter(([p]) => p.startsWith('/v1/software/uploads'))
        .flatMap(([, p]) => Object.values(p));
      assert.equal(ops.length, 10);
      for (const op of ops) {
        const id = String(op.operationId);
        // 簽章工作站的確認路由是系統對系統(API Key),其他是使用者路由
        if (id === 'endpoint.software.upload.sign-status') assert.deepEqual([op['x-auth-mode'], op['x-permission']], ['api_key', 'endpoint.software.sign-check']);
        else assert.equal(op['x-permission'], 'endpoint.software.manage', id);
      }
    } finally {
      await app.close();
    }
  });
});
