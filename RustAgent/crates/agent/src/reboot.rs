//! 指令 `system.reboot`(P7-SOFTWARE-DESIGN §2.5、§5.5;契約 command-kinds.md)。
//!
//! - 參數:`delay_sec`(0–86400,預設 300)、`message`(1–200 字、單行、選填,安全文字規則同 `message.show`)、`force`(預設 false)
//! - 以 `InitiateSystemShutdownExW` 排程重新開機:倒數由 Windows 保存(Agent 重啟也照常進行),倒數期間系統顯示關機提示;
//!   另以 `WTSSendMessage` 送一則「【IT 部門通知】」訊息框(沒有登入者就不送)。`force = false` 時應用程式可拒絕關閉
//! - 只在服務模式執行(前景開發模式不重新開機開發機);與軟體派送串行(呼叫端持有串行鎖,安裝中不重開機)
//! - 排程成功即 `succeeded`(關機後無法再回報);主機以下次 `agent_started.boot_time` 變新判斷已重開機
//! - **本機上限**(不靠主機,資安 P7-3 H1,需求方 2026-10-22 決定):開機未滿 30 分鐘不接受;24 小時內最多排程 3 次
//!   (取消的也算);有人登入時倒數至少 60 秒(`force` 也一樣)。超過回 `REBOOT_LIMITED`
//! - **倒數中**(資安 M1):排程後到重新開機前(開機時間變新,或倒數 + 5 分鐘仍未重開機),`software.*`、`agent.upgrade`、
//!   `agent.restart` 回 `REBOOT_PENDING`,不在重開機前開始會被中斷的工作
//! - `system.reboot.cancel`(資安 M2):`AbortSystemShutdownW` 取消倒數並清除倒數旗標

use serde_json::{Value, json};

/// 預設倒數(給使用者儲存工作)
pub const DEFAULT_DELAY_SEC: u64 = 300;
pub const MAX_DELAY_SEC: u64 = 86_400;
const MESSAGE_MAX: usize = 200;
/// 與 message.show 相同的固定前綴(不可由操作人覆寫)
const PREFIX: &str = "【IT 部門通知】";

/// 開機後多久內不接受重新開機(避免開機即重開的循環)
pub const MIN_UPTIME_SEC: u64 = 30 * 60;
/// 24 小時內最多排程幾次
pub const MAX_PER_DAY: usize = 3;
const DAY_SEC: i64 = 24 * 3600;
/// 有人登入時的最短倒數
pub const MIN_DELAY_WITH_USER: u64 = 60;
/// 倒數結束後多久仍視為「重開機中」(應用程式拒絕關閉等情況,之後自動解除)
pub const PENDING_GRACE_SEC: i64 = 300;

/// 本機上限檢查:回傳不允許的原因。`history` 為過去排程的 Unix 秒
pub fn limit_error(now: i64, boot: u64, history: &[i64]) -> Option<String> {
    let uptime = now.saturating_sub(boot as i64).max(0) as u64;
    if uptime < MIN_UPTIME_SEC {
        return Some(format!(
            "開機未滿 {} 分鐘(已開機 {} 分鐘),不接受重新開機",
            MIN_UPTIME_SEC / 60,
            uptime / 60
        ));
    }
    let recent = history.iter().filter(|t| now - **t < DAY_SEC).count();
    if recent >= MAX_PER_DAY {
        return Some(format!(
            "24 小時內已排程 {recent} 次重新開機,達本機上限 {MAX_PER_DAY} 次"
        ));
    }
    None
}

/// 只留 24 小時內的紀錄,加上這一次
pub fn record(now: i64, history: &[i64]) -> Vec<i64> {
    let mut h: Vec<i64> = history
        .iter()
        .copied()
        .filter(|t| now - *t < DAY_SEC)
        .collect();
    h.push(now);
    h
}

/// 有人登入時倒數至少 [`MIN_DELAY_WITH_USER`] 秒
pub fn effective_delay(delay: u64, user_present: bool) -> u64 {
    if user_present {
        delay.max(MIN_DELAY_WITH_USER)
    } else {
        delay
    }
}

/// 倒數旗標(本機 kv):排程時間與失效時間(Unix 秒)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Pending {
    pub scheduled_at: i64,
    pub until: i64,
}

impl Pending {
    pub fn new(now: i64, delay_sec: u64) -> Self {
        Self {
            scheduled_at: now,
            until: now + delay_sec as i64 + PENDING_GRACE_SEC,
        }
    }

    /// 仍在倒數中:未過失效時間,且排程之後沒有重新開機過
    pub fn active(&self, now: i64, boot: u64) -> bool {
        now < self.until && (boot as i64) < self.scheduled_at
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Params {
    pub delay_sec: u64,
    pub message: Option<String>,
    pub force: bool,
}

/// 控制字元與雙向文字控制字元(與 message.show 同一套規則;單行,換行也不允許)
fn unsafe_char(c: char) -> bool {
    crate::command::unsafe_char(c, false)
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
            if !s.trim().is_empty()
                && s.chars().count() <= MESSAGE_MAX
                && !s.chars().any(unsafe_char) =>
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
    if let Some(emp) = crate::command::sender_label(issued_by) {
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

/// 呼叫期間啟用 SeShutdownPrivilege,結束後還原為停用(P7-3 未處理項目;還原失敗只記警告)
#[cfg(windows)]
fn with_shutdown_privilege<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    shutdown_privilege(true)?;
    let r = f();
    if let Err(e) = shutdown_privilege(false) {
        log::warn!("無法還原關機權限:{e}");
    }
    r
}

/// 啟用 / 停用本行程權杖的 SeShutdownPrivilege(SYSTEM 有此權限但預設停用)
#[cfg(windows)]
fn shutdown_privilege(enable: bool) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LUID};
    use windows_sys::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED,
        TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
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
    let adjusted: Result<(), std::io::Error> = unsafe {
        let ok = LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid) != 0 && {
            let mut tp = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                ..Default::default()
            };
            tp.Privileges[0].Luid = luid;
            tp.Privileges[0].Attributes = if enable { SE_PRIVILEGE_ENABLED } else { 0 };
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
        // 錯誤碼在 CloseHandle 之前取得
        let r = if ok {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        };
        CloseHandle(token);
        r
    };
    if let Err(e) = adjusted {
        let hint = if e.raw_os_error() == Some(1300) {
            "(帳戶沒有 SeShutdownPrivilege)"
        } else {
            ""
        };
        return Err(format!("無法調整關機權限:{e}{hint}"));
    }
    Ok(())
}

/// 排程重新開機(阻塞):啟用 SeShutdownPrivilege → InitiateSystemShutdownExW(重新開機、計畫性、原因:其他)
#[cfg(windows)]
pub fn schedule(p: &Params, text: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Shutdown::{
        InitiateSystemShutdownExW, SHTDN_REASON_FLAG_PLANNED, SHTDN_REASON_MAJOR_OTHER,
        SHTDN_REASON_MINOR_OTHER,
    };
    let msg: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let err = with_shutdown_privilege(|| {
        // SAFETY:msg 以 NUL 結尾;本機(lpMachineName = NULL)
        let ok = unsafe {
            InitiateSystemShutdownExW(
                std::ptr::null(),
                msg.as_ptr(),
                p.delay_sec as u32,
                p.force as i32,
                1,
                // 事件 1074 的原因:IT 遠端指令的計畫性重開機(不記成「應用程式安裝」,稽核時才不會誤判)
                SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_MINOR_OTHER | SHTDN_REASON_FLAG_PLANNED,
            )
        };
        // 錯誤碼在還原權限之前取得
        Ok((ok == 0).then(std::io::Error::last_os_error))
    })?;
    if let Some(e) = err {
        let hint = match e.raw_os_error() {
            Some(1115) => "(系統已在關機中)",
            Some(1190) => "(已有排程的關機或重新開機)",
            _ => "",
        };
        return Err(format!("無法排程重新開機:{e}{hint}"));
    }
    Ok(())
}

/// 取消倒數中的重新開機(阻塞);回傳是否真的取消了(沒有進行中的關機回 false)
#[cfg(windows)]
pub fn abort() -> Result<bool, String> {
    use windows_sys::Win32::System::Shutdown::AbortSystemShutdownW;
    // SAFETY:本機(NULL);錯誤碼在還原權限之前取得
    let err = with_shutdown_privilege(|| {
        Ok((unsafe { AbortSystemShutdownW(std::ptr::null()) } == 0)
            .then(std::io::Error::last_os_error))
    })?;
    let Some(e) = err else {
        return Ok(true);
    };
    match e.raw_os_error() {
        // ERROR_NO_SHUTDOWN_IN_PROGRESS
        Some(1116) => Ok(false),
        _ => Err(format!("無法取消重新開機:{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_limits() {
        let now = 1_800_000_000;
        let boot = (now - 3600) as u64;
        assert!(limit_error(now, boot, &[]).is_none());
        assert!(
            limit_error(now, (now - 600) as u64, &[])
                .unwrap()
                .contains("開機未滿")
        );
        let three = [now - 100, now - 200, now - 300];
        assert!(limit_error(now, boot, &three).unwrap().contains("上限"));
        let old = [now - DAY_SEC - 1, now - 200, now - 300];
        assert!(limit_error(now, boot, &old).is_none(), "超過 24 小時的不算");
        assert_eq!(record(now, &old), vec![now - 200, now - 300, now]);
        assert_eq!(effective_delay(0, true), 60);
        assert_eq!(effective_delay(0, false), 0);
        assert_eq!(effective_delay(300, true), 300);
    }

    #[test]
    fn pending_flag() {
        let now = 1_800_000_000;
        let p = Pending::new(now, 300);
        assert!(p.active(now + 10, (now - 3600) as u64));
        assert!(!p.active(now + 10, (now + 5) as u64), "已重開機");
        assert!(
            !p.active(now + 300 + PENDING_GRACE_SEC, (now - 3600) as u64),
            "倒數 + 5 分鐘後自動解除"
        );
    }

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
        assert!(parse(&json!({ "message": "   " })).is_err(), "只有空白");
        for c in ['\u{2028}', '\u{200B}', '\u{FEFF}', '\u{061C}', '\u{E0041}'] {
            assert!(
                parse(&json!({ "message": format!("a{c}b") })).is_err(),
                "{:04X}",
                c as u32
            );
        }
    }

    #[test]
    fn sender_is_validated() {
        let p = parse(&json!({})).unwrap();
        for bad in ["S1\n惡意", "S1\u{202E}", "", &"S".repeat(17)] {
            let (_, text) = notice(&p, Some(bad));
            assert!(!text.contains("發送人"), "{bad:?} 不顯示");
        }
        assert!(
            notice(&p, Some("S112009"))
                .1
                .ends_with("(發送人:IT S112009)")
        );
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
