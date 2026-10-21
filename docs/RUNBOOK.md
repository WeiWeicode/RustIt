# RustIt 端點平台維運手冊(RUNBOOK)

> PLATFORM-PLAN §8 B10。目前有發版(§1,P6-4)與版本回滾(§2,P6-6);大量離線、憑證過期、手動解除安裝、NAS 無法掛載等章節上線前補。

## 1. 發版:建置 → 簽章 → 上架 → 登錄 → 逐環推進

適用:Agent(`rustit-agent.exe`)、Watchdog(`rustit-watchdog.exe`)的新版本。角色:**開發者**(推 tag)、**簽章人員**(持簽章憑證)、**IT 管理員**(GigaItApp 登錄與發佈環)。

| 步驟 | 誰 | 做什麼 |
| --- | --- | --- |
| 0. 版本號 | 開發者 | 改 `RustAgent/crates/agent/Cargo.toml` / `watchdog/Cargo.toml` 的 `version`(Agent 與 Watchdog 各自的版本,semver),合併 `develop` 後在 `main` 建 tag `rustit-v<Agent 版本>`(Maintainer) |
| 1. 建置 | CI(Windows Runner) | tag 觸發 `build:release`(或在 pipeline 手動執行):產出 `release-out/`,**未簽章**:`agent\<版本>\rustit-agent.exe`、`watchdog\<版本>\rustit-watchdog.exe`、`SHA256SUMS.txt`、`RELEASE-INFO.txt`。MSI 因為設定隨部署區寫入,在開發機以 `installer\build-agent-msi.ps1` 另外建置(或 `build-release.ps1 -Env …`) |
| 2. 核對與簽章 | 簽章人員(**自己的電腦**) | 下載 artifact 解壓成 `C:\release-out`,執行 `powershell -ExecutionPolicy Bypass -File RustAgent\installer\sign-release.ps1 -Dir C:\release-out -Thumbprint <正式憑證指紋>`。腳本先核對每個檔案的雜湊與 `SHA256SUMS.txt`(對不上就整批中止),再 `signtool sign /fd SHA256 /tr <時間戳記> /td SHA256`、`signtool verify /pa`,輸出 `SHA256SUMS.signed.txt` 與 `SIGNED-INFO.txt` |
| 3. 上架 | 簽章人員 | `powershell -ExecutionPolicy Bypass -File RustAgent\installer\publish-release.ps1 -Dir C:\release-out -Environment <test|prod>`(必填;先加 `-DryRun` 看會做什麼。`prod` 拒絕測試憑證、要求時間戳記,且不可指向主機 2)。複製到主機的版本檔目錄 `{元件}/{版本}/{檔名}`,主機重算 SHA-256 比對;**不覆蓋既有版本檔** |
| 4. 登錄 | IT 管理員 | GigaItApp「端點管理 › 電腦清單 › Agent 版本」→「登錄版本」:挑檔案、填預期簽章者指紋(`SIGNED-INFO.txt` 的 `signer_thumbprint`)。登錄後是**草稿**,SHA-256 與大小由主機計算 |
| 5. pilot | IT 管理員 | 發佈環表把 `pilot` 環的目標設為新版(草稿可以);確認 pilot 的測試機(所屬環 `pilot`)升級成功、運作正常,至少觀察 24 小時 |
| 6. 發佈與推進 | IT 管理員 | 版本清單「發佈」→ 依序把 `it`、`all` 環設為新版。`pilot` 未滿 24 小時就推進會被擋,確認後才能 `force`(寫入稽核)。同時升級台數有上限(`RELEASE_MAX_CONCURRENT`),其餘電腦下次上報再排 |
| 7. 收尾 | IT 管理員 | 看發佈環進度(到目標 / 失敗 / 待開始)與告警 `upgrade_failed`;失敗的電腦在電腦詳情看錯誤與「立即升級」重試 |

**檢查清單(簽章前)**:版本號與變更說明、`SHA256SUMS.txt` 與 CI artifact 一致、簽章憑證是正式憑證(**不是測試憑證**:`SIGNED-INFO.txt` 的 `test_mode=False`)、時間戳記有加(`timestamp` 不是 `none`)。

**測試期**:正式程式碼簽章憑證(IT 的 AD CS,ADR 0003)還沒簽發前,沿用測試憑證(`installer\new-test-signing-cert.ps1`),`sign-release.ps1 -Test -NoTimestamp`,只能上**測試區**;VM 要匯入測試根憑證到 `LocalMachine\Root`。正式區上線前必須換成正式憑證與時間戳記,並移除端點上的測試根憑證。

**簽章的注意事項**
- 簽章在簽章人員的電腦執行,**CI 與 Runner 沒有私鑰**;不要把憑證或私鑰放進 CI 變數、repo 或 Runner。
- 一旦簽過的版本檔就不要重建同版本號:要修東西就升版本號(版本檔目錄不允許覆蓋既有版本)。
- 簽章者換憑證時,新版本登錄時把新舊指紋並列在「預期簽章者」,並確認端點本機信任清單(`agent.toml [upgrade] trusted_signers`,由 MSI 或 GPO 寫入)也有新指紋,否則端點會以 `SIGNER_NOT_TRUSTED` 拒絕。

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
