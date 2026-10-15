# 指令類型(command kinds)

> WebSocket `command` / `command_update`(`ws-envelope.schema.json`)的 `kind`、`params`、`result` 定義。上位規範:ENDPOINT-AGENT-GUIDE §8.3–§8.4;計畫 PLATFORM-PLAN §4.4。
> **只開放固定類型**,不提供任意 shell / PowerShell。新增類型時 Agent 與 ItAgentBack 一起發版;舊版 Agent 收到不認得的 `kind` 回 `failed` + `UNSUPPORTED_COMMAND`。
> 參數**不得含機密**(密碼、Token):需要機密的動作由主機自己持有(例如 NAS 帳密只在後端)。

## 共通規則

| 項目 | 規則 |
| --- | --- |
| 等級 | `basic`(`endpoint.command.basic`,沒有破壞性)/ `admin`(`endpoint.command.admin`);管理 API 依等級拆路徑,類型與路徑等級不符回 `400 ENDPOINT_COMMAND_LEVEL_MISMATCH` |
| 有效期限 | `expires_at` = 建立時間 + 類型預設(建立時可用 `expiresInSec` 60–86400 覆寫)。Agent **確認收到(`acked`)之前**超過即不執行:主機設為 `expired`,Agent 收到時回 `failed EXPIRED` |
| 執行逾時 | `acked` 之後改看類型的執行逾時;超過仍未到終態,主機設為 `failed TIMEOUT` |
| 串行 | 標「是」的類型(會改變系統)在 Agent 上同時間只執行一個;查詢類可並行 |
| 去重 | Agent 以 `command_id` 去重(本機持久化,保留 7 天);重複收到不重跑,重送最後狀態 |
| 結果 | `result` 序列化後 4,000 字元內;大量資料(日誌、診斷檔)走 HTTPS(P4-2) |
| 每台上限 | 同一台尚未結束(queued / sent / acked / running)的同類型指令:`message.show` 3 筆、`agent.restart` 1 筆;超過回 `409 ITA_COMMAND_LIMIT`(避免洗版、反覆重啟) |
| 冪等 | 同一工號 + 同一 `Idempotency-Key` 回傳既有的那筆;用在不同電腦、類型或等級回 `422 ITA_IDEMPOTENCY_KEY_REUSED` |

## 錯誤代碼(`command_update.error_code`)

| 代碼 | 由誰 | 說明 |
| --- | --- | --- |
| `UNSUPPORTED_COMMAND` | Agent / 主機 | 不認得的 `kind`;舊版 Agent 回信封 `unsupported` 時主機以此代碼結束 |
| `EXPIRED` | Agent | 收到時已超過 `expires_at` |
| `TIMEOUT` | 主機 | `acked` 後超過執行逾時 |
| `INVALID_PARAMS` | Agent | 參數不符(主機建立時已驗證;版本差異時才會出現) |
| `NO_ACTIVE_SESSION` | Agent | `message.show`:主控台沒有登入的使用者 |
| `NOT_RUNNING_AS_SERVICE` | Agent | `agent.restart`:前景模式(開發)沒有服務失敗復原,無法重啟 |
| `EXECUTION_FAILED` | Agent | 其他執行錯誤,`error_message` 說明 |

## 類型

| kind | 等級 | 有效 / 逾時 | 串行 | 階段 |
| --- | --- | --- | --- | --- |
| `inventory.collect` | basic | 1 小時 / 10 分鐘 | 否 | P4 |
| `agent.restart` | basic | 1 小時 / 5 分鐘 | 是 | P4 |
| `message.show` | basic | 1 小時 / 2 分鐘 | 否 | P4 |
| `agent.diagnose`、`logs.collect`、`agent.log_level` | basic | — | — | P4-2(待定義) |
| `agent.upgrade` | admin | — | 是 | P6 |
| `software.install`、`software.uninstall`、`system.reboot` | admin | — | 是 | P7 |

### `inventory.collect` — 立即蒐集並回報資產

- `params`:無(`{}`)。
- 流程:`acked` → `running` → 蒐集 → `POST /agent/v1/inventory` → `succeeded`。
- `result`:`{ "agent_seq": 1759740000123, "result": "stored" | "unchanged" | "archived" }`。回報失敗(連不上、503)時 `failed EXECUTION_FAILED`,資產仍留在本機暫存照常補傳。

### `agent.restart` — 重新啟動 Agent

- `params`:無。
- 流程:`acked` → `running`(本機記下「重啟中」)→ 正常收尾、以服務專屬結束代碼停止 → Windows 服務失敗復原(10 / 30 / 60 秒)重新啟動 → 啟動後回 `succeeded`。
- `result`:`{ "restarted_at": "<端點時間>" }`。
- 前景模式回 `failed NOT_RUNNING_AS_SERVICE`。

### `message.show` — 在使用者螢幕顯示訊息

- `params`:

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `text` | string 1–1000、最多 30 行 | ✅ | 訊息內容 |
| `title` | string 1–64、單行 | | 顯示為「【IT 部門通知】」+ title;省略只顯示前綴 |
| `timeout_sec` | integer 0–3600 | | 幾秒後自動關閉;0(預設)= 不自動關閉 |

- 不可含控制字元(`text` 允許換行 `\n`,不允許 `\r`)與雙向文字控制字元(U+200E、U+200F、U+202A–202E、U+2066–2069);主機建立時與 Agent 顯示前都檢查,不符回 `INVALID_PARAMS`。
- **防偽裝**:標題一律加固定前綴「【IT 部門通知】」,不可覆寫;內文結尾由 Agent 附上「(發送人:IT <工號>)」(`command.issued_by`)。
- 顯示方式:使用者端程式(P8)在執行時由它顯示;目前一律 Windows `WTSSendMessage` 系統訊息框,送到主控台工作階段(遠端桌面工作階段收不到),不等待使用者按下。
- `result`:`{ "session_id": 1, "shown_via": "wts" }`;沒有登入者回 `failed NO_ACTIVE_SESSION`。
