//! WMI 查詢。struct 名稱即 WMI 類別名稱，欄位名稱需與 WMI 屬性完全相同。
#![allow(non_snake_case, non_camel_case_types)]

use crate::{
    Antivirus, ComputerInfo, Gpu, Hotfix, MemoryModule, NetAdapter, PhysicalDisk,
};
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
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

fn run<T: DeserializeOwned>(
    con: &WMIConnection,
    what: &str,
    warnings: &mut Vec<String>,
    query: Option<&str>,
) -> Vec<T> {
    let result = match query {
        Some(q) => con.raw_query(q),
        None => con.query(),
    };
    result.unwrap_or_else(|e| {
        warnings.push(format!("WMI {what} 查詢失敗：{e}"));
        Vec::new()
    })
}

pub(crate) fn fill(info: &mut ComputerInfo, warnings: &mut Vec<String>) {
    let con = match WMIConnection::new() {
        Ok(c) => c,
        Err(e) => {
            warnings.push(format!("無法連線 WMI：{e}"));
            return;
        }
    };

    if let Some(cs) = run::<Win32_ComputerSystem>(&con, "ComputerSystem", warnings, None).pop() {
        info.system.manufacturer = text(cs.Manufacturer);
        info.system.model = text(cs.Model);
        info.system.domain = text(cs.Domain);
        info.system.part_of_domain = cs.PartOfDomain.unwrap_or(false);
    }
    if let Some(bios) = run::<Win32_BIOS>(&con, "BIOS", warnings, None).pop() {
        info.identity.bios_serial = text(bios.SerialNumber);
        info.identity.bios_vendor = text(bios.Manufacturer);
        info.identity.bios_version = text(bios.SMBIOSBIOSVersion);
    }
    if let Some(board) = run::<Win32_BaseBoard>(&con, "BaseBoard", warnings, None).pop() {
        info.identity.board_manufacturer = text(board.Manufacturer);
        info.identity.board_product = text(board.Product);
        info.identity.board_serial = text(board.SerialNumber);
    }
    if let Some(p) = run::<Win32_ComputerSystemProduct>(&con, "Product", warnings, None).pop() {
        info.identity.system_uuid = text(p.UUID);
    }
    if let Some(cpu) = run::<Win32_Processor>(&con, "Processor", warnings, None).into_iter().next() {
        info.cpu.name = text(cpu.Name);
        info.cpu.cores = cpu.NumberOfCores.unwrap_or(0);
        info.cpu.logical = cpu.NumberOfLogicalProcessors.unwrap_or(0);
        info.cpu.max_mhz = cpu.MaxClockSpeed.unwrap_or(0);
    }

    info.memory_modules = run::<Win32_PhysicalMemory>(&con, "PhysicalMemory", warnings, None)
        .into_iter()
        .map(|m| MemoryModule {
            slot: text(m.DeviceLocator),
            capacity: m.Capacity.unwrap_or(0),
            speed_mhz: m.Speed.unwrap_or(0),
            manufacturer: text(m.Manufacturer),
            part_number: text(m.PartNumber),
        })
        .collect();

    info.physical_disks = run::<Win32_DiskDrive>(&con, "DiskDrive", warnings, None)
        .into_iter()
        .map(|d| PhysicalDisk {
            model: text(d.Model),
            serial: text(d.SerialNumber),
            size: d.Size.unwrap_or(0),
            interface: text(d.InterfaceType),
            media_type: text(d.MediaType),
        })
        .collect();

    info.gpus = run::<Win32_VideoController>(&con, "VideoController", warnings, None)
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

    info.network = run::<NetConfig>(
        &con,
        "NetworkAdapterConfiguration",
        warnings,
        Some(
            "SELECT Description, MACAddress, IPAddress, DefaultIPGateway, DNSServerSearchOrder, DHCPEnabled \
             FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled = TRUE",
        ),
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
        run::<Win32_QuickFixEngineering>(&con, "QuickFixEngineering", warnings, None)
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

    // 防毒狀態在 SecurityCenter2 命名空間（Windows Server 上沒有，失敗屬正常）。
    if let Ok(sc) = WMIConnection::with_namespace_path("ROOT\\SecurityCenter2") {
        if let Ok(list) = sc.query::<AntiVirusProduct>() {
            info.security.antivirus = list
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
        }
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
