# 新增功能紀錄

新紀錄加在最上方;格式見 `AGENT.md` §10。

## 2026-10-06 M0 目錄重整與資料契約
- 內容:依 INTEGRATION-PLAN §2(決策 D6)以 `git mv` 把 Rust 檔案搬入 `RustAgent/`(`Cargo.toml`、`Cargo.lock`、`crates/`、`scripts/`、`docs/ui-performance-comparison.md`、`docs/images/`),搬移單獨一個 commit(a1ec3f4,40 個 rename、0 行內容變更);未進版控的 `dist/` 一併移入。之後修正路徑:`.gitignore`(`/RustAgent/target`、`/RustAgent/dist` 等)、`README.md`、`AGENT.md` 開頭、`docs/PROJECT-MAP.md`;`scripts/bench.ps1` 以腳本上一層為根目錄,搬移後不需修改。新增 `docs/contracts/`:`inventory.schema.json`(請求 + `InventoryResponse`)、`ws-envelope.schema.json`(`hello` / `hello_ack` / `heartbeat` / `heartbeat_ack` / `unsupported`)、`sync.schema.json`(M5)與 9 個去識別化範例(RFC 5737 IP、RFC 7042 MAC、EXAMPLE 字樣;未使用 `dump` 的真實結果)。契約重點:`content_hash` = 把 `collect_ms` 設 0 後的 serde_json SHA-256,Server 只比對相等;`agent_seq` 須重啟後仍遞增(M5 前以啟動時 Unix 毫秒為起點);新增欄位不得列入 `required`。根目錄 `PROJECT-MAP.md` 的效能比較表連結改為 `RustIt/RustAgent/docs/`(根目錄 b4a9318)。
- 檔案:`.gitignore`、`README.md`、`AGENT.md`、`docs/PROJECT-MAP.md`、`docs/contracts/`(README、3 個 schema、`examples/`)
- 驗證:本機原無 Rust 工具鏈,經需求方同意以 winget 安裝 VS 2022 Build Tools(C++)與 rustup(rustc 1.99.0 stable-msvc);`RustAgent/` 下 `cargo build`(collector、demo、native)成功、`cargo test -p rustit-collector` 通過(collector 無測試案例,範例可編譯)。契約範例由兩端測試驗證:ItAgentBack `npm test`(Ajv draft-07)、RustAgent `cargo test -p rustit-agent`(jsonschema),見 M1、M2 紀錄。

## 2026-10-06 釐清端點權限 403 的原因(D9)
- 內容:IT 管理系統「電腦清單」進頁 403(S112009 無 `endpoint.device.read`)。查 `GigaItApp/deploy/gateway-rbac.yaml`:`it.endpoint-device.read` 與 `.list` 沒有 `includes`(其他節點都綁對應 API 權限),且 `endpoint.device.read` 在 Gateway 內沒有任何定義,要等 Endpoint Server 的 OpenAPI 註冊才會建立。結論:代碼命名沒錯(`it.*` 為應用權限、`endpoint.*` 為 API 權限),缺的是綁定;改於整合計畫 M4(先註冊 OpenAPI,再補 `includes` 並 apply),不需手動 SQL 指派。D7(PEM 憑證)確認。僅文件,未改 GigaItApp。
- 檔案:`docs/INTEGRATION-PLAN.md`(M4、D7、D9、§9)
- 驗證:對照 `gateway-rbac.yaml`、權限試算畫面截圖(端點管理三節點無「隨附」標籤)、Gateway `grep endpoint.device` 無任何定義。**尚未在測試區 DB 確認該權限不存在**(需登入「權限設定 › API 權限」查看)。

## 2026-10-06 決策確認與跨 repo 文件同步
- 內容:需求方確認 D1–D6、D8(資料庫命名、`mssql` + 手寫 migration、SQLite + AES-GCM、目錄拆分與共用文件位置、主管同意本庫不加密連線)。同步其他 repo 文件:Gateway(`ENDPOINT-AGENT-GUIDE.md` v0.4、`AGENT.md` §10、`PROJECT-MAP.md`、`ARCHITECTURE.md`、`PRD.md` 圖例)、根目錄(`PROJECT-MAP.md`、`AGENT.md` §3)、`GigaNexusAIPlan/architecture/workspace.json`(新增 `sql-ita`、`ita-mongo-redis` 與關係,`npm run arch:check` 通過)。NexusPlan 甘特圖新增 W6-7 ~ W6-12(M0–M5,2026-10-06 ~ 10-07)與相依;W6 原有高階工作維持原排程。僅文件。
- 檔案:`docs/INTEGRATION-PLAN.md`;其他 repo 見各自 `docs/DevelopmentProcess/` 與 git 紀錄
- 驗證:`npm run arch:check` 通過;`grep Axum` 於 Gateway 僅剩歷史說明;甘特圖以 API 新增後回傳 200。

## 2026-10-06 整合計畫 v0.2:三種資料庫、Agent 本機加密暫存、目錄拆分
- 內容:依需求方回覆更新計畫——儲存改為 SQL Server `giganexus_It_Agent*`(唯一真相)+ MongoDB(快照歷史)+ Redis(在線狀態);Agent 本機加密暫存與連線後 `/sync` 比對;`RustIt/` 拆為 `RustAgent/`(Rust)與 `ItAgentBack/`(Node.js),共用文件留 `RustIt/docs/`;基本階段限縮為「前後端通、資料庫寫入、ItApp 看到資訊」,並加入往 IP-guard / SmartIT 的路線圖。僅文件;建庫指令待需求方確認 D2 後提供,由需求方執行。
- 檔案:`docs/INTEGRATION-PLAN.md`、`docs/decisions/0004-node-endpoint-server.md`、`AGENT.md`、`docs/PROJECT-MAP.md`
- 驗證:純文件;對照 Gateway `DATABASE.md` §0(SQL Server 2012 限制)、`giga-observe/docker-compose.yml`(Mongo / Redis 不對外)、`gw-environments`(資料庫環境命名)。

## 2026-10-06 整合計畫、AGENT.md、Endpoint Server 改 Node.js 決策
- 內容:規劃 Agent → Node.js Endpoint Server → GigaItApp 電腦清單的接通(目標:IT 畫面看到自己電腦的基本資訊);新增 RustIt 根目錄 `AGENT.md`(結構對齊 GigaItApp,含 AI 分工、部署區、Rust 與 Node.js 規則);記錄 Endpoint Server 由 Rust Axum 改為 Node.js(ADR 0004)。僅文件,**尚未動任何程式碼,也未修改其他 repo**。
- 檔案:`AGENT.md`、`docs/INTEGRATION-PLAN.md`、`docs/decisions/0004-node-endpoint-server.md`、`docs/DevelopmentProcess/NewFeatures.md`、`docs/PROJECT-MAP.md`、`README.md`
- 驗證:純文件,無指令可執行;對照 Gateway `ENDPOINT-AGENT-GUIDE.md`(§2–§8)、`BACKEND-GUIDE.md` §3–§4、GigaItApp `Devices.vue` 與 `types.ts` 確認欄位、port、權限代碼一致。待辦:Gateway 文件與 `workspace.json` 同步(ADR 0004「需同步的文件」,需先取得同意)。
