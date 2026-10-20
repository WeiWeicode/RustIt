//! WebSocket 長連線(指南 §5.3、§6.3):整個程式只維持**一條**;連線後先送 `hello`,之後每 30 秒(以 `hello_ack` 為準)送 `heartbeat`。
//! 超過 3 個心跳間隔沒收到 Server 任何訊息視為斷線;斷線依 §4.2 判斷原因後退避重連(1 秒起、上限 2 分鐘、±20%;被拒 10 分鐘)。
//! P2:hello 帶端點時間與硬體指紋;hello_ack 的主機設定(settings_version 改變時)寫入本機並通知其他工作;
//! 心跳附上本機暫存數量;連線成功 / 失敗記入連線紀錄(PLATFORM-PLAN §4.2)。
//! P4:`command` 交給執行器([`crate::command`]);本機尚未被確認的 `command_update` 在 hello_ack 後與有新狀態時送出,
//! 收到 `command_update_ack` 才標記已回報;`prepare_shutdown`:送完待送狀態、以 1000 關閉、隨機 0–30 秒後重連。
//! P6-2:本機管道 `prepare_shutdown`(Watchdog 升級 Agent)設定 `ws_hold`:送完待送的 `command_update`(等主機確認,最多 20 秒)、
//! 以 1000 關閉,之後不重連直到 Agent 被停止(或 5 分鐘後恢復)。
//! P5:心跳附健康摘要 `health`(主機設定 health_enabled,預設開;取樣在背景執行緒,逾時就省略);hello 帶裝置憑證到期日。

use crate::Shared;
use crate::command;
use crate::protocol::{
    AgentSettings, CommandBody, CommandUpdateAck, Envelope, HelloAck, HelloBody, PrepareShutdown,
    WS_PATH,
};
use futures_util::{SinkExt, StreamExt};
use log::{debug, info, warn};
use rustit_collector::{Health, HealthSampler};
use rustit_common::backoff::Backoff;
use rustit_common::backoff::random_up_to;
use rustit_common::stop::wait;
use rustit_common::transport::{SendError, WsStream};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::{Instant, Interval, interval_at};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(30);
/// Server 停用裝置時的 close code(指南 §5.4)
const CLOSE_DEVICE_DISABLED: u16 = 4403;
/// 時鐘偏差告警門檻(與主機相同,A2)
const CLOCK_SKEW_WARN_MS: i64 = 5 * 60_000;
/// prepare_shutdown 沒有指定時,重連前隨機等待的上限(避免全部 Agent 同時湧入)
const PREPARE_SHUTDOWN_JITTER: Duration = Duration::from_secs(30);
/// prepare_shutdown(升級)時等主機確認待送狀態的上限
const HOLD_FLUSH: Duration = Duration::from_secs(20);
/// 健康取樣最多等這麼久(磁碟列舉異常時不拖住心跳)
const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);

/// 健康取樣器跨連線保留(CPU 使用率需要前一次取樣)
type Sampler = Arc<Mutex<HealthSampler>>;

/// 在背景執行緒取樣;逾時或失敗回 None(心跳照送,只是沒有 health)
async fn sample_health(sampler: &Sampler) -> Option<Health> {
    let s = sampler.clone();
    // try_lock:上一次取樣卡住(逾時後背景執行緒仍在跑)時直接略過,不累積阻塞執行緒
    let job = tokio::task::spawn_blocking(move || s.try_lock().ok().map(|mut x| x.sample()));
    match tokio::time::timeout(HEALTH_TIMEOUT, job).await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            warn!("健康取樣失敗:{e}");
            None
        }
        Err(_) => {
            warn!(
                "健康取樣超過 {} 秒,本次心跳不附健康摘要",
                HEALTH_TIMEOUT.as_secs()
            );
            None
        }
    }
}

/// 連線結束(任何原因)時清除 ws_connected
struct ConnectedFlag<'a>(&'a Shared);

impl Drop for ConnectedFlag<'_> {
    fn drop(&mut self) {
        self.0.ws_connected.store(false, Ordering::Relaxed);
    }
}

/// 裝置憑證到期日(RFC 3339);開發模式(http)或讀不到時為空字串
fn cert_not_after(shared: &Shared) -> String {
    let Some(tls) = shared.tls.as_ref() else {
        return String::new();
    };
    match rustit_common::tls::device_cert_not_after(&tls.client) {
        Ok(t) => chrono::DateTime::from_timestamp(t, 0)
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            .unwrap_or_default(),
        Err(e) => {
            // 讀不到時主機無法判斷憑證即將到期,要留紀錄
            warn!("讀不到裝置憑證到期日,hello 不帶 cert_not_after:{e}");
            String::new()
        }
    }
}

enum End {
    Shutdown,
    Closed(String),
    /// 主機要求先斷線(prepare_shutdown),等這麼久再重連
    Prepared(Duration),
    /// Watchdog 升級 Agent(本機管道 prepare_shutdown):已關閉,等 ws_hold 解除才重連
    Held,
}

pub async fn run(
    shared: Arc<Shared>,
    mut hello: watch::Receiver<Option<HelloBody>>,
    settings: watch::Sender<AgentSettings>,
    mut shutdown: watch::Receiver<bool>,
) {
    // 測試用壞版本:管道正常但不連 WebSocket(P6-2 VM 驗收「2 分鐘內不正常 → 還原」)
    if cfg!(feature = "broken-no-ws") {
        warn!("broken-no-ws 測試版:不連 WebSocket");
        let _ = shutdown.wait_for(|s| *s).await;
        return;
    }
    // hello 需要電腦名稱與 IP:等第一份蒐集結果
    tokio::select! {
        r = hello.wait_for(Option::is_some) => if r.is_err() { return },
        _ = shutdown.changed() => return,
    }
    let mut backoff = Backoff::new();
    let sampler: Sampler = Arc::new(Mutex::new(HealthSampler::new()));
    let mut hold = shared.ws_hold.subscribe();
    loop {
        // 升級停止前收尾中:不連線
        if *hold.borrow() {
            tokio::select! {
                ok = async { hold.wait_for(|h| !*h).await.is_ok() } => if !ok { return },
                _ = shutdown.changed() => return,
            }
            info!("升級收尾已解除,重新連線");
        }
        let delay = match session(
            &shared,
            &hello,
            &settings,
            &sampler,
            &mut shutdown,
            &mut backoff,
        )
        .await
        {
            Ok(End::Shutdown) => return,
            Ok(End::Closed(reason)) => {
                let d = backoff.next_delay();
                warn!("WebSocket 中斷:{reason};{} 秒後重連", d.as_secs());
                d
            }
            Ok(End::Held) => Duration::ZERO,
            Ok(End::Prepared(d)) => {
                info!(
                    "主機要求暫時斷線(prepare_shutdown);{} 秒後重連",
                    d.as_secs()
                );
                d
            }
            Err(e) => {
                shared.failed(&e);
                let d = e.wait(&mut backoff);
                warn!("WebSocket 無法連線:{e};{} 秒後重連", d.as_secs());
                d
            }
        };
        if wait(delay, &mut shutdown).await {
            return;
        }
    }
}

async fn send(ws: &mut WsStream, env: &Envelope) -> Result<(), SendError> {
    let text = serde_json::to_string(env).map_err(|e| SendError::Retry(e.to_string()))?;
    ws.send(Message::text(text))
        .await
        .map_err(|e| SendError::Retry(format!("WebSocket 傳送失敗:{e}")))
}

fn ticker(period: Duration) -> Interval {
    interval_at(Instant::now() + period, period)
}

/// hello_ack 的主機設定:版本與本機保存的不同時寫入並通知其他工作
fn apply_settings(shared: &Shared, ack: &HelloAck, settings: &watch::Sender<AgentSettings>) {
    let (Some(version), Some(new)) = (ack.settings_version, ack.settings.as_ref()) else {
        return;
    };
    let store = shared.store.lock();
    if store.get("settings_version").ok().flatten() == Some(version.to_string())
        && *settings.borrow() == *new
    {
        return;
    }
    let saved = serde_json::to_string(new)
        .map_err(|e| e.to_string())
        .and_then(|json| store.set("settings", &json))
        .and_then(|_| store.set("settings_version", &version.to_string()));
    drop(store);
    match saved {
        Ok(()) => info!("套用主機設定 v{version}:{new:?}"),
        Err(e) => warn!("無法保存主機設定:{e}"),
    }
    settings.send_replace(new.clone());
}

/// 主機沒回 ack(SQL 暫時無法寫入)時,同一連線內隔這麼久再重送同一狀態
const UPDATE_RESEND: Duration = Duration::from_secs(60);

/// 本連線已送出、等 ack 的 command_update
#[derive(Default)]
struct SentUpdates {
    /// 信封 id → (command_id, state):ack 沿用信封 id,據此標記確切是哪一則被確認
    by_envelope: HashMap<String, (String, String)>,
    /// command_id → (最後送出的 state, 送出時間):同一狀態在 UPDATE_RESEND 內不重送
    last: HashMap<String, (String, Instant)>,
}

/// 送出本機尚未被主機確認的 command_update
async fn flush_updates(
    shared: &Shared,
    ws: &mut WsStream,
    sent: &mut SentUpdates,
) -> Result<(), SendError> {
    let pending = match shared.store.lock().command_unreported() {
        Ok(p) => p,
        Err(e) => {
            warn!("無法讀取待送的指令狀態:{e}");
            return Ok(());
        }
    };
    for v in pending {
        let (Some(id), Some(state)) = (v["command_id"].as_str(), v["state"].as_str()) else {
            continue;
        };
        if let Some((s, at)) = sent.last.get(id)
            && s == state
            && at.elapsed() < UPDATE_RESEND
        {
            continue;
        }
        let (id, state) = (id.to_string(), state.to_string());
        let env = Envelope::new("command_update", v);
        send(ws, &env).await?;
        sent.by_envelope.insert(env.id, (id.clone(), state.clone()));
        sent.last.insert(id, (state, Instant::now()));
    }
    Ok(())
}

/// command_update_ack:標記已回報(accepted = false 也視為送達,契約;不再重送)
fn on_update_ack(shared: &Shared, env: Envelope, sent: &mut SentUpdates) {
    if let Some(ack) = env
        .body
        .and_then(|b| serde_json::from_value::<CommandUpdateAck>(b).ok())
    {
        if !ack.accepted {
            warn!(
                "主機不採用指令 {} 的狀態(已結束或不屬於此裝置)",
                ack.command_id
            );
        }
        if let Some((id, state)) = sent.by_envelope.remove(&env.id)
            && let Err(e) = shared.store.lock().command_reported(&id, &state)
        {
            warn!("無法標記指令狀態已回報:{e}");
        }
    }
}

/// 升級收尾:等主機確認剛送出的指令狀態(最多 HOLD_FLUSH),其他訊息略過(未確認的指令主機會在重連後重送)
async fn drain_acks(shared: &Shared, ws: &mut WsStream, sent: &mut SentUpdates) {
    let deadline = Instant::now() + HOLD_FLUSH;
    while !sent.by_envelope.is_empty() {
        let msg = match tokio::time::timeout_at(deadline, ws.next()).await {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        if let Message::Text(text) = msg
            && let Ok(env) = serde_json::from_str::<Envelope>(text.as_str())
            && env.kind == "command_update_ack"
        {
            on_update_ack(shared, env, sent);
        }
    }
    if !sent.by_envelope.is_empty() {
        warn!(
            "升級收尾:{} 則指令狀態未獲主機確認,重新啟動後再送",
            sent.by_envelope.len()
        );
    }
}

async fn session(
    shared: &Arc<Shared>,
    hello: &watch::Receiver<Option<HelloBody>>,
    settings: &watch::Sender<AgentSettings>,
    sampler: &Sampler,
    shutdown: &mut watch::Receiver<bool>,
    backoff: &mut Backoff,
) -> Result<End, SendError> {
    let mut ws = shared.transport.connect_ws(WS_PATH).await?;
    backoff.reset();
    info!("WebSocket 已連線");
    let mut body = hello.borrow().clone().unwrap_or_default().stamped();
    body.cert_not_after = cert_not_after(shared);
    if let Ok(mut c) = shared.cert_not_after.lock() {
        c.clone_from(&body.cert_not_after);
    }
    // 本機管道 get_status 的連線狀態:收到 hello_ack 才算連上,這條連線結束就清除
    let _connected = ConnectedFlag(shared);
    send(&mut ws, &Envelope::new("hello", json!(body))).await?;

    let mut period = DEFAULT_HEARTBEAT;
    let mut beat = ticker(period);
    let mut last_rx = Instant::now();
    // 收到 hello_ack(裝置未被停用)後才送指令狀態;本連線已送出、等 ack 的 (command_id → state)
    let mut ready = false;
    let mut sent_updates = SentUpdates::default();
    let mut hold = shared.ws_hold.subscribe();
    loop {
        tokio::select! {
            held = async { hold.wait_for(|h| *h).await.is_ok() } => {
                if !held {
                    continue;
                }
                info!("升級停止前收尾:送出待送的指令狀態後關閉 WebSocket");
                if ready {
                    flush_updates(shared, &mut ws, &mut sent_updates).await?;
                    drain_acks(shared, &mut ws, &mut sent_updates).await;
                }
                let _ = ws.close(Some(CloseFrame { code: CloseCode::Normal, reason: "agent upgrading".into() })).await;
                return Ok(End::Held);
            }
            _ = shared.command_notify.notified() => {
                if ready {
                    flush_updates(shared, &mut ws, &mut sent_updates).await?;
                }
            }
            _ = beat.tick() => {
                if last_rx.elapsed() > period * 3 {
                    return Ok(End::Closed("超過 3 個心跳間隔沒有收到 Server 訊息".into()));
                }
                let (inv, ev) = shared.store.lock().counts().unwrap_or_default();
                let mut body = json!({ "outbox_pending": inv, "events_pending": ev, "last_inventory_seq": shared.last_acked_seq.load(Ordering::Relaxed) });
                let health_on = settings.borrow().health_enabled();
                if health_on && let Some(h) = sample_health(sampler).await {
                    body["health"] = json!(h);
                }
                send(&mut ws, &Envelope::new("heartbeat", body)).await?;
                if ready {
                    flush_updates(shared, &mut ws, &mut sent_updates).await?;
                }
            }
            msg = ws.next() => {
                let Some(msg) = msg else { return Ok(End::Closed("連線已結束".into())) };
                let msg = msg.map_err(|e| SendError::Retry(format!("WebSocket 錯誤:{e}")))?;
                last_rx = Instant::now();
                match msg {
                    Message::Text(text) => {
                        let Ok(env) = serde_json::from_str::<Envelope>(text.as_str()) else {
                            warn!("收到無法解析的 WebSocket 訊息,忽略");
                            continue;
                        };
                        match env.kind.as_str() {
                            "hello_ack" => {
                                if let Some(ack) = env.body.and_then(|b| serde_json::from_value::<HelloAck>(b).ok()) {
                                    info!("Server 已確認:裝置 {},心跳 {} 秒", ack.device_id, ack.heartbeat_interval_sec);
                                    // 收到 hello_ack 才算連上(未被停用)
                                    shared.reached();
                                    if let Some(skew) = ack.clock_skew_ms.filter(|s| s.abs() > CLOCK_SKEW_WARN_MS) {
                                        warn!("本機時鐘與主機相差 {} 秒,請檢查時間同步", skew / 1000);
                                    }
                                    shared.clock_skew_ms.store(ack.clock_skew_ms.unwrap_or(0), Ordering::Relaxed);
                                    shared.ws_connected.store(true, Ordering::Relaxed);
                                    shared.last_ack_ms.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
                                    shared.clock_known.store(true, Ordering::Relaxed);
                                    apply_settings(shared, &ack, settings);
                                    let p = Duration::from_secs(ack.heartbeat_interval_sec.clamp(5, 300));
                                    if p != period {
                                        period = p;
                                        beat = ticker(period);
                                    }
                                    // 離線期間或上次連線未確認的指令結果(P4)
                                    ready = true;
                                    flush_updates(shared, &mut ws, &mut sent_updates).await?;
                                }
                            }
                            "command" => match env.body.and_then(|b| serde_json::from_value::<CommandBody>(b).ok()) {
                                Some(cmd) => command::dispatch(shared.clone(), cmd),
                                None => warn!("command 訊息格式不符,忽略({})", env.id),
                            },
                            "command_update_ack" => on_update_ack(shared, env, &mut sent_updates),
                            "prepare_shutdown" => {
                                let p = env.body.and_then(|b| serde_json::from_value::<PrepareShutdown>(b).ok());
                                info!("主機即將關閉連線:{}", p.as_ref().map(|p| p.reason.as_str()).unwrap_or("-"));
                                if ready {
                                    flush_updates(shared, &mut ws, &mut sent_updates).await?;
                                }
                                let _ = ws.close(Some(CloseFrame { code: CloseCode::Normal, reason: "prepare_shutdown".into() })).await;
                                let wait = match p.and_then(|p| p.reconnect_after_sec) {
                                    Some(s) => Duration::from_secs(s.min(3600)),
                                    None => random_up_to(PREPARE_SHUTDOWN_JITTER),
                                };
                                return Ok(End::Prepared(wait));
                            }
                            "heartbeat_ack" => {
                                shared.last_ack_ms.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
                                debug!("heartbeat_ack {}", env.id)
                            }
                            "unsupported" => warn!("Server 不支援 Agent 送出的訊息:{:?}", env.body),
                            // 不認得的類型回 unsupported(指南 §5.6)
                            other => {
                                info!("收到不支援的訊息類型 {other}");
                                send(&mut ws, &Envelope::reply(&env, "unsupported", json!({ "type": other }))).await?;
                            }
                        }
                    }
                    Message::Close(frame) => {
                        let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                        if code == CLOSE_DEVICE_DISABLED {
                            return Err(SendError::Rejected(format!("裝置已被 IT 停用(close {code})")));
                        }
                        return Ok(End::Closed(format!("Server 關閉連線 {code} {reason}")));
                    }
                    // ping / pong 由 tungstenite 自動處理;二進位訊息不在契約內
                    _ => {}
                }
            }
            _ = shutdown.changed() => {
                // 1001 Going Away:Agent 停止(服務停止 / 關機),Server 立即標記離線(PLATFORM-PLAN §4.1)
                let _ = ws.close(Some(CloseFrame { code: CloseCode::Away, reason: "agent stopping".into() })).await;
                return Ok(End::Shutdown);
            }
        }
    }
}
