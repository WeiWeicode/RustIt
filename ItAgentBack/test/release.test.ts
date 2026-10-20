/**
 * P6-1 版本登錄與發佈環(docs/P6-UPGRADE-DESIGN.md):目標版本選擇、進度與失敗次數、推進限制、撤回、同時升級上限、
 * 升級告警、版本檔目錄(路徑穿越、Range)、下載 API、Watchdog 上報的 target、升級事件的路徑白名單、agent.upgrade 指令。
 * 經記憶體儲存;SQL 語句由整合測試涵蓋。
 */
import assert from 'node:assert/strict';
import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv, type GatewayIdentity } from '@giganexus/backend-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildAgentApp } from '../src/agent-app.js';
import type { WatchdogReportRequest } from '../src/contracts.js';
import { buildMgmtApp } from '../src/mgmt-app.js';
import { CommandDispatcher } from '../src/services/command-dispatcher.js';
import { DeviceService, eventAllowedOn } from '../src/services/device-service.js';
import { parseRange, ReleaseFiles } from '../src/services/release-files.js';
import { desiredVersion, mergeProgress, mismatchOf, RING_OBSERVE_MS } from '../src/services/release-service.js';
import type { DeviceRecord, DeviceUpgradeRecord, RingRecord, UpgradeTargetRow } from '../src/stores/types.js';
import { ALL, CONTRACTS_DIR, DN, FP, MemoryCommandStore, certHeaders, example, only } from './helpers.js';
import { SIGNER, releasesDir, setupReleases } from './release-helpers.js';

const log = Fastify({ logger: { level: 'silent' } }).log;
const ctx = { log, requestId: 'req-rel-1', scope: ALL };
const IT: GatewayIdentity = { sub: '1', emp: 'S000001', name: '測試人員' };
const NOW = new Date('2026-10-21T00:00:00Z');

const ring = (r: Partial<RingRecord>): RingRecord => ({
  ring: 'pilot',
  component: 'agent',
  targetVersion: null,
  targetSetAt: null,
  updatedByEmp: null,
  updatedByName: null,
  updatedAt: NOW,
  ...r,
});
const up = (u: Partial<DeviceUpgradeRecord>): DeviceUpgradeRecord => ({
  deviceRef: 1,
  component: 'agent',
  targetVersion: null,
  fromVersion: null,
  state: 'pending',
  attempts: 0,
  errorCode: null,
  errorMessage: null,
  forcedVersion: null,
  forcedByEmp: null,
  forcedAt: null,
  startedAt: null,
  updatedAt: NOW,
  ...u,
});

/** Watchdog 上報(0.2.0,Agent 0.7.0 在線) */
function report(patch: Partial<WatchdogReportRequest> = {}): WatchdogReportRequest {
  const r = example<WatchdogReportRequest>('watchdog-report.sample.json');
  return { ...r, watchdog_version: '0.2.0', agent: { ...r.agent, version: '0.7.0' }, events: [], ...patch };
}

describe('目標版本選擇與進度(純函式)', () => {
  it('強制版本優先於所屬環;沒有目標回 null', () => {
    const rings = [ring({ ring: 'pilot', targetVersion: '0.7.1', targetSetAt: NOW }), ring({ ring: 'all', targetVersion: '0.7.0' })];
    assert.equal(desiredVersion('agent', 'pilot', rings, undefined)?.version, '0.7.1');
    assert.equal(desiredVersion('agent', 'all', rings, undefined)?.version, '0.7.0');
    assert.equal(desiredVersion('agent', 'it', rings, undefined), null);
    assert.deepEqual(desiredVersion('agent', 'all', rings, up({ forcedVersion: '0.6.0', forcedAt: NOW })), { version: '0.6.0', source: 'forced', since: NOW });
    assert.equal(desiredVersion('watchdog', 'pilot', rings, undefined), null);
  });

  it('失敗次數:同一目標進入失敗才加一,重送同一結果不重複計;換目標歸零;成功清除已到達的強制版本', () => {
    const p = { component: 'agent', target_version: '0.7.2', state: 'rolled_back' } as const;
    const a = mergeProgress(up({ targetVersion: '0.7.2', state: 'installing' }), p, NOW);
    assert.equal(a.attempts, 1);
    const again = mergeProgress(up({ targetVersion: '0.7.2', state: 'rolled_back', attempts: 1 }), p, NOW);
    assert.equal(again.attempts, 1, '重送不重複計');
    const retry = mergeProgress(up({ targetVersion: '0.7.2', state: 'downloading', attempts: 1 }), p, NOW);
    assert.equal(retry.attempts, 2);
    assert.equal(mergeProgress(up({ targetVersion: '0.7.1', state: 'failed', attempts: 2 }), p, NOW).attempts, 1, '換目標歸零');
    assert.equal(mergeProgress(up({ targetVersion: '0.7.2', state: 'installing' }), { ...p, attempts: 3 }, NOW).attempts, 3, '採用 Watchdog 回報較大的次數');
    const ok = mergeProgress(
      up({ targetVersion: '0.6.0', state: 'installing', forcedVersion: '0.6.0', forcedByEmp: 'S1', forcedAt: NOW }),
      { ...p, target_version: '0.6.0', state: 'succeeded' },
      NOW,
    );
    assert.deepEqual([ok.forcedVersion, ok.errorCode], [null, null]);
  });

  it('version_mismatch:目標生效超過 24 小時、最近有回報、版本不同才成立;沒有 Watchdog 不比 Watchdog', () => {
    const old = new Date(NOW.getTime() - RING_OBSERVE_MS - 60_000);
    const rings = [
      ring({ ring: 'all', targetVersion: '0.7.1', targetSetAt: old }),
      ring({ ring: 'all', component: 'watchdog', targetVersion: '0.2.1', targetSetAt: old }),
    ];
    const row: UpgradeTargetRow = {
      deviceRef: 1,
      deviceId: 'd',
      company: null,
      ring: 'all',
      lastSeenAt: new Date(NOW.getTime() - 60_000),
      agentVersion: '0.7.0',
      watchdogVersion: null,
      watchdogReportAt: null,
      upgrades: [],
      openRules: [],
    };
    assert.deepEqual(mismatchOf(row, rings, NOW), [{ component: 'agent', current: '0.7.0', target: '0.7.1' }]);
    assert.deepEqual(mismatchOf({ ...row, agentVersion: '0.7.1' }, rings, NOW), []);
    assert.deepEqual(mismatchOf({ ...row, lastSeenAt: new Date(NOW.getTime() - 2 * 3_600_000) }, rings, NOW), [], '離線過久不評估');
    assert.deepEqual(mismatchOf(row, [ring({ ring: 'all', targetVersion: '0.7.1', targetSetAt: NOW })], NOW), [], '未滿 24 小時');
  });

  it('Range 解析', () => {
    assert.equal(parseRange(undefined, 100), undefined);
    assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
    assert.deepEqual(parseRange('bytes=90-200', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=5-1', 100), undefined, '語法錯誤(起點大於終點)忽略 Range');
    assert.equal(parseRange('bytes=0-1,5-6', 100), undefined, '多段不支援,回整個檔案');
  });

  it('升級事件只收對應的路徑:Agent 升級結果經 Watchdog、Watchdog 替換結果經 Agent', () => {
    const e = (component: string) => ({ type: 'upgrade_failed', data: { component, to: '0.7.2' } });
    assert.ok(eventAllowedOn(e('agent'), 'watchdog'));
    assert.ok(!eventAllowedOn(e('agent'), 'agent'));
    assert.ok(eventAllowedOn(e('watchdog'), 'agent'));
    assert.ok(!eventAllowedOn(e('watchdog'), 'watchdog'));
    assert.ok(eventAllowedOn({ type: 'agent_restarted' }, 'watchdog'));
    assert.ok(eventAllowedOn({ type: 'usb_inserted' }, 'agent'));
  });
});

describe('版本檔目錄', () => {
  it('只接受 {元件}/{版本}/{檔名} 且在根目錄內;SHA-256 依內容', async () => {
    const dir = releasesDir();
    const sha = dir.put('agent', '0.7.1', 'rustit-agent.exe', 'MZ-agent-0.7.1');
    const files = new ReleaseFiles(dir.root);
    const f = await files.resolve('agent', '0.7.1', 'rustit-agent.exe');
    assert.ok(f);
    assert.equal(await files.sha256(f), sha);
    assert.equal(await files.resolve('agent', '..', 'rustit-agent.exe'), null);
    assert.equal(await files.resolve('agent', '0.7.1', '..'), null);
    assert.equal(await files.resolve('desktop', '0.7.1', 'rustit-agent.exe'), null);
    assert.equal(await files.resolve('agent', '0.7.1', 'missing.exe'), null);
    // 內容換掉後重新計算
    writeFileSync(path.join(dir.root, 'agent', '0.7.1', 'rustit-agent.exe'), 'MZ-changed-content');
    const f2 = (await files.resolve('agent', '0.7.1', 'rustit-agent.exe'))!;
    assert.notEqual(await files.sha256(f2), sha);
    assert.deepEqual(
      (await files.list()).map((x) => `${x.component}/${x.version}/${x.fileName}`),
      ['agent/0.7.1/rustit-agent.exe'],
    );
  });

  it('符號連結指到根目錄外不接受', async (t) => {
    const dir = releasesDir();
    const outside = releasesDir();
    outside.put('x', 'y', 'secret.txt', 'secret');
    dir.put('agent', '0.7.1', 'ok.exe', 'MZ');
    try {
      symlinkSync(path.join(outside.root, 'x', 'y', 'secret.txt'), path.join(dir.root, 'agent', '0.7.1', 'link.exe'));
    } catch {
      t.skip('此環境無法建立符號連結');
      return;
    }
    assert.equal(await new ReleaseFiles(dir.root).resolve('agent', '0.7.1', 'link.exe'), null);
  });
});

describe('版本登錄、發佈環、Watchdog 上報的目標', () => {
  let env: ReturnType<typeof setupReleases>;
  let device: DeviceRecord;
  let sha: string;

  beforeEach(async () => {
    env = setupReleases();
    env.clock.t = NOW.getTime();
    device = await env.service.identify(ctx, DN, FP);
    sha = env.dir.put('agent', '0.7.1', 'rustit-agent.exe', 'MZ-agent-0.7.1');
  });

  const register = (version = '0.7.1', component: 'agent' | 'watchdog' = 'agent', fileName = 'rustit-agent.exe') =>
    env.releases.register(ctx, IT, { component, version, fileName, signerThumbprints: [SIGNER.toUpperCase()] });

  it('登錄:主機計算 SHA-256 與大小、指紋轉小寫、draft;同版本 409;檔案不存在 404;非全部公司 403', async () => {
    const r = await register();
    assert.deepEqual([r.status, r.sha256, r.sizeBytes, r.signerThumbprints], ['draft', sha, 14, [SIGNER]]);
    await assert.rejects(register(), { code: 'ITA_RELEASE_EXISTS' });
    await assert.rejects(register('0.7.9'), { code: 'ITA_RELEASE_FILE_NOT_FOUND' });
    await assert.rejects(
      env.releases.register({ ...ctx, scope: only('碩禾') }, IT, { component: 'agent', version: '0.7.1', fileName: 'x', signerThumbprints: [SIGNER] }),
      {
        code: 'ITA_SCOPE_ALL_REQUIRED',
      },
    );
    assert.deepEqual((await env.releases.unregisteredFiles(ctx)).items, []);
  });

  it('環目標:draft 只能給 pilot;it / all 要 pilot 觀察滿 24 小時(force 略過);revoked 不可設', async () => {
    const r = await register();
    await assert.rejects(env.releases.setRing(ctx, IT, 'all', 'agent', '0.7.1', false), { code: 'ITA_RELEASE_NOT_PUBLISHED' });
    await env.releases.setRing(ctx, IT, 'pilot', 'agent', '0.7.1', false);
    await env.releases.setStatus(ctx, IT, r.releaseId, 'published');
    await assert.rejects(env.releases.setRing(ctx, IT, 'it', 'agent', '0.7.1', false), { code: 'ITA_RING_TOO_EARLY' });
    const forced = await env.releases.setRing(ctx, IT, 'it', 'agent', '0.7.1', true);
    assert.equal(forced.targetVersion, '0.7.1');
    env.clock.advance(RING_OBSERVE_MS / 1000);
    assert.equal((await env.releases.setRing(ctx, IT, 'all', 'agent', '0.7.1', false)).targetVersion, '0.7.1');
    // 撤回:清除所有以此為目標的環
    const revoked = await env.releases.setStatus(ctx, IT, r.releaseId, 'revoked');
    assert.deepEqual(revoked.clearedRings.sort(), ['all', 'it', 'pilot']);
    await assert.rejects(env.releases.setRing(ctx, IT, 'pilot', 'agent', '0.7.1', false), { code: 'ITA_RELEASE_REVOKED' });
    await assert.rejects(env.releases.setStatus(ctx, IT, r.releaseId, 'published'), { code: 'ITA_RELEASE_STATUS' });
  });

  it('Watchdog 上報:所屬環有新版 → target 帶下載資訊並記 pending;已是目標 → null;draft 不給非 pilot 裝置', async () => {
    await register();
    await env.releases.setRing(ctx, IT, 'pilot', 'agent', '0.7.1', false);
    assert.deepEqual(await env.releases.onWatchdogReport(ctx, device, report()), { agent: null, watchdog: null }, '裝置在 all 環');
    await env.releases.setDeviceRing(ctx, IT, device.deviceId, 'pilot');
    const t = await env.releases.onWatchdogReport(ctx, device, report());
    assert.deepEqual(t.agent, {
      version: '0.7.1',
      url: '/agent/v1/releases/agent/0.7.1/rustit-agent.exe',
      sha256: sha,
      size_bytes: 14,
      signer_thumbprints: [SIGNER],
    });
    assert.equal(t.watchdog, null);
    assert.equal(env.store.upgrades[0]!.state, 'pending');
    // 升級完成:Agent 回報 0.7.1 → 不再下發、紀錄補記成功
    assert.deepEqual(await env.releases.onWatchdogReport(ctx, device, report({ agent: { ...report().agent, version: '0.7.1' } })), {
      agent: null,
      watchdog: null,
    });
    assert.equal(env.store.upgrades[0]!.state, 'succeeded');
  });

  it('同一目標失敗 2 次不再下發並開 upgrade_failed;agent.upgrade 重設後再下發;成功關閉告警', async () => {
    await register();
    await env.releases.setRing(ctx, IT, 'pilot', 'agent', '0.7.1', false);
    await env.releases.setDeviceRing(ctx, IT, device.deviceId, 'pilot');
    const fail = report({
      upgrade: { component: 'agent', target_version: '0.7.1', from_version: '0.7.0', state: 'rolled_back', error_code: 'HEALTH_CHECK_FAILED' },
    });
    await env.releases.onWatchdogReport(ctx, device, report());
    assert.ok((await env.releases.onWatchdogReport(ctx, device, fail)).agent, '第 1 次失敗仍下發');
    assert.equal(env.monitor.alerts.length, 0);
    await env.releases.onWatchdogReport(ctx, device, report({ upgrade: { component: 'agent', target_version: '0.7.1', state: 'downloading' } }));
    assert.equal((await env.releases.onWatchdogReport(ctx, device, fail)).agent, null, '第 2 次失敗後不再下發');
    const alert = env.monitor.alerts.find((a) => a.rule === 'upgrade_failed')!;
    assert.equal(alert.state, 'open');
    assert.equal(JSON.parse(alert.detail).attempts, 2);
    // 重送同一結果不重複計
    await env.releases.onWatchdogReport(ctx, device, fail);
    assert.equal(env.store.upgrades[0]!.attempts, 2);
    await env.releases.applyUpgradeCommand(ctx, device.id, { component: 'agent' }, { emp: 'S1', name: null });
    assert.ok((await env.releases.onWatchdogReport(ctx, device, report())).agent, '重設失敗次數後再下發');
    // 自報成功但回報的版本不是目標:不採用、不關告警
    await env.releases.onWatchdogReport(ctx, device, report({ upgrade: { component: 'agent', target_version: '0.7.1', state: 'succeeded' } }));
    assert.equal(alert.state, 'open');
    const ok = report({ upgrade: { component: 'agent', target_version: '0.7.1', state: 'succeeded' } });
    ok.agent.version = '0.7.1';
    await env.releases.onWatchdogReport(ctx, device, ok);
    assert.equal(alert.state, 'resolved');
  });

  it('還原失敗(ROLLBACK_FAILED)第一次就開 critical', async () => {
    await register();
    await env.releases.setRing(ctx, IT, 'pilot', 'agent', '0.7.1', false);
    await env.releases.setDeviceRing(ctx, IT, device.deviceId, 'pilot');
    await env.releases.onWatchdogReport(ctx, device, report());
    const t = await env.releases.onWatchdogReport(
      ctx,
      device,
      report({ upgrade: { component: 'agent', target_version: '0.7.1', state: 'failed', error_code: 'ROLLBACK_FAILED' } }),
    );
    assert.equal(t.agent, null, '還原失敗不再下發');
    const alert = env.monitor.alerts.find((a) => a.rule === 'upgrade_failed')!;
    assert.equal(alert.severity, 'critical');
    await env.releases.sweep(ctx);
    assert.equal(alert.state, 'open', '掃描不會關掉還原失敗的告警');
  });

  it('第 1 次失敗:照樣下發但保留失敗狀態與錯誤;重送同一個失敗不重複計次', async () => {
    await register();
    await env.releases.setRing(ctx, IT, 'pilot', 'agent', '0.7.1', false);
    await env.releases.setDeviceRing(ctx, IT, device.deviceId, 'pilot');
    await env.releases.onWatchdogReport(ctx, device, report());
    const fail = report({ upgrade: { component: 'agent', target_version: '0.7.1', state: 'rolled_back', error_code: 'HEALTH_CHECK_FAILED' } });
    assert.ok((await env.releases.onWatchdogReport(ctx, device, fail)).agent);
    const u = () => env.store.upgrades[0]!;
    assert.deepEqual([u().state, u().errorCode, u().attempts], ['rolled_back', 'HEALTH_CHECK_FAILED', 1]);
    assert.ok((await env.releases.onWatchdogReport(ctx, device, fail)).agent);
    assert.equal(u().attempts, 1, '重送不重複計次');
    assert.equal(env.monitor.alerts.length, 0);
  });

  it('舊版 Watchdog(0.1.0)不下發也不佔名額', async () => {
    await register();
    await env.releases.setRing(ctx, IT, 'pilot', 'agent', '0.7.1', false);
    await env.releases.setDeviceRing(ctx, IT, device.deviceId, 'pilot');
    assert.deepEqual(await env.releases.onWatchdogReport(ctx, device, report({ watchdog_version: '0.1.0' })), { agent: null, watchdog: null });
    assert.equal(env.store.upgrades.length, 0);
  });

  it('改到 / 移出 pilot 需全部公司角色;其他環只要範圍內', async () => {
    env.sql.setCompanyRaw(device.id, '碩禾');
    const scoped = { ...ctx, scope: only('碩禾') };
    await assert.rejects(env.releases.setDeviceRing(scoped, IT, device.deviceId, 'pilot'), { code: 'ITA_SCOPE_ALL_REQUIRED' });
    assert.equal((await env.releases.setDeviceRing(scoped, IT, device.deviceId, 'it')).ring, 'it');
    await env.releases.setDeviceRing(ctx, IT, device.deviceId, 'pilot');
    await assert.rejects(env.releases.setDeviceRing(scoped, IT, device.deviceId, 'all'), { code: 'ITA_SCOPE_ALL_REQUIRED' });
    await assert.rejects(env.releases.setDeviceRing({ ...ctx, scope: only('OTHER') }, IT, device.deviceId, 'it'), { code: 'ITA_DEVICE_NOT_FOUND' });
  });

  it('agent.upgrade 指定版本:強制版本優先於所屬環(可降版);只能指定 published;到達後清除', async () => {
    env.dir.put('agent', '0.6.0', 'rustit-agent.exe', 'MZ-agent-0.6.0');
    const old = await register('0.6.0');
    await assert.rejects(env.releases.checkUpgradeCommand(ctx, device.id, { component: 'agent', version: '0.6.0' }), { code: 'ITA_RELEASE_NOT_PUBLISHED' });
    await assert.rejects(env.releases.checkUpgradeCommand(ctx, device.id, { component: 'agent', version: '9.9.9' }), { code: 'ITA_RELEASE_NOT_FOUND' });
    await env.releases.setStatus(ctx, IT, old.releaseId, 'published');
    await env.releases.checkUpgradeCommand(ctx, device.id, { component: 'agent', version: '0.6.0' });
    await env.releases.applyUpgradeCommand(ctx, device.id, { component: 'agent', version: '0.6.0' }, { emp: 'S1', name: null });
    assert.equal((await env.releases.onWatchdogReport(ctx, device, report())).agent?.version, '0.6.0');
    const view = await env.releases.deviceUpgrade(ctx, device.deviceId);
    assert.deepEqual([view.upgrades[0]!.targetVersion, view.upgrades[0]!.targetSource, view.upgrades[0]!.forcedBy], ['0.6.0', 'forced', 'S1']);
    await env.releases.onWatchdogReport(ctx, device, report({ agent: { ...report().agent, version: '0.6.0' } }));
    assert.equal(env.store.upgrades[0]!.forcedVersion, null);
  });

  it('同時升級上限:進行中的台數達上限時新的裝置先拿 null;進行中的那台照常拿到', async () => {
    env = setupReleases({ maxConcurrent: 1 });
    env.clock.t = NOW.getTime();
    env.dir.put('agent', '0.7.1', 'rustit-agent.exe', 'MZ');
    const a = await env.service.identify(ctx, DN, FP);
    const b = await env.service.identify(ctx, 'O=GigaNexus Dev,CN=PC-EXAMPLE-02', 'b'.repeat(40));
    const r = await env.releases.register(ctx, IT, { component: 'agent', version: '0.7.1', fileName: 'rustit-agent.exe', signerThumbprints: [SIGNER] });
    await env.releases.setStatus(ctx, IT, r.releaseId, 'published');
    await env.releases.setRing(ctx, IT, 'all', 'agent', '0.7.1', true);
    assert.ok((await env.releases.onWatchdogReport(ctx, a, report())).agent);
    assert.equal((await env.releases.onWatchdogReport(ctx, b, report())).agent, null);
    assert.ok((await env.releases.onWatchdogReport(ctx, a, report())).agent, '進行中的那台不受限');
    // 30 分鐘沒有更新就不計入
    env.clock.advance(31 * 60);
    assert.ok((await env.releases.onWatchdogReport(ctx, b, report())).agent);
  });

  it('環進度只計資料範圍內的電腦;version_mismatch 掃描', async () => {
    await register();
    await env.releases.setRing(ctx, IT, 'pilot', 'agent', '0.7.1', false);
    await env.releases.setDeviceRing(ctx, IT, device.deviceId, 'pilot');
    env.sql.setCompanyRaw(device.id, '碩禾');
    let pilot = (await env.releases.rings(ctx)).items.find((x) => x.ring === 'pilot' && x.component === 'agent')!;
    assert.deepEqual(pilot.progress, { total: 1, atTarget: 0, inProgress: 0, failed: 0, waiting: 1 });
    pilot = (await env.releases.rings({ ...ctx, scope: only('OTHER') })).items.find((x) => x.ring === 'pilot' && x.component === 'agent')!;
    assert.equal(pilot.progress.total, 0);
    // 24 小時後仍是舊版、最近有回報 → version_mismatch;到版後自動關閉
    env.clock.advance(RING_OBSERVE_MS / 1000 + 60);
    env.sql.devices[0]!.lastSeenAt = env.clock.now();
    env.sql.devices[0]!.agentVersion = '0.7.0';
    assert.deepEqual(await env.releases.sweep(ctx), { opened: 1, resolved: 0 });
    env.sql.devices[0]!.agentVersion = '0.7.1';
    assert.deepEqual(await env.releases.sweep(ctx), { opened: 0, resolved: 1 });
  });

  it('Agent 回報替換 Watchdog 的結果(component = watchdog)寫入進度', async () => {
    await env.releases.onAgentUpgradeEvents(ctx, device.id, [
      { type: 'upgrade_failed', data: { component: 'watchdog', to: '0.2.1', rolled_back: true, error_code: 'HEALTH_CHECK_FAILED' } },
    ]);
    const w = env.store.upgrades.find((u) => u.component === 'watchdog')!;
    assert.deepEqual([w.targetVersion, w.state, w.attempts, w.errorCode], ['0.2.1', 'rolled_back', 1, 'HEALTH_CHECK_FAILED']);
  });
});

describe('DeviceService.watchdogReport 與下載 API、管理 API', () => {
  let env: ReturnType<typeof setupReleases>;
  let agent: FastifyInstance;
  let mgmt: FastifyInstance;
  let device: DeviceRecord;
  let sha: string;

  beforeEach(async () => {
    env = setupReleases();
    env.clock.t = NOW.getTime();
    // 帶升級的 DeviceService(與 server.ts 相同的接法)
    const service = new DeviceService(env.sql, env.mongo, env.redis, {
      heartbeatIntervalSec: 30,
      now: env.clock.now,
      monitor: env.monitor,
      upgrades: env.releases,
      onAgentEvents: (c, ref, events) => env.releases.onAgentUpgradeEvents(c, ref, events),
    });
    agent = await buildAgentApp({
      config: { logLevel: 'silent', agentTls: null, trustedProxies: null },
      service,
      contractsDir: CONTRACTS_DIR,
      releases: env.releases,
    });
    const gateway = loadGatewayEnv({ GW_ENV: 'dev', SERVICE_CODE: 'endpoint-api', GW_JWKS_URL: 'http://127.0.0.1:1/jwks' });
    mgmt = await buildMgmtApp({
      config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken: true, scopeAllRoles: [] },
      service,
      releases: env.releases,
    });
    device = await service.identify(ctx, DN, FP);
    sha = env.dir.put('agent', '0.7.1', 'rustit-agent.exe', 'MZ-agent-0.7.1');
  });
  afterEach(async () => {
    await agent.close();
    await mgmt.close();
  });

  const setupPilot = async () => {
    let res = await mgmt.inject({
      method: 'POST',
      url: '/v1/releases',
      payload: { component: 'agent', version: '0.7.1', fileName: 'rustit-agent.exe', signerThumbprints: [SIGNER], notes: '測試' },
    });
    assert.equal(res.statusCode, 200, res.body);
    res = await mgmt.inject({ method: 'PUT', url: '/v1/release-rings/pilot/agent', payload: { targetVersion: '0.7.1' } });
    assert.equal(res.statusCode, 200, res.body);
    res = await mgmt.inject({ method: 'PUT', url: `/v1/devices/${device.deviceId}/ring`, payload: { ring: 'pilot' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().ring, 'pilot');
  };

  it('管理 API:版本清單、未登錄檔案、環進度;非 pilot 設 draft 回 409', async () => {
    assert.equal((await mgmt.inject('/v1/releases/files')).json().items.length, 1);
    await setupPilot();
    assert.equal((await mgmt.inject('/v1/releases?component=agent')).json().items[0].sha256, sha);
    assert.equal((await mgmt.inject('/v1/releases/files')).json().items.length, 0);
    const rings = (await mgmt.inject('/v1/release-rings')).json().items;
    assert.equal(rings.length, 6);
    const res = await mgmt.inject({ method: 'PUT', url: '/v1/release-rings/all/agent', payload: { targetVersion: '0.7.1' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'ITA_RELEASE_NOT_PUBLISHED');
    // 目標設為 null(不升級)
    const cleared = await mgmt.inject({ method: 'PUT', url: '/v1/release-rings/pilot/agent', payload: { targetVersion: null } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().targetVersion, null);
    assert.equal(
      (await mgmt.inject({ method: 'POST', url: '/v1/releases', payload: { component: 'agent', version: '../x', fileName: 'a', signerThumbprints: [SIGNER] } }))
        .statusCode,
      400,
    );
  });

  it('Watchdog 上報回應帶 target;Watchdog 上報的 upgrade_failed(component = agent)寫入,component = watchdog 略過', async () => {
    await setupPilot();
    const res = await agent.inject({ method: 'POST', url: '/agent/v1/watchdog/report', headers: certHeaders(), payload: report() as object });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().target.agent.version, '0.7.1');
    const up = example<WatchdogReportRequest>('watchdog-report-upgrade.sample.json');
    const ev = up.events![0]!;
    const r2 = await agent.inject({
      method: 'POST',
      url: '/agent/v1/watchdog/report',
      headers: certHeaders(),
      payload: { ...up, events: [ev, { ...ev, event_id: '5b1e7c2d-3f4a-4b5c-8d6e-7f8091a2b3c5', data: { ...ev.data, component: 'watchdog' } }] } as object,
    });
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(r2.json().accepted.length, 2);
    assert.deepEqual(
      env.sql.agentEvents.filter((e) => e.type === 'upgrade_failed').map((e) => JSON.parse(e.data).component),
      ['agent'],
    );
  });

  it('下載:只給被指派的目標;整檔 200、Range 206;非目標 404;檔案被換掉 409;開始下載記稽核', async () => {
    const url = '/agent/v1/releases/agent/0.7.1/rustit-agent.exe';
    assert.equal((await agent.inject({ url, headers: certHeaders() })).statusCode, 404, '尚未指派');
    await setupPilot();
    let res = await agent.inject({ url, headers: certHeaders() });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'MZ-agent-0.7.1');
    assert.equal(res.headers['x-file-sha256'], sha);
    assert.equal(res.headers['accept-ranges'], 'bytes');
    res = await agent.inject({ url, headers: { ...certHeaders(), range: 'bytes=3-' } });
    assert.equal(res.statusCode, 206);
    assert.equal(res.body, 'agent-0.7.1');
    assert.equal(res.headers['content-range'], 'bytes 3-13/14');
    res = await agent.inject({ url, headers: { ...certHeaders(), range: 'bytes=99-' } });
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers['content-range'], 'bytes */14');
    await agent.inject({ url, headers: certHeaders() });
    assert.equal(env.sql.events.filter((e) => e.type === 'release_download').length, 1, '從 0 開始才記,同一版本每小時一次');
    assert.equal((await agent.inject({ url: '/agent/v1/releases/agent/0.7.1/other.exe', headers: certHeaders() })).statusCode, 404);
    assert.equal((await agent.inject({ url: '/agent/v1/releases/agent/0.6.0/rustit-agent.exe', headers: certHeaders() })).statusCode, 404);
    writeFileSync(path.join(env.dir.root, 'agent', '0.7.1', 'rustit-agent.exe'), 'MZ-tampered!!!');
    res = await agent.inject({ url, headers: certHeaders() });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'ITA_RELEASE_FILE_CHANGED');
    // 沒有裝置憑證
    assert.equal((await agent.inject({ url })).statusCode, 401);
  });
});

describe('agent.upgrade 指令(CommandDispatcher kindHooks)', () => {
  it('建立前檢查版本、建立後記錄強制版本;basic 路徑不可建立', async () => {
    const env = setupReleases();
    const store = new MemoryCommandStore(env.sql);
    const commands = new CommandDispatcher(store, env.sql, env.service, {
      now: env.clock.now,
      kindHooks: {
        'agent.upgrade': {
          check: (c, ref, p) => env.releases.checkUpgradeCommand(c, ref, p),
          apply: (c, ref, p, a) => env.releases.applyUpgradeCommand(c, ref, p, a),
        },
      },
    });
    const d = await env.service.identify(ctx, DN, FP);
    await assert.rejects(commands.create(ctx, IT, 'basic', d.deviceId, { kind: 'agent.upgrade', params: { component: 'agent' } }), {
      code: 'ENDPOINT_COMMAND_LEVEL_MISMATCH',
    });
    await assert.rejects(commands.create(ctx, IT, 'admin', d.deviceId, { kind: 'agent.upgrade', params: { component: 'agent', version: '0.7.1' } }), {
      code: 'ITA_RELEASE_NOT_FOUND',
    });
    assert.equal(store.commands.length, 0, '檢查失敗不建立');
    await assert.rejects(commands.create(ctx, IT, 'admin', d.deviceId, { kind: 'agent.upgrade', params: { component: 'agent', version: 'latest' } }), {
      code: 'VALIDATION_FAILED',
    });
    env.dir.put('agent', '0.7.1', 'rustit-agent.exe', 'MZ');
    const r = await env.releases.register(ctx, IT, { component: 'agent', version: '0.7.1', fileName: 'rustit-agent.exe', signerThumbprints: [SIGNER] });
    await env.releases.setStatus(ctx, IT, r.releaseId, 'published');
    const cmd = await commands.create(ctx, IT, 'admin', d.deviceId, { kind: 'agent.upgrade', params: { component: 'agent', version: '0.7.1' } });
    assert.equal(cmd.kind, 'agent.upgrade');
    assert.deepEqual([env.store.upgrades[0]!.forcedVersion, env.store.upgrades[0]!.forcedByEmp], ['0.7.1', 'S000001']);
  });
});
