//! 本程式自己的資源用量與畫面更新統計，顯示在「效能比較」頁。
//!
//! 跨程式的公平比較（含 WebView2 的子行程）請用 `scripts/bench.ps1`，這裡只看本行程。

use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RegGetValueW};
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
use windows::Win32::System::WindowsProgramming::QueryProcessCycleTime;
use windows::core::w;

/// FILETIME（1601 年起算，單位 100 ns）與 Unix 時間的差。
const FILETIME_UNIX_OFFSET: u64 = 116_444_736_000_000_000;

#[derive(Clone, Copy, Default)]
pub struct ProcessUsage {
    /// 工作集（工作管理員「記憶體」欄預設顯示的值是私有工作集，比這個小一些）。
    pub working_set: u64,
    /// 私有位元組（Commit）。
    pub private: u64,
    /// 與上次取樣之間的平均 CPU 使用率，以全部邏輯處理器為 100%（與工作管理員相同）。
    /// 以 CPU 週期計算：GetProcessTimes 以 15.6 ms 的時脈中斷取樣，負載很輕時誤差比數值本身還大。
    pub cpu: f32,
}

const fn ft(t: FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}

/// 行程建立時間（FILETIME，單位 100 ns）。
fn created_at() -> Option<u64> {
    let (mut created, mut exited, mut kernel, mut user) = Default::default();
    unsafe { GetProcessTimes(GetCurrentProcess(), &mut created, &mut exited, &mut kernel, &mut user).ok()? };
    Some(ft(created))
}

/// 本行程累計用掉的 CPU 週期。
fn cycles() -> u64 {
    let mut c = 0;
    unsafe { QueryProcessCycleTime(GetCurrentProcess(), &mut c) }.map_or(0, |_| c)
}

/// 處理器標稱時脈（每秒週期數）。QueryProcessCycleTime 以固定頻率的 TSC 計數，用它換算成秒。
fn cycles_per_sec() -> f64 {
    let mut mhz = 0u32;
    let mut size = size_of::<u32>() as u32;
    let key = w!(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
    let r = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, key, w!("~MHz"), RRF_RT_REG_DWORD, None, Some((&raw mut mhz).cast()), Some(&mut size)) };
    if r.is_ok() && mhz > 0 { f64::from(mhz) * 1e6 } else { 3e9 }
}

fn memory() -> (u64, u64) {
    let mut c = PROCESS_MEMORY_COUNTERS_EX {
        cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    let ptr = (&raw mut c).cast::<PROCESS_MEMORY_COUNTERS>();
    match unsafe { GetProcessMemoryInfo(GetCurrentProcess(), ptr, c.cb) } {
        Ok(()) => (c.WorkingSetSize as u64, c.PrivateUsage as u64),
        Err(_) => (0, 0),
    }
}

/// 從行程建立到現在經過的毫秒數。包含載入 DLL、建立視窗、OpenGL 與字型初始化。
pub fn ms_since_process_start() -> Option<f64> {
    let created = created_at()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_nanos() as u64 / 100 + FILETIME_UNIX_OFFSET;
    Some(now.saturating_sub(created) as f64 / 10_000.0)
}

pub struct ProcessSampler {
    last_cycles: u64,
    last_at: Instant,
    cycles_per_sec: f64,
    cores: f64,
}

impl ProcessSampler {
    pub fn new() -> Self {
        Self {
            last_cycles: cycles(),
            last_at: Instant::now(),
            cycles_per_sec: cycles_per_sec(),
            cores: std::thread::available_parallelism().map_or(1, |n| n.get()) as f64,
        }
    }

    pub fn sample(&mut self) -> ProcessUsage {
        let now = cycles();
        let elapsed = self.last_at.elapsed().as_secs_f64().max(0.001);
        let used = now.saturating_sub(self.last_cycles) as f64 / self.cycles_per_sec;
        self.last_cycles = now;
        self.last_at = Instant::now();
        let (working_set, private) = memory();
        ProcessUsage { working_set, private, cpu: (used / elapsed / self.cores * 100.0) as f32 }
    }
}

/// 最近 N 幀的統計。egui 只在有輸入或資料變動時才重繪，閒置時 FPS 接近 0 是正常的。
pub struct FrameStats {
    /// 行程建立 → 第一次建構完介面（毫秒）。
    pub first_frame_ms: Option<f64>,
    pub total_frames: u64,
    /// 每幀建構介面（執行 `App::ui`）花的時間，毫秒。
    pub build_ms: VecDeque<f32>,
    /// eframe 回報的上一幀 CPU 時間（建構 + 排版 + 送出繪圖指令，不含等待 vsync），毫秒。
    pub frame_cpu_ms: VecDeque<f32>,
    stamps: VecDeque<Instant>,
}

pub const FRAME_HISTORY: usize = 120;

impl FrameStats {
    pub fn new() -> Self {
        Self {
            first_frame_ms: None,
            total_frames: 0,
            build_ms: VecDeque::with_capacity(FRAME_HISTORY),
            frame_cpu_ms: VecDeque::with_capacity(FRAME_HISTORY),
            stamps: VecDeque::new(),
        }
    }

    /// `extra_pass`：同一幀因 `request_discard` 重跑的排版，累加到上一筆而不算新的一幀。
    pub fn record(&mut self, build: Duration, frame_cpu_secs: Option<f32>, extra_pass: bool) {
        let build_ms = build.as_secs_f32() * 1000.0;
        if extra_pass {
            if let Some(last) = self.build_ms.back_mut() {
                *last += build_ms;
            }
            return;
        }
        if self.first_frame_ms.is_none() {
            self.first_frame_ms = ms_since_process_start();
        }
        self.total_frames += 1;
        push(&mut self.build_ms, build_ms);
        if let Some(s) = frame_cpu_secs {
            push(&mut self.frame_cpu_ms, s * 1000.0);
        }
        let now = Instant::now();
        self.stamps.push_back(now);
        while self.stamps.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(1)) {
            self.stamps.pop_front();
        }
    }

    /// 最近 1 秒實際繪製的畫面數。
    pub fn fps(&self) -> usize {
        self.stamps.len()
    }
}

fn push(q: &mut VecDeque<f32>, v: f32) {
    if q.len() == FRAME_HISTORY {
        q.pop_front();
    }
    q.push_back(v);
}

pub fn avg_max(q: &VecDeque<f32>) -> (f32, f32) {
    if q.is_empty() {
        return (0.0, 0.0);
    }
    let max = q.iter().copied().fold(0.0, f32::max);
    (q.iter().sum::<f32>() / q.len() as f32, max)
}
