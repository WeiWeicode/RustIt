//! RustIt 端點服務共用函式庫(PLATFORM-PLAN §3.1):Agent 與 Watchdog 都以 SYSTEM 執行、用同一張裝置憑證經 `:9443` 連線,
//! 共用設定檔、憑證來源、連線與退避、WebSocket 信封、停止訊號、檔案日誌與路徑;P5-2 加服務控制([`scm`])與本機管道([`pipe`])。
//!
//! 只在 Rust 端內部共用;**不和 ItAgentBack 共用程式碼**,兩端只靠 `docs/contracts/` 溝通(AGENT.md §7.3)。

pub mod backoff;
pub mod config;
pub mod envelope;
pub mod logging;
pub mod paths;
#[cfg(windows)]
pub mod pipe;
#[cfg(windows)]
pub mod scm;
pub mod stop;
pub mod tls;
pub mod transport;
