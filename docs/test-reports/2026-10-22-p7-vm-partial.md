# P7 軟體派送:測試區 NAS 切換與 VM 初步驗證(2026-10-22)

> 這**不是**正式的 P7 VM 驗收報告(`P7-SOFTWARE-DESIGN.md` §8.3 十二項);需求方決定程式碼全部完成後再做完整驗收(預計報告檔名 `2026-10-2x-p7-vm-acceptance.md`)。本檔記錄 2026-10-22 當天已實際執行的項目與發現,供完整驗收與後續工作參考。
> 測試人:需求方(VM 內操作與瀏覽器操作),Claude(唯讀查證、NAS 檔案複製與雜湊比對、測試區畫面讀取)。

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 部署區 | 測試區(主機 2);Endpoint Server 為 CI `deploy-test` 部署(develop,pipeline #423 起;切換 NAS 後重跑 `deploy-test`) |
| 程式 | develop `150d7de`(含 P7-1 後端、P7-2 / P7-3 Agent 0.9.0、P7-4-1 NAS 腳本、P7-5 `GET /batches` 與 GigaItApp 軟體派送畫面) |
| 測試機 | VM `RUSTIT-P34`(`pilot` 環),Agent 由 0.8.2 升到 **0.9.0** |
| Agent 0.9.0 | CI `build:release`(pipeline #428、job #1229,commit `150d7de`)→ 需求方以測試憑證簽章 → `publish-release.ps1 -Environment test` 上架;`rustit-agent.exe` SHA-256 `e9f895e9d68c90bc6d34a85b8b8d08e3703ae66b30b19db49925bef8c3c79754`,簽章者 `bb8ced00c84798f6e098581e50f41b2ee4247cd3`(`GigaNexus Test Code Signing (RustIt P6)`) |
| 軟體庫 | NAS `//10.10.130.31/docker-folder/RustIT`(`releases\`、`software\`),主機 2 WSL 以 CIFS **唯讀**掛載到 `/srv/giganexus/nas-rustit`,容器 `/srv/releases`、`/srv/software` 唯讀 |
| 套件 | Notepad++ 8.9.8(MSI,廠商簽章 `1e8e0d13b608ba908572c1a129faec5d228df8a2`);7-Zip 26.05(NSIS exe,測試憑證加簽) |

## 2. 結果

### 2.1 NAS 唯讀掛載(P7-4)

| 項目 | 結果 |
| --- | --- |
| 帳密腳本 `host2-set-nas-credentials.sh`(MR !53) | 通過:帳密 0400 寫入 root 專屬目錄、CIFS 唯讀掛載、寫入測試被拒 |
| `releases\` 複製(Agent 0.8.2、Watchdog 0.3.2) | 通過:主機 2 原檔、NAS、容器唯讀掛載讀到的 SHA-256 三處一致 |
| `/etc/fstab`(`x-systemd.automount`)與重開機 | 通過:重開機後唯讀 cifs 已掛載,容器重建後讀 NAS(`ita.env` 的 `ITA_RELEASES_HOST_DIR`、`ITA_SOFTWARE_HOST_DIR`),`endpoint-server` healthy,Agent 與 Watchdog 回報恢復 |
| 備註 | `systemctl is-active` 回報 automount 單元 `inactive` 但掛載正常(systemd 開機時似乎直接啟動 `.mount`);結果正確,原因未追 |

### 2.2 Agent 0.9.0 發版與升級

`build:release`(手動,Windows Runner)產出未簽章檔 → 簽章 → 上架 → 複製到 NAS `releases\agent\0.9.0\`(雜湊三處一致)→ 「Agent 版本」登錄 → `pilot` 環目標 0.9.0 → VM 升級成功(「立即升級」成功)。

### 2.3 對照設計 §8.3 十二項

| # | 項目 | 結果 | 觀察 |
| --- | --- | --- | --- |
| 1 | 登錄兩個套件(`draft`)並對 VM 單台派送 | **通過** | Notepad++:`exit_code 0`、4 秒、`signer` 為預期指紋、`detected`;7-Zip 26.05.2:`exit_code 0`、1 秒、`signer` 為測試憑證指紋。「`software_installed` 事件」與登錄檔項目**未逐項確認**(畫面顯示「偵測到已安裝」) |
| 2 | `mark-tested` 與第二人發佈 | 未執行 | |
| 3 | 3 台批次 | 未執行 | |
| 4 | 移除 | 未執行 | |
| 5 | 重複派送已安裝 | 未執行 | |
| 6 | 替換軟體庫檔案 | 未執行 | |
| 7 | 簽章者不在清單 / 未簽章 | **部分** | `SIGNER_NOT_TRUSTED`(本機清單 0 個,訊息帶出簽章者指紋)與 `SIGNATURE_INVALID`(`WinVerifyTrust 0x800B0100`,未簽章)皆未啟動安裝程式;「移除清單內指紋後重派」未做 |
| 8~12 | 斷線補送、逾時、3010、A6、批次 21 台核可 | 未執行 | |

另外觀察到:Agent 0.8.2 收到 `software.install` 回 `UNSUPPORTED_COMMAND`(預期行為,升級到 0.9.0 後消失)。

## 3. 發現與建議交給後續處理

1. **上架腳本預設目的地過時**:`RustAgent/installer/publish-release.ps1` 預設 `-ReleasesDir /srv/giganexus/ita-releases`(舊本機目錄)。測試區切到 NAS 後,版本檔目錄是唯讀掛載,腳本寫不進去;這次上架到舊目錄後由 Claude 以 UNC 路徑複製到 NAS 並比對雜湊。需改腳本或 RUNBOOK §1 步驟 3(上架後複製到 NAS,或改寫 NAS 的可寫路徑)。
2. **重建同版本號的檔案被拒絕**:CI 重新建置會讓未改版本的 Watchdog 0.3.2 內容與已發佈的不同,`publish-release.ps1` 對它回 `REFUSE`(正確,不覆蓋),但整體結束碼 1,且「中止前已放好的項目不會回滾」。上架時只放有新版本號的元件目錄(本次 Agent 已放好、Watchdog 被拒,結果正確)。建議 RUNBOOK §1 註明。
3. **`agent.toml` 不可重複 `trusted_signers`**:需求方先寫成兩行 `trusted_signers`(同一個 `[software]` 區段),TOML 不允許重複鍵,Agent 下次重啟會解析失敗。修正為單一陣列放多個指紋後 Agent 重啟成功。建議 RUNBOOK §4 補一句範例。
4. **加簽後的檔案**:7-Zip 未簽章,依設計 §9-2 由 IT 以公司(測試期為測試)憑證加簽;加簽後檔案內容與雜湊改變,軟體庫不覆蓋既有檔,需放新版本資料夾(`7-Zip\26.05.2\`)並重新登錄,舊草稿撤回。NSIS 加簽後靜默安裝(`/S`)正常。
5. **權限範圍**:NAS 帳號 `docker-backup` 為可讀寫(整個 `docker-folder`);容器雖以 `ro` 掛載,上線前仍應請 NAS 管理員另開只對 `RustIT\` 唯讀的專用帳號(ADR 0002 的唯讀要求)。
6. **主機 2 同時是 Runner 與測試區**:重開機會讓 GitLab Runner 與所有測試區服務中斷,驗證需在沒人用的時段。

## 4. 尚未完成 / 下一步

- P7 程式碼收尾(完整驗收前):`npm run test:int`(`GET /batches` 與新 SQL)、上架腳本預設目錄、`prepare_shutdown` 在 `software.*` 執行中延後、L2 安裝參數開關(三處同步);其餘資安稽核剩餘項目見設計 §8.1.1、§8.1.2。
- 完整 VM 驗收(§8.3 十二項)與第 3 台 IT 電腦;之後補 Gateway 指南 VM 驗收小節、RUNBOOK §4 報告引用、HANDOFF 與甘特圖 W6-20 done。
