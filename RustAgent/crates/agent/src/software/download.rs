//! 安裝檔下載(P7-SOFTWARE-DESIGN §5.1 `download.rs`、§5.6):`cache\software\{packageId}\installer.{msi|exe}`。
//!
//! - 只用指令快照的 `url`(固定 `/agent/v1/packages/{package_id}`)與同一組 mTLS 連線(`rustit_common::transport`,不跟隨重新導向);
//!   寫入 `.part`,中斷保留,下次以 `Range` 續傳(超過 24 小時的由 [`super::purge_stale`] 清除)
//! - 下載完成以快照的大小與 SHA-256 驗整個檔案(主機回應標頭的雜湊不採信);上次已完整下載且雜湊相符就沿用
//! - 磁碟剩餘需 ≥ 檔案大小 × 2(下載檔 + 執行前的 staging 複本)+ 1 GB(`DISK_FULL`)
//! - 主機拒絕(4xx,例如不再指派 404、套件被換掉 503 `ITA_PACKAGE_CHANGED`)不重試;其他錯誤最多 [`TRIES`] 次

use super::{Env, Failure, Install, fail, hash};
use log::{info, warn};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const TRIES: u32 = 3;
/// 第 2、3 次之前等待的秒數
pub const RETRY_WAIT: [u64; 2] = [10, 30];
/// 下載後(含 staging 複本)仍要保留的磁碟空間
pub const FREE_MARGIN: u64 = 1024 * 1024 * 1024;
/// 下載中多久回報一次進度
pub const PROGRESS_EVERY: Duration = Duration::from_secs(5);
/// 下載階段的進度範圍 0–80%
const PROGRESS_SPAN: u64 = 80;

/// 下載一次的結果(主機回應已依 HTTP 狀態分類)
#[derive(Debug, PartialEq, Eq)]
pub enum Fetched {
    Done(u64),
    /// 416:續傳位置不被接受,刪掉續傳檔重來
    RangeNotSatisfiable,
}

/// 下載失敗;`permanent` = 主機拒絕,不重試
#[derive(Debug)]
pub struct DlError {
    pub permanent: bool,
    pub message: String,
}

fn len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// 下載到 `dir`(已由呼叫端建立並檢查),回傳已驗過大小與 SHA-256 的檔案
pub async fn fetch(env: &impl Env, dir: &Path, p: &Install) -> Result<PathBuf, Failure> {
    let done = dir.join(p.installer.file_name());
    if done.is_file() {
        if len(&done) == p.size_bytes && hash(&done).await.ok().as_deref() == Some(&p.sha256) {
            info!("沿用已下載的 {}", done.display());
            return Ok(done);
        }
        let _ = std::fs::remove_file(&done);
    }
    let free = env.free_bytes(dir).map_err(|e| fail("DISK_FULL", e))?;
    let need = p.size_bytes.saturating_mul(2).saturating_add(FREE_MARGIN);
    if free < need {
        return Err(fail(
            "DISK_FULL",
            format!(
                "磁碟剩餘 {} MB,少於需要的 {} MB(安裝檔 × 2 + 1 GB)",
                free / 1_048_576,
                need / 1_048_576
            ),
        ));
    }
    let part = dir.join(format!("{}.part", p.installer.file_name()));
    let mut last = String::new();
    for attempt in 0..TRIES {
        if attempt > 0 {
            let wait = RETRY_WAIT[(attempt as usize - 1).min(RETRY_WAIT.len() - 1)];
            env.sleep(Duration::from_secs(wait)).await;
        }
        let mut offset = len(&part);
        if offset > p.size_bytes {
            let _ = std::fs::remove_file(&part);
            offset = 0;
        }
        match download_with_progress(env, p, &part, offset).await {
            Ok(Fetched::Done(n)) if n == p.size_bytes => {
                std::fs::rename(&part, &done)
                    .map_err(|e| fail("DOWNLOAD_FAILED", format!("無法改名下載檔:{e}")))?;
                break;
            }
            Ok(Fetched::Done(n)) => {
                last = format!("下載大小 {n} 與快照 {} 不符", p.size_bytes);
                warn!("{last}(第 {} 次),續傳", attempt + 1);
            }
            Ok(Fetched::RangeNotSatisfiable) => {
                last = "續傳位置不被接受,重新下載".into();
                warn!("{last}");
                let _ = std::fs::remove_file(&part);
            }
            Err(e) if e.permanent => {
                let _ = std::fs::remove_file(&part);
                return Err(fail("DOWNLOAD_FAILED", e.message));
            }
            Err(e) => {
                warn!("下載 {} 失敗(第 {} 次):{}", p.name, attempt + 1, e.message);
                last = e.message;
            }
        }
    }
    if !done.is_file() {
        return Err(fail("DOWNLOAD_FAILED", last));
    }
    verify(&done, p).await.inspect_err(|_| {
        let _ = std::fs::remove_file(&done);
    })?;
    Ok(done)
}

/// 大小與 SHA-256 都要符合快照;不符 `HASH_MISMATCH`(不啟動安裝程式)
pub async fn verify(path: &Path, p: &Install) -> Result<(), Failure> {
    let size = len(path);
    if size != p.size_bytes {
        return Err(fail(
            "HASH_MISMATCH",
            format!(
                "檔案大小 {size} 與快照 {} 不符,未執行安裝程式",
                p.size_bytes
            ),
        ));
    }
    let got = hash(path).await.map_err(|e| fail("HASH_MISMATCH", e))?;
    if got != p.sha256 {
        return Err(fail(
            "HASH_MISMATCH",
            "下載檔案的 SHA-256 與指令不符,未執行安裝程式",
        ));
    }
    Ok(())
}

/// 下載中每 [`PROGRESS_EVERY`] 以 `.part` 目前大小回報進度(0–80%)
async fn download_with_progress(
    env: &impl Env,
    p: &Install,
    part: &Path,
    offset: u64,
) -> Result<Fetched, DlError> {
    let dl = env.download(&p.url, part, offset, p.size_bytes);
    tokio::pin!(dl);
    let mut tick = tokio::time::interval(PROGRESS_EVERY);
    loop {
        tokio::select! {
            r = &mut dl => return r,
            _ = tick.tick() => {
                let pct = (len(part).min(p.size_bytes) * PROGRESS_SPAN / p.size_bytes.max(1)) as u8;
                env.progress(pct);
            }
        }
    }
}
