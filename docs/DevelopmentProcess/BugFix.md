# Bug 修改紀錄

新紀錄加在最上方;格式見 `AGENT.md` §10。

## 2026-10-15 logs.collect 的 zip 檔案時間為 1980-01-01、瞬間完成的指令沒有 started_at
- 內容:測試區 VM 驗證時發現兩個小問題。① zip 項目沒有設定修改時間,`zip` 套件未開 time / chrono 功能時預設 1980-01-01;改為日誌檔的修改時間(本機時間,zip 格式無時區),讀不到時用現在時間。② Agent 的 `command_log` 每筆指令只保留最後狀態,瞬間完成的指令(`agent.log_level`、`agent.restart` 重送)running 被 succeeded 覆蓋,主機沒收到 running 而沒有 `started_at`;主機收到終態時,若沒有 started_at 且不是「未開始執行」的失敗(UNSUPPORTED_COMMAND、EXPIRED、INVALID_PARAMS、NOT_RUNNING_AS_SERVICE),以 `acked_at`(沒有則本次時間)補上。
- 版本:rustit-agent 0.4.1。
- 檔案:`RustAgent/crates/agent/src/logs.rs`、`Cargo.toml`;`ItAgentBack/src/services/command-dispatcher.ts`、`src/stores/{types,sql-command-store}.ts`、`test/{commands.test,helpers}.ts`、`test/int/stores.int.test.ts`
- 驗證:`cargo test -p rustit-agent -p rustit-common` 全數通過(zip 項目時間等於日誌檔修改時間),clippy 無警告;`npm test` 92、`npm run test:int` 8 項通過(瞬間完成補 started_at、UNSUPPORTED_COMMAND 不補,SQL 條件更新)。

## 2026-10-15 指令 API 自動註冊被 Gateway 拒絕(IMPORT_HAS_ERRORS)
- 內容:P4-1 / P4-2 部署測試區後,endpoint-api 啟動時自動註冊 OpenAPI 失敗(`API 自動註冊失敗,Gateway 路由未更新`),指令與附檔下載路由都沒有進入 Gateway 草稿。原因:① `x-permissions` 沒有宣告 `endpoint.command.basic`(`openapi.ts` 仍是 P4 前「待指令 API 實作時再宣告」);② `endpoint.command.listByDevice` 含大寫,不符 Gateway 的代碼格式 `^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$`。任一路由不符時整批拒絕。既有 OpenAPI 測試只建了不含指令路由的管理 API,沒有抓到。修正:宣告 `endpoint.command.basic`(端點一般指令,指南 §8.2)、operationId 改 `endpoint.command.list-by-device`;新增測試以 Gateway 相同規則檢查全部路由(operationId / x-permission 格式、權限已宣告、summary、description ≤ 1000、x-gherkin);`npm run openapi` 也輸出指令與附檔路由,與自動註冊內容一致。
- 檔案:`ItAgentBack/src/openapi.ts`、`src/routes/commands.ts`、`src/print-openapi.ts`、`test/command-files.test.ts`
- 驗證:`npm test` 91 項通過;`npm run openapi` 的輸出以 Gateway `bff/src/cli/openapi.ts` 的 `parseOpenApi` 檢查:errors 0、路由 10 條、權限 `endpoint.device.read`、`endpoint.command.basic`。測試區日誌(`d68f066`)可見原本的錯誤內容。

## 2026-10-15 前景 Agent 本機狀態目錄被誤加入版控
- 內容:P4-1 合併 develop(`e30fe9a`)時,把開發機前景執行 Agent(`cargo run -p rustit-agent -- run --config crates/agent/agent.dev.toml`,`state_dir` 為設定檔目錄下的 `state/`)產生的 `RustAgent/crates/agent/state/` 一併 commit:`store.db`(含 `-shm`、`-wal`)是本機 SQLite 佇列,`store.key` 是以 DPAPI 保護的本機加密金鑰。改為 `git rm --cached` 移出版控(不刪本機檔案,開發機的 Agent 仍在使用),並在根目錄 `.gitignore` 加上 `/RustAgent/crates/agent/state/`。`store.key` 由 DPAPI 綁定開發者的 Windows 帳號,其他帳號或電腦無法解開,外洩風險低;歷史中的舊版本仍在,是否改寫歷史另行決定。
- 檔案:`.gitignore`、`RustAgent/crates/agent/state/*`(移出版控)
- 驗證:`git ls-files RustAgent/crates/agent/state` 無輸出;`git check-ignore -v RustAgent/crates/agent/state/store.key` 命中 `.gitignore` 新規則;主 checkout 的本機檔案仍存在。

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
