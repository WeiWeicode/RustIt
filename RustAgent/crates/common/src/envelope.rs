//! WebSocket 信封(`docs/contracts/ws-envelope.schema.json`;指南 §5.6):Agent 與 Watchdog 共用。

use serde::{Deserialize, Serialize};

/// WebSocket 信封 `{v, type, id, body}`(ws-envelope.schema.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<serde_json::Value>,
}

impl Envelope {
    pub fn new(kind: &str, body: serde_json::Value) -> Self {
        Self {
            v: 1,
            kind: kind.to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            body: Some(body),
        }
    }

    /// 回覆類訊息沿用被回覆訊息的 id
    pub fn reply(to: &Envelope, kind: &str, body: serde_json::Value) -> Self {
        Self {
            v: 1,
            kind: kind.to_string(),
            id: to.id.clone(),
            body: Some(body),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_reuses_message_id() {
        let hb = Envelope::new("heartbeat", serde_json::json!({}));
        let ack = Envelope::reply(&hb, "unsupported", serde_json::json!({ "type": "x" }));
        assert_eq!(ack.id, hb.id);
        assert_eq!(serde_json::to_value(&ack).unwrap()["type"], "unsupported");
    }
}
