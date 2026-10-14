//! 端點事件(PLATFORM-PLAN §4.2;契約 event.schema.json):先寫本機 `outbox_event`,
//! 背景工作有事件就批次 `POST /agent/v1/events`(每批 100 筆),主機回 accepted 後才從本機刪除;
//! 送不出去照一般退避(429 照 Retry-After)重試,離線期間持續累積(上限 5,000 筆,丟最舊並記 `local_overflow`)。
//! 主機回 400(內容不符契約)時改逐筆送,仍被拒的那一筆記日誌後丟棄,避免一筆壞資料擋住整個佇列。

use crate::Shared;
use crate::protocol::{EVENTS_PATH, EventOut, EventsRequest, EventsResponse};
use crate::store::{SharedStore, StoredEvent};
use log::{info, warn};
use rustit_common::backoff::Backoff;
use rustit_common::stop::wait;
use rustit_common::transport::SendError;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Notify, watch};

const BATCH: usize = 100;
/// 沒有新事件通知時,定期再檢查一次(例如上次送出失敗後累積的事件)
const IDLE_CHECK: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct EventQueue {
    store: SharedStore,
    notify: Arc<Notify>,
}

impl EventQueue {
    pub fn new(store: SharedStore) -> Self {
        Self {
            store,
            notify: Arc::new(Notify::new()),
        }
    }

    /// 記一筆事件(occurred_at 為端點上的發生時間);寫入失敗只記日誌,不影響呼叫端
    pub fn record(&self, kind: &str, occurred_at: String, data: Value) {
        let result = self.store.lock().push_event(kind, &occurred_at, &data);
        match result {
            Ok((_, 0)) => {}
            Ok((_, dropped)) => {
                warn!("本機事件暫存已滿,丟棄最舊的 {dropped} 筆");
                // 直接寫入,不再遞迴檢查上限
                let _ = self.store.lock().push_event(
                    "local_overflow",
                    &crate::protocol::now_rfc3339(),
                    &json!({ "store": "outbox_event", "dropped": dropped }),
                );
            }
            Err(e) => warn!("無法寫入本機事件 {kind}:{e}"),
        }
        self.notify.notify_one();
    }
}

pub async fn run(shared: Arc<Shared>, mut shutdown: watch::Receiver<bool>) {
    let mut backoff = Backoff::new();
    loop {
        let batch = match shared.store.lock().event_batch(BATCH) {
            Ok(b) => b,
            Err(e) => {
                warn!("無法讀取本機事件:{e}");
                Vec::new()
            }
        };
        if batch.is_empty() {
            tokio::select! {
                _ = shared.events.notify.notified() => continue,
                _ = tokio::time::sleep(IDLE_CHECK) => continue,
                _ = shutdown.changed() => return,
            }
        }
        let result = match send(&shared, &batch).await {
            // 整批內容被拒:逐筆送,找出壞的那筆
            Err(e) if e.is_bad_request() && batch.len() > 1 => {
                warn!("端點事件整批被主機拒絕({e}),改逐筆送出");
                let mut confirmed = 0;
                let mut last = Ok(0);
                for one in &batch {
                    match send(&shared, std::slice::from_ref(one)).await {
                        Ok(n) => confirmed += n,
                        Err(e) if e.is_bad_request() => drop_rejected(&shared, one, &e),
                        Err(e) => {
                            last = Err(e);
                            break;
                        }
                    }
                }
                last.map(|_| confirmed)
            }
            Err(e) if e.is_bad_request() => {
                drop_rejected(&shared, &batch[0], &e);
                Ok(1)
            }
            other => other,
        };
        match result {
            Ok(confirmed) => {
                backoff.reset();
                if confirmed == 0 {
                    // 主機沒有確認這一批的任何一筆(不應發生):避免立即重送
                    warn!("主機沒有確認任何事件,稍後再送");
                    if wait(IDLE_CHECK, &mut shutdown).await {
                        return;
                    }
                }
            }
            Err(e) => {
                shared.failed(&e);
                let delay = e.wait(&mut backoff);
                warn!("端點事件送出失敗:{e};{} 秒後重試", delay.as_secs());
                if wait(delay, &mut shutdown).await {
                    return;
                }
            }
        }
    }
}

/// 送出一批;回傳主機確認並已從本機刪除的筆數(只認這一批內的 event_id)
async fn send(shared: &Shared, batch: &[StoredEvent]) -> Result<usize, SendError> {
    let req = EventsRequest {
        events: batch
            .iter()
            .map(|e| EventOut {
                event_id: e.event_id.clone(),
                kind: e.kind.clone(),
                occurred_at: e.occurred_at.clone(),
                data: e.data.clone(),
            })
            .collect(),
    };
    let res: EventsResponse = shared.transport.post_json(EVENTS_PATH, &req).await?;
    shared.reached();
    let ids: Vec<String> = res
        .accepted
        .into_iter()
        .filter(|id| batch.iter().any(|e| &e.event_id == id))
        .collect();
    if let Err(e) = shared.store.lock().delete_events(&ids) {
        warn!("無法刪除已送出的事件:{e}");
    }
    info!("端點事件已送出 {} 筆", ids.len());
    Ok(ids.len())
}

/// 單筆被主機以 400 拒絕:不再重送,記日誌後丟棄
fn drop_rejected(shared: &Shared, e: &StoredEvent, err: &SendError) {
    warn!("端點事件 {}({})被主機拒絕,丟棄:{err}", e.event_id, e.kind);
    if let Err(x) = shared
        .store
        .lock()
        .delete_events(std::slice::from_ref(&e.event_id))
    {
        warn!("無法刪除被拒的事件:{x}");
    }
}
