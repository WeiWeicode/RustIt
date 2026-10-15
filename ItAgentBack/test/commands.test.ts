/**
 * 指令通道(PLATFORM-PLAN P4 §4.4、ENDPOINT-AGENT-GUIDE §8.3–§8.5):
 *   派送器:在線推送、離線排隊與重連補送、斷線退回、狀態只能往前、裝置相符、逾期 / 逾時、舊版 Agent、冪等、取消、批次限流、SQL 失敗不回 ack;
 *   管理 API:等級與路徑相符、參數驗證、202、查詢;WebSocket 端到端 command → command_update → command_update_ack。
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv, type GatewayIdentity } from '@giganexus/backend-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildAgentApp } from '../src/agent-app.js';
import { compileWsEnvelope } from '../src/contracts.js';
import { buildMgmtApp } from '../src/mgmt-app.js';
import type { DeviceRecord } from '../src/stores/types.js';
import { CONTRACTS_DIR, DN, FP, FakeConnection, certHeaders, setupCommands } from './helpers.js';

const log = Fastify({ logger: { level: 'silent' } }).log;
const ctx = { log, requestId: 'req-cmd-1' };
const IT: GatewayIdentity = { sub: '1', emp: 'S000001', name: '測試人員' };
const OTHER: GatewayIdentity = { sub: '2', emp: 'S000002', name: '另一位' };
const validateEnvelope = compileWsEnvelope(CONTRACTS_DIR);

let env: ReturnType<typeof setupCommands>;
let device: DeviceRecord;

async function addDevice(dn: string): Promise<DeviceRecord> {
  return env.service.identify(ctx, dn, FP);
}

async function online(d: DeviceRecord): Promise<FakeConnection> {
  const conn = new FakeConnection();
  await env.service.connected(ctx, d, conn);
  return conn;
}

const commandsSent = (c: FakeConnection) => c.sent.filter((m) => m.type === 'command');

describe('指令派送器', () => {
  beforeEach(async () => {
    env = setupCommands();
    device = await addDevice(DN);
  });

  it('在線:寫入後立即推送(信封 id = command_id,符合契約),狀態 sent 並記稽核欄位', async () => {
    const conn = await online(device);
    const v = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: '測試' } });
    assert.equal(v.state, 'sent');
    assert.equal(v.sendCount, 1);
    const [msg] = commandsSent(conn);
    assert.ok(msg);
    assert.equal(msg.id, v.commandId);
    assert.ok(validateEnvelope({ v: 1, ...msg }), JSON.stringify(validateEnvelope.errors));
    assert.deepEqual(msg.body.params, { text: '測試' });
    assert.equal(msg.body.issued_by, 'S000001');
    const rec = env.store.commands[0]!;
    assert.deepEqual([rec.createdByEmp, rec.createdByName, rec.requestId, rec.certDn], ['S000001', '測試人員', 'req-cmd-1', DN]);
  });

  it('離線:排隊;重連 hello 後依建立順序補送', async () => {
    const a = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    env.clock.advance(1);
    const b = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: 'x' } });
    assert.deepEqual([a.state, b.state], ['queued', 'queued']);
    const conn = await online(device);
    await env.commands.onHello(ctx, device.id);
    assert.deepEqual(
      commandsSent(conn).map((m) => m.id),
      [a.commandId, b.commandId],
    );
  });

  it('等級與路徑不符 400 ENDPOINT_COMMAND_LEVEL_MISMATCH;不認得的類型、參數錯誤、有效期限超出範圍 400', async () => {
    await assert.rejects(env.commands.create(ctx, IT, 'admin', device.deviceId, { kind: 'inventory.collect' }), { code: 'ENDPOINT_COMMAND_LEVEL_MISMATCH' });
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'system.reboot' }), { code: 'ITA_COMMAND_KIND_UNKNOWN' });
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: {} }), { code: 'VALIDATION_FAILED' });
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect', params: { cmd: 'whoami' } }), {
      code: 'VALIDATION_FAILED',
    });
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect', expiresInSec: 10 }), {
      code: 'VALIDATION_FAILED',
    });
    assert.equal(env.store.commands.length, 0);
  });

  it('不存在 404、停用的電腦 409 ITA_DEVICE_NOT_ACTIVE', async () => {
    await assert.rejects(env.commands.create(ctx, IT, 'basic', '00000000-0000-4000-8000-000000000000', { kind: 'inventory.collect' }), {
      code: 'ITA_DEVICE_NOT_FOUND',
    });
    env.sql.byId(device.id).status = 'disabled';
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' }), { code: 'ITA_DEVICE_NOT_ACTIVE' });
  });

  it('command_update:acked → running → succeeded,各階段時間與結果;重複或較舊的更新不改資料', async () => {
    await online(device);
    const v = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    const up = (state: 'acked' | 'running' | 'succeeded' | 'failed', extra = {}) =>
      env.commands.onUpdate(ctx, device.id, { command_id: v.commandId, state, ...extra });
    env.clock.advance(1);
    assert.deepEqual(await up('acked'), { command_id: v.commandId, accepted: true, state: 'acked' });
    env.clock.advance(1);
    assert.equal((await up('running', { progress: 10 }))?.state, 'running');
    assert.equal((await up('running', { progress: 50 }))?.accepted, true);
    env.clock.advance(1);
    assert.equal((await up('succeeded', { result: { agent_seq: 1, result: 'stored' } }))?.state, 'succeeded');
    // 終態之後的更新不採用
    assert.deepEqual(await up('acked'), { command_id: v.commandId, accepted: false, state: 'succeeded' });
    const got = await env.commands.get(ctx, v.commandId);
    assert.equal(got.state, 'succeeded');
    assert.equal(got.progress, 100);
    assert.deepEqual(got.result, { agent_seq: 1, result: 'stored' });
    assert.ok(got.sentAt && got.ackedAt && got.startedAt && got.finishedAt);
    assert.ok(got.ackedAt < got.startedAt! && got.startedAt! < got.finishedAt!);
  });

  it('不屬於這台裝置的 command_update 一律拒絕', async () => {
    const other = await addDevice('O=GigaNexus Dev,CN=PC-EXAMPLE-02');
    const v = await env.commands.create(ctx, IT, 'basic', other.deviceId, { kind: 'inventory.collect' });
    const ack = await env.commands.onUpdate(ctx, device.id, { command_id: v.commandId, state: 'succeeded' });
    assert.deepEqual(ack, { command_id: v.commandId, accepted: false });
    assert.equal(env.store.commands[0]!.state, 'queued');
  });

  it('Agent 直接回 failed(不認得的 kind):錯誤代碼寫入', async () => {
    await online(device);
    const v = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    await env.commands.onUpdate(ctx, device.id, { command_id: v.commandId, state: 'failed', error_code: 'UNSUPPORTED_COMMAND', error_message: 'x' });
    const got = await env.commands.get(ctx, v.commandId);
    assert.deepEqual([got.state, got.errorCode], ['failed', 'UNSUPPORTED_COMMAND']);
  });

  it('瞬間完成(沒收到 running)時 started_at 以 acked_at 補上;未開始執行的失敗不補', async () => {
    await online(device);
    const a = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'agent.diagnose' });
    env.clock.advance(1);
    await env.commands.onUpdate(ctx, device.id, { command_id: a.commandId, state: 'acked' });
    env.clock.advance(1);
    await env.commands.onUpdate(ctx, device.id, { command_id: a.commandId, state: 'succeeded', result: {} });
    const done = await env.commands.get(ctx, a.commandId);
    assert.ok(done.startedAt);
    assert.equal(done.startedAt, done.ackedAt);
    assert.ok(done.startedAt < done.finishedAt!);
    const b = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    await env.commands.onUpdate(ctx, device.id, { command_id: b.commandId, state: 'failed', error_code: 'UNSUPPORTED_COMMAND' });
    assert.equal((await env.commands.get(ctx, b.commandId)).startedAt, null);
  });

  it('WebSocket 斷線:sent 改回 queued 並於重連後重送;acked 不動', async () => {
    let conn = await online(device);
    const a = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    const b = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: 'x' } });
    await env.commands.onUpdate(ctx, device.id, { command_id: a.commandId, state: 'acked' });
    await env.commands.onDisconnected(ctx, device.id);
    await env.service.disconnected(ctx, device, conn);
    assert.deepEqual(
      env.store.commands.map((c) => c.state),
      ['acked', 'queued'],
    );
    conn = await online(device);
    await env.commands.onHello(ctx, device.id);
    assert.deepEqual(
      commandsSent(conn).map((m) => m.id),
      [b.commandId],
    );
    assert.equal(env.store.commands[1]!.sendCount, 2);
  });

  it('送出失敗(連線正在關閉)留在 queued', async () => {
    const conn = await online(device);
    conn.broken = true;
    const v = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    assert.equal(v.state, 'queued');
  });

  it('逾期:queued / sent 超過 expires_at → expired,重連後不送;acked 超過執行逾時 → failed TIMEOUT', async () => {
    const queued = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect', expiresInSec: 60 });
    const conn = await online(device);
    const acked = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: 'x' } });
    await env.commands.onUpdate(ctx, device.id, { command_id: acked.commandId, state: 'acked' });
    env.clock.advance(61);
    assert.deepEqual(await env.commands.sweep(ctx), { expired: 1, timedOut: 0 });
    await env.commands.onHello(ctx, device.id);
    assert.ok(!commandsSent(conn).some((m) => m.id === queued.commandId));
    // message.show 執行逾時 2 分鐘
    env.clock.advance(60);
    assert.deepEqual(await env.commands.sweep(ctx), { expired: 0, timedOut: 1 });
    const got = await env.commands.get(ctx, acked.commandId);
    assert.deepEqual([got.state, got.errorCode], ['failed', 'TIMEOUT']);
    assert.equal((await env.commands.get(ctx, queued.commandId)).state, 'expired');
  });

  it('舊版 Agent 回 unsupported(信封 id = command_id)→ failed UNSUPPORTED_COMMAND', async () => {
    await online(device);
    const v = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    await env.commands.onUnsupported(ctx, device.id, v.commandId, 'command');
    const got = await env.commands.get(ctx, v.commandId);
    assert.deepEqual([got.state, got.errorCode], ['failed', 'UNSUPPORTED_COMMAND']);
  });

  it('Idempotency-Key:同一工號重送回傳同一筆;不同工號是不同筆', async () => {
    const a = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect', idempotencyKey: 'k1' });
    const b = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect', idempotencyKey: 'k1' });
    const c = await env.commands.create(ctx, OTHER, 'basic', device.deviceId, { kind: 'inventory.collect', idempotencyKey: 'k1' });
    assert.equal(a.commandId, b.commandId);
    assert.notEqual(a.commandId, c.commandId);
    assert.equal(env.store.commands.length, 2);
    // 同一個 key 用在另一種指令:422,不回傳舊的那筆
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: 'x' }, idempotencyKey: 'k1' }), {
      code: 'ITA_IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('同一台尚未結束的 message.show 最多 3 筆、agent.restart 1 筆(409 ITA_COMMAND_LIMIT)', async () => {
    for (let i = 0; i < 3; i++) await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: `第 ${i} 則` } });
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: 'x' } }), { code: 'ITA_COMMAND_LIMIT' });
    const r = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'agent.restart' });
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'agent.restart' }), { code: 'ITA_COMMAND_LIMIT' });
    await env.commands.cancel(ctx, IT, r.commandId);
    assert.equal((await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'agent.restart' })).state, 'queued', '結束後可再送');
  });

  it('message.show 拒絕控制字元、雙向文字控制字元與過多行', async () => {
    const bad = ['a\u0000b', 'https://‮moc.elpmaxe', 'x\r\ny', '\n'.repeat(30) + 'x'];
    for (const text of bad)
      await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text } }), { code: 'VALIDATION_FAILED' }, JSON.stringify(text));
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: 'x', title: 'a\nb' } }), {
      code: 'VALIDATION_FAILED',
    });
    assert.equal((await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: '第一行\n第二行' } })).state, 'queued');
  });

  it('連線被取代(舊連線未經斷線處理):新連線 hello 時 sent 改回 queued 並重送', async () => {
    const old = await online(device);
    const v = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    assert.equal(commandsSent(old).length, 1);
    const fresh = await online(device);
    assert.equal(env.service.replaced(device.deviceId, old), true);
    await env.commands.onHello(ctx, device.id);
    assert.deepEqual(
      commandsSent(fresh).map((m) => m.id),
      [v.commandId],
    );
  });

  it('取消:只能取消自己建立且 queued 的', async () => {
    const v = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    await assert.rejects(env.commands.cancel(ctx, OTHER, v.commandId), { code: 'ITA_COMMAND_NOT_OWNER' });
    assert.equal((await env.commands.cancel(ctx, IT, v.commandId)).state, 'canceled');
    await assert.rejects(env.commands.cancel(ctx, IT, v.commandId), { code: 'ITA_COMMAND_NOT_CANCELABLE' });
    await online(device);
    const sent = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    await assert.rejects(env.commands.cancel(ctx, IT, sent.commandId), { code: 'ITA_COMMAND_NOT_CANCELABLE' });
  });

  it('SQL 無法寫入:建立回 503;command_update 不回 ack', async () => {
    await online(device);
    const v = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    env.store.fail = true;
    await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' }), { code: 'ITA_STORAGE_UNAVAILABLE' });
    assert.equal(await env.commands.onUpdate(ctx, device.id, { command_id: v.commandId, state: 'acked' }), null);
  });
});

describe('批次與限流(指南 §8.4)', () => {
  it('同時執行上限:達上限的留在 queued,一台結束後補送下一台;任一台不存在整批不建立', async () => {
    env = setupCommands({ batchMaxConcurrent: 1 });
    const d1 = await addDevice(DN);
    const d2 = await addDevice('O=GigaNexus Dev,CN=PC-EXAMPLE-02');
    const c1 = await online(d1);
    const c2 = await online(d2);
    await assert.rejects(env.commands.createBatch(ctx, IT, 'basic', [d1.deviceId, '00000000-0000-4000-8000-000000000000'], { kind: 'inventory.collect' }), {
      code: 'ITA_DEVICE_NOT_FOUND',
    });
    assert.equal(env.store.commands.length, 0);
    const r = await env.commands.createBatch(ctx, IT, 'basic', [d1.deviceId, d2.deviceId], { kind: 'inventory.collect' });
    assert.deepEqual(
      r.commands.map((c) => c.state),
      ['sent', 'queued'],
    );
    assert.equal(commandsSent(c2).length, 0);
    await env.commands.onUpdate(ctx, d1.id, { command_id: r.commands[0]!.commandId, state: 'succeeded' });
    assert.equal(commandsSent(c2).length, 1);
    assert.equal(commandsSent(c1).length, 1);
    const batch = await env.commands.getBatch(ctx, r.batchId);
    assert.deepEqual([batch.targetCount, batch.counts], [2, { succeeded: 1, sent: 1 }]);
    const page = await env.commands.list(ctx, { batchId: r.batchId });
    assert.equal(page.items.length, 2);
  });
});

describe('指令管理 API(:51240)', () => {
  let mgmt: FastifyInstance;
  before(async () => {
    env = setupCommands();
    device = await addDevice(DN);
    const gateway = loadGatewayEnv({ GW_ENV: 'dev', SERVICE_CODE: 'endpoint-api', GW_JWKS_URL: 'http://127.0.0.1:1/jwks.json' });
    mgmt = await buildMgmtApp({
      config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken: true },
      service: env.service,
      commands: env.commands,
    });
  });
  after(async () => {
    await mgmt.close();
  });

  const create = (kind: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    mgmt.inject({ method: 'POST', url: `/v1/devices/${device.deviceId}/basic-commands`, payload: { kind, ...extra }, headers });

  it('202 + commandId;查詢、裝置紀錄、全部紀錄', async () => {
    const res = await create('inventory.collect', {}, { 'idempotency-key': 'abc-1' });
    assert.equal(res.statusCode, 202);
    const { commandId, state } = res.json() as { commandId: string; state: string };
    assert.equal(state, 'queued');
    assert.equal((await create('inventory.collect', {}, { 'idempotency-key': 'abc-1' })).json().commandId, commandId);
    const got = await mgmt.inject({ method: 'GET', url: `/v1/commands/${commandId}` });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().createdBy.emp, 'dev');
    const byDevice = await mgmt.inject({ method: 'GET', url: `/v1/devices/${device.deviceId}/commands` });
    assert.equal(byDevice.json().items.length, 1);
    const all = await mgmt.inject({ method: 'GET', url: '/v1/commands?state=queued&limit=10' });
    assert.equal(all.json().items[0].commandId, commandId);
  });

  it('basic 路徑送管理指令 400;參數錯誤 400;找不到 404', async () => {
    const reboot = await create('system.reboot');
    assert.equal(reboot.statusCode, 400);
    assert.equal(reboot.json().code, 'ITA_COMMAND_KIND_UNKNOWN');
    const bad = await create('message.show', { params: { text: '' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, 'VALIDATION_FAILED');
    const missing = await mgmt.inject({ method: 'GET', url: '/v1/commands/00000000-0000-4000-8000-000000000000' });
    assert.deepEqual([missing.statusCode, missing.json().code], [404, 'ITA_COMMAND_NOT_FOUND']);
  });

  it('OpenAPI:指令路由宣告 x-permission,建立類設 x-audit-level: meta', async () => {
    const doc = (await mgmt.inject({ method: 'GET', url: '/openapi.json' })).json() as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const post = doc.paths['/v1/devices/{deviceId}/basic-commands']!.post!;
    assert.equal(post['x-permission'], 'endpoint.command.basic');
    assert.equal(post['x-audit-level'], 'meta');
    assert.equal(doc.paths['/v1/commands/{commandId}']!.get!['x-permission'], 'endpoint.device.read');
    assert.equal(doc.paths['/v1/batches/basic-commands']!.post!['x-permission'], 'endpoint.command.basic');
  });
});

describe('WebSocket 端到端:command → command_update → command_update_ack', () => {
  let agent: FastifyInstance;
  let url: string;
  before(async () => {
    env = setupCommands();
    agent = await buildAgentApp({
      config: { logLevel: 'silent', agentTls: null, trustedProxies: null },
      service: env.service,
      commands: env.commands,
      contractsDir: CONTRACTS_DIR,
      sweepIntervalMs: 60_000,
    });
    await agent.listen({ host: '127.0.0.1', port: 0 });
    url = `ws://127.0.0.1:${(agent.server.address() as AddressInfo).port}/agent/v1/ws`;
  });
  after(async () => {
    await agent.close();
  });

  it('離線建立 → 連線 hello 後收到 command → 回報結果收到 ack;斷線前的 sent 重連後重送', async () => {
    device = await addDevice(DN);
    const v = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'message.show', params: { text: 'hi' } });
    const ws = new WebSocket(url, { headers: certHeaders() });
    const inbox: Record<string, unknown>[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d)) as Record<string, unknown>));
    await new Promise<void>((r, j) => ws.once('open', () => r()).once('error', j));
    const waitFor = async <T>(fn: () => T | undefined): Promise<T> => {
      for (let i = 0; i < 200; i++) {
        const x = fn();
        if (x !== undefined) return x;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('逾時');
    };
    ws.send(JSON.stringify({ v: 1, type: 'hello', id: 'h1', body: { agent_version: '0.3.0', host_name: 'PC-EXAMPLE-01' } }));
    const cmd = await waitFor(() => inbox.find((m) => m.type === 'command'));
    assert.equal(cmd.id, v.commandId);
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'command_update',
        id: 'u1',
        body: { command_id: v.commandId, state: 'succeeded', result: { session_id: 1, shown_via: 'wts' } },
      }),
    );
    const ack = await waitFor(() => inbox.find((m) => m.type === 'command_update_ack'));
    assert.equal(ack.id, 'u1');
    assert.ok(validateEnvelope(ack), JSON.stringify(validateEnvelope.errors));
    assert.deepEqual(ack.body, { command_id: v.commandId, accepted: true, state: 'succeeded' });
    assert.equal((await env.commands.get(ctx, v.commandId)).state, 'succeeded');

    // 已送出未確認 → 斷線改回 queued
    const v2 = await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'inventory.collect' });
    assert.equal(v2.state, 'sent');
    ws.close();
    await waitFor(() => (env.store.commands[1]!.state === 'queued' ? true : undefined));
  });

  it('服務關閉時送 prepare_shutdown 再以 1001 關閉', async () => {
    const ws = new WebSocket(url, { headers: certHeaders() });
    const inbox: Record<string, unknown>[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d)) as Record<string, unknown>));
    await new Promise<void>((r, j) => ws.once('open', () => r()).once('error', j));
    await new Promise((r) => setTimeout(r, 50));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    await env.service.closeAll(100);
    assert.equal(await closed, 1001);
    const ps = inbox.find((m) => m.type === 'prepare_shutdown');
    assert.ok(ps && validateEnvelope(ps));
    assert.deepEqual(ps.body, { reason: 'server_restart' });
  });
});
