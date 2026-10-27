# P7 軟體派送:Agent 0.9.2 發版與 VM 驗收

> **狀態:主要項目完成;L3 未通過(見 §5-6);Watchdog 延後升級、#3 第 3 台、#12 未驗證**(見 §3、§4)。取代 2026-10-22 的進行中版本(Agent 0.9.1 / Watchdog 0.3.5 的發版與 #1、#2 結果併入本檔)。
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
| 8. Watchdog 軟體派送中延後升級 | **未驗證** | 需暫時把 pilot 環目標版本改成 0.9.0 再派長時間安裝,風險較高;待需求方決定 |
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

- **撤回 / 移除測試套件**:草稿 `RustIt-TestInst 1.0.2`、`1.0.3`、`RustIt-SlowMSI 1.0.0`(逾時已改 300 秒)、`RustIt-TestInst-A|B|C|D`;已撤回 `RustIt-TestInst 1.0.1`、`7-Zip 26.05.2.0.0`、`26.05.2.0`、`26.05.1`、`26.05`。已發佈的 `7-Zip 26.05.0`、`7-Zip 26.05.2`、`Notepad++ 8.9.8` 是否保留由需求方決定。
- **VM**:`RustIt Test Slow MSI` 要待 msiserver 空閒(約 15:53 後)**手動**移除(名稱含 rustit 不可經 GigaItApp 移除);`RustIt Test Installer` 已移除;另移除 7-Zip、Notepad++;`RUSTIT_TEST_POWER` 已清除;驗收後還原檢查點。
- **開發機**:移除匯入的測試根憑證;`agent.toml` 還原備份;視需要移除 7-Zip 21.07 / 26.05、Notepad++ 8.8.9 / 8.9.8、`RustIt Test Slow MSI`。
- **NAS 測試檔(寫入權限需求方)**:`software\RustIt-TestInst\{1.0.1,1.0.2,1.0.3}\`、`RustIt-TestInst-{A,B,C}\1.0.0\`(含 B 的 `.bak` / 替換檔,需先還原)、`RustIt-SlowMSI\1.0.0\`;`releases\watchdog\0.3.3\` 殘留(見 2026-10-22 紀錄)。
- 告警 `d28ac339-8cc2-44a6-8ae3-f4fe1c87e1cb`(software_file_tampered,VM)待處理。

## 9. 下一步

依序:Watchdog 延後升級(待決定)→ #3 第 3 台 → 清理。L3 需主工作階段先查原因。#12 與新行為 9(429)在測試區無法驗證,交主工作階段決定是否另找環境。
