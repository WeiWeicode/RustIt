/**
 * OpenAPI 根層設定(BACKEND-GUIDE.md §6.1):x-gateway 與 x-permissions 必填;x-gateway.project 由 SDK 自 package.json 寫入(RustIt)。
 * 對外前綴 /api/endpoint(x-gateway.system = endpoint),後端路徑 /v1/... 匯入時去掉版本段。
 */
import type { SwaggerOptions } from '@fastify/swagger';

/** 路由 schema 可用的 Gateway 擴充欄位(BACKEND-GUIDE.md §6.1),由 @fastify/swagger 原樣輸出到 operation */
declare module 'fastify' {
  interface FastifySchema {
    'x-permission'?: string;
    'x-gherkin'?: string;
    'x-audit-level'?: 'none' | 'meta' | 'body';
    'x-cache-ttl'?: number;
    'x-cache-scope'?: 'shared' | 'user';
    'x-timeout-ms'?: number;
    'x-gateway-path'?: string;
    'x-rate-limit'?: string;
  }
}

/**
 * 本服務的 API 權限代碼(ENDPOINT-AGENT-GUIDE §8.2);Gateway 匯入時不存在者一併建立。
 * 畫面節點(GigaItApp 選單 it.endpoint-device.read、Tab it.endpoint-device.list)以 includes 綁定(INTEGRATION-PLAN M4、決策 D9)。
 * 指令類(endpoint.command.basic / admin)待指令 API 實作時再宣告。
 */
export const PERMISSIONS = [{ code: 'endpoint.device.read', name: '端點查詢' }];

export function swaggerOptions(serviceCode: string, project: string): SwaggerOptions {
  const extensions = { 'x-gateway': { upstream: serviceCode, system: 'endpoint', project }, 'x-permissions': PERMISSIONS };
  return { openapi: { openapi: '3.0.3', info: { title: 'RustIt 端點管理(Endpoint Server)', version: '0.1.0' }, ...extensions } };
}
