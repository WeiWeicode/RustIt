//! Watchdog 本機紀錄 `state\watchdog.db`(SQLite;P5-MONITOR-DESIGN §6.1):上報前先寫本機,主機回 accepted 才刪(PLATFORM-PLAN §4.2「先記本機,再送主機」)。
//! P6-2 加 `upgrade` 表(每個元件一列:目標版本、狀態、失敗次數;Watchdog 中途重啟時據此收尾,P6-UPGRADE-DESIGN §5.2)。
//! 只有服務狀態、版本與事件,不含資產或使用者資料,不加密(需求方 2026-10-19 決定,§9-4);目錄 ACL 只允許 SYSTEM、Administrators。

use crate::upgrade::UpgradeRecord;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::path::Path;

/// 待送事件上限,滿了丟最舊
pub const MAX_EVENTS: i64 = 1000;

pub struct Outbox {
    db: Connection,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredEvent {
    pub event_id: String,
    pub kind: String,
    pub occurred_at: String,
    pub data: Value,
}

impl Outbox {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("無法建立 {}:{e}", dir.display()))?;
        let path = dir.join("watchdog.db");
        let db = Connection::open(&path).map_err(|e| format!("無法開啟 {}:{e}", path.display()))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS outbox_event (
               seq INTEGER PRIMARY KEY AUTOINCREMENT,
               event_id TEXT NOT NULL UNIQUE,
               kind TEXT NOT NULL,
               occurred_at TEXT NOT NULL,
               data TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS upgrade (
               component TEXT PRIMARY KEY,
               target_version TEXT NOT NULL,
               target_sha256 TEXT NOT NULL,
               from_version TEXT,
               state TEXT NOT NULL,
               attempts INTEGER NOT NULL,
               error_code TEXT,
               error_message TEXT,
               started_at TEXT NOT NULL,
               rev INTEGER NOT NULL,
               reported_rev INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS kv (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )
        .map_err(|e| format!("無法初始化 {}:{e}", path.display()))?;
        Ok(Self { db })
    }

    /// 寫一筆事件;回傳因上限丟棄的筆數
    pub fn push(&self, kind: &str, occurred_at: &str, data: &Value) -> Result<usize, String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.db
            .execute(
                "INSERT INTO outbox_event (event_id, kind, occurred_at, data) VALUES (?1, ?2, ?3, ?4)",
                params![id, kind, occurred_at, data.to_string()],
            )
            .map_err(|e| format!("無法寫入本機事件:{e}"))?;
        let dropped = self
            .db
            .execute(
                "DELETE FROM outbox_event WHERE seq <= (SELECT MAX(seq) FROM outbox_event) - ?1",
                params![MAX_EVENTS],
            )
            .map_err(|e| format!("無法清除舊事件:{e}"))?;
        Ok(dropped)
    }

    pub fn batch(&self, limit: usize) -> Result<Vec<StoredEvent>, String> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT event_id, kind, occurred_at, data FROM outbox_event ORDER BY seq LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], |r| {
                Ok(StoredEvent {
                    event_id: r.get(0)?,
                    kind: r.get(1)?,
                    occurred_at: r.get(2)?,
                    data: serde_json::from_str(&r.get::<_, String>(3)?)
                        .unwrap_or(Value::Object(Default::default())),
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| format!("無法讀取本機事件:{e}"))
    }

    pub fn remove(&self, ids: &[String]) -> Result<(), String> {
        for id in ids {
            self.db
                .execute("DELETE FROM outbox_event WHERE event_id = ?1", params![id])
                .map_err(|e| format!("無法刪除已送出的事件:{e}"))?;
        }
        Ok(())
    }

    pub fn upgrade_get(&self, component: &str) -> Result<Option<UpgradeRecord>, String> {
        self.db
            .query_row(
                "SELECT component, target_version, target_sha256, from_version, state, attempts, error_code, error_message, started_at
                 FROM upgrade WHERE component = ?1",
                params![component],
                |r| {
                    Ok(UpgradeRecord {
                        component: r.get(0)?,
                        target_version: r.get(1)?,
                        target_sha256: r.get(2)?,
                        from_version: r.get(3)?,
                        state: r.get(4)?,
                        attempts: r.get(5)?,
                        error_code: r.get(6)?,
                        error_message: r.get(7)?,
                        started_at: r.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("無法讀取本機升級紀錄:{e}"))
    }

    /// 寫入(取代)該元件的紀錄;每次寫入版次加一,上報成功後以版次標記已回報
    pub fn upgrade_save(&self, r: &UpgradeRecord) -> Result<(), String> {
        self.db
            .execute(
                "INSERT INTO upgrade (component, target_version, target_sha256, from_version, state, attempts, error_code, error_message, started_at, rev)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)
                 ON CONFLICT(component) DO UPDATE SET target_version = ?2, target_sha256 = ?3, from_version = ?4, state = ?5, attempts = ?6,
                   error_code = ?7, error_message = ?8, started_at = ?9, rev = rev + 1",
                params![
                    r.component,
                    r.target_version,
                    r.target_sha256,
                    r.from_version,
                    r.state,
                    r.attempts,
                    r.error_code,
                    r.error_message,
                    r.started_at
                ],
            )
            .map(|_| ())
            .map_err(|e| format!("無法寫入本機升級紀錄:{e}"))
    }

    /// 要上報的升級進度:進行中(`active`:升級工作正在執行),或結束後還沒有成功上報過;回傳 (紀錄, 版次)。
    /// 不在執行中的未結束紀錄(下載中 Watchdog 被重啟)不再上報,免得主機一直看到「下載中」(審查建議 4)
    pub fn upgrade_to_report(&self, active: bool) -> Result<Option<(UpgradeRecord, i64)>, String> {
        let row: Option<(String, i64)> = self
            .db
            .query_row(
                "SELECT component, rev FROM upgrade
                 WHERE (?1 = 1 AND state NOT IN ('succeeded', 'failed', 'rolled_back'))
                    OR (state IN ('succeeded', 'failed', 'rolled_back') AND rev > reported_rev)
                 ORDER BY started_at DESC LIMIT 1",
                params![active as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("無法讀取本機升級紀錄:{e}"))?;
        let Some((component, rev)) = row else {
            return Ok(None);
        };
        Ok(self.upgrade_get(&component)?.map(|r| (r, rev)))
    }

    /// 上報成功:這個版次(含)以前的進度已送達
    pub fn upgrade_reported(&self, component: &str, rev: i64) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE upgrade SET reported_rev = ?2 WHERE component = ?1 AND reported_rev < ?2",
                params![component, rev],
            )
            .map(|_| ())
            .map_err(|e| format!("無法更新本機升級紀錄:{e}"))
    }

    /// agent.upgrade(Agent 管道 upgrade_requested):重設失敗次數,讓同一目標可以再試
    pub fn upgrade_reset_attempts(&self, component: &str) -> Result<bool, String> {
        self.db
            .execute(
                "UPDATE upgrade SET attempts = 0, error_code = NULL, rev = rev + 1
                 WHERE component = ?1 AND state IN ('failed', 'rolled_back') AND (attempts > 0 OR error_code IS NOT NULL)",
                params![component],
            )
            .map(|n| n > 0)
            .map_err(|e| format!("無法更新本機升級紀錄:{e}"))
    }

    pub fn upgrade_delete(&self, component: &str) -> Result<(), String> {
        self.db
            .execute(
                "DELETE FROM upgrade WHERE component = ?1",
                params![component],
            )
            .map(|_| ())
            .map_err(|e| format!("無法刪除本機升級紀錄:{e}"))
    }

    pub fn kv_get(&self, key: &str) -> Option<String> {
        self.db
            .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .ok()
            .flatten()
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.db
            .execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![key, value],
            )
            .map(|_| ())
            .map_err(|e| format!("無法寫入本機紀錄:{e}"))
    }

    pub fn count(&self) -> Result<i64, String> {
        self.db
            .query_row("SELECT COUNT(*) FROM outbox_event", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn upgrade_record_roundtrip_and_report_marks() {
        let dir = tempfile::tempdir().unwrap();
        let o = Outbox::open(dir.path()).unwrap();
        assert_eq!(o.upgrade_get("agent").unwrap(), None);
        assert_eq!(o.upgrade_to_report(true).unwrap(), None);
        let mut r = UpgradeRecord {
            component: "agent".into(),
            target_version: "0.7.1".into(),
            target_sha256: "ab".repeat(32),
            from_version: Some("0.7.0".into()),
            state: "downloading".into(),
            attempts: 0,
            error_code: None,
            error_message: None,
            started_at: "2026-10-21T02:00:00.000Z".into(),
        };
        o.upgrade_save(&r).unwrap();
        let (got, rev) = o.upgrade_to_report(true).unwrap().unwrap();
        assert_eq!(got, r);
        // 進行中:即使已回報也照樣帶;升級工作沒在跑(Watchdog 重啟後)就不帶
        o.upgrade_reported("agent", rev).unwrap();
        assert!(o.upgrade_to_report(true).unwrap().is_some());
        assert!(o.upgrade_to_report(false).unwrap().is_none());
        r.state = "rolled_back".into();
        r.attempts = 1;
        r.error_code = Some("HEALTH_CHECK_FAILED".into());
        o.upgrade_save(&r).unwrap();
        let (_, rev2) = o.upgrade_to_report(false).unwrap().unwrap();
        assert!(rev2 > rev);
        o.upgrade_reported("agent", rev2).unwrap();
        assert_eq!(
            o.upgrade_to_report(true).unwrap(),
            None,
            "結束且已回報:不再帶"
        );
        assert!(o.upgrade_reset_attempts("agent").unwrap());
        assert_eq!(o.upgrade_get("agent").unwrap().unwrap().attempts, 0);
        assert!(
            o.upgrade_to_report(false).unwrap().is_some(),
            "重設後再報一次"
        );
        // ROLLBACK_FAILED 也可由 agent.upgrade 解除
        r.state = "failed".into();
        r.error_code = Some("ROLLBACK_FAILED".into());
        r.attempts = 0;
        o.upgrade_save(&r).unwrap();
        assert!(o.upgrade_reset_attempts("agent").unwrap());
        assert_eq!(o.upgrade_get("agent").unwrap().unwrap().error_code, None);
        o.kv_set("k", "1").unwrap();
        o.kv_set("k", "2").unwrap();
        assert_eq!(o.kv_get("k").as_deref(), Some("2"));
        assert_eq!(o.kv_get("none"), None);
        // 重開後仍在
        drop(o);
        let o = Outbox::open(dir.path()).unwrap();
        assert_eq!(o.upgrade_get("agent").unwrap().unwrap().state, "failed");
        assert_eq!(o.kv_get("k").as_deref(), Some("2"));
        o.upgrade_delete("agent").unwrap();
        assert_eq!(o.upgrade_get("agent").unwrap(), None);
    }

    #[test]
    fn push_batch_remove_and_cap() {
        let dir = tempfile::tempdir().unwrap();
        let o = Outbox::open(dir.path()).unwrap();
        o.push(
            "agent_restarted",
            "2026-10-20T00:00:00.000Z",
            &json!({ "cause": "crashed" }),
        )
        .unwrap();
        o.push(
            "agent_service_stopped",
            "2026-10-20T00:01:00.000Z",
            &json!({ "restarted": true }),
        )
        .unwrap();
        let b = o.batch(10).unwrap();
        assert_eq!(
            b.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            ["agent_restarted", "agent_service_stopped"]
        );
        assert_eq!(b[0].data["cause"], "crashed");
        o.remove(&[b[0].event_id.clone()]).unwrap();
        assert_eq!(o.count().unwrap(), 1);
        // 重開後資料仍在
        drop(o);
        let o = Outbox::open(dir.path()).unwrap();
        assert_eq!(o.count().unwrap(), 1);
        let mut dropped = 0;
        for _ in 0..MAX_EVENTS {
            dropped += o
                .push("agent_restarted", "2026-10-20T00:00:00.000Z", &json!({}))
                .unwrap();
        }
        assert_eq!(o.count().unwrap(), MAX_EVENTS);
        assert_eq!(dropped, 1);
        assert_eq!(
            o.batch(1).unwrap()[0].kind,
            "agent_restarted",
            "最舊的一筆被丟棄"
        );
    }
}
