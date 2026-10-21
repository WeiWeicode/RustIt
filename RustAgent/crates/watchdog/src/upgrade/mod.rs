//! Watchdog 升級 Agent(P6-2;設計 P6-UPGRADE-DESIGN §5.2、§8.2;契約 watchdog.schema.json UpgradeTarget / UpgradeProgress、event.schema.json Upgrade)。
//!
//! 上報回應帶 `target.agent` → [`Upgrader::run`]:
//!
//! | 步驟 | 狀態 | 失敗時 |
//! | --- | --- | --- |
//! | 檢查目標(url 的元件 / 版本段與目標一致、版本 ≥ 0.7.0、大小 ≤ 200 MB);同一目標已失敗 2 次不再嘗試 | — | `failed`(`DOWNLOAD_FAILED`) |
//! | 磁碟剩餘 ≥ 500 MB → 下載到 `cache\agent\{版本}\{檔名}.part`(中斷後以 Range 續傳,最多 3 次) | `downloading` | `DISK_FULL` / `DOWNLOAD_FAILED` |
//! | 大小、SHA-256(以 `target.sha256` 驗整個檔案,不採信回應標頭)、Authenticode、簽章者(主機清單 ∩ 本機清單)、版本資源 | `verifying` | `HASH_MISMATCH` / `SIGNATURE_INVALID` / `SIGNER_NOT_TRUSTED`(刪檔,不還原) |
//! | 維護中(看守暫停)→ 管道 `prepare_shutdown`(90 秒,逾時照樣繼續)→ 停止服務 → `previous\` 備份 → `.new` 再驗雜湊 → 換上 → 啟動 | `installing` | `STOP_TIMEOUT` / `REPLACE_FAILED` |
//! | 2 分鐘內每 10 秒 `get_status`:版本 = 目標、`ws_connected`、PID 連續兩次相同 | `succeeded` | 還原 `previous\` → 確認舊版正常 → `rolled_back`(`HEALTH_CHECK_FAILED`);還原也失敗 `failed`(`ROLLBACK_FAILED`) |
//!
//! - 每一步先寫本機 `watchdog.db` 的 `upgrade` 表再上報;Watchdog 在 `installing` 中途被重啟時 [`Upgrader::resume`] 依目前 exe 收尾,不停在半套
//! - 失敗次數:同一目標版本進入失敗(含還原)加一,達 [`MAX_ATTEMPTS`] 不再自動嘗試;`agent.upgrade`(Agent 管道 `upgrade_requested`)重設
//! - SCM / 管道 / 下載 / 簽章 / 本機紀錄經 [`UpgradeEnv`] 注入(正式 [`swap::RealEnv`],測試用假實作);檔案操作直接用檔案系統(測試用暫存目錄)
//! - Watchdog 自己的升級(`target.watchdog`,P6-3):[`Upgrader::run_watchdog`] 同樣下載、驗證(SHA-256、簽章、簽章者、版本資源),
//!   然後經管道 `replace_watchdog` 交給 Agent(Watchdog 不覆寫自己);Agent 再驗一次並替換,結果由 Agent 上報事件。
//!   新版 Watchdog 啟動時 [`Upgrader::resume_watchdog`] 依自己的版本收尾本機紀錄(= 目標 `succeeded`,否則 `rolled_back`;
//!   `succeeded` 後被 Agent 換回舊版也記 `rolled_back`)。交給 Agent 超過 [`WATCHDOG_REPLACE_STALE`] 仍是舊版的
//!   `installing` 紀錄,下次目標到時記 `rolled_back`(Agent 沒動到服務的失敗路徑)

pub mod download;
pub mod swap;

use crate::monitor::AgentStatus;
use log::{info, warn};
use rustit_common::authenticode::signer_allowed;
use rustit_common::scm::SvcInfo;
use rustit_common::version;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const COMPONENT: &str = "agent";
pub const AGENT_EXE: &str = "rustit-agent.exe";
pub const WATCHDOG_COMPONENT: &str = "watchdog";
/// 可替換成的最低 Watchdog 版本:0.3.0 起才會經管道要求替換(與 Agent 相同)
pub const MIN_WATCHDOG_VERSION: &str = "0.3.0";
/// replace_watchdog 等 Agent 回 ack 的上限(Agent 要讀整個檔案、驗簽章)。
/// 大於 Agent 管道的請求上限(60 秒)與 Agent 自己的驗證期限(50 秒):Agent 驗證逾時時先回拒絕,這裡收得到明確結果
pub const REPLACE_ACK_TIMEOUT: Duration = Duration::from_secs(70);
/// Watchdog 紀錄停在 installing(已交給 Agent)多久仍是舊版就視為替換逾時:Agent 在沒動到服務的失敗路徑
/// (查詢服務失敗、服務 exe 路徑不符)下不會停止這個行程,紀錄不會由 resume_watchdog 收尾(審查必修 B)。
/// Agent 替換最長約為停止 + 2 分鐘健康檢查 + 還原 2 分鐘;從 started_at(開始下載)起算,留足餘裕
pub const WATCHDOG_REPLACE_STALE: Duration = Duration::from_secs(15 * 60);
/// 同一目標版本失敗幾次後不再自動嘗試(與主機相同)
pub const MAX_ATTEMPTS: u32 = 2;
/// 升級檔大小上限(不信任主機宣告,§8.2)
pub const MAX_SIZE: u64 = 200 * 1024 * 1024;
/// 磁碟剩餘少於此值不下載
pub const MIN_FREE: u64 = 500 * 1024 * 1024;
/// 可升級 / 降版到的最低 Agent 版本:0.7.0 起才認得 agent.toml 的 `[upgrade]`,更舊的版本讀不了新的設定檔
pub const MIN_AGENT_VERSION: &str = "0.7.0";
/// prepare_shutdown 等待(Agent 執行中的指令等 60 秒 + 送完待送 20 秒 + 餘裕,§9-6)
pub const PREPARE_TIMEOUT: Duration = Duration::from_secs(90);
pub const HEALTH_WINDOW: Duration = Duration::from_secs(120);
pub const HEALTH_POLL: Duration = Duration::from_secs(10);
const DOWNLOAD_TRIES: u32 = 3;
const DOWNLOAD_RETRY: [u64; 2] = [10, 30];
/// cache\ 每個元件保留的版本數
const KEEP_VERSIONS: usize = 2;

/// 升級的元件:下載目錄、版本下限不同,下載與驗證流程相同
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comp {
    Agent,
    Watchdog,
}

impl Comp {
    pub fn name(self) -> &'static str {
        match self {
            Comp::Agent => COMPONENT,
            Comp::Watchdog => WATCHDOG_COMPONENT,
        }
    }

    fn min_version(self) -> &'static str {
        match self {
            Comp::Agent => MIN_AGENT_VERSION,
            Comp::Watchdog => MIN_WATCHDOG_VERSION,
        }
    }
}

/// 上報回應 `target.agent`(watchdog.schema.json UpgradeTarget)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UpgradeTarget {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub signer_thumbprints: Vec<String>,
}

/// 上報回應 `target` 的兩個元件目標(沒有 / 不要升級 = None)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Targets {
    pub agent: Option<UpgradeTarget>,
    pub watchdog: Option<UpgradeTarget>,
}

/// 本機 `upgrade` 表的一列(每個元件一列)
#[derive(Debug, Clone, PartialEq)]
pub struct UpgradeRecord {
    pub component: String,
    pub target_version: String,
    /// 中途重啟時用來判斷 exe 是否已換成新版
    pub target_sha256: String,
    pub from_version: Option<String>,
    /// downloading / verifying / installing / succeeded / failed / rolled_back
    pub state: String,
    pub attempts: u32,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    /// RFC 3339
    pub started_at: String,
}

impl UpgradeRecord {
    /// 上報的 `upgrade`(watchdog.schema.json UpgradeProgress)
    pub fn progress(&self) -> Value {
        let mut v = json!({
            "component": self.component,
            "target_version": self.target_version,
            "state": self.state,
            "attempts": self.attempts,
        });
        if let Some(f) = &self.from_version {
            v["from_version"] = json!(f);
        }
        if let Some(c) = &self.error_code {
            v["error_code"] = json!(c);
        }
        if let Some(m) = &self.error_message {
            v["error_message"] = json!(m);
        }
        v
    }

    pub fn terminal(&self) -> bool {
        matches!(self.state.as_str(), "succeeded" | "failed" | "rolled_back")
    }
}

/// 下載一次的結果
#[derive(Debug, PartialEq, Eq)]
pub enum Fetched {
    /// 檔案總長
    Done(u64),
    /// 續傳位置不被接受(416):刪掉續傳檔重來
    RangeNotSatisfiable,
}

/// 升級需要的外部操作(正式為 SCM / 管道 / mTLS 下載 / WinVerifyTrust / watchdog.db,測試用假實作)
#[allow(async_fn_in_trait)]
pub trait UpgradeEnv {
    /// 從 `offset` 續傳到 `part`(總長不可超過 `limit`)
    async fn download(
        &self,
        url: &str,
        part: &Path,
        offset: u64,
        limit: u64,
    ) -> Result<Fetched, String>;
    fn free_bytes(&self, dir: &Path) -> Result<u64, String>;
    /// Authenticode 驗證通過時回傳簽章者 SHA-1 指紋
    fn signer(&self, path: &Path) -> Result<String, String>;
    /// exe 版本資源的 ProductVersion
    fn product_version(&self, path: &Path) -> Option<String>;
    async fn query(&self) -> Result<SvcInfo, String>;
    /// 管道 prepare_shutdown,等 Agent 回 ack(最多 [`PREPARE_TIMEOUT`])
    async fn prepare_shutdown(&self, pid: u32) -> Result<(), String>;
    /// 管道 get_status(伺服端 PID 必須是 `pid`)
    async fn get_status(&self, pid: u32) -> Result<AgentStatus, String>;
    /// 停止 Agent 服務(逾時結束行程)
    async fn stop(&self, pid: Option<u32>) -> Result<(), String>;
    async fn start(&self) -> Result<(), String>;
    async fn sleep(&self, d: Duration);
    fn now(&self) -> Instant;
    /// Windows 關機中、Windows Installer 執行中:不開始安裝
    fn hands_off(&self) -> bool;
    fn load(&self) -> Option<UpgradeRecord> {
        self.load_component(COMPONENT)
    }
    /// 指定元件的本機紀錄
    fn load_component(&self, component: &str) -> Option<UpgradeRecord>;
    fn save(&self, rec: &UpgradeRecord);
    /// 刪除紀錄(中斷但沒動到 Agent 的升級:不算失敗,下次目標重新來)
    fn clear(&self) {
        self.clear_component(COMPONENT);
    }
    fn clear_component(&self, component: &str);
    fn event(&self, kind: &'static str, data: Value);
    /// 管道 replace_watchdog(P6-3):交給 Agent 替換 Watchdog,等它回 ack(最多 [`REPLACE_ACK_TIMEOUT`]);
    /// 拒絕時回 (error_code, 說明)
    async fn replace_watchdog(
        &self,
        agent_pid: u32,
        target: &UpgradeTarget,
        path: &Path,
    ) -> Result<(), (String, String)>;
    /// 維護中:看守暫停,不把升級造成的停止當成竄改
    fn maintenance(&self, on: bool);
}

/// 一次升級的結果(呼叫端記日誌用)
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 不需要或不可嘗試(已是目標、失敗次數已滿、關機中)
    Skipped(&'static str),
    Succeeded,
    /// Watchdog 目標:已交給 Agent 替換(結果由 Agent 與新版 Watchdog 上報)
    HandedOff,
    /// 失敗(state、error_code)
    Failed(&'static str, &'static str),
}

struct Failure {
    code: &'static str,
    message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
    }
}

/// 管道 `replace_watchdog` 的 body(pipe.schema.json ReplaceWatchdog,P6-3)
pub fn replace_watchdog_body(target: &UpgradeTarget, path: &Path) -> Value {
    json!({
        "version": target.version,
        "path": path.to_string_lossy(),
        "sha256": target.sha256,
        "signer_thumbprints": target.signer_thumbprints,
    })
}

/// Agent 回的 error_code 轉成已知代碼(event.schema.json UpgradeErrorCode);不認得的一律 REPLACE_FAILED
fn known_code(code: &str) -> &'static str {
    const CODES: [&str; 10] = [
        "DOWNLOAD_FAILED",
        "HASH_MISMATCH",
        "SIGNATURE_INVALID",
        "SIGNER_NOT_TRUSTED",
        "STOP_TIMEOUT",
        "REPLACE_FAILED",
        "HEALTH_CHECK_FAILED",
        "ROLLBACK_FAILED",
        "DISK_FULL",
        "PREPARE_TIMEOUT",
    ];
    CODES
        .iter()
        .find(|c| **c == code)
        .copied()
        .unwrap_or("REPLACE_FAILED")
}

/// 檔案位置:Agent 安裝目錄(Watchdog 同目錄)與下載快取 `cache\`
#[derive(Debug, Clone)]
pub struct Paths {
    pub install_dir: PathBuf,
    pub cache_dir: PathBuf,
}

impl Paths {
    fn exe(&self) -> PathBuf {
        self.install_dir.join(AGENT_EXE)
    }
    fn previous(&self) -> PathBuf {
        self.install_dir.join("previous").join(AGENT_EXE)
    }
    fn staged(&self) -> PathBuf {
        self.install_dir.join(format!("{AGENT_EXE}.new"))
    }
    pub fn version_dir(&self, v: &str) -> PathBuf {
        self.cache_dir.join(COMPONENT).join(v)
    }
    fn comp_dir(&self, comp: Comp, v: &str) -> PathBuf {
        self.cache_dir.join(comp.name()).join(v)
    }
}

pub struct Upgrader<'a, E: UpgradeEnv> {
    pub env: &'a E,
    pub paths: Paths,
    /// 本機信任清單(agent.toml [upgrade] trusted_signers)
    pub trusted: Vec<String>,
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

fn cut(s: &str) -> String {
    s.chars().take(300).collect()
}

/// 主機給的字串寫日誌前:去掉控制字元、最多 64 字(資安 L1)
fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(64).collect()
}

/// 在阻塞執行緒算 SHA-256(檔案最大 200 MB,不佔 async 工作執行緒)
async fn hash(path: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || sha256_file(&path))
        .await
        .map_err(|e| format!("背景工作異常:{e}"))?
}

/// 離開時一定結束維護中(安裝中途 panic 也不會讓看守永久暫停,資安 L5)
struct Maintenance<'a, E: UpgradeEnv>(&'a E);

impl<'a, E: UpgradeEnv> Maintenance<'a, E> {
    fn enter(env: &'a E) -> Self {
        env.maintenance(true);
        Self(env)
    }
}

impl<E: UpgradeEnv> Drop for Maintenance<'_, E> {
    fn drop(&mut self) {
        self.0.maintenance(false);
    }
}

/// 第 5 步的檔案操作(阻塞執行緒):舊版複製到 previous\(覆蓋上一份)→ 新檔複製為 .new、在目的地再驗雜湊 →
/// 換上(同磁碟區改名 = MoveFileEx REPLACE_EXISTING)
fn replace_files(paths: &Paths, new: &Path, sha256: &str) -> Result<(), Failure> {
    let exe = paths.exe();
    let prev = paths.previous();
    if let Some(d) = prev.parent() {
        std::fs::create_dir_all(d)
            .map_err(|e| fail("REPLACE_FAILED", format!("無法建立 {}:{e}", d.display())))?;
    }
    std::fs::copy(&exe, &prev).map_err(|e| fail("REPLACE_FAILED", format!("無法備份舊版:{e}")))?;
    let staged = paths.staged();
    std::fs::copy(new, &staged).map_err(|e| fail("REPLACE_FAILED", format!("無法複製新版:{e}")))?;
    match sha256_file(&staged) {
        Ok(h) if h == sha256 => {}
        Ok(h) => {
            return Err(fail(
                "HASH_MISMATCH",
                format!("複製後的 SHA-256 {h} 與目標不符"),
            ));
        }
        Err(e) => return Err(fail("REPLACE_FAILED", e)),
    }
    std::fs::rename(&staged, &exe).map_err(|e| fail("REPLACE_FAILED", format!("無法換上新版:{e}")))
}

/// previous\ 換回(阻塞執行緒)
fn restore_files(paths: &Paths) -> Result<(), String> {
    let staged = paths.staged();
    std::fs::copy(paths.previous(), &staged).map_err(|e| format!("無法複製備份:{e}"))?;
    std::fs::rename(&staged, paths.exe()).map_err(|e| format!("無法換回舊版:{e}"))
}

async fn blocking_fs<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

/// `started_at`(RFC 3339)距今超過 [`WATCHDOG_REPLACE_STALE`];解析不了也算(不讓壞紀錄永遠擋住替換)
fn stale(started_at: &str) -> bool {
    let limit = chrono::Duration::from_std(WATCHDOG_REPLACE_STALE).unwrap_or_default();
    chrono::DateTime::parse_from_rfc3339(started_at)
        .map(|t| chrono::Utc::now() - t.with_timezone(&chrono::Utc) > limit)
        .unwrap_or(true)
}

/// 檢查主機下發的目標(§8.2);回傳下載檔名
fn check_target(t: &UpgradeTarget, comp: Comp) -> Result<String, String> {
    let file = version::release_file(&t.url, comp.name(), &t.version)?.to_string();
    let min = comp.min_version();
    match version::compare(&t.version, min) {
        None => return Err(format!("版本格式錯誤:{}", t.version)),
        Some(Ordering::Less) => {
            return Err(format!(
                "不支援降版到 {min} 以前({}):{}",
                t.version,
                match comp {
                    Comp::Agent => "舊版讀不了目前的 agent.toml",
                    Comp::Watchdog => "舊版不會經管道要求替換,換上去就無法再升級",
                }
            ));
        }
        _ => {}
    }
    if t.sha256.len() != 64 || !t.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return Err("sha256 格式錯誤".into());
    }
    if t.size_bytes == 0 || t.size_bytes > MAX_SIZE {
        return Err(format!(
            "檔案大小 {} 超過上限 {MAX_SIZE} bytes",
            t.size_bytes
        ));
    }
    if t.signer_thumbprints.is_empty() {
        return Err("沒有預期的簽章者".into());
    }
    Ok(file)
}

impl<E: UpgradeEnv> Upgrader<'_, E> {
    /// 依主機目標升級 Agent;`current` 為 get_status 最近回報的 Agent 版本
    pub async fn run(&self, target: &UpgradeTarget, current: Option<&str>) -> Outcome {
        if current == Some(target.version.as_str()) {
            return Outcome::Skipped("已是目標版本");
        }
        let prev = self
            .env
            .load()
            .filter(|r| r.component == COMPONENT && r.target_version == target.version);
        if let Some(p) = &prev {
            if p.attempts >= MAX_ATTEMPTS || p.error_code.as_deref() == Some("ROLLBACK_FAILED") {
                return Outcome::Skipped("同一目標版本已失敗,不再自動嘗試");
            }
            if !p.terminal() && p.state == "installing" {
                // 不應發生(啟動時已 resume);保守起見不重複安裝
                return Outcome::Skipped("上一次安裝尚未收尾");
            }
        }
        if self.env.hands_off() {
            return Outcome::Skipped("Windows 關機中或安裝程式執行中");
        }
        // 舊版本以安裝目錄 exe 的版本資源為準(上報快照可能過時;還原後據此檢查,審查建議 5)
        let from = self
            .env
            .product_version(&self.paths.exe())
            .or(current.map(str::to_string));
        let mut rec = UpgradeRecord {
            component: COMPONENT.into(),
            target_version: target.version.clone(),
            target_sha256: target.sha256.clone(),
            from_version: from,
            state: "downloading".into(),
            attempts: prev.map_or(0, |p| p.attempts),
            error_code: None,
            error_message: None,
            started_at: crate::now_rfc3339(),
        };
        // 先檢查目標再寫紀錄、日誌與事件(主機給的字串未驗證前不落地,資安 L1)
        let file = match check_target(target, Comp::Agent) {
            Ok(f) => f,
            Err(e) => {
                warn!("主機下發的 Agent 目標不合法,略過:{}", clean(&e));
                if target.version.len() > 32 || version::core(&target.version).is_none() {
                    return Outcome::Skipped("目標版本格式不合法");
                }
                rec.target_sha256 = String::new();
                return self.finish(
                    &mut rec,
                    "failed",
                    Some(fail("DOWNLOAD_FAILED", format!("目標不合法:{}", clean(&e)))),
                );
            }
        };
        info!(
            "開始升級 Agent {} → {}",
            rec.from_version.as_deref().unwrap_or("?"),
            target.version
        );
        self.env.save(&rec);
        self.env.event("upgrade_started", self.event_data(&rec));
        // 其他版本留下的檔案(含中斷的 .part)先清,只保留最新的另一個版本(資安 L2)
        self.prune_cache(Comp::Agent, &target.version);
        let path = match self.fetch(Comp::Agent, target, &file).await {
            Ok(p) => p,
            Err(f) => return self.finish(&mut rec, "failed", Some(f)),
        };
        rec.state = "verifying".into();
        self.env.save(&rec);
        if let Err(f) = self.verify(target, &path).await {
            let _ = std::fs::remove_file(&path);
            return self.finish(&mut rec, "failed", Some(f));
        }
        if self.env.hands_off() {
            // 驗證完成但 Windows 開始關機:不安裝,下次上報再來(檔案留在 cache,不必重新下載;紀錄不算失敗)
            self.env.clear();
            return Outcome::Skipped("Windows 關機中或安裝程式執行中");
        }
        rec.state = "installing".into();
        self.env.save(&rec);
        let _m = Maintenance::enter(self.env);
        let (state, f) = self.install(&path, target, rec.from_version.clone()).await;
        self.finish(&mut rec, state, f)
    }

    /// Watchdog 自己的升級(P6-3):下載、驗證後經管道交給 Agent 替換;本機紀錄(component = watchdog)記進度,
    /// 但**不產生事件**(Watchdog 路徑的事件白名單只收 component = agent,Watchdog 的結果由 Agent 上報)
    pub async fn run_watchdog(&self, target: &UpgradeTarget, current: &str) -> Outcome {
        if current == target.version {
            return Outcome::Skipped("已是目標版本");
        }
        let prev = self
            .env
            .load_component(WATCHDOG_COMPONENT)
            .filter(|r| r.target_version == target.version);
        if let Some(p) = &prev {
            if p.attempts >= MAX_ATTEMPTS {
                return Outcome::Skipped("同一目標版本已失敗,不再自動嘗試");
            }
            if !p.terminal() && p.state == "installing" {
                if !stale(&p.started_at) {
                    return Outcome::Skipped("上一次替換尚未收尾");
                }
                // 已交給 Agent 超過 WATCHDOG_REPLACE_STALE 仍是舊版(開頭已排除 current == 目標):
                // Agent 沒替換也沒停止這個行程,記為還原(失敗次數加一,呼叫端設冷卻),避免永遠略過
                let mut p = p.clone();
                return self.fail_quiet_as(
                    &mut p,
                    "rolled_back",
                    fail(
                        "HEALTH_CHECK_FAILED",
                        format!("替換逾時未完成(交給 Agent 後仍是 {current})"),
                    ),
                );
            }
        }
        if self.env.hands_off() {
            return Outcome::Skipped("Windows 關機中或安裝程式執行中");
        }
        let mut rec = UpgradeRecord {
            component: WATCHDOG_COMPONENT.into(),
            target_version: target.version.clone(),
            target_sha256: target.sha256.clone(),
            from_version: Some(current.to_string()),
            state: "downloading".into(),
            attempts: prev.map_or(0, |p| p.attempts),
            error_code: None,
            error_message: None,
            started_at: crate::now_rfc3339(),
        };
        let file = match check_target(target, Comp::Watchdog) {
            Ok(f) => f,
            Err(e) => {
                warn!("主機下發的 Watchdog 目標不合法,略過:{}", clean(&e));
                if target.version.len() > 32 || version::core(&target.version).is_none() {
                    return Outcome::Skipped("目標版本格式不合法");
                }
                rec.target_sha256 = String::new();
                return self.fail_quiet(
                    &mut rec,
                    fail("DOWNLOAD_FAILED", format!("目標不合法:{}", clean(&e))),
                );
            }
        };
        info!("開始升級 Watchdog {current} → {}", target.version);
        self.env.save(&rec);
        self.prune_cache(Comp::Watchdog, &target.version);
        let path = match self.fetch(Comp::Watchdog, target, &file).await {
            Ok(p) => p,
            Err(f) => return self.fail_quiet(&mut rec, f),
        };
        rec.state = "verifying".into();
        self.env.save(&rec);
        if let Err(f) = self.verify(target, &path).await {
            let _ = std::fs::remove_file(&path);
            return self.fail_quiet(&mut rec, f);
        }
        if self.env.hands_off() {
            self.env.clear_component(WATCHDOG_COMPONENT);
            return Outcome::Skipped("Windows 關機中或安裝程式執行中");
        }
        // 交給 Agent:Agent 必須在執行中(伺服端 PID 比對 SCM)
        let pid = match self.env.query().await {
            Ok(SvcInfo {
                pid: Some(p),
                state: rustit_common::scm::SvcState::Running,
                ..
            }) => p,
            Ok(i) => {
                return self.fail_quiet(
                    &mut rec,
                    fail(
                        "REPLACE_FAILED",
                        format!("Agent 服務 {} 中,無法交給 Agent 替換", i.state.as_str()),
                    ),
                );
            }
            Err(e) => {
                return self.fail_quiet(
                    &mut rec,
                    fail("REPLACE_FAILED", format!("無法查詢 Agent 服務:{e}")),
                );
            }
        };
        // 先記 installing 再送出:Agent 回 ack 後很快就會停止這個行程,新版啟動時據此收尾(resume_watchdog)
        rec.state = "installing".into();
        self.env.save(&rec);
        match self.env.replace_watchdog(pid, target, &path).await {
            Ok(()) => {
                info!("已交給 Agent 替換 Watchdog → {}", target.version);
                Outcome::HandedOff
            }
            Err((code, message)) => self.fail_quiet(
                &mut rec,
                Failure {
                    code: known_code(&code),
                    message,
                },
            ),
        }
    }

    /// 新版 Watchdog 啟動時:上次停在 installing(已交給 Agent)→ 依自己的版本收尾本機紀錄。
    /// 版本 = 目標:`succeeded`;仍是舊版:Agent 還原或沒換成,記 `rolled_back`(失敗次數加一;Agent 已上報 `upgrade_failed` 事件)。
    ///
    /// 新版一啟動就記 `succeeded`,但 Agent 的 2 分鐘健康檢查此時還沒結束;之後檢查失敗、Agent 換回舊版時,
    /// 舊版啟動看到的是 `succeeded` 且目標不是自己的版本 → 同樣記 `rolled_back`(審查必修 A:否則失敗次數不加、
    /// 不設冷卻,下次上報又替換一次,無限循環)
    pub fn resume_watchdog(&self, own_version: &str) -> Option<Outcome> {
        let mut rec = self.env.load_component(WATCHDOG_COMPONENT).filter(|r| {
            r.state == "installing" || (r.state == "succeeded" && r.target_version != own_version)
        })?;
        if rec.state == "succeeded" {
            warn!(
                "Watchdog {} 啟動後被換回 {own_version}(Agent 健康檢查未通過),記為還原",
                rec.target_version
            );
            rec.state = "rolled_back".into();
            rec.attempts += 1;
            rec.error_code = Some("HEALTH_CHECK_FAILED".into());
            rec.error_message = Some(cut(&format!(
                "新版 Watchdog {} 啟動後健康檢查未通過,已還原為 {own_version}",
                rec.target_version
            )));
            self.env.save(&rec);
            return Some(Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED"));
        }
        if rec.target_version == own_version {
            rec.state = "succeeded".into();
            rec.error_code = None;
            rec.error_message = None;
            info!("Watchdog 已升級為 {own_version}");
            self.env.save(&rec);
            return Some(Outcome::Succeeded);
        }
        warn!(
            "Watchdog 升級 {} 沒有成功(目前仍是 {own_version}),記為還原",
            rec.target_version
        );
        rec.state = "rolled_back".into();
        rec.attempts += 1;
        rec.error_code = Some("HEALTH_CHECK_FAILED".into());
        rec.error_message = Some(cut(&format!(
            "Agent 替換 Watchdog {} 後仍是 {own_version}(已還原或未完成)",
            rec.target_version
        )));
        self.env.save(&rec);
        Some(Outcome::Failed("rolled_back", "HEALTH_CHECK_FAILED"))
    }

    /// Watchdog 目標失敗:只記本機紀錄(失敗次數加一),不產生事件
    fn fail_quiet(&self, rec: &mut UpgradeRecord, f: Failure) -> Outcome {
        self.fail_quiet_as(rec, "failed", f)
    }

    fn fail_quiet_as(&self, rec: &mut UpgradeRecord, state: &'static str, f: Failure) -> Outcome {
        rec.state = state.into();
        rec.attempts += 1;
        rec.error_code = Some(f.code.to_string());
        rec.error_message = Some(cut(&f.message));
        warn!(
            "升級 Watchdog {} 失敗({state},第 {} 次):{} {}",
            rec.target_version, rec.attempts, f.code, f.message
        );
        self.env.save(rec);
        Outcome::Failed(state, f.code)
    }

    /// Watchdog 啟動時:上一次停在 installing(安裝中途被重啟)→ 依目前 exe 收尾(§5.2 第 8 步)
    pub async fn resume(&self) -> Option<Outcome> {
        let mut rec = self
            .env
            .load()
            .filter(|r| r.component == COMPONENT && r.state == "installing")?;
        warn!(
            "上一次升級 Agent {} 在安裝中途中斷,收尾中",
            rec.target_version
        );
        let _m = Maintenance::enter(self.env);
        let _ = std::fs::remove_file(self.paths.staged());
        let exe = self.paths.exe();
        let (state, f) = match hash(exe.clone()).await {
            Ok(h) if h == rec.target_sha256 => {
                // 已換上新版:照第 6 / 7 步驗證
                let _ = self.env.start().await;
                match self.health(&rec.target_version, true).await {
                    Ok(()) => ("succeeded", None),
                    Err(e) => {
                        self.rollback(rec.from_version.as_deref(), fail("HEALTH_CHECK_FAILED", e))
                            .await
                    }
                }
            }
            Ok(_) => {
                // 還沒換上(或已還原):確認舊版跑起來;沒動到 Agent,不算失敗(重開機中斷不耗失敗次數,審查建議 7),下次目標重新來
                let _ = self.env.start().await;
                self.env.clear();
                return Some(Outcome::Skipped("中斷時仍是舊版,已恢復"));
            }
            Err(_) if self.paths.previous().is_file() => {
                // exe 不見了(替換中斷):從 previous\ 換回
                self.rollback(
                    rec.from_version.as_deref(),
                    fail("REPLACE_FAILED", "Watchdog 在替換中途中斷,程式不完整"),
                )
                .await
            }
            Err(e) => (
                "failed",
                Some(fail("ROLLBACK_FAILED", format!("程式不見且沒有備份:{e}"))),
            ),
        };
        Some(self.finish(&mut rec, state, f))
    }

    fn event_data(&self, rec: &UpgradeRecord) -> Value {
        let mut d = json!({ "component": COMPONENT, "to": rec.target_version });
        if let Some(f) = &rec.from_version {
            d["from"] = json!(f);
        }
        d
    }

    fn finish(&self, rec: &mut UpgradeRecord, state: &'static str, f: Option<Failure>) -> Outcome {
        rec.state = state.into();
        let duration_ms = chrono::DateTime::parse_from_rfc3339(&rec.started_at)
            .map(|t| {
                (chrono::Utc::now() - t.with_timezone(&chrono::Utc))
                    .num_milliseconds()
                    .max(0)
            })
            .unwrap_or(0);
        let mut data = self.event_data(rec);
        data["duration_ms"] = json!(duration_ms);
        match f {
            None => {
                rec.error_code = None;
                rec.error_message = None;
                info!("Agent 已升級為 {}", rec.target_version);
                self.env.save(rec);
                self.env.event("upgrade_succeeded", data);
                Outcome::Succeeded
            }
            Some(f) => {
                rec.attempts += 1;
                rec.error_code = Some(f.code.to_string());
                rec.error_message = Some(cut(&f.message));
                warn!(
                    "升級 Agent {} 失敗({state},第 {} 次):{} {}",
                    rec.target_version, rec.attempts, f.code, f.message
                );
                self.env.save(rec);
                data["error_code"] = json!(f.code);
                data["error_message"] = json!(cut(&f.message));
                data["rolled_back"] = json!(state == "rolled_back");
                self.env.event("upgrade_failed", data);
                Outcome::Failed(state, f.code)
            }
        }
    }

    /// 下載(或沿用 cache 內已完整的檔案)到 `cache\agent\{版本}\{檔名}`
    async fn fetch(&self, comp: Comp, t: &UpgradeTarget, file: &str) -> Result<PathBuf, Failure> {
        let dir = self.paths.comp_dir(comp, &t.version);
        let done = dir.join(file);
        if done.is_file() && hash(done.clone()).await.ok().as_deref() == Some(t.sha256.as_str()) {
            info!("沿用已下載的 {}", done.display());
            return Ok(done);
        }
        let _ = std::fs::remove_file(&done);
        std::fs::create_dir_all(&dir)
            .map_err(|e| fail("DOWNLOAD_FAILED", format!("無法建立 {}:{e}", dir.display())))?;
        let free = self
            .env
            .free_bytes(&dir)
            .map_err(|e| fail("DISK_FULL", e))?;
        // 下載後也要留 500 MB(資安 L2)
        if free < MIN_FREE + t.size_bytes {
            return Err(fail(
                "DISK_FULL",
                format!(
                    "磁碟剩餘 {} MB,少於 {} MB",
                    free / 1_048_576,
                    MIN_FREE / 1_048_576
                ),
            ));
        }
        let part = dir.join(format!("{file}.part"));
        let mut last = String::new();
        for attempt in 0..DOWNLOAD_TRIES {
            if attempt > 0 {
                let wait = DOWNLOAD_RETRY[(attempt as usize - 1).min(DOWNLOAD_RETRY.len() - 1)];
                self.env.sleep(Duration::from_secs(wait)).await;
            }
            let mut offset = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            if offset > t.size_bytes {
                let _ = std::fs::remove_file(&part);
                offset = 0;
            }
            match self.env.download(&t.url, &part, offset, t.size_bytes).await {
                Ok(Fetched::Done(n)) if n == t.size_bytes => {
                    std::fs::rename(&part, &done)
                        .map_err(|e| fail("DOWNLOAD_FAILED", format!("無法改名下載檔:{e}")))?;
                    return Ok(done);
                }
                Ok(Fetched::Done(n)) => {
                    last = format!("下載大小 {n} 與預期 {} 不符", t.size_bytes);
                    warn!("{last}(第 {} 次),續傳", attempt + 1);
                }
                Ok(Fetched::RangeNotSatisfiable) => {
                    last = "續傳位置不被接受,重新下載".into();
                    warn!("{last}");
                    let _ = std::fs::remove_file(&part);
                }
                Err(e) => {
                    last = e;
                    warn!("下載升級檔失敗(第 {} 次):{last}", attempt + 1);
                }
            }
        }
        Err(fail("DOWNLOAD_FAILED", last))
    }

    async fn verify(&self, t: &UpgradeTarget, path: &Path) -> Result<(), Failure> {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size != t.size_bytes {
            return Err(fail(
                "HASH_MISMATCH",
                format!("檔案大小 {size} 與目標 {} 不符", t.size_bytes),
            ));
        }
        let got = hash(path.to_path_buf())
            .await
            .map_err(|e| fail("HASH_MISMATCH", e))?;
        if got != t.sha256 {
            return Err(fail("HASH_MISMATCH", format!("SHA-256 {got} 與目標不符")));
        }
        let signer = self
            .env
            .signer(path)
            .map_err(|e| fail("SIGNATURE_INVALID", e))?;
        if !signer_allowed(&signer, &t.signer_thumbprints, &self.trusted) {
            return Err(fail(
                "SIGNER_NOT_TRUSTED",
                format!(
                    "簽章者 {signer} 不同時在主機清單與本機信任清單內(本機 {} 個)",
                    self.trusted.len()
                ),
            ));
        }
        match self.env.product_version(path) {
            Some(v) if v == t.version => Ok(()),
            v => Err(fail(
                "HASH_MISMATCH",
                format!(
                    "檔案版本 {} 與目標 {} 不符",
                    v.as_deref().unwrap_or("(無)"),
                    t.version
                ),
            )),
        }
    }

    /// cache\agent\ 只保留最新 2 個版本(含這次)
    fn prune_cache(&self, comp: Comp, keep: &str) {
        let root = self.paths.cache_dir.join(comp.name());
        let Ok(rd) = std::fs::read_dir(&root) else {
            return;
        };
        let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = rd
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir() && e.file_name() != keep)
            .map(|e| {
                let t = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                (t, e.path())
            })
            .collect();
        dirs.sort_by_key(|d| std::cmp::Reverse(d.0));
        for (_, d) in dirs.into_iter().skip(KEEP_VERSIONS - 1) {
            if let Err(e) = std::fs::remove_dir_all(&d) {
                warn!("無法清除舊的升級檔 {}:{e}", d.display());
            }
        }
    }

    /// 第 3–7 步;回傳 (state, 失敗)
    async fn install(
        &self,
        new: &Path,
        t: &UpgradeTarget,
        from: Option<String>,
    ) -> (&'static str, Option<Failure>) {
        let info = match self.env.query().await {
            Ok(i) => i,
            Err(e) => {
                return (
                    "failed",
                    Some(fail("STOP_TIMEOUT", format!("無法查詢 Agent 服務:{e}"))),
                );
            }
        };
        // 服務設定的程式不是安裝目錄的 rustit-agent.exe(路徑被改):不替換別的檔案
        match &info.exe {
            Some(exe) if same_path(exe, &self.paths.exe()) => {}
            other => {
                return (
                    "failed",
                    Some(fail(
                        "REPLACE_FAILED",
                        format!(
                            "Agent 服務的程式 {other:?} 不是 {}",
                            self.paths.exe().display()
                        ),
                    )),
                );
            }
        }
        if let Some(pid) = info.pid
            && let Err(e) = self.env.prepare_shutdown(pid).await
        {
            // 逾時照樣繼續(執行中的指令由主機逾時處理),只記警告(§5.2 第 3 步)
            warn!("PREPARE_TIMEOUT:{e};照樣停止 Agent");
        }
        if let Err(e) = self.env.stop(info.pid).await {
            let _ = self.env.start().await;
            return ("failed", Some(fail("STOP_TIMEOUT", e)));
        }
        let (paths, new_file, sha) = (self.paths.clone(), new.to_path_buf(), t.sha256.clone());
        let replaced = blocking_fs(move || replace_files(&paths, &new_file, &sha))
            .await
            .unwrap_or_else(|| Err(fail("REPLACE_FAILED", "背景工作異常")));
        if let Err(e) = replaced {
            // 換上前失敗:exe 仍是舊版(previous 的複本或原檔),直接啟動
            let _ = std::fs::remove_file(self.paths.staged());
            let _ = self.env.start().await;
            return ("failed", Some(e));
        }
        if let Err(e) = self.env.start().await {
            return self
                .rollback(
                    from.as_deref(),
                    fail("HEALTH_CHECK_FAILED", format!("新版無法啟動:{e}")),
                )
                .await;
        }
        match self.health(&t.version, true).await {
            Ok(()) => ("succeeded", None),
            Err(e) => {
                self.rollback(from.as_deref(), fail("HEALTH_CHECK_FAILED", e))
                    .await
            }
        }
    }

    /// 第 6 步:2 分鐘內每 10 秒 get_status;`expect_ws`:新版要 WebSocket 已連線,還原後的舊版只要管道正常。
    /// 還原後(`expect_ws = false`)管道失敗但 SCM 的 PID 連續兩次相同也算正常:管道可能被一般使用者搶建(資安 M3),
    /// 不能因此判 ROLLBACK_FAILED 而永久停止升級
    async fn health(&self, version: &str, expect_ws: bool) -> Result<(), String> {
        let deadline = self.env.now() + HEALTH_WINDOW;
        let mut ok_pid: Option<u32> = None;
        let mut last = String::from("2 分鐘內沒有回報");
        loop {
            self.env.sleep(HEALTH_POLL).await;
            let pid = match self.env.query().await {
                Ok(SvcInfo { pid: Some(p), .. }) => Some(p),
                Ok(i) => {
                    last = format!("Agent 服務 {}", i.state.as_str());
                    None
                }
                Err(e) => {
                    last = e;
                    None
                }
            };
            match pid {
                None => ok_pid = None,
                Some(pid) => match self.env.get_status(pid).await {
                    Ok(s) if !version.is_empty() && s.version != version => {
                        return Err(format!("執行中的版本 {} 不是 {version}", s.version));
                    }
                    Ok(s) if expect_ws && !s.ws_connected => {
                        last = "WebSocket 未連線".into();
                        ok_pid = None;
                    }
                    Ok(_) if ok_pid == Some(pid) => return Ok(()),
                    Ok(_) => ok_pid = Some(pid),
                    Err(e) if !expect_ws && ok_pid == Some(pid) => {
                        warn!("還原後管道仍不正常({e}),但 Agent 服務 PID {pid} 穩定,視為已還原");
                        return Ok(());
                    }
                    Err(e) => {
                        last = e;
                        ok_pid = (!expect_ws).then_some(pid);
                    }
                },
            }
            if self.env.now() >= deadline {
                return Err(format!("新版 2 分鐘內 get_status 不正常({last})"));
            }
        }
    }

    /// 第 7 步:停止 → previous\ 換回 → 啟動 → 確認舊版正常;回傳 (state, 失敗)
    async fn rollback(
        &self,
        from: Option<&str>,
        cause: Failure,
    ) -> (&'static str, Option<Failure>) {
        warn!("升級失敗({} {}),還原舊版", cause.code, cause.message);
        let pid = self.env.query().await.ok().and_then(|i| i.pid);
        if let Err(e) = self.env.stop(pid).await {
            warn!("還原前停止 Agent 失敗:{e}");
        }
        let paths = self.paths.clone();
        let restored = blocking_fs(move || {
            let r = restore_files(&paths);
            if r.is_err() {
                let _ = std::fs::remove_file(paths.staged());
            }
            r
        })
        .await
        .unwrap_or_else(|| Err("背景工作異常".into()));
        let started = self.env.start().await;
        let checked = match (&restored, &started) {
            (Err(e), _) | (_, Err(e)) => Err(e.clone()),
            _ => self.health(from.unwrap_or(""), false).await,
        };
        match checked {
            Ok(()) => (
                "rolled_back",
                Some(Failure {
                    code: cause.code,
                    message: format!("{},已還原 {}", cause.message, from.unwrap_or("舊版")),
                }),
            ),
            Err(e) => (
                "failed",
                Some(fail(
                    "ROLLBACK_FAILED",
                    format!("{};還原失敗:{e}", cause.message),
                )),
            ),
        }
    }
}

#[cfg(test)]
mod tests;
