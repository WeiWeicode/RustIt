//! 契約測試(AGENT.md §7.3):Watchdog 送出的上報必須通過 `docs/contracts/watchdog.schema.json`(事件引用 event.schema.json),
//! 主機與 Agent 的範例(上報回應、本機管道 status)必須能被 Watchdog 解析。ItAgentBack 的 npm test 吃同一份範例。
#![cfg(windows)]

use rustit_common::scm::{ExitKind, StartType, SvcInfo, SvcState};
use rustit_watchdog::monitor::AgentStatus;
use rustit_watchdog::report::{EventOut, ReportResponse, Snapshot, build};
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
    let req =
        serde_json::to_value(build(&snap, events, Some("2027-10-14T08:00:00Z".into()))).unwrap();
    assert_valid(&req);
    // Agent 不存在時也要符合
    let missing = Snapshot {
        info: Some(SvcInfo::missing()),
        ..Default::default()
    };
    assert_valid(&serde_json::to_value(build(&missing, Vec::new(), None)).unwrap());
    // 範例本身
    assert_valid(&read("examples/watchdog-report.sample.json"));
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
