/**
 * 資料範圍(ENDPOINT-AGENT-GUIDE §8.2「資料範圍」、§10.2 E6;設計 docs/E6-COMPANY-SCOPE-DESIGN.md §3.4):
 *   管理 API 只回傳、只接受登入者所屬公司(內部 Token 的 cos)的電腦;Token 的 roles 含 ENDPOINT_SCOPE_ALL_ROLES 任一個即全部公司。
 *   未指定公司的電腦只有全部公司看得到。範圍外一律回與「不存在」相同的 404(不洩漏存在)。
 *   管理方法一律收 MgmtCtx(型別上必帶 scope),新增路由不會漏掉範圍。
 */
import type { GatewayIdentity } from '@giganexus/backend-sdk';
import { COMPANY_NAME_MAX } from './company.js';
import type { Ctx } from './device-service.js';

export type Scope = { all: true } | { all: false; companies: readonly string[] };

export const SCOPE_ALL: Scope = { all: true };

/** 管理 API 的 ctx:必帶資料範圍 */
export interface MgmtCtx extends Ctx {
  scope: Scope;
}

export function scopeOf(id: GatewayIdentity, allRoles: readonly string[]): Scope {
  if ((id.roles ?? []).some((r) => allRoles.includes(r))) return SCOPE_ALL;
  // 超過欄位長度(NVARCHAR(20))的名稱不可能對到任何裝置,直接略過
  const companies = [...new Set((id.cos ?? []).filter((c) => typeof c === 'string' && c.length > 0 && c.length <= COMPANY_NAME_MAX))];
  return { all: false, companies };
}

export function inScope(s: Scope, company: string | null): boolean {
  if (s.all) return true;
  return company !== null && s.companies.includes(company);
}

/** 清單查詢的公司條件:undefined = 不限 */
export function scopeCompanies(s: Scope): string[] | undefined {
  return s.all ? undefined : [...s.companies];
}

/** 日誌用的範圍摘要(不記公司名稱以外的資訊) */
export function scopeLog(s: Scope): string {
  return s.all ? 'all' : s.companies.length ? s.companies.join(',') : 'empty';
}
