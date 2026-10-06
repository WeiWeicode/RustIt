//! `rustit-agent run [--config <agent.toml>]`:前景執行(Windows 服務化屬後續)。只組裝:參數、日誌、Ctrl+C;邏輯在 lib。
//! 日誌等級以環境變數 RUST_LOG 調整(預設 info);日誌不含憑證私鑰、Token 與完整軟體清單(AGENT.md §7.1)。

use log::{error, info};
use rustit_agent::config::AgentConfig;
use std::path::PathBuf;
use std::process::ExitCode;
use tokio::sync::watch;

const USAGE: &str = "用法:rustit-agent run [--config <agent.toml>]";

fn parse_args(args: &[String]) -> Result<PathBuf, String> {
    match args {
        [cmd] if cmd == "run" => Ok(PathBuf::from("agent.toml")),
        [cmd, flag, path] if cmd == "run" && flag == "--config" => Ok(PathBuf::from(path)),
        _ => Err(USAGE.to_string()),
    }
}

fn main() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = match parse_args(&args) {
        Ok(p) => p,
        Err(usage) => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    let settings = match AgentConfig::load(&path) {
        Ok(s) => s,
        Err(e) => {
            error!("{e}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            error!("無法建立非同步執行環境:{e}");
            return ExitCode::FAILURE;
        }
    };
    let result = runtime.block_on(async {
        let (tx, rx) = watch::channel(false);
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                info!("收到中斷訊號,結束中");
                let _ = tx.send(true);
            }
        });
        rustit_agent::run(settings, rx).await
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("{e}");
            ExitCode::FAILURE
        }
    }
}
