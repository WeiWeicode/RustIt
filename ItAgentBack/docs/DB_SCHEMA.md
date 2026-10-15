# ItAgentBack 資料結構

> 對應 `db/migrations/0001_init.sql`、`0002_sync_event.sql`(PLATFORM-PLAN P2)、`0003_command.sql`(P4)。原則(INTEGRATION-PLAN §3.1):**SQL Server 是唯一真相**;MongoDB 與 Redis 只放可重建的資料。
> SQL Server 2012(`DATABASE.md` §0):無 JSON 函式、無 `CREATE OR ALTER`;JSON 由 ItAgentBack 組 / 解,需要查詢的值拆成獨立欄位。時間一律 UTC。

## 1. SQL Server(schema `ita`)

| 資料庫 | 用途 | 帳號 |
| --- | --- | --- |
| `giganexus_It_Agent_test` | 開發 + 測試區共用 | `ita_app`(讀寫)/ `ita_migrate`(migration) |
| `giganexus_It_Agent_poc_test` | 整合測試(`npm run test:int` 每次清空重建) | 同上 |
| `giganexus_It_Agent` | 正式區(2026-12 建立) | `ita_prod_app` / `ita_prod_migrate` |

建庫與帳號:`db/dba/01-create-databases.sql`(DBA 以 sa 執行)。結構:`npm run db:migrate`(以 `ita_migrate` 套用 `db/migrations/*.sql`,記錄於 `ita.schema_migration`;已套用的檔案不可再改)。

### `ita.device` — 裝置登錄

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `id` | INT PK | 內部主鍵 |
| `device_id` | UNIQUEIDENTIFIER UQ | 對外識別(管理 API 的 `deviceId`) |
| `cert_dn` | NVARCHAR(450) UQ | **裝置鍵**:`x-client-cert-dn` 完整字串(指南 §3.3) |
| `cert_fp` | CHAR(40) | 目前的憑證指紋;變更時寫 `device_event` |
| `computer_name` | NVARCHAR(255) | 登錄時取 DN 的 CN,收到 hello / 資產後改為實際電腦名稱 |
| `status` | VARCHAR(16) | `active` / `disabled`(停用:HTTPS 403、WebSocket 4403)/ `retired`(退役,0002;畫面在 P3) |
| `agent_version` | VARCHAR(32) | |
| `first_seen_at` / `last_seen_at` | DATETIME2(3) | `last_seen_at` 由回報、hello、斷線更新,心跳最多每 5 分鐘落盤一次 |
| `last_inventory_at` | DATETIME2(3) | 最後一次資產回報(含內容沒變) |
| `hw_fingerprint` | CHAR(64) | 0002:hello 的硬體指紋(BIOS 序號 + 系統 UUID 的 SHA-256;A1),篩選索引;與其他裝置相同時寫 `suspected_duplicate` |
| `clock_skew_ms` / `clock_checked_at` | INT / DATETIME2(3) | 0002:最近一次 hello 的時鐘偏差(端點 − 主機,毫秒)與檢查時間(A2) |
| `merged_into` / `retired_at` | INT FK / DATETIME2(3) | 0002:IT 確認合併後指向保留的裝置、退役時間(A1;操作在 P3) |
| 共通欄位 | | `created_at/by`、`updated_at/by`、`row_ver` |

### `ita.device_inventory` — 最新一份資產(1:1)

`device_ref` 為主鍵;`agent_seq`、`content_hash`、`collected_at`、`received_at`;查詢用摘要欄位(`host_name`、`user_name`、`domain`、`manufacturer`、`model`、`os_*`、`arch`、`boot_time`、`bios_serial`、`system_uuid`、`cpu_*`、`memory_total`、`primary_ip`);完整快照 `payload NVARCHAR(MAX)`(Agent 的 `ComputerInfo` JSON)。

### `ita.device_nic` — 網卡位址

一張網卡的每個 IP 一列(沒有 IP 的網卡一列 `ip_address = NULL`),索引 `mac`、`ip_address`,供依 IP / MAC 查詢;隨最新資產整批替換。管理 API 的 `ips` 取 IPv4,有閘道的網卡優先。

### `ita.device_event` — 稽核與端點事件

主機產生(`event_uid` 為 NULL,`occurred_at` = 寫入時間):`registered`(首次連線)、`fingerprint_changed`(憑證續約或被複製)、`duplicate_connection`(同一裝置第二條 WebSocket)、`clock_skew`(時鐘偏差由正常變成超過 ±5 分鐘)、`suspected_duplicate`(硬體指紋與另一台相同)、`disabled` / `enabled`(管理 API 實作後)。

Agent 回報(0002,`POST /agent/v1/events`;`event.schema.json`):`offline_period`、`usb_inserted` / `usb_removed`、`agent_started`、`local_overflow` 等。`occurred_at` 為**端點上的發生時間**,`received_at` 為主機收到時間,`event_uid` 為 Agent 產生的 event_id,`(device_ref, event_uid)` 篩選唯一索引去重(重送不重複),`data` 為事件內容 JSON(上限 4,000 字元,過長只記長度)。不認得的 type 照常保存。

### `ita.command` / `ita.command_batch` — 指令(0003,P4)

一筆 `ita.command` = 一台電腦一個動作(ENDPOINT-AGENT-GUIDE §8.4–§8.5;類型 `docs/contracts/command-kinds.md`)。

| 欄位 | 說明 |
| --- | --- |
| `command_id` | 對外 `commandId`;Agent 以此去重,WebSocket 信封 id 同值 |
| `batch_ref` | 屬於批次時指向 `command_batch`(`max_concurrent` 同時執行上限,預設 20) |
| `device_ref` / `cert_dn` | 對象與建立當下的 DN(稽核) |
| `kind` / `level` / `params` | 類型、`basic` / `admin`、參數 JSON(不含機密,原樣保存以便重送) |
| `state` | `queued` → `sent` → `acked` → `running` → `succeeded` / `failed`;`queued` 可 `canceled`;`queued` / `sent` 超過 `expires_at` → `expired`;斷線時 `sent` 改回 `queued`。條件更新,只能往前,終態不變 |
| `progress` / `result_summary` / `error_code` / `error_message` | Agent 的 `command_update`(result 4,000 字元內,過長只記大小) |
| `expires_at` / `timeout_at` | 有效期限(未確認收到前)/ 執行逾時(acked 後設定,超過 → `failed TIMEOUT`) |
| `send_count`、`sent_at` / `acked_at` / `started_at` / `finished_at` | 推送次數與各階段時間 |
| `idempotency_key` | 與 `created_by_emp` 篩選唯一索引(重複送出回傳同一筆) |
| `created_by_emp` / `created_by_name` / `request_id` / `created_at` | 稽核:內部 Token 的工號、姓名與 X-Request-Id(不以來源 IP 為依據) |

`ita.command_batch`:`batch_id`、`kind`、`level`、`params`、`target_count`、`max_concurrent`、第二人核可欄位(`requires_approval`、`approved_by_*`,B1,邏輯在 P7)、冪等鍵與稽核欄位。`ita.command_file`:指令附檔索引(`logs.collect` 的日誌 zip,A4;P4-2):`file_id`(對外)、`command_ref`、`file_name`(下載顯示名稱,主機產生)、`size_bytes`、`sha256`、`storage_path`(相對於 `COMMAND_FILES_DIR`)、`expires_at`(建立 + `COMMAND_FILE_KEEP_DAYS`,預設 14 天,B5)。寫入順序:先寫檔、再寫索引(失敗刪檔);清除:先刪檔、再刪索引列,`ita.command` 保留。

### 離線補傳比對(`DeviceService.sync`,`POST /agent/v1/sync`)

與目前資料同 `content_hash`、或 Mongo 已有同 `agent_seq` 的列入 `skip`(Agent 直接刪除);其餘同 hash 只取最新一份,依 `collected_at` 由舊到新列入 `need`,單次最多 20 筆;Agent 逐筆 `POST /agent/v1/inventory`,較舊的只進 Mongo 歷史(`archived`)。Mongo 無法使用時不去重。

### 寫入順序(`DeviceService.ingestInventory`)

1. 比對 `content_hash`:Redis → SQL;相同 → 只更新 `last_seen_at`、`last_inventory_at`(`unchanged`)。
2. `collected_at` 比目前資料舊(補傳)→ 只進 Mongo 歷史(`archived`)。
3. 否則在**一個交易**寫 `device_inventory`(upsert)、`device_nic`(替換)、`device`(名稱、版本、時間)→ 成功後寫 Mongo 快照 → 更新 Redis hash(`stored`)。
4. SQL 失敗回 503 `ITA_STORAGE_UNAVAILABLE`,不寫 Mongo / Redis;Mongo / Redis 失敗只記 warn。

## 2. MongoDB 7(資料庫 `ita_{env}`)

| 集合 | 內容 | 索引 |
| --- | --- | --- |
| `snapshots` | 每份被接受的快照(含補傳的舊快照):`device_id`、`agent_seq`、`content_hash`、`collected_at`、`received_at`、`inventory` | `(device_id, agent_seq, content_hash)` 唯一(重複補傳不重複);`received_at` TTL `SNAPSHOT_RETENTION_DAYS`(預設 90 天) |
| `heartbeats` | 心跳:`device_id`、`at`、`body` | `at` TTL 1 天 |

## 3. Redis 7(前綴 `ita:{env}:`)

| Key | 內容 | TTL |
| --- | --- | --- |
| `ita:{env}:online:{deviceId}` | 在線資訊 JSON(`connectedAt`、`lastHeartbeatAt`、`agentVersion`) | 90 秒(3 個心跳間隔),每次心跳續期;WebSocket 關閉即刪除 |
| `ita:{env}:hash:{deviceId}` | 目前資料的 `content_hash` | 7 天 |

Redis 無法使用時,在線狀態退回本實例的 WebSocket 連線表,hash 比對退回 SQL。
