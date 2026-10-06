/**
 * SQL Server 2012(giganexus_It_Agent*,schema ita):唯一真相(INTEGRATION-PLAN §3)。結構見 db/migrations/、docs/DB_SCHEMA.md。
 * 連線 encrypt: false(2012 RTM 不支援 TLS 1.2;內網,主管已同意,決策 D8)。時間以 UTC 讀寫(tedious useUTC 預設 true)。
 * 啟動時資料庫連不上不阻擋服務:第一次使用時才連線,失敗由 service 轉成 503,下次呼叫再試。
 */
import sql from 'mssql';
import type { SqlConfig } from '../config.js';
import { primaryIpv4 } from '../contracts.js';
import type { CurrentInventory, DeviceEventType, DeviceRecord, DeviceRow, DeviceStore, InventorySnapshot } from './types.js';

const BY_AGENT = 'agent';

/** 依欄位長度截斷,避免 Agent 回報的異常長字串讓整筆寫入失敗 */
const cut = (s: string | null | undefined, n: number): string | null => (s == null || s === '' ? null : s.length > n ? s.slice(0, n) : s);

const DEVICE_COLS = `d.id, d.device_id, d.cert_dn, d.cert_fp, d.computer_name, d.status, d.agent_version, d.first_seen_at, d.last_seen_at, d.last_inventory_at`;
const SUMMARY_COLS = `${DEVICE_COLS}, i.user_name, i.domain, i.os_name, i.os_version, i.os_display_version, i.os_build, i.manufacturer, i.model, i.cpu_name, i.memory_total`;

type Row = Record<string, unknown>;

function toDevice(r: Row): DeviceRecord {
  return {
    id: Number(r.id),
    deviceId: String(r.device_id).toLowerCase(),
    certDn: String(r.cert_dn),
    certFp: String(r.cert_fp).trim(),
    computerName: String(r.computer_name),
    status: r.status === 'disabled' ? 'disabled' : 'active',
    agentVersion: (r.agent_version as string | null) ?? null,
    firstSeenAt: r.first_seen_at as Date,
    lastSeenAt: r.last_seen_at as Date,
    lastInventoryAt: (r.last_inventory_at as Date | null) ?? null,
  };
}

function toRow(r: Row, ips: string[]): DeviceRow {
  const osVersion = [r.os_display_version, r.os_build].filter(Boolean).join(' / ') || ((r.os_version as string | null) ?? null);
  return {
    ...toDevice(r),
    userName: (r.user_name as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    osName: (r.os_name as string | null) ?? null,
    osVersion,
    manufacturer: (r.manufacturer as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    cpuName: (r.cpu_name as string | null) ?? null,
    // BIGINT 由 tedious 以字串傳回
    memoryTotal: r.memory_total == null ? null : Number(r.memory_total),
    ips,
  };
}

const isDuplicateKey = (err: unknown) => [2627, 2601].includes((err as { number?: number }).number ?? 0);

export class SqlDeviceStore implements DeviceStore {
  private pool: sql.ConnectionPool;
  private connecting: Promise<sql.ConnectionPool> | null = null;

  constructor(cfg: SqlConfig, appName = 'it-agent-back') {
    this.pool = new sql.ConnectionPool({
      server: cfg.server,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      connectionTimeout: 8000,
      requestTimeout: 15000,
      pool: { max: 10, min: 0, idleTimeoutMillis: 60000 },
      options: { encrypt: false, trustServerCertificate: true, appName },
    });
    // 連線池的背景錯誤不可讓行程崩潰;實際錯誤由各查詢回報
    this.pool.on('error', () => undefined);
  }

  private async ready(): Promise<sql.ConnectionPool> {
    if (this.pool.connected) return this.pool;
    this.connecting ??= this.pool.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async request(): Promise<sql.Request> {
    return (await this.ready()).request();
  }

  async ping(): Promise<void> {
    await (await this.request()).query('SELECT 1 AS ok');
  }

  async findByDn(certDn: string): Promise<DeviceRecord | null> {
    const r = await (await this.request()).input('dn', sql.NVarChar(450), certDn).query(`SELECT ${DEVICE_COLS} FROM ita.device d WHERE d.cert_dn = @dn`);
    const row = r.recordset[0] as Row | undefined;
    return row ? toDevice(row) : null;
  }

  async register(input: { certDn: string; certFp: string; computerName: string; requestId: string; at: Date }): Promise<DeviceRecord> {
    const pool = await this.ready();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const r = await new sql.Request(tx)
        .input('dn', sql.NVarChar(450), input.certDn)
        .input('fp', sql.Char(40), input.certFp)
        .input('name', sql.NVarChar(255), cut(input.computerName, 255))
        .input('at', sql.DateTime2(3), input.at)
        .input('by', sql.NVarChar(64), BY_AGENT)
        .input('rid', sql.VarChar(64), cut(input.requestId, 64)).query(`
          DECLARE @ids TABLE (id INT);
          INSERT INTO ita.device (cert_dn, cert_fp, computer_name, first_seen_at, last_seen_at, created_by, updated_by)
          OUTPUT INSERTED.id INTO @ids
          VALUES (@dn, @fp, @name, @at, @at, @by, @by);
          INSERT INTO ita.device_event (device_ref, event_type, cert_dn, cert_fp, detail, request_id)
          SELECT id, 'registered', @dn, @fp, N'首次連線自動登錄', @rid FROM @ids;
          SELECT ${DEVICE_COLS} FROM ita.device d WHERE d.id = (SELECT id FROM @ids);`);
      await tx.commit();
      return toDevice(r.recordset[0] as Row);
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      // 同一台新裝置的 WebSocket 與回報同時到達:另一個請求已登錄,改讀既有資料
      if (isDuplicateKey(err)) {
        const existing = await this.findByDn(input.certDn);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async updateFingerprint(device: DeviceRecord, certFp: string, requestId: string): Promise<void> {
    await (await this.request())
      .input('id', sql.Int, device.id)
      .input('fp', sql.Char(40), certFp)
      .input('old', sql.NVarChar(1000), `舊指紋 ${device.certFp}`)
      .input('dn', sql.NVarChar(450), device.certDn)
      .input('rid', sql.VarChar(64), cut(requestId, 64)).query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        UPDATE ita.device SET cert_fp = @fp, updated_at = SYSUTCDATETIME(), updated_by = '${BY_AGENT}' WHERE id = @id;
        INSERT INTO ita.device_event (device_ref, event_type, cert_dn, cert_fp, detail, request_id) VALUES (@id, 'fingerprint_changed', @dn, @fp, @old, @rid);
        COMMIT;`);
  }

  async addEvent(device: DeviceRecord | null, type: DeviceEventType, detail: string, requestId: string): Promise<void> {
    await (await this.request())
      .input('id', sql.Int, device?.id ?? null)
      .input('type', sql.VarChar(32), type)
      .input('dn', sql.NVarChar(450), device?.certDn ?? null)
      .input('fp', sql.Char(40), device?.certFp ?? null)
      .input('detail', sql.NVarChar(1000), cut(detail, 1000))
      .input('rid', sql.VarChar(64), cut(requestId, 64))
      .query(`INSERT INTO ita.device_event (device_ref, event_type, cert_dn, cert_fp, detail, request_id) VALUES (@id, @type, @dn, @fp, @detail, @rid)`);
  }

  async touch(deviceRef: number, at: Date, patch: { computerName?: string; agentVersion?: string } = {}): Promise<void> {
    await (await this.request())
      .input('id', sql.Int, deviceRef)
      .input('at', sql.DateTime2(3), at)
      .input('name', sql.NVarChar(255), cut(patch.computerName, 255))
      .input('ver', sql.VarChar(32), cut(patch.agentVersion, 32)).query(`
        UPDATE ita.device
        SET last_seen_at = CASE WHEN last_seen_at < @at THEN @at ELSE last_seen_at END,
            computer_name = COALESCE(@name, computer_name),
            agent_version = COALESCE(@ver, agent_version),
            updated_at = SYSUTCDATETIME(), updated_by = '${BY_AGENT}'
        WHERE id = @id`);
  }

  async currentInventory(deviceRef: number): Promise<CurrentInventory | null> {
    const r = await (await this.request())
      .input('id', sql.Int, deviceRef)
      .query(`SELECT agent_seq, content_hash, collected_at FROM ita.device_inventory WHERE device_ref = @id`);
    const row = r.recordset[0] as Row | undefined;
    return row ? { agentSeq: Number(row.agent_seq), contentHash: String(row.content_hash), collectedAt: row.collected_at as Date } : null;
  }

  async saveInventory(device: DeviceRecord, s: InventorySnapshot): Promise<void> {
    const inv = s.inventory;
    const sys = inv.system;
    const pool = await this.ready();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input('id', sql.Int, device.id)
        .input('seq', sql.BigInt, s.agentSeq)
        .input('hash', sql.Char(64), s.contentHash)
        .input('collected', sql.DateTime2(3), s.collectedAt)
        .input('received', sql.DateTime2(3), s.receivedAt)
        .input('host', sql.NVarChar(255), cut(sys.host_name, 255))
        .input('user', sql.NVarChar(255), cut(sys.user_name, 255))
        .input('domain', sql.NVarChar(255), cut(sys.domain, 255))
        .input('pod', sql.Bit, sys.part_of_domain)
        .input('mfr', sql.NVarChar(255), cut(sys.manufacturer, 255))
        .input('model', sql.NVarChar(255), cut(sys.model, 255))
        .input('os', sql.NVarChar(255), cut(sys.os_name, 255))
        .input('osv', sql.NVarChar(100), cut(sys.os_version, 100))
        .input('osdv', sql.NVarChar(50), cut(sys.os_display_version, 50))
        .input('osb', sql.NVarChar(50), cut(sys.os_build, 50))
        .input('arch', sql.VarChar(32), cut(sys.arch, 32))
        .input('boot', sql.DateTime2(0), sys.boot_time > 0 ? new Date(sys.boot_time * 1000) : null)
        .input('bios', sql.NVarChar(255), cut(inv.identity.bios_serial, 255))
        .input('uuid', sql.NVarChar(64), cut(inv.identity.system_uuid, 64))
        .input('cpu', sql.NVarChar(255), cut(inv.cpu.name, 255))
        .input('cores', sql.Int, inv.cpu.cores)
        .input('logical', sql.Int, inv.cpu.logical)
        .input('mem', sql.BigInt, inv.memory_total)
        .input('ip', sql.VarChar(45), cut(primaryIpv4(inv.network), 45))
        .input('payload', sql.NVarChar(sql.MAX), s.payload)
        .input('ver', sql.VarChar(32), cut(s.agentVersion, 32))
        .input('by', sql.NVarChar(64), BY_AGENT).query(`
          UPDATE ita.device_inventory SET
            agent_seq = @seq, content_hash = @hash, collected_at = @collected, received_at = @received,
            host_name = @host, user_name = @user, domain = @domain, part_of_domain = @pod, manufacturer = @mfr, model = @model,
            os_name = @os, os_version = @osv, os_display_version = @osdv, os_build = @osb, arch = @arch, boot_time = @boot,
            bios_serial = @bios, system_uuid = @uuid, cpu_name = @cpu, cpu_cores = @cores, cpu_logical = @logical, memory_total = @mem,
            primary_ip = @ip, payload = @payload, updated_at = SYSUTCDATETIME(), updated_by = @by
          WHERE device_ref = @id;
          IF @@ROWCOUNT = 0
            INSERT INTO ita.device_inventory (device_ref, agent_seq, content_hash, collected_at, received_at, host_name, user_name, domain, part_of_domain,
              manufacturer, model, os_name, os_version, os_display_version, os_build, arch, boot_time, bios_serial, system_uuid, cpu_name, cpu_cores,
              cpu_logical, memory_total, primary_ip, payload, created_by, updated_by)
            VALUES (@id, @seq, @hash, @collected, @received, @host, @user, @domain, @pod, @mfr, @model, @os, @osv, @osdv, @osb, @arch, @boot, @bios,
              @uuid, @cpu, @cores, @logical, @mem, @ip, @payload, @by, @by);
          DELETE FROM ita.device_nic WHERE device_ref = @id;
          UPDATE ita.device SET
            computer_name = COALESCE(@host, computer_name), agent_version = @ver,
            last_seen_at = CASE WHEN last_seen_at < @received THEN @received ELSE last_seen_at END,
            last_inventory_at = @received, updated_at = SYSUTCDATETIME(), updated_by = @by
          WHERE id = @id;`);

      // 網卡位址:每個 IP 一列,沒有 IP 的網卡一列 NULL;上限 200 列(參數上限 2100)
      const nics = inv.network.flatMap((n, idx) =>
        (n.ips.length ? n.ips : [null]).map((ip) => ({ idx, n, ip })),
      ).slice(0, 200);
      for (let i = 0; i < nics.length; i += 50) {
        const req = new sql.Request(tx).input('id', sql.Int, device.id);
        const values = nics.slice(i, i + 50).map(({ idx, n, ip }, k) => {
          req
            .input(`x${k}`, sql.Int, idx)
            .input(`d${k}`, sql.NVarChar(255), cut(n.description, 255))
            .input(`m${k}`, sql.VarChar(32), cut(n.mac, 32))
            .input(`a${k}`, sql.VarChar(45), cut(ip, 45))
            .input(`v${k}`, sql.Bit, ip?.includes(':') ?? false)
            .input(`g${k}`, sql.Bit, n.gateways.length > 0)
            .input(`h${k}`, sql.Bit, n.dhcp_enabled);
          return `(@id, @x${k}, @d${k}, @m${k}, @a${k}, @v${k}, @g${k}, @h${k})`;
        });
        await req.query(`INSERT INTO ita.device_nic (device_ref, nic_index, description, mac, ip_address, is_ipv6, has_gateway, dhcp_enabled) VALUES ${values.join(', ')}`);
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }

  async markInventoryUnchanged(deviceRef: number, at: Date): Promise<void> {
    await (await this.request()).input('id', sql.Int, deviceRef).input('at', sql.DateTime2(3), at).query(`
      UPDATE ita.device SET last_seen_at = CASE WHEN last_seen_at < @at THEN @at ELSE last_seen_at END, last_inventory_at = @at,
        updated_at = SYSUTCDATETIME(), updated_by = '${BY_AGENT}'
      WHERE id = @id`);
  }

  /** IPv4 依裝置分組:有閘道的網卡優先,其次網卡順序 */
  private async ipv4Of(deviceRef?: number): Promise<Map<number, string[]>> {
    const req = await this.request();
    let where = 'is_ipv6 = 0 AND ip_address IS NOT NULL';
    if (deviceRef !== undefined) {
      req.input('id', sql.Int, deviceRef);
      where += ' AND device_ref = @id';
    }
    const r = await req.query(`SELECT device_ref, ip_address FROM ita.device_nic WHERE ${where} ORDER BY device_ref, has_gateway DESC, nic_index, id`);
    const map = new Map<number, string[]>();
    for (const row of r.recordset as Row[]) {
      const list = map.get(Number(row.device_ref)) ?? [];
      const ip = String(row.ip_address);
      if (!list.includes(ip)) list.push(ip);
      map.set(Number(row.device_ref), list);
    }
    return map;
  }

  async listDevices(): Promise<DeviceRow[]> {
    const r = await (await this.request()).query(
      `SELECT ${SUMMARY_COLS} FROM ita.device d LEFT JOIN ita.device_inventory i ON i.device_ref = d.id ORDER BY d.computer_name, d.id`,
    );
    const ips = await this.ipv4Of();
    return (r.recordset as Row[]).map((row) => toRow(row, ips.get(Number(row.id)) ?? []));
  }

  async getDevice(deviceId: string): Promise<{ row: DeviceRow; payload: string | null; collectedAt: Date | null } | null> {
    const r = await (await this.request())
      .input('did', sql.UniqueIdentifier, deviceId)
      .query(`SELECT ${SUMMARY_COLS}, i.payload, i.collected_at FROM ita.device d LEFT JOIN ita.device_inventory i ON i.device_ref = d.id WHERE d.device_id = @did`);
    const row = r.recordset[0] as Row | undefined;
    if (!row) return null;
    const ips = await this.ipv4Of(Number(row.id));
    return { row: toRow(row, ips.get(Number(row.id)) ?? []), payload: (row.payload as string | null) ?? null, collectedAt: (row.collected_at as Date | null) ?? null };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
