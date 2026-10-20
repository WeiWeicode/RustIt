//! GigaNexus 端點 Watchdog(RustIt PLATFORM-PLAN P5 §4.10 A5;規範 Gateway ENDPOINT-AGENT-GUIDE §7;設計 P5-MONITOR-DESIGN §6)。
//!
//! 兩個工作:
//! - 看守([`monitor`]):每 30 秒查 `GigaNexusAgent` 服務與本機管道 `get_status`,處理當掉、卡住、被停止、改啟動類型、程式不見;
//!   事件先寫本機 `state\watchdog.db`([`outbox`])
//! - 上報([`report`]):每 5 分鐘(主機可調)及有新事件時 `POST /agent/v1/watchdog/report`,**自己**經 `:9443` 送,不經過 Agent
//!
//! - 升級([`upgrade`],P6-2):上報回應帶 `target.agent` 時下載、驗證、替換 Agent,失敗還原;進行中看守暫停(維護中)
//!
//! 與 Agent 共用 `agent.toml`、裝置憑證與 `rustit-common`;不依賴 `rustit-agent`。失敗只記錄並重試,不影響使用者電腦(AGENT.md §5)。
#![cfg(windows)]

pub mod monitor;
pub mod outbox;
pub mod report;
pub mod service;
pub mod upgrade;

use crate::monitor::{AgentControl, AgentStatus, Monitor};
use crate::outbox::Outbox;
use crate::report::Snapshot;
use crate::upgrade::{Outcome, Paths, UpgradeTarget, Upgrader};
use log::{info, warn};
use rustit_common::config::Settings;
use rustit_common::envelope::Envelope;
use rustit_common::pipe::PipeError;
use rustit_common::scm::{self, AGENT_SERVICE, SvcInfo, SvcState};
use rustit_common::stop::{RUNTIME_SHUTDOWN, StopSignal, wait, with_grace};
use serde_json::json;
use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, watch};

/// 版本(build.rs:RUSTIT_BUILD_VERSION 或 Cargo.toml;與 exe 版本資源相同)
pub const WATCHDOG_VERSION: &str = env!("RUSTIT_VERSION");
/// 看守間隔(指南 §7.1)
pub const TICK: Duration = Duration::from_secs(30);
/// 停止 Agent 等多久才結束行程(大於 Agent 的停止收尾:STOP_GRACE 30 + 執行環境 5 + 餘裕)
pub(crate) const STOP_TIMEOUT: Duration = Duration::from_secs(50);
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
    /// 升級中(維護中):看守暫停,不把升級造成的停止當成竄改(P6-UPGRADE-DESIGN §5.2 第 3 步)
    pub maintenance: AtomicBool,
    /// 上報回應最新的 Agent 目標版本(升級工作等待)
    pub target: watch::Sender<Option<UpgradeTarget>>,
    /// 升級工作正在執行(上報才帶未結束的進度)
    pub upgrade_active: AtomicBool,
}

/// 維護中最長多久(升級最多約 下載 + 90 + 50 + 120 + 還原 120 秒);超過就恢復看守並記錄(資安 L5)
const MAINTENANCE_LIMIT: Duration = Duration::from_secs(20 * 60);
/// 升級失敗後多久內不自動再試(任何版本;agent.upgrade 可解除)。主機輪流下發不同版本也不會反覆停止 Agent(審查必修 1、資安 M1)
const UPGRADE_COOLDOWN: Duration = Duration::from_secs(30 * 60);
/// kv:升級冷卻到期時間(RFC 3339)、已處理的 agent.upgrade 要求 id(Watchdog 重啟後不重複重設失敗次數,審查建議 2)
const KV_COOLDOWN: &str = "upgrade_cooldown_until";
const KV_REQUEST_SEEN: &str = "upgrade_request_seen";

/// 正式的 Agent 服務操作(SCM);維護中不動作(看守這一輪與升級同時發生時,不把升級停掉的 Agent 拉起來,審查建議 3)
struct Scm(Arc<Shared>);

impl Scm {
    fn guard(&self) -> Result<(), String> {
        if self.0.maintenance.load(Ordering::SeqCst) {
            Err("升級中(維護中),看守暫停".into())
        } else {
            Ok(())
        }
    }
}

impl AgentControl for Scm {
    fn start(&self) -> Result<(), String> {
        self.guard()?;
        scm::start(AGENT_SERVICE)
    }
    fn stop_or_kill(&self, pid: Option<u32>) -> Result<(), String> {
        self.guard()?;
        // 逾時才結束行程;結束前確認行程是服務設定的程式且 PID 沒變(common::scm)
        scm::stop_or_kill(AGENT_SERVICE, pid, STOP_TIMEOUT)
    }
    fn set_auto_start(&self) -> Result<(), String> {
        self.guard()?;
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
pub(crate) async fn probe(expected_pid: u32) -> Result<AgentStatus, PipeError> {
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
    // 上次停在安裝中(Watchdog 中途被重啟):先進入維護中,看守不要在收尾前拉起舊的 Agent
    let installing = outbox
        .upgrade_get(upgrade::COMPONENT)
        .ok()
        .flatten()
        .is_some_and(|r| r.state == "installing");
    let (target_tx, target_rx) = watch::channel(None);
    let shared = Arc::new(Shared {
        outbox: Mutex::new(outbox),
        snapshot: Mutex::new(Snapshot::default()),
        changed: Notify::new(),
        settings,
        maintenance: AtomicBool::new(installing && service_mode),
        target: target_tx,
        upgrade_active: AtomicBool::new(false),
    });
    let expected_exe = if service_mode {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("rustit-agent.exe")))
    } else {
        None
    };
    let watcher = tokio::spawn(watch_agent(shared.clone(), expected_exe, shutdown.clone()));
    let reporter = tokio::spawn(report::run(shared.clone(), shutdown.clone()));
    let upgrader = tokio::spawn(upgrade_task(shared.clone(), target_rx, shutdown));
    let (a, b, c) = tokio::join!(watcher, reporter, upgrader);
    a.and(b).and(c).map_err(|e| format!("背景工作異常結束:{e}"))
}

/// 升級工作(P6-2):啟動時先收尾中斷的安裝,之後每次上報回應帶 `target.agent` 就執行一次(同一目標的重試由失敗次數限制)。
/// 只在服務模式執行(前景開發模式沒有權限停止 / 替換服務,只記錄目標)
async fn upgrade_task(
    shared: Arc<Shared>,
    mut targets: watch::Receiver<Option<UpgradeTarget>>,
    mut shutdown: watch::Receiver<bool>,
) {
    let service_mode = SERVICE_MODE.load(Ordering::Relaxed);
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let (true, Some(install_dir)) = (service_mode, install_dir) else {
        loop {
            tokio::select! {
                r = targets.changed() => if r.is_err() { return },
                _ = shutdown.changed() => return,
            }
            if let Some(t) = targets.borrow_and_update().clone() {
                info!("主機下發 Agent 目標版本 {}(前景模式不升級)", t.version);
            }
        }
    };
    let cache_dir = shared.settings.state_dir.parent().map_or_else(
        || shared.settings.state_dir.join("cache"),
        |d| d.join("cache"),
    );
    // cache\ 要是一般目錄(不是 junction / 符號連結)且 ACL 套用成功才升級:否則刪舊版本、套 ACL 會跟著連結動到別處(資安 L4)
    let cache_ok = std::fs::create_dir_all(cache_dir.join(upgrade::COMPONENT))
        .map_err(|e| format!("無法建立 {}:{e}", cache_dir.display()))
        .and_then(|_| not_reparse(&cache_dir))
        .and_then(|_| not_reparse(&cache_dir.join(upgrade::COMPONENT)))
        .and_then(|_| scm::protect_dir(&cache_dir));
    if let Err(e) = &cache_ok {
        warn!("{e};停用升級");
    }
    if shared.settings.trusted_signers.is_empty() {
        warn!("agent.toml 沒有 [upgrade] trusted_signers:任何升級檔都會被拒絕(SIGNER_NOT_TRUSTED)");
    }
    let mut env = upgrade::swap::RealEnv {
        shared: shared.clone(),
        transport: None,
    };
    let paths = Paths {
        install_dir,
        cache_dir,
    };
    shared.upgrade_active.store(true, Ordering::Relaxed);
    let resumed = Upgrader {
        env: &env,
        paths: paths.clone(),
        trusted: shared.settings.trusted_signers.clone(),
    }
    .resume()
    .await;
    if let Some(o) = resumed {
        info!("中斷的升級已收尾:{o:?}");
        refresh_snapshot(&shared).await;
    }
    shared.upgrade_active.store(false, Ordering::Relaxed);
    shared.maintenance.store(false, Ordering::Relaxed);
    loop {
        tokio::select! {
            r = targets.changed() => if r.is_err() { return },
            _ = shutdown.changed() => return,
        }
        let Some(target) = targets.borrow_and_update().clone() else {
            continue;
        };
        if cache_ok.is_err() {
            continue;
        }
        if let Some(until) = cooldown_until(&shared)
            && chrono::Utc::now() < until
        {
            log::debug!("升級冷卻中(到 {until}),暫不升級 Agent {}", target.version);
            continue;
        }
        if env.transport.is_none() {
            match rustit_common::transport::Transport::new(&shared.settings, &user_agent()) {
                Ok(t) => env.transport = Some(t),
                Err(e) => {
                    warn!("無法建立下載連線:{e};下次上報再試");
                    continue;
                }
            }
        }
        let current = shared
            .snapshot
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .status
            .as_ref()
            .map(|s| s.version.clone());
        let up = Upgrader {
            env: &env,
            paths: paths.clone(),
            trusted: shared.settings.trusted_signers.clone(),
        };
        // 安裝中不理會停止訊號:被中斷時下次啟動由 resume 收尾
        shared.upgrade_active.store(true, Ordering::Relaxed);
        let outcome = up.run(&target, current.as_deref()).await;
        shared.upgrade_active.store(false, Ordering::Relaxed);
        match outcome {
            Outcome::Skipped(why) => log::debug!("不升級 Agent {}:{why}", target.version),
            o => {
                info!("升級 Agent {} 結束:{o:?}", target.version);
                if matches!(o, Outcome::Failed(..)) {
                    let until = chrono::Utc::now()
                        + chrono::Duration::from_std(UPGRADE_COOLDOWN).unwrap_or_default();
                    if let Err(e) = shared
                        .outbox
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .kv_set(KV_COOLDOWN, &until.to_rfc3339())
                    {
                        warn!("{e}");
                    }
                }
                refresh_snapshot(&shared).await;
            }
        }
        // 升級期間累積的目標(每次上報都會送)丟掉,等下一次上報再判斷(審查必修 1)
        targets.borrow_and_update();
    }
}

fn cooldown_until(shared: &Shared) -> Option<chrono::DateTime<chrono::Utc>> {
    let v = shared
        .outbox
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .kv_get(KV_COOLDOWN)?;
    chrono::DateTime::parse_from_rfc3339(&v)
        .ok()
        .map(|t| t.with_timezone(&chrono::Utc))
}

/// 目錄不可是 reparse point(junction、符號連結)
fn not_reparse(dir: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let m =
        std::fs::symlink_metadata(dir).map_err(|e| format!("無法讀取 {}:{e}", dir.display()))?;
    if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !m.is_dir() {
        return Err(format!("{} 不是一般目錄(連結)", dir.display()));
    }
    Ok(())
}

/// 升級結束後立即以 get_status 更新上報用的 Agent 狀態(看守暫停期間的快照已過時;主機以回報的版本核對升級成功)
async fn refresh_snapshot(shared: &Shared) {
    let Ok(Ok(info)) = tokio::task::spawn_blocking(|| scm::query(AGENT_SERVICE)).await else {
        return;
    };
    let status = match info.pid {
        Some(pid) => probe(pid).await.ok(),
        None => None,
    };
    {
        let mut snap = shared.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        snap.info = Some(info);
        if let Some(s) = status {
            snap.status = Some(s);
            snap.status_at = Some(now_rfc3339());
            snap.probe_error = None;
        }
    }
    shared.changed.notify_one();
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
    // 已處理過的 agent.upgrade 要求(管道 status.upgrade_requested.id;存本機,Watchdog 重啟後不重複處理)
    let mut upgrade_request_seen = shared
        .outbox
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .kv_get(KV_REQUEST_SEEN);
    let mut maintenance_since: Option<Instant> = None;
    loop {
        // 升級中(維護中):看守暫停,升級工作自己停止 / 啟動 / 檢查 Agent;結束後重新以目前狀態為基準
        if shared.maintenance.load(Ordering::SeqCst) {
            let since = *maintenance_since.get_or_insert_with(Instant::now);
            if since.elapsed() > MAINTENANCE_LIMIT {
                warn!(
                    "維護中超過 {} 分鐘,恢復看守",
                    MAINTENANCE_LIMIT.as_secs() / 60
                );
                shared.maintenance.store(false, Ordering::SeqCst);
            } else {
                if wait(TICK, &mut shutdown).await {
                    return;
                }
                continue;
            }
        }
        if maintenance_since.take().is_some() {
            monitor.resync();
        }
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
        if let Some(Ok(AgentStatus {
            upgrade_requested: Some(req),
            ..
        })) = &probe_result
            && upgrade_request_seen.as_deref() != Some(req.id.as_str())
        {
            upgrade_request_seen = Some(req.id.clone());
            let outbox = shared.outbox.lock().unwrap_or_else(|p| p.into_inner());
            if let Err(e) = outbox.kv_set(KV_REQUEST_SEEN, &req.id) {
                warn!("{e}");
            }
            // 冷卻一併解除(IT 明確要求再試)
            if let Err(e) = outbox.kv_set(KV_COOLDOWN, "") {
                warn!("{e}");
            }
            drop(outbox);
            info!(
                "收到 agent.upgrade({} {}):重設失敗次數並立即上報",
                req.component,
                req.version.as_deref().unwrap_or("依所屬環")
            );
            if let Err(e) = shared
                .outbox
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .upgrade_reset_attempts(&req.component)
            {
                warn!("{e}");
            }
            shared.changed.notify_one();
        }
        let now = Instant::now();
        // SCM 操作(啟動 / 停止最多 30 秒)放到阻塞執行緒,不卡住上報工作
        let (events, monitor_back) = {
            let info2 = info.clone();
            let ctl = Scm(shared.clone());
            match tokio::task::spawn_blocking(move || {
                let events = monitor.tick(&ctl, &info2, probe_result, now);
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
        // 這一輪進行中升級開始了:看到的停止是升級造成的,不記事件(下一輪結束維護中後重新為基準)
        let events: Vec<monitor::Event> = if shared.maintenance.load(Ordering::SeqCst) {
            maintenance_since.get_or_insert_with(Instant::now);
            Vec::new()
        } else {
            extra.into_iter().chain(events).collect()
        };
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
