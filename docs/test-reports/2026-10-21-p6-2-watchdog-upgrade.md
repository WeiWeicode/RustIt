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
