# 資料契約(Agent ↔ ItAgentBack)

RustAgent 與 ItAgentBack 的**唯一共同依據**(`AGENT.md` §7.3、INTEGRATION-PLAN §5)。兩端不共用程式碼,各自以 `examples/` 的同一份範例做契約測試;改契約時兩端測試一起更新。

| Schema | 用途 | 範例 |
| --- | --- | --- |
| [inventory.schema.json](inventory.schema.json) | `POST /agent/v1/inventory` 請求;回應在 `definitions.InventoryResponse` | `inventory.sample.json`、`inventory-response.sample.json` |
| [ws-envelope.schema.json](ws-envelope.schema.json) | WebSocket `GET /agent/v1/ws` 信封與 `hello` / `hello_ack` / `heartbeat` / `heartbeat_ack` / `unsupported` | `ws-*.sample.json` |
| [sync.schema.json](sync.schema.json) | `POST /agent/v1/sync` 請求;回應在 `definitions.SyncResponse`(M5) | `sync.sample.json`、`sync-response.sample.json` |

- JSON Schema **draft-07**(Fastify 內建的 Ajv 與 Rust `jsonschema` 都支援)。欄位名稱 `snake_case`(沿用 collector 的 serde 輸出)。
- 相容規則:只新增欄位,新欄位不列入 `required`;收到不認得的欄位忽略(不使用 `additionalProperties: false`);不認得的 WebSocket `type` 回 `unsupported`;不相容的變更走 `/agent/v2/` 並存。
- 裝置身分不在訊息內:由 Gateway `:9443` 的 `x-client-cert-dn` / `x-client-cert-fp` 標頭決定(ENDPOINT-AGENT-GUIDE §3.3、§4.1);`device_id` 由後端指派。
- 錯誤回應沿用 Gateway 格式 `{ code, message, requestId }`:`401 DEVICE_UNAUTHORIZED`(沒有憑證標頭)、`403 ITA_DEVICE_DISABLED`、`400 VALIDATION_FAILED`、`503 ITA_STORAGE_UNAVAILABLE`(SQL Server 無法寫入,Agent 留在本機暫存重試)。
- **範例必須去識別化**:使用者、電腦名稱、序號、UUID、MAC(`00:00:5E:00:53:xx`,RFC 7042 文件用)、IP(`192.0.2.0/24`、`198.51.100.0/24`,RFC 5737)一律用假值;不可提交 `cargo run -p rustit-collector --example dump` 的真實結果。
