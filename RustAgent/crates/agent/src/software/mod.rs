//! 軟體派送:`software.install` / `software.uninstall`(P7-SOFTWARE-DESIGN §5;契約 `docs/contracts/command-kinds.md`)。
//!
//! **Agent 只信任指令內的目錄快照**(主機建立指令時從軟體目錄產生),執行前再驗一次全部欄位([`args`] 與 [`parse_install`])。
//!
//! | `software.install` 步驟 | 進度 | 失敗代碼 |
//! | --- | --- | --- |
//! | 驗參數(白名單、`url` 固定、大小上限) | — | `INVALID_PARAMS` |
//! | `detect` 已通過 → 直接成功 `already_installed`(派送是冪等的) | — | — |
//! | 下載(續傳、本機快取)→ 驗大小與 SHA-256([`download`]) | 0–80% | `DISK_FULL` / `DOWNLOAD_FAILED` / `HASH_MISMATCH` |
//! | 複製到 `staging\{commandId}\`,**在目的地**再驗 SHA-256 → Authenticode → 簽章者(主機清單 ∩ 本機 `trusted_signers`) | 82% | `HASH_MISMATCH` / `SIGNATURE_INVALID` / `SIGNER_NOT_TRUSTED` |
//! | 寫死的命令列、Job Object、逾時結束行程樹;1618 每 60 秒重試 3 次([`install`]) | 85% | `INSTALL_TIMEOUT` / `INSTALL_BUSY` / `INSTALL_FAILED` |
//! | 登錄檔輪詢 120 秒([`detect`]) | 95% | `DETECT_FAILED` |
//! | 立即重新蒐集資產(失敗只記警告)、刪除安裝檔與 staging | 100% | — |
//!
//! `draft` 套件(只派到 pilot 測試機)的 `signer_thumbprints` 為空:簽章仍須有效,回報實際簽章者供 IT 標記 `tested`,不比對清單(§5.2)。
//! **未簽章的檔案在任何狀態都拒絕**。
//!
//! `software.uninstall`:偵測不到 → `already_absent`;否則依 HKLM 項目決定移除命令([`uninstall`])→ 執行 → 輪詢到項目消失。
//!
//! 會改變系統,與其他此類指令串行(呼叫端持有 `Shared::exclusive`)。結果由 [`crate::command`] 先寫本機再回報,斷線重連後補送。

pub mod args;
pub mod detect;
pub mod download;
pub mod install;
pub mod power;
pub mod uninstall;

use crate::Shared;
use download::{DlError, Fetched};
use install::{CmdLine, Exit};
use log::{info, warn};
use rustit_collector::UninstallEntry;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 安裝檔大小上限(與主機 SOFTWARE_MAX_BYTES 預設相同,不信任主機宣告)
pub const MAX_SIZE: u64 = 4 * 1024 * 1024 * 1024;
/// 安裝逾時預設與上限(指令整體逾時 4 小時含下載)
pub const DEFAULT_TIMEOUT_SEC: u64 = 1800;
const TIMEOUT_RANGE: std::ops::RangeInclusive<u64> = 60..=14_400;
/// 1618(另一個安裝進行中)重試
pub const BUSY_RETRIES: u32 = 3;
pub const BUSY_WAIT: Duration = Duration::from_secs(60);
/// 安裝後 / 移除後的登錄檔輪詢:每 3 秒、共 120 秒
pub const DETECT_INTERVAL: Duration = Duration::from_secs(3);
pub const DETECT_POLLS: u32 = 40;
/// `.part` 與殘留的 staging 保留時間
pub const STALE_AFTER: Duration = Duration::from_secs(24 * 3600);
/// 安裝記錄保留天數(同日誌)
pub const LOG_KEEP: Duration = Duration::from_secs(14 * 24 * 3600);
/// `log_tail`:最後幾行、最多幾個字元(result 序列化後 4,000 字元內)
const LOG_TAIL_LINES: usize = 20;
const LOG_TAIL_CHARS: usize = 1500;
const LOG_READ_MAX: u64 = 64 * 1024;
const MAX_SIGNERS: usize = 8;

/// 指令失敗;`result` 為失敗時也要給主機的摘要(例如 `INSTALL_FAILED` 的 `exit_code`、`log_tail`)
#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub result: Option<Value>,
}

pub fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
        result: None,
    }
}

fn invalid(message: impl Into<String>) -> Failure {
    fail("INVALID_PARAMS", message)
}

/// 安裝程式類型(§5.3)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Installer {
    Msi,
    Inno,
    Nsis,
    Burn,
    Exe,
}

impl Installer {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "msi" => Self::Msi,
            "inno" => Self::Inno,
            "nsis" => Self::Nsis,
            "burn" => Self::Burn,
            "exe" => Self::Exe,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Msi => "msi",
            Self::Inno => "inno",
            Self::Nsis => "nsis",
            Self::Burn => "burn",
            Self::Exe => "exe",
        }
    }

    /// 快取與 staging 內的檔名(副檔名依類型;主機的檔名不帶到端點)
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Msi => "installer.msi",
            _ => "installer.exe",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectKind {
    ProductCode,
    DisplayName,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detect {
    pub kind: DetectKind,
    pub value: String,
}

/// `software.install` 快照(已驗證)
#[derive(Debug, Clone)]
pub struct Install {
    pub package_id: String,
    pub name: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub installer: Installer,
    pub install_args: String,
    pub signers: Vec<String>,
    pub detect: Detect,
    pub timeout: Duration,
    /// A6:略過電池延後(不略過計量網路)
    pub ignore_power: bool,
    /// 目錄的重開機政策 `required`:已知安裝後必須重新開機(結果標 `reboot_required`,主機據此開 reboot_pending、畫面提供重新開機)
    pub reboot_required_by_policy: bool,
}

/// `software.uninstall` 快照(已驗證)
#[derive(Debug, Clone)]
pub struct Uninstall {
    pub package_id: String,
    pub name: String,
    pub version: String,
    pub installer: Installer,
    pub uninstall_args: String,
    pub detect: Detect,
    pub timeout: Duration,
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// 控制字元與雙向文字控制字元(同 message.show)
fn unsafe_text(s: &str) -> bool {
    s.chars().any(|c| {
        c.is_control() || matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
    })
}

fn text<'a>(p: &'a Value, key: &str, max: usize) -> Result<&'a str, Failure> {
    p[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().count() <= max && !unsafe_text(s))
        .ok_or_else(|| invalid(format!("{key} 需 1–{max} 字、不含控制字元")))
}

fn parse_common(
    p: &Value,
) -> Result<(String, String, String, Installer, Detect, Duration), Failure> {
    let package_id = p["package_id"]
        .as_str()
        .filter(|s| is_uuid(s))
        .ok_or_else(|| invalid("package_id 需 UUID"))?
        .to_ascii_lowercase();
    let name = text(p, "name", 100)?.to_string();
    let version = text(p, "version", 50)?.to_string();
    let installer = p["installer_type"]
        .as_str()
        .and_then(Installer::parse)
        .ok_or_else(|| invalid("installer_type 需 msi / inno / nsis / burn / exe"))?;
    let d = &p["detect"];
    let value = d["value"].as_str().unwrap_or_default().to_string();
    let detect = match d["type"].as_str() {
        Some("msi_product_code") if args::is_guid(&value) => Detect {
            kind: DetectKind::ProductCode,
            value,
        },
        Some("display_name")
            if value.chars().count() <= 400
                && !unsafe_text(&value)
                && value.replace('%', "").trim().chars().count() >= 3 =>
        {
            Detect {
                kind: DetectKind::DisplayName,
                value,
            }
        }
        _ => {
            return Err(invalid(
                "detect 需 msi_product_code({GUID})或 display_name(1–400 字、至少 3 個 % 以外的字元)",
            ));
        }
    };
    let timeout = match &p["timeout_sec"] {
        Value::Null => DEFAULT_TIMEOUT_SEC,
        v => v
            .as_u64()
            .filter(|s| TIMEOUT_RANGE.contains(s))
            .ok_or_else(|| invalid("timeout_sec 需 60–14400"))?,
    };
    Ok((
        package_id,
        name,
        version,
        installer,
        detect,
        Duration::from_secs(timeout),
    ))
}

fn checked_args(p: &Value, key: &str, kind: Installer) -> Result<String, Failure> {
    let v = match &p[key] {
        Value::Null => "",
        Value::String(s) => s.as_str(),
        _ => return Err(invalid(format!("{key} 需字串"))),
    };
    match args::args_error(v, Some(kind)) {
        Some(e) => Err(invalid(format!("{key}:{e}"))),
        None => Ok(v.to_string()),
    }
}

/// `software.install` 快照的第二道驗證(主機已驗;版本差異或主機被繞過時仍擋)
pub fn parse_install(p: &Value) -> Result<Install, Failure> {
    let (package_id, name, version, installer, detect, timeout) = parse_common(p)?;
    let url = p["url"].as_str().unwrap_or_default();
    if url != format!("/agent/v1/packages/{package_id}") {
        return Err(invalid("url 必須是 /agent/v1/packages/{package_id}"));
    }
    let sha256 = p["sha256"]
        .as_str()
        .filter(|s| is_hex(s, 64))
        .ok_or_else(|| invalid("sha256 需 64 個小寫十六進位字元"))?
        .to_string();
    let size_bytes = p["size_bytes"]
        .as_u64()
        .filter(|s| (1..=MAX_SIZE).contains(s))
        .ok_or_else(|| invalid(format!("size_bytes 需 1–{MAX_SIZE}")))?;
    let signers = match &p["signer_thumbprints"] {
        Value::Null => Vec::new(),
        Value::Array(a) if a.len() <= MAX_SIGNERS => a
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|s| is_hex(s, 40))
                    .map(str::to_string)
                    .ok_or_else(|| invalid("signer_thumbprints 需 40 個小寫十六進位字元"))
            })
            .collect::<Result<_, _>>()?,
        _ => return Err(invalid(format!("signer_thumbprints 最多 {MAX_SIGNERS} 個"))),
    };
    let reboot_required_by_policy = match &p["reboot_policy"] {
        Value::Null => false,
        Value::String(s) if s == "never" => false,
        Value::String(s) if s == "required" => true,
        _ => return Err(invalid("reboot_policy 需 never / required")),
    };
    let ignore_power = match &p["ignore_power"] {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ => return Err(invalid("ignore_power 需 true / false")),
    };
    Ok(Install {
        install_args: checked_args(p, "install_args", installer)?,
        package_id,
        name,
        version,
        url: url.to_string(),
        sha256,
        size_bytes,
        installer,
        signers,
        detect,
        timeout,
        ignore_power,
        reboot_required_by_policy,
    })
}

pub fn parse_uninstall(p: &Value) -> Result<Uninstall, Failure> {
    let (package_id, name, version, installer, detect, timeout) = parse_common(p)?;
    Ok(Uninstall {
        uninstall_args: checked_args(p, "uninstall_args", installer)?,
        package_id,
        name,
        version,
        installer,
        detect,
        timeout,
    })
}

/// 流程需要的外部操作(正式為登錄檔 / mTLS 下載 / WinVerifyTrust / Job Object,測試用假實作)
#[allow(async_fn_in_trait)]
pub trait Env {
    /// 整台電腦的登錄檔中第一個符合 `detect` 的項目
    async fn find(&self, d: &Detect) -> Option<UninstallEntry>;
    /// 建立目錄並確認安全:SYSTEM / Administrators 專用 ACL、不是連結(junction / 符號連結)
    fn prepare_dir(&self, dir: &Path) -> Result<(), String>;
    fn free_bytes(&self, dir: &Path) -> Result<u64, String>;
    async fn download(
        &self,
        url: &str,
        part: &Path,
        offset: u64,
        limit: u64,
    ) -> Result<Fetched, DlError>;
    /// Authenticode 驗證通過時回傳(簽章者 SHA-1 指紋, 簽章者名稱)
    fn signer(&self, path: &Path) -> Result<(String, String), String>;
    /// 執行並等結束(逾時結束行程樹);主行程結束後再等 Job 內的子行程最多 `drain`
    async fn run(&self, cmd: &CmdLine, timeout: Duration, drain: Duration) -> Result<Exit, String>;
    /// 移除程式存在,且在 Program Files / Windows / Package Cache 底下或只有系統管理帳號可寫(資安 H1)
    fn check_uninstaller(&self, path: &Path) -> Result<(), String>;
    fn msiexec(&self) -> PathBuf;
    async fn sleep(&self, d: Duration);
    /// 回報 `running` 與進度百分比
    fn progress(&self, pct: u8);
    /// 立即重新蒐集並回報資產(失敗只記警告)
    async fn collect(&self);
    /// A6:電池與計量網路狀態
    async fn power(&self) -> power::PowerState;
}

/// 檔案位置:`cache\software\`(下載與 staging)、`logs\software\`(安裝記錄)
#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
    pub logs: PathBuf,
}

impl Paths {
    fn package(&self, package_id: &str) -> PathBuf {
        self.root.join(package_id)
    }
    fn staging(&self, command_id: &str) -> PathBuf {
        self.root.join("staging").join(command_id)
    }
    fn log(&self, command_id: &str) -> PathBuf {
        self.logs.join(format!("{command_id}.log"))
    }
}

pub async fn hash(path: &Path) -> Result<String, String> {
    let p = path.to_path_buf();
    tokio::task::spawn_blocking(move || crate::upgrade_watchdog::sha256_file(&p))
        .await
        .map_err(|e| e.to_string())?
}

/// 結束時刪除安裝檔與 staging(成功或失敗都刪;只留可續傳的 `.part`,§5.6)
struct Cleanup(Vec<PathBuf>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        for p in &self.0 {
            let r = if p.is_dir() {
                std::fs::remove_dir_all(p)
            } else {
                std::fs::remove_file(p)
            };
            if let Err(e) = r
                && e.kind() != std::io::ErrorKind::NotFound
            {
                warn!("無法刪除 {}:{e}", p.display());
            }
        }
    }
}

/// 以拒絕他人寫入 / 刪除的共用模式開啟(他人仍可讀取與執行)
#[cfg(windows)]
fn hold_readonly(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x1;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
}

fn older_than(path: &Path, age: Duration) -> bool {
    std::fs::symlink_metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|e| e > age)
}

/// 清除超過 24 小時的下載殘留與 staging、超過 14 天的安裝記錄(每次執行前)
pub fn purge_stale(paths: &Paths) {
    let remove = |p: &Path| {
        let r = if p.is_dir() {
            std::fs::remove_dir_all(p)
        } else {
            std::fs::remove_file(p)
        };
        if let Err(e) = r {
            warn!("無法清除 {}:{e}", p.display());
        }
    };
    let entries = |dir: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .map(|rd| rd.flatten().map(|e| e.path()).collect())
            .unwrap_or_default()
    };
    for p in entries(&paths.root) {
        if p.file_name().is_some_and(|n| n == "staging") {
            entries(&p)
                .iter()
                .filter(|s| older_than(s, STALE_AFTER))
                .for_each(|s| remove(s));
        } else if older_than(&p, STALE_AFTER) {
            remove(&p);
        }
    }
    for p in entries(&paths.logs) {
        if older_than(&p, LOG_KEEP) {
            remove(&p);
        }
    }
}

/// 安裝記錄最後 20 行(MSI 記錄為 UTF-16LE),經 logs.collect 同一套遮罩;沒有記錄回 None
pub fn log_tail(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut bom = [0u8; 2];
    let utf16 = f.read_exact(&mut bom).is_ok() && bom == [0xFF, 0xFE];
    // MSI /l*v 可到數十 MB:只讀最後 64 KB(UTF-16 對齊偶數位置)
    let mut start = len.saturating_sub(LOG_READ_MAX);
    if utf16 {
        start = (start & !1).max(2);
    }
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;
    let text = if utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(LOG_TAIL_LINES)..].join("\n");
    let tail = crate::logs::redact(&tail);
    let n = tail.chars().count();
    let tail: String = tail
        .chars()
        .skip(n.saturating_sub(LOG_TAIL_CHARS))
        .collect();
    (!tail.is_empty()).then_some(tail)
}

/// 1618 重試後的結束代碼
/// 整體不超過 `timeout`(含 1618 重試與等待,不會超過主機的執行逾時);`drain` = 主行程結束後等子行程的上限
async fn run_installer(
    env: &impl Env,
    cmd: &CmdLine,
    timeout: Duration,
    drain: Duration,
) -> Result<u32, Failure> {
    let mut retried = 0;
    let mut left = timeout;
    loop {
        let started = Instant::now();
        let exit = env.run(cmd, left, drain).await;
        left = left.saturating_sub(started.elapsed());
        match exit {
            Ok(Exit::Code(1618)) if retried == BUSY_RETRIES || left <= BUSY_WAIT => {
                return Err(fail(
                    "INSTALL_BUSY",
                    format!("另一個安裝進行中(1618),重試 {BUSY_RETRIES} 次仍失敗"),
                ));
            }
            Ok(Exit::Code(1618)) => {
                retried += 1;
                warn!(
                    "另一個安裝進行中(1618),{} 秒後重試(第 {retried} 次)",
                    BUSY_WAIT.as_secs()
                );
                env.sleep(BUSY_WAIT).await;
                left = left.saturating_sub(BUSY_WAIT);
            }
            Ok(Exit::Code(c)) => return Ok(c),
            Ok(Exit::Timeout) => {
                // MSI 的實際安裝在 Windows Installer 服務(msiserver)內進行,不在 Job 內,只結束得了 msiexec 前端(§8.2)
                return Err(fail(
                    "INSTALL_TIMEOUT",
                    format!(
                        "超過 {} 秒仍未結束,已結束安裝程式的行程樹(MSI 的安裝可能仍在 Windows Installer 服務內進行)",
                        timeout.as_secs()
                    ),
                ));
            }
            Err(e) => return Err(fail("EXECUTION_FAILED", e)),
        }
    }
}

/// 輪詢到「有 / 沒有」該項目為止;回傳是否達成
async fn poll_detect(env: &impl Env, d: &Detect, present: bool) -> bool {
    for i in 0..DETECT_POLLS {
        if env.find(d).await.is_some() == present {
            return true;
        }
        if i + 1 < DETECT_POLLS {
            env.sleep(DETECT_INTERVAL).await;
        }
    }
    false
}

fn with_result(mut f: Failure, result: Value) -> Failure {
    f.result = Some(result);
    f
}

/// 簽章檢查:有效簽章必要;主機清單非空時,簽章者須同時在主機清單與本機清單(P6 `signer_allowed`);
/// draft(主機清單為空)也必須在本機清單內(資安 C2,需求方 2026-10-22 決定:本機清單是主機被入侵時的最後一道)
fn check_signer(
    env: &impl Env,
    file: &Path,
    p: &Install,
    trusted: &[String],
) -> Result<(String, String), Failure> {
    let (signer, subject) = env
        .signer(file)
        .map_err(|e| fail("SIGNATURE_INVALID", format!("{e},未執行安裝程式")))?;
    // 憑證主體名稱由簽章者決定:去掉控制字元與雙向文字控制字元(GigaItApp 顯示時不可偽裝,資安 L6)
    let subject: String = subject
        .chars()
        .filter(|c| !unsafe_text(&c.to_string()))
        .take(200)
        .collect();
    let not_trusted = |why: String| {
        with_result(
            fail("SIGNER_NOT_TRUSTED", format!("{why},未執行安裝程式")),
            json!({ "signer": signer, "signer_subject": subject }),
        )
    };
    if p.signers.is_empty() {
        // draft 套件(只派到 pilot 測試機):不比對主機清單,但仍須在本機清單內;回報實際簽章者供 IT 標記 tested
        if !trusted.iter().any(|t| t.eq_ignore_ascii_case(&signer)) {
            return Err(not_trusted(format!(
                "draft 套件的簽章者 {signer}({subject})不在本機信任清單內(本機 {} 個)",
                trusted.len()
            )));
        }
        info!(
            "{} {} 尚未登錄簽章者(draft),簽章者 {signer}({subject})在本機信任清單內",
            p.name, p.version
        );
    } else if !rustit_common::authenticode::signer_allowed(&signer, &p.signers, trusted) {
        return Err(with_result(
            fail(
                "SIGNER_NOT_TRUSTED",
                format!(
                    "簽章者 {signer}({subject})不同時在主機清單與本機信任清單內(本機 {} 個),未執行安裝程式",
                    trusted.len()
                ),
            ),
            json!({ "signer": signer, "signer_subject": subject }),
        ));
    }
    Ok((signer, subject))
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

/// 安裝檔已完整下載過(大小相符;雜湊由下載步驟驗):A6 只延後下載,不延後安裝已下載的檔案
pub fn cached(paths: &Paths, p: &Install) -> bool {
    let f = paths.package(&p.package_id).join(p.installer.file_name());
    std::fs::metadata(f).is_ok_and(|m| m.is_file() && m.len() == p.size_bytes)
}

/// A6(§5.4):電池供電或計量網路時延後下載,每 5 分鐘重新檢查;超過 `max` 回 `DEFERRED_TIMEOUT`。
/// 呼叫端在取得串行鎖之前呼叫(延後期間不擋其他指令)
pub async fn defer(env: &impl Env, p: &Install, max: Duration) -> Result<(), Failure> {
    let mut waited = Duration::ZERO;
    loop {
        let Some(reason) = power::defer_reason(env.power().await, p.ignore_power) else {
            if !waited.is_zero() {
                info!("{} {} 延後條件解除,繼續", p.name, p.version);
            }
            return Ok(());
        };
        if waited >= max {
            return Err(fail(
                "DEFERRED_TIMEOUT",
                format!(
                    "{reason},已延後 {} 分鐘仍未解除;請接上電源或回到非計量網路後重新派送",
                    waited.as_secs() / 60
                ),
            ));
        }
        if waited.is_zero() {
            info!(
                "{} {}:{reason},延後下載(每 {} 分鐘重新檢查,最多 {} 分鐘)",
                p.name,
                p.version,
                power::CHECK_EVERY.as_secs() / 60,
                max.as_secs() / 60
            );
        }
        // 進度 0 的 running 也讓主機重設逾時(延後期間不被判逾時)
        env.progress(0);
        let step = power::CHECK_EVERY.min(max - waited);
        env.sleep(step).await;
        waited += step;
    }
}

/// `software.install` 流程(§5.2)
pub async fn install(
    env: &impl Env,
    paths: &Paths,
    command_id: &str,
    p: &Install,
    trusted: &[String],
) -> Result<Value, Failure> {
    let started = Instant::now();
    // command_id 會組成 staging / 記錄路徑(結束時 remove_dir_all):主機被繞過也只接受 UUID
    if !is_uuid(command_id) {
        return Err(invalid("command_id 需 UUID"));
    }
    if env.find(&p.detect).await.is_some() {
        info!("{} {} 已安裝,不重新安裝", p.name, p.version);
        return Ok(json!({
            "already_installed": true,
            "detected": true,
            "reboot_required": false,
            "duration_ms": elapsed_ms(started),
        }));
    }
    let unsafe_dir = |e: String| {
        fail(
            "EXECUTION_FAILED",
            format!("軟體快取目錄不安全,停用軟體派送:{e}"),
        )
    };
    env.prepare_dir(&paths.root).map_err(unsafe_dir)?;
    purge_stale(paths);
    let pkg_dir = paths.package(&p.package_id);
    env.prepare_dir(&pkg_dir).map_err(unsafe_dir)?;
    env.progress(0);
    info!("下載 {} {}({} bytes)", p.name, p.version, p.size_bytes);
    let file = download::fetch(env, &pkg_dir, p).await?;
    let staging = paths.staging(command_id);
    // 從這裡起,結束時刪除安裝檔;staging 確認安全之後才登記刪除
    let mut cleanup = Cleanup(vec![file.clone()]);
    env.prepare_dir(&staging).map_err(unsafe_dir)?;
    cleanup.0.push(staging.clone());
    env.progress(82);
    // TOCTOU:複製到僅 SYSTEM / Administrators 可寫的 staging,在目的地再驗雜湊與簽章,從該位置執行(§5.6)
    let staged = staging.join(p.installer.file_name());
    let (src, dst) = (file.clone(), staged.clone());
    tokio::task::spawn_blocking(move || std::fs::copy(&src, &dst))
        .await
        .map_err(|e| fail("EXECUTION_FAILED", format!("背景工作異常:{e}")))?
        .map_err(|e| fail("EXECUTION_FAILED", format!("無法複製安裝檔到 staging:{e}")))?;
    // 驗證前先以「只允許他人讀取」開啟並持有到安裝程式結束:驗證後到執行之間無法改寫(資安 L7,縱深防禦)
    let _hold = hold_readonly(&staged)
        .map_err(|e| fail("EXECUTION_FAILED", format!("無法鎖定 staging 的安裝檔:{e}")))?;
    download::verify(&staged, p).await?;
    let (signer, subject) = check_signer(env, &staged, p, trusted)?;
    env.prepare_dir(&paths.logs).map_err(unsafe_dir)?;
    let log = paths.log(command_id);
    let mut cmd =
        install::install_cmdline(p.installer, &staged, &log, &p.install_args, &env.msiexec());
    // 安裝程式解壓用的 TEMP 不用 C:\Windows\Temp(一般使用者可在那裡建立檔案,資安 M2)
    let temp = staging.join("tmp");
    env.prepare_dir(&temp).map_err(unsafe_dir)?;
    cmd.temp = Some(temp);
    env.progress(85);
    info!("安裝 {} {}:{}", p.name, p.version, cmd.command_line());
    let code = run_installer(env, &cmd, p.timeout, p.timeout).await?;
    let tail = log_tail(&log);
    let mut result = json!({
        "exit_code": code,
        "reboot_required": matches!(code, 3010 | 1641),
        "signer": signer,
        "signer_subject": subject,
        "already_installed": code == 1638,
    });
    if let Some(t) = &tail {
        result["log_tail"] = json!(t);
    }
    if !matches!(code, 0 | 3010 | 1641 | 1638) {
        result["duration_ms"] = json!(elapsed_ms(started));
        return Err(with_result(
            fail("INSTALL_FAILED", format!("安裝程式結束代碼 {code}")),
            result,
        ));
    }
    env.progress(95);
    let detected = poll_detect(env, &p.detect, true).await;
    result["detected"] = json!(detected);
    result["duration_ms"] = json!(elapsed_ms(started));
    if !detected {
        return Err(with_result(
            fail(
                "DETECT_FAILED",
                format!("安裝程式結束代碼 {code},但 120 秒內登錄檔找不到符合 detect 的項目"),
            ),
            result,
        ));
    }
    // 重開機政策 required:只在安裝成功且不是「已安裝同版本」(1638)時標記(失敗或沒裝東西不需要重開機)
    if p.reboot_required_by_policy && code != 1638 {
        result["reboot_required"] = json!(true);
    }
    env.collect().await;
    info!("{} {} 安裝完成(結束代碼 {code})", p.name, p.version);
    Ok(result)
}

/// `software.uninstall` 流程
pub async fn uninstall(
    env: &impl Env,
    paths: &Paths,
    command_id: &str,
    p: &Uninstall,
) -> Result<Value, Failure> {
    let started = Instant::now();
    if !is_uuid(command_id) {
        return Err(invalid("command_id 需 UUID"));
    }
    let Some(entry) = env.find(&p.detect).await else {
        info!("{} {} 未安裝,不需移除", p.name, p.version);
        return Ok(json!({
            "already_absent": true,
            "reboot_required": false,
            "duration_ms": elapsed_ms(started),
        }));
    };
    env.prepare_dir(&paths.logs)
        .map_err(|e| fail("EXECUTION_FAILED", format!("記錄目錄不安全:{e}")))?;
    let log = paths.log(command_id);
    let cmd = uninstall::uninstall_cmdline(
        &entry,
        p.installer,
        &p.uninstall_args,
        &log,
        &env.msiexec(),
        |path| env.check_uninstaller(path),
    )?;
    env.progress(50);
    info!(
        "移除 {}({},套件 {}):{}",
        entry.name,
        entry.version,
        p.package_id,
        cmd.command_line()
    );
    let code = run_installer(env, &cmd, p.timeout, install::DRAIN_MAX).await?;
    let mut result = json!({
        "exit_code": code,
        "reboot_required": matches!(code, 3010 | 1641),
        "already_absent": false,
    });
    if let Some(t) = log_tail(&log) {
        result["log_tail"] = json!(t);
    }
    // 1605:MSI 找不到該產品(已被移除),仍以登錄檔輪詢確認
    if !matches!(code, 0 | 3010 | 1641 | 1605) {
        result["duration_ms"] = json!(elapsed_ms(started));
        return Err(with_result(
            fail("INSTALL_FAILED", format!("移除程式結束代碼 {code}")),
            result,
        ));
    }
    env.progress(90);
    let gone = poll_detect(env, &p.detect, false).await;
    result["duration_ms"] = json!(elapsed_ms(started));
    if !gone {
        return Err(with_result(
            fail(
                "DETECT_FAILED",
                format!("移除程式結束代碼 {code},但 120 秒後登錄檔仍有該項目"),
            ),
            result,
        ));
    }
    env.collect().await;
    info!("{} {} 已移除(結束代碼 {code})", p.name, p.version);
    Ok(result)
}

/// 正式環境
pub(crate) struct RealEnv {
    pub shared: Arc<Shared>,
    pub command_id: String,
}

impl Env for RealEnv {
    async fn find(&self, d: &Detect) -> Option<UninstallEntry> {
        let d = d.clone();
        tokio::task::spawn_blocking(move || {
            detect::find(rustit_collector::machine_uninstall_entries(), &d)
        })
        .await
        .ok()
        .flatten()
    }

    fn prepare_dir(&self, dir: &Path) -> Result<(), String> {
        use rustit_common::winfile::not_reparse;
        // 上層 cache\(或 logs\)也不可是連結:建立子目錄時會跟著連結走
        if let Some(parent) = dir.parent()
            && parent.exists()
        {
            not_reparse(parent)?;
        }
        std::fs::create_dir_all(dir).map_err(|e| format!("無法建立 {}:{e}", dir.display()))?;
        not_reparse(dir)?;
        rustit_common::scm::protect_dir(dir)?;
        rustit_common::scm::owner_is_admin(dir)
    }

    fn free_bytes(&self, dir: &Path) -> Result<u64, String> {
        rustit_common::winfile::free_bytes(dir)
    }

    async fn download(
        &self,
        url: &str,
        part: &Path,
        offset: u64,
        limit: u64,
    ) -> Result<Fetched, DlError> {
        use rustit_common::transport::{Download, SendError};
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(part)
            .map_err(|e| DlError {
                permanent: false,
                message: format!("無法開啟 {}:{e}", part.display()),
            })?;
        match self
            .shared
            .transport
            .download(url, &mut file, offset, limit)
            .await
        {
            Ok(Download::Done(n)) => Ok(Fetched::Done(n)),
            Ok(Download::RangeNotSatisfiable) => Ok(Fetched::RangeNotSatisfiable),
            Err(e) => {
                // 4xx(不再指派、停用)與 503 ITA_PACKAGE_CHANGED(軟體庫檔案被換掉)重試也不會成功
                let permanent = match &e {
                    SendError::Rejected(_) => true,
                    SendError::Retry(m) => {
                        m.starts_with("HTTP 404") || m.contains("ITA_PACKAGE_CHANGED")
                    }
                    SendError::Busy(..) => false,
                };
                Err(DlError {
                    permanent,
                    message: e.to_string(),
                })
            }
        }
    }

    fn signer(&self, path: &Path) -> Result<(String, String), String> {
        rustit_common::authenticode::signer_details(path)
    }

    async fn run(&self, cmd: &CmdLine, timeout: Duration, drain: Duration) -> Result<Exit, String> {
        let cmd = cmd.clone();
        tokio::task::spawn_blocking(move || install::run_job(&cmd, timeout, drain))
            .await
            .map_err(|e| format!("背景工作異常:{e}"))?
    }

    fn check_uninstaller(&self, path: &Path) -> Result<(), String> {
        if !path.is_file() {
            return Err(format!("移除程式 {} 不存在", path.display()));
        }
        let lower = path.to_string_lossy().to_lowercase();
        let env_dir = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let program_data = env_dir("ProgramData", r"C:\ProgramData");
        let roots = [
            env_dir("ProgramFiles", r"C:\Program Files"),
            env_dir("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            env_dir("SystemRoot", r"C:\Windows"),
            format!(r"{program_data}\Package Cache"),
        ];
        if roots
            .iter()
            .any(|r| lower.starts_with(&format!(r"{}\", r.to_lowercase())))
        {
            return Ok(());
        }
        rustit_common::scm::admin_only_writable(path).map_err(|e| {
            format!(
                "移除程式 {} 不在 Program Files / Windows / Package Cache 底下,且{e}",
                path.display()
            )
        })
    }

    fn msiexec(&self) -> PathBuf {
        install::msiexec_path()
    }

    async fn sleep(&self, d: Duration) {
        tokio::time::sleep(d).await
    }

    fn progress(&self, pct: u8) {
        crate::command::report_progress(&self.shared, &self.command_id, pct);
    }

    async fn power(&self) -> power::PowerState {
        tokio::task::spawn_blocking(power::current)
            .await
            .unwrap_or_default()
    }

    async fn collect(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self.shared.collect_now.send(tx).await.is_err() {
            warn!("資產回報工作已停止,派送後未重新蒐集");
            return;
        }
        match rx.await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => warn!("派送後重新蒐集資產失敗:{e}"),
            Err(_) => warn!("派送後重新蒐集資產失敗:資產回報工作已停止"),
        }
    }
}

pub(crate) fn real_paths(shared: &Shared) -> Paths {
    Paths {
        root: shared.cache_dir.join("software"),
        logs: shared
            .cache_dir
            .parent()
            .map_or_else(|| shared.cache_dir.join("logs"), |d| d.join("logs"))
            .join("software"),
    }
}

#[cfg(test)]
mod tests;
