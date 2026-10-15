/**
 * PLATFORM-PLAN P2(主機端):離線補傳比對 POST /agent/v1/sync、端點事件 POST /agent/v1/events、
 * 主機忙碌 429 + Retry-After(A3)、hello 的時鐘偏差(A2)與硬體指紋(A1)、hello_ack 帶主機下發設定。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildAgentApp } from '../src/agent-app.js';
import { CLOCK_SKEW_ALERT_MS, DEFAULT_SETTINGS, SYNC_NEED_LIMIT, settingsVersion } from '../src/services/device-service.js';
import { CONTRACTS_DIR, certHeaders, example, inventoryRequest, setup } from './helpers.js';

const config = { logLevel: 'silent', agentTls: null, trustedProxies: null };
const H1 = inventoryRequest().content_hash;
const h = (c: string) => c.repeat(64);
const SEQ = inventoryRequest().agent_seq;

let env: ReturnType<typeof setup>;
let app: FastifyInstance;

const call = (url: string, payload: unknown, headers: Record<string, string> = certHeaders()) =>
  app.inject({ method: 'POST', url, headers, payload: payload as object });
const pending = (seq: number, at: string, hash: string) => ({ agent_seq: seq, collected_at: at, content_hash: hash });
const ctx = () => ({ log: app.log, requestId: 't' });

describe('離線補傳比對 POST /agent/v1/sync', () => {
  beforeEach(async () => {
    env = setup();
    app = await buildAgentApp({ config, service: env.service, contractsDir: CONTRACTS_DIR });
    // 目前資料:範例快照(seq SEQ、08:00、H1)
    assert.equal((await call('/agent/v1/inventory', inventoryRequest())).json().result, 'stored');
  });

  it('與目前資料同 hash、Mongo 已有同 seq 的列入 skip;同 hash 只要最新一份;need 依蒐集時間由舊到新', async () => {
    const res = await call('/agent/v1/sync', {
      last_acked_seq: SEQ,
      last_acked_hash: H1,
      pending: [
        pending(SEQ, '2026-10-06T08:00:00Z', H1), // Mongo 已有此 (seq, hash)
        pending(SEQ + 1, '2026-10-06T09:00:00Z', H1), // 與目前資料相同
        pending(SEQ + 4, '2026-10-06T12:00:00Z', h('c')),
        pending(SEQ + 2, '2026-10-06T10:00:00Z', h('b')),
        pending(SEQ + 3, '2026-10-06T11:00:00Z', h('b')), // 同 hash 較新的一份
      ],
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.need, [SEQ + 3, SEQ + 4]);
    assert.deepEqual([...body.skip].sort(), [SEQ, SEQ + 1, SEQ + 2].sort());
  });

  it('同 seq 不同 hash(本機暫存重建後 seq 重來)仍列入 need,不被誤刪', async () => {
    const body = (await call('/agent/v1/sync', { pending: [pending(SEQ, '2026-10-07T08:00:00Z', h('a'))] })).json();
    assert.deepEqual(body.need, [SEQ]);
    assert.deepEqual(body.skip, []);
    assert.deepEqual(body.server_state, { status: 'active', last_hash: H1, last_seq: SEQ });
    assert.equal(body.device_id, env.sql.devices[0]!.deviceId);
  });

  it(`need 單次最多 ${SYNC_NEED_LIMIT} 筆;沒列到的既不在 need 也不在 skip(下次 /sync 再比對)`, async () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      pending(SEQ + 10 + i, new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString(), i.toString(16).padStart(2, '0').repeat(32)),
    );
    const body = (await call('/agent/v1/sync', { pending: items })).json();
    assert.equal(body.need.length, SYNC_NEED_LIMIT);
    assert.deepEqual(body.need, items.slice(0, SYNC_NEED_LIMIT).map((p) => p.agent_seq));
    assert.deepEqual(body.skip, []);
  });

  it('Mongo 無法使用時不去重(交給 /inventory 比對);SQL Server 失敗回 503', async () => {
    env.mongo.fail = true;
    const ok = await call('/agent/v1/sync', { pending: [pending(SEQ, '2026-10-06T08:00:00Z', h('a'))] });
    assert.deepEqual(ok.json().need, [SEQ]);
    env.mongo.fail = false;
    env.sql.fail = true;
    const res = await call('/agent/v1/sync', { pending: [] });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'ITA_STORAGE_UNAVAILABLE');
  });

  it('補傳的較舊快照經 /inventory 只進歷史(archived),不覆蓋目前資料', async () => {
    const res = await call('/agent/v1/inventory', inventoryRequest({ agent_seq: SEQ - 5, collected_at: '2026-10-06T07:00:00Z', content_hash: h('d') }));
    assert.equal(res.json().result, 'archived');
    assert.equal(env.sql.inventories.get(1)!.contentHash, H1);
    assert.ok(env.mongo.snapshots.some((s) => s.agentSeq === SEQ - 5));
  });

  it('不符合契約回 400', async () => {
    assert.equal((await call('/agent/v1/sync', { pending: [{ agent_seq: 0 }] })).statusCode, 400);
  });
});

describe('端點事件 POST /agent/v1/events', () => {
  beforeEach(async () => {
    env = setup();
    app = await buildAgentApp({ config, service: env.service, contractsDir: CONTRACTS_DIR });
  });

  it('寫入端點事件(occurred_at 為端點時間、另記 received_at);重送同一 event_id 不重複', async () => {
    const sample = example<{ events: { event_id: string }[] }>('event.sample.json');
    const res = await call('/agent/v1/events', sample);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.json().accepted,
      sample.events.map((e) => e.event_id),
    );
    assert.equal(env.sql.agentEvents.length, 4);
    const offline = env.sql.agentEvents.find((e) => e.type === 'offline_period')!;
    assert.equal(offline.occurredAt.toISOString(), '2026-10-06T09:00:05.120Z');
    assert.equal(offline.receivedAt.toISOString(), env.clock.now().toISOString());
    assert.equal(JSON.parse(offline.data).reason, 'network');

    assert.equal((await call('/agent/v1/events', sample)).statusCode, 200);
    assert.equal(env.sql.agentEvents.length, 4, '重送不重複');
    const twice = { events: [sample.events[0], sample.events[0]] };
    assert.equal((await call('/agent/v1/events', twice)).statusCode, 200);
    assert.equal(env.sql.agentEvents.length, 4, '同一批內重複也只保存一筆');
  });

  it('data 過長時只保存長度;SQL Server 失敗回 503(Agent 保留在本機重送)', async () => {
    const big = { events: [{ event_id: '0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b', type: 'future_event', occurred_at: '2026-10-06T09:00:00Z', data: { s: 'x'.repeat(5000) } }] };
    assert.equal((await call('/agent/v1/events', big)).statusCode, 200);
    assert.equal(JSON.parse(env.sql.agentEvents[0]!.data).truncated, true);
    env.sql.fail = true;
    assert.equal((await call('/agent/v1/events', big)).statusCode, 503);
  });

  it('不符合契約(offline_period 缺欄位、空陣列)回 400', async () => {
    const bad = { events: [{ event_id: '0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b', type: 'offline_period', occurred_at: '2026-10-06T09:00:00Z', data: {} }] };
    assert.equal((await call('/agent/v1/events', bad)).statusCode, 400);
    assert.equal((await call('/agent/v1/events', { events: [] })).statusCode, 400);
  });
});

describe('主機忙碌 429 + Retry-After(A3)', () => {
  beforeEach(() => {
    env = setup();
  });

  it('同時處理數達上限:回 429 ITA_BUSY 與 Retry-After,不查詢資料庫', async () => {
    app = await buildAgentApp({ config: { ...config, agentMaxInflight: 1, busyRetryAfterSec: 45 }, service: env.service, contractsDir: CONTRACTS_DIR });
    // 讓第一個請求卡在 SQL,第二個請求進來時同時處理數已達上限
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const findByDn = env.sql.findByDn.bind(env.sql);
    env.sql.findByDn = async (dn) => {
      await gate;
      return findByDn(dn);
    };
    const first = call('/agent/v1/sync', { pending: [] });
    await new Promise((r) => setTimeout(r, 20));
    const second = await call('/agent/v1/events', example('event.sample.json'));
    assert.equal(second.statusCode, 429);
    assert.equal(second.headers['retry-after'], '45');
    assert.equal(second.json().code, 'ITA_BUSY');
    releaseFirst();
    assert.equal((await first).statusCode, 200);
    // 處理完釋放名額
    assert.equal((await call('/agent/v1/sync', { pending: [] })).statusCode, 200);
  });

  it('被拒的請求(401)也會釋放名額', async () => {
    app = await buildAgentApp({ config: { ...config, agentMaxInflight: 1 }, service: env.service, contractsDir: CONTRACTS_DIR });
    for (let i = 0; i < 3; i++) assert.equal((await call('/agent/v1/sync', { pending: [] }, {})).statusCode, 401);
    assert.equal((await call('/agent/v1/sync', { pending: [] })).statusCode, 200);
  });
});

describe('hello:時鐘偏差(A2)、硬體指紋(A1)、主機下發設定', () => {
  beforeEach(async () => {
    env = setup();
    app = await buildAgentApp({ config, service: env.service, contractsDir: CONTRACTS_DIR });
    await call('/agent/v1/inventory', inventoryRequest());
  });

  const hello = (patch: Record<string, unknown> = {}) =>
    env.service.hello(ctx(), env.sql.devices[0]!, { agent_version: '0.2.0', host_name: 'PC-EXAMPLE-01', ...patch });

  it('hello_ack 帶設定與版本;沒帶 agent_time 時不回 clock_skew_ms', async () => {
    const ack = await hello();
    assert.deepEqual(ack.settings, DEFAULT_SETTINGS);
    assert.equal(ack.settings_version, settingsVersion(DEFAULT_SETTINGS));
    assert.equal(ack.clock_skew_ms, undefined);
    assert.notEqual(settingsVersion({ ...DEFAULT_SETTINGS, inventory_interval_sec: 600 }), ack.settings_version, '設定改變則版本改變');
  });

  it('記錄偏差;超過 ±5 分鐘時寫 clock_skew 事件一次,恢復後再超過才再寫', async () => {
    const at = (offsetMs: number) => new Date(env.clock.now().getTime() + offsetMs).toISOString();
    assert.equal((await hello({ agent_time: at(-380) })).clock_skew_ms, -380);
    assert.equal(env.sql.devices[0]!.clockSkewMs, -380);
    const skewEvents = () => env.sql.events.filter((e) => e.type === 'clock_skew').length;
    assert.equal(skewEvents(), 0);

    await hello({ agent_time: at(CLOCK_SKEW_ALERT_MS + 600_000) });
    await hello({ agent_time: at(CLOCK_SKEW_ALERT_MS + 600_000) });
    assert.equal(skewEvents(), 1, '持續偏差不重複寫');
    await hello({ agent_time: at(1000) });
    await hello({ agent_time: at(-CLOCK_SKEW_ALERT_MS - 1) });
    assert.equal(skewEvents(), 2);
  });

  it('硬體指紋與另一台裝置相同:寫 suspected_duplicate,不自動合併;指紋沒變不重複寫', async () => {
    const other = await env.sql.register({ certDn: 'O=GigaNexus Dev,CN=PC-EXAMPLE-OLD', certFp: 'c'.repeat(40), computerName: 'PC-EXAMPLE-OLD', requestId: 't', at: env.clock.now() });
    env.sql.byId(other.id).hwFingerprint = h('e');
    await hello({ hw_fingerprint: h('e') });
    await hello({ hw_fingerprint: h('e') });
    const dup = env.sql.events.filter((e) => e.type === 'suspected_duplicate');
    assert.equal(dup.length, 1);
    assert.match(dup[0]!.detail, /PC-EXAMPLE-OLD/);
    assert.equal(env.sql.devices.length, 2, '不自動合併');
    assert.equal(env.sql.devices[0]!.hwFingerprint, h('e'));
  });

  it('SQL 寫入失敗時不寫偏差事件(下次 hello 再判斷)', async () => {
    const touch = env.sql.touch.bind(env.sql);
    env.sql.touch = async () => {
      throw new Error('模擬故障');
    };
    await hello({ agent_time: new Date(env.clock.now().getTime() + CLOCK_SKEW_ALERT_MS * 2).toISOString() });
    assert.equal(env.sql.events.filter((e) => e.type === 'clock_skew').length, 0);
    env.sql.touch = touch;
  });

  it('空字串指紋(BIOS 序號與 UUID 無法取得)不比對', async () => {
    await hello({ hw_fingerprint: '' });
    assert.equal(env.sql.devices[0]!.hwFingerprint, null);
    assert.ok(!env.sql.calls.includes('findByHwFingerprint'));
  });
});
