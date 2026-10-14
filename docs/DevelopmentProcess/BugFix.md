# Bug 修改紀錄

新紀錄加在最上方;格式見 `AGENT.md` §10。

## 2026-10-14 乾淨的 Windows 安裝 MSI 失敗(1920 / 1603):缺 VC++ 執行階段
- 內容:Hyper-V 測試 VM(全新 Win10)安裝測試區 MSI,服務 30 秒內未啟動(錯誤 1920)而整個回滾(1603)。原因是 `rustit-agent.exe` 以 MSVC 預設動態連結 `VCRUNTIME140.dll`,開發機有 VC++ 可轉散發套件所以沒發現,乾淨系統沒有,程式無法載入。新增 `RustAgent/.cargo/config.toml`,對 `x86_64-pc-windows-msvc` 開 `+crt-static`,把 C 執行階段靜態連結進 exe(workspace 全部 crate 生效,之後的 Watchdog、desktop 也不需另裝執行階段)。
- 檔案:`RustAgent/.cargo/config.toml`
- 驗證:重建後 exe 不再引用 `VCRUNTIME140.dll` 與 `api-ms-win-crt-*`;`cargo test -p rustit-agent -p rustit-common` 26 項通過;新 MSI SHA-256 `08f1620b…2033b2`,已放到主機 2。VM 重新安裝成功,P1 VM 驗證 7 項通過(HANDOFF「P1 收尾」)。
