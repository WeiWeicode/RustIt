//! GigaNexus 端點 Agent(RustIt INTEGRATION-PLAN M2;規範 Gateway ENDPOINT-AGENT-GUIDE §6)。
//!
//! 流程:開啟本機暫存([`store`])→ 結束上次未結束的離線期間、記 `agent_started` → 啟動隨機延遲 0–30 秒 → 四個獨立工作
//!   - 資產回報([`inventory`]):蒐集 → 本機暫存 → `POST /agent/v1/inventory`(多份時先 `/sync` 比對)
//!   - WebSocket([`ws`]):`hello`(端點時間、硬體指紋)+ 每 30 秒 `heartbeat`,斷線退避重連;`hello_ack` 的主機設定寫入本機
//!   - 端點事件([`events`]):本機暫存 → `POST /agent/v1/events`
//!   - USB 插拔([`usb`]):每 10 秒比對可移除磁碟區
//!
//! 共用一個 `rustit_common::transport::Transport`(同一個 rustls 設定)。蒐集一律經 rustit-collector,Agent 不直接呼叫 WMI。
//! 連不上主機時照常蒐集與記錄,恢復後補傳並回報離線期間([`conn`],PLATFORM-PLAN §4.2)。
//! 失敗只記錄並重試,**不因回報失敗而結束或卡住使用者電腦**(AGENT.md §5)。

mod conn;
mod crypto;
mod events;
mod inventory;
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
use rustit_common::config::Settings;
use rustit_common::stop::{RUNTIME_SHUTDOWN, StopSignal, wait, with_grace};
use rustit_common::transport::{SendError, Transport};
use serde_json::json;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::watch;

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
}

impl Shared {
    /// 連線或回報失敗:記入連線紀錄(429、400 主機有回應,不算離線);被停用時切換狀態
    pub fn failed(&self, e: &SendError) {
        if e.counts_as_offline() {
            self.conn.failed(e);
        }
        if e.is_device_disabled() {
            self.set_disabled(true);
        }
    }

    /// 回報成功或收到 hello_ack:結束離線期間;能成功表示裝置未被停用(WebSocket 只連上不算,停用的裝置會連上後被 4403 關閉)
    pub fn reached(&self) {
        self.conn.succeeded();
        self.set_disabled(false);
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
    let transport = Transport::new(&settings, &protocol::user_agent())?;
    let store = SharedStore::new(Store::open(&settings.state_dir)?);
    let (saved_settings, disabled) = {
        let s = store.lock();
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
        (saved, disabled)
    };
    let events = EventQueue::new(store.clone());
    let conn = ConnTracker::new(store.clone(), events.clone());
    // 上次執行時連不上主機、之後 Agent 停止:以最後一次嘗試結束該期間(停止的時間不算離線)
    conn.recover_after_restart();
    events.record(
        "agent_started",
        now_rfc3339(),
        json!({ "agent_version": protocol::AGENT_VERSION }),
    );
    let shared = Arc::new(Shared {
        transport,
        store,
        events,
        conn,
        last_acked_seq: AtomicU64::new(0),
        disabled: AtomicBool::new(disabled),
    });
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
        shutdown.clone(),
    ));
    let ws = tokio::spawn(ws::run(
        shared.clone(),
        hello_rx,
        settings_tx,
        shutdown.clone(),
    ));
    let ev = tokio::spawn(events::run(shared.clone(), shutdown.clone()));
    let usb = tokio::spawn(usb::run(shared.events.clone(), settings_rx, shutdown));
    let (a, b, c, d) = tokio::join!(inv, ws, ev, usb);
    a.and(b)
        .and(c)
        .and(d)
        .map_err(|e| format!("背景工作異常結束:{e}"))
}
