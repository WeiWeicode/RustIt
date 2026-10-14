//! 訊息格式:RustIt `docs/contracts/`(資料契約,Agent 與 ItAgentBack 的唯一共同依據;AGENT.md §7.3)。
//! 只新增欄位;收到不認得的欄位忽略、不認得的 type 回 `unsupported`(指南 §5.6)。

use rustit_collector::ComputerInfo;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use rustit_common::envelope::Envelope;

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// HTTPS / WebSocket 的 User-Agent(指南 §5.6)
pub fn user_agent() -> String {
    format!("giganexus-agent/{AGENT_VERSION}")
}

/// Agent 通道路徑(契約 `/agent/v1`)
pub const INVENTORY_PATH: &str = "/agent/v1/inventory";
pub const SYNC_PATH: &str = "/agent/v1/sync";
pub const EVENTS_PATH: &str = "/agent/v1/events";
pub const WS_PATH: &str = "/agent/v1/ws";

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

/// `hello` 內容:連線後第一則(指南 §6.3 第 2 步)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct HelloBody {
    pub agent_version: String,
    pub host_name: String,
    pub os_name: String,
    pub os_version: String,
    pub ips: Vec<String>,
    pub boot_time: u64,
    /// 送出時的端點時間(A2);送出前由 [`HelloBody::stamped`] 填入,未填時不送
    #[serde(skip_serializing_if = "String::is_empty")]
    pub agent_time: String,
    /// 硬體指紋(A1),見 [`hw_fingerprint`]
    pub hw_fingerprint: String,
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
            agent_time: String::new(),
            hw_fingerprint: hw_fingerprint(&info.identity.bios_serial, &info.identity.system_uuid),
        }
    }

    /// 填入目前時間後送出
    pub fn stamped(&self) -> Self {
        Self {
            agent_time: now_rfc3339(),
            ..self.clone()
        }
    }
}

/// UTC、毫秒(契約的 date-time)
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 硬體指紋(ws-envelope HelloBody.hw_fingerprint):SHA-256("rustit-hw-v1|" + BIOS 序號 + "|" + 系統 UUID),
/// 兩者先去除前後空白、轉大寫;兩者皆為空白或廠商預設值時回空字串(不比對,避免組裝機誤判為同一台)
pub fn hw_fingerprint(bios_serial: &str, system_uuid: &str) -> String {
    let bios = bios_serial.trim().to_uppercase();
    let uuid = system_uuid.trim().to_uppercase();
    let bios_ok = !bios.is_empty()
        && !bios.chars().all(|c| c == '0')
        && ![
            "SYSTEM SERIAL NUMBER",
            "TO BE FILLED BY O.E.M.",
            "DEFAULT STRING",
            "NOT SPECIFIED",
        ]
        .contains(&bios.as_str());
    let uuid_ok = !uuid.is_empty()
        && !uuid.chars().all(|c| c == '0' || c == '-')
        && !uuid.chars().all(|c| c == 'F' || c == '-');
    if !bios_ok && !uuid_ok {
        return String::new();
    }
    hex::encode(Sha256::digest(
        format!("rustit-hw-v1|{bios}|{uuid}").as_bytes(),
    ))
}

/// 主機下發設定(ws-envelope AgentSettings;PLATFORM-PLAN §4.2 第二層);不認得的欄位忽略
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inventory_interval_sec: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usb_events: Option<bool>,
}

impl AgentSettings {
    /// 主機有設定就用主機的(下限 5 分鐘),否則用安裝設定 agent.toml 的值
    pub fn inventory_interval(&self, install_default: std::time::Duration) -> std::time::Duration {
        self.inventory_interval_sec
            .map(|s| std::time::Duration::from_secs(s.clamp(300, 86_400)))
            .unwrap_or(install_default)
    }

    pub fn usb_events(&self) -> bool {
        self.usb_events.unwrap_or(true)
    }
}

/// `POST /agent/v1/sync`(sync.schema.json)
#[derive(Debug, Serialize)]
pub struct SyncRequest {
    pub last_acked_seq: u64,
    pub last_acked_hash: String,
    pub pending: Vec<SyncPending>,
}

#[derive(Debug, Serialize)]
pub struct SyncPending {
    pub agent_seq: u64,
    pub collected_at: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncResponse {
    pub device_id: String,
    pub need: Vec<u64>,
    #[serde(default)]
    pub skip: Vec<u64>,
    pub server_state: ServerState,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerState {
    pub status: String,
}

/// `POST /agent/v1/events`(event.schema.json)
#[derive(Debug, Serialize)]
pub struct EventsRequest {
    pub events: Vec<EventOut>,
}

#[derive(Debug, Serialize)]
pub struct EventOut {
    pub event_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub occurred_at: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventsResponse {
    pub accepted: Vec<String>,
}

/// `hello_ack` 內容
#[derive(Debug, Clone, Deserialize)]
pub struct HelloAck {
    pub device_id: String,
    pub heartbeat_interval_sec: u64,
    #[serde(default)]
    pub clock_skew_ms: Option<i64>,
    #[serde(default)]
    pub settings_version: Option<u64>,
    #[serde(default)]
    pub settings: Option<AgentSettings>,
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
    fn hw_fingerprint_rules() {
        let fp = hw_fingerprint(" example-sn-0001 ", "00000000-0000-4000-8000-000000000001");
        assert_eq!(fp.len(), 64);
        assert_eq!(
            fp,
            hw_fingerprint("EXAMPLE-SN-0001", "00000000-0000-4000-8000-000000000001"),
            "去空白、不分大小寫"
        );
        assert_ne!(
            fp,
            hw_fingerprint("EXAMPLE-SN-0002", "00000000-0000-4000-8000-000000000001")
        );
        assert_eq!(
            hw_fingerprint(
                "To be filled by O.E.M.",
                "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"
            ),
            ""
        );
        assert_eq!(hw_fingerprint("", ""), "");
        assert_eq!(
            hw_fingerprint("Default string", "4C4C4544-0042-3510-8048-B4C04F4E4D32").len(),
            64,
            "UUID 有效即可"
        );
    }

    #[test]
    fn settings_fallback() {
        let d = std::time::Duration::from_secs(3600);
        assert_eq!(AgentSettings::default().inventory_interval(d), d);
        assert!(AgentSettings::default().usb_events());
        let s: AgentSettings =
            serde_json::from_str(r#"{"inventory_interval_sec":60,"usb_events":false,"future":1}"#)
                .unwrap();
        assert_eq!(
            s.inventory_interval(d),
            std::time::Duration::from_secs(300),
            "下限 5 分鐘"
        );
        assert!(!s.usb_events());
    }
}
