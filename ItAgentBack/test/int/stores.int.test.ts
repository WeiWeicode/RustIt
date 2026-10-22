/**
 * 整合測試(npm run test:int,讀 .env):真實的 SQL Server 2012(ITA_TEST_DB_NAME = giganexus_It_Agent_poc_test)、
 * 本機 compose 的 MongoDB / Redis。每次執行先清空並重建 schema ita(resetSchema 只允許 *_poc_test),
 * Mongo 用獨立資料庫 ita_int_test、Redis 用前綴 ita:int_test:,不碰開發資料。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import { SqlMonitorStore } from '../../src/stores/sql-monitor-store.js';
import { SqlReleaseStore } from '../../src/stores/sql-release-store.js';
import { SqlSoftwareStore } from '../../src/stores/sql-software-store.js';
import { displayNameLike, installSnapshot } from '../../src/services/software-service.js';
import { AlertService } from '../../src/services/alert-service.js';
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

  it('P5(0006):健康落盤與讀取、憑證到期日、資產變更事件(同一交易)、告警開 / 更新 / 自動關閉 / 手動關閉、清單 IN、停用時關閉', async () => {
    const monitor = new SqlMonitorStore(() => sql.connection());
    let alerts: AlertService | undefined;
    const svc = new DeviceService(sql, mongo, redis, {
      heartbeatIntervalSec: 30,
      monitor,
      onHostEvents: (c, ref, events) => alerts!.onHostEvents(c, ref, events),
    });
    alerts = new AlertService(monitor, (id) => svc.lookup(id));
    const d = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-P5', '9'.repeat(40));
    await svc.connected(ctx, d, new FakeConnection());

    // 健康:第一則落盤;超出範圍的值不讓整筆失敗
    await svc.heartbeat(ctx, d, { health: { cpu_pct: 12, mem_used_pct: 63, disk_min_free_pct: 4, disk_min_free_drive: 'C:', uptime_s: 100, agent_rss_mb: 14 } });
    await monitor.saveCertNotAfter(d.id, new Date('2026-11-01T00:00:00Z'));
    const h = (await monitor.healthOf([d.id])).get(d.id)!;
    assert.deepEqual([h.cpuPct, h.memUsedPct, h.diskMinFreePct, h.diskMinFreeDrive, h.uptimeS, h.agentRssMb], [12, 63, 4, 'C:', 100, 14]);
    assert.equal(h.certNotAfter?.toISOString(), '2026-11-01T00:00:00.000Z');
    await monitor.saveHealth(d.id, new Date(), { cpuPct: 250, memUsedPct: -3, diskMinFreePct: 4 });
    // P5-2:Watchdog 回報欄位(長字串截斷,不影響健康欄位)
    await monitor.saveWatchdog(d.id, { version: '0.1.0', reportAt: new Date(), agentServiceState: 'running', agentStartType: 'auto', agentStatusOk: true, agentLastError: 'x'.repeat(400), agentRestarts24h: 2 });
    const w = (await monitor.healthOf([d.id])).get(d.id)!;
    assert.deepEqual([w.watchdogVersion, w.agentServiceState, w.agentStartType, w.agentStatusOk, w.agentLastError?.length, w.agentRestarts24h, w.diskMinFreePct], ['0.1.0', 'running', 'auto', true, 300, 2, 4]);
    assert.equal((await monitor.healthOf([d.id])).get(d.id)!.cpuPct, 100);

    // 資產變更:第二份移除一個軟體、換 BIOS 序號 → 兩筆主機事件 + 硬體告警
    const inv1 = inventoryRequest({ content_hash: '1'.repeat(64), agent_seq: 1, collected_at: '2026-10-19T00:00:00Z' });
    assert.equal((await svc.ingestInventory(ctx, d, inv1)).result, 'stored');
    const inv2 = inventoryRequest({ content_hash: '2'.repeat(64), agent_seq: 2, collected_at: '2026-10-19T01:00:00Z' });
    inv2.inventory = structuredClone(inv2.inventory);
    inv2.inventory.software.shift();
    inv2.inventory.identity.bios_serial = 'P5-NEW-SN';
    assert.equal((await svc.ingestInventory(ctx, d, inv2)).result, 'stored');
    const ev = await svc.listEvents(ctx, d.deviceId, undefined, 20);
    assert.ok(ev.items.some((e) => e.type === 'software_removed'));
    assert.ok(ev.items.some((e) => e.type === 'hardware_changed' && (e.data as { component: string }).component === 'bios'));

    // 掃描:磁碟 4%、憑證 30 天內 → 開;再掃一次只更新;hardware_changed 不自動關
    const first = await alerts.sweep(ctx);
    assert.ok(first.opened >= 2);
    assert.equal((await alerts.sweep(ctx)).opened, 0);
    const open = await monitor.listAlerts({ state: 'open', deviceRef: d.id, limit: 50 });
    assert.deepEqual(open.map((a) => a.rule).sort(), ['cert_expiring', 'disk_low', 'hardware_changed']);
    assert.equal(open.find((a) => a.rule === 'disk_low')!.severity, 'critical');
    assert.equal((await monitor.openAlertCounts([d.id])).get(d.id), 3);
    assert.equal((await monitor.listAlerts({ state: 'open', companies: [], limit: 50 })).length, 0, 'IN 空清單不回任何列');

    // 恢復 → 自動關閉;手動關閉硬體告警;停用 → 其餘關閉
    await monitor.saveHealth(d.id, new Date(), { diskMinFreePct: 50 });
    assert.equal(await monitor.resolveAuto(d.id, 'disk_low', new Date(), '條件已恢復'), true);
    const hw = open.find((a) => a.rule === 'hardware_changed')!;
    assert.equal(await monitor.resolveManual(hw.alertId, new Date(), { emp: 'S000001', name: '測試人員' }, '已確認', 'int-p5'), true);
    assert.equal(await monitor.resolveManual(hw.alertId, new Date(), { emp: 'S000001', name: '測試人員' }, '已確認', 'int-p5'), false);
    const hwAfter = (await monitor.getAlert(hw.alertId))!;
    assert.deepEqual([hwAfter.state, hwAfter.resolvedBy, hwAfter.resolvedByEmp, hwAfter.eventRef !== null], ['resolved', 'manual', 'S000001', true]);
    await svc.setStatus(ctx, { emp: 'S000001', name: '測試人員' }, d.deviceId, 'disabled', '整合測試');
    assert.ok((await monitor.resolveInactive(new Date())) >= 1);
    assert.equal((await monitor.openAlertCounts([d.id])).get(d.id), undefined);

    // 非正常重啟的計數(LIKE data)
    const e = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-P5-R', '6'.repeat(40));
    const started = (i: number, exit: string) => ({ event_id: `00000000-0000-4000-8000-0000000005${String(i).padStart(2, '0')}`, type: 'agent_started', occurred_at: new Date().toISOString(), data: { agent_version: '0.5.0', previous_exit: exit } });
    await svc.ingestEvents(ctx, e, { events: [started(1, 'unexpected'), started(2, 'stop'), started(3, 'unexpected')] });
    const t = (await monitor.monitorTargets(new Date(Date.now() - 86_400_000))).find((x) => x.deviceRef === e.id)!;
    assert.equal(t.unexpectedRestarts24h, 2);
  });

  it('P6(0007):版本登錄與重複、狀態條件更新、撤回清除環目標與強制版本、環目標生效時間、裝置環、升級進度 upsert、進行中台數、升級目標列', async () => {
    const rel = new SqlReleaseStore(() => sql.connection());
    const svc = new DeviceService(sql, mongo, redis, { heartbeatIntervalSec: 30 });
    const d = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-P6-01', '7'.repeat(40));
    const actor = { emp: 'S000001', name: '測試人員' };
    const at = new Date('2026-10-21T00:00:00Z');
    // migration 預設:3 環 × 2 元件,裝置預設 all
    assert.equal((await rel.listRings()).length, 6);
    assert.equal(await rel.deviceRing(d.id), 'all');

    const r = await rel.addRelease({
      component: 'agent',
      version: '0.7.1',
      fileName: 'rustit-agent.exe',
      sha256: 'a'.repeat(64),
      sizeBytes: 14,
      signerThumbprints: ['b'.repeat(40), 'c'.repeat(40)],
      notes: '整合測試',
      actor,
      at,
      requestId: 'int-p6',
    });
    assert.deepEqual([r.status, r.signerThumbprints.length, r.createdByEmp], ['draft', 2, 'S000001']);
    await assert.rejects(
      rel.addRelease({
        component: 'agent',
        version: '0.7.1',
        fileName: 'x',
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
        signerThumbprints: ['b'.repeat(40)],
        notes: null,
        actor,
        at,
        requestId: 'int-p6',
      }),
      { code: 'ITA_RELEASE_EXISTS' },
    );
    assert.equal((await rel.findRelease('agent', '0.7.1'))?.releaseId, r.releaseId);
    assert.equal((await rel.listReleases({ component: 'watchdog' })).length, 0);

    // 環目標:版本改變才更新 target_set_at
    await rel.setRingTarget('pilot', 'agent', '0.7.1', actor, at, 'int-p6');
    const later = new Date(at.getTime() + 60_000);
    await rel.setRingTarget('pilot', 'agent', '0.7.1', actor, later, 'int-p6');
    const pilot = (await rel.listRings()).find((x) => x.ring === 'pilot' && x.component === 'agent')!;
    assert.deepEqual([pilot.targetVersion, pilot.targetSetAt?.toISOString(), pilot.updatedAt.toISOString()], ['0.7.1', at.toISOString(), later.toISOString()]);
    await rel.setRingTarget('it', 'agent', '0.7.1', actor, at, 'int-p6');

    // 發佈:只從 draft;重複發佈不更新
    assert.equal((await rel.setReleaseStatus(r.releaseId, ['draft'], 'published', actor, at, 'int-p6')).ok, true);
    assert.equal((await rel.setReleaseStatus(r.releaseId, ['draft'], 'published', actor, at, 'int-p6')).ok, false);
    assert.equal((await rel.getRelease(r.releaseId))?.publishedByEmp, 'S000001');

    // 裝置環與升級進度
    await rel.setDeviceRing(d.id, 'pilot');
    assert.equal(await rel.deviceRing(d.id), 'pilot');
    const patch = {
      targetVersion: '0.7.1',
      fromVersion: '0.7.0',
      state: 'downloading' as const,
      attempts: 0,
      errorCode: null,
      errorMessage: null,
      forcedVersion: '0.7.1',
      forcedByEmp: 'S000001',
      forcedAt: at,
      startedAt: at,
    };
    await rel.saveUpgrade(d.id, 'agent', patch, new Date());
    await rel.saveUpgrade(d.id, 'agent', { ...patch, state: 'installing' }, new Date());
    const ups = await rel.deviceUpgrades(d.id);
    assert.deepEqual([ups.length, ups[0]!.state, ups[0]!.forcedVersion], [1, 'installing', '0.7.1']);
    assert.ok((await rel.activeUpgrades(new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))) >= 1);
    const row = (await rel.upgradeTargets()).find((x) => x.deviceRef === d.id)!;
    assert.deepEqual([row.ring, row.upgrades.length, row.openRules], ['pilot', 1, []]);
    assert.equal((await rel.upgradeTargets([])).length, 0, 'IN 空清單不回任何列');

    // 撤回:清除以此為目標的環(pilot、it)與強制版本(同一交易)
    const revoked = await rel.setReleaseStatus(r.releaseId, ['draft', 'published'], 'revoked', actor, later, 'int-p6');
    assert.deepEqual([revoked.ok, revoked.clearedRings.sort()], [true, ['it', 'pilot']]);
    assert.equal((await rel.listRings()).filter((x) => x.targetVersion === '0.7.1').length, 0);
    assert.equal((await rel.deviceUpgrades(d.id))[0]!.forcedVersion, null);
    assert.equal((await rel.getRelease(r.releaseId))?.status, 'revoked');
  });
  it('P7(0008):套件登錄與重複、狀態條件更新(退回 draft / tested / 同人不可發佈 / CHECK)、撤回取消 queued 安裝、測試結果與指派、已安裝台數、批次核可 / 駁回 / 逾期 / done、全域並行計數', async () => {
    const sw = new SqlSoftwareStore(() => sql.connection());
    const cmds = new SqlCommandStore(() => sql.connection());
    const svc = new DeviceService(sql, mongo, redis, { heartbeatIntervalSec: 30 });
    const d = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-P7-01', '8'.repeat(40));
    const d2 = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-P7-02', '9'.repeat(40));
    const inv = structuredClone(inventoryRequest({ content_hash: '7'.repeat(64) }));
    inv.inventory.software = [{ name: '7-Zip 24.09 (x64_edition)', version: '24.09', publisher: 'Igor Pavlov', install_date: '2026-10-20' }];
    await svc.ingestInventory(ctx, d, inv);
    const creator = { emp: 'S000001', name: '登錄人' };
    const reviewer = { emp: 'S000002', name: '覆核人' };
    const at = new Date('2026-10-21T00:00:00Z');
    const base = {
      name: '7-Zip',
      version: '24.09',
      fileName: '7-Zip/24.09/7z2409-x64.msi',
      sha256: 'a'.repeat(64),
      sizeBytes: 1572864,
      installerType: 'msi' as const,
      installArgs: 'ALLUSERS=1',
      uninstallArgs: null,
      detectType: 'display_name' as const,
      detectValue: '7-Zip%',
      rebootPolicy: 'never' as const,
      licenseLimit: 10,
      notes: '整合測試',
      actor: creator,
      at,
      requestId: 'int-p7',
    };
    const p = await sw.addPackage(base);
    assert.deepEqual([p.status, p.signerThumbprints, p.licenseLimit, p.createdByEmp], ['draft', [], 10, 'S000001']);
    await assert.rejects(sw.addPackage({ ...base, fileName: '7-Zip/24.09/other.msi' }), { code: 'ITA_PACKAGE_EXISTS' });
    await assert.rejects(sw.addPackage({ ...base, version: '24.10' }), { code: 'ITA_PACKAGE_EXISTS' }, '同一檔案');
    assert.equal((await sw.listPackages({ q: 'zip', status: 'draft' })).length, 1);
    assert.equal((await sw.listPackages({ q: '%' })).length, 0, '關鍵字的萬用字元跳脫');

    // 狀態條件更新
    assert.equal(await sw.updatePackage(p.packageId, 'tested', { notes: 'x', argsChanged: false, revertToDraft: false }, creator, at, 'int-p7'), false);
    assert.equal(await sw.updatePackage(p.packageId, 'draft', { installArgs: 'ALLUSERS=1 /norestart', licenseLimit: null, argsChanged: true, revertToDraft: false }, creator, at, 'int-p7'), true);
    assert.equal(await sw.publish(p.packageId, reviewer, at, 'int-p7'), false, 'draft 不能發佈');
    assert.equal(await sw.markTested(p.packageId, ['b'.repeat(40)], ['b'.repeat(40), 'c'.repeat(40)], creator, at, 'int-p7'), true);
    assert.equal(await sw.publish(p.packageId, creator, at, 'int-p7'), false, '登錄人不能發佈');
    assert.equal(await sw.publish(p.packageId, reviewer, at, 'int-p7'), true);
    const pub = (await sw.getPackage(p.packageId))!;
    assert.deepEqual(
      [pub.status, pub.installArgs, pub.licenseLimit, pub.signerThumbprints, pub.observedSigners.length, pub.testedByEmp, pub.publishedByEmp],
      ['published', 'ALLUSERS=1 /norestart', null, ['b'.repeat(40)], 2, 'S000001', 'S000002'],
    );
    // 第二道防線:CHECK 不允許發佈人 = 登錄人
    const pool = await sql.connection();
    await assert.rejects(
      pool.request().input('pid', p.packageId).query(`UPDATE ita.software_package SET published_by_emp = created_by_emp WHERE package_id = @pid`),
      (err: { number?: number }) => err.number === 547,
    );
    // 改安裝參數退回 draft(清除簽章者與覆核)
    assert.equal(await sw.updatePackage(p.packageId, 'published', { installArgs: 'ALLUSERS=2', argsChanged: true, revertToDraft: true }, creator, at, 'int-p7'), true);
    const back = (await sw.getPackage(p.packageId))!;
    assert.deepEqual([back.status, back.signerThumbprints, back.publishedByEmp, back.testedAt, back.updatedByEmp], ['draft', [], null, null, 'S000001']);
    // D2-2:覆核人改參數後,自己不能發佈(程式條件與 CHECK)
    assert.equal(await sw.updatePackage(p.packageId, 'draft', { installArgs: 'ALLUSERS=1', argsChanged: true, revertToDraft: false }, reviewer, at, 'int-p7'), true);
    assert.deepEqual((await sw.getPackage(p.packageId))!.editors, ['S000001', 'S000002'], '退回 draft 後修改人累加');
    assert.equal(await sw.markTested(p.packageId, ['b'.repeat(40)], ['b'.repeat(40)], creator, at, 'int-p7'), true);
    assert.equal(await sw.publish(p.packageId, reviewer, at, 'int-p7'), false, '最後修改參數的人不能發佈');
    await assert.rejects(
      pool.request().input('pid', p.packageId).query(`UPDATE ita.software_package SET published_by_emp = N'S000002' WHERE package_id = @pid`),
      (err: { number?: number }) => err.number === 547,
    );
    assert.equal(await sw.updatePackage(p.packageId, 'tested', { installArgs: 'ALLUSERS=2', argsChanged: true, revertToDraft: true }, creator, at, 'int-p7'), true);

    // 指令參數快照:測試結果、下載授權(只認 sent / acked / running)
    const newCmd = (deviceRef: number, dn: string, params: object, batchRef?: string) => ({
      commandId: randomUUID(),
      deviceRef,
      certDn: dn,
      kind: 'software.install',
      level: 'admin' as const,
      params: JSON.stringify(params),
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: null,
      createdByEmp: 'S000001',
      createdByName: null,
      requestId: batchRef ?? 'int-p7',
      createdAt: new Date(),
    });
    const snap = installSnapshot(back);
    const c1 = newCmd(d.id, d.certDn, snap);
    const c2 = newCmd(d.id, d.certDn, snap);
    await cmds.createCommands(null, [c1, c2]);
    assert.equal((await sw.installResults(p.packageId, 10)).length, 2);
    assert.equal((await sw.installResults(randomUUID(), 10)).length, 0);
    assert.deepEqual(await sw.activeInstallPackages(d.id), []);
    const rec1 = (await cmds.getCommand(c1.commandId))!;
    await cmds.transition(rec1.id, ['queued'], { state: 'sent', at: new Date() });
    assert.deepEqual((await sw.activeInstallPackages(d.id)).map((a) => a.packageId), [p.packageId]);
    assert.equal(await cmds.activeOfKinds(['software.install', 'software.uninstall']), 1);
    assert.equal((await cmds.queuedOfKinds(['software.install'], new Date(), 10)).filter((c) => c.deviceRef === d.id).length, 1);
    // 撤回:同一交易取消尚未送出的安裝(已送出的不動)
    const rv = await sw.revoke(p.packageId, creator, at, 'int-p7');
    assert.deepEqual(rv, { ok: true, canceledCommands: 1 });
    assert.deepEqual([(await cmds.getCommand(c2.commandId))!.state, (await cmds.getCommand(c2.commandId))!.errorCode], ['canceled', 'PACKAGE_REVOKED']);
    assert.equal((await cmds.getCommand(c1.commandId))!.state, 'sent');
    assert.deepEqual(await sw.revoke(p.packageId, creator, at, 'int-p7'), { ok: false, canceledCommands: 0 });
    assert.equal(await sw.deviceRing(d.id), 'all');

    // 已安裝台數(DisplayName LIKE;_ 與 [ 跳脫、% 萬用)
    assert.deepEqual(await sw.installedCounts([displayNameLike('7-Zip%'), displayNameLike('7-Zip 24.09 (x64_edition)'), displayNameLike('7-Zip 24.09 (x64Xedition)')]), [1, 1, 0]);
    assert.deepEqual(await sw.installedCounts([displayNameLike('7-Zip%')], []), [0], '資料範圍 IN 空清單');
    assert.deepEqual(
      (await sw.installedDevices(displayNameLike('7-Zip%'), { onlyRefs: [d.id, d2.id], limit: 10 })).map((x) => x.deviceId),
      [d.deviceId],
    );
    assert.deepEqual(await sw.installedDevices(displayNameLike('7-Zip%'), { onlyRefs: [], limit: 10 }), []);

    // 批次核可(B1):pending_approval 不在待送清單;同人不可核可;核可後延長有效期限;駁回、逾期取消 queued;全部結束 → done
    const newBatch = (createdAt: Date) => ({
      batchId: randomUUID(),
      kind: 'software.uninstall',
      level: 'admin' as const,
      params: '{}',
      maxConcurrent: 20,
      requiresApproval: true,
      idempotencyKey: null,
      createdByEmp: 'S000001',
      createdByName: null,
      requestId: 'int-p7',
      createdAt,
    });
    const un = (deviceRef: number, dn: string) => ({ ...newCmd(deviceRef, dn, { package_id: p.packageId }), kind: 'software.uninstall' });
    const b1 = newBatch(new Date());
    await cmds.createCommands(b1, [un(d.id, d.certDn), un(d2.id, d2.certDn)]);
    const g1 = (await cmds.getBatch(b1.batchId))!;
    assert.deepEqual([g1.state, g1.requiresApproval, g1.counts], ['pending_approval', true, { queued: 2 }]);
    const pending = await cmds.queuedForBatch(g1.id, new Date(), 10);
    assert.deepEqual([pending.length, pending[0]!.batchState], [2, 'pending_approval']);
    assert.equal((await cmds.queuedOfKinds(['software.uninstall'], new Date(), 10)).length, 0, '待核可不送');
    assert.equal(await cmds.approveBatch(g1.id, creator, at, new Date('2030-01-01T00:00:00Z')), false, '建立人不可核可');
    assert.equal(await cmds.approveBatch(g1.id, reviewer, at, new Date('2030-01-01T00:00:00Z')), true);
    assert.equal(await cmds.approveBatch(g1.id, reviewer, at, new Date('2030-01-01T00:00:00Z')), false);
    const ap = (await cmds.getBatch(b1.batchId))!;
    assert.deepEqual([ap.state, ap.approvedByEmp, ap.approvedByName], ['running', 'S000002', '覆核人']);
    const q = await cmds.queuedOfKinds(['software.uninstall'], new Date(), 10);
    assert.deepEqual([q.length, q[0]!.expiresAt.toISOString()], [2, '2030-01-01T00:00:00.000Z']);
    await assert.rejects(
      pool.request().input('id', g1.id).query(`UPDATE ita.command_batch SET approved_by_emp = created_by_emp WHERE id = @id`),
      (err: { number?: number }) => err.number === 547,
    );
    for (const c of q) await cmds.transition(c.id, ['queued'], { state: 'succeeded', at: new Date() });
    await cmds.finishBatchIfDone(g1.id);
    assert.equal((await cmds.getBatch(b1.batchId))!.state, 'done');

    const b2 = newBatch(new Date());
    await cmds.createCommands(b2, [un(d.id, d.certDn)]);
    const g2 = (await cmds.getBatch(b2.batchId))!;
    assert.equal(await cmds.rejectBatch(g2.id, creator, at, '目標有誤'), true);
    assert.equal(await cmds.rejectBatch(g2.id, creator, at, '再一次'), false);
    const rj = (await cmds.getBatch(b2.batchId))!;
    assert.deepEqual([rj.state, rj.rejectedByEmp, rj.rejectReason, rj.counts], ['rejected', 'S000001', '目標有誤', { canceled: 1 }]);

    const b3 = newBatch(new Date(Date.now() - 25 * 3_600_000));
    await cmds.createCommands(b3, [un(d2.id, d2.certDn)]);
    assert.equal(await cmds.expirePendingBatches(new Date(Date.now() - 24 * 3_600_000), new Date()), 1);
    const ex = (await cmds.getBatch(b3.batchId))!;
    assert.deepEqual([ex.state, ex.counts], ['expired', { canceled: 1 }]);
    assert.equal(await cmds.expirePendingBatches(new Date(Date.now() - 24 * 3_600_000), new Date()), 0);

    // 批次清單(P7-5):新到舊、可依狀態與建立時間篩、游標分頁、含各狀態台數
    const b4 = newBatch(new Date());
    await cmds.createCommands(b4, [un(d.id, d.certDn), un(d2.id, d2.certDn)]);
    const pend = await cmds.listBatches({ state: 'pending_approval', createdAfter: new Date(Date.now() - 24 * 3_600_000), limit: 10 });
    assert.deepEqual(
      pend.map((x) => [x.batchId, x.counts]),
      [[b4.batchId, { queued: 2 }]],
    );
    // 只看本測試建立的批次(前面的 P4 測試也建立了批次)
    const mine = new Set<string>([b1.batchId, b2.batchId, b3.batchId, b4.batchId]);
    const all = (await cmds.listBatches({ limit: 50 })).filter((x) => mine.has(x.batchId));
    assert.deepEqual(
      all.map((x) => [x.batchId, x.state]),
      [
        [b4.batchId, 'pending_approval'],
        [b3.batchId, 'expired'],
        [g2.batchId, 'rejected'],
        [g1.batchId, 'done'],
      ],
    );
    assert.deepEqual(all[2]!.counts, { canceled: 1 });
    assert.deepEqual((await cmds.listBatches({ beforeId: all[1]!.id, limit: 1 })).map((x) => x.batchId), [g2.batchId]);
  });

  it('P7 收尾:撤回記錄原狀態、整批取消回傳裝置、批次收尾掃描、D2-1 累計台數、reboot_required 起算時間', async () => {
    const sw = new SqlSoftwareStore(() => sql.connection());
    const cmds = new SqlCommandStore(() => sql.connection());
    const monitor = new SqlMonitorStore(() => sql.connection());
    const svc = new DeviceService(sql, mongo, redis, { heartbeatIntervalSec: 30 });
    const d = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-P7F-01', 'd'.repeat(40));
    const d2 = await svc.identify(ctx, 'O=GigaNexus Dev,CN=PC-P7F-02', 'e'.repeat(40));
    await svc.ingestInventory(ctx, d, structuredClone(inventoryRequest({ content_hash: '6'.repeat(64) })));
    const pool = await sql.connection();
    const creator = { emp: 'S000011', name: '登錄人' };
    const reviewer = { emp: 'S000012', name: '覆核人' };
    const at = new Date();
    const pkgInput = (name: string) => ({
      name,
      version: '1.0',
      fileName: `${name}/1.0/setup.msi`,
      sha256: 'f'.repeat(64),
      sizeBytes: 1024,
      installerType: 'msi' as const,
      installArgs: null,
      uninstallArgs: null,
      detectType: 'display_name' as const,
      detectValue: `${name}%`,
      rebootPolicy: 'never' as const,
      licenseLimit: null,
      notes: null,
      actor: creator,
      at,
      requestId: 'int-p7f',
    });
    // revoked_from:撤回時記下原狀態
    const draft = await sw.addPackage(pkgInput('ToolA'));
    assert.equal((await sw.revoke(draft.packageId, creator, at, 'int-p7f')).ok, true);
    const rv = (await sw.getPackage(draft.packageId))!;
    assert.deepEqual([rv.status, rv.revokedFrom], ['revoked', 'draft']);
    const p = await sw.addPackage(pkgInput('ToolB'));

    const newCmd = (deviceRef: number, dn: string, kind = 'software.install', emp = creator.emp) => ({
      commandId: randomUUID(),
      deviceRef,
      certDn: dn,
      kind,
      level: 'admin' as const,
      params: JSON.stringify(installSnapshot(p)),
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: null,
      createdByEmp: emp,
      createdByName: null,
      requestId: 'int-p7f',
      createdAt: new Date(),
    });
    const newBatch = (requiresApproval: boolean, createdAt = new Date(), emp = creator.emp) => ({
      batchId: randomUUID(),
      kind: 'software.install',
      level: 'admin' as const,
      params: '{}',
      maxConcurrent: 20,
      requiresApproval,
      idempotencyKey: null,
      createdByEmp: emp,
      createdByName: null,
      requestId: 'int-p7f',
      createdAt,
    });

    // 整批取消(檔案被換掉,M1):回傳被取消指令的裝置;已送出的不動;批次由收尾掃描結束
    const b = newBatch(false);
    const q1 = newCmd(d.id, d.certDn);
    const q2 = newCmd(d2.id, d2.certDn);
    await cmds.createCommands(b, [q1, q2]);
    assert.equal((await cmds.getBatch(b.batchId))!.state, 'running');
    const sent = (await cmds.getCommand(q1.commandId))!;
    await cmds.transition(sent.id, ['queued'], { state: 'sent', at: new Date() });
    assert.deepEqual(await sw.cancelQueuedInstalls(p.packageId, 'PACKAGE_FILE_CHANGED', new Date()), [d2.id]);
    const c2 = (await cmds.getCommand(q2.commandId))!;
    assert.deepEqual([c2.state, c2.errorCode], ['canceled', 'PACKAGE_FILE_CHANGED']);
    // 前面測試留下的批次也可能被收尾,只看本測試的批次
    const lookback = new Date(Date.now() - 8 * 86_400_000);
    await cmds.finishIdleBatches(lookback);
    assert.equal((await cmds.getBatch(b.batchId))!.state, 'running', '還有已送出的指令');
    await cmds.transition(sent.id, ['sent'], { state: 'succeeded', at: new Date(), resultSummary: JSON.stringify({ exit_code: 3010, reboot_required: true }) });
    assert.ok((await cmds.finishIdleBatches(lookback)) >= 1);
    assert.equal((await cmds.getBatch(b.batchId))!.state, 'done');
    // 待核可的批次不收尾(核可 / 駁回 / 逾期另有流程);超過回溯期間的批次不掃
    const pend = newBatch(true);
    const pc = newCmd(d.id, d.certDn);
    await cmds.createCommands(pend, [pc]);
    await cmds.transition((await cmds.getCommand(pc.commandId))!.id, ['queued'], { state: 'canceled', at: new Date() });
    const old = newBatch(false, new Date(Date.now() - 10 * 86_400_000));
    await cmds.createCommands(old, [{ ...newCmd(d2.id, d2.certDn), createdAt: old.createdAt }]);
    await pool
      .request()
      .input('bid', old.batchId)
      .query(`UPDATE ita.command SET state = 'canceled' WHERE batch_ref = (SELECT id FROM ita.command_batch WHERE batch_id = @bid)`);
    await cmds.finishIdleBatches(lookback);
    assert.deepEqual([(await cmds.getBatch(pend.batchId))!.state, (await cmds.getBatch(old.batchId))!.state], ['pending_approval', 'running']);

    // D2-1:此人 24 小時內涉及的電腦台數;待核可 / 已核可批次不計,未核可的 running / done 批次與單台照計(取消的單台也計)
    const since = new Date(Date.now() - 86_400_000);
    const kinds = ['software.install', 'software.uninstall'];
    assert.equal(await cmds.recentGatedTargets(creator.emp, kinds, since), 2, '未核可的 done 批次含 d、d2;待核可與 10 天前的不計');
    const single = newCmd(d.id, d.certDn, 'software.uninstall', 'S000013');
    await cmds.createCommands(null, [single]);
    await cmds.transition((await cmds.getCommand(single.commandId))!.id, ['queued'], { state: 'canceled', at: new Date() });
    assert.equal(await cmds.recentGatedTargets('S000013', kinds, since), 1, '取消的單台照計');
    assert.equal(await cmds.recentGatedTargets('s000013', kinds, since), 1, '工號不分大小寫');
    assert.equal(await cmds.recentGatedTargets('S000013', ['system.reboot'], since), 0, '另一組類型');
    const ap = newBatch(true, new Date(), 'S000014');
    await cmds.createCommands(ap, [newCmd(d.id, d.certDn, 'software.install', 'S000014'), newCmd(d2.id, d2.certDn, 'software.install', 'S000014')]);
    assert.equal(await cmds.recentGatedTargets('S000014', kinds, since), 0, '待核可不計');
    assert.equal(await cmds.approveBatch((await cmds.getBatch(ap.batchId))!.id, reviewer, new Date(), new Date(Date.now() + 86_400_000)), true);
    assert.equal(await cmds.recentGatedTargets('S000014', kinds, since), 0, '已核可不計');

    // reboot_required:開機時間之後成功、結果含 reboot_required 的軟體指令,取最早完成時間;沒有資產(開機時間未知)的不算
    const t = await monitor.monitorTargets(new Date(Date.now() - 86_400_000));
    const rb = t.find((x) => x.deviceRef === d.id)!.rebootRequiredSince;
    assert.ok(rb && Math.abs(rb.getTime() - Date.now()) < 120_000, String(rb));
    assert.equal(t.find((x) => x.deviceRef === d2.id)!.rebootRequiredSince, null);
  });
});
