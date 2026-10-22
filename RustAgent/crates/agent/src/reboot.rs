//! 指令 `system.reboot`(P7-SOFTWARE-DESIGN §2.5、§5.5;契約 command-kinds.md)。
//!
//! - 參數:`delay_sec`(0–86400,預設 300)、`message`(1–200 字、單行、選填,安全文字規則同 `message.show`)、`force`(預設 false)
//! - 以 `InitiateSystemShutdownExW` 排程重新開機:倒數由 Windows 保存(Agent 重啟也照常進行),倒數期間系統顯示關機提示;
//!   另以 `WTSSendMessage` 送一則「【IT 部門通知】」訊息框(沒有登入者就不送)。`force = false` 時應用程式可拒絕關閉
//! - 只在服務模式執行(前景開發模式不重新開機開發機);與軟體派送串行(呼叫端持有串行鎖,安裝中不重開機)
//! - 排程成功即 `succeeded`(關機後無法再回報);主機以下次 `agent_started.boot_time` 變新判斷已重開機

use serde_json::{Value, json};

/// 預設倒數(給使用者儲存工作)
pub const DEFAULT_DELAY_SEC: u64 = 300;
pub const MAX_DELAY_SEC: u64 = 86_400;
const MESSAGE_MAX: usize = 200;
/// 與 message.show 相同的固定前綴(不可由操作人覆寫)
const PREFIX: &str = "【IT 部門通知】";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Params {
    pub delay_sec: u64,
    pub message: Option<String>,
    pub force: bool,
}

/// 控制字元與雙向文字控制字元(單行:換行也不允許)
fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// 參數已由主機驗證;版本差異或主機被繞過時仍檢查,不符回錯誤訊息(INVALID_PARAMS)
pub fn parse(p: &Value) -> Result<Params, String> {
    let delay_sec = match &p["delay_sec"] {
        Value::Null => DEFAULT_DELAY_SEC,
        v => v
            .as_u64()
            .filter(|d| *d <= MAX_DELAY_SEC)
            .ok_or_else(|| format!("delay_sec 需 0–{MAX_DELAY_SEC}"))?,
    };
    let message = match &p["message"] {
        Value::Null => None,
        Value::String(s)
            if !s.is_empty() && s.chars().count() <= MESSAGE_MAX && !s.chars().any(unsafe_char) =>
        {
            Some(s.clone())
        }
        _ => return Err(format!("message 需 1–{MESSAGE_MAX} 字、單行、不含控制字元")),
    };
    let force = match &p["force"] {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ => return Err("force 需 true / false".into()),
    };
    Ok(Params {
        delay_sec,
        message,
        force,
    })
}

/// 倒數的文字說明:「5 分鐘」「30 秒」「立即」
fn when(delay_sec: u64) -> String {
    match delay_sec {
        0 => "立即".into(),
        s if s % 60 == 0 => format!("於 {} 分鐘後", s / 60),
        s if s < 60 => format!("於 {s} 秒後"),
        s => format!("於 {} 分 {} 秒後", s / 60, s % 60),
    }
}

/// 提示內文:固定說明 + 操作人附加說明 + 發送人(標題另有固定前綴)
pub fn notice(p: &Params, issued_by: Option<&str>) -> (String, String) {
    let mut text = format!("電腦將{}重新開機,請先儲存工作。", when(p.delay_sec));
    if p.force {
        text.push_str("\n重新開機時未儲存的應用程式將被強制關閉。");
    }
    if let Some(m) = &p.message {
        text.push('\n');
        text.push_str(m);
    }
    if let Some(emp) = issued_by.filter(|e| !e.is_empty()) {
        text.push_str(&format!("\n\n(發送人:IT {emp})"));
    }
    (format!("{PREFIX}重新開機"), text)
}

pub fn result(p: &Params, notified: bool) -> Value {
    let at = chrono::Utc::now() + chrono::Duration::seconds(p.delay_sec as i64);
    json!({
        "scheduled_at": at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "delay_sec": p.delay_sec,
        "force": p.force,
        "notified": notified,
    })
}

/// 排程重新開機(阻塞):啟用 SeShutdownPrivilege → InitiateSystemShutdownExW(重新開機、計畫性、原因:應用程式 / 安裝)
#[cfg(windows)]
pub fn schedule(p: &Params, text: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LUID};
    use windows_sys::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED,
        TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Shutdown::{
        InitiateSystemShutdownExW, SHTDN_REASON_FLAG_PLANNED, SHTDN_REASON_MAJOR_APPLICATION,
        SHTDN_REASON_MINOR_INSTALLATION,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let name: Vec<u16> = "SeShutdownPrivilege"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY:目前行程的虛擬控制代碼;token 成功時以 CloseHandle 關閉
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
    } == 0
    {
        return Err(format!(
            "無法開啟行程權杖:{}",
            std::io::Error::last_os_error()
        ));
    }
    let mut luid = LUID::default();
    // SAFETY:name 以 NUL 結尾;tp 長度正確
    let adjusted = unsafe {
        let ok = LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid) != 0 && {
            let mut tp = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                ..Default::default()
            };
            tp.Privileges[0].Luid = luid;
            tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
            AdjustTokenPrivileges(
                token,
                0,
                &tp,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ) != 0
                // 沒有該權限時也回成功,以 GetLastError = ERROR_NOT_ALL_ASSIGNED(1300)區分
                && std::io::Error::last_os_error().raw_os_error() != Some(1300)
        };
        CloseHandle(token);
        ok
    };
    if !adjusted {
        return Err(format!(
            "無法啟用關機權限:{}",
            std::io::Error::last_os_error()
        ));
    }
    let msg: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY:msg 以 NUL 結尾;本機(lpMachineName = NULL)
    let ok = unsafe {
        InitiateSystemShutdownExW(
            std::ptr::null(),
            msg.as_ptr(),
            p.delay_sec as u32,
            p.force as i32,
            1,
            SHTDN_REASON_MAJOR_APPLICATION
                | SHTDN_REASON_MINOR_INSTALLATION
                | SHTDN_REASON_FLAG_PLANNED,
        )
    };
    if ok == 0 {
        let e = std::io::Error::last_os_error();
        let hint = match e.raw_os_error() {
            Some(1115) => "(系統已在關機中)",
            Some(1190) => "(已有排程的關機或重新開機)",
            _ => "",
        };
        return Err(format!("無法排程重新開機:{e}{hint}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params() {
        let p = parse(&json!({})).unwrap();
        assert_eq!(
            (p.delay_sec, p.message.as_deref(), p.force),
            (300, None, false)
        );
        let sample =
            parse(&json!({ "delay_sec": 0, "message": "安裝更新後需重新開機", "force": true }))
                .unwrap();
        assert_eq!((sample.delay_sec, sample.force), (0, true));
        assert!(parse(&json!({ "delay_sec": 86_401 })).is_err());
        assert!(parse(&json!({ "delay_sec": -1 })).is_err());
        assert!(parse(&json!({ "message": "" })).is_err());
        assert!(parse(&json!({ "message": "a\nb" })).is_err(), "單行");
        assert!(parse(&json!({ "message": "a\u{202E}b" })).is_err());
        assert!(parse(&json!({ "message": "字".repeat(201) })).is_err());
        assert!(
            parse(&json!({ "message": "字".repeat(200) })).is_ok(),
            "以字元計"
        );
        assert!(parse(&json!({ "force": "yes" })).is_err());
    }

    #[test]
    fn contract_sample_parses() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/contracts/examples/ws-command-system-reboot.sample.json"
        );
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let p = parse(&v["body"]["params"]).unwrap();
        assert_eq!((p.delay_sec, p.force), (300, false));
    }

    #[test]
    fn notice_text() {
        let p = Params {
            delay_sec: 300,
            message: Some("安裝更新後需重新開機".into()),
            force: false,
        };
        let (title, text) = notice(&p, Some("S000001"));
        assert_eq!(title, "【IT 部門通知】重新開機");
        assert_eq!(
            text,
            "電腦將於 5 分鐘後重新開機,請先儲存工作。\n安裝更新後需重新開機\n\n(發送人:IT S000001)"
        );
        let (_, text) = notice(
            &Params {
                delay_sec: 90,
                message: None,
                force: true,
            },
            None,
        );
        assert!(
            text.starts_with("電腦將於 1 分 30 秒後重新開機") && text.contains("強制關閉"),
            "{text}"
        );
        assert_eq!(when(0), "立即");
        assert_eq!(when(45), "於 45 秒後");
    }

    #[test]
    fn result_fields() {
        let r = result(
            &Params {
                delay_sec: 300,
                message: None,
                force: false,
            },
            true,
        );
        assert_eq!(
            (r["delay_sec"].as_u64(), r["notified"].as_bool()),
            (Some(300), Some(true))
        );
        assert!(chrono::DateTime::parse_from_rfc3339(r["scheduled_at"].as_str().unwrap()).is_ok());
    }
}
