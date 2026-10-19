//! `rustit-watchdog`:只組裝(參數、日誌、結束訊號);邏輯在 lib。
//!
//! - `run [--config <檔>]`:前景執行(開發用;看守本機已安裝的 GigaNexusAgent 服務,沒有權限時只記錄);日誌到主控台
//! - `service [--config <檔>]`:由 Windows SCM 啟動(MSI 安裝的 GigaNexusWatchdog)

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "用法:rustit-watchdog run [--config <agent.toml>]\n      rustit-watchdog service [--config <agent.toml>]    (由 Windows 服務控制管理員啟動)";

#[derive(Debug, PartialEq)]
enum Command {
    Run(PathBuf),
    Service(PathBuf),
}

fn parse_args(args: &[String]) -> Result<Command, String> {
    let config = |rest: &[String]| -> Result<Option<PathBuf>, String> {
        match rest {
            [] => Ok(None),
            [flag, path] if flag == "--config" => Ok(Some(PathBuf::from(path))),
            _ => Err(USAGE.to_string()),
        }
    };
    match args {
        [cmd, rest @ ..] if cmd == "run" => Ok(Command::Run(
            config(rest)?.unwrap_or_else(|| PathBuf::from("agent.toml")),
        )),
        [cmd, rest @ ..] if cmd == "service" => Ok(Command::Service(
            config(rest)?.unwrap_or_else(rustit_common::paths::default_config),
        )),
        _ => Err(USAGE.to_string()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args) {
        Ok(Command::Run(path)) => run_foreground(path),
        Ok(Command::Service(path)) => service(path),
        Err(usage) => {
            eprintln!("{usage}");
            ExitCode::from(2)
        }
    }
}

#[cfg(windows)]
fn run_foreground(path: PathBuf) -> ExitCode {
    use log::{error, info, warn};
    use rustit_common::config::AgentConfig;
    use rustit_common::stop::{STOP_GRACE, StopSignal};
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let settings = match AgentConfig::load(&path) {
        Ok(s) => s,
        Err(e) => {
            error!("{e}");
            return ExitCode::from(2);
        }
    };
    let (stop, rx) = StopSignal::new();
    let signal = stop.clone();
    let ctrl_c = async move {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {
                info!("收到中斷訊號,結束中");
                stop.stop(STOP_GRACE);
            }
            Err(e) => {
                warn!("無法監聽中斷訊號:{e}");
                let _keep = stop;
                std::future::pending::<()>().await;
            }
        }
    };
    match rustit_watchdog::run_blocking(settings, signal, rx, ctrl_c) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn service(path: PathBuf) -> ExitCode {
    match rustit_watchdog::service::dispatch(path) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(windows))]
fn run_foreground(_: PathBuf) -> ExitCode {
    eprintln!("Watchdog 只支援 Windows");
    ExitCode::FAILURE
}

#[cfg(not(windows))]
fn service(_: PathBuf) -> ExitCode {
    eprintln!("Watchdog 只支援 Windows");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: &[&str]) -> Result<Command, String> {
        parse_args(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_commands() {
        assert_eq!(
            parse(&["run"]).unwrap(),
            Command::Run(PathBuf::from("agent.toml"))
        );
        assert_eq!(
            parse(&["service", "--config", "a.toml"]).unwrap(),
            Command::Service(PathBuf::from("a.toml"))
        );
        for bad in [&[][..], &["install"], &["run", "--config"]] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }
}
