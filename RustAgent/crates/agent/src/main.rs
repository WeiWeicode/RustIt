//! `rustit-agent`:只組裝(參數、日誌、結束訊號);邏輯在 lib。
//!
//! - `run [--config <檔>]`:前景執行(開發用);日誌到主控台,等級以 RUST_LOG 調整(預設 info)
//! - `service [--config <檔>]`:由 Windows SCM 啟動;日誌寫 `%ProgramData%\GigaNexus\Agent\logs\`(PLATFORM-PLAN §4.1)
//! - `install [--config <檔>]` / `uninstall`:開發測試用(需系統管理員),正式一律 MSI
//!
//! 日誌不含憑證私鑰、Token 與完整軟體清單(AGENT.md §7.1)。

use log::{error, info, warn};
use rustit_agent::config::AgentConfig;
use rustit_agent::{STOP_GRACE, StopSignal};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "用法:rustit-agent run [--config <agent.toml>]\n      rustit-agent service [--config <agent.toml>]    (由 Windows 服務控制管理員啟動)\n      rustit-agent install [--config <agent.toml>]    (開發測試用,需系統管理員)\n      rustit-agent uninstall";

#[derive(Debug, PartialEq)]
enum Command {
    /// 前景執行;未指定設定檔時用目前目錄的 agent.toml
    Run(PathBuf),
    /// 服務模式;未指定時用 `%ProgramData%\GigaNexus\Agent\agent.toml`
    Service(PathBuf),
    Install(Option<PathBuf>),
    Uninstall,
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
            config(rest)?.unwrap_or_else(rustit_agent::paths::default_config),
        )),
        [cmd, rest @ ..] if cmd == "install" => Ok(Command::Install(config(rest)?)),
        [cmd] if cmd == "uninstall" => Ok(Command::Uninstall),
        _ => Err(USAGE.to_string()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse_args(&args) {
        Ok(c) => c,
        Err(usage) => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    match command {
        Command::Run(path) => run_foreground(path),
        Command::Service(path) => service(path),
        Command::Install(path) => admin(|| install(path.as_deref()), "已安裝並啟動服務"),
        Command::Uninstall => admin(uninstall, "已停止並移除服務"),
    }
}

fn run_foreground(path: PathBuf) -> ExitCode {
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
                // 無法監聽 Ctrl+C 時繼續執行;保留訊號來源,不讓 Agent 誤以為要結束
                warn!("無法監聽中斷訊號:{e}");
                let _keep = stop;
                std::future::pending::<()>().await;
            }
        }
    };
    let result = rustit_agent::run_blocking(settings, signal, rx, ctrl_c);
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn admin(f: impl FnOnce() -> Result<(), String>, ok: &str) -> ExitCode {
    match f() {
        Ok(()) => {
            println!("{ok}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn service(path: PathBuf) -> ExitCode {
    match rustit_agent::service::dispatch(path) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn install(path: Option<&std::path::Path>) -> Result<(), String> {
    rustit_agent::service::install(path)
}

#[cfg(windows)]
fn uninstall() -> Result<(), String> {
    rustit_agent::service::uninstall()
}

#[cfg(not(windows))]
fn service(_: PathBuf) -> ExitCode {
    eprintln!("服務模式只支援 Windows");
    ExitCode::FAILURE
}

#[cfg(not(windows))]
fn install(_: Option<&std::path::Path>) -> Result<(), String> {
    Err("服務只支援 Windows".into())
}

#[cfg(not(windows))]
fn uninstall() -> Result<(), String> {
    Err("服務只支援 Windows".into())
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
            parse(&["run", "--config", "a.toml"]).unwrap(),
            Command::Run(PathBuf::from("a.toml"))
        );
        assert_eq!(
            parse(&["service"]).unwrap(),
            Command::Service(rustit_agent::paths::default_config())
        );
        assert_eq!(
            parse(&["service", "--config", r"D:\a\agent.toml"]).unwrap(),
            Command::Service(PathBuf::from(r"D:\a\agent.toml"))
        );
        assert_eq!(parse(&["install"]).unwrap(), Command::Install(None));
        assert_eq!(
            parse(&["install", "--config", "a.toml"]).unwrap(),
            Command::Install(Some(PathBuf::from("a.toml")))
        );
        assert_eq!(parse(&["uninstall"]).unwrap(), Command::Uninstall);
    }

    #[test]
    fn rejects_bad_arguments() {
        for bad in [
            &[][..],
            &["start"],
            &["run", "--config"],
            &["run", "-c", "a"],
            &["uninstall", "x"],
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }
}
