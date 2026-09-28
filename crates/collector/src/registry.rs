//! 登錄檔與設定檔讀取：已安裝軟體、USB 儲存裝置、RustDesk。

use crate::{RustDeskStatus, Software, UsbDevice, UsbInfo, UsbPolicy};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use winreg::{HKCU, HKLM, RegKey};

const UNINSTALL_PATHS: [(&RegKey, &str); 3] = [
    (HKLM, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    (HKLM, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    (HKCU, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
];

fn string(key: &RegKey, name: &str) -> String {
    key.get_value::<String, _>(name)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// 逐一走訪所有 Uninstall 子機碼。
fn for_each_uninstall_entry(mut f: impl FnMut(&RegKey)) {
    for (root, path) in UNINSTALL_PATHS {
        let Ok(uninstall) = root.open_subkey(path) else { continue };
        for name in uninstall.enum_keys().flatten() {
            if let Ok(entry) = uninstall.open_subkey(&name) {
                f(&entry);
            }
        }
    }
}

/// 與「設定 > 應用程式」相同的篩選：略過系統元件與更新套件。
pub(crate) fn installed_software() -> Vec<Software> {
    let mut seen = HashSet::new();
    let mut list = Vec::new();
    for_each_uninstall_entry(|entry| {
        let name = string(entry, "DisplayName");
        let system_component = entry.get_value::<u32, _>("SystemComponent").unwrap_or(0) == 1;
        let is_update = !string(entry, "ParentKeyName").is_empty();
        if name.is_empty() || system_component || is_update {
            return;
        }
        let version = string(entry, "DisplayVersion");
        if seen.insert((name.to_lowercase(), version.clone())) {
            list.push(Software {
                name,
                version,
                publisher: string(entry, "Publisher"),
                install_date: format_install_date(&string(entry, "InstallDate")),
            });
        }
    });
    list.sort_by_key(|s| s.name.to_lowercase());
    list
}

/// 依 DisplayName 開頭（不分大小寫）找已安裝的軟體，含解除安裝指令。
pub fn find_installed(name_prefix: &str) -> Option<crate::InstalledApp> {
    let prefix = name_prefix.to_lowercase();
    let mut found = None;
    for_each_uninstall_entry(|entry| {
        if found.is_some() {
            return;
        }
        let name = string(entry, "DisplayName");
        if name.to_lowercase().starts_with(&prefix) {
            found = Some(crate::InstalledApp {
                version: string(entry, "DisplayVersion"),
                publisher: string(entry, "Publisher"),
                uninstall_string: string(entry, "UninstallString"),
                quiet_uninstall_string: string(entry, "QuietUninstallString"),
                install_location: string(entry, "InstallLocation"),
                name,
            });
        }
    });
    found
}

/// `20260915` → `2026-09-15`；其他格式原樣回傳。
fn format_install_date(raw: &str) -> String {
    if raw.len() == 8 && raw.bytes().all(|b| b.is_ascii_digit()) {
        format!("{}-{}-{}", &raw[..4], &raw[4..6], &raw[6..])
    } else {
        raw.to_string()
    }
}

/// 回傳（版本代號如 `24H2`, 完整組建如 `26100.6584`）。UBR 反映已安裝的累積更新。
pub(crate) fn os_build() -> Option<(String, String)> {
    let key = HKLM.open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").ok()?;
    let build = string(&key, "CurrentBuild");
    let build = match key.get_value::<u32, _>("UBR") {
        Ok(ubr) => format!("{build}.{ubr}"),
        Err(_) => build,
    };
    Some((string(&key, "DisplayVersion"), build))
}

pub(crate) fn usb_info() -> UsbInfo {
    let storage_policy = HKLM
        .open_subkey(r"SYSTEM\CurrentControlSet\Services\USBSTOR")
        .and_then(|k| k.get_value::<u32, _>("Start"))
        .map(|start| if start == 4 { UsbPolicy::Blocked } else { UsbPolicy::Allowed })
        .unwrap_or(UsbPolicy::Unknown);

    // Enum\USBSTOR\<裝置型號>\<序號> 保存曾插入過的 USB 儲存裝置。
    let mut storage_history = Vec::new();
    if let Ok(usbstor) = HKLM.open_subkey(r"SYSTEM\CurrentControlSet\Enum\USBSTOR") {
        for model in usbstor.enum_keys().flatten() {
            let Ok(model_key) = usbstor.open_subkey(&model) else { continue };
            for instance in model_key.enum_keys().flatten() {
                let friendly = model_key
                    .open_subkey(&instance)
                    .map(|k| string(&k, "FriendlyName"))
                    .unwrap_or_default();
                storage_history.push(UsbDevice {
                    friendly_name: if friendly.is_empty() { model.clone() } else { friendly },
                    serial: instance.split('&').next().unwrap_or(&instance).to_string(),
                });
            }
        }
    }

    UsbInfo { storage_policy, storage_history }
}

pub(crate) fn rustdesk_status(software: &[Software]) -> RustDeskStatus {
    let mut status = RustDeskStatus::default();

    if let Some(sw) = software.iter().find(|s| s.name.to_lowercase().starts_with("rustdesk")) {
        status.installed = true;
        status.version = sw.version.clone();
    }

    let mut install_dir = None;
    for_each_uninstall_entry(|entry| {
        if install_dir.is_none() && string(entry, "DisplayName").to_lowercase().starts_with("rustdesk") {
            let loc = string(entry, "InstallLocation");
            if !loc.is_empty() {
                install_dir = Some(PathBuf::from(loc.trim_matches('"')));
            }
        }
    });
    let candidates = install_dir
        .into_iter()
        .chain(std::env::var_os("ProgramFiles").map(|p| Path::new(&p).join("RustDesk")));
    for dir in candidates {
        let exe = dir.join("rustdesk.exe");
        if exe.is_file() {
            status.installed = true;
            status.exe_path = exe.to_string_lossy().into_owned();
            break;
        }
    }

    // RustDesk 以服務模式執行時設定檔在 LocalService 底下，否則在使用者的 AppData。
    let config_dirs = [
        std::env::var_os("APPDATA").map(|p| Path::new(&p).join(r"RustDesk\config")),
        Some(PathBuf::from(
            r"C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config",
        )),
    ];
    for dir in config_dirs.into_iter().flatten() {
        if status.id.is_empty() {
            status.id = toml_value(&dir.join("RustDesk.toml"), "id").unwrap_or_default();
        }
        if status.custom_server.is_empty() {
            status.custom_server =
                toml_value(&dir.join("RustDesk2.toml"), "custom-rendezvous-server").unwrap_or_default();
        }
    }
    // 新版 RustDesk 只存加密後的 enc_id，改問執行檔本身。
    if status.id.is_empty() && !status.exe_path.is_empty() {
        status.id = rustdesk_get_id(Path::new(&status.exe_path)).unwrap_or_default();
    }
    status
}

fn rustdesk_get_id(exe: &Path) -> Option<String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut child = Command::new(exe)
        .arg("--get-id")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().ok()?.is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let id = out.trim();
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())).then(|| id.to_string())
}

/// 讀取簡單的 `key = 'value'` 行，不需要完整的 TOML 解析器。
fn toml_value(path: &Path, key: &str) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    content.lines().find_map(|line| {
        let (k, v) = line.split_once('=')?;
        (k.trim() == key)
            .then(|| v.trim().trim_matches(['\'', '"']).to_string())
            .filter(|v| !v.is_empty())
    })
}
