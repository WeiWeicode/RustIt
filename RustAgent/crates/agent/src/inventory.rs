//! 資產回報迴圈(PLATFORM-PLAN §4.2、INTEGRATION-PLAN §4.2):
//!
//! 1. 蒐集(rustit-collector,背景執行緒)→ 寫本機 `outbox_inventory`(加密;連續相同內容只留最新一份)。
//!    蒐集依自己的時程進行,**連不上主機時照常蒐集**(送出失敗不會擋住下一次蒐集)。
//! 2. 送出:暫存只有一份時直接 `POST /agent/v1/inventory`;多份(離線累積)時先 `POST /agent/v1/sync` 比對,
//!    刪除 skip、依 need 逐份上傳(較舊的主機只放歷史),主機回 200 後才從本機刪除。
//! 3. 失敗依類型等待後重送(被拒 10 分鐘、429 照 Retry-After、其他指數退避),但不超過下一次蒐集的時間。
//! 4. 裝置被主機停用時暫停蒐集(避免暫存塞滿),仍定期嘗試,恢復後繼續。
//! 5. 間隔:主機下發設定 `inventory_interval_sec`,沒有時用 agent.toml。
//! 6. 指令 `inventory.collect`(P4):經 [`CollectRequest`] 要求立即蒐集並送出,回覆這一份的回報結果;不影響原本的時程。

use crate::Shared;
use crate::protocol::{
    AgentSettings, HelloBody, INVENTORY_PATH, InventoryRequest, InventoryResponse, SYNC_PATH,
    SyncPending, SyncRequest, SyncResponse,
};
use crate::store::PendingInventory;
use log::{error, info, warn};
use rustit_common::backoff::Backoff;
use rustit_common::stop::wait;
use rustit_common::transport::SendError;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

/// 立即蒐集的要求(指令 inventory.collect):回覆 command_update 的 result,或失敗原因
pub type CollectRequest = oneshot::Sender<Result<serde_json::Value, String>>;

pub async fn run(
    shared: Arc<Shared>,
    install_interval: Duration,
    hello_tx: watch::Sender<Option<HelloBody>>,
    settings: watch::Receiver<AgentSettings>,
    mut collect_now: mpsc::Receiver<CollectRequest>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut next_collect = Instant::now();
    let mut backoff = Backoff::new();
    loop {
        if Instant::now() >= next_collect {
            if shared.is_disabled() {
                info!("裝置已被主機停用,暫停蒐集;恢復後繼續");
            } else {
                collect_into_outbox(&shared, &hello_tx).await;
            }
            next_collect = Instant::now() + settings.borrow().inventory_interval(install_interval);
        }
        let delay = match flush(&shared).await {
            Ok(()) => {
                backoff.reset();
                next_collect.saturating_duration_since(Instant::now())
            }
            Err(e) => {
                shared.failed(&e);
                let d = e.wait(&mut backoff);
                warn!("資產回報失敗:{e};{} 秒後重試", d.as_secs());
                // 不超過下一次蒐集:離線期間照常蒐集
                d.min(next_collect.saturating_duration_since(Instant::now()))
            }
        };
        tokio::select! {
            stop = wait(delay, &mut shutdown) => if stop { return },
            Some(reply) = collect_now.recv() => {
                // 停止時不等蒐集與上傳結束(回覆被丟棄,執行器回報失敗)
                tokio::select! {
                    r = collect_and_send(&shared, &hello_tx) => { let _ = reply.send(r); }
                    _ = shutdown.changed() => return,
                }
            }
        }
    }
}

/// 指令 inventory.collect:蒐集一份並送出(多份暫存時照常經 /sync),回報這一份的結果
async fn collect_and_send(
    shared: &Shared,
    hello_tx: &watch::Sender<Option<HelloBody>>,
) -> Result<serde_json::Value, String> {
    let seq = collect_into_outbox(shared, hello_tx)
        .await
        .ok_or("資產蒐集或寫入本機暫存失敗")?;
    flush(shared).await.map_err(|e| {
        shared.failed(&e);
        format!("資產回報失敗(已留在本機暫存補傳):{e}")
    })?;
    // 與前一份內容相同時本機只留最新一份,主機的結果以最後一次上傳為準
    let last = shared
        .last_upload
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let result = match last {
        Some((s, r)) if s == seq => r,
        _ => "sent".to_string(),
    };
    Ok(json!({ "agent_seq": seq, "result": result }))
}

/// 蒐集並寫入本機暫存;回傳這一份的 agent_seq(失敗回 None,已記錄)
async fn collect_into_outbox(
    shared: &Shared,
    hello_tx: &watch::Sender<Option<HelloBody>>,
) -> Option<u64> {
    let info = match tokio::task::spawn_blocking(rustit_collector::collect).await {
        Ok(info) => info,
        Err(e) => {
            error!("資產蒐集失敗:{e}");
            return None;
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

    let now_ms = u64::try_from(collected_at.timestamp_millis()).unwrap_or(1);
    let result = (|| {
        let store = shared.store.lock();
        let seq = store.next_agent_seq(now_ms)?;
        let req = InventoryRequest::new(info, seq, collected_at);
        let body = serde_json::to_vec(&req).map_err(|e| e.to_string())?;
        let dropped = store.push_inventory(seq, &req.collected_at, &req.content_hash, &body)?;
        Ok::<_, String>((seq, dropped))
    })();
    match result {
        Ok((seq, 0)) => Some(seq),
        Ok((seq, dropped)) => {
            warn!("本機資產暫存已滿,丟棄最舊的 {dropped} 份(最新 seq={seq})");
            shared.events.record(
                "local_overflow",
                crate::protocol::now_rfc3339(),
                json!({ "store": "outbox_inventory", "dropped": dropped }),
            );
            Some(seq)
        }
        Err(e) => {
            error!("無法寫入本機資產暫存:{e}");
            None
        }
    }
}

/// 送出暫存直到清空或沒有進展;連線或回報失敗時回 Err(由呼叫端記錄並等待)
async fn flush(shared: &Shared) -> Result<(), SendError> {
    loop {
        let pending = match shared.store.lock().pending_inventory() {
            Ok(p) => p,
            Err(e) => {
                error!("無法讀取本機資產暫存:{e}");
                return Ok(());
            }
        };
        let progress = match pending.as_slice() {
            [] => return Ok(()),
            [one] => upload(shared, one).await?,
            many => sync_round(shared, many).await?,
        };
        shared.reached();
        if !progress {
            // 沒有實際上傳或刪除任何一份(本機讀取失敗、主機回了不在暫存的 seq):留到下一個週期,避免空轉
            warn!("資產暫存這一輪沒有進展,{} 份留到下次", pending.len());
            return Ok(());
        }
    }
}

/// 上傳一份暫存;成功後從本機刪除並記錄最後確認的 seq / hash。回傳是否有實際進展(上傳或刪除)
async fn upload(shared: &Shared, p: &PendingInventory) -> Result<bool, SendError> {
    let body = match shared.store.lock().inventory_body(p.agent_seq) {
        Ok(Some(b)) => b,
        // 已不存在,或無法解密已被刪除:算有進展
        Ok(None) => return Ok(true),
        Err(e) => {
            warn!("無法讀取暫存的資產回報 seq={}:{e}", p.agent_seq);
            return Ok(false);
        }
    };
    let value: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            warn!("暫存的資產回報 seq={} 格式錯誤,已刪除:{e}", p.agent_seq);
            let _ = shared.store.lock().delete_inventory(&[p.agent_seq]);
            return Ok(true);
        }
    };
    let res: InventoryResponse = shared.transport.post_json(INVENTORY_PATH, &value).await?;
    info!(
        "資產回報完成:seq={} 結果={} 裝置={}",
        res.agent_seq, res.result, res.device_id
    );
    let store = shared.store.lock();
    let saved = store
        .delete_inventory(&[p.agent_seq])
        .and_then(|_| store.set("last_acked_seq", &p.agent_seq.to_string()))
        .and_then(|_| store.set("last_acked_hash", &p.content_hash))
        .and_then(|_| store.set("device_id", &res.device_id));
    if let Err(e) = saved {
        warn!("無法更新本機暫存:{e}");
    }
    shared.last_acked_seq.store(p.agent_seq, Ordering::Relaxed);
    if let Ok(mut last) = shared.last_upload.lock() {
        *last = Some((p.agent_seq, res.result.clone()));
    }
    Ok(true)
}

/// 一輪 /sync:刪除 skip、上傳 need;回傳是否有實際進展
async fn sync_round(shared: &Shared, pending: &[PendingInventory]) -> Result<bool, SendError> {
    let (last_seq, last_hash) = {
        let store = shared.store.lock();
        let seq = store
            .get("last_acked_seq")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        (
            seq,
            store
                .get("last_acked_hash")
                .ok()
                .flatten()
                .unwrap_or_default(),
        )
    };
    let req = SyncRequest {
        last_acked_seq: last_seq,
        last_acked_hash: last_hash,
        pending: pending
            .iter()
            .map(|p| SyncPending {
                agent_seq: p.agent_seq,
                collected_at: p.collected_at.clone(),
                content_hash: p.content_hash.clone(),
            })
            .collect(),
    };
    let res: SyncResponse = shared.transport.post_json(SYNC_PATH, &req).await?;
    info!(
        "離線補傳比對:暫存 {} 份,主機需要 {} 份、略過 {} 份(狀態 {})",
        pending.len(),
        res.need.len(),
        res.skip.len(),
        res.server_state.status
    );
    let mut progress = match shared.store.lock().delete_inventory(&res.skip) {
        Ok(n) => n > 0,
        Err(e) => {
            warn!("無法刪除已略過的暫存:{e}");
            false
        }
    };
    for seq in &res.need {
        if let Some(p) = pending.iter().find(|p| p.agent_seq == *seq) {
            progress |= upload(shared, p).await?;
        }
    }
    Ok(progress)
}
