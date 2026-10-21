//! 看守 Watchdog(P5-2;指南 §7.1「互相看守」、PLATFORM-PLAN A5;P5-MONITOR-DESIGN §5.2)。
//!
//! 服務模式每 60 秒查一次 `GigaNexusWatchdog`:
//! - 被手動停止(結束代碼 0)→ 立即啟動並記 `watchdog_stopped`
//! - 啟動類型被改成手動 / 停用 → 改回自動(停止中再啟動)並記 `watchdog_stopped`
//! - 當掉(結束代碼非 0)→ 交給 SCM 失敗復原;下一輪仍停止才自己啟動,不記竄改事件
//! - 服務不存在(被刪除)→ 同一次執行只記一次 `watchdog_missing`,不擋 Agent
//! - 服務設定的程式不是 Agent 同目錄的 `rustit-watchdog.exe`(路徑被改)→ 記一次 `watchdog_binary_changed`
//! - 這次執行還沒看過 Watchdog 在跑(剛安裝、開機時 SCM 還沒啟動它)→ 只啟動,不記竄改事件
//! - 啟動失敗退避 1、2、5、10 分鐘;同一次停止的事件只記前 3 次,之後每小時一次
//!
//! Windows 關機中、Windows Installer 執行中(安裝 / 升級 / 解除安裝)、Agent 自己正在停止時不動作。

use crate::events::EventQueue;
use crate::protocol::now_rfc3339;
use log::{info, warn};
use rustit_common::scm::{self, ExitKind, StartType, SvcInfo, SvcState, WATCHDOG_SERVICE};
use rustit_common::stop::wait;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tokio::sync::watch;

const INTERVAL: Duration = Duration::from_secs(60);
const START_BACKOFF: [u64; 4] = [60, 120, 300, 600];

#[derive(Debug, PartialEq, Eq)]
enum Action {
    None,
    /// 第一次看到不存在
    ReportMissing,
    /// 當掉:先等 SCM 失敗復原
    WaitRecovery,
    /// 自己啟動(restore:先改回自動;tamper:記 watchdog_stopped)
    Start {
        restore: bool,
        tamper: bool,
    },
    /// 執行中但啟動類型被改:只改回自動並記事件
    Restore,
}

/// 看守狀態(跨輪保留)
#[derive(Default)]
struct Guard {
    missing_reported: bool,
    /// 上一輪已看到當掉停止
    crash_waiting: bool,
    /// 這次執行看過 Watchdog 在跑(沒看過的停止是還沒被 SCM 啟動,不是被人停止)
    seen_running: bool,
    /// 已記過程式路徑被改
    binary_reported: bool,
    /// 這次停止已失敗的啟動次數與下次可嘗試的時間
    start_failures: u32,
    next_start: Option<Instant>,
}

impl Guard {
    /// 純函式:依這一輪看到的狀態決定動作
    fn decide(&self, info: &SvcInfo, now: Instant) -> Action {
        if info.state == SvcState::Missing {
            return if self.missing_reported {
                Action::None
            } else {
                Action::ReportMissing
            };
        }
        let changed = matches!(info.start_type, StartType::Manual | StartType::Disabled);
        if info.state == SvcState::Stopped && self.next_start.is_some_and(|t| now < t) {
            return Action::None;
        }
        let tamper = self.seen_running && self.start_failures == 0;
        match (info.state, info.exit) {
            (SvcState::Stopped, ExitKind::Clean) => Action::Start {
                restore: changed,
                tamper,
            },
            (SvcState::Stopped, _) if changed => Action::Start {
                restore: true,
                tamper,
            },
            (SvcState::Stopped, _) if self.crash_waiting || self.start_failures > 0 => {
                Action::Start {
                    restore: false,
                    tamper: false,
                }
            }
            (SvcState::Stopped, _) => Action::WaitRecovery,
            _ if changed => Action::Restore,
            _ => Action::None,
        }
    }

    /// 這一輪看到的狀態更新旗標
    fn observe(&mut self, info: &SvcInfo, action: &Action) {
        self.crash_waiting = *action == Action::WaitRecovery;
        if info.state != SvcState::Missing {
            self.missing_reported = false;
        }
        if info.state == SvcState::Running {
            self.seen_running = true;
            self.start_failures = 0;
            self.next_start = None;
        }
    }

    /// 啟動失敗:退避;回傳這次是否要記事件(前 3 次,之後每 6 次)
    fn start_failed(&mut self, now: Instant) -> bool {
        self.start_failures += 1;
        let wait = START_BACKOFF[(self.start_failures as usize - 1).min(START_BACKOFF.len() - 1)];
        self.next_start = Some(now + Duration::from_secs(wait));
        self.start_failures <= 3 || self.start_failures.is_multiple_of(6)
    }
}

pub async fn run(events: EventQueue, mut stop: watch::Receiver<bool>) {
    let mut guard = Guard::default();
    loop {
        if wait(INTERVAL, &mut stop).await {
            return;
        }
        if crate::SHUTDOWN_REQUESTED.load(Ordering::Relaxed) || scm::hands_off() {
            continue;
        }
        let info = match tokio::task::spawn_blocking(|| scm::query(WATCHDOG_SERVICE)).await {
            Ok(Ok(i)) => i,
            Ok(Err(e)) => {
                warn!("無法查詢 Watchdog 服務:{e}");
                continue;
            }
            Err(e) => {
                warn!("查詢 Watchdog 服務失敗:{e}");
                continue;
            }
        };
        // 程式路徑被改成別的程式(資安稽核 M3):Watchdog 必須是 Agent 同目錄的 rustit-watchdog.exe
        if let (Some(exe), Some(expected)) = (&info.exe, expected_watchdog_exe()) {
            let same = exe
                .to_string_lossy()
                .eq_ignore_ascii_case(&expected.to_string_lossy());
            if !same && !guard.binary_reported {
                warn!("Watchdog 服務的程式被改為 {}", exe.display());
                events.record(
                    "watchdog_binary_changed",
                    now_rfc3339(),
                    json!({ "path": cut260(&exe.to_string_lossy()), "expected": cut260(&expected.to_string_lossy()) }),
                );
            }
            guard.binary_reported = !same;
        }
        let now = Instant::now();
        let action = guard.decide(&info, now);
        guard.observe(&info, &action);
        match action {
            Action::None | Action::WaitRecovery => {}
            Action::ReportMissing => {
                guard.missing_reported = true;
                warn!("Watchdog 服務不存在(被移除或安裝不完整)");
                events.record("watchdog_missing", now_rfc3339(), json!({}));
            }
            Action::Restore => {
                let r = tokio::task::spawn_blocking(|| scm::set_auto_start(WATCHDOG_SERVICE)).await;
                let err = flatten(r).err();
                warn!(
                    "Watchdog 啟動類型被改為 {},已改回自動",
                    info.start_type.as_str()
                );
                events.record(
                    "watchdog_stopped",
                    now_rfc3339(),
                    with_error(json!({ "state": info.state.as_str(), "start_type": info.start_type.as_str(), "restarted": false }), err),
                );
            }
            Action::Start { restore, tamper } => {
                let r = tokio::task::spawn_blocking(move || {
                    if restore {
                        scm::set_auto_start(WATCHDOG_SERVICE)?;
                    }
                    scm::start(WATCHDOG_SERVICE)
                })
                .await;
                let err = flatten(r).err();
                let report = match &err {
                    None => {
                        info!("已啟動 Watchdog 服務");
                        tamper
                    }
                    Some(e) => {
                        warn!("無法啟動 Watchdog 服務:{e}");
                        guard.start_failed(now) && (tamper || guard.seen_running)
                    }
                };
                if report {
                    events.record(
                        "watchdog_stopped",
                        now_rfc3339(),
                        with_error(
                            json!({ "state": info.state.as_str(), "start_type": info.start_type.as_str(), "restarted": err.is_none() }),
                            err,
                        ),
                    );
                }
            }
        }
    }
}

/// Agent 同目錄的 rustit-watchdog.exe(MSI 安裝在同一個目錄)
fn expected_watchdog_exe() -> Option<std::path::PathBuf> {
    Some(
        std::env::current_exe()
            .ok()?
            .parent()?
            .join("rustit-watchdog.exe"),
    )
}

fn cut260(s: &str) -> String {
    s.chars().take(260).collect()
}

fn flatten(r: Result<Result<(), String>, tokio::task::JoinError>) -> Result<(), String> {
    r.map_err(|e| e.to_string()).and_then(|x| x)
}

fn with_error(mut v: serde_json::Value, err: Option<String>) -> serde_json::Value {
    if let Some(e) = err {
        v["error"] = json!(e.chars().take(300).collect::<String>());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(state: SvcState, exit: ExitKind, start_type: StartType) -> SvcInfo {
        SvcInfo {
            state,
            pid: None,
            exit,
            start_type,
            exe: None,
        }
    }

    fn seen() -> Guard {
        Guard {
            seen_running: true,
            ..Default::default()
        }
    }

    #[test]
    fn decisions() {
        let t = Instant::now();
        assert_eq!(
            Guard::default().decide(&SvcInfo::missing(), t),
            Action::ReportMissing
        );
        let reported = Guard {
            missing_reported: true,
            ..Default::default()
        };
        assert_eq!(reported.decide(&SvcInfo::missing(), t), Action::None);
        let running = info(SvcState::Running, ExitKind::Clean, StartType::Auto);
        assert_eq!(seen().decide(&running, t), Action::None);
        let manual_stop = info(SvcState::Stopped, ExitKind::Clean, StartType::Auto);
        assert_eq!(
            seen().decide(&manual_stop, t),
            Action::Start {
                restore: false,
                tamper: true
            }
        );
        let disabled = info(SvcState::Stopped, ExitKind::Clean, StartType::Disabled);
        assert_eq!(
            seen().decide(&disabled, t),
            Action::Start {
                restore: true,
                tamper: true
            }
        );
        let crashed = info(SvcState::Stopped, ExitKind::Failed(1067), StartType::Auto);
        assert_eq!(seen().decide(&crashed, t), Action::WaitRecovery);
        let waiting = Guard {
            crash_waiting: true,
            ..seen()
        };
        assert_eq!(
            waiting.decide(&crashed, t),
            Action::Start {
                restore: false,
                tamper: false
            }
        );
        let running_manual = info(SvcState::Running, ExitKind::Clean, StartType::Manual);
        assert_eq!(seen().decide(&running_manual, t), Action::Restore);
    }

    #[test]
    fn not_yet_started_is_not_tampering() {
        // 剛安裝 / 開機:這次執行還沒看過 Watchdog 在跑,新服務的結束代碼是 0
        let t = Instant::now();
        let stopped = info(SvcState::Stopped, ExitKind::Clean, StartType::Auto);
        assert_eq!(
            Guard::default().decide(&stopped, t),
            Action::Start {
                restore: false,
                tamper: false
            }
        );
    }

    #[test]
    fn start_failures_back_off_and_throttle_events() {
        let t = Instant::now();
        let mut g = seen();
        let stopped = info(SvcState::Stopped, ExitKind::Clean, StartType::Auto);
        assert!(g.start_failed(t), "第 1 次記事件");
        assert_eq!(
            g.decide(&stopped, t + Duration::from_secs(30)),
            Action::None,
            "退避 60 秒內不再試"
        );
        assert_eq!(
            g.decide(&stopped, t + Duration::from_secs(61)),
            Action::Start {
                restore: false,
                tamper: false
            }
        );
        assert!(g.start_failed(t) && g.start_failed(t));
        assert!(!g.start_failed(t), "第 4 次不記");
        g.observe(
            &info(SvcState::Running, ExitKind::Clean, StartType::Auto),
            &Action::None,
        );
        assert_eq!((g.start_failures, g.next_start), (0, None), "跑起來後重設");
    }
}
