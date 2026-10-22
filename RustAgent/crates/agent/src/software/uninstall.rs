//! 移除命令(P7-SOFTWARE-DESIGN §5.1 `uninstall.rs`;移植 demo `deploy.rs` 的 `uninstall_command` / `split_command`)。
//!
//! 來源只有整台電腦的 Uninstall 項目(HKLM;HKCU 可被一般使用者寫入,不讀,見 collector `machine_uninstall_entries`):
//! - MSI(`WindowsInstaller = 1`、`installer_type = msi`,或移除字串是 msiexec):`msiexec.exe /x {產品代碼} /qn /norestart /l*v <記錄> <uninstall_args>`;
//!   產品代碼取子機碼名稱,不是 GUID 時從移除字串取 `{…}`,都必須是 GUID 格式
//! - 其他:`QuietUninstallString` 優先;沒有時 `UninstallString` + 目錄的 `uninstall_args`(兩者都要有,沒有靜默參數的移除程式會在 session 0 卡住)
//! - 程式必須是絕對路徑的 `.exe` 且存在;**不經 `cmd /c`、不展開 `%`**(含 `%` 一律不支援)、不接受殼層類程式(cmd、PowerShell、腳本主機、rundll32 等)

use super::args::is_guid;
use super::install::CmdLine;
use super::{Failure, Installer, fail};
use rustit_collector::UninstallEntry;
use std::path::{Path, PathBuf};

/// 不接受作為移除程式的殼層與腳本主機(可執行任意指令)
const SHELLS: [&str; 10] = [
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "wscript.exe",
    "cscript.exe",
    "mshta.exe",
    "rundll32.exe",
    "regsvr32.exe",
    "msbuild.exe",
    "conhost.exe",
];

/// `"C:\a b\x.exe" /foo` 或 `C:\a\x.exe /foo` → (程式, 其餘參數)
pub fn split_command(cmd: &str) -> Option<(PathBuf, String)> {
    let cmd = cmd.trim();
    if let Some(rest) = cmd.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some((
            PathBuf::from(&rest[..end]),
            rest[end + 1..].trim().to_string(),
        ));
    }
    let end = cmd.to_lowercase().find(".exe").map(|i| i + 4)?;
    Some((PathBuf::from(&cmd[..end]), cmd[end..].trim().to_string()))
}

fn product_code(e: &UninstallEntry) -> Option<String> {
    if is_guid(&e.key) {
        return Some(e.key.clone());
    }
    let s = &e.uninstall_string;
    let start = s.find('{')?;
    let end = s[start..].find('}')? + start;
    let code = &s[start..=end];
    is_guid(code).then(|| code.to_string())
}

fn not_supported(msg: impl Into<String>) -> Failure {
    fail("UNINSTALL_NOT_SUPPORTED", msg)
}

/// 決定移除命令;`exists` 檢查程式檔(測試注入)
pub fn uninstall_cmdline(
    e: &UninstallEntry,
    kind: Installer,
    extra: &str,
    log: &Path,
    msiexec: &Path,
    exists: impl Fn(&Path) -> bool,
) -> Result<CmdLine, Failure> {
    let msi_string = e.uninstall_string.to_lowercase().contains("msiexec");
    if e.windows_installer || kind == Installer::Msi || msi_string {
        if let Some(code) = product_code(e) {
            let mut args = format!("/x {code} /qn /norestart /l*v \"{}\"", log.display());
            if !extra.is_empty() {
                args = format!("{args} {extra}");
            }
            return Ok(CmdLine {
                program: msiexec.to_path_buf(),
                args,
            });
        }
        if msi_string {
            return Err(not_supported("MSI 移除字串沒有有效的產品代碼"));
        }
    }
    let (raw, quiet) = if !e.quiet_uninstall_string.is_empty() {
        (e.quiet_uninstall_string.as_str(), true)
    } else if !e.uninstall_string.is_empty() && !extra.is_empty() {
        (e.uninstall_string.as_str(), false)
    } else if e.uninstall_string.is_empty() {
        return Err(not_supported("登錄檔沒有移除指令"));
    } else {
        return Err(not_supported(
            "只有 UninstallString、目錄沒有靜默移除參數(uninstall_args),無法靜默移除",
        ));
    };
    if raw.contains('%') {
        return Err(not_supported("移除指令含環境變數(%),Agent 不展開"));
    }
    let (program, rest) =
        split_command(raw).ok_or_else(|| not_supported("無法解析移除指令的程式路徑"))?;
    let name = program
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let absolute = program.to_string_lossy().as_bytes().get(1..3) == Some(b":\\");
    if !absolute || !name.ends_with(".exe") || SHELLS.contains(&name.as_str()) {
        return Err(not_supported(format!(
            "不支援的移除程式 {}(必須是絕對路徑的 .exe,不可為殼層或腳本主機)",
            program.display()
        )));
    }
    if !exists(&program) {
        return Err(not_supported(format!(
            "移除程式 {} 不存在",
            program.display()
        )));
    }
    let args = if quiet || extra.is_empty() {
        rest
    } else {
        format!("{rest} {extra}").trim().to_string()
    };
    Ok(CmdLine { program, args })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, uninstall: &str, quiet: &str, msi: bool) -> UninstallEntry {
        UninstallEntry {
            key: key.into(),
            name: "App".into(),
            uninstall_string: uninstall.into(),
            quiet_uninstall_string: quiet.into(),
            windows_installer: msi,
            ..Default::default()
        }
    }

    const LOG: &str = r"C:\ProgramData\GigaNexus\Agent\logs\software\c1.log";
    const MSIEXEC: &str = r"C:\Windows\System32\msiexec.exe";

    fn plan(e: &UninstallEntry, kind: Installer, extra: &str) -> Result<CmdLine, Failure> {
        uninstall_cmdline(e, kind, extra, Path::new(LOG), Path::new(MSIEXEC), |_| true)
    }

    #[test]
    fn splits_registry_commands() {
        let (exe, args) =
            split_command(r#""C:\Program Files\Mozilla Firefox\uninstall\helper.exe" /foo"#)
                .unwrap();
        assert_eq!(
            exe,
            PathBuf::from(r"C:\Program Files\Mozilla Firefox\uninstall\helper.exe")
        );
        assert_eq!(args, "/foo");
        let (exe, args) = split_command(r"C:\Program Files\WinRAR\uninstall.exe").unwrap();
        assert_eq!(exe, PathBuf::from(r"C:\Program Files\WinRAR\uninstall.exe"));
        assert_eq!(args, "");
    }

    #[test]
    fn msi_uses_product_code() {
        let code = "{23170F69-40C1-2702-2409-000001000000}";
        let e = entry(code, &format!("MsiExec.exe /I{code}"), "", true);
        let c = plan(&e, Installer::Msi, "").unwrap();
        assert_eq!(c.program, PathBuf::from(MSIEXEC));
        assert_eq!(c.args, format!("/x {code} /qn /norestart /l*v \"{LOG}\""));
        // 子機碼不是 GUID 時從移除字串取
        let e = entry("SomeApp", &format!("MsiExec.exe /X{code}"), "", false);
        assert!(
            plan(&e, Installer::Exe, "")
                .unwrap()
                .args
                .starts_with(&format!("/x {code} "))
        );
        let e = entry("SomeApp", "MsiExec.exe /X{bad}", "", false);
        assert_eq!(
            plan(&e, Installer::Exe, "").unwrap_err().code,
            "UNINSTALL_NOT_SUPPORTED"
        );
    }

    #[test]
    fn exe_prefers_quiet_string() {
        let e = entry(
            "Notepad++",
            r#""C:\Program Files\Notepad++\uninstall.exe""#,
            r#""C:\Program Files\Notepad++\uninstall.exe" /S"#,
            false,
        );
        let c = plan(&e, Installer::Nsis, "/S").unwrap();
        assert_eq!(
            c.program,
            PathBuf::from(r"C:\Program Files\Notepad++\uninstall.exe")
        );
        assert_eq!(c.args, "/S", "Quiet 字串不再加 uninstall_args");
        let e = entry("A", r#""C:\Program Files\A\unins000.exe""#, "", false);
        assert_eq!(
            plan(&e, Installer::Inno, "/VERYSILENT").unwrap().args,
            "/VERYSILENT"
        );
        assert_eq!(
            plan(&e, Installer::Inno, "").unwrap_err().code,
            "UNINSTALL_NOT_SUPPORTED",
            "沒有靜默參數"
        );
    }

    #[test]
    fn rejects_unsafe_commands() {
        for raw in [
            r"cmd.exe /c del C:\x",
            r#""C:\Windows\System32\cmd.exe" /c x"#,
            r"%ProgramFiles%\A\uninstall.exe /S",
            r#""C:\Windows\System32\rundll32.exe" x.dll,Uninstall"#,
            r"uninstall.exe /S",
            r#""C:\Program Files\A\uninstall.bat""#,
        ] {
            let e = entry("A", "", raw, false);
            assert_eq!(
                plan(&e, Installer::Exe, "").unwrap_err().code,
                "UNINSTALL_NOT_SUPPORTED",
                "{raw}"
            );
        }
        let e = entry("A", "", "", false);
        assert_eq!(
            plan(&e, Installer::Exe, "/S").unwrap_err().code,
            "UNINSTALL_NOT_SUPPORTED"
        );
        let e = entry("A", "", r#""C:\Program Files\A\u.exe" /S"#, false);
        let missing = uninstall_cmdline(
            &e,
            Installer::Exe,
            "",
            Path::new(LOG),
            Path::new(MSIEXEC),
            |_| false,
        );
        assert_eq!(missing.unwrap_err().code, "UNINSTALL_NOT_SUPPORTED");
    }
}
