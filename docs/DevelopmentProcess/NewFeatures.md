# 新增功能紀錄

新紀錄加在最上方;格式見 `AGENT.md` §10。

## 2026-10-06 M2 RustAgent MVP(`rustit-agent`)
- 內容:新增 `RustAgent/crates/agent`(前景執行 `rustit-agent run --config agent.toml`)。啟動隨機延遲 0–30 秒後兩個工作:資產回報(collector 在背景執行緒蒐集 → `POST /agent/v1/inventory`,預設每小時)與 WebSocket(`hello` → 依 `hello_ack` 的間隔每 30 秒 `heartbeat`;超過 3 個間隔沒收到 Server 訊息即重連;不認得的 type 回 `unsupported`;close 4403 視為停用)。重試:一般錯誤 1 秒起指數退避、上限 2 分鐘、±20%;HTTP 400 / 401 / 403 每 10 分鐘(指南 §4.2、§6.3)。HTTPS(reqwest 0.13 `rustls-no-provider`)與 WebSocket(tokio-tungstenite 0.30)共用一個 `rustls::ClientConfig`,加密套件用 ring(不用 aws-lc-rs,Windows 建置不需 CMake / NASM);憑證來源 trait `CertSource`,本階段只有 PEM 檔。`agent.toml`:https 必須有 `[tls]`;http 只允許 127.0.0.1 / localhost;`[dev] simulate_client_cert` 自帶 `x-client-cert-*`(DN 預設 `O=GigaNexus Dev,CN=<電腦名稱>`、指紋為 DN 的 SHA-256 前 40 字)。`agent_seq` 以啟動時 Unix 毫秒為起點(M5 改為本機暫存)。日誌不含私鑰與軟體清單,只記筆數。新增相依:reqwest、tokio-tungstenite、rustls、futures-util、toml、sha2、hex、uuid、chrono、fastrand、url、log、env_logger(多數已在 Cargo.lock);dev:jsonschema(`default-features = false`)。
- 檔案:`RustAgent/Cargo.toml`(workspace 加入 agent)、`RustAgent/crates/agent/`(`src/` 9 個模組、`tests/contract.rs`、`agent.dev.toml`、`agent.example.toml`)、`.gitignore`、`docs/PROJECT-MAP.md`
- 驗證:`cargo test -p rustit-agent` 12 項通過(設定、退避範圍、錯誤分類、content_hash、契約:送出的 inventory / hello / heartbeat / unsupported 通過 `docs/contracts` schema,Server 範例可解析);`cargo clippy -p rustit-agent --all-targets` 無警告。本機閉環(使用者自己的電腦):ItAgentBack(dev)+ `cargo run -p rustit-agent -- run --config crates/agent/agent.dev.toml` → WebSocket 連線並收到 `hello_ack`、第一份回報 `stored`(debug 版蒐集 6.4 秒、軟體 111 筆);SQL Server `giganexus_It_Agent_test` 有裝置與摘要(電腦名稱、OS、CPU、記憶體、3 個 IPv4)、Redis 有 `ita:dev:online:*`(TTL 90 秒,心跳後續期至 88)與 hash、Mongo 有 1 份快照與心跳;強制結束 Agent 行程後 Server 同一刻收到 close 1006、清單變離線(半開連線的 90 秒逾時由 ItAgentBack 單元測試涵蓋)。

## 2026-10-06 M1 ItAgentBack 骨架與資料層
- 內容:新增 `ItAgentBack/`(Node.js 22、Fastify 5、TypeScript strict;結構沿用 Gateway `samples/node-backend`,`gateway.project = RustIt`,SDK `@giganexus/backend-sdk` 0.3 取自 GitLab npm Registry)。兩個 Fastify 實例:`:51240` 管理 API(`X-Internal-Token`,aud `endpoint-api`;`GET /v1/devices`、`/v1/devices/{deviceId}`,`x-permission: endpoint.device.read`,OpenAPI `x-gateway.system = endpoint`,test / prod 由 setupGateway 自動註冊草稿)與 `:51241` Agent 通道(身分 hook:`x-client-verify=SUCCESS` + DN + 40 字指紋,且來源須在 `AGENT_TRUSTED_PROXIES`;`POST /agent/v1/inventory` 以契約 schema 驗證、`WS /agent/v1/ws` 處理 hello / heartbeat / unsupported、同裝置第二條連線以 4409 關閉舊連線並寫稽核、每 10 秒檢查心跳逾時)。寫入順序與降級集中在 `DeviceService`(§3.1);三個 store:mssql(`encrypt: false`,連不上不阻擋啟動、回 503)、MongoDB 6 驅動(TTL 索引、重複補傳去重)、ioredis 6(`enableOfflineQueue: false`,失敗退回本機連線表)。手寫 migration(`0001_init.sql` 四張表 + `ita.schema_migration` 含 checksum)與整合測試庫重建(只允許 `*_poc_test`)。設定:dev 旁路 `DEV_TRUST_CLIENT_HEADERS` / `DEV_SKIP_TOKEN` 非 dev 設定即啟動失敗;test / prod 機密只收 `*_FILE`、`:51241` 必須 TLS;dev 預設只聽 127.0.0.1。開發用 compose 起 Mongo 7 / Redis 7(只綁 127.0.0.1:27027 / 6389;測試區 compose 於 M4 不宣告 ports)。建庫 T-SQL 由需求方以 sa 執行(16 句成功)。
- 檔案:`ItAgentBack/`(`src/`、`test/`、`db/dba/01-create-databases.sql`、`db/migrations/0001_init.sql`、`deploy/docker-compose.dev.yml`、`docs/DB_SCHEMA.md`、`README.md`、`.env.example`)、根目錄 `.claude/launch.json`(`itagentback`)、`docs/PROJECT-MAP.md`
- 驗證:`npm test` 35 項通過(契約範例與相容規則、未帶憑證標頭 / 來源不符 401、首次登錄與新指紋稽核、停用 403、hash 沒變不寫庫、補傳舊快照只進歷史、SQL 失敗 503 且 Mongo / Redis 不寫、Mongo + Redis 失敗仍成功、契約不符 400、WebSocket hello_ack / heartbeat_ack / unsupported、關閉即離線、90 秒逾時離線、Redis 故障退回連線表、第二條連線 4409、OpenAPI 上架檢查、Token 缺少 / aud 不符 401、部署區設定);`npm run typecheck`、`npm run build` 通過;`npm run db:migrate` 已套用到 `giganexus_It_Agent_test`;`npm run test:int` 4 項通過(SQL Server 2012 + 本機 Mongo / Redis);`/readyz` 回 sql / mongo / redis 皆 ok。注意:本機 Windows 保留 TCP 51176–51275,dev 改用 51296 / 51297(`.env`;51291 為 itapp-api 已登記,不可用),測試區 / 正式區不變。

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
