/**
 * Redis 7:在線狀態與 content_hash 快取(INTEGRATION-PLAN §3.1)。key 一律帶前綴 ita:{env}:(AGENT.md §7.2)。
 *   ita:{env}:online:{deviceId}  在線資訊 JSON,TTL = 3 個心跳間隔,由心跳續期;過期即離線
 *   ita:{env}:hash:{deviceId}    目前資料的 content_hash(7 天,過期就回 SQL 比對)
 * 不排隊等待重連(enableOfflineQueue: false):Redis 斷線時指令立即失敗,service 退回本機連線表與 SQL。
 */
import { Redis } from 'ioredis';
import type { OnlineInfo, StateStore } from './types.js';

const HASH_TTL_SEC = 7 * 86400;

export class RedisStateStore implements StateStore {
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly prefix: string,
  ) {
    this.redis = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: false });
    // 斷線重連由 ioredis 處理;錯誤由各指令回報給 service,這裡只避免未處理的 error 事件
    this.redis.on('error', () => undefined);
  }

  private key(kind: 'online' | 'hash', deviceId: string): string {
    return `${this.prefix}${kind}:${deviceId}`;
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async setOnline(deviceId: string, info: OnlineInfo, ttlSec: number): Promise<void> {
    await this.redis.set(this.key('online', deviceId), JSON.stringify(info), 'EX', ttlSec);
  }

  async clearOnline(deviceId: string): Promise<void> {
    await this.redis.del(this.key('online', deviceId));
  }

  async onlineOf(deviceIds: string[]): Promise<Map<string, OnlineInfo>> {
    const map = new Map<string, OnlineInfo>();
    if (deviceIds.length === 0) return map;
    const values = await this.redis.mget(deviceIds.map((id) => this.key('online', id)));
    values.forEach((v, i) => {
      if (v) map.set(deviceIds[i]!, JSON.parse(v) as OnlineInfo);
    });
    return map;
  }

  async getHash(deviceId: string): Promise<string | null> {
    return this.redis.get(this.key('hash', deviceId));
  }

  async setHash(deviceId: string, hash: string): Promise<void> {
    await this.redis.set(this.key('hash', deviceId), hash, 'EX', HASH_TTL_SEC);
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
