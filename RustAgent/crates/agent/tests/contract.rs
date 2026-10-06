//! 契約測試(AGENT.md §7.3):Agent 送出的 JSON 必須通過 RustIt/docs/contracts 的 JSON Schema,
//! Server 的範例回應必須能被 Agent 解析。ItAgentBack 的 npm test 吃同一份範例;改契約時兩邊一起更新。

use rustit_agent::protocol::{Envelope, HelloAck, HelloBody, InventoryRequest, InventoryResponse};
use rustit_collector::{ComputerInfo, NetAdapter, Software};
use serde_json::{Value, json};
use std::path::PathBuf;

fn contracts() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../docs/contracts")
}

fn read(rel: &str) -> Value {
    let path = contracts().join(rel);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("無法讀取 {}:{e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} 不是合法 JSON:{e}", path.display()))
}

fn assert_valid(schema: &str, instance: &Value) {
    let validator = jsonschema::validator_for(&read(schema)).expect("schema 可編譯");
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|e| format!("{} {}", e.instance_path(), e))
        .collect();
    assert!(errors.is_empty(), "不符合 {schema}:{errors:#?}");
}

/// 假資料(不可用真實電腦的蒐集結果,AGENT.md §7.3)
fn sample_info() -> ComputerInfo {
    let mut info = ComputerInfo::default();
    info.system.host_name = "PC-EXAMPLE-01".into();
    info.system.user_name = "EXAMPLE\\user01".into();
    info.system.boot_time = 1_791_244_800;
    info.memory_total = 17_179_869_184;
    info.collect_ms = 2350;
    info.network.push(NetAdapter {
        description: "Example Ethernet".into(),
        mac: "00:00:5E:00:53:01".into(),
        ips: vec!["192.0.2.10".into(), "fe80::1".into()],
        gateways: vec!["192.0.2.1".into()],
        dns: vec![],
        dhcp_enabled: true,
    });
    info.software.push(Software {
        name: "Example Office".into(),
        version: "1.0".into(),
        publisher: "Example".into(),
        install_date: "2026-09-15".into(),
    });
    info
}

#[test]
fn inventory_request_matches_schema() {
    let collected_at = chrono::DateTime::parse_from_rfc3339("2026-10-06T08:00:00Z")
        .unwrap()
        .to_utc();
    let req = InventoryRequest::new(sample_info(), 1_791_273_600_001, collected_at);
    let value = serde_json::to_value(&req).unwrap();
    assert_valid("inventory.schema.json", &value);
    assert_eq!(value["collected_at"], "2026-10-06T08:00:00.000Z");
    assert_eq!(value["inventory"]["usb"]["storage_policy"], "Unknown");
}

#[test]
fn collector_default_output_has_every_required_field() {
    // 預設值(WMI 全部失敗時)除了電腦名稱以外仍是完整結構:確保 collector 新增欄位不會漏掉契約要求的欄位
    let mut info = ComputerInfo::default();
    info.system.host_name = "PC".into();
    assert_valid(
        "inventory.schema.json",
        &json!({
            "agent_version": "0.1.0", "agent_seq": 1, "collected_at": "2026-10-06T08:00:00Z",
            "content_hash": "0".repeat(64), "inventory": serde_json::to_value(&info).unwrap()
        }),
    );
}

#[test]
fn ws_messages_match_schema() {
    let hello = Envelope::new("hello", json!(HelloBody::from_info(&sample_info())));
    let hello = serde_json::to_value(&hello).unwrap();
    assert_valid("ws-envelope.schema.json", &hello);
    assert_eq!(hello["body"]["ips"], json!(["192.0.2.10"]));

    let hb = Envelope::new(
        "heartbeat",
        json!({ "outbox_pending": 0, "last_inventory_seq": 1 }),
    );
    assert_valid(
        "ws-envelope.schema.json",
        &serde_json::to_value(&hb).unwrap(),
    );

    let from_server: Envelope =
        serde_json::from_value(read("examples/ws-unsupported.sample.json")).unwrap();
    let reply = Envelope::reply(
        &from_server,
        "unsupported",
        json!({ "type": "future_type" }),
    );
    assert_valid(
        "ws-envelope.schema.json",
        &serde_json::to_value(&reply).unwrap(),
    );
}

#[test]
fn server_examples_parse() {
    let res: InventoryResponse =
        serde_json::from_value(read("examples/inventory-response.sample.json")).unwrap();
    assert_eq!(res.result, "stored");
    let ack: Envelope = serde_json::from_value(read("examples/ws-hello-ack.sample.json")).unwrap();
    assert_eq!(ack.kind, "hello_ack");
    let body: HelloAck = serde_json::from_value(ack.body.unwrap()).unwrap();
    assert_eq!(body.heartbeat_interval_sec, 30);
    let hb_ack: Envelope =
        serde_json::from_value(read("examples/ws-heartbeat-ack.sample.json")).unwrap();
    assert_eq!(hb_ack.kind, "heartbeat_ack");
    // 多出的欄位忽略
    let mut extra = read("examples/inventory-response.sample.json");
    extra["future_field"] = json!(1);
    assert!(serde_json::from_value::<InventoryResponse>(extra).is_ok());
}
