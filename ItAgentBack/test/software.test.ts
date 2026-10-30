/**
 * P7-1 軟體目錄與下載(docs/P7-SOFTWARE-DESIGN.md §1–§4、§6):參數白名單與偵測規則、軟體庫路徑、狀態機與兩人覆核、
 * draft 只能派 pilot、mark-tested 簽章者需等於回報值、參數快照、撤回、授權數、批次第二人核可(同人 403、24 小時逾期、駁回)、
 * 全域並行上限、套件下載 API(只給被指派、Range / 416、檔案被換掉 503、稽核)、管理 API。
 * 經記憶體儲存;SQL 語句由整合測試涵蓋。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, symlinkSync, writeFileSync, type ReadStream } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv, type GatewayIdentity } from '@giganexus/backend-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildAgentApp } from '../src/agent-app.js';
import { commandTimeoutSec } from '../src/commands/kinds.js';
import { buildMgmtApp } from '../src/mgmt-app.js';
import { APPROVAL_WINDOW_MS, deferredOf } from '../src/services/command-dispatcher.js';
import { SoftwareFiles, splitSoftwarePath } from '../src/services/software-files.js';
import {
  argsErrors,
  reportedVersion,
  deployDenied,
  detectErrors,
  displayNameLike,
  DOWNLOADS_PER_DEVICE,
  installSnapshot,
  qualifyingSigners,
  type Download,
  type RegisterPackageInput,
} from '../src/services/software-service.js';
import type { DeviceRecord, InstallerType, InstallResultRow, PackageRecord } from '../src/stores/types.js';
import { ALL, CONTRACTS_DIR, FakeConnection, inventoryRequest, only } from './helpers.js';
import { PKG_SIGNER, setupSoftware, softwareDir } from './software-helpers.js';

const log = Fastify({ logger: { level: 'silent' } }).log;
const ctx = { log, requestId: 'req-sw-1', scope: ALL };
const IT: GatewayIdentity = { sub: '1', emp: 'S000001', name: '登錄人' };
const REVIEWER: GatewayIdentity = { sub: '2', emp: 'S000002', name: '覆核人' };
const THIRD: GatewayIdentity = { sub: '3', emp: 'S000003', name: '第三人' };
const FOURTH: GatewayIdentity = { sub: '4', emp: 'S000004', name: '第四人' };
const FILE = '7-Zip/24.09/7z2409-x64.msi';
const CONTENT = 'MSI-7zip-24.09';

const pkg = (p: Partial<PackageRecord> = {}): PackageRecord => ({
  id: 1,
  packageId: '11111111-2222-4333-8444-555555555555',
  name: '7-Zip',
  version: '24.09',
  fileName: FILE,
  sha256: 'a'.repeat(64),
  sizeBytes: 10,
  installerType: 'msi',
  installArgs: 'ALLUSERS=1',
  uninstallArgs: null,
  detectType: 'display_name',
  detectValue: '7-Zip%',
  rebootPolicy: 'never',
  timeoutSec: 1800,
  signerThumbprints: [],
  observedSigners: [],
  licenseLimit: null,
  status: 'draft',
  notes: null,
  createdByEmp: 'S000001',
  createdByName: null,
  createdAt: new Date(0),
  updatedByEmp: null,
  updatedAt: null,
  editors: [],
  testedByEmp: null,
  testedAt: null,
  publishedByEmp: null,
  publishedByName: null,
  publishedAt: null,
  revokedByEmp: null,
  revokedAt: null,
  revokedFrom: null,
  ...p,
});

describe('參數白名單、偵測規則、軟體庫路徑(純函式)', () => {
  it('B-1:主機的指令逾時(commandTimeoutSec):software.* 依快照 timeout_sec 加寬,其他類型不變', () => {
    assert.equal(commandTimeoutSec('software.install', { timeout_sec: 1800 }), 4 * 3600);
    assert.equal(commandTimeoutSec('software.install', JSON.stringify({ timeout_sec: 7200 })), 4 * 3600 + 5400);
    assert.equal(commandTimeoutSec('software.install', { timeout_sec: 300 }), 4 * 3600, '較短不縮減');
    assert.equal(commandTimeoutSec('software.install', { timeout_sec: 999999 }), 4 * 3600 + 5400, '超過上限以 7200 計');
    assert.equal(commandTimeoutSec('software.install', '{not json'), 4 * 3600);
    assert.equal(commandTimeoutSec('software.install', {}), 4 * 3600, '舊快照沒有 timeout_sec');
    assert.equal(commandTimeoutSec('software.uninstall', { timeout_sec: 3600 }), 3600 + 1800);
    assert.equal(commandTimeoutSec('system.reboot', { timeout_sec: 7200 }), 1800, '非軟體派送不看 timeout_sec');
    assert.equal(commandTimeoutSec('unknown.kind', {}), 600);
  });

  it('L2:REMOVE=ALL(安裝變成移除整個產品)一律拒絕;REMOVE={產品代碼} / 功能名稱可用', () => {
    for (const [t, bad] of [
      ['msi', 'REMOVE=ALL'],
      ['msi', 'remove=all'],
      ['msi', 'REMOVE="ALL"'],
      ['msi', 'ALLUSERS=1 REMOVE=Feature1,ALL'],
      ['burn', 'REMOVE=ALL'],
      [undefined, 'REMOVE=All'],
    ] as const)
      assert.equal(argsErrors('installArgs', bad, t).length, 1, `應拒絕:${bad}`);
    assert.deepEqual(argsErrors('uninstallArgs', 'REMOVE=ALL', 'msi').length, 1, '移除參數也拒絕');
    assert.deepEqual(argsErrors('installArgs', 'REMOVE=Feature1', 'msi'), []);
    assert.deepEqual(argsErrors('installArgs', 'REMOVE=ALLFEATURES', 'msi'), [], '只擋 ALL 本身');
    // 資安 M1:/v 黏著把參數轉交 msiexec;Inno 的 /VERYSILENT 不受影響
    for (const bad of ['/s /vREMOVE=ALL', '-vREMOVE=ALL', '/s /v/qn']) assert.equal(argsErrors('installArgs', bad, 'exe').length, 1, `應拒絕:${bad}`);
    assert.deepEqual(argsErrors('installArgs', '/VERYSILENT /NORESTART', 'inno'), []);
    // 資安 L3:Agent 回報的版本字串去控制 / 雙向字元並限長
    assert.equal(reportedVersion('8.9‮8'), '8.98');
    assert.equal(reportedVersion('1'.repeat(80))?.length, 50);
    assert.equal(reportedVersion(5), null);
  });

  it('安裝參數:白名單字元、長度、不可指到其他檔案、不可含機密', () => {
    assert.deepEqual(argsErrors('installArgs', 'ALLUSERS=1 INSTALLDIR="C:/Program Files/7-Zip" /norestart'), []);
    assert.deepEqual(argsErrors('installArgs', ''), []);
    assert.deepEqual(argsErrors('installArgs', null), []);
    for (const bad of ['a & calc', 'x | y', 'a;b', 'a > b', 'a`b', '$env', 'C:\\x', 'a\nb', '^x'])
      assert.equal(argsErrors('installArgs', bad).length, 1, `應拒絕:${JSON.stringify(bad)}`);
    assert.equal(argsErrors('installArgs', 'x'.repeat(501)).length, 1);
    for (const bad of ['TRANSFORMS=evil.mst', '/i other.msi', 'RUN=calc.exe', 'x.ps1', 'PATCH=a.MSP'])
      assert.equal(argsErrors('installArgs', bad).length, 1, `應拒絕:${bad}`);
    for (const bad of ['PIDKEY=XXXXX', 'PASSWORD=1', 'api-key: 1', 'Token=1', 'PRODUCTKEY = A'])
      assert.equal(argsErrors('installArgs', bad).length, 1, `應拒絕:${bad}`);
  });

  it('D3:install-args.vectors.json(與 Agent 共用):依安裝程式類型、不可讀寫外部檔案、路徑只限 Program Files', () => {
    type Vec = { installer_type: InstallerType | null; args: string; why?: string };
    const v = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, 'install-args.vectors.json'), 'utf8')) as { valid: Vec[]; invalid: Vec[] };
    for (const x of v.valid) assert.deepEqual(argsErrors('installArgs', x.args, x.installer_type ?? undefined), [], `應接受(${x.installer_type}):${x.args}`);
    for (const x of v.invalid)
      assert.equal(argsErrors('installArgs', x.args, x.installer_type ?? undefined).length, 1, `應拒絕(${x.installer_type},${x.why}):${x.args}`);
  });

  it('偵測規則:MSI 產品代碼格式;DisplayName 單行、至少 3 個非 % 字元;LIKE 跳脫保留 %', () => {
    assert.deepEqual(detectErrors('msi_product_code', '{23170F69-40C1-2702-2409-000001000000}'), []);
    assert.equal(detectErrors('msi_product_code', '23170F69-40C1-2702-2409-000001000000').length, 1);
    assert.deepEqual(detectErrors('display_name', '7-Zip%'), []);
    assert.equal(detectErrors('display_name', '%').length, 1);
    assert.equal(detectErrors('display_name', '%a%').length, 1);
    assert.equal(detectErrors('display_name', 'a\nb').length, 1);
    assert.equal(displayNameLike('Notepad++ (64-bit x64)%'), 'Notepad++ (64-bit x64)%');
    assert.equal(displayNameLike('a_b[c]\\%'), 'a\\_b\\[c]\\\\%');
  });

  it('軟體庫路徑:固定三段、每段白名單、\\ 視同 /、.msi / .exe', () => {
    assert.deepEqual(splitSoftwarePath('Notepad++/8.7.1/npp.8.7.1.Installer.x64.exe'), ['Notepad++', '8.7.1', 'npp.8.7.1.Installer.x64.exe']);
    assert.deepEqual(splitSoftwarePath('7-Zip\\24.09\\7z2409-x64.msi'), ['7-Zip', '24.09', '7z2409-x64.msi']);
    for (const bad of [
      '../x/y.msi',
      '7-Zip/../y.msi',
      '7-Zip/24.09/../../etc.msi',
      '7-Zip/24.09/a.zip',
      '7-Zip/a.msi',
      'a/b/c/d.msi',
      '.x/1/a.msi',
      'a/1./a.msi',
      'a/1/a .msi ',
      'a:b/1/a.msi',
    ])
      assert.equal(splitSoftwarePath(bad), null, bad);
  });

  it('派送限制:revoked 不能安裝可移除;draft / tested 只能 pilot', () => {
    assert.equal(deployDenied(pkg({ status: 'published' }), 'all', 'install'), null);
    assert.equal(deployDenied(pkg({ status: 'draft' }), 'all', 'install')?.code, 'ITA_PACKAGE_NOT_PUBLISHED');
    assert.equal(deployDenied(pkg({ status: 'tested' }), 'it', 'uninstall')?.code, 'ITA_PACKAGE_NOT_PUBLISHED');
    assert.equal(deployDenied(pkg({ status: 'draft' }), 'pilot', 'install'), null);
    assert.equal(deployDenied(pkg({ status: 'revoked' }), 'pilot', 'install')?.code, 'ITA_PACKAGE_REVOKED');
    assert.equal(deployDenied(pkg({ status: 'revoked', revokedFrom: 'published' }), 'all', 'uninstall'), null);
    // C1:未曾發佈就撤回,移除參數沒有經過覆核,只限 pilot
    assert.equal(deployDenied(pkg({ status: 'revoked', revokedFrom: 'draft' }), 'all', 'uninstall')?.code, 'ITA_PACKAGE_NOT_PUBLISHED');
    assert.equal(deployDenied(pkg({ status: 'revoked', revokedFrom: 'tested' }), 'pilot', 'uninstall'), null);
  });

  it('測試依據:pilot、succeeded、偵測通過、快照與目前目錄一致才算', () => {
    const p = pkg();
    const snap = JSON.stringify(installSnapshot(p));
    const row = (r: Partial<InstallResultRow>): InstallResultRow => ({
      commandId: 'c1',
      deviceId: 'd',
      computerName: 'PC',
      deviceCompany: null,
      ring: 'pilot',
      state: 'succeeded',
      params: snap,
      resultSummary: JSON.stringify({ exit_code: 0, signer: PKG_SIGNER.toUpperCase(), detected: true }),
      errorCode: null,
      createdByEmp: 'S1',
      finishedAt: null,
      ...r,
    });
    assert.deepEqual(qualifyingSigners(p, [row({})]), { commandIds: ['c1'], signers: [PKG_SIGNER] });
    assert.deepEqual(qualifyingSigners(p, [row({ ring: 'all' })]).commandIds, []);
    assert.deepEqual(qualifyingSigners(p, [row({ state: 'failed' })]).commandIds, []);
    assert.deepEqual(qualifyingSigners(p, [row({ resultSummary: JSON.stringify({ signer: PKG_SIGNER, detected: false }) })]).commandIds, []);
    assert.deepEqual(qualifyingSigners({ ...p, installArgs: 'ALLUSERS=2' }, [row({})]).commandIds, [], '參數已改');
    assert.deepEqual(qualifyingSigners({ ...p, sha256: 'b'.repeat(64) }, [row({})]).commandIds, [], '檔案不同');
  });

  it('軟體庫:實際位置必須在根目錄內(符號連結指到外面不接受);大小上限', async (t) => {
    const dir = softwareDir();
    const outside = softwareDir();
    dir.put(FILE, CONTENT);
    outside.put('x/1/evil.msi', 'evil');
    const files = new SoftwareFiles(dir.root, 1024);
    assert.ok(await files.resolve(FILE));
    try {
      symlinkSync(path.join(outside.root, 'x'), path.join(dir.root, 'Evil'), 'junction');
    } catch {
      t.skip('無法建立符號連結');
      return;
    }
    assert.equal(await files.resolve('Evil/1/evil.msi'), null);
    dir.put('Big/1/big.exe', Buffer.alloc(2048));
    assert.equal(await files.resolve('Big/1/big.exe'), null, '超過大小上限');
    assert.deepEqual(
      (await files.list()).map((f) => f.fileName),
      [FILE],
    );
  });

  it('L4:resolve 之後檔案被換掉,開檔時 503;開檔後雜湊與內容讀同一個檔案代號', async () => {
    const dir = softwareDir();
    dir.put(FILE, CONTENT);
    const files = new SoftwareFiles(dir.root);
    const f = (await files.resolve(FILE))!;
    dir.put(FILE, 'MSI-replaced-longer');
    await assert.rejects(files.openChecked(f), { code: 'ITA_FILES_CHANGED' });
    const g = (await files.resolve(FILE))!;
    const opened = await files.openChecked(g);
    assert.equal(await opened.sha256(), createHash('sha256').update('MSI-replaced-longer').digest('hex'));
    const chunks: Buffer[] = [];
    for await (const c of opened.stream({ start: 4, end: 11 })) chunks.push(c as Buffer);
    assert.equal(Buffer.concat(chunks).toString(), 'replaced');
  });
});

describe('軟體目錄、覆核與派送(SoftwareService + CommandDispatcher)', () => {
  let env: ReturnType<typeof setupSoftware>;
  let pilot: DeviceRecord;
  let other: DeviceRecord;
  let sha: string;

  const register = (patch: Partial<RegisterPackageInput> = {}, who = IT) =>
    env.software.register(ctx, who, {
      name: '7-Zip',
      version: '24.09',
      fileName: FILE,
      installerType: 'msi',
      installArgs: 'ALLUSERS=1',
      detectType: 'display_name',
      detectValue: '7-Zip%',
      ...patch,
    });
  const online = async (d: DeviceRecord) => {
    const conn = new FakeConnection();
    await env.service.connected(ctx, d, conn);
    return conn;
  };
  const install = (d: DeviceRecord, packageId: string, who = IT) =>
    env.commands.create(ctx, who, 'admin', d.deviceId, { kind: 'software.install', params: { packageId } });
  /** Agent 回報安裝成功(簽章者) */
  const succeed = async (d: DeviceRecord, commandId: string, signer = PKG_SIGNER) => {
    await env.commands.onUpdate(ctx, d.id, { command_id: commandId, state: 'acked' });
    return env.commands.onUpdate(ctx, d.id, {
      command_id: commandId,
      state: 'succeeded',
      result: { exit_code: 0, reboot_required: false, signer, signer_subject: 'CN=Example', detected: true, already_installed: false, installed_version: '24.09.00.0', previous_version: '21.07' },
    });
  };
  const addDevice = async (cn: string, n: number) => env.service.identify(ctx, `O=GigaNexus Dev,CN=${cn}`, n.toString(16).padStart(40, '0'));

  beforeEach(async () => {
    env = setupSoftware();
    pilot = await addDevice('PC-PILOT', 1);
    other = await addDevice('PC-OTHER', 2);
    env.store.ringOf.set(pilot.id, 'pilot');
    sha = env.dir.put(FILE, CONTENT);
  });

  it('登錄:主機算 SHA-256 與大小、路徑正規化、draft;重複 409;檔案不存在 404;非全部公司 403;欄位錯誤 400', async () => {
    const r = await env.software.register(ctx, IT, {
      name: '7-Zip',
      version: '24.09',
      fileName: '7-Zip\\24.09\\7z2409-x64.msi',
      installerType: 'msi',
      detectType: 'display_name',
      detectValue: '7-Zip%',
    });
    assert.deepEqual([r.status, r.sha256, r.sizeBytes, r.fileName, r.signerThumbprints], ['draft', sha, CONTENT.length, FILE, []]);
    await assert.rejects(register(), { code: 'ITA_PACKAGE_EXISTS' });
    await assert.rejects(register({ version: '24.10', fileName: '7-Zip/24.10/7z.msi' }), { code: 'ITA_PACKAGE_FILE_NOT_FOUND' });
    await assert.rejects(env.software.register({ ...ctx, scope: only('甲公司') }, IT, { ...r, fileName: FILE } as RegisterPackageInput), {
      code: 'ITA_SCOPE_ALL_REQUIRED',
    });
    await assert.rejects(register({ version: '1', installerType: 'inno' }), { code: 'VALIDATION_FAILED' }, '副檔名與類型不符');
    await assert.rejects(register({ version: '2', installArgs: 'A=1 & calc' }), { code: 'VALIDATION_FAILED' });
    await assert.rejects(register({ version: '3', detectType: 'msi_product_code', detectValue: '{23170F69-40C1-2702-2409-000001000000}', licenseLimit: 10 }), {
      code: 'VALIDATION_FAILED',
    });
    await assert.rejects(register({ version: '4', fileName: '../x/7z.msi' }), { code: 'VALIDATION_FAILED' });
    // B-1:安裝逾時 300–7200 秒(登錄省略 = 1800)
    assert.equal(r.timeoutSec, 1800);
    for (const timeoutSec of [299, 7201, 1800.5]) await assert.rejects(register({ version: '5', timeoutSec }), { code: 'VALIDATION_FAILED' }, `逾時 ${timeoutSec}`);
    assert.deepEqual((await env.software.unregisteredFiles(ctx)).items, []);
  });

  it('B-1:安裝逾時寫入快照(安裝與移除);修改逾時不退回 draft;主機的指令逾時依套件逾時加寬', async () => {
    const r = await register({ timeoutSec: 300 });
    await online(pilot);
    const a = await install(pilot, r.packageId);
    assert.equal((a.params as { timeout_sec: number }).timeout_sec, 300);
    // 300 不縮減類型的 4 小時(含下載)
    await env.commands.onUpdate(ctx, pilot.id, { command_id: a.commandId, state: 'acked' });
    const acked = env.commandStore.commands.find((c) => c.commandId === a.commandId)!;
    assert.equal(acked.timeoutAt!.getTime() - acked.ackedAt!.getTime(), 4 * 3600 * 1000);
    await succeed(pilot, a.commandId);
    // B-2:詳情的測試機結果顯示 Agent 偵測到的版本
    const tr = (await env.software.get(ctx, r.packageId)).testResults[0]!;
    assert.deepEqual([tr.installedVersion, tr.previousVersion, tr.alreadyInstalled], ['24.09.00.0', '21.07', false]);
    // B-5:畫面依此停用發佈
    assert.equal((await env.software.get(ctx, r.packageId)).viewerScopeAll, true);
    assert.equal((await env.software.get({ ...ctx, scope: only('甲公司') }, r.packageId)).viewerScopeAll, false);
    await env.software.markTested(ctx, IT, r.packageId, [PKG_SIGNER]);
    const u = await env.software.update(ctx, IT, r.packageId, { timeoutSec: 7200 });
    assert.deepEqual([u.status, u.timeoutSec], ['tested', 7200], '逾時不需重新覆核');
    await assert.rejects(env.software.update(ctx, IT, r.packageId, { timeoutSec: 100 }), { code: 'VALIDATION_FAILED' });
    const b = await install(pilot, r.packageId);
    assert.equal((b.params as { timeout_sec: number }).timeout_sec, 7200);
    await env.commands.onUpdate(ctx, pilot.id, { command_id: b.commandId, state: 'running', progress: 0 });
    const running = env.commandStore.commands.find((c) => c.commandId === b.commandId)!;
    assert.equal(running.timeoutAt!.getTime() - running.startedAt!.getTime(), (4 * 3600 + 7200 - 1800) * 1000, '超過 1800 的部分加上');
    const c = await env.commands.create(ctx, IT, 'admin', pilot.deviceId, { kind: 'software.uninstall', params: { packageId: r.packageId } });
    assert.equal((c.params as { timeout_sec: number }).timeout_sec, 7200);
  });

  it('A6 延後中(Agent 0.9.3):running 帶 result.deferred → 暫存延後狀態、重設執行逾時;不帶 deferred 的 running 清除', async () => {
    const r = await register();
    await online(pilot);
    const a = await install(pilot, r.packageId);
    await env.commands.onUpdate(ctx, pilot.id, { command_id: a.commandId, state: 'acked' });
    const cmd = env.commandStore.commands.find((c) => c.commandId === a.commandId)!;
    const old = new Date(0);
    cmd.timeoutAt = old;
    const next = '2026-10-27T08:05:00Z';
    await env.commands.onUpdate(ctx, pilot.id, {
      command_id: a.commandId,
      state: 'running',
      progress: 0,
      result: { deferred: { reason: 'battery', next_check_at: next, extra: 'x'.repeat(5000) } },
    });
    assert.deepEqual(JSON.parse(cmd.resultSummary!), { deferred: { reason: 'battery', next_check_at: '2026-10-27T08:05:00.000Z' } }, '只存原因代碼與時間');
    assert.ok(cmd.timeoutAt!.getTime() > old.getTime() + 3 * 3600 * 1000, '延後期間重設執行逾時');
    // 重設有上限:開始 + 4 小時 + 類型逾時(資安 M1:不能一直延後佔住名額)
    cmd.startedAt = new Date(0);
    await env.commands.onUpdate(ctx, pilot.id, { command_id: a.commandId, state: 'running', progress: 0, result: { deferred: { reason: 'metered', next_check_at: next } } });
    assert.equal(cmd.timeoutAt!.getTime(), 4 * 3600 * 1000 + 4 * 3600 * 1000);
    // 解除:不帶 deferred 的 running 清除延後狀態
    await env.commands.onUpdate(ctx, pilot.id, { command_id: a.commandId, state: 'running', progress: 10 });
    assert.equal(cmd.resultSummary, null);
    // 進入下載後不再接受延後
    await env.commands.onUpdate(ctx, pilot.id, { command_id: a.commandId, state: 'running', progress: 0, result: { deferred: { reason: 'battery', next_check_at: next } } });
    assert.equal(cmd.resultSummary, null);
    // 不認得的原因 / 時間不採用
    await env.commands.onUpdate(ctx, pilot.id, { command_id: a.commandId, state: 'running', result: { deferred: { reason: 'other', next_check_at: next } } });
    assert.equal(cmd.resultSummary, null);
    await succeed(pilot, a.commandId);
    assert.equal(JSON.parse(cmd.resultSummary!).deferred, undefined, '終態的 result 覆寫');
  });

  it('deferredOf:原因只收 battery / metered、時間要能解析', () => {
    assert.deepEqual(deferredOf({ deferred: { reason: 'metered', next_check_at: '2026-10-27T08:05:00+08:00' } }), {
      reason: 'metered',
      next_check_at: '2026-10-27T00:05:00.000Z',
    });
    for (const bad of [undefined, {}, { deferred: 'battery' }, { deferred: { reason: 'battery' } }, { deferred: { reason: 'battery', next_check_at: 'soon' } }, { deferred: { reason: '<b>', next_check_at: '2026-10-27T08:05:00Z' } }])
      assert.equal(deferredOf(bad), null, JSON.stringify(bad));
  });

  it('draft 只能派到 pilot;參數換成目錄快照(Agent 只信任快照)', async () => {
    const r = await register();
    await assert.rejects(install(other, r.packageId), { code: 'ITA_PACKAGE_NOT_PUBLISHED' });
    assert.equal(env.commandStore.commands.length, 0, '檢查失敗不建立');
    const conn = await online(pilot);
    const cmd = await install(pilot, r.packageId);
    assert.equal(cmd.state, 'sent');
    assert.deepEqual(cmd.params, {
      package_id: r.packageId,
      name: '7-Zip',
      version: '24.09',
      url: `/agent/v1/packages/${r.packageId}`,
      sha256: sha,
      size_bytes: CONTENT.length,
      installer_type: 'msi',
      install_args: 'ALLUSERS=1',
      signer_thumbprints: [],
      detect: { type: 'display_name', value: '7-Zip%' },
      timeout_sec: 1800,
      reboot_policy: 'never',
    });
    assert.deepEqual(conn.sent.find((m) => m.type === 'command')!.body.params, cmd.params);
    await assert.rejects(env.commands.create(ctx, IT, 'admin', pilot.deviceId, { kind: 'software.install', params: { packageId: r.packageId, url: 'x' } }), {
      code: 'VALIDATION_FAILED',
    });
    await assert.rejects(env.commands.create(ctx, IT, 'basic', pilot.deviceId, { kind: 'software.install', params: { packageId: r.packageId } }), {
      code: 'ENDPOINT_COMMAND_LEVEL_MISMATCH',
    });
    await assert.rejects(install(pilot, '00000000-0000-4000-8000-000000000000'), { code: 'ITA_PACKAGE_NOT_FOUND' });
  });

  it('M5:未發佈的套件派到測試機需全部公司角色', async () => {
    const r = await register();
    env.sql.byId(pilot.id).company = '甲公司';
    await assert.rejects(env.commands.create({ ...ctx, scope: only('甲公司') }, IT, 'admin', pilot.deviceId, { kind: 'software.install', params: { packageId: r.packageId } }), {
      code: 'ITA_SCOPE_ALL_REQUIRED',
    });
    assert.equal((await install(pilot, r.packageId)).kind, 'software.install');
  });

  it('mark-tested:需 pilot 安裝成功;簽章者需等於回報值;發佈需第二人;改參數退回 draft', async () => {
    const r = await register();
    await assert.rejects(env.software.markTested(ctx, IT, r.packageId, [PKG_SIGNER]), { code: 'ITA_PACKAGE_NOT_TESTED' });
    await online(pilot);
    const cmd = await install(pilot, r.packageId);
    await succeed(pilot, cmd.commandId, PKG_SIGNER.toUpperCase());
    await assert.rejects(env.software.markTested(ctx, IT, r.packageId, ['c'.repeat(40)]), { code: 'ITA_SIGNER_NOT_OBSERVED' });
    await assert.rejects(env.software.markTested(ctx, IT, r.packageId, []), { code: 'VALIDATION_FAILED' });
    const tested = await env.software.markTested(ctx, IT, r.packageId, [PKG_SIGNER.toUpperCase()]);
    assert.deepEqual([tested.status, tested.signerThumbprints, tested.observedSigners, tested.testedByEmp], ['tested', [PKG_SIGNER], [PKG_SIGNER], 'S000001']);
    await assert.rejects(env.software.markTested(ctx, IT, r.packageId, [PKG_SIGNER]), { code: 'ITA_PACKAGE_STATUS' });
    // 第二人覆核
    await assert.rejects(env.software.publish(ctx, IT, r.packageId), { code: 'ITA_REVIEWER_SAME_AS_CREATOR' });
    await assert.rejects(env.software.publish({ ...ctx, scope: only('甲公司') }, REVIEWER, r.packageId), { code: 'ITA_SCOPE_ALL_REQUIRED' });
    const pub = await env.software.publish(ctx, REVIEWER, r.packageId);
    assert.deepEqual([pub.status, pub.publishedBy?.emp], ['published', 'S000002']);
    await assert.rejects(env.software.publish(ctx, REVIEWER, r.packageId), { code: 'ITA_PACKAGE_STATUS' });
    // 已發佈:可派任何電腦,快照帶簽章者
    const c2 = await install(other, r.packageId);
    assert.deepEqual(c2.params.signer_thumbprints, [PKG_SIGNER]);
    // 改授權數不退回;改安裝參數退回 draft(清除簽章者與覆核),之前的測試結果不再作為依據
    assert.equal((await env.software.update(ctx, IT, r.packageId, { licenseLimit: 100, notes: '說明' })).status, 'published');
    const back = await env.software.update(ctx, IT, r.packageId, { installArgs: 'ALLUSERS=2' });
    assert.deepEqual([back.status, back.signerThumbprints, back.publishedBy, back.testedByEmp], ['draft', [], null, null]);
    await assert.rejects(env.software.markTested(ctx, IT, r.packageId, [PKG_SIGNER]), { code: 'ITA_PACKAGE_NOT_TESTED' });
    await assert.rejects(install(other, r.packageId), { code: 'ITA_PACKAGE_NOT_PUBLISHED' });
    const detail = await env.software.get(ctx, r.packageId);
    assert.equal(detail.testResults.length, 1, '只列 pilot 的結果');
    assert.deepEqual([detail.testResults[0]!.signer, detail.testResults[0]!.qualifies], [PKG_SIGNER.toUpperCase(), false]);
  });

  it('D2-2:最後修改安裝參數 / 偵測規則的人不能發佈;只改說明 / 授權數不算', async () => {
    const r = await register();
    // 覆核人改了安裝參數 → 之後不能由他發佈(登錄人也不行),要第三人
    const edited = await env.software.update(ctx, REVIEWER, r.packageId, { installArgs: 'ALLUSERS=2' });
    assert.deepEqual(edited.editors, ['S000002']);
    await env.software.update(ctx, THIRD, r.packageId, { notes: '只改說明' });
    assert.deepEqual((await env.software.get(ctx, r.packageId)).editors, ['S000002'], '改說明不記為參數修改人');
    // 多人修改:第三人改偵測規則後,覆核人(先前改過參數)仍不能發佈
    assert.deepEqual((await env.software.update(ctx, THIRD, r.packageId, { detectValue: '7-Zip 2%' })).editors, ['S000002', 'S000003']);
    await env.software.update(ctx, THIRD, r.packageId, { detectValue: '7-Zip%' });
    await online(pilot);
    const cmd = await install(pilot, r.packageId);
    await succeed(pilot, cmd.commandId, PKG_SIGNER);
    await env.software.markTested(ctx, IT, r.packageId, [PKG_SIGNER]);
    await assert.rejects(env.software.publish(ctx, REVIEWER, r.packageId), { code: 'ITA_REVIEWER_SAME_AS_EDITOR' });
    await assert.rejects(env.software.publish(ctx, IT, r.packageId), { code: 'ITA_REVIEWER_SAME_AS_CREATOR' });
    await assert.rejects(env.software.publish(ctx, THIRD, r.packageId), { code: 'ITA_REVIEWER_SAME_AS_EDITOR' });
    await assert.rejects(env.software.publish(ctx, { sub: 'client:bot' } as GatewayIdentity, r.packageId), { code: 'ITA_REVIEWER_NOT_PERSON' });
    assert.equal((await env.software.publish(ctx, FOURTH, r.packageId)).publishedBy?.emp, 'S000004');
    // 已發佈後再修改:修改人重設為這一次的人
    assert.deepEqual((await env.software.update(ctx, IT, r.packageId, { rebootPolicy: 'required' })).editors, ['S000001'], '改重開機政策也要重新覆核');
  });

  it('software_install_failed:安裝失敗開告警;同一套件再派送成功自動關閉;逾時也算失敗', async () => {
    const r = await register();
    await online(pilot);
    const open = () => env.monitor.alerts.filter((a) => a.rule === 'software_install_failed' && a.state === 'open');
    const c1 = await install(pilot, r.packageId);
    await env.commands.onUpdate(ctx, pilot.id, { command_id: c1.commandId, state: 'failed', error_code: 'INSTALL_FAILED', result: { exit_code: 1603 } });
    assert.equal(open().length, 1);
    assert.deepEqual(JSON.parse(open()[0]!.detail ?? '{}'), {
      packageId: r.packageId,
      name: '7-Zip',
      version: '24.09',
      commandId: c1.commandId,
      errorCode: 'INSTALL_FAILED',
      exitCode: 1603,
    });
    const c2 = await install(pilot, r.packageId);
    await succeed(pilot, c2.commandId);
    assert.equal(open().length, 0, '同一套件成功後自動關閉');
    // 執行逾時(sweep → failed TIMEOUT)
    const c3 = await install(pilot, r.packageId);
    await env.commands.onUpdate(ctx, pilot.id, { command_id: c3.commandId, state: 'acked' });
    env.clock.advance(5 * 3600);
    await env.commands.sweep(ctx);
    assert.equal(JSON.parse(open()[0]?.detail ?? '{}').errorCode, 'TIMEOUT');
  });

  it('M2:改安裝參數退回 draft 時,尚未送出的指令(舊快照)一併取消', async () => {
    const r = await register();
    const queued = await install(pilot, r.packageId);
    assert.equal(queued.state, 'queued');
    await env.software.update(ctx, IT, r.packageId, { installArgs: 'ALLUSERS=2' });
    assert.equal(env.commandStore.commands.find((c) => c.commandId === queued.commandId)!.state, 'queued', 'draft 本來就是 draft,不算退回');
    await online(pilot);
    const done = await install(pilot, r.packageId);
    await succeed(pilot, done.commandId);
    await env.software.markTested(ctx, IT, r.packageId, [PKG_SIGNER]);
    // 另一台離線的 pilot 測試機:指令留在 queued
    env.store.ringOf.set(other.id, 'pilot');
    const pending = await install(other, r.packageId);
    assert.equal(pending.state, 'queued');
    await env.software.update(ctx, IT, r.packageId, { installArgs: 'ALLUSERS=1' });
    const c = env.commandStore.commands.find((x) => x.commandId === pending.commandId)!;
    assert.deepEqual([c.state, c.errorCode], ['canceled', 'PACKAGE_CHANGED']);
  });

  it('撤回:尚未送出的安裝取消;不能再安裝,可移除;不能修改', async () => {
    const r = await register();
    const queued = await install(pilot, r.packageId);
    assert.equal(queued.state, 'queued');
    const revoked = await env.software.revoke(ctx, IT, r.packageId);
    assert.deepEqual([revoked.status, revoked.canceledCommands], ['revoked', 1]);
    assert.equal(env.commandStore.commands[0]!.state, 'canceled');
    await assert.rejects(install(pilot, r.packageId), { code: 'ITA_PACKAGE_REVOKED' });
    // C1:draft 撤回的移除只能派 pilot
    await assert.rejects(env.commands.create(ctx, IT, 'admin', other.deviceId, { kind: 'software.uninstall', params: { packageId: r.packageId } }), {
      code: 'ITA_PACKAGE_NOT_PUBLISHED',
    });
    const un = await env.commands.create(ctx, IT, 'admin', pilot.deviceId, { kind: 'software.uninstall', params: { packageId: r.packageId } });
    assert.deepEqual(un.params, {
      package_id: r.packageId,
      name: '7-Zip',
      version: '24.09',
      installer_type: 'msi',
      uninstall_args: '',
      detect: { type: 'display_name', value: '7-Zip%' },
      timeout_sec: 1800,
    });
    await assert.rejects(env.software.update(ctx, IT, r.packageId, { notes: 'x' }), { code: 'ITA_PACKAGE_REVOKED' });
    await assert.rejects(env.software.revoke(ctx, IT, r.packageId), { code: 'ITA_PACKAGE_STATUS' });
  });

  it('撤回後釋放安裝檔路徑(0010):同一檔案可重新登錄(版本號仍不可重用);未撤回的仍佔用', async () => {
    const r = await register();
    assert.deepEqual((await env.software.unregisteredFiles(ctx)).items, []);
    await assert.rejects(register({ version: '24.09.1' }), { code: 'ITA_PACKAGE_EXISTS' }, '未撤回仍佔用路徑');
    await env.software.revoke(ctx, IT, r.packageId);
    assert.deepEqual(
      (await env.software.unregisteredFiles(ctx)).items.map((f) => f.fileName),
      [FILE],
      '撤回後出現在可登錄清單',
    );
    await assert.rejects(register(), { code: 'ITA_PACKAGE_EXISTS' }, '已撤回的版本號不可重用');
    const again = await register({ version: '24.09.1' });
    assert.equal(again.fileName, FILE);
    assert.deepEqual((await env.software.unregisteredFiles(ctx)).items, []);
  });

  /** 登錄 → pilot 測試 → tested → 第二人發佈 */
  const published = async (patch: Partial<RegisterPackageInput> = {}) => {
    const r = await register(patch);
    await online(pilot);
    const cmd = await install(pilot, r.packageId);
    await succeed(pilot, cmd.commandId);
    await env.software.markTested(ctx, IT, r.packageId, [PKG_SIGNER]);
    await env.software.publish(ctx, REVIEWER, r.packageId);
    return r.packageId;
  };

  it('授權數:已安裝 + 本批新增(排除已安裝)> 上限 → 409;draft 不計', async () => {
    const id = await published({ licenseLimit: 2 });
    const third = await addDevice('PC-THIRD', 3);
    // pilot 已安裝(資產有 7-Zip)
    const inv = structuredClone(inventoryRequest());
    inv.inventory.software = [{ name: '7-Zip 24.09 (x64)', version: '24.09', publisher: 'Igor Pavlov', install_date: '2026-10-20' }];
    await env.service.ingestInventory(ctx, pilot, inv);
    // 已安裝 1 + 新增 other、third = 3 > 2
    await assert.rejects(env.software.deploy(ctx, IT, id, { action: 'install', deviceIds: [pilot.deviceId, other.deviceId, third.deviceId] }), {
      code: 'ITA_LICENSE_EXCEEDED',
    });
    // 已安裝的 pilot 不重複計:1 + 1 = 2
    const b = await env.software.deploy(ctx, IT, id, { action: 'install', deviceIds: [pilot.deviceId, other.deviceId] });
    assert.equal(b.commands.length, 2);
    assert.equal(env.commandStore.commands.filter((c) => c.batchRef !== null).length, 2);
    // 移除不檢查授權數
    assert.equal((await env.software.deploy(ctx, IT, id, { action: 'uninstall', deviceIds: [third.deviceId] })).commands.length, 1);
  });

  it('批次第二人核可:超過門檻待核可不送出;同人 403;第二人核可後送出且有效期限自核可時起算', async () => {
    env = setupSoftware({ approvalThreshold: 2 });
    pilot = await addDevice('PC-PILOT', 1);
    other = await addDevice('PC-OTHER', 2);
    env.store.ringOf.set(pilot.id, 'pilot');
    env.dir.put(FILE, CONTENT);
    const id = await published();
    const third = await addDevice('PC-THIRD', 3);
    const conns = [await online(other), await online(third)];
    // 覆核人自己 24 小時內沒有派送過:2 台在門檻內(IT 已在 pilot 測試機派過 1 台,累計會超過,D2-1)
    const small = await env.software.deploy(ctx, REVIEWER, id, { action: 'install', deviceIds: [other.deviceId, third.deviceId] });
    assert.deepEqual([small.state, small.requiresApproval], ['running', false], '門檻內不需核可');
    const big = await env.software.deploy(ctx, IT, id, { action: 'uninstall', deviceIds: [pilot.deviceId, other.deviceId, third.deviceId] });
    assert.deepEqual([big.state, big.requiresApproval], ['pending_approval', true]);
    assert.ok(big.commands.every((c) => c.state === 'queued'));
    // 重連補送也不送出待核可的指令
    await env.commands.onHello(ctx, other.id);
    assert.ok(!conns[0]!.sent.some((m) => m.type === 'command' && m.body.kind === 'software.uninstall'));
    const view = await env.commands.getBatch(ctx, big.batchId);
    assert.equal(view.approvalExpiresAt, new Date(env.clock.t + APPROVAL_WINDOW_MS).toISOString());
    await assert.rejects(env.commands.approveBatch(ctx, IT, big.batchId, 'software'), { code: 'ITA_APPROVER_SAME_AS_CREATOR' });
    env.clock.advance(3600);
    const ok = await env.commands.approveBatch(ctx, REVIEWER, big.batchId, 'software');
    assert.deepEqual([ok.state, ok.approvedBy?.emp], ['running', 'S000002']);
    assert.ok(
      conns.every((c) => c.sent.some((m) => m.type === 'command' && m.body.kind === 'software.uninstall')),
      '核可後送出',
    );
    const cmd = env.commandStore.commands.find((c) => c.kind === 'software.uninstall' && c.deviceRef === pilot.id)!;
    assert.equal(cmd.expiresAt.getTime(), env.clock.t + 86400 * 1000, '有效期限自核可時起算');
    await assert.rejects(env.commands.approveBatch(ctx, REVIEWER, big.batchId, 'software'), { code: 'ITA_BATCH_NOT_PENDING' });
  });

  it('批次核可:24 小時無人核可 → expired 指令取消;駁回 → rejected 指令取消', async () => {
    env = setupSoftware({ approvalThreshold: 1 });
    pilot = await addDevice('PC-PILOT', 1);
    other = await addDevice('PC-OTHER', 2);
    env.store.ringOf.set(pilot.id, 'pilot');
    env.dir.put(FILE, CONTENT);
    const id = await published();
    const a = await env.software.deploy(ctx, IT, id, { action: 'uninstall', deviceIds: [pilot.deviceId, other.deviceId] });
    const b = await env.software.deploy(ctx, IT, id, { action: 'install', deviceIds: [pilot.deviceId, other.deviceId] }, 'k-1');
    assert.equal(b.state, 'pending_approval');
    // 同一個 Idempotency-Key 回傳同一批
    assert.equal((await env.software.deploy(ctx, IT, id, { action: 'install', deviceIds: [pilot.deviceId, other.deviceId] }, 'k-1')).batchId, b.batchId);
    // 同一個 key 用在另一個套件:422(不可回傳舊的那批)
    env.dir.put('7-Zip/24.10/7z2410-x64.msi', 'MSI-7zip-24.10');
    const other2 = await register({ version: '24.10', fileName: '7-Zip/24.10/7z2410-x64.msi' });
    await assert.rejects(env.software.deploy(ctx, IT, other2.packageId, { action: 'install', deviceIds: [pilot.deviceId, other.deviceId] }, 'k-1'), {
      code: 'ITA_IDEMPOTENCY_KEY_REUSED',
    });
    // 核可人的資料範圍需涵蓋批次全部電腦(這兩台未指定公司:只有全部公司看得到)
    await assert.rejects(env.commands.approveBatch({ ...ctx, scope: only('甲公司') }, REVIEWER, b.batchId, 'software'), { code: 'ITA_BATCH_NOT_FOUND' });
    const rejected = await env.commands.rejectBatch(ctx, IT, b.batchId, '目標有誤', 'software');
    assert.deepEqual([rejected.state, rejected.rejectReason, rejected.counts], ['rejected', '目標有誤', { canceled: 2 }]);
    env.clock.advance(APPROVAL_WINDOW_MS / 1000 - 60);
    await assert.rejects(env.commands.approveBatch(ctx, REVIEWER, b.batchId, 'software'), { code: 'ITA_BATCH_NOT_PENDING' });
    env.clock.advance(60);
    await assert.rejects(env.commands.approveBatch(ctx, REVIEWER, a.batchId, 'software'), { code: 'ITA_BATCH_NOT_PENDING' }, '已超過 24 小時');
    await env.commands.sweep(ctx);
    const expired = await env.commands.getBatch(ctx, a.batchId);
    assert.deepEqual([expired.state, expired.counts], ['expired', { canceled: 2 }]);
    assert.ok(
      env.commandStore.commands.filter((c) => c.batchRef !== null).every((c) => c.errorCode === 'APPROVAL_EXPIRED' || c.errorCode === 'BATCH_REJECTED'),
    );
  });

  it('批次清單(P7-5):state=pending_approval 只列核可期限內的待核可批次;新到舊分頁;範圍外的批次不列出', async () => {
    env = setupSoftware({ approvalThreshold: 1 });
    pilot = await addDevice('PC-PILOT', 1);
    other = await addDevice('PC-OTHER', 2);
    env.store.ringOf.set(pilot.id, 'pilot');
    env.dir.put(FILE, CONTENT);
    const id = await published();
    const targets = [pilot.deviceId, other.deviceId];
    const old = await env.software.deploy(ctx, IT, id, { action: 'uninstall', deviceIds: targets });
    env.clock.advance(APPROVAL_WINDOW_MS / 1000 + 60); // old 超過 24 小時核可期限(尚未被掃描設為 expired)
    const a = await env.software.deploy(ctx, IT, id, { action: 'install', deviceIds: targets });
    const b = await env.software.deploy(ctx, IT, id, { action: 'uninstall', deviceIds: targets });
    const pending = await env.commands.listBatches(ctx, { state: 'pending_approval' });
    assert.deepEqual(
      pending.items.map((x) => x.batchId),
      [b.batchId, a.batchId],
      '新到舊,不含逾期的',
    );
    assert.deepEqual([pending.items[0]!.state, pending.items[0]!.counts, pending.nextCursor], ['pending_approval', { queued: 2 }, null]);
    // 分頁
    const p1 = await env.commands.listBatches(ctx, { state: 'pending_approval', limit: 1 });
    assert.deepEqual([p1.items.map((x) => x.batchId), p1.nextCursor !== null], [[b.batchId], true]);
    const p2 = await env.commands.listBatches(ctx, { state: 'pending_approval', limit: 1, cursor: p1.nextCursor! });
    assert.deepEqual([p2.items.map((x) => x.batchId), p2.nextCursor], [[a.batchId], null]);
    // 不篩狀態:含逾期的 old
    assert.equal((await env.commands.listBatches(ctx, {})).items.length, 3);
    assert.ok(old.batchId);
    // 駁回後不再列在待核可
    await env.commands.rejectBatch(ctx, IT, a.batchId, '目標有誤', 'software');
    assert.deepEqual((await env.commands.listBatches(ctx, { state: 'pending_approval' })).items.map((x) => x.batchId), [b.batchId]);
    // 這兩台沒有指定公司:只有全部公司的資料範圍看得到
    assert.deepEqual((await env.commands.listBatches({ ...ctx, scope: only('甲公司') }, { state: 'pending_approval' })).items, []);
  });

  it('全域並行上限(SOFTWARE_MAX_CONCURRENT):達上限留在 queued,有一筆結束再補送;批次全部結束 → done', async () => {
    env = setupSoftware({ maxConcurrent: 1 });
    pilot = await addDevice('PC-PILOT', 1);
    other = await addDevice('PC-OTHER', 2);
    env.store.ringOf.set(pilot.id, 'pilot');
    env.dir.put(FILE, CONTENT);
    const id = await published();
    const third = await addDevice('PC-THIRD', 3);
    const [c1, c2] = [await online(other), await online(third)];
    const first = await install(other, id);
    assert.equal(first.state, 'sent');
    const b = await env.software.deploy(ctx, IT, id, { action: 'uninstall', deviceIds: [third.deviceId] });
    assert.equal(b.commands[0]!.state, 'queued', '單台與批次共用上限');
    assert.equal(c2.sent.filter((m) => m.type === 'command').length, 0);
    await succeed(other, first.commandId);
    assert.equal(c2.sent.filter((m) => m.type === 'command').length, 1, '名額釋出後補送');
    await env.commands.onUpdate(ctx, third.id, { command_id: b.commands[0]!.commandId, state: 'succeeded', result: { exit_code: 0, already_absent: true } });
    assert.equal((await env.commands.getBatch(ctx, b.batchId)).state, 'done');
    assert.equal(env.commandStore.batches.find((x) => x.batchId === b.batchId)!.state, 'done');
    void c1;
  });

  it('D2-1:同一人 24 小時內逐台派送累計超過門檻,之後的單台進入待核可;核可過的批次不計;24 小時後重新計算', async () => {
    env = setupSoftware({ approvalThreshold: 2 });
    pilot = await addDevice('PC-PILOT', 1);
    env.store.ringOf.set(pilot.id, 'pilot');
    env.dir.put(FILE, CONTENT);
    const id = await published(); // IT 在 pilot 派過 1 台
    const a = await addDevice('PC-A', 11);
    const b = await addDevice('PC-B', 12);
    const c = await addDevice('PC-C', 13);
    const first = await install(a, id);
    assert.equal(first.batchState, null, '累計 2 台,未超過');
    const gated = await install(b, id);
    assert.deepEqual([gated.batchState, gated.state], ['pending_approval', 'queued'], '累計第 3 台需核可');
    // 移除與安裝共用計數;另一人不受影響
    const un = await env.commands.create(ctx, IT, 'admin', c.deviceId, { kind: 'software.uninstall', params: { packageId: id } });
    assert.equal(un.batchState, 'pending_approval');
    assert.equal((await env.commands.create(ctx, REVIEWER, 'admin', c.deviceId, { kind: 'software.install', params: { packageId: id } })).batchState, null);
    // 第二人核可後送出
    await assert.rejects(env.commands.approveBatch(ctx, IT, gated.batchId!, 'software'), { code: 'ITA_APPROVER_SAME_AS_CREATOR' });
    assert.equal((await env.commands.approveBatch(ctx, REVIEWER, gated.batchId!, 'software')).state, 'running');
    // 24 小時後重新計算
    env.clock.advance(25 * 3600);
    assert.equal((await install(a, id)).batchState, null);
  });

  it('D2-1:同一人同時送出多台單台派送,累計門檻不會被競態繞過', async () => {
    env = setupSoftware({ approvalThreshold: 2 });
    pilot = await addDevice('PC-PILOT', 1);
    env.store.ringOf.set(pilot.id, 'pilot');
    env.dir.put(FILE, CONTENT);
    const id = await published(); // IT 在 pilot 派過 1 台
    const devices = [];
    for (let i = 0; i < 5; i++) devices.push(await addDevice(`PC-RACE-${i}`, 300 + i));
    const views = await Promise.all(devices.map((d) => install(d, id)));
    assert.equal(views.filter((v) => v.batchState === null).length, 1, '累計 2 台以內只有 1 台不需核可');
    assert.equal(views.filter((v) => v.batchState === 'pending_approval').length, 4);
  });

  it('核可路由:重開機批次只能由 /approve-command 核可,軟體派送批次只能由 /approve', async () => {
    env = setupSoftware({ approvalThreshold: 2 });
    pilot = await addDevice('PC-PILOT', 1);
    env.store.ringOf.set(pilot.id, 'pilot');
    env.dir.put(FILE, CONTENT);
    const id = await published();
    const ds = [];
    for (let i = 0; i < 3; i++) ds.push(await addDevice(`PC-RB-${i}`, 400 + i));
    const reboot = await env.commands.createBatch(
      ctx,
      IT,
      'admin',
      ds.map((d) => d.deviceId),
      { kind: 'system.reboot', params: { delay_sec: 300, message: '安裝更新後需重新開機', force: false } },
    );
    assert.equal(reboot.state, 'pending_approval');
    await assert.rejects(env.commands.approveBatch(ctx, REVIEWER, reboot.batchId, 'software'), { code: 'ITA_APPROVAL_ROUTE_MISMATCH' });
    await assert.rejects(env.commands.rejectBatch(ctx, REVIEWER, reboot.batchId, 'x', 'software'), { code: 'ITA_APPROVAL_ROUTE_MISMATCH' });
    assert.equal((await env.commands.approveBatch(ctx, REVIEWER, reboot.batchId, 'command')).state, 'running');
    const sw = await env.software.deploy(ctx, IT, id, { action: 'install', deviceIds: ds.map((d) => d.deviceId) });
    assert.equal(sw.state, 'pending_approval');
    await assert.rejects(env.commands.approveBatch(ctx, REVIEWER, sw.batchId, 'command'), { code: 'ITA_APPROVAL_ROUTE_MISMATCH' });
    assert.equal((await env.commands.rejectBatch(ctx, IT, sw.batchId, '目標有誤', 'software')).state, 'rejected');
  });

  it('M3:大量電腦同時重連,全域並行上限不會被超過', async () => {
    env = setupSoftware({ approvalThreshold: 10_000, maxConcurrent: 2 });
    pilot = await addDevice('PC-PILOT', 1);
    env.store.ringOf.set(pilot.id, 'pilot');
    env.dir.put(FILE, CONTENT);
    const id = await published();
    const devices = [];
    for (let i = 0; i < 6; i++) {
      const d = await addDevice(`PC-STORM-${i}`, 200 + i);
      await install(d, id);
      devices.push(d);
    }
    for (const d of devices) await online(d);
    // 同時 hello 補送
    await Promise.all(devices.map((d) => env.commands.onHello(ctx, d.id)));
    const active = env.commandStore.commands.filter((c) => c.kind === 'software.install' && ['sent', 'acked', 'running'].includes(c.state));
    assert.equal(active.length, 2);
  });

  it('全域並行上限補送:最舊的 200 筆以上都是離線電腦時,後面在線的仍補送得到', async () => {
    // 累計核可門檻(D2-1)放大,只測補送
    env = setupSoftware({ approvalThreshold: 10_000 });
    pilot = await addDevice('PC-PILOT', 1);
    env.store.ringOf.set(pilot.id, 'pilot');
    env.dir.put(FILE, CONTENT);
    const id = await published();
    for (let i = 0; i < 70; i++) {
      const d = await addDevice(`PC-OFF-${i}`, 100 + i);
      for (let k = 0; k < 3; k++) await install(d, id);
    }
    const late = await addDevice('PC-LATE', 999);
    const cmd = await install(late, id);
    assert.equal(cmd.state, 'queued');
    assert.ok(env.commandStore.commands.filter((c) => c.state === 'queued').length > 200);
    const conn = await online(late);
    await env.commands.sweep(ctx);
    assert.equal(conn.sent.filter((m) => m.type === 'command' && m.id === cmd.commandId).length, 1);
  });

  it('M1 定期複驗:檔案被換掉 → 取消排隊中的安裝、開告警、拒絕新的安裝;恢復後解除;批次由掃描收尾', async () => {
    const r = await register();
    const batch = await env.software.deploy(ctx, IT, r.packageId, { action: 'install', deviceIds: [pilot.deviceId] });
    assert.equal(batch.commands[0]!.state, 'queued', 'pilot 離線,排隊中');
    assert.deepEqual(await env.software.verifyFiles(ctx), { checked: 1, changed: 0 });
    env.dir.put(FILE, 'MSI-tampered!!');
    assert.deepEqual(await env.software.verifyFiles(ctx), { checked: 1, changed: 1 });
    const c = env.commandStore.commands.find((x) => x.commandId === batch.commands[0]!.commandId)!;
    assert.deepEqual([c.state, c.errorCode], ['canceled', 'PACKAGE_FILE_CHANGED']);
    const alerts = env.monitor.alerts.filter((a) => a.rule === 'software_file_tampered');
    assert.deepEqual(
      alerts.map((a) => [a.deviceRef, JSON.parse(a.detail ?? '{}').actualSha256 !== null]),
      [[pilot.id, true]],
      '被取消安裝的裝置開告警',
    );
    await assert.rejects(install(pilot, r.packageId), { code: 'ITA_PACKAGE_CHANGED' });
    // 已知不符:下一輪不重複取消、不重複開告警
    await env.software.verifyFiles(ctx);
    assert.equal(env.monitor.alerts.filter((a) => a.rule === 'software_file_tampered').length, 1);
    // 不經派送器取消的指令:批次由每分鐘掃描收尾
    const b = () => env.commandStore.batches.find((x) => x.batchId === batch.batchId)!;
    assert.equal(b().state, 'running');
    await env.commands.sweep(ctx);
    assert.equal(b().state, 'done');
    // 找不到檔案也算不符;放回原檔後解除
    env.dir.put(FILE, CONTENT);
    await env.software.verifyFiles(ctx);
    assert.equal((await install(pilot, r.packageId)).kind, 'software.install');
  });

  it('M1 定期複驗:找不到檔案要連續兩輪才處理;軟體庫一個檔案都沒有(掛載中斷)整輪略過;取消失敗下一輪再試', async () => {
    const r = await register();
    const queued = async () => (await install(pilot, r.packageId)).commandId;
    const state = (id: string) => env.commandStore.commands.find((c) => c.commandId === id)!.state;
    // 軟體庫全空:不處理
    rmSync(path.join(env.dir.root, '7-Zip'), { recursive: true });
    const c1 = await queued();
    assert.deepEqual(await env.software.verifyFiles(ctx), { checked: 0, changed: 0 });
    assert.equal(state(c1), 'queued');
    // 只有這個檔案不見:第一輪只記下,第二輪才取消
    env.dir.put('Other/1.0/other.msi', 'other');
    await env.software.verifyFiles(ctx);
    assert.equal(state(c1), 'queued', '第一輪不處理');
    await env.software.verifyFiles(ctx);
    assert.equal(state(c1), 'canceled');
    await assert.rejects(queued(), { code: 'ITA_PACKAGE_CHANGED' });
    // 恢復後解除;再換掉檔案時取消失敗 → 新的安裝已拒絕,下一輪再取消
    env.dir.put(FILE, CONTENT);
    await env.software.verifyFiles(ctx);
    const c2 = await queued();
    env.dir.put(FILE, 'MSI-tampered!!');
    const original = env.store.cancelQueuedInstalls.bind(env.store);
    env.store.cancelQueuedInstalls = () => Promise.reject(new Error('SQL 中斷'));
    await env.software.verifyFiles(ctx);
    assert.equal(state(c2), 'queued');
    await assert.rejects(queued(), { code: 'ITA_PACKAGE_CHANGED' });
    env.store.cancelQueuedInstalls = original;
    await env.software.verifyFiles(ctx);
    assert.equal(state(c2), 'canceled');
  });

  it('L11:同一個 Idempotency-Key 用在不同的目標電腦 → 422;相同電腦(順序不同)回傳同一批', async () => {
    const id = await published();
    const a = await env.software.deploy(ctx, IT, id, { action: 'install', deviceIds: [pilot.deviceId, other.deviceId] }, 'key-1');
    const again = await env.software.deploy(ctx, IT, id, { action: 'install', deviceIds: [other.deviceId.toUpperCase(), pilot.deviceId] }, 'key-1');
    assert.equal(again.batchId, a.batchId);
    await assert.rejects(env.software.deploy(ctx, IT, id, { action: 'install', deviceIds: [pilot.deviceId] }, 'key-1'), { code: 'ITA_IDEMPOTENCY_KEY_REUSED' });
  });

  it('L10:同時大量要求補送,只合併成「執行中 + 再跑一次」', async () => {
    await register();
    env.commandStore.calls.length = 0;
    await Promise.all(Array.from({ length: 30 }, () => env.commands.sweep(ctx)));
    const scans = env.commandStore.calls.filter((n) => n === 'activeOfKinds').length;
    assert.ok(scans <= 2, `補送執行 ${scans} 次`);
  });
});

describe('套件下載 API 與管理 API', () => {
  let env: ReturnType<typeof setupSoftware>;
  let agent: FastifyInstance;
  let mgmt: FastifyInstance;
  let device: DeviceRecord;
  const DN = 'O=GigaNexus Dev,CN=PC-EXAMPLE-01';
  const FP = '574f45a0357c7d134a9e2f78cd7ed4dc0444ee77';
  const headers = { 'x-client-cert-dn': DN, 'x-client-cert-fp': FP, 'x-client-verify': 'SUCCESS' };

  beforeEach(async () => {
    env = setupSoftware();
    agent = await buildAgentApp({
      config: { logLevel: 'silent', agentTls: null, trustedProxies: null },
      service: env.service,
      contractsDir: CONTRACTS_DIR,
      software: env.software,
    });
    const gateway = loadGatewayEnv({ GW_ENV: 'dev', SERVICE_CODE: 'endpoint-api', GW_JWKS_URL: 'http://127.0.0.1:1/jwks' });
    mgmt = await buildMgmtApp({
      config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken: true, scopeAllRoles: [] },
      service: env.service,
      commands: env.commands,
      software: env.software,
    });
    device = await env.service.identify(ctx, DN, FP);
    env.store.ringOf.set(device.id, 'pilot');
    env.dir.put(FILE, CONTENT);
  });
  afterEach(async () => {
    await agent.close();
    await mgmt.close();
  });

  it('管理 API:未登錄檔案、登錄、清單、詳情、單台派送(admin-commands);路徑穿越與危險參數 400', async () => {
    assert.deepEqual(
      (await mgmt.inject('/v1/software/files')).json().items.map((f: { fileName: string }) => f.fileName),
      [FILE],
    );
    const body = { name: '7-Zip', version: '24.09', fileName: FILE, installerType: 'msi', detectType: 'display_name', detectValue: '7-Zip%' };
    const reg = await mgmt.inject({ method: 'POST', url: '/v1/software', payload: body });
    assert.equal(reg.statusCode, 200, reg.body);
    const id = reg.json().packageId as string;
    assert.equal((await mgmt.inject('/v1/software/files')).json().items.length, 0);
    assert.equal((await mgmt.inject('/v1/software?status=draft&q=zip')).json().items[0].packageId, id);
    assert.equal((await mgmt.inject('/v1/software?status=published')).json().items.length, 0);
    const cmd = await mgmt.inject({
      method: 'POST',
      url: `/v1/devices/${device.deviceId}/admin-commands`,
      payload: { kind: 'software.install', params: { packageId: id } },
    });
    assert.equal(cmd.statusCode, 202, cmd.body);
    assert.equal(cmd.json().params.url, `/agent/v1/packages/${id}`);
    const detail = await mgmt.inject(`/v1/software/${id}`);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().testResults.length, 1);
    for (const payload of [
      { ...body, version: '1', fileName: '../../etc/passwd.msi' },
      { ...body, version: '2', installArgs: 'A=1 | calc' },
      { ...body, version: '3', installerType: 'cmd' },
    ])
      assert.equal((await mgmt.inject({ method: 'POST', url: '/v1/software', payload })).statusCode, 400, JSON.stringify(payload));
    // 同一人發佈:403(先標記 tested 才走得到)
    const pub = await mgmt.inject({ method: 'POST', url: `/v1/software/${id}/publish` });
    assert.deepEqual([pub.statusCode, pub.json().code], [409, 'ITA_PACKAGE_STATUS']);
  });

  it('下載:只給被指派(尚未結束的此套件 software.install);整檔 200、Range 206、416;移出 pilot / 撤回 404;檔案被換掉 503;稽核每小時一筆', async () => {
    const r = await env.software.register(ctx, IT, {
      name: '7-Zip',
      version: '24.09',
      fileName: FILE,
      installerType: 'msi',
      detectType: 'display_name',
      detectValue: '7-Zip%',
    });
    const url = `/agent/v1/packages/${r.packageId}`;
    assert.equal((await agent.inject({ url, headers })).statusCode, 404, '尚未指派');
    const conn = new FakeConnection();
    await env.service.connected(ctx, device, conn);
    const cmd = await env.commands.create(ctx, IT, 'admin', device.deviceId, { kind: 'software.install', params: { packageId: r.packageId } });
    assert.equal(cmd.state, 'sent');
    let res = await agent.inject({ url, headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.body, CONTENT);
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['content-length'], String(CONTENT.length));
    res = await agent.inject({ url, headers: { ...headers, range: 'bytes=4-' } });
    assert.deepEqual([res.statusCode, res.body, res.headers['content-range']], [206, CONTENT.slice(4), `bytes 4-${CONTENT.length - 1}/${CONTENT.length}`]);
    res = await agent.inject({ url, headers: { ...headers, range: 'bytes=999-' } });
    assert.deepEqual([res.statusCode, res.headers['content-range']], [416, `bytes */${CONTENT.length}`]);
    await agent.inject({ url, headers });
    assert.equal(env.sql.events.filter((e) => e.type === 'package_download').length, 1, '從 0 開始才記,同一套件每小時一次');
    assert.equal((await agent.inject({ url: '/agent/v1/packages/not-a-uuid', headers })).statusCode, 400);
    assert.equal((await agent.inject({ url: '/agent/v1/packages/00000000-0000-4000-8000-000000000000', headers })).statusCode, 404);
    // 另一台離線的 pilot 測試機:安裝排隊中
    const offline = await env.service.identify(ctx, 'O=GigaNexus Dev,CN=PC-OFFLINE', 'ab'.repeat(20));
    env.store.ringOf.set(offline.id, 'pilot');
    const waiting = await env.commands.create(ctx, IT, 'admin', offline.deviceId, { kind: 'software.install', params: { packageId: r.packageId } });
    assert.equal(waiting.state, 'queued');
    // 檔案被換掉:503,不下發
    writeFileSync(path.join(env.dir.root, ...FILE.split('/')), 'MSI-tampered!!');
    res = await agent.inject({ url, headers });
    assert.deepEqual([res.statusCode, res.json().code], [503, 'ITA_PACKAGE_CHANGED']);
    // D4:開 critical 告警在要求下載的裝置上
    const tampered = env.monitor.alerts.filter((a) => a.rule === 'software_file_tampered');
    assert.deepEqual(
      tampered.map((a) => [a.deviceRef, a.severity, a.state, JSON.parse(a.detail ?? '{}').packageId]),
      [[device.id, 'critical', 'open', r.packageId]],
    );
    // M1:排隊中的安裝一併取消
    const w = env.commandStore.commands.find((c) => c.commandId === waiting.commandId)!;
    assert.deepEqual([w.state, w.errorCode], ['canceled', 'PACKAGE_FILE_CHANGED']);
    writeFileSync(path.join(env.dir.root, ...FILE.split('/')), CONTENT);
    assert.equal((await agent.inject({ url, headers })).statusCode, 200);
    // draft 套件:裝置移出 pilot 後不給
    env.store.ringOf.set(device.id, 'all');
    assert.equal((await agent.inject({ url, headers })).statusCode, 404);
    env.store.ringOf.set(device.id, 'pilot');
    // M2:目錄改了安裝參數,已送出的舊快照不給;改回後可下載
    await env.software.update(ctx, IT, r.packageId, { installArgs: 'ALLUSERS=1' });
    assert.equal((await agent.inject({ url, headers })).statusCode, 404);
    await env.software.update(ctx, IT, r.packageId, { installArgs: '' });
    assert.equal((await agent.inject({ url, headers })).statusCode, 200);
    // 指令結束後不再給
    await env.commands.onUpdate(ctx, device.id, { command_id: cmd.commandId, state: 'failed', error_code: 'INSTALL_FAILED' });
    assert.equal((await agent.inject({ url, headers })).statusCode, 404);
    // 沒有裝置憑證 401;停用 403
    assert.equal((await agent.inject({ url })).statusCode, 401);
    env.sql.byId(device.id).status = 'disabled';
    assert.equal((await agent.inject({ url, headers })).statusCode, 403);
  });

  it('下載:撤回後已送出的指令也不給', async () => {
    const r = await env.software.register(ctx, IT, {
      name: '7-Zip',
      version: '24.09',
      fileName: FILE,
      installerType: 'msi',
      detectType: 'display_name',
      detectValue: '7-Zip%',
    });
    await env.service.connected(ctx, device, new FakeConnection());
    await env.commands.create(ctx, IT, 'admin', device.deviceId, { kind: 'software.install', params: { packageId: r.packageId } });
    await env.software.revoke(ctx, IT, r.packageId);
    assert.equal((await agent.inject({ url: `/agent/v1/packages/${r.packageId}`, headers })).statusCode, 404);
  });

  it('L5:同一台同時下載超過上限 → 429;串流關閉後釋放名額', async () => {
    const r = await env.software.register(ctx, IT, {
      name: '7-Zip',
      version: '24.09',
      fileName: FILE,
      installerType: 'msi',
      detectType: 'display_name',
      detectValue: '7-Zip%',
    });
    await env.service.connected(ctx, device, new FakeConnection());
    await env.commands.create(ctx, IT, 'admin', device.deviceId, { kind: 'software.install', params: { packageId: r.packageId } });
    const open: ReadStream[] = [];
    for (let i = 0; i < DOWNLOADS_PER_DEVICE; i++) open.push((await env.software.download(ctx, device, r.packageId, undefined)).stream!);
    await assert.rejects(env.software.download(ctx, device, r.packageId, undefined), { status: 429, code: 'ITA_DOWNLOAD_BUSY' });
    const closed = new Promise<void>((ok) => open[0]!.once('close', () => ok()));
    open[0]!.destroy();
    await closed;
    const d = await env.software.download(ctx, device, r.packageId, undefined);
    assert.equal(d.status, 200);
    for (const s of [...open.slice(1), d.stream!]) s.destroy();
    // 同時進來的請求也不能超過上限(檢查後立即預留名額);沒有交出串流的(416)不佔名額
    await new Promise((ok) => setTimeout(ok, 20));
    const all = await Promise.allSettled(Array.from({ length: 5 }, () => env.software.download(ctx, device, r.packageId, undefined)));
    const ok = all.filter((x) => x.status === 'fulfilled').map((x) => (x as PromiseFulfilledResult<Download>).value);
    assert.equal(ok.length, DOWNLOADS_PER_DEVICE);
    for (const x of ok) x.stream!.destroy();
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal((await env.software.download(ctx, device, r.packageId, 'bytes=999-')).status, 416);
    assert.equal((await env.software.download(ctx, device, r.packageId, 'bytes=999-')).status, 416);
    const last = await env.software.download(ctx, device, r.packageId, undefined);
    assert.equal(last.status, 200, '416 沒有佔用名額');
    last.stream!.destroy();
  });
});
