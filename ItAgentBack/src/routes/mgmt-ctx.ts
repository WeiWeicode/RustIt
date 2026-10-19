/** 管理 API 路由共用:由請求組出 MgmtCtx(日誌、追蹤、資料範圍;req.scope 由 mgmt-app 驗完 Token 後設定,E6) */
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import type { MgmtCtx } from '../services/scope.js';

export function mgmtCtx(req: FastifyRequest): MgmtCtx {
  // 只有不驗 Token 的路由(健康檢查、OpenAPI)沒有 scope,不會走到這裡
  if (!req.scope) throw new AppError(401, 'ITA_INTERNAL_TOKEN_INVALID', '缺少內部 Token');
  return { log: req.log, requestId: req.id, scope: req.scope };
}
