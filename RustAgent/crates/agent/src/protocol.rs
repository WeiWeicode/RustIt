//! 訊息格式:RustIt `docs/contracts/`(資料契約,Agent 與 ItAgentBack 的唯一共同依據;AGENT.md §7.3)。
//! 只新增欄位;收到不認得的欄位忽略、不認得的 type 回 `unsupported`(指南 §5.6)。

use rustit_collector::ComputerInfo;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `POST /agent/v1/inventory` 請求(inventory.schema.json)
#[derive(Debug, Serialize)]
pub struct InventoryRequest {
    pub agent_version: String,
    pub agent_seq: u64,
    pub collected_at: String,
    pub content_hash: String,
    pub inventory: ComputerInfo,
}

impl InventoryRequest {
    pub fn new(
        inventory: ComputerInfo,
        agent_seq: u64,
        collected_at: chrono::DateTime<chrono::Utc>,
    ) -> Self {
        Self {
            agent_version: AGENT_VERSION.to_string(),
            agent_seq,
            collected_at: collected_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            content_hash: content_hash(&inventory),
            inventory,
        }
    }
}

/// 契約定義:把 `collect_ms` 設為 0 後,以 serde_json 序列化結果計算 SHA-256(小寫十六進位)。
/// 蒐集耗時每次不同,不列入比對;Server 只比對是否相等。
pub fn content_hash(info: &ComputerInfo) -> String {
    let mut copy = info.clone();
    copy.collect_ms = 0;
    // ComputerInfo 只有字串、數字、布林與陣列,序列化不會失敗;萬一失敗則以空內容計算(只影響去重)
    let bytes = serde_json::to_vec(&copy).unwrap_or_default();
    hex::encode(Sha256::digest(&bytes))
}

/// `POST /agent/v1/inventory` 回應(InventoryResponse)
#[derive(Debug, Clone, Deserialize)]
pub struct InventoryResponse {
    pub device_id: String,
    pub agent_seq: u64,
    /// stored / unchanged / archived
    pub result: String,
}

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

/// `hello` 內容:連線後第一則(指南 §6.3 第 2 步)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct HelloBody {
    pub agent_version: String,
    pub host_name: String,
    pub os_name: String,
    pub os_version: String,
    pub ips: Vec<String>,
    pub boot_time: u64,
}

impl HelloBody {
    pub fn from_info(info: &ComputerInfo) -> Self {
        Self {
            agent_version: AGENT_VERSION.to_string(),
            host_name: info.system.host_name.clone(),
            os_name: info.system.os_name.clone(),
            os_version: info.system.os_version.clone(),
            ips: info
                .primary_ipv4()
                .map(|ip| vec![ip.to_string()])
                .unwrap_or_default(),
            boot_time: info.system.boot_time,
        }
    }
}

/// `hello_ack` 內容
#[derive(Debug, Clone, Deserialize)]
pub struct HelloAck {
    pub device_id: String,
    pub heartbeat_interval_sec: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_ignores_collect_ms() {
        let mut a = ComputerInfo::default();
        a.system.host_name = "PC-EXAMPLE-01".into();
        a.collect_ms = 1200;
        let mut b = a.clone();
        b.collect_ms = 3400;
        assert_eq!(content_hash(&a), content_hash(&b));
        assert_eq!(content_hash(&a).len(), 64);
        b.memory_total = 1;
        assert_ne!(content_hash(&a), content_hash(&b));
    }

    #[test]
    fn reply_reuses_message_id() {
        let hb = Envelope::new("heartbeat", serde_json::json!({}));
        let ack = Envelope::reply(&hb, "unsupported", serde_json::json!({ "type": "x" }));
        assert_eq!(ack.id, hb.id);
        assert_eq!(serde_json::to_value(&ack).unwrap()["type"], "unsupported");
    }
}
