# 端點平台框架計畫(第二階段):常駐服務、本機持久化、監測、指令、升級、派送、使用者端程式

> 版本 v0.4(**2026-10-13 需求方定案**;根目錄文件、甘特圖 W6-13 ~ W6-24、Gateway 指南 v0.5 已同步)。前一份計畫 [INTEGRATION-PLAN.md](INTEGRATION-PLAN.md) 的基本階段(M0–M4)已完成,M5(離線暫存)擴充為本計畫 P2。
> v0.2:端點分「監控服務」與「使用者端程式」兩層、軟體庫 NAS、建置與簽章選項。v0.3:§11 待決事項全部決定;使用者端程式由 Demo 改造、移除 egui 原生版;新增本機設定與持久化(§4.2,含離線紀錄),階段重新排序。v0.4:基礎建設補強 A1–A8(§4.10)、上線前清單 B1–B10(§8)、路線圖補充(§9)。
> 上位規範:`../../giga-api-gateway-bff/docs/ENDPOINT-AGENT-GUIDE.md`(以下簡稱「指南」)§6–§8;本計畫與指南不一致之處列在 §10,**指南修訂前以指南為準**。
> 時程以 NexusPlan 甘特圖為準,本文件只列階段與完成標準。

## 1. 目標與原則

**目標**:把「Agent 前景執行、只回報資產」的基本階段,擴充成可以正式上線的端點平台框架:

1. **常駐**:Agent 以 Windows 服務執行,開機自動啟動、當掉自動復原,由 Watchdog 看守。
2. **不遺失**:連不上主機時,蒐集結果、事件、指令結果與連線狀況都記在本機,連回後補傳;設定在本機持久化,離線也能用最後一次的設定運作。
3. **監測**:IT 隨時看得到每台電腦是否在線、健康狀態(CPU / 記憶體 / 磁碟)、Agent 本身是否正常,以及硬體拆換、軟體增刪、USB 插拔等事件。
4. **指令**:IT 從 GigaItApp 對單台或多台電腦下達固定類型的指令,有完整狀態與稽核。
5. **升級**:Agent / Watchdog / 使用者端程式由後台指定目標版本,分批(發佈環)自動升級,失敗自動還原。
6. **派送**:IT 維護軟體目錄,對電腦勾選軟體後由 Agent 在背景靜默安裝 / 移除。
7. **畫面分流**:IT 要看的畫面在 **GigaItApp**;使用者要用的功能(我的電腦、公告、報修,之後 AI、BPM 查看、信箱等)由**使用者端程式**(托盤 + 視窗)提供。
8. **監控與使用者操作分開**:監控服務常駐背景,使用者關閉或結束使用者端程式都不影響監控與回報。

**原則**

| 原則 | 說明 |
| --- | --- |
| 兩層分開 | **監控層**(Agent + Watchdog,Windows 服務、SYSTEM、session 0、用**裝置憑證**經 `:9443`)與**使用者層**(使用者端程式,登入者身分、一般權限、用**使用者登入**經 `:443`)是不同程式、不同身分、不同通道,各自發版;兩層只經本機唯讀管道交換少量資料(§4.8) |
| 使用者層不承擔監控 | 使用者端程式沒在執行時,監控、回報、指令、派送照常運作;要提示使用者時,使用者端程式在就由它顯示,不在就退回 `WTSSendMessage` 系統訊息框 |
| 使用者功能以網頁為主 | 公告、報修、BPM、信箱、AI 都是 Gateway 後面的網頁應用,使用者端程式只做外殼(托盤、通知、視窗)並嵌入這些頁面;只有「我的電腦」等本機資訊用打包在程式內的頁面 |
| 先記本機,再送主機 | 會送到主機的資料(快照、事件、指令結果)先寫本機持久化,主機確認後才刪;連不上時不丟資料,也記下連不上的時間與原因(§4.2) |
| SQL Server 是唯一真相 | 主機端:指令、派送、版本、事件都先寫 SQL 再推送;Mongo / Redis 只放可重建的資料(`AGENT.md` §7.2)。本機持久化只是「尚未送達」的暫存與設定快取 |
| 先有通道再有功能 | 指令通道(P4)是升級、派送、重開機的共同基礎,先做好狀態機與稽核,功能只是新增指令類型 |
| 只開放固定指令類型 | 不提供任意 shell / PowerShell;新增類型時 Agent 與 Server 一起發版(指南 §8.3) |
| 契約先行 | 每個新通道先寫 `docs/contracts/` 的 schema 與去識別化範例,兩端契約測試共用(`AGENT.md` §7.3) |

**不在本計畫**:RustDesk 遠端協助、USB / 網路控管(封鎖)、報修單的後端(使用者端程式只預留入口)、網路掃描、AD 同步、非 Windows 端點。列在 §9 路線圖。

---

## 2. 現況盤點

| 元件 | 現況 | 本計畫要做的 |
| --- | --- | --- |
| `collector` | ✅ 硬體、軟體、網路、防毒、USB 儲存、RustDesk 狀態 | 補輕量健康指標(§4.3);不改既有欄位 |
| `agent`(`rustit-agent`) | ✅ 前景執行 `run --config`;HTTPS 回報、WebSocket hello / 心跳、退避、PEM 憑證 | 服務化、本機持久化、Windows 憑證存放區、指令執行、事件、本機管道、軟體派送 |
| `demo`(Tauri) | 示範用;含我的電腦各頁、報修 / 公告 / 遠端協助的模擬頁、可運作的軟體派送(`src/deploy.rs`) | **改造為使用者端程式 `desktop`**:保留使用者會用的頁面,移除軟體派送與功能說明頁(§3.3);`deploy.rs` 移植到 Agent |
| `native`(egui) | 示範用,與 WebView2 版比較效能 | **移除**(P1);效能比較報告保留為決策紀錄 |
| `watchdog` / 安裝程式(MSI) | 不存在 | 新增(P5、P1) |
| `ItAgentBack` | ✅ 測試區運作;`/v1/devices[/{id}]`、Agent 回報與 WebSocket、三種儲存、giga-observe 監控 | `/sync`、離線紀錄、指令、事件、健康、版本、軟體目錄與檔案下載 |
| GigaItApp「電腦清單」 | ✅ 清單 + 詳情(概要、磁碟、網卡) | 詳情分 Tab、指令按鈕、指令紀錄、軟體派送、Agent 版本、告警、離線期間 |
| 契約 | inventory、ws-envelope(hello / heartbeat / unsupported)、sync(已定義、未實作) | sync 實作、command / command_update、event、watchdog report、本機管道、使用者管道 |

---

## 3. 整體架構

```mermaid
flowchart LR
    subgraph PC["端點電腦(Windows)"]
        WD["GigaNexusWatchdog 服務<br/>(crates/watchdog)"]
        AG["GigaNexusAgent 服務<br/>(crates/agent)"]
        DB[("本機持久化<br/>state\store.db<br/>加密 SQLite")]
        PIPE{{"具名管道<br/>giganexus-agent-v1"}}
        UPIPE{{"唯讀管道<br/>giganexus-agent-user-v1"}}
        UA["使用者端程式<br/>(crates/desktop,登入者身分)<br/>托盤 + 視窗"]
        WD <-->|get_status / prepare_shutdown| PIPE
        PIPE <--> AG
        AG <--> DB
        AG --> UPIPE --> UA
    end
    subgraph GW["Gateway"]
        N9443["Nginx :9443 mTLS"]
        BFF["BFF /api/endpoint/*<br/>權限 endpoint.*"]
        N443["Nginx :443<br/>使用者登入、/ws/notify、各應用"]
    end
    subgraph EP["ItAgentBack(Node.js)"]
        AGCH["endpoint-agent :51241<br/>回報 / sync / WS / 下載 / watchdog"]
        API["endpoint-api :51240<br/>裝置 / 指令 / 派送 / 版本"]
        SVC["service 層<br/>指令派送器、事件、版本規則"]
    end
    SQL[("SQL Server<br/>giganexus_It_Agent")]
    MG[("MongoDB<br/>快照、心跳、事件明細")]
    RD[("Redis<br/>在線、即時健康")]
    NAS[("NAS RustIT\<br/>軟體庫 + 版本檔<br/>唯讀掛載")]
    ITAPP["GigaItApp 端點管理"]

    AG -->|HTTPS + WSS| N9443
    WD -->|HTTPS| N9443
    N9443 --> AGCH
    UA -->|使用者登入 HTTPS / WSS| N443
    ITAPP --> BFF --> API
    AGCH --> SVC
    API --> SVC
    SVC --> SQL
    SVC --> MG
    SVC --> RD
    AGCH -->|套件下載(Range)| NAS
```

### 3.1 RustAgent 目錄(Cargo workspace)

| crate | 類型 | 職責 | 狀態 |
| --- | --- | --- | --- |
| `collector` | lib | 只蒐集、不連網(WMI、登錄檔、sysinfo);Agent 與使用者端程式共用 | 既有 |
| `common`(新) | lib | 兩個服務共用:`agent.toml` 解析、`CertSource` 與 `rustls::ClientConfig`、HTTPS / WSS 連線與退避、信封型別、具名管道訊息、日誌設定、`ProgramData` 路徑、本機持久化(store) | P1、P2 從 `agent` 抽出 / 新增 |
| `agent` | bin + lib | 回報、`/sync` 補傳、WebSocket、指令執行器、事件偵測、軟體安裝 / 移除、本機管道與使用者管道伺服端 | 既有,擴充 |
| `watchdog`(新) | bin + lib | 看守 Agent、上報、執行升級與還原;自己的上報也先寫本機再送 | P5、P6 |
| `desktop`(由 `demo` 改名) | bin | 使用者端程式:托盤、通知、我的電腦(本機頁面)、嵌入 Gateway 網頁應用;以登入者身分執行,**不**持有裝置憑證 | P8 |
| `native` | — | **移除**(P1,單獨一個 commit) | — |
| `installer/`(新,非 crate) | WiX 原始檔 + 建置腳本 | 監控 MSI(Agent + Watchdog 兩個服務);使用者端 MSI(兩層各自發版) | P1、P8 |

`common` 是 Rust 端內部共用,**不和 ItAgentBack 共用程式碼**;兩端仍只靠 `docs/contracts/` 溝通。移除 `native` 時一併移除只為並排比較的 `scripts/bench.ps1`,`RustAgent/docs/ui-performance-comparison.md` 保留。

### 3.2 端點電腦上的安裝結果

| 項目 | 內容 |
| --- | --- |
| 服務 | `GigaNexusAgent`、`GigaNexusWatchdog`,LocalSystem,自動啟動;失敗復原 10 / 30 / 60 秒,1 天重設(指南 §6.1) |
| 程式 | `%ProgramFiles%\GigaNexus\Agent\`(`rustit-agent.exe`、`rustit-watchdog.exe`);升級時舊版保留在 `previous\` |
| 設定 / 資料 | `%ProgramData%\GigaNexus\Agent\`:`agent.toml`(安裝設定)、`state\`(本機持久化 `store.db` 與加密金鑰檔,§4.2)、`logs\`、`cache\`(安裝檔);ACL 只允許 SYSTEM、Administrators |
| 日誌 | 每日一檔、保留 14 天、單檔上限 10 MB;不含私鑰、Token、完整軟體清單 |
| 憑證 | 正式:`LocalMachine\My` 的 AD CS 電腦憑證(私鑰不可匯出,以 CNG 簽署,指南 §3.4);測試區:PEM 檔 |
| 使用者端程式 | `%ProgramFiles%\GigaNexus\Desktop\`;登入時由 `HKLM\...\Run` 啟動(每位登入者一個行程);使用者資料在 `%LOCALAPPDATA%\GigaNexus\Desktop\`(WebView2 登入狀態、快取) |
| 指令列 | `rustit-agent run --config <檔>`(前景,開發用,保留)、`rustit-agent service`(由 SCM 啟動);`install` / `uninstall` 只給開發測試,正式一律 MSI |

### 3.3 Demo 畫面與功能的去向

Demo(Tauri)改造為使用者端程式 `desktop`:使用者會用的頁面保留(改接真實資料),IT 功能移到 GigaItApp。

| Demo 頁面 / 功能 | 使用者端程式 `desktop` | IT(GigaItApp) | 階段 |
| --- | --- | --- | --- |
| 總覽(電腦名稱、使用者、網域、OS、狀態卡) | **保留 →「我的電腦」首頁**,加上 IP、MAC、Agent 連線狀態與「複製電腦資訊」(§4.8) | 電腦詳情「概要」Tab | P8-1;P3 |
| 硬體資訊 | 保留(唯讀) | 「硬體」Tab | P8-1;P3 |
| 網路 | 保留(唯讀) | 「網路」Tab(擴充 DNS、閘道) | P8-1;P3 |
| 已安裝軟體 | 保留(唯讀) | 「軟體」Tab;清單依軟體名稱篩選電腦 | P8-1;P3 |
| 安全與控管(防毒、Windows 更新、USB 儲存) | 保留(唯讀摘要) | 「安全與周邊」Tab;USB 插拔 →「事件」Tab | P8-1;P3、P5 |
| 即時使用率(`live_stats`) | 保留在我的電腦首頁 | 心跳附健康摘要(§4.3),詳情頁最近值與 24 小時走勢 | P8-1;P5 |
| 匯出 JSON | 移除(使用者不需要) | 詳情「下載資產 JSON」 | P3 |
| 公告 | 保留頁面入口,改為 BFF 通知中心的資料;收到即跳 Windows 通知(`/ws/notify`) | 由 BFF 通知中心發布 | P8-1 |
| 報修單 | 保留頁面入口,送單時自動帶入本機資產;後端另立或併入 portal-api | 處理畫面(路線圖) | 入口 P8-3;後端路線圖 |
| 遠端協助 | 保留:顯示要告訴 IT 的電腦資訊、RustDesk 狀態;之後顯示「IT 正在連線」 | 電腦詳情按鈕(路線圖) | P8-1;路線圖 |
| 軟體派送(`deploy.rs`) | **移除頁面**;執行邏輯移植到 Agent `software` 模組(SYSTEM 執行,去掉 UAC 提權) | 「軟體派送」選單 | P7 |
| 功能說明 | 移除 | — | P8-1 |
| egui 原生版、效能比較 | `native` crate 移除;`ui-performance-comparison.md` 保留為決策紀錄 | — | P1 |

---

## 4. 功能框架

### 4.1 常駐(Agent 服務化)— P1

- `windows-service` crate;服務主迴圈收到 Stop / Shutdown 時:關閉 WebSocket(close 1001)、等待執行中的指令最多 30 秒、把未送出的資料留在本機持久化、寫日誌後結束。
- `CertSource` 新增 Windows 憑證存放區實作:依指南 §3.4 從 `LocalMachine\My` 挑選「簽發者為 Agent 中繼 CA、EKU 含用戶端驗證、在效期內、`NotAfter` 最晚」的憑證,以 `rustls-cng` 讓私鑰留在 CNG 內簽章(實作 `ResolvesClientCert`,每次握手重新挑選);**指南標示未實測,P1 先做 PoC**。PEM 實作保留給測試區與開發。
- 設定路徑預設 `%ProgramData%\GigaNexus\Agent\agent.toml`(MSI 寫入 Gateway 位址與部署區);`run --config` 仍可指定。設定分層見 §4.2。
- MSI(WiX):安裝兩個服務、設定失敗復原、建立目錄與 ACL;參數 `GATEWAY=<ip>:9443`、`ENV=test|prod`。網域電腦以 GPO 軟體安裝派送,非網域電腦由 IT 手動安裝並匯入憑證(指南 §3.1、E5)。
- 簽章:exe 與 MSI 以 AD CS 程式碼簽章憑證簽署(ADR 0003,流程 §4.9);憑證取得前,測試區用未簽章版本,只裝在 IT 電腦。
- 同階段移除 `native` crate(單獨一個 commit,只刪不改)。

**完成標準**:IT 3 台電腦以 MSI 安裝,重開機後自動連線;以工作管理員結束 Agent 行程,10 秒內由 SCM 重新啟動;解除安裝後服務、程式目錄移除(`ProgramData` 保留日誌與持久化資料,重新安裝後接續使用)。

### 4.2 本機設定與持久化(含離線紀錄)— P2

沿用 INTEGRATION-PLAN §4 的決定(SQLite + AES-256-GCM + DPAPI,不用 SQLCipher;`/sync` 冪等比對),擴充為 Agent 所有「要記在本機」的資料。

**設定分三層**

| 層 | 內容 | 存放 | 誰能改 |
| --- | --- | --- | --- |
| 安裝設定 | Gateway 位址、部署區、憑證來源(PEM / 存放區)、日誌等級 | `agent.toml`(MSI 寫入) | 只有 MSI / 系統管理員;服務不改寫它 |
| 主機下發設定 | 回報間隔、心跳間隔、健康指標開關、所屬發佈環、事件類別開關 | `store.db` 的 `settings`(主機在 `hello_ack` / `watchdog report` 回應帶最新版本號,變更時下載並持久化) | 主機;**離線或重開機時用最後一次收到的設定**,從未收過就用程式內預設值 |
| 本機狀態 | `device_id`、`agent_seq`、最後確認的 `seq` / `hash`、指令去重表、目前裝置狀態(active / disabled) | `store.db` 的 `state` | Agent 自己 |

**持久化內容**(`%ProgramData%\GigaNexus\Agent\state\store.db`,敏感欄位以 AES-256-GCM 加密,金鑰經 DPAPI 電腦範圍保護)

| 資料表 | 內容 | 送達後 | 上限 |
| --- | --- | --- | --- |
| `outbox_inventory` | 尚未確認的資產快照(`agent_seq`、`collected_at`、`content_hash`、加密 payload);連續相同 hash 只留一份 | 經 `/sync` 比對、主機確認後刪除 | 50 份或 20 MB,滿了丟最舊並記一筆 `local_overflow` 紀錄 |
| `outbox_event` | 事件(USB 插拔、Agent 重啟、憑證即將到期、**離線期間**…),保留發生時間 | `POST /agent/v1/events` 確認後刪除 | 5,000 筆,滿了丟最舊 |
| `outbox_command_result` | 離線期間完成、尚未回報的指令結果(例如安裝到一半斷線) | 重連後以 `command_update` 補送,確認後刪除 | 500 筆 |
| `conn_log` | 連線紀錄:每次斷線 / 重連的時間、原因分類(網路不通、DNS、TLS / 憑證被拒、HTTP 4xx / 5xx、主機 503)、重試次數 | 重連時彙總成一筆 `offline_period` 事件送出;本機保留 30 天供現場查看 | 30 天 |
| `settings` / `state` | 見上表 | 不刪 | — |

**「連不上主機也要記錄」的行為**

1. 斷線當下寫 `conn_log`(開始時間、原因);之後依退避重試,每次失敗只更新計數與最後原因,不逐筆寫(避免長時間離線塞爆)。
2. 離線期間照常蒐集:資產照排程寫 `outbox_inventory`;USB 插拔等事件寫 `outbox_event`;Watchdog 的上報也先寫自己的本機紀錄。
3. 重連後依序:`hello` → `/sync` 補傳快照 → 送出事件(含 `offline_period`:開始、結束、主要原因、期間重試次數)→ 補送指令結果。
4. 主機據此在 GigaItApp 顯示「離線期間」與當時發生的事件(時間是端點上的發生時間,另記 `received_at`)。
5. 使用者端程式「我的電腦」可直接顯示「目前未連線,自 HH:mm 起,原因:…」,方便使用者回報給 IT(§4.8)。

**完成標準**:Agent 執行中拔網路 1 小時,期間插拔 USB 隨身碟、重啟一次服務;接回網路後,主機收到最新資產、USB 事件(發生時間正確)、一筆 `offline_period`(開始 / 結束 / 原因),且沒有重複資料;離線期間重開機後,持久化資料仍在;`store.db` 複製到另一台電腦無法解密;主機停用裝置後,Agent 套用主機狀態(INTEGRATION-PLAN §4.2 第 4 點)。

### 4.3 監測 — P3(看得到)、P5(即時與事件)

**三層資料**

| 層 | 內容 | 頻率 | 存放 | 畫面 |
| --- | --- | --- | --- | --- |
| 資產 | 既有 `ComputerInfo` | 開機、每 24 小時、指令 `inventory.collect`;內容沒變只更新時間(現行 `content_hash`) | SQL 最新一份 + Mongo 歷史 | 詳情各 Tab、變更歷程 |
| 健康 | `cpu_pct`、`mem_used_pct`、`disk_min_free_pct`(最滿的固定磁碟)、`uptime_s`、`agent_rss_mb` | 附在每 30 秒的 `heartbeat.body.health` | Redis 最新值(TTL 90 秒)+ Mongo `heartbeats`(既有,TTL 1 天);需要更長走勢再加每小時彙總 | 清單欄位、詳情走勢 |
| 事件 | 硬體變更、軟體增刪、USB 儲存插拔、Agent 重啟次數、憑證即將到期、離線期間 | 發生時寫本機 `outbox_event`,在線時立即 `POST /agent/v1/events`(批次);軟硬體變更由 Server 比對前後兩份資產產生 | SQL `ita.device_event`(擴充 `event_type`)+ Mongo 明細 | 詳情「事件」Tab、「告警」頁 |

- 健康指標只做摘要,**不做**程序清單、螢幕、鍵盤等(PRD §7 隱私)。
- 軟硬體變更由 **Server 比對**(同一裝置前後兩份 payload 的 `software`、`memory_modules`、`physical_disks`、`gpus` 序號),Agent 不需要記住上一份,也不會因 Agent 重裝而漏判。
- USB 插拔由 Agent 監聽裝置變更(`CM_Register_Notification`,ADR 0003 使用者模式),只記錄、不封鎖。
- **告警規則**(初版固定,不做規則引擎):離線超過 N 天、磁碟剩餘 < 10%、硬體序號變更、Agent 24 小時內重啟 ≥ 3 次、憑證 30 天內到期、Watchdog 回報版本不符。先只在 GigaItApp「告警」頁顯示;之後經 BFF 通知逐人寄給 IT 值班人員。

### 4.4 指令通道 — P4

依指南 §8.3–§8.5 實作,本計畫只補框架決定:

- **資料表**:`ita.command`(一筆指令 = 一台電腦一個動作;`command_id`、`batch_id`、`device_ref`、`kind`、`level`、`params`(遮罩後)、`state`、`progress`、`result_summary`、`error_code`、`expires_at`、建立人工號 / 姓名、各階段時間)、`ita.command_batch`(批次、同時執行上限)。
- **派送器**(ItAgentBack service 層):寫入 SQL → 該裝置在線就從 WebSocket 推 `command` → 依 `command_update` 更新狀態;Agent 重連(收到 `hello`)時補送 `queued` 指令;每分鐘掃描逾期指令設為 `expired`。單一實例,多實例另議(指南 §8.4)。
- **Agent 執行器**:以 `command_id` 去重(去重表在本機持久化,重開機後仍有效);同時間只執行一個會改變系統的指令(`software.*`、`system.reboot`、`agent.upgrade`),查詢類可並行;不認得的 `kind` 回 `UNSUPPORTED_COMMAND`;執行結果先寫本機再回報。
- **第一批類型**:`inventory.collect`(basic)、`agent.restart`(basic)、`message.show`(basic;使用者端程式在執行就由它顯示,否則 `WTSSendMessage` 跳系統訊息框);之後 P6 `agent.upgrade`、P7 `software.install` / `software.uninstall` / `system.reboot`。
- **畫面**:電腦詳情的指令按鈕(依 itapp 按鈕權限 ∧ `/api/auth/me` 的 `endpoint.*` 顯示,指南 §8.6)、「指令紀錄」Tab;執行中每 2 秒輪詢 `GET /commands/{id}`。

### 4.5 升級 — P6

依指南 §7.4(Watchdog 替換 Agent、Agent 替換 Watchdog,都不覆寫自己),補充後台設計:

| 項目 | 設計 |
| --- | --- |
| 版本登錄 | `ita.agent_release`:版本、元件(agent / watchdog / desktop)、檔案相對路徑、SHA-256、預期簽章者、狀態(`draft` / `published` / `revoked`) |
| 發佈環 | `ita.release_ring`:`pilot`(IT 測試機)→ `it`(IT 部門)→ `all`;每環一個目標版本,之後依部門 / 公司細分。裝置預設 `all`,IT 可改。先設 `pilot` 觀察 1 天,再往下一環 |
| 下發 | Watchdog 每 5 分鐘 `POST /agent/v1/watchdog/report`,回應帶目標版本與下載路徑;也可用指令 `agent.upgrade` 立即觸發 |
| 下載 | `GET /agent/v1/releases/{version}/{file}`(經 `:9443`,支援 Range);檔案放 NAS `RustIT\releases\{agent|watchdog|desktop}\{version}\`(§4.6) |
| 驗證與還原 | SHA-256 + Authenticode 簽章者相符才安裝;新版 2 分鐘內 `get_status` 不正常就還原 `previous\` 並回報失敗;同一版本失敗 2 次不再自動重試 |
| 遠端停用開關 | 環的目標版本可設回舊版(降版走同一流程);裝置可停用(既有 `status = disabled`) |
| 首次安裝 | MSI(GPO);之後一律經 Watchdog 升級。MSI 只在大改版(例如服務名稱、目錄變更)時重派 |

### 4.6 軟體派送 — P7

依 [ADR 0002](decisions/0002-software-deployment.md)(採方案 B:NAS 儲存、伺服器以 HTTPS 提供),補充:

| 項目 | 設計 |
| --- | --- |
| 軟體庫 | **`\\10.10.130.31\docker-folder\RustIT\software`**,依 `軟體\版本\` 分資料夾;IT 直接把測過的安裝檔放進去(大檔不經網頁上傳,避開 Nginx 單檔 30 MB 限制)。Agent / Watchdog / 使用者端程式的版本檔放同層 `RustIT\releases\` |
| NAS 帳密與掛載 | 需求方提供 NAS 帳密,**只給後端**:由需求方執行的機密腳本寫入主機 2 `/srv/giganexus/ita-secrets/`(AI 不經手),`endpoint-server` 以 CIFS volume **唯讀**掛載 `RustIT\`。**Agent 不拿 NAS 帳密、不直接連 NAS**,一律經 `:9443` 向後端下載 |
| 軟體目錄 | `ita.software_package`:名稱、版本、檔案相對路徑、SHA-256(Server 自動計算)、類型(MSI / Inno / NSIS / …)、靜默安裝 / 移除參數(依類型帶範本)、「已安裝」判斷(DisplayName 樣式或 MSI 產品代碼)、是否需重開機、狀態(`draft` / `tested` / `published`)、建立人 / 覆核人 |
| 簽章者 | 不在 Linux 解析 Authenticode:`draft` 先派到測試機,Agent 回報實際簽章者,IT 確認後寫入「預期簽章者」並改 `tested`;第二人覆核後 `published`(ADR 0002 兩人覆核) |
| 派送 | 一次派送 = 一個 `command_batch`,每台一筆 `software.install` 指令;同時執行上限(預設 20 台)由派送器控制;Agent 依序下載(`GET /agent/v1/packages/{packageId}`,Range、本機快取)→ 驗 SHA-256 與簽章者 → 靜默安裝(逾時 30 分鐘)→ 重新蒐集確認已安裝 → 回報結束代碼 |
| 移除 | `software.uninstall`:用登錄檔 `QuietUninstallString` / `UninstallString` 加靜默參數,MSI 用 `msiexec /x {產品代碼} /qn`;輪詢登錄檔直到項目消失(沿用 Demo `deploy.rs` 的處理) |
| 重開機 | 結束代碼 3010 / 1641 不強制重開,狀態 `succeeded` + `reboot_required`;IT 另下 `system.reboot`(先提示使用者,可延後) |
| 授權數 | 目錄記錄授權數,已安裝數(由資產比對)達上限時不允許派送;報表屬路線圖 |

**為何不用 giga-file-service**:附件服務的下載走使用者登入(BFF),Agent 沒有使用者身分;安裝檔也遠大於 30 MB。軟體庫由 ItAgentBack 唯讀提供。

### 4.7 giga-Portal「我的電腦」— 路線圖

使用者在**這台電腦上**看自己的電腦,由使用者端程式提供(§4.8),不需要「電腦 ↔ 使用者」對應。要在**別台電腦的入口網**看自己名下的電腦,才需要對應:先只做碩禾 AD 帳號(S + 6 碼,以 Agent 回報的登入者對應工號);其他公司由 IT 在 GigaItApp 手動指定保管人。API 會是 `/api/endpoint/my-devices`(新權限,只回自己的電腦)。

### 4.8 使用者端程式(`crates/desktop`)— P8

**與監控服務分開**(需求方已決定):

| 面向 | 監控服務(Agent + Watchdog) | 使用者端程式 |
| --- | --- | --- |
| 執行身分 | LocalSystem,session 0,看不到桌面 | 目前登入者,一般權限,每個登入工作階段一個行程 |
| 對 Gateway 的身分 | **裝置憑證**(mTLS,`:9443`) | **使用者登入**(Gateway 帳號,`:443`);不碰裝置憑證私鑰 |
| 生命週期 | 開機即執行,使用者無法停止 | 登入後啟動;關視窗後托盤仍在,結束托盤也**不影響監控** |
| 變動頻率 | 低,升級要謹慎(SYSTEM 權限、全公司) | 高(陸續加入 AI、BPM、信箱等入口),可單獨快速發版 |
| 出錯影響 | 影響資產與指令 | 只影響使用者介面 |

**我的電腦(共用電腦報修、遠端協助的依據)**

使用者要能直接看到並回報這台電腦的識別資訊,尤其是共用電腦(登入者不一定是保管人):

| 欄位 | 來源 | Agent 沒執行 / 沒連線時 |
| --- | --- | --- |
| 電腦名稱、網域 / 工作群組 | 使用者端程式自己讀(Windows API,不需管理員) | 仍可顯示 |
| IP 位址(有閘道的網卡優先)、MAC | 同上 | 仍可顯示 |
| 目前登入人員(帳號、顯示名稱) | 同上 | 仍可顯示 |
| 電腦型號、序號、OS 版本 | `collector`(Demo 既有做法,一般使用者可執行) | 仍可顯示 |
| Agent 狀態:連線中 / 未連線(自何時、原因)/ 未執行;Agent 版本 | 唯讀管道 | 顯示「Agent 未執行,請聯絡 IT」 |
| 裝置代碼(`device_id` 前 8 碼,IT 在 GigaItApp 可搜尋) | 唯讀管道 | 顯示「尚未登錄」 |

- 首頁一鍵「**複製電腦資訊**」(純文字:電腦名稱、IP、登入人員、裝置代碼、時間),貼到報修單或 Teams / Email 給 IT;報修入口送單時自動附上。
- GigaItApp 清單可用電腦名稱、IP、裝置代碼找到同一台電腦(P3 篩選)。
- 基本資訊由使用者端程式自己讀,**Agent 故障時使用者仍能回報**,這正是需要遠端協助的時候。

**架構**

| 項目 | 設計 |
| --- | --- |
| 來源 | `crates/demo` 以 `git mv` 改名為 `crates/desktop`(單獨一個 commit),保留 §3.3 的使用者頁面,移除軟體派送與功能說明頁;模擬資料(`mock.js`)逐步換成真實資料 |
| 技術 | Tauri 2 + WebView2 + 托盤圖示。**平時只有托盤**,開視窗時才建立 WebView2、關閉視窗就釋放;WebView2 開著時約 450 MB 是已知代價(`RustAgent/docs/ui-performance-comparison.md`) |
| 頁面 | 本機打包頁面:我的電腦各頁、遠端協助資訊;嵌入的網頁應用:公告、報修、入口網、BPM 查看、信箱、AI 等,**只允許 Gateway 網域**,外部連結交給預設瀏覽器 |
| 原生功能 | 只有少數:托盤選單、Windows 通知、開機啟動、我的電腦、複製電腦資訊、截圖附加到報修;**遠端網頁不能呼叫任何原生指令**(Tauri capabilities 只開給本機打包的頁面) |
| 登入 | WebView2 內登入 Gateway(與瀏覽器相同的 BFF 登入,AD / 本機帳號規則不變),登入狀態存在使用者自己的 `%LOCALAPPDATA%`;Windows 整合式登入(Kerberos)另案評估,需 Gateway 支援。我的電腦**不需登入**即可看 |
| 公告 / 通知 | 以使用者身分連 BFF `/ws/notify`,收到就跳 Windows 通知;沿用 BFF 通知中心 |
| 和 Agent 的關係 | 只透過**唯讀管道** `\\.\pipe\giganexus-agent-user-v1`:讀 Agent 狀態與裝置代碼;接收 Agent 轉來的提示(`message.show`、重開機提示),使用者可回「稍後」。**不能**對 Agent 下任何管理操作(指南 §10 E3) |
| 啟動 | MSI 寫 `HKLM\...\Run`,每位使用者登入時啟動;使用者結束後不強制拉起,下次登入再啟動 |
| 升級 | 版本放 `RustIT\releases\desktop\`;由 Watchdog 執行:經管道通知各工作階段的使用者端程式結束 → 替換檔案 → 由使用者重新開啟或下次登入啟動 |

**階段**(P8 拆三步):

1. **P8-1 外殼與我的電腦**:Demo 改名與頁面整理、托盤、我的電腦(自己讀的欄位)、複製電腦資訊、登入、`/ws/notify` 公告通知、使用者端 MSI。
2. **P8-2 與 Agent 串接**:唯讀管道、Agent 狀態與裝置代碼、`message.show` / 重開機提示改由使用者端顯示。
3. **P8-3 應用入口**:報修(帶入電腦資訊與截圖)、BPM 查看、信箱(以取代 Notes 的系統為準)、AI 等,依各系統經 Gateway 上線的順序逐一加入。

### 4.9 Windows 執行檔的建置與簽章 — 採選項 C

要產出:`rustit-agent.exe`、`rustit-watchdog.exe`、`rustit-desktop.exe`、兩個 MSI,全部要 Authenticode 簽章(ADR 0003)。MSVC 工具鏈與 WiX 只能在 Windows 跑;現有 GitLab Runner 在主機 2 的 WSL(Linux)。

| 選項 | 做法 | 結論 |
| --- | --- | --- |
| A. 開發機手動 | 開發者電腦建置,簽章人員自己簽 | 只用在 Windows Runner 建好之前的測試期 |
| B. Windows Runner 全自動簽章 | 簽章憑證裝在 Runner | 不採用:私鑰在 CI 主機,能推受保護分支的人等於能簽章,違反 ADR 0003 |
| **C. Windows Runner 建置 + 人工簽章** | CI 產出**未簽章**檔案與 SHA-256;簽章人員核對雜湊後在自己電腦執行簽章腳本,放到 NAS `RustIT\releases\`,在 GigaItApp 登錄版本 | ✅ **需求方採用** |
| D. Linux 交叉編譯 | `cargo-xwin` + `wixl` | 不採用:Windows 專屬功能無法測試,MSI 仍需 Windows |
| E. 雲端簽章 | Azure Trusted Signing | 不採用:台灣申請資格未確認、需對外連線 |

**Windows Runner 放哪裡**

| 位置 | 評估 |
| --- | --- |
| **主機 2(Windows 本機,不經 WSL)— 先用** | 已有 Windows 10 與 Docker / Runner 管理經驗;另裝一個 GitLab Runner(shell executor、PowerShell、tag `windows`),與 WSL 內的 Linux Runner 分開。Rust release 建置吃 CPU 數分鐘,只在 tag / 手動 job 執行,並設定 `concurrent = 1`;若影響測試區 Gateway 再申請獨立 Windows VM |
| AD 主機(網域控制站)— **不建議** | 網域控制站是全公司最高權限的主機;CI Runner 會執行 repo 裡的任意建置腳本,等於讓能推程式的人取得在 DC 上執行程式的能力,一旦被濫用就是整個網域淪陷。另外 DC 不應安裝開發工具(VS Build Tools、Rust、WiX)與額外服務,也不該被建置工作拖慢登入與驗證 |
| 獨立 Windows VM | 最乾淨;主機 2 資源吃緊時再申請 |

簽章憑證仍待 IT 以 AD CS 簽發(ADR 0003)。AD 主機只負責簽發憑證,**簽章動作在簽章人員自己的電腦**,不在 AD 主機上。

### 4.10 基礎建設補強(試行前)

以下項目不屬於單一功能,但會影響 P1–P8 的設計,放進對應階段一起做:

| # | 項目 | 做法 | 階段 |
| --- | --- | --- | --- |
| A1 | **裝置身分合併與汰換** | 裝置鍵仍是憑證 DN(指南 §3.3),另以「BIOS 序號 + 主機板 UUID」做硬體指紋:新登錄的裝置指紋與既有裝置相同(重灌、改名、換憑證)時,標記「疑似同一台」,由 IT 在 GigaItApp 確認合併(歷史、事件、指令紀錄併入舊裝置,舊 DN 記入 `device_event`);不自動合併,避免虛擬機或主機板序號空白造成誤併。新增裝置狀態 `retired`(報廢 / 退役):不再出現在清單預設檢視,資料依保存期限清除(B5) | P2(資料欄位)、P3(畫面) |
| A2 | **時鐘偏差** | `hello` 帶 `agent_time`,主機記錄 `clock_skew_ms`;事件與快照的端點時間超過 ±5 分鐘偏差時,畫面同時顯示端點時間與校正後時間,並產生告警 | P2 |
| A3 | **主機端限流** | 主機忙碌時回 `429` + `Retry-After`(秒);Agent 照等並加隨機延遲,不計入一般錯誤退避;補傳每次最多 N 筆。寫入契約 README 的錯誤回應 | P2 |
| A4 | **遠端診斷** | 指令 `agent.diagnose`(basic:檢查連線、DNS、時間、憑證效期、磁碟、WMI 回應時間,結果回報)、`logs.collect`(basic:壓縮最近 N 天 Agent / Watchdog 日誌經 HTTPS 上傳,主機存 Mongo GridFS 或檔案,保存 14 天)、`agent.log_level`(basic:暫時調高日誌等級,到期自動恢復) | P4 |
| A5 | **Agent 被停用 / 移除的偵測** | Watchdog 偵測 Agent 服務被手動停止、啟動類型被改、程式檔被刪,寫本機事件並上報;Agent 同樣看守 Watchdog。主機端:裝置「應在線卻超過 N 小時無心跳也無 Watchdog 回報」列入告警。服務 ACL 限制一般使用者停止(管理員仍可停,只能偵測) | P5 |
| A6 | **WMI 逾時與資源保護** | collector 每項 WMI 查詢設逾時(預設 15 秒,逾時寫 `warnings`、不阻塞其他項目);蒐集時降低行程與 I/O 優先權;使用電池或計量網路時,延後大檔下載與非必要的完整掃描(健康、心跳照常) | P1(逾時、優先權)、P7(下載策略) |
| A7 | **WebView2 Runtime** | 使用者端 MSI 檢查 WebView2 Runtime,沒有就執行內附的 Evergreen 安裝程式(安裝檔一起放 `RustIT\releases\`);缺少時托盤與 Windows 通知仍可用,開視窗時提示聯絡 IT | P8-1 |
| A8 | **Windows 測試機環境** | 準備 Hyper-V(或主機 2 / 新 VM)上的 Win10、Win11 測試 VM 各一台,加入網域、裝好測試憑證,建立「乾淨快照」;MSI 安裝、升級、還原、派送、離線測試都在 VM 上做,每次測完還原快照。只用自己的電腦測不出首次安裝與升級失敗的情況 | P1 起 |

---

## 5. ItAgentBack 擴充

### 5.1 模組

| 模組(`src/`) | 內容 | 階段 |
| --- | --- | --- |
| `agent-app.ts` | 既有;加 `POST /agent/v1/sync`、`POST /agent/v1/events` | P2 |
| `routes/devices.ts` | 既有;加 `/{id}/software`、`/{id}/events`、`/{id}/history`、`/{id}/inventory.json`;清單篩選(名稱、IP、MAC、裝置代碼、軟體) | P3、P5 |
| `routes/commands.ts` | 指南 §8.3 的指令 API(basic / admin 分路徑、批次、取消、Idempotency-Key) | P4 |
| `routes/alerts.ts` | 告警清單(由事件與規則計算) | P5 |
| `routes/releases.ts` | 版本登錄、發佈環目標版本、裝置所屬環 | P6 |
| `routes/software.ts` | 軟體目錄 CRUD、NAS 檔案瀏覽、狀態變更、派送(建立 batch) | P7 |
| `agent-app.ts`(續) | WS `command` / `command_update`(P4)、`POST /agent/v1/watchdog/report`(P5)、`GET /agent/v1/releases/...`(P6)、`GET /agent/v1/packages/{id}`(P7);`hello_ack` 帶設定版本號(P2) | P4–P7 |
| `services/sync-service.ts` | `/sync` 冪等比對(INTEGRATION-PLAN §4.2)、`offline_period` 等事件寫入 | P2 |
| `services/command-dispatcher.ts` | 指令狀態機、在線推送、重連補送、逾期、批次限流 | P4 |
| `services/event-service.ts` | 資產前後比對、告警規則 | P5 |
| `services/release-service.ts`、`software-service.ts` | 版本選擇、檔案雜湊、下載稽核 | P6、P7 |

### 5.2 資料表(手寫 migration,SQL Server 2012 語法)

| migration | 資料表 | 階段 |
| --- | --- | --- |
| `0002_sync_event.sql` | `ita.device_event` 加 `occurred_at`(端點發生時間)、`received_at`、索引與新 `event_type`(含 `offline_period`、`usb_*`、`local_overflow`、`merged`);`ita.device_setting`(主機下發設定與版本號);`ita.device` 加 `hw_fingerprint`、`clock_skew_ms`、`merged_into`、`retired_at`(A1、A2) | P2 |
| `0003_command.sql` | `ita.command`、`ita.command_batch`(含第二人核可欄位,B1);診斷檔案索引(`logs.collect`,A4) | P4 |
| `0004_health.sql` | `ita.device_health`(Watchdog 最近回報、憑證到期、重啟次數;1:1) | P5 |
| `0005_release.sql` | `ita.agent_release`、`ita.release_ring`、`ita.device` 加 `ring`、`watchdog_version`、`desktop_version` | P6 |
| `0006_software.sql` | `ita.software_package` | P7 |

同步更新 `ItAgentBack/docs/DB_SCHEMA.md` 與 `../GigaNexusAIPlan/architecture/projects/`(若建立 RustIt 專案檔)。

### 5.3 管理 API 權限

沿用指南 §8.2 四個代碼,另加一個軟體目錄維護權限(§10 差異 1):

| 權限 | 用在 |
| --- | --- |
| `endpoint.device.read` | 清單、詳情、軟體、事件、離線期間、歷程、指令紀錄、告警、軟體目錄與版本(唯讀) |
| `endpoint.command.basic` | `inventory.collect`、`agent.restart`、`message.show`;取消自己建立的指令 |
| `endpoint.command.admin` | `software.*`、`system.reboot`、`agent.upgrade`;停用 / 啟用裝置;調整裝置所屬發佈環 |
| `endpoint.software.manage`(新) | 新增 / 修改軟體目錄、版本登錄、發佈環目標版本、覆核 |

---

## 6. 契約擴充(`docs/contracts/`)

| 檔案 | 內容 | 階段 |
| --- | --- | --- |
| `sync.schema.json` | 既有,實作;`hello` 加 `agent_time`、`hw_fingerprint`(A1、A2),`hello_ack` 加 `settings_version`、`min_agent_version`(B2);README 補 `429` + `Retry-After`(A3) | P2 |
| `event.schema.json`(新) | `POST /agent/v1/events`:`events[]`(`type`、`occurred_at`、`data`);含 `offline_period`(開始、結束、主要原因、重試次數) | P2 |
| `ws-envelope.schema.json` | 加 `command`、`command_update`、`prepare_shutdown`(P4);`heartbeat.body.health`(選填,P5) | P4、P5 |
| `settings.schema.json`(新) | 主機下發設定(回報間隔、心跳間隔、健康指標、發佈環、事件開關) | P2 |
| `watchdog.schema.json`(新) | `POST /agent/v1/watchdog/report` 請求與回應(目標版本、下載路徑、SHA-256) | P5、P6 |
| `pipe.schema.json`(新) | 本機管道 `get_status` / `status` / `prepare_shutdown`(指南 §7.2) | P5 |
| `user-pipe.schema.json`(新) | 使用者唯讀管道:`agent_status`(連線狀態、未連線起始時間與原因、版本、裝置代碼)、Agent → 使用者端的 `prompt`(訊息、重開機提示)與使用者回覆 | P8 |
| `command-kinds.md`(新) | 每個指令類型的 `params`、`result`、等級、有效期限、錯誤代碼 | P4 起逐步補 |

相容規則不變:只新增欄位、不認得的 `type` 回 `unsupported`、不認得的 `kind` 回 `UNSUPPORTED_COMMAND`。

---

## 7. GigaItApp 畫面(GigaItApp repo,需同意)

| 選單(`it.group.endpoint` 底下) | Tab / 按鈕 | API 權限 | 階段 |
| --- | --- | --- | --- |
| 電腦清單(既有) | 清單加:健康摘要、Agent 版本、所屬環;篩選:電腦名稱、IP / MAC、裝置代碼、軟體名稱、OS、在線 | `endpoint.device.read` | P3、P5 |
| └ 電腦詳情 | 概要 / 硬體 / 網路 / 軟體 / 安全與周邊 / 健康與 Agent / 事件(含離線期間)/ 指令紀錄;按鈕:立即蒐集、重啟 Agent、傳送訊息、重新開機、派送軟體、停用 | read;basic / admin | P2–P7 |
| 指令紀錄 | 全部指令與批次、狀態篩選 | `endpoint.device.read` | P4 |
| 告警 | 依規則列出,點進電腦詳情 | `endpoint.device.read` | P5 |
| Agent 版本 | 版本登錄 / 發佈環(agent、watchdog、desktop) | read;`endpoint.software.manage` | P6 |
| 軟體派送 | 軟體目錄 / 派送工作(批次進度) | read;`endpoint.software.manage`;admin | P7 |

選單、Tab、按鈕代碼與 `includes` 綁定寫在 `GigaItApp/deploy/gateway-rbac.yaml`;**API 權限要等 ItAgentBack 註冊 OpenAPI 後才存在,先部署後綁定**(INTEGRATION-PLAN D9 的教訓)。

---

## 8. 階段與完成標準

| 階段 | 內容 | 主要 repo | 完成標準 | 依賴 |
| --- | --- | --- | --- | --- |
| **P0** 框架定案 | 本計畫;README / HANDOFF / PROJECT-MAP 對齊;定案後更新根目錄文件、甘特圖、指南(§10) | RustIt(後續:根目錄、Gateway) | 需求方確認本計畫 | — |
| **P1** 常駐 | `common` 抽出、服務化、Windows 憑證存放區(PoC)、安裝設定、日誌、監控 MSI(未簽章);移除 `native`;WMI 逾時與優先權(A6);Windows 測試 VM(A8) | RustIt | §4.1 完成標準;MSI 在測試 VM 從快照安裝成功 | P0 |
| **P2** 本機持久化與離線紀錄 | 加密 store、設定分層、outbox、`conn_log`、`/sync`、`/events`、`offline_period`;硬體指紋(A1)、時鐘偏差(A2)、`429` 限流(A3) | RustIt | §4.2 完成標準;測試 VM 時鐘調快 10 分鐘 → 主機記錄偏差並告警;主機回 `429` 時 Agent 依 `Retry-After` 等待 | P1 |
| **P3** 資料呈現 | 管理 API 回完整資產與軟體、清單篩選;GigaItApp 詳情分 Tab、下載 JSON;疑似同一台的合併確認、退役(A1) | RustIt、GigaItApp | IT 在測試區看到自己電腦的硬體、軟體、安全 Tab,可依軟體名稱、IP、電腦名稱找到電腦;測試 VM 重灌後出現「疑似同一台」,合併後歷史連續 | — (可與 P1、P2 並行;合併畫面需 P2) |
| **P4** 指令通道 | `ita.command`、派送器、WS command、`inventory.collect` / `agent.restart` / `message.show` / `agent.diagnose` / `logs.collect` / `agent.log_level`、指令紀錄 | RustIt、GigaItApp、Gateway(BFF 權限) | 從 GigaItApp 對在線電腦下指令,狀態走完 queued → succeeded;離線電腦重連後補送;過期指令不執行;離線時完成的結果重連後補回;稽核欄位齊全;`agent.diagnose`、`logs.collect` 可在 GigaItApp 看到結果與下載日誌(A4) | P2 |
| **P5** 監測 | 健康摘要、事件、Server 比對軟硬體變更、Watchdog(看守 + 上報)、Agent 被停用 / 移除偵測(A5)、告警頁 | RustIt、GigaItApp | 結束 Agent 行程 → Watchdog 重啟並上報;以管理員手動停止 Agent 服務 → 產生事件與告警;插 USB 隨身碟 → 事件出現;移除一個軟體 → 下次蒐集產生變更事件 | P2、P4 |
| **P6** 升級 | 版本登錄、發佈環、Watchdog 升級與還原、`agent.upgrade`;Windows Runner(主機 2)與人工簽章流程 | RustIt、GigaItApp、主機 2 | `pilot` 環設新版 → 10 分鐘內升級成功;故意放壞的版本 → 自動還原並回報;發版檔案皆經人工簽章 | P5、NAS |
| **P7** 軟體派送 | 軟體目錄、NAS 唯讀掛載、套件下載、Agent `software` 模組、派送工作、`system.reboot`;本機信任簽章者清單與第二人核可(B1);電池 / 計量網路延後下載(A6) | RustIt、GigaItApp、主機 2 | 對 3 台 IT 電腦派送 7-Zip(MSI)與 Notepad++(Inno),再移除;每台狀態與結束代碼正確;雜湊不符時拒絕安裝;簽章者不在本機信任清單時拒絕安裝;派送中斷線,重連後結果正確 | P4、NAS |
| **P8** 使用者端程式 | P8-1 外殼與我的電腦、P8-2 與 Agent 串接、P8-3 應用入口(§4.8) | RustIt(應用入口依賴對方系統上線) | P8-1:沒有 WebView2 的 Win10 測試 VM 安裝後可正常開視窗(A7);登入 Windows 後托盤出現;我的電腦顯示電腦名稱、IP、登入人員,「複製電腦資訊」可貼上;發一則公告 → 跳 Windows 通知;結束托盤後 Agent 仍正常回報。P8-2:顯示 Agent 連線狀態與裝置代碼(拔網路後顯示未連線起始時間);IT 下 `message.show` 由使用者端顯示 | P8-1:無(可與 P1 並行);P8-2:P2、P4 |

- **可交給同仁並行**:P3(只動管理 API 與 GigaItApp)、P8-1(使用者端外殼,沿用 Demo 前端)。P1、P2、P4 牽涉服務、持久化、通訊協定與安全,由 Claude 主寫。
- 每階段結束:`docs/DevelopmentProcess/` 紀錄、`docs/PROJECT-MAP.md`、`../GigaNexusAIPlan/architecture/*.json`(`npm run arch:check`)、甘特圖進度。
- **上線前另外必須完成**(不屬於單一階段,除既有的程式碼簽章憑證(ADR 0003)、AD CS 電腦憑證自動註冊(指南 E1、E2、E8)、Gateway CRL 定期更新(指南 G1)、`:9443` 防火牆改端點網段):

| # | 項目 | 說明 | 優先 |
| --- | --- | --- | --- |
| B1 | **派送的第二道防線** | 端點的「信任簽章者清單」由 MSI / GPO 寫入(`HKLM` 原則,只有網域管理員能改),**主機無法修改**;Agent 安裝軟體或升級時,簽章者必須同時符合主機下發的預期簽章者與本機清單。另外,一次派送超過 20 台、或 `system.reboot` 超過 20 台,需要第二人在 GigaItApp 核可才送出 | 高 |
| B2 | **最低支援版本** | 主機宣告 `min_agent_version`;低於此版本的 Agent 只允許回報與升級,其他指令回 `AGENT_TOO_OLD`。主機與 Agent 的相容範圍是 N-1(指南 §5.6) | 中 |
| B3 | **正式區部署** | `main` → 正式區 CI(主機 3)、正式庫 `giganexus_It_Agent`、Mongo / Redis、NAS 掛載、機密、Gateway 正式區路由發佈與權限綁定;依 Gateway 正式區時程 | 高 |
| B4 | **備份與還原** | SQL `giganexus_It_Agent` 依公司 DB 備份排程(完整 + 交易記錄);Mongo / Redis 可重建,不備份;NAS `RustIT\`(軟體庫、版本檔)納入 NAS 備份;上線前做一次還原演練 | 高 |
| B5 | **資料保存與個資** | 保存期限:稽核與指令紀錄 1 年(PRD §7)、事件 1 年、快照歷史 90 天(既有)、連線紀錄與診斷日誌 14–30 天;退役裝置 1 年後刪除;上線前發布隱私公告(INTEGRATION-PLAN D10),列出蒐集項目與用途 | 高 |
| B6 | **大量異常偵測** | giga-observe 加入「端點在線率驟降(例如 10 分鐘內下降 20%)」「同一錯誤碼暴增(憑證被拒、503)」告警,通知**維運人員**;CRL / 憑證過期會造成全公司同時掉線,這是最可能的大規模事故 | 高 |
| B7 | **壓測工具** | `RustIt/tools/agent-sim`(Node.js 或 Rust):模擬 500–1,000 台 Agent 的 WebSocket、心跳、補傳、事件、指令回應;驗證主機與 Gateway(指南 G3) | 中 |
| B8 | **CI 安全掃描** | CI 加 `cargo audit`、`npm audit`(高風險即失敗)、產出 SBOM;發版檢查清單(版本號、變更說明、簽章、雜湊、`pilot` 環觀察) | 中 |
| B9 | **公司間的資料範圍** | 依指南 E6:管理 API 依內部 Token 的 `cos` 過濾;另設「全部公司」角色給 IT 主管 | 中 |
| B10 | **維運手冊與使用者文件** | `docs/RUNBOOK.md`:大量離線、憑證過期、版本回滾、手動解除安裝、NAS 無法掛載的處理步驟;IT 安裝指南(GPO 派送、非網域電腦);使用者 FAQ(托盤是什麼、蒐集哪些資料、如何回報電腦資訊) | 中 |

---

## 9. 路線圖(本計畫之後)

| 功能 | 需要的新東西 |
| --- | --- |
| RustDesk 遠端協助(PRD §6) | 自架 hbbs / hbbr、`software.install` 派送 RustDesk、密碼加密保存、`rustdesk://` 一鍵連線與稽核;使用者端顯示「IT 正在連線」 |
| USB 儲存控管(PRD §5.2) | 策略下發(`policy.apply` 指令)、白名單、違規事件 |
| 報修單後端(PRD §4.1) | 使用者端程式 / giga-Portal 送單、IT 端 GigaItApp 處理;自動帶入電腦資訊 |
| giga-Portal 我的電腦(§4.7) | `endpoint.device.self` 類權限、電腦 ↔ 使用者對應 |
| 使用者自助安裝軟體 | 使用者端程式列出 IT 核准的軟體,經 Agent 安裝(需新權限與稽核) |
| 報表 | 資產總表、軟體授權、硬體變更、安全狀態;匯出 Excel |
| 財產與保管人資料 | 財產編號、保管人、部門(可從 portal-api 人事資料帶入);清單依部門篩選 |
| Windows 事件記錄檔 | Agent / Watchdog 同時寫 Windows Event Log,IT 既有工具也看得到 |
| 全域緊急停止 | 一個開關暫停所有指令與派送(目前只能逐台停用);需 `endpoint.software.manage` 以上權限並寫稽核 |
| 公司外網路 | 在家或 VPN 的電腦能否連 `:9443`、需要的防火牆規則;離線期間靠本機持久化 |
| 多使用者工作階段 | Windows Server / 遠端桌面主機上多個使用者端程式同時執行、各自的唯讀管道連線 |
| 規模 | 多實例(Redis pub/sub 轉送指令)、1,000 台以上 |

---

## 10. 與上位規範(指南)的差異 — 定案後修訂指南

| # | 指南現況 | 本計畫 | 處理 |
| --- | --- | --- | --- |
| 1 | §8.2 只有四個權限代碼 | 新增 `endpoint.software.manage`(軟體目錄、版本登錄、發佈環) | 修訂指南 §8.2、§8.3 |
| 2 | §8.3 指令類型沒有 `message.show` | 新增(basic) | 同上 |
| 3 | §7.1 托盤程式負責使用者介面(報修、公告) | 一致,並擴大為「使用者端程式」:我的電腦、嵌入 Gateway 網頁應用(BPM、信箱、AI 等),以使用者登入經 `:443`,與監控服務分開發版;托盤管道定為 `giganexus-agent-user-v1`(唯讀) | 修訂 §7.1、回填 E3 |
| 4 | §6.3 第 4 點「變更時增量」回報 | 仍回報完整資產,由 Server 比對產生變更事件 | 修訂 §6.3 措辭 |
| 5 | §7.4 套件下載路徑未定(E4) | `GET /agent/v1/releases/{version}/{file}`,檔案在 NAS `RustIT\releases\` | 回填 E4 |
| 6 | §6 未提本機持久化與離線紀錄 | 加密本機 store、`/sync`、`/events`、`offline_period`(§4.2) | 修訂 §6.3 補一點 |
| 7 | §8.3 指令類型 | 新增 `agent.diagnose`、`logs.collect`、`agent.log_level`(basic,A4) | 修訂 §8.3 |
| 8 | §4.2 / §5 未定義主機忙碌與最低版本 | `429` + `Retry-After`(A3)、`min_agent_version` / `AGENT_TOO_OLD`(B2) | 修訂 §4.2、§5.6 |
| 9 | §3.3 以 DN 為裝置鍵 | 不變;另加硬體指紋供 IT 確認合併(A1) | 修訂 §3.3 補一點 |

PRD(2026-09-27)中的 Rust Axum 後端、PostgreSQL、React 前端已由後續決定取代(ADR 0004、GigaItApp);托盤程式保留,改為使用者端程式(§4.8),公告後端用 BFF 通知中心;PRD 保留為需求來源,架構以本計畫與指南為準。

---

## 11. 決定事項(原待決 Q1–Q12)

| # | 問題 | 決定 |
| --- | --- | --- |
| Q1 | Demo / native 去留 | Demo 保留使用者會用的頁面,改造為使用者端程式 `desktop`;`native`(egui)移除(§3.3) |
| Q2 | 托盤程式 | 要做,屬使用者端程式,與監控服務分開;使用者關閉程式不影響監控 |
| Q3 | 軟體庫 NAS | `\\10.10.130.31\docker-folder\RustIT\software`,版本檔放 `RustIT\releases\`;NAS 帳密只給後端 |
| Q4 | 入口網「我的電腦」對應 | 先只做碩禾 AD;其他公司由 IT 手動指定保管人(路線圖) |
| Q5 | 告警是否寄 Email | 先只在 GigaItApp 顯示;之後經 BFF 通知逐人寄給 IT 值班人員 |
| Q6 | 建置與簽章 | 選項 C:Windows Runner 建置 + 人工簽章;Runner 先放主機 2(Windows 本機),吃不消再申請 Windows VM;**不放 AD 主機**(§4.9) |
| Q7 | 新權限與指南修訂 | 依 §10,定案後修訂 |
| Q8 | 發佈環 | `pilot` / `it` / `all` 起步 |
| Q9 | 健康指標 | 隨心跳 30 秒、Mongo 保存 1 天 |
| Q10 | 使用者端技術 | Tauri 2 + WebView2,平時只有托盤 |
| Q11 | 使用者端登入 | 先用 BFF 既有登入;Windows 整合式登入另案評估 |
| Q12 | BPM、信箱、AI 入口 | 各系統經 Gateway 上線後才加入口 |

---

## 12. 跨 repo 變更清單(各自動手前先取得同意)

| 對象 | 變更 | 階段 |
| --- | --- | --- |
| `giga-api-gateway-bff` | 指南修訂(§10);BFF 權限 `endpoint.software.manage`(若權限需預先建立) | P0 定案後、P4 前 |
| `GigaItApp` | 詳情 Tab、離線期間、指令按鈕與紀錄、告警、軟體派送、Agent 版本頁;`gateway-rbac.yaml` 新選單 / Tab / 按鈕與 `includes` | P2–P7 |
| 根目錄 `GigaNexusAI` | `PROJECT-MAP.md` RustIt 列、`workspace.json`(watchdog、desktop、`common`;移除 native)、甘特圖新增 P1–P8 與上線前項目 B1–B10 | P0 定案後 |
| `giga-observe` | 端點在線率驟降、同一錯誤碼暴增告警(B6) | 上線前 |
| 主機 2 | NAS(`\\10.10.130.31\docker-folder\RustIT\`)唯讀掛載進 `endpoint-server`、NAS 帳密機密(需求方執行)、`ita.env` 新設定;Windows 本機 GitLab Runner;Win10 / Win11 測試 VM(A8,若放主機 2) | P1、P6、P7 |
