//! GigaNexus 端點 Agent(RustIt INTEGRATION-PLAN M2;規範 Gateway ENDPOINT-AGENT-GUIDE §6)。
//!
//! 流程:啟動隨機延遲 0–30 秒 → 兩個獨立工作
//!   - 資產回報([`inventory`]):蒐集 → `POST /agent/v1/inventory`,每 `inventory_interval_sec` 一次
//!   - WebSocket([`ws`]):`hello` + 每 30 秒 `heartbeat`,斷線退避重連
//!
//! 兩者共用一個 `rustit_common::transport::Transport`(同一個 rustls 設定)。蒐集一律經 rustit-collector,Agent 不直接呼叫 WMI。
//! 失敗只記錄並重試,**不因回報失敗而結束或卡住使用者電腦**(AGENT.md §5)。

mod inventory;
pub mod protocol;
#[cfg(windows)]
pub mod service;
mod ws;

use log::info;
use rustit_common::backoff;
use rustit_common::config::Settings;
use rustit_common::stop::{RUNTIME_SHUTDOWN, StopSignal, wait, with_grace};
use rustit_common::transport::Transport;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use tokio::sync::watch;

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
    let transport = Arc::new(Transport::new(&settings, &protocol::user_agent())?);
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
    let last_acked_seq = Arc::new(AtomicU64::new(0));
    let inv = tokio::spawn(inventory::run(
        transport.clone(),
        settings.inventory_interval,
        hello_tx,
        last_acked_seq.clone(),
        shutdown.clone(),
    ));
    let ws = tokio::spawn(ws::run(transport, hello_rx, last_acked_seq, shutdown));
    let (a, b) = tokio::join!(inv, ws);
    a.and(b).map_err(|e| format!("背景工作異常結束:{e}"))
}
