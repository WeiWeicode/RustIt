//! Agent 替換 Watchdog(P6-3;設計 P6-UPGRADE-DESIGN §2.2、§5.3;契約 pipe.schema.json ReplaceWatchdog)。
//!
//! Watchdog 下載並驗證新版後,經本機管道送 `replace_watchdog`(只接受 Watchdog 服務的行程)→ [`validate`] Agent **自行再驗一次**
//! (路徑在 `cache\watchdog\` 底下、大小、SHA-256、Authenticode、簽章者 = 主機清單 ∩ 本機清單、版本資源)→ 回 `replace_watchdog_ack`
//! → [`replace`]:
//!
//! | 步驟 | 失敗時 |
//! | --- | --- |
//! | 維護中(看守 Watchdog 暫停)、`cache\` 與 `cache\watchdog\` 不是連結、寫 `replace.json` 標記(含舊版雜湊)、事件 `upgrade_started` | `REPLACE_FAILED`(沒動到服務) |
//! | 服務設定的程式必須是安裝目錄的 `rustit-watchdog.exe`;停止服務(握住行程控制代碼、逾時才結束行程) | `STOP_TIMEOUT` / `REPLACE_FAILED`(沒動到檔案,直接啟動舊版) |
//! | 舊版複製到 `previous\`(雜湊 = 標記的舊版雜湊)、新檔複製為 `.new` 再驗雜湊、簽章、簽章者、版本資源(TOCTOU)、`rename` 換上 | `REPLACE_FAILED` / `HASH_MISMATCH` / `SIGNATURE_INVALID` / `SIGNER_NOT_TRUSTED`(啟動舊版) |
//! | 啟動;2 分鐘內每 10 秒:服務執行中、PID 連續兩次相同、新 Watchdog 以該 PID 連上管道(版本由換上前的雜湊比對保證) | 還原 `previous\`(雜湊必須是舊版,不符不覆寫)→ 確認舊版跑起來 → `rolled_back`(`HEALTH_CHECK_FAILED`);還原也失敗 `ROLLBACK_FAILED` |
//!
//! 結果由 Agent 以事件 `upgrade_started` / `upgrade_succeeded` / `upgrade_failed`(`component = watchdog`)經 `/agent/v1/events` 上報。
//! Agent 在替換中途被重啟時,[`resume`] 依標記與目前 exe 收尾,不停在半套。

use crate::Shared;
use crate::events::EventQueue;
use crate::protocol::now_rfc3339;
use log::{info, warn};
use rustit_common::scm::{SvcInfo, SvcState};
use rustit_common::version;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::cmp::Ordering as Cmp;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub const COMPONENT: &str = "watchdog";
pub const WATCHDOG_EXE: &str = "rustit-watchdog.exe";
/// 可替換成的最低 Watchdog 版本:0.3.0 起才會經管道要求替換(更舊的版本換上去就再也不能升級)
pub const MIN_WATCHDOG_VERSION: &str = "0.3.0";
/// 升級檔大小上限(與 Watchdog 相同,不信任主機宣告)
pub const MAX_SIZE: u64 = 200 * 1024 * 1024;
pub const HEALTH_WINDOW: Duration = Duration::from_secs(120);
pub const HEALTH_POLL: Duration = Duration::from_secs(10);
/// ack 送出後再等多久才停止 Watchdog(讓它讀完回應)
pub const ACK_GRACE: Duration = Duration::from_secs(2);
/// 停止 Watchdog 服務的等待上限(逾時結束行程)
pub const STOP_TIMEOUT: Duration = Duration::from_secs(50);
/// Agent 端驗證(讀整個檔案、雜湊、WinVerifyTrust)的期限,逾時回拒絕 `REPLACE_FAILED`。三者關係:
/// 本值 50 秒 < 管道 `replace_watchdog` 的請求上限(`pipe.rs` `REPLACE_VERIFY_LIMIT`,60 秒)
/// < Watchdog 等 ack 的上限(`watchdog` `upgrade::REPLACE_ACK_TIMEOUT`,70 秒):驗證逾時時 Agent 先回明確的拒絕,
/// 不會在管道或 Watchdog 已放棄之後才驗證通過
pub const VALIDATE_LIMIT: Duration = Duration::from_secs(50);
/// 維護中標記(跨 Agent 重啟):`cache\watchdog\replace.json`
const MARKER: &str = "replace.json";
/// 標記大小上限;超過視為損毀(刪除並記警告,不讀)
const MARKER_MAX: u64 = 4 * 1024;

/// Agent 驗證 / 替換失敗(代碼同 event.schema.json UpgradeErrorCode)
#[derive(Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
    }
}

/// 管道 `replace_watchdog` 的內容(已通過 [`validate`])
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub version: String,
    pub path: PathBuf,
    pub sha256: String,
    /// 主機清單(管道送來的 signer_thumbprints)與本機信任清單:換上前對 `.new` 再驗簽章者
    pub signers: Vec<String>,
    pub trusted: Vec<String>,
}

/// 替換需要的外部操作(正式為 SCM / WinVerifyTrust / 管道紀錄,測試用假實作);全部同步,在阻塞執行緒執行
pub trait Env {
    fn signer(&self, path: &Path) -> Result<String, String>;
    fn product_version(&self, path: &Path) -> Option<String>;
    fn query(&self) -> Result<SvcInfo, String>;
    fn stop(&self, pid: Option<u32>) -> Result<(), String>;
    fn start(&self) -> Result<(), String>;
    /// 啟動前清除「Watchdog 連上管道」紀錄
    fn clear_seen(&self);
    /// 啟動後最近一次連上管道的 Watchdog PID(伺服端已比對 SCM)
    fn seen_pid(&self) -> Option<u32>;
    fn sleep(&self, d: Duration);
    fn now(&self) -> Instant;
    /// 維護中:看守 Watchdog 暫停
    fn maintenance(&self, on: bool);
    fn event(&self, kind: &'static str, data: Value);
}

/// 檔案位置:安裝目錄(Agent 與 Watchdog 同目錄)與下載快取 `cache\`
#[derive(Debug, Clone)]
pub struct Paths {
    pub install_dir: PathBuf,
    pub cache_dir: PathBuf,
}

impl Paths {
    fn exe(&self) -> PathBuf {
        self.install_dir.join(WATCHDOG_EXE)
    }
    fn previous(&self) -> PathBuf {
        self.install_dir.join("previous").join(WATCHDOG_EXE)
    }
    fn staged(&self) -> PathBuf {
        self.install_dir.join(format!("{WATCHDOG_EXE}.new"))
    }
    fn root(&self) -> PathBuf {
        self.cache_dir.join(COMPONENT)
    }
    fn marker(&self) -> PathBuf {
        self.root().join(MARKER)
    }
}

/// 標記內容:替換進行中(Agent 被重啟時據此收尾)
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Marker {
    version: String,
    sha256: String,
    from: Option<String>,
    /// 替換前安裝目錄 exe 的 SHA-256:還原前比對 `previous\`,不符就不覆寫
    old_sha256: String,
    started_at: String,
}

/// `cache\`、`cache\watchdog\` 必須是一般目錄,標記存在時必須是一般檔案(不是 junction / 符號連結);
/// 不通過就不讀、不寫、不刪標記,也不替換
fn cache_safe(paths: &Paths) -> Result<(), String> {
    use rustit_common::winfile::{not_reparse, plain_file};
    not_reparse(&paths.cache_dir)?;
    not_reparse(&paths.root())?;
    plain_file(&paths.marker()).map(|_| ())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f =
        std::fs::File::open(path).map_err(|e| format!("無法開啟 {}:{e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("無法讀取 {}:{e}", path.display()))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

fn cut(s: &str) -> String {
    s.chars().take(300).collect()
}

/// 簽章者必須同時在主機清單與本機清單(同 Watchdog 升級 Agent;共用 `rustit_common::authenticode`)
fn signer_allowed(signer: &str, host: &[String], local: &[String]) -> bool {
    rustit_common::authenticode::signer_allowed(signer, host, local)
}

/// 管道 `replace_watchdog` 的第二道驗證(Agent 不信任管道內容,即使來自 Watchdog 服務)
pub fn validate(
    env: &impl Env,
    paths: &Paths,
    body: &Value,
    trusted: &[String],
) -> Result<Request, Failure> {
    let text = |k: &str| body.get(k).and_then(Value::as_str).unwrap_or("");
    let ver = text("version");
    if ver.len() > 32 || version::core(ver).is_none() {
        return Err(fail("DOWNLOAD_FAILED", "版本格式錯誤"));
    }
    match version::compare(ver, MIN_WATCHDOG_VERSION) {
        Some(Cmp::Less) | None => {
            return Err(fail(
                "DOWNLOAD_FAILED",
                format!("不支援替換成 {MIN_WATCHDOG_VERSION} 以前的 Watchdog({ver})"),
            ));
        }
        _ => {}
    }
    let sha = text("sha256");
    if sha.len() != 64 || !sha.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return Err(fail("HASH_MISMATCH", "sha256 格式錯誤"));
    }
    let signers: Vec<String> = body
        .get("signer_thumbprints")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_ascii_lowercase))
                .collect()
        })
        .unwrap_or_default();
    if signers.is_empty() {
        return Err(fail("SIGNER_NOT_TRUSTED", "沒有預期的簽章者"));
    }
    // cache\ 被換成 junction 時正規化路徑會跟著連結走:先確認兩層都是一般目錄
    cache_safe(paths).map_err(|e| fail("REPLACE_FAILED", e))?;
    // 路徑必須在 cache\watchdog\ 底下(兩邊都取正規化路徑,擋 `..` 與連結)
    let root = std::fs::canonicalize(paths.root())
        .map_err(|e| fail("DOWNLOAD_FAILED", format!("無法讀取 cache\\watchdog:{e}")))?;
    let file = std::fs::canonicalize(text("path"))
        .map_err(|e| fail("DOWNLOAD_FAILED", format!("找不到升級檔:{e}")))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err(fail("DOWNLOAD_FAILED", "升級檔不在 cache\\watchdog\\ 底下"));
    }
    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    if size == 0 || size > MAX_SIZE {
        return Err(fail(
            "HASH_MISMATCH",
            format!("檔案大小 {size} 超過上限 {MAX_SIZE}"),
        ));
    }
    let got = sha256_file(&file).map_err(|e| fail("HASH_MISMATCH", e))?;
    if got != sha {
        return Err(fail("HASH_MISMATCH", format!("SHA-256 {got} 與要求不符")));
    }
    check_signed(env, &file, ver, &signers, trusted)?;
    Ok(Request {
        version: ver.to_string(),
        path: file,
        sha256: sha.to_string(),
        signers,
        trusted: trusted.to_vec(),
    })
}

/// Authenticode、簽章者(主機清單 ∩ 本機清單)、版本資源。[`validate`] 對快取檔、[`replace_files`] 對換上前的 `.new`
/// 各驗一次:雜湊、簽章、版本資源是分別開檔讀的,只驗快取檔擋不住驗證之間被換檔(TOCTOU)
fn check_signed(
    env: &impl Env,
    file: &Path,
    ver: &str,
    signers: &[String],
    trusted: &[String],
) -> Result<(), Failure> {
    let signer = env.signer(file).map_err(|e| fail("SIGNATURE_INVALID", e))?;
    if !signer_allowed(&signer, signers, trusted) {
        return Err(fail(
            "SIGNER_NOT_TRUSTED",
            format!(
                "簽章者 {signer} 不同時在主機清單與本機信任清單內(本機 {} 個)",
                trusted.len()
            ),
        ));
    }
    match env.product_version(file) {
        Some(v) if v == ver => Ok(()),
        v => Err(fail(
            "HASH_MISMATCH",
            format!(
                "檔案版本 {} 與目標 {ver} 不符",
                v.as_deref().unwrap_or("(無)")
            ),
        )),
    }
}

/// 離開時一定結束維護中(中途 panic 也不會讓看守永久暫停)
struct Maintenance<'a, E: Env>(&'a E);

impl<'a, E: Env> Maintenance<'a, E> {
    fn enter(env: &'a E) -> Self {
        env.maintenance(true);
        Self(env)
    }
}

impl<E: Env> Drop for Maintenance<'_, E> {
    fn drop(&mut self) {
        self.0.maintenance(false);
    }
}

fn event_data(to: &str, from: Option<&str>) -> Value {
    let mut d = json!({ "component": COMPONENT, "to": to });
    if let Some(f) = from {
        d["from"] = json!(f);
    }
    d
}

fn finish(
    env: &impl Env,
    to: &str,
    from: Option<&str>,
    started: Instant,
    f: Option<(bool, Failure)>,
) {
    let mut data = event_data(to, from);
    data["duration_ms"] = json!(env.now().saturating_duration_since(started).as_millis() as u64);
    match f {
        None => {
            info!("Watchdog 已升級為 {to}");
            env.event("upgrade_succeeded", data);
        }
        Some((rolled_back, f)) => {
            warn!("替換 Watchdog {to} 失敗:{} {}", f.code, f.message);
            data["error_code"] = json!(f.code);
            data["error_message"] = json!(cut(&f.message));
            data["rolled_back"] = json!(rolled_back);
            env.event("upgrade_failed", data);
        }
    }
}

/// 舊版複製到 previous\(覆蓋上一份;雜湊必須 = 標記的 `old_sha256`)→ 新檔複製為 .new,在目的地再驗雜湊、
/// 簽章、簽章者、版本資源 → 換上
fn replace_files(
    env: &impl Env,
    paths: &Paths,
    req: &Request,
    old_sha256: &str,
) -> Result<(), Failure> {
    let (exe, prev) = (paths.exe(), paths.previous());
    if let Some(d) = prev.parent() {
        std::fs::create_dir_all(d)
            .map_err(|e| fail("REPLACE_FAILED", format!("無法建立 {}:{e}", d.display())))?;
    }
    match sha256_file(&exe) {
        Ok(h) if h == old_sha256 => {}
        Ok(_) => return Err(fail("REPLACE_FAILED", "舊版在寫入標記後被改動")),
        Err(e) => return Err(fail("REPLACE_FAILED", e)),
    }
    std::fs::copy(&exe, &prev).map_err(|e| fail("REPLACE_FAILED", format!("無法備份舊版:{e}")))?;
    // 備份要確實是舊版:還原只靠它(複製成功不等於內容完整)
    match sha256_file(&prev) {
        Ok(h) if h == old_sha256 => {}
        Ok(_) => return Err(fail("REPLACE_FAILED", "備份的雜湊與舊版不符")),
        Err(e) => return Err(fail("REPLACE_FAILED", e)),
    }
    let staged = paths.staged();
    std::fs::copy(&req.path, &staged)
        .map_err(|e| fail("REPLACE_FAILED", format!("無法複製新版:{e}")))?;
    match sha256_file(&staged) {
        Ok(h) if h == req.sha256 => {}
        Ok(h) => {
            return Err(fail(
                "HASH_MISMATCH",
                format!("複製後的 SHA-256 {h} 與目標不符"),
            ));
        }
        Err(e) => return Err(fail("REPLACE_FAILED", e)),
    }
    // 換上的就是這個檔案:在目的地再驗簽章與版本(validate 驗的是快取檔)
    check_signed(env, &staged, &req.version, &req.signers, &req.trusted)?;
    std::fs::rename(&staged, &exe).map_err(|e| fail("REPLACE_FAILED", format!("無法換上新版:{e}")))
}

/// previous\ 換回;previous\ 的雜湊必須 = 替換前的舊版(`old_sha256`),不符就不覆寫 exe
fn restore_files(paths: &Paths, old_sha256: &str) -> Result<(), String> {
    let staged = paths.staged();
    let prev_hash = sha256_file(&paths.previous())?;
    if prev_hash != old_sha256 {
        return Err("previous\\ 的雜湊與替換前的舊版不符,不還原".into());
    }
    std::fs::copy(paths.previous(), &staged).map_err(|e| format!("無法複製備份:{e}"))?;
    if sha256_file(&staged)? != prev_hash {
        return Err("複製後的備份雜湊不符".into());
    }
    std::fs::rename(&staged, paths.exe()).map_err(|e| format!("無法換回舊版:{e}"))
}

/// 啟動後的檢查:2 分鐘內每 10 秒,服務執行中、PID 連續兩次相同、(`expect_seen`)新 Watchdog 以該 PID 連上管道。
/// 還原後(`expect_seen = false`)只要求服務穩定:舊 Watchdog 連管道是它自己的事,不能因此讓還原失敗
fn health(env: &impl Env, expect_seen: bool) -> Result<(), String> {
    let deadline = env.now() + HEALTH_WINDOW;
    let mut stable: Option<u32> = None;
    let mut last = String::from("2 分鐘內沒有回報");
    loop {
        env.sleep(HEALTH_POLL);
        match env.query() {
            Ok(SvcInfo {
                state: SvcState::Running,
                pid: Some(p),
                ..
            }) => {
                if expect_seen && env.seen_pid() != Some(p) {
                    last = "新 Watchdog 尚未連上管道".into();
                    stable = Some(p);
                } else if stable == Some(p) {
                    return Ok(());
                } else {
                    stable = Some(p);
                }
            }
            Ok(i) => {
                last = format!("Watchdog 服務 {}", i.state.as_str());
                stable = None;
            }
            Err(e) => {
                last = e;
                stable = None;
            }
        }
        if env.now() >= deadline {
            return Err(format!("新版 2 分鐘內不正常({last})"));
        }
    }
}

/// 啟動 Watchdog;失敗只記警告(呼叫端的結論由健康檢查或結果決定),不吞掉線索
fn start_logged(env: &impl Env, why: &str) {
    if let Err(e) = env.start() {
        warn!("{why}:啟動 Watchdog 失敗:{e}");
    }
}

/// 停止 → previous\ 換回 → 啟動 → 確認舊版穩定;回傳是否已還原並確認正常
fn rollback(
    env: &impl Env,
    paths: &Paths,
    old_sha256: &str,
    cause: &Failure,
) -> Result<(), String> {
    warn!(
        "替換 Watchdog 失敗({} {}),還原舊版",
        cause.code, cause.message
    );
    let pid = env.query().ok().and_then(|i| i.pid);
    if let Err(e) = env.stop(pid) {
        warn!("還原前停止 Watchdog 失敗:{e}");
    }
    let restored = restore_files(paths, old_sha256);
    if restored.is_err() {
        let _ = std::fs::remove_file(paths.staged());
    }
    env.clear_seen();
    let started = env.start();
    match (restored, started) {
        (Err(e), _) | (_, Err(e)) => Err(e),
        _ => health(env, false),
    }
}

/// 第 3–7 步:回傳 Ok 或 (已還原, 失敗)
fn swap(
    env: &impl Env,
    paths: &Paths,
    req: &Request,
    old_sha256: &str,
) -> Result<(), (bool, Failure)> {
    let info = env.query().map_err(|e| {
        (
            false,
            fail("REPLACE_FAILED", format!("無法查詢 Watchdog 服務:{e}")),
        )
    })?;
    // 服務設定的程式不是安裝目錄的 rustit-watchdog.exe(路徑被改):不替換別的檔案
    match &info.exe {
        Some(exe) if same_path(exe, &paths.exe()) => {}
        other => {
            return Err((
                false,
                fail(
                    "REPLACE_FAILED",
                    format!(
                        "Watchdog 服務的程式 {other:?} 不是 {}",
                        paths.exe().display()
                    ),
                ),
            ));
        }
    }
    if let Err(e) = env.stop(info.pid) {
        start_logged(env, "停止逾時後恢復");
        return Err((false, fail("STOP_TIMEOUT", e)));
    }
    if let Err(f) = replace_files(env, paths, req, old_sha256) {
        // 換上前失敗:exe 仍是舊版,直接啟動
        let _ = std::fs::remove_file(paths.staged());
        start_logged(env, "換檔失敗後恢復舊版");
        return Err((false, f));
    }
    env.clear_seen();
    let verdict = match env.start() {
        Err(e) => Err(fail("HEALTH_CHECK_FAILED", format!("新版無法啟動:{e}"))),
        Ok(()) => health(env, true).map_err(|e| fail("HEALTH_CHECK_FAILED", e)),
    };
    let Err(cause) = verdict else {
        return Ok(());
    };
    match rollback(env, paths, old_sha256, &cause) {
        Ok(()) => Err((
            true,
            fail(cause.code, format!("{},已還原舊版", cause.message)),
        )),
        Err(e) => Err((
            false,
            fail("ROLLBACK_FAILED", format!("{};還原失敗:{e}", cause.message)),
        )),
    }
}

/// 替換 Watchdog 的完整流程(阻塞;呼叫端放在阻塞執行緒)。`from` 為目前 exe 的版本
pub fn replace(env: &impl Env, paths: &Paths, req: &Request, from: Option<String>) {
    let started = env.now();
    let _m = Maintenance::enter(env);
    // 標記是 Agent 中途被重啟時收尾的依據:快取目錄是連結、舊版讀不到或標記寫不進就不開始(此時還沒動任何檔案)
    let marked = cache_safe(paths)
        .and_then(|_| sha256_file(&paths.exe()))
        .and_then(|old_sha256| {
            let marker = Marker {
                version: req.version.clone(),
                sha256: req.sha256.clone(),
                from: from.clone(),
                old_sha256,
                started_at: now_rfc3339(),
            };
            let t = serde_json::to_string(&marker).map_err(|e| e.to_string())?;
            std::fs::write(paths.marker(), t)
                .map_err(|e| format!("{}:{e}", paths.marker().display()))?;
            Ok(marker.old_sha256)
        });
    info!(
        "開始替換 Watchdog {} → {}",
        from.as_deref().unwrap_or("?"),
        req.version
    );
    env.event("upgrade_started", event_data(&req.version, from.as_deref()));
    let old_sha256 = match marked {
        Ok(h) => h,
        Err(e) => {
            finish(
                env,
                &req.version,
                from.as_deref(),
                started,
                Some((
                    false,
                    fail("REPLACE_FAILED", format!("無法寫入替換標記:{e}")),
                )),
            );
            return;
        }
    };
    let result = swap(env, paths, req, &old_sha256);
    let _ = std::fs::remove_file(paths.marker());
    finish(env, &req.version, from.as_deref(), started, result.err());
}

/// Agent 啟動時:上次替換 Watchdog 到一半被中斷(Agent 被重啟、關機)→ 依標記與目前 exe 收尾
pub fn resume(env: &impl Env, paths: &Paths) {
    // 快取目錄或標記是連結:不讀、不寫、不刪(刪除會跟著連結動到別處)
    if let Err(e) = cache_safe(paths) {
        // cache\watchdog\ 還沒建立(Watchdog 尚未啟動過)不是異常,不記警告
        if paths.root().exists() {
            warn!("{e};不收尾替換 Watchdog 的標記");
        }
        return;
    }
    let marker_path = paths.marker();
    let Ok(meta) = std::fs::metadata(&marker_path) else {
        return;
    };
    if meta.len() > MARKER_MAX {
        warn!(
            "{} 有 {} bytes,超過 {MARKER_MAX} bytes,視為損毀並刪除",
            marker_path.display(),
            meta.len()
        );
        let _ = std::fs::remove_file(&marker_path);
        return;
    }
    let Some(marker) = std::fs::read_to_string(&marker_path)
        .ok()
        .and_then(|t| serde_json::from_str::<Marker>(&t).ok())
    else {
        warn!("{} 內容損毀,刪除", marker_path.display());
        let _ = std::fs::remove_file(&marker_path);
        return;
    };
    warn!("上一次替換 Watchdog {} 在中途中斷,收尾中", marker.version);
    let started = env.now();
    let _m = Maintenance::enter(env);
    let _ = std::fs::remove_file(paths.staged());
    let from = marker.from.as_deref();
    let outcome = match sha256_file(&paths.exe()) {
        Ok(h) if h == marker.sha256 => {
            // 已換上新版:照健康檢查收尾
            env.clear_seen();
            start_logged(env, "收尾");
            match health(env, true) {
                Ok(()) => None,
                Err(e) => {
                    let cause = fail("HEALTH_CHECK_FAILED", e);
                    Some(match rollback(env, paths, &marker.old_sha256, &cause) {
                        Ok(()) => (
                            true,
                            fail(cause.code, format!("{},已還原舊版", cause.message)),
                        ),
                        Err(e) => (
                            false,
                            fail("ROLLBACK_FAILED", format!("{};還原失敗:{e}", cause.message)),
                        ),
                    })
                }
            }
        }
        Ok(_) => {
            // 還沒換上(或已還原):確認舊版跑起來。`upgrade_started` 已送出,補一筆結束事件,事件流才不會停在開始
            env.clear_seen();
            start_logged(env, "收尾");
            Some((
                true,
                fail("REPLACE_FAILED", "Agent 在替換前被重啟,替換中止,維持舊版"),
            ))
        }
        Err(e) if paths.previous().is_file() => {
            // exe 不見了(替換中斷):從 previous\ 換回
            let cause = fail(
                "REPLACE_FAILED",
                format!("Agent 在替換中途中斷,程式不完整:{e}"),
            );
            Some(match rollback(env, paths, &marker.old_sha256, &cause) {
                Ok(()) => (
                    true,
                    fail(cause.code, format!("{},已還原舊版", cause.message)),
                ),
                Err(e) => (
                    false,
                    fail("ROLLBACK_FAILED", format!("{};還原失敗:{e}", cause.message)),
                ),
            })
        }
        Err(e) => Some((
            false,
            fail("ROLLBACK_FAILED", format!("程式不見且沒有備份:{e}")),
        )),
    };
    let _ = std::fs::remove_file(paths.marker());
    finish(env, &marker.version, from, started, outcome);
}

/// 正式環境:SCM、WinVerifyTrust、Agent 的管道紀錄與事件佇列
pub(crate) struct RealEnv {
    pub(crate) shared: std::sync::Arc<Shared>,
}

#[cfg(windows)]
impl Env for RealEnv {
    fn signer(&self, path: &Path) -> Result<String, String> {
        rustit_common::authenticode::signer_thumbprint(path)
    }
    fn product_version(&self, path: &Path) -> Option<String> {
        rustit_common::winfile::product_version(path)
    }
    fn query(&self) -> Result<SvcInfo, String> {
        rustit_common::scm::query(rustit_common::scm::WATCHDOG_SERVICE)
    }
    fn stop(&self, pid: Option<u32>) -> Result<(), String> {
        rustit_common::scm::stop_or_kill(rustit_common::scm::WATCHDOG_SERVICE, pid, STOP_TIMEOUT)
    }
    fn start(&self) -> Result<(), String> {
        rustit_common::scm::start(rustit_common::scm::WATCHDOG_SERVICE)
    }
    fn clear_seen(&self) {
        if let Ok(mut s) = self.shared.watchdog_seen.lock() {
            *s = None;
        }
    }
    fn seen_pid(&self) -> Option<u32> {
        self.shared.watchdog_seen.lock().ok().and_then(|s| *s)
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d)
    }
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn maintenance(&self, on: bool) {
        self.shared.watchdog_replacing.store(on, Ordering::SeqCst);
    }
    fn event(&self, kind: &'static str, data: Value) {
        let q: &EventQueue = &self.shared.events;
        q.record(kind, now_rfc3339(), data);
    }
}

fn real_paths(shared: &Shared) -> Option<Paths> {
    Some(Paths {
        install_dir: std::env::current_exe().ok()?.parent()?.to_path_buf(),
        cache_dir: shared.cache_dir.clone(),
    })
}

/// 管道 `replace_watchdog_ack` 的 body(pipe.schema.json ReplaceWatchdogAck)
fn ack(failure: Option<&Failure>) -> Value {
    crate::protocol::replace_watchdog_ack(failure.map(|f| (f.code, f.message.as_str())))
}

/// 持有「替換進行中」旗標;Drop 時一定放開(含 panic、future 被取消),看守不會因此永久暫停
struct Hold(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Hold {
    fn try_take(flag: &std::sync::Arc<std::sync::atomic::AtomicBool>) -> Option<Self> {
        (!flag.swap(true, Ordering::SeqCst)).then(|| Self(flag.clone()))
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 管道 `replace_watchdog`(用戶端已確認是 Watchdog 服務):再驗一次 → 通過就回 accepted,稍後(等 Watchdog 讀完 ack)在背景替換。
/// 同時只做一次;驗證(讀整個檔案、WinVerifyTrust)放在阻塞執行緒。
/// 整個流程在獨立的 task 執行、旗標由它持有:管道請求逾時或用戶端斷線而取消這個 future 時,驗證與替換照常進行並在結束時放開旗標
pub(crate) async fn accept(shared: &std::sync::Arc<Shared>, body: Value) -> Value {
    let Some(hold) = Hold::try_take(&shared.watchdog_replacing) else {
        return ack(Some(&fail("REPLACE_FAILED", "已有替換 Watchdog 進行中")));
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let (checker, runner) = (shared.clone(), shared.clone());
    tokio::spawn(async move {
        let _hold = hold;
        let check = move || {
            let env = RealEnv {
                shared: checker.clone(),
            };
            let paths =
                real_paths(&checker).ok_or_else(|| fail("REPLACE_FAILED", "無法取得安裝目錄"))?;
            let req = validate(&env, &paths, &body, &checker.trusted_signers)?;
            let from = env.product_version(&paths.exe());
            Ok::<_, Failure>((req, paths, from))
        };
        let run = move |(req, paths, from): (Request, Paths, Option<String>)| {
            replace(&RealEnv { shared: runner }, &paths, &req, from)
        };
        hand_over(tx, VALIDATE_LIMIT, ACK_GRACE, check, run).await;
    });
    rx.await
        .unwrap_or_else(|_| ack(Some(&fail("REPLACE_FAILED", "替換工作中斷"))))
}

/// 驗證(阻塞執行緒,最多 `limit`,逾時回拒絕 REPLACE_FAILED)→ 回 ack → 要求方仍在等(管道請求沒有逾時、
/// 用戶端沒斷線)才在 `grace` 後替換;要求方已放棄就不替換(Watchdog 那邊已記失敗,替換會與它的紀錄不一致)。
/// 回傳是否已開始替換。驗證逾時時阻塞執行緒仍會跑完,但只讀檔,結果丟棄
async fn hand_over<T: Send + 'static>(
    tx: tokio::sync::oneshot::Sender<Value>,
    limit: Duration,
    grace: Duration,
    check: impl FnOnce() -> Result<T, Failure> + Send + 'static,
    run: impl FnOnce(T) + Send + 'static,
) -> bool {
    let checked = match tokio::time::timeout(limit, tokio::task::spawn_blocking(check)).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(fail("REPLACE_FAILED", format!("背景工作異常:{e}"))),
        Err(_) => Err(fail(
            "REPLACE_FAILED",
            format!("Agent 驗證升級檔超過 {} 秒", limit.as_secs()),
        )),
    };
    let t = match checked {
        Ok(t) => t,
        Err(f) => {
            warn!("拒絕 replace_watchdog:{} {}", f.code, f.message);
            let _ = tx.send(ack(Some(&f)));
            return false;
        }
    };
    if tx.send(ack(None)).is_err() {
        warn!("replace_watchdog 已驗證通過,但要求方已放棄(管道逾時或斷線),不替換");
        return false;
    }
    tokio::time::sleep(grace).await;
    if let Err(e) = tokio::task::spawn_blocking(move || run(t)).await {
        warn!("替換 Watchdog 的背景工作異常:{e}");
    }
    true
}

/// 服務啟動時收尾上次中斷的替換(沒有標記就什麼都不做);先取得旗標,避免與新的 replace_watchdog 同時進行
pub(crate) fn resume_service(shared: &std::sync::Arc<Shared>) {
    let Some(_hold) = Hold::try_take(&shared.watchdog_replacing) else {
        return;
    };
    if let Some(paths) = real_paths(shared) {
        resume(
            &RealEnv {
                shared: shared.clone(),
            },
            &paths,
        );
    }
}

#[cfg(test)]
mod tests;
