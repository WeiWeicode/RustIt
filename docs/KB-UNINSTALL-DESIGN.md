# 遠端移除 Windows 更新(KB)設計(草案)

> 狀態:**草案,待需求方確認 §9**。範圍:IT 在 GigaItApp 對端點電腦移除指定的 Windows 更新(KB 編號),用於某個更新造成相容性問題時的緊急處理。
> 沿用 P4 指令通道與 P7 派送的機制(等級、串行鎖、批次第二人核可、`REBOOT_PENDING`、結果回報);契約只新增,舊版 Agent 回 `UNSUPPORTED_COMMAND`。
> 時程以甘特圖為準,本文件不列日期。

## 0. 現況與缺口

| 項目 | 現況 | 缺口 |
| --- | --- | --- |
| 已安裝 KB 的蒐集 | collector `wmi_query.rs` 查 `Win32_QuickFixEngineering`,依安裝日排序後**只保留 8 筆**(`security.recent_hotfixes`) | IT 看不到較舊的 KB,不能從畫面確認某台是否裝了要移除的 KB |
| `software.uninstall` | 只處理登錄檔 Uninstall 機碼裡的軟體,經軟體目錄(套件)下發快照 | Windows 更新不在 Uninstall 機碼,也不在軟體目錄,**目前無法移除** |
| 重新開機 | `system.reboot`(P7-3)可單台 / 累計核可 | 不需改;移除 KB 後的重開機沿用 |

## 1. 分批

| 批 | 內容 | repo |
| --- | --- | --- |
| **U1** 蒐集完整 KB 清單 | collector 不再截成 8 筆(上限改 200,超過留警告);契約 `inventory.schema.json` 註明;GigaItApp「安全」Tab 改成完整清單 + 搜尋 | RustIt、GigaItApp |
| **U2** 主機端 | `kinds.ts` 新增 `system.update.uninstall`;參數驗證、每台上限、批次與累計核可計入「軟體安裝 / 移除」組;結果與錯誤代碼;`command-kinds.md`、範例 JSON;單元 / 整合測試 | RustIt(ItAgentBack) |
| **U3** Agent | `software/` 下新增 `update.rs`:查 KB 對應的 CBS 套件、以 DISM 移除、確認消失、回報;Agent **0.10.0**;mock `Env` 單元測試 | RustIt(RustAgent) |
| **U4** GigaItApp | 單台:「安全」Tab 的 KB 列加「移除」(`endpoint.command.admin`);多台:批次頁選「移除 Windows 更新」+ 輸入 KB;結果顯示 `reboot_required` 並提示下 `system.reboot` | GigaItApp(跨 repo,需同意) |
| **U5** 驗收與文件 | 測試區 VM 驗收(§8.3)、RUNBOOK 失敗處理、Gateway `ENDPOINT-AGENT-GUIDE` §8.3 指令表(需同意)、甘特圖 | RustIt、Gateway |

U1 可先上(只是蒐集變多,不影響行為);U2 與 U3 一起發版(指令類型要兩邊同時支援)。

## 2. 契約(`command-kinds.md`)

### 2.1 指令類型

| kind | 等級 | 有效 / 逾時 | 串行 | 每台上限 |
| --- | --- | --- | --- | --- |
| `system.update.uninstall` | admin | 24 小時 / 90 分鐘 | 是(與 `software.*` 共用串行鎖) | 1 筆 |

- 權限沿用 `endpoint.command.admin`(指南 §8.2 已涵蓋「會影響使用者的指令」),**不新增權限代碼、不改 BFF**。
- 逾時 90 分鐘:累積更新(LCU)的移除常需 10–40 分鐘,慢機更久。
- `REBOOT_PENDING` 期間不執行(同 `software.*`)。

### 2.2 參數

```json
{ "kb": "KB5062660" }
```

- `kb`:`^KB[0-9]{6,8}$`(主機與 Agent 都驗證;大小寫統一轉大寫)。不接受套件名稱或任何命令列片段,**命令列由 Agent 寫死組出**(同 P7 §5.3)。
- 不經軟體目錄、不建立套件、不比對授權數。

### 2.3 結果與錯誤代碼(盡量沿用 P7 代碼,GigaItApp 不必新增顯示邏輯)

- `result`:`exit_code`、`reboot_required`、`packages`(實際移除的 CBS 套件名稱,1–N 個)、`already_absent`(查不到該 KB 時直接 `succeeded`)、`duration_ms`、`interrupted`、`log_tail`(DISM 記錄最後 20 行,同 `logs.collect` 遮罩)。
- 結束代碼:`0` 成功;`3010` 成功且 `reboot_required = true`;其餘依下表。

| 代碼 | 情況 |
| --- | --- |
| `UNINSTALL_NOT_SUPPORTED` | 永久套件(DISM `0x800f0825`,例如服務堆疊更新 SSU)、或 KB 在 Agent 內建的不可移除清單(§5.3) |
| `INSTALL_FAILED` | DISM 其他失敗碼(`result.exit_code` 帶值) |
| `INSTALL_TIMEOUT` | 超過逾時,結束行程樹;CBS 交易可能仍在進行,提示需重開機後再查 |
| `INSTALL_BUSY` | 另一個服務作業進行中 / 有待重開機的 CBS 作業(`0x800f082f`、`0x800f0905` 等),或 Windows Installer / TrustedInstaller 忙碌等 15 分鐘仍忙 |
| `DETECT_FAILED` | DISM 回成功,但套件狀態不是「已移除 / 移除待重開機」 |
| `INVALID_PARAMS` | `kb` 格式不符(沿用 P4) |

> 「待重開機才完成」是常態:DISM 回 3010 時套件狀態為 `Uninstall Pending`,`DETECT_FAILED` 只在既不是 `Absent/Staged` 也不是 `Uninstall Pending` 時才回。

## 3. ItAgentBack

- `src/commands/kinds.ts`:新增 kind、`params` JSON Schema、`maxPending: 1`;`SOFTWARE_KINDS` 不加(那是套件快照邏輯),另加入「累計核可組」的軟體組(D2-1:同一人 24 小時內 `software.*` + `system.update.uninstall` 合計台數 > 20 走第二人核可)。
- 批次 API 沿用 `/v1/batches/...`(admin 類批次)。
- 告警:失敗沿用 `software_install_failed`(類型名稱不改,`detail.kind` 區分);不新增 migration。
- `GET /v1/devices/{id}` 不變(KB 清單在資產 JSON 內)。
- 測試:`test/` 參數驗證、上限、核可累計;`test:int` 不需新資料表。

## 4. 蒐集(U1)

- `wmi_query.rs`:`hotfixes.truncate(8)` 改為上限 200;超過時加一筆 `warnings`。欄位名稱 `recent_hotfixes` 保留(避免契約破壞),schema 說明改為「已安裝更新(依安裝日新到舊,最多 200 筆)」。
- 已知限制:`Win32_QuickFixEngineering` 只列 CBS 套件型的更新;.NET、Office(MSI / C2R)、Defender 定義檔不在其中,本功能也**不處理**這些(§7)。
- 移除完成後 Agent 觸發一次資產蒐集(同 `software.uninstall` 的 `env.collect()`),畫面反映結果。

## 5. Agent(0.10.0)

### 5.1 模組

`crates/agent/src/software/update.rs`(放在 `software/` 下以共用 `Env`、`run_installer`、`wait_idle`、記錄與遮罩);`command.rs` 的 kind 清單與分派加入 `system.update.uninstall`。

### 5.2 流程

1. 驗證 `kb`;`REBOOT_PENDING` → 拒絕。
2. **找套件**:執行 `%SystemRoot%\System32\Dism.exe /Online /English /Get-Packages /Format:Table`,再對候選套件 `/Get-PackageInfo`,以 `Support Information`(`...kbid=NNNNNNN`)或套件名稱中的 `KBNNNNNNN` 比對;只取狀態 `Installed` 的套件。找不到 → `succeeded` + `already_absent`。
3. 套件標示 `Permanent`(`Get-PackageInfo` 的 `Permanency`)→ `UNINSTALL_NOT_SUPPORTED`,不嘗試移除。
4. 等 Windows Installer / TrustedInstaller 空閒(沿用 0.9.3 的 `wait_idle`,最多 15 分鐘)。
5. 逐一執行 `Dism.exe /Online /English /Remove-Package /PackageName:<名稱> /Quiet /NoRestart /LogPath:<記錄>`;不經 `cmd /c`、絕對路徑、參數由程式組出(套件名稱只接受 `[A-Za-z0-9_~.\-]`)。
6. 再查一次狀態(§2.3 規則)→ 回報;觸發資產蒐集。
7. **永不自動重開機**:`reboot_required = true` 時由 IT 另下 `system.reboot`。

> 為何用 DISM 而不用 `wusa /uninstall /kb:`:2021 年起累積更新與 SSU 合併發佈,微軟文件說明合併套件**不能用 wusa 移除**,只能用 DISM 移除 LCU 部分;且 wusa 在 Windows 10 的 `/quiet` 移除行為不穩定(可能跳視窗卡在 session 0)。DISM 輸出解析用 `/English` 固定語系。

### 5.3 安全

- 不可移除清單(Agent 內建,同 P7 `PROTECTED` 的精神):服務堆疊更新(永久套件本來就移不掉)、需求方指定的關鍵安全更新(預設空,§9-3)。
- 只接受 KB 編號,不接受任意套件名稱 → 主機被入侵時最多只能移除「已安裝的某個 KB」,無法執行任意命令;仍受第二人核可門檻限制。
- `log_tail` 經遮罩;DISM 記錄放 `staging\<command_id>\`,沿用 `purge_stale` 清理。

## 6. GigaItApp(U4,跨 repo 需同意)

- 「安全」Tab:完整 KB 清單(KB、說明、安裝日),搜尋;有 `endpoint.command.admin` 時每列有「移除」→ 確認視窗(需輸入 KB 編號確認,說明「Windows Update 可能會重新安裝,需另外暫停 / 封鎖」)。
- 批次:指令批次頁加「移除 Windows 更新」,輸入 KB + 選電腦;> 20 台走既有待核可流程。
- 結果:`reboot_required` 時顯示「需重新開機才完成」+「重新開機」按鈕(開既有 `system.reboot` 視窗)。
- Gherkin:`GigaItApp` 依現有慣例補「移除 Windows 更新」情境。

## 7. 不做的事(留路線圖)

- **阻止 Windows Update 重新安裝**:移除後 Windows Update 會在下次檢查時重新裝回,本功能只負責移除。封鎖要靠 WSUS 不核准 / 群組原則 / 「暫停更新」(§9-1)。
- **安裝 KB**(派送 `.msu`):不做;安裝更新交給 Windows Update / WSUS。
- **非 CBS 更新**:.NET、Office、Defender 定義檔、驅動程式更新。
- **依條件自動移除**(例如偵測到某 KB 就移除):不做,一律由 IT 手動下指令。

## 8. 測試與驗證

### 8.1 自動化

- Agent:mock `Env` 測 DISM 輸出解析(英文 Table / PackageInfo 樣本,含多個套件對應同一 KB、`Permanent`、`Uninstall Pending`)、結束代碼對應、逾時與中斷、`REBOOT_PENDING` 拒絕、參數驗證。
- ItAgentBack:參數驗證、每台上限 1、與 `software.*` 共用累計核可、舊版 Agent `UNSUPPORTED_COMMAND`。
- 契約:`docs/contracts/examples/ws-command-system-update-uninstall.sample.json` 與 `kinds.ts` 一致的測試(同既有契約測試)。

### 8.2 風險與已知限制

- LCU 移除時間長、需重開機,期間使用者可能自行重開 → 結果以重開機後重連的回報與下次資產為準(`interrupted`)。
- DISM 輸出格式依 Windows 版本略有差異 → 樣本涵蓋 Win10 22H2 與 Win11 23H2 / 24H2。
- KB 對應多個套件(例如 LCU + .NET 子套件)時全部移除;`packages` 列出實際移除的名稱。

### 8.3 測試區 VM 驗收(草案;VM 內指令由需求方執行)

1. VM(`RUSTIT-P34`)先建檢查點;安裝一個可移除的非 LCU KB 或使用現有 LCU。
2. GigaItApp 單台移除 → `succeeded` + `reboot_required`;下 `system.reboot` → 重開後資產清單不再有該 KB。
3. 同一 KB 再下一次 → `already_absent`。
4. 對 SSU / 永久套件 → `UNINSTALL_NOT_SUPPORTED`。
5. 移除進行中重啟 Agent 服務 → `interrupted`,重連後結果正確。
6. 舊版 Agent(0.9.4)→ `UNSUPPORTED_COMMAND`。
7. 還原 VM 檢查點。

## 9. 要你決定的事

1. **重新安裝的處理**:公司有沒有 WSUS?(a)本功能只移除,封鎖由 WSUS / GPO 處理(建議第一版);(b)Agent 同時把該機「暫停更新」N 天(改 `HKLM\...\WindowsUpdate\UX\Settings` 暫停到期日,會影響其他更新);(c)用 Windows Update API 把該 KB 設為隱藏(需上網搜尋更新,慢且在 WSUS 環境下行為不同)。
2. **核可門檻**:沿用「> 20 台(含 24 小時累計)才需第二人核可」,或移除 KB **一律**需第二人核可(安全更新被移除風險較高)?
3. **不可移除的 KB 清單**:是否有指定的關鍵安全更新不允許移除?(預設空,只擋永久套件)
4. **KB 清單上限**:200 筆是否足夠?(Win10 一般 10–40 筆)
5. **GigaItApp 入口**:單台「安全」Tab + 批次頁兩個入口都做,或第一版只做單台?
