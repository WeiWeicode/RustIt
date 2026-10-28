/**
 * 升級(PLATFORM-PLAN §4.5、§5.3;P6-UPGRADE-DESIGN §3.2):對外 /api/endpoint/releases、/release-rings、/devices/{id}/ring、/devices/{id}/upgrade。
 *   - 查詢(endpoint.device.read):版本清單、未登錄的版本檔、發佈環目標與進度、裝置升級狀態
 *   - 版本登錄、發佈 / 撤回、環目標(endpoint.software.manage,且需全部公司角色,需求方 2026-10-20 §9-5):x-audit-level: meta
 *   - 裝置所屬環(endpoint.command.admin,PLATFORM-PLAN §5.3)
 *   - 版本號查重(endpoint.release.registry,Gateway auth_mode = api_key):上架腳本以 API Key 呼叫(S1-SIGNING-DESIGN §2)
 * 路由只驗參數與宣告權限,邏輯在 ReleaseService(AGENT.md §8.1)。
 */
import type { GatewayIdentity } from '@giganexus/backend-sdk';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import type { RegisterInput, ReleaseService } from '../services/release-service.js';
import type { ReleaseComponent, ReleaseStatus, Ring } from '../stores/types.js';
import { mgmtCtx } from './mgmt-ctx.js';

const COMPONENTS = ['agent', 'watchdog'] as const;
const STATUSES = ['draft', 'published', 'revoked'] as const;
const RINGS = ['pilot', 'it', 'all'] as const;
const VERSION = { type: 'string', pattern: '^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}(?:-[0-9A-Za-z.-]{1,20})?$', description: 'x.y.z,可帶 -後綴' } as const;
const strOrNull = { type: ['string', 'null'] } as const;
const dateOrNull = { type: ['string', 'null'], format: 'date-time' } as const;
const TAGS = ['端點升級'];

const releaseSchema = {
  type: 'object',
  properties: {
    releaseId: { type: 'string', format: 'uuid' },
    component: { type: 'string', enum: COMPONENTS },
    version: { type: 'string' },
    fileName: { type: 'string' },
    sha256: { type: 'string', description: '登錄時由主機計算' },
    sizeBytes: { type: 'integer' },
    signerThumbprints: { type: 'array', items: { type: 'string' }, description: '預期簽章者憑證 SHA-1 指紋' },
    status: { type: 'string', enum: STATUSES, description: 'draft 只能設給 pilot 環;revoked 不再下發' },
    notes: strOrNull,
    createdBy: { type: 'object', properties: { emp: { type: 'string' }, name: strOrNull } },
    createdAt: { type: 'string', format: 'date-time' },
    publishedByEmp: strOrNull,
    publishedAt: dateOrNull,
    revokedByEmp: strOrNull,
    revokedAt: dateOrNull,
  },
} as const;

const progressSchema = {
  type: 'object',
  description: '只計登入者資料範圍內、未被指定強制版本的電腦',
  properties: {
    total: { type: 'integer' },
    atTarget: { type: 'integer' },
    inProgress: { type: 'integer' },
    failed: { type: 'integer' },
    waiting: { type: 'integer', description: '尚未開始(含未回報、等待同時升級上限)' },
  },
} as const;

const ringSchema = {
  type: 'object',
  properties: {
    ring: { type: 'string', enum: RINGS },
    component: { type: 'string', enum: COMPONENTS },
    targetVersion: strOrNull,
    targetSetAt: dateOrNull,
    updatedBy: { type: 'object', properties: { emp: strOrNull, name: strOrNull } },
    updatedAt: { type: 'string', format: 'date-time' },
    progress: progressSchema,
  },
} as const;

const deviceUpgradeSchema = {
  type: 'object',
  properties: {
    deviceId: { type: 'string', format: 'uuid' },
    ring: { type: 'string', enum: RINGS },
    upgrades: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component: { type: 'string', enum: COMPONENTS },
          currentVersion: strOrNull,
          targetVersion: strOrNull,
          targetSource: { type: ['string', 'null'], enum: ['forced', 'ring', null], description: 'forced = agent.upgrade 指定的版本' },
          state: { type: ['string', 'null'], enum: ['pending', 'downloading', 'verifying', 'installing', 'succeeded', 'failed', 'rolled_back', null] },
          attempts: { type: 'integer' },
          errorCode: strOrNull,
          errorMessage: strOrNull,
          forcedBy: strOrNull,
          updatedAt: dateOrNull,
        },
      },
    },
  },
} as const;

const releaseIdParams = { type: 'object', required: ['releaseId'], properties: { releaseId: { type: 'string', format: 'uuid' } } } as const;
const deviceIdParams = { type: 'object', required: ['deviceId'], properties: { deviceId: { type: 'string', format: 'uuid' } } } as const;

/** gwEnv:本服務所在部署區,版本號查重回傳給上架腳本確認查到的是目標區 */
export function releaseRoutes(releases: ReleaseService, gwEnv: string): FastifyPluginAsync {
  return async (app) => {
    const who = (req: FastifyRequest): GatewayIdentity => {
      if (!req.identity) throw new AppError(401, 'ITA_INTERNAL_TOKEN_INVALID', '缺少內部 Token');
      return req.identity;
    };

    app.get<{ Querystring: { component?: ReleaseComponent; status?: ReleaseStatus } }>(
      '/v1/releases',
      {
        schema: {
          operationId: 'endpoint.release.list',
          summary: 'Agent 版本清單',
          description: '已登錄的 Agent / Watchdog 版本(新到舊),可依元件與狀態篩選。',
          tags: TAGS,
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 列出已登錄的 Agent 版本',
            '  假如 已登錄 agent 0.7.1',
            '  而且 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/releases?component=agent',
            '  那麼 回應 200',
            '  而且 items 包含 version 為 "0.7.1" 的版本',
          ].join('\n'),
          querystring: { type: 'object', properties: { component: { type: 'string', enum: COMPONENTS }, status: { type: 'string', enum: STATUSES } } },
          response: { 200: { type: 'object', properties: { items: { type: 'array', items: releaseSchema } } } },
        },
      },
      async (req) => releases.list(mgmtCtx(req), req.query),
    );

    app.get(
      '/v1/releases/files',
      {
        schema: {
          operationId: 'endpoint.release.files',
          summary: '尚未登錄的版本檔',
          description: '版本檔目錄({元件}/{版本}/{檔名})中尚未登錄的檔案,給登錄畫面挑選。簽章人員把已簽章的檔案放進目錄後才會出現。',
          tags: TAGS,
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 列出尚未登錄的版本檔',
            '  假如 版本檔目錄有 agent/0.7.1/rustit-agent.exe 且尚未登錄',
            '  當 呼叫 GET /api/endpoint/releases/files',
            '  那麼 回應 200',
            '  而且 items 包含 version 為 "0.7.1"、fileName 為 "rustit-agent.exe" 的檔案',
          ].join('\n'),
          response: {
            200: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      component: { type: 'string', enum: COMPONENTS },
                      version: { type: 'string' },
                      fileName: { type: 'string' },
                      sizeBytes: { type: 'integer' },
                      modifiedAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (req) => releases.unregisteredFiles(mgmtCtx(req)),
    );

    app.get<{ Querystring: { component: ReleaseComponent; version: string } }>(
      '/v1/releases/registry',
      {
        schema: {
          operationId: 'endpoint.release.registry',
          summary: '版本號查重(上架腳本)',
          description:
            '上架腳本放檔前確認同一元件同一版本號是否已登錄(含已撤回,撤回的版本號也不能重用)。系統對系統路由:以 API Key 呼叫,只回元件、版本、狀態與所在部署區(environment),不含檔案路徑與簽章者。',
          tags: TAGS,
          'x-auth-mode': 'api_key',
          'x-permission': 'endpoint.release.registry',
          'x-gherkin': [
            '場景: 上架前查詢版本號是否已登錄',
            '  假如 測試區已登錄 agent 0.7.1 且已撤回',
            '  而且 API Key 具備 endpoint.release.registry',
            '  當 以 X-Api-Key 呼叫 GET /api/endpoint/releases/registry?component=agent&version=0.7.1',
            '  那麼 回應 200',
            '  而且 environment 為 "test"',
            '  而且 items 包含 version 為 "0.7.1"、status 為 "revoked" 的版本',
          ].join('\n'),
          querystring: {
            type: 'object',
            required: ['component', 'version'],
            additionalProperties: false,
            properties: { component: { type: 'string', enum: COMPONENTS }, version: VERSION },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                environment: { type: 'string', description: '本服務所在部署區(GW_ENV)' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { component: { type: 'string', enum: COMPONENTS }, version: { type: 'string' }, status: { type: 'string', enum: STATUSES } },
                  },
                },
              },
            },
          },
        },
      },
      async (req) => ({ environment: gwEnv, ...(await releases.registry(mgmtCtx(req), req.query.component, req.query.version)) }),
    );

    app.post<{ Body: RegisterInput }>(
      '/v1/releases',
      {
        schema: {
          operationId: 'endpoint.release.register',
          summary: '登錄 Agent 版本',
          description:
            '把版本檔目錄中已簽章的檔案登錄為 draft 版本;SHA-256 與大小由主機讀檔計算。預期簽章者填簽章憑證的 SHA-1 指紋(端點驗證 Authenticode 時比對)。只有可管理所有公司的角色可用(其他回 403 ITA_SCOPE_ALL_REQUIRED);同一元件同一版本已登錄回 409 ITA_RELEASE_EXISTS。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 登錄新版 Agent',
            '  假如 版本檔目錄有 agent/0.7.1/rustit-agent.exe',
            '  而且 使用者擁有 endpoint.software.manage 且可管理所有公司',
            '  當 呼叫 POST /api/endpoint/releases,component 為 "agent"、version 為 "0.7.1"、fileName 為 "rustit-agent.exe"',
            '  那麼 回應 200',
            '  而且 status 為 "draft"、sha256 為檔案的 SHA-256',
          ].join('\n'),
          body: {
            type: 'object',
            required: ['component', 'version', 'fileName', 'signerThumbprints'],
            additionalProperties: false,
            properties: {
              component: { type: 'string', enum: COMPONENTS },
              version: VERSION,
              fileName: { type: 'string', pattern: '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$' },
              signerThumbprints: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^[0-9A-Fa-f]{40}$' } },
              notes: { type: 'string', maxLength: 1000 },
            },
          },
          response: { 200: releaseSchema },
        },
      },
      async (req) => releases.register(mgmtCtx(req), who(req), req.body),
    );

    for (const [action, to, summary, text] of [
      ['publish', 'published', '發佈版本', 'draft 改為 published,之後才能設為 it / all 環的目標'],
      ['revoke', 'revoked', '撤回版本', '不再下發;以此版本為目標的環改為不升級、指定此版本的強制升級一併清除(回傳 clearedRings)'],
    ] as const)
      app.post<{ Params: { releaseId: string } }>(
        `/v1/releases/:releaseId/${action}`,
        {
          schema: {
            operationId: `endpoint.release.${action}`,
            summary,
            description: `${text}。只有可管理所有公司的角色可用;狀態不符回 409 ITA_RELEASE_STATUS。`,
            tags: TAGS,
            'x-permission': 'endpoint.software.manage',
            'x-audit-level': 'meta',
            'x-gherkin': [
              `場景: ${summary}`,
              '  假如 agent 0.7.1 已登錄',
              '  而且 使用者擁有 endpoint.software.manage 且可管理所有公司',
              `  當 呼叫 POST /api/endpoint/releases/{releaseId}/${action}`,
              '  那麼 回應 200',
              `  而且 status 為 "${to}"`,
            ].join('\n'),
            params: releaseIdParams,
            response: {
              200: { ...releaseSchema, properties: { ...releaseSchema.properties, clearedRings: { type: 'array', items: { type: 'string', enum: RINGS } } } },
            },
          },
        },
        async (req) => releases.setStatus(mgmtCtx(req), who(req), req.params.releaseId.toLowerCase(), to),
      );

    app.get(
      '/v1/release-rings',
      {
        schema: {
          operationId: 'endpoint.release-ring.list',
          summary: '發佈環目標版本與進度',
          description: 'pilot(IT 測試機)→ it(IT 部門)→ all 三個環 × Agent / Watchdog 的目標版本,與各環電腦的升級進度(只計登入者資料範圍內的電腦)。',
          tags: TAGS,
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 查看發佈環進度',
            '  假如 pilot 環 agent 的目標版本為 0.7.1',
            '  當 呼叫 GET /api/endpoint/release-rings',
            '  那麼 回應 200',
            '  而且 items 包含 ring 為 "pilot"、component 為 "agent"、targetVersion 為 "0.7.1" 的項目',
          ].join('\n'),
          response: { 200: { type: 'object', properties: { items: { type: 'array', items: ringSchema } } } },
        },
      },
      async (req) => releases.rings(mgmtCtx(req)),
    );

    app.put<{ Params: { ring: Ring; component: ReleaseComponent }; Body: { targetVersion: string | null; force?: boolean } }>(
      '/v1/release-rings/:ring/:component',
      {
        schema: {
          operationId: 'endpoint.release-ring.set',
          summary: '設定發佈環目標版本',
          description:
            '設定某環某元件的目標版本(null = 不升級);可設比目前舊的版本(降版)。draft 只能設給 pilot;設給 it / all 的版本必須已是 pilot 目標滿 24 小時,否則 409 ITA_RING_TOO_EARLY(確定要推進帶 force: true,寫入稽核)。只有可管理所有公司的角色可用。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: pilot 環設定新版',
            '  假如 agent 0.7.1 已登錄',
            '  而且 使用者擁有 endpoint.software.manage 且可管理所有公司',
            '  當 呼叫 PUT /api/endpoint/release-rings/pilot/agent,targetVersion 為 "0.7.1"',
            '  那麼 回應 200',
            '  而且 targetVersion 為 "0.7.1"',
          ].join('\n'),
          params: {
            type: 'object',
            required: ['ring', 'component'],
            properties: { ring: { type: 'string', enum: RINGS }, component: { type: 'string', enum: COMPONENTS } },
          },
          body: {
            type: 'object',
            required: ['targetVersion'],
            additionalProperties: false,
            properties: { targetVersion: { anyOf: [VERSION, { type: 'null' }] }, force: { type: 'boolean', default: false } },
          },
          response: { 200: ringSchema },
        },
      },
      async (req) => releases.setRing(mgmtCtx(req), who(req), req.params.ring, req.params.component, req.body.targetVersion, req.body.force === true),
    );

    app.get<{ Params: { deviceId: string } }>(
      '/v1/devices/:deviceId/upgrade',
      {
        schema: {
          operationId: 'endpoint.device.upgrade',
          summary: '電腦的升級狀態',
          description: '所屬環、Agent / Watchdog 目前版本、目標版本(所屬環或 agent.upgrade 指定)、升級狀態與最後錯誤。',
          tags: TAGS,
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 查看電腦的升級狀態',
            '  假如 電腦 PC-EXAMPLE-01 在 pilot 環',
            '  當 呼叫 GET /api/endpoint/devices/{deviceId}/upgrade',
            '  那麼 回應 200',
            '  而且 ring 為 "pilot"',
          ].join('\n'),
          params: deviceIdParams,
          response: { 200: deviceUpgradeSchema },
        },
      },
      async (req) => releases.deviceUpgrade(mgmtCtx(req), req.params.deviceId.toLowerCase()),
    );

    app.put<{ Params: { deviceId: string }; Body: { ring: Ring } }>(
      '/v1/devices/:deviceId/ring',
      {
        schema: {
          operationId: 'endpoint.device.set-ring',
          summary: '調整電腦所屬環',
          description: '把電腦放到 pilot(IT 測試機)/ it(IT 部門)/ all;預設 all。',
          tags: TAGS,
          'x-permission': 'endpoint.command.admin',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 把測試機放到 pilot 環',
            '  假如 電腦 PC-EXAMPLE-01 在 all 環',
            '  而且 使用者擁有 endpoint.command.admin',
            '  當 呼叫 PUT /api/endpoint/devices/{deviceId}/ring,ring 為 "pilot"',
            '  那麼 回應 200',
            '  而且 ring 為 "pilot"',
          ].join('\n'),
          params: deviceIdParams,
          body: { type: 'object', required: ['ring'], additionalProperties: false, properties: { ring: { type: 'string', enum: RINGS } } },
          response: { 200: deviceUpgradeSchema },
        },
      },
      async (req) => releases.setDeviceRing(mgmtCtx(req), who(req), req.params.deviceId.toLowerCase(), req.body.ring),
    );
  };
}
