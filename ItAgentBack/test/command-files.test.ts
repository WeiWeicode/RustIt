/**
 * P4-2 遠端診斷(PLATFORM-PLAN A4、B5;docs/contracts/command-kinds.md):
 *   類型:agent.diagnose / logs.collect / agent.log_level 的參數驗證與每台上限;
 *   附檔上傳(:51241):裝置相符、類型允許、狀態 acked / running、SHA-256、大小、重送冪等、SQL 失敗刪檔;
 *   下載(:51240):GET /commands/{id} 的 files、下載標頭與內容、404 / 410、x-permission;到期清除。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import { loadGatewayEnv, loadMonitorEnv, type GatewayIdentity } from '@giganexus/backend-sdk';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildAgentApp } from '../src/agent-app.js';
import { buildMgmtApp } from '../src/mgmt-app.js';
import { FILE_MAX_BYTES } from '../src/services/command-files.js';
import type { DeviceRecord } from '../src/stores/types.js';
import { ALL, CONTRACTS_DIR, DN, FP, certHeaders, setupCommands } from './helpers.js';

const log = Fastify({ logger: { level: 'silent' } }).log;
const ctx = { log, requestId: 'req-diag-1', scope: ALL };
const IT: GatewayIdentity = { sub: '1', emp: 'S000001', name: '測試人員' };
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv) => Ajv;
const validateUpload = addFormats(new Ajv({ strict: true })).compile(JSON.parse(readFileSync(path.join(CONTRACTS_DIR, 'command-file.schema.json'), 'utf8')));

let env: ReturnType<typeof setupCommands>;
let device: DeviceRecord;

const zip = Buffer.from('PK\u0003\u0004 假的 zip 內容(測試用)');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** 建立指令並推進到 running(Agent 已 acked) */
async function running(kind: string, params: Record<string, unknown> = {}, d = device) {
  const v = await env.commands.create(ctx, IT, 'basic', d.deviceId, { kind, params });
  await env.commands.onUpdate(ctx, d.id, { command_id: v.commandId, state: 'acked' });
  await env.commands.onUpdate(ctx, d.id, { command_id: v.commandId, state: 'running' });
  return v.commandId;
}

describe('P4-2 指令類型', () => {
  beforeEach(async () => {
    env = setupCommands();
    device = await env.service.identify(ctx, DN, FP);
  });

  it('參數驗證:logs.collect days 1–14、agent.log_level level 必填且只能 debug / trace / default、agent.diagnose 無參數', async () => {
    const create = (kind: string, params: Record<string, unknown>) => env.commands.create(ctx, IT, 'basic', device.deviceId, { kind, params });
    for (const [kind, params] of [
      ['logs.collect', { days: 0 }],
      ['logs.collect', { days: 15 }],
      ['logs.collect', { path: 'C:\\Windows' }],
      ['agent.log_level', {}],
      ['agent.log_level', { level: 'info' }],
      ['agent.log_level', { level: 'debug', duration_min: 4 }],
      ['agent.log_level', { level: 'debug', duration_min: 1441 }],
      ['agent.diagnose', { target: '8.8.8.8' }],
    ] as const)
      await assert.rejects(create(kind, params), { code: 'VALIDATION_FAILED' }, `${kind} ${JSON.stringify(params)}`);
    assert.equal(env.store.commands.length, 0);
    assert.equal((await create('logs.collect', { days: 14 })).state, 'queued');
    assert.equal((await create('agent.log_level', { level: 'trace', duration_min: 1440 })).state, 'queued');
    assert.equal((await create('agent.diagnose', {})).state, 'queued');
  });

  it('同一台尚未結束的三種診斷指令各 1 筆(409 ITA_COMMAND_LIMIT)', async () => {
    for (const [kind, params] of [
      ['agent.diagnose', {}],
      ['logs.collect', {}],
      ['agent.log_level', { level: 'debug' }],
    ] as const) {
      await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind, params });
      await assert.rejects(env.commands.create(ctx, IT, 'basic', device.deviceId, { kind, params }), { code: 'ITA_COMMAND_LIMIT' });
    }
  });
});

describe('指令附檔上傳(:51241)', () => {
  let agent: FastifyInstance;
  beforeEach(async () => {
    env = setupCommands();
    device = await env.service.identify(ctx, DN, FP);
    agent = await buildAgentApp({
      config: { logLevel: 'silent', agentTls: null, trustedProxies: null },
      service: env.service,
      commands: env.commands,
      files: env.files,
      contractsDir: CONTRACTS_DIR,
    });
  });

  const upload = (commandId: string, body: Buffer, hash = sha(body), headers: Record<string, string> = certHeaders()) =>
    agent.inject({
      method: 'POST',
      url: `/agent/v1/commands/${commandId}/files`,
      headers: { ...headers, 'content-type': 'application/zip', 'x-file-sha256': hash },
      payload: body,
    });

  it('201 符合契約;檔案寫入存放目錄、索引列帶主機產生的檔名與 14 天期限;重送相同內容回同一個 file_id', async () => {
    const id = await running('logs.collect', { days: 3 });
    const res = await upload(id, zip);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { file_id: string; sha256: string; size_bytes: number; expires_at: string };
    assert.ok(validateUpload(body), JSON.stringify(validateUpload.errors));
    assert.deepEqual([body.sha256, body.size_bytes, body.expires_at], [sha(zip), zip.length, '2026-10-20T08:00:00.000Z']);
    const [f] = env.store.files;
    assert.ok(f);
    assert.equal(f.fileName, 'PC-EXAMPLE-01-logs-20261006-080000Z.zip');
    assert.equal(f.storagePath, `2026/10/${body.file_id}.zip`);
    assert.deepEqual(readFileSync(path.join(env.filesDir, f.storagePath)), zip);
    const again = await upload(id, zip);
    assert.deepEqual([again.statusCode, again.json().file_id], [201, body.file_id]);
    assert.equal(env.store.files.length, 1);
    const other = await upload(id, Buffer.from('另一份內容'));
    assert.deepEqual([other.statusCode, other.json().code], [409, 'ITA_COMMAND_FILE_EXISTS']);
  });

  it('別台的指令 404;不允許附檔的類型 400;尚未 acked 或已結束 409', async () => {
    const otherDevice = await env.service.identify(ctx, 'O=GigaNexus Dev,CN=PC-EXAMPLE-02', FP);
    const others = await running('logs.collect', {}, otherDevice);
    assert.deepEqual([(await upload(others, zip)).statusCode, (await upload(others, zip)).json().code], [404, 'ITA_COMMAND_NOT_FOUND']);
    const diag = await running('agent.diagnose');
    assert.equal((await upload(diag, zip)).json().code, 'ITA_COMMAND_FILE_NOT_ALLOWED');
    const queued = (await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'logs.collect' })).commandId;
    const res = await upload(queued, zip);
    assert.deepEqual([res.statusCode, res.json().code], [409, 'ITA_COMMAND_NOT_RUNNING']);
    assert.equal((await upload('00000000-0000-4000-8000-000000000000', zip)).statusCode, 404);
    assert.equal(env.store.files.length, 0);
  });

  it('SHA-256 不符 400(不留檔);缺少 x-file-sha256 400;超過 20 MB 413;未帶憑證 401', async () => {
    const id = await running('logs.collect');
    const bad = await upload(id, zip, 'a'.repeat(64));
    assert.deepEqual([bad.statusCode, bad.json().code], [400, 'ITA_FILE_HASH_MISMATCH']);
    assert.equal((await upload(id, zip, 'not-hex')).statusCode, 400);
    const big = Buffer.alloc(FILE_MAX_BYTES + 1);
    const tooBig = await upload(id, big);
    assert.deepEqual([tooBig.statusCode, tooBig.json().code], [413, 'ITA_FILE_TOO_LARGE']);
    assert.equal((await upload(id, zip, sha(zip), {})).statusCode, 401);
    const chunked = await agent.inject({
      method: 'POST',
      url: `/agent/v1/commands/${id}/files`,
      // 串流本體:不帶 Content-Length(分段傳送)
      headers: { ...certHeaders(), 'content-type': 'application/zip', 'x-file-sha256': sha(zip) },
      payload: Readable.from([zip]),
    });
    assert.deepEqual([chunked.statusCode, chunked.json().code], [411, 'ITA_LENGTH_REQUIRED']);
    assert.equal(env.store.files.length, 0);
    const left = readdirSync(env.filesDir, { recursive: true }).filter((n) => String(n).endsWith('.zip') || String(n).endsWith('.part'));
    assert.deepEqual(left, []);
  });

  it('SQL 無法寫入索引:503 且刪除已寫入的檔案(Agent 重試)', async () => {
    const id = await running('logs.collect');
    const add = env.store.addFile.bind(env.store);
    env.store.addFile = async () => {
      throw new Error('SQL 模擬故障');
    };
    const res = await upload(id, zip);
    assert.deepEqual([res.statusCode, res.json().code], [503, 'ITA_STORAGE_UNAVAILABLE']);
    const left = readdirSync(env.filesDir, { recursive: true }).filter((n) => String(n).endsWith('.zip'));
    assert.deepEqual(left, []);
    env.store.addFile = add;
    assert.equal((await upload(id, zip)).statusCode, 201);
  });
});

describe('指令附檔下載與清除(:51240)', () => {
  let agent: FastifyInstance;
  let mgmt: FastifyInstance;
  before(async () => {
    env = setupCommands();
    device = await env.service.identify(ctx, DN, FP);
    agent = await buildAgentApp({
      config: { logLevel: 'silent', agentTls: null, trustedProxies: null },
      service: env.service,
      commands: env.commands,
      files: env.files,
      contractsDir: CONTRACTS_DIR,
    });
    const gateway = loadGatewayEnv({ GW_ENV: 'dev', SERVICE_CODE: 'endpoint-api', GW_JWKS_URL: 'http://127.0.0.1:1/jwks.json' });
    mgmt = await buildMgmtApp({
      config: { gateway, monitor: loadMonitorEnv('dev', {}), logLevel: 'silent', devSkipToken: true, scopeAllRoles: [] },
      service: env.service,
      commands: env.commands,
      files: env.files,
    });
  });
  after(async () => {
    await agent.close();
    await mgmt.close();
  });

  it('GET /commands/{id} 帶 files;下載內容與標頭正確;fileId 不屬於該指令 404;過期 410;清除後刪檔與索引', async () => {
    const id = await running('logs.collect');
    const up = await agent.inject({
      method: 'POST',
      url: `/agent/v1/commands/${id}/files`,
      headers: { ...certHeaders(), 'content-type': 'application/zip', 'x-file-sha256': sha(zip) },
      payload: zip,
    });
    const fileId = up.json().file_id as string;
    await env.commands.onUpdate(ctx, device.id, { command_id: id, state: 'succeeded', result: { file_id: fileId } });

    const got = (await mgmt.inject({ method: 'GET', url: `/v1/commands/${id}` })).json() as { files: Record<string, unknown>[] };
    assert.equal(got.files.length, 1);
    assert.deepEqual([got.files[0]!.fileId, got.files[0]!.sizeBytes, got.files[0]!.expired], [fileId, zip.length, false]);

    const dl = await mgmt.inject({ method: 'GET', url: `/v1/commands/${id}/files/${fileId}` });
    assert.equal(dl.statusCode, 200);
    assert.deepEqual(dl.rawPayload, zip);
    assert.equal(dl.headers['content-type'], 'application/zip');
    assert.equal(dl.headers['content-disposition'], 'attachment; filename="PC-EXAMPLE-01-logs-20261006-080000Z.zip"');
    assert.equal(dl.headers['x-content-type-options'], 'nosniff');
    assert.equal(dl.headers['x-file-sha256'], sha(zip));

    const otherCmd = (await env.commands.create(ctx, IT, 'basic', device.deviceId, { kind: 'agent.diagnose' })).commandId;
    const wrong = await mgmt.inject({ method: 'GET', url: `/v1/commands/${otherCmd}/files/${fileId}` });
    assert.deepEqual([wrong.statusCode, wrong.json().code], [404, 'ITA_COMMAND_FILE_NOT_FOUND']);

    env.clock.advance(14 * 86400);
    const gone = await mgmt.inject({ method: 'GET', url: `/v1/commands/${id}/files/${fileId}` });
    assert.deepEqual([gone.statusCode, gone.json().code], [410, 'ITA_COMMAND_FILE_EXPIRED']);
    const stored = path.join(env.filesDir, env.store.files[0]!.storagePath);
    assert.equal(await env.files.sweep(ctx), 1);
    assert.equal(existsSync(stored), false);
    assert.equal(env.store.files.length, 0);
    // 指令紀錄與 result 保留
    const after = (await mgmt.inject({ method: 'GET', url: `/v1/commands/${id}` })).json() as { result: unknown; files: unknown[] };
    assert.deepEqual([after.result, after.files], [{ file_id: fileId }, []]);
  });

  it('OpenAPI:下載宣告 endpoint.device.read 與 x-audit-level: meta', async () => {
    const doc = (await mgmt.inject({ method: 'GET', url: '/openapi.json' })).json() as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const op = doc.paths['/v1/commands/{commandId}/files/{fileId}']!.get!;
    assert.equal(op['x-permission'], 'endpoint.device.read');
    assert.equal(op['x-audit-level'], 'meta');
  });

  it('OpenAPI 符合 Gateway 匯入規則(全部路由;任一不符時整批註冊失敗 IMPORT_HAS_ERRORS)', async () => {
    // 同 giga-api-gateway-bff bff/src/cli/openapi.ts 的檢查
    const CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/;
    const doc = (await mgmt.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      'x-permissions': { code: string }[];
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const declared = new Set(doc['x-permissions'].map((p) => p.code));
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    assert.ok(ops.length >= 10, `路由數 ${ops.length}`);
    for (const op of ops) {
      const id = String(op.operationId);
      assert.match(id, CODE, `operationId 格式:${id}`);
      assert.ok(op.summary, `${id} 缺少 summary`);
      const perm = String(op['x-permission']);
      assert.match(perm, CODE, `${id} x-permission 格式`);
      assert.ok(declared.has(perm), `${id} 的 x-permission ${perm} 未列在 x-permissions`);
      assert.ok(typeof op.description === 'string' && op.description.length <= 1000, `${id} description 需 1000 字內`);
      assert.ok(typeof op['x-gherkin'] === 'string', `${id} 缺少 x-gherkin`);
    }
  });
});
