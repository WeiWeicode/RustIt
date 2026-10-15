//! USB 儲存裝置插拔事件(PLATFORM-PLAN §4.2 完成標準;契約 event.schema.json UsbVolume):
//! 每 10 秒列舉一次可移除磁碟區(rustit-collector,不查 WMI),與上次比對產生 `usb_inserted` / `usb_removed`。
//! 啟動後第一次列舉只當基準,不產生事件。主機下發設定 `usb_events = false` 時停止偵測。

use crate::events::EventQueue;
use crate::protocol::{AgentSettings, now_rfc3339};
use log::warn;
use rustit_collector::Volume;
use rustit_common::stop::wait;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::watch;

const POLL: Duration = Duration::from_secs(10);

pub async fn run(
    events: EventQueue,
    settings: watch::Receiver<AgentSettings>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut previous: Option<Vec<Volume>> = None;
    loop {
        if settings.borrow().usb_events() {
            let now = match tokio::task::spawn_blocking(rustit_collector::removable_volumes).await {
                Ok(v) => v,
                Err(e) => {
                    // 保留上次結果,略過這一輪(不可當成「全部移除」產生假事件)
                    warn!("列舉可移除磁碟區失敗:{e}");
                    if wait(POLL, &mut shutdown).await {
                        return;
                    }
                    continue;
                }
            };
            if let Some(prev) = &previous {
                let (inserted, removed) = diff(prev, &now);
                for v in inserted {
                    events.record("usb_inserted", now_rfc3339(), data(v));
                }
                for v in removed {
                    events.record("usb_removed", now_rfc3339(), data(v));
                }
            }
            previous = Some(now);
        } else {
            previous = None;
        }
        if wait(POLL, &mut shutdown).await {
            return;
        }
    }
}

/// 以磁碟機代號 + 標籤 + 容量判斷是否同一個磁碟區
fn same(a: &Volume, b: &Volume) -> bool {
    a.mount_point == b.mount_point && a.label == b.label && a.total == b.total
}

fn diff<'a>(prev: &'a [Volume], now: &'a [Volume]) -> (Vec<&'a Volume>, Vec<&'a Volume>) {
    let inserted = now
        .iter()
        .filter(|v| !prev.iter().any(|p| same(p, v)))
        .collect();
    let removed = prev
        .iter()
        .filter(|p| !now.iter().any(|v| same(p, v)))
        .collect();
    (inserted, removed)
}

fn data(v: &Volume) -> Value {
    json!({
        "drive": v.mount_point.trim_end_matches('\\'),
        "label": v.label,
        "file_system": v.file_system,
        "total": v.total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vol(drive: &str, label: &str) -> Volume {
        Volume {
            mount_point: format!("{drive}\\"),
            label: label.into(),
            file_system: "FAT32".into(),
            total: 16,
            available: 8,
            removable: true,
        }
    }

    #[test]
    fn detects_insert_and_remove() {
        let prev = vec![vol("E:", "USB-A")];
        let now = vec![vol("F:", "USB-B")];
        let (i, r) = diff(&prev, &now);
        assert_eq!(i[0].label, "USB-B");
        assert_eq!(r[0].label, "USB-A");
        assert_eq!(data(i[0])["drive"], "F:");
        let (i, r) = diff(&now, &now);
        assert!(i.is_empty() && r.is_empty());
    }
}
