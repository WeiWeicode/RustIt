/**
 * 軟體派送(PLATFORM-PLAN §4.6;P7-SOFTWARE-DESIGN §3.5):對外 /api/endpoint/software*。
 *   - 查詢(endpoint.device.read):目錄清單(含資料範圍內已安裝台數)、未登錄的安裝檔、套件詳情(測試機結果、已安裝電腦)
 *   - 登錄、修改、測試完成、發佈、撤回(endpoint.software.manage,且需全部公司角色,§9-5):x-audit-level: meta
 *   - 批次派送(endpoint.command.admin):> BATCH_APPROVAL_THRESHOLD 台進入待核可,核可 / 駁回在 routes/commands.ts
 *     (BFF 一個 operation 只檢查一個權限;設計原訂 software.manage + command.admin,改為與單台派送相同的 command.admin,§8.1)
 *   - 單台派送沿用 POST /devices/{id}/admin-commands(kind = software.install / software.uninstall、params.packageId)
 * 路由只驗參數與宣告權限,邏輯在 SoftwareService(AGENT.md §8.1)。
 */
import type { GatewayIdentity } from '@giganexus/backend-sdk';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import { BATCH_MAX_DEVICES } from '../services/command-dispatcher.js';
import {
  ARGS_MAX,
  DEFAULT_TIMEOUT_SEC,
  DETECT_TYPES,
  INSTALLER_TYPES,
  PACKAGE_STATUSES,
  REBOOT_POLICIES,
  TIMEOUT_MAX_SEC,
  TIMEOUT_MIN_SEC,
  type DeployInput,
  type RegisterPackageInput,
  type SoftwareService,
  type UpdatePackageInput,
} from '../services/software-service.js';
import type { PackageStatus } from '../stores/types.js';
import { mgmtCtx } from './mgmt-ctx.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const strOrNull = { type: ['string', 'null'] } as const;
const dateOrNull = { type: ['string', 'null'], format: 'date-time' } as const;
const who2 = { type: ['object', 'null'], properties: { emp: { type: 'string' }, name: strOrNull } } as const;
const TAGS = ['端點軟體派送'];
const ARGS = {
  type: 'string',
  maxLength: ARGS_MAX,
  description: '靜默參數的額外屬性;只允許英數字、空白與 / - _ = . : , " { } %,不可指到其他檔案、不可含序號 / 密碼',
} as const;
const TIMEOUT = {
  type: 'integer',
  minimum: TIMEOUT_MIN_SEC,
  maximum: TIMEOUT_MAX_SEC,
  description: `Agent 執行安裝 / 移除程式的逾時(秒,${TIMEOUT_MIN_SEC}–${TIMEOUT_MAX_SEC};登錄時省略為 ${DEFAULT_TIMEOUT_SEC})`,
} as const;
const SIGNERS = { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^[0-9A-Fa-f]{40}$' } } as const;

const packageProps = {
  packageId: uuid,
  name: { type: 'string' },
  version: { type: 'string' },
  fileName: { type: 'string', description: '軟體庫內相對路徑 {軟體}/{版本}/{檔名}' },
  sha256: { type: 'string', description: '登錄時由主機計算' },
  sizeBytes: { type: 'integer' },
  installerType: { type: 'string', enum: INSTALLER_TYPES },
  installArgs: strOrNull,
  uninstallArgs: strOrNull,
  detectType: { type: 'string', enum: DETECT_TYPES },
  detectValue: { type: 'string' },
  rebootPolicy: { type: 'string', enum: REBOOT_POLICIES },
  timeoutSec: { type: 'integer', description: 'Agent 執行安裝 / 移除程式的逾時(秒)' },
  signerThumbprints: { type: 'array', items: { type: 'string' }, description: '預期簽章者憑證 SHA-1 指紋(tested 起才有)' },
  observedSigners: { type: 'array', items: { type: 'string' }, description: '測試機回報的實際簽章者' },
  licenseLimit: { type: ['integer', 'null'] },
  installedCount: { type: ['integer', 'null'], description: '資料範圍內已安裝台數(DisplayName 樣式比對;MSI 產品代碼為 null)' },
  status: { type: 'string', enum: PACKAGE_STATUSES, description: 'draft / tested 只能派送到 pilot 環;revoked 不可再安裝' },
  notes: strOrNull,
  createdBy: { type: 'object', properties: { emp: { type: 'string' }, name: strOrNull } },
  createdAt: { type: 'string', format: 'date-time' },
  updatedByEmp: strOrNull,
  updatedAt: dateOrNull,
  testedByEmp: strOrNull,
  testedAt: dateOrNull,
  publishedBy: who2,
  publishedAt: dateOrNull,
  revokedByEmp: strOrNull,
  revokedAt: dateOrNull,
} as const;
const packageSchema = { type: 'object', properties: packageProps } as const;
const uploadRefSchema = {
  type: ['object', 'null'],
  description: '對應的上傳與送簽紀錄(S1-3);簽章者欄位為簽章工作站回報(未驗證),實際簽章者以測試機回報為準',
  properties: {
    uploadId: uuid,
    state: { type: 'string', enum: ['uploaded', 'queued', 'signed', 'rejected'] },
    uploadedBy: { type: 'object', properties: { emp: { type: 'string' }, name: strOrNull } },
    approvedBy: who2,
    vendorSigner: strOrNull,
    vendorSignerSubject: strOrNull,
    vendorCheck: strOrNull,
    signedSigner: strOrNull,
    signedAt: dateOrNull,
    rejectCode: strOrNull,
  },
} as const;

const detailSchema = {
  type: 'object',
  properties: {
    ...packageProps,
    viewerScopeAll: { type: 'boolean', description: '查詢者有可管理所有公司的角色(才能登錄 / 修改 / 標記測試完成 / 發佈 / 撤回)' },
    upload: uploadRefSchema,
    testResults: {
      type: 'array',
      description: 'pilot 測試機的 software.install(新到舊);qualifies = 可作為 mark-tested 依據',
      items: {
        type: 'object',
        properties: {
          commandId: uuid,
          deviceId: uuid,
          computerName: { type: 'string' },
          state: { type: 'string' },
          errorCode: strOrNull,
          exitCode: { type: ['integer', 'null'] },
          signer: strOrNull,
          signerSubject: strOrNull,
          detected: { type: ['boolean', 'null'] },
          installedVersion: { ...strOrNull, description: 'Agent 偵測到的已安裝版本(0.9.2 起;已安裝時或安裝後)' },
          previousVersion: { ...strOrNull, description: '安裝前偵測到的較舊版本(升級時;0.9.2 起)' },
          alreadyInstalled: { type: ['boolean', 'null'] },
          qualifies: { type: 'boolean' },
          createdByEmp: { type: 'string' },
          finishedAt: dateOrNull,
        },
      },
    },
    installedDevices: {
      type: 'array',
      description: '資料範圍內已安裝的電腦(依資產的軟體清單,最多 200 筆)',
      items: { type: 'object', properties: { deviceId: uuid, computerName: { type: 'string' }, name: { type: 'string' }, version: strOrNull } },
    },
  },
} as const;

const packageIdParams = { type: 'object', required: ['packageId'], properties: { packageId: uuid } } as const;
const idemHeaders = {
  type: 'object',
  properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7e]+$', description: '重複送出時回傳同一批' } },
} as const;

export function softwareRoutes(software: SoftwareService): FastifyPluginAsync {
  return async (app) => {
    const who = (req: FastifyRequest): GatewayIdentity => {
      if (!req.identity) throw new AppError(401, 'ITA_INTERNAL_TOKEN_INVALID', '缺少內部 Token');
      return req.identity;
    };

    app.get<{ Querystring: { status?: PackageStatus; q?: string } }>(
      '/v1/software',
      {
        schema: {
          operationId: 'endpoint.software.list',
          summary: '軟體目錄',
          description: '已登錄的軟體套件(依名稱),可依狀態與名稱關鍵字篩選;installedCount 為資料範圍內已安裝的台數。',
          tags: TAGS,
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 列出已發佈的軟體',
            '  假如 7-Zip 24.09 已發佈',
            '  而且 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/software?status=published',
            '  那麼 回應 200',
            '  而且 items 包含 name 為 "7-Zip" 的套件',
          ].join('\n'),
          querystring: { type: 'object', properties: { status: { type: 'string', enum: PACKAGE_STATUSES }, q: { type: 'string', maxLength: 100 } } },
          response: { 200: { type: 'object', properties: { items: { type: 'array', items: packageSchema } } } },
        },
      },
      async (req) => software.list(mgmtCtx(req), req.query),
    );

    app.get(
      '/v1/software/files',
      {
        schema: {
          operationId: 'endpoint.software.files',
          summary: '尚未登錄的安裝檔',
          description: '軟體庫({軟體}/{版本}/{安裝檔},.msi 或 .exe)中尚未登錄的檔案,給登錄畫面挑選。IT 把測過的安裝檔放進軟體庫後才會出現。',
          tags: TAGS,
          // 軟體庫的檔名只給目錄管理者(資安稽核 L9)
          'x-permission': 'endpoint.software.manage',
          'x-gherkin': [
            '場景: 列出尚未登錄的安裝檔',
            '  假如 軟體庫有 7-Zip/24.09/7z2409-x64.msi 且尚未登錄',
            '  當 呼叫 GET /api/endpoint/software/files',
            '  那麼 回應 200',
            '  而且 items 包含 fileName 為 "7-Zip/24.09/7z2409-x64.msi" 的檔案',
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
                      fileName: { type: 'string' },
                      software: { type: 'string' },
                      version: { type: 'string' },
                      sizeBytes: { type: 'integer' },
                      modifiedAt: { type: 'string', format: 'date-time' },
                      upload: { ...uploadRefSchema, description: '該路徑最新一筆上傳紀錄;null 代表直接放進軟體庫(S1 過渡期)' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (req) => software.unregisteredFiles(mgmtCtx(req)),
    );

    app.post<{ Body: RegisterPackageInput }>(
      '/v1/software',
      {
        schema: {
          operationId: 'endpoint.software.register',
          summary: '登錄軟體套件',
          description:
            '把軟體庫中的安裝檔登錄為 draft;SHA-256 與大小由主機讀檔計算。draft 只能派送到 pilot 環的測試機,測試成功後 mark-tested、再由另一位 IT 發佈。只有可管理所有公司的角色可用(其他回 403 ITA_SCOPE_ALL_REQUIRED);同名同版本或同一檔案已登錄回 409 ITA_PACKAGE_EXISTS;檔案不存在回 404 ITA_PACKAGE_FILE_NOT_FOUND;檔案有上傳紀錄但尚未簽章(待核可 / 送簽中 / 已駁回)或與簽章後的雜湊不符回 409 ITA_UPLOAD_NOT_SIGNED(沒有上傳紀錄的檔案在 S1 過渡期仍可登錄)。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 登錄 7-Zip MSI',
            '  假如 軟體庫有 7-Zip/24.09/7z2409-x64.msi',
            '  而且 使用者擁有 endpoint.software.manage 且可管理所有公司',
            '  當 呼叫 POST /api/endpoint/software,name 為 "7-Zip"、version 為 "24.09"、installerType 為 "msi"、detectType 為 "display_name"、detectValue 為 "7-Zip%"',
            '  那麼 回應 200',
            '  而且 status 為 "draft"',
            '場景: 安裝參數含特殊字元',
            '  當 呼叫 POST /api/endpoint/software,installArgs 為 "ALLUSERS=1 & calc"',
            '  那麼 回應 400',
          ].join('\n'),
          body: {
            type: 'object',
            required: ['name', 'version', 'fileName', 'installerType', 'detectType', 'detectValue'],
            additionalProperties: false,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\u0000-\\u001F\\u007F]+$' },
              version: { type: 'string', minLength: 1, maxLength: 50, pattern: '^[A-Za-z0-9._ +-]+$' },
              fileName: { type: 'string', minLength: 5, maxLength: 260, description: '{軟體}/{版本}/{檔名}(\\ 視同 /)' },
              installerType: { type: 'string', enum: INSTALLER_TYPES },
              installArgs: ARGS,
              uninstallArgs: ARGS,
              detectType: { type: 'string', enum: DETECT_TYPES },
              detectValue: { type: 'string', minLength: 1, maxLength: 400, description: 'MSI 產品代碼 {GUID},或登錄檔 DisplayName 樣式(% 為萬用字元)' },
              rebootPolicy: { type: 'string', enum: REBOOT_POLICIES, default: 'never' },
              timeoutSec: TIMEOUT,
              licenseLimit: { type: ['integer', 'null'], minimum: 0, maximum: 1000000 },
              notes: { type: 'string', maxLength: 1000 },
            },
          },
          response: { 200: packageSchema },
        },
      },
      async (req) => software.register(mgmtCtx(req), who(req), req.body),
    );

    app.get<{ Params: { packageId: string } }>(
      '/v1/software/:packageId',
      {
        schema: {
          operationId: 'endpoint.software.get',
          summary: '軟體套件詳情',
          description: '狀態、覆核人、完整安裝參數與簽章者(發佈前覆核用)、pilot 測試機的安裝結果、資料範圍內已安裝的電腦。',
          tags: TAGS,
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 查詢不存在的套件',
            '  當 呼叫 GET /api/endpoint/software/00000000-0000-4000-8000-000000000000',
            '  那麼 回應 404',
            '  而且 回應的 code 為 "ITA_PACKAGE_NOT_FOUND"',
          ].join('\n'),
          params: packageIdParams,
          response: { 200: detailSchema },
        },
      },
      async (req) => software.get(mgmtCtx(req), req.params.packageId.toLowerCase()),
    );

    app.put<{ Params: { packageId: string }; Body: UpdatePackageInput }>(
      '/v1/software/:packageId',
      {
        schema: {
          operationId: 'endpoint.software.update',
          summary: '修改軟體套件',
          description:
            '修改安裝 / 移除參數、偵測規則、重開機政策、安裝逾時、授權數、說明(逾時、授權數、說明不需重新覆核)。tested / published 的套件改到安裝參數或偵測規則會退回 draft(清除簽章者與覆核紀錄,需重新測試與覆核);已撤回的不能修改。只有可管理所有公司的角色可用。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 修改已發佈套件的安裝參數',
            '  假如 7-Zip 24.09 已發佈',
            '  當 呼叫 PUT /api/endpoint/software/{packageId},installArgs 為 "ALLUSERS=1"',
            '  那麼 回應 200',
            '  而且 status 為 "draft"',
          ].join('\n'),
          params: packageIdParams,
          body: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              installArgs: ARGS,
              uninstallArgs: ARGS,
              detectType: { type: 'string', enum: DETECT_TYPES },
              detectValue: { type: 'string', minLength: 1, maxLength: 400 },
              rebootPolicy: { type: 'string', enum: REBOOT_POLICIES },
              timeoutSec: TIMEOUT,
              licenseLimit: { type: ['integer', 'null'], minimum: 0, maximum: 1000000 },
              notes: { type: 'string', maxLength: 1000 },
            },
          },
          response: { 200: packageSchema },
        },
      },
      async (req) => software.update(mgmtCtx(req), who(req), req.params.packageId.toLowerCase(), req.body),
    );

    app.post<{ Params: { packageId: string }; Body: { signerThumbprints: string[] } }>(
      '/v1/software/:packageId/mark-tested',
      {
        schema: {
          operationId: 'endpoint.software.mark-tested',
          summary: '標記測試完成',
          description:
            'draft 改為 tested。需有 pilot 測試機以目前的檔案與參數安裝成功且偵測通過的紀錄(否則 409 ITA_PACKAGE_NOT_TESTED);signerThumbprints 必須是該次測試機回報的實際簽章者(否則 409 ITA_SIGNER_NOT_OBSERVED)。只有可管理所有公司的角色可用。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 測試機尚未安裝就標記測試完成',
            '  假如 7-Zip 24.09 為 draft 且沒有測試機安裝紀錄',
            '  當 呼叫 POST /api/endpoint/software/{packageId}/mark-tested',
            '  那麼 回應 409',
            '  而且 回應的 code 為 "ITA_PACKAGE_NOT_TESTED"',
          ].join('\n'),
          params: packageIdParams,
          body: { type: 'object', required: ['signerThumbprints'], additionalProperties: false, properties: { signerThumbprints: SIGNERS } },
          response: { 200: packageSchema },
        },
      },
      async (req) => software.markTested(mgmtCtx(req), who(req), req.params.packageId.toLowerCase(), req.body.signerThumbprints),
    );

    for (const [action, summary, text, gherkin] of [
      [
        'publish',
        '發佈軟體套件',
        'tested 改為 published,之後才能派送到 pilot 以外的電腦。發佈人不可是登錄人(403 ITA_REVIEWER_SAME_AS_CREATOR);覆核者應先在詳情確認完整安裝參數、簽章者、檔案大小與雜湊',
        ['  假如 7-Zip 24.09 為 tested,登錄人為 S000001', '  當 S000001 呼叫 POST /api/endpoint/software/{packageId}/publish', '  那麼 回應 403'],
      ],
      [
        'revoke',
        '撤回軟體套件',
        '立即不能再安裝(仍可移除);尚未送出的安裝指令取消(回傳 canceledCommands),已送出的指令下載會被拒',
        ['  假如 7-Zip 24.09 已發佈', '  當 呼叫 POST /api/endpoint/software/{packageId}/revoke', '  那麼 回應 200', '  而且 status 為 "revoked"'],
      ],
    ] as const)
      app.post<{ Params: { packageId: string } }>(
        `/v1/software/:packageId/${action}`,
        {
          schema: {
            operationId: `endpoint.software.${action}`,
            summary,
            description: `${text}。只有可管理所有公司的角色可用;狀態不符回 409 ITA_PACKAGE_STATUS。`,
            tags: TAGS,
            'x-permission': 'endpoint.software.manage',
            'x-audit-level': 'meta',
            'x-gherkin': [`場景: ${summary}`, ...gherkin].join('\n'),
            params: packageIdParams,
            response: { 200: { type: 'object', properties: { ...packageProps, canceledCommands: { type: 'integer' } } } },
          },
        },
        async (req) => {
          const id = req.params.packageId.toLowerCase();
          return action === 'publish' ? software.publish(mgmtCtx(req), who(req), id) : software.revoke(mgmtCtx(req), who(req), id);
        },
      );

    app.post<{ Params: { packageId: string }; Body: DeployInput }>(
      '/v1/software/:packageId/deploy',
      {
        schema: {
          operationId: 'endpoint.software.deploy',
          summary: '批次派送軟體',
          description: `多台電腦安裝或移除同一個套件(最多 ${BATCH_MAX_DEVICES} 台);任一台不存在、已停用、不在資料範圍、未發佈套件派到非 pilot 電腦或超過授權數則整批不建立。超過 20 台(BATCH_APPROVAL_THRESHOLD)時批次為 pending_approval,需另一位具 endpoint.software.manage 的 IT 以 POST /batches/{batchId}/approve 核可後才送出,24 小時未核可自動取消。回 202 與 batchId、state、各台 commandId。`,
          tags: TAGS,
          'x-permission': 'endpoint.command.admin',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 對 3 台電腦安裝 7-Zip',
            '  假如 7-Zip 24.09 已發佈',
            '  而且 使用者擁有 endpoint.command.admin',
            '  當 呼叫 POST /api/endpoint/software/{packageId}/deploy,action 為 "install"、deviceIds 三台',
            '  那麼 回應 202',
            '  而且 state 為 "running"',
            '場景: 超過 20 台需第二人核可',
            '  當 呼叫 POST /api/endpoint/software/{packageId}/deploy,deviceIds 21 台',
            '  那麼 回應 202',
            '  而且 state 為 "pending_approval"',
          ].join('\n'),
          params: packageIdParams,
          headers: idemHeaders,
          body: {
            type: 'object',
            required: ['action', 'deviceIds'],
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['install', 'uninstall'] },
              deviceIds: { type: 'array', minItems: 1, maxItems: BATCH_MAX_DEVICES, items: uuid },
              maxConcurrent: { type: 'integer', minimum: 1, maximum: 20, description: '這批同時執行上限,預設 20(全域另有 SOFTWARE_MAX_CONCURRENT)' },
              ignorePower: { type: 'boolean', description: '安裝時略過電池延後(不略過計量網路)' },
            },
          },
          response: {
            202: {
              type: 'object',
              properties: {
                batchId: uuid,
                state: { type: 'string', enum: ['pending_approval', 'running', 'done', 'rejected', 'expired'] },
                requiresApproval: { type: 'boolean' },
                commands: { type: 'array', items: { type: 'object', properties: { deviceId: uuid, commandId: uuid, state: { type: 'string' } } } },
              },
            },
          },
        },
      },
      async (req, reply) => {
        const key = (req.headers['idempotency-key'] as string | undefined) || undefined;
        return reply.status(202).send(await software.deploy(mgmtCtx(req), who(req), req.params.packageId.toLowerCase(), req.body, key));
      },
    );
  };
}
