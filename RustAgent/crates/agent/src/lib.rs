//! GigaNexus 端點 Agent(RustIt INTEGRATION-PLAN M2;規範 Gateway ENDPOINT-AGENT-GUIDE §6)。
//!
//! 流程:啟動隨機延遲 0–30 秒 → 兩個獨立工作
//!   - 資產回報([`inventory`]):蒐集 → `POST /agent/v1/inventory`,每 `inventory_interval_sec` 一次
//!   - WebSocket([`ws`]):`hello` + 每 30 秒 `heartbeat`,斷線退避重連
//!
//! 兩者共用一個 [`transport::Transport`](同一個 rustls 設定)。蒐集一律經 rustit-collector,Agent 不直接呼叫 WMI。
//! 失敗只記錄並重試,**不因回報失敗而結束或卡住使用者電腦**(AGENT.md §5)。

pub mod backoff;
pub mod config;
mod inventory;
pub mod logging;
pub mod paths;
pub mod protocol;
#[cfg(windows)]
pub mod service;
pub mod tls;
pub mod transport;
mod ws;

use config::Settings;
use log::{info, warn};
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::watch;
use transport::Transport;

/// 一般停止(服務停止、Ctrl+C)時,最多等這麼久讓工作收尾(關閉 WebSocket、等蒐集結束;PLATFORM-PLAN §4.1)
pub const STOP_GRACE: Duration = Duration::from_secs(30);
/// Windows 關機時的收尾時間:系統給服務的時間很短,只求送出 WebSocket close
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// 收尾逾時後,關閉執行環境時等待背景執行緒(WMI 蒐集)的上限
pub const RUNTIME_SHUTDOWN: Duration = Duration::from_secs(5);

/// 結束訊號:通知所有工作結束,並記下這次允許的收尾時間
#[derive(Clone)]
pub struct StopSignal {
    tx: Arc<watch::Sender<bool>>,
    grace_ms: Arc<AtomicU64>,
}

impl StopSignal {
    pub fn new() -> (Self, watch::Receiver<bool>) {
        let (tx, rx) = watch::channel(false);
        let stop = Self {
            tx: Arc::new(tx),
            grace_ms: Arc::new(AtomicU64::new(STOP_GRACE.as_millis() as u64)),
        };
        (stop, rx)
    }

    /// 要求結束,收尾時間 `grace`
    pub fn stop(&self, grace: Duration) {
        self.grace_ms
            .store(grace.as_millis() as u64, Ordering::SeqCst);
        let _ = self.tx.send(true);
    }

    pub fn grace(&self) -> Duration {
        Duration::from_millis(self.grace_ms.load(Ordering::SeqCst))
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

/// 執行 `work`;收到結束訊號後超過寬限仍未結束就直接返回 Ok。
/// 訊號來源被丟棄(`Err`)不算結束要求,繼續等 `work`。
pub async fn with_grace<W>(
    work: W,
    mut shutdown: watch::Receiver<bool>,
    grace: impl Fn() -> Duration,
) -> Result<(), String>
where
    W: Future<Output = Result<(), String>>,
{
    tokio::pin!(work);
    tokio::select! {
        r = &mut work => r,
        _ = async {
            if shutdown.wait_for(|s| *s).await.is_err() {
                std::future::pending::<()>().await;
            }
            tokio::time::sleep(grace()).await;
        } => {
            warn!("結束逾時({} 秒),不再等待背景工作", grace().as_secs());
            Ok(())
        }
    }
}

/// 執行到收到結束訊號(shutdown 變成 true)為止
pub async fn run(settings: Settings, mut shutdown: watch::Receiver<bool>) -> Result<(), String> {
    let transport = Arc::new(Transport::new(&settings)?);
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
    if inventory::wait(delay, &mut shutdown).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 收到結束訊號後,工作超過寬限仍未結束就返回
    #[tokio::test(start_paused = true)]
    async fn gives_up_after_grace() {
        let (stop, rx) = StopSignal::new();
        let s = stop.clone();
        let started = tokio::time::Instant::now();
        let task = tokio::spawn(with_grace(std::future::pending(), rx, move || s.grace()));
        stop.stop(SHUTDOWN_GRACE);
        assert_eq!(task.await.unwrap(), Ok(()));
        assert_eq!(started.elapsed(), SHUTDOWN_GRACE);
    }

    /// 訊號來源被丟棄不算結束要求:工作仍持續
    #[tokio::test(start_paused = true)]
    async fn dropped_sender_is_not_a_stop() {
        let (tx, rx) = watch::channel(false);
        drop(tx);
        let r = tokio::time::timeout(
            Duration::from_secs(3600),
            with_grace(std::future::pending(), rx, || STOP_GRACE),
        )
        .await;
        assert!(r.is_err(), "不應在沒有結束要求時返回");
    }

    /// 工作自己結束時回傳其結果
    #[tokio::test]
    async fn returns_work_result() {
        let (_stop, rx) = StopSignal::new();
        let r = with_grace(async { Err::<(), _>("x".to_string()) }, rx, || STOP_GRACE).await;
        assert_eq!(r, Err("x".into()));
    }
}
