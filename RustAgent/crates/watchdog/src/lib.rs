//! GigaNexus 端點 Watchdog(RustIt PLATFORM-PLAN P5 §4.10 A5;規範 Gateway ENDPOINT-AGENT-GUIDE §7;設計 P5-MONITOR-DESIGN §6)。
//!
//! 兩個工作:
//! - 看守([`monitor`]):每 30 秒查 `GigaNexusAgent` 服務與本機管道 `get_status`,處理當掉、卡住、被停止、改啟動類型、程式不見;
//!   事件先寫本機 `state\watchdog.db`([`outbox`])
//! - 上報([`report`]):每 5 分鐘(主機可調)及有新事件時 `POST /agent/v1/watchdog/report`,**自己**經 `:9443` 送,不經過 Agent
//!
//! 與 Agent 共用 `agent.toml`、裝置憑證與 `rustit-common`;不依賴 `rustit-agent`。失敗只記錄並重試,不影響使用者電腦(AGENT.md §5)。
#![cfg(windows)]

pub mod monitor;
pub mod outbox;
pub mod report;
pub mod service;

use crate::monitor::{AgentControl, AgentStatus, Monitor};
use crate::outbox::Outbox;
use crate::report::Snapshot;
use log::{info, warn};
use rustit_common::config::Settings;
use rustit_common::envelope::Envelope;
use rustit_common::pipe::PipeError;
use rustit_common::scm::{self, AGENT_SERVICE, SvcInfo, SvcState};
use rustit_common::stop::{RUNTIME_SHUTDOWN, StopSignal, wait, with_grace};
use serde_json::json;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, watch};

pub const WATCHDOG_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 看守間隔(指南 §7.1)
pub const TICK: Duration = Duration::from_secs(30);
/// 停止 Agent 等多久才結束行程(大於 Agent 的停止收尾:STOP_GRACE 30 + 執行環境 5 + 餘裕)
const STOP_TIMEOUT: Duration = Duration::from_secs(50);
/// 以 Windows 服務執行(service.rs 設定):才檢查 Agent 程式路徑、套用 state\ 目錄 ACL
pub static SERVICE_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const PIPE_TIMEOUT: Duration = Duration::from_secs(5);

pub fn user_agent() -> String {
    format!("giganexus-watchdog/{WATCHDOG_VERSION}")
}

/// 兩個工作共用
pub(crate) struct Shared {
    pub outbox: Mutex<Outbox>,
    pub snapshot: Mutex<Snapshot>,
    /// 有新事件或狀態改變:上報工作立即送
    pub changed: Notify,
    pub settings: Settings,
}

/// 正式的 Agent 服務操作(SCM)
struct Scm;

impl AgentControl for Scm {
    fn start(&self) -> Result<(), String> {
        scm::start(AGENT_SERVICE)
    }
    fn stop_or_kill(&self, pid: Option<u32>) -> Result<(), String> {
        // 逾時才結束行程;結束前確認行程是服務設定的程式且 PID 沒變(common::scm)
        scm::stop_or_kill(AGENT_SERVICE, pid, STOP_TIMEOUT)
    }
    fn set_auto_start(&self) -> Result<(), String> {
        scm::set_auto_start(AGENT_SERVICE)
    }
    fn exe_exists(&self, path: &Path) -> bool {
        path.is_file()
    }
    fn shutting_down(&self) -> bool {
        scm::hands_off()
    }
}

/// 本機管道 get_status;伺服端 PID 必須是 SCM 的 Agent PID(指南 §7.2 防冒充,不符時不送出請求)
async fn probe(expected_pid: u32) -> Result<AgentStatus, PipeError> {
    let reply = rustit_common::pipe::request(
        &Envelope::new("get_status", json!({})),
        expected_pid,
        PIPE_TIMEOUT,
    )
    .await?;
    if reply.kind != "status" {
        return Err(PipeError::Other(format!("本機管道回應類型 {}", reply.kind)));
    }
    serde_json::from_value(reply.body.unwrap_or_default())
        .map_err(|e| PipeError::Other(format!("本機管道回應格式錯誤:{e}")))
}

/// 開啟本機紀錄;檔案損壞時改名保留後重建(看守不因此停擺)
fn open_outbox(dir: &Path) -> Result<Outbox, String> {
    match Outbox::open(dir) {
        Ok(o) => Ok(o),
        Err(e) => {
            let broken = dir.join(format!(
                "watchdog.db.broken-{}",
                chrono::Utc::now().format("%Y%m%d%H%M%S")
            ));
            warn!("{e};改名為 {} 後重建", broken.display());
            let _ = std::fs::rename(dir.join("watchdog.db"), &broken);
            Outbox::open(dir)
        }
    }
}

/// 建立執行環境並執行到結束(前景與服務模式共用);`side_task` 在同一個執行環境背景執行
pub fn run_blocking<F>(
    settings: Settings,
    stop: StopSignal,
    shutdown: watch::Receiver<bool>,
    side_task: F,
) -> Result<(), String>
where
    F: Future<Output = ()> + Send + 'static,
{
    let runtime =
        tokio::runtime::Runtime::new().map_err(|e| format!("無法建立非同步執行環境:{e}"))?;
    let result = runtime.block_on(async move {
        tokio::spawn(side_task);
        let grace_of = stop.clone();
        with_grace(run(settings, shutdown.clone()), shutdown, move || {
            grace_of.grace()
        })
        .await
    });
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN);
    result
}

pub async fn run(settings: Settings, shutdown: watch::Receiver<bool>) -> Result<(), String> {
    let service_mode = SERVICE_MODE.load(std::sync::atomic::Ordering::Relaxed);
    if service_mode {
        // 開發安裝沿用 ProgramData 預設 ACL 時,一般使用者不能預先放 watchdog.db 讓 Watchdog 以裝置憑證送出(資安稽核 L5)
        std::fs::create_dir_all(&settings.state_dir)
            .map_err(|e| format!("無法建立 {}:{e}", settings.state_dir.display()))?;
        if let Err(e) = scm::protect_dir(&settings.state_dir) {
            warn!("{e}");
        }
    }
    let outbox = open_outbox(&settings.state_dir)?;
    info!(
        "Watchdog {WATCHDOG_VERSION} 啟動:看守 {AGENT_SERVICE},Server {},本機待送事件 {} 筆",
        settings.server,
        outbox.count().unwrap_or(0)
    );
    let shared = Arc::new(Shared {
        outbox: Mutex::new(outbox),
        snapshot: Mutex::new(Snapshot::default()),
        changed: Notify::new(),
        settings,
    });
    let expected_exe = if service_mode {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("rustit-agent.exe")))
    } else {
        None
    };
    let watcher = tokio::spawn(watch_agent(shared.clone(), expected_exe, shutdown.clone()));
    let reporter = tokio::spawn(report::run(shared.clone(), shutdown));
    let (a, b) = tokio::join!(watcher, reporter);
    a.and(b).map_err(|e| format!("背景工作異常結束:{e}"))
}

async fn watch_agent(
    shared: Arc<Shared>,
    expected_exe: Option<std::path::PathBuf>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut monitor = Monitor::new();
    monitor.expected_exe = expected_exe;
    // 已記過冒充的管道伺服端 PID(同一個只記一次)
    let mut impersonation_reported: Option<u32> = None;
    loop {
        let info = match tokio::task::spawn_blocking(|| scm::query(AGENT_SERVICE)).await {
            Ok(Ok(i)) => i,
            Ok(Err(e)) => {
                warn!("無法查詢 Agent 服務:{e}");
                SvcInfo {
                    state: SvcState::Unknown,
                    ..SvcInfo::missing()
                }
            }
            Err(e) => {
                warn!("查詢 Agent 服務失敗:{e}");
                SvcInfo {
                    state: SvcState::Unknown,
                    ..SvcInfo::missing()
                }
            }
        };
        let mut extra = Vec::new();
        let probe_result = match (info.state, info.pid) {
            (SvcState::Running, Some(pid)) => Some(match probe(pid).await {
                Ok(s) => Ok(s),
                Err(e) => {
                    if let PipeError::Impersonation {
                        server_pid,
                        expected_pid,
                    } = e
                        && impersonation_reported != Some(server_pid)
                    {
                        impersonation_reported = Some(server_pid);
                        warn!("{e}");
                        extra.push(monitor::Event {
                            kind: "agent_pipe_impersonation",
                            data: json!({ "server_pid": server_pid, "agent_pid": expected_pid }),
                        });
                    }
                    Err(e.to_string())
                }
            }),
            _ => None,
        };
        let now = Instant::now();
        // SCM 操作(啟動 / 停止最多 30 秒)放到阻塞執行緒,不卡住上報工作
        let (events, monitor_back) = {
            let info2 = info.clone();
            match tokio::task::spawn_blocking(move || {
                let events = monitor.tick(&Scm, &info2, probe_result, now);
                (events, monitor)
            })
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    warn!("看守工作異常:{e};看守狀態已重置");
                    let mut m = Monitor::new();
                    m.expected_exe = std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.join("rustit-agent.exe")))
                        .filter(|_| SERVICE_MODE.load(std::sync::atomic::Ordering::Relaxed));
                    (Vec::new(), m)
                }
            }
        };
        monitor = monitor_back;
        let events: Vec<monitor::Event> = extra.into_iter().chain(events).collect();
        let restarts = monitor.restarts_24h(now);
        let state_changed = {
            let mut snap = shared.snapshot.lock().unwrap_or_else(|p| p.into_inner());
            snap.update(&info, &monitor, restarts)
        };
        if !events.is_empty() {
            let outbox = shared.outbox.lock().unwrap_or_else(|p| p.into_inner());
            for e in &events {
                match outbox.push(e.kind, &now_rfc3339(), &e.data) {
                    Ok(0) => {}
                    Ok(n) => warn!("本機事件已滿,丟棄最舊的 {n} 筆"),
                    Err(e) => warn!("{e}"),
                }
            }
        }
        if !events.is_empty() || state_changed {
            shared.changed.notify_one();
        }
        if wait(TICK, &mut shutdown).await {
            return;
        }
    }
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
