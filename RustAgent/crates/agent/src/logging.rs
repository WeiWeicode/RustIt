//! 服務模式的檔案日誌(PLATFORM-PLAN §3.2):每日一檔 `agent-YYYY-MM-DD.log`、保留 14 天、單檔上限 10 MB。
//!
//! 服務沒有主控台,日誌只能寫檔。超過當日上限時寫一行說明後停止寫入到隔天(不輪替,避免磁碟被單日異常塞滿)。
//! 日誌不可含憑證私鑰、Token、完整軟體清單(AGENT.md §7.1),由呼叫端負責。
//! 第三方套件(reqwest、hyper、rustls、tungstenite)的 debug / trace 可能含標頭或完整內容,檔案日誌只收它們 warn 以上;
//! `log_level` 只調整本程式(target 以 `rustit` 開頭)的等級。

use chrono::{Local, NaiveDate};
use log::{LevelFilter, Log, Metadata, Record};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const KEEP_DAYS: i64 = 14;
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const PREFIX: &str = "agent-";
const SUFFIX: &str = ".log";
/// 開檔失敗(目錄被刪、防毒暫時鎖檔)後,隔多久再試
const REOPEN_AFTER: Duration = Duration::from_secs(60);

pub struct FileLogger {
    dir: PathBuf,
    max_bytes: u64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    date: Option<NaiveDate>,
    file: Option<File>,
    size: u64,
    full: bool,
    retry_at: Option<Instant>,
}

impl FileLogger {
    pub fn new(dir: PathBuf, max_bytes: u64) -> Self {
        Self {
            dir,
            max_bytes,
            state: Mutex::new(State::default()),
        }
    }

    /// 安裝為全域 logger;等級之後可用 `log::set_max_level` 依設定檔調整
    pub fn install(dir: PathBuf, level: LevelFilter) -> Result<(), String> {
        fs::create_dir_all(&dir).map_err(|e| format!("無法建立日誌目錄 {}:{e}", dir.display()))?;
        log::set_boxed_logger(Box::new(Self::new(dir, MAX_FILE_BYTES)))
            .map_err(|e| format!("日誌已初始化:{e}"))?;
        log::set_max_level(level);
        Ok(())
    }

    /// 鎖中毒(寫日誌時 panic)後仍繼續使用
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn write_line(&self, date: NaiveDate, line: &str) {
        let mut st = self.state();
        if st.date != Some(date) && st.retry_at.is_none_or(|t| Instant::now() >= t) {
            remove_expired(&self.dir, date);
            let path = self.dir.join(file_name(date));
            match OpenOptions::new().create(true).append(true).open(&path) {
                Ok(f) => {
                    st.size = f.metadata().map_or(0, |m| m.len());
                    // 重啟後檔案已達上限:不再寫,也不重複寫說明行
                    st.full = st.size >= self.max_bytes;
                    st.file = Some(f);
                    st.date = Some(date);
                    st.retry_at = None;
                }
                Err(_) => {
                    // 不記下日期,稍後重試;失敗期間的日誌丟棄(無處可寫)
                    st.file = None;
                    st.retry_at = Some(Instant::now() + REOPEN_AFTER);
                }
            }
        }
        if st.full {
            return;
        }
        let max = self.max_bytes;
        let State {
            file, size, full, ..
        } = &mut *st;
        let Some(f) = file.as_mut() else { return };
        if *size + line.len() as u64 > max {
            let _ = writeln!(
                f,
                "日誌已達單日上限 {} MB,今天之後的紀錄不再寫入",
                max / 1024 / 1024
            );
            *full = true;
            return;
        }
        if f.write_all(line.as_bytes()).is_ok() {
            *size += line.len() as u64;
        }
    }
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let max = if metadata.target().starts_with("rustit") {
            log::max_level()
        } else {
            log::max_level().min(LevelFilter::Warn)
        };
        metadata.level() <= max
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let now = Local::now();
        let line = format!(
            "{} {:<5} {} {}\n",
            now.format("%Y-%m-%d %H:%M:%S%.3f"),
            record.level(),
            record.target(),
            record.args()
        );
        self.write_line(now.date_naive(), &line);
    }

    fn flush(&self) {
        if let Some(f) = self.state().file.as_mut() {
            let _ = f.flush();
        }
    }
}

pub fn file_name(date: NaiveDate) -> String {
    format!("{PREFIX}{}{SUFFIX}", date.format("%Y-%m-%d"))
}

/// 檔名的日期早於保留期限就算過期;不是本程式的檔名一律不動
pub fn is_expired(name: &str, today: NaiveDate) -> bool {
    let Some(date) = name
        .strip_prefix(PREFIX)
        .and_then(|s| s.strip_suffix(SUFFIX))
    else {
        return false;
    };
    NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok_and(|d| (today - d).num_days() >= KEEP_DAYS)
}

fn remove_expired(dir: &Path, today: NaiveDate) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_str()
            .is_some_and(|n| is_expired(n, today))
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rustit-agent-log-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 保留 14 天:第 14 天起刪除;其他檔案不動
    #[test]
    fn expiry_by_file_name() {
        let today = d("2026-10-20");
        assert!(!is_expired("agent-2026-10-07.log", today));
        assert!(is_expired("agent-2026-10-06.log", today));
        assert!(!is_expired("agent.toml", today));
        assert!(!is_expired("agent-bad.log", today));
        assert_eq!(file_name(today), "agent-2026-10-20.log");
    }

    /// 換日時開新檔並清掉過期檔
    #[test]
    fn rotates_daily_and_removes_expired() {
        let dir = temp_dir("rotate");
        fs::write(dir.join("agent-2026-09-01.log"), "old").unwrap();
        fs::write(dir.join("other.txt"), "keep").unwrap();
        let logger = FileLogger::new(dir.clone(), MAX_FILE_BYTES);
        logger.write_line(d("2026-10-19"), "a\n");
        logger.write_line(d("2026-10-20"), "b\n");
        assert_eq!(
            fs::read_to_string(dir.join("agent-2026-10-19.log")).unwrap(),
            "a\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("agent-2026-10-20.log")).unwrap(),
            "b\n"
        );
        assert!(!dir.join("agent-2026-09-01.log").exists());
        assert!(dir.join("other.txt").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    /// 超過單日上限:寫一行說明後停止,隔天恢復
    #[test]
    fn stops_at_daily_limit() {
        let dir = temp_dir("limit");
        let logger = FileLogger::new(dir.clone(), 10);
        logger.write_line(d("2026-10-20"), "12345\n");
        logger.write_line(d("2026-10-20"), "67890\n");
        logger.write_line(d("2026-10-20"), "x\n");
        let text = fs::read_to_string(dir.join("agent-2026-10-20.log")).unwrap();
        assert!(text.starts_with("12345\n"));
        assert!(text.contains("單日上限"));
        assert!(!text.contains("67890") && !text.contains("x\n"));
        logger.write_line(d("2026-10-21"), "y\n");
        assert_eq!(
            fs::read_to_string(dir.join("agent-2026-10-21.log")).unwrap(),
            "y\n"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    /// 第三方套件只收 warn 以上;本程式依 max_level
    #[test]
    fn third_party_capped_at_warn() {
        let logger = FileLogger::new(std::env::temp_dir(), MAX_FILE_BYTES);
        log::set_max_level(LevelFilter::Debug);
        let meta = |target, level| Metadata::builder().target(target).level(level).build();
        assert!(logger.enabled(&meta("rustit_agent::ws", log::Level::Debug)));
        assert!(!logger.enabled(&meta("hyper::proto", log::Level::Debug)));
        assert!(!logger.enabled(&meta("rustls::client", log::Level::Info)));
        assert!(logger.enabled(&meta("rustls::client", log::Level::Warn)));
    }

    /// 重啟後當天檔案已達上限:不再寫入,也不重複寫說明行
    #[test]
    fn full_file_stays_full_after_restart() {
        let dir = temp_dir("restart");
        fs::write(dir.join("agent-2026-10-20.log"), "0123456789").unwrap();
        let logger = FileLogger::new(dir.clone(), 10);
        logger.write_line(d("2026-10-20"), "x\n");
        assert_eq!(
            fs::read_to_string(dir.join("agent-2026-10-20.log")).unwrap(),
            "0123456789"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    /// 開檔失敗不記下日期,目錄恢復後(到重試時間)可再寫
    #[test]
    fn retries_after_open_failure() {
        let dir = temp_dir("retry").join("missing");
        let logger = FileLogger::new(dir.clone(), MAX_FILE_BYTES);
        logger.write_line(d("2026-10-20"), "lost\n");
        assert!(logger.state().date.is_none());
        fs::create_dir_all(&dir).unwrap();
        logger.state().retry_at = Some(Instant::now());
        logger.write_line(d("2026-10-20"), "ok\n");
        assert_eq!(
            fs::read_to_string(dir.join("agent-2026-10-20.log")).unwrap(),
            "ok\n"
        );
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
