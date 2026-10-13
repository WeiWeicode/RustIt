//! 端點電腦上的固定路徑(PLATFORM-PLAN §3.2、指南 §6.1)。
//!
//! `%ProgramData%\GigaNexus\Agent\`:`agent.toml`(安裝設定)、`logs\`;ACL 由 MSI 設定為只允許 SYSTEM、Administrators。

use std::path::PathBuf;

/// `%ProgramData%\GigaNexus\Agent`;環境變數不存在時用 Windows 預設位置
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    base.join("GigaNexus").join("Agent")
}

/// 服務模式預設的設定檔(Agent 與 Watchdog 共用同一份安裝設定)
pub fn default_config() -> PathBuf {
    data_dir().join("agent.toml")
}

/// 服務模式的日誌目錄
pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}
