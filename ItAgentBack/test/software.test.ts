/**
 * P7-1 軟體目錄與下載(docs/P7-SOFTWARE-DESIGN.md §1–§4、§6):參數白名單與偵測規則、軟體庫路徑、狀態機與兩人覆核、
 * draft 只能派 pilot、mark-tested 簽章者需等於回報值、參數快照、撤回、授權數、批次第二人核可(同人 403、24 小時逾期、駁回)、
 * 全域並行上限、套件下載 API(只給被指派、Range / 416、檔案被換掉 503、稽核)、管理 API。
 * 經記憶體儲存;SQL 語句由整合測試涵蓋。
 */
import assert from 'node:assert/strict';
import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv, type GatewayIdentity } from '@giganexus/backend-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildAgentApp } from '../src/agent-app.js';
import { buildMgmtApp } from '../src/mgmt-app.js';
import { APPROVAL_WINDOW_MS } from '../src/services/command-dispatcher.js';
import { SoftwareFiles, splitSoftwarePath } from '../src/services/software-files.js';
import {
  argsErrors,
  deployDenied,
  detectErrors,
  displayNameLike,
  installSnapshot,
  qualifyingSigners,
  type RegisterPackageInput,
} from '../src/services/software-service.js';
import type { DeviceRecord, InstallResultRow, PackageRecord } from '../src/stores/types.js';
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

  it('D3:不可讀寫外部檔案;磁碟機路徑只限 Program Files;{ } 只限 GUID', () => {
    for (const ok of [
      '/qn /norestart ALLUSERS=1',
      'INSTALLDIR="C:/Program Files (x86)/Foo Bar/"',
      '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LANG=english /DIR="C:/Program Files/Notepad++"',
      '/S /D=C:/Program Files/App',
      '/passive /TASKS="desktopicon" /ALLUSERS',
      'REMOVE={12345678-1234-1234-1234-123456789ABC}',
    ])
      assert.deepEqual(argsErrors('installArgs', ok), [], `應接受:${ok}`);
    for (const bad of [
      // 外部檔案參數
      'TRANSFORMS=x',
      'patch = y',
      'MSIPATCHREMOVE=z',
      '/l*v C:/Program Files/a',
      '/lv out',
      '-log out',
      '/LOG="C:/Program Files/a"',
      '/LOADINF="settings"',
      '/SAVEINF=a',
      '/f1"C:/Program Files/setup"',
      '/p x',
      '/update x',
      'CONFIGFILE=y',
      // 路徑
      'INSTALLDIR="//server/share/x"',
      'INSTALLDIR="C:/Windows/System32"',
      'INSTALLDIR="D:/Program Files/x"',
      '/D=C:Program Files',
      'INSTALLDIR="C:/Program Files/../Windows"',
      'INSTALLDIR=/Windows',
      '/DIR={sys}',
      '/DIR="{tmp}/x"',
      'A=(1)',
      'A=@file',
      'A=[WindowsFolder]',
    ])
      assert.equal(argsErrors('installArgs', bad).length, 1, `應拒絕:${bad}`);
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
      result: { exit_code: 0, reboot_required: false, signer, signer_subject: 'CN=Example', detected: true, already_installed: false },
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
    assert.deepEqual((await env.software.unregisteredFiles(ctx)).items, []);
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
    await assert.rejects(env.commands.approveBatch(ctx, IT, big.batchId), { code: 'ITA_APPROVER_SAME_AS_CREATOR' });
    env.clock.advance(3600);
    const ok = await env.commands.approveBatch(ctx, REVIEWER, big.batchId);
    assert.deepEqual([ok.state, ok.approvedBy?.emp], ['running', 'S000002']);
    assert.ok(
      conns.every((c) => c.sent.some((m) => m.type === 'command' && m.body.kind === 'software.uninstall')),
      '核可後送出',
    );
    const cmd = env.commandStore.commands.find((c) => c.kind === 'software.uninstall' && c.deviceRef === pilot.id)!;
    assert.equal(cmd.expiresAt.getTime(), env.clock.t + 86400 * 1000, '有效期限自核可時起算');
    await assert.rejects(env.commands.approveBatch(ctx, REVIEWER, big.batchId), { code: 'ITA_BATCH_NOT_PENDING' });
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
    await assert.rejects(env.commands.approveBatch({ ...ctx, scope: only('甲公司') }, REVIEWER, b.batchId), { code: 'ITA_BATCH_NOT_FOUND' });
    const rejected = await env.commands.rejectBatch(ctx, IT, b.batchId, '目標有誤');
    assert.deepEqual([rejected.state, rejected.rejectReason, rejected.counts], ['rejected', '目標有誤', { canceled: 2 }]);
    env.clock.advance(APPROVAL_WINDOW_MS / 1000 - 60);
    await assert.rejects(env.commands.approveBatch(ctx, REVIEWER, b.batchId), { code: 'ITA_BATCH_NOT_PENDING' });
    env.clock.advance(60);
    await assert.rejects(env.commands.approveBatch(ctx, REVIEWER, a.batchId), { code: 'ITA_BATCH_NOT_PENDING' }, '已超過 24 小時');
    await env.commands.sweep(ctx);
    const expired = await env.commands.getBatch(ctx, a.batchId);
    assert.deepEqual([expired.state, expired.counts], ['expired', { canceled: 2 }]);
    assert.ok(
      env.commandStore.commands.filter((c) => c.batchRef !== null).every((c) => c.errorCode === 'APPROVAL_EXPIRED' || c.errorCode === 'BATCH_REJECTED'),
    );
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
    await assert.rejects(env.commands.approveBatch(ctx, IT, gated.batchId!), { code: 'ITA_APPROVER_SAME_AS_CREATOR' });
    assert.equal((await env.commands.approveBatch(ctx, REVIEWER, gated.batchId!)).state, 'running');
    // 24 小時後重新計算
    env.clock.advance(25 * 3600);
    assert.equal((await install(a, id)).batchState, null);
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
    writeFileSync(path.join(env.dir.root, ...FILE.split('/')), CONTENT);
    assert.equal((await agent.inject({ url, headers })).statusCode, 200);
    // draft 套件:裝置移出 pilot 後不給
    env.store.ringOf.set(device.id, 'all');
    assert.equal((await agent.inject({ url, headers })).statusCode, 404);
    env.store.ringOf.set(device.id, 'pilot');
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
});
