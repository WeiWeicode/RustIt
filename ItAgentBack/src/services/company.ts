/**
 * 電腦所屬公司的自動判定(E6-COMPANY-SCOPE-DESIGN §2 第 1、4、5 項、§3.3):
 *   1. 憑證 DN 的 CN 是 FQDN(含「.」)→ 取網域尾碼(Nginx 驗過、IT 的 CA 簽發,可信)
 *   2. Agent 回報的網域(part_of_domain 為 true 才用;端點可偽造,但偽造者必須已控制該台電腦)
 *   判不出回 null(未指定,由全部公司角色手動指定)。網域 → 公司的對應來自設定 ENDPOINT_COMPANY_DOMAINS,
 *   最長尾碼優先(ygdmc.gsc.com.tw 不可被 gsc.com.tw 先吃掉),不分大小寫。
 */
import type { CompanySource } from '../stores/types.js';

/** 網域(小寫)→ 公司名稱 */
export type CompanyDomains = ReadonlyMap<string, string>;

/** 公司名稱上限同 Gateway gw.company.comp_name(NVARCHAR(20)) */
export const COMPANY_NAME_MAX = 20;

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * 解析設定:`公司=網域,網域;公司=網域`(例 `碩禾=gsc.com.tw,gsmc.com.tw;鹽城碩禾=ygdmc.gsc.com.tw`)。
 * 格式錯、公司名稱過長、同一網域指到兩家公司 → 丟 Error(設定檔載入時轉為 ConfigError,啟動失敗)
 */
export function parseCompanyDomains(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (raw ?? '').split(';')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    const company = eq > 0 ? part.slice(0, eq).trim() : '';
    if (!company || company.length > COMPANY_NAME_MAX) throw new Error(`公司名稱需 1–${COMPANY_NAME_MAX} 字:${part.trim()}`);
    const domains = part
      .slice(eq + 1)
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (domains.length === 0) throw new Error(`${company} 沒有網域`);
    for (const d of domains) {
      if (!DOMAIN_RE.test(d)) throw new Error(`網域格式錯誤:${d}`);
      const prev = map.get(d);
      if (prev && prev !== company) throw new Error(`網域 ${d} 同時指到 ${prev} 與 ${company}`);
      map.set(d, company);
    }
  }
  return map;
}

/** host(FQDN 或網域)符合的公司:由長到短比對尾碼 */
export function companyOfDomain(map: CompanyDomains, host: string | null | undefined): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase().replace(/\.$/, '');
  while (h) {
    const hit = map.get(h);
    if (hit) return hit;
    const dot = h.indexOf('.');
    if (dot < 0) return null;
    h = h.slice(dot + 1);
  }
  return null;
}

/** RFC 2253 DN 的 CN(不分大小寫);沒有回 null。device-service 的 cnOf 找不到時回整個 DN(當電腦名稱),此處需要 null,且不可反向引用 device-service(循環相依) */
function cnOf(dn: string): string | null {
  return /(?:^|,)\s*CN=([^,]+)/i.exec(dn)?.[1]?.trim() || null;
}

export function resolveCompany(
  map: CompanyDomains,
  certDn: string,
  inv: { domain: string | null | undefined; partOfDomain: boolean | null | undefined } | null,
): { company: string; source: Exclude<CompanySource, 'manual'> } | null {
  if (map.size === 0) return null;
  const cn = cnOf(certDn);
  // CN 只是電腦名稱(沒有「.」)時不當網域比對:避免名稱剛好等於某個網域的第一段
  if (cn?.includes('.')) {
    const c = companyOfDomain(map, cn);
    if (c) return { company: c, source: 'cert' };
  }
  if (inv?.partOfDomain) {
    const c = companyOfDomain(map, inv.domain);
    if (c) return { company: c, source: 'domain' };
  }
  return null;
}
