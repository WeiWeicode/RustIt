# Windows 本機 GitLab Runner 設定(P6-4)

> 對應 PLATFORM-PLAN §4.9(選項 C:Windows Runner 建置 + 人工簽章)、P6-UPGRADE-DESIGN §6。
> **目的**:在主機 2 的 Windows 本機(不經 WSL)跑 `RustAgent/installer/build-release.ps1`,產出**未簽章**的 Agent / Watchdog exe 與 `SHA256SUMS.txt`。
> **不放簽章憑證**:私鑰不在 Runner(ADR 0003;能推受保護分支的人不能因此簽章)。簽章由簽章人員在自己的電腦做(`sign-release.ps1`)。

## 1. 為什麼要另一個 Runner

| | 既有 Runner | 新增 Runner |
| --- | --- | --- |
| 位置 | 主機 2 的 WSL(Linux),shell executor | 主機 2 的 **Windows 本機**,shell executor,shell = PowerShell |
| tag | `windows-runner`(名稱容易混淆:它其實是 WSL 內的 Linux Runner) | `windows` |
| 用途 | ItAgentBack 的檢查與測試環部署(Docker) | Rust(MSVC)與 WiX 的 Windows 建置 |
| 併發 | 依現況 | `concurrent = 1`(Rust release 建置吃 CPU 數分鐘,不要和測試區部署同時搶) |

RustIt 的 `.gitlab-ci.yml` 已有兩個 `windows` tag 的 job(`build:release`、`audit:rust`);**沒有這個 Runner 時它們不會執行**,手動 job 不擋 pipeline。

## 2. 前置條件(主機 2,Windows 10)

建議**等測試區沒有人在驗收時**再裝(Runner 與 Rust 建置會吃 CPU 與磁碟;主機 2 同時跑測試區 Gateway 與端點測試 VM)。磁碟至少留 15 GB。

| 項目 | 安裝 | 驗證 |
| --- | --- | --- |
| Visual Studio Build Tools(C++ 桌面開發:MSVC、Windows SDK) | Microsoft 官方安裝程式,只選「使用 C++ 的桌面開發」 | `cl` 在「x64 Native Tools」命令列可用 |
| Rust(MSVC 工具鏈) | `rustup-init.exe`,`stable-x86_64-pc-windows-msvc`,安裝到 Runner 服務帳號可用的位置 | `cargo --version`、`rustc --version` |
| WiX v5(**不可 v6 以上**,企業使用需付 OSMF) | `dotnet tool install --global wix --version 5.0.2`(需 .NET SDK) | `wix --version` 以 `5.` 開頭 |
| Git for Windows | 官方安裝程式 | `git --version` |
| (選用)`cargo-audit` | `cargo install cargo-audit --locked` | `cargo audit --version`(要連 RustSec 資料庫,內網可能連不到) |
| 私有 npm / crates 來源 | Rust 目前沒有私有 crate;`cargo build --locked` 用 `Cargo.lock`,需要能連 crates.io(或公司鏡像) | 在 Runner 帳號下 `cargo fetch` |

## 3. 安裝與註冊 Runner

由**需求方**執行(註冊 Token 是機密,Claude 不經手);非機密的安裝步驟 Claude 可以經 `ssh host2` 代勞。

1. 下載 `gitlab-runner-windows-amd64.exe`(版本與既有 Runner 一致或更新),放到 `C:\GitLab-Runner\`,改名 `gitlab-runner.exe`。
2. 取得註冊 Token:GitLab → `giganexus/RustIt` → Settings → CI/CD → Runners → New project runner(tag `windows`,**不勾**「Run untagged jobs」;勾「Lock to current projects」)。
3. 註冊(系統管理員 PowerShell):

   ```powershell
   cd C:\GitLab-Runner
   .\gitlab-runner.exe register --non-interactive `
     --url http://10.10.130.123/ --token <Runner 驗證 Token> `
     --executor shell --shell powershell `
     --name host2-windows --tag-list windows
   ```

4. 編輯 `C:\GitLab-Runner\config.toml`:`concurrent = 1`;`[[runners]]` 下確認 `executor = "shell"`、`shell = "powershell"`,並限制 `builds_dir`、`cache_dir` 在專用磁碟路徑(例如 `D:\ci\builds`)。
5. 安裝為服務並啟動:

   ```powershell
   .\gitlab-runner.exe install --user ".\<Runner 專用本機帳號>" --password <密碼>
   .\gitlab-runner.exe start
   ```

   服務帳號用**專用的低權限本機帳號**(不是 Administrator、不是網域帳號),只對 `D:\ci\` 與 Rust / WiX 的安裝目錄有權限。密碼由需求方輸入,不貼進對話。
6. GitLab 的 Runner 頁面應顯示 `host2-windows` 在線。

## 4. 驗證

1. 對 RustIt 任一分支的 pipeline 手動執行 `build:release`:應在 Runner 上建置並產出 `release-out/`(artifact):`agent\<版本>\rustit-agent.exe`、`watchdog\<版本>\rustit-watchdog.exe`、`SHA256SUMS.txt`、`RELEASE-INFO.txt`(`signed=false`)。
2. 下載 artifact,在開發機核對 `SHA256SUMS.txt`(`Get-FileHash`)。
3. 簽章人員走完 `sign-release.ps1` → `publish-release.ps1`(見 `docs/RUNBOOK.md` §1)。

## 5. 安全注意事項

- Runner 會執行 repo 裡的任意建置腳本:**只綁 `giganexus/RustIt` 一個專案**,不要設成共享 Runner;**不要裝在網域控制站**(PLATFORM-PLAN §4.9)。
- Runner 主機**沒有**簽章憑證與私鑰;`build:release` 的產物一律視為未簽章,簽章前必須核對雜湊。
- tag `rustit-v*` 才會自動建置;建立這種 tag 需要 Maintainer 權限(在 GitLab 設定受保護的 tag `rustit-v*`,只允許 Maintainer)。
- artifact 保存 30 天;正式發版的已簽章檔案留在版本檔目錄與簽章人員保管處,不依賴 CI artifact 長期保存。
