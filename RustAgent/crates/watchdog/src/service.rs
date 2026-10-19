//! Windows 服務 `GigaNexusWatchdog`(指南 §7.1;P5-MONITOR-DESIGN §6.1):LocalSystem、自動啟動,由監控 MSI 安裝(與 Agent 同一個 MSI)。
//!
//! - `rustit-watchdog service [--config <檔>]`:由 SCM 啟動;日誌寫 `%ProgramData%\GigaNexus\Agent\logs\watchdog-YYYY-MM-DD.log`
//! - 每次啟動自行套用失敗復原(10 / 30 / 60 秒)與服務 ACL(一般使用者只能查詢),與 Agent 相同(`rustit_common::scm`)
//! - 沒有開發用 install / uninstall:Watchdog 要看守已安裝的 Agent 服務,一律以 MSI 安裝測試;開發時用 `run` 前景執行

use log::{LevelFilter, error, info, warn};
use rustit_common::config::{AgentConfig, Settings};
use rustit_common::logging::FileLogger;
use rustit_common::stop::{RUNTIME_SHUTDOWN, SHUTDOWN_GRACE, STOP_GRACE, StopSignal};
use rustit_common::{paths, scm};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::watch;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{
    self, ServiceControlHandlerResult, ServiceStatusHandle,
};
use windows_service::{define_windows_service, service_dispatcher};

pub const SERVICE_NAME: &str = scm::WATCHDOG_SERVICE;
const LOG_PREFIX: &str = "watchdog";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;
const EXIT_CONFIG: u32 = 2;
const EXIT_RUNTIME: u32 = 1;
const STOP_WAIT_HINT: Duration =
    Duration::from_secs(STOP_GRACE.as_secs() + RUNTIME_SHUTDOWN.as_secs() + 15);
const START_WAIT_HINT: Duration = Duration::from_secs(10);

define_windows_service!(ffi_service_main, service_main);

static CONFIG: OnceLock<PathBuf> = OnceLock::new();

pub fn dispatch(config: PathBuf) -> Result<(), String> {
    let _ = CONFIG.set(config);
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .map_err(|e| format!("無法連到服務控制管理員(只能由 SCM 啟動,開發測試請用 run):{e}"))
}

fn service_main(_args: Vec<OsString>) {
    if let Err(e) = FileLogger::install(paths::logs_dir(), LOG_PREFIX, LevelFilter::Info) {
        eprintln!("{e}");
    }
    std::panic::set_hook(Box::new(|p| error!("程式異常:{p}")));
    let config = CONFIG.get().cloned().unwrap_or_else(paths::default_config);
    if let Err(e) = run_service(&config) {
        error!("{e}");
    }
    log::logger().flush();
}

fn run_service(config: &Path) -> Result<(), String> {
    let (stop, rx) = StopSignal::new();
    let signal = stop.clone();
    let handler = move |control| match control {
        ServiceControl::Stop => {
            signal.stop(STOP_GRACE);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Shutdown => {
            signal.stop(SHUTDOWN_GRACE);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let status = service_control_handler::register(SERVICE_NAME, handler)
        .map_err(|e| format!("無法註冊服務控制處理常式:{e}"))?;
    set_state(
        status,
        ServiceState::StartPending,
        ServiceExitCode::Win32(0),
        START_WAIT_HINT,
    )?;
    if let Err(e) = scm::ensure_recovery(SERVICE_NAME) {
        warn!("無法套用失敗復原設定:{e}");
    }
    if let Err(e) = scm::apply_service_acl(SERVICE_NAME) {
        warn!("{e}");
    }
    let exit = match AgentConfig::load(config) {
        Err(e) => {
            error!("{e}");
            ServiceExitCode::ServiceSpecific(EXIT_CONFIG)
        }
        Ok(settings) => {
            log::set_max_level(settings.log_level.unwrap_or(LevelFilter::Info));
            info!("服務啟動,設定檔 {}", config.display());
            crate::SERVICE_MODE.store(true, std::sync::atomic::Ordering::Relaxed);
            match run_watchdog(settings, stop, rx, status) {
                Ok(()) => ServiceExitCode::Win32(0),
                Err(e) => {
                    error!("{e}");
                    ServiceExitCode::ServiceSpecific(EXIT_RUNTIME)
                }
            }
        }
    };
    info!("服務停止");
    set_state(status, ServiceState::Stopped, exit, Duration::ZERO)
}

fn run_watchdog(
    settings: Settings,
    stop: StopSignal,
    rx: watch::Receiver<bool>,
    status: ServiceStatusHandle,
) -> Result<(), String> {
    let mut stopping = rx.clone();
    let report = async move {
        if let Err(e) = set_state(
            status,
            ServiceState::Running,
            ServiceExitCode::Win32(0),
            Duration::ZERO,
        ) {
            error!("{e}");
        }
        if stopping.wait_for(|s| *s).await.is_ok() {
            info!("收到停止要求,收尾中");
            if let Err(e) = set_state(
                status,
                ServiceState::StopPending,
                ServiceExitCode::Win32(0),
                STOP_WAIT_HINT,
            ) {
                warn!("{e}");
            }
        }
    };
    crate::run_blocking(settings, stop, rx, report)
}

fn set_state(
    status: ServiceStatusHandle,
    state: ServiceState,
    exit_code: ServiceExitCode,
    wait_hint: Duration,
) -> Result<(), String> {
    let controls_accepted = if state == ServiceState::Running {
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
    } else {
        ServiceControlAccept::empty()
    };
    status
        .set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: state,
            controls_accepted,
            exit_code,
            checkpoint: 0,
            wait_hint,
            process_id: None,
        })
        .map_err(|e| format!("無法回報服務狀態:{e}"))
}
