# GigaNexus RustIt 端點管理 — AI 協作準則(AGENT.md)

> **目錄拆分(計畫 `docs/INTEGRATION-PLAN.md` §2,M0 執行)**:`RustIt/` 之下分為 `RustAgent/`(Rust)與 `ItAgentBack/`(Node.js)。本文使用**拆分後**的路徑;M0 搬移完成前,Rust 檔案仍在根目錄(`crates/`、`Cargo.toml`),`ItAgentBack/` 尚未建立。

> 本文件是 AI 程式助手(Claude、Gemini 等)在本專案中的行為準則,所有 AI 協作開發必須遵守。
> 結構對齊 `../GigaItApp/AGENT.md`,通用準則來源為 `../giga-api-gateway-bff/AGENT.md`。
> Gateway 的規格(`../giga-api-gateway-bff/docs/`)仍是上位規範;本文件與之不一致時,**先指出差異,不要自行決定以哪一邊為準**。
> 本專案與 Gateway、GigaItApp 等專案放在**同一層目錄**、彼此相依;跨專案規則(相對路徑、用 BFF 路由表找 API、跨 repo 修改)見 `../giga-api-gateway-bff/AGENT.md` **§10 多專案工作區**。

---

## AI 分工(Claude / Gemini)— 必讀

同 `../giga-api-gateway-bff/AGENT.md` §10.8(有出入時以該節為準)。

寫程式、寫測試、寫文件由 **Claude** 負責;**Gemini** 只負責執行測試、撰寫測試報告,以及非邏輯性的修改。Gemini 開始動手前,先確認工作在下表 Gemini 欄是 ✅。

| 工作 | Claude | Gemini |
| --- | --- | --- |
| 寫程式(新功能、業務邏輯、API、資料存取、通訊協定、修 bug、重構) | ✅ | ❌ |
| 寫測試(單元 / 整合 / 契約測試碼、測試用 fixture 的邏輯) | ✅ | ❌ |
| 寫文件(`AGENT.md`、`README.md`、`docs/`、`PROJECT-MAP.md`、架構 JSON、修正紀錄) | ✅ | ❌(測試報告除外) |
| 執行測試(既有的 `cargo test`、`ItAgentBack/` 的 `npm test` 等)並撰寫測試報告 | ✅ | ✅ |
| 非邏輯性修改:示範介面(`RustAgent/crates/demo/ui`)的假資料、版面與樣式、畫面文案錯字 | ✅ | ✅ |
| CI/CD 與容器、部署設定 | ✅ | ❌ **禁止** |

**Gemini 禁止修改**(即使只改一行):

- CI/CD:`.gitlab-ci.yml`、`ci-templates/`、Runner 設定。
- 容器與部署:`Dockerfile*`、`docker-compose*`、`.dockerignore`、`deploy/`、部署腳本、`.env*`、`agent.toml` 範本、安裝(MSI)設定。
- 相依與建置設定:`Cargo.toml`、`Cargo.lock`、`build.rs`、`tauri.conf.json`、`ItAgentBack/package.json`(含 scripts)、lock 檔、`tsconfig*.json`。
- 憑證與簽章:任何 PKI、憑證、金鑰相關檔案與腳本(ADR 0003)。
- 資料庫:schema、`ItAgentBack/db/migrations/`、seed、連線帳密。
- 測試程式碼:測試失敗時**不得**為了讓測試通過而修改測試或程式、跳過測試、調整門檻;把失敗寫進報告,交給 Claude 處理。

**測試報告**(Gemini 執行測試後必寫):

- 位置:`docs/test-reports/YYYY-MM-DD-<主題>.md`。
- 內容:1. 環境(分支 / commit、部署區、執行的指令)2. 結果(通過 / 失敗 / 略過數量)3. 失敗項目(測試名稱、錯誤訊息摘錄)4. **可能問題**:推測原因、相關檔案與行號、重現步驟、影響範圍 5. 建議交給 Claude 處理的項目。
- 測試全部通過也要寫,並列出觀察到的潛在風險(警告訊息、偶發失敗、執行過慢等)。

**判斷不了是否屬於「非邏輯性」時,一律視為邏輯修改**:不動程式,寫進報告交給 Claude 處理。

---

## 0. 專案定位(先讀)

| 項目 | 內容 |
| --- | --- |
| 做什麼 | Windows 端點電腦的資產蒐集與控管:Agent 蒐集硬體 / 軟體 / 資安狀態並回報,IT 在 GigaItApp「端點管理」檢視與管理(產品規格 `docs/PRD.md`) |
| 元件 | **Rust**(端點):`RustAgent/crates/collector`(蒐集函式庫)、`RustAgent/crates/agent`(規劃中,見整合計畫)、`native`(egui 示範)、`demo`(Tauri 示範)。**Node.js**(後端):`ItAgentBack/`(規劃中)= Endpoint Server,**取代原規劃的 Rust Axum**(`docs/decisions/0004-node-endpoint-server.md`) |
| 通道 | Agent → Gateway `:9443`(mTLS、HTTP/1.1)→ `endpoint-agent`(51241,HTTPS 回報 + WebSocket 指令);**不使用 gRPC**(`docs/decisions/0001`) |
| 管理 API | IT 前端 → `/api/endpoint/*` → BFF(權限 `endpoint.*`)→ `endpoint-api`(51240)。**權限以 BFF 為準**(Gateway PRD Q27、ENDPOINT-AGENT-GUIDE §8);`itapp-api` 不轉送端點 API |
| 服務代碼與 port | `endpoint-api` 51240、`endpoint-agent` 51241(Gateway BACKEND-GUIDE §3.3 已登記);**不可自行換 port**。`x-gateway.project` = `RustIt` |
| 工作區 | 與 `../giga-api-gateway-bff/`(上位規範、`@giganexus/backend-sdk`、開發用 PKI)、`../GigaItApp/`(電腦清單頁)同層;規則見 Gateway `AGENT.md` §10 |
| 進行中 | **整合計畫 `docs/INTEGRATION-PLAN.md`**:Agent → Node.js Endpoint Server → GigaItApp 電腦清單。開工前先讀,並對照其階段與完成標準 |
| 儲存 | SQL Server `giganexus_It_Agent*`(永久、**唯一真相**)、MongoDB(快照歷史)、Redis(在線狀態、快取);Agent 端本機加密暫存(離線不遺失,連線後與後端比對)。分工見整合計畫 §3–§4 |
| 目錄 | `RustAgent/`、`ItAgentBack/`、`docs/`(共用文件);**各目錄與檔案職責見專案地圖 `docs/PROJECT-MAP.md`** |

Agent 與 Server 之間只透過 **資料契約**(`docs/contracts/`,JSON Schema + 範例檔)溝通,不共用程式碼;改契約要兩邊測試一起更新(§7.3)。

---

## 1. 先思考再動手

- **動手之前,先說明你的理解與假設**:用 1–3 句話摘要打算做什麼、為什麼這樣做。
- **有疑問先問,不要猜**;需求有多種解讀時,列出選項讓人類選擇。
- 規格以 Gateway `docs/`、本文件與 `docs/INTEGRATION-PLAN.md` 為準;程式與規格不一致時先指出差異。

```
❌ 直接把 gRPC 版的 agent.conf 改成 WebSocket
✅ 「agent.conf 在 Gateway repo,改它會牽動 06-websocket-agent E2E 與 mock-upstream(指南 §10 G0)。
    我整理要改的三個檔案與順序給你,同意後在 Gateway repo 處理,可以嗎?」
```

## 2. 簡單優先

- 用最少的程式碼解決當前問題,不寫「未來可能用到」的程式碼。
- 不要「順便」引入新套件、設計模式或抽象層;新增相依前先說明理由(Rust 以 `docs/PRD.md` §3 與 Gateway `docs/TECH-STACK.md` 已列的優先;Node.js 優先用樣本 `samples/node-backend` 已有的相依)。
- **不提供任意 shell 指令**:指令一律是固定類型(ENDPOINT-AGENT-GUIDE §8.3),新增類型要 Agent 與 Server 一起發版。
- 憑證來源抽成 trait 是指南 §3.4 明確要求的,其餘不為「以後可能換」而加抽象。

```
❌ 為了送心跳,建立 MessageBus + 事件訂閱框架
✅ 一個 tokio 迴圈,每 30 秒送一則 heartbeat,斷線就走退避重連
```

## 3. 外科手術式修改

- **只改必須改的地方**;不順手整理、重構、改名不相關的程式碼,不改動既有格式(Rust 交給 `cargo fmt`,TypeScript 交給 Prettier)。
- **`RustAgent/crates/collector` 是 `native`、`demo`、`agent` 共用的函式庫**:改結構體欄位會同時影響三者與資料契約,只新增欄位、不改既有欄位的意義與名稱。
- 修改其他 repo(Gateway、GigaItApp)前先說明要改什麼、為什麼,**取得同意後再改**,並在該 repo 的 `docs/DevelopmentProcess/` 留紀錄(Gateway `AGENT.md` §10.5)。
- 每次修改都要能用一句話解釋為什麼改。

## 4. 目標導向執行

- 先定義成功標準,**對應 `docs/INTEGRATION-PLAN.md` 的階段與完成標準**,以及 `docs/PRD.md` 的需求;自己迭代到達成為止,遇到阻塞(缺資訊、權限不足、Gateway 尚未提供)才停下來回報。
- 行為變更時同步更新:契約(`docs/contracts/`)→ 兩端的契約測試 → ENDPOINT-AGENT-GUIDE(上位規範,需同意)→ 專案地圖(§9.1)。
- 完成時簡要說明:做了什麼、執行了哪些指令、結果如何;**能在本機跑起來驗證的就實際跑**(`cargo test`、`npm test`、Agent 連本機 Server),不要只說「應該可以」。

## 5. 失敗要明確說

- **失敗就說失敗**,不能把「靜默跳過」包裝成「完成」;附上錯誤訊息與 `x-request-id`。
- Rust 不用 `unwrap()` / `expect()` 處理執行期可預期的錯誤(網路、檔案、WMI),回傳 `Result` 並記錄;Node.js 不用空的 `catch {}`。確實要降級(例如 WMI 某項查不到)時,寫進 `warnings` 並在註解說明依據 —— collector 已是這個做法。
- **Agent 絕不因回報失敗而崩潰或卡住使用者電腦**:失敗進退避重試,但**要留紀錄**,不可完全無聲。
- 不要刪除或放寬失敗的測試來讓測試通過。
- 在端點電腦上測試只用**自己的電腦**;**不要在使用者的電腦上安裝、不要對他人電腦下指令**。

---

## 6. 部署區與設定

| 項目 | `dev`(本機開發) | `test`(測試區,主機 2) | `prod`(正式區,主機 3) |
| --- | --- | --- | --- |
| `GW_ENV`(`ItAgentBack/`) | `dev` | `test` | `prod` |
| Agent 憑證 | PEM 檔(臨時 PKI) | PEM 檔(`deploy/gen-temp-pki.sh` 簽發) | AD CS 電腦憑證(`LocalMachine\My`,不可匯出私鑰) |
| 機密(API Key、金鑰) | 可直接給值 | `*_FILE`(Docker secret) | **只接受** `*_FILE` |
| 身分旁路(`DEV_TRUST_CLIENT_HEADERS`、`DEV_SKIP_TOKEN`) | 可開 | **有設定就啟動失敗** | **有設定就啟動失敗** |
| 自動註冊 OpenAPI | 不註冊 | 寫入測試區 Gateway 草稿 | 寫入正式區草稿,IT 核可發佈 |

- 部署區只有這三個值;缺少必要設定時**啟動失敗**,不要加預設值繞過檢查。
- Agent 的 Gateway 位址以 IP 設定(`<gateway-ip>:9443`),不用主機名稱(Gateway PRD Q1)。
- `:51241` 防火牆**只允許 Gateway 主機**連入;`ItAgentBack/` 不可信任任何不是 Nginx 帶來的身分標頭。

---

## 7. 程式規則

### 7.1 Rust(`RustAgent/crates/`)

- 語言版本 edition 2024,`resolver = "3"`;`lib.rs` 放邏輯、`main.rs` 只組裝;平台相依 `#[cfg(windows)]`(Gateway `AGENT.md` §10.7.2 Rust 列)。
- 蒐集一律經 `rustit-collector`,Agent 不自己呼叫 WMI / 登錄檔;新增蒐集項目改 `collector`(並更新契約)。
- 非同步用 `tokio`;HTTP 用 `reqwest`(rustls)、WebSocket 用 `tokio-tungstenite`,**兩者共用同一個 `rustls::ClientConfig`**(指南 §3.4、§6.2)。**不使用 `native-tls`**(私鑰必須可匯出)。
- Agent 整個程式只維持**一條** WebSocket;心跳 30 秒;重連退避 1 秒起、上限 2 分鐘、±20% 隨機;憑證類錯誤(HTTP 400 / 403)每 10 分鐘重試,不快速重試(指南 §4.2、§6.3)。
- 日誌不可含憑證私鑰、Token、完整軟體清單。

### 7.2 Node.js(`ItAgentBack/`)

- TypeScript(ESM、`strict`)、Fastify,沿用 `../giga-api-gateway-bff/samples/node-backend` 的結構、部署區處理與錯誤格式(Gateway BACKEND-GUIDE §5.3);**先複製樣本,不自行發明專案結構**。
- 兩個 listener、兩套信任來源,**不可混用**:`:51240` 只認 `X-Internal-Token`(ES256、`iss=giganexus-bff`、`aud=endpoint-api`);`:51241` 只認 Nginx 的 `x-client-cert-*`,要求 `x-client-verify=SUCCESS`,以**完整 DN** 為裝置鍵(指南 §3.3、§5.2)。
- 指令 API 依等級拆路徑並檢查「指令類型」與路徑等級相符(指南 §8.3)——本階段尚未實作指令,但新增時不得省略。
- 所有 Agent 通道日誌帶 `x-request-id`、DN、指紋(指南 §5.7);只新增欄位、不改既有欄位意義,同時支援前一版 Agent(指南 §5.6)。
- **SQL Server 是唯一真相**;Mongo、Redis 只放可重建的資料,不放只存在那裡的資料。SQL 寫入失敗回 503(Agent 靠本機暫存重試),Mongo / Redis 失敗只記 warn、不擋回報。寫入順序與降級集中在 service 層,路由不直接操作任何儲存。
- SQL Server 2012:無 JSON 函式、`encrypt: false`(僅限已同意的內網);migration 手寫 SQL;Redis key 一律 `ita:{env}:` 前綴;Mongo / Redis 不宣告對外 port。

### 7.3 資料契約(`docs/contracts/`)

- Agent 與 Server 的**唯一共同依據**。兩端各自有一組測試,吃**同一份範例 JSON**。
- 只新增欄位;收到不認得的欄位忽略、不認得的 `type` 回 `unsupported`;不相容變更走新路徑(`/agent/v2/`)並存。
- 範例檔必須**去識別化**(假的使用者、序號、MAC、IP),不可提交真實電腦的蒐集結果。

---

## 8. 專案慣例

| 項目 | 規範 |
| --- | --- |
| Rust 命名 | 標準慣例(型別 `PascalCase`、函式與變數 `snake_case`);JSON 欄位 `snake_case`(沿用 collector 的 serde 輸出) |
| TypeScript 命名 | 變數 / 函式 `camelCase`,型別 `PascalCase`,常數 `UPPER_SNAKE_CASE`,檔名 `kebab-case.ts`;對外 JSON(管理 API)`camelCase`(與 GigaItApp 的 `EndpointDevice` 一致) |
| 格式 | Rust:`cargo fmt`;TypeScript:Prettier(單引號、`printWidth` 160、尾逗號) |
| 註解語言 | 繁體中文,註明對應規格章節(例 `(指南 §5.3)`);同一檔案內統一 |
| 機密與憑證 | 不進版控:私鑰、`*.pfx`、`.env*`、Token、真實蒐集結果(`.gitignore` 已排除 `.env`、`dist/`、`*.exe`) |
| 測試資料 | 全部虛構;**不可把自己電腦的序號、MAC、使用者名稱提交進 repo** |

### 8.1 專案地圖與設計原則

- **專案地圖:`docs/PROJECT-MAP.md`**。開發新功能後,在同一個變更內更新(新增 / 搬移 / 刪除目錄或主要檔案、職責改變、新增進入點或對外介面都要反映),並更新開頭的「最後更新」;規則見 Gateway `AGENT.md` §10.7.1。
- 核心設計原則依 Gateway `AGENT.md` §10.7.2 的 **Rust** 與 **TypeScript / Node.js 後端** 兩列:

| 原則 | 本專案做法 |
| --- | --- |
| 職責分離 | Rust:`collector` 只蒐集、不連網;`agent` 的 transport / heartbeat / config 分模組,核心流程不直接依賴 `reqwest` 與 Windows API(以 trait 或參數注入)。Node.js:`routes/`(介面)只驗參數與宣告權限,邏輯在 service,儲存在 `DeviceStore` |
| 原始碼根目錄 | Rust 各 crate 的 `src/`;`ItAgentBack/src/`(建置只取 `src/`,`tsconfig.build.json`) |
| 集中測試 | Rust:單元測試同檔 `#[cfg(test)]`、整合測試 `tests/`;`ItAgentBack/test/`(與 `src/` 平行,`tsx --test`);契約範例在 `docs/contracts/examples/` |

- 既有程式與原則不同之處列在專案地圖「已知差異」,不要為了符合原則大規模搬移(§3)。

### 常用指令

| 位置 | 指令 | 說明 |
| --- | --- | --- |
| `RustAgent/` | `cargo test -p rustit-collector` | collector 單元測試 |
| `RustAgent/` | `cargo run -p rustit-collector --example dump` | 印出這台電腦的蒐集結果(JSON),**含真實個資,不可提交** |
| `RustAgent/` | `cargo run -p rustit-native` / `cargo run -p rustit-demo` | 示範介面(egui / Tauri) |
| `RustAgent/` | `cargo build -p rustit-agent --release`、`cargo test -p rustit-agent` | Agent(M2 之後) |
| `RustAgent/` | `powershell -ExecutionPolicy Bypass -File scripts/bench.ps1 -Runs 3` | 效能並排量測 |
| `ItAgentBack/` | `npm run dev` / `npm test` / `npm run typecheck` / `npm run build` / `npm run db:migrate` | Endpoint Server(M1 之後;`dev` 讀 `.env`) |

---

## 9. 參考文件

| 文件 | 路徑 | 說明 |
| --- | --- | --- |
| **整合計畫** | `docs/INTEGRATION-PLAN.md` | Agent → Node.js Server → GigaItApp:目標、架構、階段、待決事項、跨 repo 變更 |
| **交接文件** | `docs/HANDOFF.md` | 目前做到哪、已決定事項、需使用者親自執行的事、需先同意的跨 repo 動作、開工前必讀清單 |
| **專案地圖** | `docs/PROJECT-MAP.md` | 目錄與檔案職責、分層、跨專案對應;**開發新功能後必須更新**(§8.1) |
| 產品需求 | `docs/PRD.md` | 功能需求、非功能需求、里程碑 |
| 架構決策 | `docs/decisions/` | 0001 Nginx 與通訊(Agent 改 HTTPS + WebSocket)、0002 軟體派送、0003 程式碼簽章與 PKI、0004 Endpoint Server 改 Node.js |
| 資料契約 | `docs/contracts/` | Agent ↔ Server 的 JSON Schema 與範例(M0 建立) |
| Gateway 開發手冊 | `../giga-api-gateway-bff/AGENT.md` | 通用準則來源;§10 多專案工作區、§10.7 設計原則、§10.8 AI 分工 |
| 端點規格 | `../giga-api-gateway-bff/docs/ENDPOINT-AGENT-GUIDE.md` | **上位規範**:憑證、`:9443`、Agent / Server 規範、§8 管理 API 與指令、§10 待辦、§11 上線檢查 |
| 後端規範 | `../giga-api-gateway-bff/docs/BACKEND-GUIDE.md` | §3 port、§4 內部 Token、§5 錯誤與日誌、§6 OpenAPI、§7.5 自動註冊 |
| 後端樣本 | `../giga-api-gateway-bff/samples/node-backend/` | `ItAgentBack/` 的起點(含 AGENT.md) |
| 部署與 PKI | `../giga-api-gateway-bff/docs/DEPLOYMENT.md` | 部署、機密;臨時 PKI `deploy/gen-temp-pki.sh` |
| IT 前端 | `../GigaItApp/AGENT.md`、`../GigaItApp/docs/PRD.md` | §6.8 / FR-8.x 電腦清單、`frontend/src/pages/endpoint/Devices.vue` |
| 全專案總圖 | `../PROJECT-MAP.md`、`../AGENT.md` | 工作區入口與專案導航 |

---

## 10. 修正紀錄

每次修正都要留紀錄,**新紀錄加在檔案最上方**(檔案不存在時於首次記錄建立)。**時程以 NexusPlan 甘特圖為準**,紀錄與文件不另列排程,完成工作後經 API 更新甘特圖。

| 文件 | 路徑 | 說明 |
| --- | --- | --- |
| Bug 修改紀錄 | `docs/DevelopmentProcess/BugFix.md` | Bug 修改 |
| 新增功能紀錄 | `docs/DevelopmentProcess/NewFeatures.md` | 新功能、計畫與決策文件 |
| Agent 修改紀錄 | `docs/DevelopmentProcess/AgentCorrection.md` | `RustAgent/` |
| 後端修改紀錄 | `docs/DevelopmentProcess/BackendCorrection.md` | `ItAgentBack/` |

動到其他 repo(Gateway、GigaItApp)時,另在該 repo 的 `docs/DevelopmentProcess/` 留紀錄,commit 訊息註明配合的另一個 repo 與 commit。

**開發新功能後,同一個變更內更新 `docs/PROJECT-MAP.md`**(§8.1),並在紀錄的「檔案」欄列出。

### 紀錄格式
```
## YYYY-MM-DD 標題
- 內容:改了什麼、為什麼
- 檔案:主要修改的檔案
- 驗證:執行的指令與結果(Agent 連 Server 的實測步驟與畫面)
```
