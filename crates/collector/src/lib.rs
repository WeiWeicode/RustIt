//! 端點資料蒐集：Demo 與之後的 Agent 共用。
//!
//! 資料來源：sysinfo（OS、記憶體、磁碟區）、WMI（硬體、網路、防毒）、登錄檔（軟體、USB、RustDesk）。
//! 任何單一來源失敗都不會中斷整體蒐集，錯誤會記錄在 [`ComputerInfo::warnings`]。

mod registry;
mod wmi_query;

pub use registry::find_installed;

use serde::Serialize;
use std::time::Instant;
use sysinfo::{Disks, System};

#[derive(Debug, Clone, Default, Serialize)]
pub struct ComputerInfo {
    pub system: SystemSummary,
    pub identity: Identity,
    pub cpu: CpuInfo,
    pub memory_total: u64,
    pub memory_modules: Vec<MemoryModule>,
    pub physical_disks: Vec<PhysicalDisk>,
    pub volumes: Vec<Volume>,
    pub gpus: Vec<Gpu>,
    pub network: Vec<NetAdapter>,
    pub software: Vec<Software>,
    pub security: SecurityInfo,
    pub usb: UsbInfo,
    pub rustdesk: RustDeskStatus,
    pub collect_ms: u128,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SystemSummary {
    pub host_name: String,
    pub user_name: String,
    pub domain: String,
    pub part_of_domain: bool,
    pub manufacturer: String,
    pub model: String,
    pub os_name: String,
    pub os_version: String,
    /// 例如 `24H2`。
    pub os_display_version: String,
    /// 含 UBR 的完整組建，例如 `26100.6584`。
    pub os_build: String,
    pub arch: String,
    pub boot_time: u64,
}

/// 資產唯一識別：BIOS 序號 + 系統 UUID（見 PRD 第 2 節）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct Identity {
    pub bios_serial: String,
    pub bios_vendor: String,
    pub bios_version: String,
    pub board_manufacturer: String,
    pub board_product: String,
    pub board_serial: String,
    pub system_uuid: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CpuInfo {
    pub name: String,
    pub cores: u32,
    pub logical: u32,
    pub max_mhz: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MemoryModule {
    pub slot: String,
    pub capacity: u64,
    pub speed_mhz: u32,
    pub manufacturer: String,
    pub part_number: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PhysicalDisk {
    pub model: String,
    pub serial: String,
    pub size: u64,
    pub interface: String,
    pub media_type: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Volume {
    pub mount_point: String,
    pub label: String,
    pub file_system: String,
    pub total: u64,
    pub available: u64,
    pub removable: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Gpu {
    pub name: String,
    pub driver_version: String,
    pub resolution: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct NetAdapter {
    pub description: String,
    pub mac: String,
    pub ips: Vec<String>,
    pub gateways: Vec<String>,
    pub dns: Vec<String>,
    pub dhcp_enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Software {
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub install_date: String,
}

/// 登錄檔 Uninstall 機碼中的一筆軟體，供軟體派送判斷是否已安裝與移除。
#[derive(Debug, Clone, Default, Serialize)]
pub struct InstalledApp {
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub uninstall_string: String,
    pub quiet_uninstall_string: String,
    pub install_location: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SecurityInfo {
    pub antivirus: Vec<Antivirus>,
    pub recent_hotfixes: Vec<Hotfix>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Antivirus {
    pub name: String,
    pub enabled: bool,
    pub up_to_date: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Hotfix {
    pub id: String,
    pub description: String,
    pub installed_on: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UsbInfo {
    /// 登錄檔 `USBSTOR\Start`：3 = 允許、4 = 停用。
    pub storage_policy: UsbPolicy,
    /// 曾經插入過的 USB 儲存裝置（`Enum\USBSTOR`）。
    pub storage_history: Vec<UsbDevice>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub enum UsbPolicy {
    Allowed,
    Blocked,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UsbDevice {
    pub friendly_name: String,
    pub serial: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RustDeskStatus {
    pub installed: bool,
    pub version: String,
    pub exe_path: String,
    pub id: String,
    pub custom_server: String,
}

/// 完整蒐集一次。WMI 查詢約需 1–3 秒，請在背景執行緒呼叫。
pub fn collect() -> ComputerInfo {
    let started = Instant::now();
    let mut info = ComputerInfo::default();
    let mut warnings = Vec::new();

    let sys = System::new_all();
    info.system = SystemSummary {
        host_name: System::host_name().unwrap_or_default(),
        user_name: current_user(),
        os_name: System::long_os_version().unwrap_or_default(),
        os_version: System::os_version().unwrap_or_default(),
        os_build: System::kernel_version().unwrap_or_default(),
        arch: System::cpu_arch(),
        boot_time: System::boot_time(),
        ..Default::default()
    };
    info.memory_total = sys.total_memory();
    info.volumes = Disks::new_with_refreshed_list()
        .iter()
        .map(|d| Volume {
            mount_point: d.mount_point().to_string_lossy().into_owned(),
            label: d.name().to_string_lossy().into_owned(),
            file_system: d.file_system().to_string_lossy().into_owned(),
            total: d.total_space(),
            available: d.available_space(),
            removable: d.is_removable(),
        })
        .collect();

    if let Some((display, build)) = registry::os_build() {
        info.system.os_display_version = display;
        info.system.os_build = build;
    }

    wmi_query::fill(&mut info, &mut warnings);

    info.software = registry::installed_software();
    info.usb = registry::usb_info();
    info.rustdesk = registry::rustdesk_status(&info.software);

    // WMI 抓不到 CPU 名稱時（例如 WMI 服務異常）改用 sysinfo。
    if info.cpu.name.is_empty() {
        if let Some(cpu) = sys.cpus().first() {
            info.cpu.name = cpu.brand().trim().to_string();
        }
        info.cpu.logical = sys.cpus().len() as u32;
    }

    info.warnings = warnings;
    info.collect_ms = started.elapsed().as_millis();
    info
}

fn current_user() -> String {
    let user = std::env::var("USERNAME").unwrap_or_default();
    match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!("{domain}\\{user}"),
        _ => user,
    }
}

impl Identity {
    /// 組裝機常見的 BIOS 預設序號，不能拿來當資產識別。
    pub fn bios_serial_is_placeholder(&self) -> bool {
        let s = self.bios_serial.to_lowercase();
        s.is_empty()
            || s.chars().all(|c| c == '0')
            || ["system serial number", "to be filled by o.e.m.", "default string", "not specified"]
                .contains(&s.as_str())
    }

    /// 資產唯一識別碼：優先用 BIOS 序號，預設值時改用系統 UUID。
    pub fn asset_key(&self) -> &str {
        if self.bios_serial_is_placeholder() { &self.system_uuid } else { &self.bios_serial }
    }
}

impl ComputerInfo {
    /// 用來比對硬體拆換的零件清單（PRD 2「變更偵測」）。
    pub fn hardware_parts(&self) -> Vec<String> {
        let mut parts = vec![format!("處理器 {}", self.cpu.name)];
        parts.extend(self.memory_modules.iter().map(|m| {
            format!("記憶體 {} {} {} {}", m.slot, m.capacity / (1 << 30), m.manufacturer, m.part_number)
        }));
        parts.extend(
            self.physical_disks
                .iter()
                .map(|d| format!("硬碟 {} ({})", d.model, d.serial)),
        );
        parts.extend(self.gpus.iter().map(|g| format!("顯示卡 {}", g.name)));
        parts
    }

    /// 與上一次蒐集比對，回傳（新增的零件, 移除的零件）。
    pub fn hardware_diff(&self, previous: &ComputerInfo) -> (Vec<String>, Vec<String>) {
        let now = self.hardware_parts();
        let before = previous.hardware_parts();
        let added = now.iter().filter(|p| !before.contains(p)).cloned().collect();
        let removed = before.iter().filter(|p| !now.contains(p)).cloned().collect();
        (added, removed)
    }

    /// 第一張有閘道的網卡的 IPv4，沒有就取任一 IPv4。
    pub fn primary_ipv4(&self) -> Option<&str> {
        let is_v4 = |ip: &&String| ip.contains('.');
        self.network
            .iter()
            .filter(|n| !n.gateways.is_empty())
            .chain(self.network.iter())
            .find_map(|n| n.ips.iter().find(is_v4))
            .map(String::as_str)
    }
}
