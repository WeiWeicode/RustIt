//! 指令 `agent.diagnose`:連線與環境自我檢查(PLATFORM-PLAN A4;`docs/contracts/command-kinds.md`)。
//!
//! 檢查 Gateway(`GET /healthz`)、AD 網域 DNS、時鐘偏差、裝置憑證到期日、系統磁碟、WMI 回應、本機暫存。
//! 每項各自逾時,單項卡住或失敗不影響其他項;結果放 `command_update.result`(4,000 字元內),不含憑證內容與私鑰。

use crate::Shared;
use crate::protocol::AGENT_VERSION;
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

/// Gateway 檢查逾時與 warn 門檻
const GATEWAY_TIMEOUT: Duration = Duration::from_secs(10);
const GATEWAY_WARN_MS: u64 = 3_000;
/// WMI 檢查逾時與 warn 門檻
const WMI_TIMEOUT: Duration = Duration::from_secs(30);
const WMI_WARN_MS: u64 = 5_000;
const DNS_TIMEOUT: Duration = Duration::from_secs(10);
/// 待補傳筆數超過即 warn
const STORE_WARN: u64 = 100;
/// detail 上限(字元)
const DETAIL_MAX: usize = 200;

#[derive(Debug, Serialize, PartialEq)]
pub struct Check {
    pub name: &'static str,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
    pub detail: String,
}

fn check(
    name: &'static str,
    status: &'static str,
    ms: Option<u64>,
    detail: impl Into<String>,
) -> Check {
    Check {
        name,
        status,
        ms,
        detail: detail.into().chars().take(DETAIL_MAX).collect(),
    }
}

/// 時鐘偏差:絕對值 > 2 分鐘 warn、> 5 分鐘 fail
pub fn grade_clock(skew_ms: i64) -> &'static str {
    match skew_ms.unsigned_abs() {
        s if s > 300_000 => "fail",
        s if s > 120_000 => "warn",
        _ => "ok",
    }
}

/// 憑證剩餘秒數:已過期 fail、不到 30 天 warn
pub fn grade_cert(remaining_sec: i64) -> &'static str {
    match remaining_sec {
        s if s <= 0 => "fail",
        s if s < 30 * 86_400 => "warn",
        _ => "ok",
    }
}

/// 系統磁碟:可用 < 2 GB fail、< 10% warn
pub fn grade_disk(available: u64, total: u64) -> &'static str {
    if available < 2 * 1024 * 1024 * 1024 {
        "fail"
    } else if total > 0 && available * 10 < total {
        "warn"
    } else {
        "ok"
    }
}

pub async fn run(shared: &Shared) -> Value {
    let wmi = tokio::task::spawn_blocking(|| rustit_collector::wmi_probe(WMI_TIMEOUT))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    let checks = vec![
        gateway(shared).await,
        dns(&wmi).await,
        clock(shared),
        cert(shared),
        disk().await,
        wmi_check(&wmi),
        store(shared),
    ];
    json!({
        "agent_version": AGENT_VERSION,
        "service_mode": crate::SERVICE_MODE.load(Ordering::Relaxed),
        "log_level": log::max_level().to_string().to_lowercase(),
        "uptime_sec": shared.started.elapsed().as_secs(),
        "checks": checks,
    })
}

async fn gateway(shared: &Shared) -> Check {
    let started = Instant::now();
    let r = tokio::time::timeout(GATEWAY_TIMEOUT, shared.transport.get_status("/healthz")).await;
    let ms = started.elapsed().as_millis() as u64;
    match r {
        Err(_) => check(
            "gateway",
            "fail",
            Some(ms),
            format!("{} 秒內沒有回應", GATEWAY_TIMEOUT.as_secs()),
        ),
        Ok(Err(e)) => check("gateway", "fail", Some(ms), e.to_string()),
        Ok(Ok(200)) => check(
            "gateway",
            if ms > GATEWAY_WARN_MS { "warn" } else { "ok" },
            Some(ms),
            "GET /healthz 200",
        ),
        Ok(Ok(status)) => check(
            "gateway",
            "fail",
            Some(ms),
            format!("GET /healthz {status}"),
        ),
    }
}

async fn dns(wmi: &Result<rustit_collector::WmiProbe, String>) -> Check {
    let domain = match wmi {
        Err(_) => return check("dns", "skipped", None, "WMI 無法取得網域"),
        Ok(p) if !p.part_of_domain || p.domain.is_empty() => {
            return check("dns", "skipped", None, "未加入網域");
        }
        Ok(p) => p.domain.clone(),
    };
    let started = Instant::now();
    let r = tokio::time::timeout(
        DNS_TIMEOUT,
        tokio::net::lookup_host(format!("{domain}:389")),
    )
    .await;
    let ms = Some(started.elapsed().as_millis() as u64);
    match r {
        Err(_) => check("dns", "fail", ms, format!("{domain} 解析逾時")),
        Ok(Err(e)) => check("dns", "fail", ms, format!("{domain} 解析失敗:{e}")),
        Ok(Ok(addrs)) => check(
            "dns",
            "ok",
            ms,
            format!("{domain} → {} 筆位址", addrs.count()),
        ),
    }
}

fn clock(shared: &Shared) -> Check {
    if !shared.clock_known.load(Ordering::Relaxed) {
        return check("clock", "skipped", None, "尚未收到 hello_ack");
    }
    let skew = shared.clock_skew_ms.load(Ordering::Relaxed);
    check(
        "clock",
        grade_clock(skew),
        None,
        format!("偏差 {skew} ms(端點 − 主機)"),
    )
}

fn cert(shared: &Shared) -> Check {
    let Some(tls) = &shared.tls else {
        return check("cert", "skipped", None, "未使用裝置憑證(開發模式 http)");
    };
    match rustit_common::tls::device_cert_not_after(&tls.client) {
        Err(e) => check("cert", "fail", None, e),
        Ok(not_after) => {
            let remaining = not_after - chrono::Utc::now().timestamp();
            let at = chrono::DateTime::from_timestamp(not_after, 0)
                .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                .unwrap_or_default();
            check(
                "cert",
                grade_cert(remaining),
                None,
                format!("到期 {at},剩 {} 天", remaining.div_euclid(86_400)),
            )
        }
    }
}

async fn disk() -> Check {
    match tokio::task::spawn_blocking(rustit_collector::system_volume).await {
        Ok(Some(v)) => {
            let gb = |b: u64| b as f64 / 1024f64.powi(3);
            let pct = (v.available * 100).checked_div(v.total).unwrap_or(0);
            check(
                "disk",
                grade_disk(v.available, v.total),
                None,
                format!(
                    "{} 可用 {:.1} GB({pct}%),共 {:.1} GB",
                    v.mount_point,
                    gb(v.available),
                    gb(v.total)
                ),
            )
        }
        Ok(None) => check("disk", "skipped", None, "找不到系統磁碟"),
        Err(e) => check("disk", "fail", None, e.to_string()),
    }
}

fn wmi_check(wmi: &Result<rustit_collector::WmiProbe, String>) -> Check {
    match wmi {
        Ok(p) => check(
            "wmi",
            if p.elapsed_ms > WMI_WARN_MS {
                "warn"
            } else {
                "ok"
            },
            Some(p.elapsed_ms),
            "Win32_ComputerSystem",
        ),
        Err(e) => check("wmi", "fail", None, e.clone()),
    }
}

fn store(shared: &Shared) -> Check {
    let s = shared.store.lock();
    let counts = s.counts();
    let unreported = s.command_unreported().map(|v| v.len());
    drop(s);
    match (counts, unreported) {
        (Ok((inv, ev)), Ok(cmd)) => check(
            "store",
            if inv + ev > STORE_WARN { "warn" } else { "ok" },
            None,
            format!("待補傳資產 {inv}、事件 {ev}、未回報指令 {cmd}"),
        ),
        (Err(e), _) | (_, Err(e)) => check("store", "fail", None, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thresholds() {
        assert_eq!(grade_clock(0), "ok");
        assert_eq!(grade_clock(-120_000), "ok");
        assert_eq!(grade_clock(120_001), "warn");
        assert_eq!(grade_clock(-300_001), "fail");
        assert_eq!(grade_cert(31 * 86_400), "ok");
        assert_eq!(grade_cert(29 * 86_400), "warn");
        assert_eq!(grade_cert(0), "fail");
        const GB: u64 = 1024 * 1024 * 1024;
        assert_eq!(grade_disk(100 * GB, 200 * GB), "ok");
        assert_eq!(grade_disk(15 * GB, 200 * GB), "warn");
        assert_eq!(
            grade_disk(GB, 4 * GB),
            "fail",
            "可用 < 2 GB 即使比例足夠也 fail"
        );
    }

    #[test]
    fn detail_is_capped() {
        let c = check("gateway", "fail", None, "字".repeat(500));
        assert_eq!(c.detail.chars().count(), DETAIL_MAX);
        let v = serde_json::to_value(&c).unwrap();
        assert!(v.get("ms").is_none(), "沒有耗時不輸出 ms");
    }
}
