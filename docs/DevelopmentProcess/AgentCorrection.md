# Agent 修改紀錄(RustAgent)

新紀錄加在最上方;格式見 `AGENT.md` §10。本檔自 P7-2 起記錄 `RustAgent/` 的修改,先前的 Agent 變更記在 `NewFeatures.md` / `BugFix.md`。

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
  - 需求方 2026-10-22 決定:**C2** draft 套件(主機簽章者清單為空)的簽章者也必須在本機 `trusted_signers` 內,本機清單空白不接受任何套件;**H1** 移除程式在 Program Files / Windows / `ProgramData\Package Cache` 以外時,做 ACL 檢查且路徑不可含 `..`;**H2** 內建不可移除清單(GigaNexus / RustIt 本身、常見防毒 / EDR),符合回 `UNINSTALL_NOT_SUPPORTED`。
  - 未修:L2(`ACTION=` 與重開機類開關)、L3(MSI 逾時後安裝仍在 msiserver 進行);M3(分開 `[software] trusted_signers`)待 P7-3 與 MSI 0.9.0 一起做。
- 檔案:`RustAgent/crates/agent/src/software/{mod,args,download,install,uninstall,detect,power,tests}.rs`、`agent/src/{command,lib}.rs`、`agent/Cargo.toml`(版本 0.9.0;`windows` 0.62 COM 介面、`windows-sys` 加 `Win32_System_Power`)、`RustAgent/Cargo.lock`、`collector/src/{lib,registry}.rs`、`common/src/{authenticode,scm}.rs`;文件 `docs/P7-SOFTWARE-DESIGN.md`、`docs/contracts/command-kinds.md`、`docs/HANDOFF.md`、`docs/PROJECT-MAP.md`、本檔。
- 驗證:`cargo test -p rustit-agent` 116/116。`cargo test -p rustit-common` 單獨執行會因 `log::set_boxed_logger` 編譯失敗(既有問題,與本次修改無關);與 Agent 一起編譯(`cargo test -p rustit-agent`)正常。VM 驗收(設計 §8.3)尚未做。
