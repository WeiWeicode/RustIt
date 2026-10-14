//! 契約測試(AGENT.md §7.3):Agent 送出的 JSON 必須通過 RustIt/docs/contracts 的 JSON Schema,
//! Server 的範例回應必須能被 Agent 解析。ItAgentBack 的 npm test 吃同一份範例;改契約時兩邊一起更新。

use rustit_agent::protocol::{
    Envelope, EventOut, EventsRequest, EventsResponse, HelloAck, HelloBody, InventoryRequest,
    InventoryResponse, SyncPending, SyncRequest, SyncResponse,
};
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
    // P2:送出前填入端點時間;硬體指紋為 64 字元或空字串
    let stamped = Envelope::new(
        "hello",
        json!(HelloBody::from_info(&sample_info()).stamped()),
    );
    let stamped = serde_json::to_value(&stamped).unwrap();
    assert_valid("ws-envelope.schema.json", &stamped);
    assert!(
        stamped["body"]["agent_time"]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
    let mut with_id = sample_info();
    with_id.identity.bios_serial = "EXAMPLE-SN-0001".into();
    let fp = serde_json::to_value(Envelope::new(
        "hello",
        json!(HelloBody::from_info(&with_id)),
    ))
    .unwrap();
    assert_valid("ws-envelope.schema.json", &fp);
    assert_eq!(fp["body"]["hw_fingerprint"].as_str().unwrap().len(), 64);

    let hb = Envelope::new(
        "heartbeat",
        json!({ "outbox_pending": 0, "events_pending": 3, "last_inventory_seq": 1 }),
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
    let s = body.settings.expect("hello_ack 範例帶主機設定");
    assert_eq!(
        (
            s.inventory_interval_sec,
            s.usb_events,
            body.settings_version.is_some()
        ),
        (Some(3600), Some(true), true)
    );
    let sync: SyncResponse =
        serde_json::from_value(read("examples/sync-response.sample.json")).unwrap();
    assert_eq!(
        (
            sync.need.len(),
            sync.skip.len(),
            sync.server_state.status.as_str()
        ),
        (1, 1, "active")
    );
    let ev: EventsResponse =
        serde_json::from_value(read("examples/event-response.sample.json")).unwrap();
    assert_eq!(ev.accepted.len(), 4);
    let hb_ack: Envelope =
        serde_json::from_value(read("examples/ws-heartbeat-ack.sample.json")).unwrap();
    assert_eq!(hb_ack.kind, "heartbeat_ack");
    // 多出的欄位忽略
    let mut extra = read("examples/inventory-response.sample.json");
    extra["future_field"] = json!(1);
    assert!(serde_json::from_value::<InventoryResponse>(extra).is_ok());
}

/// P2:/sync 與 /events 請求(PLATFORM-PLAN §4.2)
#[test]
fn sync_and_events_requests_match_schema() {
    let sync = SyncRequest {
        last_acked_seq: 1_791_273_600_001,
        last_acked_hash: "a".repeat(64),
        pending: vec![SyncPending {
            agent_seq: 1_791_273_600_002,
            collected_at: "2026-10-06T09:00:00.000Z".into(),
            content_hash: "b".repeat(64),
        }],
    };
    assert_valid("sync.schema.json", &serde_json::to_value(&sync).unwrap());

    let event = |kind: &str, data: Value| EventOut {
        event_id: "3b9d2f5e-7c41-4a8e-9f06-1d2c3b4a5e61".into(),
        kind: kind.into(),
        occurred_at: "2026-10-06T09:00:05.120Z".into(),
        data,
    };
    let req = EventsRequest {
        events: vec![
            event(
                "offline_period",
                json!({ "started_at": "2026-10-06T09:00:05.120Z", "ended_at": "2026-10-06T10:02:41.900Z", "reason": "network", "retries": 47, "last_error": "IO error" }),
            ),
            event(
                "usb_inserted",
                json!({ "drive": "E:", "label": "USB-EXAMPLE", "file_system": "FAT32", "total": 16 }),
            ),
            event("agent_started", json!({ "agent_version": "0.2.0" })),
            event(
                "local_overflow",
                json!({ "store": "outbox_event", "dropped": 1 }),
            ),
        ],
    };
    let v = serde_json::to_value(&req).unwrap();
    assert_valid("event.schema.json", &v);
    assert_eq!(
        v["events"][0]["type"], "offline_period",
        "kind 以 type 送出"
    );
}
