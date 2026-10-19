# P5 監測設計

> 草案 2026-10-19,分支 `docs/p5-monitor-design`(從 `docs/handoff-p5` ab6ee85 開)。依據:PLATFORM-PLAN §4.3、§4.10 A5、§5、§6、§8 P5 列;指南 ENDPOINT-AGENT-GUIDE §5.3、§6.3–§6.5、§7。
> **2026-10-19 需求方確認**:§9 全部照建議(關閉告警沿用 `endpoint.command.basic`、Watchdog 遇手動停止與改啟動類型會恢復、`watchdog.db` 不加密、告警存表與 §4 門檻、版本不符延到 P6、版本號 0.5.0 / 0.6.0 / Watchdog 0.1.0)。migration 0006 寫好後先給需求方看再套用。
> 現況(HANDOFF §2 第 0 項):沒有 `watchdog` crate;心跳沒有 `health`;Server 不比對前後兩份資產;GigaItApp 沒有告警畫面。USB 插拔、`offline_period`、`clock_skew`、`agent_started` 事件 P2 已完成。

## 0. 分批

| 批 | 內容 | 版本 | 需要同意 |
| --- | --- | --- | --- |
| **P5-1 健康、變更事件、告警(後端為主)** | migration `0006_monitor.sql`;契約:`heartbeat.body.health`、`hello.cert_not_after`、`AgentSettings.health_enabled`、新事件類型;Server:健康寫入、**資產前後比對**產生軟硬體變更事件、告警規則與 `/v1/alerts`、健康走勢 API;Agent:心跳附健康摘要、`agent_started` 帶上次結束原因、hello 帶憑證到期日 | Agent **0.5.0** | migration 套用 `giganexus_It_Agent_test`;合併 develop |
| **P5-2 Watchdog 與互相看守(A5)** | 新 crate `watchdog`(`GigaNexusWatchdog` 服務);Agent 本機管道伺服端 `get_status`;`POST /agent/v1/watchdog/report`;Agent 看守 Watchdog;服務 ACL;**監控 MSI 加第二個服務**;Watchdog 相關告警規則 | Agent **0.6.0**、Watchdog **0.1.0** | MSI 加服務;VM 安裝測試 |
| **P5-3 GigaItApp 畫面** | 清單健康欄與告警數、詳情「健康與 Agent」Tab、事件 Tab 新類型標籤、「告警」Tab;`gateway-rbac.yaml` | — | **GigaItApp、`gateway-rbac.yaml`:動手前另外確認**(OpenAPI 註冊後才綁 `includes`) |
| P5-4 收尾 | 指南回寫(§6.3、§7.2、§7.3、§8.3)、根目錄 `workspace.json`(watchdog `planned` → `active`)、`PROJECT-MAP.md`、甘特圖 W6-18、測試報告 | — | Gateway / 根目錄 repo 修改前確認 |

P5-1 與 P5-2 互不依賴程式碼(只共用 migration 0006,一次建好),P5-1 先做:不用改 MSI 就能在測試區驗證「移除軟體 → 變更事件」「磁碟告警」。P5-3 可在 P5-1 的 API 上線後就開始,Watchdog 欄位等 P5-2。

**完成標準對應**(PLATFORM-PLAN §8 P5):

| 完成標準 | 由哪一批達成 | 驗證方式 |
| --- | --- | --- |
| 結束 Agent 行程 → Watchdog 重啟並上報 | P5-2 | 工作管理員結束 `rustit-agent.exe`:SCM 失敗復原 10 秒內先重啟(P1 既有);Watchdog 偵測 PID 變更 → `agent_restarted`(cause `crashed`)立即上報。另測「失敗復原被改成無動作」時由 Watchdog 在寬限 90 秒後重啟(§5.3) |
| 以管理員手動停止 Agent 服務 → 產生事件與告警 | P5-2 | `Stop-Service GigaNexusAgent` → Watchdog `agent_service_stopped` → 告警 `agent_tampered`;Watchdog 重新啟動 Agent,Agent `agent_started.previous_exit = stop`;告警在 IT 確認後關閉 |
| 插 USB 隨身碟 → 事件出現 | P2 已完成 | 自己的電腦前景模式(VM 無 USB 直通,HANDOFF P2-3) |
| 移除一個軟體 → 下次蒐集產生變更事件 | P5-1 | VM 移除一個小軟體 → 下 `inventory.collect` → `software_removed` 事件 |

## 1. 資料表(`0006_monitor.sql`,SQL Server 2012)

> PLATFORM-PLAN §5.2 原訂 `0004_health.sql`;0004、0005 已用於 P3 軟體清單與 E6 公司,本階段為 **0006**(§5.2 一併更正)。`ita.device_event` 不改結構(`event_type` VARCHAR(32) 本來就不限值)。

### `ita.device_health` — 最近健康與 Watchdog 狀態(1:1)

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `device_ref` | INT PK FK | |
| `health_at` | DATETIME2(3) NULL | 最近一次寫入的健康摘要時間(心跳每 5 分鐘落盤一次,與 `last_seen_at` 同節奏) |
| `cpu_pct` / `mem_used_pct` / `disk_min_free_pct` | TINYINT NULL | 0–100 |
| `disk_min_free_drive` | VARCHAR(8) NULL | 最滿的固定磁碟代號(例 `C:`) |
| `uptime_s` / `agent_rss_mb` | INT NULL | |
| `cert_not_after` | DATETIME2(3) NULL | 裝置憑證到期日(hello 或 Watchdog 回報,取最新) |
| `watchdog_version` / `watchdog_report_at` | VARCHAR(32) / DATETIME2(3) NULL | P5-2 |
| `agent_service_state` / `agent_start_type` | VARCHAR(16) NULL | Watchdog 看到的 Agent 服務狀態(`running` / `stopped` / `start_pending` / …)與啟動類型(`auto` / `manual` / `disabled` / `missing`) |
| `agent_status_ok` / `agent_last_error` | BIT / NVARCHAR(300) NULL | 最近一次 `get_status` 是否正常、Agent 回報的最近錯誤 |
| `agent_restarts_24h` | INT NULL | Watchdog 統計的 24 小時內非正常重啟次數 |
| `updated_at` | DATETIME2(3) | |

**為什麼最近健康要進 SQL**:Redis 只保留 90 秒、Mongo 1 天;離線電腦在清單上仍要顯示最後一次健康,告警規則(磁碟)也要以唯一真相判斷(`AGENT.md` §7.2)。每 5 分鐘一次寫入,200 台 ≈ 每秒 0.7 筆,與既有心跳 `touch` 合併成同一次更新。

### `ita.device_alert` — 告警

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `id` | BIGINT IDENTITY PK | |
| `alert_id` | UNIQUEIDENTIFIER UQ | 對外 `alertId` |
| `device_ref` | INT FK | |
| `rule` | VARCHAR(32) | §4 規則代碼 |
| `severity` | VARCHAR(8) | CHECK `warn` / `critical` |
| `state` | VARCHAR(16) | CHECK `open` / `resolved` |
| `opened_at` / `last_seen_at` / `resolved_at` | DATETIME2(3) | `last_seen_at`:條件仍成立的最近一次評估 |
| `resolved_by` | VARCHAR(8) NULL | `auto`(條件消失)/ `manual`(IT 確認) |
| `resolved_by_emp` / `resolved_by_name` / `resolve_note` | NVARCHAR(64) / NVARCHAR(100) / NVARCHAR(500) NULL | 手動關閉的稽核(內部 Token 的 `emp`、`name`) |
| `detail` | NVARCHAR(2000) | JSON:規則的數值與依據(例 `{"disk":"C:","free_pct":6}`、硬體變更前後) |
| `event_ref` | BIGINT NULL FK `device_event` | 觸發的事件(變更、竄改類) |
| `request_id` | VARCHAR(64) NULL | 手動關閉的 X-Request-Id |

索引:**篩選唯一** `(device_ref, rule) WHERE state = 'open'`(同一台同一規則只有一筆未結束;條件持續成立只更新 `last_seen_at` / `detail`)、`(state, opened_at)`(告警頁)、`(device_ref, opened_at)`(詳情)。

**為什麼存表而不是查詢時計算**(PLATFORM-PLAN §5.1 原寫「由事件與規則計算」):硬體變更、竄改這類告警沒有「自動消失」的條件,需要有人確認並留稽核;之後逐人寄信(Q5)也需要「新開的告警」才不會重複通知。保存期限 1 年(B5,與事件相同,清除工作在上線前與其他保存期限一起做)。

## 2. 契約變更(只新增欄位,舊版 Agent 照常運作)

### 2.1 `ws-envelope.schema.json`

| 位置 | 新增 | 說明 |
| --- | --- | --- |
| `HeartbeatBody.health`(選填) | `cpu_pct`、`mem_used_pct`、`disk_min_free_pct`(整數 0–100)、`disk_min_free_drive`、`uptime_s`、`agent_rss_mb` | PLATFORM-PLAN §4.3;每則心跳都帶,欄位取不到就省略(不送 0) |
| `HelloBody.cert_not_after`(選填) | date-time | 裝置憑證到期日;Agent 啟動與每次重連時讀(`rustit_common::tls::device_cert_not_after`,`agent.diagnose` 已在用),Watchdog 沒裝也能判斷憑證告警 |
| `AgentSettings.health_enabled`(選填) | boolean,預設 true | 主機下發開關(PLATFORM-PLAN §4.2 第二層);false 時心跳不帶 `health` |

### 2.2 `event.schema.json`(新類型與 `data`)

| type | 來源 | data |
| --- | --- | --- |
| `agent_started`(既有,補欄位) | Agent | 加 `previous_exit`:`stop`(服務被停止)/ `shutdown`(Windows 關機)/ `restart_command`(`agent.restart`)/ `unexpected`(上次沒有正常結束:被結束行程、當掉、被 Watchdog 強制重啟)/ `first_run`;加 `boot_time` |
| `watchdog_stopped` | Agent(P5-2) | `state`(看到的狀態)、`restarted`(是否已由 Agent 重新啟動)、`error` |
| `watchdog_missing` | Agent(P5-2) | Watchdog 服務不存在(舊 MSI 或被刪除);同一次執行只記一次 |
| `agent_restarted` | Watchdog | `cause`:`crashed`(行程消失、SCM 自動重啟)/ `hung`(`get_status` 連續 3 次失敗,Watchdog 強制重啟)/ `restart_command`;`previous_pid`、`pid` |
| `agent_service_stopped` | Watchdog | 服務被停止且不是關機、不是 `agent.restart`(結束代碼 0);`restarted`、`error` |
| `agent_start_type_changed` | Watchdog | `from`、`to`、`restored`(是否已改回自動) |
| `agent_binary_missing` | Watchdog | `path`;服務設定指向的 exe 不存在 |
| `agent_start_failed` | Watchdog | Watchdog 嘗試啟動 Agent 失敗:`error`(Win32 代碼與訊息)、`attempts` |

主機產生(`event_uid` 為 NULL,`occurred_at` = 新資產的 `collected_at`,§3.2):

| type | data |
| --- | --- |
| `software_installed` / `software_removed` | `name`、`version`、`publisher` |
| `software_updated` | `name`、`publisher`、`from`、`to` |
| `software_changed_bulk` | 一份資產變更超過 50 項時改記一筆:`installed`、`removed`、`updated` 筆數與前 20 個名稱(例如重灌、大量更新) |
| `hardware_changed` | `component`(`memory` / `disk` / `gpu` / `bios` / `board` / `cpu`)、`before`、`after`(序號、型號、容量) |

### 2.3 `watchdog.schema.json`(新,P5-2)

`POST /agent/v1/watchdog/report`(`:9443` → `:51241`,同一張裝置憑證,指南 §7.3)。每 5 分鐘一次,**狀態改變或有新事件時立即送**。

| 請求欄位 | 說明 |
| --- | --- |
| `watchdog_version`、`reported_at` | |
| `agent` | `service_state`、`start_type`、`pid`、`exe_present`;最近一次 `get_status`:`status_ok`、`status_at`、`version`、`ws_connected`、`last_heartbeat_ack`、`last_error` |
| `agent_restarts_24h` | 非正常重啟次數(`crashed` + `hung`) |
| `cert_not_after` | |
| `events[]` | 0–50 筆,格式同 `event.schema.json` 的 `Event`(上表 Watchdog 來源的類型);Watchdog 先寫本機再送,主機回 `accepted` 才刪 |

| 回應欄位 | 說明 |
| --- | --- |
| `server_time`、`accepted[]`(event_id) | |
| `report_interval_sec` | 預設 300(主機可調) |
| `target` | P5 一律 `null`;P6 放目標版本、下載路徑、SHA-256(指南 §7.4)。**P5 先定義欄位,Watchdog 0.1.0 忽略** |

主機只讓這條路徑更新 `device_health` 的 Watchdog 欄位與寫 Watchdog 事件(指南 §7.3「不要因為 DN 相同就開放所有功能」)。停用 / 退役的裝置回 403(與 Agent 相同,Watchdog 依 close / 403 規則每 1 / 10 分鐘重試)。

### 2.4 `pipe.schema.json`(新,P5-2)

本機管道 `\\.\pipe\giganexus-agent-v1`(指南 §7.2),每則一行 JSON、共用信封。

| type | 方向 | body |
| --- | --- | --- |
| `get_status` | Watchdog → Agent | 無 |
| `status` | Agent → Watchdog | 指南 §7.2 草案欄位(`version`、`started_at`、`ws_connected`、`last_heartbeat_ack`、`last_error`、`cert_not_after`)+ `pid`、`device_status`(active / disabled / retired)、`outbox_pending`、`events_pending` |
| `prepare_shutdown` / `prepare_shutdown_ack` | Watchdog → Agent | **只定義,P6 升級時實作**;P5 收到回 `unsupported` |

## 3. ItAgentBack

### 3.1 模組

| 檔案 | 內容 |
| --- | --- |
| `src/services/health-service.ts`(新) | 心跳健康:Redis `ita:{env}:health:{deviceId}`(TTL 90 秒)、每 5 分鐘寫 `device_health`(與 `touch` 同節奏);Watchdog 回報寫入;走勢查詢(Mongo `heartbeats`,依 5 分鐘分桶取平均 / 最大) |
| `src/services/change-detector.ts`(新,純函式) | 前後兩份 `ComputerInfo` → 變更清單(§3.2);不碰儲存,單元測試直接餵範例 JSON |
| `src/services/alert-service.ts`(新) | 規則評估(§4):事件觸發 + 每 5 分鐘掃描;開 / 更新 / 自動關閉;手動關閉 |
| `src/routes/alerts.ts`(新) | 管理 API(§3.3) |
| `src/stores/sql-monitor-store.ts`(新) | `device_health`、`device_alert` |
| `device-service.ts`(改) | `heartbeat` 交給 health-service;`ingestInventory` 在交易內讀舊 payload → 比對 → 變更事件與資產同一交易寫入;`hello` 存 `cert_not_after` |
| `agent-app.ts`(改) | `POST /agent/v1/watchdog/report`(P5-2) |

PLATFORM-PLAN §5.1 原訂 `event-service.ts` 一個檔案,拆成比對(純函式)與告警兩個,職責較清楚。

### 3.2 資產前後比對(PLATFORM-PLAN §4.3:由 Server 比對,Agent 不記上一份)

- **何時比**:`ingestInventory` 的 `stored` 分支(內容變了且比目前的新)。`unchanged`、`archived`(補傳的舊快照)不比;第一份資產(沒有上一份)不比;合併後第一份不比(兩台的軟體不同會誤報)。
- **在同一個交易**:讀舊 `payload` → 寫新資產 → 寫變更事件;交易失敗整批 503(Agent 重送時重新比對,不會漏也不會重複)。
- **軟體**:以 `name` 為鍵,同名多版本以版本集合比較 → `software_installed` / `software_removed` / `software_updated`;一份超過 50 項改記一筆 `software_changed_bulk`。
- **硬體**:`memory_modules`、`physical_disks` 以序號比對(序號空白的項目以「型號 + 容量」比對,VM 常見);`gpus` 以名稱 + PNP 裝置 ID;`bios_serial`、`system_uuid` → `bios` / `board`;CPU 名稱。每個元件一筆 `hardware_changed`。
- 只新增事件,不改既有資產寫入順序(DB_SCHEMA「寫入順序」第 3 步多一個動作)。

### 3.3 管理 API(`:51240`,對外 `/api/endpoint/*`)

| 方法 | 路徑 | `x-permission` | 說明 |
| --- | --- | --- | --- |
| GET | `/v1/alerts` | `endpoint.device.read` | 篩選 `state`(預設 open)、`rule`、`severity`、`deviceId`;`limit` ≤ 100、`before` 游標;依資料範圍(E6 `cos`)過濾 |
| POST | `/v1/alerts/{alertId}/resolve` | **待決 §9-2** | `{ note }`(1–500 字);只能關 `open` 的;`x-audit-level: meta`;自動類規則條件仍成立時,下次評估會再開一筆新的 |
| GET | `/v1/devices/{deviceId}/health` | `endpoint.device.read` | `hours` 1–24(預設 24),5 分鐘分桶;Mongo 不可用回 503 |
| GET | `/v1/devices`(改) | 同既有 | 每台加 `health`(在線取 Redis、否則 SQL 最後一次,附 `at`)、`openAlerts`(未結束告警數) |
| GET | `/v1/devices/{deviceId}`(改) | 同既有 | 加 `health`、`watchdog`(版本、最後回報、Agent 服務狀態、啟動類型、24 小時重啟次數)、`certNotAfter`、`openAlerts[]` |

錯誤:`404 ITA_ALERT_NOT_FOUND`、`409 ITA_ALERT_NOT_OPEN`。

## 4. 告警規則(固定,不做規則引擎;門檻以 `ita.env` 設定)

| 規則 `rule` | 條件 | 嚴重度 | 自動關閉 | 評估時機 | 預設門檻(環境變數) |
| --- | --- | --- | --- | --- | --- |
| `offline_long` | active 裝置 `last_seen_at` 超過 N 天 | warn | 重新連線 | 每 5 分鐘 | 7 天(`ALERT_OFFLINE_DAYS`) |
| `disk_low` | `disk_min_free_pct` < 10 | warn(< 5 為 critical) | ≥ 15(緩衝,避免在門檻上下反覆開關) | 健康落盤時 | 10 / 15(`ALERT_DISK_FREE_PCT`、`ALERT_DISK_CLEAR_PCT`) |
| `hardware_changed` | 收到 `hardware_changed` 事件 | critical | **否,IT 確認** | 事件寫入時 | — |
| `agent_restarts` | 24 小時內非正常重啟 ≥ 3:`agent_started.previous_exit = unexpected` 的筆數,有 Watchdog 時取兩者較大的 `agent_restarts_24h` | warn | 24 小時視窗內降到 3 以下 | 事件寫入時 + 每 5 分鐘 | 3(`ALERT_RESTARTS_24H`) |
| `cert_expiring` | `cert_not_after` 在 30 天內(已過期為 critical) | warn | 換新憑證後到期日超過門檻 | hello、Watchdog 回報、每日一次 | 30 天(`ALERT_CERT_DAYS`) |
| `clock_skew` | `clock_skew_ms` 絕對值 > 5 分鐘(A2;P2 只記事件) | warn | 偏差恢復正常 | hello | 沿用 P2 的 5 分鐘 |
| `agent_tampered`(P5-2) | Watchdog 事件 `agent_service_stopped`、`agent_start_type_changed`、`agent_binary_missing`,或 Agent 事件 `watchdog_stopped` / `watchdog_missing` | critical | **否,IT 確認**(有人動了服務,要有人看過) | 事件寫入時 | — |
| `agent_silent`(P5-2,A5 主機端) | Watchdog 15 分鐘內有回報,但 Agent 心跳超過 15 分鐘沒有(電腦開著、Agent 不工作) | critical | Agent 心跳恢復 | 每 5 分鐘 | 15 分鐘(`ALERT_SILENT_MIN`) |

- **「Watchdog 回報版本不符」延到 P6**:P5 還沒有目標版本(`ita.agent_release` / 發佈環在 P6),沒有「應該是哪一版」可比。P6 加規則 `version_mismatch`(Agent / Watchdog 版本 ≠ 所屬環目標版本超過 1 小時,或升級失敗)。
- A5「應在線卻超過 N 小時無心跳也無 Watchdog 回報」:電腦關機與 Agent + Watchdog 一起被停,主機分不出來;前者交給 `offline_long`,能分辨的情況(電腦開著、Agent 不工作)是 `agent_silent`。兩個服務都被停用時,停用當下的 `agent_tampered` 已經先開了告警。
- 停用 / 退役 / 已合併的裝置不評估,既有未結束告警在停用、退役時自動關閉(`resolved_by = auto`,`detail` 註明原因)。
- 本階段**只在 GigaItApp 顯示**;逐人寄信給 IT 值班人員是之後的事(PLATFORM-PLAN Q5、NOTIFY-PLAN)。
- 單一實例評估(與指令派送器相同);多實例另議。

## 5. Agent(`rustit-agent`)

### 5.1 P5-1(0.5.0)

- **健康摘要**:`rustit-collector` 新增 `health` 模組(只蒐集、不連網,符合 collector 職責;**不改既有結構體**):`HealthSampler` 保留一個 `sysinfo::System`,每次心跳前更新 CPU、記憶體、固定磁碟(排除可移除磁碟)、開機時間與本行程 RSS。CPU 使用率需要兩次取樣的差值,第一則心跳不帶 `cpu_pct`。
- 心跳迴圈(`ws.rs`)依 `health_enabled` 決定是否附 `health`;取樣失敗只省略欄位、記 debug。
- **上次結束原因**:正常收尾時在本機 kv 寫 `last_exit`(`stop` / `shutdown` / `restart_command`),啟動時讀出放進 `agent_started.previous_exit` 再清除;讀不到即 `unexpected`(被結束行程、當掉、斷電)。服務控制處理常式已經分 Stop / Shutdown(`service.rs`),只要把原因傳下去。
- hello 帶 `cert_not_after`(讀不到就省略;PEM 與 Windows 存放區都支援)。

### 5.2 P5-2(0.6.0)

- **本機管道伺服端**(`pipe.rs`):`tokio::net::windows::named_pipe::ServerOptions`,安全性描述元 `D:P(A;;GA;;;SY)(A;;GA;;;BA)`(指南 §7.2),`first_pipe_instance(true)`(防止別的行程先建立同名管道);只處理 `get_status`,每則請求 1 KB 上限、5 秒逾時,同時最多 4 個連線。回應的資料由 `Shared` 讀(不另存一份狀態)。
- **看守 Watchdog**(`guard.rs`):每 60 秒查 `GigaNexusWatchdog`:停止 → 啟動並記 `watchdog_stopped`;不存在 → 記一次 `watchdog_missing`(相容 0.4.x MSI 升級前的電腦,只記不擋);Windows 關機中(收到 Shutdown)不動作。
- **服務 ACL**(A5):服務啟動時與失敗復原一起套用,一般使用者(IU、SU、AU)只有查詢權限,停止 / 啟動 / 變更設定只有 SYSTEM、Administrators;Windows 預設已大致如此,明確設定是為了防止被改寬。
- 前景模式(`run`)不啟動管道與看守(沒有服務可看守,開發用)。

## 6. Watchdog(新 crate `RustAgent/crates/watchdog`,`rustit-watchdog` 0.1.0)

### 6.1 結構

| 模組 | 內容 |
| --- | --- |
| `main.rs` | 只組裝:`service`(SCM)、`run --config`(前景,開發用) |
| `service.rs` | `GigaNexusWatchdog`,LocalSystem、自動啟動、失敗復原 10 / 30 / 60 秒(與 Agent 相同,啟動時自行套用);日誌 `logs\watchdog-YYYY-MM-DD.log` |
| `scm.rs` | 查 `GigaNexusAgent` 狀態、PID、啟動類型、結束代碼、exe 路徑;啟動 / 停止 / 改回自動(`windows-service` crate,與 Agent 相同) |
| `pipe.rs` | `get_status` 用戶端;連線後 `GetNamedPipeServerProcessId` 與 SCM 的 Agent PID 比對,不一致即中斷並記錄(指南 §7.2 防冒充) |
| `monitor.rs` | 每 30 秒的看守狀態機(§6.2),核心邏輯以 trait 注入 SCM / 管道,單元測試用假實作 |
| `report.rs` | `POST /agent/v1/watchdog/report`;每 5 分鐘 + 狀態變更 / 新事件立即送;退避、429、403 規則與 Agent 相同 |
| `outbox.rs` | 本機紀錄 `state\watchdog.db`(SQLite):待送事件(上限 1,000 筆,丟最舊)、24 小時重啟紀錄、最後狀態。**不加密**(§9-4) |

共用 `rustit-common`:`agent.toml`(同一份安裝設定,不新增段落)、憑證與 `Transport`、退避、停止訊號、檔案日誌、路徑。**不依賴 `rustit-agent` 與 `rustit-collector`**。新增相依只有 `rusqlite`(workspace 已有,同版本)。

### 6.2 看守規則(指南 §7.1)

| 看到的情況 | 判斷 | 動作 | 事件 |
| --- | --- | --- | --- |
| 執行中、`get_status` 正常 | 正常 | 記錄狀態 | — |
| 執行中、PID 和上次不同 | 重啟過 | — | `agent_restarted`(`crashed`,或上次停止代碼為 3 時 `restart_command`) |
| 執行中、`get_status` 連續 3 次失敗(90 秒) | 卡住 | 停止服務(等 30 秒)→ 逾時則結束行程 → 啟動 | `agent_restarted`(`hung`) |
| 已停止、結束代碼非 0(當掉、`agent.restart` 的 3) | SCM 失敗復原中 | 等 90 秒寬限(大於失敗復原最長的 60 秒),仍停止才自己啟動 | 啟動失敗記 `agent_start_failed` |
| 已停止、結束代碼 0、Windows 不在關機中 | **有人手動停止** | 立即啟動(§9-3) | `agent_service_stopped` |
| 啟動類型不是自動 | 被改設定 | 改回自動(§9-3) | `agent_start_type_changed` |
| 服務不存在或 exe 不存在 | 被移除 / 損壞 | 只記錄、每小時重查(Watchdog 不能自己重裝) | `agent_binary_missing` |

- 啟動失敗退避:1、2、5、10 分鐘,之後每 10 分鐘;不無限快速重試。
- **Windows 關機**:Watchdog 收到 Shutdown 就停止看守,不會把關機當成手動停止。
- **P6 升級時**由 Watchdog 自己停止 Agent,屆時加「維護中」狀態避免誤判;P5 不需要。
- **IT 要停 Agent 做排查**:先把 Watchdog 啟動類型設為停用並停止(只停止的話,Agent 會在 60 秒內把它啟動),再停 Agent;過程會產生 `agent_tampered` 告警,排查完恢復設定、由 IT 關閉告警。寫進 RUNBOOK(B10)。

### 6.3 MSI(P5-2)

- `agent.wxs` 加 `rustit-watchdog.exe` 與第二組 `ServiceInstall` / `ServiceControl`(`GigaNexusWatchdog`,參數 `service --config "[DATADIR]agent.toml"`);`build-agent-msi.ps1` 一起建置。WiX 仍是 **v5**。
- 從 0.4.2 / 0.5.0 MSI 升級:既有 `MajorUpgrade` 處理,兩個服務一起安裝。解除安裝兩個服務一起移除,`ProgramData` 保留(與 P1 相同)。
- 產品名稱不變(GigaNexus Agent);MSI 版本號跟 Agent(0.6.0)。

## 7. GigaItApp(P5-3,動手前另外確認)

| 位置 | 內容 | API 權限 |
| --- | --- | --- |
| 電腦清單 | 加「健康」欄(CPU / 記憶體 / 磁碟最低剩餘,超過門檻標色)、「告警」數字徽章;篩選「有未結束告警」 | `endpoint.device.read` |
| 電腦詳情 新 Tab「健康與 Agent」 | 目前值、24 小時走勢(簡單 SVG 折線,不加圖表套件)、Agent 版本 / 上次啟動原因、Watchdog 狀態、24 小時重啟次數、憑證到期日、此台告警(可關閉) | read;關閉見 §9-2 |
| 電腦詳情「事件」Tab | 新事件類型的中文標籤與 `data` 摘要(只以文字顯示,不用 `v-html`) | read |
| 新 Tab「告警」(`it.endpoint-alert.list`,在「電腦清單」選單下,與「指令紀錄」同層) | 未結束 / 已關閉、規則、嚴重度篩選;點電腦名稱進詳情;關閉按鈕 `it.endpoint-alert.resolve` | read;按鈕綁 §9-2 |

`gateway-rbac.yaml` 在 ItAgentBack OpenAPI 註冊、批次發佈後才加 `includes`(INTEGRATION-PLAN D9)。

## 8. 測試與驗證

- **ItAgentBack**:契約測試(新範例 `ws-heartbeat-health`、`ws-hello` 加欄位、`event` 新類型、`watchdog-report` 請求 / 回應);`change-detector` 單元測試(安裝 / 移除 / 更新 / 同名多版本 / 超過 50 項 / 硬體序號空白 / 第一份不比);`alert-service`(開、重複只更新、緩衝關閉、手動關閉、停用時關閉、24 小時視窗);管理 API;`test:int` 的 SQL store(`giganexus_It_Agent_poc_test`)。
- **Agent / Watchdog**:契約測試;`HealthSampler`(數值範圍、第一次無 CPU);`last_exit` 讀寫;Watchdog `monitor` 狀態機以假 SCM / 假管道測試(手動停止、當掉寬限、卡住 3 次、啟動類型、關機中不動作、啟動失敗退避)。
- **測試區 VM**(`RUSTIT-P34`;Claude 經 `ssh host2` 操作 Hyper-V,VM 內指令由需求方執行):P5-1 移除軟體 + `inventory.collect`;用大檔把 VM C: 塞到剩 < 10%(VM 本來就只剩 8%,可能一上線就出現 `disk_low`,正好驗證);P5-2 MSI 升級後完成標準兩項(結束行程、手動停止)+ 停用 Watchdog 啟動類型 + 刪除 exe(之後還原檢查點)。先建檢查點「P5 前(0.4.2)」。

## 9. 要你決定的事

1. **分批與順序**:P5-1(健康 / 變更 / 告警後端)→ P5-2(Watchdog + MSI)→ P5-3(GigaItApp)。是否同意?(建議:同意)
2. **關閉告警的權限**:沿用 `endpoint.command.basic`(IT 一般操作)/ 沿用 `endpoint.command.admin`(與停用、合併同級)/ 新增 `endpoint.alert.manage`(要改 Gateway 指南 §8.2 與 BFF)。(建議:沿用 `endpoint.command.basic`,不新增權限代碼)
3. **Watchdog 遇到手動停止與改啟動類型的處理**:立即重新啟動、改回自動,並記事件與告警 / 只記事件與告警,不動服務。(建議:重新啟動並改回;A5 寫「管理員仍可停,只能偵測」,但沒有規定偵測後不能恢復,恢復能避免誤操作讓電腦長期失聯;IT 排查時依 §6.2 先停 Watchdog)
4. **Watchdog 本機紀錄不加密**:`watchdog.db` 只有服務狀態、版本、事件(沒有資產與使用者資料),目錄 ACL 只允許 SYSTEM、Administrators;不加密就不必把 Agent 的加密 store 搬進 `rustit-common`。(建議:不加密;若要加密,P5-2 先做一個把 store 搬到 common 的重構)
5. **告警存表**(§1 `ita.device_alert`,而非查詢時計算)與預設門檻(§4 表):是否同意?特別是 `offline_long` 7 天、`agent_silent` 15 分鐘。
6. **「Watchdog 回報版本不符」延到 P6**(沒有目標版本可比)。(建議:同意)
7. **版本號**:Agent 0.5.0(P5-1)/ 0.6.0(P5-2)、Watchdog 從 0.1.0 獨立編號(P6 兩者分開升級)。(建議:同意)
8. migration 0006 寫好後,由你在開發機執行 `npm run db:migrate`,還是我執行?(P4 時由 Claude 經同意後套用)

PLATFORM-PLAN 要配合修正的地方(確認後與 P5-1 一起改):§5.1 `event-service.ts` 拆成 `change-detector` / `alert-service` / `health-service`;§5.2 `0004_health.sql` → `0006_monitor.sql`(加 `device_alert`);§4.3 告警規則註明版本不符在 P6。
