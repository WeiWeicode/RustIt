# E6 資料範圍依公司(`cos`)過濾 — 設計

> 2026-10-16 E6-1 已上測試區(RustIt MR !25,endpoint-server `3081af75`;§6.1)。草案 2026-10-16,分支 `feature/e6-company-scope`(從 `gitlab/develop` 807c7a1 開)。依據:ENDPOINT-AGENT-GUIDE §8.2「資料範圍」、§10.2 E6、§11 Endpoint Server 檢查清單;P3-DATA-DESIGN §3、§6.1「未處理(已知)」;資安稽核 M2。
> **2026-10-16 需求方確認**:§2 第 1、2、3、6 項採建議(混合判斷;`ENDPOINT_SCOPE_ALL_ROLES` 測試區先 `it-admin`;未指定只有全部公司角色看得到;改公司需 admin 且為全部公司角色);第 4、5、7 項隨之採建議;第 8、9 項(GigaItApp、Gateway)各批動手前另行同意。

## 0. 目標與缺口

目前有 `endpoint.device.read` 的人看得到**全部公司**的電腦,有 `endpoint.command.admin` 的人能停用 / 退役 / 合併**全部公司**的電腦(資安稽核 M2;指南 §8.2 要求「依內部 Token 的 `cos` 只回傳、只接受該公司的電腦」)。目前 admin 只授予 it-admin,風險暫時受控,但上線前必須補上。

完成標準:

1. 管理 API(`:51240`)的每一條裝置 / 指令路由,只回傳、只接受「登入者公司」的電腦;不在範圍內的一律回 **404**(與不存在相同,不洩漏存在)。
2. 「可管理所有公司」的角色看得到、管得到全部,包含尚未判定公司的電腦。
3. 範圍檢查集中在 service 層一處,新路由不會因為忘記加檢查而漏掉(型別強制)。
4. Agent 通道(`:51241`)行為不變。

## 1. 現況

### 1.1 Token 內容(`@giganexus/backend-sdk` `GatewayIdentity`)

| 欄位 | 內容 | 本設計用途 |
| --- | --- | --- |
| `cos` | `string[]`,登入者所屬公司的**公司名稱**(`gw.company.comp_name`,NVARCHAR(20),如 `碩禾`、`禾迅`;來自 `gw.user_company`,只取啟用的公司) | 範圍 |
| `roles` | 角色代碼陣列(如 `it-admin`) | 判斷「全部公司」 |
| `emp` / `name` | 工號 / 姓名 | 稽核(既有) |

- BFF 看不到也不會轉送權限代碼,只帶角色(指南 §8.2)。
- API Key 呼叫(`sub = client:*`)的 `cos` 一律是 `[]`、`roles` 是 `[]`;目前沒有系統對系統呼叫端點 API。
- **注意**:`cos` 來自人事同步的 `gw.user_company`;只有 AD 資料、沒有所屬公司的使用者 `cos` 為空,依本設計會**看不到任何電腦**。上線前要確認 IT 人員在 Gateway 都有所屬公司(§7 驗證項目)。

### 1.2 公司與網域(Gateway,`gw.company_ad_domain`)

碩禾 → `gsc`、`gsmc`;鹽城碩禾 → `ygdmc`;禾迅等子公司無網域(本機帳號)。Gateway 存的是網域**代碼**,端點回報的是 **DNS 網域**(本機 `Win32_ComputerSystem.Domain` 實測為 `gsmc.com.tw`):`@gsc.com.tw`、`@gsmc.com.tw`、`@ygdmc.gsc.com.tw`(Gateway PRD §8.2、REFERENCES §1.3)。ItAgentBack 不可直接讀 Gateway 資料庫(Gateway `AGENT.md` §10.4)。

### 1.3 裝置上有哪些可判斷公司的資料

| 來源 | 例 | 可信度 | 現況 |
| --- | --- | --- | --- |
| 憑證 DN(`ita.device.cert_dn`,Nginx 驗過的 `x-client-cert-dn`) | 指南 §3.2 建議:網域電腦 `CN=<FQDN>`、非網域 `CN=<公司代碼>-<電腦名稱>` | **高**(IT 的 CA 簽發,端點無法竄改) | E1 **未定案**;測試區臨時 PKI 為 `O=GigaNexus Test,CN=<電腦名稱>`,判斷不出公司 |
| Agent 回報的網域(`ita.device_inventory.domain` / `part_of_domain`) | `gsmc.com.tw`;工作群組為 `WORKGROUP` | 中(端點自行回報,可偽造;偽造者必須已控制該台電腦) | 已有資料;測試 VM 是工作群組 |
| IT 手動指定 | — | 高 | 無欄位 |

### 1.4 受影響的管理 API

| 路由 | `x-permission` | 目前的查找 | 加上範圍後 |
| --- | --- | --- | --- |
| `GET /v1/devices` | read | `sql.listDevices(filter)` | SQL 加 `company IN (...)` |
| `GET /v1/devices/{id}` | read | `DeviceService.found()` | 不在範圍 → 404 `ITA_DEVICE_NOT_FOUND`;`suspectedDuplicates` 只列範圍內的 |
| `GET /v1/devices/{id}/events` | read | `found()` | 同上 |
| `GET /v1/devices/{id}/inventory.json` | read | `found()` | 同上 |
| `PUT /v1/devices/{id}/status` | admin | `found()` | 同上 |
| `POST /v1/devices/{id}/merge` | admin | `found()` × 2 | 目標、來源**都**要在範圍內,任一不在 → 404 |
| `POST /v1/devices/{id}/basic-commands` | basic | `CommandDispatcher.activeDevice()` | 不在範圍 → 404 |
| `POST /v1/batches/basic-commands` | basic | `activeDevice()` × N | 任一台不在範圍 → 整批 404(與既有「任一台不存在就整批拒絕」相同) |
| `GET /v1/devices/{id}/commands`、`GET /v1/commands` | read | `dispatcher.list()` | 有 `deviceId` 時先檢查;無 `deviceId` 時 SQL JOIN `ita.device` 加公司條件 |
| `GET /v1/commands/{id}` | read | `dispatcher.getRecord()` | 依指令所屬裝置的公司;不在範圍 → 404 `ITA_COMMAND_NOT_FOUND` |
| `POST /v1/commands/{id}/cancel` | basic | `getRecord()` + 建立者檢查 | 先範圍(404)再建立者(403) |
| `GET /v1/batches/{id}` | read | `store.getBatch()` | 批次內**所有**裝置都在範圍內才看得到,否則 404(避免從筆數推知其他公司的電腦) |
| `GET /v1/commands/{id}/files/{fileId}` | read | `CommandFileService.open()` | 先以 `dispatcher.get()` 檢查指令範圍,再開檔 |

## 2. 決定事項(2026-10-16 已確認,見開頭)

| # | 問題 | 選項 | 建議 |
| --- | --- | --- | --- |
| **1** | **電腦屬於哪家公司** | A. 只由 IT 手動指定(新電腦先「未指定」)<br>B. 只看憑證 DN(依 E1:FQDN 網域尾碼或 `<公司代碼>-` 前綴)<br>C. 只看 Agent 回報的網域<br>D. **混合**:憑證 DN 判得出就用 → 否則用回報網域 → 都沒有則「未指定」;IT 手動指定優先且之後不再自動改 | **D**。理由:正式區網域電腦多數可自動判定(省人工);E1 未定案、測試 PKI 判斷不出時有網域可退;工作群組 / 子公司電腦由「全部公司」角色手動指定。回報網域可偽造,但偽造者必須已控制該台電腦,最多讓**自己那台**出現在別家公司的清單,不會讓 IT 取得別家電腦的權限;來源記在 `company_source`,畫面可標示「依回報網域」 |
| **2** | **「可管理所有公司」怎麼判斷** | A. 設定檔列角色代碼:`ENDPOINT_SCOPE_ALL_ROLES=it-admin`(Token `roles` 有任一個即全部)<br>B. 新設專用角色(例 `endpoint-all-companies`,不含權限,只當標記),仍經 A 的設定檔指定<br>C. 由 BFF 拆路由 / 新權限代碼(BFF 一條路由只能查一個權限,要整組重複路由,不建議)<br>D. 要求 Gateway 在 `cos` 放 `*`(需改 Gateway,不建議) | **A,測試區先設 `it-admin`**(目前唯一有 admin 的角色,需求方測試方便);正式區要「一般 IT 只管自己公司」時改 B:在 GigaItApp `gateway-rbac.yaml` 新增標記角色(需 GigaItApp 同意),只改設定、不改程式。設定為空 = 沒有人能看全部 |
| 3 | 「未指定公司」的電腦誰看得到 | A. 只有全部公司角色<br>B. 所有人 | **A**(不洩漏;全部公司角色在清單以「未指定」篩選後逐台指定) |
| 4 | 網域 → 公司的對應放哪裡 | A. ItAgentBack 設定 `ENDPOINT_COMPANY_DOMAINS`(JSON)<br>B. 讀 Gateway `gw.company_ad_domain`(跨資料庫,違反 §10.4)<br>C. 請 Gateway 新增查詢 API(需改 Gateway) | **A**:`碩禾=gsc.com.tw,gsmc.com.tw;鹽城碩禾=ygdmc.gsc.com.tw`(實作時由 JSON 改為此格式:放在 Compose 的 env 檔不需處理引號與跳脫,§6.1)。比對**最長尾碼優先**(`ygdmc.gsc.com.tw` 不可被 `gsc.com.tw` 先吃掉),不分大小寫。公司名稱必須與 Gateway `comp_name` 完全一致,啟動時檢查格式、不檢查名稱存在(看不到 Gateway DB) |
| 5 | 憑證 DN 規則(E1 未定) | A. 現在只實作「CN 是 FQDN → 取網域尾碼套 #4 對應」<br>B. 連 `<公司代碼>-` 前綴一起做 | **A**:非網域電腦的前綴格式與公司代碼表要等 E1 / E8 定案;未定前非網域電腦走「回報網域 → 未指定 → 手動」 |
| 6 | 誰可以改電腦的公司 | A. `endpoint.command.admin` 且為全部公司角色<br>B. `endpoint.command.admin` 即可(但只能改成自己 `cos` 內的公司) | **A**:新路由 `PUT /v1/devices/{id}/company`(admin);非全部公司角色回 403 `ITA_SCOPE_ALL_REQUIRED`。B 會讓兩家公司的 IT 互相把電腦搶來搶去 |
| 7 | 指令紀錄跟著誰 | A. 跟著裝置**目前**的公司(電腦改指定公司,歷史指令一起移過去)<br>B. 記錄建立當時的公司 | **A**:不需在 `ita.command` 加欄位,JOIN `ita.device` 即可;改公司寫稽核事件 |
| 8 | GigaItApp 畫面 | 清單加「公司」欄與篩選、詳情「概要」顯示公司與來源、「指定公司」按鈕(新按鈕節點 `includes: [endpoint.command.admin]`) | **另一批(E6-2)**,動 GigaItApp 前再確認;E6-1 只做後端,沒有畫面時全部公司角色可用 API 指定 |
| 9 | Gateway 文件 | 指南 §8.2 補判斷方式、§8.3 加 `PUT .../company`、§10.2 E6 改「已決定」、§11 勾選 | 實作合併前回寫(**需 Gateway 同意**) |

## 3. 設計(以 §2 建議為準;決定不同時改寫本節)

### 3.1 資料表(`0005_device_company.sql`,SQL Server 2012)

```sql
-- 裝置所屬公司(E6):名稱同 Gateway gw.company.comp_name;NULL = 未指定(只有全部公司角色看得到)
ALTER TABLE ita.device ADD
  company        NVARCHAR(20)  NULL,
  company_source VARCHAR(8)    NULL;   -- cert / domain / manual;NULL = 未判定
GO
ALTER TABLE ita.device ADD CONSTRAINT ck_device_company_source
  CHECK (company_source IS NULL OR company_source IN ('cert', 'domain', 'manual'));
GO
CREATE INDEX ix_device_company ON ita.device (company);
GO
```

- 只新增可為 NULL 的欄位,舊版服務不受影響(可先套 migration 再部署)。
- **回填**:同 0004 做法,服務啟動時對 `company_source IS NULL` 的裝置依 §3.3 判定一次(冪等;判不出維持 NULL;失敗只記 warn)。不在 migration 內解析 JSON。

### 3.2 設定(`config.ts`)

| 變數 | 例 | 規則 |
| --- | --- | --- |
| `ENDPOINT_SCOPE_ALL_ROLES` | `it-admin` | 逗號分隔角色代碼;可空(= 沒有人看全部)。test / prod 未設定時**啟動失敗**(避免漏設造成 IT 全部看不到而誤以為故障;要空就明確設為空字串) |
| `ENDPOINT_COMPANY_DOMAINS` | `碩禾=gsc.com.tw,gsmc.com.tw;鹽城碩禾=ygdmc.gsc.com.tw` | `公司=網域,網域;公司=網域`;公司名稱 1–20 字、網域小寫且不可重複指到兩家公司,格式錯**啟動失敗**;可省略(= 不自動判定) |
| dev `DEV_SKIP_TOKEN` | — | `DEV_IDENTITY` 視為全部公司(只在 dev) |

兩個都寫進 `deploy/` 的 `ita.env` 範本(非機密);測試區由需求方更新 `/srv/giganexus/deploy/ita.env`。

### 3.3 公司判定(`src/services/company.ts`,純函式)

```ts
/** 1. 憑證 DN 的 CN 是 FQDN → 網域尾碼;2. Agent 回報的網域(part_of_domain 為 true 才用);判不出回 null */
export function resolveCompany(map: CompanyDomains, certDn: string, inv: { domain: string | null; partOfDomain: boolean | null } | null):
  { company: string; source: 'cert' | 'domain' } | null
```

| 時機 | 規則 |
| --- | --- |
| 新裝置登錄(`identify` 建立列) | 以 DN 判定;判得出寫 `cert` |
| 收到資產(`ingestInventory`) | `company_source` 為 NULL 或 `domain` 時重新判定(電腦換網域會跟著改);`cert` / `manual` 不動。公司有變寫 `company_changed` 事件 |
| IT 指定(`PUT .../company`) | 寫 `manual`,之後不自動改;`company: null` 表示「改回自動判定」(清為 NULL 後立即重判一次) |
| 合併 | 目標的公司不變;目標為 NULL 時取來源的值與來源 |

### 3.4 範圍與集中檢查

```ts
// src/services/scope.ts
export type Scope = { all: true } | { all: false; companies: readonly string[] };
export function scopeOf(id: GatewayIdentity, allRoles: readonly string[]): Scope; // roles ∩ allRoles 非空 → all;否則 cos(去重)
export function inScope(s: Scope, company: string | null): boolean;             // all → true;company 為 NULL → false

// 管理 API 專用的 ctx:型別上必帶 scope,管理方法簽名改收 MgmtCtx
export interface MgmtCtx extends Ctx { scope: Scope }
```

- 路由的 `ctx(req)` 改為 `mgmtCtx(req)`,在 `mgmt-app.ts` 驗完 Token 後計算一次 `req.scope`;Agent 通道仍用 `Ctx`(沒有 scope,也不會呼叫管理方法)。
- **單點查找**:`DeviceService.found(ctx: MgmtCtx, id)` 查到後 `inScope` 不成立就丟與「不存在」完全相同的 404(相同代碼、訊息;日誌記 `scopeDenied: true` 方便追查)。`CommandDispatcher.activeDevice` 改呼叫這個(不再直接 `devices.getDevice`)。
- **指令查找**:`CommandRecord` 加 `deviceCompany`(`listCommands` / `getCommand` 的 SQL 已 JOIN `ita.device`,只多選一欄),`getRecord(ctx, id)` 檢查範圍;`CommandFileService.open` 改收 `MgmtCtx`,先呼叫 `dispatcher.get()`。
- **清單類**:`DeviceFilter` / `CommandFilter` 加 `companies?: string[]`(`undefined` = 全部;`[]` = 一律空結果,不送 SQL),SQL 以 `@co0, @co1…` 參數組 `IN`。`listDevices` 另接受查詢參數 `company`(指定一家,必須在範圍內;`company=` 空值 = 未指定,只有全部公司角色可用)。
- `findByHwFingerprint`(疑似同一台)也帶範圍:不讓 A 公司 IT 從提示看到 B 公司的電腦。
- 回應只新增欄位:清單與詳情加 `company`、`companySource`。

### 3.5 新路由

| 方法 | 路徑 | `x-permission` | 說明 |
| --- | --- | --- | --- |
| `PUT` | `/v1/devices/{id}/company` | `endpoint.command.admin` | `{ company: string \| null, reason }`;全部公司角色才可用(否則 403 `ITA_SCOPE_ALL_REQUIRED`);已合併的裝置回 409 `ITA_DEVICE_STATUS_INVALID`;寫 `company_changed` 事件(舊值、新值、來源、操作人)。`x-audit-level: meta`。公司名稱不檢查是否存在於 Gateway(看不到),畫面以下拉選單提供 `ENDPOINT_COMPANY_DOMAINS` 的公司與清單中已出現的公司 |

錯誤代碼只新增 `ITA_SCOPE_ALL_REQUIRED`(403)。範圍外一律沿用既有 404:`ITA_DEVICE_NOT_FOUND`、`ITA_COMMAND_NOT_FOUND`、`ITA_BATCH_NOT_FOUND`、`ITA_COMMAND_FILE_NOT_FOUND`。

### 3.6 不做

- Agent 端、資料契約、`:51241` 不變。
- 不在 `ita.command` / `ita.command_batch` 加公司欄位(§2 #7)。
- 不讀 Gateway 資料庫、不改 BFF。
- 稽核仍以 `emp` 為準;不另記操作人的 `cos`。

## 4. 分批

| 批 | 內容 | repo | 需要同意 |
| --- | --- | --- | --- |
| **E6-1** | migration 0005、`scope.ts` / `company.ts`、service 集中檢查、`PUT .../company`、回填、設定與 `ita.env` 範本、測試 | RustIt | migration 套用 `giganexus_It_Agent_test` 前;合併 develop 前(測試區共用,群組告知) |
| E6-2 | GigaItApp:公司欄 / 篩選 / 指定公司按鈕;`gateway-rbac.yaml` 新按鈕節點(與 #2 B 的標記角色,若採用) | GigaItApp | 動手前 |
| E6-3 | 指南 §8.2、§8.3、§10.2 E6、§11 回寫 | Gateway | 動手前 |

## 5. 測試計畫

**單元(`npm test`,記憶體 store)**

- `scopeOf`:`roles` 命中設定 → all;未命中 → `cos`;`cos` 空 / 缺 → 空範圍;API Key 身分 → 空範圍;設定為空 → 沒有人 all。
- `resolveCompany`:FQDN CN、`O=…,CN=<短名>`(判不出)、回報網域大小寫、最長尾碼(`x.ygdmc.gsc.com.tw` → 鹽城碩禾)、`part_of_domain=false`、未知網域 → null。
- 設定:JSON 格式錯、同一網域指到兩家公司、test / prod 缺 `ENDPOINT_SCOPE_ALL_ROLES` → 啟動失敗。
- 管理 API(以 A 公司、B 公司、全部公司三種 Token 跑**每一條** §1.4 路由):A 看不到 / 操作不了 B 與未指定的電腦,回 404 且回應本文與「真的不存在」**逐欄相同**;清單 `total` 不含範圍外;批次含一台範圍外 → 整批 404 且**沒有建立任何指令**;合併來源或目標任一範圍外 → 404 且資料未變;批次查詢含範圍外裝置 → 404;附檔下載範圍外 → 404;取消他公司指令 → 404(不是 403);`suspectedDuplicates` 不含範圍外。
- 全部公司角色:看得到未指定;`company=` 篩選;`PUT .../company` 改為 manual、事件、之後收到資產不再自動改;`null` 改回自動;非全部公司 → 403。
- 收到資產:`domain` 來源隨網域變更、`cert` / `manual` 不變。
- 路由清單比對:測試列舉 `mgmt-app` 註冊的所有路由,除健康檢查與 OpenAPI 外都必須在「已驗證範圍」清單內(新增路由忘了範圍測試會失敗)。

**整合(`npm run test:int`,SQL Server 2012 `giganexus_It_Agent_poc_test`)**

- 0005 套用;`listDevices` / `listCommands` 的 `IN` 參數(0、1、多家公司)、`company IS NULL` 篩選;回填冪等;合併後目標公司規則。

**測試區(E6-1 合併後,需求方登入)**

1. `ita.env` 設 `ENDPOINT_SCOPE_ALL_ROLES=it-admin` 與網域對應 → 部署後自己的電腦自動為 `碩禾`(`domain`),VM(工作群組)為未指定。
2. it-admin 看得到兩台;以 API 把 VM 指定為 `碩禾`。
3. 另一個只有 `endpoint.device.read`、`cos` 為其他公司的測試帳號(需求方準備)→ 清單為空、直接打 VM 的 deviceId 回 404。
4. 確認 IT 人員在 Gateway 都有所屬公司(`/api/auth/me` 的公司不是空的)。

## 6. 部署順序

1. migration 0005 套用 `giganexus_It_Agent_test`(**先問**)。✅ 2026-10-16
2. 需求方更新主機 2 `/srv/giganexus/deploy/ita.env`(兩個新變數;未設定時新版啟動失敗,所以**必須在合併前**)。
3. RustIt 合併 develop(群組告知)→ endpoint-server 自動註冊 OpenAPI(新路由 `PUT .../company` 進草稿,IT 發佈)。
4. E6-2 / E6-3 依同意另行處理。

## 6.1 實作與驗證(2026-10-16,分支 `feature/e6-company-scope`)

- ItAgentBack:migration 0005;`services/scope.ts`(`scopeOf`、`inScope`、`MgmtCtx`)、`services/company.ts`(網域對應解析、`resolveCompany`)、`routes/mgmt-ctx.ts`;`DeviceService.found()` 與 `CommandDispatcher.scopedDevice()` / `getRecord()` / `batchInScope()`、`CommandFileService.open()` / `forCommand()` 檢查範圍;清單類以 SQL `company IN (...)` 過濾;`PUT /v1/devices/{id}/company`;啟動回填 `backfillCompany`;Compose / `test.env.example` 加兩個設定(`ENDPOINT_SCOPE_ALL_ROLES` 未設定時 Compose 與服務都啟動失敗)。
- 測試:`npm test` 124 項(新增 `test/scope.test.ts`:純函式、四種 Token × 每條管理 API、範圍外與不存在回應逐欄相同、批次與合併不留下資料、Idempotency-Key、公司自動判定與指定、回填、路由清單比對)全部通過;暫時拿掉 `found()` 的範圍檢查時 5 項失敗(測試有效)。`npm run test:int` 10 項(SQL Server 2012 `giganexus_It_Agent_poc_test`:0005、IN 參數 0 / 1 / 多家、`IS NULL`、`setCompany` 不覆寫 manual、回填、合併繼承、CHECK)全部通過。
- 子代理審查(`code-reviewer`、`security-auditor`,無高嚴重度)後的修正:`suspected_duplicate` 事件內容提到範圍外的裝置時改為不含識別資訊的說明;清單 / 詳情的 `suspectedDuplicate` 標記只看範圍內的另一台;併入的目標在範圍外時 `mergedInto`(含 409 details)回 null;SQL 公司比對改二進位定序;`GET /v1/commands?batchId=` 與 `GET /v1/batches/{id}` 一致(含範圍外裝置視同不存在);批次 Idempotency-Key 命中範圍外的批次回 404。
- **與設計不同**:`ENDPOINT_COMPANY_DOMAINS` 由 JSON 改為 `公司=網域,網域;公司=網域`(§2 #4、§3.2 已改);`CommandFileService` 自行檢查範圍(不經 dispatcher,邏輯相同)。
- migration 0005 已套用 `giganexus_It_Agent_test`(2026-10-16,經需求方同意;欄位、CHECK、索引確認,既有 3 台皆未指定,新版部署後啟動回填)。
- **測試區(2026-10-16)**:MR !25 合併後第一次 deploy-test 因主機 2 `ita.env` 尚未設定 `ENDPOINT_SCOPE_ALL_ROLES` 在 compose 階段失敗(保護如預期,舊版 `bde3369a` 持續運作);需求方同意後於 `ita.env` 加 `ENDPOINT_SCOPE_ALL_ROLES=it-admin`、`ENDPOINT_COMPANY_DOMAINS=碩禾=gsc.com.tw,gsmc.com.tw`(公司名稱用 LOS 的「碩禾」,碩禾員工的 `cos`;鹽城碩禾尚未開放登入先不列;備份 `ita.env.bak-20261016`),重跑後 `3081af75` healthy。啟動回填 2 台:開發機兩筆登錄分別為 `cert`(CN 為 FQDN)與 `domain`(回報 `gsmc.com.tw`)→ 碩禾;VM `DESKTOP-1TB2UMP`(WORKGROUP)維持未指定。OpenAPI 批次 112(新增 `PUT /v1/devices/{id}/company`)待 IT 發佈。
- **未做**:E6-2(GigaItApp)、E6-3(指南回寫)待同意;`test.env.example` 的公司名稱(碩禾、鹽城碩禾)須與測試區 Gateway `gw.company.comp_name` 核對。

## 7. 風險

| 風險 | 處理 |
| --- | --- |
| IT 人員 `cos` 為空 → 看不到任何電腦,像故障 | 部署前以 `/api/auth/me` 確認;清單回應不提示原因(避免洩漏),日誌記 `scope: empty` |
| Gateway 公司改名(LOS `CompName` 變更)→ 裝置的 `company` 對不上 | 屬罕見事件;改名時以 SQL `UPDATE ita.device SET company = …` 一併處理(寫進 DB_SCHEMA 維運說明) |
| 回報網域可偽造 | 見 §2 #1;正式區憑證採 FQDN 後以 `cert` 為主。資安稽核補充:憑證 CN 不是 FQDN 時(測試區臨時 PKI),該台的本機管理員可改 Agent 回報讓**自己那台**變成未指定(所屬公司 IT 看不到,只有全部公司角色看得到)或歸到別家公司;不影響其他電腦。目前接受(公司變更會寫 `company_changed` 事件),**上線檢查加入「正式區裝置憑證 CN 必須是 FQDN」**(指南 E1) |
| 公司名稱大小寫 / 全半形 | SQL 比對一律 `COLLATE Latin1_General_BIN2`,與 service 逐字比對一致;`cos` 超過 20 字的名稱直接略過 |
| 修改 `ENDPOINT_COMPANY_DOMAINS` | 來源為 `domain` 的既有裝置要等下次資產內容變動才重算(啟動回填只處理未判定的) |
| 清單在 service 分頁、在線篩選在 Redis | 範圍條件在 SQL,分頁仍正確;不影響 |
