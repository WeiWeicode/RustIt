/**
 * 軟體套件上傳與送簽(S1-3;S1-SIGNING-DESIGN §4.4):對外 /api/endpoint/software/uploads*。
 *   - 全部 endpoint.software.manage(BFF),且需全部公司角色(UploadService);上傳、登錄、核可、駁回 x-audit-level: meta
 *   - 串流上傳 POST /v1/software/uploads?fileName=:本體為安裝檔原始位元組(application/octet-stream),邊收邊算 SHA-256 寫入 incoming\;
 *     大檔案經 Gateway Nginx 直接串流(§4.5 A,Gateway 另案),經 BFF 時受 BFF 本體上限限制
 *   - 網路芳鄰放進 incoming\ 的檔案:GET /v1/software/uploads/incoming 挑選 → POST /v1/software/uploads/register 登錄(過渡期,§9-2)
 * 路由只驗參數與宣告權限,邏輯在 UploadService(AGENT.md §8.1)。
 */
import type { GatewayIdentity } from '@giganexus/backend-sdk';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { AppError } from '../errors.js';
import { UPLOAD_STATES, type UploadService } from '../services/upload-service.js';
import type { UploadState } from '../stores/types.js';
import { mgmtCtx } from './mgmt-ctx.js';

const strOrNull = { type: ['string', 'null'] } as const;
const dateOrNull = { type: ['string', 'null'], format: 'date-time' } as const;
const who = { type: ['object', 'null'], properties: { emp: { type: 'string' }, name: strOrNull } } as const;
const TAGS = ['端點軟體派送'];
const FILE_NAME = { type: 'string', minLength: 5, maxLength: 260, description: '{軟體}/{版本}/{安裝檔}(.msi / .exe);簽章後放進軟體庫的同一路徑' } as const;
const NOTES = { type: 'string', maxLength: 1000 } as const;

const uploadSchema = {
  type: 'object',
  properties: {
    uploadId: { type: 'string', format: 'uuid' },
    fileName: { type: 'string' },
    sha256: { type: 'string', description: '原始檔(未重簽)的 SHA-256,由主機計算' },
    sizeBytes: { type: 'integer' },
    state: { type: 'string', enum: UPLOAD_STATES, description: 'uploaded → queued(已核可送簽)→ signed(已放進軟體庫);rejected' },
    source: { type: 'string', enum: ['upload', 'incoming'], description: 'upload = 經 API 上傳;incoming = 網路芳鄰放進 incoming 後登錄' },
    notes: strOrNull,
    uploadedBy: who,
    uploadedAt: { type: 'string', format: 'date-time' },
    approvedBy: who,
    approvedAt: dateOrNull,
    rejectCode: { ...strOrNull, description: 'REJECTED(人工駁回)、INCOMING_CHANGED、RESULT_MISMATCH、SIGN_JOB_WRITE_FAILED,或工作站的代碼(HASH_MISMATCH、VENDOR_NOT_ALLOWED…)' },
    rejectReason: strOrNull,
    rejectedByEmp: strOrNull,
    rejectedAt: dateOrNull,
    vendorSigner: { ...strOrNull, description: '工作站回報的原廠簽章者指紋(未簽章為 null);只供覆核參考' },
    vendorSignerSubject: strOrNull,
    vendorCheck: { ...strOrNull, description: 'allowlist(工作站白名單)/ manual(簽章人員人工確認)' },
    signedSigner: { ...strOrNull, description: '重簽的憑證指紋(工作站回報)' },
    signOperator: strOrNull,
    signedSha256: { ...strOrNull, description: '軟體庫內重簽後檔案的 SHA-256(主機重算確認)' },
    signedAt: dateOrNull,
  },
} as const;

const uploadIdParams = { type: 'object', required: ['uploadId'], properties: { uploadId: { type: 'string', format: 'uuid' } } } as const;

export function uploadRoutes(uploads: UploadService): FastifyPluginAsync {
  return async (app) => {
    const identity = (req: FastifyRequest): GatewayIdentity => {
      if (!req.identity) throw new AppError(401, 'ITA_INTERNAL_TOKEN_INVALID', '缺少內部 Token');
      return req.identity;
    };
    // 串流上傳:本體不緩衝,交給 UploadService 邊收邊寫(大小上限 SOFTWARE_MAX_BYTES 在寫入時檢查);只影響本 plugin 的路由
    app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

    app.get<{ Querystring: { state?: UploadState } }>(
      '/v1/software/uploads',
      {
        schema: {
          operationId: 'endpoint.software.upload.list',
          summary: '上傳與送簽清單',
          description: '軟體套件上傳紀錄(新到舊,最多 500 筆),可依狀態篩選。只有可管理所有公司的角色可用(其他回 403 ITA_SCOPE_ALL_REQUIRED)。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-gherkin': [
            '場景: 列出待核可的上傳',
            '  假如 IT 已上傳 Notepad++/8.7.1/npp.8.7.1.Installer.x64.exe',
            '  當 呼叫 GET /api/endpoint/software/uploads?state=uploaded',
            '  那麼 回應 200',
            '  而且 items 包含 fileName 為 "Notepad++/8.7.1/npp.8.7.1.Installer.x64.exe" 的上傳',
          ].join('\n'),
          querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: UPLOAD_STATES } } },
          response: { 200: { type: 'object', properties: { items: { type: 'array', items: uploadSchema } } } },
        },
      },
      async (req) => uploads.list(mgmtCtx(req), req.query),
    );

    app.get(
      '/v1/software/uploads/incoming',
      {
        schema: {
          operationId: 'endpoint.software.upload.incoming',
          summary: 'incoming 內尚未登錄的檔案',
          description: '以網路芳鄰放進 NAS incoming\\ 的安裝檔中,尚未登錄上傳的檔案(過渡期,S1-SIGNING-DESIGN §9-2)。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-gherkin': [
            '場景: 列出 incoming 內尚未登錄的檔案',
            '  假如 incoming 有 7-Zip/24.09/7z2409-x64.msi 且尚未登錄',
            '  當 呼叫 GET /api/endpoint/software/uploads/incoming',
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
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (req) => uploads.unregisteredIncoming(mgmtCtx(req)),
    );

    app.get<{ Params: { uploadId: string } }>(
      '/v1/software/uploads/:uploadId',
      {
        schema: {
          operationId: 'endpoint.software.upload.get',
          summary: '上傳紀錄詳情',
          description: '單筆上傳紀錄(含工作站回報的原廠簽章者與重簽結果)。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-gherkin': ['場景: 查詢上傳紀錄', '  當 呼叫 GET /api/endpoint/software/uploads/{uploadId}', '  那麼 回應 200'].join('\n'),
          params: uploadIdParams,
          response: { 200: uploadSchema },
        },
      },
      async (req) => uploads.get(mgmtCtx(req), req.params.uploadId.toLowerCase()),
    );

    app.post<{ Querystring: { fileName: string } }>(
      '/v1/software/uploads',
      {
        schema: {
          operationId: 'endpoint.software.upload.create',
          summary: '上傳安裝檔',
          description:
            '本體為安裝檔原始位元組(Content-Type: application/octet-stream),目標路徑以 fileName 指定;主機邊收邊算 SHA-256 寫入 incoming\\(不覆蓋)。' +
            '需帶 Content-Length(411 ITA_UPLOAD_LENGTH_REQUIRED);incoming 或軟體庫已有同路徑回 409 ITA_UPLOAD_FILE_EXISTS;同路徑已有進行中的上傳回 409 ITA_UPLOAD_EXISTS;' +
            '超過上限回 413 ITA_UPLOAD_TOO_LARGE;同時上傳太多回 429 ITA_UPLOAD_BUSY;閒置超過 2 分鐘回 408 ITA_UPLOAD_TIMEOUT。備註不經上傳 API(避免進請求日誌)。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 上傳安裝檔',
            '  假如 使用者擁有 endpoint.software.manage 且可管理所有公司',
            '  當 以 application/octet-stream 呼叫 POST /api/endpoint/software/uploads?fileName=Notepad%2B%2B/8.7.1/npp.8.7.1.Installer.x64.exe',
            '  那麼 回應 200',
            '  而且 state 為 "uploaded"、sha256 為檔案的 SHA-256',
          ].join('\n'),
          querystring: { type: 'object', required: ['fileName'], additionalProperties: false, properties: { fileName: FILE_NAME } },
          response: { 200: uploadSchema },
        },
      },
      async (req) => {
        if (!req.headers['content-type']?.startsWith('application/octet-stream'))
          throw new AppError(415, 'VALIDATION_FAILED', 'Content-Type 需為 application/octet-stream');
        const len = req.headers['content-length'];
        const contentLength = typeof len === 'string' && /^\d{1,16}$/.test(len) ? Number(len) : null;
        return uploads.upload(mgmtCtx(req), identity(req), { fileName: req.query.fileName, contentLength }, req.body as Readable);
      },
    );

    app.post<{ Body: { fileName: string; notes?: string } }>(
      '/v1/software/uploads/register',
      {
        schema: {
          operationId: 'endpoint.software.upload.register',
          summary: '登錄 incoming 內的檔案',
          description: '把已用網路芳鄰放進 incoming\\ 的安裝檔登錄為上傳紀錄(SHA-256 由主機讀檔計算)。incoming 找不到回 404 ITA_UPLOAD_FILE_NOT_FOUND。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 登錄 incoming 內的檔案',
            '  假如 incoming 有 7-Zip/24.09/7z2409-x64.msi',
            '  當 呼叫 POST /api/endpoint/software/uploads/register,fileName 為 "7-Zip/24.09/7z2409-x64.msi"',
            '  那麼 回應 200',
            '  而且 source 為 "incoming"、state 為 "uploaded"',
          ].join('\n'),
          body: { type: 'object', required: ['fileName'], additionalProperties: false, properties: { fileName: FILE_NAME, notes: NOTES } },
          response: { 200: uploadSchema },
        },
      },
      async (req) => uploads.registerIncoming(mgmtCtx(req), identity(req), req.body),
    );

    app.post<{ Params: { uploadId: string } }>(
      '/v1/software/uploads/:uploadId/approve',
      {
        schema: {
          operationId: 'endpoint.software.upload.approve',
          summary: '核可送簽',
          description:
            '第二人核可後寫入送簽工作單,狀態改為 queued,等簽章工作站以公司軟體發佈憑證重簽。核可人不可是上傳者(403 ITA_UPLOAD_SAME_PERSON);' +
            '核可前重算 incoming 檔案雜湊,與上傳時不同回 409 ITA_UPLOAD_FILE_CHANGED 並標記 rejected;狀態不是 uploaded 回 409 ITA_UPLOAD_STATE。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 第二人核可送簽',
            '  假如 S100001 上傳了 Notepad++/8.7.1/npp.8.7.1.Installer.x64.exe',
            '  而且 S100002 擁有 endpoint.software.manage 且可管理所有公司',
            '  當 S100002 呼叫 POST /api/endpoint/software/uploads/{uploadId}/approve',
            '  那麼 回應 200',
            '  而且 state 為 "queued"',
            '',
            '場景: 上傳者不可核可自己的上傳',
            '  當 S100001 呼叫 POST /api/endpoint/software/uploads/{uploadId}/approve',
            '  那麼 回應 403',
            '  而且 code 為 "ITA_UPLOAD_SAME_PERSON"',
          ].join('\n'),
          params: uploadIdParams,
          response: { 200: uploadSchema },
        },
      },
      async (req) => uploads.approve(mgmtCtx(req), identity(req), req.params.uploadId.toLowerCase()),
    );

    app.get<{ Params: { uploadId: string } }>(
      '/v1/software/uploads/:uploadId/sign-status',
      {
        schema: {
          operationId: 'endpoint.software.upload.sign-status',
          summary: '送簽狀態確認(簽章工作站)',
          description:
            '簽章工作站簽章前以 API Key 確認:這筆上傳在主機上確實是 queued、核可人 ≠ 上傳者、路徑與雜湊與工作單相同(工作單可被能寫 sign-queue 的人偽造)。' +
            '找不到回 200 且 state 為 not_found。系統對系統路由,不接受使用者登入。',
          tags: TAGS,
          'x-auth-mode': 'api_key',
          'x-permission': 'endpoint.software.sign-check',
          'x-gherkin': [
            '場景: 簽章工作站確認送簽狀態',
            '  假如 上傳紀錄已由第二人核可(state 為 "queued")',
            '  而且 API Key 具備 endpoint.software.sign-check',
            '  當 以 X-Api-Key 呼叫 GET /api/endpoint/software/uploads/{uploadId}/sign-status',
            '  那麼 回應 200',
            '  而且 state 為 "queued"、approvedBy 與 uploadedBy 不同',
          ].join('\n'),
          params: uploadIdParams,
          response: {
            200: {
              type: 'object',
              properties: {
                environment: { type: 'string' },
                uploadId: { type: 'string' },
                state: { type: 'string', enum: [...UPLOAD_STATES, 'not_found'] },
                fileName: strOrNull,
                sha256: strOrNull,
                sizeBytes: { type: ['integer', 'null'] },
                uploadedBy: strOrNull,
                approvedBy: strOrNull,
              },
            },
          },
        },
      },
      async (req) => uploads.signStatus(mgmtCtx(req), req.params.uploadId.toLowerCase()),
    );

    app.post<{ Params: { uploadId: string }; Body: { reason: string } }>(
      '/v1/software/uploads/:uploadId/reject',
      {
        schema: {
          operationId: 'endpoint.software.upload.reject',
          summary: '駁回上傳',
          description: '駁回 uploaded 或 queued 的上傳(queued 時一併移除送簽工作單);其他狀態回 409 ITA_UPLOAD_STATE。',
          tags: TAGS,
          'x-permission': 'endpoint.software.manage',
          'x-audit-level': 'meta',
          'x-gherkin': [
            '場景: 駁回上傳',
            '  假如 上傳紀錄狀態為 "uploaded"',
            '  當 呼叫 POST /api/endpoint/software/uploads/{uploadId}/reject,reason 為 "版本錯誤"',
            '  那麼 回應 200',
            '  而且 state 為 "rejected"、rejectCode 為 "REJECTED"',
          ].join('\n'),
          params: uploadIdParams,
          body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
          response: { 200: uploadSchema },
        },
      },
      async (req) => uploads.reject(mgmtCtx(req), identity(req), req.params.uploadId.toLowerCase(), req.body.reason),
    );
  };
}
