/**
 * 資料範圍依公司(cos)過濾(ENDPOINT-AGENT-GUIDE §8.2、§10.2 E6;docs/E6-COMPANY-SCOPE-DESIGN.md §5):
 *   - 範圍與公司判定的純函式
 *   - 以甲公司、乙公司、全部公司、沒有公司四種內部 Token 打每一條管理 API:範圍外與「不存在」回應相同(不洩漏存在)
 *   - 公司自動判定(登錄、收到資產、啟動回填)與 IT 指定
 *   - 路由清單比對:OpenAPI 的每個 operation 都必須列在本檔已驗證範圍的清單內(新增路由忘了範圍測試會失敗)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv } from '@giganexus/backend-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { buildMgmtApp } from '../src/mgmt-app.js';
import { companyOfDomain, parseCompanyDomains, resolveCompany } from '../src/services/company.js';
import { inScope, scopeOf } from '../src/services/scope.js';
import type { DeviceRecord } from '../src/stores/types.js';
import { ReleaseFiles } from '../src/services/release-files.js';
import { ReleaseService } from '../src/services/release-service.js';
import { SoftwareFiles } from '../src/services/software-files.js';
import { SoftwareService } from '../src/services/software-service.js';
import { ALL, inventoryRequest, only, setupCommands } from './helpers.js';
import { MemoryReleaseStore, releasesDir } from './release-helpers.js';
import { MemorySoftwareStore, softwareDir } from './software-helpers.js';

const log = Fastify({ logger: { level: 'silent' } }).log;
const agentCtx = { log, requestId: 'agent' };
const allCtx = { log, requestId: 'seed', scope: ALL };
const DOMAINS = parseCompanyDomains('甲公司=a.example;乙公司=b.example;丙公司=sub.a.example');
const NONE = '00000000-0000-4000-8000-000000000000';

describe('範圍與公司判定(純函式)', () => {
  it('scopeOf:roles 命中全部公司角色 → all;否則取 cos(去重、去空);API Key 身分與沒有公司 → 空範圍', () => {
    assert.deepEqual(scopeOf({ sub: '1', cos: ['甲公司'], roles: ['it-admin'] }, ['it-admin']), { all: true });
    assert.deepEqual(scopeOf({ sub: '1', cos: ['甲公司', '甲公司', '', '乙公司'], roles: ['employee'] }, ['it-admin']), {
      all: false,
      companies: ['甲公司', '乙公司'],
    });
    assert.deepEqual(scopeOf({ sub: 'client:x', cos: [], roles: [] }, ['it-admin']), { all: false, companies: [] });
    assert.deepEqual(scopeOf({ sub: '1' }, ['it-admin']), { all: false, companies: [] });
    // 設定為空:沒有人是全部公司
    assert.deepEqual(scopeOf({ sub: '1', cos: ['甲公司'], roles: ['it-admin'] }, []), { all: false, companies: ['甲公司'] });
  });

  it('inScope:未指定公司只有 all 看得到', () => {
    assert.equal(inScope(ALL, null), true);
    assert.equal(inScope(only('甲公司'), null), false);
    assert.equal(inScope(only('甲公司'), '甲公司'), true);
    assert.equal(inScope(only('甲公司'), '乙公司'), false);
    assert.equal(inScope(only(), '甲公司'), false);
  });

  it('companyOfDomain:最長尾碼優先、不分大小寫、尾端句點', () => {
    assert.equal(companyOfDomain(DOMAINS, 'pc1.sub.a.example'), '丙公司');
    assert.equal(companyOfDomain(DOMAINS, 'PC1.A.Example.'), '甲公司');
    assert.equal(companyOfDomain(DOMAINS, 'a.example'), '甲公司');
    assert.equal(companyOfDomain(DOMAINS, 'example'), null);
    assert.equal(companyOfDomain(DOMAINS, 'evil-a.example'), null);
    assert.equal(companyOfDomain(DOMAINS, null), null);
  });

  it('resolveCompany:憑證 FQDN 優先 → 回報網域(part_of_domain 才用)→ 判不出', () => {
    assert.deepEqual(resolveCompany(DOMAINS, 'CN=PC1.b.example', { domain: 'a.example', partOfDomain: true }), { company: '乙公司', source: 'cert' });
    assert.deepEqual(resolveCompany(DOMAINS, 'O=GigaNexus Test,CN=PC1', { domain: 'a.example', partOfDomain: true }), { company: '甲公司', source: 'domain' });
    assert.equal(resolveCompany(DOMAINS, 'O=GigaNexus Test,CN=PC1', { domain: 'a.example', partOfDomain: false }), null);
    assert.equal(resolveCompany(DOMAINS, 'O=GigaNexus Test,CN=PC1', null), null);
    // CN 不是 FQDN 時不當網域比對
    assert.equal(resolveCompany(parseCompanyDomains('甲公司=a.example'), 'CN=a', null), null);
    assert.equal(resolveCompany(new Map(), 'CN=PC1.a.example', { domain: 'a.example', partOfDomain: true }), null);
  });
});

describe('管理 API 的資料範圍(:51240)', () => {
  const env = setupCommands({ companyDomains: DOMAINS });
  const releases = new ReleaseService(
    new MemoryReleaseStore(env.sql, env.monitor),
    new ReleaseFiles(releasesDir().root),
    env.monitor,
    env.sql,
    (id) => env.service.lookup(id),
    { now: env.clock.now },
  );
  const swDir = softwareDir();
  const software = new SoftwareService(new MemorySoftwareStore(env.sql, env.store), new SoftwareFiles(swDir.root), env.sql, {
    now: env.clock.now,
    commands: () => env.commands,
  });
  let app: FastifyInstance;
  let jwks: http.Server;
  const tokens: Record<string, string> = {};
  let devA: DeviceRecord;
  let devB: DeviceRecord;
  let devU: DeviceRecord;
  let cmdB: string;
  let batchB: string;
  let fileB: string;

  before(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256', use: 'sig' };
    jwks = http.createServer((_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [jwk] })));
    await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
    const jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`;
    const sign = (claims: JWTPayload) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: 'test' })
        .setIssuer('giganexus-bff')
        .setAudience('endpoint-api')
        .setExpirationTime('5m')
        .sign(privateKey);
    tokens.a = await sign({ sub: '1', emp: 'S000001', name: '甲 IT', cos: ['甲公司'], roles: ['employee'] });
    tokens.b = await sign({ sub: '2', emp: 'S000002', name: '乙 IT', cos: ['乙公司'], roles: ['employee'] });
    tokens.all = await sign({ sub: '3', emp: 'S000003', name: 'IT 主管', cos: ['甲公司'], roles: ['it-admin'] });
    tokens.none = await sign({ sub: '4', emp: 'S000004', cos: [], roles: [] });
    tokens.apiKey = await sign({ sub: 'client:9', emp: 'client:x', cos: [], amr: 'api_key', roles: [] });

    const gateway = loadGatewayEnv({ GW_ENV: 'dev', SERVICE_CODE: 'endpoint-api', GW_JWKS_URL: jwksUrl });
    app = await buildMgmtApp({
      config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken: false, scopeAllRoles: ['it-admin'] },
      service: env.service,
      commands: env.commands,
      files: env.files,
      alerts: env.alerts,
      releases,
      software,
    });

    // 甲:憑證 FQDN;乙:憑證判不出、回報網域 b.example;未指定:工作群組
    devA = await env.service.identify(agentCtx, 'O=GigaNexus Dev,CN=PC-A.a.example', 'a'.repeat(40));
    await env.service.ingestInventory(agentCtx, devA, inventoryRequest());
    devB = await env.service.identify(agentCtx, 'O=GigaNexus Dev,CN=PC-B', 'b'.repeat(40));
    const invB = structuredClone(inventoryRequest({ content_hash: 'b'.repeat(64) }));
    invB.inventory.system.domain = 'b.example';
    await env.service.ingestInventory(agentCtx, devB, invB);
    devU = await env.service.identify(agentCtx, 'O=GigaNexus Dev,CN=PC-U', 'c'.repeat(40));
    // 甲、乙硬體指紋相同(疑似同一台的提示不可跨公司)
    env.sql.byId(devA.id).hwFingerprint = 'f'.repeat(64);
    env.sql.byId(devB.id).hwFingerprint = 'f'.repeat(64);

    // 乙的指令(由甲 IT 的工號以 Idempotency-Key k1 建立:模擬之後電腦被改指定到乙公司)、批次、附檔
    const who = { sub: '1', emp: 'S000001', name: '甲 IT' };
    cmdB = (await env.commands.create(allCtx, who, 'basic', devB.deviceId, { kind: 'inventory.collect', idempotencyKey: 'k1' })).commandId;
    batchB = (await env.commands.createBatch(allCtx, who, 'basic', [devB.deviceId], { kind: 'agent.restart' })).batchId;
    fileB = '11111111-1111-4111-8111-111111111111';
    const ref = env.store.commands.find((c) => c.commandId === cmdB)!.id;
    const at = env.clock.now();
    await env.store.addFile({
      fileId: fileB,
      commandRef: ref,
      fileName: 'x.zip',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      storagePath: 'x/x.zip',
      createdAt: at,
      expiresAt: new Date(at.getTime() + 86_400_000),
    });
  });

  after(async () => {
    await app.close();
    jwks.close();
  });

  const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { 'x-internal-token': token, 'x-request-id': 'req-same' } });

  /** 範圍外的回應必須與「不存在」逐欄相同(狀態、代碼、訊息、details) */
  async function sameAsMissing(token: string, method: 'GET' | 'POST' | 'PUT', url: string, missingUrl: string, payload?: object) {
    const denied = await call(token, method, url, payload);
    const missing = await call(token, method, missingUrl, payload);
    assert.equal(denied.statusCode, 404, `${method} ${url}`);
    assert.deepEqual(denied.json(), missing.json(), `${method} ${url}`);
    return denied.json() as { code: string };
  }

  const ids = (res: { json(): unknown }) => ((res.json() as { items: { deviceId: string }[] }).items ?? []).map((d) => d.deviceId).sort();

  it('自動判定:憑證 FQDN → cert;回報網域 → domain;工作群組 → 未指定', () => {
    assert.deepEqual([devA.company, devA.companySource], ['甲公司', 'cert']);
    assert.deepEqual([env.sql.byId(devB.id).company, env.sql.byId(devB.id).companySource], ['乙公司', 'domain']);
    assert.deepEqual([devU.company, devU.companySource], [null, null]);
  });

  it('GET /v1/devices:只列範圍內;未指定只有全部公司看得到;沒有公司與 API Key 為空;company 篩選不可越界', async () => {
    assert.deepEqual(ids(await call(tokens.a!, 'GET', '/v1/devices')), [devA.deviceId]);
    assert.deepEqual(ids(await call(tokens.b!, 'GET', '/v1/devices')), [devB.deviceId]);
    assert.deepEqual(ids(await call(tokens.all!, 'GET', '/v1/devices')), [devA.deviceId, devB.deviceId, devU.deviceId].sort());
    for (const t of [tokens.none!, tokens.apiKey!]) {
      const res = await call(t, 'GET', '/v1/devices');
      assert.deepEqual([res.statusCode, res.json().total, res.json().items], [200, 0, []]);
    }
    assert.equal((await call(tokens.a!, 'GET', '/v1/devices')).json().total, 1);
    assert.deepEqual(ids(await call(tokens.a!, 'GET', `/v1/devices?company=${encodeURIComponent('乙公司')}`)), []);
    assert.deepEqual(ids(await call(tokens.a!, 'GET', '/v1/devices?company=')), []);
    assert.deepEqual(ids(await call(tokens.all!, 'GET', '/v1/devices?company=')), [devU.deviceId]);
    assert.deepEqual(ids(await call(tokens.all!, 'GET', `/v1/devices?company=${encodeURIComponent('乙公司')}`)), [devB.deviceId]);
    const [row] = (await call(tokens.a!, 'GET', '/v1/devices')).json().items;
    assert.deepEqual([row.company, row.companySource], ['甲公司', 'cert']);
  });

  it('裝置詳情 / 事件 / 下載 / 狀態:範圍外與不存在相同', async () => {
    for (const [method, suffix, payload] of [
      ['GET', '', undefined],
      ['GET', '/events', undefined],
      ['GET', '/inventory.json', undefined],
      ['GET', '/health', undefined],
      ['PUT', '/status', { status: 'disabled' }],
      ['GET', '/commands', undefined],
      ['POST', '/basic-commands', { kind: 'inventory.collect' }],
      ['POST', '/admin-commands', { kind: 'agent.upgrade', params: { component: 'agent' } }],
      ['GET', '/upgrade', undefined],
      ['PUT', '/ring', { ring: 'it' }],
    ] as const) {
      const body = await sameAsMissing(tokens.a!, method, `/v1/devices/${devB.deviceId}${suffix}`, `/v1/devices/${NONE}${suffix}`, payload);
      assert.equal(body.code, 'ITA_DEVICE_NOT_FOUND');
      await sameAsMissing(tokens.a!, method, `/v1/devices/${devU.deviceId}${suffix}`, `/v1/devices/${NONE}${suffix}`, payload);
    }
    assert.equal(env.sql.byId(devB.id).status, 'active', '範圍外的停用不可生效');
    assert.equal((await call(tokens.b!, 'GET', `/v1/devices/${devB.deviceId}`)).statusCode, 200);
    assert.equal((await call(tokens.all!, 'GET', `/v1/devices/${devU.deviceId}`)).statusCode, 200);
  });

  it('疑似同一台:清單、標記、事件內容都不透露範圍外的另一台', async () => {
    const detailA = (await call(tokens.a!, 'GET', `/v1/devices/${devA.deviceId}`)).json();
    assert.deepEqual([detailA.suspectedDuplicates, detailA.suspectedDuplicate], [[], false]);
    assert.equal((await call(tokens.a!, 'GET', '/v1/devices')).json().items[0].suspectedDuplicate, false);
    const all = (await call(tokens.all!, 'GET', `/v1/devices/${devA.deviceId}`)).json();
    assert.deepEqual([all.suspectedDuplicates.map((d: { deviceId: string }) => d.deviceId), all.suspectedDuplicate], [[devB.deviceId], true]);

    // hello 寫的 suspected_duplicate 事件帶對方的名稱與 deviceId:範圍外改為不含識別資訊的說明
    await env.sql.addEvent(devA, 'suspected_duplicate', `與 PC-B(${devB.deviceId})硬體指紋相同`);
    const evA = (await call(tokens.a!, 'GET', `/v1/devices/${devA.deviceId}/events`)).json().items as { type: string; detail: string }[];
    const dupA = evA.find((e) => e.type === 'suspected_duplicate')!;
    assert.equal(dupA.detail, '與另一台裝置硬體指紋相同');
    assert.ok(!JSON.stringify(evA).includes(devB.deviceId));
    const evAll = (await call(tokens.all!, 'GET', `/v1/devices/${devA.deviceId}/events`)).json().items as { type: string; detail: string }[];
    assert.match(evAll.find((e) => e.type === 'suspected_duplicate')!.detail, new RegExp(devB.deviceId));
  });

  it('合併:目標或來源任一在範圍外 → 404,資料不變', async () => {
    await sameAsMissing(tokens.a!, 'POST', `/v1/devices/${devB.deviceId}/merge`, `/v1/devices/${NONE}/merge`, { sourceDeviceId: devA.deviceId, force: true });
    const res = await call(tokens.a!, 'POST', `/v1/devices/${devA.deviceId}/merge`, { sourceDeviceId: devB.deviceId, force: true });
    const missing = await call(tokens.a!, 'POST', `/v1/devices/${devA.deviceId}/merge`, { sourceDeviceId: NONE, force: true });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), missing.json());
    assert.equal(env.sql.byId(devB.id).mergedInto ?? null, null);
  });

  it('批次:任一台範圍外整批 404,不建立任何指令', async () => {
    const before = env.store.commands.length;
    const res = await call(tokens.a!, 'POST', '/v1/batches/basic-commands', { deviceIds: [devA.deviceId, devB.deviceId], kind: 'inventory.collect' });
    const missing = await call(tokens.a!, 'POST', '/v1/batches/basic-commands', { deviceIds: [devA.deviceId, NONE], kind: 'inventory.collect' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), missing.json());
    assert.equal(env.store.commands.length, before);
  });

  it('指令查詢 / 取消 / 批次 / 附檔:範圍外與不存在相同(取消回 404,不是 403)', async () => {
    assert.equal((await sameAsMissing(tokens.a!, 'GET', `/v1/commands/${cmdB}`, `/v1/commands/${NONE}`)).code, 'ITA_COMMAND_NOT_FOUND');
    assert.equal((await sameAsMissing(tokens.a!, 'POST', `/v1/commands/${cmdB}/cancel`, `/v1/commands/${NONE}/cancel`)).code, 'ITA_COMMAND_NOT_FOUND');
    assert.equal(env.store.commands.find((c) => c.commandId === cmdB)!.state, 'queued', '範圍外的取消不可生效');
    assert.equal((await sameAsMissing(tokens.a!, 'GET', `/v1/batches/${batchB}`, `/v1/batches/${NONE}`)).code, 'ITA_BATCH_NOT_FOUND');
    assert.equal(
      (await sameAsMissing(tokens.a!, 'GET', `/v1/commands/${cmdB}/files/${fileB}`, `/v1/commands/${cmdB}/files/${NONE}`)).code,
      'ITA_COMMAND_FILE_NOT_FOUND',
    );
    // 全部指令清單、依批次:只含範圍內裝置的指令
    const listA = (await call(tokens.a!, 'GET', '/v1/commands')).json().items as { deviceId: string }[];
    assert.ok(listA.every((c) => c.deviceId === devA.deviceId));
    assert.deepEqual((await call(tokens.a!, 'GET', `/v1/commands?batchId=${batchB}`)).json().items, []);
    assert.equal((await call(tokens.b!, 'GET', `/v1/commands/${cmdB}`)).json().files.length, 1);
    assert.equal((await call(tokens.b!, 'GET', `/v1/batches/${batchB}`)).statusCode, 200);
    assert.ok(((await call(tokens.b!, 'GET', '/v1/commands')).json().items as unknown[]).length >= 2);
  });

  it('Idempotency-Key 找到範圍外的既有指令:404,不回傳那一筆', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/devices/${devA.deviceId}/basic-commands`,
      payload: { kind: 'inventory.collect' },
      headers: { 'x-internal-token': tokens.a!, 'idempotency-key': 'k1' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'ITA_DEVICE_NOT_FOUND');

    // 批次:同一工號的 key 已用於含範圍外裝置的批次
    await env.commands.createBatch(allCtx, { sub: '1', emp: 'S000001' }, 'basic', [devB.deviceId], { kind: 'inventory.collect', idempotencyKey: 'bk' });
    const before = env.store.commands.length;
    const batch = await app.inject({
      method: 'POST',
      url: '/v1/batches/basic-commands',
      payload: { deviceIds: [devA.deviceId], kind: 'inventory.collect' },
      headers: { 'x-internal-token': tokens.a!, 'idempotency-key': 'bk' },
    });
    assert.deepEqual([batch.statusCode, batch.json().code], [404, 'ITA_DEVICE_NOT_FOUND']);
    assert.equal(env.store.commands.length, before);
  });

  it('PUT /company:只有全部公司角色;指定後範圍跟著變、不再自動改;null 改回自動判定', async () => {
    const put = (token: string, id: string, company: string | null) => call(token, 'PUT', `/v1/devices/${id}/company`, { company, reason: '測試' });
    const denied = await put(tokens.a!, devA.deviceId, '乙公司');
    assert.deepEqual([denied.statusCode, denied.json().code], [403, 'ITA_SCOPE_ALL_REQUIRED']);
    assert.equal((await put(tokens.all!, devA.deviceId, '   ')).statusCode, 400);

    const ok = await put(tokens.all!, devU.deviceId, '甲公司');
    assert.deepEqual(ok.json(), { deviceId: devU.deviceId, company: '甲公司', companySource: 'manual', changed: true });
    assert.deepEqual(ids(await call(tokens.a!, 'GET', '/v1/devices')), [devA.deviceId, devU.deviceId].sort());
    const events = (await call(tokens.a!, 'GET', `/v1/devices/${devU.deviceId}/events`)).json().items as { type: string }[];
    assert.ok(events.some((e) => e.type === 'company_changed'));

    // 乙改指定為甲公司(manual)後,回報網域不再改回乙
    await put(tokens.all!, devB.deviceId, '甲公司');
    const fresh = (await env.sql.findByDn(devB.certDn))!;
    const inv = structuredClone(inventoryRequest({ content_hash: 'd'.repeat(64), agent_seq: 99 }));
    inv.inventory.system.domain = 'b.example';
    await env.service.ingestInventory(agentCtx, fresh, inv);
    assert.deepEqual([env.sql.byId(devB.id).company, env.sql.byId(devB.id).companySource], ['甲公司', 'manual']);
    assert.equal((await call(tokens.b!, 'GET', `/v1/devices/${devB.deviceId}`)).statusCode, 404, '乙 IT 已看不到');

    // null:改回自動判定(回報網域 b.example → 乙公司)
    const reset = await put(tokens.all!, devB.deviceId, null);
    assert.deepEqual([reset.json().company, reset.json().companySource], ['乙公司', 'domain']);
  });

  it('回報網域變更:domain 來源跟著改;cert 來源不動', async () => {
    const b = (await env.sql.findByDn(devB.certDn))!;
    const inv = structuredClone(inventoryRequest({ content_hash: 'e'.repeat(64), agent_seq: 100 }));
    inv.inventory.system.domain = 'a.example';
    await env.service.ingestInventory(agentCtx, b, inv);
    assert.deepEqual([env.sql.byId(devB.id).company, env.sql.byId(devB.id).companySource], ['甲公司', 'domain']);
    inv.content_hash = 'f'.repeat(64);
    inv.agent_seq = 101;
    inv.inventory.system.domain = 'unknown.example';
    await env.service.ingestInventory(agentCtx, (await env.sql.findByDn(devB.certDn))!, inv);
    assert.deepEqual([env.sql.byId(devB.id).company, env.sql.byId(devB.id).companySource], [null, null], '判不出改回未指定');

    const a = (await env.sql.findByDn(devA.certDn))!;
    inv.content_hash = '9'.repeat(64);
    inv.agent_seq = 102;
    inv.inventory.system.domain = 'b.example';
    await env.service.ingestInventory(agentCtx, a, inv);
    assert.deepEqual([env.sql.byId(devA.id).company, env.sql.byId(devA.id).companySource], ['甲公司', 'cert']);
  });

  it('告警(P5):清單只列範圍內;依 deviceId 篩選範圍外為空;關閉範圍外與不存在相同', async () => {
    const at = env.clock.now();
    const b = await env.monitor.openAlert({ deviceRef: devB.id, rule: 'disk_low', severity: 'warn', detail: '{}', at });
    await env.monitor.openAlert({ deviceRef: devU.id, rule: 'disk_low', severity: 'warn', detail: '{}', at });
    // 前面的測試改過公司:這裡固定為乙公司 / 未指定,結束後還原;甲可能已有別的告警,只看這兩台
    const saved = [env.sql.byId(devB.id), env.sql.byId(devU.id)].map((d) => [d.company, d.companySource] as const);
    env.sql.setCompanyRaw(devB.id, '乙公司', 'manual');
    env.sql.setCompanyRaw(devU.id, null);
    const mine = new Set([devB.deviceId, devU.deviceId]);
    const alertIds = (res: { json(): unknown }) =>
      (res.json() as { items: { deviceId: string }[] }).items
        .map((x) => x.deviceId)
        .filter((id) => mine.has(id))
        .sort();
    assert.deepEqual(alertIds(await call(tokens.a!, 'GET', '/v1/alerts')), []);
    assert.deepEqual(alertIds(await call(tokens.b!, 'GET', '/v1/alerts')), [devB.deviceId]);
    assert.deepEqual(alertIds(await call(tokens.all!, 'GET', '/v1/alerts')), [devB.deviceId, devU.deviceId].sort());
    assert.deepEqual(alertIds(await call(tokens.none!, 'GET', '/v1/alerts')), []);
    assert.deepEqual(alertIds(await call(tokens.a!, 'GET', `/v1/alerts?deviceId=${devB.deviceId}`)), []);
    const body = await sameAsMissing(tokens.a!, 'POST', `/v1/alerts/${b.alertId}/resolve`, `/v1/alerts/${NONE}/resolve`, { note: '確認' });
    assert.equal(body.code, 'ITA_ALERT_NOT_FOUND');
    assert.equal(env.monitor.alerts.find((x) => x.alertId === b.alertId)!.state, 'open', '範圍外的關閉不可生效');
    assert.equal((await call(tokens.b!, 'POST', `/v1/alerts/${b.alertId}/resolve`, { note: '確認' })).statusCode, 200);
    env.sql.setCompanyRaw(devB.id, ...saved[0]!);
    env.sql.setCompanyRaw(devU.id, ...saved[1]!);
  });

  it('升級(P6):版本與環的維護只有全部公司角色;環進度只計範圍內;查詢不分公司', async () => {
    for (const [method, url, payload] of [
      ['POST', '/v1/releases', { component: 'agent', version: '0.7.1', fileName: 'rustit-agent.exe', signerThumbprints: ['a'.repeat(40)] }],
      ['POST', `/v1/releases/${NONE}/publish`, undefined],
      ['POST', `/v1/releases/${NONE}/revoke`, undefined],
      ['PUT', '/v1/release-rings/pilot/agent', { targetVersion: null }],
    ] as const) {
      const res = await call(tokens.a!, method, url, payload);
      assert.deepEqual([res.statusCode, res.json().code], [403, 'ITA_SCOPE_ALL_REQUIRED'], `${method} ${url}`);
    }
    assert.equal((await call(tokens.all!, 'PUT', '/v1/release-rings/pilot/agent', { targetVersion: null })).statusCode, 200);
    // 範圍內的電腦放進 pilot 也需全部公司角色
    // (前面的測試會改裝置的公司:以當下 token 甲看得到的那台測)
    const mine = [devA, devB, devU].find((d) => env.sql.byId(d.id).company === '甲公司')!;
    const pilot = await call(tokens.a!, 'PUT', `/v1/devices/${mine.deviceId}/ring`, { ring: 'pilot' });
    assert.deepEqual([pilot.statusCode, pilot.json().code], [403, 'ITA_SCOPE_ALL_REQUIRED']);
    const total = async (token: string) =>
      ((await call(token, 'GET', '/v1/release-rings')).json() as { items: { ring: string; component: string; progress: { total: number } }[] }).items;
    assert.ok(
      (await total(tokens.a!)).every((r) => r.progress.total === 0),
      '沒有設定目標時不計',
    );
    assert.equal((await call(tokens.none!, 'GET', '/v1/releases')).statusCode, 200);
    assert.equal((await call(tokens.none!, 'GET', '/v1/releases/files')).statusCode, 200);
  });

  it('軟體派送(P7):目錄維護只有全部公司角色;已安裝台數只計範圍內;派送與核可範圍外與不存在相同', async () => {
    swDir.put('Example Office/16.0.1/office-setup.exe', 'MZ-office');
    const body = {
      name: 'Example Office',
      version: '16.0.1',
      fileName: 'Example Office/16.0.1/office-setup.exe',
      installerType: 'exe',
      installArgs: '/quiet',
      detectType: 'display_name',
      detectValue: 'Example Office%',
    };
    for (const [method, url, payload] of [
      ['POST', '/v1/software', body],
      ['PUT', `/v1/software/${NONE}`, { notes: 'x' }],
      ['POST', `/v1/software/${NONE}/mark-tested`, { signerThumbprints: ['a'.repeat(40)] }],
      ['POST', `/v1/software/${NONE}/publish`, undefined],
      ['POST', `/v1/software/${NONE}/revoke`, undefined],
    ] as const) {
      const res = await call(tokens.a!, method, url, payload);
      assert.deepEqual([res.statusCode, res.json().code], [403, 'ITA_SCOPE_ALL_REQUIRED'], `${method} ${url}`);
    }
    const reg = await call(tokens.all!, 'POST', '/v1/software', body);
    assert.equal(reg.statusCode, 200, reg.body);
    const pkgId = reg.json().packageId as string;
    // 已安裝台數:甲只看到 PC-A;全部公司看到 PC-A、PC-B(PC-U 沒有資產)。清單只算已發佈的套件(M6),draft 看詳情
    assert.equal(((await call(tokens.all!, 'GET', '/v1/software')).json().items as { installedCount: number | null }[])[0]!.installedCount, null);
    const count = async (token: string) => (await call(token, 'GET', `/v1/software/${pkgId}`)).json().installedCount as number;
    assert.equal(await count(tokens.all!), 2);
    assert.equal(await count(tokens.a!), [devA, devB].filter((d) => env.sql.byId(d.id).company === '甲公司').length);
    assert.equal(await count(tokens.none!), 0);
    assert.equal((await call(tokens.none!, 'GET', '/v1/software/files')).statusCode, 200);
    const detail = (await call(tokens.a!, 'GET', `/v1/software/${pkgId}`)).json() as { installedDevices: { deviceId: string }[] };
    assert.ok(detail.installedDevices.every((d) => env.sql.byId([devA, devB, devU].find((x) => x.deviceId === d.deviceId)!.id).company === '甲公司'));
    assert.equal((await call(tokens.a!, 'GET', `/v1/software/${NONE}`)).json().code, 'ITA_PACKAGE_NOT_FOUND');
    // 派送:範圍外的電腦與不存在相同,不建立任何指令
    const theirs = [devA, devB, devU].find((d) => env.sql.byId(d.id).company !== '甲公司')!;
    const before = env.store.commands.length;
    const denied = await call(tokens.a!, 'POST', `/v1/software/${pkgId}/deploy`, { action: 'uninstall', deviceIds: [theirs.deviceId] });
    const missing = await call(tokens.a!, 'POST', `/v1/software/${pkgId}/deploy`, { action: 'uninstall', deviceIds: [NONE] });
    assert.equal(denied.statusCode, 404);
    assert.deepEqual(denied.json(), missing.json());
    assert.equal(env.store.commands.length, before);
    // 核可 / 駁回:批次含範圍外裝置與不存在相同;範圍內但不是待核可 409
    assert.equal((await sameAsMissing(tokens.a!, 'POST', `/v1/batches/${batchB}/approve`, `/v1/batches/${NONE}/approve`)).code, 'ITA_BATCH_NOT_FOUND');
    assert.equal(
      (await sameAsMissing(tokens.a!, 'POST', `/v1/batches/${batchB}/reject`, `/v1/batches/${NONE}/reject`, { reason: '測試' })).code,
      'ITA_BATCH_NOT_FOUND',
    );
    const notPending = await call(tokens.all!, 'POST', `/v1/batches/${batchB}/approve`);
    assert.deepEqual([notPending.statusCode, notPending.json().code], [409, 'ITA_BATCH_NOT_PENDING']);
  });

  it('路由清單:OpenAPI 的每個 operation 都已在本檔驗證資料範圍', async () => {
    const doc = (await app.inject('/openapi.json')).json() as { paths: Record<string, Record<string, { operationId: string }>> };
    const ops = Object.values(doc.paths)
      .flatMap((p) => Object.values(p).map((o) => o.operationId))
      .sort();
    // 新增管理路由時,先在上面補上範圍測試,再把 operationId 加進這份清單
    const VERIFIED = [
      'endpoint.alert.list',
      'endpoint.alert.resolve',
      'endpoint.command.admin.create',
      'endpoint.command.basic.batch',
      'endpoint.command.basic.create',
      'endpoint.command.batch.approve',
      'endpoint.command.batch.get',
      'endpoint.command.batch.reject',
      'endpoint.command.cancel',
      'endpoint.command.file.download',
      'endpoint.command.get',
      'endpoint.command.list',
      'endpoint.command.list-by-device',
      'endpoint.device.company',
      'endpoint.device.events',
      'endpoint.device.get',
      'endpoint.device.health',
      'endpoint.device.inventory-download',
      'endpoint.device.list',
      'endpoint.device.merge',
      'endpoint.device.set-ring',
      'endpoint.device.status',
      'endpoint.device.upgrade',
      'endpoint.release-ring.list',
      'endpoint.release-ring.set',
      'endpoint.release.files',
      'endpoint.release.list',
      'endpoint.release.publish',
      'endpoint.release.register',
      'endpoint.release.revoke',
      'endpoint.software.deploy',
      'endpoint.software.files',
      'endpoint.software.get',
      'endpoint.software.list',
      'endpoint.software.mark-tested',
      'endpoint.software.publish',
      'endpoint.software.register',
      'endpoint.software.revoke',
      'endpoint.software.update',
    ];
    assert.deepEqual(ops, VERIFIED);
  });
});

describe('啟動回填所屬公司', () => {
  it('只處理未判定的裝置;判不出維持未指定;未設定對應時不處理', async () => {
    const env = setupCommands({ companyDomains: DOMAINS });
    // 模擬 migration 0005 前登錄:直接寫 store,不經 identify 判定
    const x = await env.sql.register({ certDn: 'CN=PC-X.a.example', certFp: '1'.repeat(40), computerName: 'PC-X', requestId: 't', at: env.clock.now() });
    const y = await env.sql.register({ certDn: 'CN=PC-Y', certFp: '2'.repeat(40), computerName: 'PC-Y', requestId: 't', at: env.clock.now() });
    const z = await env.sql.register({ certDn: 'CN=PC-Z.b.example', certFp: '3'.repeat(40), computerName: 'PC-Z', requestId: 't', at: env.clock.now() });
    env.sql.setCompanyRaw(z.id, '丙公司', 'manual');
    assert.equal(await env.service.backfillCompany(agentCtx), 1);
    assert.deepEqual([env.sql.byId(x.id).company, env.sql.byId(x.id).companySource], ['甲公司', 'cert']);
    assert.equal(env.sql.byId(y.id).company, null);
    assert.equal(env.sql.byId(z.id).company, '丙公司');
    assert.equal(await env.service.backfillCompany(agentCtx), 0, '冪等');
    assert.equal(await setupCommands().service.backfillCompany(agentCtx), 0);
  });

  it('合併:目標未指定時取來源的公司;已指定則不變', async () => {
    const env = setupCommands({ companyDomains: DOMAINS });
    const actor = { emp: 'S000003', name: null };
    const t = await env.service.identify(agentCtx, 'CN=PC-T', '4'.repeat(40));
    const s = await env.service.identify(agentCtx, 'CN=PC-S.b.example', '5'.repeat(40));
    await env.service.merge(allCtx, actor, t.deviceId, s.deviceId, '', true);
    assert.deepEqual([env.sql.byId(t.id).company, env.sql.byId(t.id).companySource], ['乙公司', 'cert']);
    const t2 = await env.service.identify(agentCtx, 'CN=PC-T2.a.example', '6'.repeat(40));
    const s2 = await env.service.identify(agentCtx, 'CN=PC-S2.b.example', '7'.repeat(40));
    await env.service.merge(allCtx, actor, t2.deviceId, s2.deviceId, '', true);
    assert.deepEqual([env.sql.byId(t2.id).company, env.sql.byId(t2.id).companySource], ['甲公司', 'cert']);
  });

  it('已合併的來源:併入的目標改到範圍外後不再顯示其 deviceId;指定公司回 409', async () => {
    const env = setupCommands({ companyDomains: DOMAINS });
    const actor = { emp: 'S000003', name: null };
    const a = { log, requestId: 't', scope: only('甲公司') };
    const t = await env.service.identify(agentCtx, 'CN=PC-T.a.example', '4'.repeat(40));
    const s = await env.service.identify(agentCtx, 'CN=PC-S.a.example', '5'.repeat(40));
    await env.service.merge(allCtx, actor, t.deviceId, s.deviceId, '', true);
    assert.equal((await env.service.getDevice(a, s.deviceId)).mergedInto, t.deviceId);
    await assert.rejects(env.service.setCompany(allCtx, actor, s.deviceId, '甲公司', ''), { code: 'ITA_DEVICE_STATUS_INVALID' });

    await env.service.setCompany(allCtx, actor, t.deviceId, '乙公司', '');
    assert.equal((await env.service.getDevice(a, s.deviceId)).mergedInto, null);
    assert.equal((await env.service.listDevices(a, { statuses: ['retired'], page: 1, pageSize: 50 })).items[0]!.mergedInto, null);
    await assert.rejects(
      env.service.setStatus(a, actor, s.deviceId, 'active', ''),
      (err: { details?: { mergedInto: unknown } }) => err.details?.mergedInto === null,
    );
    assert.equal((await env.service.getDevice(allCtx, s.deviceId)).mergedInto, t.deviceId);
  });
});
