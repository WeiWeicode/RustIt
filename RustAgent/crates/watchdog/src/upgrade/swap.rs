//! 正式的升級環境(§5.1 `swap.rs`):SCM 停止 / 啟動 Agent、本機管道 `prepare_shutdown` / `get_status`、mTLS 下載、
//! WinVerifyTrust、`watchdog.db` 的 `upgrade` 表與事件、維護中旗標。備份 / 替換 / 還原的檔案操作在 [`super::Upgrader`]。

use super::{Fetched, PREPARE_TIMEOUT, UpgradeEnv, UpgradeRecord};
use crate::Shared;
use crate::monitor::AgentStatus;
use log::warn;
use rustit_common::envelope::Envelope;
use rustit_common::scm::{self, AGENT_SERVICE, SvcInfo};
use rustit_common::transport::Transport;
use rustit_common::{authenticode, winfile};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub(crate) struct RealEnv {
    pub(crate) shared: Arc<Shared>,
    /// 下載用連線(裝置憑證暫時讀不到時為 None,下次目標再建立)
    pub(crate) transport: Option<Transport>,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("背景工作異常:{e}"))?
}

impl UpgradeEnv for RealEnv {
    async fn download(
        &self,
        url: &str,
        part: &Path,
        offset: u64,
        limit: u64,
    ) -> Result<Fetched, String> {
        let t = self
            .transport
            .as_ref()
            .ok_or_else(|| "下載連線尚未建立".to_string())?;
        super::download::fetch(t, url, part, offset, limit).await
    }

    fn free_bytes(&self, dir: &Path) -> Result<u64, String> {
        winfile::free_bytes(dir)
    }

    // WinVerifyTrust 會讀整個檔案(≤ 200 MB,每次升級一次);Watchdog 用多執行緒 runtime,直接在升級工作內執行
    fn signer(&self, path: &Path) -> Result<String, String> {
        authenticode::signer_thumbprint(path)
    }

    fn product_version(&self, path: &Path) -> Option<String> {
        winfile::product_version(path)
    }

    async fn query(&self) -> Result<SvcInfo, String> {
        blocking(|| scm::query(AGENT_SERVICE)).await
    }

    async fn prepare_shutdown(&self, pid: u32) -> Result<(), String> {
        let req = Envelope::new(
            "prepare_shutdown",
            json!({ "reason": "upgrade", "timeout_sec": PREPARE_TIMEOUT.as_secs() }),
        );
        let reply = rustit_common::pipe::request(&req, pid, PREPARE_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        if reply.kind != "prepare_shutdown_ack" {
            return Err(format!("Agent 回應 {}(舊版 Agent 不支援)", reply.kind));
        }
        let body = reply.body.unwrap_or_default();
        if body["flushed"] != json!(true) {
            warn!("Agent 未送完待送資料就停止:{body}");
        }
        Ok(())
    }

    async fn get_status(&self, pid: u32) -> Result<AgentStatus, String> {
        crate::probe(pid).await.map_err(|e| e.to_string())
    }

    async fn stop(&self, pid: Option<u32>) -> Result<(), String> {
        blocking(move || scm::stop_or_kill(AGENT_SERVICE, pid, crate::STOP_TIMEOUT)).await
    }

    async fn start(&self) -> Result<(), String> {
        blocking(|| scm::start(AGENT_SERVICE)).await
    }

    async fn sleep(&self, d: Duration) {
        tokio::time::sleep(d).await
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn hands_off(&self) -> bool {
        scm::hands_off()
    }

    fn load(&self) -> Option<UpgradeRecord> {
        let outbox = self.shared.outbox.lock().unwrap_or_else(|p| p.into_inner());
        outbox.upgrade_get(super::COMPONENT).unwrap_or_else(|e| {
            warn!("{e}");
            None
        })
    }

    fn save(&self, rec: &UpgradeRecord) {
        if let Err(e) = self
            .shared
            .outbox
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .upgrade_save(rec)
        {
            warn!("{e}");
        }
        self.shared.changed.notify_one();
    }

    fn clear(&self) {
        if let Err(e) = self
            .shared
            .outbox
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .upgrade_delete(super::COMPONENT)
        {
            warn!("{e}");
        }
    }

    fn event(&self, kind: &'static str, data: Value) {
        if let Err(e) = self
            .shared
            .outbox
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(kind, &crate::now_rfc3339(), &data)
        {
            warn!("{e}");
        }
        self.shared.changed.notify_one();
    }

    fn maintenance(&self, on: bool) {
        self.shared.maintenance.store(on, Ordering::Relaxed);
    }
}
