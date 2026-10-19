//! Watchdog 上報(指南 §7.3;契約 `docs/contracts/watchdog.schema.json`):`POST /agent/v1/watchdog/report`。
//!
//! - 每 `report_interval_sec`(主機回應,預設 300 秒)送一次;有新事件或 Agent 狀態改變時 5 秒後立即送
//! - 事件取本機最舊的 50 筆,主機回 accepted 才刪
//! - 連不上依一般退避(429 依 Retry-After,停用 / 退役 403 每 10 分鐘)重試,失敗後有新事件也等退避結束;啟動時隨機延遲 0–30 秒
//! - 上報連線(裝置憑證)建立失敗時每 10 分鐘重試,看守照常

use crate::Shared;
use crate::monitor::{AgentStatus, Monitor};
use log::{debug, info, warn};
use rustit_common::backoff::{Backoff, random_up_to};
use rustit_common::scm::SvcInfo;
use rustit_common::stop::wait;
use rustit_common::transport::Transport;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

pub const REPORT_PATH: &str = "/agent/v1/watchdog/report";
const DEFAULT_INTERVAL: Duration = Duration::from_secs(300);
const BATCH: usize = 50;
/// 有變化時等一下再送,把同一輪的多個事件合併成一次
const DEBOUNCE: Duration = Duration::from_secs(5);
const STARTUP_JITTER: Duration = Duration::from_secs(30);
const TRANSPORT_RETRY: Duration = Duration::from_secs(600);

/// 看守工作最新看到的狀態(上報用)
#[derive(Debug, Default)]
pub struct Snapshot {
    pub info: Option<SvcInfo>,
    pub status: Option<AgentStatus>,
    pub status_at: Option<String>,
    pub probe_error: Option<String>,
    pub restarts_24h: u32,
}

impl Snapshot {
    /// 更新;回傳上報關心的狀態是否改變(服務狀態、啟動類型、WebSocket 連線)
    pub fn update(&mut self, info: &SvcInfo, m: &Monitor, restarts: u32) -> bool {
        let before = self.key();
        self.info = Some(info.clone());
        self.status = m.last_status.clone();
        self.status_at = m
            .last_status_at
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        self.probe_error = m.last_probe_error.clone();
        self.restarts_24h = restarts;
        before != self.key()
    }

    fn key(&self) -> (Option<&'static str>, Option<&'static str>, Option<bool>) {
        (
            self.info.as_ref().map(|i| i.state.as_str()),
            self.info.as_ref().map(|i| i.start_type.as_str()),
            self.status.as_ref().map(|s| s.ws_connected),
        )
    }
}

#[derive(Debug, Serialize)]
pub struct ReportAgent {
    pub service_state: &'static str,
    pub start_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exe_present: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ws_connected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_heartbeat_ack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EventOut {
    pub event_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub occurred_at: String,
    pub data: Value,
}

#[derive(Debug, Serialize)]
pub struct ReportRequest {
    pub watchdog_version: &'static str,
    pub reported_at: String,
    pub agent: ReportAgent,
    pub agent_restarts_24h: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cert_not_after: Option<String>,
    pub events: Vec<EventOut>,
}

#[derive(Debug, Deserialize)]
pub struct ReportResponse {
    pub accepted: Vec<String>,
    #[serde(default)]
    pub report_interval_sec: Option<u64>,
}

/// 由最新狀態組請求;Agent 執行中才帶 status_ok(管道最近一次是否成功)
pub fn build(
    snap: &Snapshot,
    events: Vec<EventOut>,
    cert_not_after: Option<String>,
) -> ReportRequest {
    let info = snap.info.clone().unwrap_or_else(SvcInfo::missing);
    let running = info.state == rustit_common::scm::SvcState::Running;
    let status = snap
        .status
        .as_ref()
        .filter(|_| running && snap.probe_error.is_none());
    let cut = |s: &str| s.chars().take(300).collect::<String>();
    ReportRequest {
        watchdog_version: crate::WATCHDOG_VERSION,
        reported_at: crate::now_rfc3339(),
        agent: ReportAgent {
            service_state: info.state.as_str(),
            start_type: info.start_type.as_str(),
            pid: info.pid,
            exe_present: info.exe.as_deref().map(|p| p.is_file()),
            status_ok: running.then(|| snap.probe_error.is_none() && snap.status.is_some()),
            status_at: snap.status_at.clone().filter(|_| running),
            version: status.map(|s| s.version.clone()),
            ws_connected: status.map(|s| s.ws_connected),
            last_heartbeat_ack: status.and_then(|s| s.last_heartbeat_ack.clone()),
            last_error: snap
                .probe_error
                .as_deref()
                .filter(|_| running)
                .or(status.and_then(|s| s.last_error.as_deref()))
                .map(cut),
        },
        agent_restarts_24h: snap.restarts_24h,
        cert_not_after,
        events,
    }
}

fn cert_not_after(shared: &Shared) -> Option<String> {
    let tls = shared.settings.tls.as_ref()?;
    let t = rustit_common::tls::device_cert_not_after(&tls.client).ok()?;
    chrono::DateTime::from_timestamp(t, 0)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

pub(crate) async fn run(shared: Arc<Shared>, mut shutdown: watch::Receiver<bool>) {
    if wait(random_up_to(STARTUP_JITTER), &mut shutdown).await {
        return;
    }
    let mut backoff = Backoff::new();
    // 憑證暫時讀不到時只暫停上報,看守照常(連線物件在這裡建立並重試)
    let transport = loop {
        match Transport::new(&shared.settings, &crate::user_agent()) {
            Ok(t) => break t,
            Err(e) => {
                warn!(
                    "無法建立上報連線:{e};{} 秒後重試",
                    TRANSPORT_RETRY.as_secs()
                );
                if wait(TRANSPORT_RETRY, &mut shutdown).await {
                    return;
                }
            }
        }
    };
    loop {
        let events = {
            let outbox = shared.outbox.lock().unwrap_or_else(|p| p.into_inner());
            outbox.batch(BATCH).unwrap_or_else(|e| {
                warn!("{e}");
                Vec::new()
            })
        };
        let out: Vec<EventOut> = events
            .into_iter()
            .map(|e| EventOut {
                event_id: e.event_id,
                kind: e.kind,
                occurred_at: e.occurred_at,
                data: e.data,
            })
            .collect();
        let n = out.len();
        let req = {
            let snap = shared.snapshot.lock().unwrap_or_else(|p| p.into_inner());
            build(&snap, out, cert_not_after(&shared))
        };
        match transport
            .post_json::<_, ReportResponse>(REPORT_PATH, &req)
            .await
        {
            Ok(res) => {
                backoff.reset();
                if let Err(e) = shared
                    .outbox
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&res.accepted)
                {
                    warn!("{e}");
                }
                if n > 0 {
                    info!("Watchdog 上報完成:事件 {} 筆", res.accepted.len());
                } else {
                    debug!("Watchdog 上報完成");
                }
                let interval = res
                    .report_interval_sec
                    .map_or(DEFAULT_INTERVAL, |s| Duration::from_secs(s.clamp(60, 3600)));
                // 還有沒送完的事件(超過一批)就接著送
                let delay = if n >= BATCH { DEBOUNCE } else { interval };
                tokio::select! {
                    _ = shared.changed.notified() => {
                        if wait(DEBOUNCE, &mut shutdown).await {
                            return;
                        }
                    }
                    stop = wait(delay, &mut shutdown) => if stop { return },
                }
            }
            Err(e) => {
                // 失敗後照退避等完(429 的 Retry-After、停用的 10 分鐘),有新事件也不提早送
                let d = e.wait(&mut backoff);
                warn!("Watchdog 上報失敗:{e};{} 秒後重試", d.as_secs());
                if wait(d, &mut shutdown).await {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustit_common::scm::{ExitKind, StartType, SvcState};

    #[test]
    fn build_report_fields() {
        let mut snap = Snapshot {
            info: Some(SvcInfo {
                state: SvcState::Running,
                pid: Some(10),
                exit: ExitKind::Clean,
                start_type: StartType::Auto,
                exe: None,
            }),
            status: Some(AgentStatus {
                version: "0.6.0".into(),
                pid: 10,
                ws_connected: true,
                ..Default::default()
            }),
            status_at: Some("2026-10-20T00:00:00.000Z".into()),
            probe_error: None,
            restarts_24h: 2,
        };
        let r = serde_json::to_value(build(&snap, Vec::new(), None)).unwrap();
        assert_eq!(r["agent"]["status_ok"], true);
        assert_eq!(r["agent"]["version"], "0.6.0");
        assert_eq!(r["agent_restarts_24h"], 2);
        assert!(r.get("cert_not_after").is_none());
        snap.probe_error = Some("本機管道逾時".into());
        let r = serde_json::to_value(build(&snap, Vec::new(), None)).unwrap();
        assert_eq!(r["agent"]["status_ok"], false);
        assert_eq!(r["agent"]["last_error"], "本機管道逾時");
        assert!(r["agent"].get("version").is_none());
        // Agent 停止:不帶管道欄位
        snap.info = Some(SvcInfo {
            state: SvcState::Stopped,
            pid: None,
            exit: ExitKind::Clean,
            start_type: StartType::Disabled,
            exe: None,
        });
        let r = serde_json::to_value(build(&snap, Vec::new(), None)).unwrap();
        assert_eq!(r["agent"]["service_state"], "stopped");
        assert_eq!(r["agent"]["start_type"], "disabled");
        assert!(r["agent"].get("status_ok").is_none());
    }
}
