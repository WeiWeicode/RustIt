# P7 軟體派送:Agent 0.9.2 發版與 VM 驗收

> **狀態:0.9.2 驗收完成,L3 未通過(§5-6);Agent 0.9.3 於 2026-10-28 重驗,L3 與其餘 6 項全部通過,見 §10;「延後第一次回報畫面落後」已於 Agent 0.9.4 修正並重驗通過(§11),另記錄一次間歇性下載 404(§11.4)待查。Watchdog 延後升級(需求方決定不做)、#3 第 3 台、#12、下載 429、延後「恢復後繼續」仍未驗證**(見 §3、§4、§10.3)。測試套件已撤回(§8),其餘清理由需求方處理。取代 2026-10-22 的進行中版本(Agent 0.9.1 / Watchdog 0.3.5 的發版與 #1、#2 結果併入本檔)。
> 依需求方決定先用 2 台(開發機 `S1800-S112009` + VM `RUSTIT-P34`),設計中的「3 台」改 2 台,**第 3 台待補**。
> 測試人:需求方(簽章、GigaItApp 操作、VM 內指令、NAS 放檔;第二人 V112001),Claude(雜湊與主機資料唯讀查證、經內建瀏覽器操作 GigaItApp、測試工具製作)。2026-10-27 起 GigaItApp 的登錄 / 派送 / 撤回由 Claude 在需求方已登入的瀏覽器操作,每個寫入都先取得需求方同意。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 部署區 | 測試區(主機 2);MR RustIt !58、GigaItApp !11、docs !59 !60 已合併 |
| 程式 | develop `481a735`(需求方本機 `git pull gitlab develop` 後) |
| 測試機 | VM `RUSTIT-P34`(`pilot` 環);開發機 `S1800-S112009`(`all` 環) |
| NAS | 測試區改走 `RustIT\test\{releases,software}`(主機 2 唯讀掛載 `/srv/giganexus/nas-rustit/test/...`) |
| 簽章 | 測試憑證 `bb8ced00c84798f6e098581e50f41b2ee4247cd3`(`sign-release.ps1 -Test -NoTimestamp`);Notepad++ 廠商簽章 `1e8e0d13b608ba908572c1a129faec5d228df8a2`;第二測試憑證 `2953e8c04eabefd6c6fb35491de6671dd808b46b` |

## 2. 發版結果

| 元件 | 簽章後 SHA-256 | 結果 |
| --- | --- | --- |
| Agent 0.9.2 | `d3e6bddf3cfde97c30ccc8b8d77733a25a0f8137530431af67cfe5f05bb888a3`(9,669,512 B) | `publish-release.ps1 -Environment test`:版本表查詢通過、掛載雜湊相符、上架完成;VM 0.9.1 → 0.9.2 `upgrade_succeeded` |
| Watchdog 0.3.5 | (前次已登錄;0.9.2 發版時 `SHA256SUMS.signed.txt` 只留 agent 行) | 再次上架時被擋下(已登錄過該版本),符合新防重複機制 |

- **版本防呆實測**:同版本重建被擋(`REGISTERED agent 0.9.2 … 已登錄過`);被撤回的版本不可重用。
- `all` 環曾因需求方誤用 force 先指向 0.9.2 又切回 0.9.1;之後設回 0.9.2,開發機由 0.9.0 升級。
- 開發機升級先遇 `SIGNATURE_INVALID`(測試根憑證不在 LocalMachine\Root),需求方匯入測試憑證後成功(**驗收後要移除該憑證**)。

## 3. §8.3 十二項

| # | 項目 | 結果 | 觀察 |
| --- | --- | --- | --- |
| 1 | 登錄兩套件、VM 單台派送 | **通過** | 兩套件登錄、VM 單台派送成功;`device_event` 有 `software_installed`;登錄檔與主機 `device_software` 一致 |
| 2 | `mark-tested` 與第二人發佈 | **通過** | `7-Zip 26.05.0`:S112009 登錄(11:58)、V112001 標記測試完成(13:04)並發佈(13:06),登錄人≠發佈人;S112009 的「發佈」按鈕停用;預期簽章者與測試機回報簽章者皆 `bb8ced00…`。「無角色者發佈鈕停用」僅在 `TestInst 1.0.1` 驗證到「修改 / 撤回停用」,「發佈」鈕未單獨截圖 |
| 3 | 批次(3 台改 2 台) | **部分通過(2 台)** | Notepad++ 8.9.8 + 7-Zip 26.05.0 × `S1800-S112009`、`RUSTIT-P34`:四筆皆成功。開發機原本就裝這兩個,等同 `already_installed`,真安裝只在 VM。**第 3 台待補** |
| 4 | 移除 | **通過** | VM 移除 7-Zip 26.05.0:結束代碼 0,耗 2 秒(requestId `f7b5150333d9`);Notepad++、7-Zip 的移除先前已在 VM 驗證 |
| 5 | 重複派送已安裝 | **通過** | 開發機 / VM 重派 Notepad++ → `already_installed`、不下載 |
| 6 | 替換軟體庫檔案 | **通過** | 見 §4-1 |
| 7 | 簽章者不在清單 / 未簽章 | **通過** | `SIGNER_NOT_TRUSTED`(Notepad++、7-Zip 各一次,本機 `[software] trusted_signers` 補上指紋後成功);`SIGNATURE_INVALID 0x800B0109`(測試根未信任)。完全未簽章檔案未另測 |
| 8 | 安裝中斷線 | **通過** | `RustIt-TestInst-B`(`/reg /sleep=120`),約 60 秒中斷 VM 網路(需求方操作,起訖時間未精確記錄):成功、結束代碼 0、耗 121 秒,指令紀錄只有一筆(requestId `2f4207429fe2`) |
| 9 | 逾時 | **通過** | `RustIt-TestInst-C`(`/reg /sleep=400`、`timeout_sec` 300):14:17 → 14:22 `INSTALL_TIMEOUT`「300 秒仍未結束,已結束安裝程式的行程樹;Windows Installer 已沒有進行中的安裝」(requestId `f69afb8fe145`);VM 無 `rustit-testinst` 殘留進程;登錄檔項目已被寫入(程式先 `/reg` 再 sleep),見 §6 |
| 10 | 3010 | **通過** | `RustIt-TestInst-A`(`/reg /exit=3010`):成功、「安裝完成,結束代碼 3010」+「需要重新開機」+「偵測到已安裝」(requestId `0827622360f1`);VM 未自動重開(`reboot_policy=never`) |
| 11 | A6 電池 / 計量網路 | **部分通過** | `battery`:派 A 後事件停在「執行中」、無 staging 下載;移除旗標後對照派送 2 秒成功(requestId `f518a6c8bddf`)。`metered`(15:37~15:39):派 A 不略過(15:37:09)與勾「略過電池延後」(`ignore_power = true`,15:38:06)兩筆都停在「執行中」,**略過開關不略過計量網路**,符合設計;旗標清除並重啟 Agent 後兩筆皆 `EXECUTION_FAILED`「Agent 在執行期間停止,未完成」(第二筆 requestId `ad221acf2f1e`、commandId `8b63916f-564e-45e4-94e1-a62f0aa89d0c`)。**恢復後繼續**無法驗證(見 §5-3);`DEFERRED_TIMEOUT`(4 小時)未實測 |
| 12 | 批次 21 台核可 | **未驗證** | 測試區電腦清單只有 2 台,門檻 > 20 台無法達成;補驗需 21 台測試資料(動資料庫)或更多機器 |

## 4. 0.9.2 新行為

| 項目 | 結果 | 觀察 |
| --- | --- | --- |
| 1. 替換軟體庫檔案(#6) | **通過** | NAS 把 `RustIt-TestInst-B\1.0.0\rustit-testinst.exe` 換成不同內容(`20b1eb49…`,登錄值 `f3556f7e…`)。**下載時複驗**:VM 派 B → `DOWNLOAD_FAILED` HTTP 503 `ITA_PACKAGE_CHANGED`「安裝檔內容與登錄不符」,安裝程式未啟動(requestId `4f62e4091fa4`、主機 reqId `6c6d0f52242ffc59b0ba42a238b0fd4a`),並對 VM 開告警 `d28ac339-8cc2-44a6-8ae3-f4fe1c87e1cb`。**定期複驗**:重啟 `giganexus-ita-test-endpoint-server-1`(14:41:42)後 10 分鐘(約 14:51:43)日誌 `軟體庫定期複驗完成 checked 9 changed 1`,列出 expected / actual 雜湊與大小(242,568 → 1,665,440)。恢復一致的路徑未實測 |
| 2. 套件 `timeout_sec` | **通過** | 300 秒實際採用(#9) |
| 3. 版本比較 | **通過** | Notepad++ 8.8.9 → 8.9.8、7-Zip 21.07 → 26.05 升級成功;同版本 / 較新 `already_installed`;登錄 `26.05.2.0.0` 但實際為 26.05 → 安裝後等待登錄檔版本到達不了 → `DETECT_FAILED`;`RustIt-TestInst 1.0.1`(程式固定寫 `1.0.0`)→「結束代碼成功,但偵測結果與預期不符,偵測到 1.0.0」。版本補零規則:`26.05.0` = `26.05` 通過 |
| 4. 新禁止參數 | **通過** | `REMOVE=ALL`、`REMOVE=ALL,Foo`、`/vREMOVE=ALL` 於登錄時被拒 |
| 5. 結果欄位 | **通過** | 結果含 `installed_version`(偵測到版本 1.0.0、26.05、8.9.8);`already_installed` 不重裝 |
| 6. 停服務 / 關機時中斷安裝後等待 | **通過** | `RustIt-TestInst-D 1.0.1`(`/reg`,版本高於程式寫入的 1.0.0,使 Agent 進入等待登錄檔)15:12:18 派送、15:12:25 `Stop-Service GigaNexusAgent`:Agent 日誌「收到停止要求,收尾中」→ 指令 `EXECUTION_FAILED`「安裝程式已結束(結束代碼 0),確認登錄檔期間 Agent 停止(服務停止或關機),未確認結果;請重新派送確認」(requestId `536950258ee2`);沒有等滿 120 秒,服務 15:12:27 重新啟動,離線期間事件補送 1 筆 |
| 7. L3 逾時後 msiserver 等待(SlowMSI) | **未通過** | `RustIt-SlowMSI 1.0.0`(`timeout_sec` 300)15:17:50 派送:300 秒後(15:22:50)`INSTALL_TIMEOUT`「已結束安裝程式的行程樹;Windows Installer 已沒有進行中的安裝」。但 15:29 VM 手動操作仍出現 Windows Installer 1618「正在安裝其他程式」;MSI 日誌 `dc42c494-….log` 最後一行是 `CustomActionSchedule(Action=SlowCA, Target=/sleep=2100)`,自訂動作約到 15:53 才結束。見 §5-6 |
| 8. Watchdog 軟體派送中延後升級 | **未驗證(需求方決定不做)** | 需暫時把 pilot 環目標版本改成 0.9.0 再派長時間安裝,風險較高 |
| 9. 下載 429 | **不可行** | 需同時 21 個下載,測試區 2 台 |
| 10. 無角色者發佈鈕 | **部分** | 見 §3 #2 |

## 5. 發現(交給主工作階段)

1. **TestInst 與 0.9.2 版本檢查不相容(測試工具,非 Agent)**:`rustit-testinst.exe /reg` 固定寫登錄檔版本 `1.0.0`,0.9.2 要求登錄版本 ≥ 套件版本,所以規劃的 `1.0.1 / 1.0.2 / 1.0.3` 套件全部 `DETECT_FAILED`。本次改用同檔案、名稱不同、版本 `1.0.0` 的 `RustIt-TestInst-A/B/C`。若要保留多版本,測試工具要支援 `/ver=`。
2. **撤回後安裝檔路徑不會釋放**:`RustIt-TestInst 1.0.1` 撤回後,登錄畫面的「安裝檔」清單仍沒有該檔;同一檔案要重新登錄,必須複製到新資料夾。RUNBOOK §1 只說「已撤銷版本號不可重用」,沒提路徑。
3. **電池 / 計量延後無法用環境旗標驗證 resume**:旗標是 Agent 進程環境變數,改動後必須重啟 Agent,重啟會把延後中的指令終止(原指令 `4e66e56a…` 變 `EXECUTION_FAILED`「Agent 在執行期間停止,未完成」)。設計 §8.3 第 11 項的「恢復後繼續」需另外的驗證方式。
4. **延後沒有明確日誌 / 畫面**:延後期間事件只顯示「執行中」,Agent 日誌只有「收到指令」,`logs\software` 沒有紀錄;只能由「沒有 staging 下載、同套件平時 1 秒完成」推論。建議延後時寫一行日誌,畫面顯示 `deferred`(設計 §8.3 第 11 項預期 `deferred`)。
5. **7-Zip 判斷值 / 版本需對應**:登錄 `7-Zip 26.05.2.0.0` 與實際顯示 26.05 不符導致 `DETECT_FAILED`;登錄畫面沒有檢查版本欄與 DisplayVersion 的對應。
6. **L3:逾時後宣告「Windows Installer 已沒有進行中的安裝」與事實不符**:SlowMSI 的自訂動作在 msiserver 內持續睡 2100 秒,Agent 在 300 秒結束 `msiexec` 客戶端行程樹後直接判定 Windows Installer 已空閒,實際上 msiserver 仍占用(15:29 有 1618,產品登錄已寫入、ARP 看得到)。後果:事件失敗但 VM 留下半裝產品,且之後約 30 分鐘內任何 MSI 派送都會 1618。與設計 §8.2 L3 的「逾時後等 Windows Installer 結束」不符,需查判斷方式(是否只看客戶端行程、未看 msiserver 的執行中安裝)。
7. **名稱含 `rustit` 的軟體不可移除**:`RustIt Test Slow MSI` 派「移除」回 `UNINSTALL_NOT_SUPPORTED`(符合「rustit」,監控本身 / 防毒 / EDR 保護規則),屬設計行為(requestId `5716402c3f41`);但名稱含 RustIt 的測試軟體無法經 GigaItApp 清理,需在機器上手動移除。

## 6. 觀察 / 潛在風險

- **逾時後不清理半成品**:安裝程式在逾時前已寫入登錄檔,事件顯示失敗但 Programs 清單有「RustIt Test Installer 1.0.0」,同套件再派會是 `already_installed`。Agent 不應回復廠商安裝程式的變更,記為觀察。
- 需求方在 `all` 環誤用 force 讓 0.9.2 提早推到全部;pilot 24 小時規則在測試區因只有 VM 在 pilot 而無影響。
- 開發機 `agent.toml` 的 `[software] trusted_signers` 因驗收增加 `2953e8c0…`、`1e8e0d13…`、`bb8ced00…`;備份 `agent.toml.bak-20261027`、`.bak2-20261027`。
- 事件詳情的 payload 顯示 `detect = [object Object]`(JS 物件被字串化),可改為 JSON 顯示(GigaItApp 小問題)。
- 定期複驗只在容器啟動後 10 分鐘與每天一次;沒有排隊中的安裝時不發告警(設計 §9 項 7 已決定不改)。
- **逾時後半成品**:除 #9 的 TestInst 外,SlowMSI 逾時後產品已登錄且 msiserver 仍占用(見 §5-6)。
- 本次 GigaItApp 操作改由內建瀏覽器(需求方登入)進行,事件詳情對話框需捲動才看得完整,通用頁面在 531 px 寬度下可用。

## 7. 測試工具(不進 repo)

| 檔案 | 用途 | SHA-256(測試憑證簽章後) | NAS 位置 |
| --- | --- | --- | --- |
| `rustit-testinst.exe` | Rust 小程式:`/sleep=N`、`/exit=C`、`/reg`(寫 Uninstall `RustIt Test Installer` 版本 1.0.0)、`/unreg` | `f3556f7e4342e9e2084b7dadc34f0cd1ce8c2304f5b33988122301188f78420b` | `software\RustIt-TestInst\1.0.1|1.0.2|1.0.3\`、`RustIt-TestInst-A|B|C\1.0.0\` |
| `rustit-test-slow.msi` | WiX 5,deferred 自訂動作 `SlowCA` 在 msiserver 內 `/sleep=2100`(產品 `{20ADC0A9-4C08-412D-82B4-222694115B82}`) | `03dd5d064ad028d3d7a8de7cd41519d200914bfa2573706f68a1ab5a9d6b0d99` | `software\RustIt-SlowMSI\1.0.0\` |

## 8. 清理清單(需求方決定)

- **撤回 / 移除測試套件(2026-10-27 已由 Claude 經內建瀏覽器撤回,需求方同意)**:草稿 `RustIt-TestInst 1.0.2`、`1.0.3`、`RustIt-SlowMSI 1.0.0`(逾時已改 300 秒)、`RustIt-TestInst-A|B|C|D`;已撤回 `RustIt-TestInst 1.0.1`、`7-Zip 26.05.2.0.0`、`26.05.2.0`、`26.05.1`、`26.05`。已發佈的 `7-Zip 26.05.0`、`7-Zip 26.05.2`、`Notepad++ 8.9.8` 是否保留由需求方決定。
- **VM**:`RustIt Test Slow MSI` 要待 msiserver 空閒(約 15:53 後)**手動**移除(名稱含 rustit 不可經 GigaItApp 移除);`RustIt Test Installer` 已移除;另移除 7-Zip、Notepad++;`RUSTIT_TEST_POWER` 已清除;驗收後還原檢查點。
- **開發機**:移除匯入的測試根憑證;`agent.toml` 還原備份;視需要移除 7-Zip 21.07 / 26.05、Notepad++ 8.8.9 / 8.9.8、`RustIt Test Slow MSI`。
- **NAS 測試檔(寫入權限需求方)**:`software\RustIt-TestInst\{1.0.1,1.0.2,1.0.3}\`、`RustIt-TestInst-{A,B,C}\1.0.0\`(含 B 的 `.bak` / 替換檔,需先還原)、`RustIt-SlowMSI\1.0.0\`;`releases\watchdog\0.3.3\` 殘留(見 2026-10-22 紀錄)。
- 告警 `d28ac339-8cc2-44a6-8ae3-f4fe1c87e1cb`(software_file_tampered,VM)待處理。

## 9. 下一步

測試套件已撤回。待需求方處理:VM / 開發機測試軟體、測試根憑證、NAS 測試檔(須套件撤回後再刪)、告警 `d28ac339-…`。待主工作階段:L3 查因、#3 第 3 台與 #12 的補驗環境。#12 與新行為 9(429)在測試區無法驗證,交主工作階段決定是否另找環境。

## 10. 0.9.3 重驗(2026-10-28)

> 測試人:需求方(VM 內指令、GigaItApp 已登入的瀏覽器),Claude(經內建瀏覽器操作 GigaItApp;每項寫入限於需求方 2026-10-28 同意的範圍:登錄、派送、移除)。時間為 VM / 開發機本地時間(UTC+8)。
> 程式:develop `9d70306`(含 Agent 0.9.3、GigaItApp !12);VM `RUSTIT-P34`:Agent 0.9.3、Watchdog 0.3.5;`pilot` 環。

### 10.1 結果總表

| # | 項目 | 結果 |
| --- | --- | --- |
| 0 | 前置:VM 升到 0.9.3、msiserver 空閒 | **通過** |
| 1 | L3:SlowMSI 逾時 → 緊接 Notepad++ MSI | **通過** |
| 2 | #9:exe 類型逾時訊息不變 | **通過** |
| 3 | #11:延後顯示與日誌(電池、計量網路) | **通過**(「恢復後繼續」仍無法驗證) |
| 4 | 撤回後重新登錄同一安裝檔 | **通過** |
| 5 | 事件詳情 `detect` 以 JSON 顯示 | **通過** |
| 6 | 回歸:Notepad++ 單台派送、同版本重派 | **通過** |

### 10.2 逐項證據

**0. 前置**
- 步驟:VM 查執行檔版本與 Agent 日誌;查 `RustIt Test Slow MSI` 是否還在、`Global\_MSIExecute`、`msiexec`。
- 預期:Agent 0.9.3、日誌有「Agent 0.9.3 啟動」、事件 `upgrade_succeeded`;SlowMSI 已不在,msiserver 空閒。
- 實際:`rustit-agent.exe` 0.9.3、`rustit-watchdog.exe` 0.3.5,服務 Running;`agent-2026-10-27.log` 16:44:10「Agent 0.9.3 啟動」(最新的日誌檔看不到,因為在 10-27 的檔);電腦詳情「事件」Tab:10-27 16:44 `upgrade_succeeded` `{"component":"agent","duration_ms":23958,"from":"0.9.2","to":"0.9.3"}`;`RustIt Test Slow MSI` 已不在(原先預期要手動移除,實際上 10-27 16:39 已移除,事件「移除軟體 RustIt Test Slow MSI」);`_MSIExecute` 不存在、無 `msiexec`。VM 殘留 7-Zip 26.05、Notepad++ 8.9.8。
- 前置動作:08:49 經 GigaItApp 移除 VM 的 Notepad++ 8.9.8(結束代碼 0,cmd `cb4c7d1b…`),讓 L3 的 Notepad++ 是真安裝。

**1. L3(SlowMSI 逾時 → Notepad++ MSI)**
- 步驟:登錄 `RustIt-SlowMSI2 1.0.0`(MSI,產品代碼 `{20ADC0A9-4C08-412D-82B4-222694115B82}`,`timeout_sec` 300,與撤回的 SlowMSI 同一安裝檔)→ 08:50:52 派到 VM(cmd `7cac4691-7aad-4c42-bef8-9473ce6e9767`,見 VM Agent 日誌)→ 逾時後 09:01:05 派 Notepad++ 8.9.8(cmd `52d57952…`,requestId `e74dcd5d053c`)。
- 預期:SlowMSI 結果為「Windows Installer 仍在執行」;Notepad++ 等待至空閒,或 15 分鐘後 `INSTALL_BUSY`,不得 1618。
- 實際:
  - 08:56:53 `INSTALL_TIMEOUT`「超過 300 秒仍未結束,已結束安裝程式的行程樹;Windows Installer 仍在執行(安裝在 Windows Installer 服務內繼續進行,逾時前的變更不回復);同一台的下一筆 MSI 派送會先等它結束」;日誌 08:56:53「Windows Installer 等了 60 秒仍在執行,不再等待」(逾時後多看 60 秒,與設計相符)。
  - 09:01:06 日誌「Windows Installer 仍在執行,等它結束再執行 msiexec(每 30 秒檢查,最多 15 分鐘)」;`Get-Process msiexec` 仍有 `msiserver` 的行程(Id 8088,啟動 08:49:15 起;SI 0)。
  - 09:16 `INSTALL_BUSY`「Windows Installer 仍在執行(已等 15 分鐘),未啟動安裝程式;請稍後重新派送」(建立 09:01 → 結束 09:16);**沒有出現 1618,也沒有啟動 Notepad++ 的 msiexec**。SlowMSI 的自訂動作約 09:26 結束(09:26:04 `_MSIExecute` 不存在)。
- 判定:通過。0.9.2 的錯誤(誤報「已沒有進行中的安裝」、之後 30 分鐘內任何 MSI 派送撞 1618)已不重現。

**2. #9 TestInst-C 逾時**
- 步驟:登錄 `RustIt-TestInst-C2 1.0.0`(`/reg /sleep=400`,exe,`timeout_sec` 300,判斷值 `RustIt Test Installer`,與撤回的 C 同一安裝檔),msiserver 空閒時派送。
- 預期:`INSTALL_TIMEOUT`,訊息與 0.9.2 相同。
- 實際:09:27 → 09:32 `INSTALL_TIMEOUT`「超過 300 秒仍未結束,已結束安裝程式的行程樹;Windows Installer 已沒有進行中的安裝」(requestId `1d8a17802cb4`),與 0.9.2 的訊息一致。
- 觀察:第一次派送(09:18,cmd `da20062d…`,requestId `87d94564b5dc`)當時 SlowMSI 的 msiserver 仍占用,結果訊息變成「…;Windows Installer 仍在執行(…);同一台的下一筆 MSI 派送會先等它結束」,且多等 60 秒(09:18 → 09:24)。exe 類型逾時後同樣檢查 msiserver,是 0.9.3 的設計行為,不算缺陷;但驗收 #9 時 msiserver 必須空閒才能比對 0.9.2 訊息,因此重做一次(上列通過的一筆)。

**3. #11 延後**
- 步驟:VM 系統環境變數 `RUSTIT_TEST_POWER=battery`、重啟 `GigaNexusAgent`(09:34),派 `RustIt-TestInst-D2 1.0.0`(`/reg`,不勾「略過電池延後」,cmd `530aabc7…`,requestId `2760b30f3805`);之後改 `metered`、重啟(09:49),再派一次(cmd `60753fb3…`,requestId `c465882196fb`)。
- 預期:畫面顯示「延後中(原因)」;Agent 日誌每 5 分鐘一行。
- 實際:
  - battery:畫面「延後中(電池供電)」,說明「電腦目前電池供電,Agent 延後下載(每 5 分鐘重新檢查,最多 4 小時;計量網路不因『略過電池延後』而略過);下次檢查 09:46」。日誌 `09:36:03.180`、`09:41:03.198`、`09:46:03.210` 各一行「RustIt-TestInst-D2 1.0.0:電池供電,延後下載,下次檢查 …(已延後 0 / 5 / 10 分鐘,最多 240 分鐘)」,間隔 5 分鐘整。
  - metered:畫面「延後中(計量網路)」,下次檢查 09:59(09:55 看到)。
  - 重啟 Agent 會終止延後中的指令(battery 那筆在 09:49 重啟後結束,與 0.9.2 §5-3 相同,預期行為);**「恢復後繼續」仍無法以環境旗標驗證**。
- 觀察(不影響通過):派送後頭幾分鐘畫面仍是「執行中」,到第二次檢查前後才變成「延後中」(battery:09:36 派、09:37 仍「執行中」、09:41 後看到「延後中」;metered:09:49 派、約 09:55 已是「延後中」)。日誌在派送當下(09:36:03)就有延後行,所以 Agent 端立即進入延後,畫面落後的原因未查明。可能原因:`RustAgent/crates/agent/src/command.rs` `report_deferred` 以 `running` 回報,與先前的 `running` 狀態相同,主機或前端可能只在 `result.deferred` 變動(`next_check_at` 更新)時才反映;可往 endpoint-server 暫存 `result.deferred` 與 GigaItApp 指令列表輪詢間隔查。
- 清理:09:57 已清除 `RUSTIT_TEST_POWER`(`GetEnvironmentVariable(...,'Machine') -eq $null` → True)並重啟 Agent。

**4. 撤回後重新登錄同一安裝檔**
- 步驟:開「登錄套件」,查安裝檔下拉清單;用同一檔案登錄。
- 預期:撤回套件的安裝檔重新出現在清單,可登錄,從 draft 開始。
- 實際:清單列出已撤回套件的安裝檔(SlowMSI、TestInst 1.0.1~1.0.3、A、B、C、D;0.9.2 時這些檔不在清單內,見 §5-2)。三次登錄都成功且為「草稿」:`RustIt-SlowMSI2 1.0.0`(id `95b05420-55bb-4b06-aec8-ab714c73be90`)、`RustIt-TestInst-C2 1.0.0`(id `b4ef52e7-c5c9-4ae2-a731-394feb80fe5d`)、`RustIt-TestInst-D2 1.0.0`(id `4d56a1cd-e5f1-4bbb-94b8-32d60c622d87`)。migration 0010 生效。
- 附註:以原名稱 `RustIt-SlowMSI 1.0.0` 重新登錄回 409「同名同版本或同一檔案已登錄過」,符合設計(已撤回的版本號不可重用);改名後成功。

**5. 事件詳情 `detect` 以 JSON 顯示**
- 實際:指令詳情的參數行為 `…detect = {"type":"display_name","value":"Notepad++%"},timeout_sec = 1800,reboot_policy = never`(INSTALL_BUSY 那筆);電腦詳情「事件」Tab 的 `upgrade_succeeded` 內容為 JSON 文字。不再出現 `[object Object]`。

**6. 回歸**
- Notepad++ 單台派送:09:58(VM 剛重啟 Agent、顯示離線,指令排隊後送出)成功,「安裝完成,結束代碼 0,耗時 3 秒。偵測到已安裝」「偵測到版本 8.9.8」「簽章者 `1e8e0d13…`(NOTEPAD++)」(cmd `b08eaedb…`,requestId `6dbbcae676d8`);事件「安裝軟體 Notepad++ (x64) · 8.9.8」。
- 同版本重派:09:59 成功「已經安裝(偵測到 8.9.8),未重複執行。偵測到已安裝」(cmd `5ecf6b52…`,requestId `eea979841817`),沒有下載。

### 10.3 未涵蓋與觀察

- 延後「恢復後繼續」、`DEFERRED_TIMEOUT`(4 小時)、#12、下載 429、#3 第 3 台、Watchdog 延後升級:同 §3、§4,未驗證。
- GigaItApp 移除名稱含「rustit」的軟體回 `UNINSTALL_NOT_SUPPORTED`(`RustIt Test Installer` 屬保護規則,requestId `5527cb74e548`),測試用 TestInst 套件每次都要在 VM 手動清登錄(`HKLM\...\Uninstall\RustItTestInst`);重新派 `/reg` 前不清會變 `already_installed`。
- 事件列表「安裝軟體 / 移除軟體」依登錄檔差異產生:`RustIt Test Slow MSI` 的 ARP 項目被手動刪除後(見 §10.4),列表沒有對應的「移除軟體」事件。

### 10.4 本次在測試區留下的痕跡

| 位置 | 內容 | 建議處理 |
| --- | --- | --- |
| GigaItApp 軟體目錄 | 新登錄 3 個**草稿**:`RustIt-SlowMSI2 1.0.0`、`RustIt-TestInst-C2 1.0.0`、`RustIt-TestInst-D2 1.0.0`(id 見 §10.2-4) | 驗收後撤回(不刪檔;NAS 檔案撤回後才可刪) |
| 指令紀錄 | VM 上本次的安裝 / 移除軟體指令(2026-10-28 08:49 起) | 保留 |
| VM `RUSTIT-P34` | Notepad++ 8.9.8 已安裝(重驗後);7-Zip 26.05 仍在;`RustIt Test Installer` 登錄項目已清;**`RustIt Test Slow MSI` 的「新增或移除程式」項目被需求方在 09:26 誤刪**(本應只刪 `RustIt Test Installer`;Windows Installer 的產品註冊 `{20ADC0A9-4C08-412D-82B4-222694115B82}` 仍在,可用 `msiexec /x {20ADC0A9-4C08-412D-82B4-222694115B82}` 移除);SlowMSI 的 msiserver 工作 09:26 已結束 | 驗收後還原檢查點,或手動移除產品代碼上列項目 |
| VM 環境變數 | `RUSTIT_TEST_POWER` 已清 | 無 |
| `agent.toml`、`ita.env`、NAS、migration、發佈環 | 本次未動 | 無 |
| 0.9.3 發佈狀態 | 仍為草稿,`pilot` 環目標 0.9.3、`all` 0.9.2、`it` 0.9.1,未動 | 通過後由主討論串安排發佈 |

## 11. 0.9.4 發版與重驗(2026-10-28)

> 0.9.3 重驗(§10)發現「延後第一次回報畫面落後」,另一個子任務修正為 Agent 0.9.4(RustIt !69,`9c06b12`,merge `a73f241`):`ws.rs` `flush_updates` 60 秒內同 state 跳過、`store.rs` `command_reported` 只比 state,把未送出的 `running + result.deferred` 標成已送;修正後延後開始 / 下次檢查時間 / 延後結束立即送出。只改 Agent,Watchdog 不變(0.3.5),無 migration,endpoint-server / GigaItApp 不用改。
> 測試人:需求方(GitLab 建置、簽章、上架、VM 內指令),Claude(唯讀查版本表與主機日誌、經內建瀏覽器操作 GigaItApp;同意範圍:登錄 0.9.4 草稿、pilot 環目標改 0.9.4、派送 D2)。時間為本地時間(UTC+8)。

### 11.1 發版

| 步驟 | 結果 |
| --- | --- |
| 建置 | `build:release`:pipeline **502**、job **1442**,commit `a73f241f74b501a776c0b2b3cb518a350c36c0ed`(develop),成功(耗時約 533 秒,10:35 完成);產出 agent 0.9.4、watchdog 0.3.5(未改版本) |
| 簽章 | `sign-release.ps1 -Test -NoTimestamp -ExpectedCommit a73f241f…`:簽章者 `bb8ced00c84798f6e098581e50f41b2ee4247cd3`(`GigaNexus Test Code Signing (RustIt P6, not for production)`),`test_mode=True`、`timestamp=none`,`signed_by=GSMCTW\S112009`,`signed_at=2026-10-28T02:37:58Z`,`source_commit=a73f241f…`,`source_sums_sha256=b19cfd0f9b9b3d3226d27e8a4c67a6c20e3ac57dceff905d814aead148e3be99` |
| 簽章後 SHA-256 | **agent 0.9.4:`8ff81dd72e91ef95b7d89d8458ad0f4f1ee9a22564d199706b2847863ae45584`**(9,665,928 B);watchdog 0.3.5 簽章後 `506f273e58497a89e33f7589c95344f9e9af35c5fb3972dcd00207d47e6260d2`,**未上架**(版本號已登錄過,上架前從 `SHA256SUMS.signed.txt` 拿掉) |
| 版本表查重 | 上架前由 Claude 唯讀查 `ita.agent_release`(`giganexus_It_Agent_test`,容器內應用程式自己的連線):agent 只有 0.9.0 / 0.9.1 / 0.9.2(已發佈)與 0.9.3(草稿),**0.9.4 沒登錄過**;上架腳本自己的查詢同樣 `REGISTRY-OK`、未登錄 |
| 上架 | `publish-release.ps1 -Environment test`(先 `-DryRun` 通過):NAS **`RustIT\test\releases\agent\0.9.4\rustit-agent.exe`**;寫入後雜湊相符,經主機 2 唯讀掛載重算亦相符。NAS 其他路徑、`ita.env`、migration 都沒動 |
| 登錄 | GigaItApp「Agent 版本」→「登錄版本」:Agent 0.9.4,預期簽章者 `bb8ced00…`,備註「修正延後第一次回報畫面落後(延後開始、下次檢查時間、延後結束立即送出)」;狀態**草稿**,主機計算 SHA-256 前綴 `8ff81dd72e91ef95…` 與簽章結果一致 |
| 發佈環 | **pilot / Agent 目標改 0.9.4**(約 10:45;原 0.9.3);其餘未動:pilot Watchdog 0.3.5、`it` Agent 0.9.1、`all` Agent 0.9.2、`it` / `all` Watchdog 0.3.5,沒用 force。0.9.3 當時仍為草稿(發佈由需求方另行處理) |

### 11.2 VM 升級到 0.9.4

- 需求方在電腦詳情按「立即升級」(Watchdog 約 5 分鐘上報週期內也會自動取得目標);VM `rustit-agent.exe` ProductVersion **0.9.4**。
- 電腦詳情「事件」Tab:10:46 `release_download`「下載 agent 0.9.4(9665928 bytes)」→ 10:46 `upgrade_started` `{"component":"agent","from":"0.9.3","to":"0.9.4"}` → 10:46「Agent 版本 0.9.4,上次結束:服務被停止」→ 10:47 **`upgrade_succeeded`** `{"component":"agent","duration_ms":43623,"from":"0.9.3","to":"0.9.4"}`。

### 11.3 #11 延後顯示重驗

| 項目 | 步驟 / 預期 | 實際 | 結果 |
| --- | --- | --- | --- |
| battery | VM `RUSTIT_TEST_POWER=battery`、重啟 `GigaNexusAgent`(10:48:34)後,10:49:05 派 `RustIt-TestInst-D2 1.0.0`(`/reg`,cmd `1a0c1c63-b43c-4b48-8e81-1beee4486ccc`,requestId `7b091f39dc07`)。預期派送後幾秒內顯示「延後中(電池供電)」,不是「執行中」 | 約 20 秒後(10:49)指令詳情已是「**延後中(電池供電)**」,「電腦目前電池供電,Agent 延後下載(每 5 分鐘重新檢查,最多 4 小時;計量網路不因『略過電池延後』而略過);下次檢查 10:54」。0.9.3 同樣情境要到約 5 分鐘後才轉成延後中、先顯示「執行中」 | **通過** |
| metered | 旗標改 `metered`、重啟(10:49:31),10:50:05 再派 D2(cmd `87ee9426-2e4c-4c8e-a456-cf736ccc1b01`,requestId `a97c44836605`) | 約 20 秒內顯示「**延後中(計量網路)**」,下次檢查 10:55 | **通過** |
| 重啟的影響 | 改旗標必須重啟 Agent,延後中的兩筆因此被終止 | 兩筆皆 `EXECUTION_FAILED`(預期,同 §5-3) | 符合預期 |
| 清除旗標 | 10:51:05 `RUSTIT_TEST_POWER` 清除(`GetEnvironmentVariable(...,'Machine') -eq $null` → `True`)並重啟 | 服務 Running | 已清 |
| 正常派送 | 旗標清除後派 D2 | 第一次回 `DOWNLOAD_FAILED` 404(見 §11.4);10:53 第二次成功:「安裝完成,結束代碼 0,耗時 2 秒。偵測到已安裝」「偵測到版本 1.0.0」「簽章者 `bb8ced00…`」(cmd `c3075aae-f608-4645-948e-2a409e6f6cd6`,requestId `6d8e6212a3f6`) | 通過(第二次) |

- Agent 日誌每 5 分鐘一行(09:36 / 09:41 / 09:46 的證據見 §10.2-3,0.9.3);0.9.4 本次未收 VM 日誌,以畫面為準。
- **「恢復後繼續」與 `DEFERRED_TIMEOUT` 仍未驗證**:旗標是 Agent 行程的環境變數,必須重啟才會生效,重啟又會終止延後中的指令,無法用旗標做到「延後中解除」;需要實機電池或計量網路。

### 11.4 觀察:間歇性下載 404(未查明,未改程式)

- **現象**:旗標清除並重啟 Agent(10:51:05)後的第一筆正常派送(10:51:34,cmd `f5710103-b54f-4f53-9df7-c2f126e2a0de`,requestId `8cc602beaca6`)回 `DOWNLOAD_FAILED`「安裝檔下載失敗 HTTP 404 `ITA_PACKAGE_NOT_FOUND`」;2 分鐘後同一套件、同一台重派(10:53)成功。
- **主機日誌**(endpoint-server,唯讀):`/agent/v1/packages/4d56a1cd-…` 的下載請求(reqId `a586da0560e6822507674f31c65b1a08`)在「指令已推送」後約 27 毫秒到達(`.297` 推送 → `.324` 下載請求),`.370` 才收到 `running` 更新;下載判斷記錄「下載的套件不是這台被指派的安裝,拒絕」`status: draft`、`assigned: false`、`current: false`、`ring: pilot`。
- **可疑處**:`ItAgentBack/src/services/software-service.ts` `download()` 以 `store.activeInstallPackages()`(`sql-software-store.ts`,`state IN ('sent','acked','running')`)判斷是否被指派;`command-dispatcher.ts` `trySend()` 先 `transition → sent` 再推送,理論上下載時資料庫已是 `sent`。資料庫當時紀錄顯示該指令 `sent_at` 與推送相符,看不出競爭條件在哪;可能與 Agent 重啟後第一筆指令 / 重連剛完成的時序有關。**不確定 0.9.3 以前是否也會發生**(0.9.3 的 D2 從未跑到下載;其他套件在重啟後的第一筆派送,如 09:58 的 Notepad++,成功)。
- **影響**:偶發的單次失敗,重派即可;未重現,證據只有這一次。建議交主工作階段決定是否追(可在重啟 Agent 後連派數次的情境重現)。

### 11.5 本次在測試區留下的痕跡

| 位置 | 內容 | 建議處理 |
| --- | --- | --- |
| NAS | `RustIT\test\releases\agent\0.9.4\rustit-agent.exe`(新) | 保留(版本已登錄,撤回後才能刪) |
| GigaItApp「Agent 版本」 | Agent 0.9.4:草稿;pilot Agent 目標 0.9.4;`it` 0.9.1、`all` 0.9.2 未動;0.9.3 發佈與否由需求方處理 | 0.9.4 是否發佈、`it` / `all` 是否推進由需求方決定(`pilot` 未滿 24 小時推進會被擋) |
| VM `RUSTIT-P34` | Agent 0.9.4;`RustIt Test Installer 1.0.0` 登錄項目(D2 的 `/reg` 寫入,GigaItApp 因名稱含 rustit 無法移除);`RUSTIT_TEST_POWER` 已清 | VM 手動刪登錄項目 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\RustItTestInst`,或驗收後還原檢查點 |
| GigaItApp 軟體目錄 | 草稿 `RustIt-SlowMSI2`、`RustIt-TestInst-C2`、`RustIt-TestInst-D2`(§10.4 同) | 驗收後撤回 |
| 告警 | D2 的 `software_install_failed`(EXECUTION_FAILED 兩筆、DOWNLOAD_FAILED 一筆,告警 `0e54decc-184a-4939-af10-e01a38e0a1a6`) | 驗收後處理 |
| `ita.env`、migration、其他 NAS 路徑、Watchdog | 未動 | 無 |
