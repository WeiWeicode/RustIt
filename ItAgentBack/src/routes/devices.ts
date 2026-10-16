/**
 * 電腦清單 / 詳情(INTEGRATION-PLAN §5、ENDPOINT-AGENT-GUIDE §8.3;P3 擴充見 docs/P3-DATA-DESIGN.md §3):對外 /api/endpoint/devices[/{deviceId}]。
 * 回傳 camelCase,與 GigaItApp 的 EndpointDevice 相容(只新增欄位)。清單不帶軟體清單,只在詳情的 inventory。
 *   - 查詢(endpoint.device.read):清單分頁與篩選、詳情、事件、下載資產 JSON
 *   - 裝置狀態與合併(endpoint.command.admin,指南 §8.2「停用 / 啟用裝置」屬管理等級):x-audit-level: meta,操作人取自內部 Token
 * 資料範圍依 Token 的 cos(所屬公司)過濾(指南 §8.2、§10 E6;docs/E6-COMPANY-SCOPE-DESIGN.md):只回傳、只接受該公司的電腦,範圍外回與不存在相同的 404;
 *   指定所屬公司(PUT /company)只有全部公司角色可用。
 * 路由只驗參數與宣告權限,邏輯在 DeviceService(AGENT.md §8.1)。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import { COMPANY_NAME_MAX } from '../services/company.js';
import type { DeviceService } from '../services/device-service.js';
import type { Actor, DeviceStatus } from '../stores/types.js';
import { mgmtCtx } from './mgmt-ctx.js';

const str = { type: 'string' } as const;
const strOrNull = { type: ['string', 'null'] } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const dateOrNull = { type: ['string', 'null'], format: 'date-time' } as const;
const STATUSES = ['active', 'disabled', 'retired'] as const;
const deviceParams = { type: 'object', properties: { deviceId: uuid }, required: ['deviceId'] } as const;

const summaryProps = {
  deviceId: uuid,
  computerName: str,
  certDn: str,
  certFingerprint: str,
  online: { type: 'boolean' },
  status: { type: 'string', enum: STATUSES },
  firstSeenAt: { type: 'string', format: 'date-time' },
  lastSeenAt: { type: 'string', format: 'date-time' },
  userName: strOrNull,
  domain: strOrNull,
  osName: strOrNull,
  osVersion: strOrNull,
  manufacturer: strOrNull,
  model: strOrNull,
  cpuName: strOrNull,
  memoryTotal: { type: ['integer', 'null'], description: '位元組' },
  ips: { type: 'array', items: str, description: 'IPv4,有閘道的網卡優先' },
  agentVersion: strOrNull,
  lastInventoryAt: dateOrNull,
  suspectedDuplicate: { type: 'boolean', description: '有其他未合併、未退役的裝置硬體指紋相同(疑似同一台)' },
  mergedInto: { type: ['string', 'null'], format: 'uuid', description: '已併入的目標裝置' },
  retiredAt: dateOrNull,
  company: { type: ['string', 'null'], description: '所屬公司(Gateway 公司名稱);null = 未指定,只有可管理所有公司的角色看得到' },
  companySource: { type: ['string', 'null'], enum: ['cert', 'domain', 'manual', null], description: '公司的判定來源:憑證 DN / Agent 回報的網域 / IT 指定' },
} as const;

const summarySchema = { type: 'object', properties: summaryProps } as const;

const listQuery = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 100, description: '電腦名稱、使用者、IP、MAC、裝置代碼(部分比對)' },
    software: { type: 'string', maxLength: 200, description: '軟體名稱(部分比對)' },
    os: { type: 'string', maxLength: 100, description: '作業系統名稱或版本(部分比對)' },
    online: { type: 'boolean' },
    status: {
      type: 'string',
      pattern: '^(active|disabled|retired)(,(active|disabled|retired))*$',
      description: '逗號分隔;預設 active,disabled(不含退役與已合併)',
    },
    company: { type: 'string', maxLength: COMPANY_NAME_MAX, description: '只列此公司;空字串 = 未指定公司(只有可管理所有公司的角色)' },
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  },
} as const;

interface ListQuery {
  q?: string;
  software?: string;
  os?: string;
  online?: boolean;
  status?: string;
  company?: string;
  page: number;
  pageSize: number;
}

const reason = { type: 'string', maxLength: 200, description: '原因(寫入稽核)' } as const;

export function deviceRoutes(service: DeviceService): FastifyPluginAsync {
  return async (app) => {
    const ctx = mgmtCtx;
    const actor = (req: FastifyRequest): Actor => {
      if (!req.identity) throw new AppError(401, 'ITA_INTERNAL_TOKEN_INVALID', '缺少內部 Token');
      return { emp: req.identity.emp ?? req.identity.sub, name: req.identity.name ?? null };
    };
    const id = (req: { params: { deviceId: string } }) => req.params.deviceId.toLowerCase();
    const trimmed = (s: string | undefined) => s?.trim() || undefined;

    app.get<{ Querystring: ListQuery }>(
      '/v1/devices',
      {
        schema: {
          operationId: 'endpoint.device.list',
          summary: '電腦清單',
          description:
            '列出已連線過的端點電腦:名稱、在線狀態、使用者、IP、作業系統、CPU、記憶體、所屬公司、最後回報。只列登入者所屬公司(內部 Token 的 cos)的電腦,可管理所有公司的角色看得到全部(含未指定公司)。分頁(page、pageSize,依電腦名稱排序),可依關鍵字(名稱、使用者、IP、MAC、裝置代碼)、軟體名稱、作業系統、在線、狀態、公司篩選;預設不列退役與已合併的裝置。在線狀態由 Agent 的 WebSocket 心跳決定(90 秒無心跳即離線)。',
          tags: ['端點電腦'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 列出有 Agent 回報的電腦',
            '  假如 電腦 PC-EXAMPLE-01 的 Agent 已回報資產且 WebSocket 在線',
            '  而且 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/devices',
            '  那麼 回應 200',
            '  而且 items 包含 computerName 為 "PC-EXAMPLE-01"、online 為 true 的電腦',
            '場景: 依軟體名稱找電腦',
            '  假如 電腦 PC-EXAMPLE-01 安裝了 7-Zip',
            '  當 呼叫 GET /api/endpoint/devices?software=7-zip',
            '  那麼 回應 200',
            '  而且 items 包含 computerName 為 "PC-EXAMPLE-01" 的電腦',
            '場景: 只看得到自己公司的電腦',
            '  假如 電腦 PC-EXAMPLE-02 屬於另一家公司',
            '  而且 使用者擁有 endpoint.device.read,所屬公司不含該公司',
            '  當 呼叫 GET /api/endpoint/devices',
            '  那麼 items 不包含 PC-EXAMPLE-02',
          ].join('\n'),
          querystring: listQuery,
          response: {
            200: {
              type: 'object',
              properties: {
                items: { type: 'array', items: summarySchema },
                total: { type: 'integer' },
                page: { type: 'integer' },
                pageSize: { type: 'integer' },
              },
            },
          },
        },
      },
      async (req) => {
        const q = req.query;
        return service.listDevices(ctx(req), {
          q: trimmed(q.q),
          software: trimmed(q.software),
          os: trimmed(q.os),
          online: q.online,
          statuses: q.status ? ([...new Set(q.status.split(','))] as DeviceStatus[]) : [],
          company: q.company === undefined ? undefined : q.company.trim() || null,
          page: q.page,
          pageSize: q.pageSize,
        });
      },
    );

    app.get<{ Params: { deviceId: string } }>(
      '/v1/devices/:deviceId',
      {
        schema: {
          operationId: 'endpoint.device.get',
          summary: '電腦詳情',
          description:
            '單一電腦的摘要與最新一份完整資產快照(硬體、網卡、磁碟、防毒、軟體清單),以及硬體指紋相同的其他裝置(疑似同一台,只列資料範圍內的);不存在或不屬於登入者所屬公司回 404 ITA_DEVICE_NOT_FOUND。',
          tags: ['端點電腦'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 查詢不存在的電腦',
            '  假如 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/devices/00000000-0000-4000-8000-000000000000',
            '  那麼 回應 404',
            '  而且 回應的 code 為 "ITA_DEVICE_NOT_FOUND"',
          ].join('\n'),
          params: deviceParams,
          response: {
            200: {
              type: 'object',
              properties: {
                ...summaryProps,
                collectedAt: dateOrNull,
                clockSkewMs: { type: ['integer', 'null'], description: '最近一次 hello 的時鐘偏差(端點 − 主機,毫秒)' },
                suspectedDuplicates: {
                  type: 'array',
                  description: '硬體指紋相同、未合併、未退役的其他裝置',
                  items: {
                    type: 'object',
                    properties: {
                      deviceId: uuid,
                      computerName: str,
                      status: str,
                      firstSeenAt: { type: 'string', format: 'date-time' },
                      lastSeenAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
                inventory: {
                  type: ['object', 'null'],
                  additionalProperties: true,
                  description: 'Agent 的 ComputerInfo(資料契約 inventory.schema.json),鍵名轉 camelCase',
                },
              },
            },
          },
        },
      },
      async (req) => service.getDevice(ctx(req), id(req)),
    );

    app.get<{ Params: { deviceId: string }; Querystring: { cursor?: string; limit: number } }>(
      '/v1/devices/:deviceId/events',
      {
        schema: {
          operationId: 'endpoint.device.events',
          summary: '電腦事件',
          description:
            '這台電腦的事件,依寫入順序新到舊:主機稽核(首次登錄、憑證指紋變更、停用 / 啟用 / 退役、合併、時鐘偏差、疑似同一台)與 Agent 端點事件(USB 插拔、離線期間、Agent 啟動)。端點事件的 occurredAt 為端點上的發生時間,receivedAt 為主機收到時間。',
          tags: ['端點電腦'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 查詢電腦事件',
            '  假如 電腦 PC-EXAMPLE-01 已登錄',
            '  而且 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/devices/{deviceId}/events',
            '  那麼 回應 200',
            '  而且 items 包含 type 為 "registered" 的事件',
          ].join('\n'),
          params: deviceParams,
          querystring: {
            type: 'object',
            properties: {
              cursor: { type: 'string', pattern: '^\\d{1,18}$', description: '上一頁回傳的 nextCursor' },
              limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer' },
                      type: str,
                      occurredAt: { type: 'string', format: 'date-time' },
                      receivedAt: dateOrNull,
                      detail: strOrNull,
                      data: { description: '端點事件內容(event.schema.json 的 data)', nullable: true },
                    },
                  },
                },
                nextCursor: strOrNull,
              },
            },
          },
        },
      },
      async (req) => service.listEvents(ctx(req), id(req), req.query.cursor ? Number(req.query.cursor) : undefined, req.query.limit),
    );

    app.get<{ Params: { deviceId: string } }>(
      '/v1/devices/:deviceId/inventory.json',
      {
        schema: {
          operationId: 'endpoint.device.inventory-download',
          summary: '下載資產 JSON',
          description: '最新一份資產快照原樣下載(資料契約 inventory.schema.json 的 inventory,鍵名 snake_case);尚未回報資產回 404 ITA_INVENTORY_NOT_FOUND。',
          tags: ['端點電腦'],
          'x-permission': 'endpoint.device.read',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 下載資產 JSON',
            '  假如 電腦 PC-EXAMPLE-01 已回報資產',
            '  而且 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/devices/{deviceId}/inventory.json',
            '  那麼 回應 200',
            '  而且 Content-Disposition 檔名為 "PC-EXAMPLE-01-<日期>.json"',
          ].join('\n'),
          params: deviceParams,
        },
      },
      async (req, reply) => {
        const file = await service.inventoryJson(ctx(req), id(req));
        return reply
          .header('content-type', 'application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="${file.fileName}"`)
          .header('x-content-type-options', 'nosniff')
          .header('cache-control', 'no-store')
          .send(file.body);
      },
    );

    app.put<{ Params: { deviceId: string }; Body: { status: DeviceStatus; reason?: string } }>(
      '/v1/devices/:deviceId/status',
      {
        schema: {
          operationId: 'endpoint.device.status',
          summary: '停用 / 啟用 / 退役裝置',
          description:
            '變更裝置狀態並寫稽核:disabled(停用)、retired(退役,清單預設不顯示)立即關閉其 WebSocket,之後 Agent 連線回 403;active 恢復。已併入其他裝置者回 409 ITA_DEVICE_STATUS_INVALID。狀態相同時不變更(changed 為 false)。',
          tags: ['端點電腦'],
          'x-permission': 'endpoint.command.admin',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 停用裝置',
            '  假如 電腦 PC-EXAMPLE-01 的 Agent WebSocket 在線',
            '  而且 使用者擁有 endpoint.command.admin',
            '  當 呼叫 PUT /api/endpoint/devices/{deviceId}/status,status 為 "disabled"',
            '  那麼 回應 200',
            '  而且 Agent 的 WebSocket 被關閉',
          ].join('\n'),
          params: deviceParams,
          body: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: STATUSES }, reason } },
          response: { 200: { type: 'object', properties: { deviceId: uuid, status: { type: 'string', enum: STATUSES }, changed: { type: 'boolean' } } } },
        },
      },
      async (req) => service.setStatus(ctx(req), actor(req), id(req), req.body.status, req.body.reason?.trim() ?? ''),
    );

    app.post<{ Params: { deviceId: string }; Body: { sourceDeviceId: string; reason?: string; force?: boolean } }>(
      '/v1/devices/:deviceId/merge',
      {
        schema: {
          operationId: 'endpoint.device.merge',
          summary: '合併疑似同一台的裝置',
          description:
            '把 sourceDeviceId(重灌、改名、換憑證後的新登錄)併入路徑上的舊裝置:事件、指令紀錄、較新的一份資產搬到舊裝置,舊裝置改用來源目前的憑證,deviceId 不變;來源標記退役並記錄併入對象,其 WebSocket 立即關閉,Agent 重連後即對到舊裝置。兩台尚未結束的指令一律取消(DEVICE_MERGED)。硬體指紋由端點自行回報,只是提示:指紋不同、或新登錄早於舊裝置最後回報(曾同時使用)時需 IT 確認後帶 force: true;舊裝置在線、舊裝置已退役、新登錄已停用 / 退役、任一方已合併過回 409 ITA_MERGE_INVALID。重送同一請求回 alreadyMerged: true。',
          tags: ['端點電腦'],
          'x-permission': 'endpoint.command.admin',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 合併重灌後的新登錄',
            '  假如 電腦 PC-EXAMPLE-01 重灌後以新憑證登錄為另一台裝置,兩者硬體指紋相同',
            '  而且 使用者擁有 endpoint.command.admin',
            '  當 呼叫 POST /api/endpoint/devices/{舊裝置}/merge,sourceDeviceId 為新登錄的裝置',
            '  那麼 回應 200',
            '  而且 新登錄的裝置 mergedInto 為舊裝置',
          ].join('\n'),
          params: deviceParams,
          body: {
            type: 'object',
            required: ['sourceDeviceId'],
            properties: { sourceDeviceId: uuid, reason, force: { type: 'boolean', default: false, description: '硬體指紋不同仍合併' } },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                deviceId: uuid,
                sourceDeviceId: uuid,
                alreadyMerged: { type: 'boolean' },
                events: { type: 'integer', description: '搬到舊裝置的事件數' },
                commands: { type: 'integer', description: '搬到舊裝置的指令數' },
                canceledCommands: { type: 'integer', description: '兩台尚未結束、因合併取消的指令數' },
                inventoryFrom: { type: 'string', enum: ['source', 'target', 'none'], description: '保留哪一邊的資產(較新的一份)' },
              },
            },
          },
        },
      },
      async (req) =>
        service.merge(ctx(req), actor(req), id(req), req.body.sourceDeviceId.toLowerCase(), req.body.reason?.trim() ?? '', req.body.force ?? false),
    );

    app.put<{ Params: { deviceId: string }; Body: { company: string | null; reason?: string } }>(
      '/v1/devices/:deviceId/company',
      {
        schema: {
          operationId: 'endpoint.device.company',
          summary: '指定電腦所屬公司',
          description:
            '指定電腦所屬公司(資料範圍依此過濾:只有該公司的 IT 看得到、管得到),之後不再依憑證或回報網域自動變更;company 為 null 時改回自動判定並立即判定一次。只有可管理所有公司的角色能使用,其他人回 403 ITA_SCOPE_ALL_REQUIRED;已併入其他裝置者回 409 ITA_DEVICE_STATUS_INVALID。公司名稱須與 Gateway 的公司名稱相同。',
          tags: ['端點電腦'],
          'x-permission': 'endpoint.command.admin',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 指定工作群組電腦的公司',
            '  假如 電腦 PC-EXAMPLE-01 未指定公司',
            '  而且 使用者擁有 endpoint.command.admin,且為可管理所有公司的角色',
            '  當 呼叫 PUT /api/endpoint/devices/{deviceId}/company,company 為 "範例公司"',
            '  那麼 回應 200',
            '  而且 companySource 為 "manual"',
            '場景: 一般 IT 不能改公司',
            '  假如 使用者擁有 endpoint.command.admin,但不是可管理所有公司的角色',
            '  當 呼叫 PUT /api/endpoint/devices/{deviceId}/company',
            '  那麼 回應 403',
            '  而且 回應的 code 為 "ITA_SCOPE_ALL_REQUIRED"',
          ].join('\n'),
          params: deviceParams,
          body: {
            type: 'object',
            required: ['company'],
            properties: {
              company: { type: ['string', 'null'], minLength: 1, maxLength: COMPANY_NAME_MAX, pattern: '\\S', description: '公司名稱;null = 改回自動判定' },
              reason,
            },
          },
          response: {
            200: {
              type: 'object',
              properties: { deviceId: uuid, company: summaryProps.company, companySource: summaryProps.companySource, changed: { type: 'boolean' } },
            },
          },
        },
      },
      async (req) => service.setCompany(ctx(req), actor(req), id(req), req.body.company?.trim() ?? null, req.body.reason?.trim() ?? ''),
    );
  };
}
