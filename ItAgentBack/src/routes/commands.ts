/**
 * 指令 API(ENDPOINT-AGENT-GUIDE §8.2–§8.3;PLATFORM-PLAN P4 §4.4、§5.3):對外 /api/endpoint/*,權限由 BFF 依 x-permission 檢查。
 *   - 依風險拆路徑:basic-commands 只接受 basic 類型、admin-commands 只接受 admin 類型(否則 400 ENDPOINT_COMMAND_LEVEL_MISMATCH);
 *     admin 類型 agent.upgrade(P6)、software.install / software.uninstall / system.reboot(P7)。admin 批次只開軟體派送
 *     (POST /software/{id}/deploy,routes/software.ts);超過門檻的批次待第二人核可:POST /batches/{id}/approve、/reject(B1)
 *   - POST 支援 Idempotency-Key(同一工號 + 同一 key 回傳既有的那筆);建立指令設 x-audit-level: meta,不設 x-cache-ttl
 *   - 操作人(工號、姓名)取自內部 Token,寫入稽核(§8.5)
 *   - 指令附檔(logs.collect 日誌,P4-2):GET /commands/{id} 回應帶 files;下載 GET /commands/{id}/files/{fileId}(x-audit-level: meta)
 *   - 資料範圍(E6):指令跟著裝置目前的公司,只回傳、只接受登入者所屬公司的電腦;範圍外與不存在同樣回 404
 * 路由只驗參數與宣告權限,邏輯在 CommandDispatcher(AGENT.md §8.1)。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { COMMAND_KINDS, EXPIRES_MAX_SEC, EXPIRES_MIN_SEC } from '../commands/kinds.js';
import { AppError } from '../errors.js';
import { BATCH_MAX_DEVICES, type CommandDispatcher } from '../services/command-dispatcher.js';
import type { CommandFileService } from '../services/command-files.js';
import type { CommandState } from '../stores/types.js';
import { mgmtCtx } from './mgmt-ctx.js';

const STATES = ['queued', 'sent', 'acked', 'running', 'succeeded', 'failed', 'canceled', 'expired'] as const;
const BASIC_KINDS = COMMAND_KINDS.filter((k) => k.level === 'basic').map((k) => k.kind);
const ADMIN_KINDS = COMMAND_KINDS.filter((k) => k.level === 'admin').map((k) => k.kind);
const uuid = { type: 'string', format: 'uuid' } as const;
const strOrNull = { type: ['string', 'null'] } as const;
const dateOrNull = { type: ['string', 'null'], format: 'date-time' } as const;

const commandSchema = {
  type: 'object',
  properties: {
    commandId: uuid,
    batchId: { type: ['string', 'null'], format: 'uuid' },
    batchState: {
      type: ['string', 'null'],
      enum: ['pending_approval', 'running', 'done', 'rejected', 'expired', null],
      description: '所屬批次狀態;軟體派送 / 重開機同一人 24 小時內累計超過門檻時,單台指令也會進入 pending_approval 的單台批次,需第二人核可',
    },
    deviceId: uuid,
    computerName: { type: 'string' },
    kind: { type: 'string' },
    level: { type: 'string', enum: ['basic', 'admin'] },
    params: { type: 'object', additionalProperties: true },
    state: { type: 'string', enum: STATES },
    progress: { type: ['integer', 'null'] },
    result: { type: ['object', 'null'], additionalProperties: true },
    errorCode: strOrNull,
    errorMessage: strOrNull,
    expiresAt: { type: 'string', format: 'date-time' },
    sendCount: { type: 'integer' },
    createdBy: { type: 'object', properties: { emp: { type: 'string' }, name: strOrNull } },
    requestId: strOrNull,
    createdAt: { type: 'string', format: 'date-time' },
    sentAt: dateOrNull,
    ackedAt: dateOrNull,
    startedAt: dateOrNull,
    finishedAt: dateOrNull,
    files: {
      type: 'array',
      description: '指令附檔(logs.collect 的日誌 zip);只在 GET /commands/{commandId} 回傳',
      items: {
        type: 'object',
        properties: {
          fileId: uuid,
          fileName: { type: 'string' },
          sizeBytes: { type: 'integer' },
          sha256: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          expired: { type: 'boolean' },
        },
      },
    },
  },
} as const;

const createBody = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      maxLength: 64,
      description: `指令類型(docs/contracts/command-kinds.md);basic:${BASIC_KINDS.join('、')};admin:${ADMIN_KINDS.join('、')}`,
    },
    params: { type: 'object', additionalProperties: true, description: '依類型定義' },
    expiresInSec: { type: 'integer', minimum: EXPIRES_MIN_SEC, maximum: EXPIRES_MAX_SEC, description: '有效期限(秒);省略用類型預設(1 小時)' },
  },
} as const;

const idemHeaders = {
  type: 'object',
  properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7e]+$', description: '重複送出時回傳同一筆' } },
} as const;

const listQuery = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: STATES },
    kind: { type: 'string', maxLength: 64 },
    batchId: uuid,
    cursor: { type: 'string', pattern: '^\\d+$', description: '上一頁回傳的 nextCursor' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
} as const;

const listResponse = { type: 'object', properties: { items: { type: 'array', items: commandSchema }, nextCursor: strOrNull } } as const;

const BATCH_STATES = ['pending_approval', 'running', 'done', 'rejected', 'expired'] as const;
const actorOrNull = { type: ['object', 'null'], properties: { emp: { type: 'string' }, name: strOrNull } } as const;
const batchSchema = {
  type: 'object',
  properties: {
    batchId: uuid,
    kind: { type: 'string' },
    level: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
    targetCount: { type: 'integer' },
    maxConcurrent: { type: 'integer' },
    state: { type: 'string', enum: BATCH_STATES, description: 'pending_approval 待第二人核可(指令不送出);rejected / expired 的指令皆已取消' },
    requiresApproval: { type: 'boolean' },
    approvalExpiresAt: dateOrNull,
    approvedBy: actorOrNull,
    approvedAt: dateOrNull,
    rejectedBy: actorOrNull,
    rejectedAt: dateOrNull,
    rejectReason: strOrNull,
    createdBy: { type: 'object', properties: { emp: { type: 'string' }, name: strOrNull } },
    createdAt: { type: 'string', format: 'date-time' },
    counts: { type: 'object', additionalProperties: { type: 'integer' } },
  },
} as const;

interface CreateBody {
  kind: string;
  params?: Record<string, unknown>;
  expiresInSec?: number;
}
interface ListQuery {
  state?: CommandState;
  kind?: string;
  batchId?: string;
  cursor?: string;
  limit?: number;
}

export function commandRoutes(commands: CommandDispatcher, files?: CommandFileService): FastifyPluginAsync {
  return async (app) => {
    const ctx = mgmtCtx;
    const who = (req: FastifyRequest) => {
      if (!req.identity) throw new AppError(401, 'ITA_INTERNAL_TOKEN_INVALID', '缺少內部 Token');
      return req.identity;
    };
    const idemKey = (req: FastifyRequest) => (req.headers['idempotency-key'] as string | undefined) || undefined;

    app.post<{ Params: { deviceId: string }; Body: CreateBody }>(
      '/v1/devices/:deviceId/basic-commands',
      {
        schema: {
          operationId: 'endpoint.command.basic.create',
          summary: '建立一般指令',
          description:
            '對一台電腦建立沒有破壞性的指令(立即蒐集資產、重啟 Agent、傳送訊息)。先寫入資料庫再從 Agent 的 WebSocket 推送;電腦離線時排隊,重連後送出,超過有效期限未送達即 expired。回 202 與 commandId,前端以 GET /commands/{commandId} 輪詢結果。類型不屬於 basic 回 400 ENDPOINT_COMMAND_LEVEL_MISMATCH。',
          tags: ['端點指令'],
          'x-permission': 'endpoint.command.basic',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 對在線電腦立即蒐集資產',
            '  假如 電腦 PC-EXAMPLE-01 的 Agent WebSocket 在線',
            '  而且 使用者擁有 endpoint.command.basic',
            '  當 呼叫 POST /api/endpoint/devices/{deviceId}/basic-commands,kind 為 "inventory.collect"',
            '  那麼 回應 202',
            '  而且 state 為 "sent"',
            '場景: 從一般指令路徑送出管理指令',
            '  當 呼叫 POST /api/endpoint/devices/{deviceId}/basic-commands,kind 為 "system.reboot"',
            '  那麼 回應 400',
          ].join('\n'),
          params: { type: 'object', properties: { deviceId: uuid }, required: ['deviceId'] },
          headers: idemHeaders,
          body: createBody,
          response: { 202: commandSchema },
        },
      },
      async (req, reply) => {
        const view = await commands.create(ctx(req), who(req), 'basic', req.params.deviceId.toLowerCase(), { ...req.body, idempotencyKey: idemKey(req) });
        return reply.status(202).send(view);
      },
    );

    app.post<{ Params: { deviceId: string }; Body: CreateBody }>(
      '/v1/devices/:deviceId/admin-commands',
      {
        schema: {
          operationId: 'endpoint.command.admin.create',
          summary: '建立管理指令',
          description:
            '對一台電腦建立會影響使用者或系統的指令:agent.upgrade(立即檢查升級或指定版本)、software.install / software.uninstall(params 只帶 packageId,主機換成目錄快照)、system.reboot。流程同一般指令,回 202 與 commandId。類型不屬於 admin 回 400 ENDPOINT_COMMAND_LEVEL_MISMATCH;agent.upgrade 指定的版本未登錄回 404 ITA_RELEASE_NOT_FOUND、未發佈或已撤回回 409;軟體套件不存在 404 ITA_PACKAGE_NOT_FOUND、未發佈套件派到非 pilot 電腦 409 ITA_PACKAGE_NOT_PUBLISHED、已撤回 409 ITA_PACKAGE_REVOKED、超過授權數 409 ITA_LICENSE_EXCEEDED。',
          tags: ['端點指令'],
          'x-permission': 'endpoint.command.admin',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 要求電腦立即檢查 Agent 升級',
            '  假如 使用者擁有 endpoint.command.admin',
            '  當 呼叫 POST /api/endpoint/devices/{deviceId}/admin-commands,kind 為 "agent.upgrade"、params 為 {"component":"agent"}',
            '  那麼 回應 202',
            '場景: 對測試機安裝尚未發佈的軟體',
            '  假如 7-Zip 24.09 為 draft,電腦在 pilot 環',
            '  當 呼叫 POST /api/endpoint/devices/{deviceId}/admin-commands,kind 為 "software.install"、params 為 {"packageId":"{packageId}"}',
            '  那麼 回應 202',
            '  而且 params.sha256 為套件的 SHA-256',
            '場景: 從管理指令路徑送出一般指令',
            '  當 呼叫 POST /api/endpoint/devices/{deviceId}/admin-commands,kind 為 "inventory.collect"',
            '  那麼 回應 400',
          ].join('\n'),
          params: { type: 'object', properties: { deviceId: uuid }, required: ['deviceId'] },
          headers: idemHeaders,
          body: createBody,
          response: { 202: commandSchema },
        },
      },
      async (req, reply) => {
        const view = await commands.create(ctx(req), who(req), 'admin', req.params.deviceId.toLowerCase(), { ...req.body, idempotencyKey: idemKey(req) });
        return reply.status(202).send(view);
      },
    );

    app.post<{ Body: CreateBody & { deviceIds: string[] } }>(
      '/v1/batches/basic-commands',
      {
        schema: {
          operationId: 'endpoint.command.basic.batch',
          summary: '批次建立一般指令',
          description: `多台電腦同一個一般指令(最多 ${BATCH_MAX_DEVICES} 台);任一台不存在或已停用則整批不建立。同時執行台數上限 20,其餘排隊依序送出。回 202 與 batchId、各台 commandId。`,
          tags: ['端點指令'],
          'x-permission': 'endpoint.command.basic',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 對兩台電腦立即蒐集資產',
            '  假如 使用者擁有 endpoint.command.basic',
            '  當 呼叫 POST /api/endpoint/batches/basic-commands,deviceIds 兩台、kind 為 "inventory.collect"',
            '  那麼 回應 202',
            '  而且 commands 有 2 筆',
          ].join('\n'),
          headers: idemHeaders,
          body: {
            ...createBody,
            required: ['deviceIds', 'kind'],
            properties: { ...createBody.properties, deviceIds: { type: 'array', minItems: 1, maxItems: BATCH_MAX_DEVICES, items: uuid } },
          },
          response: {
            202: {
              type: 'object',
              properties: {
                batchId: uuid,
                state: { type: 'string', enum: BATCH_STATES },
                requiresApproval: { type: 'boolean' },
                commands: {
                  type: 'array',
                  items: { type: 'object', properties: { deviceId: uuid, commandId: uuid, state: { type: 'string', enum: STATES } } },
                },
              },
            },
          },
        },
      },
      async (req, reply) => {
        const { deviceIds, ...input } = req.body;
        return reply.status(202).send(await commands.createBatch(ctx(req), who(req), 'basic', deviceIds, { ...input, idempotencyKey: idemKey(req) }));
      },
    );

    app.post<{ Params: { commandId: string } }>(
      '/v1/commands/:commandId/cancel',
      {
        schema: {
          operationId: 'endpoint.command.cancel',
          summary: '取消指令',
          description: '只能取消自己建立、尚未送出(queued)的指令;別人建立的回 403 ITA_COMMAND_NOT_OWNER,已送出或已結束回 409 ITA_COMMAND_NOT_CANCELABLE。',
          tags: ['端點指令'],
          'x-permission': 'endpoint.command.basic',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 取消已送出的指令',
            '  假如 指令已推送到 Agent(state 為 "sent")',
            '  當 建立人呼叫 POST /api/endpoint/commands/{commandId}/cancel',
            '  那麼 回應 409',
            '  而且 回應的 code 為 "ITA_COMMAND_NOT_CANCELABLE"',
          ].join('\n'),
          params: { type: 'object', properties: { commandId: uuid }, required: ['commandId'] },
          response: { 200: commandSchema },
        },
      },
      async (req) => commands.cancel(ctx(req), who(req), req.params.commandId.toLowerCase()),
    );

    app.get<{ Params: { commandId: string } }>(
      '/v1/commands/:commandId',
      {
        schema: {
          operationId: 'endpoint.command.get',
          summary: '指令狀態與結果',
          description:
            '指令的狀態(queued / sent / acked / running / succeeded / failed / canceled / expired)、結果摘要、錯誤代碼與稽核欄位;執行中由前端每 2 秒輪詢。logs.collect 另回 files(日誌 zip,以 GET /commands/{commandId}/files/{fileId} 下載)。',
          tags: ['端點指令'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 查詢不存在的指令',
            '  假如 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/commands/00000000-0000-4000-8000-000000000000',
            '  那麼 回應 404',
            '  而且 回應的 code 為 "ITA_COMMAND_NOT_FOUND"',
          ].join('\n'),
          params: { type: 'object', properties: { commandId: uuid }, required: ['commandId'] },
          response: { 200: commandSchema },
        },
      },
      async (req) => {
        const id = req.params.commandId.toLowerCase();
        const view = await commands.get(ctx(req), id);
        return files ? { ...view, files: await files.forCommand(ctx(req), id) } : view;
      },
    );

    if (files)
      app.get<{ Params: { commandId: string; fileId: string } }>(
        '/v1/commands/:commandId/files/:fileId',
        {
          schema: {
            operationId: 'endpoint.command.file.download',
            summary: '下載指令附檔',
            description:
              '下載 logs.collect 上傳的 Agent 日誌(zip)。檔案保存 14 天,超過回 410 ITA_COMMAND_FILE_EXPIRED;fileId 不屬於此指令回 404 ITA_COMMAND_FILE_NOT_FOUND。日誌可能含電腦名稱、登入帳號與 IP,下載會記錄稽核。',
            tags: ['端點指令'],
            'x-permission': 'endpoint.device.read',
            'x-audit-level': 'meta',
            'x-gherkin': [
              '場景: 下載已過期的日誌',
              '  假如 logs.collect 指令的附檔已超過保存期限',
              '  當 呼叫 GET /api/endpoint/commands/{commandId}/files/{fileId}',
              '  那麼 回應 410',
              '  而且 回應的 code 為 "ITA_COMMAND_FILE_EXPIRED"',
            ].join('\n'),
            params: { type: 'object', properties: { commandId: uuid, fileId: uuid }, required: ['commandId', 'fileId'] },
            response: { 200: { description: '日誌 zip', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } } },
          },
        },
        async (req, reply) => {
          const { file, stream } = await files.open(ctx(req), req.params.commandId.toLowerCase(), req.params.fileId.toLowerCase());
          return reply
            .header('content-type', 'application/zip')
            .header('content-length', String(file.sizeBytes))
            .header('content-disposition', `attachment; filename="${file.fileName}"`)
            .header('x-content-type-options', 'nosniff')
            .header('cache-control', 'no-store')
            .header('x-file-sha256', file.sha256)
            .send(stream);
        },
      );

    app.get<{ Params: { deviceId: string }; Querystring: ListQuery }>(
      '/v1/devices/:deviceId/commands',
      {
        schema: {
          // operationId 只能小寫(Gateway 匯入格式 {system}.{resource}.{action})
          operationId: 'endpoint.command.list-by-device',
          summary: '電腦的指令紀錄',
          description: '該電腦的指令,新到舊;每頁最多 100 筆,以 nextCursor 取下一頁。',
          tags: ['端點指令'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 查詢電腦的指令紀錄',
            '  假如 電腦 PC-EXAMPLE-01 有一筆 inventory.collect 指令',
            '  當 呼叫 GET /api/endpoint/devices/{deviceId}/commands',
            '  那麼 回應 200',
            '  而且 items 包含 kind 為 "inventory.collect" 的指令',
          ].join('\n'),
          params: { type: 'object', properties: { deviceId: uuid }, required: ['deviceId'] },
          querystring: listQuery,
          response: { 200: listResponse },
        },
      },
      async (req) => commands.list(ctx(req), { ...req.query, deviceId: req.params.deviceId.toLowerCase() }),
    );

    app.get<{ Querystring: ListQuery }>(
      '/v1/commands',
      {
        schema: {
          operationId: 'endpoint.command.list',
          summary: '全部指令紀錄',
          description: '所有電腦的指令,新到舊;可依狀態、類型、批次篩選,以 nextCursor 取下一頁。',
          tags: ['端點指令'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 列出失敗的指令',
            '  假如 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/commands?state=failed',
            '  那麼 回應 200',
            '  而且 items 的 state 皆為 "failed"',
          ].join('\n'),
          querystring: listQuery,
          response: { 200: listResponse },
        },
      },
      async (req) => commands.list(ctx(req), { ...req.query, batchId: req.query.batchId?.toLowerCase() }),
    );

    app.get<{ Params: { batchId: string } }>(
      '/v1/batches/:batchId',
      {
        schema: {
          operationId: 'endpoint.command.batch.get',
          summary: '批次狀態',
          description: '批次的指令類型、台數、同時執行上限、狀態(含第二人核可資訊)與各狀態台數;各台明細以 GET /commands?batchId= 查詢。',
          tags: ['端點指令'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 查詢不存在的批次',
            '  當 呼叫 GET /api/endpoint/batches/00000000-0000-4000-8000-000000000000',
            '  那麼 回應 404',
            '  而且 回應的 code 為 "ITA_BATCH_NOT_FOUND"',
          ].join('\n'),
          params: { type: 'object', properties: { batchId: uuid }, required: ['batchId'] },
          response: { 200: batchSchema },
        },
      },
      async (req) => commands.getBatch(ctx(req), req.params.batchId.toLowerCase()),
    );

    // 第二人核可(PLATFORM-PLAN B1;P7-SOFTWARE-DESIGN §6):核可人需資料範圍涵蓋批次全部電腦(否則 404,同不存在)
    app.post<{ Params: { batchId: string } }>(
      '/v1/batches/:batchId/approve',
      {
        schema: {
          operationId: 'endpoint.command.batch.approve',
          summary: '核可批次',
          description:
            '待核可(pending_approval)的批次由建立人以外的 IT 核可後開始送出,指令有效期限自核可時起算。核可人是建立人回 403 ITA_APPROVER_SAME_AS_CREATOR;不是待核可或已超過 24 小時回 409 ITA_BATCH_NOT_PENDING。核可前應確認套件、安裝參數、簽章者、雜湊、目標台數與並行數。',
          tags: ['端點指令'],
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 建立人自己核可',
            '  假如 S000001 建立了 21 台的軟體派送批次',
            '  當 S000001 呼叫 POST /api/endpoint/batches/{batchId}/approve',
            '  那麼 回應 403',
            '  而且 回應的 code 為 "ITA_APPROVER_SAME_AS_CREATOR"',
          ].join('\n'),
          params: { type: 'object', properties: { batchId: uuid }, required: ['batchId'] },
          response: { 200: batchSchema },
        },
      },
      async (req) => commands.approveBatch(ctx(req), who(req), req.params.batchId.toLowerCase()),
    );

    app.post<{ Params: { batchId: string }; Body: { reason: string } }>(
      '/v1/batches/:batchId/reject',
      {
        schema: {
          operationId: 'endpoint.command.batch.reject',
          summary: '駁回批次',
          description: '駁回待核可的批次(建立人也可撤回自己的批次),批次內指令全部取消。不是待核可回 409 ITA_BATCH_NOT_PENDING。',
          tags: ['端點指令'],
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 駁回待核可的批次',
            '  假如 批次為 pending_approval',
            '  當 呼叫 POST /api/endpoint/batches/{batchId}/reject,reason 為 "目標電腦有誤"',
            '  那麼 回應 200',
            '  而且 state 為 "rejected"',
          ].join('\n'),
          params: { type: 'object', properties: { batchId: uuid }, required: ['batchId'] },
          body: {
            type: 'object',
            required: ['reason'],
            additionalProperties: false,
            properties: { reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '^[^\\u0000-\\u001F\\u007F]+$' } },
          },
          response: { 200: batchSchema },
        },
      },
      async (req) => commands.rejectBatch(ctx(req), who(req), req.params.batchId.toLowerCase(), req.body.reason.trim()),
    );
  };
}
