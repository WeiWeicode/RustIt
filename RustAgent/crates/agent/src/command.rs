//! 指令執行器(PLATFORM-PLAN P4 §4.4;ENDPOINT-AGENT-GUIDE §8.4;類型 `docs/contracts/command-kinds.md`)。
//!
//! - **只執行固定類型**,不提供任意 shell;不認得的 `kind` 回 `failed UNSUPPORTED_COMMAND`。
//! - 以 `command_id` 去重(本機 `command_log`,重開機後仍有效):重複收到不重跑,重送最後狀態。
//! - 收到時已超過 `expires_at`(以 `hello_ack.clock_skew_ms` 換算主機時間)回 `failed EXPIRED`,不執行。
//! - 每則 `command_update` **先寫本機**再通知 WebSocket 送出;主機回 `command_update_ack` 才標記已回報,斷線則重連後重送。
//! - 會改變系統的類型(目前 `agent.restart`)取得同一把串行鎖;查詢類並行。
//! - `agent.restart`:記下指令後以服務專屬結束代碼停止,由服務失敗復原重新啟動;啟動後回 `succeeded`。前景模式不支援。
//! - `message.show`:使用者端程式(P8)尚未存在,一律 `WTSSendMessage` 送到主控台工作階段,不等待使用者按下。

use crate::Shared;
use crate::protocol::{CommandBody, CommandUpdate, now_rfc3339};
use log::{error, info, warn};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::sync::oneshot;

/// 本版支援的類型(與 command-kinds.md 一致)
pub const KINDS: [&str; 3] = ["inventory.collect", "agent.restart", "message.show"];
/// kv:執行中的 agent.restart 指令(重新啟動後回報 succeeded)
const RESTART_KEY: &str = "restart_command";
/// 已回報的指令紀錄保留天數(大於最長有效期限 1 天,才能去重)
pub const COMMAND_LOG_DAYS: i64 = 7;
/// 訊息框標題固定前綴(不可由操作人覆寫,避免偽裝成系統或其他程式的對話框)
const TITLE_PREFIX: &str = "【IT 部門通知】";
/// message.show 內文最多行數(與主機相同)
const MESSAGE_MAX_LINES: usize = 30;

/// 指令失敗(錯誤代碼見 command-kinds.md)
struct Failure {
    code: &'static str,
    message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
    }
}

/// 寫入本機並通知 WebSocket 送出
fn report(shared: &Shared, id: &str, state: &str, fill: impl FnOnce(&mut CommandUpdate)) {
    let mut u = CommandUpdate {
        command_id: id.to_string(),
        state: state.to_string(),
        progress: None,
        result: None,
        error_code: None,
        error_message: None,
        occurred_at: now_rfc3339(),
    };
    fill(&mut u);
    let saved = serde_json::to_value(&u)
        .map_err(|e| e.to_string())
        .and_then(|v| {
            shared
                .store
                .lock()
                .command_save(id, state, &v, &u.occurred_at)
        });
    match saved {
        Ok(()) => shared.command_notify.notify_one(),
        Err(e) => error!("無法保存指令 {id} 的狀態 {state}:{e}"),
    }
}

fn report_failure(shared: &Shared, id: &str, f: Failure) {
    warn!("指令 {id} 失敗:{} {}", f.code, f.message);
    report(shared, id, "failed", |u| {
        u.error_code = Some(f.code.to_string());
        u.error_message = Some(f.message);
    });
}

/// 啟動時:上次執行的 agent.restart 回報成功;其他執行到一半的指令(Agent 中途被結束)回報失敗;清除舊紀錄
pub fn recover(shared: &Shared) {
    let (restart, unfinished) = {
        let store = shared.store.lock();
        let restart = store
            .get(RESTART_KEY)
            .ok()
            .flatten()
            .filter(|v| !v.is_empty());
        if restart.is_some()
            && let Err(e) = store.set(RESTART_KEY, "")
        {
            warn!("無法清除重新啟動紀錄:{e}");
        }
        let before = (chrono::Utc::now() - chrono::Duration::days(COMMAND_LOG_DAYS))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        if let Err(e) = store.purge_command_log(&before) {
            warn!("無法清除舊的指令紀錄:{e}");
        }
        (restart, store.command_unfinished().unwrap_or_default())
    };
    for id in unfinished {
        if restart.as_deref() == Some(id.as_str()) {
            info!("已依指令 {id} 重新啟動");
            report(shared, &id, "succeeded", |u| {
                u.progress = Some(100);
                u.result = Some(json!({ "restarted_at": now_rfc3339() }));
            });
        } else {
            report_failure(
                shared,
                &id,
                fail("EXECUTION_FAILED", "Agent 在執行期間停止,未完成"),
            );
        }
    }
}

/// WebSocket 收到 `command`:在背景執行,不阻塞 WebSocket 迴圈
pub fn dispatch(shared: Arc<Shared>, cmd: CommandBody) {
    tokio::spawn(async move { execute(shared, cmd).await });
}

async fn execute(shared: Arc<Shared>, cmd: CommandBody) {
    let id = cmd.command_id.to_lowercase();
    let first = shared
        .store
        .lock()
        .command_begin(&id, &cmd.kind, &now_rfc3339());
    match first {
        Err(e) => {
            // 無法去重就不執行(避免重複執行);主機逾時後設為 failed
            error!("無法記錄指令 {id}({}),不執行:{e}", cmd.kind);
            return;
        }
        Ok(false) => {
            // 至少送達一次的重送:不重跑,重送最後狀態
            let last = shared.store.lock().command_last_update(&id).ok().flatten();
            info!("重複收到指令 {id}({}),不重新執行", cmd.kind);
            if let Some(v) = last {
                let state = v["state"].as_str().unwrap_or("acked").to_string();
                if let Err(e) = shared
                    .store
                    .lock()
                    .command_save(&id, &state, &v, &now_rfc3339())
                {
                    warn!("無法重送指令 {id} 的狀態:{e}");
                }
                shared.command_notify.notify_one();
            }
            return;
        }
        Ok(true) => {}
    }
    info!(
        "收到指令 {id}:{}(操作人 {})",
        cmd.kind,
        cmd.issued_by.as_deref().unwrap_or("-")
    );
    match expired(&shared, &cmd.expires_at) {
        Err(f) => return report_failure(&shared, &id, f),
        Ok(true) => {
            return report_failure(&shared, &id, fail("EXPIRED", "收到時已超過有效期限,不執行"));
        }
        Ok(false) => {}
    }
    if !KINDS.contains(&cmd.kind.as_str()) {
        return report_failure(
            &shared,
            &id,
            fail(
                "UNSUPPORTED_COMMAND",
                format!("此版本 Agent 不支援 {}", cmd.kind),
            ),
        );
    }
    report(&shared, &id, "acked", |_| {});
    let outcome = match cmd.kind.as_str() {
        "inventory.collect" => {
            report(&shared, &id, "running", |_| {});
            inventory_collect(&shared).await
        }
        "message.show" => {
            report(&shared, &id, "running", |_| {});
            message_show(&cmd.params, cmd.issued_by.as_deref()).await
        }
        "agent.restart" => return agent_restart(&shared, &id).await,
        _ => Err(fail("UNSUPPORTED_COMMAND", cmd.kind.clone())),
    };
    match outcome {
        Ok(result) => {
            info!("指令 {id}({})完成", cmd.kind);
            report(&shared, &id, "succeeded", |u| {
                u.progress = Some(100);
                u.result = Some(result);
            })
        }
        Err(f) => report_failure(&shared, &id, f),
    }
}

/// expires_at 是主機時間;本機時間 − 偏差 = 主機時間
fn expired(shared: &Shared, expires_at: &str) -> Result<bool, Failure> {
    let exp = chrono::DateTime::parse_from_rfc3339(expires_at).map_err(|_| {
        fail(
            "INVALID_PARAMS",
            format!("expires_at 無法解析:{expires_at}"),
        )
    })?;
    let skew = chrono::Duration::milliseconds(shared.clock_skew_ms.load(Ordering::Relaxed));
    Ok(chrono::Utc::now() - skew >= exp)
}

async fn inventory_collect(shared: &Shared) -> Result<Value, Failure> {
    let (tx, rx) = oneshot::channel();
    shared
        .collect_now
        .send(tx)
        .await
        .map_err(|_| fail("EXECUTION_FAILED", "資產回報工作已停止"))?;
    rx.await
        .map_err(|_| fail("EXECUTION_FAILED", "資產回報工作已停止"))?
        .map_err(|e| fail("EXECUTION_FAILED", e))
}

async fn agent_restart(shared: &Shared, id: &str) {
    if !crate::SERVICE_MODE.load(Ordering::Relaxed) {
        return report_failure(
            shared,
            id,
            fail(
                "NOT_RUNNING_AS_SERVICE",
                "前景模式沒有服務失敗復原,無法重新啟動",
            ),
        );
    }
    // 會改變系統的指令串行;持有到行程結束
    let _guard = shared.exclusive.lock().await;
    report(shared, id, "running", |_| {});
    if let Err(e) = shared.store.lock().set(RESTART_KEY, id) {
        return report_failure(
            shared,
            id,
            fail("EXECUTION_FAILED", format!("無法記錄重新啟動:{e}")),
        );
    }
    info!("依指令 {id} 重新啟動 Agent");
    shared.request_restart();
    std::future::pending::<()>().await;
}

struct MessageParams {
    title: String,
    text: String,
    timeout_sec: u32,
}

/// 控制字元(text 允許換行)與雙向文字控制字元:可倒轉顯示、偽裝網址
fn unsafe_char(c: char, allow_newline: bool) -> bool {
    (c.is_control() && !(allow_newline && c == '\n'))
        || matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// 參數已由主機驗證;版本差異或主機被繞過時仍檢查,不符回 INVALID_PARAMS。
/// 顯示時標題一律加固定前綴,內文結尾附發送人工號(安全審查:避免偽裝系統對話框)
fn message_params(p: &Value, issued_by: Option<&str>) -> Result<MessageParams, Failure> {
    let text = p["text"].as_str().unwrap_or_default();
    if text.is_empty() || text.chars().count() > 1000 || text.lines().count() > MESSAGE_MAX_LINES {
        return Err(fail("INVALID_PARAMS", "text 需 1–1000 字、最多 30 行"));
    }
    let title = p["title"].as_str();
    if title.is_some_and(|t| t.is_empty() || t.chars().count() > 64) {
        return Err(fail("INVALID_PARAMS", "title 需 1–64 字"));
    }
    if text.chars().any(|c| unsafe_char(c, true))
        || title.is_some_and(|t| t.chars().any(|c| unsafe_char(c, false)))
    {
        return Err(fail("INVALID_PARAMS", "不可含控制字元或雙向文字控制字元"));
    }
    let title = match title {
        Some(t) => format!("{TITLE_PREFIX}{t}"),
        None => TITLE_PREFIX.to_string(),
    };
    let text = match issued_by {
        Some(emp) if !emp.is_empty() => format!("{text}\n\n(發送人:IT {emp})"),
        _ => text.to_string(),
    };
    let timeout_sec = match &p["timeout_sec"] {
        Value::Null => 0,
        v => v
            .as_u64()
            .filter(|s| *s <= 3600)
            .ok_or_else(|| fail("INVALID_PARAMS", "timeout_sec 需 0–3600"))? as u32,
    };
    Ok(MessageParams {
        title,
        text,
        timeout_sec,
    })
}

async fn message_show(params: &Value, issued_by: Option<&str>) -> Result<Value, Failure> {
    let p = message_params(params, issued_by)?;
    let session =
        tokio::task::spawn_blocking(move || wts::send_message(&p.title, &p.text, p.timeout_sec))
            .await
            .map_err(|e| fail("EXECUTION_FAILED", e.to_string()))??;
    Ok(json!({ "session_id": session, "shown_via": "wts" }))
}

#[cfg(windows)]
mod wts {
    use super::{Failure, fail};
    use windows_sys::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SERVER_HANDLE, WTSFreeMemory, WTSGetActiveConsoleSessionId,
        WTSQuerySessionInformationW, WTSSendMessageW, WTSUserName,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    };

    const NO_SESSION: u32 = 0xFFFF_FFFF;

    /// 主控台工作階段有登入的使用者才送;回傳工作階段 ID
    pub fn send_message(title: &str, text: &str, timeout_sec: u32) -> Result<u32, Failure> {
        // SAFETY:無參數的 Win32 呼叫
        let session = unsafe { WTSGetActiveConsoleSessionId() };
        if session == NO_SESSION || !has_user(session) {
            return Err(fail("NO_ACTIVE_SESSION", "主控台沒有登入的使用者"));
        }
        let title: Vec<u16> = title.encode_utf16().collect();
        let text: Vec<u16> = text.encode_utf16().collect();
        let mut response = 0i32;
        // SAFETY:緩衝區在呼叫期間有效,長度以位元組計;bWait = FALSE 不等待使用者
        let ok = unsafe {
            WTSSendMessageW(
                WTS_CURRENT_SERVER_HANDLE,
                session,
                title.as_ptr(),
                (title.len() * 2) as u32,
                text.as_ptr(),
                (text.len() * 2) as u32,
                MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST,
                timeout_sec,
                &mut response,
                0,
            )
        };
        if ok == 0 {
            return Err(fail(
                "EXECUTION_FAILED",
                format!("WTSSendMessage 失敗:{}", std::io::Error::last_os_error()),
            ));
        }
        Ok(session)
    }

    fn has_user(session: u32) -> bool {
        let mut buf: *mut u16 = std::ptr::null_mut();
        let mut bytes = 0u32;
        // SAFETY:成功時 buf 由系統配置,以 WTSFreeMemory 釋放
        let ok = unsafe {
            WTSQuerySessionInformationW(
                WTS_CURRENT_SERVER_HANDLE,
                session,
                WTSUserName,
                &mut buf,
                &mut bytes,
            )
        };
        if ok == 0 || buf.is_null() {
            return false;
        }
        // SAFETY:buf 為以 NUL 結尾的 UTF-16 字串,第一個字元非 0 表示有使用者名稱
        let has = unsafe { *buf != 0 };
        // SAFETY:釋放系統配置的緩衝區
        unsafe { WTSFreeMemory(buf.cast()) };
        has
    }
}

#[cfg(not(windows))]
mod wts {
    use super::{Failure, fail};

    pub fn send_message(_: &str, _: &str, _: u32) -> Result<u32, Failure> {
        Err(fail("EXECUTION_FAILED", "只支援 Windows"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_params_rules() {
        let p = message_params(&json!({ "text": "維護通知" }), Some("S000001"))
            .ok()
            .unwrap();
        assert_eq!((p.title.as_str(), p.timeout_sec), (TITLE_PREFIX, 0));
        assert_eq!(p.text, "維護通知\n\n(發送人:IT S000001)");
        let p = message_params(&json!({ "text": "x", "title": "Windows 安全性" }), None)
            .ok()
            .unwrap();
        assert_eq!(p.title, "【IT 部門通知】Windows 安全性", "標題前綴不可覆寫");
        assert_eq!(p.text, "x");
        assert!(message_params(&json!({}), None).is_err());
        assert!(message_params(&json!({ "text": "x", "timeout_sec": 3601 }), None).is_err());
        assert!(message_params(&json!({ "text": "x", "title": "" }), None).is_err());
        assert!(message_params(&json!({ "text": "a\u{202E}b" }), None).is_err());
        assert!(message_params(&json!({ "text": "a\u{0000}b" }), None).is_err());
        assert!(message_params(&json!({ "text": "x", "title": "a\nb" }), None).is_err());
        assert!(message_params(&json!({ "text": "第一行\n第二行" }), None).is_ok());
        assert!(message_params(&json!({ "text": "x\n".repeat(31) }), None).is_err());
        let long: String = "字".repeat(1000);
        assert!(
            message_params(&json!({ "text": long }), None).is_ok(),
            "以字元計,不以位元組"
        );
    }
}
