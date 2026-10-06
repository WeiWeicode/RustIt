//! WebSocket 長連線(指南 §5.3、§6.3):整個程式只維持**一條**;連線後先送 `hello`,之後每 30 秒(以 `hello_ack` 為準)送 `heartbeat`。
//! 超過 3 個心跳間隔沒收到 Server 任何訊息視為斷線;斷線依 §4.2 判斷原因後退避重連(1 秒起、上限 2 分鐘、±20%;被拒 10 分鐘)。

use crate::backoff::Backoff;
use crate::inventory::wait;
use crate::protocol::{Envelope, HelloAck, HelloBody};
use crate::transport::{SendError, Transport, WsStream};
use futures_util::{SinkExt, StreamExt};
use log::{debug, info, warn};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::{Instant, Interval, interval_at};
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(30);
/// Server 停用裝置時的 close code(指南 §5.4)
const CLOSE_DEVICE_DISABLED: u16 = 4403;

enum End {
    Shutdown,
    Closed(String),
}

pub async fn run(
    transport: Arc<Transport>,
    mut hello: watch::Receiver<Option<HelloBody>>,
    last_acked_seq: Arc<AtomicU64>,
    mut shutdown: watch::Receiver<bool>,
) {
    // hello 需要電腦名稱與 IP:等第一份蒐集結果
    tokio::select! {
        r = hello.wait_for(Option::is_some) => if r.is_err() { return },
        _ = shutdown.changed() => return,
    }
    let mut backoff = Backoff::new();
    loop {
        let delay = match session(
            &transport,
            &hello,
            &last_acked_seq,
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
            Err(e) => {
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

async fn session(
    transport: &Transport,
    hello: &watch::Receiver<Option<HelloBody>>,
    last_acked_seq: &AtomicU64,
    shutdown: &mut watch::Receiver<bool>,
    backoff: &mut Backoff,
) -> Result<End, SendError> {
    let mut ws = transport.connect_ws().await?;
    backoff.reset();
    info!("WebSocket 已連線");
    let body = hello.borrow().clone().unwrap_or_default();
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
                let body = json!({ "outbox_pending": 0, "last_inventory_seq": last_acked_seq.load(Ordering::Relaxed) });
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
                let _ = ws.close(None).await;
                return Ok(End::Shutdown);
            }
        }
    }
}
