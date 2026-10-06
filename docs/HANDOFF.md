# 交接:RustIt 整合(M0–M5 程式實作)

> 建立:2026-10-06。給接手寫程式的 AI(Opus)與工程師。**先讀 `../AGENT.md`,再讀 [INTEGRATION-PLAN.md](INTEGRATION-PLAN.md)(v0.3,完整計畫與完成標準)**;本文只補「現在做到哪、哪些已決定、哪些要先問、怎麼開始」。

## 1. 一句話目標

基本階段(兩天內,甘特圖 W6-7 ~ W6-12):RustAgent 經 Gateway `:9443` 連到 ItAgentBack(Node.js)→ 寫入 SQL Server / Mongo / Redis → GigaItApp「電腦清單」看到使用者自己電腦的基本資訊。進階功能(下指令、軟體派送、遠端、控管、報修)**不做**,等員工入口網與 GigaItApp 完善後再說。

## 2. 目前狀態(2026-10-06)

| 項目 | 狀態 |
| --- | --- |
| 計畫、AGENT.md、ADR 0004、本交接文件 | ✅ 已寫,**尚未 commit**(RustIt:`AGENT.md`、`docs/INTEGRATION-PLAN.md`、`docs/HANDOFF.md`、`docs/decisions/0004-*`、`docs/DevelopmentProcess/`、`README.md`、`docs/PROJECT-MAP.md`) |
| 跨 repo 文件同步 | ✅ 已改,**尚未 commit**:Gateway(`ENDPOINT-AGENT-GUIDE.md` v0.4、`AGENT.md`、`PROJECT-MAP.md`、`ARCHITECTURE.md`、`PRD.md`、`DevelopmentProcess/NewFeatures.md`);根目錄(`PROJECT-MAP.md`、`AGENT.md`、`GigaNexusAIPlan/architecture/workspace.json`,`npm run arch:check` 通過) |
| 甘特圖 | ✅ 已新增 W6-7 ~ W6-12(M0–M5,10/6–10/7,進度 0%);W6 原有 W6-1 ~ W6-M 維持原排程 |
| 程式碼 | ❌ **一行都還沒寫**:`RustAgent/crates/agent`、`ItAgentBack/`、`docs/contracts/` 都不存在;目錄尚未搬移 |
| SQL Server 資料庫 | ❌ 尚未建立(由使用者執行,見 §4) |
| Gateway `agent.conf` | ⚠ 仍是 gRPC 版 |
| 倉庫分支 | 根目錄、`giga-api-gateway-bff`、`RustIt` 在 `main`;`GigaItApp` 在 `develop`。**各 repo 各自 commit**;CI 部署分支規則見記憶 `ci-deploy-branches`(BFF 推 `main:develop` 才部署) |

## 3. 已決定(不要重新討論)

| # | 決定 |
| --- | --- |
| D1 | Endpoint Server 用 **Node.js(Fastify + TypeScript)**,放 `RustIt/ItAgentBack/`,取代 Rust Axum;Rust 只做端點(ADR 0004) |
| D2 | 資料庫:正式 `giganexus_It_Agent`、開發 + 測試共用 `giganexus_It_Agent_test`、整合測試 `giganexus_It_Agent_poc_test`(整合測試會清空 schema,不可指向前兩者);主機 `10.10.130.220`;帳號 `ita_app` / `ita_migrate`(正式 `ita_prod_*`) |
| D3 | `mssql` 驅動 + **手寫 SQL migration**,不用 ORM;SQL Server 2012 語法(無 JSON 函式、無 `CREATE OR ALTER`) |
| D4 | Agent 本機離線暫存:SQLite(`rusqlite` bundled)+ AES-256-GCM 欄位加密 + DPAPI 保護金鑰;不用 SQLCipher |
| D5 | MongoDB(快照歷史)+ Redis(在線狀態、快取)放進基本階段;**SQL Server 是唯一真相**,Mongo / Redis 可重建 |
| D6 | 目錄:`RustIt/RustAgent/`(Rust,`git mv` 搬 `Cargo.*`、`crates/`、`scripts/`、`dist/`、`ui-performance-comparison.md`、`images/`)+ `RustIt/ItAgentBack/`;PRD、PROJECT-MAP、decisions、contracts、DevelopmentProcess 留 `RustIt/docs/`;資料夾 `RustIt` 與 `x-gateway.project: RustIt` 不變 |
| D7 | 測試區裝置憑證先用 `giga-api-gateway-bff/deploy/gen-temp-pki.sh` 簽的 PEM |
| D8 | 主管已同意 `giganexus_It_Agent*` 同 Gateway 做法:內網連線 `encrypt: false` |
| D9 | `endpoint.device.read` 403 的原因是 **缺 `includes` 綁定**,不是命名錯誤(見 §5) |
| 其他 | dev 旁路(`DEV_TRUST_CLIENT_HEADERS`、`DEV_SKIP_TOKEN`)可用,**`GW_ENV` 非 `dev` 有設定就啟動失敗**;離線暫存與比對(M5)排最後,時間不夠可整段延後 |

## 4. 需要使用者親自做的事(AI 不可代做)

- **建庫**:AI **不用 `sa`**、不連 `10.10.130.220` 建庫。M1 開工時由 AI 產出 T-SQL(建立 `giganexus_It_Agent_test`、`giganexus_It_Agent_poc_test`、登入帳號 `ita_app` / `ita_migrate`、schema `ita`、權限;密碼用佔位字串),**貼給使用者在 SQL Server 執行**;使用者把帳密放進 `ItAgentBack/.env`(不進版控)與主機 2 機密。正式庫等 2026-12 正式區再建。
- **輸入任何真實帳密**:瀏覽器登入 Gateway / IT 管理系統由使用者自己做(`GigaItApp/AGENT.md` §9)。
- **任何機密**:不要印在對話或寫進 repo。

## 5. 權限 403 的處理(寫在計畫 M4,別提前做)

`GigaItApp/deploy/gateway-rbac.yaml` 的 `it.endpoint-device.read`(選單)與 `it.endpoint-device.list`(Tab)沒有 `includes`,且 Gateway 內沒有 `endpoint.device.read` 這個 API 權限(要等 ItAgentBack 的 OpenAPI 註冊才會建立)。**順序**:ItAgentBack 部署到測試區並註冊 OpenAPI(`x-permission: endpoint.device.read`)→ 再把兩個節點補 `includes: [endpoint.device.read]` 並 apply。S112009 已有 `it-admin`,綁定後自動取得,不需 SQL 指派。先補綁定會讓 apply 找不到權限。

## 6. 執行順序與驗收(詳見 INTEGRATION-PLAN §6)

M0 目錄重整 + 契約 → M1 ItAgentBack(骨架、三種儲存、管理 API、dev 旁路)→ M2 RustAgent MVP → **M3 GigaItApp 顯示(本機閉環,三項驗收達成)** → M4 測試區接通 → M5 離線暫存與 `/sync`。每個里程碑要能獨立驗證;M3 完成就等於基本階段的 1、2、3 在本機成立。

建議 commit 切法(各 repo 各自 commit,**commit 前先問使用者**):

1. RustIt:先 commit 目前的文件(計畫、AGENT.md、ADR、本檔);Gateway、根目錄的文件同步也各 commit 一次。
2. M0 的 `git mv` 搬移**單獨一個 commit**(只搬、不改內容),之後再修路徑。

## 7. 要先取得同意才能做的事(Gateway `AGENT.md` §10.5)

| 動作 | 狀態 |
| --- | --- |
| 改文件(Gateway、根目錄、workspace.json、甘特圖) | ✅ 已同意並完成 |
| 改 **GigaItApp 程式**(`types.ts`、`Devices.vue`、`vite.config.ts` 開發 proxy、`gateway-rbac.yaml`) | 計畫已列(§9),**動手前(M3)簡短確認一次** |
| 改 **Gateway 程式**(`nginx/conf.d/agent.conf`、E2E `06-websocket-agent`、`tools/mock-upstream/endpoint.js`、`deploy/`、env `ENDPOINT_GRPC_UPSTREAM` → `ENDPOINT_AGENT_UPSTREAM`) | 計畫已列,**動手前(M4)簡短確認一次**;先改 mock 與 E2E,再改 Nginx,`nginx -t` 與 E2E 全綠才合併 |
| 主機 2 部署(`test.env`、機密、容器)、推 `develop` 觸發 CI | M4 動手前確認;主機 2 建置要 `--pull`(記憶 `host2-node-image-pull`) |
| 測試區是否可從使用者電腦連 `:9443` | M4 前先 `Test-NetConnection 10.10.130.124 -Port 9443`;不通就回報,不改防火牆 |

## 8. 開工前先讀 / 先查

1. `../AGENT.md`(本專案準則;AI 分工、部署區、Rust 與 Node.js 規則、紀錄格式)。
2. `INTEGRATION-PLAN.md` §3(儲存分工與寫入順序)、§4(離線比對)、§5(契約與管理 API)。
3. `../../giga-api-gateway-bff/docs/ENDPOINT-AGENT-GUIDE.md` v0.4:§3 憑證、§4 `:9443`、§5 Server、§6 Agent、§8 管理 API。
4. `../../giga-api-gateway-bff/samples/node-backend/`(複製為 `ItAgentBack/` 的起點,`AGENT.md` §0 要命名專案:`gateway.project = RustIt`)。
5. `../../giga-observe/docker-compose.yml`(Mongo / Redis 不對外開 port 的做法,可照抄)。
6. `../../GigaItApp/frontend/src/pages/endpoint/Devices.vue`、`api/types.ts`(`EndpointDevice` 只能新增欄位)。
7. `RustAgent/crates/collector/src/lib.rs`(`ComputerInfo`,serde 輸出為 snake_case;`cargo run -p rustit-collector --example dump` 的結果含真實個資,**不可提交**,範例檔要去識別化)。

## 9. 完成後要做的收尾

- 各 repo `docs/DevelopmentProcess/` 留紀錄(格式見 `AGENT.md` §10);改結構時同步各 `docs/PROJECT-MAP.md`;`workspace.json` 有變就 `npm run arch:check`。
- 甘特圖:啟動 `GigaNexusAIPlan`(`node --disable-warning=ExperimentalWarning server/index.js`,http://localhost:5190),以 `POST /api/tasks/:id/progress` 更新 W6-7 ~ W6-12 進度後關閉服務(記憶 `schedule-source-gantt`)。
- 目錄搬移完成後,根目錄 `PROJECT-MAP.md` 的 `RustIt/docs/ui-performance-comparison.md` 連結改為 `RustIt/RustAgent/docs/ui-performance-comparison.md`。
- 更新記憶 `endpoint-agent-rust-websocket`。
