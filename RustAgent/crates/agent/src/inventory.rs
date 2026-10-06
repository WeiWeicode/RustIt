//! 資產回報迴圈:蒐集(rustit-collector,背景執行緒)→ `POST /agent/v1/inventory`,失敗依類型等待後重送同一份,
//! 成功後等下一個週期(預設 1 小時;內容沒變時 Server 只更新最後回報時間)。
//! 離線暫存與 `/sync` 在 M5 加入;目前 Agent 重啟前未送出的那一份會遺失(下次啟動會重新蒐集)。

use crate::backoff::Backoff;
use crate::protocol::{HelloBody, InventoryRequest};
use crate::transport::Transport;
use log::{error, info, warn};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::watch;

pub async fn run(
    transport: Arc<Transport>,
    interval: Duration,
    hello_tx: watch::Sender<Option<HelloBody>>,
    last_acked_seq: Arc<AtomicU64>,
    mut shutdown: watch::Receiver<bool>,
) {
    // 契約:agent_seq 在同一台電腦上單調遞增、重啟後仍遞增;M5 前以啟動時的 Unix 毫秒為起點
    let mut seq = u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(1);
    loop {
        let info = match tokio::task::spawn_blocking(rustit_collector::collect).await {
            Ok(info) => info,
            Err(e) => {
                error!("資產蒐集失敗:{e}");
                if wait(interval, &mut shutdown).await {
                    return;
                }
                continue;
            }
        };
        let collected_at = chrono::Utc::now();
        if !info.warnings.is_empty() {
            warn!(
                "資產蒐集有 {} 項警告(已隨回報送出):{:?}",
                info.warnings.len(),
                info.warnings
            );
        }
        hello_tx.send_replace(Some(HelloBody::from_info(&info)));

        seq += 1;
        let collect_ms = info.collect_ms;
        let software = info.software.len();
        let req = InventoryRequest::new(info, seq, collected_at);
        let mut backoff = Backoff::new();
        loop {
            match transport.post_inventory(&req).await {
                Ok(res) => {
                    info!(
                        "資產回報完成:seq={} 結果={} 裝置={} 蒐集 {collect_ms} ms、軟體 {software} 筆",
                        res.agent_seq, res.result, res.device_id
                    );
                    last_acked_seq.store(res.agent_seq, Ordering::Relaxed);
                    break;
                }
                Err(e) => {
                    let delay = e.wait(&mut backoff);
                    warn!("資產回報失敗:{e};{} 秒後重試", delay.as_secs());
                    if wait(delay, &mut shutdown).await {
                        return;
                    }
                }
            }
        }
        if wait(interval, &mut shutdown).await {
            return;
        }
    }
}

/// 等待;收到結束訊號回傳 true
pub(crate) async fn wait(d: Duration, shutdown: &mut watch::Receiver<bool>) -> bool {
    if *shutdown.borrow() {
        return true;
    }
    tokio::select! {
        _ = tokio::time::sleep(d) => false,
        _ = shutdown.changed() => true,
    }
}
