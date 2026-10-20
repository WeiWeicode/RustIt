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
| 結果 | `result` 序列化後 4,000 字元內;大量資料(日誌)以 HTTPS 上傳為指令附檔(見「指令附檔」),`result` 只放 `file_id` |
| 每台上限 | 同一台尚未結束(queued / sent / acked / running)的同類型指令:`message.show` 3 筆,`agent.restart`、`agent.diagnose`、`logs.collect`、`agent.log_level`、`agent.upgrade` 各 1 筆;超過回 `409 ITA_COMMAND_LIMIT`(避免洗版、反覆重啟) |
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
| `NO_LOGS` | Agent | `logs.collect`:指定天數內沒有日誌檔 |
| `UPLOAD_FAILED` | Agent | `logs.collect`:附檔上傳重試後仍失敗,`error_message` 帶 HTTP 狀態或錯誤 |
| `EXECUTION_FAILED` | Agent | 其他執行錯誤,`error_message` 說明 |

## 類型

| kind | 等級 | 有效 / 逾時 | 串行 | 階段 |
| --- | --- | --- | --- | --- |
| `inventory.collect` | basic | 1 小時 / 10 分鐘 | 否 | P4 |
| `agent.restart` | basic | 1 小時 / 5 分鐘 | 是 | P4 |
| `message.show` | basic | 1 小時 / 2 分鐘 | 否 | P4 |
| `agent.diagnose` | basic | 1 小時 / 3 分鐘 | 否 | P4-2 |
| `logs.collect` | basic | 1 小時 / 15 分鐘 | 否 | P4-2 |
| `agent.log_level` | basic | 1 小時 / 1 分鐘 | 否 | P4-2 |
| `agent.upgrade` | admin | 1 小時 / 5 分鐘 | 是 | P6 |
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

### `agent.diagnose` — 連線與環境自我檢查(A4)

- `params`:無。
- 每項檢查各自有逾時,單項卡住不影響其他項;`status` 為 `ok` / `warn` / `fail` / `skipped`,`detail` ≤ 200 字。任一項 `fail` 指令仍是 `succeeded`(診斷本身完成),由畫面依 `status` 顯示。

| `name` | 內容 | warn / fail |
| --- | --- | --- |
| `gateway` | 以 Agent 現有的 mTLS 連線 `GET /healthz`,`ms` 為耗時 | > 3 秒 warn;失敗 fail |
| `dns` | 解析電腦所屬 AD 網域;工作群組 → `skipped` | 解析失敗 fail |
| `clock` | `hello_ack.clock_skew_ms` | 絕對值 > 2 分鐘 warn、> 5 分鐘 fail;尚未收到 hello_ack → `skipped` |
| `cert` | 裝置憑證到期日與剩餘天數(只讀憑證,不碰私鑰) | < 30 天 warn、已過期 fail |
| `disk` | 系統磁碟可用空間 | < 10% warn、< 2 GB fail |
| `wmi` | `Win32_ComputerSystem` 查詢耗時(經 `rustit-collector`;同一次查詢取得 `dns` 用的網域) | > 5 秒 warn;失敗或 30 秒逾時 fail |
| `store` | 本機暫存待補傳資產 / 事件、未回報指令筆數 | 待補傳 > 100 warn |

- `result`:`{ "agent_version", "service_mode", "log_level", "uptime_sec", "checks": [{ "name", "status", "ms"?, "detail"? }] }`(範例 `ws-command-update-diagnose.sample.json`)。

### `logs.collect` — 收集 Agent 日誌並上傳(A4)

- `params`:

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `days` | integer 1–14 | | 最近幾天(含今天),預設 3;日誌只保留 14 天 |

- 流程:`acked` → `running` → 日誌目錄最近 `days` 天的 `agent-YYYY-MM-DD.log` 壓成一個 zip → `POST /agent/v1/commands/{commandId}/files` → `succeeded`。Watchdog 日誌待 P5 再加參數。
- **遮罩**(第二道防線;日誌本來就不可含私鑰與 Token,`AGENT.md` §7.1):`-----BEGIN … PRIVATE KEY-----` 到 `-----END … PRIVATE KEY-----` 整段、`Bearer` / `Basic` 之後的值、鍵 `token` / `password` / `passwd` / `pwd` / `secret` / `api_key` / `api-key` / `apikey` 接 `=` 或 `:`(前後可有空白,含 JSON `"token":"值"`)的值,不分大小寫,替換為 `***`。
- 壓縮後上限 20 MB:超過時從最舊的日期開始捨棄,`truncated = true`。指定天數內沒有任何日誌 → `failed NO_LOGS`;上傳重試 3 次仍失敗 → `failed UPLOAD_FAILED`。
- `result`:`{ "file_id", "file_name", "size_bytes", "sha256", "days_included", "truncated" }`(範例 `ws-command-update-logs.sample.json`)。

### `agent.log_level` — 暫時調整日誌等級(A4)

- `params`:

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `level` | `debug` / `trace` / `default` | ✅ | `default` = 立即恢復設定檔(`agent.toml`)的等級 |
| `duration_min` | integer 5–1440 | | 幾分鐘後自動恢復,預設 60;`default` 時忽略 |

- Agent 記在本機,**重啟後仍有效直到到期**;到期自動恢復設定檔的等級並寫一行日誌。第三方套件(HTTP、TLS、WebSocket)仍只記 warn 以上,不因 trace 記下標頭。
- `result`:`{ "level", "previous", "until" }`(`default` 時 `until` 為 null)。

### `agent.upgrade` — 立即檢查升級 / 指定版本(P6)

路徑:`POST /api/endpoint/devices/{deviceId}/admin-commands`(`endpoint.command.admin`;admin 批次等 B1 第二人核可再開)。`params`:`component`(必填,`agent` / `watchdog`)、`version`(選填,`x.y.z` 可帶 `-後綴`)。

- 省略 `version`:重設這台該元件的失敗次數,依所屬環的目標立即檢查。
- 指定 `version`:這台強制升級 / 降版到該版本(優先於所屬環,到達後清除)。版本必須已登錄且 `published`(`draft` 只能經 pilot 環目標下發,改環目標需 `endpoint.software.manage` 與全部公司角色),否則建立時回 `404 ITA_RELEASE_NOT_FOUND` / `409 ITA_RELEASE_NOT_PUBLISHED` / `409 ITA_RELEASE_REVOKED`,不建立指令。
- Agent(0.7.0 起)收到後在本機管道 `status.upgrade_requested` 通知 Watchdog 立即上報;`succeeded` 只代表已交給 Watchdog,實際結果看 `GET /v1/devices/{id}/upgrade` 與 `upgrade_*` 事件。0.6.0 以前的 Agent 回 `UNSUPPORTED_COMMAND`(強制版本仍已記錄,Watchdog 下次定期上報會取得)。
- `result`:`{ "handed_to_watchdog": true }`。

## 指令附檔(P4-2)

| 方向 | API | 說明 |
| --- | --- | --- |
| Agent → 主機 | `POST /agent/v1/commands/{commandId}/files`(`:9443` mTLS) | 本體為 zip 原始位元組(`Content-Type: application/zip`、必須帶 `Content-Length`,否則 `411 ITA_LENGTH_REQUIRED`)、標頭 `x-file-sha256`;上限 20 MB。只接受屬於此裝置、kind 為 `logs.collect`、狀態 `acked` / `running` 的指令。回 `201`(`command-file.schema.json`)。錯誤:`404 ITA_COMMAND_NOT_FOUND`、`409 ITA_COMMAND_NOT_RUNNING`、`400 ITA_COMMAND_FILE_NOT_ALLOWED`、`400 ITA_FILE_HASH_MISMATCH`、`409 ITA_COMMAND_FILE_EXISTS`(同一指令已有不同內容的檔;相同內容回同一個 `file_id`)、`413 ITA_FILE_TOO_LARGE`、`503 ITA_STORAGE_UNAVAILABLE` |
| IT → 主機 | `GET /api/endpoint/commands/{commandId}/files/{fileId}`(BFF 權限 `endpoint.device.read`) | 下載(`Content-Disposition: attachment`);過期 `410 ITA_COMMAND_FILE_EXPIRED`。`GET /commands/{commandId}` 回應的 `files` 列出附檔 |

- 檔名與存放路徑由主機產生(不採用 Agent 給的名稱);保存 14 天(`COMMAND_FILE_KEEP_DAYS` 14–30,B5),到期刪除檔案,指令紀錄與 `result` 保留。
