//! WebSocket 長連線(指南 §5.3、§6.3):整個程式只維持**一條**;連線後先送 `hello`,之後每 30 秒(以 `hello_ack` 為準)送 `heartbeat`。
//! 超過 3 個心跳間隔沒收到 Server 任何訊息視為斷線;斷線依 §4.2 判斷原因後退避重連(1 秒起、上限 2 分鐘、±20%;被拒 10 分鐘)。
//! P2:hello 帶端點時間與硬體指紋;hello_ack 的主機設定(settings_version 改變時)寫入本機並通知其他工作;
//! 心跳附上本機暫存數量;連線成功 / 失敗記入連線紀錄(PLATFORM-PLAN §4.2)。

use crate::Shared;
use crate::protocol::{AgentSettings, Envelope, HelloAck, HelloBody, WS_PATH};
use futures_util::{SinkExt, StreamExt};
use log::{debug, info, warn};
use rustit_common::backoff::Backoff;
use rustit_common::stop::wait;
use rustit_common::transport::{SendError, WsStream};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;
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

enum End {
    Shutdown,
    Closed(String),
}

pub async fn run(
    shared: Arc<Shared>,
    mut hello: watch::Receiver<Option<HelloBody>>,
    settings: watch::Sender<AgentSettings>,
    mut shutdown: watch::Receiver<bool>,
) {
    // hello 需要電腦名稱與 IP:等第一份蒐集結果
    tokio::select! {
        r = hello.wait_for(Option::is_some) => if r.is_err() { return },
        _ = shutdown.changed() => return,
    }
    let mut backoff = Backoff::new();
    loop {
        let delay = match session(&shared, &hello, &settings, &mut shutdown, &mut backoff).await {
            Ok(End::Shutdown) => return,
            Ok(End::Closed(reason)) => {
                let d = backoff.next_delay();
                warn!("WebSocket 中斷:{reason};{} 秒後重連", d.as_secs());
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

async fn session(
    shared: &Shared,
    hello: &watch::Receiver<Option<HelloBody>>,
    settings: &watch::Sender<AgentSettings>,
    shutdown: &mut watch::Receiver<bool>,
    backoff: &mut Backoff,
) -> Result<End, SendError> {
    let mut ws = shared.transport.connect_ws(WS_PATH).await?;
    backoff.reset();
    info!("WebSocket 已連線");
    let body = hello.borrow().clone().unwrap_or_default().stamped();
    send(&mut ws, &Envelope::new("hello", json!(body))).await?;

    let mut period = DEFAULT_HEARTBEAT;
    let mut beat = ticker(period);
    let mut last_rx = Instant::now();
    loop {
        tokio::select! {
            _ = beat.tick() => {
                if last_rx.elapsed() > period * 3 {
                    return Ok(End::Closed("超過 3 個心跳間隔沒有收到 Server 訊息".into()));
                }
                let (inv, ev) = shared.store.lock().counts().unwrap_or_default();
                let body = json!({ "outbox_pending": inv, "events_pending": ev, "last_inventory_seq": shared.last_acked_seq.load(Ordering::Relaxed) });
                send(&mut ws, &Envelope::new("heartbeat", body)).await?;
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
                                    apply_settings(shared, &ack, settings);
                                    let p = Duration::from_secs(ack.heartbeat_interval_sec.clamp(5, 300));
                                    if p != period {
                                        period = p;
                                        beat = ticker(period);
                                    }
                                }
                            }
                            "heartbeat_ack" => debug!("heartbeat_ack {}", env.id),
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
