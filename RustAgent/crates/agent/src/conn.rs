//! 連線紀錄與離線期間(PLATFORM-PLAN §4.2「連不上主機也要記錄」):
//!
//! 1. 斷線當下寫 `conn_log`(開始時間、原因);之後每次失敗只更新次數與最後原因,不逐筆寫。
//! 2. 任一通道(HTTPS 或 WebSocket)成功即視為恢復:結束這段期間,並寫一筆 `offline_period` 事件(occurred_at = 開始時間),
//!    隨事件佇列送出。不到 1 分鐘的短暫中斷只留在 conn_log,不產生事件,避免網路抖動造成大量事件。
//! 3. 啟動時若有未結束的期間:距最後一次嘗試不超過 10 分鐘(服務重啟)視為同一段離線,繼續累計;
//!    超過(關機、長時間停止)則以最後一次嘗試的時間結束,停止的時間不算離線(完成標準:離線中重啟服務仍只有一筆 offline_period)。

use crate::events::EventQueue;
use crate::protocol::now_rfc3339;
use crate::store::{Period, SharedStore};
use log::{info, warn};
use rustit_common::transport::SendError;
use serde_json::json;

/// 短於此時間的中斷不產生 offline_period 事件
pub const MIN_OFFLINE_SECS: i64 = 60;
/// 啟動時距最後一次嘗試不超過此時間,視為服務重啟,延續同一段離線期間
pub const RESTART_GAP_SECS: i64 = 600;

/// 結束一段離線期間的時間點
enum EndAt {
    /// 現在(恢復連線)
    Now,
    /// 最後一次嘗試(Agent 停止的時間不算)
    LastAttempt,
}

#[derive(Clone)]
pub struct ConnTracker {
    store: SharedStore,
    events: EventQueue,
}

fn parse(t: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(t)
        .ok()
        .map(|d| d.with_timezone(&chrono::Utc))
}

impl ConnTracker {
    pub fn new(store: SharedStore, events: EventQueue) -> Self {
        Self { store, events }
    }

    /// 回報或連線失敗時呼叫:連不上主機才記入離線期間;裝置被停用代表主機有回應,
    /// 結束進行中的期間(否則會延續到 IT 重新啟用才結束);429、400 不影響期間
    pub fn observe_failure(&self, err: &SendError) {
        if err.counts_as_offline() {
            self.failed(err);
        } else if err.is_device_disabled() {
            self.succeeded();
        }
    }

    /// 一次連線或回報失敗
    pub fn failed(&self, err: &SendError) {
        let result =
            self.store
                .lock()
                .record_failure(&now_rfc3339(), err.reason(), &err.to_string());
        match result {
            Ok(p) if p.retries == 1 => warn!(
                "開始連不上主機(原因 {}),之後恢復時回報離線期間",
                err.reason()
            ),
            Ok(_) => {}
            Err(e) => warn!("無法寫入連線紀錄:{e}"),
        }
    }

    /// 連線或回報成功:結束進行中的離線期間
    pub fn succeeded(&self) {
        self.close(EndAt::Now);
    }

    /// 啟動時呼叫:上次執行時未結束的期間,服務重啟(10 分鐘內)則延續,否則以最後一次嘗試的時間結束
    pub fn recover_after_restart(&self) {
        let gap = match self.store.lock().open_period() {
            Ok(Some(p)) => {
                parse(&p.last_attempt_at).map(|t| (chrono::Utc::now() - t).num_seconds())
            }
            _ => return,
        };
        if gap.is_some_and(|g| g <= RESTART_GAP_SECS) {
            info!("上次停止前連不上主機,延續同一段離線期間");
            return;
        }
        self.close(EndAt::LastAttempt);
    }

    fn close(&self, at: EndAt) {
        let period = {
            let store = self.store.lock();
            match store.open_period() {
                Ok(Some(p)) => {
                    let ended = match at {
                        EndAt::LastAttempt => p.last_attempt_at.clone(),
                        EndAt::Now => now_rfc3339(),
                    };
                    if let Err(e) = store.close_period(p.id, &ended) {
                        warn!("無法結束連線紀錄:{e}");
                        return;
                    }
                    // 順便清除 30 天前的紀錄(服務長期不重啟時也會清)
                    let before = (chrono::Utc::now()
                        - chrono::Duration::days(crate::store::CONN_LOG_DAYS))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    if let Err(e) = store.purge_conn_log(&before) {
                        warn!("無法清除舊的連線紀錄:{e}");
                    }
                    (p, ended)
                }
                Ok(None) => return,
                Err(e) => {
                    warn!("無法讀取連線紀錄:{e}");
                    return;
                }
            }
        };
        let (p, ended) = period;
        self.emit(&p, &ended);
    }

    /// 期間夠長才寫 offline_period 事件(store 已解鎖後才寫,避免重複上鎖)
    fn emit(&self, p: &Period, ended: &str) {
        let secs = match (parse(&p.started_at), parse(ended)) {
            (Some(a), Some(b)) => (b - a).num_seconds(),
            _ => 0,
        };
        if secs < MIN_OFFLINE_SECS {
            return;
        }
        info!(
            "與主機恢復連線:離線 {secs} 秒、嘗試 {} 次、主要原因 {}",
            p.retries,
            p.main_reason()
        );
        self.events.record(
            "offline_period",
            p.started_at.clone(),
            json!({
                "started_at": p.started_at,
                "ended_at": ended,
                "reason": p.main_reason(),
                "retries": p.retries,
                "last_error": p.last_error,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn setup() -> (tempfile::TempDir, SharedStore, ConnTracker) {
        let dir = tempfile::tempdir().unwrap();
        let store = SharedStore::new(Store::open(dir.path()).unwrap());
        let tracker = ConnTracker::new(store.clone(), EventQueue::new(store.clone()));
        (dir, store, tracker)
    }

    fn backdate(store: &SharedStore, secs: i64) {
        let at = (chrono::Utc::now() - chrono::Duration::seconds(secs))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let s = store.lock();
        let p = s.open_period().unwrap().unwrap();
        s.close_period(p.id, &at).unwrap();
        // 重新開一段起點較早的期間(測試用:直接改起點)
        drop(s);
        let s = store.lock();
        s.record_failure(&at, "network", "連線逾時").unwrap();
    }

    #[test]
    fn long_outage_emits_offline_period_once() {
        let (_d, store, t) = setup();
        t.failed(&SendError::Retry("IO error: (os error 10060)".into()));
        backdate(&store, 3600);
        t.failed(&SendError::Retry("IO error: (os error 10060)".into()));
        t.succeeded();
        t.succeeded();
        let ev = store.lock().event_batch(10).unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].kind, "offline_period");
        assert_eq!(ev[0].data["reason"], "network");
        assert_eq!(
            ev[0].occurred_at,
            ev[0].data["started_at"].as_str().unwrap()
        );
        assert!(store.lock().open_period().unwrap().is_none());
    }

    #[test]
    fn short_blip_only_in_conn_log() {
        let (_d, store, t) = setup();
        t.failed(&SendError::Busy(
            std::time::Duration::from_secs(30),
            "HTTP 429".into(),
        ));
        t.succeeded();
        assert!(store.lock().event_batch(10).unwrap().is_empty());
    }

    #[test]
    fn long_stop_closes_period_at_last_attempt() {
        let (_d, store, t) = setup();
        t.failed(&SendError::Retry("x".into()));
        backdate(&store, 7200);
        // 最後一次嘗試在 2 小時前(之後關機)
        t.recover_after_restart();
        assert!(store.lock().open_period().unwrap().is_none(), "結束期間");
        let ev = store.lock().event_batch(10).unwrap();
        assert_eq!(
            ev.len(),
            0,
            "起點與最後嘗試相同 → 期間 0 秒,關機時間不算離線"
        );
    }

    #[test]
    fn disabled_device_is_not_offline() {
        let (_d, store, t) = setup();
        let disabled = SendError::Rejected(
            r#"HTTP 403 {"code":"ITA_DEVICE_DISABLED","message":"此裝置已停用"}"#.into(),
        );
        t.observe_failure(&disabled);
        t.observe_failure(&SendError::Rejected("裝置已被 IT 停用(close 4403)".into()));
        assert!(
            store.lock().open_period().unwrap().is_none(),
            "停用不開離線期間"
        );
        t.succeeded();
        assert!(store.lock().event_batch(10).unwrap().is_empty());
    }

    #[test]
    fn disabled_response_ends_outage() {
        let (_d, store, t) = setup();
        t.observe_failure(&SendError::Retry("IO error: (os error 10060)".into()));
        backdate(&store, 3600);
        // 網路恢復後第一個回應就是停用:主機已可連上,離線期間到此結束
        t.observe_failure(&SendError::Rejected(
            r#"HTTP 403 {"code":"ITA_DEVICE_DISABLED"}"#.into(),
        ));
        assert!(store.lock().open_period().unwrap().is_none());
        let ev = store.lock().event_batch(10).unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].kind, "offline_period");
        assert_eq!(ev[0].data["reason"], "network");
    }

    #[test]
    fn busy_does_not_touch_period() {
        let (_d, store, t) = setup();
        t.observe_failure(&SendError::Busy(
            std::time::Duration::from_secs(30),
            "HTTP 429".into(),
        ));
        assert!(store.lock().open_period().unwrap().is_none());
    }

    #[test]
    fn service_restart_keeps_one_period() {
        let (_d, store, t) = setup();
        t.failed(&SendError::Retry("x".into()));
        backdate(&store, 3600);
        t.failed(&SendError::Retry("x".into()));
        // 服務重啟:最後一次嘗試剛剛發生
        t.recover_after_restart();
        assert!(store.lock().open_period().unwrap().is_some(), "延續");
        t.failed(&SendError::Retry("x".into()));
        t.succeeded();
        let ev = store.lock().event_batch(10).unwrap();
        assert_eq!(ev.len(), 1, "只有一筆 offline_period");
        assert_eq!(ev[0].data["retries"], 3);
    }
}
