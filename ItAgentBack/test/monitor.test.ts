/**
 * P5 監測(docs/P5-MONITOR-DESIGN.md):資產前後比對(change-detector)、告警規則(evaluate)、心跳健康摘要、
 * 資產變更事件與硬體變更告警、告警掃描(開 / 更新 / 緩衝關閉 / 停用時關閉)、告警 API 與健康走勢。
 * 經記憶體儲存與管理 API(DEV_SKIP_TOKEN);SQL 語句由整合測試涵蓋。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv } from '@giganexus/backend-sdk';
import type { FastifyInstance } from 'fastify';
import type { ComputerInfo } from '../src/contracts.js';
import { buildMgmtApp } from '../src/mgmt-app.js';
import { DEFAULT_THRESHOLDS, evaluate } from '../src/services/alert-service.js';
import { BULK_LIMIT, detectChanges } from '../src/services/change-detector.js';
import { healthFrom } from '../src/services/device-service.js';
import type { MonitorTarget } from '../src/stores/types.js';
import { ALL, DN, FP, FakeConnection, inventoryRequest, only, setup } from './helpers.js';

const base = (): ComputerInfo => structuredClone(inventoryRequest().inventory);

describe('資產前後比對(change-detector)', () => {
  it('第一份不比;內容相同沒有事件', () => {
    assert.deepEqual(detectChanges(null, base()), []);
    assert.deepEqual(detectChanges(base(), base()), []);
  });

  it('軟體安裝 / 移除 / 更新(同名多版本以版本集合比較)', () => {
    const prev = base();
    prev.software = [
      { name: 'A', version: '1', publisher: 'P', install_date: '' },
      { name: 'B', version: '1', publisher: 'P', install_date: '' },
      { name: 'VC', version: '14.1', publisher: 'M', install_date: '' },
      { name: 'VC', version: '14.2', publisher: 'M', install_date: '' },
    ];
    const next = base();
    next.software = [
      { name: 'B', version: '2', publisher: 'P', install_date: '' },
      { name: 'C', version: '3', publisher: 'Q', install_date: '' },
      { name: 'VC', version: '14.2', publisher: 'M', install_date: '' },
      { name: 'VC', version: '14.1', publisher: 'M', install_date: '' },
    ];
    const ev = detectChanges(prev, next);
    assert.deepEqual(
      ev.map((e) => [e.type, e.data.name]),
      [
        ['software_updated', 'B'],
        ['software_installed', 'C'],
        ['software_removed', 'A'],
      ],
    );
    assert.deepEqual(ev[0]!.data, { name: 'B', publisher: 'P', from: '1', to: '2' });
  });

  it(`超過 ${BULK_LIMIT} 項改記一筆 software_changed_bulk`, () => {
    const next = base();
    next.software = Array.from({ length: BULK_LIMIT + 1 }, (_, i) => ({ name: `S${i}`, version: '1', publisher: '', install_date: '' }));
    const ev = detectChanges(base(), next);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.type, 'software_changed_bulk');
    assert.equal((ev[0]!.data.names as string[]).length, 20);
  });

  it('硬體:記憶體、磁碟序號、BIOS 序號變更各一筆;USB 外接磁碟與查不到的元件不算', () => {
    const prev = base();
    const next = base();
    next.memory_modules = [next.memory_modules[0]!, { ...next.memory_modules[1]!, capacity: 17179869184, part_number: 'EX16G' }];
    next.physical_disks = [
      { ...next.physical_disks[0]!, serial: 'NEW-DISK' },
      { model: 'USB Stick', serial: 'U1', size: 1, interface: 'USB', media_type: 'Removable Media' },
    ];
    next.identity.bios_serial = 'NEW-SN';
    next.gpus = [];
    const ev = detectChanges(prev, next);
    assert.deepEqual(
      ev.map((e) => e.data.component),
      ['memory', 'disk', 'bios'],
    );
    assert.ok((ev[1]!.data.after as string[])[0]!.includes('NEW-DISK'));
  });
});

const target = (patch: Partial<MonitorTarget> = {}): MonitorTarget => ({
  deviceRef: 1,
  lastSeenAt: new Date('2026-10-19T00:00:00Z'),
  clockSkewMs: 0,
  health: null,
  unexpectedRestarts24h: 0,
  openRules: [],
  ...patch,
});
const health = (patch: Record<string, unknown> = {}) =>
  ({
    deviceRef: 1,
    healthAt: new Date('2026-10-19T00:00:00Z'),
    certNotAfter: null,
    watchdogVersion: null,
    watchdogReportAt: null,
    agentServiceState: null,
    agentStartType: null,
    agentStatusOk: null,
    agentLastError: null,
    agentRestarts24h: null,
    ...patch,
  }) as MonitorTarget['health'];
const NOW = new Date('2026-10-19T00:05:00Z');
const rules = (t: MonitorTarget, now = NOW) => evaluate(t, now, DEFAULT_THRESHOLDS).map((h) => h.rule);

describe('資產比對的誤報防護', () => {
  it('磁碟序號這次讀不到(型號 + 容量相同)不算變更;遠端桌面 / 虛擬顯示卡出現或消失不算變更', () => {
    const prev = base();
    const next = base();
    next.physical_disks = [{ ...next.physical_disks[0]!, serial: '' }];
    next.gpus = [...next.gpus, { name: 'Microsoft Remote Display Adapter', driver_version: '', resolution: '' }];
    assert.deepEqual(detectChanges(prev, next), []);
  });

  it('硬體變更的內容序列化後不超過 2,000 字元', () => {
    const next = base();
    next.memory_modules = Array.from({ length: 30 }, (_, i) => ({
      slot: `DIMM ${i} ${'x'.repeat(200)}`,
      capacity: 1,
      speed_mhz: 1,
      manufacturer: 'M',
      part_number: 'P',
    }));
    const [ev] = detectChanges(base(), next);
    assert.equal(ev!.data.component, 'memory');
    assert.ok(JSON.stringify(ev!.data).length <= 2000);
  });
});

describe('告警規則(evaluate)', () => {
  it('正常裝置沒有告警', () => {
    assert.deepEqual(rules(target({ health: health({ diskMinFreePct: 50 }) })), []);
  });

  it('離線超過 7 天', () => {
    assert.deepEqual(rules(target(), new Date('2026-10-26T00:00:01Z')), ['offline_long']);
    assert.deepEqual(rules(target(), new Date('2026-10-25T23:59:59Z')), []);
  });

  it('磁碟:< 10% 開、< 5% critical;已開時回到 15% 以上才關', () => {
    const hit = evaluate(target({ health: health({ diskMinFreePct: 4, diskMinFreeDrive: 'C:' }) }), NOW, DEFAULT_THRESHOLDS);
    assert.deepEqual(hit, [{ rule: 'disk_low', severity: 'critical', detail: { drive: 'C:', freePct: 4 } }]);
    assert.deepEqual(rules(target({ health: health({ diskMinFreePct: 12 }) })), []);
    assert.deepEqual(rules(target({ health: health({ diskMinFreePct: 12 }), openRules: ['disk_low'] })), ['disk_low']);
    assert.deepEqual(rules(target({ health: health({ diskMinFreePct: 15 }), openRules: ['disk_low'] })), []);
  });

  it('非正常重啟 ≥ 3;Watchdog 24 小時內的統計取較大值', () => {
    assert.deepEqual(rules(target({ unexpectedRestarts24h: 3 })), ['agent_restarts']);
    assert.deepEqual(
      rules(target({ unexpectedRestarts24h: 1, health: health({ watchdogReportAt: NOW, agentRestarts24h: 4 }) })).includes('agent_restarts'),
      true,
    );
    assert.deepEqual(
      rules(target({ unexpectedRestarts24h: 1, health: health({ watchdogReportAt: new Date('2026-10-17T00:00:00Z'), agentRestarts24h: 4 }) })),
      [],
    );
  });

  it('憑證 30 天內到期(過期為 critical)、時鐘偏差 > 5 分鐘', () => {
    assert.deepEqual(rules(target({ health: health({ certNotAfter: new Date('2026-11-10T00:00:00Z') }) })), ['cert_expiring']);
    assert.equal(evaluate(target({ health: health({ certNotAfter: new Date('2026-10-18T00:00:00Z') }) }), NOW, DEFAULT_THRESHOLDS)[0]!.severity, 'critical');
    assert.deepEqual(rules(target({ health: health({ certNotAfter: new Date('2027-10-18T00:00:00Z') }) })), []);
    assert.deepEqual(rules(target({ clockSkewMs: -300_001 })), ['clock_skew']);
  });

  it('agent_silent:Watchdog 15 分鐘內有回報但 Agent 超過 15 分鐘沒有心跳', () => {
    const t = target({ lastSeenAt: new Date('2026-10-18T23:40:00Z'), health: health({ watchdogReportAt: new Date('2026-10-19T00:03:00Z') }) });
    assert.deepEqual(rules(t), ['agent_silent']);
    assert.deepEqual(rules({ ...t, health: health({ watchdogReportAt: new Date('2026-10-18T23:40:00Z') }) }), []);
  });
});

describe('healthFrom', () => {
  it('轉 camelCase、略過非數字與負數;空物件為 undefined', () => {
    assert.deepEqual(healthFrom({ cpu_pct: 12, mem_used_pct: 'x', disk_min_free_pct: -1, disk_min_free_drive: 'C:', uptime_s: 5 }), {
      cpuPct: 12,
      diskMinFreeDrive: 'C:',
      uptimeS: 5,
    });
    assert.equal(healthFrom({}), undefined);
    assert.equal(healthFrom(undefined), undefined);
  });
});

describe('監測流程(DeviceService + AlertService + 管理 API)', () => {
  let env: ReturnType<typeof setup>;
  let app: FastifyInstance;
  const ctx = () => ({ log: app.log, requestId: 't', scope: ALL });

  beforeEach(async () => {
    env = setup();
    const gateway = loadGatewayEnv({ GW_ENV: 'dev', SERVICE_CODE: 'endpoint-api', GW_JWKS_URL: 'http://127.0.0.1:1/jwks' });
    app = await buildMgmtApp({
      config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken: true, scopeAllRoles: [] },
      service: env.service,
      alerts: env.alerts,
    });
  });

  async function online() {
    const d = await env.service.identify(ctx(), DN, FP);
    await env.service.connected(ctx(), d, new FakeConnection());
    return d;
  }

  it('心跳健康摘要:在線取最近一則;第一則就落盤,之後每 5 分鐘;離線後清單顯示最後落盤的值', async () => {
    const d = await online();
    await env.service.heartbeat(ctx(), d, { health: { cpu_pct: 10, disk_min_free_pct: 40 } });
    env.clock.advance(30);
    await env.service.heartbeat(ctx(), d, { health: { cpu_pct: 20, disk_min_free_pct: 40 } });
    assert.equal(env.monitor.health.get(d.id)!.cpuPct, 10, '5 分鐘內不重複落盤');
    let list = (await app.inject('/v1/devices')).json();
    assert.equal(list.items[0].health.cpuPct, 20);
    assert.equal(list.items[0].openAlerts, 0);
    env.clock.advance(300);
    await env.service.heartbeat(ctx(), d, { health: { cpu_pct: 30, disk_min_free_pct: 40 } });
    assert.equal(env.monitor.health.get(d.id)!.cpuPct, 30);
    env.redis.online.clear();
    list = (await app.inject('/v1/devices')).json();
    assert.equal(list.items[0].online, false);
    assert.equal(list.items[0].health.cpuPct, 30);
  });

  it('hello 的憑證到期日落盤,詳情回 certNotAfter;舊版 Agent 沒有健康時 health 為 null', async () => {
    const d = await online();
    await env.service.hello(ctx(), d, { agent_version: '0.5.0', host_name: 'PC-EXAMPLE-01', cert_not_after: '2027-10-14T08:00:00Z' });
    const detail = (await app.inject(`/v1/devices/${d.deviceId}`)).json();
    assert.equal(detail.certNotAfter, '2027-10-14T08:00:00.000Z');
    assert.equal(detail.health, null);
    assert.equal(detail.watchdog, null);
    assert.deepEqual(detail.alerts, []);
  });

  it('移除軟體 → 下次資產產生 software_removed;換硬體 → hardware_changed 與 critical 告警,不自動關閉', async () => {
    const d = await env.service.identify(ctx(), DN, FP);
    await env.service.ingestInventory(ctx(), d, inventoryRequest());
    assert.equal(env.sql.hostEvents.length, 0, '第一份不比對');
    const inv = base();
    const removed = inv.software.shift()!;
    inv.identity.bios_serial = 'NEW-SN';
    await env.service.ingestInventory(ctx(), d, inventoryRequest({ content_hash: 'c'.repeat(64), collected_at: '2026-10-07T08:00:00Z', inventory: inv }));
    assert.deepEqual(
      env.sql.hostEvents.map((e) => [e.type, e.data.name ?? e.data.component]),
      [
        ['hardware_changed', 'bios'],
        ['software_removed', removed.name],
      ],
    );
    const events = (await app.inject(`/v1/devices/${d.deviceId}/events`)).json();
    assert.ok(events.items.some((e: { type: string }) => e.type === 'software_removed'));
    let alerts = (await app.inject('/v1/alerts')).json().items;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].rule, 'hardware_changed');
    assert.equal(alerts[0].severity, 'critical');
    // 掃描不會自動關閉事件類告警
    await env.alerts.sweep(ctx());
    alerts = (await app.inject('/v1/alerts')).json().items;
    assert.equal(alerts.length, 1);
    // 手動關閉
    const res = await app.inject({ method: 'POST', url: `/v1/alerts/${alerts[0].alertId}/resolve`, payload: { note: '更換主機板,已確認' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().state, 'resolved');
    assert.equal(res.json().resolvedBy, 'manual');
    assert.equal(res.json().resolvedByEmp, 'dev');
    const again = await app.inject({ method: 'POST', url: `/v1/alerts/${alerts[0].alertId}/resolve`, payload: { note: 'x' } });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().code, 'ITA_ALERT_NOT_OPEN');
    assert.equal((await app.inject('/v1/alerts')).json().items.length, 0);
    assert.equal((await app.inject('/v1/alerts?state=resolved')).json().items.length, 1);
  });

  it('補傳的舊快照與內容相同的回報不比對', async () => {
    const d = await env.service.identify(ctx(), DN, FP);
    await env.service.ingestInventory(ctx(), d, inventoryRequest({ collected_at: '2026-10-07T08:00:00Z' }));
    const inv = base();
    inv.software = [];
    await env.service.ingestInventory(ctx(), d, inventoryRequest({ content_hash: 'd'.repeat(64), collected_at: '2026-10-06T00:00:00Z', inventory: inv }));
    await env.service.ingestInventory(ctx(), d, inventoryRequest({ collected_at: '2026-10-08T08:00:00Z' }));
    assert.equal(env.sql.hostEvents.length, 0);
  });

  it('掃描:磁碟不足開告警、重複掃描只更新、恢復後自動關閉;停用的裝置告警自動關閉', async () => {
    const d = await online();
    await env.service.heartbeat(ctx(), d, { health: { disk_min_free_pct: 6, disk_min_free_drive: 'C:' } });
    assert.deepEqual(await env.alerts.sweep(ctx()), { opened: 1, resolved: 0 });
    assert.deepEqual(await env.alerts.sweep(ctx()), { opened: 0, resolved: 0 });
    assert.equal(env.monitor.alerts.length, 1);
    env.clock.advance(301);
    await env.service.heartbeat(ctx(), d, { health: { disk_min_free_pct: 12 } });
    assert.deepEqual(await env.alerts.sweep(ctx()), { opened: 0, resolved: 0 }, '12% 仍在緩衝內');
    env.clock.advance(301);
    await env.service.heartbeat(ctx(), d, { health: { disk_min_free_pct: 20 } });
    assert.deepEqual(await env.alerts.sweep(ctx()), { opened: 0, resolved: 1 });
    assert.equal(env.monitor.alerts[0]!.resolvedBy, 'auto');
    // 再次不足 → 新開一筆;停用後掃描關閉
    env.clock.advance(301);
    await env.service.heartbeat(ctx(), d, { health: { disk_min_free_pct: 3 } });
    await env.alerts.sweep(ctx());
    assert.equal(env.monitor.alerts.filter((a) => a.state === 'open').length, 1);
    env.sql.byId(d.id).status = 'disabled';
    assert.deepEqual(await env.alerts.sweep(ctx()), { opened: 0, resolved: 1 });
  });

  it('24 小時內 3 次非正常重啟 → agent_restarts', async () => {
    const d = await env.service.identify(ctx(), DN, FP);
    const ev = (i: number, exit: string) => ({
      event_id: `00000000-0000-4000-8000-00000000000${i}`,
      type: 'agent_started',
      occurred_at: env.clock.now().toISOString(),
      data: { agent_version: '0.5.0', previous_exit: exit },
    });
    await env.service.ingestEvents(ctx(), d, { events: [ev(1, 'unexpected'), ev(2, 'stop'), ev(3, 'unexpected')] });
    await env.alerts.sweep(ctx());
    assert.equal(env.monitor.alerts.length, 0);
    await env.service.ingestEvents(ctx(), d, { events: [ev(4, 'unexpected')] });
    await env.alerts.sweep(ctx());
    assert.deepEqual(
      env.monitor.alerts.map((a) => a.rule),
      ['agent_restarts'],
    );
  });

  it('資料範圍:別家公司的告警看不到、不能關閉(404)', async () => {
    const d = await online();
    env.sql.setCompanyRaw(d.id, 'GSMC');
    await env.service.heartbeat(ctx(), d, { health: { disk_min_free_pct: 1 } });
    await env.alerts.sweep(ctx());
    const other = { log: app.log, requestId: 't', scope: only('OTHER') };
    assert.deepEqual((await env.alerts.list(other, { limit: 50 })).items, []);
    assert.deepEqual((await env.alerts.list(other, { deviceId: d.deviceId, limit: 50 })).items, []);
    await assert.rejects(env.alerts.resolve(other, { emp: 'x', name: null }, env.monitor.alerts[0]!.alertId, 'n'), { code: 'ITA_ALERT_NOT_FOUND' });
    assert.equal((await env.alerts.list({ ...other, scope: only('GSMC') }, { limit: 50 })).items.length, 1);
  });

  it('健康走勢:5 分鐘分桶(CPU 平均、磁碟取最小)、依時間排序;Mongo 無法使用回 503', async () => {
    const d = await online();
    await env.service.heartbeat(ctx(), d, { health: { cpu_pct: 10, disk_min_free_pct: 40 } });
    env.clock.advance(30);
    await env.service.heartbeat(ctx(), d, { health: { cpu_pct: 30, disk_min_free_pct: 30 } });
    env.clock.advance(300);
    await env.service.heartbeat(ctx(), d, { health: { cpu_pct: 50 } });
    const r = (await app.inject(`/v1/devices/${d.deviceId}/health?hours=1`)).json();
    assert.equal(r.bucketSec, 300);
    assert.deepEqual(
      r.points.map((p: { cpuPct: number; diskMinFreePct: number | null }) => [p.cpuPct, p.diskMinFreePct]),
      [
        [20, 30],
        [50, null],
      ],
    );
    env.mongo.fail = true;
    const res = await app.inject(`/v1/devices/${d.deviceId}/health`);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'ITA_HISTORY_UNAVAILABLE');
  });
});
