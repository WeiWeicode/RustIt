/**
 * 整合測試(npm run test:int,讀 .env):真實的 SQL Server 2012(ITA_TEST_DB_NAME = giganexus_It_Agent_poc_test)、
 * 本機 compose 的 MongoDB / Redis。每次執行先清空並重建 schema ita(resetSchema 只允許 *_poc_test),
 * Mongo 用獨立資料庫 ita_int_test、Redis 用前綴 ita:int_test:,不碰開發資料。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { connect, migrate, migrateConfig, resetSchema } from '../../src/db/migrator.js';
import { DeviceService } from '../../src/services/device-service.js';
import { MongoSnapshotStore } from '../../src/stores/mongo-store.js';
import { RedisStateStore } from '../../src/stores/redis-store.js';
import { SqlDeviceStore } from '../../src/stores/sql-store.js';
import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { DN, FP, inventoryRequest } from '../helpers.js';

const env = process.env;
const testDb = env.ITA_TEST_DB_NAME ?? '';
if (!testDb.endsWith('_poc_test')) throw new Error(`ITA_TEST_DB_NAME 必須是整合測試庫(*_poc_test):${testDb}`);

const MONGO_DB = 'ita_int_test';
const REDIS_PREFIX = 'ita:int_test:';
const log = Fastify({ logger: { level: 'silent' } }).log;
const ctx = { log, requestId: 'int-test' };

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

    const [row] = await service.listDevices(ctx);
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
    const list = await service.listDevices(ctx);
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
    const conn = { close() {}, terminate() {} };
    await service.connected(ctx, device, conn);
    await service.heartbeat(ctx, device, { outbox_pending: 0 });
    assert.equal((await service.listDevices(ctx))[0]!.online, true);
    await service.disconnected(ctx, device, conn);
    assert.equal((await service.listDevices(ctx))[0]!.online, false);
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
});
