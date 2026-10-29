# RustIt 端點平台維運手冊(RUNBOOK)

> PLATFORM-PLAN §8 B10。目前有發版(§1,P6-4)、版本回滾(§2,P6-6)、軟體派送失敗處理(§3,P7-6)與廠商簽章者憑證換新(§4,P7-6);大量離線、憑證過期、手動解除安裝、NAS 無法掛載等章節上線前補。

## 1. 發版:建置 → 簽章 → 上架 → 登錄 → 逐環推進

適用:Agent(`rustit-agent.exe`)、Watchdog(`rustit-watchdog.exe`)的新版本。角色:**開發者**(推 tag)、**簽章人員**(持簽章憑證)、**IT 管理員**(GigaItApp 登錄與發佈環)。

| 步驟 | 誰 | 做什麼 |
| --- | --- | --- |
| 0. 版本號 | 開發者 | 改 `RustAgent/crates/agent/Cargo.toml` / `watchdog/Cargo.toml` 的 `version`(Agent 與 Watchdog 各自的版本,semver),合併 `develop` 後在 `main` 建 tag `rustit-v<Agent 版本>`(Maintainer) |
| 1. 建置 | CI(Windows Runner) | tag 觸發 `build:release`(或在 pipeline 手動執行):產出 `release-out/`,**未簽章**:`agent\<版本>\rustit-agent.exe`、`watchdog\<版本>\rustit-watchdog.exe`、`SHA256SUMS.txt`、`RELEASE-INFO.txt`。MSI 因為設定隨部署區寫入,在開發機以 `installer\build-agent-msi.ps1` 另外建置(或 `build-release.ps1 -Env …`) |
| 2. 核對與簽章 | 簽章人員(**自己的電腦**) | 下載 artifact 解壓成 `C:\release-out`,執行 `powershell -ExecutionPolicy Bypass -File RustAgent\installer\sign-release.ps1 -Dir C:\release-out -Thumbprint <正式憑證指紋>`。腳本先核對每個檔案的雜湊與 `SHA256SUMS.txt`(對不上就整批中止),再 `signtool sign /fd SHA256 /tr <時間戳記> /td SHA256`、`signtool verify /pa`,輸出 `SHA256SUMS.signed.txt` 與 `SIGNED-INFO.txt` |
| 3. 上架 | 簽章人員 | `powershell -ExecutionPolicy Bypass -File RustAgent\installer\publish-release.ps1 -Dir C:\release-out -Environment <test|prod>`(必填;先加 `-DryRun` 看會做什麼。`prod` 拒絕測試憑證、要求時間戳記,且要指定正式區主機 `-HostAlias` 與 endpoint-server 容器 `-ServerContainer`)。執行前先以有 NAS `RustIT` 寫入權的帳號連上 NAS(`net use`)。**上架前先查目標區版本表**:建議加 `-GatewayUrl https://<該區 Gateway> -ApiKeyFile <金鑰檔>`,以 API Key(只授 `endpoint.release.registry`、限定來源 IP,Gateway 負責人建立;金鑰檔只能有本人、SYSTEM、Administrators 的權限,不可放網路分享;建立後以 SID 設權限,不要用帳號名稱(不同網域有同名帳號時會授權錯人):`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; icacls <金鑰檔> /inheritance:r /grant:r "*${sid}:(R)" "*S-1-5-18:(F)" "*S-1-5-32-544:(F)"`;Gateway 以 DNS 名稱指定(測試區 `https://giganexus-test.gigasolar.com.tw`))呼叫 `GET /api/endpoint/releases/registry`;`-GatewayUrl` 的主機必須在腳本內該區的允許清單(`$GatewayHosts`),不跟隨重新導向,回應的部署區必須等於 `-Environment`,不需要主機帳號(S1-1);未給時沿用舊方式,經 ssh 在 endpoint-server 容器內唯讀查 `ita.agent_release`,同一元件同一版本號登錄過(**含已撤回**)就停止,要換新版本號重建;查不到(連不上、正式區未部署)也停止,確定沒登錄過才加 `-SkipRegistryCheck`。腳本從本機以 SMB 寫入 NAS 版本檔目錄 `RustIT\{test|prod}\releases\{元件}\{版本}\{檔名}`(同一台 NAS 兩區分開,依 `-Environment` 選;給的 `-NasReleasesDir` 與環境不一致、或是舊的 `RustIT\releases` 就停止),重算 SHA-256 比對;**不覆蓋既有版本檔**。放好後經 ssh 以主機的唯讀掛載再算一次雜湊,確認 endpoint-server 讀得到(主機只唯讀掛載,不能經主機寫入;NAS 之前的主機本機目錄改用 `-HostDir`)。**只放有新版本號的元件**:同一版本號重新建置的檔案內容不同,會被拒絕(`REFUSE`,結束碼非 0,中止前已放好的不回滾);例如只改 Agent 時 CI 也會建一份未改版本的 Watchdog,上架前把它從 `SHA256SUMS.signed.txt` 拿掉,或確認被拒的只有它 |
| 4. 登錄 | IT 管理員 | GigaItApp「端點管理 › 電腦清單 › Agent 版本」→「登錄版本」:挑檔案、填預期簽章者指紋(`SIGNED-INFO.txt` 的 `signer_thumbprint`)。登錄後是**草稿**,SHA-256 與大小由主機計算 |
| 5. pilot | IT 管理員 | 發佈環表把 `pilot` 環的目標設為新版(草稿可以);確認 pilot 的測試機(所屬環 `pilot`)升級成功、運作正常,至少觀察 24 小時 |
| 6. 發佈與推進 | IT 管理員 | 版本清單「發佈」→ 依序把 `it`、`all` 環設為新版。`pilot` 未滿 24 小時就推進會被擋,確認後才能 `force`(寫入稽核)。同時升級台數有上限(`RELEASE_MAX_CONCURRENT`),其餘電腦下次上報再排 |
| 7. 收尾 | IT 管理員 | 看發佈環進度(到目標 / 失敗 / 待開始)與告警 `upgrade_failed`;失敗的電腦在電腦詳情看錯誤與「立即升級」重試 |

**檢查清單(簽章前)**:版本號與變更說明、`SHA256SUMS.txt` 與 CI artifact 一致、簽章憑證是正式憑證(**不是測試憑證**:`SIGNED-INFO.txt` 的 `test_mode=False`)、時間戳記有加(`timestamp` 不是 `none`)。

**測試期**:正式程式碼簽章憑證(IT 的 AD CS,ADR 0003)還沒簽發前,沿用測試憑證(`installer\new-test-signing-cert.ps1`),`sign-release.ps1 -Test -NoTimestamp`,只能上**測試區**;VM 要匯入測試根憑證到 `LocalMachine\Root`。正式區上線前必須換成正式憑證與時間戳記,並移除端點上的測試根憑證。

**簽章的注意事項**
- 簽章在簽章人員的電腦執行,**CI 與 Runner 沒有私鑰**;不要把憑證或私鑰放進 CI 變數、repo 或 Runner。
- 一旦簽過的版本檔就不要重建同版本號:要修東西就升版本號(版本檔目錄不允許覆蓋既有版本)。
- 簽章者換憑證時,新版本登錄時把新舊指紋並列在「預期簽章者」,並確認端點本機信任清單(`agent.toml [upgrade] trusted_signers`,由 MSI 或 GPO 寫入)也有新指紋,否則端點會以 `SIGNER_NOT_TRUSTED` 拒絕。軟體派送的套件另用 `[software] trusted_signers`(§4)。

### 1.1 版本檔與軟體庫目錄切換為 test / prod 分開(B-3,需求方 2026-10-27;**部署步驟,由主討論串安排執行**)

同一台 NAS,兩區路徑分開:

| 用途 | 測試區 | 正式區 | 舊路徑(停用) |
| --- | --- | --- | --- |
| 版本檔 | `\\10.10.130.31\docker-folder\RustIT\test\releases` | `...\RustIT\prod\releases` | `RustIT\releases` |
| 軟體庫 | `\\10.10.130.31\docker-folder\RustIT\test\software` | `...\RustIT\prod\software` | `RustIT\software` |

上架腳本(`feature/p7-acceptance-fixes` 起)只接受 `RustIT\{test|prod}\releases`。測試區目前讀的是舊路徑:主機 2 fstab 把 `//10.10.130.31/docker-folder/RustIT` 唯讀掛在 `/srv/giganexus/nas-rustit`,`ita.env` 的 `ITA_RELEASES_HOST_DIR=/srv/giganexus/nas-rustit/releases`、`ITA_SOFTWARE_HOST_DIR=/srv/giganexus/nas-rustit/software`。**切換前不要用新腳本上架測試區,也不要把新套件放進 `test\software`**(切換時會一併複製)。掛載的是整個 `RustIT`,不用改 fstab。已登錄的版本與套件存的是相對路徑(`{元件}/{版本}/{檔名}`、`{軟體}/{版本}/{檔名}`)與 SHA-256,搬目錄後不用重新登錄。

步驟 1–3 可用一支腳本執行(建目錄、`robocopy`、逐檔比對,不一致就停止;2026-10-27 主討論串的共用筆記 `nas-switch-test.ps1`,內容即下列指令)。寫入 NAS 與改主機設定由需求方執行(AI 的工作階段權限不允許修改共用資源;NAS 帳密不經手)。2026-10-27 盤點:`releases` 6 個檔案(46.7 MB)、`software` 8 個檔案(13.2 MB)。

1. **建立目錄**(有 NAS `RustIT` 寫入權的帳號,在自己的電腦,先 `net use`):
   `New-Item -ItemType Directory -Force \\10.10.130.31\docker-folder\RustIT\test\releases, \\10.10.130.31\docker-folder\RustIT\test\software, \\10.10.130.31\docker-folder\RustIT\prod\releases, \\10.10.130.31\docker-folder\RustIT\prod\software`
2. **複製到 test**(prod 從空的開始:正式版本以正式憑證另行上架,正式套件另行放置):
   `robocopy \\10.10.130.31\docker-folder\RustIT\releases \\10.10.130.31\docker-folder\RustIT\test\releases /E /COPY:DT /R:2 /W:5`,`software` 同法。不要用 `/MIR`、`/MOV`(不刪來源)。
3. **比對雜湊**(兩個目錄都做,完全一致才繼續):
   `function H($r) { Get-ChildItem -Recurse -File -LiteralPath $r | % { '{0} {1}' -f $_.FullName.Substring($r.Length), (Get-FileHash -LiteralPath $_.FullName).Hash } }`
   `Compare-Object (H '\\10.10.130.31\docker-folder\RustIT\releases') (H '\\10.10.130.31\docker-folder\RustIT\test\releases')` 沒有輸出;`software` 同法。另抽查與登錄的雜湊一致(GigaItApp「Agent 版本」、「軟體派送 › 軟體目錄」詳情的 SHA-256)。
4. **主機 2 確認唯讀掛載讀得到**(非機密,可由 Claude 經 `ssh host2` 執行)。主機 2 的 SSH 預設是 PowerShell,`wsl -e sh -c '...'` 內含括號或引號會被拆壞(2026-10-27 實測),**每個指令各下一次 `wsl -u root -e`**:
   `ssh host2 "wsl -u root -e ls -R /srv/giganexus/nas-rustit/test"`、`ssh host2 "wsl -u root -e sha256sum /srv/giganexus/nas-rustit/test/releases/agent/0.9.1/rustit-agent.exe"`(其他檔案同法),雜湊與步驟 3 相同。
5. **改 `ita.env`**(主機 2 `/srv/giganexus/deploy/ita.env`,非機密;先備份)。同樣每個指令各下一次、不用分號(遠端 PowerShell 會把 `;` 當成指令分隔):
   `ssh host2 "wsl -u root -e cp -p /srv/giganexus/deploy/ita.env /srv/giganexus/deploy/ita.env.bak-<日期>"`
   `ssh host2 "wsl -u root -e sed -i -e s#nas-rustit/releases#nas-rustit/test/releases# -e s#nas-rustit/software#nas-rustit/test/software# /srv/giganexus/deploy/ita.env"`
   `ssh host2 "wsl -u root -e grep HOST_DIR /srv/giganexus/deploy/ita.env"` → `ITA_RELEASES_HOST_DIR=/srv/giganexus/nas-rustit/test/releases`、`ITA_SOFTWARE_HOST_DIR=/srv/giganexus/nas-rustit/test/software`(compose 的預設值自 develop `d48eefe` 起也是這兩個路徑)。切換前(2026-10-27)的值是 `.../nas-rustit/releases`、`.../nas-rustit/software`。
6. **重新部署 endpoint-server**:由需求方在 GitLab 重跑 develop 最新 pipeline 的 `deploy-test` job(AI 的 GitLab Token 只有 Pipeline Read,不能重跑)(Retry;它讀 `ita.env`、帶 `IMAGE_TAG` 與 compose 專案名稱,不要在主機上手打 `docker compose`,避免建出另一組容器)。確認 `docker exec giganexus-ita-test-endpoint-server-1 ls /srv/releases/agent /srv/software` 看得到內容。
7. **驗證**:
   - 版本:pilot 測試機 `agent.upgrade`(或 Watchdog 定期上報)下載 200、雜湊相符;新腳本 `-Environment test -DryRun` 不再報路徑不一致。
   - 軟體:GigaItApp「軟體派送 › 軟體目錄」已登錄套件的詳情正常;「登錄套件」的未登錄檔案清單正確;對 pilot 測試機派送一個已登錄套件,下載成功(沒有 `503 ITA_PACKAGE_CHANGED` / `ITA_PACKAGE_UNAVAILABLE`);定期複驗(`verifyFiles`)沒有開 `software_file_tampered` 告警。
8. **舊目錄**:確認一段時間沒問題後,由需求方決定是否刪除 `RustIT\releases`、`RustIT\software`(需 NAS 寫入帳號;刪除前先備份)。
   **回滾**:`ita.env` 兩行改回 `.../nas-rustit/releases`、`.../nas-rustit/software`,重新部署 endpoint-server(舊目錄在步驟 8 之前都還在)。

**OpenAPI**:只改請求 / 回應欄位(例如 P7 VM 驗收修正的 `timeoutSec`、`viewerScopeAll`)時不需要發佈 Gateway 草稿——Gateway 路由表只記路徑、方法與權限,不存請求 / 回應 schema;endpoint-server 啟動日誌 `API 已註冊,與 Gateway 現有設定相同`(`pendingPublish: false`)即表示沒有草稿。此時不要執行 `gw -- publish`(會一併發佈其他服務的草稿)。

正式區(主機 3)部署時直接使用 `RustIT\prod\releases`、`RustIT\prod\software`(掛載方式與主機 2 相同時為 `/srv/giganexus/nas-rustit/prod/...`;不同時上架加 `-MountCheckDir`、`ita.env` 指到實際掛載點)。

## 2. 版本回滾

適用:新版本推出後發現問題(功能異常、效能變差、大量 `upgrade_failed`)。角色:**IT 管理員**(GigaItApp「Agent 版本」;改發佈環要 `endpoint.software.manage` **且**全部公司角色 `ENDPOINT_SCOPE_ALL_ROLES`,P6-UPGRADE-DESIGN §9-5)。

**先分清楚兩件事**

- 單台升級失敗**已自動還原**:Watchdog / Agent 在新版 2 分鐘內不正常時會換回 `previous\` 的舊版並回報 `rolled_back`;同一目標版本失敗 2 次就不再自動嘗試、任何失敗後冷卻 30 分鐘,告警 `upgrade_failed`。這種情況不需要回滾,先看錯誤代碼(電腦詳情「健康與 Agent」)。
- 環目標改成「不升級」**只會停止繼續升級**,已經升上去的電腦不會自己降回來。要降回去,就把環目標設為**舊版本**(降版與升級走同一個流程)。

| 步驟 | 做什麼 |
| --- | --- |
| 1. 止血 | 版本清單對有問題的版本按「撤回」(`POST /api/endpoint/releases/{releaseId}/revoke`):不再下發,以它為目標的環自動改為「不升級」(回應 `clearedRings`),指定這個版本的單台強制升級一併清除。還在下載 / 安裝中的電腦會照常完成或自動還原 |
| 2. 選回滾版本 | 上一個**已發佈**的版本(撤回或草稿版本不能設為 `it` / `all` 目標)。下限:Agent **0.7.0**、Watchdog **0.3.0**(更舊的版本讀不了目前的設定或不會替換 Watchdog,Watchdog 會拒絕);要回到更舊只能重派 MSI |
| 3. 設回滾目標 | 發佈環表把受影響的環(`pilot` → `it` → `all`,只改有升上去的環)目標設為舊版。舊版通常不是 pilot 環滿 24 小時的設定,`it` / `all` 會回 `409 ITA_RING_TOO_EARLY`:確認後帶 `force`(畫面確認對話框;寫入稽核) |
| 4. 觀察 | 發佈環進度(到目標 / 進行中 / 失敗)、告警;同時升級台數有上限(`RELEASE_MAX_CONCURRENT`,預設 20),其餘電腦在下次上報(最多 5 分鐘)時再排,1,000 台約需 1–2 小時 |
| 5. 個別處理 | 單台要立即降版或重試:電腦詳情「升級 Agent」(`agent.upgrade`,`params: { component, version }`,版本必須已發佈),會解除冷卻並重設失敗次數(含 `ROLLBACK_FAILED`) |
| 6. 修正後重發 | 修好後**升新的版本號**重新走 §1(不重用撤回的版本號,版本檔目錄也不允許覆蓋) |

**`ROLLBACK_FAILED`(還原也失敗)**:critical 告警,主機不再對該台下發;看守恢復照常拉起服務。先用 `agent.diagnose` / `logs.collect` 查原因(需要 Agent 還能連線),不行就到現場以系統管理員解除安裝後重新安裝監控 MSI(Windows Installer 依檔案版本決定是否覆蓋,較新的 exe 不一定會被修復蓋回,所以用解除安裝 + 安裝;之後再由發佈環升到目標版本)。此流程尚未在 VM 演練。

**Watchdog 回滾**:流程相同(元件選 `watchdog`)。Watchdog 由 Agent 替換,Agent 必須在執行中;Agent 本身異常時先處理 Agent。

## 3. 軟體派送失敗處理(P7-6)

適用:`software.install` / `software.uninstall` / `system.reboot` 失敗。角色:**IT 管理員**(GigaItApp 端點管理的軟體派送(P7-5 進行中)與電腦詳情「指令」,或直接呼叫 `/api/endpoint/*`)。錯誤代碼定義見 [`contracts/command-kinds.md`](contracts/command-kinds.md);指令 `result.log_tail` 是安裝記錄最後 20 行,完整記錄在該機 `C:\ProgramData\GigaNexus\Agent\logs\software\*.log`(`-Encoding UTF8`,系統管理員)。

**原則**:先看錯誤代碼、再看 `result` 與日誌;**驗證類失敗(雜湊、簽章)不要用「重派」硬過**,先查原因;同一套件在多台同時失敗,先**停止派送**(套件「撤回」會取消尚未送出的安裝,`PACKAGE_REVOKED`),再查。

| 錯誤代碼 | 意義 | 處置 |
| --- | --- | --- |
| `DOWNLOAD_FAILED` | 下載失敗(連線、主機拒絕、軟體庫讀不到 `503 ITA_PACKAGE_UNAVAILABLE`) | 單台:確認在線與 `:9443` 連通後重派。多台:查主機的軟體庫(`SOFTWARE_DIR`,測試區 `/srv/giganexus/ita-software/`)與磁碟、NAS 掛載;主機拒絕(4xx)Agent 不重試,指令不再屬於該裝置時 `404 ITA_PACKAGE_NOT_FOUND` |
| `HASH_MISMATCH` | 下載的檔案 SHA-256 與快照不符,**未啟動安裝程式** | 重派一次排除傳輸錯誤;仍失敗代表軟體庫檔案被換掉或損毀:主機會以 `PACKAGE_FILE_CHANGED` 取消排隊中的安裝並開 `software_file_tampered`(critical),**先通報資安**,不要重登錄同一個檔案;確認來源後以新版本號重新登錄 |
| `SIGNATURE_INVALID` | Authenticode 無效或未簽章 | 確認安裝檔簽章(`Get-AuthenticodeSignature`);廠商未簽章的檔案由 IT 以公司憑證加簽後以新版本登錄(P7-SOFTWARE-DESIGN §9-2);時間戳記 / 根憑證未信任時檢查該機根憑證 |
| `SIGNER_NOT_TRUSTED` | 實際簽章者不在「主機 `signer_thumbprints` ∩ 本機 `[software] trusted_signers`」 | 比對 `result.signer` 與兩份清單;廠商換憑證見 §4;本機清單空白 = 不接受任何套件。`draft` 套件主機清單為空,但仍需在本機清單內 |
| `DISK_FULL` | 磁碟不足(需求 = 安裝檔 × 2 + 1 GB) | 請使用者清理,或先對該機派 `logs.collect` 看磁碟;不要放寬門檻 |
| `INSTALL_FAILED` | 安裝 / 移除程式結束代碼不是成功碼(`result.exit_code`) | 查 `log_tail` 與廠商的結束代碼表;3010 / 1641 屬成功(`reboot_required`),1638 屬已安裝。參數錯誤時修正安裝參數:套件會退回 `draft` 並重新覆核,舊快照的排隊指令被取消(`PACKAGE_CHANGED`) |
| `INSTALL_TIMEOUT` | 超過 `timeout_sec`,已結束行程樹 | 軟體安裝時間長就調高 `timeout_sec`(同樣會退回 `draft`);MSI 逾時後 msiserver 可能仍在作業(訊息「Windows Installer 仍在執行」,Agent 0.9.3),同一台的下一筆 MSI 會先等它結束(最多 15 分鐘);逾時前的變更不回復,視需要手動移除。不靜默的安裝程式會卡在視窗 → 回到 `draft` 測試機找出靜默參數 |
| `INSTALL_BUSY` | 結束代碼 1618(另一個安裝進行中),60 秒間隔重試 3 次仍失敗;0.9.3 起也可能是執行前 Windows Installer 等 15 分鐘仍在執行(未啟動安裝) | 等該機其他安裝 / Windows Update 完成後重派 |
| `DETECT_FAILED` | 結束代碼成功但登錄檔找不到(安裝)或 120 秒內仍存在(移除) | 檢查套件的「偵測規則」(MSI 產品代碼或 DisplayName 樣式)是否寫對;規則錯誤 → 修正後重新覆核;該機實際狀況以登錄檔為準 |
| `UNINSTALL_NOT_SUPPORTED` | 沒有可用的移除指令,或項目在不可移除清單(GigaNexus / RustIt、防毒 / EDR),或移除程式位置不安全 | 不可移除清單是設計行為,不要繞過;其餘請到現場處理 |
| `DEFERRED_TIMEOUT` | 電池 / 計量網路延後下載超過 4 小時 | 等插電後重派;確認要略過電池時派送帶 `ignorePower`(計量網路不可略過) |
| `REBOOT_PENDING` | 重新開機倒數中,安裝 / 移除 / 升級 / 重啟 Agent 被拒 | 重開機完成後重派;不要等了可對該機派 `system.reboot.cancel` 再重派 |
| `REBOOT_LIMITED` | `system.reboot` 超過本機上限(開機未滿 30 分鐘、24 小時內已 3 次、有人登入倒數 < 60 秒) | 設計行為(防止反覆重開機),`force` 也不能繞過;隔天或延長 `delay_sec` |
| `EXPIRED` / `TIMEOUT` | 離線太久超過有效期限(安裝 24 小時、重開機 4 小時)/ 執行逾時 | 電腦上線後重派 |
| `AGENT_UPGRADING` | Watchdog 升級 Agent 時收到 | 升級完成後重派;升級與派送避開同時段(升級會中斷進行中的安裝) |
| `UNSUPPORTED_COMMAND` | Agent 版本低於 0.9.0 | 先升級 Agent(發佈環,§1) |
| `INVALID_PARAMS` | Agent 驗證安裝參數不符(版本差異) | 修正安裝參數,重新覆核後重派 |

**取消待核可 / 排隊中的派送**:待核可批次由建立人「撤回」或第二人「駁回」(`BATCH_REJECTED`);24 小時無人核可自動 `expired`(`APPROVAL_EXPIRED`)。已核可但 Agent 離線的指令,有效期限 24 小時(自核可起算)。

**重開機未完成**:`reboot_required` 的電腦超過 7 天沒重開機會開告警 `reboot_pending`。到畫面對該機派 `system.reboot`(預設 5 分鐘倒數;`force` 需二次確認);人在座位旁不想被重開機,派 `system.reboot.cancel`。重開機本身沒有 `result` 之後的回報:Agent 重開機後補送 `succeeded`(`rebooted: true`)。

**批次大量失敗**:(1)撤回套件止血;(2)對失敗清單依錯誤代碼分類(指令清單篩選 `kind`、`batchId`);(3)只有「下載 / 忙碌 / 逾時 / 過期」這類暫時性失敗才整批重派;(4)驗證類(`HASH_MISMATCH`、`SIGNATURE_INVALID`、`SIGNER_NOT_TRUSTED`)與 `INSTALL_FAILED` 先找出原因;(5)修好後走新的版本登錄 → `draft` 測試機 → `tested` → 第二人發佈。

**告警**:`software_install_failed`(warn,同一台再派同一套件成功自動關)、`reboot_pending`(warn)、`software_file_tampered`(critical,不自動關閉,確認後由 IT 手動關閉)。每台每條規則只留一筆開啟中的告警,同一台多個套件失敗時 detail 只留最近一次。

### 3.1 套件上傳與送簽(S1-3,`docs/S1-SIGNING-DESIGN.md` §3.2、§4)

前置(一次性):NAS 管理員建立上傳帳號(只能寫 `RustIT\<區>\incoming\`、`sign-queue\`)與簽章人員的寫入權(`software\`);主機 2 本人執行 `sudo sh ItAgentBack/deploy/host2-set-nas-upload.sh` 並照輸出改 `ita.env`;SQL 套用 migration 0011;Gateway 發佈 `endpoint.software.upload.*` 路由、建立簽章工作站 API Key(只授 `endpoint.software.sign-check`,限定簽章人員電腦 IP)。

| 步驟 | 誰 | 做法 |
| --- | --- | --- |
| 1. 上傳 | IT | GigaItApp 上傳安裝檔(S1-4 前可用 `POST /api/endpoint/software/uploads?fileName=` 或網路芳鄰放進 `incoming\{軟體}\{版本}\` 後 `POST …/uploads/register`)。路徑就是簽章後在軟體庫的位置,軟體庫已有同路徑會被拒(換新的版本資料夾) |
| 2. 核可送簽 | **另一位** IT(全部公司角色) | `POST …/uploads/{id}/approve`:主機重算雜湊後寫送簽工作單,狀態 `queued`。上傳者本人不能核可 |
| 3. 重簽 | 簽章人員 | `powershell -ExecutionPolicy Bypass -File RustAgent\installer\signing-workstation.ps1 software -Environment <test\|prod> -Thumbprint <軟體發佈憑證> -GatewayUrl https://<該區 Gateway> -ApiKeyFile <金鑰檔>`(先加 `-DryRun`)。每筆先向主機確認 `queued` 與兩人,再複製到本機重算雜湊、檢查原廠簽章(白名單 `%USERPROFILE%\.rustit\vendor-signers.json`,範例 `vendor-signers.example.json`;不在白名單輸入 `yes` 才簽、`reject` 拒絕)、重簽、不覆蓋地放進 `software\`、寫結果檔 |
| 4. 確認 | 主機(自動) | 每分鐘讀結果,重算軟體庫檔案雜湊相符才標記 `signed`;不符 `rejected / RESULT_MISMATCH`(查 endpoint-server 日誌) |
| 5. 登錄與派送 | IT | 照 P7:「尚未登錄的安裝檔」登錄 → pilot 測試 → 第二人發佈。預期簽章者填**軟體發佈憑證**指紋 |

拒絕代碼:`REJECTED`(人工駁回)、`INCOMING_CHANGED`(核可時檔案被換掉)、`NOT_APPROVED`(主機上不是 `queued`:已駁回或偽造的工作單)、`JOB_MISMATCH`(工作單與主機紀錄不一致)、`HASH_MISMATCH`、`ENVIRONMENT_MISMATCH`、`INVALID_JOB`、`INCOMING_MISSING`、`TARGET_EXISTS`、`VENDOR_NOT_ALLOWED`、`RESULT_MISMATCH`、`SIGN_JOB_WRITE_FAILED`。遇到 `NOT_APPROVED` / `JOB_MISMATCH` 要查誰寫了 `sign-queue\`。簽章失敗(token 沒插、時間戳記連不到)不寫結果,修好後重跑即可。

## 4. 廠商簽章者憑證換新流程(B10)

適用:廠商(Notepad++、7-Zip 加簽用的公司憑證等)的程式碼簽章憑證續約或更換,新版安裝檔的簽章者指紋(葉憑證 SHA-1)改變。端點以**葉憑證指紋**比對,換憑證後若本機清單沒有新指紋,新版會以 `SIGNER_NOT_TRUSTED` 被拒;若提早拿掉舊指紋,舊版重派也會被拒。角色:**IT 管理員**(登錄套件)、**GPO 管理者 / 簽章人員**(本機清單)。

信任模型:實際簽章者必須**同時**在 (1) 主機套件的 `signer_thumbprints`(登錄時填)與 (2) 端點 `agent.toml` 的 `[software] trusted_signers`(與升級用的 `[upgrade] trusted_signers` 分開)。兩邊都要換,**順序是先本機、再主機**,因為主機清單可以隨時改,本機清單散佈到全公司需要時間。

| 步驟 | 誰 | 做什麼 |
| --- | --- | --- |
| 1. 取得新指紋 | IT 管理員 | 向廠商或從新版安裝檔取得簽章者指紋(`Get-AuthenticodeSignature <檔> \| Select -Expand SignerCertificate \| Select Thumbprint`);用官方管道核對,不要只相信下載頁面。公司加簽的檔案則是新的公司程式碼簽章憑證(§1) |
| 2. 本機清單加入新指紋(舊的**保留**) | GPO 管理者 | 以 MSI(`build-agent-msi.ps1 -SoftwareSigners "<舊>,<新>"`)或 GPO 把 `[software] trusted_signers` 更新為「舊 + 新」。**同一個區段只能有一行 `trusted_signers`,多個指紋放在同一個陣列**(`trusted_signers = ["<舊>", "<新>"]`):寫成兩行是 TOML 重複鍵,Agent 下次重啟讀不了設定而啟動失敗(2026-10-22 VM 實際發生)。**含 `[software]` 區段的 `agent.toml` 不可給 0.9.0 以前的 Agent 讀**(設定結構會讓舊版啟動失敗),先確認發佈環已將 Agent 全數升到 0.9.0 以上 |
| 3. 確認散佈完成 | IT 管理員 | 抽查各環電腦的 `agent.toml`(或 `agent.diagnose`、事件);GPO 套用有延遲,至少等一個 GPO 更新週期,並確認 pilot 測試機已有新指紋 |
| 4. 主機清單新舊並列 | IT 管理員 | 新版套件登錄時,`signer_thumbprints` 填「新 + 舊」(新舊並列);舊版套件維持原清單 |
| 5. draft 測試 | IT 管理員 | 新版套件(`draft`)派到 pilot 測試機(VM);`result.signer` 應為新指紋 → `mark-tested`(填實際簽章者)→ 第二人發佈(§3 後半) |
| 6. 汰除舊指紋 | IT 管理員 / GPO 管理者 | 確認不再需要舊簽章的版本(舊版套件已撤回或改用新版)後,先從主機清單、再從本機 `[software] trusted_signers` 移除舊指紋;一般至少保留一個季度 |

**注意**
- 本機清單**空白 = 不接受任何套件**,也不是「接受全部」;移除指紋前確認沒有仍要派送的舊版套件。
- 不要把測試憑證指紋留在正式區本機清單:正式區上線時只列正式指紋(P6 檢查清單)。
- 緊急撤銷(憑證外洩):先把該指紋從本機 `[software] trusted_signers` 移除(GPO / MSI,散佈後端點即拒絕),同時在主機撤回相關套件並移除主機清單的該指紋,阻止新的派送。
- 此流程尚未在正式區演練;測試區以 7-Zip 測試簽章與 Notepad++ 簽章者驗證(待 VM 驗收,見 [`test-reports/`](test-reports/) 的 P7 VM 驗收報告 <!-- TODO(P7-6):報告完成後補上檔名與結果 -->)。
