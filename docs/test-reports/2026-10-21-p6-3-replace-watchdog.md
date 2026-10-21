# 測試報告:P6-3 Agent 替換 Watchdog(Agent 0.8.0 / Watchdog 0.3.0)VM 驗收

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-21 |
| 部署區 | 測試區(主機 2;Gateway `giganexus-test.gigasolar.com.tw`);後端沒有改動(P6-1 已有 `target.watchdog`、`onAgentUpgradeEvents`) |
| 分支 / commit | RustIt `develop` `fc94a92`(MR !43,`feature/p6-3-replace-watchdog`:`eaadd04` 實作、`a458882` 契約測試登記) |
| 端點安裝包 | `GigaNexusAgent-0.8.0-test.msi`(Agent 0.8.0 + Watchdog 0.3.0,`trusted_signers` = 第一張測試憑證 `bb8ced00…`),SHA-256 `a9b9336b…ba19dcb` |
| 升級檔(皆已簽章者與預期相符,主機登錄時重算 SHA-256 與開發機一致) | Watchdog 0.3.0(降版用)、0.3.1(正常)、0.3.2-broken(`broken-exit`)、0.3.3(**未簽章**)、0.3.4(**第二張憑證** `2953e8c0…`);Agent 0.8.1(回歸)。皆登錄為 `draft`,只經 pilot 環 |
| 測試機 | Hyper-V VM `RUSTIT-P34`(deviceId `de87bce2…`,pilot 環;檢查點「P6-3 before (Agent 0.7.0, Watchdog 0.2.0)」) |
| 操作方式 | VM 內指令(安裝 MSI、重開機監看、查日誌)由需求方執行;版本登錄、發佈環目標、`agent.upgrade` 與狀態查詢由 Claude 經測試區 BFF(需求方登入的瀏覽器工作階段,身分 S112009)呼叫,並以 `ita.device_event`、`ita.device_upgrade` 與 VM 日誌核對;升級檔建置與簽章由 Claude 在需求方開發機執行(需求方同意使用兩張測試憑證私鑰) |

## 2. 本機前置(合併前)

| 指令 | 結果 |
| --- | --- |
| `cargo test -p rustit-common -p rustit-watchdog -p rustit-agent` | 全過(Agent 單元 68、common 30 + 1 略過、Watchdog 42、契約各項) |
| `cargo clippy -p rustit-common -p rustit-watchdog -p rustit-agent --all-targets` | 無警告 |
| `npm run typecheck`、`npm test`(`ItAgentBack/`) | 全過(180 項) |

**過程中的失敗**:MR !43 第一次 pipeline 失敗(`check:itagentback`)。原因:後端契約測試要求「每個範例檔都有對應的 schema 檢查」,新增的 `pipe-replace-watchdog*.sample.json` 沒登記(提交 P6-3 前只跑了 Rust 測試,漏跑 `ItAgentBack` 的 `npm test`)。補登記並加正反向檢查後 pipeline 通過,沒有放寬任何既有斷言。

## 3. VM 驗收結果(設計 §8.6)

| # | 步驟 | 結果 | 證據 |
| --- | --- | --- | --- |
| 0 | 升級安裝 MSI 0.8.0 | ✅ 通過 | 兩個服務 Running;`rustit-watchdog.exe` ProductVersion 0.3.0;API Agent 0.8.0、Watchdog 0.3.0 |
| 1 | pilot `watchdog` 目標 0.3.1 + `agent.upgrade`(component = watchdog) | ✅ 通過 | 事件 `upgrade_started`(02:21:34Z)→ `upgrade_succeeded`(02:21:56Z,約 22 秒);API watchdog `succeeded`、現行 0.3.1;**沒有** `watchdog_stopped` / `agent_tampered` / `watchdog_binary_changed`;指令 `succeeded`、`handed_to_watchdog = true` |
| 2 | 目標改 `0.3.2-broken`(啟動即結束) | ✅ 通過(第一輪) | `upgrade_started`(02:25:16Z)→ 約 2 分 20 秒後 `upgrade_failed`(`rolled_back: true`,02:27:38Z);API `rolled_back`、`HEALTH_CHECK_FAILED`、`attempts = 1`,Watchdog 回到 0.3.1 且在執行。**未實測**「冷卻 30 分鐘後再失敗一次 → `attempts = 2` 後不再下發」:`agent.upgrade` 會重設失敗次數與冷卻(設計 §8.3),要等自然冷卻;此行為由單元測試涵蓋(`MAX_ATTEMPTS`、冷卻) |
| 3 | 反向:① 0.3.3(未簽章)② 0.3.4(第二張憑證) | ✅ 通過 | ① `SIGNATURE_INVALID`(WinVerifyTrust 0x800B0100,未簽章)② `SIGNER_NOT_TRUSTED`(簽章者 `2953e8c0…` 不同時在主機清單與本機清單,本機 1 個);都在 **Watchdog 驗證階段**被擋,Agent 沒有收到 `replace_watchdog`(沒有該段的 `upgrade_started` 事件),Watchdog 現行維持 0.3.1 |
| 4 | 降版 0.3.1 → 0.3.0 | ✅ 通過 | `upgrade_started`(02:32:57Z)→ `upgrade_succeeded`(02:33:18Z);API `succeeded`、現行 0.3.0 |
| 5 | 替換中重開機 | ✅ 通過 | Agent 日誌:10:37:37「開始替換 Watchdog 0.3.0 → 0.3.1」→ 10:37:57 Agent 服務收到停止要求(VM 重開機)→ 10:38:55 服務啟動 → 10:39:07「**上一次替換 Watchdog 0.3.1 在中途中斷,收尾中**」→ 10:39:28「**Watchdog 已升級為 0.3.1**」;事件 `upgrade_started`(#161)→ `upgrade_succeeded`(#163);VM:`ProductVersion` 0.3.1、`previous\rustit-watchdog.exe` 存在、兩個服務 Running |
| 6 | 回歸:Agent 0.8.0 → 0.8.1(Watchdog 升級 Agent) | ✅ 通過 | `upgrade_started`(02:34:04Z)→ `upgrade_succeeded`(02:34:37Z);API agent `succeeded`、現行 0.8.1;watchdog 紀錄不受影響(仍 `succeeded`、0.3.0) |

收尾核對:`ita.device_upgrade` agent `0.8.1` / watchdog `0.3.1` 皆 `succeeded`、`attempts = 0`;pilot 環兩個元件的目標已清為 `null`(六個環 × 元件皆 `null`);沒有新的未結束告警。

## 4. 觀察與可能問題

1. **步驟 2 的 API 狀態在健康檢查期間停在 `pending`**:壞版 Watchdog 一直結束,不會上報進度,畫面要等 Agent 的 `upgrade_failed` 事件(約 2 分鐘)才變 `rolled_back`。符合設計(結果由 Agent 事件上報);P6-5 畫面可考慮在 `pending` 超過數分鐘時提示「替換進行中」。
2. **`agent.upgrade` 與「失敗 2 次後停止」互斥**(沿用 P6-2 觀察 A5-1):驗收時用 `agent.upgrade` 立即觸發會重設次數;要實測 `attempts = 2` 只能等 30 分鐘自然冷卻。
3. 步驟 5 重開機時 Agent 先收到 Windows 的停止要求,日誌「收到停止要求,收尾中」在 Watchdog 被替換流程停止之後;重開機後由 Agent 的 `resume`(標記 `replace.json`)收尾,結果正確。
4. 仍未驗(沿用 P6-2):升級時有執行中指令且逾時的 `AGENT_UPGRADING`;全新安裝 MSI(無舊版)路徑。
5. **清理未做**:VM `LocalMachine\Root` 的兩張測試根憑證仍在(設計 §8.3 資安項目,驗收全部結束後移除);VM 維持 Agent 0.8.1 / Watchdog 0.3.1;主機 2 `/srv/giganexus/ita-releases/` 仍有 0.3.x 與 Agent 0.8.1 檔案(`draft`)。

## 5. 建議交給 Claude 處理的項目

- 依 P6-6:指南(ENDPOINT-AGENT-GUIDE §7.3 / §7.4)回寫 `replace_watchdog`、`command-kinds.md`、根目錄 `workspace.json` / `PROJECT-MAP.md`、RUNBOOK 版本回滾。
- 上線前檢查(設計 §8.5):本機最低版本下限、測試憑證指紋正式環拒絕、`exe_of` 對無引號 ImagePath。
