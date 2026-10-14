//! 本機持久化 `state\store.db`(PLATFORM-PLAN §4.2;SQLite,rusqlite bundled)。
//!
//! | 資料表 | 內容 | 送達後 | 上限 |
//! | --- | --- | --- | --- |
//! | `kv` | 本機狀態與主機下發設定:agent_seq、device_id、裝置狀態、settings / settings_version | 不刪 | — |
//! | `outbox_inventory` | 尚未確認的資產回報(完整請求 JSON,**加密**);連續相同 hash 只留最新一份 | `/sync` skip 或 `/inventory` 200 後刪除 | 50 份或 20 MB,丟最舊 |
//! | `outbox_event` | 端點事件(data **加密**),保留發生時間 | `/events` accepted 後刪除 | 5,000 筆,丟最舊 |
//! | `conn_log` | 連線中斷期間:開始、最後嘗試、次數、各原因次數、最後錯誤 | 保留 30 天 | 30 天 |
//!
//! 金鑰無法解開(store 被複製到別台電腦)時,把舊檔改名保留、建立新的 store,不讓 Agent 無法啟動。
//! 日誌不寫 payload 與金鑰(AGENT.md §7.1)。

use crate::crypto::{Cipher, KeyError};
use log::warn;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

pub const MAX_INVENTORY_ROWS: i64 = 50;
pub const MAX_INVENTORY_BYTES: i64 = 20 * 1024 * 1024;
pub const MAX_EVENT_ROWS: i64 = 5000;
pub const CONN_LOG_DAYS: i64 = 30;

const DB_FILE: &str = "store.db";

/// 多個背景工作共用;每次操作很短,用一般 Mutex
#[derive(Clone)]
pub struct SharedStore(Arc<Mutex<Store>>);

impl SharedStore {
    pub fn new(store: Store) -> Self {
        Self(Arc::new(Mutex::new(store)))
    }

    /// 某個工作在操作中 panic 時仍可繼續使用(store 的每個操作都是單一交易)
    pub fn lock(&self) -> MutexGuard<'_, Store> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub struct Store {
    conn: Connection,
    cipher: Cipher,
}

/// 尚未確認的資產回報摘要(`/sync` 的 pending)
#[derive(Debug, Clone, PartialEq)]
pub struct PendingInventory {
    pub agent_seq: u64,
    pub collected_at: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredEvent {
    pub event_id: String,
    pub kind: String,
    pub occurred_at: String,
    pub data: Value,
}

/// 一段連線中斷期間(conn_log 中尚未結束的一列)
#[derive(Debug, Clone, PartialEq)]
pub struct Period {
    pub id: i64,
    pub started_at: String,
    pub last_attempt_at: String,
    pub retries: u64,
    pub reasons: BTreeMap<String, u64>,
    pub last_error: String,
}

impl Period {
    /// 次數最多的原因;同次數取字母順序第一個(結果固定)
    pub fn main_reason(&self) -> &str {
        self.reasons
            .iter()
            .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
            .map(|(k, _)| k.as_str())
            .unwrap_or("unknown")
    }
}

type R<T> = Result<T, String>;

/// 開啟失敗:Unreadable(金鑰解不開、資料庫毀損)才重建,其他不動資料
enum OpenError {
    Unreadable(String),
    Other(String),
}

impl From<rusqlite::Error> for OpenError {
    fn from(e: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode::{DatabaseCorrupt, NotADatabase};
        match e.sqlite_error_code() {
            Some(DatabaseCorrupt | NotADatabase) => OpenError::Unreadable(db_err(e)),
            _ => OpenError::Other(db_err(e)),
        }
    }
}

fn db_err(e: rusqlite::Error) -> String {
    format!("本機資料庫錯誤:{e}")
}

impl Store {
    /// 開啟(必要時建立)`dir\store.db`。只有金鑰解不開(複製自別台電腦、毀損)或資料庫毀損時,改名保留舊檔後重建;
    /// 其他錯誤(檔案被占用、權限、磁碟)可能是暫時性的,直接回錯誤(服務結束後由失敗復原重啟再試),不動資料
    pub fn open(dir: &Path) -> R<Self> {
        std::fs::create_dir_all(dir).map_err(|e| format!("無法建立 {}:{e}", dir.display()))?;
        // state 被換成 junction / 符號連結時拒絕使用(避免以 SYSTEM 身分寫到別處,資安稽核 M4)
        let meta = std::fs::symlink_metadata(dir)
            .map_err(|e| format!("無法讀取 {}:{e}", dir.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "{} 是連結(junction / symlink),拒絕使用",
                dir.display()
            ));
        }
        match Self::try_open(dir) {
            Ok(s) => Ok(s),
            Err(OpenError::Other(e)) => Err(e),
            Err(OpenError::Unreadable(e)) => {
                let suffix = chrono::Utc::now().format("%Y%m%d%H%M%S");
                warn!(
                    "本機暫存無法使用({e}),舊檔改名保留(.unreadable-{suffix})並重建;未送出的資料將遺失"
                );
                for name in [DB_FILE, "store.db-wal", "store.db-shm", "store.key"] {
                    let p = dir.join(name);
                    if p.exists() {
                        let target = dir.join(format!("{name}.unreadable-{suffix}"));
                        std::fs::rename(&p, &target)
                            .map_err(|e| format!("無法改名 {}:{e}", p.display()))?;
                    }
                }
                Self::try_open(dir).map_err(|e| match e {
                    OpenError::Unreadable(m) | OpenError::Other(m) => m,
                })
            }
        }
    }

    fn try_open(dir: &Path) -> Result<Self, OpenError> {
        let cipher = Cipher::load_or_create(dir).map_err(|e| match e {
            KeyError::Unreadable(m) => OpenError::Unreadable(m),
            KeyError::Io(m) => OpenError::Other(m),
        })?;
        let conn = Connection::open(dir.join(DB_FILE)).map_err(OpenError::from)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(OpenError::from)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA journal_size_limit = 4194304;
             CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS outbox_inventory (
               agent_seq INTEGER PRIMARY KEY, collected_at TEXT NOT NULL, content_hash TEXT NOT NULL, payload BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS outbox_event (
               seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
               occurred_at TEXT NOT NULL, data BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS conn_log (
               id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, ended_at TEXT, last_attempt_at TEXT NOT NULL,
               retries INTEGER NOT NULL, reasons TEXT NOT NULL, last_error TEXT NOT NULL);",
        )
        .map_err(OpenError::from)?;
        Ok(Self { conn, cipher })
    }

    // ---------- kv ----------

    pub fn get(&self, key: &str) -> R<Option<String>> {
        self.conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .map_err(db_err)
    }

    pub fn set(&self, key: &str, value: &str) -> R<()> {
        self.conn
            .execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
            .map(|_| ())
            .map_err(db_err)
    }

    /// 單調遞增、重啟後仍遞增的 agent_seq(契約);以 Unix 毫秒為下限,與 P2 前的編號相容
    pub fn next_agent_seq(&self, now_ms: u64) -> R<u64> {
        let last = self
            .get("agent_seq")?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let next = (last + 1).max(now_ms);
        self.set("agent_seq", &next.to_string())?;
        Ok(next)
    }

    // ---------- outbox_inventory ----------

    /// 寫入一份資產回報(body 為完整請求 JSON);與最新一份同 hash 時取代之。回傳因超過上限丟棄的份數
    pub fn push_inventory(&self, seq: u64, collected_at: &str, hash: &str, body: &[u8]) -> R<u64> {
        let sealed = self.cipher.seal(body)?;
        let tx = self.conn.unchecked_transaction().map_err(db_err)?;
        tx.execute(
            "DELETE FROM outbox_inventory WHERE agent_seq = (SELECT agent_seq FROM outbox_inventory ORDER BY agent_seq DESC LIMIT 1) AND content_hash = ?1",
            [hash],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT OR REPLACE INTO outbox_inventory (agent_seq, collected_at, content_hash, payload) VALUES (?1, ?2, ?3, ?4)",
            params![seq as i64, collected_at, hash, sealed],
        )
        .map_err(db_err)?;
        let mut dropped = 0u64;
        loop {
            let (rows, bytes): (i64, i64) = tx
                .query_row(
                    "SELECT COUNT(*), COALESCE(SUM(LENGTH(payload)), 0) FROM outbox_inventory",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(db_err)?;
            // 至少保留最新一份
            if rows <= 1 || (rows <= MAX_INVENTORY_ROWS && bytes <= MAX_INVENTORY_BYTES) {
                break;
            }
            tx.execute("DELETE FROM outbox_inventory WHERE agent_seq = (SELECT MIN(agent_seq) FROM outbox_inventory)", [])
                .map_err(db_err)?;
            dropped += 1;
        }
        tx.commit().map_err(db_err)?;
        Ok(dropped)
    }

    /// 由舊到新
    pub fn pending_inventory(&self) -> R<Vec<PendingInventory>> {
        let mut st = self
            .conn
            .prepare("SELECT agent_seq, collected_at, content_hash FROM outbox_inventory ORDER BY agent_seq")
            .map_err(db_err)?;
        let rows = st
            .query_map([], |r| {
                Ok(PendingInventory {
                    agent_seq: r.get::<_, i64>(0)? as u64,
                    collected_at: r.get(1)?,
                    content_hash: r.get(2)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<Result<_, _>>().map_err(db_err)
    }

    /// 解密後的請求 JSON;不存在、或無法解密(刪除該筆並記日誌)回 None;讀取失敗回錯誤
    pub fn inventory_body(&self, seq: u64) -> R<Option<Vec<u8>>> {
        let sealed: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT payload FROM outbox_inventory WHERE agent_seq = ?1",
                [seq as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(sealed) = sealed else {
            return Ok(None);
        };
        match self.cipher.open(&sealed) {
            Ok(body) => Ok(Some(body)),
            Err(e) => {
                self.delete_inventory(&[seq])?;
                warn!("暫存的資產回報 seq={seq} 無法解密,已刪除:{e}");
                Ok(None)
            }
        }
    }

    /// 回傳實際刪除的份數
    pub fn delete_inventory(&self, seqs: &[u64]) -> R<usize> {
        let mut st = self
            .conn
            .prepare("DELETE FROM outbox_inventory WHERE agent_seq = ?1")
            .map_err(db_err)?;
        let mut n = 0;
        for s in seqs {
            n += st.execute([*s as i64]).map_err(db_err)?;
        }
        Ok(n)
    }

    // ---------- outbox_event ----------

    /// 寫入事件,回傳 (event_id, 因超過上限丟棄的筆數)
    pub fn push_event(&self, kind: &str, occurred_at: &str, data: &Value) -> R<(String, u64)> {
        let id = uuid::Uuid::new_v4().to_string();
        let sealed = self.cipher.seal(data.to_string().as_bytes())?;
        self.conn
            .execute(
                "INSERT INTO outbox_event (event_id, kind, occurred_at, data) VALUES (?1, ?2, ?3, ?4)",
                params![id, kind, occurred_at, sealed],
            )
            .map_err(db_err)?;
        let dropped = self
            .conn
            .execute(
                "DELETE FROM outbox_event WHERE seq IN (SELECT seq FROM outbox_event ORDER BY seq DESC LIMIT -1 OFFSET ?1)",
                [MAX_EVENT_ROWS],
            )
            .map_err(db_err)? as u64;
        Ok((id, dropped))
    }

    /// 最舊的 limit 筆;無法解密的直接刪除
    pub fn event_batch(&self, limit: usize) -> R<Vec<StoredEvent>> {
        let rows: Vec<(String, String, String, Vec<u8>)> = {
            let mut st = self
                .conn
                .prepare("SELECT event_id, kind, occurred_at, data FROM outbox_event ORDER BY seq LIMIT ?1")
                .map_err(db_err)?;
            st.query_map([limit as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(db_err)?
            .collect::<Result<_, _>>()
            .map_err(db_err)?
        };
        let mut out = Vec::with_capacity(rows.len());
        for (event_id, kind, occurred_at, sealed) in rows {
            match self
                .cipher
                .open(&sealed)
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            {
                Some(data) => out.push(StoredEvent {
                    event_id,
                    kind,
                    occurred_at,
                    data,
                }),
                None => {
                    warn!("暫存的事件 {event_id}({kind})無法解密,已刪除");
                    self.delete_events(&[event_id])?;
                }
            }
        }
        Ok(out)
    }

    pub fn delete_events(&self, ids: &[String]) -> R<()> {
        let mut st = self
            .conn
            .prepare("DELETE FROM outbox_event WHERE event_id = ?1")
            .map_err(db_err)?;
        for id in ids {
            st.execute([id]).map_err(db_err)?;
        }
        Ok(())
    }

    /// (暫存的資產份數, 暫存的事件筆數)
    pub fn counts(&self) -> R<(u64, u64)> {
        self.conn
            .query_row("SELECT (SELECT COUNT(*) FROM outbox_inventory), (SELECT COUNT(*) FROM outbox_event)", [], |r| {
                Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))
            })
            .map_err(db_err)
    }

    // ---------- conn_log ----------

    pub fn open_period(&self) -> R<Option<Period>> {
        self.conn
            .query_row(
                "SELECT id, started_at, last_attempt_at, retries, reasons, last_error FROM conn_log WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1",
                [],
                |r| {
                    let reasons: String = r.get(4)?;
                    Ok(Period {
                        id: r.get(0)?,
                        started_at: r.get(1)?,
                        last_attempt_at: r.get(2)?,
                        retries: r.get::<_, i64>(3)? as u64,
                        reasons: serde_json::from_str(&reasons).unwrap_or_default(),
                        last_error: r.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(db_err)
    }

    /// 記一次失敗:沒有進行中的期間就開始一段,否則只更新次數與最後原因(不逐筆寫,PLATFORM-PLAN §4.2 第 1 點)
    pub fn record_failure(&self, at: &str, reason: &str, error: &str) -> R<Period> {
        // 去除控制字元(主機或中間設備回應可能夾帶換行、ANSI 控制碼;日誌與上傳時不可偽造換行)
        let error: String = error
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(300)
            .collect();
        let mut p = match self.open_period()? {
            Some(p) => p,
            None => {
                self.conn
                    .execute(
                        "INSERT INTO conn_log (started_at, last_attempt_at, retries, reasons, last_error) VALUES (?1, ?1, 0, '{}', '')",
                        [at],
                    )
                    .map_err(db_err)?;
                Period {
                    id: self.conn.last_insert_rowid(),
                    started_at: at.to_string(),
                    last_attempt_at: at.to_string(),
                    retries: 0,
                    reasons: BTreeMap::new(),
                    last_error: String::new(),
                }
            }
        };
        p.retries += 1;
        *p.reasons.entry(reason.to_string()).or_default() += 1;
        p.last_attempt_at = at.to_string();
        p.last_error = error;
        self.conn
            .execute(
                "UPDATE conn_log SET last_attempt_at = ?2, retries = ?3, reasons = ?4, last_error = ?5 WHERE id = ?1",
                params![p.id, p.last_attempt_at, p.retries as i64, serde_json::to_string(&p.reasons).unwrap_or_default(), p.last_error],
            )
            .map_err(db_err)?;
        Ok(p)
    }

    pub fn close_period(&self, id: i64, ended_at: &str) -> R<()> {
        self.conn
            .execute(
                "UPDATE conn_log SET ended_at = ?2 WHERE id = ?1",
                params![id, ended_at],
            )
            .map(|_| ())
            .map_err(db_err)
    }

    /// 刪除早於 before(RFC 3339)且已結束的連線紀錄
    pub fn purge_conn_log(&self, before: &str) -> R<u64> {
        self.conn
            .execute(
                "DELETE FROM conn_log WHERE ended_at IS NOT NULL AND ended_at < ?1",
                [before],
            )
            .map(|n| n as u64)
            .map_err(db_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path()).unwrap();
        (dir, s)
    }

    #[test]
    fn agent_seq_is_monotonic_across_reopen() {
        let (dir, s) = open();
        assert_eq!(s.next_agent_seq(1000).unwrap(), 1000);
        assert_eq!(s.next_agent_seq(500).unwrap(), 1001, "時鐘倒退仍遞增");
        drop(s);
        let s = Store::open(dir.path()).unwrap();
        assert_eq!(s.next_agent_seq(900).unwrap(), 1002);
        assert_eq!(s.next_agent_seq(5000).unwrap(), 5000);
    }

    #[test]
    fn inventory_outbox_dedups_consecutive_hash_and_encrypts() {
        let (dir, s) = open();
        s.push_inventory(
            1,
            "2026-10-06T08:00:00.000Z",
            "aa",
            b"{\"host\":\"PC-EXAMPLE-01\"}",
        )
        .unwrap();
        s.push_inventory(
            2,
            "2026-10-06T09:00:00.000Z",
            "aa",
            b"{\"host\":\"PC-EXAMPLE-01\"}",
        )
        .unwrap();
        s.push_inventory(3, "2026-10-06T10:00:00.000Z", "bb", b"{}")
            .unwrap();
        let p = s.pending_inventory().unwrap();
        assert_eq!(
            p.iter().map(|x| x.agent_seq).collect::<Vec<_>>(),
            vec![2, 3],
            "連續相同 hash 只留最新"
        );
        assert_eq!(
            s.inventory_body(2).unwrap().unwrap(),
            b"{\"host\":\"PC-EXAMPLE-01\"}"
        );
        let raw = std::fs::read(dir.path().join(DB_FILE)).unwrap();
        assert!(
            !raw.windows(13).any(|w| w == b"PC-EXAMPLE-01"),
            "payload 加密"
        );
        s.delete_inventory(&[2]).unwrap();
        assert_eq!(s.counts().unwrap(), (1, 0));
    }

    #[test]
    fn inventory_outbox_cap_drops_oldest() {
        let (_d, s) = open();
        let mut dropped = 0;
        for i in 0..(MAX_INVENTORY_ROWS as u64 + 3) {
            dropped += s
                .push_inventory(
                    i + 1,
                    "2026-10-06T08:00:00.000Z",
                    &format!("{i:064x}"),
                    b"{}",
                )
                .unwrap();
        }
        assert_eq!(dropped, 3);
        let p = s.pending_inventory().unwrap();
        assert_eq!(p.len() as i64, MAX_INVENTORY_ROWS);
        assert_eq!(p[0].agent_seq, 4);
    }

    #[test]
    fn events_roundtrip_and_cap() {
        let (_d, s) = open();
        let (id, _) = s
            .push_event(
                "usb_inserted",
                "2026-10-06T09:30:12.004Z",
                &json!({ "drive": "E:" }),
            )
            .unwrap();
        let batch = s.event_batch(10).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].event_id, id);
        assert_eq!(batch[0].data["drive"], "E:");
        s.delete_events(&[id]).unwrap();
        assert!(s.event_batch(10).unwrap().is_empty());

        s.conn.execute_batch("BEGIN").unwrap();
        for _ in 0..MAX_EVENT_ROWS {
            s.push_event("x", "2026-10-06T09:00:00Z", &json!({}))
                .unwrap();
        }
        s.conn.execute_batch("COMMIT").unwrap();
        let (_, dropped) = s
            .push_event("last", "2026-10-06T10:00:00Z", &json!({}))
            .unwrap();
        assert_eq!(dropped, 1);
        assert_eq!(s.counts().unwrap().1 as i64, MAX_EVENT_ROWS);
    }

    #[test]
    fn conn_log_period() {
        let (_d, s) = open();
        assert!(s.open_period().unwrap().is_none());
        s.record_failure("2026-10-06T09:00:00.000Z", "network", "e1")
            .unwrap();
        s.record_failure("2026-10-06T09:00:05.000Z", "network", "e2")
            .unwrap();
        let p = s
            .record_failure("2026-10-06T09:00:10.000Z", "tls", "e3")
            .unwrap();
        assert_eq!(
            (
                p.retries,
                p.main_reason(),
                p.started_at.as_str(),
                p.last_error.as_str()
            ),
            (3, "network", "2026-10-06T09:00:00.000Z", "e3")
        );
        s.close_period(p.id, "2026-10-06T09:01:00.000Z").unwrap();
        assert!(s.open_period().unwrap().is_none());
        assert_eq!(s.purge_conn_log("2026-10-07T00:00:00.000Z").unwrap(), 1);
    }

    #[test]
    fn unreadable_key_is_set_aside() {
        let (dir, s) = open();
        s.push_inventory(1, "2026-10-06T08:00:00.000Z", "aa", b"{}")
            .unwrap();
        drop(s);
        // 模擬複製到別台電腦:金鑰檔無法解開(非 Windows 時改成長度錯誤)
        std::fs::write(dir.path().join("store.key"), b"not-a-valid-key").unwrap();
        let s = Store::open(dir.path()).unwrap();
        assert!(s.pending_inventory().unwrap().is_empty(), "重建新的 store");
        drop(s);
        // 資料庫檔毀損也重建
        for f in ["store.db-wal", "store.db-shm"] {
            let _ = std::fs::remove_file(dir.path().join(f));
        }
        std::fs::write(dir.path().join(DB_FILE), [b'x'; 4096]).unwrap();
        assert!(Store::open(dir.path()).is_ok());
        assert!(std::fs::read_dir(dir.path()).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".unreadable-")
        }));
    }
}
