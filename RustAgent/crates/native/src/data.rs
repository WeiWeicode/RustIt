//! 背景工作（資料蒐集、每秒取樣）與格式化工具。行為對應 Tauri 版 `crates/demo/src/main.rs` 的指令。

use crate::perf::{ProcessSampler, ProcessUsage};
use eframe::egui;
use rustit_collector::ComputerInfo;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::System;
use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};

pub struct Snapshot {
    pub info: ComputerInfo,
    pub asset_key: String,
    pub bios_placeholder: bool,
    pub primary_ip: Option<String>,
    /// 與上一次蒐集比對的（新增, 移除）零件；第一次蒐集為 `None`。
    pub hardware_changes: Option<(Vec<String>, Vec<String>)>,
    pub collected_at: SystemTime,
}

impl Snapshot {
    pub fn new(info: ComputerInfo, previous: Option<&ComputerInfo>) -> Self {
        Self {
            asset_key: info.identity.asset_key().to_string(),
            bios_placeholder: info.identity.bios_serial_is_placeholder(),
            primary_ip: info.primary_ipv4().map(str::to_string),
            hardware_changes: previous.map(|p| info.hardware_diff(p)),
            collected_at: SystemTime::now(),
            info,
        }
    }
}

#[derive(Clone, Copy)]
pub struct LiveStats {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub uptime: u64,
}

pub enum Msg {
    Collected(Box<ComputerInfo>),
    Tick(LiveStats, ProcessUsage),
}

/// WMI 查詢約 2 秒，放到背景執行緒；完成後喚醒介面重繪。
pub fn spawn_collect(tx: Sender<Msg>, ctx: egui::Context) {
    std::thread::spawn(move || {
        let info = rustit_collector::collect();
        if tx.send(Msg::Collected(Box::new(info))).is_ok() {
            ctx.request_repaint();
        }
    });
}

/// 每秒取樣一次系統使用率與本程式的資源用量。
///
/// - `active` 為 false（視窗不在前景或已最小化）時暫停，與 WebView 版暫停輪詢的行為相同。
/// - `repaint` 為 true（目前頁面有即時數字）時才喚醒介面；其他頁面不重繪。
pub fn spawn_ticker(tx: Sender<Msg>, ctx: egui::Context, active: Arc<AtomicBool>, repaint: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        let mut sampler = ProcessSampler::new();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if !active.load(Ordering::Relaxed) {
                continue;
            }
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let live = LiveStats {
                cpu: sys.global_cpu_usage(),
                mem_used: sys.used_memory(),
                mem_total: sys.total_memory(),
                uptime: System::uptime(),
            };
            if tx.send(Msg::Tick(live, sampler.sample())).is_err() {
                break;
            }
            if repaint.load(Ordering::Relaxed) {
                ctx.request_repaint();
            }
        }
    });
}

/// 匯出 Agent 將回報給伺服器的 JSON，存在 exe 旁邊，回傳完整路徑。
pub fn export_json(info: &ComputerInfo) -> Result<PathBuf, String> {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir);
    let stamp = unix_now();
    let path = dir.join(format!("rustit-{}-{stamp}.json", info.system.host_name));
    let json = serde_json::to_string_pretty(info).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path)
}

/// 在檔案總管中選取剛匯出的檔案。
pub fn reveal(path: &Path) {
    let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
}

// ------------------------------------------------------------ 格式化

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Unix 秒數轉成本地時間（依 Windows 的時區設定）。
fn local(unix_secs: u64) -> Option<SYSTEMTIME> {
    let t = unix_secs * 10_000_000 + 116_444_736_000_000_000;
    let ft = FILETIME { dwLowDateTime: t as u32, dwHighDateTime: (t >> 32) as u32 };
    let (mut utc, mut local) = (SYSTEMTIME::default(), SYSTEMTIME::default());
    unsafe {
        FileTimeToSystemTime(&ft, &mut utc).ok()?;
        SystemTimeToTzSpecificLocalTime(None, &utc, &mut local).ok()?;
    }
    Some(local)
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// `MM/DD HH:MM`
pub fn fmt_short(t: SystemTime) -> String {
    local(secs(t)).map_or_else(String::new, |s| format!("{:02}/{:02} {:02}:{:02}", s.wMonth, s.wDay, s.wHour, s.wMinute))
}

/// `YYYY-MM-DD HH:MM`
pub fn fmt_datetime(unix_secs: u64) -> String {
    local(unix_secs).map_or_else(String::new, |s| {
        format!("{}-{:02}-{:02} {:02}:{:02}", s.wYear, s.wMonth, s.wDay, s.wHour, s.wMinute)
    })
}

pub fn greeting() -> &'static str {
    match local(unix_now()).map_or(12, |s| s.wHour) {
        0..5 => "夜深了",
        5..11 => "早安",
        11..18 => "午安",
        _ => "晚安",
    }
}

pub fn bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 { format!("{n} B") } else { format!("{v:.1} {}", UNITS[u]) }
}

pub fn duration(secs: u64) -> String {
    let (d, h, m) = (secs / 86400, secs % 86400 / 3600, secs % 3600 / 60);
    if d > 0 { format!("{d} 天 {h} 小時 {m} 分") } else { format!("{h} 小時 {m} 分") }
}

pub fn dash(s: &str) -> &str {
    if s.trim().is_empty() { "—" } else { s }
}
