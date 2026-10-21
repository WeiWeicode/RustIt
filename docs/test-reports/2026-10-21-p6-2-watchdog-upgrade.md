# 測試報告:P6-2 Watchdog 升級 Agent(Agent 0.7.0 / Watchdog 0.2.0)VM 驗收

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-20 ~ 2026-10-21 |
| 部署區 | 測試區(主機 2 `giganexus-ita-test-endpoint-server-1`;Gateway `giganexus-test.gigasolar.com.tw`) |
| 分支 / commit | RustIt `develop`(含 P6-1 MR !37、P6-2 MR !38 `948adf1`) |
| 端點安裝包 | `GigaNexusAgent-0.7.0-test.msi`(Agent 0.7.0 + Watchdog 0.2.0,`-TrustedSigners` 寫入 `agent.toml`) |
| 升級檔 | 主機 2 `/srv/giganexus/ita-releases/agent/`:0.7.0、0.7.1、0.7.2-broken(不連 WebSocket)、0.7.3-broken(啟動即結束)、0.7.4(未簽章)、0.7.5(另一張憑證簽章) |
| 測試機 | Hyper-V VM `RUSTIT-P34`(deviceId `de87bce2-f5c9-40c2-bd04-ec5a311f5f1c`,pilot 環;檢查點「P6 前(未安裝)」) |
| 操作方式 | VM 內由需求方執行;步驟 5~9 的 API 由 Claude 經瀏覽器(需求方登入的 GigaItApp 工作階段,身分 S112009)呼叫 `/api/endpoint/*`,結果以 `GET /devices/{id}/upgrade`、`ita.device_event` 與 VM 日誌核對 |

## 2. 結果

| # | 項目 | 結果 | 證據 |
| --- | --- | --- | --- |
| 0 | 匯入測試憑證 | 通過 | 0.7.1 檔 `Valid` |
| 1 | 安裝 MSI 0.7.0 | 通過 | 兩服務執行、`[upgrade] trusted_signers` 已寫入 |
| 2 | pilot 目標 0.7.1 | 通過 | `upgrade_succeeded`(2026-10-20 07:24Z) |
| 3 | 0.7.2-broken(不連 WebSocket) | 通過 | 兩次皆還原 0.7.1、`upgrade_failed`,第 2 次後不再下發 |
| 4 | 0.7.3-broken(啟動即結束) | 通過 | `rolled_back` / `HEALTH_CHECK_FAILED`、`attempts = 2`、`Agent 服務 stopped,已還原 0.7.1` |
| 5-① | 未簽章 0.7.4 | 通過 | `SIGNATURE_INVALID`(WinVerifyTrust 0x800B0100,未簽章);Agent 未被停止 |
| 5-② | 另一張憑證簽章 0.7.5 | 通過 | `SIGNER_NOT_TRUSTED`(簽章者 `2953e8c0…` 不同時在主機清單與本機信任清單) |
| 6 | `agent.upgrade` 指令 | 通過 | 指令 `succeeded`、`result.handed_to_watchdog = true`;Watchdog 日誌「收到 agent.upgrade…重設失敗次數並立即上報」 |
| 7 | 降版 0.7.1 → 0.7.0 | 通過 | `succeeded`,`ProductVersion` 0.7.0 |
| 8 | 升級中重開機 | 通過 | 日誌 08:31:16 停服務後重開機;開機後「上一次升級 Agent 0.7.0 在安裝中途中斷,收尾中」→「中斷的升級已收尾:Succeeded」;Agent 0.7.0、兩服務 Running |
| 9 | 升級時有執行中的指令 | 部分 | `logs.collect` 在升級開始前已完成(`succeeded`),升級照常成功;**「60 秒後 `failed` / `AGENT_UPGRADING`」的情況未觸發** |

SHA-256 不符由主機下載前複驗擋下,端點端驗證由單元測試涵蓋(設計 §8.4 步驟 5 說明),未在 VM 另測。

## 3. 觀察與可能問題

1. **步驟 9 證據偏弱**:`logs.collect` 太快,與升級沒有重疊。要驗 `AGENT_UPGRADING` 需要較慢的指令(例如先把 Agent 日誌等級調高並蒐集、或暫時以測試指令拉長),建議併入 P6-3 驗收時補測。
2. **步驟 8 事件缺漏**:重開機後 `ita.device_event` 沒有該次降版的 `upgrade_succeeded`(只有 `agent_started`),但 `ita.device_upgrade` 與日誌正確。推測是收尾由 Watchdog 重啟後完成,事件未補送或被去重;影響只在事件時間軸,不影響升級結果。建議 P6-3 時確認收尾路徑是否補報 `upgrade_succeeded`。
3. `rustit_common::stop 結束逾時(5 秒),不再等待背景工作`(WARN):停服務時背景工作 5 秒內未結束,屬既有行為,升級結果未受影響。
4. 驗收中途會話 Token 逾時(401),以 `/api/auth/refresh` 更新後繼續,與升級功能無關。

## 4. 清理

- pilot 環 agent 目標已清為 `null`;裝置維持 pilot 環、Agent 0.7.0、Watchdog 0.2.0。
- 升級檔仍在主機 2 `ita-releases`(0.7.4 / 0.7.5 / broken 版維持 `draft`)。
- VM 尚未還原檢查點,可留作 P6-3 驗收。

## 5. 建議交給 Claude 處理

- P6-3(Agent 替換 Watchdog、`replace_watchdog`)前,先決定是否補測步驟 9 與步驟 8 的事件補報。
- 同步 P6 設計 §8.4 進度、HANDOFF、甘特圖 W6-19。

---

## 附錄 A:2026-10-20 第一階段驗收紀錄(步驟 0–4)與觀察

> 由先前分支 `docs/p6-2-vm-acceptance` 的報告併入(該報告當時步驟 5–9 未測,結果已由上方 §2 取代)。以下 A5 的 9 項觀察與 A6 的建議**多數仍未處理**,P6-3 / P6-5 開工前請先看。
> 附錄內的「§N」(例如 §5-3)指附錄的 A 節(A5-3 即觀察 3)。
> 另有一項未做:依設計 §8.3 資安項目,驗收後要**移除 VM `Cert:\LocalMachine\Root` 的兩張測試根憑證**(目前還在);全新安裝 0.7.0 MSI(無 0.6.0)的路徑未驗。

### A2. 本機測試(全部通過)

在 `RustAgent/` 與 `ItAgentBack/` 執行:

| 指令 | 結果 |
| --- | --- |
| `cargo test -p rustit-common -p rustit-watchdog -p rustit-agent` | common 30 通過 / 1 略過;watchdog 單元 28 + main 1 + 契約 4;agent 單元 33 + main 2 + 契約 9;失敗 0 |
| `cargo clippy -p rustit-common -p rustit-watchdog -p rustit-agent --all-targets` | 無警告、無錯誤 |
| `npm test`(`ItAgentBack/`) | 179 通過、0 失敗、0 略過 |

數量與預期相符。common 的 1 項略過是既有的 `#[ignore]`。

### A3. VM 驗收前置

| # | 項目 | 結果 |
| --- | --- | --- |
| 1 | 經 BFF 呼叫 `GET /api/endpoint/releases`、`/release-rings` | 200(不是 404);rings 6 筆(pilot / it / all × agent / watchdog) |
| 2 | 主機 2 `/srv/giganexus/ita-releases/` | 存在,root 擁有,空;上架時建 `agent/<版本>/` |
| 3 | 以 `feature/p6-2-watchdog-upgrade` 建置 | MSI 0.7.0 與 6 個升級檔(見 A4.1) |
| 4 | 測試簽章憑證 | 已建立(第一張);另建第二張供步驟 5 ② |
| 5–6 | 版本登錄 | 0.7.1 已 `published`;其餘維持 `draft`(只經 pilot 環) |
| — | 檢查點 | 建了「P6 前(未安裝)」;**沒有**建「P6-2 0.7.0」(見 §5-2) |

#### A4.1 升級檔(皆已上架 `/srv/giganexus/ita-releases/agent/<版本>/rustit-agent.exe`,主機重算 SHA-256 與開發機一致、版本登錄 API 回傳亦一致)

| 版本 | 內容 | 簽章者 | SHA-256(前 8 碼) | 大小 |
| --- | --- | --- | --- | --- |
| 0.7.0 | 降版用 | `bb8ced00…` | b8115c10 | 8930184 |
| 0.7.1 | 正常 | `bb8ced00…` | e94e4a30 | 8930184 |
| 0.7.2-broken | `broken-no-ws` | `bb8ced00…` | d5f1369b | 8931720 |
| 0.7.3-broken | `broken-exit` | `bb8ced00…` | a479045e | 8569224 |
| 0.7.4 | **未簽章**(步驟 5 ①) | — | 012437d3 | 8928256 |
| 0.7.5 | 第二張憑證簽章(步驟 5 ②) | `2953e8c0…` | 338f3781 | 8930192 |

MSI SHA-256 前 8 碼 `de3fbd87`。除 0.7.1(`published`)外,其餘五個版本都已登錄為 `draft`。

### A4. VM 驗收結果(2026-10-20 當時;5–9 已於 10-21 補完)(設計 §8.4 表格)

| # | 結果 | 證據 |
| --- | --- | --- |
| 0 | ✅ 通過 | 對 0.7.1 檔 `Get-AuthenticodeSignature` 為 `Valid`;MSI SHA-256 與建置相符;Root 匯入成功(TrustedPublisher 見 §5-3) |
| 1 | ✅ 通過 | 兩個服務 Running / Automatic;`agent.toml` 有 `[upgrade] trusted_signers`;安裝目錄 exe ProductVersion 0.7.0;API `currentVersion` agent 0.7.0、watchdog 0.2.0。事件 #101 是 `software_updated` 0.6.0 → 0.7.0(見 §5-2) |
| 2 | ✅ 通過 | pilot 目標 0.7.1(07:23:00Z)→ 日誌 15:24:00 開始、15:24:24「已升級為 0.7.1」、結束 `Succeeded`;事件 `upgrade_started`(#103)、`release_download`(#102,8930184 bytes)、`upgrade_succeeded`(#105,`duration_ms` 23822);API `succeeded`、`attempts 0`;安裝目錄 0.7.1、`previous\` 0.7.0;維護期間沒有 `agent_service_stopped` / `agent_tampered` |
| 3 | ✅ 通過 | 0.7.2-broken:15:29:34 開始 → 15:31:38 `HEALTH_CHECK_FAILED`(WebSocket 未連線)→ 還原 0.7.1,`rolled_back`、`attempts 1`、事件 `upgrade_failed`(`rolled_back: true`,#110)。冷卻 30 分鐘(15:31:59 → 16:02:10 自動重試,沿用快取檔)→ 第 2 次失敗 16:04:33,`attempts 2`、告警 `upgrade_failed`(`warn`、`open`,detail 含版本與錯誤)。冷卻再到期(16:34)後約 5 分鐘內沒有第 3 次嘗試(觀察窗偏短,見 §5-9) |
| 4 | ✅ 通過 | 0.7.3-broken:目標 16:39:59 設定,16:44:43 開始(約 4 分 44 秒,上報週期)→ 16:46:47 `HEALTH_CHECK_FAILED`(Agent 服務 stopped)→ 還原 0.7.1,`rolled_back`、`attempts 1`(依版本計,不沿用 0.7.2 的 2)、事件 `upgrade_failed`(#118);日誌「還原後管道仍不正常(os error 2),但 Agent 服務 PID 穩定,視為已還原」(資安 M3 預期路徑);兩個服務最後 Running |
| 5 | ✅ 見 §2 | 2026-10-21 完成:`SIGNATURE_INVALID`、`SIGNER_NOT_TRUSTED` |
| 6 | 見 §2 | 2026-10-21 完成(步驟 9 為部分) |
| 7 | 見 §2 | 2026-10-21 完成(步驟 9 為部分) |
| 8 | 見 §2 | 2026-10-21 完成(步驟 9 為部分) |
| 9 | 見 §2 | 2026-10-21 完成(步驟 9 為部分) |

### A5. 觀察與可能問題(無失敗項目;以下交 Claude 判斷)

1. **設計 §8.4 步驟 3 與 §8.3 互相矛盾**:§8.4 寫「冷卻 30 分鐘後(或下 `agent.upgrade` 立即)再試一次仍失敗 → `attempts = 2`」,§8.3 寫 `agent.upgrade` 會**解除冷卻並重設失敗次數**。用 `agent.upgrade` 跳過冷卻就看不到 `attempts = 2`。本次改以等自然冷卻驗證 `attempts = 2` 與「告警」,後續步驟 5、6 改用 `agent.upgrade` 清冷卻(已與需求方確認,步驟 5 ① 與 6 合併驗證)。建議修正 §8.4 文字。
2. **驗收前的 VM 不是「未安裝」**:步驟 1 的事件 #101 是 `software_updated` 0.6.0 → 0.7.0,Watchdog 日誌也有 0.1.0 與 0.7.0 之前的紀錄,表示檢查點「P6 前(未安裝)」其實已有 0.6.0;HANDOFF 寫「VM 已解除安裝」與實況不符。步驟 1 驗的是「0.6.0 → 0.7.0 MSI 升級」,不是全新安裝。**全新安裝路徑未驗**。另外「P6-2 0.7.0」檢查點沒建(需求方在 Watchdog 開始升級前未建),VM 目前沒有 0.7.0 乾淨狀態可還原,只能回「P6 前」再裝 MSI。
3. **`TrustedPublisher` 匯入被拒**:系統管理員(High 完整性)`Import-Certificate -CertStoreLocation Cert:\LocalMachine\TrustedPublisher` 回 `E_ACCESSDENIED`(0x80070005),該存放區沒有測試憑證。只有 Root 時簽章仍為 `Valid`、升級成功,所以目前不影響結果;原因不明(VM 政策?)。設計 §9-1 寫兩處都要匯入,建議確認 Watchdog 驗簽是否真不需要 `TrustedPublisher`(`WTD_CACHE_ONLY_URL_RETRIEVAL`、`winverifytrust` 設定),再決定設計文字。
4. **`POST /releases/{id}/publish` 空 body 回 400**:Console `fetch` 送 `Content-Type: application/json` 但沒有 body,回 `400 VALIDATION_FAILED`;改送 `{}` 回 200。推測是 Fastify 對空 JSON body 的處理(未驗證)。GigaItApp 畫面(P6-5)送 publish / revoke 時要帶 `{}` 或在後端允許空 body。
5. **`GET /devices/{id}/upgrade` 在新目標尚未開始時顯示舊紀錄**:把目標由 0.7.2-broken 改成 0.7.3-broken 後,尚未開始前 `targetVersion` 已是新版,但 `state: rolled_back`、`attempts: 2`、錯誤訊息仍是 0.7.2-broken 的紀錄。畫面(P6-5)會讓人誤以為新版已失敗 2 次;建議 API 或畫面在 `targetVersion` 與紀錄版本不同時不顯示舊狀態。
6. **冷卻讓同一台測試機的壞版本測試只能串行**:任何失敗都 30 分鐘冷卻,步驟 3 + 4 + 5 單靠自然等待要 1.5 小時以上;建議驗收文件註明或提供測試用縮短冷卻的設定(不可用於正式)。
7. **還原後管道檢查**:步驟 4 的日誌顯示還原後本機管道還沒建好(os error 2),靠 PID 穩定視為已還原(設計 M3 預期)。若 Agent 啟動較慢,管道仍可能偶發未就緒;目前不會誤判為 `ROLLBACK_FAILED`。
8. **Console 操作的坑(不是缺陷)**:BFF 非 GET 請求要 `X-CSRF-Token`(= `gn_csrf` Cookie);登入工作階段過期回 401、重新整理後 Console 變數消失。驗收文件建議附一段每次都重新讀 Cookie 的 helper(本報告 §7 附)。
9. **「不再下發」觀察窗偏短**:步驟 3 在冷卻到期(16:34)到改目標(16:39:59)之間約 5 分鐘沒有第 3 次嘗試;設計要求至少一個上報週期,已滿足一個週期,但未做 10 分鐘以上觀察。

### A6. 建議交給 Claude(Opus)處理的項目

1. 修正設計 §8.4 步驟 3 的文字(觀察 1)。
2. 確認 Watchdog 驗簽是否不需要 `TrustedPublisher`,再更新設計 §9-1 與驗收前置(觀察 3)。
3. `publish` / `revoke` 空 body 處理或在 OpenAPI 標明 body 必填(觀察 4)。
4. `GET /devices/{id}/upgrade` 舊紀錄顯示邏輯(觀察 5),納入 P6-5 畫面設計。
5. ~~HANDOFF 的 VM 狀態改寫~~(已更新:Agent 0.7.0 / Watchdog 0.2.0,pilot 環;「VM 已解除安裝」的舊說法在 P6-2 驗收段已移除)。
6. 全新安裝 0.7.0 MSI(無 0.6.0)的路徑尚未驗,建議用「P6 前(未安裝)」以外的乾淨 VM 或先解除安裝再測。
