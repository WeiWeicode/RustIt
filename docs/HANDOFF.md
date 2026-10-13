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

1. **P1 剩下:在 Hyper-V 測試 VM 驗證 MSI**(主機 2 已啟用 Hyper-V,VM 由需求方建立)。見下方「P1 收尾:VM 測試」。
2. **P3 資料呈現**、**P8-1 使用者端外殼與我的電腦** 可並行:P1(Agent 服務化、`common` crate、Windows 憑證存放區、MSI)由 Claude 主寫;P3(管理 API 回完整資產 + GigaItApp 詳情分 Tab)只動後端與前端,適合交給同仁。
3. P1 之後接 **P2 本機持久化與離線紀錄**,再做 P4 指令通道(升級、派送的共同基礎)。

### P1 收尾:VM 測試(完成標準 PLATFORM-PLAN §4.1、§4.10 A8)

| 項目 | 內容 |
| --- | --- |
| VM | 主機 2 Hyper-V;Win10 22H2 與 Win11 各一台(先做一台也可),2 vCPU / 4 GB / 64 GB,網路接得到 `10.10.130.124:9443`(外部虛擬交換器;Default Switch 是 NAT,來源 IP 會變成主機 2,需確認防火牆「GigaNexus Agent 9443」是否允許) |
| 準備 | 裝好 Windows、加入網域(或先不加)、建立「乾淨」檢查點;測試用裝置憑證:測試區臨時 PKI 為 VM 另簽一張(`giga-api-gateway-bff/deploy/gen-temp-pki.sh`,CN 用 VM 的電腦名稱),PFX 匯入 VM 的 `LocalMachine\My`(不加 `-Exportable`) |
| MSI | `RustAgent/installer/build-agent-msi.ps1 -Env test …` 產生 `dist/msi/GigaNexusAgent-<版本>-test.msi` |
| 驗證 | 1. `msiexec /i … /qn /l*v install.log` 成功;2. `sc qfailure GigaNexusAgent` 為 10 / 30 / 60 秒(服務自行套用);3. 重開機後未登入也自動連線(GigaItApp 電腦清單出現 VM);4. 強制結束行程後自動重啟;5. `icacls C:\ProgramData\GigaNexus\Agent` 只有 SYSTEM、Administrators;6. `msiexec /x` 後服務與 `Program Files\GigaNexus\Agent` 移除、日誌保留;7. 還原檢查點重複安裝 |
| 已知 | 開發機實測(2026-10-13):MSI 安裝 / 解除安裝成功、服務以 `LocalMachine\My` 憑證啟動;當時發現服務自行套用失敗復原少了 `SERVICE_START` 權限(已修,**待 VM 驗證**)。ACL 套用前就存在的舊日誌檔仍保有原權限,新檔案才繼承 |

主機 2 注意:2026-10-13 啟用 Hyper-V 重開機後,開機排程 `WSL-GigaNexus`(以 `user` 執行 `wsl -d Ubuntu -u root --exec /bin/sleep infinity`)失敗(結果 -1),WSL 未常駐,整個測試區 Gateway 停擺;手動 `Start-ScheduledTask -TaskName WSL-GigaNexus` 後恢復。之後主機 2 重開機要確認此排程(建議為開機觸發加 1 分鐘延遲,需同意後設定)。

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
