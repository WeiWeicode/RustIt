# P6 升級設計

> 草案 2026-10-20,分支 `docs/p6-upgrade-design`(從 develop `56d2263` 開)。依據:PLATFORM-PLAN §4.5、§4.9、§5、§6、§7、§8 P6 列、§8 B1 / B2;指南 ENDPOINT-AGENT-GUIDE §7.1–§7.4、§8.3、§10.2 E4;ADR 0002、0003;`P5-MONITOR-DESIGN.md`(Watchdog、本機管道、`watchdog/report`)。
> **2026-10-20 需求方確認**:§9 全部照建議(測試簽章憑證、本機信任清單 P6 就做、測試區先用主機 2 本機目錄、`pilot` 未滿 24 小時回 409 + `force`、改環與版本需 `endpoint.software.manage` 且全部公司角色、執行中指令等最多 60 秒、版本號 Agent 0.7.0 / Watchdog 0.2.0、Windows Runner 在 P6-1~3 驗收後、migration 0007 先給需求方看再由 Claude 套用)。
> **進度(2026-10-20)**:P6-1 完成實作(分支 `feature/p6-1-release`):migration 0007、管理 API、下載 API、`watchdog/report` 的 `target` / `upgrade`、`agent.upgrade` 與 admin-commands 路由、升級告警;`npm test` 178/178、`test:int` 12/12(0007 已套用整合測試庫 `_poc_test`);審查後調整見 §8.1。**待辦**:migration 0007 套用 `giganexus_It_Agent_test`(需求方看過後)、合併 develop 部署測試區、Gateway OpenAPI 草稿批次發佈。
> **進度(2026-10-20,P6-2)**:P6-1 已合併 develop(MR !37)。P6-2 實作完成(分支 `feature/p6-2-watchdog-upgrade`):Watchdog 0.2.0 升級 Agent、Agent 0.7.0 `prepare_shutdown` / `agent.upgrade`、監控 MSI 0.7.0 `-TrustedSigners`、測試簽章憑證腳本;`cargo test` / `clippy` 通過、契約測試通過;子代理審查後調整見 §8.3。**待辦**:VM 驗收(§8.4,需求方執行)。
> 設計當時的現況:Agent 0.6.0、Watchdog 0.1.0(P5-2,VM `RUSTIT-P34` 驗收通過);`watchdog/report` 回應已有 `target` 欄位(一律 `null`);管道 `prepare_shutdown` 只定義、回 `unsupported`;`ita.device.agent_version`、`ita.device_health.watchdog_version` 已有;**程式碼簽章憑證未簽發(ADR 0003 建議中)、NAS `RustIT\` 未掛載、主機 2 沒有 Windows Runner**。

## 0. 分批

| 批 | 內容 | 版本 | 需要同意 |
| --- | --- | --- | --- |
| **P6-1 版本登錄與發佈環(後端)** | migration `0007_release.sql`;管理 API(版本登錄、發佈環目標版本、裝置所屬環、升級進度);Agent 下載 API(Range);`watchdog/report` 回應帶 `target`、請求帶 `upgrade` 進度;並行上限;`upgrade_failed`、`version_mismatch` 告警;`agent.upgrade` 指令(admin) | — | migration 套用 `giganexus_It_Agent_test`;版本檔目錄(§9-3);合併 develop |
| **P6-2 Watchdog 升級 Agent** | Watchdog 下載(續傳)→ 驗 SHA-256 與 Authenticode 簽章者 → 管道 `prepare_shutdown` → 停服務、舊版放 `previous\`、替換、啟動 → 2 分鐘內 `get_status` 驗證 → 失敗還原並回報;Agent 實作 `prepare_shutdown` | Agent **0.7.0**、Watchdog **0.2.0**(MSI 首次安裝到 VM) | VM 驗收;測試簽章憑證(§9-1) |
| **P6-3 Agent 升級 Watchdog、`agent.upgrade` 立即觸發** | Watchdog 下載驗證後經管道 `replace_watchdog` 交給 Agent 替換(互相升級、不覆寫自己);`agent.upgrade` 讓 Watchdog 立即上報 | 同上 | VM 驗收 |
| **P6-4 Windows Runner + 人工簽章流程** | 主機 2 Windows 本機 GitLab Runner(shell、PowerShell、tag `windows`、`concurrent = 1`);CI 手動 / tag job 產出未簽章 exe、MSI 與 SHA-256;簽章腳本、上架腳本 | — | Runner 註冊 Token 由需求方執行;`.gitlab-ci.yml` |
| **P6-5 GigaItApp「Agent 版本」頁** | 版本清單 / 登錄 / 發佈 / 撤回、發佈環目標版本與進度、裝置詳情「所屬環」與升級狀態;`gateway-rbac.yaml` | — | **GigaItApp、`gateway-rbac.yaml`:動手前另外確認**(OpenAPI 註冊、IT 發佈後才綁 `includes`) |
| P6-6 收尾 | 指南回寫(§7.3、§7.4、§8.3、E4)、`command-kinds.md`、根目錄 `workspace.json` / `PROJECT-MAP.md`、甘特圖 W6-19、測試報告、RUNBOOK 版本回滾一節(B10 先寫這段) | — | Gateway / 根目錄 repo 修改前確認 |

P6-1 先做(後端可單獨用 API 與 curl 驗證);P6-2 依賴 P6-1 的 API;P6-3 依賴 P6-2 的下載與驗證程式;P6-4 與 P6-1~3 互不依賴,**Runner 建好前用開發機建置 + 人工簽章**(PLATFORM-PLAN §4.9 選項 A,只限測試期);P6-5 在 P6-1 API 上線後可開始。

**完成標準對應**(PLATFORM-PLAN §8 P6):

| 完成標準 | 由哪一批達成 | 驗證方式 |
| --- | --- | --- |
| `pilot` 環設新版 → 10 分鐘內升級成功 | P6-1、P6-2 | VM 設為 `pilot`,登錄 0.7.1 並設為 `pilot` 目標 → Watchdog 下一次上報(≤ 5 分鐘)取得目標 → 下載、替換 → 新版 hello 上線;GigaItApp 顯示 0.7.1。Watchdog 0.2.0 → 0.2.1 同樣測一次(P6-3) |
| 故意放壞的版本 → 自動還原並回報 | P6-2 | 以 `broken-for-test` feature 建置 0.7.2(啟動即結束 / 不連 WebSocket 兩種)→ 2 分鐘內 `get_status` 不正常 → 還原 0.7.1、事件 `upgrade_failed`(`rolled_back`)、告警;同版本失敗 2 次後不再自動重試 |
| 發版檔案皆經人工簽章 | P6-2、P6-4 | 未簽章 / 簽章者不符 / SHA-256 不符的檔案都拒絕安裝並回報(三個反向測試);測試期用測試簽章憑證(§9-1) |

## 1. 資料表(`0007_release.sql`,SQL Server 2012)

> PLATFORM-PLAN §5.2 原訂 `0005_release.sql`;0005、0006 已用於 E6 公司與 P5 監測,本階段為 **0007**(§5.2 一併更正)。`desktop` 元件到 P8 才用,欄位先允許。

### `ita.agent_release` — 版本登錄

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `release_id` | `UNIQUEIDENTIFIER` PK | |
| `component` | `VARCHAR(16)` | `agent` / `watchdog` / `desktop` |
| `version` | `VARCHAR(32)` | semver;`UNIQUE (component, version)` |
| `file_name` | `NVARCHAR(128)` | 版本檔目錄下 `{component}\{version}\` 的檔名(只允許 `[A-Za-z0-9._-]`) |
| `sha256`、`size_bytes` | `CHAR(64)`、`BIGINT` | **登錄時由 Server 讀檔計算**,不接受人工輸入;下載時再比對一次,檔案被換掉就拒絕下發並記錯 |
| `signer_thumbprints` | `VARCHAR(400)` | 預期簽章者憑證 SHA-1 指紋(逗號分隔,換憑證時可同時列新舊) |
| `status` | `VARCHAR(16)` | `draft` → `published` → `revoked`;`revoked` 不可再設為目標 |
| `notes` | `NVARCHAR(1000)` | 變更說明 |
| `created_by` / `created_at`、`published_by` / `published_at`、`revoked_by` / `revoked_at` | | 工號取自內部 Token |

### `ita.release_ring` — 發佈環目標版本

| 欄位 | 說明 |
| --- | --- |
| `ring` + `component` | PK;`ring` 為 `pilot` / `it` / `all` |
| `target_version` | NULL = 不升級(維持現況);可設比目前舊的版本(降版走同一流程) |
| `updated_by` / `updated_at` | |

規則:`pilot` 可設 `draft` 或 `published`;`it`、`all` 只能設 `published`。往下一環設定時,若 `pilot` 環的同一版本設定未滿 24 小時,API 回 `409 ITA_RING_TOO_EARLY`,可帶 `force: true` 略過(寫入稽核)(§9-4)。

### `ita.device` 加欄位、`ita.device_upgrade`

- `ita.device.ring VARCHAR(16) NOT NULL DEFAULT 'all'`。
- `ita.device_upgrade`(device × component,1:1):`target_version`、`state`(`pending` / `downloading` / `verifying` / `installing` / `succeeded` / `failed` / `rolled_back`)、`attempts`(同一目標版本的失敗次數)、`error_code`、`error_message`、`started_at`、`updated_at`、`forced_by`(`agent.upgrade` 指定版本時的操作人)。
- `ita.device_health.watchdog_version` 沿用 P5;`desktop_version` 到 P8 再加。

## 2. 契約變更(只新增欄位,舊版照常運作)

### 2.1 `watchdog.schema.json`

**請求加 `upgrade`**(選填;沒有進行中的升級時省略):

| 欄位 | 說明 |
| --- | --- |
| `component`、`target_version`、`from_version` | |
| `state` | 同 `ita.device_upgrade.state` |
| `attempts`、`error_code`、`error_message` | 錯誤代碼:`DOWNLOAD_FAILED`、`HASH_MISMATCH`、`SIGNATURE_INVALID`、`SIGNER_NOT_TRUSTED`、`PREPARE_TIMEOUT`、`STOP_TIMEOUT`、`REPLACE_FAILED`、`HEALTH_CHECK_FAILED`、`ROLLBACK_FAILED`、`DISK_FULL` |

**回應 `target`**(0.1.0 忽略,不影響):

```json
{ "target": {
    "agent":    { "version": "0.7.1", "url": "/agent/v1/releases/agent/0.7.1/rustit-agent.exe",
                  "sha256": "…", "size_bytes": 7340032, "signer_thumbprints": ["…"] },
    "watchdog": null } }
```

- 某元件已是目標版本、或同版本已失敗 2 次(且沒有 `agent.upgrade` 強制)、或超過並行上限時,該元件為 `null`。
- **並行上限** `RELEASE_MAX_CONCURRENT`(預設 20):`device_upgrade.state` 在 `downloading`~`installing` 且 30 分鐘內有更新的台數達上限時,新的裝置先拿 `null`,下次上報再排。

### 2.2 `pipe.schema.json`

| type | 方向 | body | 說明 |
| --- | --- | --- | --- |
| `prepare_shutdown` / `prepare_shutdown_ack` | Watchdog → Agent | `reason: "upgrade"`、`timeout_sec` / `flushed`、`outbox_pending` | **實作**:Agent 停止接新指令、送完待送的 `command_update` 與事件(上限 20 秒)、以 1000 關閉 WebSocket 後回 ack;執行中的指令先等最多 60 秒,逾時才記 `failed` / `AGENT_UPGRADING`(§9-6;Watchdog 的 `prepare_shutdown` 等待因此為 90 秒) |
| `status`(加欄位) | Agent → Watchdog | `upgrade_requested: { component, version? }` | `agent.upgrade` 指令設定;Watchdog 看到後立即上報(不等 5 分鐘) |
| `replace_watchdog` / `replace_watchdog_ack` | Watchdog → Agent | `version`、`path`(`cache\` 內已驗證的檔案)、`sha256`、`signer_thumbprints` / `accepted` | P6-3:Agent **自行再驗一次**雜湊與簽章後才替換;Watchdog 被停止前收到 `accepted` |

管道仍只允許 SYSTEM、Administrators,並沿用 P5 的伺服端 PID 比對;`replace_watchdog` 只接受 `path` 位於 `ProgramData\GigaNexus\Agent\cache\watchdog\` 底下的檔案。

### 2.3 事件與指令

- 新事件(Watchdog 上報):`upgrade_started`、`upgrade_succeeded`(`component`、`from`、`to`、耗時)、`upgrade_failed`(`component`、`to`、`error_code`、`rolled_back`)。Agent 替換 Watchdog 的結果由 Agent 經 `/agent/v1/events` 上報(同樣三種,`component = watchdog`);路徑白名單依元件區分(P5 L1 規則延伸)。
- `agent.upgrade`(admin,`command-kinds.md`):`params: { component: "agent" | "watchdog", version?: string }`。省略 `version` = 依所屬環目標立即檢查;指定版本 = 這台強制升級 / 降版到該版本(必須 `published`,`pilot` 環裝置可用 `draft`),並重設失敗次數。Agent 回 `succeeded` 只代表「已交給 Watchdog」,實際結果看 `device_upgrade` 與事件。有效期限 1 小時。

## 3. ItAgentBack

### 3.1 模組

| 模組 | 內容 |
| --- | --- |
| `services/release-service.ts` | 版本檔目錄讀取(防路徑穿越:只允許 `{component}/{version}/{file}` 三層、正規化後必須在根目錄下)、SHA-256 計算、目標版本選擇(裝置環 → 環目標 → 強制版本 → 失敗次數 → 並行上限)、`upgrade` 進度落盤 |
| `routes/releases.ts` | 管理 API(§3.2) |
| `agent-app.ts` | `GET /agent/v1/releases/:component/:version/:file`:裝置憑證、裝置必須 `active`、該版本必須是**這台目前被指派的目標**(否則 404,不讓端點任意下載);支援 `Range` / `206`;每次下載寫一筆稽核(裝置、版本、位元組範圍彙總) |
| `services/alert-service.ts` | 新規則 `upgrade_failed`(事件類,同版本失敗 2 次開,升級成功或目標改變時自動關)、`version_mismatch`(在線且 Watchdog 正常,但環目標設定超過 24 小時仍未到目標版本) |
| `commands/kinds.ts` | `agent.upgrade`(admin) |

設定(`ita.env`):`RELEASES_DIR`(容器內唯讀掛載點,預設 `/srv/releases`)、`RELEASE_MAX_CONCURRENT=20`。

### 3.2 管理 API(`:51240`,對外 `/api/endpoint/*`)

| 方法 | 路徑 | `x-permission` | 說明 |
| --- | --- | --- | --- |
| `GET` | `/releases` | `endpoint.device.read` | 版本清單(篩選 `component`、`status`) |
| `GET` | `/releases/files` | `endpoint.device.read` | 版本檔目錄內尚未登錄的檔案(給登錄畫面挑選) |
| `POST` | `/releases` | `endpoint.software.manage` | 登錄:`component`、`version`、`fileName`、`signerThumbprints`、`notes`;Server 計算雜湊;`x-audit-level: meta` |
| `POST` | `/releases/{releaseId}/publish`、`/revoke` | `endpoint.software.manage` | 發佈 / 撤回;撤回的版本若是某環目標,該環目標改為 NULL 並回傳受影響的環;`x-audit-level: meta` |
| `GET` | `/release-rings` | `endpoint.device.read` | 各環 × 元件目標版本與進度(已到目標 / 進行中 / 失敗 / 未回報台數) |
| `PUT` | `/release-rings/{ring}/{component}` | `endpoint.software.manage` | `{ targetVersion: string \| null, force?: boolean }`;`x-audit-level: meta` |
| `PUT` | `/devices/{deviceId}/ring` | `endpoint.command.admin` | 調整裝置所屬環(PLATFORM-PLAN §5.3);`x-audit-level: meta` |
| `GET` | `/devices/{deviceId}/upgrade` | `endpoint.device.read` | 這台各元件的升級狀態(詳情頁也一併帶) |

全部依 E6 資料範圍過濾裝置;版本與環是全公司共用設定,只有 `ENDPOINT_SCOPE_ALL_ROLES` 角色能改環目標(其他回 `403 ITA_SCOPE_ALL_REQUIRED`)(§9-5)。

## 4. 版本檔目錄

- 結構:`releases\{agent|watchdog|desktop}\{version}\rustit-agent.exe`(只放**已簽章**的 exe;MSI 給首次安裝,放同層 `msi\{version}\`,Server 不下發)。
- 正式:NAS `\\10.10.130.31\docker-folder\RustIT\releases\`,`endpoint-server` 以 CIFS 唯讀掛載(帳密由需求方以機密腳本寫入主機 2,P7 軟體庫共用同一個掛載)。
- 測試區在 NAS 帳密到位前:主機 2 `/srv/giganexus/ita-releases/`(唯讀 bind mount 到 `RELEASES_DIR`),上架由需求方或 Claude 經 `ssh host2` 複製(§9-3)。

## 5. Watchdog(0.2.0)

### 5.1 新模組

| 模組 | 內容 |
| --- | --- |
| `upgrade/mod.rs` | 升級狀態機(§5.2),核心邏輯以 trait 注入 SCM / 管道 / 檔案系統 / 下載 / 簽章驗證,單元測試用假實作 |
| `upgrade/download.rs` | 下載到 `cache\{component}\{version}\*.part`,中斷後以 `Range` 續傳;完成後比對大小與 SHA-256 才改名;磁碟剩餘 < 500 MB 不下載(`DISK_FULL`);`cache\` 每個元件只保留最新 2 個版本 |
| `rustit-common::authenticode` | `WinVerifyTrust`(`WINTRUST_ACTION_GENERIC_VERIFY_V2`,鏈要到受信任的根)+ 取簽章者憑證 SHA-1 指紋;簽章者必須**同時**在主機下發的 `signer_thumbprints` 與本機信任清單內(§9-2)。Agent 的 `replace_watchdog` 與 P7 軟體派送共用 |
| `upgrade/swap.rs` | 停服務、備份、替換、啟動、還原(§5.3) |

### 5.2 升級 Agent 流程

1. 上報取得 `target.agent` → 本機記錄目標(`watchdog.db` 新表 `upgrade`:元件、目標版本、狀態、失敗次數),上報 `upgrade.state = downloading`。
2. 下載完成 → 驗 SHA-256、Authenticode、簽章者;任一失敗 → `failed`(不還原,因為還沒動),刪除檔案。
3. **維護中**(看守暫停,不把接下來的停止當成竄改)→ 管道 `prepare_shutdown`(等 90 秒;逾時照樣繼續,記 `PREPARE_TIMEOUT` 警告)。
4. 停止 `GigaNexusAgent`(沿用 P5 M2:握住行程控制代碼、等 50 秒、逾時才結束行程)。
5. `Program Files\GigaNexus\Agent\rustit-agent.exe` → `previous\rustit-agent.exe`(覆蓋上一份 previous);新檔先複製為同目錄 `rustit-agent.exe.new`、**在目的地再驗一次雜湊**,再以 `MoveFileEx(REPLACE_EXISTING)` 換上。
6. 啟動服務 → 2 分鐘內每 10 秒 `get_status`:`version` = 目標、`ws_connected = true`、PID 穩定 → `succeeded`,結束維護中,立即上報。
7. 失敗(啟動失敗、2 分鐘內不正常、版本不符)→ 停止 → `previous\` 換回 → 啟動 → 確認舊版 `get_status` 正常 → `rolled_back`;還原也失敗 → `ROLLBACK_FAILED`(critical 告警,看守恢復照常拉起)。同一目標版本失敗 2 次不再自動嘗試。
8. Watchdog 在步驟 3–7 期間自己被重啟(當機、關機):重啟後讀本機 `upgrade` 狀態,若停在 `installing` → 檢查目前 exe 版本與服務狀態,依步驟 6 / 7 收尾,不會停在半套。

### 5.3 Agent 替換 Watchdog(P6-3,Agent 0.7.0 `upgrade_watchdog.rs`)

Watchdog 完成下載與驗證後送 `replace_watchdog` → Agent 再驗一次 → 回 `accepted` → Agent 的 Watchdog 看守進入維護中 → 停止 `GigaNexusWatchdog` → 備份 / 替換(同 §5.2 步驟 5)→ 啟動 → 2 分鐘內新 Watchdog 以 SCM 的 PID 連上管道並送出 `get_status` → 成功;否則還原。結果由 Agent 經 `/agent/v1/events` 上報,新 Watchdog 的上報版本也會反映在 `watchdog_version`。

### 5.4 不做的事

- 不升級 MSI 本身(ARP 顯示的版本會停在首次安裝的版本;服務名稱、目錄變更等大改版才重派 MSI,PLATFORM-PLAN §4.5)。GigaItApp 以回報的 exe 版本為準。
- 不做差分更新、不做 P2P 分享下載(1,000 台以內、exe 約 7–10 MB,並行上限即可)。

## 6. 建置與簽章(P6-4)

| 步驟 | 誰 | 內容 |
| --- | --- | --- |
| 建置 | CI(主機 2 Windows Runner,手動 / tag `rustit-v*`) | `cargo build --release`(crt-static)、WiX 5 MSI;產出**未簽章** exe / MSI 與 `SHA256SUMS.txt`(artifact 保存 30 天);`cargo audit`(B8 先做這項) |
| 簽章 | 簽章人員(自己的電腦) | `RustAgent/installer/sign-release.ps1`:核對 `SHA256SUMS.txt` → `signtool sign /fd SHA256 /tr <時間戳記>`(時間戳記伺服器另確認,內網可能連不到)→ 驗證 → 產出已簽章檔的新 SHA-256 |
| 上架 | 簽章人員 | `publish-release.ps1`:複製到版本檔目錄 `{component}\{version}\` → GigaItApp 登錄(或 API)→ 設 `pilot` 目標 |

Runner 建好前(P6-1~3 開發期):開發機 `build-agent-msi.ps1` 建置 + 測試簽章憑證簽章(選項 A,只限測試期)。

## 7. GigaItApp(P6-5,動手前另外確認)

| 位置 | 內容 | 權限 |
| --- | --- | --- |
| 新 Tab「Agent 版本」(`it.endpoint-release.list`,電腦清單選單下) | 版本清單(元件、版本、狀態、SHA-256、簽章者、登錄 / 發佈人);登錄(從未登錄檔案挑選)、發佈、撤回按鈕 | read;按鈕 `it.endpoint-release.manage` → `endpoint.software.manage` |
| 同頁「發佈環」區塊 | 三環 × 兩元件目標版本、各環進度(到目標 / 進行中 / 失敗 / 未回報),設定目標(`pilot` 未滿 24 小時的確認對話框) | 同上 |
| 電腦詳情「健康與 Agent」Tab | 所屬環(可改,`endpoint.command.admin`)、各元件升級狀態與最後錯誤;指令「升級 Agent」(admin) | read;admin |
| 電腦清單 | 「所屬環」欄與篩選 | read |

## 8. 測試與驗證

- **ItAgentBack**:契約測試(`watchdog-report` 加 `upgrade`、回應 `target`);`release-service` 單元測試(環 → 目標、`draft` 只限 pilot、強制版本、失敗 2 次、並行上限、撤回連動、路徑穿越);下載 API(Range、非指派版本 404、停用 403、檔案被換掉);`test:int` SQL store(`giganexus_It_Agent_poc_test`)。
- **Watchdog / Agent**:升級狀態機以假實作測試(成功、下載中斷續傳、雜湊不符、簽章不符、prepare 逾時、啟動失敗還原、2 分鐘不正常還原、還原失敗、Watchdog 中途重啟收尾、同版本失敗 2 次);`authenticode` 以測試簽章檔與未簽章檔測試(只在 Windows 跑)。
- **測試區 VM**(`RUSTIT-P34`;先建檢查點「P6 前(0.6.0)」):MSI 0.7.0 首次升級 → 完成標準三項 + Watchdog 0.2.0 → 0.2.1 + 降版 0.7.1 → 0.7.0 + 升級中重開機。

## 8.1 P6-1 實作與審查後的調整(code-reviewer、security-auditor 子代理,2026-10-20)

- **admin-commands 路由**:P4 只開了 basic;P6-1 加 `POST /devices/{id}/admin-commands`(`endpoint.command.admin`,只單台;admin 批次等 B1 第二人核可一起做)。
- **強制版本只能是 published**(資安 M1):原設計「pilot 裝置可用 draft」會讓只有 `command.admin` 的人(把電腦放進 pilot 再下 `agent.upgrade`)繞過 §9-5;改為 draft 只能經 pilot 環目標下發,且**把電腦放進或移出 pilot 需全部公司角色**。其他環照 `command.admin` + 資料範圍。強制指定舊的 published 版本(單台降版)仍允許,屬 `agent.upgrade` 的用途。
- **舊版 Watchdog 不下發、不佔名額**(資安 M2):`watchdog_version` < 0.2.0 時 `target` 一律 null。名額改為:`pending`(已下發未開始)只佔 10 分鐘,`downloading` ~ `installing` 佔 30 分鐘;同時升級上限是**軟上限**(並行上報之間不加鎖,可能略為超過)。
- **失敗狀態不被覆寫**(審查必修 1):同一目標失敗 1 次時照樣下發讓 Watchdog 重試,但不把紀錄改回 `pending`(畫面看得到錯誤、重送同一失敗不重複計次);`ROLLBACK_FAILED` 一次就停止下發、告警不會被掃描關掉。
- **自報成功要核對版本**(資安 L1):`upgrade.state = succeeded` 只在回報的目前版本等於目標時採用;另一元件仍停在失敗時不關 `upgrade_failed`。
- **agent.upgrade 在建立指令前套用**:檢查通過後先記強制版本 / 重設失敗次數,再寫指令(套用失敗就不建立指令,不會卡住 `maxPending`);沒有紀錄又沒指定版本時不寫任何列。
- **下載**:416 帶 `Content-Range: bytes */大小`;`bytes=a-b` 而 a > b 時忽略 Range(RFC 9110);`release_download` 稽核同一台同一版本每小時一筆;SHA-256 同時多個請求共用一次計算,快取鍵加 ctime 與 inode。主機端複驗只是第二道防線,**端點必須自己驗**(§8.2)。
- **其他**:`saveUpgrade` 加 `UPDLOCK, HOLDLOCK`(並行寫入不撞主鍵);裝置升級狀態只查單台;`onAgentEvents` 的告警與升級各自容錯;`PUT release-rings` 可設 `null`。
- **回滾也需 force**:`it` / `all` 緊急改回舊版時,該舊版通常不是 pilot 目標滿 24 小時,要帶 `force: true`(寫入稽核)。寫進 RUNBOOK。

### 8.2 P6-2 Watchdog 必須遵守(資安 L3、L5)

- 下載檔案以 `target.sha256` 驗**整個組好的檔案**,不採信回應標頭 `x-file-sha256`;`size_bytes` 自設上限 200 MB,下載前檢查磁碟空間。
- `target.version` 必須與 `url` 的版本段一致,下載後檔案的 FileVersion 也要一致。
- 簽章者:主機下發的 `signer_thumbprints` **與**本機信任清單取交集,主機清單不能單獨放行(§9-2)。
- 只用 `agent.toml` 的 Gateway 位址與同一組 mTLS 連線下載,不跟隨重新導向。
- 告警 `detail` 含端點回報的字串(`errorMessage` 等):GigaItApp 一律以文字顯示(P6-5,與 P5 相同)。

### 8.3 P6-2 實作與審查後的調整(code-reviewer、security-auditor 子代理,2026-10-20)

實作照 §5.2;與設計不同或補充的地方:

- **版本比對用 ProductVersion**(§8.2 寫 FileVersion):兩支 exe 由 `build.rs` 寫入版本資源,FileVersion 只能是數字(`0.7.2.0`),帶後綴的版本要比字串,所以比 `ProductVersion`(與 FileVersion 字串同值)。版本可由 `RUSTIT_BUILD_VERSION` 覆寫(測試版)。不符回 `HASH_MISMATCH`(錯誤代碼列舉沒有更適合的,`error_message` 說明);目標格式不合法回 `DOWNLOAD_FAILED`。
- **不降到 0.7.0 以前**:0.6.0 讀不了含 `[upgrade]` 的 `agent.toml`(`deny_unknown_fields`),Watchdog 拒絕 `< 0.7.0` 的目標。
- **`prepare_shutdown` 逾時**只記警告、照樣停止(§5.2 第 3 步),不上報 `PREPARE_TIMEOUT`(升級可能仍成功;代碼保留給之後需要時)。
- **`upgrade_requested`** 加 `id`(指令 command_id,去重用;契約只新增欄位)。
- **`duration_ms`** 從開始(下載)算到結束(event.schema 描述已改)。
- **審查必修 1**:升級期間每次上報都送 `target`,原本結束後會立刻再跑一次,2 次失敗額度幾分鐘內就用完 → 結束後丟掉積壓的目標;任何升級失敗後 **30 分鐘冷卻**(任何版本,存 `watchdog.db` kv),主機輪流下發兩個版本也不會反覆停止 Agent(資安 M1)。`agent.upgrade` 解除冷卻並重設失敗次數(含 `ROLLBACK_FAILED`)。
- **審查建議**:已處理的 `agent.upgrade` id 存本機(Watchdog 重啟不重複重設);看守的 SCM 操作在維護中一律不動作、該輪事件丟棄,維護中結束後看守狀態重新為基準(不誤記重啟);維護中最多 20 分鐘、以 Drop 保證結束(資安 L5);不在執行中的未結束紀錄不上報;舊版本以安裝目錄 exe 的版本資源為準;雜湊與檔案複製在阻塞執行緒;中途重啟時若仍是舊版不算失敗(清掉紀錄、下次重來)、清 `.new` 殘檔;Agent 端 `abort_running` 只處理真的在執行的指令、已結束的指令不再被改狀態、「先登記執行中再檢查升級旗標」消除空隙、5 分鐘自動恢復只解除同一次收尾。
- **資安**:WinVerifyTrust 加 `WTD_CACHE_ONLY_URL_RETRIEVAL`(不依 AIA 連網,M2);還原後管道失敗但 SCM PID 穩定視為已還原(一般使用者搶建管道不會造成 `ROLLBACK_FAILED`,M3);下載錯誤內容最多讀 8 KB(M4);先檢查目標再寫紀錄 / 日誌,主機字串去控制字元(L1);下載前要「500 MB + 檔案大小」、每次開始先清其他版本(L2);`cache\` 是 junction / 連結或 ACL 套用失敗就停用升級(L4);`agent.upgrade` 的 command_id 上限 64 字(L6)。
- **未處理(列入後續)**:驗證時以同一個 handle 算雜湊與驗簽(L3,cache 只有 SYSTEM / Administrators 可寫,目前以 `.new` 再驗雜湊為第二道);本機最低版本下限、壞版本改用只在測試 VM 信任的另一張憑證、撤銷檢查與 SHA-256 指紋(L7,上線前);測試憑證金鑰保護、`-Env prod` 拒絕測試指紋、驗收後移除 VM 的測試根憑證(L8);`protect_dir` 設擁有者;下載寫檔仍在 async 工作內(每塊幾 KB)。

### 8.4 P6-2 VM 驗收步驟(`RUSTIT-P34`;VM 內指令由需求方執行)

**前置**

1. P6-1 已在測試區(develop 部署);Gateway OpenAPI 草稿批次已發佈(`/api/endpoint/releases`、`/release-rings`、`/devices/{id}/ring`、`/admin-commands`),否則經 BFF 呼叫會 404。
2. 主機 2 建 `/srv/giganexus/ita-releases/{agent,watchdog}/`(`RELEASES_DIR` 唯讀掛載,§4、§9-3)。
3. **開發機(需求方)**:`installer\new-test-signing-cert.ps1` → 記下 SHA-1 指紋 `<T>`,公鑰 `dist\signing\GigaNexus-Test-CodeSigning.cer`(私鑰不離開這台電腦)。
4. 開發機:`build-agent-msi.ps1 -Env test … -TrustedSigners <T>` → `GigaNexusAgent-0.7.0-test.msi`(Agent 0.7.0 + Watchdog 0.2.0);
   `build-test-release.ps1 -Version 0.7.1 -Thumbprint <T>`、`-Version 0.7.2-broken -Features broken-no-ws`、`-Version 0.7.3-broken -Features broken-exit`(壞版本的版本號要不同,失敗次數依版本計)。
5. 升級檔複製到主機 2 `/srv/giganexus/ita-releases/agent/<版本>/rustit-agent.exe`;GigaItApp 尚無畫面(P6-5),以瀏覽器 Console 經 BFF 呼叫:`POST /api/endpoint/releases`(`component: agent`、`version`、`fileName: rustit-agent.exe`、`signerThumbprints: [<T>]`)→ `POST …/{releaseId}/publish`(0.7.1;壞版本可留 draft,只經 pilot 環)。

**VM**

| # | 步驟 | 通過條件 |
| --- | --- | --- |
| 0 | 建檢查點「P6 前(未安裝)」;複製 `.cer` 到 VM → 系統管理員 PowerShell:`Import-Certificate -FilePath .\GigaNexus-Test-CodeSigning.cer -CertStoreLocation Cert:\LocalMachine\Root`(與 `TrustedPublisher` 各一次)→ 刪除 VM 上的 `.cer` 複本可留 | `Get-AuthenticodeSignature`(對 0.7.1 檔)為 `Valid` |
| 1 | `msiexec /i GigaNexusAgent-0.7.0-test.msi /qn /l*v install.log` | 兩個服務執行中;`Get-Content C:\ProgramData\GigaNexus\Agent\agent.toml` 有 `[upgrade] trusted_signers`;GigaItApp 顯示 Agent 0.7.0、Watchdog 0.2.0;建檢查點「P6-2 0.7.0」 |
| 2 | 主機:`PUT /api/endpoint/devices/de87bce2…/ring` `{ ring: "pilot" }`、`PUT /api/endpoint/release-rings/pilot/agent` `{ targetVersion: "0.7.1" }` | 10 分鐘內(上報 ≤ 5 分鐘 + 下載 + 2 分鐘檢查):`(Get-Item 'C:\Program Files\GigaNexus\Agent\rustit-agent.exe').VersionInfo.ProductVersion` = 0.7.1、`previous\rustit-agent.exe` 為 0.7.0;`GET /api/endpoint/devices/{id}/upgrade` `succeeded`;事件 `upgrade_started` / `upgrade_succeeded`;**沒有** `agent_service_stopped` / `agent_tampered`(維護中) |
| 3 | pilot 目標改 `0.7.2-broken`(不連 WebSocket) | 約 2 分鐘後還原 0.7.1;`rolled_back` / `HEALTH_CHECK_FAILED`、事件 `upgrade_failed`(`rolled_back: true`);冷卻 30 分鐘後(或下 `agent.upgrade` 立即)再試一次仍失敗 → `attempts = 2` 後不再下發、告警 `upgrade_failed` |
| 4 | pilot 目標改 `0.7.3-broken`(啟動即結束) | 同 3(還原 0.7.1) |
| 5 | 反向:①未簽章 0.7.4(`$env:RUSTIT_BUILD_VERSION='0.7.4'; cargo build --release -p rustit-agent --target-dir target\rel-0.7.4`,不跑簽章腳本)②0.7.5 以另一張自簽憑證簽章(第二張只匯入 VM 的 Root,不列入 `trusted_signers`;登錄時 `signerThumbprints` 填第二張的指紋)。SHA-256 不符由主機下載前複驗擋下、端點驗證由單元測試涵蓋 | ① `SIGNATURE_INVALID` ② `SIGNER_NOT_TRUSTED`;Agent 都沒有被停止(`previous\` 未變、沒有 `prepare_shutdown`) |
| 6 | `agent.upgrade` 指令(`POST /api/endpoint/devices/{id}/admin-commands` `{ kind: "agent.upgrade", params: { component: "agent" } }`) | 指令 `succeeded`、`result.handed_to_watchdog = true`;Watchdog 日誌「收到 agent.upgrade…立即上報」,失敗次數重設 |
| 7 | 降版:pilot 目標改 `0.7.0`(需先登錄 0.7.0 簽章檔) | 換回 0.7.0 並 `succeeded` |
| 8 | 升級中重開機:設新目標,看到 `installing`(Watchdog 日誌「開始升級」後、`previous\` 寫入時)立即 `Restart-Computer -Force` | 開機後 Watchdog 日誌「上一次升級…中斷,收尾中」,最後 `succeeded` 或 `rolled_back`,Agent 執行中、沒有停在半套 |
| 9 | 升級時有執行中的指令(下 `logs.collect` 後立即觸發升級) | 指令完成或 60 秒後 `failed AGENT_UPGRADING`;升級照常 |

查看:VM `C:\ProgramData\GigaNexus\Agent\logs\watchdog-*.log`、`agent-*.log`(`-Encoding UTF8`,系統管理員);主機 `ita.device_upgrade`、`ita.device_event`。驗收後還原檢查點或解除安裝。

## 9. 要你決定的事

1. **簽章憑證**:IT 的 AD CS 程式碼簽章憑證(ADR 0003)尚未簽發。測試期用自簽測試憑證(`New-SelfSignedCertificate -Type CodeSigningCert`,私鑰只在你的電腦;公鑰匯入 VM 的 `LocalMachine\Root` 與 `TrustedPublisher`),正式憑證到位後換指紋即可。(建議:同意;另請 IT 開始申請正式憑證,這是上線前必要項目)
2. **本機信任簽章者清單**(B1 第二道防線):P6 先做「主機下發的指紋 ∩ 本機清單」,本機清單由 MSI 寫入 `agent.toml` 的 `[upgrade] trusted_signers`(ACL 只有 SYSTEM、Administrators),上線前改由 GPO 寫 `HKLM\SOFTWARE\Policies\GigaNexus\Agent`(兩處都讀,原則優先)。/ P6 只比對主機下發的指紋,本機清單延到 B1。(建議:P6 就做,主機被入侵也不能推任意程式)
3. **版本檔目錄**:NAS 帳密到位前,測試區先用主機 2 本機目錄 `/srv/giganexus/ita-releases/`;NAS 掛載等你提供帳密後與 P7 一起做。(建議:同意)
4. **環的推進限制**:`pilot` 未滿 24 小時就設 `it` / `all` → API 回 409、可帶 `force` 略過並記稽核。/ 不限制,只在畫面提示。(建議:409 + force)
5. **誰能改發佈環與版本**:`endpoint.software.manage` **且**全部公司角色(`ENDPOINT_SCOPE_ALL_ROLES`),因為環是全公司共用。/ 只要 `endpoint.software.manage`。(建議:兩者都要)
6. **升級時執行中的指令**:`prepare_shutdown` 時執行中的指令記 `failed` / `AGENT_UPGRADING`(IT 可重下)。/ 等執行中的指令結束(最多 5 分鐘)再升級。(建議:等 `logs.collect` 這類短指令最多 60 秒,逾時才記 `AGENT_UPGRADING`)
7. **版本號**:Agent 0.7.0、Watchdog 0.2.0(P6-2 / P6-3 一起發);測試用 0.7.1 / 0.7.2(壞版)/ Watchdog 0.2.1。(建議:同意)
8. **Windows Runner(P6-4)時程**:與 P6-1~3 並行,現在就在主機 2 裝(需要你執行 Runner 註冊,並在主機 2 安裝 VS Build Tools、Rust、WiX 5)。/ P6-1~3 驗收後再做。(建議:P6-1~3 驗收後再做,避免同時改主機 2 影響測試區)
9. migration 0007 寫好後先給你看,由 Claude 經同意套用 `giganexus_It_Agent_test`(同 P5)。

PLATFORM-PLAN 要配合修正的地方(確認後與 P6-1 一起改):§5.2 `0005_release.sql` → `0007_release.sql`(加 `device_upgrade`);§4.5 補「並行上限」「24 小時推進限制」「本機信任清單」;§6 `pipe.schema.json` 加 `replace_watchdog`。
