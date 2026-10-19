//! Watchdog 本機紀錄 `state\watchdog.db`(SQLite;P5-MONITOR-DESIGN §6.1):上報前先寫本機,主機回 accepted 才刪(PLATFORM-PLAN §4.2「先記本機,再送主機」)。
//! 只有服務狀態、版本與事件,不含資產或使用者資料,不加密(需求方 2026-10-19 決定,§9-4);目錄 ACL 只允許 SYSTEM、Administrators。

use rusqlite::{Connection, params};
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
