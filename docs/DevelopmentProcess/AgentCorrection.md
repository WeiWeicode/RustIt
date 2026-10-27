# Agent 修改紀錄(RustAgent)

新紀錄加在最上方;格式見 `AGENT.md` §10。本檔自 P7-2 起記錄 `RustAgent/` 的修改,先前的 Agent 變更記在 `NewFeatures.md` / `BugFix.md`。

## 2026-10-27 P7 VM 驗收修正:版本比對升級、套件逾時、安裝後等待理會關機、禁止 REMOVE=ALL 與 /v 轉交(0.9.2)
- 內容:VM 驗收(設計 §8.3)#1、#2 時發現的問題,需求方 2026-10-27 決定先修再完整驗收;細節見設計 §8.1.4。分支 `feature/p7-acceptance-fixes`(從 develop `c1f6d10`)。
  - B-2:`software/detect.rs` 新增純函式 `parse_version` / `compare_versions` / `installed_state`(數字分段比較,段數不同補 0;多個項目任一個相同或較新即已安裝);`install()` 找到項目時較舊就安裝(升級)、相同或較新回 `already_installed`、**無法解析保守視為已安裝**(`version_unknown`,0.9.1 行為);安裝後輪詢要等版本到位,否則 `DETECT_FAILED`;結果帶 `installed_version`、升級時 `previous_version`(`clean_version` 去控制字元、≤ 50 字)。`Env::find` 改回傳全部符合的項目,移除流程取第一個、不比對版本。
  - B-1:快照 `timeout_sec` 只接受 300–7200(原 60–14,400),沒帶用 1800。
  - 安裝後等待理會關機:`Env::pause`(`Shared::stop_signal`,收到服務停止 / 關機 / `agent.restart` 立即回傳),用在逾時後等 Windows Installer(`settle`,回 `Settle::Stopped`)與安裝 / 移除後的登錄檔輪詢;中斷回 `EXECUTION_FAILED` + `result.interrupted`。
  - L2:`args.rs` 拒絕 `REMOVE=ALL`(逗號清單、引號、大小寫);資安稽核 M1:Inno 以外拒絕 `v` 開頭的開關(`/vREMOVE=ALL` 等轉交 msiexec)。
  - 版本 0.9.1 → **0.9.2**;Watchdog 不改。
- 檔案:`RustAgent/crates/agent/src/software/{mod,detect,args,tests}.rs`、`agent/src/lib.rs`、`agent/Cargo.toml`、`Cargo.lock`;`docs/contracts/{command-kinds.md,install-args.vectors.json,examples/ws-command-update-software-install.sample.json}`、`docs/P7-SOFTWARE-DESIGN.md` §1、§2.2、§5.2、§8.1.4、§8.2。
- 驗證:`cargo test -p rustit-agent` 131/131(新增 `version_compare`、`installed_state_rules`、`older_version_is_upgraded`、`upgrade_must_reach_package_version`、`stop_signal_ends_waits_after_install`;契約向量含新增的 `REMOVE=ALL`、`/v` 案例);`cargo fmt --check` 通過。code-reviewer、security-auditor 已跑並處理(設計 §8.1.4)。VM 驗收待 0.9.2 建置後重做。

## 2026-10-22 P7-3 Agent system.reboot / system.reboot.cancel / reboot_policy(0.9.0)
- 內容:分支 `feature/p7-2-agent-software`(`8c8a63f`、`b9032d8`、`1b383f7`);細節與編號見設計 §8.1.3。
  - `reboot.rs`(新):`system.reboot` 參數再驗(`delay_sec` 0–86400、`message` 單行 ≤ 200、`force`)、提示文字(固定前綴、附發送人)、`InitiateSystemShutdownExW` 排程(`SeShutdownPrivilege`;計畫性、事件 1074 原因「其他」),倒數由 Windows 保存;`abort`(`AbortSystemShutdownW`)。
  - `command.rs`:新增 `system.reboot`(服務模式才執行、取得串行鎖、等鎖後重驗有效期限、先排程成功後才 `WTSSendMessage`)與 `system.reboot.cancel`(不取串行鎖,結果 `{ aborted }`);排程前記 kv `reboot_command`,重開機後補送 `succeeded`(`{ rebooted, recovered_at }`)。
  - 需求方 2026-10-22 決定(都照建議):H1 本機上限(開機未滿 30 分鐘不接受、24 小時內最多 3 次含取消、有人登入時倒數至少 60 秒 → `REBOOT_LIMITED`);M1 倒數中 `software.*` / `agent.upgrade` / `agent.restart` 回 `REBOOT_PENDING`;M2 新增 `system.reboot.cancel`。
  - 修正:發送人工號只顯示英數字 1–16 字(`message.show` 一併套用);字元過濾加 Cf / Zl / Zp、`message` 不可只有空白;`reboot_policy = required` 只在安裝成功且非 1638 時標記 `reboot_required`(`software/mod.rs`);`build-agent-msi.ps1` 兩份簽章者清單有交集時警告。
  - 未處理:`SeShutdownPrivilege` 啟用後未還原(影響小);`reboot_policy` 觸發的重開機尚無自動排程(只標記)。
- 檔案:`RustAgent/crates/agent/src/{reboot,command,lib}.rs`、`agent/src/software/{mod,tests}.rs`、`agent/Cargo.toml`、`common/src/config.rs`、`RustAgent/installer/build-agent-msi.ps1`;文件 `docs/contracts/command-kinds.md`、`docs/P7-SOFTWARE-DESIGN.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`。
- 驗證:`cargo test -p rustit-agent -p rustit-common`:Agent 124/124(`1b383f7` 時);`rustit-common` 單獨執行會因 `log::set_boxed_logger` 編譯失敗(既有問題),與 Agent 一起編譯時設定測試 `software_signers_are_separate`、`trusted_signers_are_validated` 通過;`cargo build -p rustit-watchdog` 通過。(測試由主工作階段執行,文件回寫未重跑)。測試區 MSI `GigaNexusAgent-0.9.0-test.msi`(SHA-256 `589309dfaa6a846e0dd996ec0918e069cd199221119d52b81571ce6cf4e060ec`,內含 Agent 0.9.0、Watchdog 0.3.2,由 `1b383f7` 以 `build-agent-msi.ps1` 建置)。VM 驗收(設計 §8.3)尚未做。

## 2026-10-22 P7-2 Agent software 模組(0.9.0)
- 內容:新增 `software.install` / `software.uninstall` 兩個指令類型的 Agent 端(設計 `P7-SOFTWARE-DESIGN.md` §5、§8.1.2);分支 `feature/p7-2-agent-software`(`591ab84`、`11145d6`、`a484b1e`、`4848605`、`f3af32d`)。
  - `software/args`:安裝參數第二道檢查,與 ItAgentBack `argsErrors` 逐條對應,通過契約向量 `docs/contracts/install-args.vectors.json`。
  - `software/download`:下載到 `cache\software\{packageId}`,Range 續傳、快取沿用、大小與 SHA-256 驗證;磁碟需求 = 安裝檔 × 2(下載檔 + staging 複本)+ 1 GB(`DISK_FULL`);主機拒絕(404 / 503)不重試。
  - `software/install`:依 `installer_type` 寫死命令列,`CreateProcessW` + Job Object(`KILL_ON_JOB_CLOSE`),逾時結束行程樹;結束代碼 1618 重試 3 次(計入整體逾時);安裝程式的 `TEMP` / `TMP` 指到 `staging\{commandId}\tmp`。
  - `software/uninstall`:只讀 HKLM 項目;MSI 以產品代碼 `msiexec /x`;其餘用 `QuietUninstallString`,否則 `UninstallString` + 目錄 `uninstall_args`;不經 `cmd`、不展開 `%`、拒絕殼層 / 腳本主機;內建不可移除清單(H2)與移除程式 ACL 檢查(H1)。
  - `software/detect`:登錄檔 `DisplayName LIKE`(只有 `%` 為萬用字元)/ MSI 產品代碼;安裝後與移除後輪詢 120 秒(間隔 3 秒)。
  - `software/power`:**A6** 電池(`GetSystemPowerStatus`)與計量網路(`INetworkCostManager`:Variable、漫遊、接近 / 超過資料上限)延後**下載**;每 5 分鐘重查,上限 4 小時且不超過指令剩餘有效時間 → `DEFERRED_TIMEOUT`;`ignore_power` 只略過電池;在取得串行鎖之前延後;偵測失敗不延後;`RUSTIT_TEST_POWER=battery|metered` 供 VM 驗收模擬(只能更嚴)。
  - `software/mod`:`Env` trait 注入的執行器——staging 複本在目的地再驗 SHA-256 與 Authenticode,簽章者檢查(見下 C2)、`signer_subject` 過濾控制字元、`log_tail` 只讀最後 64 KB 並遮罩、過期 staging / 記錄清除(`purge_stale`)。
  - `command.rs`:新增兩個類型、串行鎖(取得後重驗有效期限)、失敗時 result 摘要;running 進度只回報百分比(主機不存 running 的 result)。
  - collector `registry::machine_uninstall_entries`(只讀 HKLM,略過更新套件 `ParentKeyName`);common `authenticode::signer_details`(簽章者指紋 + 主體名稱);common `scm::owner_is_admin`(目錄擁有者必須是 SYSTEM / Administrators)、`scm::admin_only_writable`(檔案與上層目錄只能由 SYSTEM / Administrators / TrustedInstaller 寫入)。
- 審查與稽核修正(code-reviewer、security-auditor,細節與編號見設計 §8.1.2):
  - code-reviewer:`command_id` 必須是 UUID(組 staging / 記錄路徑並 `remove_dir_all`;C1);`split_command` 改 ASCII 小寫(Unicode 小寫改變長度會 panic);安裝子行程等待改用剩餘逾時;staging 複製與登錄檔查詢移到阻塞執行緒;改名前中斷的完整 `.part` 直接採用;`free_bytes` 失敗歸 `DOWNLOAD_FAILED`;MSI 移除只附加 msi 類型的屬性參數。
  - 資安稽核:M1 快取 / staging / 記錄目錄擁有者檢查;M2 安裝程式 TEMP 隔離;L6 `signer_subject` 去控制字元、最多 200 字;L7 staging 安裝檔驗證前以只允許讀取的共用模式開啟並持有到安裝程式結束。
  - 需求方 2026-10-22 決定:**C2** draft 套件(主機簽章者清單為空)的簽章者也必須在本機 `[software] trusted_signers` 內,本機清單空白不接受任何套件;**H1** 移除程式在 Program Files / Windows / `ProgramData\Package Cache` 以外時,做 ACL 檢查且路徑不可含 `..`;**H2** 內建不可移除清單(GigaNexus / RustIt 本身、常見防毒 / EDR),符合回 `UNINSTALL_NOT_SUPPORTED`。
  - 未修:L2(`ACTION=` 與重開機類開關)、L3(MSI 逾時後安裝仍在 msiserver 進行);M3 已完成(`b9242d6`,見下一條)。
- M3(`b9242d6`,P7-3 同分支):`agent.toml` 新增 `[software] trusted_signers`(格式同 `[upgrade]`,共用 `signer_list` 檢查),沒有設定 = 不接受任何派送的套件;軟體派送改用這份清單,升級與替換 Watchdog 仍用 `[upgrade]`;`RustAgent/installer/build-agent-msi.ps1` 新增 `-SoftwareSigners`。檔案:`common/src/config.rs`、`agent/src/{command,lib}.rs`、`installer/build-agent-msi.ps1`。
- 檔案:`RustAgent/crates/agent/src/software/{mod,args,download,install,uninstall,detect,power,tests}.rs`、`agent/src/{command,lib}.rs`、`agent/Cargo.toml`(版本 0.9.0;`windows` 0.62 COM 介面、`windows-sys` 加 `Win32_System_Power`)、`RustAgent/Cargo.lock`、`collector/src/{lib,registry}.rs`、`common/src/{authenticode,scm}.rs`;文件 `docs/P7-SOFTWARE-DESIGN.md`、`docs/contracts/command-kinds.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`、本檔。
- 驗證:`cargo test -p rustit-agent` 116/116。`cargo test -p rustit-common` 單獨執行會因 `log::set_boxed_logger` 編譯失敗(既有問題,與本次修改無關);與 Agent 一起編譯(`cargo test -p rustit-agent`)正常。VM 驗收(設計 §8.3)尚未做。
