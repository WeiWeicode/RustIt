//! 停止訊號與收尾寬限(PLATFORM-PLAN §4.1):一般停止(服務停止、Ctrl+C)與 Windows 關機給不同的收尾時間。

use log::warn;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::watch;

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

/// 等待;收到結束訊號回傳 true
pub async fn wait(d: Duration, shutdown: &mut watch::Receiver<bool>) -> bool {
    if *shutdown.borrow() {
        return true;
    }
    tokio::select! {
        _ = tokio::time::sleep(d) => false,
        _ = shutdown.changed() => true,
    }
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
