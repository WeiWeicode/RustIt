//! 安裝程式的命令列與執行(P7-SOFTWARE-DESIGN §5.3、§5.6)。
//!
//! - 命令列由 Agent 依 `installer_type` 寫死,主機只給已驗過的額外參數([`super::args`]);
//!   一律 `CreateProcessW` 直接執行(指定程式路徑,不搜尋 PATH),**不經 cmd.exe / PowerShell**,不展開環境變數
//! - 行程以 `CREATE_SUSPENDED` 建立 → 放入 Job Object(`KILL_ON_JOB_CLOSE`)→ 才開始執行,子行程一律在同一個 Job 內:
//!   逾時時結束整個行程樹;主行程結束後再等 Job 內的子行程(安裝:剩餘逾時;移除:最多 [`DRAIN_MAX`])
//! - 服務在 session 0、`CREATE_NO_WINDOW`,安裝程式不可跳出需要使用者操作的視窗(靠靜默參數與逾時)

use super::Installer;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 移除時,主行程結束後等 Job 內其他行程(NSIS 自我複製的移除程式)的上限;超過就結束它們(記警告),由登錄檔偵測決定結果。
/// 安裝時改用剩餘逾時(自解壓縮的安裝程式會在子行程繼續安裝,不可提早結束)
pub const DRAIN_MAX: Duration = Duration::from_secs(300);

/// 要執行的程式與參數
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmdLine {
    pub program: PathBuf,
    pub args: String,
}

impl CmdLine {
    /// `CreateProcessW` 的命令列:`"<程式>" <參數>`
    pub fn command_line(&self) -> String {
        format!("\"{}\" {}", self.program.display(), self.args)
            .trim_end()
            .to_string()
    }
}

/// 執行結果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Code(u32),
    /// 超過逾時,已結束行程樹
    Timeout,
}

fn join(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 安裝命令列(§5.3);`log` 只用於 MSI(`/l*v`)
pub fn install_cmdline(
    kind: Installer,
    file: &Path,
    log: &Path,
    extra: &str,
    msiexec: &Path,
) -> CmdLine {
    let quoted = |p: &Path| format!("\"{}\"", p.display());
    match kind {
        Installer::Msi => CmdLine {
            program: msiexec.to_path_buf(),
            args: join(&[
                "/i",
                &quoted(file),
                "/qn /norestart /l*v",
                &quoted(log),
                extra,
            ]),
        },
        Installer::Inno => CmdLine {
            program: file.to_path_buf(),
            args: join(&["/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-", extra]),
        },
        Installer::Nsis => CmdLine {
            program: file.to_path_buf(),
            args: join(&["/S", extra]),
        },
        Installer::Burn => CmdLine {
            program: file.to_path_buf(),
            args: join(&["/quiet /norestart", extra]),
        },
        Installer::Exe => CmdLine {
            program: file.to_path_buf(),
            args: extra.to_string(),
        },
    }
}

/// 系統目錄的 msiexec.exe(`GetSystemDirectoryW`,不信任 PATH 與環境變數)
#[cfg(windows)]
pub fn msiexec_path() -> PathBuf {
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buf = [0u16; 260];
    // SAFETY:緩衝區長度以字元計
    let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    let dir = if n > 0 && n < buf.len() {
        PathBuf::from(String::from_utf16_lossy(&buf[..n]))
    } else {
        PathBuf::from(r"C:\Windows\System32")
    };
    dir.join("msiexec.exe")
}

/// 以 Job Object 執行(阻塞;呼叫端放在阻塞執行緒)
#[cfg(windows)]
pub fn run_job(cmd: &CmdLine, timeout: Duration, drain_max: Duration) -> Result<Exit, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess,
        PROCESS_INFORMATION, ResumeThread, STARTUPINFOW, TerminateProcess, WaitForSingleObject,
    };

    /// 結束時一定關閉(Job 關閉時 KILL_ON_JOB_CLOSE 結束仍在跑的行程)
    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY:由本函式取得的有效控制代碼,只關閉一次
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    // SAFETY:沒有名稱、預設安全性的 Job
    let job = Handle(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
    if job.0.is_null() {
        return Err(format!(
            "無法建立 Job Object:{}",
            std::io::Error::last_os_error()
        ));
    }
    let mut limit = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY:limit 活到呼叫結束,長度正確
    if unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limit as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(format!(
            "無法設定 Job Object:{}",
            std::io::Error::last_os_error()
        ));
    }

    let app: Vec<u16> = cmd
        .program
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // CreateProcessW 可能改寫命令列緩衝區,必須是可寫的
    let mut line: Vec<u16> = cmd
        .command_line()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let si = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut pi = PROCESS_INFORMATION::default();
    // SAFETY:緩衝區以 NUL 結尾並活到呼叫結束;不繼承控制代碼、沿用 Agent 的環境與目前目錄
    let ok = unsafe {
        CreateProcessW(
            app.as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            std::ptr::null(),
            std::ptr::null(),
            &si,
            &mut pi,
        )
    };
    if ok == 0 {
        return Err(format!(
            "無法啟動 {}:{}",
            cmd.program.display(),
            std::io::Error::last_os_error()
        ));
    }
    let process = Handle(pi.hProcess);
    let thread = Handle(pi.hThread);
    // 放進 Job 之後才開始執行:子行程不會在放入前就產生
    // SAFETY:兩個控制代碼都有效
    if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 {
        let e = std::io::Error::last_os_error();
        // SAFETY:行程仍暫停中,直接結束
        unsafe { TerminateProcess(process.0, 1) };
        return Err(format!("無法將安裝程式放入 Job Object:{e}"));
    }
    // SAFETY:執行緒控制代碼有效
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        let e = std::io::Error::last_os_error();
        // SAFETY:Job 控制代碼有效
        unsafe { TerminateJobObject(job.0, 1) };
        return Err(format!("無法開始執行安裝程式:{e}"));
    }
    drop(thread);

    let started = std::time::Instant::now();
    let ms = timeout.as_millis().min(u32::MAX as u128 - 1) as u32;
    // SAFETY:行程控制代碼有效
    let wait = unsafe { WaitForSingleObject(process.0, ms) };
    if wait == WAIT_TIMEOUT {
        // SAFETY:Job 控制代碼有效
        unsafe { TerminateJobObject(job.0, 1) };
        return Ok(Exit::Timeout);
    }
    if wait != WAIT_OBJECT_0 {
        // SAFETY:同上
        unsafe { TerminateJobObject(job.0, 1) };
        return Err(format!(
            "等待安裝程式失敗:{}",
            std::io::Error::last_os_error()
        ));
    }
    let mut code = 0u32;
    // SAFETY:行程已結束,控制代碼有效
    if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
        return Err(format!(
            "無法取得安裝程式的結束代碼:{}",
            std::io::Error::last_os_error()
        ));
    }

    // 主行程結束後:等 Job 內其他行程(自我複製的移除程式、子安裝程式)結束,不超過剩餘逾時與 DRAIN_MAX
    let drain = timeout.saturating_sub(started.elapsed()).min(drain_max);
    let deadline = std::time::Instant::now() + drain;
    loop {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY:info 長度正確
        let ok = unsafe {
            QueryInformationJobObject(
                job.0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || info.ActiveProcesses == 0 {
            break;
        }
        if std::time::Instant::now() >= deadline {
            log::warn!(
                "{} 已結束,但仍有 {} 個子行程在執行,結束它們",
                cmd.program.display(),
                info.ActiveProcesses
            );
            // SAFETY:Job 控制代碼有效
            unsafe { TerminateJobObject(job.0, 1) };
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Ok(Exit::Code(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_lines_are_fixed_per_type() {
        let file =
            Path::new(r"C:\ProgramData\GigaNexus\Agent\cache\software\staging\c1\installer.msi");
        let log = Path::new(r"C:\ProgramData\GigaNexus\Agent\logs\software\c1.log");
        let msiexec = Path::new(r"C:\Windows\System32\msiexec.exe");
        let msi = install_cmdline(Installer::Msi, file, log, "ALLUSERS=1", msiexec);
        assert_eq!(msi.program, msiexec);
        assert_eq!(
            msi.command_line(),
            format!(
                "\"{}\" /i \"{}\" /qn /norestart /l*v \"{}\" ALLUSERS=1",
                msiexec.display(),
                file.display(),
                log.display()
            )
        );
        let exe = Path::new(r"C:\x\installer.exe");
        assert_eq!(
            install_cmdline(Installer::Inno, exe, log, "", msiexec).command_line(),
            "\"C:\\x\\installer.exe\" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-"
        );
        assert_eq!(
            install_cmdline(Installer::Nsis, exe, log, "/D=C:/Program Files/A", msiexec).args,
            "/S /D=C:/Program Files/A"
        );
        assert_eq!(
            install_cmdline(Installer::Burn, exe, log, "", msiexec).args,
            "/quiet /norestart"
        );
        let plain = install_cmdline(Installer::Exe, exe, log, "", msiexec);
        assert_eq!(
            (plain.args.as_str(), plain.command_line().as_str()),
            ("", "\"C:\\x\\installer.exe\"")
        );
    }

    #[cfg(windows)]
    #[test]
    fn runs_in_job_and_returns_exit_code() {
        let system = msiexec_path().parent().unwrap().to_path_buf();
        // where.exe 找不到檔案時結束代碼 1,不需要網路或系統管理員
        let cmd = CmdLine {
            program: system.join("where.exe"),
            args: "/Q rustit-no-such-file-xyz".into(),
        };
        assert_eq!(
            run_job(&cmd, Duration::from_secs(30), DRAIN_MAX).unwrap(),
            Exit::Code(1)
        );
        let missing = CmdLine {
            program: system.join("rustit-missing.exe"),
            args: String::new(),
        };
        assert!(run_job(&missing, Duration::from_secs(5), DRAIN_MAX).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn timeout_kills_process_tree() {
        let system = msiexec_path().parent().unwrap().to_path_buf();
        // ping 本機 30 次約 30 秒
        let cmd = CmdLine {
            program: system.join("PING.EXE"),
            args: "-n 30 127.0.0.1".into(),
        };
        let started = std::time::Instant::now();
        assert_eq!(
            run_job(&cmd, Duration::from_secs(1), DRAIN_MAX).unwrap(),
            Exit::Timeout
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
