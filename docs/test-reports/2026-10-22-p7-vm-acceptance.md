# P7 軟體派送:Agent 0.9.1 / Watchdog 0.3.5 發版與 VM 驗收(進行中)

> **狀態:進行中**。2026-10-22 完成發版(Agent 0.9.1 / Watchdog 0.3.5,測試區 pilot)、§8.3 第 1、2 項、L2 新禁止參數與測試套件準備;其餘項目下一個工作日續做,完成後本檔改名為實際完成日期。
> 接續 [`2026-10-22-p7-vm-partial.md`](2026-10-22-p7-vm-partial.md)。依需求方決定先用 2 台(開發機 `S1800-S112009` + VM `RUSTIT-P34`),設計中的「3 台」改 2 台,**第 3 台待補**。
> 測試人:需求方(簽章、上架、GigaItApp 操作、VM 內指令;第二人 V112001),Claude(雜湊與主機資料唯讀查證、NAS 測試套件放置、測試工具製作)。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 部署區 | 測試區(主機 2),Endpoint Server 由 CI `deploy-test` 部署 |
| 程式 | develop `3f4cf33`(MR !56,P7 收尾)→ `c1f6d10`(MR !57,Watchdog 版本改 0.3.5);pipeline 437、440 的 `deploy-test` 成功 |
| 測試機 | VM `RUSTIT-P34`(`pilot` 環);開發機 `S1800-S112009`(`all` 環,Agent 0.9.0) |
| 版本檔 | NAS `\\10.10.130.31\docker-folder\RustIT\releases`(主機 2 唯讀掛載 `/srv/giganexus/nas-rustit/releases`,容器 `/srv/releases`) |
| 簽章 | 測試憑證 `bb8ced00c84798f6e098581e50f41b2ee4247cd3`(`sign-release.ps1 -Test -NoTimestamp`) |

## 2. 發版結果

| 元件 | 建置 | 簽章後 SHA-256 | 上架 | VM 升級 |
| --- | --- | --- | --- | --- |
| Agent 0.9.1 | pipeline 437 / job 1256,`3f4cf33`,`dirty=false` | `86ee605030bd2e57e7d829760e957611a8fad9866e6f2c0d3c8c53aa48e62e14`(9,652,616 B) | NAS OK,掛載確認相符 | 0.9.0 → 0.9.1:`release_download` 08:10:21Z → `upgrade_succeeded` 08:11:05Z |
| Watchdog 0.3.5 | pipeline 440 / job 1265,`c1f6d10`,`dirty=false` | `86d53a020907e0e30fd4ef097da9fa92646b397c63a827bf38fd0cbc9850e3d7`(6,824,328 B) | NAS OK(`SHA256SUMS.signed.txt` 先拿掉重建的 agent 行) | 0.3.2 → 0.3.5:`release_download` 08:26:15Z → `upgrade_succeeded` 08:26:41Z |

雜湊在簽章輸出、NAS(UNC)、主機 2 WSL 掛載、容器 `/srv/releases` 四處一致;兩個版本都沒有 `rolled_back`。

**新的 NAS 上架流程(第一次實際使用)**:`publish-release.ps1 -Environment test` 預設寫 NAS、經 `ssh host2` 掛載確認,兩次都一次成功。

## 3. §8.3 十二項

| # | 項目 | 結果 | 觀察 |
| --- | --- | --- | --- |
| 1 | 登錄兩套件、VM 單台派送 | **通過** | 前次已驗執行結果;本次補:`device_event` 有 `software_installed`;VM 登錄檔 `Notepad++ (x64)` 8.9.8、`7-Zip 26.05 (x64)` 26.05(需求方 VM 內查詢,與主機 `device_software` 一致) |
| 2 | `mark-tested` 與第二人發佈 | **通過** | S112009 標記測試完成(Notepad++ 08:45Z、7-Zip 08:47Z,簽章者自動帶 VM 回報值);S112009 的「發佈」按鈕停用(「登錄人不能發佈」);V112001 發佈成功(08:51Z),`created_by` / `tested_by` S112009、`published_by` V112001。後端同一人發佈的 `ITA_REVIEWER_SAME_AS_CREATOR` 未直接打 API(UI 已擋,由自動化測試涵蓋)。V112001 一開始沒有 `it-admin` → `ITA_SCOPE_ALL_REQUIRED`(預期行為) |
| 3 | 批次(3 台改 2 台) | 待做 | 第 3 台待補 |
| 4 | 移除 | 待做 | |
| 5 | 重複派送已安裝 | 待做 | |
| 6 | 替換軟體庫檔案 | 待做 | 用 RustIt-TestInst 1.0.3;換檔後重啟容器觸發定期複驗(需求方已同意) |
| 7 | 簽章者不在清單 / 未簽章 | 部分(前次) | 「移除清單內指紋後重派」待做 |
| 8 | 安裝中斷線 | 待做 | RustIt-TestInst 1.0.3(`/sleep=120`),Hyper-V 中斷網路(需求方已同意) |
| 9 | 逾時 | 待做 | 主機逾時固定 1800 秒(見 §5-1),用 RustIt-TestInst 1.0.2(`/sleep=1900`) |
| 10 | 3010 | 待做 | RustIt-TestInst 1.0.1(`/exit=3010`) |
| 11 | A6 電池 / 計量網路 | 待做 | |
| 12 | 批次 21 台核可 | 待做 | 只有 2 台,可能無法執行 |

## 4. 本次新行為

| 項目 | 結果 | 觀察 |
| --- | --- | --- |
| L2 新禁止參數 | **通過** | 登錄 / 修改時皆 400 拒絕:exe `/forcerestart`(requestId `7dae7508f946`)、`/closeapplications`(`1ac37ef412e9`);msi `ACTION=ADMIN`(`0a6a59a5229a`)、`REBOOT=ReallySuppress`(`04fc2a3a1b3c`)、`MSIRESTARTMANAGERCONTROL=Disable`(`d7befef21627`) |
| 軟體派送中 Watchdog 延後升級(`busy=software`) | 待做 | 計畫:派 RustIt-SlowMSI 期間把 pilot Agent 目標暫改 0.9.0,確認延後到安裝結束 |
| 安裝逾時後等 Windows Installer(L3) | 待做 | RustIt-SlowMSI 1.0.0(自訂動作在 msiserver 內等 2100 秒) |
| 下載 429 | 待做 | VM 上 Agent 依序執行,不易觸發 |
| 每日複驗 | 部分 | 容器啟動 10 分鐘後一輪「軟體庫定期複驗完成 checked 2 changed 0」;換檔偵測待第 6 項 |

## 5. 發現(交給主工作階段)

1. **逾時無法依套件設定(文件與程式不符)**:主機 `INSTALL_TIMEOUT_SEC = 1800` 固定(`ItAgentBack/src/services/software-service.ts:144`),套件沒有 `timeout_sec` 欄位;RUNBOOK §3 `INSTALL_TIMEOUT` 寫「調高 `timeout_sec`」、設計 §8.3 第 9 項寫「`timeout_sec` 設 30」(Agent 範圍也只接受 60–14,400)。需決定:加欄位,或修正文件。
2. **`display_name` 偵測不看版本,舊版不會被升級**:開發機有 Notepad++ 8.8.9、7-Zip 21.07,套件判斷值 `Notepad++%` / `7-Zip%` 會讓 Agent 直接回 `already_installed`(`RustAgent/crates/agent/src/software/mod.rs:724`),套件詳情「已安裝的電腦」也把 8.8.9 算進去。7-Zip 可寫 `7-Zip 26.05%`;Notepad++ 的 DisplayName 不含版本,應改 `msi_product_code`。建議:登錄畫面提示,或偵測加版本條件。
3. **Watchdog 0.3.3 版本號已被用過**:測試區已有 P6-3 反向測試的 0.3.3 / 0.3.4(已撤回),登錄回 409 `ITA_RELEASE_EXISTS`;改 0.3.5 重建(MR !57)。上架腳本沒有擋下(那兩個舊版本放在主機本機目錄,不在 NAS),所以 NAS `releases\watchdog\0.3.3\` 留有一份無法登錄的新檔(`c16c721a…`),是否刪除由需求方決定(需 NAS 寫入帳號)。建議發版前先查版本表。
4. **測試套件的判斷值預設帶套件名稱**:登錄畫面「判斷值」預設 `RustIt-TestInst%`,與實際 DisplayName 不同,照預設派送會 `DETECT_FAILED`;建議不預填或提示。
5. **V112001(無 `it-admin`)畫面上的「發佈」按鈕可按**,按了才回 `ITA_SCOPE_ALL_REQUIRED`;可依角色停用。

## 6. 觀察 / 潛在風險

- 登錄版本時出現「CSRF 驗證失敗,請重新載入頁面」(requestId `f9a634e53ac2`),重新載入後成功;可能與同一瀏覽器切換帳號或頁面開太久有關。
- `sign-release.ps1` 結果表 Status 為 `UnknownError`:簽章機沒有信任測試根憑證(`terminated in a root certificate which is not trusted`),測試模式下屬預期;可在 `-Test` 時註明。
- 需求方第一次從非互動方式執行腳本,錯誤後視窗關閉看不到訊息(實際原因是尚未簽章);RUNBOOK 可註明「在已開啟的 PowerShell 視窗執行」。
- 兩個版本登錄後都直接「發佈」,未依 RUNBOOK §1 以草稿驗 pilot 24 小時;測試區只有 VM 在 pilot,無影響。

## 7. 測試工具(不進 repo)

| 檔案 | 用途 | SHA-256(測試憑證簽章後) | NAS 位置 |
| --- | --- | --- | --- |
| `rustit-testinst.exe` | Rust 小程式:`/sleep=N`、`/exit=C`、`/reg`(寫 Uninstall `RustIt Test Installer`)、`/unreg` | `f3556f7e4342e9e2084b7dadc34f0cd1ce8c2304f5b33988122301188f78420b` | `software\RustIt-TestInst\1.0.1|1.0.2|1.0.3\` |
| `rustit-test-slow.msi` | WiX 5,deferred 自訂動作在 msiserver 內等 2100 秒;ProductCode `{20ADC0A9-4C08-412D-82B4-222694115B82}` | `03dd5d064ad028d3d7a8de7cd41519d200914bfa2573706f68a1ab5a9d6b0d99` | `software\RustIt-SlowMSI\1.0.0\` |

驗收後要撤回這 4 個測試套件、移除 VM 上的測試項目,並由需求方決定是否刪除 NAS 上的測試檔。

## 8. 下一步

依序:#5 重複派送 → #4 移除 → #3 批次(2 台)→ #7 剩餘 → #10 3010 → #8 斷線 → #6 換檔 + 重啟容器複驗 → #9 逾時 / L3 / Watchdog 延後升級(約 35 分鐘)→ #11 → #12(評估)。
