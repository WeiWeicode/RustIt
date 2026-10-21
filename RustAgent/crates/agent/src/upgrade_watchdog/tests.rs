//! 替換 Watchdog 測試(P6-UPGRADE-DESIGN §5.3、§8):SCM / 簽章 / 管道紀錄以假實作,檔案用暫存目錄。

use super::*;
use rustit_common::scm::{ExitKind, StartType};
use std::cell::{Cell, RefCell};

const OLD: &[u8] = b"MZ old watchdog 0.3.0";
const NEW: &[u8] = b"MZ new watchdog 0.3.1 .............................";
const SIGNER: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/// 某個版本啟動後的表現
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// 啟動後連上管道
    Healthy,
    /// 服務執行中但一直沒連管道
    NeverSeen,
    /// 啟動後立即結束
    Exits,
    /// 一直重啟:每次查詢 PID 都不同(PID 不穩定)
    Flapping,
}

struct Fake {
    install: PathBuf,
    signer: Result<String, String>,
    version: Option<String>,
    /// 換上前 `.new` 的簽章者 / 版本資源(None = 與快取檔相同):模擬驗證後被換成別的檔案(TOCTOU)
    staged_signer: Option<Result<String, String>>,
    staged_version: Option<Option<String>>,
    svc_exe: Option<PathBuf>,
    new_mode: Mode,
    old_mode: Mode,
    stop_fails: bool,
    pid: Cell<u32>,
    running: Cell<bool>,
    seen: Cell<Option<u32>>,
    now: Cell<Instant>,
    calls: RefCell<Vec<&'static str>>,
    events: RefCell<Vec<(&'static str, Value)>>,
    maint: RefCell<Vec<bool>>,
    /// 停止服務時讀這個檔案(檢查替換進行中的標記)
    peek: Option<PathBuf>,
    peeked: RefCell<Option<String>>,
}

impl Fake {
    fn new(install: &Path) -> Self {
        Self {
            install: install.to_path_buf(),
            signer: Ok(SIGNER.into()),
            version: Some("0.3.1".into()),
            staged_signer: None,
            staged_version: None,
            svc_exe: Some(install.join(WATCHDOG_EXE)),
            new_mode: Mode::Healthy,
            old_mode: Mode::Healthy,
            stop_fails: false,
            pid: Cell::new(100),
            running: Cell::new(true),
            seen: Cell::new(None),
            now: Cell::new(Instant::now()),
            calls: RefCell::new(Vec::new()),
            events: RefCell::new(Vec::new()),
            maint: RefCell::new(Vec::new()),
            peek: None,
            peeked: RefCell::new(None),
        }
    }

    fn installed(&self) -> Vec<u8> {
        std::fs::read(self.install.join(WATCHDOG_EXE)).unwrap_or_default()
    }

    fn mode(&self) -> Mode {
        if self.installed() == NEW {
            self.new_mode
        } else {
            self.old_mode
        }
    }

    fn kinds(&self) -> Vec<&'static str> {
        self.events.borrow().iter().map(|e| e.0).collect()
    }

    fn called(&self, c: &str) -> bool {
        self.calls.borrow().contains(&c)
    }
}

fn is_staged(p: &Path) -> bool {
    p.extension().is_some_and(|e| e == "new")
}

impl Env for Fake {
    fn signer(&self, p: &Path) -> Result<String, String> {
        match &self.staged_signer {
            Some(s) if is_staged(p) => s.clone(),
            _ => self.signer.clone(),
        }
    }
    fn product_version(&self, p: &Path) -> Option<String> {
        match &self.staged_version {
            Some(v) if is_staged(p) => v.clone(),
            _ => self.version.clone(),
        }
    }
    fn query(&self) -> Result<SvcInfo, String> {
        if self.mode() == Mode::Flapping && self.running.get() {
            self.pid.set(self.pid.get() + 1);
            self.seen.set(Some(self.pid.get()));
        }
        Ok(SvcInfo {
            state: if self.running.get() {
                SvcState::Running
            } else {
                SvcState::Stopped
            },
            pid: self.running.get().then(|| self.pid.get()),
            exit: ExitKind::Clean,
            start_type: StartType::Auto,
            exe: self.svc_exe.clone(),
        })
    }
    fn stop(&self, _: Option<u32>) -> Result<(), String> {
        self.calls.borrow_mut().push("stop");
        if let Some(p) = &self.peek
            && self.peeked.borrow().is_none()
        {
            *self.peeked.borrow_mut() = std::fs::read_to_string(p).ok();
        }
        if self.stop_fails {
            return Err("停止逾時".into());
        }
        self.running.set(false);
        Ok(())
    }
    fn start(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("start");
        self.pid.set(self.pid.get() + 1);
        match self.mode() {
            Mode::Exits => self.running.set(false),
            Mode::NeverSeen | Mode::Flapping => self.running.set(true),
            Mode::Healthy => {
                self.running.set(true);
                self.seen.set(Some(self.pid.get()));
            }
        }
        Ok(())
    }
    fn clear_seen(&self) {
        self.seen.set(None);
    }
    fn seen_pid(&self) -> Option<u32> {
        self.seen.get()
    }
    fn sleep(&self, d: Duration) {
        self.now.set(self.now.get() + d);
    }
    fn now(&self) -> Instant {
        self.now.get()
    }
    fn maintenance(&self, on: bool) {
        self.maint.borrow_mut().push(on);
    }
    fn event(&self, kind: &'static str, data: Value) {
        self.events.borrow_mut().push((kind, data));
    }
}

struct Setup {
    _dir: tempfile::TempDir,
    paths: Paths,
    fake: Fake,
    /// cache\watchdog\0.3.1\rustit-watchdog.exe
    new_file: PathBuf,
}

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let install = dir.path().join("install");
    let cache = dir.path().join("cache");
    let vdir = cache.join(COMPONENT).join("0.3.1");
    std::fs::create_dir_all(&install).unwrap();
    std::fs::create_dir_all(&vdir).unwrap();
    std::fs::write(install.join(WATCHDOG_EXE), OLD).unwrap();
    let new_file = vdir.join(WATCHDOG_EXE);
    std::fs::write(&new_file, NEW).unwrap();
    Setup {
        fake: Fake::new(&install),
        paths: Paths {
            install_dir: install,
            cache_dir: cache,
        },
        _dir: dir,
        new_file,
    }
}

fn body(s: &Setup) -> Value {
    json!({
        "version": "0.3.1",
        "path": s.new_file.to_string_lossy(),
        "sha256": sha(NEW),
        "signer_thumbprints": [SIGNER],
    })
}

fn trusted() -> Vec<String> {
    vec![SIGNER.to_string()]
}

fn ok(s: &Setup) -> Request {
    validate(&s.fake, &s.paths, &body(s), &trusted()).expect("通過驗證")
}

// ---------- validate ----------

#[test]
fn validate_accepts_a_good_request() {
    let s = setup();
    let r = ok(&s);
    assert_eq!(r.version, "0.3.1");
    assert_eq!(r.sha256, sha(NEW));
}

#[test]
fn validate_rejects_path_outside_cache() {
    let s = setup();
    let other = s.paths.install_dir.join("evil.exe");
    std::fs::write(&other, NEW).unwrap();
    let mut b = body(&s);
    b["path"] = json!(other.to_string_lossy());
    let e = validate(&s.fake, &s.paths, &b, &trusted()).unwrap_err();
    assert_eq!(e.code, "DOWNLOAD_FAILED");
    assert!(e.message.contains("cache"));
}

#[test]
fn validate_rejects_dotdot_escape() {
    let s = setup();
    let escape = s
        .paths
        .root()
        .join("0.3.1")
        .join("..")
        .join("..")
        .join("..")
        .join("install")
        .join(WATCHDOG_EXE);
    let mut b = body(&s);
    b["path"] = json!(escape.to_string_lossy());
    b["sha256"] = json!(sha(OLD));
    assert_eq!(
        validate(&s.fake, &s.paths, &b, &trusted())
            .unwrap_err()
            .code,
        "DOWNLOAD_FAILED"
    );
}

#[test]
fn validate_rejects_hash_mismatch() {
    let s = setup();
    let mut b = body(&s);
    b["sha256"] = json!(sha(b"other"));
    assert_eq!(
        validate(&s.fake, &s.paths, &b, &trusted())
            .unwrap_err()
            .code,
        "HASH_MISMATCH"
    );
}

#[test]
fn validate_rejects_bad_signature_and_untrusted_signer() {
    let mut s = setup();
    s.fake.signer = Err("未簽章".into());
    assert_eq!(
        validate(&s.fake, &s.paths, &body(&s), &trusted())
            .unwrap_err()
            .code,
        "SIGNATURE_INVALID"
    );
    s.fake.signer = Ok(SIGNER.into());
    // 本機清單沒有這個簽章者
    let other = vec!["0000000000000000000000000000000000000000".to_string()];
    assert_eq!(
        validate(&s.fake, &s.paths, &body(&s), &other)
            .unwrap_err()
            .code,
        "SIGNER_NOT_TRUSTED"
    );
    // 主機清單沒有這個簽章者
    let mut b = body(&s);
    b["signer_thumbprints"] = json!(["1111111111111111111111111111111111111111"]);
    assert_eq!(
        validate(&s.fake, &s.paths, &b, &trusted())
            .unwrap_err()
            .code,
        "SIGNER_NOT_TRUSTED"
    );
    // 沒有預期簽章者
    b["signer_thumbprints"] = json!([]);
    assert_eq!(
        validate(&s.fake, &s.paths, &b, &trusted())
            .unwrap_err()
            .code,
        "SIGNER_NOT_TRUSTED"
    );
}

#[test]
fn validate_rejects_wrong_version() {
    let mut s = setup();
    s.fake.version = Some("0.3.2".into());
    assert_eq!(
        validate(&s.fake, &s.paths, &body(&s), &trusted())
            .unwrap_err()
            .code,
        "HASH_MISMATCH"
    );
    s.fake.version = None;
    assert!(validate(&s.fake, &s.paths, &body(&s), &trusted()).is_err());
    let mut b = body(&s);
    b["version"] = json!("0.2.0");
    assert!(
        validate(&s.fake, &s.paths, &b, &trusted())
            .unwrap_err()
            .message
            .contains("0.3.0")
    );
    b["version"] = json!("not-a-version");
    assert!(validate(&s.fake, &s.paths, &b, &trusted()).is_err());
}

// ---------- replace ----------

#[test]
fn replace_succeeds() {
    let s = setup();
    let req = ok(&s);
    replace(&s.fake, &s.paths, &req, Some("0.3.0".into()));
    assert_eq!(s.fake.kinds(), ["upgrade_started", "upgrade_succeeded"]);
    assert_eq!(s.fake.installed(), NEW);
    assert_eq!(std::fs::read(s.paths.previous()).unwrap(), OLD);
    assert!(!s.paths.marker().exists());
    assert!(!s.paths.staged().exists());
    assert_eq!(*s.fake.maint.borrow(), [true, false]);
    let events = s.fake.events.borrow();
    assert_eq!(events[0].1["component"], "watchdog");
    assert_eq!(events[0].1["from"], "0.3.0");
    assert_eq!(events[1].1["to"], "0.3.1");
    assert!(events[1].1["duration_ms"].is_u64());
}

#[test]
fn replace_rolls_back_when_new_never_connects() {
    let mut s = setup();
    s.fake.new_mode = Mode::NeverSeen;
    let req = ok(&s);
    replace(&s.fake, &s.paths, &req, Some("0.3.0".into()));
    assert_eq!(s.fake.kinds(), ["upgrade_started", "upgrade_failed"]);
    let events = s.fake.events.borrow();
    assert_eq!(events[1].1["error_code"], "HEALTH_CHECK_FAILED");
    assert_eq!(events[1].1["rolled_back"], true);
    drop(events);
    assert_eq!(s.fake.installed(), OLD, "已還原舊版");
    assert!(s.fake.running.get());
    assert_eq!(*s.fake.maint.borrow(), [true, false]);
    assert!(!s.paths.marker().exists());
}

#[test]
fn replace_rolls_back_when_new_keeps_restarting() {
    // 服務一直在、也連得上管道,但 PID 每次都不同(不停重啟):不能算健康
    let mut s = setup();
    s.fake.new_mode = Mode::Flapping;
    let req = ok(&s);
    replace(&s.fake, &s.paths, &req, None);
    let events = s.fake.events.borrow();
    assert_eq!(events[1].1["error_code"], "HEALTH_CHECK_FAILED");
    assert_eq!(events[1].1["rolled_back"], true);
    drop(events);
    assert_eq!(s.fake.installed(), OLD);
}

#[test]
fn replace_rolls_back_when_new_exits() {
    let mut s = setup();
    s.fake.new_mode = Mode::Exits;
    let req = ok(&s);
    replace(&s.fake, &s.paths, &req, None);
    let events = s.fake.events.borrow();
    assert_eq!(events[1].1["rolled_back"], true);
    drop(events);
    assert_eq!(s.fake.installed(), OLD);
}

#[test]
fn replace_reports_rollback_failed_when_old_is_broken_too() {
    let mut s = setup();
    s.fake.new_mode = Mode::NeverSeen;
    s.fake.old_mode = Mode::Exits;
    let req = ok(&s);
    replace(&s.fake, &s.paths, &req, None);
    let events = s.fake.events.borrow();
    assert_eq!(events[1].1["error_code"], "ROLLBACK_FAILED");
    assert_eq!(events[1].1["rolled_back"], false);
}

#[test]
fn replace_refuses_when_service_points_elsewhere() {
    let mut s = setup();
    s.fake.svc_exe = Some(PathBuf::from(r"C:\Temp\evil.exe"));
    let req = ok(&s);
    replace(&s.fake, &s.paths, &req, None);
    assert!(!s.fake.called("stop"), "路徑被改:不停服務");
    assert_eq!(s.fake.installed(), OLD);
    let events = s.fake.events.borrow();
    assert_eq!(events[1].1["error_code"], "REPLACE_FAILED");
    assert_eq!(events[1].1["rolled_back"], false);
}

#[test]
fn replace_restarts_old_when_stop_fails() {
    let mut s = setup();
    s.fake.stop_fails = true;
    let req = ok(&s);
    replace(&s.fake, &s.paths, &req, None);
    assert!(s.fake.called("start"));
    assert_eq!(s.fake.installed(), OLD);
    let events = s.fake.events.borrow();
    assert_eq!(events[1].1["error_code"], "STOP_TIMEOUT");
}

#[test]
fn replace_detects_swap_of_file_after_validation() {
    // 驗證後、複製前檔案被換掉:複製後的雜湊不符 → 啟動舊版,不換上
    let s = setup();
    let mut req = ok(&s);
    req.sha256 = sha(b"changed after validation");
    replace(&s.fake, &s.paths, &req, None);
    assert_eq!(s.fake.installed(), OLD);
    assert!(s.fake.called("start"));
    let events = s.fake.events.borrow();
    assert_eq!(events[1].1["error_code"], "HASH_MISMATCH");
    drop(events);
    assert!(!s.paths.staged().exists());
}

// ---------- resume ----------

fn write_marker(s: &Setup) {
    let m = Marker {
        version: "0.3.1".into(),
        sha256: sha(NEW),
        from: Some("0.3.0".into()),
        old_sha256: sha(OLD),
        started_at: now_rfc3339(),
    };
    std::fs::write(s.paths.marker(), serde_json::to_string(&m).unwrap()).unwrap();
}

#[test]
fn resume_without_marker_does_nothing() {
    let s = setup();
    resume(&s.fake, &s.paths);
    assert!(s.fake.events.borrow().is_empty());
    assert!(s.fake.calls.borrow().is_empty());
}

#[test]
fn resume_finishes_when_new_is_already_in_place() {
    let s = setup();
    std::fs::write(s.paths.exe(), NEW).unwrap();
    write_marker(&s);
    resume(&s.fake, &s.paths);
    assert_eq!(s.fake.kinds(), ["upgrade_succeeded"]);
    assert!(!s.paths.marker().exists());
    assert_eq!(*s.fake.maint.borrow(), [true, false]);
}

#[test]
fn resume_rolls_back_when_new_in_place_is_unhealthy() {
    let mut s = setup();
    s.fake.new_mode = Mode::Exits;
    std::fs::create_dir_all(s.paths.previous().parent().unwrap()).unwrap();
    std::fs::write(s.paths.previous(), OLD).unwrap();
    std::fs::write(s.paths.exe(), NEW).unwrap();
    write_marker(&s);
    resume(&s.fake, &s.paths);
    let events = s.fake.events.borrow();
    assert_eq!(events[0].0, "upgrade_failed");
    assert_eq!(events[0].1["rolled_back"], true);
    drop(events);
    assert_eq!(s.fake.installed(), OLD);
}

#[test]
fn resume_just_restarts_when_old_is_still_in_place() {
    let s = setup();
    write_marker(&s);
    resume(&s.fake, &s.paths);
    // upgrade_started 已送出,要有結束事件(沒動到檔案、舊版維持 = 已還原)
    assert_eq!(s.fake.kinds(), ["upgrade_failed"]);
    let events = s.fake.events.borrow();
    assert_eq!(events[0].1["error_code"], "REPLACE_FAILED");
    assert_eq!(events[0].1["rolled_back"], true);
    drop(events);
    assert!(s.fake.called("start"));
    assert_eq!(s.fake.installed(), OLD);
    assert!(!s.paths.marker().exists());
}

#[test]
fn resume_restores_when_exe_is_missing() {
    let s = setup();
    std::fs::create_dir_all(s.paths.previous().parent().unwrap()).unwrap();
    std::fs::write(s.paths.previous(), OLD).unwrap();
    std::fs::remove_file(s.paths.exe()).unwrap();
    write_marker(&s);
    resume(&s.fake, &s.paths);
    let events = s.fake.events.borrow();
    assert_eq!(events[0].0, "upgrade_failed");
    assert_eq!(events[0].1["error_code"], "REPLACE_FAILED");
    assert_eq!(events[0].1["rolled_back"], true);
    drop(events);
    assert_eq!(s.fake.installed(), OLD);
}

#[test]
fn replace_aborts_when_marker_cannot_be_written() {
    // 標記寫不進去(cache\watchdog 不存在):還沒動檔案就中止,事件流 started → failed
    let s = setup();
    let req = ok(&s);
    std::fs::remove_file(&req.path).unwrap_or(());
    let root = s.paths.root();
    std::fs::remove_dir_all(&root).unwrap();
    replace(&s.fake, &s.paths, &req, None);
    assert_eq!(s.fake.kinds(), ["upgrade_started", "upgrade_failed"]);
    let events = s.fake.events.borrow();
    assert_eq!(events[1].1["error_code"], "REPLACE_FAILED");
    assert_eq!(events[1].1["rolled_back"], false);
    drop(events);
    assert!(!s.fake.called("stop"), "沒動服務");
    assert_eq!(s.fake.installed(), OLD);
}

#[test]
fn backup_and_restore_verify_hashes() {
    let s = setup();
    // 正常:備份 = 舊版;還原後 = 備份
    replace_files(&s.fake, &s.paths, &ok(&s), &sha(OLD)).unwrap();
    assert_eq!(std::fs::read(s.paths.previous()).unwrap(), OLD);
    restore_files(&s.paths, &sha(OLD)).unwrap();
    assert_eq!(std::fs::read(s.paths.exe()).unwrap(), OLD);
    // 沒有備份:還原失敗而不是換上空檔
    std::fs::remove_file(s.paths.previous()).unwrap();
    assert!(restore_files(&s.paths, &sha(OLD)).is_err());
    assert_eq!(std::fs::read(s.paths.exe()).unwrap(), OLD);
}

#[test]
fn replace_files_refuses_when_old_changed_after_marker() {
    // 標記記下的舊版雜湊與目前 exe 不符:不備份、不換上
    let s = setup();
    let e = replace_files(&s.fake, &s.paths, &ok(&s), &sha(b"other")).unwrap_err();
    assert_eq!(e.code, "REPLACE_FAILED");
    assert_eq!(s.fake.installed(), OLD);
    assert!(!s.paths.previous().exists());
}

#[test]
fn restore_refuses_previous_that_is_not_the_old_version() {
    // previous\ 被換掉(雜湊 ≠ 標記的舊版雜湊):不覆寫 exe
    let s = setup();
    std::fs::create_dir_all(s.paths.previous().parent().unwrap()).unwrap();
    std::fs::write(s.paths.previous(), b"MZ tampered").unwrap();
    std::fs::write(s.paths.exe(), NEW).unwrap();
    assert!(restore_files(&s.paths, &sha(OLD)).is_err());
    assert_eq!(s.fake.installed(), NEW);
    assert!(!s.paths.staged().exists());
}

// ---------- 換上前再驗簽章(TOCTOU) ----------

#[test]
fn replace_rechecks_signature_of_staged_file() {
    for (signer, version, code) in [
        (Some(Err("未簽章".to_string())), None, "SIGNATURE_INVALID"),
        (
            Some(Ok("0000000000000000000000000000000000000000".to_string())),
            None,
            "SIGNER_NOT_TRUSTED",
        ),
        (None, Some(Some("0.3.9".to_string())), "HASH_MISMATCH"),
    ] {
        let mut s = setup();
        let req = ok(&s);
        // 驗證通過後,換上前的 .new 簽章 / 版本不符
        s.fake.staged_signer = signer;
        s.fake.staged_version = version;
        replace(&s.fake, &s.paths, &req, Some("0.3.0".into()));
        let events = s.fake.events.borrow();
        assert_eq!(events[1].1["error_code"], code);
        assert_eq!(events[1].1["rolled_back"], false);
        drop(events);
        assert_eq!(s.fake.installed(), OLD, "{code}:不換上,舊版維持");
        assert!(s.fake.called("start"), "{code}:啟動舊版");
        assert!(!s.paths.staged().exists());
        assert!(!s.paths.marker().exists());
    }
}

// ---------- 標記 ----------

#[test]
fn resume_deletes_oversized_marker_without_acting() {
    let s = setup();
    std::fs::write(s.paths.marker(), vec![b' '; MARKER_MAX as usize + 1]).unwrap();
    resume(&s.fake, &s.paths);
    assert!(!s.paths.marker().exists(), "超過 4 KB 視為損毀並刪除");
    assert!(s.fake.events.borrow().is_empty());
    assert!(s.fake.calls.borrow().is_empty());
    // 損毀(不是 JSON)同樣刪除
    std::fs::write(s.paths.marker(), b"{not json").unwrap();
    resume(&s.fake, &s.paths);
    assert!(!s.paths.marker().exists());
    assert!(s.fake.calls.borrow().is_empty());
}

#[test]
fn replace_writes_old_hash_into_marker() {
    // 停止服務時(替換進行中)讀標記內容
    let mut s = setup();
    s.fake.peek = Some(s.paths.marker());
    let req = ok(&s);
    replace(&s.fake, &s.paths, &req, None);
    let text = s.fake.peeked.borrow().clone().expect("停止時標記存在");
    let m: Marker = serde_json::from_str(&text).unwrap();
    assert_eq!(m.old_sha256, sha(OLD));
    assert_eq!(m.sha256, sha(NEW));
    assert!(!s.paths.marker().exists(), "結束後刪除");
}

#[test]
fn resume_reports_rollback_failed_when_previous_was_tampered() {
    let mut s = setup();
    s.fake.new_mode = Mode::Exits;
    std::fs::create_dir_all(s.paths.previous().parent().unwrap()).unwrap();
    std::fs::write(s.paths.previous(), b"MZ tampered").unwrap();
    std::fs::write(s.paths.exe(), NEW).unwrap();
    write_marker(&s);
    resume(&s.fake, &s.paths);
    let events = s.fake.events.borrow();
    assert_eq!(events[0].0, "upgrade_failed");
    assert_eq!(events[0].1["error_code"], "ROLLBACK_FAILED");
    assert_eq!(events[0].1["rolled_back"], false);
    drop(events);
    assert_eq!(s.fake.installed(), NEW, "previous\\ 不是舊版:不覆寫 exe");
}

// ---------- 快取目錄是連結(junction) ----------

fn junction(link: &Path, target: &Path) {
    let out = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(out.status.success(), "建立 junction 失敗:{out:?}");
}

/// cache\watchdog\ 換成指向別處的 junction(內容相同)
fn setup_junction() -> (Setup, PathBuf) {
    let s = setup();
    let elsewhere = s.paths.cache_dir.join("elsewhere");
    std::fs::rename(s.paths.root(), &elsewhere).unwrap();
    junction(&s.paths.root(), &elsewhere);
    (s, elsewhere)
}

#[test]
fn junction_cache_is_refused_everywhere() {
    let (s, elsewhere) = setup_junction();
    // validate:拒絕(REPLACE_FAILED)
    let e = validate(&s.fake, &s.paths, &body(&s), &trusted()).unwrap_err();
    assert_eq!(e.code, "REPLACE_FAILED");
    // resume:不讀、不刪連結另一端的標記,也不動服務
    let m = Marker {
        version: "0.3.1".into(),
        sha256: sha(NEW),
        from: None,
        old_sha256: sha(OLD),
        started_at: now_rfc3339(),
    };
    std::fs::write(elsewhere.join(MARKER), serde_json::to_string(&m).unwrap()).unwrap();
    resume(&s.fake, &s.paths);
    assert!(elsewhere.join(MARKER).exists());
    assert!(s.fake.calls.borrow().is_empty());
    assert!(s.fake.events.borrow().is_empty());
    std::fs::remove_file(elsewhere.join(MARKER)).unwrap();
    // replace(驗證後才被換成連結):不寫標記、不動服務
    let req = Request {
        version: "0.3.1".into(),
        path: s.new_file.clone(),
        sha256: sha(NEW),
        signers: vec![SIGNER.into()],
        trusted: trusted(),
    };
    replace(&s.fake, &s.paths, &req, None);
    assert_eq!(s.fake.kinds(), ["upgrade_started", "upgrade_failed"]);
    assert_eq!(s.fake.events.borrow()[1].1["error_code"], "REPLACE_FAILED");
    assert!(!s.fake.called("stop"));
    assert!(!elsewhere.join(MARKER).exists());
    assert_eq!(s.fake.installed(), OLD);
}

#[test]
fn marker_that_is_a_directory_is_left_alone() {
    let s = setup();
    std::fs::create_dir(s.paths.marker()).unwrap();
    resume(&s.fake, &s.paths);
    assert!(s.paths.marker().is_dir(), "不是一般檔案:不刪");
    assert!(s.fake.calls.borrow().is_empty());
    assert_eq!(
        validate(&s.fake, &s.paths, &body(&s), &trusted())
            .unwrap_err()
            .code,
        "REPLACE_FAILED"
    );
}

// ---------- 回 ack 與替換的交接 ----------

fn flag() -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false))
}

#[tokio::test]
async fn hand_over_does_not_replace_when_requester_is_gone() {
    // 管道已逾時 / 用戶端斷線:驗證通過也不替換
    let ran = flag();
    let r = ran.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    drop(rx);
    let started = hand_over(
        tx,
        Duration::from_secs(5),
        Duration::ZERO,
        || Ok(()),
        move |()| r.store(true, Ordering::SeqCst),
    )
    .await;
    assert!(!started);
    assert!(!ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn hand_over_rejects_when_validation_takes_too_long() {
    let ran = flag();
    let r = ran.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let started = hand_over(
        tx,
        Duration::from_millis(50),
        Duration::ZERO,
        || {
            std::thread::sleep(Duration::from_millis(500));
            Ok(())
        },
        move |()| r.store(true, Ordering::SeqCst),
    )
    .await;
    assert!(!started);
    let reply = rx.await.unwrap();
    assert_eq!(reply["accepted"], false);
    assert_eq!(reply["error_code"], "REPLACE_FAILED");
    assert!(!ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn hand_over_replaces_after_accepted_ack() {
    let ran = flag();
    let r = ran.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let started = hand_over(
        tx,
        Duration::from_secs(5),
        Duration::ZERO,
        || Ok(()),
        move |()| r.store(true, Ordering::SeqCst),
    )
    .await;
    assert!(started);
    assert_eq!(rx.await.unwrap()["accepted"], true);
    assert!(ran.load(Ordering::SeqCst));
    // 驗證失敗:回拒絕,不替換
    let ran = flag();
    let r = ran.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    assert!(
        !hand_over(
            tx,
            Duration::from_secs(5),
            Duration::ZERO,
            || Err::<(), _>(fail("HASH_MISMATCH", "x")),
            move |()| r.store(true, Ordering::SeqCst),
        )
        .await
    );
    assert_eq!(rx.await.unwrap()["error_code"], "HASH_MISMATCH");
    assert!(!ran.load(Ordering::SeqCst));
}

#[test]
fn time_limits_are_ordered() {
    // Agent 驗證期限 < 管道請求上限(60 秒)< Watchdog 等 ack(70 秒)
    assert!(VALIDATE_LIMIT < Duration::from_secs(60));
}

#[test]
fn hold_releases_the_flag_even_if_dropped_early() {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    let flag = Arc::new(AtomicBool::new(false));
    let h = Hold::try_take(&flag).expect("取得旗標");
    assert!(Hold::try_take(&flag).is_none(), "同時只能一個");
    assert!(flag.load(Ordering::SeqCst));
    drop(h);
    assert!(!flag.load(Ordering::SeqCst), "放開後可再取得");
    assert!(Hold::try_take(&flag).is_some());
}
