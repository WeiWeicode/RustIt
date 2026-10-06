# ItAgentBack 資料結構

> 對應 `db/migrations/0001_init.sql`。原則(INTEGRATION-PLAN §3.1):**SQL Server 是唯一真相**;MongoDB 與 Redis 只放可重建的資料。
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
| `status` | VARCHAR(16) | `active` / `disabled`(停用:HTTPS 403、WebSocket 4403) |
| `agent_version` | VARCHAR(32) | |
| `first_seen_at` / `last_seen_at` | DATETIME2(3) | `last_seen_at` 由回報、hello、斷線更新,心跳最多每 5 分鐘落盤一次 |
| `last_inventory_at` | DATETIME2(3) | 最後一次資產回報(含內容沒變) |
| 共通欄位 | | `created_at/by`、`updated_at/by`、`row_ver` |

### `ita.device_inventory` — 最新一份資產(1:1)

`device_ref` 為主鍵;`agent_seq`、`content_hash`、`collected_at`、`received_at`;查詢用摘要欄位(`host_name`、`user_name`、`domain`、`manufacturer`、`model`、`os_*`、`arch`、`boot_time`、`bios_serial`、`system_uuid`、`cpu_*`、`memory_total`、`primary_ip`);完整快照 `payload NVARCHAR(MAX)`(Agent 的 `ComputerInfo` JSON)。

### `ita.device_nic` — 網卡位址

一張網卡的每個 IP 一列(沒有 IP 的網卡一列 `ip_address = NULL`),索引 `mac`、`ip_address`,供依 IP / MAC 查詢;隨最新資產整批替換。管理 API 的 `ips` 取 IPv4,有閘道的網卡優先。

### `ita.device_event` — 稽核

`event_type`:`registered`(首次連線)、`fingerprint_changed`(憑證續約或被複製)、`duplicate_connection`(同一裝置第二條 WebSocket)、`disabled` / `enabled`(管理 API 實作後)。

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
