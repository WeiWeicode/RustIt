//! 升級檔下載(§5.1、§8.2):只用 `agent.toml` 的 Gateway 位址與同一組 mTLS 連線(`rustit_common::transport::Transport`,不跟隨重新導向),
//! 寫入 `cache\{component}\{version}\{檔名}.part`;中斷時保留,下次以 `Range` 續傳。完整性由呼叫端以目標 SHA-256 驗整個檔案,
//! 回應標頭 `x-file-sha256` 不採信。

use super::Fetched;
use rustit_common::transport::{Download, Transport};
use std::path::Path;

pub async fn fetch(
    transport: &Transport,
    url: &str,
    part: &Path,
    offset: u64,
    limit: u64,
) -> Result<Fetched, String> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(part)
        .map_err(|e| format!("無法開啟 {}:{e}", part.display()))?;
    match transport.download(url, &mut file, offset, limit).await {
        Ok(Download::Done(n)) => Ok(Fetched::Done(n)),
        Ok(Download::RangeNotSatisfiable) => Ok(Fetched::RangeNotSatisfiable),
        Err(e) => Err(e.to_string()),
    }
}
