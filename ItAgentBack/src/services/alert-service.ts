/**
 * 告警(PLATFORM-PLAN §4.3、§4.10 A5;P5-MONITOR-DESIGN §4):固定規則,不做規則引擎;門檻由 ita.env 設定。
 *   - 自動類(offline_long、disk_low、agent_restarts、cert_expiring、clock_skew、agent_silent):每 5 分鐘掃描 active 裝置,
 *     條件成立開(或更新)、條件消失自動關閉;disk_low 以較高的關閉門檻做緩衝,避免在門檻上下反覆開關
 *   - 事件類(hardware_changed;P5-2 加 agent_tampered):事件寫入時開,**不自動關閉**,由 IT 確認(手動關閉留稽核)
 *   - 停用 / 退役 / 已合併裝置的未結束告警在掃描時一律自動關閉
 *   - SQL 是唯一真相;掃描失敗只記 warn,下次再評估。單一實例評估(與指令派送器相同)
 */
import { AppError, storageUnavailable } from '../errors.js';
import type { AlertRecord, AlertRule, AlertSeverity, AlertState, MonitorStore, MonitorTarget, SavedHostEvent, Actor } from '../stores/types.js';
import type { Ctx } from './device-service.js';
import { inScope, scopeCompanies, type MgmtCtx } from './scope.js';

export interface AlertThresholds {
  /** offline_long:最後回報超過幾天 */
  offlineDays: number;
  /** disk_low:剩餘低於此百分比開告警 */
  diskFreePct: number;
  /** disk_low:剩餘回到此百分比以上才關閉 */
  diskClearPct: number;
  /** agent_restarts:24 小時內非正常重啟次數 */
  restarts24h: number;
  /** cert_expiring:幾天內到期 */
  certDays: number;
  /** agent_silent:Watchdog 有回報但 Agent 心跳超過幾分鐘(P5-2) */
  silentMin: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = { offlineDays: 7, diskFreePct: 10, diskClearPct: 15, restarts24h: 3, certDays: 30, silentMin: 15 };

/** 時鐘偏差門檻 ±5 分鐘(A2,與 hello 的 clock_skew 事件相同) */
const CLOCK_SKEW_MS = 5 * 60_000;
/** 磁碟剩餘低於此百分比為 critical */
const DISK_CRITICAL_PCT = 5;
const DAY = 86_400_000;

/** 自動類規則:掃描時評估 */
export const AUTO_RULES: readonly AlertRule[] = ['offline_long', 'disk_low', 'agent_restarts', 'cert_expiring', 'clock_skew', 'agent_silent'];

export interface RuleHit {
  rule: AlertRule;
  severity: AlertSeverity;
  detail: Record<string, unknown>;
}

/** 純函式:一台裝置目前成立的自動類規則(open 的 disk_low 以關閉門檻判斷) */
export function evaluate(t: MonitorTarget, now: Date, th: AlertThresholds): RuleHit[] {
  const hits: RuleHit[] = [];
  const at = now.getTime();
  const h = t.health;

  const offlineMs = at - t.lastSeenAt.getTime();
  if (offlineMs > th.offlineDays * DAY)
    hits.push({ rule: 'offline_long', severity: 'warn', detail: { lastSeenAt: t.lastSeenAt.toISOString(), days: Math.floor(offlineMs / DAY) } });

  // 健康資料超過 1 天(離線很久)不評估磁碟:避免與 offline_long 重複,也避免換硬碟後一直開著
  const free = h?.healthAt && at - h.healthAt.getTime() < DAY ? h.diskMinFreePct : undefined;
  if (free !== undefined) {
    const limit = t.openRules.includes('disk_low') ? th.diskClearPct : th.diskFreePct;
    if (free < limit)
      hits.push({ rule: 'disk_low', severity: free < DISK_CRITICAL_PCT ? 'critical' : 'warn', detail: { drive: h?.diskMinFreeDrive ?? null, freePct: free } });
  }

  // Watchdog 24 小時內有回報才採用它的統計
  const wdFresh = !!h?.watchdogReportAt && at - h.watchdogReportAt.getTime() < DAY;
  const restarts = Math.max(t.unexpectedRestarts24h, wdFresh ? (h?.agentRestarts24h ?? 0) : 0);
  if (restarts >= th.restarts24h) hits.push({ rule: 'agent_restarts', severity: 'warn', detail: { restarts24h: restarts } });

  if (h?.certNotAfter) {
    const days = (h.certNotAfter.getTime() - at) / DAY;
    if (days < th.certDays)
      hits.push({
        rule: 'cert_expiring',
        severity: days < 0 ? 'critical' : 'warn',
        detail: { certNotAfter: h.certNotAfter.toISOString(), days: Math.floor(days) },
      });
  }

  if (t.clockSkewMs !== null && Math.abs(t.clockSkewMs) > CLOCK_SKEW_MS)
    hits.push({ rule: 'clock_skew', severity: 'warn', detail: { clockSkewMs: t.clockSkewMs } });

  // 電腦開著(Watchdog 有回報)但 Agent 不工作(A5 主機端)
  const silentMs = th.silentMin * 60_000;
  if (h?.watchdogReportAt && at - h.watchdogReportAt.getTime() <= silentMs && offlineMs > silentMs)
    hits.push({
      rule: 'agent_silent',
      severity: 'critical',
      detail: { lastSeenAt: t.lastSeenAt.toISOString(), watchdogReportAt: h.watchdogReportAt.toISOString() },
    });

  return hits;
}

export interface AlertView {
  alertId: string;
  deviceId: string;
  computerName: string;
  rule: AlertRule;
  severity: AlertSeverity;
  state: AlertState;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedBy: 'auto' | 'manual' | null;
  resolvedByEmp: string | null;
  resolvedByName: string | null;
  resolveNote: string | null;
  detail: unknown;
}

export interface AlertListQuery {
  state?: AlertState;
  rule?: AlertRule;
  severity?: AlertSeverity;
  deviceId?: string;
  beforeId?: number;
  limit: number;
}

/** 依 deviceId 查內部 id 與公司(裝置篩選的資料範圍檢查) */
export type DeviceLookup = (deviceId: string) => Promise<{ id: number; company: string | null } | null>;

export function alertView(a: AlertRecord): AlertView {
  let detail: unknown = null;
  if (a.detail) {
    try {
      detail = JSON.parse(a.detail);
    } catch {
      detail = a.detail;
    }
  }
  return {
    alertId: a.alertId,
    deviceId: a.deviceId,
    computerName: a.computerName,
    rule: a.rule,
    severity: a.severity,
    state: a.state,
    openedAt: a.openedAt.toISOString(),
    lastSeenAt: a.lastSeenAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    resolvedBy: a.resolvedBy,
    resolvedByEmp: a.resolvedByEmp,
    resolvedByName: a.resolvedByName,
    resolveNote: a.resolveNote,
    detail,
  };
}

export class AlertService {
  private readonly now: () => Date;
  private sweeping = false;

  constructor(
    private readonly store: MonitorStore,
    private readonly lookup: DeviceLookup,
    private readonly thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  private async sqlDo<T>(ctx: Ctx, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      ctx.log.error({ err, what }, 'SQL Server 操作失敗,回 503');
      throw storageUnavailable();
    }
  }

  /** 主機比對產生的事件(資產已寫入):硬體變更開 critical 告警;失敗只記 warn(事件已保存,IT 仍可在事件 Tab 看到) */
  async onHostEvents(ctx: Ctx, deviceRef: number, events: SavedHostEvent[]): Promise<void> {
    for (const e of events.filter((x) => x.type === 'hardware_changed')) {
      try {
        const r = await this.store.openAlert({
          deviceRef,
          rule: 'hardware_changed',
          severity: 'critical',
          detail: JSON.stringify(e.data),
          eventRef: e.id,
          keepDetail: true,
          at: this.now(),
        });
        ctx.log.warn({ deviceRef, alertId: r.alertId, component: e.data.component }, '硬體變更,已開告警');
      } catch (err) {
        ctx.log.warn({ err, deviceRef }, '硬體變更告警寫入失敗');
      }
    }
  }

  /** 每 5 分鐘:評估自動類規則、關閉非 active 裝置的告警;回傳新開與關閉的筆數 */
  async sweep(ctx: Ctx): Promise<{ opened: number; resolved: number }> {
    const result = { opened: 0, resolved: 0 };
    // 上一輪還沒跑完(資料庫慢)不重疊
    if (this.sweeping) return result;
    this.sweeping = true;
    try {
      const now = this.now();
      try {
        result.resolved += await this.store.resolveInactive(now);
      } catch (err) {
        ctx.log.warn({ err }, '關閉非使用中裝置的告警失敗,下次再試');
      }
      const targets = await this.store.monitorTargets(new Date(now.getTime() - DAY));
      // 一台失敗(死結、逾時)不影響其他裝置的評估
      for (const t of targets) {
        try {
          const hits = evaluate(t, now, this.thresholds);
          for (const hit of hits) {
            const r = await this.store.openAlert({
              deviceRef: t.deviceRef,
              rule: hit.rule,
              severity: hit.severity,
              detail: JSON.stringify(hit.detail),
              at: now,
            });
            if (r.created) result.opened++;
          }
          for (const rule of t.openRules)
            if (AUTO_RULES.includes(rule) && !hits.some((x) => x.rule === rule) && (await this.store.resolveAuto(t.deviceRef, rule, now, '條件已恢復')))
              result.resolved++;
        } catch (err) {
          ctx.log.warn({ err, deviceRef: t.deviceRef }, '單台裝置告警評估失敗,下次再試');
        }
      }
      if (result.opened || result.resolved) ctx.log.info({ ...result, devices: targets.length }, '告警評估完成');
    } catch (err) {
      ctx.log.warn({ err }, '告警評估失敗,下次再試');
    } finally {
      this.sweeping = false;
    }
    return result;
  }

  // ---------- 管理 API ----------

  async list(ctx: MgmtCtx, q: AlertListQuery): Promise<{ items: AlertView[]; nextCursor: string | null }> {
    const companies = scopeCompanies(ctx.scope);
    if (companies?.length === 0) return { items: [], nextCursor: null };
    let deviceRef: number | undefined;
    if (q.deviceId) {
      const d = await this.sqlDo(ctx, 'device.lookup', () => this.lookup(q.deviceId!));
      // 不存在或範圍外:與「沒有告警」相同,不洩漏存在
      if (!d || !inScope(ctx.scope, d.company)) return { items: [], nextCursor: null };
      deviceRef = d.id;
    }
    const rows = await this.sqlDo(ctx, 'alert.list', () =>
      this.store.listAlerts({ state: q.state, rule: q.rule, severity: q.severity, deviceRef, beforeId: q.beforeId, companies, limit: q.limit }),
    );
    return { items: rows.map(alertView), nextCursor: rows.length === q.limit ? String(rows[rows.length - 1]!.id) : null };
  }

  /** IT 確認後關閉;自動類規則條件仍成立時,下次掃描會再開一筆新的 */
  async resolve(ctx: MgmtCtx, actor: Actor, alertId: string, note: string): Promise<AlertView> {
    const found = await this.sqlDo(ctx, 'alert.get', () => this.store.getAlert(alertId));
    if (!found || !inScope(ctx.scope, found.deviceCompany)) throw new AppError(404, 'ITA_ALERT_NOT_FOUND', '找不到此告警');
    if (found.state !== 'open') throw new AppError(409, 'ITA_ALERT_NOT_OPEN', '此告警已關閉');
    const ok = await this.sqlDo(ctx, 'alert.resolve', () => this.store.resolveManual(alertId, this.now(), actor, note, ctx.requestId));
    if (!ok) throw new AppError(409, 'ITA_ALERT_NOT_OPEN', '此告警已關閉');
    ctx.log.info({ alertId, rule: found.rule, deviceId: found.deviceId, emp: actor.emp }, '告警已手動關閉');
    const after = await this.sqlDo(ctx, 'alert.get', () => this.store.getAlert(alertId));
    return alertView(after ?? found);
  }
}
