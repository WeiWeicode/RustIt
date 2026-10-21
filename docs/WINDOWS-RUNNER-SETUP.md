# Windows 本機 GitLab Runner 設定(P6-4)

> 對應 PLATFORM-PLAN §4.9(選項 C:Windows Runner 建置 + 人工簽章)、P6-UPGRADE-DESIGN §6。
> **目的**:在主機 2 的 Windows 本機(不經 WSL)跑 `RustAgent/installer/build-release.ps1`,產出**未簽章**的 Agent / Watchdog exe 與 `SHA256SUMS.txt`。
> **不放簽章憑證**:私鑰不在 Runner(ADR 0003;能推受保護分支的人不能因此簽章)。簽章由簽章人員在自己的電腦做(`sign-release.ps1`)。

## 1. 為什麼要另一個 Runner

| | 既有 Runner | 新增 Runner |
| --- | --- | --- |
| 位置 | 主機 2 的 WSL(Linux),shell executor | 主機 2 的 **Windows 本機**,shell executor,shell = `pwsh`(PowerShell 7) |
| tag | `windows-runner`(名稱容易混淆:它其實是 WSL 內的 Linux Runner) | `windows` |
| 用途 | ItAgentBack 的檢查與測試環部署(Docker) | Rust(MSVC)與 WiX 的 Windows 建置 |
| 併發 | 依現況 | `concurrent = 1`(Rust release 建置吃 CPU 數分鐘,不要和測試區部署同時搶) |

RustIt 的 `.gitlab-ci.yml` 已有兩個 `windows` tag 的 job(`build:release`、`audit:rust`);**沒有這個 Runner 時它們不會執行**,手動 job 不擋 pipeline。

## 2. 前置條件與建置工具(主機 2,Windows 10)

建議**等測試區沒有人在驗收時**再裝(VS Build Tools 約 20 分鐘、5 GB;Rust 建置吃 CPU)。主機 2 **只有 C 槽**(F 槽沒有空間),建置目錄放 `C:\ci`;至少留 15 GB。

工具**全部裝成全機共用**(不用個人 `dotnet tool --global`、不用個人 `~/.cargo`),Runner 服務帳號才找得到。用 [`RustAgent/installer/install-runner-tools.ps1`](../RustAgent/installer/install-runner-tools.ps1) 一次裝完(可重跑,已裝的略過;不含機密,Claude 可經 `ssh host2` 代跑):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install-runner-tools.ps1
```

| 項目 | 安裝位置 | 2026-10-21 實裝版本 |
| --- | --- | --- |
| gitlab-runner(與 WSL 既有 Runner 同版,核對官方 `release.sha256`) | `C:\GitLab-Runner\gitlab-runner.exe` | 19.4.1 |
| Git for Windows | `C:\Program Files\Git` | 2.56.0 |
| .NET SDK 8(WiX 需要) | `C:\Program Files\dotnet` | 8.0.426 |
| WiX **v5**(不可 v6 以上,企業使用需付 OSMF) | `C:\Tools\wix`(`dotnet tool install --tool-path`) | 5.0.2 |
| Rust stable MSVC(`--profile minimal`) | `RUSTUP_HOME=C:\Rust\rustup`、`C:\Rust\cargo\bin` | 1.99.1 |
| PowerShell 7(Runner 的 shell,見 §3 步驟 4) | `C:\Program Files\PowerShell\7`(驗 Microsoft 簽章) | 7.6.7 |
| VS 2022 Build Tools(`Microsoft.VisualStudio.Workload.VCTools`,含 Windows SDK) | `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools` | MSVC 14.44 |
| (選用)`cargo-audit` | `cargo install cargo-audit --locked` | 未裝 |

- 以上目錄都加入**系統** PATH;`RUSTUP_HOME` 設為系統環境變數。`CARGO_HOME`(crate 下載快取)**不**放 `C:\Rust`,由 Runner 設定指到服務帳號可寫的 `C:\ci\cargo-home`(§3 步驟 3)。
- 腳本要存成 **UTF-8 含 BOM**:Windows PowerShell 5.1 在 CP950(Big5)系統讀無 BOM 的 UTF-8 會變亂碼並語法錯誤。
- 不需要私有 crate 來源;`cargo build --locked` 要能連 crates.io。

## 3. 服務帳號、註冊與安裝服務

標 **需求方** 的步驟含 Token 或密碼,由需求方在主機 2 的**系統管理員 PowerShell**(RDP 登入)執行,不貼進對話;其餘 Claude 可經 `ssh host2` 代勞。

1. **需求方** — 在 GitLab 建 Runner,取得 Token:`giganexus/RustIt` → Settings → CI/CD → Runners → **New project runner**(不要從 Admin area 建,那是共享的 instance runner):
   - Tags `windows`;**不勾** Run untagged jobs;Description `host2-windows`
   - **勾** Lock to current projects;Protected 先不勾(要能在 feature 分支手動驗證);Maximum job timeout `3600`
   - 建立後頁面顯示的 `glrt-…` Token 只出現一次,直接用於步驟 3
2. **需求方** — 建立專用低權限本機帳號(不加入 Administrators;經 Authenticated Users 屬於 Users,可讀 Program Files):

   ```powershell
   $pw = Read-Host -AsSecureString '設定 gitlab-runner-svc 密碼'
   New-LocalUser -Name gitlab-runner-svc -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description 'GitLab Runner (RustIt P6-4)'
   ```

3. **需求方** — 註冊(新式 `glrt-` Token 的 tag、鎖定等設定在 GitLab 頁面,這裡不用 `--tag-list`):

   ```powershell
   cd C:\GitLab-Runner; .\gitlab-runner.exe register --non-interactive --url http://10.10.130.123/ --token <Token> --executor shell --shell powershell --name host2-windows --builds-dir C:\ci\builds --cache-dir C:\ci\cache --env "CARGO_HOME=C:\ci\cargo-home"
   ```

4. **Claude 可代勞** — 調整 `C:\GitLab-Runner\config.toml` 與權限(不讀出 Token):
   - 全域 `concurrent = 1`;`[[runners]]` 的 `shell = "pwsh"`。**不可用 `shell = "powershell"`**:Windows PowerShell 5.1 在 CP950 系統解析 Runner 產生的 UTF-8 腳本會失敗(job 記錄出現大量 `ParserError … UnexpectedToken` 與亂碼,最後 `exit status 0xfffd0000`)。job 內的 `powershell -File build-release.ps1` 不受影響(該檔含 BOM)。
   - 建 `C:\ci\builds`、`C:\ci\cache`、`C:\ci\cargo-home`;`gitlab-runner-svc` 對 `C:\ci` **修改**,對 `C:\Rust`、`C:\Tools`、`C:\GitLab-Runner` **讀取與執行**。
   - `config.toml` 含 Token:移除繼承,只留 SYSTEM、Administrators(完全控制)與 `gitlab-runner-svc`(讀取)。
5. **需求方** — 授予「以服務方式登入」(`SeServiceLogonRight`)。`gitlab-runner install --user` **不會**自動授予,少了這步服務啟動會失敗(事件 7041、Security 4625 狀態 `0xc000015b`):

   ```powershell
   $sid = (Get-LocalUser gitlab-runner-svc).SID.Value
   secedit /export /cfg C:\ci\sec.inf /areas USER_RIGHTS | Out-Null
   (Get-Content C:\ci\sec.inf) -replace '^(SeServiceLogonRight = .*)$', "`$1,*$sid" | Set-Content C:\ci\sec-new.inf -Encoding Unicode
   secedit /configure /db C:\ci\sec.sdb /cfg C:\ci\sec-new.inf /areas USER_RIGHTS
   Remove-Item C:\ci\sec.inf, C:\ci\sec-new.inf, C:\ci\sec.sdb -ErrorAction SilentlyContinue
   ```

6. **需求方** — 安裝為服務並啟動:

   ```powershell
   $pw = Read-Host -AsSecureString 'gitlab-runner-svc 密碼'
   cd C:\GitLab-Runner; .\gitlab-runner.exe install --user ".\gitlab-runner-svc" --password ([Net.NetworkCredential]::new('', $pw).Password); .\gitlab-runner.exe start
   ```

7. 確認:服務 `gitlab-runner` 以 `.\gitlab-runner-svc` 執行、狀態 Running、自動啟動;GitLab Runner 頁面 `host2-windows` 顯示 **Online**、Assigned Projects 只有 `giganexus/RustIt`。

## 4. 驗證

1. 對 RustIt 任一分支的 pipeline 手動執行 `build:release`:應在 Runner 上建置並產出 `release-out/`(artifact):`agent\<版本>\rustit-agent.exe`、`watchdog\<版本>\rustit-watchdog.exe`、`SHA256SUMS.txt`、`RELEASE-INFO.txt`(`signed=false`)。
2. 下載 artifact,在開發機核對 `SHA256SUMS.txt`(`Get-FileHash`)。
3. 簽章人員走完 `sign-release.ps1` → `publish-release.ps1`(見 `docs/RUNBOOK.md` §1)。

## 5. 安全注意事項

- Runner 會執行 repo 裡的任意建置腳本:**只綁 `giganexus/RustIt` 一個專案**,不要設成共享 Runner;**不要裝在網域控制站**(PLATFORM-PLAN §4.9)。
- Runner 主機**沒有**簽章憑證與私鑰;`build:release` 的產物一律視為未簽章,簽章前必須核對雜湊。
- tag `rustit-v*` 才會自動建置;建立這種 tag 需要 Maintainer 權限(在 GitLab 設定受保護的 tag `rustit-v*`,只允許 Maintainer)。
- artifact 保存 30 天;正式發版的已簽章檔案留在版本檔目錄與簽章人員保管處,不依賴 CI artifact 長期保存。

## 6. 維護

| 情況 | 做法 |
| --- | --- |
| 服務帳號密碼 | 密碼由 Windows 加密存在 LSA,不在環境變數或 `config.toml`,無法讀回;建議放公司密碼保管工具。忘記時重設即可,**不必重新註冊 Runner**(見下列) |
| 重設服務帳號密碼(需求方) | `$pw = Read-Host -AsSecureString`;`Set-LocalUser gitlab-runner-svc -Password $pw`;再 `$c = New-Object PSCredential('.\gitlab-runner-svc', $pw); $s = Get-CimInstance Win32_Service -Filter "Name='gitlab-runner'"; Invoke-CimMethod -InputObject $s -MethodName Change -Arguments @{StartName=$c.UserName; StartPassword=$c.GetNetworkCredential().Password}; Restart-Service gitlab-runner` |
| 改 `config.toml` 後 | `Restart-Service gitlab-runner`(或等 Runner 自動重新載入) |
| 升級工具 | 重跑 `install-runner-tools.ps1` 只補缺的;Rust 升版用 `rustup update`(以系統管理員、`RUSTUP_HOME=C:\Rust\rustup`、`CARGO_HOME=C:\Rust\cargo` 執行) |
| 以系統管理員在建置目錄下 git 指令 | 目錄擁有者是 `gitlab-runner-svc`,git 會報 `dubious ownership`;只讀檢查時用 `git -c safe.directory=<路徑> …`,不要加全域例外 |
| Runner 記錄 | 事件檢視器 → 應用程式,來源 `gitlab-runner`;`request_concurrency=1` 的 long polling 警告在 `concurrent = 1` 下可忽略 |
