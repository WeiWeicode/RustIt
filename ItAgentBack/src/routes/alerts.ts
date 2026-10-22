/**
 * 告警(PLATFORM-PLAN §4.3、§5.1;P5-MONITOR-DESIGN §3.3、§4):對外 /api/endpoint/alerts。
 *   - 查詢(endpoint.device.read):依狀態、規則、嚴重度、電腦篩選,新到舊、游標分頁
 *   - 關閉(endpoint.command.basic,需求方 2026-10-19 決定沿用,不新增權限代碼):IT 確認後手動關閉,x-audit-level: meta,操作人取自內部 Token
 * 資料範圍依 Token 的 cos 過濾(E6):只回傳該公司電腦的告警,範圍外回與不存在相同的 404。
 * 路由只驗參數與宣告權限,邏輯在 AlertService(AGENT.md §8.1)。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import type { AlertService } from '../services/alert-service.js';
import type { Actor, AlertRule, AlertSeverity, AlertState } from '../stores/types.js';
import { mgmtCtx } from './mgmt-ctx.js';

const RULES = [
  'offline_long',
  'disk_low',
  'hardware_changed',
  'agent_restarts',
  'cert_expiring',
  'clock_skew',
  'agent_tampered',
  'agent_silent',
  'upgrade_failed',
  'version_mismatch',
  'software_install_failed',
  'reboot_pending',
  'software_file_tampered',
] as const;
const SEVERITIES = ['warn', 'critical'] as const;
const STATES = ['open', 'resolved'] as const;
const strOrNull = { type: ['string', 'null'] } as const;
const dateOrNull = { type: ['string', 'null'], format: 'date-time' } as const;

export const alertSchema = {
  type: 'object',
  properties: {
    alertId: { type: 'string', format: 'uuid' },
    deviceId: { type: 'string', format: 'uuid' },
    computerName: { type: 'string' },
    rule: {
      type: 'string',
      enum: RULES,
      description:
        'offline_long 離線過久、disk_low 磁碟剩餘不足、hardware_changed 硬體變更、agent_restarts Agent 非正常重啟過多、cert_expiring 裝置憑證即將到期、clock_skew 時鐘偏差、agent_tampered Agent / Watchdog 服務被停止或改設定、agent_silent 電腦開著但 Agent 沒有回應、upgrade_failed 升級失敗 2 次或還原失敗、version_mismatch 發佈環目標設定超過 24 小時仍未到目標版本、software_install_failed 軟體安裝失敗、reboot_pending 需要重新開機超過 7 天、software_file_tampered 軟體庫安裝檔被換掉',
    },
    severity: { type: 'string', enum: SEVERITIES },
    state: { type: 'string', enum: STATES },
    openedAt: { type: 'string', format: 'date-time' },
    lastSeenAt: { type: 'string', format: 'date-time', description: '條件仍成立的最近一次評估' },
    resolvedAt: dateOrNull,
    resolvedBy: { type: ['string', 'null'], enum: ['auto', 'manual', null], description: 'auto 條件消失、manual IT 確認' },
    resolvedByEmp: strOrNull,
    resolvedByName: strOrNull,
    resolveNote: strOrNull,
    detail: { description: '規則的數值與依據(例如磁碟代號與剩餘百分比、硬體變更前後)', nullable: true },
  },
} as const;

interface ListQuery {
  state?: AlertState;
  rule?: AlertRule;
  severity?: AlertSeverity;
  deviceId?: string;
  cursor?: string;
  limit: number;
}

export function alertRoutes(alerts: AlertService): FastifyPluginAsync {
  return async (app) => {
    const actor = (req: FastifyRequest): Actor => {
      if (!req.identity) throw new AppError(401, 'ITA_INTERNAL_TOKEN_INVALID', '缺少內部 Token');
      return { emp: req.identity.emp ?? req.identity.sub, name: req.identity.name ?? null };
    };

    app.get<{ Querystring: ListQuery }>(
      '/v1/alerts',
      {
        schema: {
          operationId: 'endpoint.alert.list',
          summary: '告警清單',
          description:
            '端點電腦的告警(固定規則:離線過久、磁碟剩餘不足、硬體變更、Agent 非正常重啟過多、憑證即將到期、時鐘偏差、Agent 服務被停止、電腦開著但 Agent 沒有回應),新到舊。預設只列未結束(state=open);可依規則、嚴重度、電腦篩選。只列登入者所屬公司(內部 Token 的 cos)的電腦。',
          tags: ['端點告警'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 列出未結束的告警',
            '  假如 電腦 PC-EXAMPLE-01 的磁碟剩餘 6%',
            '  而且 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/alerts',
            '  那麼 回應 200',
            '  而且 items 包含 rule 為 "disk_low"、computerName 為 "PC-EXAMPLE-01" 的告警',
          ].join('\n'),
          querystring: {
            type: 'object',
            properties: {
              state: { type: 'string', enum: [...STATES, 'all'], default: 'open', description: 'all = 不篩選' },
              rule: { type: 'string', enum: RULES },
              severity: { type: 'string', enum: SEVERITIES },
              deviceId: { type: 'string', format: 'uuid' },
              cursor: { type: 'string', pattern: '^\\d{1,18}$', description: '上一頁回傳的 nextCursor' },
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          },
          response: { 200: { type: 'object', properties: { items: { type: 'array', items: alertSchema }, nextCursor: strOrNull } } },
        },
      },
      async (req) => {
        const q = req.query;
        return alerts.list(mgmtCtx(req), {
          state: (q.state as string) === 'all' ? undefined : (q.state ?? 'open'),
          rule: q.rule,
          severity: q.severity,
          deviceId: q.deviceId?.toLowerCase(),
          beforeId: q.cursor ? Number(q.cursor) : undefined,
          limit: q.limit,
        });
      },
    );

    app.post<{ Params: { alertId: string }; Body: { note: string } }>(
      '/v1/alerts/:alertId/resolve',
      {
        schema: {
          operationId: 'endpoint.alert.resolve',
          summary: '關閉告警',
          description:
            'IT 確認後手動關閉一筆未結束的告警並記錄操作人與說明。硬體變更、服務被停止這類告警不會自動消失,需要在這裡關閉;自動類規則(例如磁碟剩餘不足)若條件仍成立,下次評估(每 5 分鐘)會再開一筆新的。已關閉回 409 ITA_ALERT_NOT_OPEN,不存在或不屬於登入者所屬公司回 404 ITA_ALERT_NOT_FOUND。',
          tags: ['端點告警'],
          'x-permission': 'endpoint.command.basic',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 確認硬體變更後關閉告警',
            '  假如 電腦 PC-EXAMPLE-01 有一筆未結束的 hardware_changed 告警',
            '  而且 使用者擁有 endpoint.command.basic',
            '  當 呼叫 POST /api/endpoint/alerts/{alertId}/resolve,note 為 "更換記憶體,已確認"',
            '  那麼 回應 200',
            '  而且 state 為 "resolved"、resolvedBy 為 "manual"',
          ].join('\n'),
          params: { type: 'object', required: ['alertId'], properties: { alertId: { type: 'string', format: 'uuid' } } },
          body: {
            type: 'object',
            required: ['note'],
            properties: { note: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S', description: '確認說明(寫入稽核)' } },
          },
          response: { 200: alertSchema },
        },
      },
      async (req) => alerts.resolve(mgmtCtx(req), actor(req), req.params.alertId.toLowerCase(), req.body.note.trim()),
    );
  };
}
