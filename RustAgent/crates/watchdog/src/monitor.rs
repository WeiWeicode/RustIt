//! 看守 Agent 的狀態機(P5-MONITOR-DESIGN §6.2;指南 §7.1)。每 30 秒由 [`crate::run`] 呼叫一次 [`Monitor::tick`]:
//! 輸入這一輪 SCM 看到的 Agent 服務與本機管道 `get_status` 結果,透過 [`AgentControl`] 執行動作,回傳要上報的事件。
//!
//! | 情況 | 動作 | 事件 |
//! | --- | --- | --- |
//! | 執行中、PID 和上次不同 | 等新行程的 `get_status` 回報上次結束原因 | `agent_restarted`(crashed / hung / restart_command) |
//! | 執行中、管道曾正常但連續 3 次失敗 | 停止(逾時結束行程)→ 啟動 | 下一輪 `agent_restarted`(hung) |
//! | 已停止、結束代碼 0、這次執行曾看過它在跑 | 立即啟動 | `agent_service_stopped` |
//! | 已停止、結束代碼非 0 | 等 90 秒(SCM 失敗復原最長 60 秒)仍停止才啟動 | 啟動失敗時 `agent_start_failed` |
//! | 啟動類型不是自動 | 改回自動 | `agent_start_type_changed` |
//! | 服務或程式不存在 | 只記錄(Watchdog 不能自己重裝) | `agent_binary_missing` |
//!
//! - Windows 關機中、Windows Installer 執行中不動作;管道從未成功過(舊版 Agent 沒有管道、剛啟動)不判定卡住
//! - 這次執行還沒看過 Agent 在跑就看到它停止(開機時 Watchdog 先啟動):啟動但不記竄改事件
//! - 啟動失敗退避 1、2、5、10 分鐘,之後每 10 分鐘

use rustit_common::scm::{ExitKind, StartType, SvcInfo, SvcState};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::path::Path;
use std::time::{Duration, Instant};

/// 對 Agent 服務的操作(正式為 SCM,測試用假實作)
pub trait AgentControl {
    fn start(&self) -> Result<(), String>;
    /// 送出停止,逾時就結束行程
    fn stop_or_kill(&self, pid: Option<u32>) -> Result<(), String>;
    fn set_auto_start(&self) -> Result<(), String>;
    fn exe_exists(&self, path: &Path) -> bool;
    fn shutting_down(&self) -> bool;
}

/// 本機管道 `status` 的內容(pipe.schema.json StatusBody;只取用得到的欄位)
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct AgentStatus {
    pub version: String,
    pub pid: u32,
    #[serde(default)]
    pub ws_connected: bool,
    #[serde(default)]
    pub last_heartbeat_ack: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub cert_not_after: Option<String>,
    #[serde(default)]
    pub previous_exit: Option<String>,
    /// agent.upgrade 指令(P6-2):Watchdog 看到新的 id 就重設失敗次數並立即上報
    #[serde(default)]
    pub upgrade_requested: Option<UpgradeRequested>,
}

/// 管道 status.upgrade_requested(pipe.schema.json)
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct UpgradeRequested {
    pub id: String,
    pub component: String,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub kind: &'static str,
    pub data: Value,
}

/// 管道連續失敗幾次判定卡住(30 秒一次 = 90 秒)
pub const HUNG_FAILURES: u32 = 3;
/// 當掉後等 SCM 失敗復原的寬限
pub const RECOVERY_GRACE: Duration = Duration::from_secs(90);
/// 新 PID 等幾輪管道回報上次結束原因(舊版 Agent 沒有管道時改用 SCM 看到的結束代碼)
const PENDING_TICKS: u32 = 3;
const START_BACKOFF: [u64; 4] = [60, 120, 300, 600];
const DAY: Duration = Duration::from_secs(24 * 3600);
/// 1 小時內非正常重啟達此次數視為反覆當掉:當掉後的寬限拉長到 CRASH_LOOP_GRACE(SCM 失敗復原照常)
const CRASH_LOOP_RESTARTS: usize = 3;
const CRASH_LOOP_GRACE: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy)]
struct PendingRestart {
    prev: u32,
    pid: u32,
    waited: u32,
    /// 新 PID 出現前,SCM 看到的停止方式(沒看到為 None)
    stop: Option<ExitKind>,
}

#[derive(Default)]
pub struct Monitor {
    last_pid: Option<u32>,
    /// 管道對這個 PID 成功過(才判定卡住)
    pipe_ok_pid: Option<u32>,
    probe_failures: u32,
    /// 因卡住被 Watchdog 重啟的舊 PID
    hung_pid: Option<u32>,
    pending: Option<PendingRestart>,
    stopped_since: Option<Instant>,
    stop_kind: Option<ExitKind>,
    /// 這次停止已處理過「被手動停止」
    manual_handled: bool,
    start_attempts: u32,
    next_start: Option<Instant>,
    missing_reported: bool,
    /// 服務設定的程式應該是這支(服務模式:Watchdog 同目錄的 rustit-agent.exe);None = 不檢查(開發前景模式)
    pub expected_exe: Option<std::path::PathBuf>,
    binary_reported: bool,
    restarts: VecDeque<Instant>,
    /// 上報用
    pub last_status: Option<AgentStatus>,
    pub last_status_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_probe_error: Option<String>,
}

impl Monitor {
    pub fn new() -> Self {
        Self::default()
    }

    /// 維護中(升級)結束:升級期間的停止 / 換行程不算重啟或竄改,重新以目前狀態為基準(24 小時重啟次數保留)
    pub fn resync(&mut self) {
        let expected = self.expected_exe.take();
        let restarts = std::mem::take(&mut self.restarts);
        *self = Self::default();
        self.expected_exe = expected;
        self.restarts = restarts;
    }

    /// 24 小時內非正常重啟(crashed + hung)次數
    pub fn restarts_24h(&mut self, now: Instant) -> u32 {
        while self
            .restarts
            .front()
            .is_some_and(|t| now.duration_since(*t) > DAY)
        {
            self.restarts.pop_front();
        }
        self.restarts.len() as u32
    }

    pub fn tick(
        &mut self,
        ctl: &dyn AgentControl,
        info: &SvcInfo,
        probe: Option<Result<AgentStatus, String>>,
        now: Instant,
    ) -> Vec<Event> {
        let mut events = Vec::new();
        if ctl.shutting_down() {
            return events;
        }
        let exe_missing = info.exe.as_deref().is_some_and(|p| !ctl.exe_exists(p));
        if info.state == SvcState::Missing || exe_missing {
            if !self.missing_reported {
                self.missing_reported = true;
                let mut data = json!({ "service_missing": info.state == SvcState::Missing });
                if let Some(p) = &info.exe {
                    data["path"] = json!(p.to_string_lossy().chars().take(260).collect::<String>());
                }
                events.push(Event {
                    kind: "agent_binary_missing",
                    data,
                });
            }
            return events;
        }
        self.missing_reported = false;

        // 程式路徑被改成別的程式(資安稽核 M3):新行程沒有管道也不會被判定卡住,要另外偵測
        if let (Some(exe), Some(expected)) = (&info.exe, &self.expected_exe) {
            let same = exe
                .to_string_lossy()
                .eq_ignore_ascii_case(&expected.to_string_lossy());
            if !same && !self.binary_reported {
                log::warn!("Agent 服務的程式被改為 {}", exe.display());
                events.push(Event {
                    kind: "agent_binary_changed",
                    data: json!({
                        "path": exe.to_string_lossy().chars().take(260).collect::<String>(),
                        "expected": expected.to_string_lossy().chars().take(260).collect::<String>(),
                    }),
                });
            }
            self.binary_reported = !same;
        }

        if matches!(info.start_type, StartType::Manual | StartType::Disabled) {
            let r = ctl.set_auto_start();
            events.push(Event {
                kind: "agent_start_type_changed",
                data: with_error(json!({ "from": info.start_type.as_str(), "to": "auto", "restored": r.is_ok() }), r.err()),
            });
        }

        match info.state {
            SvcState::Running => self.on_running(ctl, info, probe, now, &mut events),
            SvcState::Stopped => self.on_stopped(ctl, info, now, &mut events),
            _ => {}
        }
        events
    }

    fn on_running(
        &mut self,
        ctl: &dyn AgentControl,
        info: &SvcInfo,
        probe: Option<Result<AgentStatus, String>>,
        now: Instant,
        events: &mut Vec<Event>,
    ) {
        self.stopped_since = None;
        self.manual_handled = false;
        self.start_attempts = 0;
        self.next_start = None;
        if let (Some(prev), Some(pid)) = (self.last_pid, info.pid)
            && prev != pid
        {
            // 上一次重啟還沒等到原因就又換了行程(快速連續當掉):先依 SCM 看到的結束代碼記下,不漏算
            if let Some(p) = self.pending.take() {
                let cause = self.cause_without_pipe(&p, p.stop.or(Some(ExitKind::Failed(0))));
                self.emit_restart(cause, p, now, events);
            }
            self.pending = Some(PendingRestart {
                prev,
                pid,
                waited: 0,
                stop: self.stop_kind,
            });
            self.probe_failures = 0;
        }
        self.stop_kind = None;
        if info.pid.is_some() {
            self.last_pid = info.pid;
        }
        match probe {
            Some(Ok(status)) => {
                self.probe_failures = 0;
                self.pipe_ok_pid = info.pid;
                self.last_probe_error = None;
                self.last_status_at = Some(chrono::Utc::now());
                if let Some(p) = self.pending.take() {
                    let cause = if self.hung_pid == Some(p.prev) {
                        Some("hung")
                    } else {
                        match status.previous_exit.as_deref() {
                            Some("unexpected") => Some("crashed"),
                            Some("restart_command") => Some("restart_command"),
                            // stop(手動停止已另記)、shutdown、first_run 不是重啟異常
                            Some(_) => None,
                            None => fallback_cause(p.stop),
                        }
                    };
                    self.emit_restart(cause, p, now, events);
                }
                self.last_status = Some(status);
            }
            Some(Err(e)) => {
                self.last_probe_error = Some(e);
                if let Some(mut p) = self.pending.take() {
                    p.waited += 1;
                    if p.waited >= PENDING_TICKS {
                        let cause = self.cause_without_pipe(&p, p.stop);
                        self.emit_restart(cause, p, now, events);
                    } else {
                        self.pending = Some(p);
                    }
                }
                // 管道對這個行程成功過才判定卡住(舊版 Agent 沒有管道、剛啟動時不算)
                if info.pid.is_some() && self.pipe_ok_pid == info.pid {
                    self.probe_failures += 1;
                    if self.probe_failures >= HUNG_FAILURES {
                        log::warn!(
                            "Agent 本機管道連續 {HUNG_FAILURES} 次沒有回應,判定卡住並重新啟動"
                        );
                        self.probe_failures = 0;
                        self.pipe_ok_pid = None;
                        self.hung_pid = info.pid;
                        if let Err(e) = ctl.stop_or_kill(info.pid).and_then(|_| ctl.start()) {
                            log::warn!("重新啟動卡住的 Agent 失敗:{e}");
                        }
                    }
                }
            }
            None => {}
        }
    }

    /// 沒有管道回報時的原因:卡住被 Watchdog 重啟的優先,否則看結束代碼
    fn cause_without_pipe(
        &self,
        p: &PendingRestart,
        stop: Option<ExitKind>,
    ) -> Option<&'static str> {
        if self.hung_pid == Some(p.prev) {
            Some("hung")
        } else {
            fallback_cause(stop)
        }
    }

    fn emit_restart(
        &mut self,
        cause: Option<&'static str>,
        p: PendingRestart,
        now: Instant,
        events: &mut Vec<Event>,
    ) {
        let Some(cause) = cause else { return };
        if cause != "restart_command" {
            self.restarts.push_back(now);
        }
        events.push(Event {
            kind: "agent_restarted",
            data: json!({ "cause": cause, "previous_pid": p.prev, "pid": p.pid }),
        });
    }

    fn on_stopped(
        &mut self,
        ctl: &dyn AgentControl,
        info: &SvcInfo,
        now: Instant,
        events: &mut Vec<Event>,
    ) {
        self.stop_kind = Some(info.exit);
        // 新行程還沒回報原因就又停止:依這次看到的結束代碼記下上一次的重啟,不丟掉
        if let Some(p) = self.pending.take() {
            let cause = self.cause_without_pipe(&p, p.stop.or(Some(info.exit)));
            self.emit_restart(cause, p, now, events);
        }
        let since = *self.stopped_since.get_or_insert(now);
        if self.next_start.is_some_and(|t| now < t) {
            return;
        }
        let manual = info.exit == ExitKind::Clean;
        if manual && !self.manual_handled {
            self.manual_handled = true;
            let r = ctl.start();
            // 這次執行看過它在跑才算被人停止;否則是開機時 Watchdog 先啟動
            if self.last_pid.is_some() {
                log::warn!("Agent 服務被手動停止,重新啟動");
                events.push(Event {
                    kind: "agent_service_stopped",
                    data: with_error(json!({ "state": "stopped", "start_type": info.start_type.as_str(), "restarted": r.is_ok() }), r.clone().err()),
                });
            }
            if let Err(e) = r {
                self.start_failed(e, now, events);
            }
            return;
        }
        // 反覆當掉時拉長寬限,交給 SCM 失敗復原,不每 30 秒就拉起來一次
        let recent = self
            .restarts
            .iter()
            .filter(|t| now.duration_since(**t) < Duration::from_secs(3600))
            .count();
        let grace = if recent >= CRASH_LOOP_RESTARTS {
            CRASH_LOOP_GRACE
        } else {
            RECOVERY_GRACE
        };
        if !manual && now.duration_since(since) < grace && self.start_attempts == 0 {
            return;
        }
        if let Err(e) = ctl.start() {
            self.start_failed(e, now, events);
        }
    }

    fn start_failed(&mut self, e: String, now: Instant, events: &mut Vec<Event>) {
        self.start_attempts += 1;
        let wait = START_BACKOFF[(self.start_attempts as usize - 1).min(START_BACKOFF.len() - 1)];
        self.next_start = Some(now + Duration::from_secs(wait));
        log::warn!(
            "無法啟動 Agent 服務(第 {} 次):{e};{wait} 秒後再試",
            self.start_attempts
        );
        // 前 3 次都記,之後每小時記一次(10 分鐘一次 × 6),避免長時間失敗洗事件
        if self.start_attempts <= 3 || self.start_attempts.is_multiple_of(6) {
            events.push(Event {
                kind: "agent_start_failed",
                data: json!({ "error": e.chars().take(300).collect::<String>(), "attempts": self.start_attempts }),
            });
        }
    }
}

/// 管道沒有回報上次結束原因時(舊版 Agent):以 SCM 看到的結束代碼判斷;沒看到停止就不記
fn fallback_cause(stop: Option<ExitKind>) -> Option<&'static str> {
    match stop {
        Some(ExitKind::Failed(_)) => Some("crashed"),
        Some(ExitKind::RestartCommand) => Some("restart_command"),
        _ => None,
    }
}

fn with_error(mut v: Value, err: Option<String>) -> Value {
    if let Some(e) = err {
        v["error"] = json!(e.chars().take(300).collect::<String>());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<String>>,
        start_fails: bool,
        shutting_down: bool,
        exe_missing: bool,
    }

    impl AgentControl for Fake {
        fn start(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("start".into());
            if self.start_fails {
                Err("拒絕存取".into())
            } else {
                Ok(())
            }
        }
        fn stop_or_kill(&self, pid: Option<u32>) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("stop {pid:?}"));
            Ok(())
        }
        fn set_auto_start(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("auto".into());
            Ok(())
        }
        fn exe_exists(&self, _: &Path) -> bool {
            !self.exe_missing
        }
        fn shutting_down(&self) -> bool {
            self.shutting_down
        }
    }

    fn svc(state: SvcState, pid: Option<u32>, exit: ExitKind) -> SvcInfo {
        SvcInfo {
            state,
            pid,
            exit,
            start_type: StartType::Auto,
            exe: Some(PathBuf::from(
                r"C:\Program Files\GigaNexus\Agent\rustit-agent.exe",
            )),
        }
    }

    fn ok(pid: u32, previous_exit: &str) -> Option<Result<AgentStatus, String>> {
        Some(Ok(AgentStatus {
            version: "0.6.0".into(),
            pid,
            previous_exit: Some(previous_exit.into()),
            ..Default::default()
        }))
    }

    fn kinds(e: &[Event]) -> Vec<&'static str> {
        e.iter().map(|x| x.kind).collect()
    }

    #[test]
    fn crash_restart_reported_with_cause_from_pipe() {
        let (mut m, f, t) = (Monitor::new(), Fake::default(), Instant::now());
        assert!(
            m.tick(
                &f,
                &svc(SvcState::Running, Some(10), ExitKind::Clean),
                ok(10, "first_run"),
                t
            )
            .is_empty()
        );
        // SCM 已重啟(Watchdog 沒看到停止),新行程回報上次 unexpected
        let e = m.tick(
            &f,
            &svc(SvcState::Running, Some(11), ExitKind::Clean),
            ok(11, "unexpected"),
            t,
        );
        assert_eq!(kinds(&e), ["agent_restarted"]);
        assert_eq!(
            e[0].data,
            json!({ "cause": "crashed", "previous_pid": 10, "pid": 11 })
        );
        assert_eq!(m.restarts_24h(t), 1);
        // agent.restart 不算非正常
        let e = m.tick(
            &f,
            &svc(SvcState::Running, Some(12), ExitKind::Clean),
            ok(12, "restart_command"),
            t,
        );
        assert_eq!(e[0].data["cause"], "restart_command");
        assert_eq!(m.restarts_24h(t), 1);
        assert!(f.calls.borrow().is_empty(), "Agent 自己起來了,不必動作");
    }

    #[test]
    fn manual_stop_restarts_and_reports_once() {
        let (mut m, f, t) = (Monitor::new(), Fake::default(), Instant::now());
        m.tick(
            &f,
            &svc(SvcState::Running, Some(10), ExitKind::Clean),
            ok(10, "first_run"),
            t,
        );
        let e = m.tick(&f, &svc(SvcState::Stopped, None, ExitKind::Clean), None, t);
        assert_eq!(kinds(&e), ["agent_service_stopped"]);
        assert_eq!(e[0].data["restarted"], true);
        assert_eq!(*f.calls.borrow(), ["start"]);
        // 仍是停止(啟動中):不重複記
        assert!(
            m.tick(&f, &svc(SvcState::Stopped, None, ExitKind::Clean), None, t)
                .is_empty()
        );
        // 新行程上次結束原因為 stop:不另記重啟
        assert!(
            m.tick(
                &f,
                &svc(SvcState::Running, Some(20), ExitKind::Clean),
                ok(20, "stop"),
                t
            )
            .is_empty()
        );
    }

    #[test]
    fn stopped_at_boot_starts_without_tamper_event() {
        let (mut m, f, t) = (Monitor::new(), Fake::default(), Instant::now());
        assert!(
            m.tick(&f, &svc(SvcState::Stopped, None, ExitKind::Clean), None, t)
                .is_empty()
        );
        assert_eq!(*f.calls.borrow(), ["start"]);
    }

    #[test]
    fn crash_waits_for_scm_recovery_then_starts() {
        let (mut m, f, t) = (Monitor::new(), Fake::default(), Instant::now());
        m.tick(
            &f,
            &svc(SvcState::Running, Some(10), ExitKind::Clean),
            ok(10, "first_run"),
            t,
        );
        let crashed = svc(SvcState::Stopped, None, ExitKind::Failed(1067));
        assert!(m.tick(&f, &crashed, None, t).is_empty());
        assert!(
            m.tick(&f, &crashed, None, t + Duration::from_secs(60))
                .is_empty()
        );
        assert!(f.calls.borrow().is_empty(), "寬限內交給 SCM");
        m.tick(&f, &crashed, None, t + RECOVERY_GRACE);
        assert_eq!(*f.calls.borrow(), ["start"]);
        // 舊版 Agent(管道不通)時以 SCM 的結束代碼判斷:crashed
        let mut e = Vec::new();
        for i in 0..PENDING_TICKS {
            e = m.tick(
                &f,
                &svc(SvcState::Running, Some(11), ExitKind::Clean),
                Some(Err("無法連線".into())),
                t + RECOVERY_GRACE + Duration::from_secs(30 * (i as u64 + 1)),
            );
        }
        assert_eq!(e[0].data["cause"], "crashed");
    }

    #[test]
    fn hung_agent_is_restarted_only_after_pipe_worked() {
        let (mut m, f, t) = (Monitor::new(), Fake::default(), Instant::now());
        let running = svc(SvcState::Running, Some(10), ExitKind::Clean);
        // 管道從未成功(舊版 / 剛啟動):失敗再多次也不判定卡住
        for _ in 0..5 {
            m.tick(&f, &running, Some(Err("逾時".into())), t);
        }
        assert!(f.calls.borrow().is_empty());
        m.tick(&f, &running, ok(10, "first_run"), t);
        for _ in 0..HUNG_FAILURES {
            m.tick(&f, &running, Some(Err("逾時".into())), t);
        }
        assert_eq!(*f.calls.borrow(), ["stop Some(10)", "start"]);
        let e = m.tick(
            &f,
            &svc(SvcState::Running, Some(11), ExitKind::Clean),
            ok(11, "stop"),
            t,
        );
        assert_eq!(e[0].data["cause"], "hung");
        assert_eq!(m.restarts_24h(t), 1);
    }

    #[test]
    fn start_type_restored_and_missing_reported_once() {
        let (mut m, f, t) = (Monitor::new(), Fake::default(), Instant::now());
        let mut disabled = svc(SvcState::Running, Some(10), ExitKind::Clean);
        disabled.start_type = StartType::Disabled;
        let e = m.tick(&f, &disabled, ok(10, "first_run"), t);
        assert_eq!(kinds(&e), ["agent_start_type_changed"]);
        assert_eq!(e[0].data["from"], "disabled");
        assert_eq!(*f.calls.borrow(), ["auto"]);
        assert_eq!(
            kinds(&m.tick(&f, &SvcInfo::missing(), None, t)),
            ["agent_binary_missing"]
        );
        assert!(m.tick(&f, &SvcInfo::missing(), None, t).is_empty());
        let gone = Fake {
            exe_missing: true,
            ..Default::default()
        };
        let mut m2 = Monitor::new();
        let e = m2.tick(
            &gone,
            &svc(SvcState::Stopped, None, ExitKind::Failed(2)),
            None,
            t,
        );
        assert_eq!(e[0].data["service_missing"], false);
        assert!(gone.calls.borrow().is_empty());
    }

    #[test]
    fn binary_path_change_reported_once() {
        let (mut m, f, t) = (Monitor::new(), Fake::default(), Instant::now());
        m.expected_exe = Some(PathBuf::from(
            r"c:\program files\giganexus\agent\RUSTIT-AGENT.exe",
        ));
        // 大小寫不同視為相同
        assert!(
            m.tick(
                &f,
                &svc(SvcState::Running, Some(10), ExitKind::Clean),
                ok(10, "first_run"),
                t
            )
            .is_empty()
        );
        let mut other = svc(SvcState::Running, Some(11), ExitKind::Clean);
        other.exe = Some(PathBuf::from(r"C:\Windows\System32\svchost.exe"));
        assert_eq!(
            kinds(&m.tick(&f, &other, None, t)),
            ["agent_binary_changed"]
        );
        assert!(m.tick(&f, &other, None, t).is_empty(), "同一次只記一次");
    }

    #[test]
    fn quick_successive_crashes_are_not_lost() {
        let (mut m, f, t) = (Monitor::new(), Fake::default(), Instant::now());
        m.tick(
            &f,
            &svc(SvcState::Running, Some(10), ExitKind::Clean),
            ok(10, "first_run"),
            t,
        );
        // 新行程 11 管道還沒通就又停止
        m.tick(
            &f,
            &svc(SvcState::Running, Some(11), ExitKind::Clean),
            Some(Err("連不上".into())),
            t,
        );
        let e = m.tick(
            &f,
            &svc(SvcState::Stopped, None, ExitKind::Failed(1067)),
            None,
            t,
        );
        assert_eq!(e[0].data["cause"], "crashed");
        // 行程 12 管道沒通就又換成 13:先記下 11 → 12 那次,不漏
        m.tick(
            &f,
            &svc(SvcState::Running, Some(12), ExitKind::Clean),
            Some(Err("連不上".into())),
            t,
        );
        let e = m.tick(
            &f,
            &svc(SvcState::Running, Some(13), ExitKind::Clean),
            Some(Err("連不上".into())),
            t,
        );
        assert_eq!(
            e[0].data,
            json!({ "cause": "crashed", "previous_pid": 11, "pid": 12 })
        );
    }

    #[test]
    fn crash_loop_extends_grace() {
        let (mut m, f, t) = (Monitor::new(), Fake::default(), Instant::now());
        for i in 0..CRASH_LOOP_RESTARTS {
            m.restarts.push_back(t);
            let _ = i;
        }
        m.tick(
            &f,
            &svc(SvcState::Running, Some(10), ExitKind::Clean),
            ok(10, "first_run"),
            t,
        );
        let crashed = svc(SvcState::Stopped, None, ExitKind::Failed(1067));
        m.tick(&f, &crashed, None, t);
        m.tick(&f, &crashed, None, t + RECOVERY_GRACE);
        assert!(f.calls.borrow().is_empty(), "反覆當掉時 90 秒還不拉起");
        m.tick(&f, &crashed, None, t + CRASH_LOOP_GRACE);
        assert_eq!(*f.calls.borrow(), ["start"]);
    }

    #[test]
    fn start_failures_back_off_and_shutdown_is_ignored() {
        let (mut m, t) = (Monitor::new(), Instant::now());
        let f = Fake {
            start_fails: true,
            ..Default::default()
        };
        m.tick(
            &f,
            &svc(SvcState::Running, Some(10), ExitKind::Clean),
            ok(10, "first_run"),
            t,
        );
        let e = m.tick(&f, &svc(SvcState::Stopped, None, ExitKind::Clean), None, t);
        assert_eq!(kinds(&e), ["agent_service_stopped", "agent_start_failed"]);
        assert_eq!(e[0].data["restarted"], false);
        // 退避 60 秒內不再試
        assert!(
            m.tick(
                &f,
                &svc(SvcState::Stopped, None, ExitKind::Clean),
                None,
                t + Duration::from_secs(30)
            )
            .is_empty()
        );
        let e = m.tick(
            &f,
            &svc(SvcState::Stopped, None, ExitKind::Clean),
            None,
            t + Duration::from_secs(61),
        );
        assert_eq!(e[0].data["attempts"], 2);
        let down = Fake {
            shutting_down: true,
            ..Default::default()
        };
        assert!(
            Monitor::new()
                .tick(
                    &down,
                    &svc(SvcState::Stopped, None, ExitKind::Clean),
                    None,
                    t
                )
                .is_empty()
        );
        assert!(down.calls.borrow().is_empty());
    }
}
