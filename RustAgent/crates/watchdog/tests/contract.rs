//! 契約測試(AGENT.md §7.3):Watchdog 送出的上報必須通過 `docs/contracts/watchdog.schema.json`(事件引用 event.schema.json),
//! 主機與 Agent 的範例(上報回應、本機管道 status)必須能被 Watchdog 解析。ItAgentBack 的 npm test 吃同一份範例。
#![cfg(windows)]

use rustit_common::scm::{ExitKind, StartType, SvcInfo, SvcState};
use rustit_watchdog::monitor::AgentStatus;
use rustit_watchdog::report::{EventOut, ReportResponse, Snapshot, agent_target, build};
use rustit_watchdog::upgrade::UpgradeRecord;
use serde_json::{Value, json};
use std::path::PathBuf;

fn read(rel: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/contracts")
        .join(rel);
    serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("無法讀取 {}:{e}", path.display())),
    )
    .unwrap()
}

/// 以本機檔案解析跨檔 $ref(event.schema.json),不連網
struct Contracts;

impl jsonschema::Retrieve for Contracts {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let name = uri
            .as_str()
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();
        Ok(read(&name))
    }
}

fn assert_valid(instance: &Value) {
    let validator = jsonschema::options()
        .with_retriever(Contracts)
        .build(&read("watchdog.schema.json"))
        .expect("schema 可編譯");
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|e| format!("{} {}", e.instance_path(), e))
        .collect();
    assert!(errors.is_empty(), "不符合 watchdog.schema.json:{errors:#?}");
}

/// P6-3:Watchdog 送給 Agent 的 replace_watchdog 要符合管道契約(與 Agent 端的契約測試吃同一份 pipe.schema.json)
#[test]
fn replace_watchdog_request_matches_pipe_schema() {
    use rustit_common::envelope::Envelope;
    use rustit_watchdog::upgrade::{UpgradeTarget, replace_watchdog_body};
    let sample = read("examples/pipe-replace-watchdog.sample.json");
    let target = UpgradeTarget {
        version: sample["body"]["version"].as_str().unwrap().into(),
        url: "/agent/v1/releases/watchdog/0.3.1/rustit-watchdog.exe".into(),
        sha256: sample["body"]["sha256"].as_str().unwrap().into(),
        size_bytes: 8_000_000,
        signer_thumbprints: vec![
            sample["body"]["signer_thumbprints"][0]
                .as_str()
                .unwrap()
                .into(),
        ],
    };
    let path = PathBuf::from(sample["body"]["path"].as_str().unwrap());
    let env = Envelope::new("replace_watchdog", replace_watchdog_body(&target, &path));
    let v = serde_json::to_value(&env).unwrap();
    let validator = jsonschema::validator_for(&read("pipe.schema.json")).expect("schema 可編譯");
    let errors: Vec<String> = validator
        .iter_errors(&v)
        .map(|e| format!("{} {}", e.instance_path(), e))
        .collect();
    assert!(errors.is_empty(), "不符合 pipe.schema.json:{errors:#?}");
    assert_eq!(v["body"], sample["body"], "與範例檔一致");
    // 範例檔自己也要合法
    for name in [
        "examples/pipe-replace-watchdog.sample.json",
        "examples/pipe-replace-watchdog-ack.sample.json",
    ] {
        assert!(validator.is_valid(&read(name)), "{name}");
    }
}

#[test]
fn report_matches_schema() {
    let snap = Snapshot {
        info: Some(SvcInfo {
            state: SvcState::Running,
            pid: Some(4321),
            exit: ExitKind::Clean,
            start_type: StartType::Auto,
            exe: Some(PathBuf::from(
                r"C:\Program Files\GigaNexus\Agent\rustit-agent.exe",
            )),
        }),
        status: Some(AgentStatus {
            version: "0.6.0".into(),
            pid: 4321,
            ws_connected: true,
            last_heartbeat_ack: Some("2026-10-20T01:04:29.000Z".into()),
            ..Default::default()
        }),
        status_at: Some("2026-10-20T01:04:30.000Z".into()),
        probe_error: None,
        restarts_24h: 1,
    };
    let events = vec![
        EventOut {
            event_id: "8d2f4a6b-1c3e-4f5a-9b7c-0d1e2f3a4b51".into(),
            kind: "agent_restarted".into(),
            occurred_at: "2026-10-20T01:02:10.000Z".into(),
            data: json!({ "cause": "crashed", "previous_pid": 4100, "pid": 4321 }),
        },
        EventOut {
            event_id: "8d2f4a6b-1c3e-4f5a-9b7c-0d1e2f3a4b52".into(),
            kind: "agent_binary_missing".into(),
            occurred_at: "2026-10-20T01:03:00.000Z".into(),
            data: json!({ "service_missing": true }),
        },
    ];
    let req = serde_json::to_value(build(
        &snap,
        events,
        Some("2027-10-14T08:00:00Z".into()),
        None,
    ))
    .unwrap();
    assert_valid(&req);
    // Agent 不存在時也要符合
    let missing = Snapshot {
        info: Some(SvcInfo::missing()),
        ..Default::default()
    };
    assert_valid(&serde_json::to_value(build(&missing, Vec::new(), None, None)).unwrap());
    // 範例本身
    assert_valid(&read("examples/watchdog-report.sample.json"));
    assert_valid(&read("examples/watchdog-report-upgrade.sample.json"));
}

/// P6-2:升級進度與 upgrade_* 事件符合契約
#[test]
fn upgrade_report_matches_schema() {
    let rec = UpgradeRecord {
        component: "agent".into(),
        target_version: "0.7.2-broken".into(),
        target_sha256: "ab".repeat(32),
        from_version: Some("0.7.0".into()),
        state: "rolled_back".into(),
        attempts: 1,
        error_code: Some("HEALTH_CHECK_FAILED".into()),
        error_message: Some(
            "新版 2 分鐘內 get_status 不正常(WebSocket 未連線),已還原 0.7.0".into(),
        ),
        started_at: "2026-10-21T02:07:09.000Z".into(),
    };
    let events = vec![
        EventOut {
            event_id: "5b1e7c2d-3f4a-4b5c-8d6e-7f8091a2b3c1".into(),
            kind: "upgrade_started".into(),
            occurred_at: "2026-10-21T02:07:09.000Z".into(),
            data: json!({ "component": "agent", "from": "0.7.0", "to": "0.7.2-broken" }),
        },
        EventOut {
            event_id: "5b1e7c2d-3f4a-4b5c-8d6e-7f8091a2b3c4".into(),
            kind: "upgrade_failed".into(),
            occurred_at: "2026-10-21T02:09:40.000Z".into(),
            data: json!({ "component": "agent", "from": "0.7.0", "to": "0.7.2-broken", "duration_ms": 151000,
                          "error_code": "HEALTH_CHECK_FAILED", "error_message": "x", "rolled_back": true }),
        },
    ];
    let req = build(&Snapshot::default(), events, None, Some(rec.progress()));
    assert_valid(&serde_json::to_value(req).unwrap());
}

#[test]
fn target_example_parses() {
    let res: ReportResponse =
        serde_json::from_value(read("examples/watchdog-report-response-target.sample.json"))
            .unwrap();
    let t = agent_target(&res).expect("target.agent");
    assert_eq!(t.version, "0.7.1");
    assert_eq!(t.url, "/agent/v1/releases/agent/0.7.1/rustit-agent.exe");
    assert_eq!(t.signer_thumbprints.len(), 1);
    // 沒有 target / target.agent 為 null / 格式不符:None,且整個回應仍可解析
    let none: ReportResponse =
        serde_json::from_value(read("examples/watchdog-report-response.sample.json")).unwrap();
    assert!(agent_target(&none).is_none());
    let bad: ReportResponse = serde_json::from_value(json!({
        "server_time": "2026-10-21T02:00:00Z", "accepted": [], "target": { "agent": { "version": 1 }, "watchdog": null }
    }))
    .unwrap();
    assert!(agent_target(&bad).is_none());
}

#[test]
fn server_and_agent_examples_parse() {
    let res: ReportResponse =
        serde_json::from_value(read("examples/watchdog-report-response.sample.json")).unwrap();
    assert_eq!(res.accepted.len(), 2);
    assert_eq!(res.report_interval_sec, Some(300));
    let status = read("examples/pipe-status.sample.json");
    let s: AgentStatus = serde_json::from_value(status["body"].clone()).unwrap();
    assert_eq!(
        (s.pid, s.ws_connected, s.previous_exit.as_deref()),
        (4321, true, Some("unexpected"))
    );
}
