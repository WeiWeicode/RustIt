# 資料契約(Agent ↔ ItAgentBack)

RustAgent 與 ItAgentBack 的**唯一共同依據**(`AGENT.md` §7.3、INTEGRATION-PLAN §5)。兩端不共用程式碼,各自以 `examples/` 的同一份範例做契約測試;改契約時兩端測試一起更新。

| Schema | 用途 | 範例 |
| --- | --- | --- |
| [inventory.schema.json](inventory.schema.json) | `POST /agent/v1/inventory` 請求;回應在 `definitions.InventoryResponse` | `inventory.sample.json`、`inventory-response.sample.json` |
| [ws-envelope.schema.json](ws-envelope.schema.json) | WebSocket `GET /agent/v1/ws` 信封與 `hello` / `hello_ack` / `heartbeat` / `heartbeat_ack` / `unsupported`;P4 `command` / `command_update` / `command_update_ack` / `prepare_shutdown` | `ws-*.sample.json` |
| [sync.schema.json](sync.schema.json) | `POST /agent/v1/sync` 請求;回應在 `definitions.SyncResponse`(PLATFORM-PLAN P2) | `sync.sample.json`、`sync-response.sample.json` |
| [event.schema.json](event.schema.json) | `POST /agent/v1/events` 請求(`offline_period`、`usb_inserted` / `usb_removed`、`agent_started`、`local_overflow`;P5-2 加 Agent 的 `watchdog_stopped` / `watchdog_missing` 與 Watchdog 的 `agent_restarted`、`agent_service_stopped`、`agent_start_type_changed`、`agent_binary_missing`、`agent_start_failed`);回應在 `definitions.EventsResponse`(P2) | `event.sample.json`、`event-response.sample.json` |
| [command-kinds.md](command-kinds.md) | 指令類型:`kind`、等級、`params`、`result`、有效期限 / 逾時、錯誤代碼(PLATFORM-PLAN P4) | `ws-command*.sample.json` |
| [watchdog.schema.json](watchdog.schema.json) | `POST /agent/v1/watchdog/report`(Watchdog 上報,P5-2):Agent 服務狀態、24 小時重啟次數、憑證到期日、事件(引用 `event.schema.json` 的 `Event`);回應在 `definitions.WatchdogReportResponse`(`target` 在 P6 才有值) | `watchdog-report.sample.json`、`watchdog-report-response.sample.json` |
| [pipe.schema.json](pipe.schema.json) | 本機具名管道 `\\.\pipe\giganexus-agent-v1`(Watchdog ↔ Agent,P5-2):`get_status` / `status`;`prepare_shutdown` 只定義(P6) | `pipe-get-status.sample.json`、`pipe-status.sample.json` |
| [command-file.schema.json](command-file.schema.json) | `POST /agent/v1/commands/{commandId}/files`(指令附檔,`logs.collect` 日誌 zip)的回應;請求為原始位元組 + `x-file-sha256`(P4-2) | `command-file-response.sample.json` |

- JSON Schema **draft-07**(Fastify 內建的 Ajv 與 Rust `jsonschema` 都支援)。欄位名稱 `snake_case`(沿用 collector 的 serde 輸出)。
- 相容規則:只新增欄位,新欄位不列入 `required`;收到不認得的欄位忽略(不使用 `additionalProperties: false`);不認得的 WebSocket `type` 回 `unsupported`;不相容的變更走 `/agent/v2/` 並存。
- 裝置身分不在訊息內:由 Gateway `:9443` 的 `x-client-cert-dn` / `x-client-cert-fp` 標頭決定(ENDPOINT-AGENT-GUIDE §3.3、§4.1);`device_id` 由後端指派。
- 錯誤回應沿用 Gateway 格式 `{ code, message, requestId }`:`401 DEVICE_UNAUTHORIZED`(沒有憑證標頭)、`403 ITA_DEVICE_DISABLED` / `403 ITA_DEVICE_RETIRED`(退役)、`400 VALIDATION_FAILED`、`503 ITA_STORAGE_UNAVAILABLE`(SQL Server 無法寫入,Agent 留在本機暫存重試)、`429 ITA_BUSY`(主機忙碌,見下)。
- **主機忙碌 `429` + `Retry-After`(秒)**(PLATFORM-PLAN A3):HTTPS 回報(`/inventory`、`/sync`、`/events`)同時處理中的請求超過上限時回 `429 ITA_BUSY`。Agent 等 `Retry-After` 秒再加 0–30% 隨機延遲後重送,**不計入一般錯誤的指數退避**;`/sync` 的 `need` 單次最多 20 筆。
- **主機下發設定**:`hello_ack.settings`(`AgentSettings`,ws-envelope)與 `settings_version`;Agent 持久化,離線與重開機時沿用最後一次的值(PLATFORM-PLAN §4.2)。原計畫的獨立 `settings.schema.json` 併入 ws-envelope 的 `AgentSettings`(只在 `hello_ack` 使用,不另開檔案)。
- **範例必須去識別化**:使用者、電腦名稱、序號、UUID、MAC(`00:00:5E:00:53:xx`,RFC 7042 文件用)、IP(`192.0.2.0/24`、`198.51.100.0/24`,RFC 5737)一律用假值;不可提交 `cargo run -p rustit-collector --example dump` 的真實結果。
