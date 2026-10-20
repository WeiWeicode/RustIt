//! GigaNexus 端點 Agent(RustIt INTEGRATION-PLAN M2;規範 Gateway ENDPOINT-AGENT-GUIDE §6)。
//!
//! 流程:開啟本機暫存([`store`])→ 結束上次未結束的離線期間、記 `agent_started`(含上次結束原因,P5)→ 啟動隨機延遲 0–30 秒 → 四個獨立工作
//!   - 資產回報([`inventory`]):蒐集 → 本機暫存 → `POST /agent/v1/inventory`(多份時先 `/sync` 比對)
//!   - WebSocket([`ws`]):`hello`(端點時間、硬體指紋、憑證到期日)+ 每 30 秒 `heartbeat`(附健康摘要,P5),斷線退避重連;`hello_ack` 的主機設定寫入本機
//!   - 端點事件([`events`]):本機暫存 → `POST /agent/v1/events`
//!   - USB 插拔([`usb`]):每 10 秒比對可移除磁碟區
//!   - 升級(P6-2):Watchdog 經本機管道 `prepare_shutdown` 要求停止前收尾([`pipe`]);指令 `agent.upgrade` 經管道 `status.upgrade_requested` 通知 Watchdog
//!   - 指令([`command`],P4):WebSocket 收到 `command` 在背景執行,結果先寫本機再經 WebSocket 回報;
//!     遠端診斷([`diagnose`]、[`logs`],P4-2)。另有每分鐘檢查暫時日誌等級是否到期
//!
//! 共用一個 `rustit_common::transport::Transport`(同一個 rustls 設定)。蒐集一律經 rustit-collector,Agent 不直接呼叫 WMI。
//! 連不上主機時照常蒐集與記錄,恢復後補傳並回報離線期間([`conn`],PLATFORM-PLAN §4.2)。
//! 失敗只記錄並重試,**不因回報失敗而結束或卡住使用者電腦**(AGENT.md §5)。

mod command;
mod conn;
mod crypto;
mod diagnose;
mod events;
#[cfg(windows)]
mod guard;
mod inventory;
mod logs;
#[cfg(windows)]
mod pipe;
pub mod protocol;
#[cfg(windows)]
pub mod service;
pub mod store;
mod usb;
mod ws;

use crate::conn::ConnTracker;
use crate::events::EventQueue;
use crate::protocol::{AgentSettings, now_rfc3339};
use crate::store::{CONN_LOG_DAYS, SharedStore, Store};
use log::{info, warn};
use rustit_common::backoff;
use rustit_common::config::{Settings, TlsSettings};
use rustit_common::stop::{RUNTIME_SHUTDOWN, StopSignal, wait, with_grace};
use rustit_common::transport::{SendError, Transport};
use serde_json::json;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use tokio::sync::{Notify, mpsc, watch};

/// 以 Windows 服務執行(service.rs 設定);前景模式不支援 agent.restart
pub static SERVICE_MODE: AtomicBool = AtomicBool::new(false);
/// 設定檔的日誌等級(第一次 run 時記下;agent.log_level 到期恢復用)
static BASE_LOG_LEVEL: std::sync::OnceLock<log::LevelFilter> = std::sync::OnceLock::new();
/// 依指令 agent.restart 結束:服務以專屬結束代碼停止,由失敗復原重新啟動
pub static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);
/// 服務收到 Windows 關機(service.rs 設定);結束原因記為 shutdown 而不是 stop
pub static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

/// 本機 kv:上次結束原因(P5,agent_started.previous_exit)。啟動時讀出後改為 unexpected,
/// 收到停止 / 關機 / agent.restart 時改成對應原因;下次啟動讀到 unexpected 表示上次沒有正常結束(被結束行程、當掉、斷電)
const LAST_EXIT: &str = "last_exit";

/// 各工作共用的狀態
pub(crate) struct Shared {
    pub transport: Transport,
    pub store: SharedStore,
    pub events: EventQueue,
    pub conn: ConnTracker,
    /// 最後一次被主機確認的 agent_seq(心跳回報)
    pub last_acked_seq: AtomicU64,
    /// 主機已停用此裝置(HTTP 403 ITA_DEVICE_DISABLED、WebSocket 4403);持久化於 kv device_status
    disabled: AtomicBool,
    /// 最近一次 hello_ack 的時鐘偏差(端點 − 主機,毫秒);判斷指令是否過期用
    pub clock_skew_ms: AtomicI64,
    /// 已收到過 hello_ack(clock_skew_ms 有意義;agent.diagnose)
    pub clock_known: AtomicBool,
    /// 啟動時間(agent.diagnose uptime)
    pub started: std::time::Instant,
    /// 裝置憑證設定(agent.diagnose 讀到期日;開發模式 http 為 None)
    pub tls: Option<TlsSettings>,
    /// 設定檔的日誌等級(agent.log_level 到期後恢復)
    pub base_log_level: log::LevelFilter,
    /// 指令 inventory.collect:要求資產迴圈立即蒐集
    pub collect_now: mpsc::Sender<inventory::CollectRequest>,
    /// 最近一次上傳的 (agent_seq, 主機結果)
    pub last_upload: std::sync::Mutex<Option<(u64, String)>>,
    /// 有新的 command_update 待送(WebSocket 迴圈等待)
    pub command_notify: Notify,
    /// 會改變系統的指令串行
    pub exclusive: tokio::sync::Mutex<()>,
    /// 讓所有工作結束(外部停止訊號或 agent.restart)
    stop: watch::Sender<bool>,
    /// 本機管道 get_status(P5-2,指南 §6.4):啟動時間(RFC 3339)、上次結束原因
    pub started_at: String,
    pub previous_exit: String,
    /// WebSocket 已連線且收到 hello_ack
    pub ws_connected: AtomicBool,
    /// 最近一次收到 hello_ack / heartbeat_ack(Unix 毫秒;0 = 沒有)
    pub last_ack_ms: AtomicI64,
    /// 最近一次回報 / 連線錯誤(恢復後清除)
    pub last_error: std::sync::Mutex<Option<String>>,
    /// 裝置憑證到期日(RFC 3339;每次連線前讀)
    pub cert_not_after: std::sync::Mutex<String>,
    /// 升級中(收到 prepare_shutdown,P6-2):新指令回 failed AGENT_UPGRADING
    pub upgrading: AtomicBool,
    /// 執行中的指令 command_id(prepare_shutdown 等它們結束,最多 60 秒)
    pub running_commands: std::sync::Mutex<std::collections::HashSet<String>>,
    /// prepare_shutdown 的次數(5 分鐘自動恢復只解除同一次的收尾)
    pub prepare_gen: AtomicU64,
    /// true = WebSocket 送完待送狀態後以 1000 關閉並暫停重連(prepare_shutdown)
    pub ws_hold: watch::Sender<bool>,
    /// agent.upgrade(P6-2):管道 status.upgrade_requested 的內容與時間(1 小時內有效)
    pub upgrade_requested: std::sync::Mutex<Option<(serde_json::Value, std::time::Instant)>>,
}

impl Shared {
    /// 連線或回報失敗:記入連線紀錄(429、400、停用時主機有回應,不算離線);被停用時切換狀態
    pub fn failed(&self, e: &SendError) {
        self.conn.observe_failure(e);
        if let Ok(mut last) = self.last_error.lock() {
            *last = Some(e.to_string().chars().take(300).collect());
        }
        if e.is_device_disabled() {
            self.set_disabled(true);
        }
    }

    /// 回報成功或收到 hello_ack:結束離線期間;能成功表示裝置未被停用(WebSocket 只連上不算,停用的裝置會連上後被 4403 關閉)
    pub fn reached(&self) {
        self.conn.succeeded();
        if let Ok(mut last) = self.last_error.lock() {
            *last = None;
        }
        self.set_disabled(false);
    }

    /// 指令 agent.restart:結束所有工作,服務以專屬結束代碼停止
    pub fn request_restart(&self) {
        RESTART_REQUESTED.store(true, Ordering::Relaxed);
        self.mark_exit("restart_command");
        let _ = self.stop.send(true);
    }

    /// 記下這次的結束原因(收到結束訊號當下就寫:收尾逾時被中斷也不會誤判為非正常結束)
    fn mark_exit(&self, reason: &str) {
        if let Err(e) = self.store.lock().set(LAST_EXIT, reason) {
            warn!("無法記錄結束原因:{e}");
        }
    }

    pub fn is_disabled(&self) -> bool {
        self.disabled.load(Ordering::Relaxed)
    }

    fn set_disabled(&self, v: bool) {
        if self.disabled.swap(v, Ordering::Relaxed) == v {
            return;
        }
        if v {
            warn!("裝置已被主機停用:暫停蒐集,每 10 分鐘確認一次");
        } else {
            info!("裝置已恢復為啟用");
        }
        if let Err(e) = self
            .store
            .lock()
            .set("device_status", if v { "disabled" } else { "active" })
        {
            warn!("無法保存裝置狀態:{e}");
        }
    }
}

/// 建立執行環境並執行 Agent 到結束(前景與服務模式共用)。
/// `side_task` 在同一個執行環境背景執行(前景:等 Ctrl+C;服務:回報服務狀態)。
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
    // 蒐集在背景執行緒(WMI)時不無限等待
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN);
    result
}

/// 執行到收到結束訊號(shutdown 變成 true)為止
pub async fn run(settings: Settings, mut shutdown: watch::Receiver<bool>) -> Result<(), String> {
    // 測試用壞版本(P6-2 VM 驗收「故意放壞的版本 → 自動還原」)
    if cfg!(feature = "broken-exit") {
        return Err(format!(
            "broken-exit 測試版 {}:啟動即結束",
            protocol::AGENT_VERSION
        ));
    }
    let transport = Transport::new(&settings, &protocol::user_agent())?;
    let store = SharedStore::new(Store::open(&settings.state_dir)?);
    let (saved_settings, disabled, previous_exit) = {
        let s = store.lock();
        // 上次結束原因;沒有紀錄 = 第一次執行(新安裝或本機暫存重建)。之後先標成 unexpected,正常結束時再改
        let previous_exit = s
            .get(LAST_EXIT)
            .ok()
            .flatten()
            .unwrap_or_else(|| "first_run".into());
        if let Err(e) = s.set(LAST_EXIT, "unexpected") {
            warn!("無法記錄執行狀態:{e}");
        }
        let saved = s
            .get("settings")
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str::<AgentSettings>(&v).ok())
            .unwrap_or_default();
        let disabled = s.get("device_status").ok().flatten().as_deref() == Some("disabled");
        let before = (chrono::Utc::now() - chrono::Duration::days(CONN_LOG_DAYS))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        if let Err(e) = s.purge_conn_log(&before) {
            warn!("無法清除舊的連線紀錄:{e}");
        }
        (saved, disabled, previous_exit)
    };
    let events = EventQueue::new(store.clone());
    let conn = ConnTracker::new(store.clone(), events.clone());
    // 上次執行時連不上主機、之後 Agent 停止:以最後一次嘗試結束該期間(停止的時間不算離線)
    conn.recover_after_restart();
    if previous_exit == "unexpected" {
        warn!("上次 Agent 沒有正常結束(被結束行程、當掉或斷電)");
    }
    events.record(
        "agent_started",
        now_rfc3339(),
        json!({
            "agent_version": protocol::AGENT_VERSION,
            "previous_exit": previous_exit,
            "boot_time": rustit_collector::boot_time(),
        }),
    );
    // 所有工作共用的結束訊號:外部停止(服務停止、Ctrl+C)轉送過來,agent.restart 也從這裡結束
    let (stop_tx, stop_rx) = watch::channel(false);
    let (collect_tx, collect_rx) = mpsc::channel(4);
    let shared = Arc::new(Shared {
        transport,
        store,
        events,
        conn,
        last_acked_seq: AtomicU64::new(0),
        disabled: AtomicBool::new(disabled),
        clock_skew_ms: AtomicI64::new(0),
        clock_known: AtomicBool::new(false),
        started: std::time::Instant::now(),
        tls: settings.tls.clone(),
        // 同一行程第一次啟動時的等級(設定檔);之後即使暫時等級生效中也不會誤抓
        base_log_level: *BASE_LOG_LEVEL.get_or_init(log::max_level),
        collect_now: collect_tx,
        last_upload: std::sync::Mutex::new(None),
        command_notify: Notify::new(),
        exclusive: tokio::sync::Mutex::new(()),
        stop: stop_tx,
        started_at: now_rfc3339(),
        previous_exit: previous_exit.clone(),
        ws_connected: AtomicBool::new(false),
        last_ack_ms: AtomicI64::new(0),
        last_error: std::sync::Mutex::new(None),
        cert_not_after: std::sync::Mutex::new(String::new()),
        upgrading: AtomicBool::new(false),
        running_commands: std::sync::Mutex::new(std::collections::HashSet::new()),
        prepare_gen: AtomicU64::new(0),
        ws_hold: watch::channel(false).0,
        upgrade_requested: std::sync::Mutex::new(None),
    });
    // 上次的 agent.restart 回報成功、中途停止的指令回報失敗(重連後送出);未到期的暫時日誌等級重新套用
    command::recover(&shared);
    command::apply_log_level(&shared);
    {
        let shared = shared.clone();
        let mut external = shutdown.clone();
        tokio::spawn(async move {
            if external.wait_for(|s| *s).await.is_ok() {
                shared.mark_exit(if SHUTDOWN_REQUESTED.load(Ordering::Relaxed) {
                    "shutdown"
                } else {
                    "stop"
                });
                let _ = shared.stop.send(true);
            }
        });
    }
    if let Ok((inv, ev)) = shared.store.lock().counts() {
        info!(
            "本機暫存:{} 尚待送出資產 {inv} 份、事件 {ev} 筆",
            settings.state_dir.display()
        );
    }
    info!(
        "Agent {} 啟動:Server {},資產回報每 {} 秒{}",
        protocol::AGENT_VERSION,
        settings.server,
        settings.inventory_interval.as_secs(),
        if settings.dev_cert_headers.is_some() {
            "(dev:模擬憑證標頭)"
        } else {
            ""
        }
    );

    // 避免 Gateway / Server 重啟後所有電腦同時湧入(指南 §6.3 第 1 步)
    let delay = backoff::random_up_to(settings.startup_jitter);
    info!("{} 秒後開始連線", delay.as_secs());
    if wait(delay, &mut shutdown).await {
        return Ok(());
    }

    let (hello_tx, hello_rx) = watch::channel(None);
    let (settings_tx, settings_rx) = watch::channel(saved_settings);
    let inv = tokio::spawn(inventory::run(
        shared.clone(),
        settings.inventory_interval,
        hello_tx,
        settings_rx.clone(),
        collect_rx,
        stop_rx.clone(),
    ));
    let ws = tokio::spawn(ws::run(
        shared.clone(),
        hello_rx,
        settings_tx,
        stop_rx.clone(),
    ));
    let ev = tokio::spawn(events::run(shared.clone(), stop_rx.clone()));
    let usb = tokio::spawn(usb::run(
        shared.events.clone(),
        settings_rx,
        stop_rx.clone(),
    ));
    let level = tokio::spawn(log_level_task(shared.clone(), stop_rx.clone()));
    // 服務模式才有本機管道(Watchdog 查狀態)與看守 Watchdog(P5-2);前景開發模式沒有對方服務
    let watch = tokio::spawn(service_tasks(shared.clone(), stop_rx));
    let (a, b, c, d, e, f) = tokio::join!(inv, ws, ev, usb, level, watch);
    a.and(b)
        .and(c)
        .and(d)
        .and(e)
        .and(f)
        .map_err(|e| format!("背景工作異常結束:{e}"))
}

/// 服務模式:本機管道伺服端與看守 Watchdog(P5-2,指南 §7.1、§7.2)
async fn service_tasks(shared: Arc<Shared>, stop: watch::Receiver<bool>) {
    #[cfg(windows)]
    if SERVICE_MODE.load(Ordering::Relaxed) {
        tokio::join!(
            pipe::run(shared.clone(), stop.clone()),
            guard::run(shared.events.clone(), stop)
        );
    }
    #[cfg(not(windows))]
    let _ = (shared, stop);
}

/// 每分鐘檢查 agent.log_level 的暫時等級是否到期
async fn log_level_task(shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    while !wait(std::time::Duration::from_secs(60), &mut stop).await {
        command::apply_log_level(&shared);
    }
}
