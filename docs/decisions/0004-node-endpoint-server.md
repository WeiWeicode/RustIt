# 0004:Endpoint Server 改用 Node.js(Rust 只負責端點)

- 日期:2026-10-06
- 狀態:**建議中**(需求方口頭決定;Gateway 文件尚未同步,見「需同步的文件」)
- 相關:[整合計畫](../INTEGRATION-PLAN.md)、[PROJECT-MAP](../PROJECT-MAP.md)、`../../giga-api-gateway-bff/docs/ENDPOINT-AGENT-GUIDE.md` §2、§5、§8

## 結論

1. **Endpoint Server 以 Node.js(Fastify + TypeScript)實作**,放在本 repo 的 `ItAgentBack/`(與 Rust 的 `RustAgent/` 並列的子專案),取代原規劃的 `crates/server`(Rust + Axum)。
2. **Rust 只做端點電腦上的程式**(`RustAgent/`):`collector`(資料蒐集)、`agent`、之後的 `watchdog`、`tray`。
3. 通道、port、權限代碼、路由規則**不變**:Agent 經 Gateway `:9443` → `endpoint-agent`(51241,HTTPS / WebSocket);IT 前端經 BFF → `endpoint-api`(51240)。Agent 看不出後端是 Rust 還是 Node。
4. Agent 與 Server 不再共用 Rust crate,改以**資料契約**(`docs/contracts/`,JSON Schema + 範例檔)為準;兩邊各自用契約檔做測試。

## 為什麼

- Gateway 的下游後端樣本(`samples/node-backend`)、`@giganexus/backend-sdk`(自動註冊 OpenAPI、驗證 `X-Internal-Token`)、`giga-observe` 監控 SDK 都是 Node.js 版本;Rust 要自己寫註冊與驗證(ENDPOINT-AGENT-GUIDE §8.3 已註明「目前只有 Node.js SDK」)。
- 團隊的後端經驗在 Node.js(itapp-api、BFF);Endpoint Server 是 IT 工具而非高吞吐服務,1,000 台以內 Node.js 綽綽有餘。
- Rust 的價值留在端點:單一 exe、低記憶體、Windows API。

## 代價與風險

| 項目 | 影響 | 對策 |
| --- | --- | --- |
| 失去 Agent / Server 共用型別 | 欄位改名可能兩邊不同步 | 契約檔 + 兩邊各一組契約測試(同一份範例 JSON) |
| Node.js 的 WebSocket 連線數 | 1,000 條常駐連線 | `ws` 套件實測;單一實例;心跳 30 秒 |
| Gateway 文件寫「Rust + Axum」 | 文件與實作不一致 | 先取得同意再改 Gateway 文件(見下) |

## 需同步的文件(其他 repo,**取得同意後才改**,AGENT.md §3、Gateway AGENT.md §10.5)

- `../giga-api-gateway-bff/docs/ENDPOINT-AGENT-GUIDE.md`:標題、§1 適用對象、§2 圖、§5 標題與 Axum extractor 範例改為 Node.js(Fastify hook);§8.1 的「Endpoint Server(Rust)」。
- `../giga-api-gateway-bff/AGENT.md` §10.2 `RustIt` 列、§10.7.2 加一列「RustIt/ItAgentBack」沿用 TypeScript / Node.js 後端。
- `../GigaNexusAIPlan/architecture/workspace.json` 的 `endpoint-server`:說明改為 Node.js、`status` 隨實作更新;新增 `architecture/projects/` 內部架構時一併處理。
- 本 repo:`PROJECT-MAP.md`、`README.md`、PRD §3 的「後端 API:Rust + Axum」;外層根目錄 `PROJECT-MAP.md`、`AGENT.md` §3(目錄拆分見整合計畫 §2)。
- 資料庫(SQL Server `giganexus_It_Agent*`、MongoDB、Redis)與目錄拆分的決定記在 [整合計畫](../INTEGRATION-PLAN.md) §2–§3,不另開 ADR。
