//! 健康摘要(PLATFORM-PLAN §4.3,P5):隨 Agent 每 30 秒的心跳送出(契約 ws-envelope `HeartbeatBody.health`)。
//! 只做摘要:整機 CPU、記憶體、最滿的固定磁碟、開機時間、Agent 本身的記憶體;**不含**程序清單、螢幕、鍵盤等(PRD §7 隱私)。
//! 只讀 sysinfo、不查 WMI,可頻繁呼叫;CPU 使用率需要兩次取樣的差值,所以取樣器要保留到下一次。

use serde::Serialize;
use sysinfo::{Disks, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// 一次取樣;取不到的欄位為 None,序列化時省略(契約:不送 0)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Health {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_used_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_min_free_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_min_free_drive: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_s: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_rss_mb: Option<u64>,
}

/// 保留 sysinfo 狀態的取樣器(一個 Agent 一個)
pub struct HealthSampler {
    sys: System,
    pid: Option<Pid>,
    /// 已做過一次 CPU 取樣:之後的使用率才有意義
    cpu_primed: bool,
}

impl Default for HealthSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl HealthSampler {
    pub fn new() -> Self {
        Self {
            sys: System::new(),
            pid: sysinfo::get_current_pid().ok(),
            cpu_primed: false,
        }
    }

    pub fn sample(&mut self) -> Health {
        self.sys.refresh_cpu_usage();
        let cpu_pct = if self.cpu_primed {
            Some(pct(self.sys.global_cpu_usage() as f64))
        } else {
            None
        };
        self.cpu_primed = true;

        self.sys.refresh_memory();
        let total = self.sys.total_memory();
        let mem_used_pct =
            (total > 0).then(|| pct(self.sys.used_memory() as f64 * 100.0 / total as f64));

        let agent_rss_mb = self.pid.and_then(|pid| {
            self.sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[pid]),
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );
            self.sys.process(pid).map(|p| p.memory() / (1024 * 1024))
        });

        let (disk_min_free_pct, disk_min_free_drive) = match fullest_fixed_disk() {
            Some((drive, free)) => (Some(free), Some(drive)),
            None => (None, None),
        };

        Health {
            cpu_pct,
            mem_used_pct,
            disk_min_free_pct,
            disk_min_free_drive,
            uptime_s: Some(System::uptime()),
            agent_rss_mb,
        }
    }
}

/// Windows 開機時間(Unix 秒;Agent 的 agent_started 事件)
pub fn boot_time() -> u64 {
    System::boot_time()
}

fn pct(v: f64) -> u8 {
    if v.is_finite() {
        v.round().clamp(0.0, 100.0) as u8
    } else {
        0
    }
}

/// 剩餘百分比最低的固定磁碟(排除可移除磁碟與容量 0 的光碟機);回傳 (`C:`, 剩餘 %)
fn fullest_fixed_disk() -> Option<(String, u8)> {
    Disks::new_with_refreshed_list()
        .iter()
        // 排除可移除磁碟、光碟機(容量 0)與 1 GB 以下的小分割區(有代號的復原 / EFI 分割區幾乎滿是正常的)
        .filter(|d| !d.is_removable() && d.total_space() >= MIN_DISK_BYTES)
        .filter_map(|d| {
            let free = pct(d.available_space() as f64 * 100.0 / d.total_space() as f64);
            Some((drive_letter(&d.mount_point().to_string_lossy())?, free))
        })
        .min_by_key(|(_, free)| *free)
}

const MIN_DISK_BYTES: u64 = 1024 * 1024 * 1024;

/// 掛載點 → 磁碟代號 `C:`;資料夾掛載點(例 `C:\Data\Disk2`,可能含使用者名稱)不送(契約只允許代號,隱私也只做摘要)
fn drive_letter(mount: &str) -> Option<String> {
    let m = mount.trim_end_matches(['\\', '/']);
    let mut chars = m.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(c), Some(':'), None) if c.is_ascii_alphabetic() => {
            Some(format!("{}:", c.to_ascii_uppercase()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_sample_has_no_cpu_then_values_in_range() {
        let mut s = HealthSampler::new();
        let first = s.sample();
        assert_eq!(first.cpu_pct, None);
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        let second = s.sample();
        assert!(second.cpu_pct.is_some_and(|v| v <= 100));
        assert!(second.mem_used_pct.is_some_and(|v| v <= 100));
        assert!(second.disk_min_free_pct.is_none_or(|v| v <= 100));
        assert!(second.uptime_s.is_some());
    }

    #[test]
    fn serializes_without_missing_fields() {
        let h = Health {
            cpu_pct: Some(12),
            disk_min_free_drive: Some("C:".into()),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&h).unwrap(),
            r#"{"cpu_pct":12,"disk_min_free_drive":"C:"}"#
        );
    }

    #[test]
    fn drive_letter_only() {
        assert_eq!(drive_letter("C:\\").as_deref(), Some("C:"));
        assert_eq!(drive_letter("d:").as_deref(), Some("D:"));
        assert_eq!(drive_letter("C:\\Data\\Disk2"), None);
        assert_eq!(drive_letter(""), None);
    }

    #[test]
    fn pct_clamps() {
        assert_eq!(pct(-3.0), 0);
        assert_eq!(pct(100.4), 100);
        assert_eq!(pct(f64::NAN), 0);
        assert_eq!(pct(7.5), 8);
    }
}
