# 測試報告:P6-4 第一次正式發版流程(Agent 0.8.2 / Watchdog 0.3.2)

## 1. 環境

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-21 |
| 部署區 | 測試區(主機 2;Gateway `giganexus-test.gigasolar.com.tw`);後端沒有改動 |
| 分支 / commit | RustIt `develop` `62f1885`(MR !47 `fix/rustls-audit`:rustls 0.23.46、rustls-webpki 0.103.16 弱點修補,Agent 0.8.2 / Watchdog 0.3.2);流水線本身是 MR !45、Runner 文件 MR !46 |
| CI | Windows Runner `host2-windows`(#4,tag `windows`、shell `pwsh`、服務帳號 `gitlab-runner-svc`);pipeline 384、`build:release` job 1092 |
| 簽章 | 第一張測試憑證 `bb8ced00…`(`-Test -NoTimestamp`),需求方在開發機執行 `sign-release.ps1` 並輸入 YES |
| 測試機 | Hyper-V VM `RUSTIT-P34`(pilot 環,升級前 Agent 0.8.1 / Watchdog 0.3.1) |
| 操作方式 | 建置由需求方在 GitLab 手動觸發(Claude 的 Token 沒有 Job: Run);產出核對、上架、版本登錄、pilot 目標由 Claude 執行(經 `ssh host2` 與需求方登入的瀏覽器工作階段,寫入前取得同意);**發佈與清空 pilot 目標由需求方在 GigaItApp 操作**(Claude 的瀏覽器請求被 Claude Code 自動權限檢查擋下,未繞過) |

## 2. 前置:弱點掃描與修補

| 步驟 | 結果 |
| --- | --- |
| `audit:rust`(develop `09c66b8`,RustSec 1,348 筆) | 弱點 6(rustls 0.23.45 ×4、rustls-webpki 0.103.15、webpki-root-certs 1.0.9)、警告 2;影響評估見 `DevelopmentProcess/BugFix.md` 2026-10-21 |
| MR !47 只改 `Cargo.lock` + 版號 | `cargo test --locked -p rustit-common -p rustit-agent -p rustit-watchdog` 158 通過、0 失敗(1 個原本就略過);主機 2 重跑 `cargo audit`:弱點 0,剩 demo(Tauri)Linux 相依的 2 個警告 |

## 3. 發版流程(RUNBOOK §1)

| # | 步驟 | 結果 |
| --- | --- | --- |
| 1 | `build:release`(pipeline 384 / job 1092) | ✅ `agent/0.8.2/rustit-agent.exe`(9,233,920 B)、`watchdog/0.3.2/rustit-watchdog.exe`(6,793,216 B);ProductVersion / FileVersion 與路徑一致;未簽章;雜湊與 `SHA256SUMS.txt` 相符;`RELEASE-INFO.txt` `commit=62f1885…`、`dirty=false`、`signed=false` |
| 2 | 取得產出 | 從主機 2 Runner 建置目錄 `release-out` 以 scp 複製到開發機 `C:\release\0.8.2`(與上傳的 artifact 同一份;Claude 的 Token 沒有 Job: Read 無法直接下載),開發機重算雜湊相符 |
| 3 | `sign-release.ps1 -Test -NoTimestamp -ExpectedCommit 62f1885…`(需求方) | ✅ `SIGNED-INFO.txt`:簽章者 `bb8ced00…`、`test_mode=True`、`source_commit` 一致;開發機 `Get-AuthenticodeSignature` 為 `UnknownError`(開發機沒裝測試根憑證,預期) |
| 4 | `publish-release.ps1 -Environment test -DryRun` | ✅ 核對通過(簽章後 agent `96d92c8b…`、watchdog `b9b1f951…`) |
| 5 | `publish-release.ps1 -Environment test` | ✅ 放進 `/srv/giganexus/ita-releases/agent/0.8.2/`、`watchdog/0.3.2/`,主機重算 SHA-256 相符;沒有覆蓋既有版本 |
| 6 | 登錄(`POST /api/endpoint/releases`) | ✅ 兩筆 `draft`,主機計算的 SHA-256 與上架一致;預期簽章者 `bb8ced00…` |
| 7 | pilot 目標 agent 0.8.2、watchdog 0.3.2 | ✅ 見 §4 |
| 8 | 發佈、清空 pilot 目標(需求方在 GigaItApp) | ✅ 兩筆「已發佈」;六個環目標都是「不升級」 |

## 4. VM 升級(pilot)

| 時間(UTC) | 事件 |
| --- | --- |
| 07:09:46 | `upgrade_started` agent 0.8.1 → 0.8.2;`release_download` 9,235,848 B |
| 07:09:51 | `agent_started` 0.8.2(`previous_exit=stop`) |
| 07:10:31 | `upgrade_succeeded` agent(44.2 秒) |
| 07:10:35 | `upgrade_started` watchdog 0.3.1 → 0.3.2;`release_download` 6,795,144 B |
| 07:10:56 | `upgrade_succeeded` watchdog(21.8 秒) |

- pilot 進度 agent / watchdog 皆 1 / 1 到達目標、失敗 0;`device_upgrade` 兩列 `succeeded`(`targetSource=ring`)
- 升級後 VM 在線、告警 0;健康摘要 Agent RSS 23 MB、CPU 1%、記憶體 62%、C: 剩 29%
- 需求方電腦 `S1800-S112009`(all 環,Agent 0.7.0)沒有被升級(all 環沒有目標)

## 5. 過程中的問題(都已處理)

| 問題 | 處理 |
| --- | --- |
| Runner shell `powershell` 在 CP950 系統解析 Runner 腳本失敗(job 1073 `exit status 0xfffd0000`) | 改 `pwsh`(MR !46,`WINDOWS-RUNNER-SETUP.md` §3 步驟 4) |
| `gitlab-runner install --user` 沒授予 `SeServiceLogonRight`,服務登入失敗(`0xc000015b`) | 需求方以 `secedit` 授予(§3 步驟 5) |
| `cargo install cargo-audit` 的執行檔沿用暫存目錄 ACL,服務帳號無法執行 | `icacls /reset`(MR !47,§6) |
| Claude 的 GitLab Token 沒有 Job: Run / Job: Read / Runner: Read | 由需求方手動觸發 job;產出改從主機 2 讀取 |
| 測試區瀏覽器發佈版本被 Claude Code 自動權限檢查擋下 | 需求方在 GigaItApp 操作 |

## 6. 未驗證與後續

- **正式發版條件未演練**:受保護 tag `rustit-v*` 觸發的 `build:release`、用受保護 tag / main 的 checkout 執行簽章與上架腳本、正式憑證(時間戳記、`signtool verify /pa`)與 `-Environment prod`(正式憑證待 IT AD CS)
- MSI(`build-release.ps1 -Env`)不在 CI 產出,本次沒有建
- 清理:VM 的兩張測試根憑證、主機 2 `ita-releases` 的 P6-2 / P6-3 測試版本檔(含 `-broken`)與對應登錄(可「撤回」),留到 P6-6
