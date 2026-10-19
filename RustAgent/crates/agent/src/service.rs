//! Windows 服務(PLATFORM-PLAN §4.1、指南 §6.1):`GigaNexusAgent`,LocalSystem,自動啟動。
//!
//! - `rustit-agent service [--config <檔>]`:由 SCM 啟動;日誌寫 `%ProgramData%\GigaNexus\Agent\logs\`。
//! - `install` / `uninstall`:**只給開發測試**(需系統管理員);正式一律由 MSI 安裝,設定相同。
//!   開發安裝建立的 `%ProgramData%\GigaNexus\Agent` 沿用 ProgramData 預設 ACL;只允許 SYSTEM、Administrators 的 ACL 由 MSI 設定。
//!
//! 失敗復原:第 1、2、後續失敗分別 10 / 30 / 60 秒後重新啟動,1 天後重設計數;設定錯誤等「非當機」的失敗也套用。
//! 停止:一般停止收尾 [`crate::STOP_GRACE`],Windows 關機只給 [`crate::SHUTDOWN_GRACE`](系統給服務的時間很短)。
//! 指令 `agent.restart`(P4):收尾後以 [`EXIT_RESTART`] 停止,由失敗復原重新啟動(1 天內第 2、3 次分別 30、60 秒後)。

use log::{LevelFilter, error, info, warn};
use rustit_common::config::{AgentConfig, Settings};
use rustit_common::logging::FileLogger;
use rustit_common::paths;
use rustit_common::stop::{RUNTIME_SHUTDOWN, SHUTDOWN_GRACE, STOP_GRACE, StopSignal};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use windows_service::service::{
    Service, ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
    ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{
    self, ServiceControlHandlerResult, ServiceStatusHandle,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

/// Windows 服務名稱(指南 §6.1)
pub const SERVICE_NAME: &str = "GigaNexusAgent";
const DISPLAY_NAME: &str = "GigaNexus Agent";
/// 檔案日誌檔名前綴:`agent-YYYY-MM-DD.log`
const LOG_PREFIX: &str = "agent";
const DESCRIPTION: &str = "GigaNexus 端點 Agent:蒐集本機資產並經 Gateway 回報 IT 管理系統(RustIt)";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;
/// 設定檔錯誤(服務專屬結束代碼,SCM 依失敗復原設定重試)
const EXIT_CONFIG: u32 = 2;
const EXIT_RUNTIME: u32 = 1;
/// 依指令 agent.restart 停止(非錯誤;SCM 依失敗復原重新啟動)
const EXIT_RESTART: u32 = 3;
/// 回報「停止中」時給 SCM 的等待提示:收尾 + 關閉執行環境 + 餘裕
const STOP_WAIT_HINT: Duration =
    Duration::from_secs(STOP_GRACE.as_secs() + RUNTIME_SHUTDOWN.as_secs() + 15);
const START_WAIT_HINT: Duration = Duration::from_secs(10);

/// Win32 錯誤碼
const ERROR_SERVICE_CANNOT_ACCEPT_CTRL: i32 = 1061;
const ERROR_SERVICE_NOT_ACTIVE: i32 = 1062;
const ERROR_SERVICE_EXISTS: i32 = 1073;

define_windows_service!(ffi_service_main, service_main);

/// 服務模式使用的設定檔:SCM 傳給 service_main 的參數只有服務名稱與 StartService 參數,
/// 安裝時寫入的 `service --config <檔>` 在行程參數裡,由 main 解析後設定
static CONFIG: OnceLock<PathBuf> = OnceLock::new();

/// 交給 SCM;阻塞到服務停止。從主控台直接執行會失敗(不是由 SCM 啟動)
pub fn dispatch(config: PathBuf) -> Result<(), String> {
    let _ = CONFIG.set(config);
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .map_err(|e| format!("無法連到服務控制管理員(只能由 SCM 啟動,開發測試請用 run):{e}"))
}

fn service_main(_args: Vec<OsString>) {
    if let Err(e) = FileLogger::install(paths::logs_dir(), LOG_PREFIX, LevelFilter::Info) {
        // 沒有日誌可寫時仍照常執行;SCM 事件記錄會留下服務狀態
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
            // 結束原因記為 shutdown(agent_started.previous_exit,P5)
            crate::SHUTDOWN_REQUESTED.store(true, std::sync::atomic::Ordering::Relaxed);
            signal.stop(SHUTDOWN_GRACE);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let status = service_control_handler::register(SERVICE_NAME, handler)
        .map_err(|e| format!("無法註冊服務控制處理常式:{e}"))?;
    // 先報「啟動中」,設定載入成功、執行環境建立後才報「執行中」:設定錯誤時啟動就會失敗
    set_state(
        status,
        ServiceState::StartPending,
        ServiceExitCode::Win32(0),
        START_WAIT_HINT,
    )?;
    // 每次啟動都套用失敗復原:MSI 的 MsiServiceConfig 表 SDK 標示不可靠(WIX1149),由服務自己設定;
    // 被手動改掉的設定也會在下次啟動恢復(PLATFORM-PLAN §4.1、§4.10 A5)
    if let Err(e) = ensure_recovery() {
        warn!("無法套用失敗復原設定:{}", describe(&e));
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
            match run_agent(settings, stop, rx, status) {
                Ok(()) if crate::RESTART_REQUESTED.load(std::sync::atomic::Ordering::Relaxed) => {
                    info!("依指令重新啟動:以結束代碼 {EXIT_RESTART} 停止,由服務失敗復原重新啟動");
                    ServiceExitCode::ServiceSpecific(EXIT_RESTART)
                }
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

fn run_agent(
    settings: Settings,
    stop: StopSignal,
    rx: watch::Receiver<bool>,
    status: ServiceStatusHandle,
) -> Result<(), String> {
    let mut stopping = rx.clone();
    let report = async move {
        // 在執行環境內:Agent 已開始執行
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

/// windows-service 的錯誤訊息不含底層 Win32 錯誤,補上(例:存取被拒 os error 5)
fn describe(e: &windows_service::Error) -> String {
    match e {
        windows_service::Error::Winapi(io) => format!("{e}:{io}"),
        _ => e.to_string(),
    }
}

fn win32_code(e: &windows_service::Error) -> Option<i32> {
    match e {
        windows_service::Error::Winapi(io) => io.raw_os_error(),
        _ => None,
    }
}

/// 開發測試用安裝(需系統管理員)。`config` 為 None 時服務讀 `%ProgramData%\GigaNexus\Agent\agent.toml`
pub fn install(config: Option<&Path>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("無法取得執行檔路徑:{e}"))?;
    let mut launch_arguments = vec![OsString::from("service")];
    if let Some(c) = config {
        if !c.is_file() {
            return Err(format!("找不到設定檔 {}", c.display()));
        }
        let c = std::path::absolute(c)
            .map_err(|e| format!("無法取得設定檔完整路徑 {}:{e}", c.display()))?;
        launch_arguments.push("--config".into());
        launch_arguments.push(c.into_os_string());
    }
    std::fs::create_dir_all(paths::logs_dir())
        .map_err(|e| format!("無法建立 {}:{e}", paths::logs_dir().display()))?;

    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|e| format!("無法連到服務控制管理員(需以系統管理員執行):{e}"))?;
    let info = ServiceInfo {
        name: SERVICE_NAME.into(),
        display_name: DISPLAY_NAME.into(),
        service_type: SERVICE_TYPE,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe,
        launch_arguments,
        dependencies: vec![],
        account_name: None, // LocalSystem(需使用電腦憑證私鑰,指南 §6.1)
        account_password: None,
    };
    let service = manager
        .create_service(
            &info,
            ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::DELETE,
        )
        .map_err(|e| match win32_code(&e) {
            Some(ERROR_SERVICE_EXISTS) => format!("服務 {SERVICE_NAME} 已安裝,請先執行 uninstall"),
            _ => format!("無法建立服務 {SERVICE_NAME}:{e}"),
        })?;
    if let Err(e) = service.set_description(DESCRIPTION) {
        eprintln!("警告:無法設定服務說明:{e}");
    }
    // 失敗復原是指南 §6.1 的要求:設定失敗就移除剛建立的服務,不留下半成品
    if let Err(e) = configure_recovery(&service) {
        let _ = service.delete();
        return Err(format!(
            "無法設定失敗復原,已移除剛建立的服務:{}",
            describe(&e)
        ));
    }
    service.start::<&OsStr>(&[]).map_err(|e| {
        format!(
            "服務已建立但無法啟動(日誌:{}):{e}",
            paths::logs_dir().display()
        )
    })?;
    Ok(())
}

fn configure_recovery(service: &Service) -> Result<(), windows_service::Error> {
    let restart = |secs| ServiceAction {
        action_type: ServiceActionType::Restart,
        delay: Duration::from_secs(secs),
    };
    service.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(24 * 3600)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![restart(10), restart(30), restart(60)]),
    })?;
    service.set_failure_actions_on_non_crash_failures(true)
}

/// 服務啟動時對自己套用失敗復原(LocalSystem 可修改自己的服務設定)
fn ensure_recovery() -> Result<(), windows_service::Error> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    // 失敗復原含「重新啟動」動作時,除了 CHANGE_CONFIG 還需要 START 權限(ChangeServiceConfig2 SERVICE_CONFIG_FAILURE_ACTIONS)
    let service = manager.open_service(
        SERVICE_NAME,
        ServiceAccess::CHANGE_CONFIG | ServiceAccess::START,
    )?;
    configure_recovery(&service)
}

/// 開發測試用移除:先停止(等到停止為止,上限為停止等待提示 + 10 秒)再刪除
pub fn uninstall() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("無法連到服務控制管理員(需以系統管理員執行):{e}"))?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
        )
        .map_err(|e| format!("無法開啟服務 {SERVICE_NAME}(是否未安裝?):{e}"))?;
    let query = || {
        service
            .query_status()
            .map(|s| s.current_state)
            .map_err(|e| format!("無法查詢服務狀態:{e}"))
    };
    if query()? != ServiceState::Stopped {
        // 剛好已停止或正在停止中:不算錯誤,繼續等到停止
        if let Err(e) = service.stop()
            && !matches!(
                win32_code(&e),
                Some(ERROR_SERVICE_NOT_ACTIVE | ERROR_SERVICE_CANNOT_ACCEPT_CTRL)
            )
        {
            return Err(format!("無法停止服務:{e}"));
        }
        let deadline = Instant::now() + STOP_WAIT_HINT + Duration::from_secs(10);
        while query()? != ServiceState::Stopped {
            if Instant::now() > deadline {
                return Err("等待服務停止逾時".into());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    service.delete().map_err(|e| format!("無法刪除服務:{e}"))
}
