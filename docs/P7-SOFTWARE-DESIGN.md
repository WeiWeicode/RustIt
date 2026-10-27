# P7 軟體派送設計

> 草案 2026-10-20,分支 `docs/p7-software-design`(從 develop `948adf1` 開,P6-2 已合併)。依據:PLATFORM-PLAN §4.4、§4.6、§4.10 A6、§5、§8 P7 列、§8 B1;[ADR 0002](decisions/0002-software-deployment.md)(採方案 B)、[ADR 0003](decisions/0003-code-signing-pki.md);`P4-COMMAND-DESIGN.md`(指令通道、批次);`P6-UPGRADE-DESIGN.md`(`authenticode`、本機信任清單、版本檔目錄、下載 API 模式);`contracts/command-kinds.md`。
> **狀態**:2026-10-20 需求方確認 §9 全部:第 2 項依建議(未簽章套件由公司憑證加簽),第 11 項先用需求方自己的本機電腦(開發機)加 VM `RUSTIT-P34`,另一台 IT 同意的電腦之後再補;其餘照建議。可開工 P7-1。
> **進度(2026-10-21,P7-1 後端完成、待 MR)**:P6 已於 2026-10-21 完成,P7 接續。分支 `feature/p7-1-software-catalog`(worktree `../RustIt-p7-1`)已推到 gitlab / origin,**MR 尚未開**。P7-1 後端實作完成:migration 0008(**只套用整合測試庫 `_poc_test`**)、軟體目錄與兩人覆核、`software.*` / `system.reboot` 指令與參數快照、套件下載、批次第二人核可與累計核可、全域並行上限、三個告警規則;需求方 2026-10-21 決定 D1~D6 全部照建議、資安稽核(重跑)已修大部分項目(§8.1.1)。測試:`npm test` 210/210、`test:int` 13/13、typecheck 通過(報告 `test-reports/2026-10-21-p7-1-backend.md`)。下一步:主工作階段處理 code-reviewer 結果後開 MR(HANDOFF §2 1-6)。
> **進度(2026-10-22,P7-2 Agent 程式完成、VM 驗收待做)**:P7-1 已合併(MR !50)並上測試區(migration 0008 已套 `giganexus_It_Agent_test`、Gateway OpenAPI v56 已發佈、主機 2 `ita-software` 已唯讀掛載)。P7-2 Agent `software` 模組(0.9.0)完成於分支 `feature/p7-2-agent-software`(最新 `f3af32d`,**MR 尚未開**):`software.install` / `software.uninstall`、A6 電池 / 計量網路延後;已通過 code-reviewer 與 security-auditor 並修正;`cargo test -p rustit-agent` 116/116。需求方 2026-10-22 決定 C2(draft 套件也須在本機 `trusted_signers` 內)、H1、H2、M3(見 §8.1.2);**M3 已完成**(`b9242d6`,`agent.toml` `[software] trusted_signers`)。**P7-3 Agent 端完成**(`system.reboot`、`system.reboot.cancel`、`reboot_policy required`;`8c8a63f`、`b9032d8`、`1b383f7`,見 §8.1.3)。下一步:MSI 0.9.0 發版(建置帶 `-SoftwareSigners`)、開 P7-2 / P7-3 MR、VM 驗收(VM `agent.toml` 的 `[software] trusted_signers` 要加 7-Zip 測試簽章者與 Notepad++ 簽章者指紋)。
> **進度(2026-10-27,VM 驗收修正、Agent 0.9.2)**:VM 驗收(§8.3)做到 #1、#2 時發現的問題,需求方 2026-10-27 決定先修程式再完整驗收:套件安裝逾時(migration 0009)、舊版升級(版本比對)、上架腳本防呆、禁止 `REMOVE=ALL`、安裝後等待理會關機、GigaItApp 判斷值不預填與發佈按鈕依角色停用。分支 `feature/p7-acceptance-fixes`(RustIt、GigaItApp),細節見 §8.1.4;**migration 0009 只寫未套用測試區**(需求方先看)。
> 設計當時的現況:Agent 0.7.0、Watchdog 0.2.0(P6-2 已合併 develop);`rustit-common::authenticode`(WinVerifyTrust + 簽章者指紋)與 `agent.toml` `[upgrade] trusted_signers` 已有;`ita.command_batch` 已有 `requires_approval` / `approved_by_*` 欄位(P4 預留、無邏輯);`kindHooks`、批次 `max_concurrent` 補送(`refillBatch`)已有;`ita.device_software`(P3)有每台最新軟體清單;**NAS `RustIT\` 未掛載、軟體目錄與 `software.*` 指令都還沒有**。`RustAgent/crates/demo/src/deploy.rs`(536 行,Firefox / WinRAR 單機版)是移植來源。

## 0. 分批

| 批 | 內容 | 版本 | 需要同意 |
| --- | --- | --- | --- |
| **P7-1 軟體目錄與下載(後端)** | migration `0008_software.sql`;`software-service`(目錄、狀態機、兩人覆核);管理 API(登錄、測試完成、發佈、撤回、挑檔);Agent 下載 API `GET /agent/v1/packages/{packageId}`(Range、僅限被指派);`software.install` / `software.uninstall` 指令類型(admin、參數快照);派送 API(單台、批次)與授權數檢查 | — | migration 套用 `giganexus_It_Agent_test`;軟體庫目錄(§9-3);合併 develop |
| **P7-2 Agent `software` 模組** | 從 `deploy.rs` 移植:下載(續傳、本機快取)→ 驗 SHA-256 與簽章者 → 靜默安裝 / 移除(SYSTEM、逾時、1618 重試)→ 輪詢登錄檔確認 → 立即重新蒐集;A6 電池 / 計量網路延後;回報簽章者(測試機用) | Agent **0.9.0** | VM 驗收;測試簽章憑證沿用 P6 |
| **P7-3 `system.reboot` 與批次核可** | `system.reboot`(先提示使用者、可延後、強制期限);批次第二人核可(B1:> 20 台);`3010` 之後的 `reboot_required` 顯示與一鍵重開機 | Agent 0.9.0 | VM 驗收 |
| **P7-4 NAS 唯讀掛載** | `endpoint-server` 以 CIFS 唯讀掛載 `RustIT\`(`releases\` 與 `software\` 共用);正式區 `main` 部署前必須完成 | — | NAS 帳密機密腳本由需求方執行(AI 不經手);`docker-compose.yml`、主機 2 修改 |
| **P7-5 GigaItApp「軟體派送」頁** | 軟體目錄 / 派送工作兩個 Tab;電腦詳情「派送軟體」「重新開機」按鈕;`gateway-rbac.yaml` | — | **GigaItApp、`gateway-rbac.yaml`:動手前另外確認**(OpenAPI 註冊、IT 發佈後才綁 `includes`) |
| P7-6 收尾 | 指南回寫(§8.3 指令類型、§5 套件下載)、`command-kinds.md`、根目錄 `workspace.json` / `PROJECT-MAP.md`、甘特圖 W6-20、測試報告、RUNBOOK「軟體派送失敗處理」 | — | Gateway / 根目錄 repo 修改前確認 |

P7-1 先做(後端可單獨用 API 與 curl 驗證);P7-2 依賴 P7-1 的下載與指令參數;P7-3 依賴 P7-2 的 Agent 指令執行;P7-4 與 P7-1~3 互不依賴(測試區先用本機目錄,§4);P7-5 在 P7-1 API 上線後可開始。

**完成標準對應**(PLATFORM-PLAN §8 P7):

| 完成標準 | 由哪一批達成 | 驗證方式 |
| --- | --- | --- |
| 對 3 台 IT 電腦派送 7-Zip(MSI)與 Notepad++(Inno),再移除;每台狀態與結束代碼正確 | P7-1、P7-2 | 測試機(VM `RUSTIT-P34` + 另 2 台 IT 同意的電腦)登錄兩個套件 → 測試機驗證 → `tested` → 第二人 `published` → 派送;每台 `succeeded`、`exit_code = 0`;資產出現 `software_installed` 事件;`software.uninstall` 後出現 `software_removed`,詳細步驟 §8.3 |
| 雜湊不符時拒絕安裝 | P7-2 | 換掉 `software\` 內檔案(主機複驗擋下一次;再以 Agent 單元測試與「繞過主機複驗」的測試參數驗端點自己驗)→ `HASH_MISMATCH`,沒有啟動安裝程式 |
| 簽章者不在本機信任清單時拒絕安裝 | P7-2 | 套件簽章者已在主機 `signer_thumbprints`、但不在 VM `agent.toml` `[software] trusted_signers` → `SIGNER_NOT_TRUSTED` |
| 派送中斷線,重連後結果正確 | P7-2 | 安裝中停用 VM 網卡 → 安裝完成後結果存本機 → 重連補送 `command_update`,主機最終 `succeeded`(沿用 P4 去重與補送) |

## 1. 資料表(`0008_software.sql`,SQL Server 2012)

> PLATFORM-PLAN §5.2 原訂 `0006_software.sql`;0005~0007 已被 E6、P5、P6 使用,本階段為 **0008**(§5.2 一併更正)。

### `ita.software_package` — 軟體目錄

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `package_id` | `UNIQUEIDENTIFIER` PK | |
| `name` / `version` | `NVARCHAR(100)` / `NVARCHAR(50)` | 顯示名稱與版本;`UNIQUE (name, version)`。同一軟體的不同版本是不同的列(新版有問題可切回舊版,ADR 0002) |
| `file_name` | `NVARCHAR(260)` | 軟體庫 `software\` 之下的**相對路徑**,固定三層 `{軟體}\{版本}\{檔名}`;每層只允許 `[A-Za-z0-9._ -]`(不含 `..`、路徑分隔、冒號) |
| `sha256` / `size_bytes` | `CHAR(64)` / `BIGINT` | **登錄時由 Server 讀檔計算**,不接受人工輸入;下載時再比對一次,檔案被換掉就拒絕下發並記錯。大小上限 `SOFTWARE_MAX_BYTES`(預設 4 GB) |
| `installer_type` | `VARCHAR(16)` | `msi` / `inno` / `nsis` / `burn` / `exe`(其他);決定參數範本與 Agent 的執行方式 |
| `install_args` | `NVARCHAR(500)` | 靜默安裝參數,依類型帶範本(MSI 的 `/qn /norestart` 與 `/i 檔案` 由 Agent 組,這裡只放額外屬性,例如 `ALLUSERS=1`);見 §2.3 的字元限制 |
| `uninstall_args` | `NVARCHAR(500)` | 靜默移除額外參數(`QuietUninstallString` 不存在時補上,例如 NSIS `/S`、Inno `/VERYSILENT`) |
| `detect_type` / `detect_value` | `VARCHAR(16)` / `NVARCHAR(400)` | 「已安裝」判斷:`msi_product_code`(`{GUID}`)或 `display_name`(登錄檔 Uninstall 的 DisplayName,`LIKE` 樣式,`%` 為萬用字元)。安裝後確認與移除輪詢都用它;MSI 產品代碼登錄時由 Server 嘗試讀出(失敗則由 IT 填) |
| `reboot_policy` | `VARCHAR(16)` | `never`(預設,3010 也只標記)/ `required`(已知必須重開機,顯示提示) |
| `timeout_sec` | `INT` | 安裝 / 移除程式的逾時(秒),300–7200,預設 1800(**0009**,2026-10-27 VM 驗收 B-1;CHECK `ck_software_package_timeout`)。修改不退回 `draft`(不改變執行內容,與授權數、說明相同) |
| `signer_thumbprints` | `VARCHAR(400)` | 預期簽章者憑證 SHA-1 指紋(逗號分隔,可同時列新舊);`tested` 之前可為 NULL |
| `observed_signers` | `VARCHAR(400)` | 測試機 Agent 回報的實際簽章者(`software.install` 的 `result.signer`),供 IT 確認後寫入 `signer_thumbprints`(§3.3) |
| `license_limit` | `INT NULL` | 授權數;NULL = 不限。已安裝數由 `ita.device_software` 比對(§3.4) |
| `status` | `VARCHAR(16)` | `draft` → `tested` → `published` → `revoked`(見 §3.2) |
| `notes` | `NVARCHAR(1000)` | 說明(來源網址、授權、已知問題) |
| `created_by` / `created_at`、`tested_by` / `tested_at`、`published_by` / `published_at`、`revoked_by` / `revoked_at` | | 工號取自內部 Token;**`published_by` 必須不同於 `created_by`**(ADR 0002 兩人覆核) |

### `ita.command_batch`(沿用 0003,P7 補邏輯)

`requires_approval`、`approved_by_emp`、`approved_by_name`、`approved_at` 欄位已有;P7 補狀態:批次加 `state`(`pending_approval` / `running` / `done` / `rejected` / `expired`)。0003 的 `ita.command_batch` 沒有 `state` 欄(指令的 `queued` 在批次未核可時不補送),由 0008 補 `ALTER TABLE`。

### 其他

- `ita.command.params` 已原樣保存(P4:參數不得含機密);`software.install` 的參數快照也放這裡,供稽核與重連補送。
- 不另建「安裝狀態表」:裝了什麼以資產(`device_software`)為準,派送結果以指令紀錄為準,避免兩份真相不一致。
- 軟體組合(ADR 0002 的「業務部標準組合」、綁 OU 自動安裝)**不做**,留路線圖(§7)。

## 2. 契約變更(只新增,舊版 Agent 回 `UNSUPPORTED_COMMAND`)

### 2.1 指令類型(`command-kinds.md`)

| kind | 等級 | 有效 / 逾時 | 串行 | 每台上限 |
| --- | --- | --- | --- | --- |
| `software.install` | admin | 24 小時 / 4 小時 | 是 | 3 筆未結束 |
| `software.uninstall` | admin | 24 小時 / 1 小時 | 是 | 3 筆未結束 |
| `system.reboot` | admin | 4 小時 / 30 分鐘 | 是 | 1 筆未結束 |

> 逾時:安裝本身 30 分鐘,但含下載(大檔、頻寬受限)與 A6 延後下載,整體給 4 小時;超過仍未到終態,主機設 `failed TIMEOUT`。有效期限 24 小時 = Agent 離線太久回來就不再執行過期的安裝。`maxPending` 3 筆讓一次派 2~3 個軟體可以排隊,同類型超過回 `409 ITA_COMMAND_LIMIT`。

### 2.2 `software.install` 參數(Server 建立時從目錄產生的**快照**)

IT 只送 `{ packageId }`;Server 建立指令時查目錄(必須 `published`,測試機例外見 §3.2),把下列快照寫入 `params`。**Agent 只信任指令內的快照,不接受其他來源的安裝參數**。

| 欄位 | 說明 |
| --- | --- |
| `package_id`、`name`、`version` | |
| `url` | `/agent/v1/packages/{packageId}`(Agent 以同一組 mTLS 連線下載,不跟隨重新導向) |
| `sha256`、`size_bytes` | 驗整個檔案 |
| `installer_type`、`install_args` | 見 §2.3 |
| `signer_thumbprints` | 預期簽章者;`draft` 套件在測試機上為空 → Agent 仍須簽章有效(`Valid`)、回報實際簽章者,且**簽章者仍須在本機 `[software] trusted_signers` 內**(C2,需求方 2026-10-22 決定,見 §5.2、§8.1.2);**不採信空清單放行**(見 §3.3) |
| `detect` | `{ type, value }` |
| `timeout_sec` | 安裝 / 移除逾時:套件的 `timeout_sec`(300–7200,預設 1800;0009)。Agent 照下發值執行,沒帶時 1800(舊主機);主機的指令逾時 = 類型逾時 + 超過 1800 的部分(`commandTimeoutSec`) |
| `reboot_policy` | |

### 2.3 安裝參數的限制(防止把「靜默參數」變成任意程式執行)

`install_args` / `uninstall_args` 由 IT 輸入,風險等於可在全公司電腦以 SYSTEM 執行指令,所以(D3,2026-10-21 需求方同意;資安稽核 H2):

- Agent 一律 `CreateProcess` 直接執行**已驗證的下載檔案**(MSI 是 `msiexec.exe /i <檔> …`),**不經 `cmd.exe` / PowerShell**;不使用 shell 展開。
- 參數字元白名單:`[A-Za-z0-9 /\-_=.:,"{}%()+]`,不含 `& | ; < > ^ \` $ \ @ [ ] ~ ?` 與換行;路徑一律用 `/`;`( )` 只為 `Program Files (x86)`,`+` 為資料夾名稱(`Notepad++`);長度 ≤ 500;主機建立與登錄時驗,Agent 執行前再驗一次,不符 `INVALID_PARAMS`。
- **依 `installer_type` 逐一檢查每個參數**(斷詞後):引號只能包住整個值;MSI 只接受「屬性=值」(`/qn`、`/norestart`、記錄檔由 Agent 加上);其他類型的開關比對禁止清單。
- **禁止讀寫外部檔案或改變安裝方式**:屬性 `TRANSFORMS*`、`PATCH*`、`MSIPATCHREMOVE`、`SOURCELIST` / `INSTALLSOURCE` / `ADDSOURCE`、`REINSTALL*`、`REBOOT`、`ARPSYSTEMCOMPONENT`、`*FILE`、`CONFIG*`、`PIDKEY` 等;開關 `/l*`、`/log`、`/loadinf`、`/saveinf`、`/f1`、`/v`、`/i`、`/p`、`/y`、`/update`、`/layout`、`/uninstall`、`-burn.*`、Inno `/SILENT` `/PASSWORD`、NSIS `/NCRC` 等。完整清單與邊界案例以測試向量為準。
- **路徑值**:禁止 UNC(`//`)、`..`、根目錄與相對路徑、替代資料流(`:`);磁碟機路徑只允許 `C:/Program Files/`、`C:/Program Files (x86)/` 底下;`{ }` 只能用於 GUID(MSI 產品代碼);NSIS 的 `/D=` 必須放最後、不加引號。
- 不允許把參數指到其他檔案(出現 `.msi` / `.exe` / `.mst` / `.inf` / `.iss` / `.ini` / `.xml` / `.txt` / `.log` / `.reg` / `.cfg` / `.json` 等副檔名一律拒絕)。
- **測試向量**:[`contracts/install-args.vectors.json`](contracts/install-args.vectors.json)(`valid` / `invalid` 兩組,含 `installer_type`)。ItAgentBack `argsErrors(field, value, installerType)` 與 Agent(P7-2)吃同一份,Agent 端實作必須通過全部向量。
- 這兩個欄位與簽章者一起,屬於「第二人覆核」要看的內容(§3.2);修改後覆核人規則見 §8.1.1 D2-2。

### 2.4 `result` 與錯誤代碼

`result`(序列化後 4,000 字元內):`{ "exit_code": 0, "reboot_required": false, "signer": "<SHA-1 指紋>", "signer_subject": "<CN>", "duration_ms": 41200, "detected": true, "already_installed": false, "log_tail": "<最後 20 行,遮罩後>" }`(移除:`already_absent`)。`log_tail` 來自安裝記錄(MSI `/l*v`),經 `logs.collect` 同一套遮罩。

新增 `command_update.error_code`:

| 代碼 | 說明 |
| --- | --- |
| `DOWNLOAD_FAILED`、`HASH_MISMATCH`、`SIGNATURE_INVALID`、`SIGNER_NOT_TRUSTED`、`DISK_FULL` | 與 P6 同義(寫入 `command-kinds.md`) |
| `INSTALL_FAILED` | 安裝程式結束代碼不是成功碼;`result.exit_code` 帶值 |
| `INSTALL_TIMEOUT` | 超過 `timeout_sec`,已結束安裝程式的行程樹 |
| `INSTALL_BUSY` | 結束代碼 1618(另一個安裝進行中),重試 3 次(間隔 60 秒)仍失敗;0.9.3 起另含執行 msiexec 前 Windows Installer 仍在執行、等 15 分鐘仍未空閒(未啟動,§8.1.5) |
| `DETECT_FAILED` | 結束代碼成功,但登錄檔找不到(安裝)或仍存在(移除,輪詢 120 秒)該項目 |
| `UNINSTALL_NOT_SUPPORTED` | 找得到項目,但沒有可用的移除指令(沒有 `UninstallString`,目錄也沒有 `uninstall_args`) |
| `DEFERRED_TIMEOUT` | A6:電池 / 計量網路延後超過上限(§5.4) |

結束代碼成功集合:`0`;`3010`、`1641` = 成功且 `reboot_required = true`;`1638`(MSI 已安裝同版本)視為 `already_installed`、`succeeded`。其餘為 `INSTALL_FAILED`。

### 2.5 `system.reboot`

`params`:`delay_sec`(預設 300,0–86400:給使用者儲存工作的時間)、`message`(≤ 200 字,選填,安全文字規則同 `message.show`)、`force`(預設 `false`)。流程見 §5.5。

## 3. ItAgentBack

### 3.1 模組

| 模組 | 內容 |
| --- | --- |
| `services/software-files.ts` | 軟體庫讀取。**沿用 `release-files.ts` 的做法並抽出共用部分**:三層路徑、realpath 後必須在根目錄下、SHA-256 串流計算與快取(鍵含 ctime、inode、size)。根目錄 `SOFTWARE_DIR`(預設 `/srv/software`) |
| `services/software-service.ts` | 目錄 CRUD、狀態機(§3.2)、授權數檢查(§3.4)、派送(建立指令與批次)、`software.install` 的 kindHook(查目錄、產生參數快照、驗證目標與狀態) |
| `routes/software.ts` | 管理 API(§3.5) |
| `agent-app.ts`(續) | `GET /agent/v1/packages/:packageId`(§3.3) |
| `commands/kinds.ts` | 三個新類型與 params schema(§2) |
| `services/command-dispatcher.ts` | 批次核可閘門(§6)、`refillBatch` 加「全域並行上限」`SOFTWARE_MAX_CONCURRENT`(預設 20,跨批次)|
| `services/alert-service.ts` | 新規則 `software_install_failed`(同一台同一套件失敗 → 開;重新派送成功時自動關)、`reboot_pending`(`reboot_required` 超過 7 天仍未重開機)|

設定(`ita.env`):`SOFTWARE_DIR`(容器內唯讀掛載點;未設定不啟用軟體派送)、`SOFTWARE_MAX_BYTES`(4 GB)、`SOFTWARE_MAX_CONCURRENT`(20)、`BATCH_APPROVAL_THRESHOLD`(20)。

### 3.2 狀態機與覆核

```
draft ──(測試機安裝成功,IT 確認簽章者)──► tested ──(第二人)──► published ──► revoked
  │                                          │                       ▲
  └──(只能派到 pilot 環裝置)                  └─ 可退回 draft         └─ 撤回後不可再派送,已派送的指令不受影響
```

| 動作 | 條件 | 權限 |
| --- | --- | --- |
| 登錄(`draft`) | 檔案在軟體庫、未登錄過;Server 算雜湊、驗 §2.3 字元限制 | `endpoint.software.manage` |
| `draft` 派送 | **只能派到 `pilot` 環的裝置**(沿用 P6:放進 / 移出 pilot 需全部公司角色);不計授權數 | `endpoint.command.admin` + `endpoint.software.manage` |
| 標記 `tested` | 該套件在某台 `pilot` 裝置有 `succeeded` 的 `software.install` 且 `detect` 通過;**IT 填入的 `signerThumbprints` 必須等於該次回報的 `observed_signers` 之一**(防止手誤與事後亂填);同時會記錄 `tested_by` | `endpoint.software.manage` |
| 發佈(`published`) | 狀態為 `tested`;**`published_by` ≠ `created_by`**(第二人);發佈時畫面顯示完整 `install_args`、`uninstall_args`、`signer_thumbprints`、檔案大小與雜湊讓覆核者確認 | `endpoint.software.manage` |
| 修改欄位 | 只有 `draft` 可改安裝參數、偵測規則、簽章者;`tested` / `published` 要改就**退回 `draft`**(清除 `tested_*` / `published_*`,已發佈版本改參數等於新的覆核) | `endpoint.software.manage` |
| 撤回(`revoked`) | 立即不能再被派送;已 `queued` 但尚未送出的指令被取消 | `endpoint.software.manage` |

**簽章者為什麼不只靠 IT 填**:Linux 的 endpoint-server 不解析 Authenticode(PLATFORM-PLAN §4.6),實際簽章者由測試機 Agent 回報,IT 確認(通常核對廠商憑證主體)後才寫入預期值。

### 3.3 下載 API:`GET /agent/v1/packages/{packageId}`

比照 P6 `releases` 下載,`:9443` mTLS、裝置憑證:

- 裝置必須 `active`;該裝置必須有一筆**尚未結束**(`sent` / `acked` / `running`)且 `params.package_id` 相同的 `software.install` 指令 → 否則 `404`(端點不能任意下載軟體庫的檔案)。
- 套件狀態:`published`,或 `draft` / `tested` 且該裝置在 `pilot` 環;`revoked` → `404`。
- 回應前複驗 SHA-256(與 `ita.software_package.sha256` 比對,檔案被換掉 → `503 ITA_PACKAGE_CHANGED` 並寫告警);支援 `Range` / `206` / `416`(`Content-Range: bytes */大小`);回應標頭 `x-file-sha256` 僅供除錯,**端點不採信**。
- 稽核 `package_download`:同一台同一套件每小時一筆(裝置、套件、位元組彙總)。
- 大檔頻寬:Nginx 該路徑加 `proxy_buffering off`、`proxy_request_buffering off`,單檔 `client_max_body_size` 不影響下載;下載限速 `limit_rate`(預設不限,正式區視 NAS 與網路決定,§9-8)。**Gateway 的 Nginx 設定在 Gateway repo,動手前先確認**。

### 3.4 授權數

派送時(`software.install` kindHook)與批次建立時檢查:`license_limit` 不為 NULL 時,`已安裝數 + 本批新增台數(排除已安裝)> license_limit` → `409 ITA_LICENSE_EXCEEDED`。已安裝數以 `ita.device_software` 依 `detect` 比對(`display_name` 樣式 `LIKE`;MSI 產品代碼 P3 的軟體清單沒有存,先只支援 `display_name` 計數,`msi_product_code` 的套件授權數檢查回「無法計算」並要求 IT 同時填 `display_name` 樣式)。授權報表屬路線圖(§7)。

### 3.5 管理 API(`:51240`,對外 `/api/endpoint/*`)

| 方法 | 路徑 | `x-permission` | 說明 |
| --- | --- | --- | --- |
| `GET` | `/software` | `endpoint.device.read` | 目錄清單(篩選 `status`、名稱關鍵字);含「已安裝台數」 |
| `GET` | `/software/files` | `endpoint.device.read` | 軟體庫內尚未登錄的檔案(給登錄畫面挑選;只列兩層深度內、副檔名 `.msi` / `.exe` / `.zip` 等) |
| `POST` | `/software` | `endpoint.software.manage` | 登錄:`name`、`version`、`fileName`、`installerType`、`installArgs`、`uninstallArgs`、`detectType`、`detectValue`、`rebootPolicy`、`licenseLimit`、`notes`;`x-audit-level: meta` |
| `PUT` | `/software/{packageId}` | `endpoint.software.manage` | 修改(§3.2 規則);`x-audit-level: meta` |
| `POST` | `/software/{packageId}/mark-tested`、`/publish`、`/revoke` | `endpoint.software.manage` | 狀態轉換(§3.2);`mark-tested` 帶 `signerThumbprints`;`x-audit-level: meta` |
| `GET` | `/software/{packageId}` | `endpoint.device.read` | 詳情:狀態、覆核人、歷次測試機結果、已安裝電腦(依資料範圍過濾) |
| `POST` | `/devices/{deviceId}/admin-commands` | `endpoint.command.admin` | 單台派送:`{ kind: "software.install", params: { packageId } }`(`software.uninstall` 同形;`system.reboot` 帶 §2.5 參數)|
| `POST` | `/software/{packageId}/deploy` | `endpoint.software.manage` + `endpoint.command.admin` | 批次派送:`{ action: "install" \| "uninstall", deviceIds: [...], maxConcurrent? }` → 建立 `command_batch`(> `BATCH_APPROVAL_THRESHOLD` 台進入 `pending_approval`,§6) |
| `POST` | `/batches/{batchId}/approve`、`/reject` | `endpoint.software.manage` | 軟體派送批次(`software.*`)第二人核可 / 駁回(§6) |
| `POST` | `/batches/{batchId}/approve-command`、`/reject-command` | `endpoint.command.admin` | 軟體派送以外的批次(`system.reboot` 等)第二人核可 / 駁回(§6);批次類型與路由不符 `403 ITA_APPROVAL_ROUTE_MISMATCH` |
| `GET` | `/batches` | `endpoint.device.read` | 批次清單(P7-5 補):`state`(待核可清單用 `pending_approval`,只列 24 小時核可期限內的)、`cursor`、`limit`;含範圍外電腦的批次不列出 |
| `GET` | `/command-batches/{batchId}` | `endpoint.device.read` | 批次進度(沿用 P4 `GET /batches/{id}`,加 `state`、核可資訊) |

- 全部依 E6 資料範圍過濾裝置。**軟體目錄是全公司共用**,與 P6 版本一樣:登錄 / 修改 / 發佈 / 撤回需 `ENDPOINT_SCOPE_ALL_ROLES` 角色,其他回 `403 ITA_SCOPE_ALL_REQUIRED`(§9-5)。
- 派送給哪些電腦仍受資料範圍限制(只能派自己看得到的公司的電腦)。
- `system.reboot` 只提供單台(admin-commands);多台重開機走批次,同樣受核可閾值限制。

## 4. 軟體庫目錄

- 結構:`software\{軟體}\{版本}\{安裝檔}`,例如 `7-Zip\24.09\7z2409-x64.msi`、`Notepad++\8.7.1\npp.8.7.1.Installer.x64.exe`。IT 直接把測過的安裝檔放進去(不經網頁上傳,避開 Nginx 單檔上限);**每個版本一個資料夾**,登錄後不得覆寫該檔案(覆寫會使雜湊不符 → 下載被拒,需重新登錄新版本)。
- 正式:NAS `\\10.10.130.31\docker-folder\RustIT\software\`;`endpoint-server` 以 CIFS **唯讀**掛載 `RustIT\`,與 P6 `releases\` 共用同一個掛載(容器內 `/srv/rustit/releases`、`/srv/rustit/software`)。**2026-10-27 起兩區分開**(需求方決定,§8.1.4 B-3):測試區 `RustIT\test\software`、`RustIT\test\releases`,正式區 `RustIT\prod\software`、`RustIT\prod\releases`;切換步驟 RUNBOOK §1.1。NAS 權限:IT 可寫、`endpoint-server` 帳號唯讀(ADR 0002)。
- 測試區在 NAS 帳密到位前:主機 2 `/srv/giganexus/ita-software/`(root 擁有、唯讀 bind mount 到 `SOFTWARE_DIR`),由需求方或 Claude 經 `ssh host2` 複製(§9-3)。**NAS 帳密只給後端**:由需求方執行的機密腳本寫入主機 2 `/srv/giganexus/ita-secrets/`,AI 不經手;Agent 不拿 NAS 帳密、不直接連 NAS。
- 容量與備份:軟體庫是 IT 工作區,不是唯一副本;安裝檔的原始來源(廠商網址、取得日期)記在 `notes`。

## 5. Agent(0.9.0)

### 5.1 新模組(`crates/agent/src/software/`)

| 模組 | 內容 |
| --- | --- |
| `mod.rs` | 執行器:收到 `software.install` / `software.uninstall` → 串行佇列(P4:會改變系統的指令同時只跑一個)→ 狀態機(§5.2)。核心流程以 trait 注入下載 / 驗證 / 行程 / 登錄檔 / 時鐘,單元測試用假實作 |
| `download.rs` | 下載到 `ProgramData\GigaNexus\Agent\cache\software\{packageId}\*.part`,`Range` 續傳,完成後比對大小與 SHA-256 才改名;**沿用 `rustit-common::transport::download`**(P6-2 已有,不跟隨重新導向);磁碟剩餘需 ≥ 檔案大小 + 1 GB(`DISK_FULL`);快取只保留已成功與進行中的,成功後立即刪除安裝檔(§5.6) |
| `install.rs` | 依 `installer_type` 組命令列(§5.3)、啟動行程(SYSTEM、`CREATE_NO_WINDOW`、放入 Job Object 以便逾時時連同子行程一併結束)、收結束代碼與記錄檔 |
| `uninstall.rs` | 從登錄檔 Uninstall 找到項目 → `QuietUninstallString` 優先,否則 `UninstallString` + `uninstall_args`;MSI 用 `msiexec /x {產品代碼} /qn /norestart`。移植 `deploy.rs` 的 `split_command` / `uninstall_command` / MSI 轉靜默 |
| `detect.rs` | 登錄檔(`HKLM\...\Uninstall`、`WOW6432Node`)比對 `display_name` 樣式或 MSI 產品代碼;`poll` 輪詢(移植 `deploy.rs` 的 `poll`) |
| `power.rs` | A6:`GetSystemPowerStatus`(電池供電)、`INetworkCostManager`/`GetConnectionCost`(計量網路) |

### 5.2 `software.install` 流程

1. 驗參數(§2.3 字元白名單、`url` 必須是 `/agent/v1/packages/{package_id}`、`size_bytes` ≤ 4 GB)。
2. **`detect` 已通過 → 比對版本**(0.9.2 起,2026-10-27 VM 驗收 B-2):登錄檔 DisplayVersion 與快照 `version` 數字分段比較;**較舊 → 繼續安裝(升級)**,相同或較新 → 直接 `succeeded` + `already_installed = true`;無法解析 → 保守視為已安裝(`version_unknown`,0.9.1 的行為)。結果一律帶 `installed_version`,升級時帶 `previous_version`(§8.1.4)。原設計「版本差異由 IT 先移除舊版」只在版本無法比較時仍適用。
3. **A6 延後**(§5.4)→ 進度 `deferred`。
4. 下載(進度 `downloading` + 百分比,每 5% 或 5 秒 `command_update`)→ 驗大小與 SHA-256(`HASH_MISMATCH`)→ 驗 Authenticode(`SIGNATURE_INVALID`)→ 簽章者:**主機 `signer_thumbprints` ∩ 本機 `agent.toml` `[software] trusted_signers`**(M3,與升級用的 `[upgrade]` 分開)必須非空且包含實際簽章者(`SIGNER_NOT_TRUSTED`);沿用 P6 的 `signer_allowed`。
5. 安裝(進度 `installing`):§5.3 命令列,逾時 `timeout_sec`(`INSTALL_TIMEOUT`,Job Object 結束行程樹);1618 重試 3 次(`INSTALL_BUSY`)。0.9.3 起執行 msiexec 前先等 Windows Installer 空閒(最多 15 分鐘,§8.1.5)。
6. 偵測(進度 `detecting`):輪詢 `detect` 最多 120 秒,版本要相同或較新(`DETECT_FAILED`);期間收到服務停止 / 關機立即結束(`EXECUTION_FAILED` + `interrupted`,§8.1.4)。
7. 立即重新蒐集並 `POST /agent/v1/inventory`(不等 24 小時),讓主機的 `device_software` 與 `software_installed` 事件即時反映;失敗只記警告,不影響指令結果。
8. `succeeded`,`result` 如 §2.4。

結果先寫本機持久化(P2 `store`)再回報;指令以 `command_id` 去重,重連後補送(P4)。

**測試機 `draft` 套件(`signer_thumbprints` 為空)**:第 4 步簽章者檢查改為「簽章必須 `Valid`(鏈到受信任的根)、**簽章者必須在本機 `agent.toml` `[software] trusted_signers` 內**(C2,需求方 2026-10-22 決定;本機清單空白不接受任何套件),並回報實際簽章者,但不比對主機清單」。因為只有 `pilot` 環的裝置會收到 `draft` 的指令(§3.3)、且 IT 後續要核對 `observed_signers` 才能 `tested`,所以可行;原設計的「draft 只要簽章有效」會讓主機被入侵時對 pilot 電腦推任意已簽章程式,故不採用。**未簽章的檔案在任何狀態都拒絕**(§9-2:未簽章套件由 IT 以公司憑證簽章後再登錄)。**代價**:測試機要先把該廠商簽章者指紋加進本機 `[software] trusted_signers`,才能測 `draft` 套件(VM 驗收前置,§8.3)。

### 5.3 命令列組法(Agent 端寫死,不由主機給完整命令)

| `installer_type` | 安裝 | 備註 |
| --- | --- | --- |
| `msi` | `msiexec.exe /i "<檔>" /qn /norestart /l*v "<記錄>" <install_args>` | 結束代碼 0 / 3010 / 1641 / 1638 / 1618 |
| `inno` | `<檔> /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- <install_args>` | |
| `nsis` | `<檔> /S <install_args>` | NSIS 的移除程式會自我複製後結束,**完成與否看登錄檔輪詢**,不看行程 |
| `burn` | `<檔> /quiet /norestart <install_args>` | |
| `exe` | `<檔> <install_args>` | 參數完全由目錄決定;第二人覆核時特別檢視 |

記錄檔放 `ProgramData\GigaNexus\Agent\logs\software\{commandId}.log`(14 天,同日誌保留);`log_tail` 經遮罩後放 `result`。

### 5.4 A6:電池與計量網路

- 條件:`AC 電源離線(電池供電)` 或 `連線成本為計量`(Cost Manager 回 `Fixed` 以外/`Variable` 且資料量接近上限)→ 延後**下載**(安裝已下載的檔案不延後)。健康、心跳、其他指令照常。
- 行為:進度 `deferred`,每 5 分鐘重新檢查;解除條件(接上電源 / 回到非計量網路)後繼續。延後上限 `defer_max_min`(`agent.toml` `[software]`,預設 240,但不超過指令的 `expires_at` 剩餘時間)→ 到期 `failed DEFERRED_TIMEOUT`(IT 可看到原因,在使用者回到辦公室插電後重派)。
- 指令參數 `ignore_power: true`(admin 專用,選填)可略過延後(例如 IT 現場處理);預設 `false`。**不略過計量網路判斷**(流量費由使用者承擔)。
- 偵測失敗(API 不可用、桌機沒有電池)視為「無限制」,不阻擋。

### 5.5 `system.reboot`(P7-3 實作後:以下為最終行為;與原設計差異見 §8.1.3)

1. 使用者端程式(P8)未實作前:`WTSSendMessage` 系統訊息框(沿用 `message.show` 的做法與防偽裝規則,前綴「【IT 部門通知】」、結尾附發送人,工號只顯示英數字 1–16 字)提示「電腦將於 N 分鐘後重新開機,請儲存工作」。**先排程,成功後才顯示訊息框**;沒有登入者或 `delay_sec = 0` → 不顯示。
2. 以 `InitiateSystemShutdownExW` 排程(倒數由 Windows 保存,Agent 重啟也照常進行;事件 1074 原因為「其他、計畫性」)`delay_sec` 後重新啟動(`force = false` 不強制關閉應用程式,應用程式可拒絕關閉;`ERROR_SHUTDOWN_IN_PROGRESS` 等失敗記 `EXECUTION_FAILED`)。`force = true`:同上但強制結束應用程式,**只有 admin 且需在畫面二次確認**。
3. 指令在「已排程」就 `succeeded`(`result: { "scheduled_at": "...", "delay_sec": 300, "force": false, "notified": true }`)——排程前 Agent 在本機 kv `reboot_command` 記下指令,**重開機後補送 `succeeded`**(`result: { "rebooted": true, "recovered_at": "..." }`);下次 `hello` 時主機把該指令對應的 `reboot_required` 標記清除(以 `boot_time` 變新為準,P5 已有 `agent_started.boot_time`)。
4. 同一時間若有 `software.*` 正在執行 → 先等待(串行),避免重開機中斷安裝。
4a. **本機上限與倒數中拒絕**(§8.1.3 H1 / M1):開機未滿 30 分鐘不接受、24 小時內最多 3 次(取消的也算)、有人登入時倒數至少 60 秒 → `REBOOT_LIMITED`;倒數中 `software.*` / `agent.upgrade` / `agent.restart` 回 `REBOOT_PENDING`。**`system.reboot.cancel`**(M2)可取消倒數,不取串行鎖。
5. 該台 `reboot_required` 狀態來源:最近一次成功的 `software.*` 指令 `result.reboot_required = true` 且之後 `boot_time` 沒有變新;GigaItApp 詳情顯示並提供「重新開機」按鈕。

### 5.6 清理與安全

- 安裝成功或失敗結束後立即刪除快取的安裝檔(只保留進行中的與失敗但可續傳的 `.part` 24 小時),避免 SYSTEM 可執行檔長期留在可被替換的目錄。`cache\software\` 與 P6 `cache\` 同樣由 SYSTEM / Administrators 專用 ACL;是連結 / junction 或 ACL 套用失敗就停用軟體派送(沿用 P6 L4)。
- **驗證後立即執行有 TOCTOU 風險**(驗完雜湊到啟動之間被換掉):安裝前把檔案複製到僅 SYSTEM 可寫的 `staging\{commandId}\` 並**在目的地再驗一次雜湊與簽章**,從該位置執行(沿用 P6-2 `.new` 再驗雜湊的作法)。
- 安裝程式的子行程繼承 SYSTEM:不提供對外網路限制(列入風險,§8.2);`Job Object` 設定 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
- 日誌不記命令列中的完整 `install_args` 以外的機密(目錄本來就不得含機密);`install_args` 內若偵測到 `password=` / `key=` 類字樣,主機登錄時拒絕(沿用 `logs.collect` 遮罩關鍵字清單),需要序號的軟體不在 P7 支援範圍(§7)。

## 6. 第二人核可(B1)

| 條件 | 行為 |
| --- | --- |
| 批次派送(`software.*` 或 `system.reboot`)**> `BATCH_APPROVAL_THRESHOLD`(20)台** | 批次 `state = pending_approval`,指令不送出;建立人以外的、具 `endpoint.software.manage` 且資料範圍涵蓋該批所有裝置的人,`POST /batches/{id}/approve`(軟體批次,`endpoint.software.manage`)或 `/approve-command`(`system.reboot` 等其他批次,`endpoint.command.admin`)後才進入 `running` 並開始補送 |
| 核可人 = 建立人 | `403 ITA_APPROVER_SAME_AS_CREATOR` |
| 路由與批次類型不符(軟體批次走 `/approve-command`,或其他批次走 `/approve`) | `403 ITA_APPROVAL_ROUTE_MISMATCH` |
| 24 小時沒人核可 | 批次 `expired`,指令全部設 `canceled`(沿用 P4 過期掃描) |
| 駁回 | `reject` 帶原因;指令設 `canceled` |
| 單台或 ≤ 20 台 | 不需核可,但寫稽核 |

- 核可畫面顯示:套件(名稱、版本、安裝參數、簽章者、雜湊)、目標台數與公司/部門分布、並行數。稽核記錄建立人、核可人、時間(`x-audit-level: meta`,參數快照在指令列)。
- 核可通知:建立批次時經 BFF 通知逐人寄給有 `endpoint.software.manage` 的 IT(沿用 P5 告警的通知路徑,若尚未實作則只在 GigaItApp 顯示待核可徽章)。
- 「兩人覆核」共三道:目錄 `published`(第二人)、本機信任簽章者(GPO,主機無法改)、批次核可(> 20 台);目的是主機被入侵或單一 IT 帳號被盜時,無法一次對全公司推任意程式。

## 7. 不做的事(留路線圖)

- **軟體組合、綁 AD OU / 群組的自動安裝**(ADR 0002)、新電腦加入網域自動裝標準組合。
- **使用者自助安裝**(托盤列出 IT 核准的軟體,P8 之後)。
- **授權報表**(只做派送時的上限檢查,§3.4)。
- **自動升級取代**(裝了舊版自動換新版):P7 只做「沒有就裝、有就跳過、要換先移除」。
- **需要序號 / 帳密 / 回應檔含機密的安裝**(例如 Office 部署工具 `setup.exe /configure`):設定檔要放軟體庫且不得含機密,先不支援,待需求。
- **多廠區分發點 NAS**、下載限速策略(§9-8)。
- **從廠商網址自動抓新版**(ADR 0002 的自動更新)。
- **使用者登入後才安裝的軟體**(每使用者安裝):目錄一律選「整台電腦」版本(ADR 0002)。

## 8. 測試與驗證

### 8.1 自動化

- **ItAgentBack**:契約測試(新 kind 的 params、`result`、錯誤代碼範例);`software-service` 單元測試(狀態機與兩人覆核、`draft` 只能派 pilot、`mark-tested` 簽章者需等於回報值、字元白名單、授權數、批次核可閘門、核可人≠建立人、過期);下載 API(非指派 404、停用 403、`draft` 非 pilot 404、Range / 416、檔案被換掉 503、路徑穿越);`test:int` SQL store(`giganexus_It_Agent_poc_test`:套件登錄重複、狀態條件更新、批次核可條件更新)。
- **Agent**:`software` 以假實作測試——成功(MSI / Inno / NSIS)、`3010` 標記重開機、`1638` 已安裝、`1618` 重試後成功 / 失敗、逾時、`HASH_MISMATCH`(沒有啟動安裝程式)、`SIGNATURE_INVALID`、`SIGNER_NOT_TRUSTED`、已安裝時跳過、偵測失敗、移除輪詢(NSIS 自我複製)、A6 延後與恢復 / 逾時、斷線補送、重複 `command_id` 不重跑、參數字元白名單、`system.reboot` 排程與取消;`power.rs` 以注入測試。
- **契約**:`command-kinds.md` 對應範例檔,兩端吃同一份。

### 8.1.1 P7-1 實作、需求方決定與資安稽核(2026-10-21)

- **需求方決定(2026-10-21,D1~D6 全部照建議)**:
  - **D1**:實作時與設計的七個差異全部同意——批次派送 `POST /v1/software/{id}/deploy` 的 `x-permission` 為 `endpoint.command.admin`(BFF 一個 operation 只能一個權限),核可 / 駁回為 `endpoint.software.manage` 並檢查核可人資料範圍涵蓋批次全部電腦;核可路由沿用 P4 的 `/v1/batches/{id}/approve`、`/reject`、`GET /v1/batches/{id}`;路徑段允許 `+`;安裝檔只接受 `.msi`(msi)與 `.exe`(其他);MSI 產品代碼由 IT 填;授權數為軟上限(不計尚未完成的派送);`uninstall` 可對已撤回的套件執行;`system.reboot` 類型可建立、Agent 0.7 回 `UNSUPPORTED_COMMAND`(Agent 端在 P7-3);主機取消指令寫 `PACKAGE_REVOKED` / `BATCH_REJECTED` / `APPROVAL_EXPIRED`。
  - **D2-1**:同一人 24 小時內累計派送超過 20 台需第二人核可(逐台或多批小批次都累計)。軟體安裝 / 移除共用一組計數,`system.reboot` 另一組;已由第二人核可的批次不計,取消的單台照計(避免「建立 → 取消」循環);超過時單台指令進待核可的單台批次(`CommandView.batchState`)。同一人同一組的「計數 → 建立」在程序內以鎖序列化(單一實例)。
  - **D2-2**:發佈人 ≠ 登錄人,且 ≠ 上次發佈以來修改過安裝參數 / 偵測規則 / 重開機政策的人(`editors`;已發佈後再修改重設為修改人;只改說明 / 授權數不算);發佈者必須有工號。
  - **D3**:安裝參數依安裝程式類型檢查、路徑只限 Program Files(§2.3,測試向量 `contracts/install-args.vectors.json`)。
  - **D4**:新增告警規則 `software_install_failed`(warn;安裝失敗開,同一台再派送同一套件成功自動關)、`reboot_pending`(warn;自動類,成功且 `reboot_required` 的 `software.*` 之後開機時間沒變新超過 7 天)、`software_file_tampered`(critical;下載時發現軟體庫安裝檔與登錄雜湊不符,開在要求下載的裝置上,不自動關閉)。
  - **D7(2026-10-21)**:`system.reboot` 等非軟體派送批次的核可 / 駁回改走 `POST /v1/batches/{id}/approve-command`、`/reject-command`(`endpoint.command.admin`);軟體批次仍走 `/approve`、`/reject`(`endpoint.software.manage`);類型與路由不符 `403 ITA_APPROVAL_ROUTE_MISMATCH`(`07d5307`,只動路由與服務層)。Gateway OpenAPI 草稿批次要多發佈這兩個 operation。
  - **D5**:Agent 版本 0.9.0(P7-2 / P7-3 一起發)。
  - **D6**:驗收先用 2 台(需求方本機電腦 + VM `RUSTIT-P34`),第 3 台待同意後補測。
- **code-reviewer(2026-10-20,無必修,已處理)**:全域補送分頁掃描(避免最舊 200 筆都是離線電腦時餓死);LIKE 樣式參數 800 字;`markTested` 服務層擋空簽章者、實際簽章者不截斷;`rooted-files` 只有不存在回 null,權限 / 掛載錯誤回 503 `ITA_FILES_UNAVAILABLE`;`params LIKE` 以 `created_at` 收斂(撤回 7 天、測試結果 180 天);重讀批次失敗記 warn;同一個 Idempotency-Key 用在另一個套件回 422。2026-10-21 再次審查建議(管控類型查表防原型鏈、`reboot_since` 開機時間未知不算、exe 寫檔類開關與 `%` 禁止等)已於 `d2e84d8` 處理(建議修正 1、3、4、5、9 與 D2-1 競態測試)。**待辦**:第 7 點「直接取消的指令所屬批次是否會收尾」、第 10 點「新 SQL 的整合測試覆蓋」。
- **資安稽核(security-auditor,2026-10-21 重跑)已修**:

  | 編號 | 內容 | 修法 |
  | --- | --- | --- |
  | C1 | 未經覆核的移除參數可對所有電腦執行 | `revoked_from`;只有從 `published` 撤回的套件可對所有電腦派送移除,其餘只限 pilot |
  | H1 | 以逐台派送避開 > 20 台核可 | D2-1 累計核可、`ix_command_creator` |
  | H2 | 參數白名單擋不住讓安裝程式讀外部檔案 | D3 依類型檢查、測試向量 |
  | H3 | 登錄後改參數再由他人發佈、或同一人改完自己發佈 | D2-2 `editors`(取代 `args_changed_by_emp`),CHECK 同步 |
  | M1(部分) | 軟體庫安裝檔被換掉 | 下載時複驗雜湊,不符則取消此套件排隊中的安裝(`PACKAGE_FILE_CHANGED`)並開 `software_file_tampered`;**主動定期重算雜湊未做** |
  | M2 | 改參數後舊快照仍可下載 / 送出 | 退回 `draft` 同交易取消尚未送出的 `software.*`(`PACKAGE_CHANGED`);下載要求指令快照與目前目錄一致 |
  | M3 | 大量電腦同時重連超過並行上限 | 「計數 → 送出」在程序內序列化 |
  | M4 | 修改套件缺稽核內容 | 日誌記錄受覆核欄位的新舊值 |
  | M5 | 未發佈套件派到測試機的權限 | 需可管理所有公司的角色(`ITA_SCOPE_ALL_REQUIRED`) |
  | M6 | 清單算已安裝台數的 `LIKE` 成本 | 清單只算已發佈套件,其他看詳情 |
  | L1 | 改重開機政策不需重新覆核 | 重開機政策變更也退回 `draft`、計入修改人 |
  | L2 | 系統 client 當作第二人、工號大小寫 | 發佈需有工號(`ITA_REVIEWER_NOT_PERSON`);工號比對不分大小寫 |
  | L3 | 核可 UPDATE 缺 24 小時條件 | 已加 |
  | L6 | 授權數錯誤洩漏全公司已安裝台數 | 不回台數 |
  | L7 | 偵測結果不明確也算通過 | 需 `detected === true` |
  | L8 | 名稱 / 版本含控制字元、雙向文字控制字元 | 登錄時拒絕 |
  | L9 | 軟體庫檔名給唯讀權限者看 | `GET /software/files` 改需 `endpoint.software.manage` |

- **設計取捨(`software_install_failed`)**:每台電腦、每個規則只保留一筆開啟中的告警(`device_alert` 唯一約束),同一台多個套件安裝失敗時只留最近一次的 detail;某套件之後安裝成功只關閉 detail 指向該套件的那一筆。要逐套件各一筆需改告警鍵,列入後續。
- **資安稽核未修(列入 HANDOFF「P7-1 資安稽核剩餘項目」)**:
  - **M1 主動定期重算雜湊**:目前只在下載時複驗;定期掃描軟體庫的作法待決定(頻率、IO 成本)。
  - **L4、L5、L10、L11**:低風險項目,待排入後續批次。
  - **L12**:攻擊前提為「已有軟體庫寫入權」,接受此風險(軟體庫寫入權以檔案伺服器權限控管)。
  - **L13**:既有相依套件的弱點,不屬 P7 變更,依相依套件更新流程處理。
- **接手(主工作階段)**:
  1. 處理 code-reviewer 剩餘結果,重跑 `npm run typecheck`、`npm test`、`npm run test:int`(`npx tsx --env-file=../../RustIt/ItAgentBack/.env --test test/int/*.int.test.ts`,只讀原檢出的 `.env`、不複製;DB 守門只允許 `*_poc_test`)。
  2. 用 `GITLAB_TOKEN` 開 MR → develop(只開不合併),描述註明:依賴 MR !39 先合併;**部署前必須先套用 migration 0008**(新版所有指令查詢讀 `command_batch.state`;0008 現在含 `editors`、`revoked_from`、`ix_command_creator`);migration 內容請需求方先看,再經同意套用 `giganexus_It_Agent_test`;測試區 compose 已加 `SOFTWARE_DIR=/srv/software`。
  3. 不推送或合併 develop / main。

### 8.1.2 P7-2 實作、需求方決定與資安稽核(2026-10-22)

分支 `feature/p7-2-agent-software`(`591ab84` → `11145d6` → `a484b1e` → `4848605` → `f3af32d`),Agent 0.9.0;`cargo test -p rustit-agent` 116/116(`cargo test -p rustit-common` 單獨執行會因 `log::set_boxed_logger` 編譯失敗,為既有問題)。

- **與設計的差異**:
  - 磁碟需求為「安裝檔 × 2 + 1 GB」(§5.1 原為檔案大小 + 1 GB):staging 複本(§5.6)也佔空間。
  - A6 延後上限是常數 4 小時(`power::DEFER_MAX`,且不超過指令剩餘有效時間),**沒有加** `agent.toml [software] defer_max_min`(§5.4)。
  - A6 在**取得串行鎖之前**延後,延後期間不擋其他指令;已完整下載的安裝檔不延後。
  - 只有 `UninstallString`、目錄也沒有 `uninstall_args` 時,回 `UNINSTALL_NOT_SUPPORTED`。
  - MSI 移除只附加 `installer_type = msi` 的屬性參數(其他類型的開關 msiexec 不認得)。
  - running 進度只回報百分比:主機不存 running 的 `result`。
  - `signer_subject` 已過濾控制字元與雙向文字控制字元、最多 200 字(L6)。
- **需求方決定(2026-10-22)**:
  - **C2**:`draft` 套件(主機簽章者清單為空)的簽章者也必須在本機 `[software] trusted_signers` 內;本機清單空白不接受任何套件。已改正文 §2.2 `signer_thumbprints` 與 §5.2「測試機 draft 套件」。
  - **H1**:移除程式在 Program Files / Windows / `ProgramData\Package Cache` 以外時,檔案與上層目錄只能由 SYSTEM / Administrators / TrustedInstaller 寫入(`scm::admin_only_writable`);路徑不可含 `..`。
  - **H2**:內建不可移除清單——DisplayName 含 GigaNexus / RustIt、常見防毒 / EDR(Defender、Symantec、Norton、Trend Micro、Sophos、Kaspersky、ESET、McAfee、CrowdStrike 等共 22 個詞,以程式 `uninstall.rs` `PROTECTED` 為準)者回 `UNINSTALL_NOT_SUPPORTED`;單字比對「詞以它開頭」(避免 `eset` 比到 `Preset`)。
  - **M3**:`trusted_signers` 分開——**已完成**(`b9242d6`,與 P7-3 同分支):`agent.toml` 新增 `[software] trusted_signers`(格式與 `[upgrade]` 相同,共用 `signer_list` 檢查);沒有設定 = 不接受任何派送的套件;Agent 軟體派送改用這份清單,升級與替換 Watchdog 仍用 `[upgrade]`;`build-agent-msi.ps1` 新增 `-SoftwareSigners` 寫入 `[software]` 區段。
- **資安稽核(security-auditor)已修**:

  | 編號 | 內容 | 修法 |
  | --- | --- | --- |
  | C1 | `command_id` 組 staging / 記錄路徑並於結束時 `remove_dir_all` | `command_id` 必須是 UUID;staging 確認安全後才登記結束時刪除 |
  | C2 | draft 套件空簽章者清單放行任何有效簽章 | 見需求方決定 |
  | H1 | 移除程式位於可被一般使用者寫入的位置 | 見需求方決定 |
  | H2 | 對全公司移除監控本身或防毒 / EDR | 見需求方決定 |
  | M1 | 快取 / staging / 記錄目錄被他人擁有 | 擁有者必須是 SYSTEM 或 Administrators(`scm::owner_is_admin`) |
  | M2 | 安裝程式使用共用的 `C:\Windows\Temp` | `TEMP` / `TMP` 指到 `staging\{commandId}	mp` |
  | L4、L5 | 低風險項目(稽核報告編號) | 隨 code-reviewer 修正一併處理:`split_command` 改 ASCII 小寫(Unicode 小寫改變長度會 panic);安裝子行程等待改用剩餘逾時、1618 重試計入整體逾時(`a484b1e`) |
  | L6 | `signer_subject` 可含控制字元 / 雙向文字控制字元 | 過濾並限長 200 |
  | L7 | staging 安裝檔驗證後被換掉(TOCTOU) | 驗證前以只允許讀取的共用模式開啟,持有到安裝程式結束 |

  L4、L5 兩列依 commit 訊息(`a484b1e`)整理,逐項編號對應以稽核報告為準。
- **資安稽核未修**:
  - **L2**:`ACTION=` 與重開機類開關尚未全面禁止;要 Agent、ItAgentBack、契約向量 `install-args.vectors.json` 三處同步修改,待排。
  - **L3**:MSI 逾時後安裝仍在 msiserver 進行(結束行程樹殺不掉 msiserver 的工作),下一筆指令可能遇到 1618(`INSTALL_BUSY`);`INSTALL_TIMEOUT` 訊息已註明。**0.9.2 的判斷不正確,0.9.3 修正並改為下一筆先等空閒(§8.1.5)**。
- **code-reviewer 未處理的建議**:
  1. `transport` 下載帶狀態碼取代字串比對(目前以錯誤字串判斷「主機拒絕(4xx)不重試」,宜改為回傳狀態碼)。
  2. `software::Failure` 與 `command::Failure` 重複,可合併。
  3. `purge_stale` 以目錄 mtime 判斷過期(續傳時目錄內檔案更新不一定更新目錄 mtime),宜改為看內容檔時間。
- **風險(Watchdog 升級)**:Agent 以 Job Object 啟動安裝程式並設 `KILL_ON_JOB_CLOSE`;Watchdog 升級 Agent 時 `prepare_shutdown` 等待執行中指令最多 60 秒,逾時記 `failed AGENT_UPGRADING` 並照樣關閉 Agent,Job 隨之關閉而**中斷進行中的安裝**(MSI 可能半裝)。升級與軟體派送避開同時段,或讓 `prepare_shutdown` 在 `software.*` 執行中時延後(P7-3 評估)。
- **接手**:P7-3 `system.reboot`(M3 已完成);開 P7-2 MR(等 P7-3 一起或先開由需求方決定);VM 驗收前置見 §8.3(VM `trusted_signers` 要加 7-Zip 測試簽章與 Notepad++ 簽章者指紋)。

### 8.1.3 P7-3 實作、需求方決定與資安稽核(2026-10-22)

分支 `feature/p7-2-agent-software`(`8c8a63f` → `b9032d8` → `1b383f7`),Agent 0.9.0(與 P7-2 同版本);程式在 `RustAgent/crates/agent/src/reboot.rs`、`command.rs`,ItAgentBack 新增類型在 `src/commands/kinds.ts`。

- **需求方決定(2026-10-22,H1、M1、M2 都照建議)**:
  - **H1 本機上限**:Agent 自行限制重新開機——開機未滿 30 分鐘不接受;24 小時內最多 3 次(取消的也算);有人登入時倒數至少 60 秒。超過回 `REBOOT_LIMITED`。主機被入侵時無法讓電腦反覆重開機。
  - **M1 倒數中拒絕**:倒數中(開機時間未變新且未超過倒數 + 5 分鐘)`software.*`、`agent.upgrade`、`agent.restart` 回 `REBOOT_PENDING`,不開始會被重開機中斷的工作。
  - **M2 新增取消**:`system.reboot.cancel`(admin、無參數、1 小時 / 5 分鐘、每台 1 筆;`AbortSystemShutdownW`、清除倒數旗標、通知使用者;結果 `{ aborted }`;不取串行鎖,不納入批次與累計核可)。ItAgentBack 已加類型與契約範例 `ws-command-system-reboot-cancel.sample.json`。
- **已修(code-reviewer / 資安稽核)**:
  - 先排程、成功後才顯示訊息框;`delay_sec = 0` 不顯示(排程失敗不讓使用者看到不會發生的倒數)。
  - 排程前把指令記在本機 kv `reboot_command`,重開機後 recover 回報 `succeeded`(`{ rebooted, recovered_at }`),不誤報為中途停止;沒排成則清除。
  - 事件 1074 的原因改為「其他、計畫性」;權限調整的錯誤碼在 `CloseHandle` 前取得。
  - `issued_by` 驗證:發送人工號只顯示英數字 1–16 字(`message.show` 一併套用);字元過濾加入格式字元(Cf)與行 / 段落分隔(Zl / Zp);`message` 不可只有空白。
  - `reboot_policy = required` 只在安裝成功且非 1638(已安裝)時標記 `reboot_required`;非字串回 `INVALID_PARAMS`。
  - `build-agent-msi.ps1`:`-TrustedSigners` 與 `-SoftwareSigners` 兩份清單有交集時警告。
- **未處理**:
  - `SeShutdownPrivilege` 啟用後沒有還原(只影響 Agent 行程,影響小)。
  - 以 `reboot_policy` 觸發的重開機尚無自動排程:需求方決定只標記 `reboot_required`,由 IT 在畫面按「重新開機」。
- **測試與建置(主工作階段於 `1b383f7` 執行)**:`cargo test -p rustit-agent -p rustit-common`:Agent 124/124(`1b383f7` 時);`rustit-common` 單獨執行會因 `log::set_boxed_logger` 編譯失敗(既有問題),與 Agent 一起編譯時設定測試 `software_signers_are_separate`、`trusted_signers_are_validated` 通過;`cargo build -p rustit-watchdog` 通過。ItAgentBack:`npm run typecheck` 通過,`npm test` 211/211(`1b383f7` 時,主工作階段執行)。測試區 MSI `GigaNexusAgent-0.9.0-test.msi`,SHA-256 `589309dfaa6a846e0dd996ec0918e069cd199221119d52b81571ce6cf4e060ec`(Agent 0.9.0、Watchdog 0.3.2);`[upgrade] trusted_signers` = 第一張測試憑證 `bb8ced00c84798f6e098581e50f41b2ee4247cd3`,`[software] trusted_signers` = 第二張測試憑證 `2953e8c04eabefd6c6fb35491de6671dd808b46b`。VM 驗收尚未做。
- **部署注意**:含 `[software]` 區段的 `agent.toml` 不可給 0.9.0 以前的 Agent 讀(設定結構 `deny_unknown_fields`,舊版會啟動失敗),Agent 版本與設定要一起換。
- **待辦**:ItAgentBack 新類型(`system.reboot.cancel`)要在 P7-2 MR 合併、部署後才能在 GigaItApp 使用;GigaItApp P7-5 要加「取消重新開機」按鈕。

### 8.1.4 VM 驗收修正(2026-10-27,Agent 0.9.2)

VM 驗收(§8.3)#1、#2 通過時發現的問題(報告 `test-reports/2026-10-22-p7-vm-acceptance.md` §5)。需求方 2026-10-27 決定先修程式、出 Agent 0.9.2,再完整驗收(避免驗兩次)。分支 `feature/p7-acceptance-fixes`(RustIt 從 develop `c1f6d10`;GigaItApp 從 develop `10e5717`)。Watchdog 不改(仍 0.3.5)。

| 編號 | 問題 | 修法 |
| --- | --- | --- |
| B-1 | 安裝逾時固定 1800(`INSTALL_TIMEOUT_SEC`),文件寫可調 | 套件加 `timeout_sec`(migration **0009**:`INT NOT NULL DEFAULT 1800`、CHECK 300–7200,既有資料以預設值補 1800);登錄 / 修改 API schema 與服務層都驗範圍(400 `VALIDATION_FAILED`);`software.install` / `software.uninstall` 快照帶套件值;主機指令逾時 `commandTimeoutSec` = 類型逾時(安裝 4 小時、移除 1 小時,以 1800 估算)+ 超過 1800 的部分,較短不縮減;修改逾時不退回 `draft`。Agent 只接受 300–7200(原 60–14,400),沒帶 1800。GigaItApp 登錄 / 修改加欄位 |
| B-2 | `display_name` 偵測不看版本,舊版不升級 | Agent `install()`:`detect` 找到項目時比對 DisplayVersion(`detect.rs` 純函式 `parse_version` / `compare_versions` / `installed_state`,單元測試含 8.8.9 < 8.9.8、26.05 < 26.05.2、24.09 = 24.09.00.0)。較舊 → 安裝;相同 / 較新 → `already_installed`;多個項目符合時任一個相同或較新即算已安裝。**無法解析(沒有 DisplayVersion、帶後綴如 `1.2-beta`、段數 > 8 或單段 > 9 位)採保守做法:視為已安裝**(不重新安裝、不降版,`version_unknown: true`);理由:版本格式不明時重裝可能反覆安裝或降版,而 0.9.1 本來就是這個行為。安裝後的登錄檔確認(settle)要等到版本相同或較新,仍是舊版 → `DETECT_FAILED`。結果一律帶 `installed_version`(去控制字元、≤ 50 字),升級時帶 `previous_version`;主機套件詳情的測試機結果、GigaItApp 指令結果顯示。移除流程不比對版本(取第一個符合的項目,同 0.9.1) |
| B-3 | 上架腳本沒擋已登錄過的版本號 | `installer/publish-release.ps1`:見下方「B-3」 |
| B-4 | 登錄畫面「判斷值」預填套件名稱 | GigaItApp 不預填,加提示(對照測試機登錄檔的 DisplayName、名稱不含版本的建議用 MSI 產品代碼) |
| B-5 | 沒有全部公司角色的人可按「發佈」 | 套件詳情 API 回 `viewerScopeAll`(查詢者是否有 `ENDPOINT_SCOPE_ALL_ROLES` 角色);GigaItApp 為 `false` 時停用「發佈」並說明原因(code-reviewer 建議:「修改」「撤回」一併停用;舊主機沒有此欄位時不擋,由主機回 403)。實際權限仍由主機檢查 |
| L2(續) | `REMOVE=ALL` 可把安裝變成移除整個產品 | 併入禁止參數:屬性 `REMOVE` 的值(逗號清單、引號、不分大小寫)含 `ALL` 一律拒絕;`REMOVE={產品代碼}` / 功能名稱仍可用。Agent `args.rs`、ItAgentBack `argsErrors`、契約向量 `install-args.vectors.json` 三處同步 |
| — | 安裝後等待期間不理會關機 | 新增 `Env::pause`(收到服務停止 / 關機 / `agent.restart` 立即回傳):逾時後等 Windows Installer(最多 10 分鐘)與安裝 / 移除後的登錄檔輪詢(120 秒)都改用它。中斷時:等登錄檔 → `EXECUTION_FAILED` 且 `result.interrupted = true`(帶 `exit_code`);等 Windows Installer → `INSTALL_TIMEOUT`,訊息註明 Agent 停止。結果先寫本機持久化,重啟後補送;重新派送時已安裝會直接 `already_installed` |

**審查(2026-10-27)**:code-reviewer 無必修,建議已處理(修改 / 撤回也依角色停用、逾時沒改就不送、讀登錄檔背景工作異常記警告)。security-auditor:

| 編號 | 內容 | 處理 |
| --- | --- | --- |
| M1 | `/v` 黏著寫(`/vREMOVE=ALL`、`/s /v/qn`)以開關形式把參數轉交 msiexec(InstallShield 類),繞過 `REMOVE=ALL` 與整份 MSI 屬性禁止清單(修改前就存在) | **已修**:Inno 以外的類型一律拒絕 `v` 開頭的開關(Agent `args.rs`、ItAgentBack `argsGrammarError`),契約向量補 6 組 |
| L3 | 主機只信 Agent 的版本字串淨化 | **已修**:套件詳情輸出前 `reportedVersion` 去控制 / 雙向字元、限 50 字 |
| L1 | 修改逾時不需第二人覆核:單一管理者可把已發佈套件調到 300 秒(大量電腦半安裝)或 7200 秒(佔住串行與並行名額) | **接受,不改**(需求方 2026-10-27):逾時只影響 Agent 等待安裝程式的時間,不改變安裝的內容(檔案、參數、偵測規則、簽章者都仍受兩人覆核);範圍 300–7200 由 API、服務層、DB CHECK 與 Agent 四處限制,修改有稽核日誌(`changes.timeoutSec`) |
| L2 | `REMOVE=` 列出全部功能名稱效果等同 `REMOVE=ALL` | **列為已知限制**(需求方 2026-10-27,§8.2-11):程式只擋 `REMOVE=ALL`,逐一列出功能名稱由第二人覆核時人工判斷 |

**B-3 上架腳本防呆**(`RustAgent/installer/publish-release.ps1`;需求方 2026-10-27 決定):

- **兩區路徑分開**:同一台 NAS,test = `\\10.10.130.31\docker-folder\RustIT\test\releases`、prod = `\\10.10.130.31\docker-folder\RustIT\prod\releases`;不給 `-NasReleasesDir` 時依 `-Environment` 選,給了但與環境不一致(例如 test 指到 `prod\`、或舊的 `RustIT\releases`)就停止(比對不分大小寫、忽略結尾 `\`)。掛載確認預設 `/srv/giganexus/nas-rustit/{環境}/releases`(`-MountCheckDir` 可改,空字串不檢查)。
- **版本號查重(只查目標區)**:經 ssh 到 `-HostAlias`,在目標區 endpoint-server 容器(test 預設 `giganexus-ita-test-endpoint-server-1`;prod 必須給 `-ServerContainer`)內以應用程式的 SQL 帳號唯讀查 `ita.agent_release`(component + version,**含已撤回**);有就停止。查詢程式碼固定,以 base64 經 ssh / PowerShell / wsl / docker exec 傳遞;密碼只在容器內讀取。查不到(連不上、容器不在、正式區未部署)也停止,除非加 `-SkipRegistryCheck`(印警告)。`-DryRun` 不查。主機的 docker 不在 WSL 時加 `-DockerCmd docker`。
- **資安稽核(2026-10-27)**:無 Critical / High;遠端指令、JS、SQL 注入都找不到路徑,失敗時停止。已修:查到的資料庫名稱必須屬於目標區(test = `giganexus_It_Agent_test`、prod 不得含 `test`),避免 `-HostAlias` / `-ServerContainer` 指錯區仍通過(M1);錯誤只印代碼,不帶 SQL 帳號 / 主機(L2);版本參數長度 40(L3)。**列為上線前待辦**(需求方 2026-10-27,§8.2-13、§8.2-14):M2 查詢用 endpoint-server 的 SQL 帳號(有寫入權,唯讀只靠程式碼)且簽章人員要能 ssh 進主機以 root 執行 docker——上正式區前改走唯讀 API(`GET /api/endpoint/releases`,唯讀 IT 帳號)或只能 SELECT 的帳號;L4 NAS `RustIT\test` / `RustIT\prod` 的寫入群組分開(NAS 管理員;路徑分區目前只靠腳本)。
- **實測(2026-10-27,測試區唯讀)**:watchdog 0.3.3 / 0.3.4 查到 `revoked`(驗收報告 §5-3 的情況會被擋)、agent 0.9.1 `published`、agent 0.9.2 未登錄;容器名稱錯誤時停止。路徑防呆:test→`prod\`、test→舊 `RustIT\releases`、prod→`test\` 都停止。
- **軟體庫也拆開**(需求方 2026-10-27 補充):test = `RustIT\test\software`、prod = `RustIT\prod\software`。軟體庫的安裝檔由 IT 直接放置(不經上架腳本);compose 預設值改為 `/srv/giganexus/nas-rustit/test/releases`、`/test/software`,`host2-set-nas-credentials.sh` 與 `test.env.example` 一併更新。
- **切換步驟**(測試區目前讀舊的 `RustIT\releases`、`RustIT\software`;建目錄、複製並比對雜湊、改 `ita.env`、重跑 deploy-test、確認後再處理舊目錄,屬部署步驟,**本分支沒有執行**):RUNBOOK §1.1。

**相容**:新主機 + 0.9.1 Agent:快照的 `timeout_sec` 在 300–7200 內,0.9.1 接受(其範圍 60–14,400);0.9.1 不比對版本、不帶新結果欄位,畫面照舊顯示。0.9.2 Agent + 舊主機:快照固定 1800,照常;主機只存 `result`,新欄位不影響。**部署順序**:先套用 0009,再部署新版 endpoint-server(新版讀寫 `timeout_sec`);0009 未套用時套件查詢失敗。GigaItApp 新欄位在舊主機上不顯示(逾時顯示 1800)。Gateway OpenAPI:**不需要再發佈**(2026-10-27 部署後確認:Gateway 路由表只記路徑、方法與權限,不存請求 / 回應 schema;endpoint-server 啟動註冊結果 42 個路由不變、`pendingPublish: false`)。

**驗收需重測**:§8.3 全部 12 項以 Agent 0.9.2 重做;另加:#5 以舊版(例如 Notepad++ 8.8.9)派送新版 → 升級成功、`previous_version` 正確;相同版本 → `already_installed` 帶 `installed_version`;#9 以套件 `timeout_sec = 300`(最小值,原寫 30 已不可設)驗 `INSTALL_TIMEOUT`,並在等 Windows Installer 期間停止服務 / 關機,確認立即結束且重啟後補送結果;登錄 `REMOVE=ALL` 被拒;無 `it-admin` 帳號(V112001)看到「發佈」停用與原因。

### 8.1.5 驗收後修正(2026-10-27,Agent 0.9.3)

依驗收報告 `docs/test-reports/2026-10-27-p7-vm-acceptance.md` §4-7、§5、§6,需求方 2026-10-27 決定。Watchdog 不改(0.3.5)。

| 項目 | 修改 |
| --- | --- |
| **L3 逾時後誤報「Windows Installer 已沒有進行中的安裝」**(§5-6) | **原因**:0.9.2 以 `Global\_MSIExecute` 判斷,但只認擁有者 = LocalSystem;msiserver 以 SYSTEM 執行,SYSTEM 權杖的預設擁有者是 **Administrators 群組**,所以 mutex 永遠不算、一律判為空閒。**做法**:仍用 `_MSIExecute`,擁有者改為 SYSTEM 或 Administrators(`scm::msi_mutex`),且 msiserver 執行中(純函式 `software::msi_busy`,單元測試涵蓋)。**理由**:msiserver 執行安裝指令碼(含 deferred 自訂動作、回復)整段期間持有它,與 msiexec 前端是否還在無關,Windows Installer 自己也是看它回 1618;「msiserver 底下的安裝工作階段」沒有公開 API,列舉 msiserver 子行程會把閒置的自訂動作伺服器誤判為忙碌;一般使用者自建的同名 mutex 擁有者是自己,不採信(不能用它擋住派送)。**行為**:逾時結束行程樹後最多再看 60 秒(原 10 分鐘),仍忙碌回 `INSTALL_TIMEOUT`「Windows Installer 仍在執行(…逾時前的變更不回復);同一台的下一筆 MSI 派送會先等它結束」+ `result.installer_busy`;**執行 msiexec 前**(MSI 安裝與 MSI 移除)仍忙碌就每 30 秒檢查、最多 15 分鐘,超過回 `INSTALL_BUSY` 且不啟動安裝程式,等待期間停止 / 關機回 `EXECUTION_FAILED` + `interrupted`。15 分鐘不計入套件逾時;移除的主機逾時(1 小時 + 超過 1800 的部分)仍足夠。逾時前的半成品不回復(§8.2-15) |
| **延後回報**(§5-4) | A6 延後期間每次檢查(5 分鐘)寫一行日誌(原因、下次檢查時間),回報 `running` + `result.deferred`(`battery` / `metered`、`next_check_at`);主機驗證後暫存並重設執行逾時(0.9.2 以前延後 4 小時會先被主機判 `TIMEOUT`:`timeout_at` 只在第一次 acked 設定),解除時清除;GigaItApp 顯示「延後中(原因)」與下次檢查時間。不新增指令狀態(避免 migration 與狀態機變更),契約見 command-kinds.md |
| **事件詳情 `[object Object]`**(§6) | GigaItApp 指令參數 / 結果 / 批次摘要 / 事件內容的物件與陣列改用 JSON 顯示 |
| **登錄畫面版本欄提示**(§5-5) | 版本欄提示「要和電腦上的 DisplayVersion 一致,例:7-Zip 是 26.05,不是 26.05.2.0.0」 |
| **撤回後釋放安裝檔路徑**(§5-2) | migration **0010**:`uq_software_package_file UNIQUE (file_name)` 改為篩選唯一索引 `ux_software_package_file_active`(只限 draft / tested / published);「尚未登錄的安裝檔」清單不算已撤回的套件。版本號規則不變(已撤回的版本號仍不可重用)。定期複驗與下載本來就略過已撤回的套件 |

**審查**(code-reviewer、security-auditor,2026-10-27):資安 M1(被冒用的裝置每 5 分鐘送延後,指令永不逾時、佔住並行名額)→ 已修:重設上限「開始 + 4 小時 + 類型逾時」、進度 > 0 後不接受延後(§8.2-19);L1(以系統管理員權限建立同名 mutex 可讓 MSI 派送延 15 分鐘後 `INSTALL_BUSY`)→ 不改,管理員本來就能停 Agent;L2(撤回後重新登錄等於重新認可檔案內容)→ 列已知限制 §8.2-18。code-reviewer:契約 / RUNBOOK / 前端 `INSTALL_BUSY` 說明、`result.installer_busy` 顯示 → 已補;「執行前等 15 分鐘可能超過主機逾時」→ 已確認不會:安裝的主機逾時是 4 小時(+ 超過 1800 的部分,含下載與延後),移除 1 小時足夠 15 分鐘 + 套件逾時 + 確認。

**相容**:0.9.3 Agent + 舊主機:`result.deferred` 只是 running 的 result,舊主機只在終態存 result,忽略;其餘照常。新主機 + 0.9.2 Agent:延後時沒有 `deferred`,顯示「執行中」(原行為)。**部署順序**:先套用 0010,再部署新版 endpoint-server(未套用時撤回後重新登錄同一檔案仍回 409,其他功能不受影響)。

**驗收需重測**:L3(SlowMSI `timeout_sec` 300:逾時結果為「Windows Installer 仍在執行」;緊接著派另一個 MSI → 等到 SlowMSI 結束才安裝,或 15 分鐘後 `INSTALL_BUSY`,不出現 1618)、#9(TestInst-C 逾時,exe 類型訊息不變)、#11(電池 / 計量延後:畫面「延後中(原因)」、Agent 日誌每 5 分鐘一行;恢復後繼續仍無法以環境旗標驗證,§5-3)、撤回套件後同一檔案重新登錄、事件詳情 `detect` 以 JSON 顯示。

**上線前待驗**(驗收未涵蓋,需另找環境或資料,§3、§4):#12 批次 > 20 台第二人核可(測試區只有 2 台)、下載 429(同一台 / 全域並行上限,需同時 21 個下載)、Watchdog 在軟體派送中延後升級 Agent(需暫改 pilot 目標版本)、#3 批次第 3 台。HANDOFF 由主工作階段統一更新(草稿見交接筆記)。

### 8.2 風險與已知限制(實作前先看)

1. **全公司任意程式執行**:最高風險功能。防線:目錄第二人覆核、`published` 才能派送、參數字元白名單且不經 shell、簽章者需同時符合主機與本機清單(GPO)、SHA-256、> 20 台第二人核可、全部稽核。
2. **廠商簽章者憑證會換**:本機信任清單以葉憑證指紋比對,廠商每年續約憑證指紋就變,新舊指紋要同時列;GPO 清單需有流程維護(RUNBOOK B10)。
3. **子行程繼承 SYSTEM**:安裝程式可做任何事;只能靠簽章與覆核控管。安裝後不留快取檔。
4. **頻寬**:`SOFTWARE_MAX_CONCURRENT`(20)是軟上限;ADR 0002 估 2,000 台 × 90 MB ≈ 180 GB,NAS 1 GbE 約 30 分鐘,仍需分批與非尖峰時段派送(§9-8)。
5. **沒有使用者互動**:服務在 session 0,安裝程式若跳視窗會卡住;靠靜默參數與逾時,逾時後 Job Object 結束行程樹。已知不靜默的軟體在 `draft` 測試機階段就會失敗,不會進 `tested`。
6. **7-Zip 官方 MSI 未簽章**(實作時再確認當時版本):依 §9-2 由 IT 以公司憑證簽章後登錄;測試期用 P6 的測試簽章憑證(`new-test-signing-cert.ps1`)簽章。
7. **定期複驗在沒有排隊中安裝時不發告警**(需求方 2026-10-27 決定不改):`verifyFiles`(M1)發現軟體庫安裝檔被換掉或不見時,告警 `software_file_tampered` 開在「被取消安裝的裝置」上;該套件當下沒有排隊中的安裝時,只記日誌並拒絕之後的新安裝指令,畫面不會出現告警。
8. **`listPackages` 最多 500 筆**(需求方 2026-10-27 決定不改):軟體目錄清單與「尚未登錄的安裝檔」比對都只取前 500 筆(依名稱);超過時清單不完整,且第 501 筆以後已登錄的檔案會被當成未登錄列出(登錄時仍會因重複回 409)。
9. **版本字串無法解析時當成已安裝**(需求方 2026-10-27 確認列為已知限制;§8.1.4 B-2 的保守做法),所以這類軟體不會自動升級:DisplayVersion 空白或帶非數字後綴時視為已安裝,IT 需先移除再安裝,或改用可比較的偵測規則。
10. **套件的「版本」要與安裝程式寫入的 DisplayVersion 同格式**(§8.1.4 B-2):例如套件填 `2024.1`、登錄檔寫 `24.1`,安裝後確認會判為「仍是舊版」回 `DETECT_FAILED`,之後每次派送都會重裝。登錄前先在測試機確認 DisplayVersion(登錄畫面已提示);pilot 測試會發現。
11. **`REMOVE=` 逐一列出所有功能,效果等於 `REMOVE=ALL`**(需求方 2026-10-27 列為已知限制):程式只擋 `REMOVE=ALL`(含逗號清單、引號、大小寫、`/v` 轉交),把產品的所有功能名稱全部列在 `REMOVE=` 裡仍會移除整個產品;由第二人覆核(發佈前檢視完整安裝參數)時人工判斷。
12. **修改已發佈套件的安裝逾時不需第二人確認**(需求方 2026-10-27 接受):逾時只影響等待時間,不影響安裝的內容;調短可能讓較慢的電腦 `INSTALL_TIMEOUT`、調長會較久佔住串行與並行名額,修改留稽核日誌。
13. **上線前待辦:上架腳本的版本表查詢改用唯讀權限**(需求方 2026-10-27):目前經 ssh 以 root 執行主機 docker、在 endpoint-server 容器內用其 SQL 帳號(有寫入權)查詢,唯讀只靠程式碼,且簽章人員要有主機管理權;正式區上線前改為唯讀 API 或只能 SELECT 的帳號。
14. **上線前待辦:NAS `RustIT\test`、`RustIT\prod` 寫入群組分開**(需求方 2026-10-27,NAS 管理員):路徑分區目前只靠上架腳本檢查,直接用檔案總管或 robocopy 仍可寫入另一區;正式區只給正式簽章人員寫入權。
15. **逾時後的半成品不回復**(需求方 2026-10-27 決定,已知行為):Agent 只結束安裝程式的行程樹,不回復廠商安裝程式已做的變更;MSI 的 deferred 自訂動作在 msiserver 內繼續,可能留下已登錄的產品(驗收 SlowMSI、TestInst-C),之後同套件派送會是 `already_installed`。由 IT 視需要手動移除;名稱含 `rustit` 等受保護字樣的軟體不能經 GigaItApp 移除(驗收 §5-7)。
16. **Watchdog 的「Windows Installer 執行中」判斷有同樣的擁有者問題**(0.9.3 發現,Watchdog 不改):`scm::installer_running`(Watchdog `hands_off` 用)也只認 SYSTEM 擁有的 `_MSIExecute`,所以安裝 / 升級監控 MSI 期間 Watchdog 不會因 Windows Installer 執行中而暫停看守(實際由升級流程的維護中旗標處理,目前未見問題)。修正要出 Watchdog 0.3.6,由需求方決定是否處理。
17. **上線前待驗**(§8.1.5):#12 21 台核可、下載 429、Watchdog 派送中延後升級、批次第 3 台。
18. **撤回後重新登錄同一檔案,等於重新認可該檔案目前的內容**(0.9.3 資安稽核 L2):套件若因檔案被換掉(`software_file_tampered`)而撤回,檔案會重新出現在可登錄清單;重新登錄以當下內容計算雜湊,仍從 draft 開始、需 pilot 測試與第二人發佈。登錄前確認撤回原因(驗收前可另放新資料夾的做法不變)。
19. **延後中的執行逾時上限**(0.9.3 資安稽核 M1):主機在延後中重設執行逾時,但不超過「開始 + 4 小時 + 類型逾時」,且進度 > 0 後不再接受延後;被冒用的裝置不能讓指令永遠佔住並行名額。

### 8.3 測試區 VM 驗收步驟(草案,`RUSTIT-P34` + 另 2 台 IT 同意的電腦;VM 內指令由需求方執行)

**前置**:P7-1 已合併 develop 並部署測試區、migration 0008 已套用 `giganexus_It_Agent_test`、Gateway OpenAPI 草稿批次已發佈、主機 2 `/srv/giganexus/ita-software/` 已建立並放入兩個套件(`7-Zip\<版本>\*.msi`,以測試憑證簽章;`Notepad++\<版本>\*.exe`)、VM 已裝 Agent 0.9.0、7-Zip 測試簽章者與 Notepad++ 簽章者指紋已加入該機 `agent.toml` 的 `[software] trusted_signers`(不是 `[upgrade]`)、VM 設為 `pilot` 環。

| # | 步驟 | 通過條件 |
| --- | --- | --- |
| 1 | 經 BFF 登錄兩個套件(`draft`),對 VM 單台派送 | `succeeded`、`exit_code = 0`;`result.signer` 為預期指紋;詳情出現 `software_installed` 事件;登錄檔可見項目 |
| 2 | `mark-tested`(帶回報的指紋)→ **另一位**覆核者 `publish` | 同一人發佈回 `409`/`403 ITA_REVIEWER_SAME_AS_CREATOR`;第二人成功 |
| 3 | 對 3 台批次派送兩個套件 | 三台皆 `succeeded`;批次進度正確;同時執行不超過上限 |
| 4 | `software.uninstall` 兩個套件 | `succeeded`;`software_removed` 事件;NSIS/Inno 以登錄檔輪詢確認消失 |
| 5 | 重複派送已安裝套件 | `succeeded` + `already_installed = true` |
| 6 | 反向:替換 `software\` 內檔案(同檔名內容不同) | 主機複驗 `ITA_PACKAGE_CHANGED`(下載被拒);繞過主機複驗的測試版 → `HASH_MISMATCH`,安裝程式未啟動 |
| 7 | 反向:移除 VM `[software] trusted_signers` 內的簽章者指紋後重派 | `SIGNER_NOT_TRUSTED`;未簽章檔 → `SIGNATURE_INVALID` |
| 8 | 安裝中斷線:派送後 `Disable-NetAdapter`、安裝完成後再啟用 | 重連後主機收到最終結果,指令只執行一次 |
| 9 | 逾時:`timeout_sec` 設 30 的長時間安裝程式 | `INSTALL_TIMEOUT`,行程樹已結束 |
| 10 | 3010:套件模擬回傳 3010(測試用) | `succeeded` + `reboot_required`;`system.reboot` 排程,畫面提示;重開機後標記清除 |
| 11 | A6:VM 模擬電池(Hyper-V 無電池,以測試旗標 `RUSTIT_TEST_POWER=battery`)與計量網路 | `deferred`;恢復後繼續;超過上限 `DEFERRED_TIMEOUT` |
| 12 | 批次 21 台(用測試資料或多台 VM) | `pending_approval`;同一人核可 `403`;第二人核可後開始;24 小時未核可 `expired` |

查看:VM `C:\ProgramData\GigaNexus\Agent\logs\agent-*.log`、`logs\software\*.log`(`-Encoding UTF8`,系統管理員);主機 `ita.command`、`ita.command_batch`、`ita.software_package`、`ita.device_event`。驗收後還原檢查點。

## 9. 要你決定的事

> 全部已確認(2026-10-20)。第 11 項調整:先以需求方本機電腦 + VM 驗收(2 台),完成標準的第 3 台 IT 電腦待同意後補測。

1. ✅ **套件版本號**:Agent **0.9.0**(P7-2 / P7-3 一起發;Watchdog 不變,目前 0.3.2)。(建議:同意)2026-10-21 調整:原訂 0.8.0,但 0.8.0~0.8.2 已被 P6-3 與 rustls 修補使用,改為 0.9.0。
2. ✅ **未簽章 / 簽章不在本機清單的套件**:所有套件必須有有效 Authenticode 簽章,且簽章者在本機信任清單內;廠商沒簽的檔案(例如 7-Zip MSI)由 IT 以**公司程式碼簽章憑證**簽章後再登錄(沿用 P6-4 簽章流程,MSI 加簽不改內容)。/ 允許目錄標記「未簽章但雜湊釘選」,由本機 GPO 清單列入雜湊(每個新版都要更新 GPO,維運負擔大)。/ 允許未簽章套件只憑主機雜湊(**不建議**:主機被入侵即可推任意程式)。(建議:第一個)
3. ✅ **軟體庫目錄**:NAS 帳密到位前,測試區先用主機 2 `/srv/giganexus/ita-software/`;NAS 掛載(P7-4,含 P6 的 `releases\`)等你提供帳密後做。(建議:同意)
4. ✅ **覆核規則**:`published_by ≠ created_by`(第二人);`tested_by` 可以是建立人。/ 三者都需不同人(IT 人少時太嚴)。(建議:第一個)
5. ✅ **誰能管理軟體目錄**:`endpoint.software.manage` **且**全部公司角色(`ENDPOINT_SCOPE_ALL_ROLES`),與 P6 版本管理一致,因為目錄是全公司共用。/ 只要 `endpoint.software.manage`。(建議:兩者都要)
6. ✅ **批次核可閾值**:> 20 台需第二人核可(B1 的數字);`system.reboot` 批次同樣 > 20 台需核可。/ 所有批次(≥ 2 台)都要核可。(建議:20)
7. ✅ **重開機政策**:3010 / 1641 只標記 `reboot_required`、不強制;`system.reboot` 預設 5 分鐘倒數並提示、`force` 另行確認;`reboot_required` 超過 7 天開告警。/ 3010 時自動排到下班時間(需要「下班時間」定義)。(建議:前者)
8. ✅ **派送時段與頻寬**:先只用並行上限(20 台)控制,下載不限速;正式區上線前依 NAS 與網路實測再決定是否在 Nginx 加 `limit_rate`、是否限制上班時間派送。(建議:同意)
9. ✅ **A6 延後上限**:電池 / 計量網路最多延後 4 小時,逾時失敗讓 IT 重派;`ignore_power` 只對電池有效。/ 不設上限,指令過期為止。(建議:4 小時)
10. ✅ **授權數**:`license_limit` 只做派送時的上限檢查,並以 `display_name` 樣式計數;報表與 MSI 產品代碼計數留路線圖。(建議:同意)
11. ✅ **測試機範圍**(調整:先用需求方本機電腦 + VM):`draft` 套件只能派到 `pilot` 環;P7 驗收的「3 台 IT 電腦」= VM `RUSTIT-P34` + 另 2 台 IT 同意的電腦(**不在使用者電腦上測試**,AGENT.md §5)。(建議:同意,請指定另 2 台)
12. ✅ migration 0008 寫好後先給你看,由 Claude 經同意套用 `giganexus_It_Agent_test`(同 P5、P6)。
13. ✅ **`system.reboot` 批次的核可權限**:需求方 2026-10-21 決定另開核可路由 `POST /v1/batches/{id}/approve-command`、`/reject-command`(`endpoint.command.admin`),`system.reboot` 等非軟體批次走此路由;軟體批次維持 `/approve`、`/reject`(`endpoint.software.manage`)。已實作(`07d5307`),見 §6、§8.1.1 D7。

PLATFORM-PLAN 要配合修正的地方(確認後與 P7-1 一起改):§5.2 `0006_software.sql` → `0008_software.sql`(加 `command_batch.state`);§4.6 補「參數快照」「`draft` 只能派 pilot」「安裝前複驗」「批次核可」;§4.4 補 `system.reboot` 與三個新類型的每台上限;`command-kinds.md` 補三類型與錯誤代碼。
