//! 本機管道伺服端(P5-2;指南 §6.4、§7.2;契約 `docs/contracts/pipe.schema.json`):Watchdog 每 30 秒 `get_status`。
//!
//! - `\\.\pipe\giganexus-agent-v1`,ACL 只允許 SYSTEM、Administrators;隨時保留一個等待中的執行個體,
//!   沒有存活的執行個體時以 `first_pipe_instance` 建立(別的行程先建立同名管道時失敗並每分鐘重試,不加入別人的管道)
//! - 每條連線一則請求、一則回應(回覆後等用戶端關閉再釋放,不直接中斷以免丟掉未讀的回應);請求 5 秒內沒送完就中斷;同時最多 [`MAX_CLIENTS`] 條,超過直接關閉
//! - 只回狀態摘要,不接受任何管理操作;`prepare_shutdown` 在 P6 才實作(現在回 unsupported)

use crate::Shared;
use crate::protocol::{AGENT_VERSION, Envelope};
use log::{debug, warn};
use rustit_common::pipe::{create_server, read_line, write_line};
use rustit_common::stop::wait;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::{Semaphore, watch};

const MAX_CLIENTS: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY: Duration = Duration::from_secs(60);
/// 回覆後等用戶端關閉的上限
const CLIENT_CLOSE_WAIT: Duration = Duration::from_secs(2);

pub async fn run(shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    let slots = Arc::new(Semaphore::new(MAX_CLIENTS));
    // 隨時保留一個等待連線的執行個體:沒有存活的執行個體時一律以 first_pipe_instance 重建,
    // 不會「加入」別人搶先建立、ACL 寬鬆的同名管道(資安稽核 M1)
    let mut waiting: Option<NamedPipeServer> = None;
    loop {
        let server = match waiting.take() {
            Some(s) => s,
            None => match create_server(true) {
                Ok(s) => s,
                Err(e) => {
                    warn!("{e};{} 秒後重試", RETRY.as_secs());
                    if wait(RETRY, &mut stop).await {
                        return;
                    }
                    continue;
                }
            },
        };
        tokio::select! {
            r = server.connect() => {
                if let Err(e) = r {
                    warn!("本機管道連線失敗:{e}");
                    continue;
                }
                // 先建立下一個執行個體再處理這條連線,中間不留空窗
                waiting = match create_server(false) {
                    Ok(next) => Some(next),
                    Err(e) => {
                        warn!("{e}");
                        None
                    }
                };
                match slots.clone().try_acquire_owned() {
                    Ok(permit) => {
                        let shared = shared.clone();
                        tokio::spawn(async move {
                            handle(shared, server).await;
                            drop(permit);
                        });
                    }
                    Err(_) => warn!("本機管道同時連線超過 {MAX_CLIENTS} 條,關閉新連線"),
                }
            }
            _ = stop.changed() => return,
        }
    }
}

async fn handle(shared: Arc<Shared>, mut server: NamedPipeServer) {
    let work = async {
        let line = read_line(&mut server).await?;
        let req: Envelope =
            serde_json::from_str(&line).map_err(|e| format!("管道請求格式錯誤:{e}"))?;
        let reply = match req.kind.as_str() {
            "get_status" => {
                // 狀態要讀本機暫存(同步鎖):放到阻塞執行緒,逾時才管得到,也不卡住 tokio 工作執行緒
                let s = shared.clone();
                let body = tokio::task::spawn_blocking(move || status_body(&s))
                    .await
                    .map_err(|e| format!("無法取得狀態:{e}"))?;
                Envelope::reply(&req, "status", body)
            }
            other => Envelope::reply(&req, "unsupported", json!({ "type": other })),
        };
        write_line(&mut server, &reply).await?;
        // 等用戶端讀完並關閉(讀到 EOF)再釋放:先中斷連線會丟掉用戶端還沒讀的回應
        let mut rest = [0u8; 64];
        let _ = tokio::time::timeout(CLIENT_CLOSE_WAIT, server.read(&mut rest)).await;
        Ok::<(), String>(())
    };
    match tokio::time::timeout(REQUEST_TIMEOUT, work).await {
        Ok(Ok(())) => debug!("本機管道 get_status 已回覆"),
        Ok(Err(e)) => warn!("{e}"),
        Err(_) => warn!("本機管道請求逾時,中斷連線"),
    }
}

/// 狀態摘要(pipe.schema.json StatusBody);沒有值的欄位省略
pub(crate) fn status_body(shared: &Shared) -> Value {
    let mut body = json!({
        "version": AGENT_VERSION,
        "pid": std::process::id(),
        "started_at": shared.started_at,
        "ws_connected": shared.ws_connected.load(Ordering::Relaxed),
        "device_status": if shared.is_disabled() { "disabled" } else { "active" },
        "previous_exit": shared.previous_exit,
    });
    let ack = shared.last_ack_ms.load(Ordering::Relaxed);
    if let Some(t) = (ack > 0)
        .then(|| chrono::DateTime::from_timestamp_millis(ack))
        .flatten()
    {
        body["last_heartbeat_ack"] = json!(t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    if let Some(e) = shared.last_error.lock().ok().and_then(|e| e.clone()) {
        body["last_error"] = json!(e);
    }
    if let Some(c) = shared
        .cert_not_after
        .lock()
        .ok()
        .map(|c| c.clone())
        .filter(|c| !c.is_empty())
    {
        body["cert_not_after"] = json!(c);
    }
    if let Ok((inv, ev)) = shared.store.lock().counts() {
        body["outbox_pending"] = json!(inv);
        body["events_pending"] = json!(ev);
    }
    body
}
