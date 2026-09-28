//! 軟體派送（Demo）：真的下載、驗證簽章、靜默安裝 / 移除。
//!
//! 正式版由 Agent（SYSTEM 服務）執行，不會跳出 UAC；Demo 以一般使用者執行，
//! 所以安裝 / 移除時用 `runas` 提升權限。設計見 docs/decisions/0002-software-deployment.md。

use rustit_collector::{InstalledApp, find_installed};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::async_runtime::{Mutex, spawn, spawn_blocking};
use tauri::{AppHandle, Emitter, Manager};

pub struct CatalogItem {
    pub id: &'static str,
    pub name: &'static str,
    pub publisher: &'static str,
    pub description: &'static str,
    pub url: &'static str,
    pub installer_kind: &'static str,
    pub install_args: &'static str,
    pub uninstall_args: &'static str,
    /// 登錄檔 Uninstall 的 DisplayName 開頭，用來判斷是否已安裝。
    pub detect_prefix: &'static str,
    /// Authenticode 簽章者必須包含這個字串。
    pub signer: &'static str,
}

pub const CATALOG: [CatalogItem; 2] = [
    CatalogItem {
        id: "firefox",
        name: "Mozilla Firefox",
        publisher: "Mozilla",
        description: "開放原始碼網頁瀏覽器（繁體中文，64 位元）",
        url: "https://download.mozilla.org/?product=firefox-latest-ssl&os=win64&lang=zh-TW",
        installer_kind: "EXE（NSIS）",
        install_args: "/S /MaintenanceService=false",
        uninstall_args: "/S",
        detect_prefix: "Mozilla Firefox",
        signer: "Mozilla Corporation",
    },
    CatalogItem {
        id: "winrar",
        name: "WinRAR",
        publisher: "win.rar GmbH",
        description: "壓縮 / 解壓縮工具（繁體中文，64 位元，商業軟體）",
        url: "https://www.rarlab.com/rar/winrar-x64-723tc.exe",
        installer_kind: "EXE（WinRAR 安裝程式）",
        install_args: "/S",
        uninstall_args: "/S",
        detect_prefix: "WinRAR",
        signer: "win.rar GmbH",
    },
];

/// 同一時間只執行一個安裝 / 移除（與 Windows Installer 的限制一致）。
#[derive(Default)]
pub struct DeployState {
    lock: Mutex<()>,
}

#[derive(Serialize)]
pub struct CatalogEntry {
    id: &'static str,
    name: &'static str,
    publisher: &'static str,
    description: &'static str,
    installer_kind: &'static str,
    install_args: &'static str,
    uninstall_args: &'static str,
    signer: &'static str,
    source: String,
    installed: Option<InstalledApp>,
}

#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    action: &'static str,
    /// queued / downloading / verifying / elevating / running / checking / done / failed / cancelled
    stage: &'static str,
    /// 0–100；無法得知進度時為 -1。
    percent: f32,
    downloaded: u64,
    total: u64,
    message: String,
}

struct Reporter {
    app: AppHandle,
    id: &'static str,
    action: &'static str,
}

impl Reporter {
    fn send(&self, stage: &'static str, percent: f32, message: impl Into<String>) {
        self.bytes(stage, percent, 0, 0, message);
    }

    fn bytes(&self, stage: &'static str, percent: f32, downloaded: u64, total: u64, message: impl Into<String>) {
        let _ = self.app.emit(
            "deploy-progress",
            Progress {
                id: self.id.to_string(),
                action: self.action,
                stage,
                percent,
                downloaded,
                total,
                message: message.into(),
            },
        );
    }
}

fn item(id: &str) -> Result<&'static CatalogItem, String> {
    CATALOG.iter().find(|c| c.id == id).ok_or_else(|| format!("軟體目錄沒有 {id}"))
}

#[tauri::command]
pub async fn deploy_catalog() -> Vec<CatalogEntry> {
    spawn_blocking(|| {
        CATALOG
            .iter()
            .map(|c| CatalogEntry {
                id: c.id,
                name: c.name,
                publisher: c.publisher,
                description: c.description,
                installer_kind: c.installer_kind,
                install_args: c.install_args,
                uninstall_args: c.uninstall_args,
                signer: c.signer,
                source: c.url.split('/').nth(2).unwrap_or_default().to_string(),
                installed: find_installed(c.detect_prefix),
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// 排入安裝；立即回傳，進度以 `deploy-progress` 事件送出。
#[tauri::command]
pub fn deploy_install(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    queue(app, ids, "install")
}

#[tauri::command]
pub fn deploy_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    queue(app, vec![id], "uninstall")
}

fn queue(app: AppHandle, ids: Vec<String>, action: &'static str) -> Result<(), String> {
    let items = ids.iter().map(|id| item(id)).collect::<Result<Vec<_>, _>>()?;
    for it in &items {
        Reporter { app: app.clone(), id: it.id, action }.send("queued", 0.0, "排隊中");
    }
    spawn(async move {
        for it in items {
            let state = app.state::<DeployState>();
            let _guard = state.lock.lock().await;
            let r = Reporter { app: app.clone(), id: it.id, action };
            let result = match action {
                "install" => install(&r, it).await,
                _ => uninstall(&r, it).await,
            };
            if let Err(e) = result {
                match e {
                    Failure::Cancelled => r.send("cancelled", 0.0, "已取消：UAC 未允許"),
                    Failure::Other(msg) => r.send("failed", 0.0, msg),
                }
            }
        }
    });
    Ok(())
}

enum Failure {
    Cancelled,
    Other(String),
}

impl<E: std::fmt::Display> From<E> for Failure {
    fn from(e: E) -> Self {
        Failure::Other(e.to_string())
    }
}

fn fail(msg: impl Into<String>) -> Failure {
    Failure::Other(msg.into())
}

// ------------------------------------------------------------ 安裝

async fn install(r: &Reporter, it: &'static CatalogItem) -> Result<(), Failure> {
    if let Some(app) = find_installed(it.detect_prefix) {
        r.send("done", 100.0, format!("已安裝 {}，略過", app.version));
        return Ok(());
    }

    let file = download(r, it).await?;

    r.send("verifying", -1.0, "驗證數位簽章…");
    let f = file.clone();
    let signer = spawn_blocking(move || verify_signature(&f)).await??;
    if !signer.contains(it.signer) {
        return Err(fail(format!("簽章者不符：{signer}")));
    }
    r.send("verifying", 100.0, format!("簽章有效：{}", short_signer(&signer)));

    run_elevated_step(r, file, it.install_args.to_string(), Duration::from_secs(15 * 60)).await?;

    r.send("checking", -1.0, "確認安裝結果…");
    let prefix = it.detect_prefix;
    let found = poll(Duration::from_secs(120), move || find_installed(prefix)).await;
    match found {
        Some(app) => {
            r.send("done", 100.0, format!("安裝完成：{} {}", app.name, app.version));
            Ok(())
        }
        None => Err(fail("安裝程式已結束，但登錄檔找不到這個軟體")),
    }
}

/// 下載到 %LOCALAPPDATA%\RustIt\cache；檔案已完整存在時直接使用快取。
async fn download(r: &Reporter, it: &CatalogItem) -> Result<PathBuf, Failure> {
    let dir = cache_dir();
    std::fs::create_dir_all(&dir)?;

    r.send("downloading", 0.0, "連線中…");
    let client = reqwest::Client::builder()
        .user_agent("RustIt-Demo/0.1")
        .connect_timeout(Duration::from_secs(15))
        .build()?;
    let mut resp = client.get(it.url).send().await?.error_for_status()?;
    let name = resp
        .url()
        .path_segments()
        .and_then(|mut s| s.next_back().map(percent_decode))
        .filter(|n| n.to_lowercase().ends_with(".exe"))
        .ok_or_else(|| fail("下載位址不是 .exe 安裝檔"))?;
    let path = dir.join(&name);
    let total = resp.content_length().unwrap_or(0);

    if total > 0 && std::fs::metadata(&path).is_ok_and(|m| m.len() == total) {
        r.bytes("downloading", 100.0, total, total, format!("使用快取：{name}"));
        return Ok(path);
    }

    let part = dir.join(format!("{name}.part"));
    let mut out = std::fs::File::create(&part)?;
    let mut done = 0u64;
    let started = Instant::now();
    let mut last = Instant::now() - Duration::from_secs(1);
    while let Some(chunk) = resp.chunk().await? {
        out.write_all(&chunk)?;
        done += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(120) {
            last = Instant::now();
            let pct = if total > 0 { done as f32 / total as f32 * 100.0 } else { -1.0 };
            let speed = done as f64 / started.elapsed().as_secs_f64().max(0.001) / 1_048_576.0;
            r.bytes("downloading", pct, done, total, format!("{name} · {speed:.1} MB/s"));
        }
    }
    out.flush()?;
    drop(out);
    if total > 0 && done != total {
        return Err(fail(format!("下載不完整（{done} / {total} bytes）")));
    }
    std::fs::rename(&part, &path)?;
    r.bytes("downloading", 100.0, done, done.max(total), format!("下載完成：{name}"));
    Ok(path)
}

fn cache_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(r"RustIt\cache")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 以 PowerShell 的 Get-AuthenticodeSignature 驗證，回傳簽章者 Subject。
/// 正式版改用 WinVerifyTrust API。路徑經環境變數傳入，避免指令注入。
fn verify_signature(path: &Path) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$s = Get-AuthenticodeSignature -LiteralPath $env:RUSTIT_VERIFY_FILE; \
             Write-Output ($s.Status.ToString() + '|' + $s.SignerCertificate.Subject)",
        ])
        .env("RUSTIT_VERIFY_FILE", path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("無法執行簽章驗證：{e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (status, subject) = text.split_once('|').unwrap_or((text.as_str(), ""));
    if status != "Valid" {
        return Err(format!("數位簽章無效（{status}）"));
    }
    Ok(subject.to_string())
}

fn short_signer(subject: &str) -> &str {
    subject
        .split(',')
        .find_map(|p| p.trim().strip_prefix("CN="))
        .unwrap_or(subject)
}

// ------------------------------------------------------------ 移除

async fn uninstall(r: &Reporter, it: &'static CatalogItem) -> Result<(), Failure> {
    let Some(app) = find_installed(it.detect_prefix) else {
        r.send("done", 100.0, "尚未安裝，不需移除");
        return Ok(());
    };
    let (exe, args) = uninstall_command(&app, it.uninstall_args).ok_or_else(|| fail("找不到解除安裝程式"))?;
    r.send("verifying", 100.0, format!("解除安裝程式：{}", exe.display()));

    run_elevated_step(r, exe, args, Duration::from_secs(10 * 60)).await?;

    // NSIS 的解除安裝程式會複製到暫存資料夾再執行，原程序提早結束，所以要輪詢登錄檔。
    r.send("checking", -1.0, "確認已移除…");
    let prefix = it.detect_prefix;
    let gone = poll(Duration::from_secs(120), move || find_installed(prefix).is_none().then_some(())).await;
    match gone {
        Some(()) => {
            r.send("done", 100.0, format!("已移除 {} {}", app.name, app.version));
            Ok(())
        }
        None => Err(fail("解除安裝程式已結束，但軟體仍在登錄檔中")),
    }
}

/// 從登錄檔的解除安裝字串組出（執行檔, 參數）。MSI 轉成 `msiexec /x {產品代碼} /qn`。
fn uninstall_command(app: &InstalledApp, silent_args: &str) -> Option<(PathBuf, String)> {
    let raw = if app.quiet_uninstall_string.is_empty() { &app.uninstall_string } else { &app.quiet_uninstall_string };
    let lower = raw.to_lowercase();
    if lower.contains("msiexec") {
        let start = raw.find('{')?;
        let end = raw[start..].find('}')? + start;
        return Some((PathBuf::from("msiexec.exe"), format!("/x {} /qn /norestart", &raw[start..=end])));
    }
    let (exe, rest) = split_command(raw)?;
    if !exe.is_file() {
        return None;
    }
    let args = if app.quiet_uninstall_string.is_empty() { format!("{rest} {silent_args}") } else { rest };
    Some((exe, args.trim().to_string()))
}

fn split_command(cmd: &str) -> Option<(PathBuf, String)> {
    let cmd = cmd.trim();
    if let Some(rest) = cmd.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some((PathBuf::from(&rest[..end]), rest[end + 1..].trim().to_string()));
    }
    let end = cmd.to_lowercase().find(".exe").map(|i| i + 4)?;
    Some((PathBuf::from(&cmd[..end]), cmd[end..].trim().to_string()))
}

// ------------------------------------------------------------ 共用

async fn run_elevated_step(r: &Reporter, exe: PathBuf, args: String, timeout: Duration) -> Result<(), Failure> {
    r.send("elevating", -1.0, "等待 Windows 的 UAC 確認…");
    let hwnd = r
        .app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);
    let started = {
        let app = r.app.clone();
        let (id, action) = (r.id, r.action);
        move || Reporter { app, id, action }.send("running", -1.0, "靜默執行中…")
    };
    let code = spawn_blocking(move || elevated::run(hwnd, &exe, &args, timeout, started)).await??;
    match code {
        0 => Ok(()),
        3010 | 1641 => {
            r.send("running", 100.0, "完成，但需要重新開機");
            Ok(())
        }
        1618 => Err(fail("另一個安裝正在進行（1618），請稍後重試")),
        c => Err(fail(format!("安裝程式回傳錯誤代碼 {c}"))),
    }
}

impl From<elevated::Error> for Failure {
    fn from(e: elevated::Error) -> Self {
        match e {
            elevated::Error::Cancelled => Failure::Cancelled,
            elevated::Error::Timeout => fail("執行逾時，已結束程序"),
            elevated::Error::Other(m) => fail(m),
        }
    }
}

async fn poll<T: Send + 'static>(limit: Duration, f: impl Fn() -> Option<T> + Send + Sync + Clone + 'static) -> Option<T> {
    let deadline = Instant::now() + limit;
    loop {
        let g = f.clone();
        if let Ok(Some(v)) = spawn_blocking(g).await {
            return Some(v);
        }
        if Instant::now() > deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
}

mod elevated {
    use std::path::Path;
    use std::time::Duration;
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, HWND, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
    use windows::Win32::System::Threading::{GetExitCodeProcess, TerminateProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
    use windows::core::{HSTRING, PCWSTR, w};

    pub enum Error {
        Cancelled,
        Timeout,
        Other(String),
    }

    /// 以系統管理員身分執行（會跳出 UAC），`on_started` 在使用者允許、程序開始後呼叫。
    pub fn run(hwnd: isize, exe: &Path, args: &str, timeout: Duration, on_started: impl FnOnce()) -> Result<u32, Error> {
        let file = HSTRING::from(exe.as_os_str());
        let params = HSTRING::from(args);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            hwnd: HWND(hwnd as *mut _),
            lpVerb: w!("runas"),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if let Err(e) = ShellExecuteExW(&mut info) {
                return Err(if e.code() == ERROR_CANCELLED.to_hresult() {
                    Error::Cancelled
                } else {
                    Error::Other(format!("無法啟動 {}：{}", exe.display(), e.message()))
                });
            }
        }
        if info.hProcess.is_invalid() {
            return Err(Error::Other("無法取得程序代碼".into()));
        }
        on_started();
        unsafe {
            let wait = WaitForSingleObject(info.hProcess, timeout.as_millis() as u32);
            let result = if wait == WAIT_OBJECT_0 {
                let mut code = 0u32;
                GetExitCodeProcess(info.hProcess, &mut code)
                    .map(|_| code)
                    .map_err(|e| Error::Other(e.message().to_string()))
            } else if wait == WAIT_TIMEOUT {
                let _ = TerminateProcess(info.hProcess, 1);
                Err(Error::Timeout)
            } else {
                Err(Error::Other("等待程序時發生錯誤".into()))
            };
            let _ = CloseHandle(info.hProcess);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_uninstall_strings() {
        let (exe, args) = split_command(r#""C:\Program Files\Mozilla Firefox\uninstall\helper.exe" /foo"#).unwrap();
        assert_eq!(exe, PathBuf::from(r"C:\Program Files\Mozilla Firefox\uninstall\helper.exe"));
        assert_eq!(args, "/foo");
        let (exe, args) = split_command(r"C:\Program Files\WinRAR\uninstall.exe").unwrap();
        assert_eq!(exe, PathBuf::from(r"C:\Program Files\WinRAR\uninstall.exe"));
        assert_eq!(args, "");
    }

    #[test]
    fn msi_uninstall_becomes_quiet() {
        let app = InstalledApp {
            uninstall_string: "MsiExec.exe /X{AAAA-BBBB}".into(),
            ..Default::default()
        };
        let (exe, args) = uninstall_command(&app, "/S").unwrap();
        assert_eq!(exe, PathBuf::from("msiexec.exe"));
        assert_eq!(args, "/x {AAAA-BBBB} /qn /norestart");
    }

    #[test]
    fn decodes_file_names() {
        assert_eq!(percent_decode("Firefox%20Setup%20156.0.1.exe"), "Firefox Setup 156.0.1.exe");
    }

    #[test]
    fn verifies_signed_windows_binary() {
        let signer = verify_signature(Path::new(r"C:\Windows\explorer.exe")).unwrap();
        assert!(signer.contains("Microsoft"), "{signer}");
    }
}
