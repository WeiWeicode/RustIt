/**
 * Agent 通道 :51241(INTEGRATION-PLAN M1 測試清單):
 *   未帶憑證標頭 401、來源不是 Gateway 401;hash 沒變不寫庫;SQL 失敗回 503 且 Mongo / Redis 不寫;
 *   Mongo / Redis 失敗不影響成功;停用 403;新指紋寫稽核;WebSocket hello / heartbeat / unsupported、關閉與心跳逾時變離線。
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildAgentApp } from '../src/agent-app.js';
import { CONTRACTS_DIR, DN, certHeaders, inventoryRequest, setup } from './helpers.js';

const config = { logLevel: 'silent', agentTls: null, trustedProxies: null };
const H2 = 'b'.repeat(64);

let env: ReturnType<typeof setup>;
let app: FastifyInstance;

const post = (payload: unknown, headers: Record<string, string> = certHeaders()) =>
  app.inject({ method: 'POST', url: '/agent/v1/inventory', headers, payload: payload as object });

describe('裝置身分(指南 §5.2)', () => {
  beforeEach(async () => {
    env = setup();
    app = await buildAgentApp({ config, service: env.service, contractsDir: CONTRACTS_DIR });
  });

  it('未帶憑證標頭或 x-client-verify 不是 SUCCESS 回 401 DEVICE_UNAUTHORIZED,不進入業務邏輯', async () => {
    const none = await post(inventoryRequest(), {});
    assert.equal(none.statusCode, 401);
    assert.equal(none.json().code, 'DEVICE_UNAUTHORIZED');
    assert.equal((await post(inventoryRequest(), { ...certHeaders(), 'x-client-verify': 'FAILED:certificate has expired' })).statusCode, 401);
    assert.equal((await post(inventoryRequest(), { ...certHeaders(), 'x-client-cert-fp': 'not-a-fingerprint' })).statusCode, 401);
    assert.deepEqual(env.sql.calls, []);
  });

  it('來源不在 AGENT_TRUSTED_PROXIES 時不採信標頭(401)', async () => {
    const strict = await buildAgentApp({ config: { ...config, trustedProxies: ['172.18.0.0/16'] }, service: env.service, contractsDir: CONTRACTS_DIR });
    const send = (remoteAddress: string) =>
      strict.inject({ method: 'POST', url: '/agent/v1/inventory', headers: certHeaders(), payload: inventoryRequest(), remoteAddress });
    assert.equal((await send('10.10.130.50')).statusCode, 401);
    assert.equal((await send('::ffff:172.18.0.5')).statusCode, 200);
    await strict.close();
  });

  it('首次連線自動登錄;同一 DN 出現新指紋時更新並寫稽核', async () => {
    assert.equal((await post(inventoryRequest())).statusCode, 200);
    assert.equal(env.sql.devices.length, 1);
    assert.equal(env.sql.devices[0]!.certDn, DN);
    const fp2 = 'a'.repeat(40);
    assert.equal((await post(inventoryRequest({ content_hash: H2 }), certHeaders(fp2))).statusCode, 200);
    assert.equal(env.sql.devices.length, 1, '同一 DN 仍是同一台');
    assert.equal(env.sql.devices[0]!.certFp, fp2);
    assert.deepEqual(
      env.sql.events.map((e) => e.type),
      ['registered', 'fingerprint_changed'],
    );
  });

  it('停用的裝置回 403 ITA_DEVICE_DISABLED', async () => {
    await post(inventoryRequest());
    env.sql.devices[0]!.status = 'disabled';
    const res = await post(inventoryRequest({ content_hash: H2 }));
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'ITA_DEVICE_DISABLED');
  });
});

describe('資產回報 POST /agent/v1/inventory(INTEGRATION-PLAN §3.1 寫入順序)', () => {
  beforeEach(async () => {
    env = setup();
    app = await buildAgentApp({ config, service: env.service, contractsDir: CONTRACTS_DIR });
  });

  it('寫入 SQL → Mongo 快照 → Redis hash,回 stored 與後端指派的 device_id', async () => {
    const res = await post(inventoryRequest());
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.result, 'stored');
    assert.equal(body.device_id, env.sql.devices[0]!.deviceId);
    assert.equal(env.sql.inventories.size, 1);
    assert.equal(env.mongo.snapshots.length, 1);
    assert.equal(env.redis.hashes.get(body.device_id), inventoryRequest().content_hash);
    assert.equal(env.sql.devices[0]!.computerName, 'PC-EXAMPLE-01');
  });

  it('content_hash 沒變:只更新最後回報時間,不寫 SQL 資產、不寫 Mongo', async () => {
    await post(inventoryRequest());
    env.sql.calls = [];
    const res = await post(inventoryRequest({ agent_seq: inventoryRequest().agent_seq + 1 }));
    assert.equal(res.json().result, 'unchanged');
    assert.ok(!env.sql.calls.includes('saveInventory'));
    assert.ok(env.sql.calls.includes('markInventoryUnchanged'));
    assert.equal(env.mongo.snapshots.length, 1);
  });

  it('Redis 沒有 hash 時改以 SQL 比對', async () => {
    await post(inventoryRequest());
    env.redis.hashes.clear();
    const res = await post(inventoryRequest());
    assert.equal(res.json().result, 'unchanged');
    assert.ok(env.sql.calls.includes('currentInventory'));
  });

  it('較舊的快照(補傳)只進 Mongo 歷史,不覆蓋目前資料', async () => {
    await post(inventoryRequest());
    const res = await post(inventoryRequest({ content_hash: H2, agent_seq: 1, collected_at: '2026-10-05T08:00:00Z' }));
    assert.equal(res.json().result, 'archived');
    assert.equal(env.sql.inventories.get(1)!.contentHash, inventoryRequest().content_hash);
    assert.equal(env.mongo.snapshots.length, 2);
  });

  it('SQL Server 失敗回 503 ITA_STORAGE_UNAVAILABLE,Mongo / Redis 都不寫', async () => {
    await post(inventoryRequest());
    env.sql.fail = true;
    env.mongo.calls = [];
    env.redis.calls = [];
    const res = await post(inventoryRequest({ content_hash: H2 }));
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'ITA_STORAGE_UNAVAILABLE');
    assert.equal(res.json().requestId, 'req-agent-1');
    assert.deepEqual(env.mongo.calls, []);
    assert.ok(!env.redis.calls.includes('setHash'));
  });

  it('Mongo、Redis 都失敗時回報仍成功(SQL 有寫入)', async () => {
    env.mongo.fail = true;
    env.redis.fail = true;
    const res = await post(inventoryRequest());
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().result, 'stored');
    assert.equal(env.sql.inventories.size, 1);
  });

  it('不符合契約回 400 VALIDATION_FAILED;多出的欄位忽略', async () => {
    const { inventory: _omit, ...noInventory } = inventoryRequest();
    const bad = await post(noInventory);
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, 'VALIDATION_FAILED');
    assert.equal((await post({ ...inventoryRequest(), future_field: 'x' })).statusCode, 200);
  });
});

describe('WebSocket GET /agent/v1/ws(指南 §5.3、§5.6)', () => {
  let url: string;
  before(async () => {
    env = setup();
    app = await buildAgentApp({ config, service: env.service, contractsDir: CONTRACTS_DIR, sweepIntervalMs: 60_000 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/agent/v1/ws`;
  });
  after(async () => {
    await app.close();
  });

  /** 連線並收集訊息;next() 等下一則 */
  async function connect(headers: Record<string, string> = certHeaders()) {
    const ws = new WebSocket(url, { headers });
    const inbox: Record<string, unknown>[] = [];
    const waiters: ((m: Record<string, unknown>) => void)[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
    const next = () => (inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<Record<string, unknown>>((r) => waiters.push(r)));
    const send = (type: string, id: string, body?: object) => ws.send(JSON.stringify({ v: 1, type, id, body }));
    return { ws, next, send };
  }

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond());
  };

  it('沒有憑證標頭時升級被拒(401)', async () => {
    await assert.rejects(connect({}), /HTTP 401/);
  });

  it('hello → hello_ack(device_id、心跳間隔);heartbeat → heartbeat_ack;不認得的 type → unsupported', async () => {
    const c = await connect();
    const deviceId = env.sql.devices[0]!.deviceId;
    await waitFor(() => env.redis.online.has(deviceId));

    c.send('hello', 'm1', { agent_version: '0.1.0', host_name: 'PC-EXAMPLE-01', ips: ['192.0.2.10'] });
    const ack = await c.next();
    assert.deepEqual([ack.type, ack.id], ['hello_ack', 'm1']);
    assert.equal((ack.body as { device_id: string }).device_id, deviceId);
    assert.equal((ack.body as { heartbeat_interval_sec: number }).heartbeat_interval_sec, 30);
    assert.equal(env.sql.devices[0]!.agentVersion, '0.1.0');

    c.send('heartbeat', 'm2', { outbox_pending: 0 });
    const hb = await c.next();
    assert.deepEqual([hb.type, hb.id], ['heartbeat_ack', 'm2']);
    assert.equal(env.mongo.heartbeats.length, 1);

    c.send('future_type', 'm3', {});
    const un = await c.next();
    assert.deepEqual([un.type, un.id, un.body], ['unsupported', 'm3', { type: 'future_type' }]);

    // 關閉 WebSocket 立即標記離線
    c.ws.close();
    await waitFor(() => !env.redis.online.has(deviceId));
  });

  it('連續 3 個心跳間隔(90 秒)沒有心跳即判定離線並中斷連線', async () => {
    const c = await connect();
    const deviceId = env.sql.devices[0]!.deviceId;
    await waitFor(() => env.redis.online.has(deviceId));
    const closed = new Promise<void>((r) => c.ws.once('close', () => r()));
    const log = app.log;
    env.clock.advance(60);
    assert.equal(await env.service.sweep({ log, requestId: 't' }), 0, '60 秒仍在線');
    env.clock.advance(31);
    assert.equal(await env.service.sweep({ log, requestId: 't' }), 1);
    assert.ok(!env.redis.online.has(deviceId));
    await closed;
  });

  it('Redis 無法使用時,在線狀態退回本實例的連線表', async () => {
    const c = await connect();
    await new Promise((r) => setTimeout(r, 50));
    env.redis.fail = true;
    const list = await env.service.listDevices({ log: app.log, requestId: 't' });
    assert.equal(list[0]!.online, true);
    env.redis.calls = [];
    c.ws.close();
    await waitFor(() => env.redis.calls.filter((x) => x === 'clearOnline').length > 0);
    assert.equal((await env.service.listDevices({ log: app.log, requestId: 't' }))[0]!.online, false);
    env.redis.fail = false;
  });

  it('同一裝置第二條 WebSocket:關閉舊連線(4409)並寫稽核', async () => {
    const a = await connect();
    const closed = new Promise<number>((r) => a.ws.once('close', (code) => r(code)));
    const b = await connect();
    assert.equal(await closed, 4409);
    assert.ok(env.sql.events.some((e) => e.type === 'duplicate_connection'));
    b.ws.close();
  });
});
