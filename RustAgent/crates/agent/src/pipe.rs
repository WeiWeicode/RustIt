//! 本機管道伺服端(P5-2;指南 §6.4、§7.2;契約 `docs/contracts/pipe.schema.json`):Watchdog 每 30 秒 `get_status`。
//!
//! - `\\.\pipe\giganexus-agent-v1`,ACL 只允許 SYSTEM、Administrators;隨時保留一個等待中的執行個體,
//!   沒有存活的執行個體時以 `first_pipe_instance` 建立(別的行程先建立同名管道時失敗並每分鐘重試,不加入別人的管道)
//! - 每條連線一則請求、一則回應(回覆後等用戶端關閉再釋放,不直接中斷以免丟掉未讀的回應);請求 5 秒內沒送完就中斷;同時最多 [`MAX_CLIENTS`] 條,超過直接關閉
//! - `get_status`:狀態摘要(含 agent.upgrade 的 `upgrade_requested`,P6-2)
//! - `replace_watchdog`(P6-3,Watchdog 升級自己前;P6-UPGRADE-DESIGN §5.3):同樣只接受 Watchdog 服務的行程;Agent 再驗一次檔案
//!   (路徑在 `cache\watchdog\`、SHA-256、Authenticode、簽章者)後回 `replace_watchdog_ack`,稍後在背景停止 Watchdog、替換、檢查、必要時還原
//!   (`upgrade_watchdog`)。替換進行中 `get_status` 另記下以 Watchdog 服務 PID 連上來的用戶端(健康檢查依據)
//! - `prepare_shutdown`(P6-2,Watchdog 升級 Agent 前;P6-UPGRADE-DESIGN §2.2、§9-6):只接受 Watchdog 服務的行程(用戶端 PID 比對 SCM)。
//!   停止接新指令 → 執行中的指令等最多 60 秒(逾時記 failed AGENT_UPGRADING)→ 送完待送的 command_update 與事件(上限 20 秒)、
//!   WebSocket 以 1000 關閉 → 回 `prepare_shutdown_ack`。5 分鐘內沒有被停止就恢復(Watchdog 中途失敗時不會一直斷線)

use crate::Shared;
use crate::command;
use crate::protocol::{AGENT_VERSION, Envelope};
use log::{debug, info, warn};
use rustit_common::pipe::{client_pid, create_server, read_line, write_line};
use rustit_common::scm::{self, WATCHDOG_SERVICE};
use rustit_common::stop::wait;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::{Semaphore, watch};

const MAX_CLIENTS: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY: Duration = Duration::from_secs(60);
/// 回覆後等用戶端關閉的上限
const CLIENT_CLOSE_WAIT: Duration = Duration::from_secs(2);
/// prepare_shutdown:執行中的指令最多等多久(§9-6)
const COMMAND_WAIT: Duration = Duration::from_secs(60);
/// prepare_shutdown:送完待送資料、關閉 WebSocket 的上限
const FLUSH_WAIT: Duration = Duration::from_secs(20);
/// replace_watchdog:讀檔、雜湊、WinVerifyTrust 的上限(200 MB 上限,一般幾秒)。
/// 大於 Agent 自己的驗證期限(`upgrade_watchdog::VALIDATE_LIMIT`,50 秒)、小於 Watchdog 等 ack 的上限(70 秒)
const REPLACE_VERIFY_LIMIT: Duration = Duration::from_secs(60);
/// prepare_shutdown 後多久沒被停止就恢復
const HOLD_LIMIT: Duration = Duration::from_secs(300);

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
    // 請求 5 秒內要送完
    let req = match tokio::time::timeout(REQUEST_TIMEOUT, read_line(&mut server)).await {
        Ok(Ok(line)) => match serde_json::from_str::<Envelope>(&line) {
            Ok(r) => r,
            Err(e) => return warn!("管道請求格式錯誤:{e}"),
        },
        Ok(Err(e)) => return warn!("{e}"),
        Err(_) => return warn!("本機管道請求逾時,中斷連線"),
    };
    // prepare_shutdown 要等指令與送出(最多 60 + 20 秒);replace_watchdog 要讀整個檔案並驗簽章;其他請求 5 秒
    let limit = match req.kind.as_str() {
        "prepare_shutdown" => COMMAND_WAIT + FLUSH_WAIT + REQUEST_TIMEOUT,
        "replace_watchdog" => REPLACE_VERIFY_LIMIT,
        _ => REQUEST_TIMEOUT,
    };
    let work = async {
        let reply = match req.kind.as_str() {
            "get_status" => {
                // 替換 Watchdog 後的健康檢查:記下以 SCM 的 Watchdog PID 連上來的用戶端(P6-3)
                if shared.watchdog_replacing.load(Ordering::SeqCst)
                    && let Ok(pid) = watchdog_pid(&server).await
                    && let Ok(mut seen) = shared.watchdog_seen.lock()
                {
                    *seen = Some(pid);
                }
                // 狀態要讀本機暫存(同步鎖):放到阻塞執行緒,逾時才管得到,也不卡住 tokio 工作執行緒
                let s = shared.clone();
                let body = tokio::task::spawn_blocking(move || status_body(&s))
                    .await
                    .map_err(|e| format!("無法取得狀態:{e}"))?;
                Envelope::reply(&req, "status", body)
            }
            "prepare_shutdown" => match from_watchdog(&server).await {
                Ok(()) => prepare_shutdown(&shared, &req).await,
                Err(e) => {
                    warn!("拒絕 prepare_shutdown:{e}");
                    Envelope::reply(
                        &req,
                        "unsupported",
                        json!({ "type": "prepare_shutdown", "reason": "not_watchdog" }),
                    )
                }
            },
            "replace_watchdog" => match from_watchdog(&server).await {
                Ok(()) => {
                    let body = req.body.clone().unwrap_or_default();
                    Envelope::reply(
                        &req,
                        "replace_watchdog_ack",
                        crate::upgrade_watchdog::accept(&shared, body).await,
                    )
                }
                Err(e) => {
                    warn!("拒絕 replace_watchdog:{e}");
                    Envelope::reply(
                        &req,
                        "unsupported",
                        json!({ "type": "replace_watchdog", "reason": "not_watchdog" }),
                    )
                }
            },
            other => Envelope::reply(&req, "unsupported", json!({ "type": other })),
        };
        write_line(&mut server, &reply).await?;
        // 等用戶端讀完並關閉(讀到 EOF)再釋放:先中斷連線會丟掉用戶端還沒讀的回應
        let mut rest = [0u8; 64];
        let _ = tokio::time::timeout(CLIENT_CLOSE_WAIT, server.read(&mut rest)).await;
        Ok::<(), String>(())
    };
    match tokio::time::timeout(limit, work).await {
        Ok(Ok(())) => debug!("本機管道 {} 已回覆", req.kind),
        Ok(Err(e)) => warn!("{e}"),
        Err(_) => warn!("本機管道請求逾時,中斷連線"),
    }
}

/// 用戶端的 PID 必須是 SCM 的 Watchdog 服務行程;回傳該 PID
async fn watchdog_pid(server: &NamedPipeServer) -> Result<u32, String> {
    let client = client_pid(server)?;
    let watchdog = tokio::task::spawn_blocking(|| scm::query(WATCHDOG_SERVICE))
        .await
        .map_err(|e| e.to_string())??
        .pid;
    if watchdog == Some(client) {
        Ok(client)
    } else {
        Err(format!(
            "用戶端 PID {client} 不是 Watchdog 服務({watchdog:?})"
        ))
    }
}

/// prepare_shutdown、replace_watchdog 的用戶端必須是 Watchdog 服務的行程
async fn from_watchdog(server: &NamedPipeServer) -> Result<(), String> {
    watchdog_pid(server).await.map(|_| ())
}

/// Watchdog 升級 Agent 前的收尾(pipe.schema.json PrepareShutdown / PrepareShutdownAck)
async fn prepare_shutdown(shared: &Arc<Shared>, req: &Envelope) -> Envelope {
    let reason = req
        .body
        .as_ref()
        .and_then(|b| b["reason"].as_str())
        .unwrap_or("-")
        .to_string();
    info!("Watchdog 要求停止前收尾({reason}):停止接新指令");
    shared.upgrading.store(true, Ordering::SeqCst);
    let generation = shared.prepare_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let deadline = Instant::now() + COMMAND_WAIT;
    while command::running_count(shared) > 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let aborted = if command::running_count(shared) > 0 {
        let n = command::abort_running(shared);
        warn!(
            "執行中的指令等待 {} 秒仍未結束,{n} 筆記為 AGENT_UPGRADING",
            COMMAND_WAIT.as_secs()
        );
        n
    } else {
        0
    };
    // WebSocket 送完待送的 command_update(等主機確認)後以 1000 關閉;事件立即送
    shared.ws_hold.send_replace(true);
    shared.events.kick();
    let deadline = Instant::now() + FLUSH_WAIT;
    let pending = |s: &Shared| {
        let store = s.store.lock();
        let updates = store.command_unreported().map(|v| v.len()).unwrap_or(0);
        let (inv, ev) = store.counts().unwrap_or_default();
        (updates, inv, ev)
    };
    let (mut updates, mut inv, mut ev) = pending(shared);
    while (shared.ws_connected.load(Ordering::Relaxed) || ev > 0 || updates > 0)
        && Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(500)).await;
        (updates, inv, ev) = pending(shared);
    }
    let flushed = updates == 0 && ev == 0 && !shared.ws_connected.load(Ordering::Relaxed);
    info!("停止前收尾完成:待送指令狀態 {updates}、事件 {ev}、資產 {inv}(中斷指令 {aborted} 筆)");
    // Watchdog 沒有接著停止 Agent(升級中途失敗):過一段時間恢復,不一直斷線
    let s = shared.clone();
    tokio::spawn(async move {
        tokio::time::sleep(HOLD_LIMIT).await;
        // 之後又收到新的 prepare_shutdown:交給那一次的計時
        if s.prepare_gen.load(Ordering::SeqCst) == generation
            && s.upgrading.swap(false, Ordering::SeqCst)
        {
            warn!(
                "prepare_shutdown 後 {} 秒沒有被停止,恢復連線與指令",
                HOLD_LIMIT.as_secs()
            );
            s.ws_hold.send_replace(false);
        }
    });
    Envelope::reply(
        req,
        "prepare_shutdown_ack",
        crate::protocol::prepare_shutdown_ack(flushed, inv, ev, aborted),
    )
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
    // 軟體派送中:Watchdog 延後升級 Agent(P7)
    if shared.software_busy.load(Ordering::SeqCst) > 0 {
        body["busy"] = json!("software");
    }
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
    if let Some(req) = shared
        .upgrade_requested
        .lock()
        .ok()
        .and_then(|r| r.clone())
        .filter(|(_, at)| at.elapsed() < command::UPGRADE_REQUEST_TTL)
        .map(|(v, _)| v)
    {
        body["upgrade_requested"] = req;
    }
    body
}
