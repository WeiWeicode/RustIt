/**
 * 監測儲存(SQL Server 2012,migration 0006;PLATFORM-PLAN P5 §4.3、P5-MONITOR-DESIGN §1):ita.device_health(1:1)、ita.device_alert。
 * 與 SqlDeviceStore 共用連線池。告警「同一台同一規則只有一筆未結束」由篩選唯一索引 ux_device_alert_open 保證。
 */
import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import { companyIn } from './sql-store.js';
import type { Actor, AlertFilter, AlertOpen, AlertRecord, AlertRule, DeviceHealthRecord, HealthSample, MonitorStore, MonitorTarget, WatchdogState } from './types.js';

type Row = Record<string, unknown>;

const cut = (s: string | null | undefined, n: number): string | null => (s == null || s === '' ? null : s.length > n ? s.slice(0, n) : s);
const num = (v: unknown) => (v == null ? undefined : Number(v));
const isDuplicateKey = (err: unknown) => [2627, 2601].includes((err as { number?: number }).number ?? 0);

const HEALTH_COLS = `h.device_ref, h.health_at, h.cpu_pct, h.mem_used_pct, h.disk_min_free_pct, h.disk_min_free_drive, h.uptime_s, h.agent_rss_mb, h.cert_not_after,
  h.watchdog_version, h.watchdog_report_at, h.agent_service_state, h.agent_start_type, h.agent_status_ok, h.agent_last_error, h.agent_restarts_24h`;

const ALERT_COLS = `a.id, a.alert_id, a.device_ref, d.device_id, d.computer_name, d.company AS device_company, a.[rule], a.severity, a.state, a.opened_at, a.last_seen_at,
  a.resolved_at, a.resolved_by, a.resolved_by_emp, a.resolved_by_name, a.resolve_note, a.detail, a.event_ref`;
const ALERT_FROM = `ita.device_alert a JOIN ita.device d ON d.id = a.device_ref`;

/** 端點事件 agent_started 的 data(JSON.stringify,無空白)中「上次沒有正常結束」 */
const UNEXPECTED_LIKE = '%"previous_exit":"unexpected"%';

function toHealth(r: Row): DeviceHealthRecord {
  return {
    deviceRef: Number(r.device_ref),
    healthAt: (r.health_at as Date | null) ?? null,
    cpuPct: num(r.cpu_pct),
    memUsedPct: num(r.mem_used_pct),
    diskMinFreePct: num(r.disk_min_free_pct),
    diskMinFreeDrive: r.disk_min_free_drive == null ? undefined : String(r.disk_min_free_drive),
    uptimeS: num(r.uptime_s),
    agentRssMb: num(r.agent_rss_mb),
    certNotAfter: (r.cert_not_after as Date | null) ?? null,
    watchdogVersion: r.watchdog_version == null ? null : String(r.watchdog_version),
    watchdogReportAt: (r.watchdog_report_at as Date | null) ?? null,
    agentServiceState: r.agent_service_state == null ? null : String(r.agent_service_state),
    agentStartType: r.agent_start_type == null ? null : String(r.agent_start_type),
    agentStatusOk: r.agent_status_ok == null ? null : Boolean(r.agent_status_ok),
    agentLastError: r.agent_last_error == null ? null : String(r.agent_last_error),
    agentRestarts24h: r.agent_restarts_24h == null ? null : Number(r.agent_restarts_24h),
  };
}

function toAlert(r: Row): AlertRecord {
  return {
    id: Number(r.id),
    alertId: String(r.alert_id).toLowerCase(),
    deviceRef: Number(r.device_ref),
    deviceId: String(r.device_id).toLowerCase(),
    computerName: String(r.computer_name),
    deviceCompany: r.device_company == null ? null : String(r.device_company),
    rule: String(r.rule) as AlertRule,
    severity: r.severity === 'critical' ? 'critical' : 'warn',
    state: r.state === 'resolved' ? 'resolved' : 'open',
    openedAt: r.opened_at as Date,
    lastSeenAt: r.last_seen_at as Date,
    resolvedAt: (r.resolved_at as Date | null) ?? null,
    resolvedBy: r.resolved_by === 'auto' || r.resolved_by === 'manual' ? r.resolved_by : null,
    resolvedByEmp: r.resolved_by_emp == null ? null : String(r.resolved_by_emp),
    resolvedByName: r.resolved_by_name == null ? null : String(r.resolved_by_name),
    resolveNote: r.resolve_note == null ? null : String(r.resolve_note),
    detail: r.detail == null ? null : String(r.detail),
    eventRef: r.event_ref == null ? null : Number(r.event_ref),
  };
}

/** 0–100 的整數;超出範圍或不是數字 → NULL(TINYINT 與 CHECK 不會擋掉整筆) */
const pct = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : Math.max(0, Math.min(100, Math.round(v))));
const int = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : Math.max(0, Math.min(2_147_483_647, Math.round(v))));

/** 數字清單轉成 IN (@r0, @r1…);空清單 → 1 = 0 */
function refsIn(req: sql.Request, refs: number[], col: string): string {
  if (refs.length === 0) return '1 = 0';
  return `${col} IN (${refs.map((r, k) => (req.input(`r${k}`, sql.Int, r), `@r${k}`)).join(', ')})`;
}

/** 一次查詢的裝置數上限(參數上限 2100) */
const REF_BATCH = 1000;

/** P7 reboot_pending:Agent result 的 reboot_required(JSON 序列化無空白,設計 §2.4) */
const REBOOT_REQUIRED_LIKE = '%"reboot_required":true%';
/** 只看最近 30 天建立的 software.* 指令(更早仍未重開機的告警已開著,超過後自動關閉) */
const REBOOT_LOOKBACK_MS = 30 * 86_400_000;

export class SqlMonitorStore implements MonitorStore {
  constructor(private readonly pool: () => Promise<sql.ConnectionPool>) {}

  private async request(): Promise<sql.Request> {
    return (await this.pool()).request();
  }

  async saveHealth(deviceRef: number, at: Date, s: HealthSample): Promise<void> {
    await (
      await this.request()
    )
      .input('id', sql.Int, deviceRef)
      .input('at', sql.DateTime2(3), at)
      .input('cpu', sql.TinyInt, pct(s.cpuPct))
      .input('mem', sql.TinyInt, pct(s.memUsedPct))
      .input('disk', sql.TinyInt, pct(s.diskMinFreePct))
      .input('drive', sql.VarChar(8), cut(s.diskMinFreeDrive, 8))
      .input('up', sql.Int, int(s.uptimeS))
      .input('rss', sql.Int, int(s.agentRssMb)).query(`
        UPDATE ita.device_health SET health_at = @at,
          -- 這一則沒有的欄位保留上一次的值(例如 Agent 重連後第一則沒有 CPU 使用率)
          cpu_pct = COALESCE(@cpu, cpu_pct), mem_used_pct = COALESCE(@mem, mem_used_pct), disk_min_free_pct = COALESCE(@disk, disk_min_free_pct),
          disk_min_free_drive = COALESCE(@drive, disk_min_free_drive), uptime_s = COALESCE(@up, uptime_s), agent_rss_mb = COALESCE(@rss, agent_rss_mb),
          updated_at = SYSUTCDATETIME()
        WHERE device_ref = @id;
        IF @@ROWCOUNT = 0
          INSERT INTO ita.device_health (device_ref, health_at, cpu_pct, mem_used_pct, disk_min_free_pct, disk_min_free_drive, uptime_s, agent_rss_mb)
          VALUES (@id, @at, @cpu, @mem, @disk, @drive, @up, @rss);`);
  }

  async saveWatchdog(deviceRef: number, w: WatchdogState): Promise<void> {
    await (await this.request())
      .input('id', sql.Int, deviceRef)
      .input('ver', sql.VarChar(32), cut(w.version, 32))
      .input('at', sql.DateTime2(3), w.reportAt)
      .input('state', sql.VarChar(16), cut(w.agentServiceState, 16))
      .input('start', sql.VarChar(16), cut(w.agentStartType, 16))
      .input('ok', sql.Bit, w.agentStatusOk)
      .input('err', sql.NVarChar(300), cut(w.agentLastError, 300))
      .input('restarts', sql.Int, w.agentRestarts24h === null ? null : int(w.agentRestarts24h)).query(`
        UPDATE ita.device_health SET watchdog_version = @ver, watchdog_report_at = @at, agent_service_state = @state, agent_start_type = @start,
          agent_status_ok = @ok, agent_last_error = @err, agent_restarts_24h = @restarts, updated_at = SYSUTCDATETIME()
        WHERE device_ref = @id;
        IF @@ROWCOUNT = 0
          INSERT INTO ita.device_health (device_ref, watchdog_version, watchdog_report_at, agent_service_state, agent_start_type, agent_status_ok,
            agent_last_error, agent_restarts_24h)
          VALUES (@id, @ver, @at, @state, @start, @ok, @err, @restarts);`);
  }

  async saveCertNotAfter(deviceRef: number, notAfter: Date): Promise<void> {
    await (await this.request()).input('id', sql.Int, deviceRef).input('na', sql.DateTime2(3), notAfter).query(`
      UPDATE ita.device_health SET cert_not_after = @na, updated_at = SYSUTCDATETIME() WHERE device_ref = @id;
      IF @@ROWCOUNT = 0 INSERT INTO ita.device_health (device_ref, cert_not_after) VALUES (@id, @na);`);
  }

  async healthOf(deviceRefs: number[]): Promise<Map<number, DeviceHealthRecord>> {
    const map = new Map<number, DeviceHealthRecord>();
    for (let i = 0; i < deviceRefs.length; i += REF_BATCH) {
      const req = await this.request();
      const where = refsIn(req, deviceRefs.slice(i, i + REF_BATCH), 'h.device_ref');
      const r = await req.query(`SELECT ${HEALTH_COLS} FROM ita.device_health h WHERE ${where}`);
      for (const row of r.recordset as Row[]) map.set(Number(row.device_ref), toHealth(row));
    }
    return map;
  }

  async monitorTargets(since: Date): Promise<MonitorTarget[]> {
    const r = await (await this.request())
      .input('since', sql.DateTime2(3), since)
      .input('unexp', sql.NVarChar(100), UNEXPECTED_LIKE)
      .input('rbLike', sql.NVarChar(100), REBOOT_REQUIRED_LIKE)
      .input('rbSince', sql.DateTime2(3), new Date(since.getTime() - REBOOT_LOOKBACK_MS)).query(`
      SELECT d.id AS dref, d.last_seen_at, d.clock_skew_ms, h.device_ref AS has_health, ${HEALTH_COLS.replace('h.device_ref, ', '')},
        (SELECT COUNT(*) FROM ita.device_event e
          WHERE e.device_ref = d.id AND e.event_type = 'agent_started' AND e.occurred_at >= @since AND e.data LIKE @unexp) AS restarts,
        (SELECT MIN(c.finished_at) FROM ita.command c
          WHERE c.device_ref = d.id AND c.kind IN ('software.install', 'software.uninstall') AND c.state = 'succeeded'
            AND c.created_at >= @rbSince AND c.result_summary LIKE @rbLike AND d.boot_time IS NOT NULL AND c.finished_at > d.boot_time) AS reboot_since
      FROM ita.device d LEFT JOIN ita.device_health h ON h.device_ref = d.id
      WHERE d.status = 'active' AND d.merged_into IS NULL;
      SELECT device_ref, [rule] FROM ita.device_alert WHERE state = 'open';`);
    const [devices, open] = r.recordsets as unknown as [Row[], Row[]];
    const rules = new Map<number, AlertRule[]>();
    for (const o of open) rules.set(Number(o.device_ref), [...(rules.get(Number(o.device_ref)) ?? []), String(o.rule) as AlertRule]);
    return devices.map((d) => ({
      deviceRef: Number(d.dref),
      lastSeenAt: d.last_seen_at as Date,
      clockSkewMs: d.clock_skew_ms == null ? null : Number(d.clock_skew_ms),
      health: d.has_health == null ? null : toHealth({ ...d, device_ref: d.dref }),
      unexpectedRestarts24h: Number(d.restarts ?? 0),
      openRules: rules.get(Number(d.dref)) ?? [],
      rebootRequiredSince: (d.reboot_since as Date | null) ?? null,
    }));
  }

  async openAlert(a: AlertOpen): Promise<{ alertId: string; created: boolean }> {
    const run = async () => {
      const r = await (
        await this.request()
      )
        .input('id', sql.Int, a.deviceRef)
        .input('rule', sql.VarChar(32), a.rule)
        .input('sev', sql.VarChar(8), a.severity)
        .input('detail', sql.NVarChar(2000), cut(a.detail, 2000))
        .input('ev', sql.BigInt, a.eventRef ?? null)
        .input('at', sql.DateTime2(3), a.at)
        .input('keep', sql.Bit, a.keepDetail ?? false)
        .input('aid', sql.UniqueIdentifier, randomUUID()).query(`
          SET XACT_ABORT ON;
          BEGIN TRAN;
          DECLARE @out TABLE (alert_id UNIQUEIDENTIFIER);
          -- 先宣告:DECLARE 帶初值會改變 @@ROWCOUNT
          DECLARE @created BIT = 0;
          UPDATE ita.device_alert WITH (UPDLOCK, HOLDLOCK) SET last_seen_at = @at, severity = @sev,
            detail = CASE WHEN @keep = 1 THEN detail ELSE @detail END, event_ref = COALESCE(event_ref, @ev)
          OUTPUT INSERTED.alert_id INTO @out
          WHERE device_ref = @id AND [rule] = @rule AND state = 'open';
          IF @@ROWCOUNT = 0
          BEGIN
            INSERT INTO ita.device_alert (alert_id, device_ref, [rule], severity, state, opened_at, last_seen_at, detail, event_ref)
            OUTPUT INSERTED.alert_id INTO @out
            VALUES (@aid, @id, @rule, @sev, 'open', @at, @at, @detail, @ev);
            SET @created = 1;
          END
          COMMIT;
          SELECT TOP 1 alert_id, @created AS created FROM @out;`);
      const row = r.recordset[0] as Row;
      return { alertId: String(row.alert_id).toLowerCase(), created: row.created === true };
    };
    try {
      return await run();
    } catch (err) {
      // 同一台同一規則同時開兩次(並行):另一個已建立,再跑一次即變成更新
      if (!isDuplicateKey(err)) throw err;
      return run();
    }
  }

  async resolveAuto(deviceRef: number, rule: AlertRule, at: Date, note: string): Promise<boolean> {
    const r = await (
      await this.request()
    )
      .input('id', sql.Int, deviceRef)
      .input('rule', sql.VarChar(32), rule)
      .input('at', sql.DateTime2(3), at)
      .input('note', sql.NVarChar(500), cut(note, 500)).query(`
        UPDATE ita.device_alert SET state = 'resolved', resolved_at = @at, resolved_by = 'auto', resolve_note = @note
        WHERE device_ref = @id AND [rule] = @rule AND state = 'open'`);
    return (r.rowsAffected[0] ?? 0) > 0;
  }

  async resolveInactive(at: Date): Promise<number> {
    const r = await (await this.request()).input('at', sql.DateTime2(3), at).query(`
      UPDATE a SET state = 'resolved', resolved_at = @at, resolved_by = 'auto',
        resolve_note = CASE WHEN d.merged_into IS NOT NULL THEN N'裝置已合併' WHEN d.status = 'disabled' THEN N'裝置已停用' ELSE N'裝置已退役' END
      FROM ita.device_alert a JOIN ita.device d ON d.id = a.device_ref
      WHERE a.state = 'open' AND (d.status <> 'active' OR d.merged_into IS NOT NULL)`);
    return r.rowsAffected[0] ?? 0;
  }

  async resolveManual(alertId: string, at: Date, actor: Actor, note: string, requestId: string): Promise<boolean> {
    const r = await (
      await this.request()
    )
      .input('aid', sql.UniqueIdentifier, alertId)
      .input('at', sql.DateTime2(3), at)
      .input('emp', sql.NVarChar(64), cut(actor.emp, 64))
      .input('name', sql.NVarChar(100), cut(actor.name, 100))
      .input('note', sql.NVarChar(500), cut(note, 500))
      .input('rid', sql.VarChar(64), cut(requestId, 64)).query(`
        UPDATE ita.device_alert SET state = 'resolved', resolved_at = @at, resolved_by = 'manual', resolved_by_emp = @emp, resolved_by_name = @name,
          resolve_note = @note, request_id = @rid
        WHERE alert_id = @aid AND state = 'open'`);
    return (r.rowsAffected[0] ?? 0) > 0;
  }

  async getAlert(alertId: string): Promise<AlertRecord | null> {
    const r = await (await this.request()).input('aid', sql.UniqueIdentifier, alertId).query(`SELECT ${ALERT_COLS} FROM ${ALERT_FROM} WHERE a.alert_id = @aid`);
    const row = r.recordset[0] as Row | undefined;
    return row ? toAlert(row) : null;
  }

  async listAlerts(f: AlertFilter): Promise<AlertRecord[]> {
    const req = (await this.request()).input('limit', sql.Int, f.limit);
    const where: string[] = [];
    if (f.state) where.push(`a.state = ${(req.input('state', sql.VarChar(16), f.state), '@state')}`);
    if (f.rule) where.push(`a.[rule] = ${(req.input('rule', sql.VarChar(32), f.rule), '@rule')}`);
    if (f.severity) where.push(`a.severity = ${(req.input('sev', sql.VarChar(8), f.severity), '@sev')}`);
    if (f.deviceRef !== undefined) where.push(`a.device_ref = ${(req.input('dref', sql.Int, f.deviceRef), '@dref')}`);
    if (f.beforeId !== undefined) where.push(`a.id < ${(req.input('before', sql.BigInt, f.beforeId), '@before')}`);
    if (f.companies) where.push(companyIn(req, f.companies));
    const r = await req.query(`SELECT TOP (@limit) ${ALERT_COLS} FROM ${ALERT_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC`);
    return (r.recordset as Row[]).map(toAlert);
  }

  async openAlertCounts(deviceRefs: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    for (let i = 0; i < deviceRefs.length; i += REF_BATCH) {
      const req = await this.request();
      const where = refsIn(req, deviceRefs.slice(i, i + REF_BATCH), 'device_ref');
      const r = await req.query(`SELECT device_ref, COUNT(*) AS n FROM ita.device_alert WHERE state = 'open' AND ${where} GROUP BY device_ref`);
      for (const row of r.recordset as Row[]) map.set(Number(row.device_ref), Number(row.n));
    }
    return map;
  }
}
