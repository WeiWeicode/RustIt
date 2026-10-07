/**
 * MongoDB 7:快照歷史與心跳記錄(INTEGRATION-PLAN §3.1)。可清空重建、不放只存在這裡的資料;失敗由 service 記 warn 後略過。
 * 資料庫名稱依部署區分開(ita_dev / ita_test / ita_prod);保留期限以 TTL 索引控制。
 *   snapshots   每份被接受的快照(含補傳的較舊快照);(device_id, agent_seq, content_hash) 唯一,重複補傳不產生重複資料
 *   heartbeats  心跳(保留 1 天)
 */
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { InventorySnapshot, SnapshotStore } from './types.js';

interface SnapshotDoc {
  device_id: string;
  agent_seq: number;
  content_hash: string;
  agent_version: string;
  collected_at: Date;
  received_at: Date;
  inventory: unknown;
}

interface HeartbeatDoc {
  device_id: string;
  at: Date;
  body: Record<string, unknown>;
}

export class MongoSnapshotStore implements SnapshotStore {
  private client!: MongoClient;
  private snapshots!: Collection<SnapshotDoc>;
  private heartbeats!: Collection<HeartbeatDoc>;
  private db!: Db;
  private indexesReady = false;

  constructor(
    private readonly url: string,
    private readonly dbName: string,
    private readonly retentionDays: number,
  ) {
    this.connect();
  }

  /**
   * 建立 client(連線在第一次操作時才建立)。driver 6 第一次連線失敗後 client 會關閉且不再重試(MongoTopologyClosedError),
   * 例如容器同時啟動、Mongo 尚未就緒;遇到時換一個新 client,下一次操作即重新連線。
   */
  private connect(): void {
    // 連不上時 3 秒內失敗,不卡住回報(service 降級)
    this.client = new MongoClient(this.url, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, appName: 'it-agent-back' });
    this.db = this.client.db(this.dbName);
    this.snapshots = this.db.collection<SnapshotDoc>('snapshots');
    this.heartbeats = this.db.collection<HeartbeatDoc>('heartbeats');
  }

  private async run<T>(op: () => Promise<T>): Promise<T> {
    try {
      const result = await op();
      // 啟動時建立索引失敗(Mongo 尚未就緒)者,連上後補建;失敗留待下次
      if (!this.indexesReady) this.ensureIndexes().catch(() => undefined);
      return result;
    } catch (err) {
      if ((err as Error).name === 'MongoTopologyClosedError') {
        const old = this.client;
        this.connect();
        void old.close().catch(() => undefined);
      }
      throw err;
    }
  }

  /** 啟動時建立索引;失敗只影響保留期限與去重,由呼叫端記 warn */
  async ensureIndexes(): Promise<void> {
    await this.snapshots.createIndex({ device_id: 1, agent_seq: 1, content_hash: 1 }, { unique: true, name: 'uq_device_seq_hash' });
    await this.snapshots.createIndex({ device_id: 1, collected_at: -1 }, { name: 'ix_device_collected' });
    await this.snapshots.createIndex({ received_at: 1 }, { expireAfterSeconds: this.retentionDays * 86400, name: 'ttl_received' });
    await this.heartbeats.createIndex({ at: 1 }, { expireAfterSeconds: 86400, name: 'ttl_at' });
    await this.heartbeats.createIndex({ device_id: 1, at: -1 }, { name: 'ix_device_at' });
    this.indexesReady = true;
  }

  async ping(): Promise<void> {
    await this.run(() => this.db.command({ ping: 1 }));
  }

  async insertSnapshot({ deviceId, snapshot: s }: { deviceId: string; snapshot: InventorySnapshot }): Promise<void> {
    try {
      await this.run(() => this.snapshots.insertOne({
        device_id: deviceId,
        agent_seq: s.agentSeq,
        content_hash: s.contentHash,
        agent_version: s.agentVersion,
        collected_at: s.collectedAt,
        received_at: s.receivedAt,
        inventory: s.inventory,
      }));
    } catch (err) {
      // 重複補傳同一份快照:已存在即視為成功
      if ((err as { code?: number }).code === 11000) return;
      throw err;
    }
  }

  async recordHeartbeat({ deviceId, at, body }: { deviceId: string; at: Date; body: Record<string, unknown> }): Promise<void> {
    await this.run(() => this.heartbeats.insertOne({ device_id: deviceId, at, body }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
