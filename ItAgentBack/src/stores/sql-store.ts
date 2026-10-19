/**
 * SQL Server 2012(giganexus_It_Agent*,schema ita):唯一真相(INTEGRATION-PLAN §3)。結構見 db/migrations/、docs/DB_SCHEMA.md。
 * 連線 encrypt: false(2012 RTM 不支援 TLS 1.2;內網,主管已同意,決策 D8)。時間以 UTC 讀寫(tedious useUTC 預設 true)。
 * 啟動時資料庫連不上不阻擋服務:第一次使用時才連線,失敗由 service 轉成 503,下次呼叫再試。
 */
import sql from 'mssql';
import type { SqlConfig } from '../config.js';
import { primaryIpv4, type ComputerInfo } from '../contracts.js';
import { AppError } from '../errors.js';
import type {
  Actor,
  AgentEvent,
  CurrentInventory,
  DeviceEventRecord,
  DeviceEventType,
  DeviceFilter,
  DeviceRecord,
  DeviceRow,
  DeviceStatus,
  DeviceStore,
  HostEventInput,
  InventorySnapshot,
  BackfillResult,
  CompanyCandidate,
  CompanyChange,
  CompanySource,
  MergeResult,
  SavedHostEvent,
  TouchPatch,
} from './types.js';

const BY_AGENT = 'agent';

/** 依欄位長度截斷,避免 Agent 回報的異常長字串讓整筆寫入失敗 */
const cut = (s: string | null | undefined, n: number): string | null => (s == null || s === '' ? null : s.length > n ? s.slice(0, n) : s);

const DEVICE_COLS = `d.id, d.device_id, d.cert_dn, d.cert_fp, d.computer_name, d.status, d.agent_version, d.first_seen_at, d.last_seen_at, d.last_inventory_at,
  d.hw_fingerprint, d.clock_skew_ms, d.company, d.company_source`;
const SUMMARY_COLS = `${DEVICE_COLS}, i.user_name, i.domain, i.part_of_domain, i.os_name, i.os_version, i.os_display_version, i.os_build, i.manufacturer, i.model, i.cpu_name, i.memory_total,
  d.retired_at, m.device_id AS merged_into_id,
  CASE WHEN d.hw_fingerprint IS NOT NULL AND EXISTS (
    SELECT 1 FROM ita.device o WHERE o.hw_fingerprint = d.hw_fingerprint AND o.id <> d.id AND o.merged_into IS NULL AND o.status <> 'retired'
  ) THEN 1 ELSE 0 END AS suspected`;
const SUMMARY_FROM = `ita.device d LEFT JOIN ita.device_inventory i ON i.device_ref = d.id LEFT JOIN ita.device m ON m.id = d.merged_into`;
/** 軟體列每批筆數(每列 5 個參數,參數上限 2100) */
const SOFTWARE_BATCH = 200;

/** LIKE 部分比對:跳脫萬用字元,搭配 ESCAPE '\\' */
export const likeContains = (s: string) => `%${s.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`;

type Row = Record<string, unknown>;

function toDevice(r: Row): DeviceRecord {
  return {
    id: Number(r.id),
    deviceId: String(r.device_id).toLowerCase(),
    certDn: String(r.cert_dn),
    certFp: String(r.cert_fp).trim(),
    computerName: String(r.computer_name),
    status: r.status === 'disabled' || r.status === 'retired' ? r.status : 'active',
    agentVersion: (r.agent_version as string | null) ?? null,
    firstSeenAt: r.first_seen_at as Date,
    lastSeenAt: r.last_seen_at as Date,
    lastInventoryAt: (r.last_inventory_at as Date | null) ?? null,
    hwFingerprint: r.hw_fingerprint == null ? null : String(r.hw_fingerprint).trim(),
    clockSkewMs: r.clock_skew_ms == null ? null : Number(r.clock_skew_ms),
    company: r.company == null ? null : String(r.company),
    companySource: r.company_source == null ? null : (String(r.company_source) as CompanySource),
  };
}

function toRow(r: Row, ips: string[]): DeviceRow {
  const osVersion = [r.os_display_version, r.os_build].filter(Boolean).join(' / ') || ((r.os_version as string | null) ?? null);
  return {
    ...toDevice(r),
    userName: (r.user_name as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    partOfDomain: r.part_of_domain == null ? null : Boolean(r.part_of_domain),
    osName: (r.os_name as string | null) ?? null,
    osVersion,
    manufacturer: (r.manufacturer as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    cpuName: (r.cpu_name as string | null) ?? null,
    // BIGINT 由 tedious 以字串傳回
    memoryTotal: r.memory_total == null ? null : Number(r.memory_total),
    ips,
    suspectedDuplicate: Number(r.suspected ?? 0) === 1,
    mergedIntoId: r.merged_into_id == null ? null : String(r.merged_into_id).toLowerCase(),
    retiredAt: (r.retired_at as Date | null) ?? null,
  };
}

type SoftwareItem = ComputerInfo['software'][number];

/** 軟體清單整批寫入(呼叫前已刪除舊列);名稱空白者略過 */
async function insertSoftware(tx: sql.Transaction, deviceRef: number, list: SoftwareItem[]): Promise<void> {
  const items = list.filter((x) => x?.name?.trim());
  for (let i = 0; i < items.length; i += SOFTWARE_BATCH) {
    const req = new sql.Request(tx).input('id', sql.Int, deviceRef);
    const values = items.slice(i, i + SOFTWARE_BATCH).map((x, k) => {
      req
        .input(`n${k}`, sql.NVarChar(400), cut(x.name.trim(), 400))
        .input(`v${k}`, sql.NVarChar(100), cut(x.version, 100))
        .input(`p${k}`, sql.NVarChar(255), cut(x.publisher, 255))
        .input(`d${k}`, sql.VarChar(16), cut(x.install_date, 16));
      return `(@id, @n${k}, @v${k}, @p${k}, @d${k})`;
    });
    await req.query(`INSERT INTO ita.device_software (device_ref, name, version, publisher, install_date) VALUES ${values.join(', ')}`);
  }
}

/** 主機比對產生的事件(event_uid NULL;occurred_at = 新資產的蒐集時間);data 上限 4,000 字元,過長只記長度 */
async function insertHostEvents(tx: sql.Transaction, device: DeviceRecord, events: HostEventInput[], at: Date): Promise<SavedHostEvent[]> {
  const saved: SavedHostEvent[] = [];
  for (const e of events) {
    let data = JSON.stringify(e.data);
    if (data.length > 4000) data = JSON.stringify({ truncated: true, size: data.length });
    const r = await new sql.Request(tx)
      .input('id', sql.Int, device.id)
      .input('type', sql.VarChar(32), e.type)
      .input('dn', sql.NVarChar(450), device.certDn)
      .input('fp', sql.Char(40), device.certFp)
      .input('at', sql.DateTime2(3), at)
      .input('data', sql.NVarChar(4000), data).query(`
        INSERT INTO ita.device_event (device_ref, event_type, cert_dn, cert_fp, occurred_at, data)
        OUTPUT INSERTED.id VALUES (@id, @type, @dn, @fp, @at, @data)`);
    saved.push({ ...e, id: Number((r.recordset[0] as Row).id) });
  }
  return saved;
}

/** 公司名稱逐字比對(與 service 的 inScope 一致;資料庫預設定序不分大小寫與全半形) */
export const COMPANY_EXACT = 'COLLATE Latin1_General_BIN2';

/** d.company IN (@sc0, @sc1…);空清單 → 1 = 0(不回任何列) */
export function companyIn(req: sql.Request, companies: readonly string[], col = 'd.company'): string {
  if (companies.length === 0) return '1 = 0';
  const ps = companies.map((c, k) => {
    req.input(`sc${k}`, sql.NVarChar(20), c);
    return `@sc${k}`;
  });
  return `${col} ${COMPANY_EXACT} IN (${ps.join(', ')})`;
}

const actorText = (a: Actor) => `操作人 ${a.emp}${a.name ? ` ${a.name}` : ''}`;

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

  /** 指令儲存(SqlCommandStore)共用同一個連線池 */
  connection(): Promise<sql.ConnectionPool> {
    return this.ready();
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

  async register(input: {
    certDn: string;
    certFp: string;
    computerName: string;
    requestId: string;
    at: Date;
    company?: string | null;
    companySource?: CompanySource | null;
  }): Promise<DeviceRecord> {
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
        .input('co', sql.NVarChar(20), input.company ?? null)
        .input('cosrc', sql.VarChar(8), input.company ? (input.companySource ?? null) : null)
        .input('rid', sql.VarChar(64), cut(input.requestId, 64)).query(`
          DECLARE @ids TABLE (id INT);
          INSERT INTO ita.device (cert_dn, cert_fp, computer_name, first_seen_at, last_seen_at, created_by, updated_by, company, company_source)
          OUTPUT INSERTED.id INTO @ids
          VALUES (@dn, @fp, @name, @at, @at, @by, @by, @co, @cosrc);
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

  /** 端點事件逐筆「不存在才寫入」;同一批同時重送撞到唯一索引(2601)時重跑一次,已存在者即略過。回傳這次新增的 eventUid(小寫) */
  async addAgentEvents(device: DeviceRecord, events: AgentEvent[], receivedAt: Date, requestId: string): Promise<string[]> {
    if (events.length === 0) return [];
    const run = async () => {
      const req = (await this.request())
        .input('id', sql.Int, device.id)
        .input('dn', sql.NVarChar(450), device.certDn)
        .input('fp', sql.Char(40), device.certFp)
        .input('received', sql.DateTime2(3), receivedAt)
        .input('rid', sql.VarChar(64), cut(requestId, 64));
      const stmts = events.map((e, k) => {
        req
          .input(`u${k}`, sql.UniqueIdentifier, e.eventUid)
          .input(`t${k}`, sql.VarChar(32), e.type)
          .input(`o${k}`, sql.DateTime2(3), e.occurredAt)
          .input(`d${k}`, sql.NVarChar(4000), e.data);
        return `IF NOT EXISTS (SELECT 1 FROM ita.device_event WHERE device_ref = @id AND event_uid = @u${k})
          INSERT INTO ita.device_event (device_ref, event_type, cert_dn, cert_fp, request_id, occurred_at, received_at, event_uid, data)
          OUTPUT INSERTED.event_uid INTO @new
          VALUES (@id, @t${k}, @dn, @fp, @rid, @o${k}, @received, @u${k}, @d${k});`;
      });
      const r = await req.query(
        `SET XACT_ABORT ON; DECLARE @new TABLE (event_uid UNIQUEIDENTIFIER); BEGIN TRAN; ${stmts.join('\n')} COMMIT; SELECT event_uid FROM @new;`,
      );
      return (r.recordset as Row[]).map((x) => String(x.event_uid).toLowerCase());
    };
    try {
      return await run();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      return run();
    }
  }

  async touch(deviceRef: number, at: Date, patch: TouchPatch = {}): Promise<void> {
    await (await this.request())
      .input('id', sql.Int, deviceRef)
      .input('at', sql.DateTime2(3), at)
      .input('name', sql.NVarChar(255), cut(patch.computerName, 255))
      .input('ver', sql.VarChar(32), cut(patch.agentVersion, 32))
      .input('hw', sql.Char(64), patch.hwFingerprint ?? null)
      .input('skew', sql.Int, patch.clockSkewMs ?? null).query(`
        UPDATE ita.device
        SET last_seen_at = CASE WHEN last_seen_at < @at THEN @at ELSE last_seen_at END,
            computer_name = COALESCE(@name, computer_name),
            agent_version = COALESCE(@ver, agent_version),
            hw_fingerprint = COALESCE(@hw, hw_fingerprint),
            clock_skew_ms = CASE WHEN @skew IS NULL THEN clock_skew_ms ELSE @skew END,
            clock_checked_at = CASE WHEN @skew IS NULL THEN clock_checked_at ELSE @at END,
            updated_at = SYSUTCDATETIME(), updated_by = '${BY_AGENT}'
        WHERE id = @id`);
  }

  async findByHwFingerprint(hwFingerprint: string, excludeRef: number): Promise<DeviceRecord[]> {
    const r = await (await this.request())
      .input('hw', sql.Char(64), hwFingerprint)
      .input('id', sql.Int, excludeRef)
      .query(`SELECT ${DEVICE_COLS} FROM ita.device d WHERE d.hw_fingerprint = @hw AND d.id <> @id AND d.merged_into IS NULL ORDER BY d.id`);
    return (r.recordset as Row[]).map(toDevice);
  }

  async currentInventory(deviceRef: number): Promise<CurrentInventory | null> {
    const r = await (await this.request())
      .input('id', sql.Int, deviceRef)
      .query(`SELECT agent_seq, content_hash, collected_at FROM ita.device_inventory WHERE device_ref = @id`);
    const row = r.recordset[0] as Row | undefined;
    return row ? { agentSeq: Number(row.agent_seq), contentHash: String(row.content_hash), collectedAt: row.collected_at as Date } : null;
  }

  async saveInventory(device: DeviceRecord, s: InventorySnapshot, diff?: (prevPayload: string | null) => HostEventInput[]): Promise<SavedHostEvent[]> {
    const inv = s.inventory;
    const sys = inv.system;
    const pool = await this.ready();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      // 變更比對(P5):先鎖住舊資產列再讀,同一台同時兩份回報時依序比對,不會漏也不會重複
      let changes: HostEventInput[] = [];
      if (diff) {
        const prev = await new sql.Request(tx)
          .input('id', sql.Int, device.id)
          .query(`SELECT payload FROM ita.device_inventory WITH (UPDLOCK, HOLDLOCK) WHERE device_ref = @id`);
        changes = diff(((prev.recordset[0] as Row | undefined)?.payload as string | null | undefined) ?? null);
      }
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
          DELETE FROM ita.device_software WHERE device_ref = @id;
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
      await insertSoftware(tx, device.id, inv.software ?? []);
      // 事件時間用端點的蒐集時間,但不晚於收到時間 + 5 分鐘(端點時鐘或偽造的未來時間不會讓事件永遠排在最前面)
      const limit = new Date(s.receivedAt.getTime() + 5 * 60_000);
      const saved = await insertHostEvents(tx, device, changes, s.collectedAt > limit ? s.receivedAt : s.collectedAt);
      await tx.commit();
      return saved;
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

  async listDevices(filter: DeviceFilter): Promise<DeviceRow[]> {
    const req = await this.request();
    const where: string[] = [];
    const statuses: DeviceStatus[] = filter.statuses.length ? filter.statuses : ['active', 'disabled'];
    const st = statuses.map((v, k) => {
      req.input(`st${k}`, sql.VarChar(16), v);
      return `@st${k}`;
    });
    where.push(`d.status IN (${st.join(', ')})`);
    if (filter.q) {
      req.input('q', sql.NVarChar(210), likeContains(filter.q));
      // MAC 可輸入 - 或 :(Agent 回報為 :)
      req.input('qmac', sql.VarChar(210), likeContains(filter.q.replace(/-/g, ':')));
      where.push(`(d.computer_name LIKE @q ESCAPE '\\' OR i.user_name LIKE @q ESCAPE '\\' OR CONVERT(VARCHAR(36), d.device_id) LIKE @q ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM ita.device_nic n WHERE n.device_ref = d.id AND (n.ip_address LIKE @q ESCAPE '\\' OR n.mac LIKE @qmac ESCAPE '\\')))`);
    }
    if (filter.software) {
      req.input('sw', sql.NVarChar(410), likeContains(filter.software));
      where.push(`EXISTS (SELECT 1 FROM ita.device_software s WHERE s.device_ref = d.id AND s.name LIKE @sw ESCAPE '\\')`);
    }
    if (filter.os) {
      req.input('os', sql.NVarChar(210), likeContains(filter.os));
      where.push(`(i.os_name LIKE @os ESCAPE '\\' OR i.os_display_version LIKE @os ESCAPE '\\')`);
    }
    // 資料範圍(E6):不含未指定公司的裝置
    if (filter.companies) where.push(companyIn(req, filter.companies));
    if (filter.company === null) where.push('d.company IS NULL');
    else if (filter.company !== undefined) {
      req.input('co', sql.NVarChar(20), filter.company);
      where.push(`d.company ${COMPANY_EXACT} = @co`);
    }
    const r = await req.query(`SELECT ${SUMMARY_COLS} FROM ${SUMMARY_FROM} WHERE ${where.join(' AND ')} ORDER BY d.computer_name, d.id`);
    const ips = await this.ipv4Of();
    return (r.recordset as Row[]).map((row) => toRow(row, ips.get(Number(row.id)) ?? []));
  }

  async getDevice(deviceId: string): Promise<{ row: DeviceRow; payload: string | null; collectedAt: Date | null } | null> {
    const r = await (await this.request())
      .input('did', sql.UniqueIdentifier, deviceId)
      .query(`SELECT ${SUMMARY_COLS}, i.payload, i.collected_at FROM ${SUMMARY_FROM} WHERE d.device_id = @did`);
    const row = r.recordset[0] as Row | undefined;
    if (!row) return null;
    const ips = await this.ipv4Of(Number(row.id));
    return { row: toRow(row, ips.get(Number(row.id)) ?? []), payload: (row.payload as string | null) ?? null, collectedAt: (row.collected_at as Date | null) ?? null };
  }

  async listEvents(deviceRef: number, beforeId: number | undefined, limit: number): Promise<DeviceEventRecord[]> {
    const r = await (await this.request())
      .input('id', sql.Int, deviceRef)
      .input('before', sql.BigInt, beforeId ?? null)
      .input('limit', sql.Int, limit).query(`
        SELECT TOP (@limit) id, event_type, occurred_at, received_at, detail, data FROM ita.device_event
        WHERE device_ref = @id AND (@before IS NULL OR id < @before) ORDER BY id DESC`);
    return (r.recordset as Row[]).map((e) => ({
      id: Number(e.id),
      type: String(e.event_type),
      occurredAt: e.occurred_at as Date,
      receivedAt: (e.received_at as Date | null) ?? null,
      detail: (e.detail as string | null) ?? null,
      data: (e.data as string | null) ?? null,
    }));
  }

  async setStatus(deviceRef: number, status: DeviceStatus, detail: string, requestId: string, actor: Actor): Promise<boolean> {
    const type: DeviceEventType = status === 'active' ? 'enabled' : status;
    const r = await (await this.request())
      .input('id', sql.Int, deviceRef)
      .input('status', sql.VarChar(16), status)
      .input('type', sql.VarChar(32), type)
      .input('detail', sql.NVarChar(1000), cut(`${actorText(actor)};${detail}`, 1000))
      .input('by', sql.NVarChar(64), cut(actor.emp, 64))
      .input('rid', sql.VarChar(64), cut(requestId, 64)).query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        UPDATE ita.device SET status = @status,
          retired_at = CASE WHEN @status = 'retired' THEN COALESCE(retired_at, SYSUTCDATETIME()) WHEN @status = 'active' THEN NULL ELSE retired_at END,
          updated_at = SYSUTCDATETIME(), updated_by = @by
        WHERE id = @id AND merged_into IS NULL;
        -- 並行的合併已把這台併入其他裝置:不變更
        IF @@ROWCOUNT = 0
        BEGIN
          ROLLBACK;
          SELECT CAST(0 AS BIT) AS ok;
          RETURN;
        END
        INSERT INTO ita.device_event (device_ref, event_type, cert_dn, cert_fp, detail, request_id)
        SELECT id, @type, cert_dn, cert_fp, @detail, @rid FROM ita.device WHERE id = @id;
        COMMIT;
        SELECT CAST(1 AS BIT) AS ok;`);
    return r.recordset[0]?.ok === true;
  }

  async merge(targetRef: number, sourceRef: number, detail: string, requestId: string, actor: Actor): Promise<MergeResult> {
    const pool = await this.ready();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const req = () => new sql.Request(tx).input('t', sql.Int, targetRef).input('s', sql.Int, sourceRef);
      // 鎖定兩列後再檢查(並行的兩次合併只有一次成功)
      const locked = await req().query(`SELECT ${DEVICE_COLS}, d.merged_into FROM ita.device d WITH (UPDLOCK, HOLDLOCK) WHERE d.id IN (@t, @s)`);
      const rows = locked.recordset as Row[];
      const t = rows.find((x) => Number(x.id) === targetRef);
      const s = rows.find((x) => Number(x.id) === sourceRef);
      if (!t || !s) throw new AppError(404, 'ITA_DEVICE_NOT_FOUND', '找不到此電腦');
      if (t.merged_into != null) throw new AppError(409, 'ITA_MERGE_INVALID', '目標裝置已併入其他裝置', { reason: 'target_merged' });
      // 並行的同一請求已完成:由 service 回 alreadyMerged
      if (s.merged_into != null && Number(s.merged_into) === targetRef)
        throw new AppError(409, 'ITA_MERGE_INVALID', '來源裝置已併入此裝置', { reason: 'already_merged' });
      if (s.merged_into != null) throw new AppError(409, 'ITA_MERGE_INVALID', '來源裝置已合併過', { reason: 'source_merged' });
      if (t.status === 'retired') throw new AppError(409, 'ITA_MERGE_INVALID', '目標裝置已退役,請先改回使用中再合併', { reason: 'target_retired' });
      // 停用 / 退役的來源不能藉合併解除封鎖(要先經 PUT /status 啟用,留稽核)
      if (s.status !== 'active') throw new AppError(409, 'ITA_MERGE_INVALID', '來源裝置已停用或退役,不能合併', { reason: 'source_not_active' });

      // 資產取 collected_at 較新的一份
      const inv = await req().query(`SELECT device_ref, collected_at FROM ita.device_inventory WHERE device_ref IN (@t, @s)`);
      const at = (ref: number) => (inv.recordset as Row[]).find((x) => Number(x.device_ref) === ref)?.collected_at as Date | undefined;
      const tAt = at(targetRef);
      const sAt = at(sourceRef);
      const inventoryFrom: MergeResult['inventoryFrom'] = !tAt && !sAt ? 'none' : !tAt || (sAt && sAt > tAt) ? 'source' : 'target';
      const drop = inventoryFrom === 'source' ? targetRef : sourceRef;

      const moved = await req()
        .input('drop', sql.Int, drop)
        .input('fromsrc', sql.Bit, inventoryFrom === 'source')
        .input('srcdn', sql.NVarChar(450), `merged:${String(s.device_id).toLowerCase()}`)
        .input('by', sql.NVarChar(64), cut(actor.emp, 64)).query(`
          SET XACT_ABORT ON;
          DELETE FROM ita.device_nic WHERE device_ref = @drop;
          DELETE FROM ita.device_software WHERE device_ref = @drop;
          DELETE FROM ita.device_inventory WHERE device_ref = @drop;
          UPDATE ita.device_inventory SET device_ref = @t WHERE device_ref = @s;
          UPDATE ita.device_nic SET device_ref = @t WHERE device_ref = @s;
          UPDATE ita.device_software SET device_ref = @t WHERE device_ref = @s;
          UPDATE ita.device_event SET device_ref = @t WHERE device_ref = @s;
          DECLARE @events INT = @@ROWCOUNT;
          -- 兩台尚未結束的指令一律取消:舊裝置排隊的指令不可送到合併後連線的 Agent(硬體指紋只是端點自行宣稱)
          UPDATE ita.command SET state = 'canceled', error_code = 'DEVICE_MERGED', error_message = N'裝置合併,未完成的指令已取消',
            finished_at = SYSUTCDATETIME()
          WHERE device_ref IN (@t, @s) AND state IN ('queued', 'sent', 'acked', 'running');
          DECLARE @canceled INT = @@ROWCOUNT;
          UPDATE ita.command SET device_ref = @t WHERE device_ref = @s;
          DECLARE @commands INT = @@ROWCOUNT;
          -- 釋放來源的 DN(唯一鍵),目標改用來源目前的憑證與連線欄位(來源才是現在在用的那台);目標的狀態不變
          DECLARE @dn NVARCHAR(450), @fp CHAR(40), @name NVARCHAR(255), @ver VARCHAR(32), @hw CHAR(64), @skew INT, @checked DATETIME2(3),
            @first DATETIME2(3), @last DATETIME2(3), @inv DATETIME2(3);
          SELECT @dn = cert_dn, @fp = cert_fp, @name = computer_name, @ver = agent_version, @hw = hw_fingerprint, @skew = clock_skew_ms,
            @checked = clock_checked_at, @first = first_seen_at, @last = last_seen_at, @inv = last_inventory_at
          FROM ita.device WHERE id = @s;
          UPDATE ita.device SET cert_dn = @srcdn, status = 'retired', merged_into = @t, retired_at = SYSUTCDATETIME(),
            updated_at = SYSUTCDATETIME(), updated_by = @by WHERE id = @s;
          -- 所屬公司(E6 §3.3):目標不變;目標未指定時取來源的。SET 內引用的是更新前的值
          DECLARE @co NVARCHAR(20), @cosrc VARCHAR(8);
          SELECT @co = company, @cosrc = company_source FROM ita.device WHERE id = @s;
          UPDATE ita.device SET company = CASE WHEN company IS NULL THEN @co ELSE company END,
            company_source = CASE WHEN company IS NULL THEN @cosrc ELSE company_source END
          WHERE id = @t;
          UPDATE ita.device SET cert_dn = @dn, cert_fp = @fp, computer_name = @name, agent_version = COALESCE(@ver, agent_version),
            hw_fingerprint = COALESCE(@hw, hw_fingerprint), clock_skew_ms = @skew, clock_checked_at = @checked,
            first_seen_at = CASE WHEN @first < first_seen_at THEN @first ELSE first_seen_at END,
            last_seen_at = CASE WHEN @last > last_seen_at THEN @last ELSE last_seen_at END,
            last_inventory_at = CASE WHEN @fromsrc = 1 THEN @inv ELSE last_inventory_at END,
            updated_at = SYSUTCDATETIME(), updated_by = @by
          WHERE id = @t;
          SELECT @events AS events, @commands AS commands, @canceled AS canceled;`);
      const counts = moved.recordset[0] as Row;
      await req()
        .input('olddn', sql.NVarChar(450), String(t.cert_dn))
        .input('detail', sql.NVarChar(1000), cut(`${actorText(actor)};併入 ${String(s.computer_name)}(${String(s.device_id).toLowerCase()});舊 DN ${String(t.cert_dn)};${detail}`, 1000))
        .input('rid', sql.VarChar(64), cut(requestId, 64)).query(`
          INSERT INTO ita.device_event (device_ref, event_type, cert_dn, cert_fp, detail, request_id)
          SELECT id, 'merged', @olddn, cert_fp, @detail, @rid FROM ita.device WHERE id = @t;`);
      await tx.commit();
      return { events: Number(counts.events), commands: Number(counts.commands), canceledCommands: Number(counts.canceled), inventoryFrom };
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }

  async setCompany(deviceRef: number, c: CompanyChange): Promise<boolean> {
    const r = await (await this.request())
      .input('id', sql.Int, deviceRef)
      .input('co', sql.NVarChar(20), c.company)
      .input('src', sql.VarChar(8), c.company === null ? null : c.source)
      .input('manual', sql.Bit, c.mode === 'manual')
      .input('detail', sql.NVarChar(1000), cut(c.detail, 1000) ?? '')
      .input('by', sql.NVarChar(64), cut(c.by, 64))
      .input('rid', sql.VarChar(64), cut(c.requestId, 64)).query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @old TABLE (company NVARCHAR(20), company_source VARCHAR(8));
        UPDATE ita.device SET company = @co, company_source = @src, updated_at = SYSUTCDATETIME(), updated_by = @by
        OUTPUT DELETED.company, DELETED.company_source INTO @old
        WHERE id = @id AND merged_into IS NULL AND (@manual = 1 OR company_source IS NULL OR company_source = 'domain');
        IF @@ROWCOUNT = 0
        BEGIN
          ROLLBACK;
          SELECT CAST(0 AS BIT) AS ok;
          RETURN;
        END
        -- 稽核:IT 指定一律記;自動判定只在公司有變時記
        IF @manual = 1 OR EXISTS (SELECT 1 FROM @old WHERE ISNULL(company, N'') <> ISNULL(@co, N''))
          INSERT INTO ita.device_event (device_ref, event_type, cert_dn, cert_fp, detail, request_id)
          SELECT d.id, 'company_changed', d.cert_dn, d.cert_fp,
            LEFT(N'公司 ' + ISNULL(o.company, N'(未指定)') + N'(' + ISNULL(o.company_source, N'-') + N')→ ' + ISNULL(@co, N'(未指定)')
              + N'(' + ISNULL(@src, N'-') + N');' + @detail, 1000), @rid
          FROM ita.device d CROSS JOIN @old o WHERE d.id = @id;
        COMMIT;
        SELECT CAST(1 AS BIT) AS ok;`);
    return r.recordset[0]?.ok === true;
  }

  async companyCandidates(afterRef: number, limit: number): Promise<CompanyCandidate[]> {
    const r = await (await this.request()).input('after', sql.Int, afterRef).input('limit', sql.Int, limit).query(`
      SELECT TOP (@limit) d.id, d.device_id, d.cert_dn, i.domain, i.part_of_domain
      FROM ita.device d LEFT JOIN ita.device_inventory i ON i.device_ref = d.id
      WHERE d.id > @after AND d.company_source IS NULL AND d.merged_into IS NULL
      ORDER BY d.id`);
    return (r.recordset as Row[]).map((x) => ({
      id: Number(x.id),
      deviceId: String(x.device_id).toLowerCase(),
      certDn: String(x.cert_dn),
      domain: (x.domain as string | null) ?? null,
      partOfDomain: x.part_of_domain == null ? null : Boolean(x.part_of_domain),
    }));
  }

  async backfillSoftware(afterRef: number, limit: number): Promise<BackfillResult> {
    const r = await (await this.request()).input('after', sql.Int, afterRef).input('limit', sql.Int, limit).query(`
      SELECT TOP (@limit) i.device_ref FROM ita.device_inventory i
      WHERE i.device_ref > @after
        AND NOT EXISTS (SELECT 1 FROM ita.device_software s WHERE s.device_ref = i.device_ref)
        AND i.payload LIKE N'%"software":\\[{%' ESCAPE '\\'
      ORDER BY i.device_ref`);
    const refs = (r.recordset as Row[]).map((x) => Number(x.device_ref));
    const result: BackfillResult = { lastRef: refs.length === limit ? refs[refs.length - 1]! : null, done: 0, failed: [] };
    for (const ref of refs) {
      const tx = new sql.Transaction(await this.ready());
      await tx.begin();
      try {
        // 鎖住資產列後重讀:Agent 同時回報新資產(saveInventory 先更新這一列)時,等它完成後看到已有軟體列就略過
        const cur = await new sql.Request(tx).input('id', sql.Int, ref).query(`
          SELECT i.payload, CASE WHEN EXISTS (SELECT 1 FROM ita.device_software s WHERE s.device_ref = i.device_ref) THEN 1 ELSE 0 END AS has
          FROM ita.device_inventory i WITH (UPDLOCK, HOLDLOCK) WHERE i.device_ref = @id`);
        const row = cur.recordset[0] as Row | undefined;
        if (row && Number(row.has) === 0) {
          let list: SoftwareItem[] | null = null;
          try {
            list = (JSON.parse(String(row.payload)) as ComputerInfo).software ?? [];
          } catch {
            // payload 不是合法 JSON:不寫,回報給 service 記錄
            result.failed.push(ref);
          }
          if (list) await insertSoftware(tx, ref, list);
        }
        await tx.commit();
        if (!result.failed.includes(ref)) result.done++;
      } catch (err) {
        await tx.rollback().catch(() => undefined);
        throw err;
      }
    }
    return result;
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
