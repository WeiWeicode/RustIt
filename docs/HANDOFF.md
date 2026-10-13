# 交接:RustIt 第二階段(端點平台框架)

> 給接手的 AI 與工程師。**先讀 `../AGENT.md`,再讀 [PLATFORM-PLAN.md](PLATFORM-PLAN.md)**(第二階段計畫、階段 P0–P8、決定事項);本文只補「現在做到哪、下一步、哪些要先問」。基本階段的完整過程見 [INTEGRATION-PLAN.md](INTEGRATION-PLAN.md) 與 [DevelopmentProcess/NewFeatures.md](DevelopmentProcess/NewFeatures.md)。

## 1. 目前狀態

| 項目 | 狀態 |
| --- | --- |
| 基本階段(INTEGRATION-PLAN M0–M4、M6) | ✅ 完成:Agent 經 Gateway `:9443` 回報 ItAgentBack,GigaItApp「電腦清單」看得到 |
| `RustAgent/crates/collector` | ✅ 硬體、軟體、網路、防毒、USB 儲存、RustDesk 狀態 |
| `RustAgent/crates/agent`(`rustit-agent`) | ✅ 前景執行(`run`)與 **Windows 服務**(`service`;開發用 `install` / `uninstall`,P1 第一批);HTTPS 回報、WebSocket hello / 心跳、退避重連、裝置憑證(PEM 檔或 Windows `LocalMachine\My`,P1 PoC 實測通過)、服務模式檔案日誌。尚未有 MSI、指令執行 |
| `RustAgent/crates/demo` | 示範介面;**將改造為使用者端程式 `desktop`**(P8),`src/deploy.rs` 是軟體派送的參考實作(P7 移植到 Agent) |
| `RustAgent/crates/native` | ✅ 已移除(P1;最後版本 `3ba3827`) |
| `ItAgentBack` | ✅ 測試區(主機 2,`endpoint-server` + `ita-mongo` / `ita-redis`,CI `develop` 部署);管理 API 只有 `GET /v1/devices[/{deviceId}]`;giga-observe 監控已接 |
| GigaItApp 電腦清單 | ✅ 清單 + 詳情(概要、磁碟、網卡) |
| INTEGRATION-PLAN M5(離線暫存、`/sync`) | ⏸ 延後,擴充為 PLATFORM-PLAN P2(本機設定與持久化、離線紀錄) |
| 第二階段計畫 | ✅ `PLATFORM-PLAN.md` v0.4 **定案**(P0,2026-10-13):根目錄 `PROJECT-MAP.md` / `workspace.json`(cbf6db9)、Gateway `ENDPOINT-AGENT-GUIDE.md` v0.5(7319e87)已同步;甘特圖 W6-13 ~ W6-24(P0–P8、上線前準備),舊 W6-1 ~ W6-6、W6-12 已由新任務取代 |

## 2. 下一步

1. **P0 已完成**。三個 repo 的文件分支(RustIt `docs/platform-plan`、根目錄 `docs/rustit-platform-plan`、Gateway `docs/endpoint-guide-v0.5`)待推送並開 MR。
2. **P1 常駐**、**P3 資料呈現**、**P8-1 使用者端外殼與我的電腦** 可並行:P1(Agent 服務化、`common` crate、Windows 憑證存放區、MSI)由 Claude 主寫;P3(管理 API 回完整資產 + GigaItApp 詳情分 Tab)只動後端與前端,適合交給同仁。
3. P1 之後接 **P2 本機持久化與離線紀錄**,再做 P4 指令通道(升級、派送的共同基礎)。

## 3. 已決定(不要重新討論)

| # | 決定 | 出處 |
| --- | --- | --- |
| D1 | Endpoint Server 用 Node.js(Fastify + TypeScript),Rust 只做端點 | ADR 0004 |
| D2 | 資料庫:正式 `giganexus_It_Agent`、開發 + 測試共用 `giganexus_It_Agent_test`、整合測試 `giganexus_It_Agent_poc_test`;主機 `10.10.130.220`;SQL Server 2012 語法、手寫 migration、內網 `encrypt: false` | INTEGRATION-PLAN D2、D3、D8 |
| D3 | SQL Server 是唯一真相;Mongo(快照、心跳)與 Redis(在線)可重建 | INTEGRATION-PLAN §3.1 |
| D4 | Agent 通訊:HTTPS 回報 + 一條 WebSocket(不用 gRPC);Agent 與 Server 只靠 `docs/contracts/` 溝通 | ADR 0001、`AGENT.md` §7.3 |
| D5 | 指令只開放固定類型,依風險拆 basic / admin 路徑,權限在 BFF 檢查 | 指南 §8.2–§8.3 |
| D6 | Agent / Watchdog 升級不覆寫自己,由對方替換 | 指南 §6.5、§7.4 |
| D7 | 軟體派送:安裝檔放 NAS,伺服器以 HTTPS(mTLS)提供,Agent 驗 SHA-256 與簽章者 | ADR 0002(方案 B) |
| D8 | 本機持久化:SQLite + AES-256-GCM + DPAPI;連不上主機也要記錄(P2) | INTEGRATION-PLAN D4、PLATFORM-PLAN §4.2 |
| D9 | 監控服務與使用者端程式分開;使用者端由 Demo 改造,egui 原生版移除 | PLATFORM-PLAN §4.8、§11 Q1–Q2 |
| D10 | 軟體庫 NAS `\\10.10.130.31\docker-folder\RustIT\`,帳密只給後端 | PLATFORM-PLAN §4.6 |
| D11 | 建置與簽章:Windows Runner(先放主機 2,不放 AD 主機)建置 + 人工簽章 | PLATFORM-PLAN §4.9 |

## 4. 需要使用者親自做的事(AI 不可代做)

- **資料庫**:建庫、建帳號、任何 `sa` 操作;AI 產出 T-SQL,由使用者執行。migration 由開發者電腦 `npm run db:migrate` 套用到 `giganexus_It_Agent_test`。
- **主機 2 機密**:`ItAgentBack/deploy/host2-set-secrets.sh` 由使用者執行(密碼隱藏輸入);裝置憑證取走後刪除主機上的副本。
- **憑證與簽章**:AD CS 範本、程式碼簽章憑證、NAS 掛載帳號由 IT / 使用者處理。
- **任何真實帳密**:不要印在對話或寫進 repo。

## 5. 要先取得同意才能做的事

| 動作 | 說明 |
| --- | --- |
| 改 GigaItApp(詳情 Tab、指令按鈕、新選單、`gateway-rbac.yaml`) | 各階段動手前簡短確認;API 權限要等 ItAgentBack 註冊 OpenAPI 後才綁 `includes` |
| 改 Gateway(指南修訂、BFF 權限) | PLATFORM-PLAN §10、§12 |
| 改根目錄 repo(`PROJECT-MAP.md`、`workspace.json`、甘特圖) | 根目錄 `AGENT.md` §4.4 |
| 合併到 `develop`(觸發測試區部署)、主機 2 設定(NAS 掛載、`ita.env`) | 測試區共用,合併前提醒在群組告知 |
| 在任何**別人**的電腦安裝 Agent 或下指令 | 只用自己的電腦測試(`AGENT.md` §5) |

## 6. 開工前先讀 / 先查

1. `../AGENT.md`(分工、部署區、Rust 與 Node.js 規則、Git 分支)。
2. `PLATFORM-PLAN.md`(本階段)→ 對應階段的指南章節:`../../giga-api-gateway-bff/docs/ENDPOINT-AGENT-GUIDE.md` §6(Agent)、§7(Watchdog 與管道)、§8(管理 API 與指令)。
3. `PROJECT-MAP.md`(目錄與檔案職責)、`../ItAgentBack/docs/DB_SCHEMA.md`(資料表與寫入順序)、`contracts/README.md`(相容規則)。
4. 測試區 Agent 套件:`RustAgent/dist/rustit-agent-test/`(exe + `agent.toml` + `pki/`,不進版控,含私鑰)。

## 7. 完成後的收尾

- `docs/DevelopmentProcess/` 留紀錄(格式見 `AGENT.md` §10);改結構時同步 `docs/PROJECT-MAP.md`;`../GigaNexusAIPlan/architecture/*.json` 有變就 `npm run arch:check`。
- 甘特圖:經 API 更新對應任務進度(根目錄記憶 `schedule-source-gantt`)。
- 本文件「目前狀態」與「下一步」隨階段更新。
