/**
 * P3 資料呈現(docs/P3-DATA-DESIGN.md):清單分頁與篩選、事件、下載資產 JSON、停用 / 退役、合併疑似同一台(A1)。
 * 經管理 API(DEV_SKIP_TOKEN,身分 dev)與記憶體儲存;SQL 語句由整合測試涵蓋。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv } from '@giganexus/backend-sdk';
import type { FastifyInstance } from 'fastify';
import type { InventoryRequest } from '../src/contracts.js';
import { buildMgmtApp } from '../src/mgmt-app.js';
import { inventoryFileName, WS_CLOSE_DEVICE_CHANGED } from '../src/services/device-service.js';
import { likeContains } from '../src/stores/sql-store.js';
import { ALL, FakeConnection, inventoryRequest, setup } from './helpers.js';

const HW = 'a'.repeat(64);
const DN2 = 'O=GigaNexus Dev,CN=PC-EXAMPLE-02';
const FP2 = 'b'.repeat(40);

let env: ReturnType<typeof setup>;
let app: FastifyInstance;
const ctx = () => ({ log: app.log, requestId: 't', scope: ALL });

/** 第二台電腦:名稱、IP、MAC、軟體、OS 都不同 */
function secondInventory(patch: Partial<InventoryRequest> = {}): InventoryRequest {
  const base = inventoryRequest();
  const inv = structuredClone(base.inventory);
  inv.system.host_name = 'PC-EXAMPLE-02';
  inv.system.os_name = 'Windows 10 Pro';
  inv.system.os_display_version = '22H2';
  inv.network = [{ ...inv.network[0]!, mac: '00:00:5E:00:53:99', ips: ['203.0.113.7'] }];
  inv.software = [{ name: '7-Zip 24.08 (x64)', version: '24.08', publisher: 'Igor Pavlov', install_date: '2026-09-01' }];
  return { ...base, content_hash: 'f'.repeat(64), collected_at: '2026-10-07T08:00:00Z', inventory: inv, ...patch };
}

async function seed() {
  const d1 = await env.service.identify(ctx(), 'O=GigaNexus Dev,CN=PC-EXAMPLE-01', '574f45a0357c7d134a9e2f78cd7ed4dc0444ee77');
  await env.service.ingestInventory(ctx(), d1, inventoryRequest());
  const d2 = await env.service.identify(ctx(), DN2, FP2);
  await env.service.ingestInventory(ctx(), d2, secondInventory());
  return { d1, d2 };
}

const get = (url: string) => app.inject({ url });
const json = (method: 'PUT' | 'POST', url: string, payload: object) => app.inject({ method, url, payload });

beforeEach(async () => {
  env = setup();
  const gateway = loadGatewayEnv({ GW_ENV: 'dev', SERVICE_CODE: 'endpoint-api', GW_JWKS_URL: 'http://127.0.0.1:1/jwks' });
  app = await buildMgmtApp({ config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken: true, scopeAllRoles: [] }, service: env.service });
});

describe('清單分頁與篩選', () => {
  it('回 total / page / pageSize,依電腦名稱排序分頁', async () => {
    await seed();
    const p1 = (await get('/v1/devices?pageSize=1')).json();
    assert.equal(p1.total, 2);
    assert.equal(p1.page, 1);
    assert.equal(p1.pageSize, 1);
    assert.deepEqual(
      p1.items.map((d: { computerName: string }) => d.computerName),
      ['PC-EXAMPLE-01'],
    );
    const p2 = (await get('/v1/devices?pageSize=1&page=2')).json();
    assert.equal(p2.items[0].computerName, 'PC-EXAMPLE-02');
    assert.equal((await get('/v1/devices?page=3&pageSize=1')).json().items.length, 0);
    assert.equal((await get('/v1/devices?pageSize=201')).statusCode, 400);
  });

  it('關鍵字比對名稱、IP、MAC(- 或 :)、裝置代碼;軟體名稱;作業系統;在線', async () => {
    const { d1, d2 } = await seed();
    await env.service.connected(ctx(), d1, new FakeConnection());
    const names = async (qs: string) => (await get(`/v1/devices?${qs}`)).json().items.map((d: { computerName: string }) => d.computerName);
    assert.deepEqual(await names('q=example-02'), ['PC-EXAMPLE-02']);
    assert.deepEqual(await names('q=203.0.113'), ['PC-EXAMPLE-02']);
    assert.deepEqual(await names('q=00-00-5E-00-53-99'), ['PC-EXAMPLE-02']);
    assert.deepEqual(await names(`q=${d2.deviceId.slice(0, 8)}`), ['PC-EXAMPLE-02']);
    assert.deepEqual(await names('software=7-zip'), ['PC-EXAMPLE-02']);
    assert.deepEqual(await names('software=office'), ['PC-EXAMPLE-01']);
    assert.deepEqual(await names('os=windows%2010'), ['PC-EXAMPLE-02']);
    assert.deepEqual(await names('online=true'), ['PC-EXAMPLE-01']);
    assert.deepEqual(await names('online=false'), ['PC-EXAMPLE-02']);
    assert.deepEqual(await names('q=%20%20'), ['PC-EXAMPLE-01', 'PC-EXAMPLE-02'], '空白關鍵字不篩選');
    assert.equal((await get('/v1/devices?status=gone')).statusCode, 400);
  });

  it('LIKE 跳脫萬用字元;下載檔名只留安全字元、日期為台北時間', () => {
    assert.equal(likeContains('50%_a[b\\'), '%50\\%\\_a\\[b\\\\%');
    assert.equal(inventoryFileName('PC 01/測試', new Date('2026-10-15T17:00:00Z')), 'PC_01___-20261016.json');
    assert.equal(inventoryFileName('', null), 'device-unknown.json');
  });
});

describe('詳情、事件、下載 JSON', () => {
  it('事件新到舊,依 cursor 往下翻', async () => {
    const { d1 } = await seed();
    await env.service.ingestEvents(ctx(), d1, {
      events: [
        { event_id: '11111111-1111-4111-8111-111111111111', type: 'usb_inserted', occurred_at: '2026-10-06T07:00:00Z', data: { label: 'USB' } },
        { event_id: '22222222-2222-4222-8222-222222222222', type: 'agent_started', occurred_at: '2026-10-06T07:30:00Z', data: {} },
      ],
    } as never);
    const first = (await get(`/v1/devices/${d1.deviceId}/events?limit=2`)).json();
    assert.deepEqual(
      first.items.map((e: { type: string }) => e.type),
      ['agent_started', 'usb_inserted'],
    );
    assert.equal(first.items[1].data.label, 'USB');
    assert.equal(first.items[1].occurredAt, '2026-10-06T07:00:00.000Z');
    assert.ok(first.nextCursor);
    const next = (await get(`/v1/devices/${d1.deviceId}/events?limit=2&cursor=${first.nextCursor}`)).json();
    assert.deepEqual(
      next.items.map((e: { type: string }) => e.type),
      ['registered'],
    );
    assert.equal(next.nextCursor, null);
    assert.equal((await get('/v1/devices/00000000-0000-4000-8000-000000000000/events')).statusCode, 404);
  });

  it('inventory.json 原樣 snake_case 並帶下載標頭;尚未回報資產回 404', async () => {
    const { d1 } = await seed();
    const res = await get(`/v1/devices/${d1.deviceId}/inventory.json`);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    assert.equal(res.headers['content-disposition'], 'attachment; filename="PC-EXAMPLE-01-20261006.json"');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.json().system.host_name, 'PC-EXAMPLE-01');
    const bare = await env.service.identify(ctx(), 'O=GigaNexus Dev,CN=PC-NEW', 'c'.repeat(40));
    const none = await get(`/v1/devices/${bare.deviceId}/inventory.json`);
    assert.equal(none.statusCode, 404);
    assert.equal(none.json().code, 'ITA_INVENTORY_NOT_FOUND');
  });
});

describe('停用 / 退役(endpoint.command.admin)', () => {
  it('停用:關閉 WebSocket、寫稽核、Agent 再連線 403;相同狀態不重複寫', async () => {
    const { d1 } = await seed();
    const conn = new FakeConnection();
    await env.service.connected(ctx(), d1, conn);
    const res = await json('PUT', `/v1/devices/${d1.deviceId}/status`, { status: 'disabled', reason: '送修' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { deviceId: d1.deviceId, status: 'disabled', changed: true });
    assert.equal(conn.closed, WS_CLOSE_DEVICE_CHANGED);
    assert.ok(env.sql.events.some((e) => e.type === 'disabled' && e.detail.includes('dev') && e.detail.includes('送修')));
    await assert.rejects(env.service.identify(ctx(), d1.certDn, d1.certFp), { code: 'ITA_DEVICE_DISABLED' });
    assert.equal((await json('PUT', `/v1/devices/${d1.deviceId}/status`, { status: 'disabled' })).json().changed, false);
    assert.equal((await json('PUT', `/v1/devices/${d1.deviceId}/status`, { status: 'gone' })).statusCode, 400);
  });

  it('退役:清單預設不列、status=retired 才列;改回 active 後恢復', async () => {
    const { d2 } = await seed();
    await json('PUT', `/v1/devices/${d2.deviceId}/status`, { status: 'retired' });
    const names = async (qs = '') => (await get(`/v1/devices?${qs}`)).json().items.map((d: { computerName: string }) => d.computerName);
    assert.deepEqual(await names(), ['PC-EXAMPLE-01']);
    const retired = (await get('/v1/devices?status=retired')).json().items;
    assert.equal(retired.length, 1);
    assert.ok(retired[0].retiredAt);
    await assert.rejects(env.service.identify(ctx(), DN2, FP2), { code: 'ITA_DEVICE_RETIRED' });
    await json('PUT', `/v1/devices/${d2.deviceId}/status`, { status: 'active' });
    assert.deepEqual(await names(), ['PC-EXAMPLE-01', 'PC-EXAMPLE-02']);
  });
});

describe('合併疑似同一台(A1)', () => {
  /** 舊裝置 d1(離線)與重灌後的新登錄 d2,硬體指紋相同 */
  async function pair() {
    const { d1, d2 } = await seed();
    env.sql.byId(d1.id).hwFingerprint = HW;
    env.sql.byId(d2.id).hwFingerprint = HW;
    return { d1, d2 };
  }

  it('清單與詳情標記疑似同一台', async () => {
    const { d1, d2 } = await pair();
    const items = (await get('/v1/devices')).json().items;
    assert.ok(items.every((d: { suspectedDuplicate: boolean }) => d.suspectedDuplicate));
    const detail = (await get(`/v1/devices/${d1.deviceId}`)).json();
    assert.deepEqual(
      detail.suspectedDuplicates.map((x: { deviceId: string }) => x.deviceId),
      [d2.deviceId],
    );
  });

  it('來源併入舊裝置:deviceId 不變、改用來源憑證、事件與較新資產搬過來、來源退役並關閉 WebSocket;重送回 alreadyMerged', async () => {
    const { d1, d2 } = await pair();
    const conn = new FakeConnection();
    await env.service.connected(ctx(), d2, conn);
    env.mongo.snapshots.push({ deviceId: d2.deviceId, agentSeq: 9, contentHash: 'x' });
    env.redis.hashes.set(d1.deviceId, 'old-hash');

    const res = await json('POST', `/v1/devices/${d1.deviceId}/merge`, { sourceDeviceId: d2.deviceId, reason: '重灌' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.alreadyMerged, false);
    assert.equal(body.inventoryFrom, 'source');
    assert.ok(body.events >= 1);

    assert.equal(conn.closed, WS_CLOSE_DEVICE_CHANGED);
    assert.ok(env.mongo.snapshots.every((s) => s.deviceId !== d2.deviceId));
    assert.ok(!env.redis.hashes.has(d1.deviceId));
    // Agent 以來源的憑證重連 → 對到舊裝置
    const again = await env.service.identify(ctx(), DN2, FP2);
    assert.equal(again.deviceId, d1.deviceId);

    const items = (await get('/v1/devices')).json().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].deviceId, d1.deviceId);
    assert.equal(items[0].computerName, 'PC-EXAMPLE-02');
    assert.equal(items[0].suspectedDuplicate, false);
    const src = (await get(`/v1/devices/${d2.deviceId}`)).json();
    assert.equal(src.status, 'retired');
    assert.equal(src.mergedInto, d1.deviceId);
    assert.ok(env.sql.events.some((e) => e.type === 'merged' && e.deviceRef === d1.id && e.detail.includes(d2.deviceId)));

    const repeat = (await json('POST', `/v1/devices/${d1.deviceId}/merge`, { sourceDeviceId: d2.deviceId })).json();
    assert.equal(repeat.alreadyMerged, true);
    const status = await json('PUT', `/v1/devices/${d2.deviceId}/status`, { status: 'active' });
    assert.equal(status.statusCode, 409);
    assert.equal(status.json().code, 'ITA_DEVICE_STATUS_INVALID');
  });

  it('拒絕:與自己合併、指紋不同未帶 force、舊裝置在線', async () => {
    const { d1, d2 } = await pair();
    const merge = (target: string, payload: object) => json('POST', `/v1/devices/${target}/merge`, payload);
    const self = await merge(d1.deviceId, { sourceDeviceId: d1.deviceId });
    assert.equal(self.statusCode, 400);
    assert.equal(self.json().code, 'ITA_MERGE_INVALID');

    env.sql.byId(d2.id).hwFingerprint = 'c'.repeat(64);
    const mismatch = await merge(d1.deviceId, { sourceDeviceId: d2.deviceId });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.json().details.reason, 'fingerprint_mismatch');

    await env.service.connected(ctx(), d1, new FakeConnection());
    const online = await merge(d1.deviceId, { sourceDeviceId: d2.deviceId, force: true });
    assert.equal(online.statusCode, 409);
    assert.equal(online.json().details.reason, 'target_online');
    assert.equal(env.sql.calls.filter((c) => c === 'merge').length, 0);
  });

  it('拒絕:新登錄已停用、舊裝置已退役、新登錄早於舊裝置最後回報(曾同時使用)未帶 force', async () => {
    const { d1, d2 } = await pair();
    const merge = (payload: object) => json('POST', `/v1/devices/${d1.deviceId}/merge`, { sourceDeviceId: d2.deviceId, ...payload });
    const reason = async (payload: object = {}) => (await merge(payload)).json().details?.reason;

    env.sql.byId(d2.id).status = 'disabled';
    assert.equal(await reason({ force: true }), 'source_not_active');
    env.sql.byId(d2.id).status = 'active';

    env.sql.byId(d1.id).status = 'retired';
    assert.equal(await reason({ force: true }), 'target_retired');
    env.sql.byId(d1.id).status = 'active';

    env.sql.byId(d1.id).lastSeenAt = new Date(d2.firstSeenAt.getTime() + 60 * 60_000);
    assert.equal(await reason(), 'overlap');
    const forced = await merge({ force: true });
    assert.equal(forced.statusCode, 200);
    assert.equal(forced.json().canceledCommands, 0);
  });
});

describe('軟體清單回填', () => {
  it('分批處理到沒有待回填的裝置', async () => {
    await seed();
    assert.equal(await env.service.backfillSoftware(ctx()), 2);
    assert.equal(await env.service.backfillSoftware(ctx()), 0);
  });
});
