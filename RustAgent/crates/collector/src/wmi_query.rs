//! WMI 查詢。struct 名稱即 WMI 類別名稱，欄位名稱需與 WMI 屬性完全相同。
//! 每項查詢在獨立執行緒執行並設逾時（[`QUERY_TIMEOUT`]），WMI 卡住時不拖住整次蒐集（PLATFORM-PLAN §4.10 A6）。
#![allow(non_snake_case, non_camel_case_types)]

use crate::{
    Antivirus, ComputerInfo, Gpu, Hotfix, MemoryModule, NetAdapter, PhysicalDisk,
};
use crate::background::BackgroundMode;
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use wmi::WMIConnection;

#[derive(Deserialize)]
struct Win32_ComputerSystem {
    Manufacturer: Option<String>,
    Model: Option<String>,
    Domain: Option<String>,
    PartOfDomain: Option<bool>,
}

#[derive(Deserialize)]
struct Win32_BIOS {
    SerialNumber: Option<String>,
    Manufacturer: Option<String>,
    SMBIOSBIOSVersion: Option<String>,
}

#[derive(Deserialize)]
struct Win32_BaseBoard {
    Manufacturer: Option<String>,
    Product: Option<String>,
    SerialNumber: Option<String>,
}

#[derive(Deserialize)]
struct Win32_ComputerSystemProduct {
    UUID: Option<String>,
}

#[derive(Deserialize)]
struct Win32_Processor {
    Name: Option<String>,
    NumberOfCores: Option<u32>,
    NumberOfLogicalProcessors: Option<u32>,
    MaxClockSpeed: Option<u32>,
}

#[derive(Deserialize)]
struct Win32_PhysicalMemory {
    DeviceLocator: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    Capacity: Option<u64>,
    Speed: Option<u32>,
    Manufacturer: Option<String>,
    PartNumber: Option<String>,
}

#[derive(Deserialize)]
struct Win32_DiskDrive {
    Model: Option<String>,
    SerialNumber: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    Size: Option<u64>,
    InterfaceType: Option<String>,
    MediaType: Option<String>,
}

#[derive(Deserialize)]
struct Win32_VideoController {
    Name: Option<String>,
    DriverVersion: Option<String>,
    CurrentHorizontalResolution: Option<u32>,
    CurrentVerticalResolution: Option<u32>,
}

#[derive(Deserialize)]
struct NetConfig {
    Description: Option<String>,
    MACAddress: Option<String>,
    IPAddress: Option<Vec<String>>,
    DefaultIPGateway: Option<Vec<String>>,
    DNSServerSearchOrder: Option<Vec<String>>,
    DHCPEnabled: Option<bool>,
}

#[derive(Deserialize)]
struct Win32_QuickFixEngineering {
    HotFixID: Option<String>,
    Description: Option<String>,
    InstalledOn: Option<String>,
}

#[derive(Deserialize)]
struct AntiVirusProduct {
    displayName: Option<String>,
    productState: Option<u32>,
}

/// WMI 的 uint64 屬性會以字串回傳，這裡同時接受數字與字串。
fn lenient_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Num {
        U(u64),
        I(i64),
        S(String),
    }
    Ok(match Option::<Num>::deserialize(d)? {
        Some(Num::U(v)) => Some(v),
        Some(Num::I(v)) => u64::try_from(v).ok(),
        Some(Num::S(s)) => s.trim().parse().ok(),
        None => None,
    })
}

fn text(v: Option<String>) -> String {
    v.map(|s| s.trim().to_string()).unwrap_or_default()
}

/// 單項 WMI 查詢最多等多久（PLATFORM-PLAN §4.10 A6）
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(15);

/// 在獨立執行緒執行 `f`，最多等 `timeout`。逾時回 `None`，該執行緒繼續跑到結束後自行釋放
/// （同步 COM 呼叫無法中途取消）。
pub(crate) fn run_with_timeout<T: Send + 'static>(
    name: &str,
    timeout: Duration,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<Option<T>, String> {
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name(format!("wmi-{name}"))
        .spawn(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| format!("無法建立查詢執行緒：{e}"))?;
    match rx.recv_timeout(timeout) {
        Ok(v) => Ok(Some(v)),
        Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("查詢執行緒異常結束".into()),
    }
}

/// WMI 查詢：每項在獨立執行緒以新連線執行並設逾時；一旦逾時視為 WMI 無回應，其餘項目略過，
/// 讓整次蒐集最多多等一個逾時，登錄檔與 sysinfo 的資料照常蒐集。
struct Wmi {
    timeout: Duration,
    unresponsive: bool,
}

impl Wmi {
    fn query<T: DeserializeOwned + Send + 'static>(
        &mut self,
        what: &'static str,
        namespace: &'static str,
        query: Option<&'static str>,
        warnings: &mut Vec<String>,
    ) -> Vec<T> {
        if self.unresponsive {
            return Vec::new();
        }
        let result = run_with_timeout(what, self.timeout, move || {
            let _bg = BackgroundMode::enter();
            let con = WMIConnection::with_namespace_path(namespace).map_err(|e| format!("無法連線 WMI {namespace}：{e}"))?;
            match query {
                Some(q) => con.raw_query(q),
                None => con.query(),
            }
            .map_err(|e| format!("WMI {what} 查詢失敗：{e}"))
        });
        match result {
            Ok(Some(Ok(v))) => v,
            Ok(Some(Err(e))) | Err(e) => {
                warnings.push(e);
                Vec::new()
            }
            Ok(None) => {
                warnings.push(format!("WMI {what} 查詢逾時（{} 秒），略過其餘 WMI 項目", self.timeout.as_secs()));
                self.unresponsive = true;
                Vec::new()
            }
        }
    }
}

const CIMV2: &str = "ROOT\\CIMV2";
/// 防毒狀態（Windows Server 上沒有這個命名空間，失敗屬正常、不列警告）
const SECURITY_CENTER: &str = "ROOT\\SecurityCenter2";

pub(crate) fn fill(info: &mut ComputerInfo, warnings: &mut Vec<String>) {
    fill_with(info, warnings, QUERY_TIMEOUT)
}

fn fill_with(info: &mut ComputerInfo, warnings: &mut Vec<String>, timeout: Duration) {
    let mut wmi = Wmi { timeout, unresponsive: false };

    if let Some(cs) = wmi.query::<Win32_ComputerSystem>("ComputerSystem", CIMV2, None, warnings).pop() {
        info.system.manufacturer = text(cs.Manufacturer);
        info.system.model = text(cs.Model);
        info.system.domain = text(cs.Domain);
        info.system.part_of_domain = cs.PartOfDomain.unwrap_or(false);
    }
    if let Some(bios) = wmi.query::<Win32_BIOS>("BIOS", CIMV2, None, warnings).pop() {
        info.identity.bios_serial = text(bios.SerialNumber);
        info.identity.bios_vendor = text(bios.Manufacturer);
        info.identity.bios_version = text(bios.SMBIOSBIOSVersion);
    }
    if let Some(board) = wmi.query::<Win32_BaseBoard>("BaseBoard", CIMV2, None, warnings).pop() {
        info.identity.board_manufacturer = text(board.Manufacturer);
        info.identity.board_product = text(board.Product);
        info.identity.board_serial = text(board.SerialNumber);
    }
    if let Some(p) = wmi.query::<Win32_ComputerSystemProduct>("Product", CIMV2, None, warnings).pop() {
        info.identity.system_uuid = text(p.UUID);
    }
    if let Some(cpu) = wmi.query::<Win32_Processor>("Processor", CIMV2, None, warnings).into_iter().next() {
        info.cpu.name = text(cpu.Name);
        info.cpu.cores = cpu.NumberOfCores.unwrap_or(0);
        info.cpu.logical = cpu.NumberOfLogicalProcessors.unwrap_or(0);
        info.cpu.max_mhz = cpu.MaxClockSpeed.unwrap_or(0);
    }

    info.memory_modules = wmi.query::<Win32_PhysicalMemory>("PhysicalMemory", CIMV2, None, warnings)
        .into_iter()
        .map(|m| MemoryModule {
            slot: text(m.DeviceLocator),
            capacity: m.Capacity.unwrap_or(0),
            speed_mhz: m.Speed.unwrap_or(0),
            manufacturer: text(m.Manufacturer),
            part_number: text(m.PartNumber),
        })
        .collect();

    info.physical_disks = wmi.query::<Win32_DiskDrive>("DiskDrive", CIMV2, None, warnings)
        .into_iter()
        .map(|d| PhysicalDisk {
            model: text(d.Model),
            serial: text(d.SerialNumber),
            size: d.Size.unwrap_or(0),
            interface: text(d.InterfaceType),
            media_type: text(d.MediaType),
        })
        .collect();

    info.gpus = wmi.query::<Win32_VideoController>("VideoController", CIMV2, None, warnings)
        .into_iter()
        .map(|g| Gpu {
            name: text(g.Name),
            driver_version: text(g.DriverVersion),
            resolution: match (g.CurrentHorizontalResolution, g.CurrentVerticalResolution) {
                (Some(w), Some(h)) if w > 0 => format!("{w} × {h}"),
                _ => String::new(),
            },
        })
        .collect();

    info.network = wmi.query::<NetConfig>(
        "NetworkAdapterConfiguration",
        CIMV2,
        Some(
            "SELECT Description, MACAddress, IPAddress, DefaultIPGateway, DNSServerSearchOrder, DHCPEnabled \
             FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = TRUE",
        ),
        warnings,
    )
    .into_iter()
    .map(|n| NetAdapter {
        description: text(n.Description),
        mac: text(n.MACAddress),
        ips: n.IPAddress.unwrap_or_default(),
        gateways: n.DefaultIPGateway.unwrap_or_default(),
        dns: n.DNSServerSearchOrder.unwrap_or_default(),
        dhcp_enabled: n.DHCPEnabled.unwrap_or(false),
    })
    .collect();

    let mut hotfixes: Vec<Hotfix> =
        wmi.query::<Win32_QuickFixEngineering>("QuickFixEngineering", CIMV2, None, warnings)
            .into_iter()
            .map(|h| Hotfix {
                id: text(h.HotFixID),
                description: text(h.Description),
                installed_on: text(h.InstalledOn),
            })
            .collect();
    hotfixes.sort_by_key(|h| std::cmp::Reverse(sortable_date(&h.installed_on)));
    hotfixes.truncate(8);
    info.security.recent_hotfixes = hotfixes;

    // 防毒狀態在 SecurityCenter2 命名空間（Windows Server 上沒有，失敗屬正常，不列警告）。
    let mut ignored = Vec::new();
    info.security.antivirus = wmi
        .query::<AntiVirusProduct>("AntiVirusProduct", SECURITY_CENTER, None, &mut ignored)
        .into_iter()
        .map(|a| {
            let state = a.productState.unwrap_or(0);
            Antivirus {
                name: text(a.displayName),
                enabled: (state >> 12) & 0xF == 1,
                up_to_date: (state >> 4) & 0xF == 0,
            }
        })
        .collect();
    if wmi.unresponsive {
        warnings.extend(ignored.into_iter().filter(|w| w.contains("逾時")));
    }
}

/// QuickFixEngineering 的 InstalledOn 格式為 `M/D/YYYY`，轉成可排序的 `YYYYMMDD`。
fn sortable_date(s: &str) -> u32 {
    let parts: Vec<u32> = s.split('/').filter_map(|p| p.trim().parse().ok()).collect();
    match parts.as_slice() {
        [m, d, y] => y * 10000 + m * 100 + d,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 逾時回 None，不等工作結束；工作完成回結果
    #[test]
    fn timeout_does_not_wait_for_hung_work() {
        let started = std::time::Instant::now();
        let r = run_with_timeout("hung", Duration::from_millis(100), || {
            thread::sleep(Duration::from_secs(5));
            1
        });
        assert_eq!(r, Ok(None));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(run_with_timeout("ok", Duration::from_secs(5), || 7), Ok(Some(7)));
    }

    /// 工作 panic 時回錯誤，不讓蒐集中斷
    #[test]
    fn panicking_work_is_an_error() {
        let r = run_with_timeout::<u8>("panic", Duration::from_secs(5), || panic!("boom"));
        assert!(r.is_err());
    }

    /// 已判定 WMI 無回應後，其餘查詢直接略過
    #[test]
    fn unresponsive_wmi_skips_remaining_queries() {
        let mut wmi = Wmi { timeout: QUERY_TIMEOUT, unresponsive: true };
        let mut warnings = Vec::new();
        let v: Vec<Win32_BIOS> = wmi.query("BIOS", CIMV2, None, &mut warnings);
        assert!(v.is_empty() && warnings.is_empty());
    }
}
