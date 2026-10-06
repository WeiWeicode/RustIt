// Release 版不跳出命令列視窗。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! RustIt Demo：Rust 負責蒐集本機資料，介面在 `ui/`（HTML/CSS/JS，由 WebView2 顯示）。
//! 報修單與公告是前端記憶體中的模擬資料，不連伺服器、不寫資料庫。

mod deploy;

use rustit_collector::ComputerInfo;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use sysinfo::System;
use tauri::State;

#[derive(Default)]
struct AppState {
    last: Mutex<Option<ComputerInfo>>,
    sys: Mutex<Option<System>>,
}

/// 蒐集結果加上前端需要、但不在 `ComputerInfo` 欄位裡的衍生值。
#[derive(Serialize)]
struct Snapshot {
    info: ComputerInfo,
    asset_key: String,
    bios_placeholder: bool,
    primary_ip: Option<String>,
    /// 與上一次蒐集比對的（新增, 移除）零件；第一次蒐集為 `None`。
    hardware_changes: Option<(Vec<String>, Vec<String>)>,
}

#[derive(Serialize)]
struct LiveStats {
    cpu: f32,
    mem_used: u64,
    mem_total: u64,
    uptime: u64,
}

#[tauri::command]
async fn collect(state: State<'_, AppState>) -> Result<Snapshot, String> {
    // WMI 查詢約 2 秒，放到 blocking 執行緒。
    let info = tauri::async_runtime::spawn_blocking(rustit_collector::collect)
        .await
        .map_err(|e| e.to_string())?;
    let mut last = state.last.lock().map_err(|e| e.to_string())?;
    let hardware_changes = last.as_ref().map(|prev| info.hardware_diff(prev));
    let snapshot = Snapshot {
        asset_key: info.identity.asset_key().to_string(),
        bios_placeholder: info.identity.bios_serial_is_placeholder(),
        primary_ip: info.primary_ipv4().map(str::to_string),
        hardware_changes,
        info: info.clone(),
    };
    *last = Some(info);
    Ok(snapshot)
}

#[tauri::command]
fn live_stats(state: State<'_, AppState>) -> Result<LiveStats, String> {
    let mut guard = state.sys.lock().map_err(|e| e.to_string())?;
    let sys = guard.get_or_insert_with(|| {
        // CPU 使用率需要兩次取樣才準，第一次先暖機。
        let mut s = System::new();
        s.refresh_cpu_usage();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        s
    });
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    Ok(LiveStats {
        cpu: sys.global_cpu_usage(),
        mem_used: sys.used_memory(),
        mem_total: sys.total_memory(),
        uptime: System::uptime(),
    })
}

/// 匯出 Agent 將回報給伺服器的 JSON，存在 exe 旁邊，回傳完整路徑。
#[tauri::command]
fn export_json(state: State<'_, AppState>) -> Result<String, String> {
    let last = state.last.lock().map_err(|e| e.to_string())?;
    let info = last.as_ref().ok_or("尚未完成資料蒐集")?;
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("rustit-{}-{stamp}.json", info.system.host_name));
    let json = serde_json::to_string_pretty(info).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// 在檔案總管中顯示剛匯出的檔案。只接受本程式匯出的 JSON。
#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let ok = p.extension().is_some_and(|e| e == "json")
        && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("rustit-"))
        && p.is_file();
    if !ok {
        return Err("不允許的路徑".into());
    }
    std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 開啟本機的 RustDesk。路徑取自蒐集結果，不接受前端傳入。
#[tauri::command]
fn open_rustdesk(state: State<'_, AppState>) -> Result<(), String> {
    let last = state.last.lock().map_err(|e| e.to_string())?;
    let exe = last
        .as_ref()
        .map(|i| i.rustdesk.exe_path.clone())
        .filter(|p| !p.is_empty())
        .ok_or("這台電腦沒有安裝 RustDesk")?;
    std::process::Command::new(exe)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(deploy::DeployState::default())
        .invoke_handler(tauri::generate_handler![
            collect,
            live_stats,
            export_json,
            reveal_file,
            open_rustdesk,
            deploy::deploy_catalog,
            deploy::deploy_install,
            deploy::deploy_uninstall
        ])
        .run(tauri::generate_context!())
        .expect("無法啟動 RustIt Demo");
}
