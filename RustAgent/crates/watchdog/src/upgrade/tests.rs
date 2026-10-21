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
    events: RefCell<Vec<(&'static str, Value)>>,
    maint: RefCell<Vec<bool>>,
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
            events: RefCell::new(Vec::new()),
            maint: RefCell::new(Vec::new()),
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
        assert!(url.starts_with("/agent/v1/releases/agent/"));
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
    fn load(&self) -> Option<UpgradeRecord> {
        self.rec.borrow().clone()
    }
    fn save(&self, rec: &UpgradeRecord) {
        *self.rec.borrow_mut() = Some(rec.clone());
    }
    fn clear(&self) {
        *self.rec.borrow_mut() = None;
    }
    fn event(&self, kind: &'static str, data: Value) {
        self.events.borrow_mut().push((kind, data));
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
        fn load(&self) -> Option<UpgradeRecord> {
            self.0.load()
        }
        fn save(&self, r: &UpgradeRecord) {
            self.0.save(r)
        }
        fn clear(&self) {
            self.0.clear()
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
