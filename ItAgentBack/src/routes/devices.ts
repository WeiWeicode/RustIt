/**
 * 電腦清單 / 詳情(INTEGRATION-PLAN §5、ENDPOINT-AGENT-GUIDE §8.3):對外 /api/endpoint/devices[/{deviceId}],權限 endpoint.device.read 由 BFF 檢查。
 * 回傳 camelCase,與 GigaItApp 的 EndpointDevice 相容(只新增欄位)。清單不帶軟體清單,只在詳情的 inventory。
 * 資料範圍依 Token 的 cos(所屬公司)過濾尚待定案(指南 §10 E6),基本階段回傳全部裝置。
 */
import type { FastifyPluginAsync } from 'fastify';
import type { DeviceService } from '../services/device-service.js';

const str = { type: 'string' } as const;
const strOrNull = { type: ['string', 'null'] } as const;

const summaryProps = {
  deviceId: { type: 'string', format: 'uuid' },
  computerName: str,
  certDn: str,
  certFingerprint: str,
  online: { type: 'boolean' },
  status: { type: 'string', enum: ['active', 'disabled'] },
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
  lastInventoryAt: { type: ['string', 'null'], format: 'date-time' },
} as const;

const summarySchema = { type: 'object', properties: summaryProps } as const;

export function deviceRoutes(service: DeviceService): FastifyPluginAsync {
  return async (app) => {
    const ctx = (req: { log: typeof app.log; id: string }) => ({ log: req.log, requestId: req.id });

    app.get(
      '/v1/devices',
      {
        schema: {
          operationId: 'endpoint.device.list',
          summary: '電腦清單',
          description: '列出已連線過的端點電腦:名稱、在線狀態、使用者、IP、作業系統、CPU、記憶體、最後回報。在線狀態由 Agent 的 WebSocket 心跳決定(90 秒無心跳即離線)。',
          tags: ['端點電腦'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 列出有 Agent 回報的電腦',
            '  假如 電腦 PC-EXAMPLE-01 的 Agent 已回報資產且 WebSocket 在線',
            '  而且 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/devices',
            '  那麼 回應 200',
            '  而且 items 包含 computerName 為 "PC-EXAMPLE-01"、online 為 true 的電腦',
          ].join('\n'),
          response: { 200: { type: 'object', properties: { items: { type: 'array', items: summarySchema } } } },
        },
      },
      async (req) => ({ items: await service.listDevices(ctx(req)) }),
    );

    app.get<{ Params: { deviceId: string } }>(
      '/v1/devices/:deviceId',
      {
        schema: {
          operationId: 'endpoint.device.get',
          summary: '電腦詳情',
          description: '單一電腦的摘要與最新一份完整資產快照(硬體、網卡、磁碟、防毒、軟體清單);不存在回 404 ITA_DEVICE_NOT_FOUND。',
          tags: ['端點電腦'],
          'x-permission': 'endpoint.device.read',
          'x-gherkin': [
            '場景: 查詢不存在的電腦',
            '  假如 使用者擁有 endpoint.device.read',
            '  當 呼叫 GET /api/endpoint/devices/00000000-0000-4000-8000-000000000000',
            '  那麼 回應 404',
            '  而且 回應的 code 為 "ITA_DEVICE_NOT_FOUND"',
          ].join('\n'),
          params: { type: 'object', properties: { deviceId: { type: 'string', format: 'uuid' } }, required: ['deviceId'] },
          response: {
            200: {
              type: 'object',
              properties: {
                ...summaryProps,
                collectedAt: { type: ['string', 'null'], format: 'date-time' },
                inventory: { type: ['object', 'null'], additionalProperties: true, description: 'Agent 的 ComputerInfo(資料契約 inventory.schema.json),鍵名轉 camelCase' },
              },
            },
          },
        },
      },
      async (req) => service.getDevice(ctx(req), req.params.deviceId.toLowerCase()),
    );
  };
}
