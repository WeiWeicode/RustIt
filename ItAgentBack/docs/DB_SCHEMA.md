# ItAgentBack 資料結構

> 對應 `db/migrations/0001_init.sql`、`0002_sync_event.sql`(PLATFORM-PLAN P2)、`0003_command.sql`(P4)、`0004`(P3 軟體)、`0005`(E6 公司)、`0006_monitor.sql`(P5 監測)、`0007_release.sql`(P6 升級)、`0008_software.sql`(P7 軟體派送)、`0009_software_timeout.sql`(P7 套件安裝逾時)、`0010_software_file_release.sql`(P7 撤回釋放安裝檔路徑)、`0011_software_upload.sql`(S1-3 上傳與送簽)。原則(INTEGRATION-PLAN §3.1):**SQL Server 是唯一真相**;MongoDB 與 Redis 只放可重建的資料。
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
| `company` | NVARCHAR(20) NULL | 0005:所屬公司(名稱同 Gateway `gw.company.comp_name` / 內部 Token 的 `cos`);NULL = 未指定,只有可管理所有公司的角色看得到(E6)。索引 `ix_device_company`;程式比對一律 `COLLATE Latin1_General_BIN2`(逐字,與 service 的範圍判斷一致) |
| `company_source` | VARCHAR(8) NULL | 0005:`cert`(憑證 CN 的 FQDN 網域)/ `domain`(Agent 回報的網域)/ `manual`(IT 以 `PUT /v1/devices/{id}/company` 指定,之後不自動改);NULL = 未判定。CHECK `ck_device_company_source` |
| 共通欄位 | | `created_at/by`、`updated_at/by`、`row_ver` |

### `ita.device_inventory` — 最新一份資產(1:1)

`device_ref` 為主鍵;`agent_seq`、`content_hash`、`collected_at`、`received_at`;查詢用摘要欄位(`host_name`、`user_name`、`domain`、`manufacturer`、`model`、`os_*`、`arch`、`boot_time`、`bios_serial`、`system_uuid`、`cpu_*`、`memory_total`、`primary_ip`);完整快照 `payload NVARCHAR(MAX)`(Agent 的 `ComputerInfo` JSON)。

### `ita.device_nic` — 網卡位址

一張網卡的每個 IP 一列(沒有 IP 的網卡一列 `ip_address = NULL`),索引 `mac`、`ip_address`,供依 IP / MAC 查詢;隨最新資產整批替換。管理 API 的 `ips` 取 IPv4,有閘道的網卡優先。

### `ita.device_software` — 軟體清單(0004,P3)

最新一份資產的軟體清單,一個軟體一列(`name` NVARCHAR(400)、`version`、`publisher`、`install_date` 原樣字串),隨資產寫入整批替換;索引 `name`(含 `device_ref`),供管理 API 依軟體名稱找電腦(`LIKE` 部分比對)。0004 之前寫入的資產由服務啟動時從 `payload` 回填(`DeviceService.backfillSoftware`,依 `device_ref` 游標分批;鎖住資產列後重讀,與 Agent 同時回報不會重複)。**部署順序:先套用 0004,再部署新版 endpoint-server**(新版寫入資產時會替換此表)。

### `ita.device_event` — 稽核與端點事件

主機產生(`event_uid` 為 NULL,`occurred_at` = 寫入時間):`registered`(首次連線)、`fingerprint_changed`(憑證續約或被複製)、`duplicate_connection`(同一裝置第二條 WebSocket)、`clock_skew`(時鐘偏差由正常變成超過 ±5 分鐘)、`suspected_duplicate`(硬體指紋與另一台相同)、`disabled` / `enabled` / `retired`(P3 管理 API `PUT /v1/devices/{id}/status`,detail 帶操作人工號與原因)、`merged`(P3 合併,記在保留的舊裝置,detail 帶操作人、來源 deviceId、舊 DN 與原因)、`company_changed`(0005 / E6:所屬公司變更,detail 帶舊值、新值、來源、操作人;自動判定只在公司有變時寫)、`release_download`(P6:開始下載版本檔)、`package_download`(P7:開始下載軟體套件,從第 0 位元組起的請求,同一台同一套件每小時一筆)。管理 API 回傳事件時,detail 提到資料範圍外的裝置(`suspected_duplicate`、`merged`)改為不含識別資訊的說明。

主機比對資產產生(P5,`event_uid` 為 NULL,`occurred_at` = 新資產的 `collected_at`,內容在 `data`;與資產同一交易寫入,`docs/P5-MONITOR-DESIGN.md` §3.2):`software_installed` / `software_removed` / `software_updated`(`name`、`version` 或 `from` / `to`、`publisher`)、`software_changed_bulk`(一份資產超過 50 項)、`hardware_changed`(`component`、`before`、`after`)。

Agent 回報(0002,`POST /agent/v1/events`;`event.schema.json`):`offline_period`、`usb_inserted` / `usb_removed`、`agent_started`(P5 起 data 帶 `previous_exit`、`boot_time`)、`local_overflow` 等。`occurred_at` 為**端點上的發生時間**,`received_at` 為主機收到時間,`event_uid` 為 Agent 產生的 event_id,`(device_ref, event_uid)` 篩選唯一索引去重(重送不重複),`data` 為事件內容 JSON(上限 4,000 字元,過長只記長度)。不認得的 type 照常保存。

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

`ita.command_batch`:`batch_id`、`kind`、`level`、`params`、`target_count`、`max_concurrent`、第二人核可欄位(`requires_approval`、`approved_by_*`,B1)、冪等鍵與稽核欄位。0008(P7)加 `state`(`pending_approval` / `running` / `done` / `rejected` / `expired`,預設 `running`;既有批次為 `running`,畫面以「全部指令已結束」顯示 `done`)與駁回欄位 `rejected_by_emp` / `rejected_by_name` / `rejected_at` / `reject_reason`;CHECK `ck_command_batch_approver`(核可人 ≠ 建立人)、索引 `ix_command_batch_state`。admin 批次超過 `BATCH_APPROVAL_THRESHOLD` 台建立為 `pending_approval`(指令 `queued` 不送出,`expires_at` 另加 24 小時);核可時條件更新為 `running` 並把批次內 `queued` 指令的 `expires_at` 改為核可時間 + 類型有效期限(同一交易);同一人 24 小時內累計超過門檻的逐台派送(D2-1)也建立單台的 `pending_approval` 批次(累計查詢用 `ita.command` 的索引 `ix_command_creator (created_by_emp, created_at) INCLUDE (kind, device_ref, batch_ref)`);駁回 / 24 小時逾期時批次內 `queued` 指令改 `canceled`(`error_code` `BATCH_REJECTED` / `APPROVAL_EXPIRED`);`running` 且全部指令結束時改 `done`。`ita.command_file`:指令附檔索引(`logs.collect` 的日誌 zip,A4;P4-2):`file_id`(對外)、`command_ref`、`file_name`(下載顯示名稱,主機產生)、`size_bytes`、`sha256`、`storage_path`(相對於 `COMMAND_FILES_DIR`)、`expires_at`(建立 + `COMMAND_FILE_KEEP_DAYS`,預設 14 天,B5)。寫入順序:先寫檔、再寫索引(失敗刪檔);清除:先刪檔、再刪索引列,`ita.command` 保留。

### `ita.device_health` — 最近健康與 Watchdog 狀態(0006,P5,1:1)

`device_ref` 為主鍵。心跳的健康摘要(`cpu_pct`、`mem_used_pct`、`disk_min_free_pct`、`disk_min_free_drive`、`uptime_s`、`agent_rss_mb`,`health_at`)每台每 5 分鐘落盤一次(連線後第一則帶健康的心跳就落盤;0–100 以外的值夾到範圍內);`cert_not_after` 由 hello 寫入。Watchdog 欄位(`watchdog_version`、`watchdog_report_at`(主機收到時間)、`agent_service_state`、`agent_start_type`、`agent_status_ok`、`agent_last_error`、`agent_restarts_24h`)由 `POST /agent/v1/watchdog/report` 寫入(P5-2,`DeviceService.watchdogReport`;Watchdog 的事件照端點事件寫 `device_event`,`cert_not_after` 也一併更新)。在線電腦的清單顯示 Redis 在線資訊裡最近一則心跳的健康,離線電腦顯示這裡的值。

### `ita.device_alert` — 告警(0006,P5)

`alert_id`(對外)、`device_ref`、`rule`(`offline_long` / `disk_low` / `hardware_changed` / `agent_restarts` / `cert_expiring` / `clock_skew` / `agent_tampered` / `agent_silent`)、`severity`(`warn` / `critical`)、`state`(`open` / `resolved`)、`opened_at`、`last_seen_at`(條件仍成立的最近一次評估)、`resolved_at`、`resolved_by`(`auto` / `manual`)、手動關閉的 `resolved_by_emp` / `resolved_by_name` / `resolve_note` / `request_id`、`detail`(JSON)、`event_ref`(觸發的事件)。**篩選唯一** `ux_device_alert_open (device_ref, rule) WHERE state = 'open'`:同一台同一規則只有一筆未結束,條件持續成立只更新 `last_seen_at` / `detail` / `severity`。

- 自動類規則每 5 分鐘由 `AlertService.sweep` 評估(active、未合併的裝置);條件消失 `resolved_by = auto`。事件類(`hardware_changed`;P5-2 的 `agent_tampered`:端點事件 `agent_service_stopped`、`agent_start_type_changed`、`agent_binary_missing`、`agent_binary_changed`、`agent_pipe_impersonation`、`watchdog_stopped`、`watchdog_missing`、`watchdog_binary_changed`)只在事件**第一次寫入**時開(重送不重開),不自動關閉。Watchdog 事件只收 `POST /agent/v1/watchdog/report`,`/agent/v1/events` 不收(反之亦然)。
- 停用 / 退役 / 已合併的裝置,掃描時把未結束的告警一律自動關閉。
- 非正常重啟次數:24 小時內 `event_type = 'agent_started'` 且 `data LIKE '%"previous_exit":"unexpected"%'` 的筆數(`ix_device_event_device`)。
- 門檻見 `ita.env` 的 `ALERT_*`(`src/config.ts`);保存期限 1 年,清除工作在上線前與其他保存期限一起做(B5)。
- **部署順序:先套用 0006,再部署新版 endpoint-server**(新版心跳、hello、清單與告警掃描都會讀寫這兩張表)。
- P6 加兩條規則(`ReleaseService.sweep` 與 Watchdog 上報時評估,不在 `AlertService` 的自動類清單內):`upgrade_failed`(同一目標版本失敗 2 次或 `ROLLBACK_FAILED`;升級成功或目標改變時自動關閉)、`version_mismatch`(目標生效超過 24 小時、1 小時內有回報仍未到目標;已有 `upgrade_failed` 時不開)。

### `ita.agent_release` / `ita.release_ring` / `ita.device_upgrade`、`ita.device.ring` — 升級(0007,P6;`docs/P6-UPGRADE-DESIGN.md` §1)

- `ita.agent_release`:`release_id`(對外)、`component`(`agent` / `watchdog` / `desktop`)、`version`(`UNIQUE (component, version)`)、`file_name`(版本檔目錄 `{component}/{version}/` 下的檔名)、`sha256` / `size_bytes`(**登錄時由主機讀檔計算**)、`signer_thumbprints`(預期簽章者 SHA-1 指紋,逗號分隔)、`status`(`draft` → `published` → `revoked`)、`notes`、登錄 / 發佈 / 撤回的工號與時間、`request_id`。撤回時同一交易把以此版本為目標的環改為 NULL、清除指定此版本的強制升級。
- `ita.release_ring`:PK `(ring, component)`,migration 建好 `pilot` / `it` / `all` × `agent` / `watchdog` 六列(目標 NULL)。`target_version` NULL = 不升級;`target_set_at` 只在版本改變時更新(推進限制「pilot 觀察滿 24 小時」與 `version_mismatch` 的起算點)。
- `ita.device.ring`(預設 `all`,CHECK `pilot` / `it` / `all`)。
- `ita.device_upgrade`:PK `(device_ref, component)`;`target_version`、`from_version`、`state`(`pending` / `downloading` / `verifying` / `installing` / `succeeded` / `failed` / `rolled_back`)、`attempts`(同一目標的失敗次數,換目標歸零;達 2 不再自動下發)、`error_code` / `error_message`、`forced_version` / `forced_by_emp` / `forced_at`(`agent.upgrade` 指定版本,優先於所屬環;到達後清除)、`started_at`、`updated_at`。同時升級上限計算 `pending` ~ `installing` 且 30 分鐘內有更新的台數(`ix_device_upgrade_state`)。
- **部署順序:先套用 0007,再部署新版 endpoint-server**;`RELEASES_DIR` 未設定時新版不讀寫這些表(版本 API 不註冊、Watchdog 的 `target` 一律 null)。

### `ita.software_package` — 軟體目錄(0008,P7;`docs/P7-SOFTWARE-DESIGN.md` §1)

- `package_id`(對外)、`name` / `version`(`UNIQUE (name, version)`;同一軟體的不同版本是不同的列)、`file_name`(軟體庫 `SOFTWARE_DIR` 下的相對路徑 `{軟體}/{版本}/{檔名}`,以 `/` 分隔;同一檔案只能被一筆**未撤回**的套件登錄:0010 起為篩選唯一索引 `ux_software_package_file_active (file_name) WHERE status IN ('draft', 'tested', 'published')`,撤回後同一檔案可重新登錄(0008 原為 `uq_software_package_file UNIQUE`,涵蓋已撤回;**部署順序:先套用 0010,再部署新版 endpoint-server**))、`sha256` / `size_bytes`(**登錄時由主機讀檔計算**,下載前再比對)。
- `installer_type`(`msi` / `inno` / `nsis` / `burn` / `exe`)、`install_args` / `uninstall_args`(額外靜默參數,字元白名單、不可指到其他檔案、不可含機密字樣;主機登錄、修改、建立指令時都驗)、`detect_type` / `detect_value`(`msi_product_code` 的 `{GUID}`,或 `display_name` 的 DisplayName `LIKE` 樣式,`%` 為萬用字元)、`reboot_policy`(`never` / `required`)。
- `signer_thumbprints`(預期簽章者 SHA-1 指紋,逗號分隔;`tested` 之前為 NULL)、`observed_signers`(標記 `tested` 時從 pilot 測試機回報的 `result.signer` 寫入;IT 填的預期簽章者必須在其中)、`license_limit`(NULL = 不限;只做派送時的上限檢查,以 `device_software.name LIKE detect_value` 計數,必須是 `display_name` 偵測)。
- `status`:`draft` → `tested` → `published` → `revoked`,一律條件更新;tested / published 改到安裝參數或偵測規則時退回 `draft`(清除 `signer_thumbprints`、`tested_*`、`published_*`)。撤回時同一交易把此套件 `queued` 的 `software.install` 改 `canceled`(`error_code = PACKAGE_REVOKED`);退回 `draft` 時同一交易把尚未送出(`queued`,含待核可批次)的 `software.install` / `software.uninstall` 舊快照改 `canceled`(`PACKAGE_CHANGED`);安裝檔被換掉時 `cancelQueuedInstalls` 取消排隊中的安裝(`PACKAGE_FILE_CHANGED`)。
- 稽核欄位:`created_by_*` / `created_at`、`updated_by_emp` / `updated_at`、`tested_by_emp` / `tested_at`、`published_by_emp` / `published_by_name` / `published_at`、`revoked_by_emp` / `revoked_at`、`request_id`。`editors`(NVARCHAR(1000),逗號分隔工號):上次發佈以來改過安裝參數 / 偵測規則 / 重開機政策的人;已發佈後再修改會重設為此人(D2-2)。`revoked_from`(VARCHAR(16)):撤回前的狀態,只有從 `published` 撤回的套件可對所有電腦派送移除,未曾發佈就撤回的只限 pilot(資安稽核 C1)。**兩人覆核**:發佈人不可是 `created_by_emp`、也不可在 `editors` 內;發佈的 UPDATE 條件同此,另有 CHECK `ck_software_package_reviewer`(`published_by_emp IS NULL OR (published_by_emp <> created_by_emp AND CHARINDEX(',' + published_by_emp + ',', ',' + ISNULL(editors, '') + ',') = 0)`)。
- `timeout_sec`(INT,0009,P7 VM 驗收 B-1):Agent 執行安裝 / 移除程式的逾時(秒),`NOT NULL DEFAULT 1800`、CHECK `ck_software_package_timeout`(300–7200);既有套件以預設值補 1800。快照 `software.install` / `software.uninstall` 的 `timeout_sec` 取此值,主機的指令逾時依此加寬(`commandTimeoutSec`)。修改不退回 `draft`。**部署順序:先套用 0009,再部署新版 endpoint-server**。
- 指令與套件的關聯:`ita.command.params` 的目錄快照含 `"package_id":"<uuid>"`(SQL 2012 無 JSON 函式,以 `LIKE` 比對;快照由主機產生,格式固定)。下載授權查這台 `software.install` 且 `state IN ('sent','acked','running')` 的 `params`。
- **部署順序:先套用 0008,再部署新版 endpoint-server**:新版的指令查詢都會讀 `command_batch.state`(未套用時所有指令 API 失敗);`SOFTWARE_DIR` 未設定時軟體 API 與套件下載不註冊。

### `ita.software_upload` — 軟體套件上傳與送簽(0011,S1-3;`docs/S1-SIGNING-DESIGN.md` §4)

- `upload_id`(對外)、`file_name`(`{軟體}/{版本}/{檔名}`,規則同軟體庫:`incoming\` 的原始檔與簽章後軟體庫的目標位置是同一路徑)、`sha256` / `size_bytes`(上傳或登錄時由主機讀檔計算;核可時再算一次)、`source`(`upload` = API 串流上傳、`incoming` = 網路芳鄰放進 `incoming\` 後登錄)。
- `state`:`uploaded` →(第二人核可,寫送簽工作單)`queued` →(工作站結果、主機以軟體庫實際檔案重算相符)`signed`;`uploaded` / `queued` 可駁回;工作站拒絕、核可時檔案被換掉(`INCOMING_CHANGED`)、結果不符(`RESULT_MISMATCH`)為 `rejected`(`rejected_by_emp` 為 NULL)。一律條件更新。
- 同一路徑同時只能有一筆進行中:篩選唯一索引 `ux_software_upload_file_active (file_name) WHERE state IN ('uploaded', 'queued')`。
- **兩人**:核可人不可是上傳者,程式、UPDATE 條件、CHECK `ck_software_upload_approver` 三道。
- 工作站回報欄位(`vendor_signer`、`vendor_signer_subject`、`vendor_check`、`signed_signer`、`sign_operator`)只供覆核顯示,不作為安全判斷;`signed_sha256` 為主機重算值。
- **部署順序:先套用 0011,再設定 `INCOMING_DIR` / `SIGN_QUEUE_DIR`**;未設定時上傳 API 不註冊、不讀寫此表。

### 離線補傳比對(`DeviceService.sync`,`POST /agent/v1/sync`)

與目前資料同 `content_hash`、或 Mongo 已有同 `agent_seq` 的列入 `skip`(Agent 直接刪除);其餘同 hash 只取最新一份,依 `collected_at` 由舊到新列入 `need`,單次最多 20 筆;Agent 逐筆 `POST /agent/v1/inventory`,較舊的只進 Mongo 歷史(`archived`)。Mongo 無法使用時不去重。

### 寫入順序(`DeviceService.ingestInventory`)

1. 比對 `content_hash`:Redis → SQL;相同 → 只更新 `last_seen_at`、`last_inventory_at`(`unchanged`)。
2. `collected_at` 比目前資料舊(補傳)→ 只進 Mongo 歷史(`archived`)。
3. 否則在**一個交易**寫 `device_inventory`(upsert)、`device_nic`、`device_software`(替換)、`device`(名稱、版本、時間);P5 起同一交易先以 `UPDLOCK` 讀出舊 `payload` 比對,軟硬體變更事件一併寫入 `device_event` → 成功後寫 Mongo 快照 → 更新 Redis hash(`stored`)→ 硬體變更交給告警(失敗只記 warn)。
4. SQL 失敗回 503 `ITA_STORAGE_UNAVAILABLE`,不寫 Mongo / Redis;Mongo / Redis 失敗只記 warn。

### 所屬公司(0005,E6;`docs/E6-COMPANY-SCOPE-DESIGN.md`)

- **自動判定**(`ENDPOINT_COMPANY_DOMAINS` 網域 → 公司,最長尾碼優先):新裝置登錄時看憑證 CN(FQDN 才比對)→ `cert`;收到資產時若來源為未判定或 `domain`,依 `part_of_domain` 為真的回報網域重算(判不出改回 NULL)。服務啟動時對 `company_source IS NULL` 的裝置回填一次(`DeviceService.backfillCompany`)。
- `SqlDeviceStore.setCompany`:`auto` 只在 `company_source IS NULL OR = 'domain'` 時更新(不覆寫並行寫入的 `manual`),`manual` 一律更新;已合併的裝置不更新。
- **維運**:修改 `ENDPOINT_COMPANY_DOMAINS` 後,來源為 `domain` 的既有裝置要等下次資產內容變動才重算(回填只處理未判定的)。Gateway 公司改名時以 SQL 一併更新 `ita.device.company`。
- **部署順序:先套用 0005,再部署新版 endpoint-server**(新版查詢會讀這兩個欄位)。

### 合併疑似同一台(`SqlDeviceStore.merge`,P3、PLATFORM-PLAN A1)

一個交易,先以 `UPDLOCK, HOLDLOCK` 鎖定兩列 `ita.device` 再檢查(目標 / 來源未合併過、目標未退役、來源為 active):

1. 資產取 `collected_at` 較新的一份:刪除另一份的 `device_inventory` / `device_nic` / `device_software`,來源的改掛到目標。
2. `device_event` 改掛到目標;兩台尚未結束(queued / sent / acked / running)的 `ita.command` 一律 `canceled`(`error_code = DEVICE_MERGED`),再把來源的指令改掛到目標。
3. 來源 `cert_dn` 改為 `merged:<來源 device_id>`(釋放唯一鍵)、`status = retired`、`merged_into`、`retired_at`;目標改用來源的 `cert_dn` / `cert_fp` / 電腦名稱 / Agent 版本 / 硬體指紋 / 時鐘偏差,`first_seen_at` 取較早、`last_seen_at` 取較晚,**狀態不變**。
4. 目標寫一筆 `merged` 事件。
5. 所屬公司(0005):目標不變;目標未指定時取來源的 `company` / `company_source`。

交易後(失敗只記 warn):關閉兩台的 WebSocket(Agent 重連時以 DN 對到目標)、Mongo `snapshots` / `heartbeats` 的 `device_id` 改為目標、清除 Redis 兩台的 hash 與來源的 online 鍵。

## 2. MongoDB 7(資料庫 `ita_{env}`)

| 集合 | 內容 | 索引 |
| --- | --- | --- |
| `snapshots` | 每份被接受的快照(含補傳的舊快照):`device_id`、`agent_seq`、`content_hash`、`collected_at`、`received_at`、`inventory` | `(device_id, agent_seq, content_hash)` 唯一(重複補傳不重複);`received_at` TTL `SNAPSHOT_RETENTION_DAYS`(預設 90 天) |
| `heartbeats` | 心跳:`device_id`、`at`、`body`(P5 起含 `health`,健康走勢 API 依 5 分鐘分桶) | `at` TTL 1 天;`(device_id, at)` |

## 3. Redis 7(前綴 `ita:{env}:`)

| Key | 內容 | TTL |
| --- | --- | --- |
| `ita:{env}:online:{deviceId}` | 在線資訊 JSON(`connectedAt`、`lastHeartbeatAt`、`agentVersion`;P5 起加最近一則心跳的 `health`) | 90 秒(3 個心跳間隔),每次心跳續期;WebSocket 關閉即刪除 |
| `ita:{env}:hash:{deviceId}` | 目前資料的 `content_hash` | 7 天 |

Redis 無法使用時,在線狀態退回本實例的 WebSocket 連線表,hash 比對退回 SQL。
