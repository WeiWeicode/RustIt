/**
 * 整合測試(npm run test:int,讀 .env):真實的 SQL Server 2012(ITA_TEST_DB_NAME = giganexus_It_Agent_poc_test)、
 * 本機 compose 的 MongoDB / Redis。每次執行先清空並重建 schema ita(resetSchema 只允許 *_poc_test),
 * Mongo 用獨立資料庫 ita_int_test、Redis 用前綴 ita:int_test:,不碰開發資料。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { connect, migrate, migrateConfig, resetSchema } from '../../src/db/migrator.js';
import { DeviceService } from '../../src/services/device-service.js';
import { MongoSnapshotStore } from '../../src/stores/mongo-store.js';
import { RedisStateStore } from '../../src/stores/redis-store.js';
import { SqlCommandStore } from '../../src/stores/sql-command-store.js';
import { CommandFileService } from '../../src/services/command-files.js';
import { SqlDeviceStore } from '../../src/stores/sql-store.js';
import { CommandDispatcher } from '../../src/services/command-dispatcher.js';
import { parseCompanyDomains } from '../../src/services/company.js';
import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { ALL, DN, FakeConnection, FP, inventoryRequest, LIST_ALL } from '../helpers.js';

const env = process.env;
const testDb = env.ITA_TEST_DB_NAME ?? '';
if (!testDb.endsWith('_poc_test')) throw new Error(`ITA_TEST_DB_NAME 必須是整合測試庫(*_poc_test):${testDb}`);

const MONGO_DB = 'ita_int_test';
const REDIS_PREFIX = 'ita:int_test:';
const log = Fastify({ logger: { level: 'silent' } }).log;
const ctx = { log, requestId: 'int-test', scope: ALL };

let sql: SqlDeviceStore;
let mongo: MongoSnapshotStore;
let redis: RedisStateStore;
let service: DeviceService;

before(async () => {
  const pool = await connect(migrateConfig(env, testDb));
  try {
    await resetSchema(pool);
    const dir = path.resolve(import.meta.dirname, '../../db/migrations');
    assert.ok((await migrate(pool, dir, () => undefined)).length > 0);
    assert.deepEqual(await migrate(pool, dir, () => undefined), [], '第二次執行沒有待套用的 migration');
  } finally {
    await pool.close();
  }
  const m = new MongoClient(env.MONGO_URL!);
  await m.db(MONGO_DB).dropDatabase();
  await m.close();
  const r = new Redis(env.REDIS_URL!);
  const keys = await r.keys(`${REDIS_PREFIX}*`);
  if (keys.length) await r.del(...keys);
  r.disconnect();

  sql = new SqlDeviceStore({ server: env.ITA_DB_HOST!, port: Number(env.ITA_DB_PORT ?? 1433), database: testDb, user: env.ITA_DB_USER!, password: env.ITA_DB_PASSWORD! });
  mongo = new MongoSnapshotStore(env.MONGO_URL!, MONGO_DB, 1);
  await mongo.ensureIndexes();
  redis = new RedisStateStore(env.REDIS_URL!, REDIS_PREFIX);
  service = new DeviceService(sql, mongo, redis, { heartbeatIntervalSec: 30 });
});

after(async () => {
  await Promise.allSettled([sql.close(), mongo.close(), redis.close()]);
});

describe('SQL Server + Mongo + Redis', () => {
  it('ita_app 可讀寫:登錄、寫入資產、hash 沒變不重寫、清單與詳情', async () => {
    const device = await service.identify(ctx, DN, FP);
    assert.match(device.deviceId, /^[0-9a-f-]{36}$/);
    assert.equal(device.computerName, 'PC-EXAMPLE-01', '登錄時以 CN 為電腦名稱');

    assert.equal((await service.ingestInventory(ctx, device, inventoryRequest())).result, 'stored');
    assert.equal((await service.ingestInventory(ctx, device, inventoryRequest({ agent_seq: inventoryRequest().agent_seq + 1 }))).result, 'unchanged');

    const [row] = (await service.listDevices(ctx, LIST_ALL)).items;
    assert.equal(row!.deviceId, device.deviceId);
    assert.equal(row!.userName, 'EXAMPLE\\user01');
    assert.equal(row!.memoryTotal, 17179869184);
    assert.deepEqual(row!.ips, ['192.0.2.10', '198.51.100.20']);
    assert.equal(row!.osVersion, '24H2 / 26100.6584');
    assert.equal(row!.online, false);

    const detail = await service.getDevice(ctx, device.deviceId);
    assert.equal((detail.inventory as { system: { hostName: string } }).system.hostName, 'PC-EXAMPLE-01');
    assert.equal(detail.collectedAt, '2026-10-06T08:00:00.000Z');
  });

  it('同一 DN 再次識別為同一台;新指紋寫稽核', async () => {
    const again = await service.identify(ctx, DN, 'c'.repeat(40));
    const list = (await service.listDevices(ctx, LIST_ALL)).items;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.deviceId, again.deviceId);
    assert.equal(list[0]!.certFingerprint, 'c'.repeat(40));
  });

  it('較舊的快照只進 Mongo 歷史;同一份重複補傳不重複', async () => {
    const device = await service.identify(ctx, DN, 'c'.repeat(40));
    const old = inventoryRequest({ agent_seq: 1, collected_at: '2026-10-01T00:00:00Z', content_hash: 'd'.repeat(64) });
    assert.equal((await service.ingestInventory(ctx, device, old)).result, 'archived');
    assert.equal((await service.ingestInventory(ctx, device, old)).result, 'archived');
    const m = new MongoClient(env.MONGO_URL!);
    try {
      assert.equal(await m.db(MONGO_DB).collection('snapshots').countDocuments({ device_id: device.deviceId }), 2);
    } finally {
      await m.close();
    }
  });

  it('WebSocket 在線狀態寫入 Redis(TTL),關閉後離線', async () => {
    const device = await service.identify(ctx, DN, 'c'.repeat(40));
    const conn = { send() {}, close() {}, terminate() {} };
    await service.connected(ctx, device, conn);
    await service.heartbeat(ctx, device, { outbox_pending: 0 });
    assert.equal(((await service.listDevices(ctx, LIST_ALL)).items)[0]!.online, true);
    await service.disconnected(ctx, device, conn);
    assert.equal(((await service.listDevices(ctx, LIST_ALL)).items)[0]!.online, false);
  });

  it('P2:/sync 以 Mongo 已收過的 seq 去重;端點事件以 event_id 去重(過濾唯一索引)', async () => {
    const device = await service.identify(ctx, DN, 'c'.repeat(40));
    const seq = inventoryRequest().agent_seq;
    const res = await service.sync(ctx, device, {
      pending: [
        { agent_seq: 1, collected_at: '2026-10-01T00:00:00Z', content_hash: 'd'.repeat(64) },
        { agent_seq: seq + 5, collected_at: '2026-10-07T00:00:00Z', content_hash: 'e'.repeat(64) },
      ],
    });
    assert.deepEqual(res.need, [seq + 5]);
    assert.deepEqual(res.skip, [1]);
    assert.equal(res.server_state.last_seq, seq);

    const events = {
      events: [
        { event_id: '3b9d2f5e-7c41-4a8e-9f06-1d2c3b4a5e61', type: 'usb_inserted', occurred_at: '2026-10-06T09:30:12.004Z', data: { drive: 'E:' } },
        { event_id: '9a4c6e1b-2d3f-4b5a-8c7d-0e1f2a3b4c52', type: 'agent_started', occurred_at: '2026-10-06T09:35:00Z', data: {} },
      ],
    };
    assert.equal((await service.ingestEvents(ctx, device, events)).accepted.length, 2);
    await service.ingestEvents(ctx, device, events);
    const pool = await connect(migrateConfig(env, testDb));
    try {
      const r = await pool.request().query(`SELECT event_type, occurred_at, received_at, data FROM ita.device_event WHERE event_uid IS NOT NULL ORDER BY occurred_at`);
      assert.equal(r.recordset.length, 2, '重送不重複');
      assert.equal((r.recordset[0].occurred_at as Date).toISOString(), '2026-10-06T09:30:12.004Z');
      assert.ok(r.recordset[0].received_at instanceof Date);
      assert.equal(JSON.parse(r.recordset[0].data as string).drive, 'E:');
    } finally {
      await pool.close();
    }
  });

  it('P2:hello 記錄時鐘偏差與硬體指紋;另一台同指紋時寫 suspected_duplicate', async () => {
    const device = await service.identify(ctx, DN, 'c'.repeat(40));
    const hw = 'f'.repeat(64);
    const ack = await service.hello(ctx, device, { agent_version: '0.2.0', host_name: 'PC-EXAMPLE-01', agent_time: new Date(Date.now() + 600_000).toISOString(), hw_fingerprint: hw });
    assert.ok(ack.clock_skew_ms! > 590_000);
    const again = await sql.findByDn(DN);
    assert.equal(again!.hwFingerprint, hw);
    assert.ok(again!.clockSkewMs! > 590_000);

    const other = await service.identify(ctx, 'O=GigaNexus Dev,CN=PC-EXAMPLE-NEW', 'd'.repeat(40));
    await service.hello(ctx, other, { agent_version: '0.2.0', host_name: 'PC-EXAMPLE-NEW', hw_fingerprint: hw });
    assert.deepEqual(
      (await sql.findByHwFingerprint(hw, other.id)).map((d) => d.deviceId),
      [device.deviceId],
    );
    const pool = await connect(migrateConfig(env, testDb));
    try {
      const r = await pool.request().query(`SELECT event_type FROM ita.device_event WHERE event_type IN ('clock_skew', 'suspected_duplicate') ORDER BY id`);
      assert.deepEqual(
        r.recordset.map((x) => x.event_type),
        ['clock_skew', 'suspected_duplicate'],
      );
    } finally {
      await pool.close();
    }
  });

  it('P4:指令 SQL(0003):建立、冪等、推送與條件更新、斷線退回、逾期掃描、批次統計', async () => {
    const commands = new CommandDispatcher(new SqlCommandStore(() => sql.connection()), sql, service);
    const who = { sub: '1', emp: 'S000001', name: '測試人員' };
    const device = await service.identify(ctx, DN, 'c'.repeat(40));
    const queued = await commands.create(ctx, who, 'basic', device.deviceId, { kind: 'inventory.collect', idempotencyKey: 'int-1', expiresInSec: 60 });
    assert.equal(queued.state, 'queued');
    assert.equal((await commands.create(ctx, who, 'basic', device.deviceId, { kind: 'inventory.collect', idempotencyKey: 'int-1' })).commandId, queued.commandId);

    const conn = new FakeConnection();
    await service.connected(ctx, device, conn);
    await commands.onHello(ctx, device.id);
    assert.equal(conn.sent.filter((m) => m.type === 'command').length, 1);
    const shown = await commands.create(ctx, who, 'basic', device.deviceId, { kind: 'message.show', params: { text: '整合測試' } });
    assert.equal(shown.state, 'sent');

    assert.deepEqual(await commands.onUpdate(ctx, device.id, { command_id: queued.commandId, state: 'acked' }), { command_id: queued.commandId, accepted: true, state: 'acked' });
    await commands.onUpdate(ctx, device.id, { command_id: queued.commandId, state: 'running', progress: 30 });
    await commands.onUpdate(ctx, device.id, { command_id: queued.commandId, state: 'succeeded', result: { agent_seq: 1, result: 'stored' } });
    assert.equal((await commands.onUpdate(ctx, device.id, { command_id: queued.commandId, state: 'running' }))!.accepted, false, '終態不可再變');
    const done = await commands.get(ctx, queued.commandId);
    assert.deepEqual([done.state, done.progress, done.result, done.createdBy], ['succeeded', 100, { agent_seq: 1, result: 'stored' }, { emp: 'S000001', name: '測試人員' }]);
    assert.ok(done.sentAt && done.ackedAt && done.startedAt && done.finishedAt);

    // 斷線:sent 改回 queued;逾期掃描(以未來時間)設為 expired
    await commands.onDisconnected(ctx, device.id);
    await service.disconnected(ctx, device, conn);
    assert.equal((await commands.get(ctx, shown.commandId)).state, 'queued');
    const later = new CommandDispatcher(new SqlCommandStore(() => sql.connection()), sql, service, { now: () => new Date(Date.now() + 2 * 3600_000) });
    assert.deepEqual(await later.sweep(ctx), { expired: 1, timedOut: 0 });
    assert.equal((await commands.get(ctx, shown.commandId)).state, 'expired');

    const batch = await commands.createBatch(ctx, who, 'basic', [device.deviceId], { kind: 'agent.restart' });
    assert.equal((await commands.getBatch(ctx, batch.batchId)).counts.queued, 1);
    const page = await commands.list(ctx, { deviceId: device.deviceId, limit: 2 });
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor);
    assert.equal((await commands.list(ctx, { deviceId: device.deviceId, cursor: page.nextCursor!, limit: 10 })).items.length, 1);
  });

  it('P4-2:指令附檔(ita.command_file):上傳寫索引、清單、下載、到期清除', async () => {
    const store = new SqlCommandStore(() => sql.connection());
    const commands = new CommandDispatcher(store, sql, service);
    const dir = mkdtempSync(path.join(tmpdir(), 'ita-int-files-'));
    const files = new CommandFileService(store, dir, { keepDays: 14 });
    const who = { sub: '1', emp: 'S000001', name: '測試人員' };
    const device = await service.identify(ctx, 'O=GigaNexus Dev,CN=PC-EXAMPLE-FILES', 'd'.repeat(40));
    const cmd = await commands.create(ctx, who, 'basic', device.deviceId, { kind: 'logs.collect', params: { days: 1 } });
    await commands.onUpdate(ctx, device.id, { command_id: cmd.commandId, state: 'acked' });
    const body = Buffer.from('PK 整合測試');
    const hash = createHash('sha256').update(body).digest('hex');
    const up = await files.upload(ctx, device, cmd.commandId, hash, body.length, Readable.from([body]));
    const again = await files.upload(ctx, device, cmd.commandId, hash, body.length, Readable.from([body]));
    assert.equal(again.file_id, up.file_id);
    // 沒收到 running 就完成:started_at 補上(本例未經 WebSocket 推送、沒有 acked_at,以完成時間補)
    await commands.onUpdate(ctx, device.id, { command_id: cmd.commandId, state: 'succeeded', result: { file_id: up.file_id } });
    const finished = await commands.get(ctx, cmd.commandId);
    assert.ok(finished.startedAt && finished.startedAt <= finished.finishedAt!);
    const list = await files.forCommand(ctx, cmd.commandId);
    assert.deepEqual(
      list.map((f) => [f.fileId, f.sizeBytes, f.sha256, f.expired]),
      [[up.file_id, body.length, hash, false]],
    );
    const { stream } = await files.open(ctx, cmd.commandId, up.file_id);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    assert.deepEqual(Buffer.concat(chunks), body);
    // 以未來時間清除:檔案與索引列刪除,指令紀錄保留
    const later = new CommandFileService(store, dir, { keepDays: 14, now: () => new Date(Date.now() + 15 * 86400_000) });
    assert.ok((await later.sweep(ctx)) >= 1);
    assert.equal(await store.getFile(up.file_id), null);
    assert.equal((await commands.get(ctx, cmd.commandId)).kind, 'logs.collect');
  });

  it('P3(0004):軟體表與回填、清單篩選、事件、狀態、合併(交易搬資料、釋放 DN)', async () => {
    const all = (patch: object = {}) => service.listDevices(ctx, { ...LIST_ALL, pageSize: 200, ...patch });
    const names = async (patch: object) => (await all(patch)).items.map((d) => d.computerName);
    const target = (await sql.findByDn(DN))!;
    assert.deepEqual(await names({ software: 'office suite' }), ['PC-EXAMPLE-01']);
    assert.deepEqual(await names({ software: '%' }), [], 'LIKE 萬用字元已跳脫');
    assert.deepEqual(await names({ q: '198.51.100' }), ['PC-EXAMPLE-01']);
    assert.deepEqual(await names({ q: '00-00-5E-00-53-01' }), ['PC-EXAMPLE-01']);
    assert.deepEqual(await names({ os: '24H2' }), ['PC-EXAMPLE-01']);
    assert.ok((await all()).items.find((d) => d.computerName === 'PC-EXAMPLE-01')!.suspectedDuplicate);

    // 回填:清掉軟體列後由 payload 補回
    const pool = await connect(migrateConfig(env, testDb));
    try {
      await pool.request().input('id', target.id).query('DELETE FROM ita.device_software WHERE device_ref = @id');
      assert.deepEqual(await names({ software: 'office suite' }), []);
      assert.ok((await service.backfillSoftware(ctx)) >= 1);
      assert.deepEqual(await names({ software: 'office suite' }), ['PC-EXAMPLE-01']);

      const ev = await service.listEvents(ctx, target.deviceId, undefined, 2);
      assert.equal(ev.items.length, 2);
      assert.ok(ev.items[0]!.id > ev.items[1]!.id, '新到舊');
      assert.ok(ev.nextCursor);

      const actor = { emp: 'S000001', name: '測試人員' };
      const files = (await sql.findByDn('O=GigaNexus Dev,CN=PC-EXAMPLE-FILES'))!;
      await service.setStatus(ctx, actor, files.deviceId, 'retired', '整合測試');
      assert.deepEqual(await names({ q: 'FILES' }), []);
      assert.ok((await all({ statuses: ['retired'], q: 'FILES' })).items[0]!.retiredAt);
      await service.setStatus(ctx, actor, files.deviceId, 'active', '');
      assert.equal((await all({ q: 'FILES' })).items[0]!.retiredAt, null);

      // 1. 同指紋、來源沒有資產:保留目標的資產;來源的 DN 釋放後對到目標
      const newDn = 'O=GigaNexus Dev,CN=PC-EXAMPLE-NEW';
      const src = (await sql.findByDn(newDn))!;
      const m1 = await service.merge(ctx, actor, target.deviceId, src.deviceId, '重灌', false);
      assert.equal(m1.inventoryFrom, 'target');
      assert.ok(m1.canceledCommands >= 1, 'P4 測試留下排隊中的 agent.restart');
      const canceled = await pool.request().input('id', target.id).query(`SELECT COUNT(*) AS n FROM ita.command WHERE device_ref = @id AND state IN ('queued', 'sent', 'acked', 'running')`);
      assert.equal(canceled.recordset[0].n, 0, '合併後沒有未完成的指令');
      assert.ok(m1.events >= 2, '來源的 registered、suspected_duplicate');
      assert.equal((await sql.findByDn(newDn))!.deviceId, target.deviceId);
      const merged = await service.getDevice(ctx, src.deviceId);
      assert.deepEqual([merged.status, merged.mergedInto, merged.certDn], ['retired', target.deviceId, `merged:${src.deviceId}`]);
      assert.equal((await service.merge(ctx, actor, target.deviceId, src.deviceId, '', true)).alreadyMerged, true);

      // 2. 指紋不同(force)、來源資產較新:目標換成來源的資產、網卡與軟體;指令搬過去
      const later = inventoryRequest({ agent_seq: 99, collected_at: '2026-10-20T00:00:00Z', content_hash: '9'.repeat(64) });
      later.inventory = structuredClone(later.inventory);
      later.inventory.software = [{ name: 'Int Test Tool', version: '1', publisher: 'X', install_date: '2026-10-20' }];
      later.inventory.network = [{ ...later.inventory.network[0]!, ips: ['203.0.113.99'] }];
      const filesDev = (await sql.findByDn('O=GigaNexus Dev,CN=PC-EXAMPLE-FILES'))!;
      await service.ingestInventory(ctx, filesDev, later);
      await assert.rejects(service.merge(ctx, actor, target.deviceId, filesDev.deviceId, '', false), { code: 'ITA_MERGE_INVALID' });
      const m2 = await service.merge(ctx, actor, target.deviceId, filesDev.deviceId, '', true);
      assert.equal(m2.inventoryFrom, 'source');
      assert.equal(m2.commands, 1, 'logs.collect 指令');
      const after = await service.getDevice(ctx, target.deviceId);
      assert.deepEqual(after.ips, ['203.0.113.99']);
      assert.equal(after.collectedAt, '2026-10-20T00:00:00.000Z');
      assert.deepEqual(await names({ software: 'int test tool' }), [after.computerName]);
      assert.deepEqual(await names({ software: 'office suite' }), [], '舊資產的軟體列已刪除');
      const r = await pool
        .request()
        .input('id', target.id)
        .query(`SELECT COUNT(*) AS n FROM ita.device_event WHERE device_ref = @id AND event_type = 'merged'`);
      assert.equal(r.recordset[0].n, 2);
    } finally {
      await pool.close();
    }
  });

  it('E6(0005):所屬公司登錄 / 自動判定 / 指定、清單與指令的 IN 參數、未指定篩選、回填、合併繼承', async () => {
    const domains = parseCompanyDomains('甲公司=a.example;乙公司=b.example');
    const svc = new DeviceService(sql, mongo, redis, { heartbeatIntervalSec: 30, companyDomains: domains });
    const store = new SqlCommandStore(() => sql.connection());
    const commands = new CommandDispatcher(store, sql, svc);
    const who = { sub: '1', emp: 'S000001', name: '測試人員' };
    const actor = { emp: 'S000001', name: '測試人員' };
    const scoped = (...companies: string[]) => ({ log, requestId: 'int-e6', scope: { all: false as const, companies } });
    const names = async (c: ReturnType<typeof scoped> | typeof ctx, patch: object = {}) =>
      (await svc.listDevices(c, { ...LIST_ALL, pageSize: 200, ...patch })).items.map((d) => d.computerName).sort();

    // 登錄:憑證 FQDN → cert;回報網域 → domain;判不出 → 未指定
    const a = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-E6-A.a.example', 'e'.repeat(40));
    assert.deepEqual([a.company, a.companySource], ['甲公司', 'cert']);
    const b = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-E6-B', 'f'.repeat(40));
    const invB = inventoryRequest({ content_hash: 'b'.repeat(64), agent_seq: 1 });
    invB.inventory = structuredClone(invB.inventory);
    invB.inventory.system.host_name = 'PC-E6-B';
    invB.inventory.system.domain = 'B.Example';
    await svc.ingestInventory(ctx, b, invB);
    const bRow = (await sql.findByDn(b.certDn))!;
    assert.deepEqual([bRow.company, bRow.companySource], ['乙公司', 'domain']);
    const u = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-E6-U', '0'.repeat(40));

    // 清單:IN 0 / 1 / 多家、指定公司、未指定(IS NULL)
    assert.deepEqual(await names(scoped(), { q: 'PC-E6' }), []);
    assert.deepEqual(await names(scoped('甲公司'), { q: 'PC-E6' }), ['PC-E6-A.a.example']);
    assert.deepEqual(await names(scoped('甲公司', '乙公司'), { q: 'PC-E6' }), ['PC-E6-A.a.example', 'PC-E6-B']);
    assert.deepEqual(await names(ctx, { q: 'PC-E6', company: null }), ['PC-E6-U']);
    assert.deepEqual(await names(ctx, { q: 'PC-E6', company: '乙公司' }), ['PC-E6-B']);
    await assert.rejects(svc.getDevice(scoped('甲公司'), b.deviceId), { code: 'ITA_DEVICE_NOT_FOUND' });

    // 指令:清單 IN、批次公司
    const cmdA = await commands.create(ctx, who, 'basic', a.deviceId, { kind: 'inventory.collect' });
    const batch = await commands.createBatch(ctx, who, 'basic', [a.deviceId, b.deviceId], { kind: 'inventory.collect' });
    const listA = await commands.list(scoped('甲公司'), { limit: 100 });
    assert.ok(listA.items.some((c) => c.commandId === cmdA.commandId));
    assert.ok(listA.items.every((c) => c.deviceId === a.deviceId));
    await assert.rejects(commands.getBatch(scoped('甲公司'), batch.batchId), { code: 'ITA_BATCH_NOT_FOUND' });
    assert.equal((await commands.getBatch(scoped('甲公司', '乙公司'), batch.batchId)).targetCount, 2);
    assert.equal((await commands.get(scoped('甲公司'), cmdA.commandId)).deviceId, a.deviceId);

    // IT 指定(manual,寫事件)→ 回報網域不再改;null 改回自動
    assert.equal((await svc.setCompany(ctx, actor, u.deviceId, '乙公司', '整合測試')).companySource, 'manual');
    assert.deepEqual(await names(scoped('乙公司'), { q: 'PC-E6' }), ['PC-E6-B', 'PC-E6-U']);
    const ev = await svc.listEvents(ctx, u.deviceId, undefined, 10);
    assert.ok(ev.items.some((e) => e.type === 'company_changed' && /乙公司/.test(e.detail ?? '')));
    assert.equal(await sql.setCompany(u.id, { company: '甲公司', source: 'domain', mode: 'auto', detail: '', requestId: 't', by: 'agent' }), false, 'manual 不被自動判定覆寫');
    const reset = await svc.setCompany(ctx, actor, b.deviceId, null, '');
    assert.deepEqual([reset.company, reset.companySource], ['乙公司', 'domain']);

    // 回填:清掉後依 DN / 回報網域補回;判不出的維持未指定
    const pool = await connect(migrateConfig(env, testDb));
    try {
      await pool.request().query(`UPDATE ita.device SET company = NULL, company_source = NULL WHERE computer_name LIKE N'PC-E6-%' AND company_source <> 'manual'`);
      assert.ok((await svc.backfillCompany(ctx)) >= 2);
      assert.deepEqual([(await sql.findByDn(a.certDn))!.company, (await sql.findByDn(b.certDn))!.company], ['甲公司', '乙公司']);
      assert.equal((await sql.findByDn(u.certDn))!.company, '乙公司', 'manual 不受回填影響');

      // 合併:目標未指定時取來源的公司
      const t = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-E6-T', '7'.repeat(40));
      const s = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-E6-S.a.example', '8'.repeat(40));
      await svc.merge(ctx, actor, t.deviceId, s.deviceId, '', true);
      const merged = (await sql.findByDn(s.certDn))!;
      assert.deepEqual([merged.deviceId, merged.company, merged.companySource], [t.deviceId, '甲公司', 'cert']);
      const chk = await pool.request().query(`SELECT COUNT(*) AS n FROM sys.check_constraints WHERE name = 'ck_device_company_source'`);
      assert.equal(chk.recordset[0].n, 1);
    } finally {
      await pool.close();
    }
  });
});
