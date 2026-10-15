# Bug 修改紀錄

新紀錄加在最上方;格式見 `AGENT.md` §10。

## 2026-10-15 裝置被停用期間被記成離線期間
- 內容:P2-3 VM 驗證時,IT 停用裝置 10 分鐘後恢復,主機收到一筆 reason `rejected` 的 `offline_period`。停用是 IT 的操作、主機有回應,主機端本來就知道(`ita.device.status`),再記離線期間是重複且會誤導。`SendError::counts_as_offline` 改為也排除裝置停用 / 退役(403 `ITA_DEVICE_DISABLED` / `ITA_DEVICE_RETIRED`、WebSocket close 4403);其他 403(憑證、身分)仍算離線。另外收到停用回應時結束進行中的離線期間(`ConnTracker::observe_failure`):網路恢復後第一個回應就是停用時,原本那段期間會一直延續到 IT 重新啟用才結束。429、400 的行為不變。rustit-agent 升為 0.2.1。
- 檔案:`RustAgent/crates/common/src/transport.rs`、`RustAgent/crates/agent/src/{conn,lib}.rs`、`RustAgent/crates/agent/Cargo.toml`、`RustAgent/Cargo.lock`、`docs/contracts/event.schema.json`(reason 說明)、`docs/HANDOFF.md`
- 驗證:`cargo test -p rustit-agent -p rustit-common` 全數通過(新增 conn 測試:停用不開離線期間、停用回應結束進行中的期間並送出一筆 network 的 offline_period、429 不影響期間;transport 測試:停用 / 退役 / 4403 / 400 / 429 不算離線,其他 403 與網路錯誤算);`cargo clippy --all-targets` 無警告;`cargo fmt --check` 通過。VM 實測待下次重建 MSI。

## 2026-10-14 shell 腳本在 Windows checkout 後變成 CRLF
- 內容:開發機 `core.autocrlf=true`,`host2-issue-test-device-cert.sh` 合併後重新 checkout 變成 CRLF,複製到主機 2 以 `sh` 執行會因 `\r` 失敗。新增 `.gitattributes`:`*.sh text eol=lf`,不論 checkout 設定一律 LF。
- 檔案:`.gitattributes`
- 驗證:`git ls-files --eol` 兩個 `.sh`(`ItAgentBack/deploy/host2-set-secrets.sh`、`RustAgent/installer/host2-issue-test-device-cert.sh`)皆為 `i/lf w/lf`;`git add --renormalize .` 無其他檔案變動。

## 2026-10-14 乾淨的 Windows 安裝 MSI 失敗(1920 / 1603):缺 VC++ 執行階段
- 內容:Hyper-V 測試 VM(全新 Win10)安裝測試區 MSI,服務 30 秒內未啟動(錯誤 1920)而整個回滾(1603)。原因是 `rustit-agent.exe` 以 MSVC 預設動態連結 `VCRUNTIME140.dll`,開發機有 VC++ 可轉散發套件所以沒發現,乾淨系統沒有,程式無法載入。新增 `RustAgent/.cargo/config.toml`,對 `x86_64-pc-windows-msvc` 開 `+crt-static`,把 C 執行階段靜態連結進 exe(workspace 全部 crate 生效,之後的 Watchdog、desktop 也不需另裝執行階段)。
- 檔案:`RustAgent/.cargo/config.toml`
- 驗證:重建後 exe 不再引用 `VCRUNTIME140.dll` 與 `api-ms-win-crt-*`;`cargo test -p rustit-agent -p rustit-common` 26 項通過;新 MSI SHA-256 `08f1620b…2033b2`,已放到主機 2。VM 重新安裝成功,P1 VM 驗證 7 項通過(HANDOFF「P1 收尾」)。
