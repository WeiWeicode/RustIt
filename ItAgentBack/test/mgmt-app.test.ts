/**
 * 管理 API :51240:OpenAPI 上架檢查(BACKEND-GUIDE §6.1)、X-Internal-Token(aud=endpoint-api)、清單與詳情格式(GigaItApp EndpointDevice 相容)。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv } from '@giganexus/backend-sdk';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildMgmtApp } from '../src/mgmt-app.js';
import { inventoryRequest, setup } from './helpers.js';

const CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/;

let app: FastifyInstance;
let jwks: http.Server;
let jwksUrl: string;
let sign: (aud?: string) => Promise<string>;
const env = setup();

async function build(devSkipToken = false) {
  const gateway = loadGatewayEnv({ GW_ENV: 'dev', SERVICE_CODE: 'endpoint-api', GW_JWKS_URL: jwksUrl });
  return buildMgmtApp({ config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken }, service: env.service });
}

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256', use: 'sig' };
  jwks = http.createServer((_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`;
  sign = (aud = 'endpoint-api') =>
    new SignJWT({ sub: '1', emp: 'S112009', cos: ['GSMC'] })
      .setProtectedHeader({ alg: 'ES256', kid: 'test' })
      .setIssuer('giganexus-bff')
      .setAudience(aud)
      .setExpirationTime('60s')
      .sign(privateKey);
  app = await build();

  // 一台已回報資產、WebSocket 在線的電腦
  const ctx = { log: app.log, requestId: 'seed' };
  const device = await env.service.identify(ctx, 'O=GigaNexus Dev,CN=PC-EXAMPLE-01', '574f45a0357c7d134a9e2f78cd7ed4dc0444ee77');
  await env.service.ingestInventory(ctx, device, inventoryRequest());
  await env.service.connected(ctx, device, { close() {}, terminate() {} });
});

after(async () => {
  await app.close();
  jwks.close();
});

const get = async (url: string, token?: string) => app.inject({ url, headers: token ? { 'x-internal-token': token, 'x-request-id': 'req-1' } : {} });

describe('OpenAPI(BACKEND-GUIDE.md §6.1)', () => {
  it('x-gateway(upstream endpoint-api、system endpoint、project RustIt)與每個 operation 的必填欄位', async () => {
    const doc = (await app.inject('/openapi.json')).json();
    assert.deepEqual(doc['x-gateway'], { upstream: 'endpoint-api', system: 'endpoint', project: 'RustIt' });
    const declared = new Set(doc['x-permissions'].map((p: { code: string }) => p.code));
    assert.ok(declared.has('endpoint.device.read'));
    const ops = Object.values(doc.paths as Record<string, Record<string, Record<string, unknown>>>).flatMap((p) => Object.values(p));
    assert.equal(ops.length, 2);
    for (const op of ops) {
      const id = String(op.operationId);
      assert.match(id, CODE);
      assert.ok(op.summary && typeof op.description === 'string');
      assert.ok(typeof op['x-gherkin'] === 'string' && /^場景[::]/m.test(op['x-gherkin']), `${id} 缺少 x-gherkin`);
      assert.equal(op['x-permission'], 'endpoint.device.read');
    }
    assert.deepEqual(Object.keys(doc.paths).sort(), ['/v1/devices', '/v1/devices/{deviceId}']);
  });
});

describe('X-Internal-Token(BACKEND-GUIDE.md §4.2)', () => {
  it('/healthz 不需 Token', async () => {
    assert.equal((await get('/healthz')).statusCode, 200);
  });

  it('缺少或 aud 不符的 Token 回 401 ITA_INTERNAL_TOKEN_INVALID', async () => {
    const res = await get('/v1/devices');
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'ITA_INTERNAL_TOKEN_INVALID');
    assert.equal((await get('/v1/devices', await sign('endpoint-agent'))).statusCode, 401);
    assert.equal((await get('/v1/devices', 'not-a-jwt')).statusCode, 401);
  });

  it('DEV_SKIP_TOKEN(只在 dev)不驗證', async () => {
    const dev = await build(true);
    assert.equal((await dev.inject('/v1/devices')).statusCode, 200);
    await dev.close();
  });
});

describe('電腦清單與詳情', () => {
  it('清單沿用 EndpointDevice 欄位並新增摘要欄位;不帶軟體清單', async () => {
    const res = await get('/v1/devices', await sign());
    assert.equal(res.statusCode, 200);
    const [d] = res.json().items;
    assert.equal(d.computerName, 'PC-EXAMPLE-01');
    assert.equal(d.online, true);
    assert.equal(d.certDn, 'O=GigaNexus Dev,CN=PC-EXAMPLE-01');
    assert.equal(d.certFingerprint, '574f45a0357c7d134a9e2f78cd7ed4dc0444ee77');
    assert.equal(d.userName, 'EXAMPLE\\user01');
    assert.deepEqual(d.ips, ['192.0.2.10']);
    assert.equal(d.memoryTotal, 17179869184);
    assert.equal(d.agentVersion, '0.1.0');
    for (const k of ['firstSeenAt', 'lastSeenAt', 'lastInventoryAt']) assert.ok(!Number.isNaN(Date.parse(d[k])), k);
    assert.equal(d.software, undefined);
    assert.equal(d.inventory, undefined);
  });

  it('詳情含完整快照(鍵名 camelCase);不存在回 404;deviceId 格式錯誤回 400', async () => {
    const token = await sign();
    const id = env.sql.devices[0]!.deviceId;
    const res = await get(`/v1/devices/${id}`, token);
    assert.equal(res.statusCode, 200);
    const d = res.json();
    assert.equal(d.inventory.system.hostName, 'PC-EXAMPLE-01');
    assert.equal(d.inventory.network[0].dhcpEnabled, true);
    assert.equal(d.inventory.security.antivirus[0].upToDate, true);
    assert.equal(d.inventory.software.length, 3);
    assert.equal(d.collectedAt, '2026-10-06T08:00:00.000Z');
    const missing = await get('/v1/devices/00000000-0000-4000-8000-000000000000', token);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, 'ITA_DEVICE_NOT_FOUND');
    assert.equal((await get('/v1/devices/abc', token)).statusCode, 400);
  });

  it('SQL Server 無法使用時回 503', async () => {
    env.sql.fail = true;
    const res = await get('/v1/devices', await sign());
    env.sql.fail = false;
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'ITA_STORAGE_UNAVAILABLE');
  });
});
