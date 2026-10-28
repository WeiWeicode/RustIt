//! 升級狀態機測試(P6-UPGRADE-DESIGN §8):SCM / 管道 / 下載 / 簽章以假實作,檔案用暫存目錄。

use super::*;
use rustit_common::scm::{ExitKind, StartType, SvcState};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

const OLD: &[u8] = b"MZ old agent 0.7.0";
const NEW: &[u8] = b"MZ new agent 0.7.1 ................................";
const SIGNER: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/// 新版啟動後的表現
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Healthy,
    /// 管道正常但 WebSocket 不連線
    NoWs,
    /// 啟動後立即結束
    Exits,
}

/// 下載一次的劇本
enum Dl {
    /// 從 offset 寫到結尾
    Full,
    /// 寫 n bytes 後中斷
    Partial(usize),
    Range416,
}

struct Fake {
    install: PathBuf,
    served: Vec<u8>,
    plan: RefCell<VecDeque<Dl>>,
    offsets: RefCell<Vec<u64>>,
    signer: Result<String, String>,
    version: Option<String>,
    free: u64,
    new_mode: Mode,
    old_mode: Mode,
    prepare_fails: bool,
    stop_fails: bool,
    pid: Cell<u32>,
    running: Cell<bool>,
    now: Cell<Instant>,
    calls: RefCell<Vec<String>>,
    rec: RefCell<Option<UpgradeRecord>>,
    /// component = watchdog 的本機紀錄(P6-3)
    wd_rec: RefCell<Option<UpgradeRecord>>,
    /// replace_watchdog 的回應(預設被 Agent 接受)與送出的 (agent_pid, 版本)
    replace_result: RefCell<Result<(), (String, String)>>,
    replaced: RefCell<Vec<(u32, String)>>,
    events: RefCell<Vec<(&'static str, Value)>>,
    maint: RefCell<Vec<bool>>,
    /// Agent 管道 status.busy(P7 軟體派送中)
    busy: RefCell<Option<String>>,
}

impl Fake {
    fn new(install: &Path) -> Self {
        Self {
            install: install.to_path_buf(),
            served: NEW.to_vec(),
            plan: RefCell::new(VecDeque::new()),
            offsets: RefCell::new(Vec::new()),
            signer: Ok(SIGNER.into()),
            version: Some("0.7.1".into()),
            free: 10 * 1024 * 1024 * 1024,
            new_mode: Mode::Healthy,
            old_mode: Mode::Healthy,
            prepare_fails: false,
            stop_fails: false,
            pid: Cell::new(100),
            running: Cell::new(true),
            now: Cell::new(Instant::now()),
            calls: RefCell::new(Vec::new()),
            rec: RefCell::new(None),
            wd_rec: RefCell::new(None),
            replace_result: RefCell::new(Ok(())),
            replaced: RefCell::new(Vec::new()),
            events: RefCell::new(Vec::new()),
            maint: RefCell::new(Vec::new()),
            busy: RefCell::new(None),
        }
    }

    fn installed(&self) -> Vec<u8> {
        std::fs::read(self.install.join(AGENT_EXE)).unwrap_or_default()
    }

    fn mode(&self) -> (Mode, &'static str) {
        if self.installed() == NEW {
            (self.new_mode, "0.7.1")
        } else {
            (self.old_mode, "0.7.0")
        }
    }

    fn kinds(&self) -> Vec<&'static str> {
        self.events.borrow().iter().map(|e| e.0).collect()
    }

    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }
}

impl UpgradeEnv for Fake {
    async fn download(
        &self,
        url: &str,
        part: &Path,
        offset: u64,
        limit: u64,
    ) -> Result<Fetched, String> {
        assert!(url.starts_with("/agent/v1/releases/"));
        self.offsets.borrow_mut().push(offset);
        let step = self.plan.borrow_mut().pop_front().unwrap_or(Dl::Full);
        let mut have = std::fs::read(part).unwrap_or_default();
        have.truncate(offset as usize);
        match step {
            Dl::Range416 => Ok(Fetched::RangeNotSatisfiable),
            Dl::Full => {
                have.extend_from_slice(&self.served[offset as usize..]);
                if have.len() as u64 > limit {
                    return Err("超過大小".into());
                }
                std::fs::write(part, &have).unwrap();
                Ok(Fetched::Done(have.len() as u64))
            }
            Dl::Partial(n) => {
                have.extend_from_slice(&self.served[offset as usize..offset as usize + n]);
                std::fs::write(part, &have).unwrap();
                Err("下載中斷:連線被重設".into())
            }
        }
    }
    fn free_bytes(&self, _: &Path) -> Result<u64, String> {
        Ok(self.free)
    }
    fn signer(&self, _: &Path) -> Result<String, String> {
        self.signer.clone()
    }
    fn product_version(&self, path: &Path) -> Option<String> {
        // 安裝目錄的 exe 依內容;下載檔依劇本
        if path == self.install.join(AGENT_EXE) {
            return Some(self.mode().1.to_string());
        }
        self.version.clone()
    }
    async fn query(&self) -> Result<SvcInfo, String> {
        let up = self.running.get() && self.mode().0 != Mode::Exits;
        Ok(SvcInfo {
            state: if up {
                SvcState::Running
            } else {
                SvcState::Stopped
            },
            pid: up.then(|| self.pid.get()),
            exit: ExitKind::Clean,
            start_type: StartType::Auto,
            exe: Some(self.install.join(AGENT_EXE)),
        })
    }
    async fn prepare_shutdown(&self, pid: u32) -> Result<(), String> {
        self.calls.borrow_mut().push(format!("prepare {pid}"));
        if self.prepare_fails {
            Err("本機管道逾時".into())
        } else {
            Ok(())
        }
    }
    async fn get_status(&self, pid: u32) -> Result<AgentStatus, String> {
        let (mode, version) = self.mode();
        Ok(AgentStatus {
            version: version.into(),
            pid,
            ws_connected: mode == Mode::Healthy,
            busy: self.busy.borrow().clone(),
            ..Default::default()
        })
    }
    async fn stop(&self, _: Option<u32>) -> Result<(), String> {
        self.calls.borrow_mut().push("stop".into());
        if self.stop_fails {
            return Err("等待服務停止逾時".into());
        }
        self.running.set(false);
        Ok(())
    }
    async fn start(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("start".into());
        self.running.set(true);
        self.pid.set(self.pid.get() + 1);
        Ok(())
    }
    async fn sleep(&self, d: Duration) {
        self.now.set(self.now.get() + d);
    }
    fn now(&self) -> Instant {
        self.now.get()
    }
    fn hands_off(&self) -> bool {
        false
    }
    fn load_component(&self, component: &str) -> Option<UpgradeRecord> {
        if component == WATCHDOG_COMPONENT {
            self.wd_rec.borrow().clone()
        } else {
            self.rec.borrow().clone()
        }
    }
    fn save(&self, rec: &UpgradeRecord) {
        if rec.component == WATCHDOG_COMPONENT {
            *self.wd_rec.borrow_mut() = Some(rec.clone());
        } else {
            *self.rec.borrow_mut() = Some(rec.clone());
        }
    }
    fn clear_component(&self, component: &str) {
        if component == WATCHDOG_COMPONENT {
            *self.wd_rec.borrow_mut() = None;
        } else {
            *self.rec.borrow_mut() = None;
        }
    }
    fn event(&self, kind: &'static str, data: Value) {
        self.events.borrow_mut().push((kind, data));
    }
    async fn replace_watchdog(
        &self,
        agent_pid: u32,
        target: &UpgradeTarget,
        path: &Path,
    ) -> Result<(), (String, String)> {
        assert!(path.is_file(), "交給 Agent 的檔案要存在");
        self.replaced
            .borrow_mut()
            .push((agent_pid, target.version.clone()));
        self.replace_result.borrow().clone()
    }
    fn maintenance(&self, on: bool) {
        self.maint.borrow_mut().push(on);
    }
}

struct Setup {
    _dir: tempfile::TempDir,
    paths: Paths,
}

fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let install = dir.path().join("Program Files").join("Agent");
    std::fs::create_dir_all(&install).unwrap();
    std::fs::write(install.join(AGENT_EXE), OLD).unwrap();
    Setup {
        paths: Paths {
            install_dir: install,
            cache_dir: dir.path().join("cache"),
        },
        _dir: dir,
    }
}

fn target() -> UpgradeTarget {
    UpgradeTarget {
        version: "0.7.1".into(),
        url: "/agent/v1/releases/agent/0.7.1/rustit-agent.exe".into(),
        sha256: hex::encode(Sha256::digest(NEW)),
        size_bytes: NEW.len() as u64,
        signer_thumbprints: vec![SIGNER.into()],
    }
}

fn upgrader<'a>(env: &'a Fake, s: &Setup) -> Upgrader<'a, Fake> {
    Upgrader {
        env,
        paths: s.paths.clone(),
        trusted: vec![SIGNER.into()],
    }
}

async fn run(env: &Fake, s: &Setup, t: &UpgradeTarget) -> Outcome {
    upgrader(env, s).run(t, Some("0.7.0")).await
}

#[tokio::test]
async fn succeeds_and_keeps_previous() {
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    assert_eq!(run(&f, &s, &target()).await, Outcome::Succeeded);
    assert_eq!(f.installed(), NEW);
    assert_eq!(std::fs::read(s.paths.previous()).unwrap(), OLD);
    assert!(!s.paths.staged().exists());
    assert_eq!(f.calls(), ["prepare 100", "stop", "start"]);
    assert_eq!(f.kinds(), ["upgrade_started", "upgrade_succeeded"]);
    let started = f.events.borrow()[0].1.clone();
    assert_eq!(
        started,
        json!({ "component": "agent", "from": "0.7.0", "to": "0.7.1" })
    );
    let rec = f.rec.borrow().clone().unwrap();
    assert_eq!((rec.state.as_str(), rec.attempts), ("succeeded", 0));
    assert_eq!(*f.maint.borrow(), [true, false]);
    // 已下載的檔案留在 cache(下一次同版本不必重新下載)
    assert!(s.paths.version_dir("0.7.1").join(AGENT_EXE).is_file());
    // 已是目標版本:不動作
    let again = upgrader(&f, &s).run(&target(), Some("0.7.1")).await;
    assert_eq!(again, Outcome::Skipped("已是目標版本"));
}

#[tokio::test]
async fn agent_busy_defers_install() {
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    *f.busy.borrow_mut() = Some("software".into());
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Skipped("Agent 正在執行軟體派送")
    );
    // 沒有停止 Agent、紀錄不算失敗;下載檔留在 cache
    assert_eq!(f.installed(), OLD);
    assert!(f.calls().is_empty());
    assert!(f.rec.borrow().is_none());
    assert!(s.paths.version_dir("0.7.1").join(AGENT_EXE).is_file());
    // 軟體派送結束後的下一次:沿用已下載的檔案完成升級
    *f.busy.borrow_mut() = None;
    assert_eq!(run(&f, &s, &target()).await, Outcome::Succeeded);
    assert_eq!(f.installed(), NEW);
}

#[tokio::test]
async fn interrupted_download_resumes_with_range() {
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    f.plan
        .borrow_mut()
        .extend([Dl::Partial(10), Dl::Partial(5), Dl::Full]);
    assert_eq!(run(&f, &s, &target()).await, Outcome::Succeeded);
    assert_eq!(*f.offsets.borrow(), [0, 10, 15]);
    // 416:刪掉續傳檔重來
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    let dir = s.paths.version_dir("0.7.1");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{AGENT_EXE}.part")), b"MZ new").unwrap();
    f.plan.borrow_mut().extend([Dl::Range416, Dl::Full]);
    assert_eq!(run(&f, &s, &target()).await, Outcome::Succeeded);
    assert_eq!(*f.offsets.borrow(), [6, 0]);
}

#[tokio::test]
async fn download_failure_after_retries() {
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    f.plan
        .borrow_mut()
        .extend([Dl::Partial(1), Dl::Partial(1), Dl::Partial(1)]);
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Failed("failed", "DOWNLOAD_FAILED")
    );
    assert!(f.calls().is_empty(), "沒動到 Agent");
    // 續傳檔保留,下次接著下載
    assert!(
        s.paths
            .version_dir("0.7.1")
            .join(format!("{AGENT_EXE}.part"))
            .is_file()
    );
}

#[tokio::test]
async fn hash_mismatch_is_rejected_without_touching_agent() {
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    let mut tampered = NEW.to_vec();
    tampered[3] ^= 1;
    f.served = tampered;
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Failed("failed", "HASH_MISMATCH")
    );
    assert_eq!(f.installed(), OLD);
    assert!(f.calls().is_empty());
    assert!(
        !s.paths.version_dir("0.7.1").join(AGENT_EXE).exists(),
        "刪除不符的檔案"
    );
    let rec = f.rec.borrow().clone().unwrap();
    assert_eq!(
        (rec.attempts, rec.error_code.as_deref()),
        (1, Some("HASH_MISMATCH"))
    );
    let failed = f.events.borrow()[1].1.clone();
    assert_eq!(failed["rolled_back"], false);
    assert_eq!(failed["error_code"], "HASH_MISMATCH");
}

#[tokio::test]
async fn signature_and_signer_checks() {
    // 未簽章 / 簽章無效
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.signer = Err("簽章無效或不受信任(WinVerifyTrust 0x800B0100,未簽章)".into());
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Failed("failed", "SIGNATURE_INVALID")
    );
    assert_eq!(f.installed(), OLD);
    // 簽章者不在主機清單
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.signer = Ok("ffffffffffffffffffffffffffffffffffffffff".into());
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Failed("failed", "SIGNER_NOT_TRUSTED")
    );
    // 主機清單有,但本機信任清單沒有:主機不能單獨放行
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    let up = Upgrader {
        env: &f,
        paths: s.paths.clone(),
        trusted: vec![],
    };
    assert_eq!(
        up.run(&target(), Some("0.7.0")).await,
        Outcome::Failed("failed", "SIGNER_NOT_TRUSTED")
    );
    assert!(f.calls().is_empty());
    // 檔案版本資源與目標不符
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.version = Some("0.7.2".into());
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Failed("failed", "HASH_MISMATCH")
    );
}

#[tokio::test]
async fn invalid_targets_are_refused_before_download() {
    type Change = Box<dyn Fn(&mut UpgradeTarget)>;
    let bad: Vec<Change> = vec![
        Box::new(|t| t.url = "/agent/v1/releases/agent/0.7.2/rustit-agent.exe".into()),
        Box::new(|t| t.url = "/agent/v1/releases/watchdog/0.7.1/rustit-agent.exe".into()),
        Box::new(|t| t.size_bytes = MAX_SIZE + 1),
        Box::new(|t| {
            t.version = "0.6.0".into();
            t.url = "/agent/v1/releases/agent/0.6.0/rustit-agent.exe".into();
        }),
        Box::new(|t| t.sha256 = "ABC".into()),
    ];
    for change in bad {
        let s = setup();
        let f = Fake::new(&s.paths.install_dir);
        let mut t = target();
        change(&mut t);
        assert_eq!(
            run(&f, &s, &t).await,
            Outcome::Failed("failed", "DOWNLOAD_FAILED")
        );
        assert!(f.offsets.borrow().is_empty(), "不下載");
    }
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.free = 100 * 1024 * 1024;
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Failed("failed", "DISK_FULL")
    );
    assert!(f.offsets.borrow().is_empty());
}

#[tokio::test]
async fn prepare_timeout_still_upgrades() {
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.prepare_fails = true;
    assert_eq!(run(&f, &s, &target()).await, Outcome::Succeeded);
}

#[tokio::test]
async fn stop_timeout_keeps_old_version() {
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.stop_fails = true;
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Failed("failed", "STOP_TIMEOUT")
    );
    assert_eq!(f.installed(), OLD);
    assert_eq!(*f.maint.borrow(), [true, false]);
}

#[tokio::test]
async fn broken_version_is_rolled_back() {
    for mode in [Mode::Exits, Mode::NoWs] {
        let s = setup();
        let mut f = Fake::new(&s.paths.install_dir);
        f.new_mode = mode;
        assert_eq!(
            run(&f, &s, &target()).await,
            Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED")
        );
        assert_eq!(f.installed(), OLD, "已換回舊版");
        assert_eq!(f.kinds(), ["upgrade_started", "upgrade_failed"]);
        let d = f.events.borrow()[1].1.clone();
        assert_eq!(d["rolled_back"], true);
        assert!(
            d["error_message"]
                .as_str()
                .unwrap()
                .contains("已還原 0.7.0")
        );
        let rec = f.rec.borrow().clone().unwrap();
        assert_eq!((rec.state.as_str(), rec.attempts), ("rolled_back", 1));
        assert_eq!(*f.maint.borrow(), [true, false]);
    }
}

#[tokio::test]
async fn rollback_failure_is_reported() {
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.new_mode = Mode::NoWs;
    f.old_mode = Mode::Exits;
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Failed("failed", "ROLLBACK_FAILED")
    );
    // 還原失敗後不再自動嘗試
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Skipped("同一目標版本已失敗,不再自動嘗試")
    );
}

/// 還原後管道被搶建(get_status 失敗)但服務 PID 穩定:視為已還原,不判 ROLLBACK_FAILED(資安 M3)
#[tokio::test]
async fn rollback_tolerates_stolen_pipe() {
    struct Stolen(Fake);
    impl UpgradeEnv for Stolen {
        async fn download(&self, u: &str, p: &Path, o: u64, l: u64) -> Result<Fetched, String> {
            self.0.download(u, p, o, l).await
        }
        fn free_bytes(&self, d: &Path) -> Result<u64, String> {
            self.0.free_bytes(d)
        }
        fn signer(&self, p: &Path) -> Result<String, String> {
            self.0.signer(p)
        }
        fn product_version(&self, p: &Path) -> Option<String> {
            self.0.product_version(p)
        }
        async fn query(&self) -> Result<SvcInfo, String> {
            self.0.query().await
        }
        async fn prepare_shutdown(&self, pid: u32) -> Result<(), String> {
            self.0.prepare_shutdown(pid).await
        }
        async fn get_status(&self, pid: u32) -> Result<AgentStatus, String> {
            if self.0.installed() == OLD {
                Err("本機管道伺服端 PID 999 不是 Agent 服務".into())
            } else {
                self.0.get_status(pid).await
            }
        }
        async fn stop(&self, pid: Option<u32>) -> Result<(), String> {
            self.0.stop(pid).await
        }
        async fn start(&self) -> Result<(), String> {
            self.0.start().await
        }
        async fn sleep(&self, d: Duration) {
            self.0.sleep(d).await
        }
        fn now(&self) -> Instant {
            self.0.now()
        }
        fn hands_off(&self) -> bool {
            false
        }
        fn load_component(&self, c: &str) -> Option<UpgradeRecord> {
            self.0.load_component(c)
        }
        fn save(&self, r: &UpgradeRecord) {
            self.0.save(r)
        }
        fn clear_component(&self, c: &str) {
            self.0.clear_component(c)
        }
        async fn replace_watchdog(
            &self,
            pid: u32,
            t: &UpgradeTarget,
            p: &Path,
        ) -> Result<(), (String, String)> {
            self.0.replace_watchdog(pid, t, p).await
        }
        fn event(&self, k: &'static str, d: Value) {
            self.0.event(k, d)
        }
        fn maintenance(&self, on: bool) {
            self.0.maintenance(on)
        }
    }
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.new_mode = Mode::NoWs;
    let env = Stolen(f);
    let up = Upgrader {
        env: &env,
        paths: s.paths.clone(),
        trusted: vec![SIGNER.into()],
    };
    assert_eq!(
        up.run(&target(), Some("0.7.0")).await,
        Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED")
    );
    assert_eq!(env.0.installed(), OLD);
}

#[tokio::test]
async fn same_version_stops_after_two_failures() {
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.new_mode = Mode::Exits;
    for n in 1..=MAX_ATTEMPTS {
        assert_eq!(
            run(&f, &s, &target()).await,
            Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED")
        );
        assert_eq!(f.rec.borrow().as_ref().unwrap().attempts, n);
    }
    let calls = f.calls().len();
    assert_eq!(
        run(&f, &s, &target()).await,
        Outcome::Skipped("同一目標版本已失敗,不再自動嘗試")
    );
    assert_eq!(f.calls().len(), calls);
    // agent.upgrade 重設失敗次數後可再試(outbox.upgrade_reset_attempts)
    f.rec.borrow_mut().as_mut().unwrap().attempts = 0;
    f.new_mode = Mode::Healthy;
    assert_eq!(run(&f, &s, &target()).await, Outcome::Succeeded);
}

fn installing(s: &Setup) -> UpgradeRecord {
    std::fs::create_dir_all(s.paths.previous().parent().unwrap()).unwrap();
    std::fs::write(s.paths.previous(), OLD).unwrap();
    UpgradeRecord {
        component: COMPONENT.into(),
        target_version: "0.7.1".into(),
        target_sha256: target().sha256,
        from_version: Some("0.7.0".into()),
        state: "installing".into(),
        attempts: 0,
        error_code: None,
        error_message: None,
        started_at: crate::now_rfc3339(),
    }
}

#[tokio::test]
async fn resume_after_watchdog_restart() {
    // 已換上新版、Agent 被停著:啟動並驗證
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    *f.rec.borrow_mut() = Some(installing(&s));
    std::fs::write(s.paths.exe(), NEW).unwrap();
    f.running.set(false);
    assert_eq!(upgrader(&f, &s).resume().await, Some(Outcome::Succeeded));
    assert_eq!(f.calls(), ["start"]);
    // 已換上新版但新版不正常:還原
    let s = setup();
    let mut f = Fake::new(&s.paths.install_dir);
    f.new_mode = Mode::NoWs;
    *f.rec.borrow_mut() = Some(installing(&s));
    std::fs::write(s.paths.exe(), NEW).unwrap();
    assert_eq!(
        upgrader(&f, &s).resume().await,
        Some(Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED"))
    );
    assert_eq!(f.installed(), OLD);
    // 還沒換上:啟動舊版,不算失敗、清掉紀錄(下次目標重新來)
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    *f.rec.borrow_mut() = Some(installing(&s));
    std::fs::write(s.paths.staged(), b"half").unwrap();
    assert_eq!(
        upgrader(&f, &s).resume().await,
        Some(Outcome::Skipped("中斷時仍是舊版,已恢復"))
    );
    assert_eq!(f.installed(), OLD);
    assert!(f.rec.borrow().is_none());
    assert!(!s.paths.staged().exists(), "清掉殘留的 .new");
    // 程式不見(替換中途):從 previous\ 換回
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    *f.rec.borrow_mut() = Some(installing(&s));
    std::fs::remove_file(s.paths.exe()).unwrap();
    assert_eq!(
        upgrader(&f, &s).resume().await,
        Some(Outcome::Failed("rolled_back", "REPLACE_FAILED"))
    );
    assert_eq!(f.installed(), OLD);
    assert_eq!(*f.maint.borrow(), [true, false]);
    // 沒有中斷的安裝:不動作
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    assert_eq!(upgrader(&f, &s).resume().await, None);
    assert!(f.maint.borrow().is_empty());
}

#[tokio::test]
async fn cache_keeps_two_versions() {
    let s = setup();
    let f = Fake::new(&s.paths.install_dir);
    for v in ["0.6.9", "0.6.8", "0.6.7"] {
        std::fs::create_dir_all(s.paths.version_dir(v)).unwrap();
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(run(&f, &s, &target()).await, Outcome::Succeeded);
    let mut left: Vec<String> = std::fs::read_dir(s.paths.cache_dir.join(COMPONENT))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, ["0.6.7", "0.7.1"], "保留這次與最新的另一個");
}

#[test]
fn progress_matches_contract_shape() {
    let r = UpgradeRecord {
        component: "agent".into(),
        target_version: "0.7.2-broken".into(),
        target_sha256: String::new(),
        from_version: Some("0.7.0".into()),
        state: "rolled_back".into(),
        attempts: 1,
        error_code: Some("HEALTH_CHECK_FAILED".into()),
        error_message: Some("x".into()),
        started_at: String::new(),
    };
    assert_eq!(
        r.progress(),
        json!({ "component": "agent", "target_version": "0.7.2-broken", "from_version": "0.7.0", "state": "rolled_back",
                "attempts": 1, "error_code": "HEALTH_CHECK_FAILED", "error_message": "x" })
    );
    assert!(r.terminal());
}

// ---------- Watchdog 自己的升級(P6-3):下載、驗證後交給 Agent ----------

fn wd_target() -> UpgradeTarget {
    UpgradeTarget {
        version: "0.3.1".into(),
        url: "/agent/v1/releases/watchdog/0.3.1/rustit-watchdog.exe".into(),
        sha256: hex::encode(Sha256::digest(NEW)),
        size_bytes: NEW.len() as u64,
        signer_thumbprints: vec![SIGNER.into()],
    }
}

fn wd_fake(s: &Setup) -> Fake {
    let mut f = Fake::new(&s.paths.install_dir);
    f.version = Some("0.3.1".into());
    f
}

async fn run_wd(env: &Fake, s: &Setup, t: &UpgradeTarget) -> Outcome {
    upgrader(env, s).run_watchdog(t, "0.3.0").await
}

#[tokio::test]
async fn watchdog_target_is_downloaded_verified_and_handed_to_agent() {
    let s = setup();
    let f = wd_fake(&s);
    assert_eq!(run_wd(&f, &s, &wd_target()).await, Outcome::HandedOff);
    // 下載到 cache\watchdog\{版本}\,Agent 與 Watchdog 自己的 exe 都沒被 Watchdog 動
    let file = s
        .paths
        .cache_dir
        .join("watchdog")
        .join("0.3.1")
        .join("rustit-watchdog.exe");
    assert_eq!(std::fs::read(&file).unwrap(), NEW);
    assert_eq!(f.installed(), OLD);
    assert_eq!(*f.replaced.borrow(), [(100, "0.3.1".to_string())]);
    // 本機紀錄:component = watchdog、installing(Agent 隨後停止這個行程);Agent 的紀錄不受影響
    let rec = f.wd_rec.borrow().clone().unwrap();
    assert_eq!(rec.component, "watchdog");
    assert_eq!(rec.state, "installing");
    assert_eq!(rec.from_version.as_deref(), Some("0.3.0"));
    assert_eq!(rec.target_sha256, wd_target().sha256);
    assert!(f.rec.borrow().is_none());
    // Watchdog 路徑不送 component = watchdog 的事件(主機只收 Agent 上報的)
    assert!(f.events.borrow().is_empty());
    assert!(f.calls().is_empty(), "不停止、不啟動任何服務");
    assert!(f.maint.borrow().is_empty(), "不進入維護中");
}

#[tokio::test]
async fn watchdog_target_rejected_by_agent_is_a_failure_with_known_code() {
    let s = setup();
    let f = wd_fake(&s);
    *f.replace_result.borrow_mut() =
        Err(("SIGNER_NOT_TRUSTED".into(), "簽章者不在本機清單".into()));
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Failed("failed", "SIGNER_NOT_TRUSTED")
    );
    let rec = f.wd_rec.borrow().clone().unwrap();
    assert_eq!((rec.state.as_str(), rec.attempts), ("failed", 1));
    assert_eq!(rec.error_code.as_deref(), Some("SIGNER_NOT_TRUSTED"));
    // 不認得的代碼一律 REPLACE_FAILED(不把主機以外的字串當代碼寫進紀錄)
    let f = wd_fake(&s);
    *f.replace_result.borrow_mut() = Err(("<script>".into(), "x".into()));
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Failed("failed", "REPLACE_FAILED")
    );
}

#[tokio::test]
async fn watchdog_target_with_bad_signature_never_reaches_agent() {
    let s = setup();
    let mut f = wd_fake(&s);
    f.signer = Err("未簽章".into());
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Failed("failed", "SIGNATURE_INVALID")
    );
    assert!(f.replaced.borrow().is_empty());
    assert!(
        !s.paths
            .cache_dir
            .join("watchdog")
            .join("0.3.1")
            .join("rustit-watchdog.exe")
            .exists(),
        "驗證失敗的檔案要刪除"
    );
}

#[tokio::test]
async fn watchdog_target_rejects_untrusted_signer_and_wrong_version() {
    let s = setup();
    let f = wd_fake(&s);
    let up = Upgrader {
        env: &f,
        paths: s.paths.clone(),
        trusted: vec!["0000000000000000000000000000000000000000".into()],
    };
    assert_eq!(
        up.run_watchdog(&wd_target(), "0.3.0").await,
        Outcome::Failed("failed", "SIGNER_NOT_TRUSTED")
    );
    let s = setup();
    let mut f = wd_fake(&s);
    f.version = Some("0.3.2".into());
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Failed("failed", "HASH_MISMATCH")
    );
    assert!(f.replaced.borrow().is_empty());
}

#[tokio::test]
async fn watchdog_target_below_minimum_version_is_refused() {
    let s = setup();
    let f = wd_fake(&s);
    let mut t = wd_target();
    t.version = "0.2.0".into();
    t.url = "/agent/v1/releases/watchdog/0.2.0/rustit-watchdog.exe".into();
    assert_eq!(
        run_wd(&f, &s, &t).await,
        Outcome::Failed("failed", "DOWNLOAD_FAILED")
    );
    assert!(f.replaced.borrow().is_empty());
    // 下載網址的元件必須是 watchdog(主機給 agent 的網址也不接受)
    let mut t = wd_target();
    t.url = "/agent/v1/releases/agent/0.3.1/rustit-agent.exe".into();
    assert_eq!(
        run_wd(&f, &s, &t).await,
        Outcome::Failed("failed", "DOWNLOAD_FAILED")
    );
}

#[tokio::test]
async fn watchdog_target_needs_a_running_agent() {
    let s = setup();
    let f = wd_fake(&s);
    f.running.set(false);
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Failed("failed", "REPLACE_FAILED")
    );
    assert!(f.replaced.borrow().is_empty());
}

#[tokio::test]
async fn watchdog_target_skips_when_current_or_attempts_exhausted() {
    let s = setup();
    let f = wd_fake(&s);
    let up = upgrader(&f, &s);
    assert_eq!(
        up.run_watchdog(&wd_target(), "0.3.1").await,
        Outcome::Skipped("已是目標版本")
    );
    *f.replace_result.borrow_mut() = Err(("REPLACE_FAILED".into(), "x".into()));
    assert!(matches!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Failed(..)
    ));
    assert!(matches!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Failed(..)
    ));
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Skipped("同一目標版本已失敗,不再自動嘗試")
    );
    // 同版本的 Agent 失敗次數與 Watchdog 無關
    assert!(f.rec.borrow().is_none());
}

#[tokio::test]
async fn watchdog_resume_marks_succeeded_when_running_the_target_version() {
    let s = setup();
    let f = wd_fake(&s);
    run_wd(&f, &s, &wd_target()).await;
    let up = upgrader(&f, &s);
    assert_eq!(up.resume_watchdog("0.3.1"), Some(Outcome::Succeeded));
    let rec = f.wd_rec.borrow().clone().unwrap();
    assert_eq!(rec.state, "succeeded");
    assert!(rec.error_code.is_none());
    assert_eq!(rec.attempts, 0);
    // 已結束的紀錄不再處理
    assert_eq!(up.resume_watchdog("0.3.1"), None);
}

#[tokio::test]
async fn watchdog_resume_marks_rolled_back_when_still_old() {
    let s = setup();
    let f = wd_fake(&s);
    run_wd(&f, &s, &wd_target()).await;
    let up = upgrader(&f, &s);
    assert_eq!(
        up.resume_watchdog("0.3.0"),
        Some(Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED"))
    );
    let rec = f.wd_rec.borrow().clone().unwrap();
    assert_eq!((rec.state.as_str(), rec.attempts), ("rolled_back", 1));
    assert!(f.events.borrow().is_empty(), "事件由 Agent 上報");
}

#[tokio::test]
async fn watchdog_resume_marks_rolled_back_when_old_returns_after_success() {
    // 審查必修 A:新版啟動記 succeeded 後,Agent 健康檢查失敗換回舊版 → 舊版啟動時記 rolled_back
    let s = setup();
    let f = wd_fake(&s);
    run_wd(&f, &s, &wd_target()).await;
    let up = upgrader(&f, &s);
    assert_eq!(up.resume_watchdog("0.3.1"), Some(Outcome::Succeeded));
    assert_eq!(
        up.resume_watchdog("0.3.0"),
        Some(Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED"))
    );
    let rec = f.wd_rec.borrow().clone().unwrap();
    assert_eq!((rec.state.as_str(), rec.attempts), ("rolled_back", 1));
    assert_eq!(rec.error_code.as_deref(), Some("HEALTH_CHECK_FAILED"));
    assert!(f.events.borrow().is_empty(), "事件由 Agent 上報");
    // 已收尾,不重複加次數
    assert_eq!(up.resume_watchdog("0.3.0"), None);
    // 下一次替換再失敗就達上限,不再自動嘗試(不會無限循環)
    assert_eq!(run_wd(&f, &s, &wd_target()).await, Outcome::HandedOff);
    assert_eq!(up.resume_watchdog("0.3.1"), Some(Outcome::Succeeded));
    assert_eq!(
        up.resume_watchdog("0.3.0"),
        Some(Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED"))
    );
    assert_eq!(f.wd_rec.borrow().as_ref().unwrap().attempts, 2);
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Skipped("同一目標版本已失敗,不再自動嘗試")
    );
}

#[tokio::test]
async fn watchdog_resume_keeps_success_of_own_version() {
    let s = setup();
    let f = wd_fake(&s);
    run_wd(&f, &s, &wd_target()).await;
    let up = upgrader(&f, &s);
    assert_eq!(up.resume_watchdog("0.3.1"), Some(Outcome::Succeeded));
    // 新版重新啟動(版本 = 目標):紀錄不變
    assert_eq!(up.resume_watchdog("0.3.1"), None);
    assert_eq!(f.wd_rec.borrow().as_ref().unwrap().state, "succeeded");
}

/// 已交給 Agent、`started_at` 在 `ago` 之前的 installing 紀錄
fn wd_installing(ago: chrono::Duration, attempts: u32) -> UpgradeRecord {
    UpgradeRecord {
        component: WATCHDOG_COMPONENT.into(),
        target_version: "0.3.1".into(),
        target_sha256: wd_target().sha256,
        from_version: Some("0.3.0".into()),
        state: "installing".into(),
        attempts,
        error_code: None,
        error_message: None,
        started_at: (chrono::Utc::now() - ago).to_rfc3339(),
    }
}

#[tokio::test]
async fn watchdog_installing_within_limit_is_skipped() {
    let s = setup();
    let f = wd_fake(&s);
    f.save(&wd_installing(chrono::Duration::minutes(14), 0));
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Skipped("上一次替換尚未收尾")
    );
    let rec = f.wd_rec.borrow().clone().unwrap();
    assert_eq!((rec.state.as_str(), rec.attempts), ("installing", 0));
    assert!(f.replaced.borrow().is_empty());
}

#[tokio::test]
async fn watchdog_stale_installing_is_rolled_back_then_retried_once() {
    // 審查必修 B:Agent 沒動到服務就失敗,舊 Watchdog 仍在跑、紀錄停在 installing
    let s = setup();
    let f = wd_fake(&s);
    f.save(&wd_installing(chrono::Duration::minutes(16), 0));
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED")
    );
    let rec = f.wd_rec.borrow().clone().unwrap();
    assert_eq!((rec.state.as_str(), rec.attempts), ("rolled_back", 1));
    assert!(rec.error_message.unwrap().contains("替換逾時未完成"));
    assert!(f.replaced.borrow().is_empty(), "這一次只收尾,不交給 Agent");
    assert!(f.events.borrow().is_empty());
    // 可再試一次(冷卻由 lib.rs 依 Failed 設定)
    assert_eq!(run_wd(&f, &s, &wd_target()).await, Outcome::HandedOff);
    assert_eq!(f.replaced.borrow().len(), 1);
    // 第二次又停在 installing 逾時 → 失敗次數達上限,不再嘗試
    let mut rec = f.wd_rec.borrow().clone().unwrap();
    assert_eq!((rec.state.as_str(), rec.attempts), ("installing", 1));
    rec.started_at = (chrono::Utc::now() - chrono::Duration::minutes(20)).to_rfc3339();
    f.save(&rec);
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED")
    );
    assert_eq!(f.wd_rec.borrow().as_ref().unwrap().attempts, 2);
    assert_eq!(
        run_wd(&f, &s, &wd_target()).await,
        Outcome::Skipped("同一目標版本已失敗,不再自動嘗試")
    );
    assert_eq!(f.replaced.borrow().len(), 1);
}

#[tokio::test]
async fn watchdog_resume_ignores_agent_records() {
    let s = setup();
    let f = wd_fake(&s);
    assert_eq!(upgrader(&f, &s).resume_watchdog("0.3.0"), None);
    // Agent 停在 installing 的紀錄不是 Watchdog 的收尾對象
    f.save(&UpgradeRecord {
        component: "agent".into(),
        target_version: "0.7.1".into(),
        target_sha256: String::new(),
        from_version: None,
        state: "installing".into(),
        attempts: 0,
        error_code: None,
        error_message: None,
        started_at: crate::now_rfc3339(),
    });
    assert_eq!(upgrader(&f, &s).resume_watchdog("0.3.0"), None);
}
