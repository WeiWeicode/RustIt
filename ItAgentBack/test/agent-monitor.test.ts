/**
 * Agent 通道的監控(giga-observe 服務 endpoint-agent):HTTPS 回報逐筆、WebSocket 每條連線關閉時一筆、心跳附在線連線數。
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildAgentApp, wsSessionLog } from '../src/agent-app.js';
import { CONTRACTS_DIR, certHeaders, inventoryRequest, setup } from './helpers.js';

interface Sent {
  path: string;
  body: { logs?: Record<string, any>[]; deps?: { name: string; ok: boolean }[] };
}

describe('Agent 通道監控(giga-observe endpoint-agent)', () => {
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  let app: FastifyInstance;
  let env: ReturnType<typeof setup>;

  before(async () => {
    // Monitor 建立時取用 fetch:先換成記錄器
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{"success":true}', { status: 202 });
    }) as typeof fetch;
    env = setup();
    app = await buildAgentApp({
      config: { logLevel: 'silent', agentTls: null, trustedProxies: null },
      service: env.service,
      contractsDir: CONTRACTS_DIR,
      sweepIntervalMs: 60_000,
      monitor: { enabled: true, endpoint: 'http://observe.test', apiKey: 'test-key' },
      deps: async () => [{ name: 'mssql', ok: true, latencyMs: 1 }],
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
  });
  after(async () => {
    await app.close();
    globalThis.fetch = realFetch;
  });

  const logs = () => sent.filter((s) => s.path === '/api/v1/ingest/logs').flatMap((s) => s.body.logs ?? []);

  it('HTTPS 回報逐筆送出,userId 為電腦名稱、meta 帶 deviceId', async () => {
    const res = await app.inject({ method: 'POST', url: '/agent/v1/inventory', headers: certHeaders(), payload: inventoryRequest() as object });
    assert.equal(res.statusCode, 200);
    await app.monitor.flush();
    const log = logs().find((l) => l.request.path === '/agent/v1/inventory');
    assert.ok(log, '應有回報紀錄');
    assert.equal(log.response.status, 200);
    assert.equal(log.request.userId, 'PC-EXAMPLE-01');
    assert.equal(log.meta.deviceId, env.sql.devices[0]!.deviceId);
  });

  it('WebSocket 關閉後送出一筆 method WS 的連線紀錄(持續時間、關閉碼、訊息數、來源 IP)', async () => {
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/ws`, { headers: { ...certHeaders(), 'x-forwarded-for': '192.0.2.10' } });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ v: 1, type: 'hello', id: 'h1', body: { agent_version: '0.1.0', host_name: 'PC-EXAMPLE-01', ips: ['192.0.2.10'] } }));
    await new Promise((r) => ws.once('message', r));
    ws.close(1000);
    let log: Record<string, any> | undefined;
    for (let i = 0; i < 100 && !log; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await app.monitor.flush();
      log = logs().find((l) => l.request.method === 'WS');
    }
    assert.ok(log, '應有 WebSocket 連線紀錄');
    assert.equal(log.level, 'info');
    assert.equal(log.response.status, 101);
    assert.equal(log.request.ip, '192.0.2.10');
    assert.equal(log.meta.closeCode, 1000);
    assert.equal(log.meta.messages, 1);
    assert.ok(log.response.durationMs >= 0);
  });

  it('心跳附上相依服務與在線連線數', async () => {
    await app.monitor.heartbeat();
    const hb = sent.filter((s) => s.path === '/api/v1/heartbeat').at(-1);
    const names = hb?.body.deps?.map((d) => d.name) ?? [];
    assert.ok(names.includes('mssql'));
    assert.ok(names.some((n) => /^WebSocket 在線 \d+ 條$/.test(n)));
  });

  it('非正常關閉(被新連線取代 4409、斷線 1006)記為 warn', () => {
    const base = { startedAt: 0, endedAt: 5000, requestId: 'r', deviceId: 'd', computerName: 'PC', ip: null, messages: 0, online: 0 };
    assert.equal(wsSessionLog({ ...base, code: 1001 }).level, 'info');
    assert.equal(wsSessionLog({ ...base, code: 4409 }).level, 'warn');
    assert.equal(wsSessionLog({ ...base, code: 1006 }).level, 'warn');
    assert.equal(wsSessionLog({ ...base, code: 1000 }).response.durationMs, 5000);
  });
});
