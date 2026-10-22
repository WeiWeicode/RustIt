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
| 每台上限 | 同一台尚未結束(queued / sent / acked / running)的同類型指令:`message.show`、`software.install`、`software.uninstall` 各 3 筆,`agent.restart`、`agent.diagnose`、`logs.collect`、`agent.log_level`、`agent.upgrade`、`system.reboot` 各 1 筆;超過回 `409 ITA_COMMAND_LIMIT`(避免洗版、反覆重啟) |
| 批次與核可 | P7 起:admin 批次超過 `BATCH_APPROVAL_THRESHOLD`(預設 20)台為 `pending_approval`,指令留在 `queued` 不送出,需建立人以外的 IT 核可(見「批次第二人核可」);`software.*` 同時執行的總數另受 `SOFTWARE_MAX_CONCURRENT`(預設 20,跨批次與單台)限制 |
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
| `AGENT_UPGRADING` | Agent | P6-2 起:Watchdog 升級 Agent 中(已送 `prepare_shutdown`)收到的新指令,或執行中等 60 秒仍未結束的指令;升級完成後可重新下達 |
| `DOWNLOAD_FAILED`、`HASH_MISMATCH`、`SIGNATURE_INVALID`、`SIGNER_NOT_TRUSTED`、`DISK_FULL` | Agent | P7 起 `software.install`:與 P6 升級同義(下載失敗、SHA-256 不符、Authenticode 無效或未簽章、簽章者不在主機與本機信任清單的交集、磁碟不足);**驗證失敗時不啟動安裝程式** |
| `INSTALL_FAILED` | Agent | P7:安裝 / 移除程式結束代碼不是成功碼,`result.exit_code` 帶值 |
| `INSTALL_TIMEOUT` | Agent | P7:超過 `timeout_sec`,已結束安裝程式的行程樹 |
| `INSTALL_BUSY` | Agent | P7:結束代碼 1618(另一個安裝進行中),間隔 60 秒重試 3 次仍失敗 |
| `DETECT_FAILED` | Agent | P7:結束代碼成功,但登錄檔找不到(安裝)或 120 秒內仍存在(移除)該項目 |
| `UNINSTALL_NOT_SUPPORTED` | Agent | P7:找得到項目,但沒有可用的移除指令 |
| `DEFERRED_TIMEOUT` | Agent | P7:電池 / 計量網路延後下載超過上限(預設 4 小時) |

主機取消指令(`canceled`)時的 `error_code`(P7 起,只出現在管理 API,不送到 Agent):`PACKAGE_REVOKED`(套件撤回時尚未送出的安裝)、`BATCH_REJECTED`(批次被駁回)、`APPROVAL_EXPIRED`(批次 24 小時無人核可)、`PACKAGE_CHANGED`(套件退回 `draft`、改了安裝參數 / 偵測規則 / 重開機政策,尚未送出的舊快照指令取消)、`PACKAGE_FILE_CHANGED`(軟體庫的安裝檔被換掉、與登錄的 SHA-256 不符,該套件排隊中的安裝一併取消,需重新登錄新版本;同時開 `software_file_tampered` 告警)。

管理 API 新增錯誤(P7;HTTP 狀態與代碼):`403 ITA_REVIEWER_SAME_AS_CREATOR`(發佈人 = 登錄人)、`403 ITA_REVIEWER_SAME_AS_EDITOR`(發佈人是上次發佈以來修改過安裝參數 / 偵測規則 / 重開機政策的人,D2-2)、`403 ITA_REVIEWER_NOT_PERSON`(發佈者沒有工號,例如系統 client)、`403 ITA_SCOPE_ALL_REQUIRED`(尚未發佈的套件派到測試機,需可管理所有公司的角色)、`409 ITA_PACKAGE_NOT_PUBLISHED`(也用於「未曾發佈就撤回」的套件派送移除到非 pilot)。

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
| `software.install` | admin | 24 小時 / 4 小時 | 是 | P7(Agent 0.9.0) |
| `software.uninstall` | admin | 24 小時 / 1 小時 | 是 | P7(Agent 0.9.0) |
| `system.reboot` | admin | 4 小時 / 30 分鐘 | 是 | P7(Agent 0.9.0) |

> `software.install` 的逾時含下載與電池延後(安裝本身由 `timeout_sec` 控制,預設 30 分鐘);有效期限 24 小時 = 離線太久回來不再執行過期的安裝。待核可批次的指令有效期限自核可時起算。

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
- `result`:`{ "handed_to_watchdog": true }`。前景模式(開發)回 `failed NOT_RUNNING_AS_SERVICE`;`component` / `version` 格式不符回 `INVALID_PARAMS`。

### `software.install` — 安裝軟體(P7)

路徑:單台 `POST /api/endpoint/devices/{deviceId}/admin-commands`(`endpoint.command.admin`);多台 `POST /api/endpoint/software/{packageId}/deploy`(`action: "install"`)。IT 只送 `params: { "packageId": "<uuid>", "ignorePower"?: true }`;主機查軟體目錄、檢查後把 `params` 換成**目錄快照**(範例 `ws-command-software-install.sample.json`)。**Agent 只信任快照**,不接受其他來源的安裝參數。

| 快照欄位 | 型別 | 說明 |
| --- | --- | --- |
| `package_id`、`name`、`version` | string | |
| `url` | string | 固定 `/agent/v1/packages/{package_id}`;以同一組 mTLS 連線下載,不跟隨重新導向 |
| `sha256`、`size_bytes` | string(64 碼小寫)、integer | 驗整個檔案;不符 `HASH_MISMATCH`,不啟動安裝程式 |
| `installer_type` | `msi` / `inno` / `nsis` / `burn` / `exe` | 決定 Agent 寫死的命令列(P7-SOFTWARE-DESIGN §5.3) |
| `install_args` | string ≤ 500 | 額外參數(可為空字串);字元白名單 `[A-Za-z0-9 /\-_=.:,"{}%()+]`(路徑用 `/`),**再依 `installer_type` 逐一檢查每個參數**(D3):MSI 只接受 `屬性=值`、禁用讀外部檔案或改變安裝方式的屬性與開關(`TRANSFORMS`、`PATCH`、`REBOOT`、`/LOG`、`/LOADINF`、`/SILENT` 等)、路徑只限 `C:/Program Files/` 與 `C:/Program Files (x86)/` 底下、不可含 UNC / `..`。規則細節以測試向量 [`install-args.vectors.json`](install-args.vectors.json) 為準(ItAgentBack 與 Agent P7-2 吃同一份);Agent 執行前再驗,不符 `INVALID_PARAMS`。**不經 cmd.exe / PowerShell** |
| `signer_thumbprints` | string[](40 碼小寫 SHA-1) | 預期簽章者;**`draft` 套件(只會派到 pilot 測試機)為空陣列**:Agent 仍須簽章有效(`Valid`)並回報實際簽章者,且**簽章者仍須在本機 `trusted_signers` 內**(本機清單空白不接受任何套件),不採信空清單放行;非空時實際簽章者須同時在此清單與本機 `trusted_signers` |
| `detect` | `{ type: "msi_product_code" \| "display_name", value }` | 「已安裝」判斷;`display_name` 為登錄檔 DisplayName 的 `LIKE` 樣式(`%` 萬用字元) |
| `timeout_sec` | integer | 安裝本身的逾時,預設 1800 |
| `reboot_policy` | `never` / `required` | |
| `ignore_power` | boolean(選填) | 略過電池延後(不略過計量網路) |

- 單台派送也累計(D2-1):同一人 24 小時內 `software.install` / `software.uninstall`(一組)累計涉及的電腦台數 + 這次 > `BATCH_APPROVAL_THRESHOLD`(20)時,該單台指令放進一個**待核可的單台批次**(`CommandView.batchState = pending_approval`,回應仍是 `CommandView`),需第二人核可後才送出;`system.reboot` 另算一組。已由第二人核可的批次不計入累計,已取消的單台照計。
- 主機檢查(不符就不建立指令):套件存在(`404 ITA_PACKAGE_NOT_FOUND`)、未撤回(`409 ITA_PACKAGE_REVOKED`)、`draft` / `tested` 只能派到 **pilot 環**(`409 ITA_PACKAGE_NOT_PUBLISHED`)、已發佈套件的授權數(`409 ITA_LICENSE_EXCEEDED`)。
- `result`(序列化後 4,000 字元內;範例 `ws-command-update-software-install.sample.json`):`exit_code`、`reboot_required`、`signer`(實際簽章者 SHA-1 指紋)、`signer_subject`、`duration_ms`、`detected`、`already_installed`、`log_tail`(安裝記錄最後 20 行,經 `logs.collect` 同一套遮罩)。結束代碼 `0` 成功;`3010` / `1641` 成功且 `reboot_required = true`;`1638` 視為 `already_installed`;其餘 `INSTALL_FAILED`。`detect` 已通過時直接 `succeeded` + `already_installed = true`。
- 測試機(pilot)回報的 `signer` 是 IT 標記 `tested` 的依據:`mark-tested` 填的簽章者必須等於回報值。
- 安裝檔下載:`GET /agent/v1/packages/{packageId}`(`:9443` mTLS)。只給有**尚未結束**(`sent` / `acked` / `running`)的此套件 `software.install` 的裝置,否則 `404 ITA_PACKAGE_NOT_FOUND`;支援 `Range` / `206`,起點超出檔案 `416`(`Content-Range: bytes */大小`);主機回應前複驗 SHA-256,檔案被換掉 `503 ITA_PACKAGE_CHANGED`、軟體庫讀不到 `503 ITA_PACKAGE_UNAVAILABLE`(稍後重試)。回應標頭 `x-file-sha256` 僅供除錯,**端點以快照的 `sha256` 驗證**。

### `software.uninstall` — 移除軟體(P7)

路徑同 `software.install`(批次 `action: "uninstall"`)。IT 送 `params: { "packageId": "<uuid>" }`,主機換成快照(範例 `ws-command-software-uninstall.sample.json`):`package_id`、`name`、`version`、`installer_type`、`uninstall_args`(同 `install_args` 規則)、`detect`、`timeout_sec`。已撤回的套件仍可移除;`draft` / `tested` 只能對 pilot 環。不檢查授權數。

- `result`:同安裝(`exit_code`、`reboot_required`、`duration_ms`、`log_tail`),另有 `already_absent`(偵測不到項目時直接 `succeeded`)。找不到可用的移除指令 `UNINSTALL_NOT_SUPPORTED`;**監控本身(GigaNexus / RustIt)與防毒 / EDR 不可移除**(Agent 內建清單,符合同回 `UNINSTALL_NOT_SUPPORTED`);移除程式在 Program Files / Windows / `ProgramData\Package Cache` 以外時需通過 ACL 檢查,否則同回 `UNINSTALL_NOT_SUPPORTED`;移除後 120 秒內仍偵測得到 `DETECT_FAILED`。

### `system.reboot` — 重新開機(P7;Agent 端流程在 P7-3)

路徑:單台 `admin-commands`(多台走批次,同樣受核可門檻限制)。`params`(範例 `ws-command-system-reboot.sample.json`):

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `delay_sec` | integer 0–86400 | | 倒數秒數,預設 300(給使用者儲存工作) |
| `message` | string 1–200、單行 | | 附加說明;安全文字規則同 `message.show`(前綴「【IT 部門通知】」、結尾附發送人) |
| `force` | boolean | | 預設 `false`;`true` 強制結束應用程式(畫面需二次確認) |

- `result`:`{ "scheduled_at": "...", "delay_sec": 300 }`(已排程即 `succeeded`,關機後無法再回報)。

## 批次第二人核可(P7;PLATFORM-PLAN B1)

| 情況 | 行為 |
| --- | --- |
| admin 批次 > `BATCH_APPROVAL_THRESHOLD`(20)台,**或同一人 24 小時內累計(含逐台與多批小批次)超過門檻**(D2-1;軟體安裝 / 移除一組、`system.reboot` 一組) | 批次 `state = pending_approval`,指令 `queued` 不送出(重連補送也不送);累計超過門檻的單台指令進單台批次,`CommandView.batchState` 為 `pending_approval` |
| `POST /api/endpoint/batches/{batchId}/approve`(`endpoint.software.manage`) | 建立人以外、資料範圍涵蓋批次全部電腦的人核可 → `running`,指令有效期限自核可時起算並開始送出;核可人 = 建立人 `403 ITA_APPROVER_SAME_AS_CREATOR`;不是待核可或已超過 24 小時 `409 ITA_BATCH_NOT_PENDING` |
| `POST /api/endpoint/batches/{batchId}/approve-command`(`endpoint.command.admin`) | 同 `/approve`,但用於**軟體派送以外**的批次(`system.reboot` 等);批次類型與路由不符(軟體批次走 `/approve-command`、其他批次走 `/approve`)`403 ITA_APPROVAL_ROUTE_MISMATCH` |
| `POST /api/endpoint/batches/{batchId}/reject-command`(`reason` 必填,`endpoint.command.admin`) | 同 `/reject`,用於非軟體批次;類型不符同上 `403 ITA_APPROVAL_ROUTE_MISMATCH` |
| `POST /api/endpoint/batches/{batchId}/reject`(`reason` 必填) | `rejected`,指令 `canceled`(`BATCH_REJECTED`);建立人也可撤回自己的批次 |
| 24 小時無人核可 | 每分鐘掃描 → `expired`,指令 `canceled`(`APPROVAL_EXPIRED`) |
| ≤ 門檻 | 不需核可(`running`),一樣寫稽核 |

`CommandView.batchState`(`pending_approval` / `running` / `done` / `rejected` / `expired`,不屬於批次為 `null`)讓清單直接看出單台指令是否在等核可。

`GET /api/endpoint/batches/{batchId}` 回 `state`(`pending_approval` / `running` / `done` / `rejected` / `expired`)、`requiresApproval`、`approvalExpiresAt`、`approvedBy` / `approvedAt`、`rejectedBy` / `rejectedAt` / `rejectReason`。

## 指令附檔(P4-2)

| 方向 | API | 說明 |
| --- | --- | --- |
| Agent → 主機 | `POST /agent/v1/commands/{commandId}/files`(`:9443` mTLS) | 本體為 zip 原始位元組(`Content-Type: application/zip`、必須帶 `Content-Length`,否則 `411 ITA_LENGTH_REQUIRED`)、標頭 `x-file-sha256`;上限 20 MB。只接受屬於此裝置、kind 為 `logs.collect`、狀態 `acked` / `running` 的指令。回 `201`(`command-file.schema.json`)。錯誤:`404 ITA_COMMAND_NOT_FOUND`、`409 ITA_COMMAND_NOT_RUNNING`、`400 ITA_COMMAND_FILE_NOT_ALLOWED`、`400 ITA_FILE_HASH_MISMATCH`、`409 ITA_COMMAND_FILE_EXISTS`(同一指令已有不同內容的檔;相同內容回同一個 `file_id`)、`413 ITA_FILE_TOO_LARGE`、`503 ITA_STORAGE_UNAVAILABLE` |
| IT → 主機 | `GET /api/endpoint/commands/{commandId}/files/{fileId}`(BFF 權限 `endpoint.device.read`) | 下載(`Content-Disposition: attachment`);過期 `410 ITA_COMMAND_FILE_EXPIRED`。`GET /commands/{commandId}` 回應的 `files` 列出附檔 |

- 檔名與存放路徑由主機產生(不採用 Agent 給的名稱);保存 14 天(`COMMAND_FILE_KEEP_DAYS` 14–30,B5),到期刪除檔案,指令紀錄與 `result` 保留。
