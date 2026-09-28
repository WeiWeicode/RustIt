# 0002：軟體派送（勾選後背景安裝 / 移除）

- 日期：2026-09-27（同日補充「安裝檔來源：NAS + HTTPS」）
- 狀態：建議中；Demo 已實作單機版（Firefox、WinRAR，直接從原廠下載）
- 相關：[PRD](../PRD.md) 5.4（遠端管理指令）、4.3（軟體授權報表）、[0001](0001-nginx-gateway-and-grpc.md)（Agent 通訊採 gRPC）

## 結論

由 Agent（Windows 服務，SYSTEM 權限）執行安裝檔的靜默參數，在背景安裝與移除軟體，使用者不需操作、不會跳出 UAC。
IT 在後台維護「軟體目錄」與「軟體組合」，對電腦勾選軟體或把組合綁到 AD OU / 群組後，由 Agent 依序下載、驗證、安裝並回報結果。

## 做法

Agent 以 `std::process::Command` 執行靜默安裝，依結束代碼判斷結果：

```rust
use std::path::Path;
use std::process::Command;

pub enum InstallResult { Success, RebootRequired, Busy, Failed(i32) }

pub fn install_msi(msi: &Path, log: &Path) -> std::io::Result<InstallResult> {
    let status = Command::new("msiexec")
        .arg("/i").arg(msi)
        .args(["/qn", "/norestart", "/l*v"]).arg(log)
        .status()?; // 正式版要加逾時（例如 30 分鐘），超過就結束程序
    Ok(match status.code().unwrap_or(-1) {
        0 => InstallResult::Success,
        3010 | 1641 => InstallResult::RebootRequired,
        1618 => InstallResult::Busy, // 另一個安裝正在進行，稍後重試
        c => InstallResult::Failed(c),
    })
}
```

常見安裝檔的靜默參數（存在軟體目錄裡）：

| 安裝檔類型 | 靜默安裝參數 | 常見例子 |
| --- | --- | --- |
| MSI | `msiexec /i x.msi /qn /norestart` | Chrome Enterprise、7-Zip、多數企業軟體 |
| Inno Setup | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` | Notepad++、VS Code 系統版 |
| NSIS | `/S` | Firefox、許多開源工具 |
| InstallShield | `/s /v"/qn"` | 舊款商用軟體 |
| WiX Burn | `/quiet /norestart` | .NET Runtime、VC++ 可轉散發套件 |
| Office | `setup.exe /configure config.xml` | Microsoft 365 Apps（Office 部署工具） |

## 後台資料

1. **軟體目錄**：每個軟體一筆，欄位如下：
   - 名稱、版本、安裝檔、SHA-256、預期的簽章者
   - 靜默安裝參數、解除安裝參數
   - 「是否已安裝」的判斷規則：登錄檔 Uninstall 的 DisplayName、MSI 產品代碼或檔案版本
   - 是否需要重開機、授權數量
2. **軟體組合**：例如「業務部標準組合」= Office + Chrome + VPN + ERP 用戶端。可綁定 AD OU / 群組，新電腦一加入就自動安裝；也可以手動勾選。
3. **派送工作**：IT 勾選後產生，後台即時顯示每台電腦、每個軟體的進度與結束代碼。

## 流程

IT 勾選 → 經 gRPC 長連線下達給 Agent → Agent 從公司伺服器下載 → 驗證 SHA-256 與數位簽章 → 依序靜默安裝 → 回報結果 → 重新掃描登錄檔，確認真的裝好。

每個軟體的狀態：排隊中 → 下載中 → 驗證中 → 安裝中 → 成功 / 需重開機 / 失敗（可重試）。
移除時改用登錄檔裡的 `UninstallString`（或 `QuietUninstallString`）加上靜默參數；MSI 改成 `msiexec /x {產品代碼} /qn`。

## 安裝檔來源：NAS 儲存，RustIt 伺服器以 HTTPS 提供

IT 事先下載並測試安裝檔，放在內網 NAS；Agent 一律從內網取檔，不直接連原廠網站。

**背景**：Demo 實測（2026-09-27 晚間）從 Mozilla CDN 下載只有 0.1–0.2 MB/s，但同一台電腦測速有 530 Mbps。路由追蹤顯示流量在中華電信 HiNet 內只有 2–5 ms，轉到 NTT 國際線路後升到約 75 ms，晚間尖峰國際線路壅塞，單一連線速度受限。改從內網取檔可完全避開這個問題。

```
IT 上傳 / 指定安裝檔 ──► NAS（\\nas\rustit-packages\軟體\版本\）
                            ▲ 伺服器掛載，唯讀
Agent ──HTTPS + mTLS──► nginx ──► RustIt 伺服器 /packages/...
```

### 兩種取檔方式比較

| | A. Agent 直接讀 NAS 共用資料夾（SMB） | B. NAS 當儲存，RustIt 伺服器以 HTTPS 提供（採用） |
| --- | --- | --- |
| 路徑 | `\\nas\software\firefox\156.0.1\...` | `https://rustit.corp.local/packages/firefox/156.0.1` |
| 身分驗證 | Agent 以 SYSTEM 執行，連網路時用電腦帳號（`網域\電腦名$`）。NAS 必須加入 AD，並開放「Domain Computers」唯讀。 | 沿用 Agent 的 mTLS 憑證，NAS 帳密只有伺服器知道。 |
| 進度、續傳 | 需要自己實作 | HTTP 原生支援（Range），Demo 的下載程式幾乎不用改 |
| 稽核 | 只有 NAS 的存取紀錄 | 誰在何時下載哪個版本，寫入 RustIt 稽核紀錄 |
| 經過 nginx | 否 | 是，與 [0001](0001-nginx-gateway-and-grpc.md) 一致 |

**採用 B 的理由**：Agent 不需要 NAS 帳密，權限、紀錄、續傳集中在伺服器。若 NAS 未加入 AD，A 方案只能開匿名讀取或在每台電腦存帳密，兩者都不可接受。

### IT 作業流程

1. **加入軟體目錄**：在後台上傳安裝檔，或從 NAS 資料夾挑選。伺服器自動計算 SHA-256、讀出數位簽章者；MSI 另外讀出產品代碼與版本。
2. **填靜默參數**：依安裝檔類型帶入範本（MSI `/qn`、NSIS `/S`、Inno Setup `/VERYSILENT`…）。
3. **測試機驗證**：先派送到測試機，確認安裝、移除、偵測都正常；第二人覆核後才發布。
4. **版本分資料夾保存**：例如 `firefox\156.0.1\`、`firefox\157.0\`。軟體目錄指向特定版本，新版有問題可切回舊版。

### 安全與容量

- **防竄改**：有 NAS 寫入權限的人可能替換檔案。Agent 下載後必須比對目錄記錄的 SHA-256 與簽章者，不符就拒絕安裝。NAS 權限設為「IT 可寫、RustIt 伺服器唯讀」。
- **頻寬估算**：2,000 台 × 90 MB ≈ 180 GB；NAS 若為 1 GbE（實際約 110 MB/s），全部傳完約 30 分鐘，仍需分批派送。
- **多廠區**：每個廠區放一台 NAS 作為分發點，Agent 依所在網段就近下載，避免跨廠區專線被塞滿。
- **自動更新（可選）**：伺服器定期檢查常用軟體（Firefox、Chrome 企業版等）的新版本，自動下載到 NAS，經 IT 核准後才開放派送。

## 注意事項

| 問題 | 說明與對策 |
| --- | --- |
| 安裝畫面看不到 | 服務在 session 0 執行，安裝檔只要跳出任何視窗就會卡住且沒人看得到。一律使用靜默參數，並設定逾時，時間到就結束程序、回報失敗。 |
| 一次只能跑一個安裝 | Windows Installer 同時只能執行一個安裝，遇到結束代碼 1618 就排隊。Agent 端所有安裝 / 移除依序執行。 |
| 只裝在個人帳號底下的軟體 | 部分安裝檔只裝進目前使用者的個人資料夾（VS Code 使用者版、Chrome 個人版），以 SYSTEM 身分會裝錯位置。軟體目錄一律選「整台電腦」版本。 |
| 解除安裝程式提早結束 | NSIS 的解除安裝程式會先把自己複製到暫存資料夾再執行，原程序立刻結束。完成與否不能只看程序結束，要輪詢登錄檔直到項目消失。 |
| 重新開機 | 結束代碼 3010 代表需要重開機。不強制重開，由托盤通知使用者或排到下班時間。 |
| 頻寬 | 2,000 台同時下載大型安裝檔會塞爆網路。分批派送、限速、支援斷點續傳；安裝檔在本機快取，重試時不必重新下載。 |
| 安全性 | 此功能等於可在全公司電腦執行任意程式，風險最高。只接受後台經 mTLS 下達的指令；安裝檔必須驗證雜湊值與簽章者；只有特定 AD 群組可以派送；每次派送寫入稽核紀錄；新增軟體到目錄時建議兩人覆核。 |
| 授權 | 派送紀錄對應 PRD 4.3 的軟體授權報表，授權數用完就不允許派送。商業軟體（例如 WinRAR）企業使用需購買授權。 |
| winget | 可用，但以 SYSTEM 身分執行 winget 的官方支援有限，且預設從網路來源下載。安裝檔統一放在公司的 RustIt 伺服器，版本才可控。 |

## Demo 實作（單機）

Demo 的「軟體派送」頁會**真的**下載並安裝 / 移除軟體，用來驗證流程：

| 軟體 | 下載來源 | 安裝參數 | 移除方式 | 預期簽章者 |
| --- | --- | --- | --- | --- |
| Mozilla Firefox（繁中） | `download.mozilla.org` 官方最新版轉址 | `/S /MaintenanceService=false` | `uninstall\helper.exe /S` | Mozilla Corporation |
| WinRAR 7.23（繁中） | `www.rarlab.com/rar/winrar-x64-723tc.exe` | `/S` | `Uninstall.exe /S` | win.rar GmbH |

與正式版的差異：

- Demo 以一般使用者執行，安裝與移除時會跳出 Windows 的 UAC 確認；正式版由 Agent（SYSTEM）執行，不會跳出。
- Demo 直接從原廠網站下載；正式版一律從公司的 RustIt 伺服器下載。
- Demo 下載後以 Authenticode 簽章（狀態須為 Valid 且簽章者符合）取代 SHA-256 比對，因為原廠「最新版」連結的檔案會變動。
- 安裝檔快取在 `%LOCALAPPDATA%\RustIt\cache`。

## 待確認

- [ ] 軟體目錄的管理流程：誰可以新增軟體、是否需要兩人覆核。
- [ ] NAS 型號、容量與網路介面（1 GbE / 10 GbE），是否已加入 AD。
- [ ] RustIt 伺服器掛載 NAS 的方式（SMB / NFS）與使用的服務帳號。
- [ ] 是否有多個廠區需要各自的分發點 NAS。
- [ ] 派送時段與頻寬限制（例如上班時間每台限速、每批最多幾台）。
- [ ] 需要重開機時的處理原則（通知使用者 / 排到下班時間 / 強制）。
- [ ] 是否開放使用者自助安裝（托盤程式列出 IT 核准的軟體）。
