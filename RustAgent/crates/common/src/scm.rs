//! Windows 服務控制(PLATFORM-PLAN P5 §4.10 A5;P5-MONITOR-DESIGN §5.2、§6):Agent 與 Watchdog 互相看守共用。
//!
//! - 查詢對方服務的狀態、PID、結束代碼、啟動類型、程式路徑;啟動 / 停止 / 改回自動啟動;結束卡住的行程(握住控制代碼、確認程式與 PID)
//! - 關機中與 Windows Installer 執行中(驗證 mutex 擁有者為 SYSTEM、msiserver 執行中、最長 30 分鐘)不看守
//! - 失敗復原(10 / 30 / 60 秒、1 天重設、非當機失敗也套用;指南 §6.1)與服務 ACL(一般使用者只能查詢)由服務每次啟動時自行套用

use std::ffi::OsStr;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use windows_service::service::{
    Service, ServiceAccess, ServiceAction, ServiceActionType, ServiceExitCode,
    ServiceFailureActions, ServiceFailureResetPeriod, ServiceStartType, ServiceState,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
    GetNamedSecurityInfoW, GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT, SE_KERNEL_OBJECT,
    SetNamedSecurityInfoW,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, EqualSid, GetAce,
    GetSecurityDescriptorDacl, INHERIT_ONLY_ACE, IsWellKnownSid, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, WinBuiltinAdministratorsSid,
    WinLocalSystemSid,
};
use windows_sys::Win32::System::Services::{
    ChangeServiceConfigW, CloseServiceHandle, OpenSCManagerW, OpenServiceW, SC_MANAGER_CONNECT,
    SERVICE_AUTO_START, SERVICE_CHANGE_CONFIG, SERVICE_NO_CHANGE, SetServiceObjectSecurity,
};
use windows_sys::Win32::System::Threading::{
    OpenMutexW, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
};
/// 標準存取權限(windows-sys 放在其他 feature,這裡直接定義)
const SYNCHRONIZE: u32 = 0x0010_0000;
const READ_CONTROL: u32 = 0x0002_0000;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};

pub const AGENT_SERVICE: &str = "GigaNexusAgent";
pub const WATCHDOG_SERVICE: &str = "GigaNexusWatchdog";
/// 指令 agent.restart 的服務專屬結束代碼(agent/src/service.rs)
pub const EXIT_RESTART: u32 = 3;

/// 服務 ACL:SYSTEM、Administrators 完整控制(Agent 與 Watchdog 都以 SYSTEM 執行,要能改對方的啟動類型);
/// 互動 / 服務 / 已驗證使用者只能查詢(Windows 預設也不能停止,明確設定是避免被改寬)
const SERVICE_SDDL: &str = "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWLOCRRC;;;AU)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SvcState {
    Running,
    Stopped,
    StartPending,
    StopPending,
    Paused,
    Missing,
    Unknown,
}

impl SvcState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::StartPending => "start_pending",
            Self::StopPending => "stop_pending",
            Self::Paused => "paused",
            Self::Missing => "missing",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartType {
    Auto,
    Manual,
    Disabled,
    Missing,
    Unknown,
}

impl StartType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
            Self::Disabled => "disabled",
            Self::Missing => "missing",
            Self::Unknown => "unknown",
        }
    }
}

/// 服務停止時的結束代碼
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitKind {
    /// Win32 0:正常停止(被停止、或程式自己結束)
    Clean,
    /// 服務專屬 3:agent.restart
    RestartCommand,
    /// 其他:當掉、被結束行程(1067)、設定錯誤…
    Failed(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SvcInfo {
    pub state: SvcState,
    pub pid: Option<u32>,
    pub exit: ExitKind,
    pub start_type: StartType,
    /// 服務設定指向的程式(由 binary path 取出,不含參數)
    pub exe: Option<PathBuf>,
}

impl SvcInfo {
    pub fn missing() -> Self {
        Self {
            state: SvcState::Missing,
            pid: None,
            exit: ExitKind::Clean,
            start_type: StartType::Missing,
            exe: None,
        }
    }
}

const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
const ERROR_SERVICE_NOT_ACTIVE: i32 = 1062;
const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;

fn win32(e: &windows_service::Error) -> Option<i32> {
    match e {
        windows_service::Error::Winapi(io) => io.raw_os_error(),
        _ => None,
    }
}

fn open(name: &str, access: ServiceAccess) -> Result<Option<Service>, String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("無法連到服務控制管理員:{e}"))?;
    match manager.open_service(name, access) {
        Ok(s) => Ok(Some(s)),
        Err(e) if win32(&e) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => Ok(None),
        Err(e) => Err(format!("無法開啟服務 {name}:{e}")),
    }
}

/// binary path(可能帶引號與參數)→ 程式路徑
pub fn exe_of(binary_path: &str) -> Option<PathBuf> {
    let s = binary_path.trim();
    let path = if let Some(rest) = s.strip_prefix('"') {
        rest.split('"').next()?
    } else {
        let lower = s.to_ascii_lowercase();
        match lower.find(".exe") {
            Some(i) => &s[..i + 4],
            None => s.split_whitespace().next()?,
        }
    };
    (!path.is_empty()).then(|| PathBuf::from(path))
}

pub fn query(name: &str) -> Result<SvcInfo, String> {
    let Some(service) = open(
        name,
        ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG,
    )?
    else {
        return Ok(SvcInfo::missing());
    };
    let status = service
        .query_status()
        .map_err(|e| format!("無法查詢服務 {name} 狀態:{e}"))?;
    let state = match status.current_state {
        ServiceState::Running => SvcState::Running,
        ServiceState::Stopped => SvcState::Stopped,
        ServiceState::StartPending => SvcState::StartPending,
        ServiceState::StopPending => SvcState::StopPending,
        ServiceState::Paused | ServiceState::PausePending | ServiceState::ContinuePending => {
            SvcState::Paused
        }
    };
    let exit = match status.exit_code {
        ServiceExitCode::Win32(0) => ExitKind::Clean,
        ServiceExitCode::ServiceSpecific(EXIT_RESTART) => ExitKind::RestartCommand,
        ServiceExitCode::Win32(c) | ServiceExitCode::ServiceSpecific(c) => ExitKind::Failed(c),
    };
    let (start_type, exe) = match service.query_config() {
        Ok(cfg) => (
            match cfg.start_type {
                ServiceStartType::AutoStart => StartType::Auto,
                ServiceStartType::OnDemand => StartType::Manual,
                ServiceStartType::Disabled => StartType::Disabled,
                _ => StartType::Unknown,
            },
            exe_of(&cfg.executable_path.to_string_lossy()),
        ),
        Err(_) => (StartType::Unknown, None),
    };
    Ok(SvcInfo {
        state,
        pid: status.process_id.filter(|p| *p != 0),
        exit,
        start_type,
        exe,
    })
}

pub fn start(name: &str) -> Result<(), String> {
    let service = open(name, ServiceAccess::START)?.ok_or_else(|| format!("服務 {name} 不存在"))?;
    match service.start::<&OsStr>(&[]) {
        Ok(()) => Ok(()),
        Err(e) if win32(&e) == Some(ERROR_SERVICE_ALREADY_RUNNING) => Ok(()),
        Err(e) => Err(format!("無法啟動服務 {name}:{e}")),
    }
}

/// 停止的結果
#[derive(Debug, PartialEq, Eq)]
pub enum StopOutcome {
    Stopped,
    /// 送出停止後等不到停止(呼叫端才可考慮結束行程)
    TimedOut,
}

/// 送出停止並等到停止;只有「等待逾時」回 `TimedOut`,其他錯誤回 Err(不應因此結束行程)
pub fn stop(name: &str, timeout: Duration) -> Result<StopOutcome, String> {
    let service = open(name, ServiceAccess::STOP | ServiceAccess::QUERY_STATUS)?
        .ok_or_else(|| format!("服務 {name} 不存在"))?;
    if let Err(e) = service.stop()
        && win32(&e) != Some(ERROR_SERVICE_NOT_ACTIVE)
    {
        return Err(format!("無法停止服務 {name}:{e}"));
    }
    wait_stopped(&service, name, timeout)
}

fn wait_stopped(service: &Service, name: &str, timeout: Duration) -> Result<StopOutcome, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match service.query_status() {
            Ok(s) if s.current_state == ServiceState::Stopped => return Ok(StopOutcome::Stopped),
            Ok(_) => {}
            Err(e) => return Err(format!("無法查詢服務 {name} 狀態:{e}")),
        }
        if Instant::now() > deadline {
            return Ok(StopOutcome::TimedOut);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// 握住的行程控制代碼:握著期間 PID 不會被重用(結束行程前先開好,避免結束到不相干的行程)
struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        // SAFETY:OpenProcess 取得的控制代碼只在這裡關閉
        unsafe { CloseHandle(self.0) };
    }
}

impl ProcessHandle {
    fn open(pid: u32) -> Result<Self, String> {
        // SAFETY:控制代碼由 Drop 關閉
        let h = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                0,
                pid,
            )
        };
        if h.is_null() {
            return Err(format!(
                "無法開啟行程 {pid}:{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self(h))
    }

    fn image(&self) -> Option<PathBuf> {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY:緩衝區長度與 len 一致
        let ok = unsafe {
            QueryFullProcessImageNameW(self.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

fn same_path(a: &std::path::Path, b: &std::path::Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

/// 停止服務;逾時才結束行程(Watchdog 處理卡住的 Agent)。
/// 送出停止前先握住行程控制代碼並確認是服務設定的程式;結束前再確認 SCM 的 PID 沒變;結束後等到服務停止
pub fn stop_or_kill(name: &str, pid: Option<u32>, timeout: Duration) -> Result<(), String> {
    let held = match pid {
        Some(p) => {
            let h = ProcessHandle::open(p)?;
            let expected = query(name)?.exe;
            match (h.image(), expected) {
                (Some(img), Some(exe)) if same_path(&img, &exe) => Some((p, h)),
                (img, exe) => {
                    return Err(format!(
                        "行程 {p} 不是服務 {name} 的程式({img:?} ≠ {exe:?}),不處理"
                    ));
                }
            }
        }
        None => None,
    };
    match stop(name, timeout)? {
        StopOutcome::Stopped => Ok(()),
        StopOutcome::TimedOut => {
            let Some((p, h)) = held else {
                return Err(format!("等待服務 {name} 停止逾時"));
            };
            if query(name)?.pid != Some(p) {
                return Err(format!("服務 {name} 的 PID 已變更,不結束行程 {p}"));
            }
            // SAFETY:h 是握住的同一個行程
            if unsafe { TerminateProcess(h.0, 1) } == 0 {
                return Err(format!(
                    "無法結束行程 {p}:{}",
                    std::io::Error::last_os_error()
                ));
            }
            drop(h);
            let service = open(name, ServiceAccess::QUERY_STATUS)?
                .ok_or_else(|| format!("服務 {name} 不存在"))?;
            match wait_stopped(&service, name, Duration::from_secs(15))? {
                StopOutcome::Stopped => Ok(()),
                StopOutcome::TimedOut => Err(format!("結束行程後服務 {name} 仍未停止")),
            }
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 改回自動啟動(只改啟動類型,其他設定不變)
pub fn set_auto_start(name: &str) -> Result<(), String> {
    let name_w = wide(name);
    // SAFETY:Win32 服務 API;所有控制代碼在本函式內關閉,字串以 NUL 結尾且活到呼叫結束
    unsafe {
        let scm = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
        if scm.is_null() {
            return Err(format!(
                "無法連到服務控制管理員:{}",
                std::io::Error::last_os_error()
            ));
        }
        let svc = OpenServiceW(scm, name_w.as_ptr(), SERVICE_CHANGE_CONFIG);
        if svc.is_null() {
            let e = std::io::Error::last_os_error();
            CloseServiceHandle(scm);
            return Err(format!("無法開啟服務 {name}:{e}"));
        }
        let ok = ChangeServiceConfigW(
            svc,
            SERVICE_NO_CHANGE,
            SERVICE_AUTO_START,
            SERVICE_NO_CHANGE,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        );
        let e = std::io::Error::last_os_error();
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
        if ok == 0 {
            return Err(format!("無法改回自動啟動 {name}:{e}"));
        }
    }
    Ok(())
}

/// Windows 正在關機(關機時不把服務停止當成被人停止)
pub fn system_shutting_down() -> bool {
    // SAFETY:只讀系統計量
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

/// Windows Installer 執行中最多讓看守暫停多久(超過就恢復看守,避免被長時間佔住)
const INSTALLER_HOLD_MAX: Duration = Duration::from_secs(30 * 60);
/// 第一次看到 Installer 執行中的時間(Unix 秒;0 = 目前沒有)
static INSTALLER_SINCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// `Global\_MSIExecute` 存在且擁有者是 SYSTEM(一般使用者也能建立同名 mutex,擁有者會是他自己,不能採信)
fn msi_mutex_owned_by_system() -> bool {
    let name = wide(r"Global\_MSIExecute");
    // SAFETY:開啟既有的具名 mutex 只讀擁有者;控制代碼與安全性描述元在本函式內釋放
    unsafe {
        let h = OpenMutexW(SYNCHRONIZE | READ_CONTROL, 0, name.as_ptr());
        if h.is_null() {
            return false;
        }
        let mut owner: PSID = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let rc = GetSecurityInfo(
            h,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        );
        let system = rc == 0 && !owner.is_null() && IsWellKnownSid(owner, WinLocalSystemSid) != 0;
        if !sd.is_null() {
            LocalFree(sd as _);
        }
        CloseHandle(h);
        system
    }
}

/// `Global\_MSIExecute` 的狀態(Agent 軟體派送判斷 Windows Installer 是否忙碌,P7 L3)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsiMutex {
    /// 不存在(或打不開)
    Absent,
    /// 擁有者是 SYSTEM 或 Administrators:msiserver 以 SYSTEM 執行,SYSTEM 權杖的預設擁有者是 Administrators 群組
    Privileged,
    /// 其他擁有者(一般使用者自建的同名 mutex,不能採信)或讀不到擁有者
    Other,
}

/// 讀 `Global\_MSIExecute`:Windows Installer 執行安裝指令碼(含 deferred 自訂動作)期間由 msiserver 持有
pub fn msi_mutex() -> MsiMutex {
    let name = wide(r"Global\_MSIExecute");
    // SAFETY:開啟既有的具名 mutex 只讀擁有者;控制代碼與安全性描述元在本函式內釋放
    unsafe {
        let h = OpenMutexW(SYNCHRONIZE | READ_CONTROL, 0, name.as_ptr());
        if h.is_null() {
            return MsiMutex::Absent;
        }
        let mut owner: PSID = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let rc = GetSecurityInfo(
            h,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        );
        let privileged = rc == 0
            && !owner.is_null()
            && (IsWellKnownSid(owner, WinLocalSystemSid) != 0
                || IsWellKnownSid(owner, WinBuiltinAdministratorsSid) != 0);
        if !sd.is_null() {
            LocalFree(sd as _);
        }
        CloseHandle(h);
        if privileged {
            MsiMutex::Privileged
        } else {
            MsiMutex::Other
        }
    }
}

/// `msiserver` 服務執行中
pub fn msiserver_running() -> bool {
    query("msiserver").is_ok_and(|i| i.state == SvcState::Running)
}

/// Windows Installer 正在執行(安裝 / 升級 / 解除安裝監控 MSI 時會依序停止兩個服務,這時不重啟對方,避免檔案被占用)。
/// 必須同時:`Global\_MSIExecute` 的擁有者是 SYSTEM、`msiserver` 服務執行中;連續超過 30 分鐘視為異常,恢復看守
pub fn installer_running() -> bool {
    use std::sync::atomic::Ordering;
    let running = msi_mutex_owned_by_system()
        && query("msiserver").is_ok_and(|i| i.state == SvcState::Running);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if !running {
        INSTALLER_SINCE.store(0, Ordering::Relaxed);
        return false;
    }
    let since = match INSTALLER_SINCE.load(Ordering::Relaxed) {
        0 => {
            INSTALLER_SINCE.store(now, Ordering::Relaxed);
            now
        }
        s => s,
    };
    if now.saturating_sub(since) > INSTALLER_HOLD_MAX.as_secs() {
        log::warn!(
            "Windows Installer 已執行超過 {} 分鐘,恢復看守",
            INSTALLER_HOLD_MAX.as_secs() / 60
        );
        return false;
    }
    true
}

/// 不該看守的時候:Windows 關機中或 Windows Installer 執行中
pub fn hands_off() -> bool {
    system_shutting_down() || installer_running()
}

/// 目錄 ACL 只允許 SYSTEM、Administrators(不繼承上層;子項繼承)。Watchdog 開啟 `state\watchdog.db` 前套用:
/// 開發安裝沿用 ProgramData 預設 ACL 時,一般使用者不能預先放檔案讓 Watchdog 以裝置憑證送出
pub fn protect_dir(dir: &std::path::Path) -> Result<(), String> {
    let sddl = wide("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
    let path = wide(&dir.to_string_lossy());
    // SAFETY:SDDL 與路徑以 NUL 結尾;安全性描述元以 LocalFree 釋放;DACL 指標指向描述元內部,釋放前使用完畢
    unsafe {
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(format!(
                "目錄 ACL 格式錯誤:{}",
                std::io::Error::last_os_error()
            ));
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let got = GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted);
        let rc = if got != 0 {
            SetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null(),
            )
        } else {
            1
        };
        LocalFree(sd as _);
        if rc != 0 {
            return Err(format!("無法套用 {} 的 ACL(錯誤 {rc})", dir.display()));
        }
    }
    Ok(())
}

/// 目錄擁有者必須是 SYSTEM 或 Administrators:擁有者可以事後改回 ACL,一般使用者預先建立的目錄即使套了
/// [`protect_dir`] 也不可信(軟體派送的快取與 staging,P7-2 資安 M1)
pub fn owner_is_admin(dir: &std::path::Path) -> Result<(), String> {
    let path = wide(&dir.to_string_lossy());
    let mut owner: PSID = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY:路徑以 NUL 結尾;owner 指向 sd 內部,sd 以 LocalFree 釋放,釋放前使用完畢
    unsafe {
        let rc = GetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        );
        if rc != 0 {
            return Err(format!("無法讀取 {} 的擁有者(錯誤 {rc})", dir.display()));
        }
        let ok = !owner.is_null()
            && (IsWellKnownSid(owner, WinLocalSystemSid) != 0
                || IsWellKnownSid(owner, WinBuiltinAdministratorsSid) != 0);
        LocalFree(sd as _);
        if !ok {
            return Err(format!(
                "{} 的擁有者不是 SYSTEM 或 Administrators",
                dir.display()
            ));
        }
    }
    Ok(())
}

/// 寫入類權限:寫入 / 附加(目錄:新增檔案 / 子目錄)、刪除子項、刪除、改 ACL、改擁有者、GENERIC_WRITE / GENERIC_ALL
const WRITE_MASK: u32 =
    0x2 | 0x4 | 0x40 | 0x1_0000 | 0x4_0000 | 0x8_0000 | 0x4000_0000 | 0x1000_0000;
/// NT SERVICE\TrustedInstaller
const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

/// 一個檔案或目錄:擁有者與 DACL 中可寫入的對象都只能是 SYSTEM / Administrators / TrustedInstaller
fn admin_only_one(path: &std::path::Path, ti: PSID) -> Result<(), String> {
    let w = wide(&path.to_string_lossy());
    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let trusted = |sid: PSID| {
        // SAFETY:sid 指向有效的 SID(安全性描述元或 ACE 內部)
        unsafe {
            IsWellKnownSid(sid, WinLocalSystemSid) != 0
                || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
                || (!ti.is_null() && EqualSid(sid, ti) != 0)
        }
    };
    // SAFETY:路徑以 NUL 結尾;owner / dacl 指向 sd 內部,sd 以 LocalFree 釋放,釋放前使用完畢
    unsafe {
        let rc = GetNamedSecurityInfoW(
            w.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        );
        if rc != 0 {
            return Err(format!("無法讀取 {} 的權限(錯誤 {rc})", path.display()));
        }
        let result = if owner.is_null() || !trusted(owner) {
            Err(format!("{} 的擁有者不是系統管理帳號", path.display()))
        } else if dacl.is_null() {
            Err(format!("{} 沒有 DACL(所有人可寫)", path.display()))
        } else {
            let mut r = Ok(());
            for i in 0..(*dacl).AceCount as u32 {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                if GetAce(dacl, i, &mut ace) == 0 || ace.is_null() {
                    r = Err(format!("無法讀取 {} 的 ACE", path.display()));
                    break;
                }
                let header = &*(ace as *const ACE_HEADER);
                // 只繼承給子項的 ACE 不作用在本身;拒絕類 ACE 只會減少權限
                if header.AceFlags as u32 & INHERIT_ONLY_ACE != 0 || header.AceType == 1 {
                    continue;
                }
                if header.AceType != 0 {
                    r = Err(format!(
                        "{} 有無法判斷的 ACE 類型 {}",
                        path.display(),
                        header.AceType
                    ));
                    break;
                }
                let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
                let sid = &allowed.SidStart as *const u32 as PSID;
                if allowed.Mask & WRITE_MASK != 0 && !trusted(sid) {
                    r = Err(format!("{} 可被系統管理帳號以外的對象寫入", path.display()));
                    break;
                }
            }
            r
        };
        LocalFree(sd as _);
        result
    }
}

/// 檔案本身與上層每一層目錄(不含磁碟機根目錄:一般使用者在根目錄只能新增資料夾,換不掉既有路徑)
/// 都只有 SYSTEM / Administrators / TrustedInstaller 可寫入。Agent 以 SYSTEM 執行 Program Files 以外的移除程式前檢查(P7-2 資安 H1)
pub fn admin_only_writable(path: &std::path::Path) -> Result<(), String> {
    let sid = wide(TRUSTED_INSTALLER);
    let mut ti: PSID = std::ptr::null_mut();
    // SAFETY:字串以 NUL 結尾;成功時 ti 以 LocalFree 釋放
    let ok = unsafe { ConvertStringSidToSidW(sid.as_ptr(), &mut ti) } != 0;
    let mut result = Ok(());
    let mut cur = Some(path);
    while let Some(p) = cur {
        if p.parent().is_none() {
            break;
        }
        if let Err(e) = admin_only_one(p, if ok { ti } else { std::ptr::null_mut() }) {
            result = Err(e);
            break;
        }
        cur = p.parent();
    }
    if ok {
        // SAFETY:ConvertStringSidToSidW 配置
        unsafe { LocalFree(ti as _) };
    }
    result
}

/// 失敗復原:第 1、2、後續失敗分別 10 / 30 / 60 秒後重新啟動,1 天後重設;非當機失敗也套用(指南 §6.1)
pub fn configure_recovery(service: &Service) -> Result<(), windows_service::Error> {
    let restart = |secs| ServiceAction {
        action_type: ServiceActionType::Restart,
        delay: Duration::from_secs(secs),
    };
    service.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(24 * 3600)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![restart(10), restart(30), restart(60)]),
    })?;
    service.set_failure_actions_on_non_crash_failures(true)
}

/// 服務啟動時對自己套用失敗復原(LocalSystem 可修改自己的服務設定)
pub fn ensure_recovery(name: &str) -> Result<(), windows_service::Error> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    // 失敗復原含「重新啟動」動作時,除了 CHANGE_CONFIG 還需要 START 權限(ChangeServiceConfig2 SERVICE_CONFIG_FAILURE_ACTIONS)
    let service =
        manager.open_service(name, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)?;
    configure_recovery(&service)
}

/// 服務啟動時對自己套用 ACL(A5:一般使用者不能停止 / 啟動 / 改設定)
pub fn apply_service_acl(name: &str) -> Result<(), String> {
    let Some(service) = open(name, ServiceAccess::WRITE_DAC)? else {
        return Err(format!("服務 {name} 不存在"));
    };
    let sddl = wide(SERVICE_SDDL);
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY:SDDL 以 NUL 結尾;轉出的安全性描述元以 LocalFree 釋放;服務控制代碼由 windows-service 持有
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(format!(
                "服務 ACL 格式錯誤:{}",
                std::io::Error::last_os_error()
            ));
        }
        let ok = SetServiceObjectSecurity(service.raw_handle(), DACL_SECURITY_INFORMATION, sd);
        let e = std::io::Error::last_os_error();
        LocalFree(sd as _);
        if ok == 0 {
            return Err(format!("無法套用服務 ACL:{e}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_of_handles_quotes_and_args() {
        assert_eq!(
            exe_of(
                r#""C:\Program Files\GigaNexus\Agent\rustit-agent.exe" service --config "C:\ProgramData\GigaNexus\Agent\agent.toml""#
            ),
            Some(PathBuf::from(
                r"C:\Program Files\GigaNexus\Agent\rustit-agent.exe"
            ))
        );
        assert_eq!(
            exe_of(r"C:\Tools\rustit-agent.EXE service"),
            Some(PathBuf::from(r"C:\Tools\rustit-agent.EXE"))
        );
        assert_eq!(exe_of(""), None);
    }

    #[test]
    fn query_missing_service() {
        let info = query("GigaNexusDoesNotExist-Test").unwrap();
        assert_eq!(info.state, SvcState::Missing);
    }
}
