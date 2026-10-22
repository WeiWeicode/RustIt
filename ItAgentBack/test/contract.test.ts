/**
 * 契約測試(AGENT.md §7.3):docs/contracts/examples 的範例必須通過 schema;RustAgent 的 cargo test 吃同一份範例。
 * 改契約時兩邊測試一起更新。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { paramErrors } from '../src/commands/kinds.js';
import { CONTRACT_IDS, compileWsEnvelope, loadContract } from '../src/contracts.js';
import { argsErrors, installSnapshot, uninstallSnapshot } from '../src/services/software-service.js';
import type { PackageRecord } from '../src/stores/types.js';
import { CONTRACTS_DIR, example } from './helpers.js';

const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv) => Ajv;
const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));
for (const name of ['inventory', 'ws-envelope', 'sync', 'event', 'watchdog'] as const) ajv.addSchema(loadContract(name, CONTRACTS_DIR));
// 本機管道(P5-2):Agent ↔ Watchdog,Server 不使用,只在契約測試驗證範例
const PIPE_ID = 'https://giganexus.local/rustit/contracts/pipe.schema.json';
ajv.addSchema(JSON.parse(readFileSync(path.join(CONTRACTS_DIR, 'pipe.schema.json'), 'utf8')) as object);
// 指令附檔上傳回應(P4-2):Agent 通道以 Fastify 回傳,只在契約測試編譯
const COMMAND_FILE_ID = 'https://giganexus.local/rustit/contracts/command-file.schema.json';
ajv.addSchema(JSON.parse(readFileSync(path.join(CONTRACTS_DIR, 'command-file.schema.json'), 'utf8')) as object);

function check(ref: string, file: string) {
  const validate = ajv.getSchema(ref);
  assert.ok(validate, `找不到 schema ${ref}`);
  const ok = validate(example(file));
  assert.ok(ok, `${file} 不符合 ${ref}:${JSON.stringify(validate.errors)}`);
}

describe('資料契約範例', () => {
  it('每個範例都有對應的 schema 檢查', () => {
    const files = readdirSync(path.join(CONTRACTS_DIR, 'examples')).sort();
    assert.deepEqual(files, [
      'command-file-response.sample.json',
      'event-response.sample.json',
      'event.sample.json',
      'inventory-response.sample.json',
      'inventory.sample.json',
      'pipe-get-status.sample.json',
      'pipe-prepare-shutdown-ack.sample.json',
      'pipe-prepare-shutdown.sample.json',
      'pipe-replace-watchdog-ack.sample.json',
      'pipe-replace-watchdog.sample.json',
      'pipe-status.sample.json',
      'sync-response.sample.json',
      'sync.sample.json',
      'watchdog-report-response-target.sample.json',
      'watchdog-report-response.sample.json',
      'watchdog-report-upgrade.sample.json',
      'watchdog-report.sample.json',
      'ws-command-log-level.sample.json',
      'ws-command-software-install.sample.json',
      'ws-command-software-uninstall.sample.json',
      'ws-command-system-reboot.sample.json',
      'ws-command-update-ack.sample.json',
      'ws-command-update-diagnose.sample.json',
      'ws-command-update-logs.sample.json',
      'ws-command-update-software-failed.sample.json',
      'ws-command-update-software-install.sample.json',
      'ws-command-update.sample.json',
      'ws-command.sample.json',
      'ws-heartbeat-ack.sample.json',
      'ws-heartbeat-health.sample.json',
      'ws-heartbeat.sample.json',
      'ws-hello-ack.sample.json',
      'ws-hello.sample.json',
      'ws-prepare-shutdown.sample.json',
      'ws-unsupported.sample.json',
    ]);
  });

  it('inventory 請求與回應', () => {
    check(CONTRACT_IDS.inventory, 'inventory.sample.json');
    check(`${CONTRACT_IDS.inventory}#/definitions/InventoryResponse`, 'inventory-response.sample.json');
  });

  it('event 請求與回應(P2):offline_period / usb_* 缺必要 data 不通過;不認得的 type 通過', () => {
    check(CONTRACT_IDS.event, 'event.sample.json');
    check(`${CONTRACT_IDS.event}#/definitions/EventsResponse`, 'event-response.sample.json');
    const validate = ajv.getSchema(CONTRACT_IDS.event)!;
    const base = { event_id: '3b9d2f5e-7c41-4a8e-9f06-1d2c3b4a5e61', occurred_at: '2026-10-06T09:00:00Z' };
    assert.equal(validate({ events: [{ ...base, type: 'offline_period', data: { started_at: '2026-10-06T09:00:00Z' } }] }), false);
    assert.equal(validate({ events: [{ ...base, type: 'usb_inserted' }] }), false);
    assert.ok(validate({ events: [{ ...base, type: 'future_event', data: { x: 1 } }] }));
    assert.equal(validate({ events: [] }), false);
  });

  it('P5-2:Watchdog 上報請求 / 回應、本機管道 get_status / status、Watchdog 事件類型', () => {
    check(CONTRACT_IDS.watchdog, 'watchdog-report.sample.json');
    check(`${CONTRACT_IDS.watchdog}#/definitions/WatchdogReportResponse`, 'watchdog-report-response.sample.json');
    check(PIPE_ID, 'pipe-get-status.sample.json');
    check(PIPE_ID, 'pipe-status.sample.json');
    const wd = ajv.getSchema(CONTRACT_IDS.watchdog)!;
    const sample = example<Record<string, any>>('watchdog-report.sample.json');
    assert.equal(wd({ ...sample, agent: { ...sample.agent, service_state: 'exploded' } }), false);
    // 事件依類型檢查 data(引用 event.schema.json)
    assert.equal(wd({ ...sample, events: [{ ...sample.events[0], data: { cause: 'oops' } }] }), false);
    assert.equal(wd({ ...sample, events: [{ ...sample.events[1], data: {} }] }), false, 'agent_service_stopped 缺 restarted');
    const { events: _e, ...noEvents } = sample;
    assert.ok(wd(noEvents));
    const pipe = ajv.getSchema(PIPE_ID)!;
    const st = example<Record<string, any>>('pipe-status.sample.json');
    const { pid: _p, ...noPid } = st.body;
    assert.equal(pipe({ ...st, body: noPid }), false);
  });

  it('P6-2:本機管道 prepare_shutdown / ack、status.upgrade_requested', () => {
    check(PIPE_ID, 'pipe-prepare-shutdown.sample.json');
    check(PIPE_ID, 'pipe-prepare-shutdown-ack.sample.json');
    const pipe = ajv.getSchema(PIPE_ID)!;
    const req = example<Record<string, any>>('pipe-prepare-shutdown.sample.json');
    assert.equal(pipe({ ...req, body: { reason: 'whatever' } }), false);
    const ack = example<Record<string, any>>('pipe-prepare-shutdown-ack.sample.json');
    assert.equal(pipe({ ...ack, body: {} }), false, 'ack 缺 flushed');
    const st = example<Record<string, any>>('pipe-status.sample.json');
    assert.equal(pipe({ ...st, body: { ...st.body, upgrade_requested: { id: 'x', component: 'desktop' } } }), false);
  });

  it('P6-3:本機管道 replace_watchdog / ack', () => {
    check(PIPE_ID, 'pipe-replace-watchdog.sample.json');
    check(PIPE_ID, 'pipe-replace-watchdog-ack.sample.json');
    const pipe = ajv.getSchema(PIPE_ID)!;
    const req = example<Record<string, any>>('pipe-replace-watchdog.sample.json');
    assert.equal(pipe({ ...req, body: { ...req.body, sha256: 'XYZ' } }), false, 'sha256 要 64 碼小寫十六進位');
    assert.equal(pipe({ ...req, body: { ...req.body, signer_thumbprints: [] } }), false, '至少一個預期簽章者');
    assert.equal(pipe({ ...req, body: { ...req.body, signer_thumbprints: ['not-a-thumbprint'] } }), false, '指紋 40 碼十六進位');
    const { path: _omit, ...noPath } = req.body;
    assert.equal(pipe({ ...req, body: noPath }), false, '缺 path');
    const ack = example<Record<string, any>>('pipe-replace-watchdog-ack.sample.json');
    assert.equal(pipe({ ...ack, body: {} }), false, 'ack 缺 accepted');
    assert.equal(pipe({ ...ack, body: { accepted: false, error_code: 'SIGNER_NOT_TRUSTED', error_message: '簽章者不在本機清單' } }), true);
    assert.equal(pipe({ ...ack, body: { accepted: false, error_code: '<script>' } }), false, 'error_code 只能是契約內的代碼');
  });

  it('P6:Watchdog 上報帶 upgrade、回應 target;升級事件依類型檢查 data', () => {
    check(CONTRACT_IDS.watchdog, 'watchdog-report-upgrade.sample.json');
    check(`${CONTRACT_IDS.watchdog}#/definitions/WatchdogReportResponse`, 'watchdog-report-response-target.sample.json');
    const resp = ajv.getSchema(`${CONTRACT_IDS.watchdog}#/definitions/WatchdogReportResponse`)!;
    const t = example<Record<string, any>>('watchdog-report-response-target.sample.json');
    assert.equal(resp({ ...t, target: { ...t.target, agent: { ...t.target.agent, url: '/agent/v1/releases/agent/../../etc/passwd' } } }), false, 'url 不可含 ..');
    assert.equal(resp({ ...t, target: { ...t.target, agent: { ...t.target.agent, url: '/agent/v1/releases/agent/../x.exe' } } }), false, '版本段不可為 ..');
    assert.equal(resp({ ...t, target: { ...t.target, agent: { ...t.target.agent, url: '/agent/v1/releases/agent/0.7.1/..' } } }), false, '檔名不可為 ..');
    assert.equal(resp({ ...t, target: { ...t.target, agent: { ...t.target.agent, sha256: 'XYZ' } } }), false);
    assert.equal(resp({ ...t, target: { ...t.target, agent: { ...t.target.agent, signer_thumbprints: [] } } }), false);
    const wd = ajv.getSchema(CONTRACT_IDS.watchdog)!;
    const up = example<Record<string, any>>('watchdog-report-upgrade.sample.json');
    assert.equal(wd({ ...up, upgrade: { ...up.upgrade, state: 'exploded' } }), false);
    assert.equal(wd({ ...up, upgrade: { ...up.upgrade, error_code: 'NOPE' } }), false);
    assert.equal(wd({ ...up, events: [{ ...up.events[0], data: { component: 'agent' } }] }), false, 'upgrade_failed 缺 to');
  });

  it('sync 請求與回應(P2)', () => {
    check(CONTRACT_IDS.sync, 'sync.sample.json');
    check(`${CONTRACT_IDS.sync}#/definitions/SyncResponse`, 'sync-response.sample.json');
  });

  it('WebSocket 信封:hello / hello_ack / heartbeat / heartbeat_ack / unsupported', () => {
    for (const f of ['ws-hello', 'ws-hello-ack', 'ws-heartbeat', 'ws-heartbeat-ack', 'ws-unsupported']) check(CONTRACT_IDS.wsEnvelope, `${f}.sample.json`);
  });

  it('P5:心跳健康摘要、hello 憑證到期日、agent_started 上次結束原因;超出範圍不通過', () => {
    check(CONTRACT_IDS.wsEnvelope, 'ws-heartbeat-health.sample.json');
    const validate = compileWsEnvelope(CONTRACTS_DIR);
    const hb = example<{ body: { health: Record<string, unknown> } }>('ws-heartbeat-health.sample.json');
    assert.equal(validate({ ...hb, body: { ...hb.body, health: { ...hb.body.health, cpu_pct: 101 } } }), false);
    assert.equal(validate({ ...hb, body: { ...hb.body, health: { ...hb.body.health, disk_min_free_pct: 12.5 } } }), false);
    // 舊版 Agent 沒有 health
    check(CONTRACT_IDS.wsEnvelope, 'ws-heartbeat.sample.json');
    const ev = ajv.getSchema(CONTRACT_IDS.event)!;
    const base = { event_id: '3b9d2f5e-7c41-4a8e-9f06-1d2c3b4a5e61', occurred_at: '2026-10-06T09:00:00Z', type: 'agent_started' };
    assert.ok(ev({ events: [{ ...base, data: { agent_version: '0.4.2' } }] }));
    assert.equal(ev({ events: [{ ...base, data: { agent_version: '0.5.0', previous_exit: 'crashed' } }] }), false);
  });

  it('WebSocket 指令(P4):command / command_update / command_update_ack / prepare_shutdown;缺必要欄位、未知 state 不通過', () => {
    for (const f of ['ws-command', 'ws-command-update', 'ws-command-update-ack', 'ws-prepare-shutdown']) check(CONTRACT_IDS.wsEnvelope, `${f}.sample.json`);
    const validate = compileWsEnvelope(CONTRACTS_DIR);
    const cmd = example<{ body: Record<string, unknown> }>('ws-command.sample.json');
    const { expires_at: _e, ...noExpiry } = cmd.body;
    assert.equal(validate({ ...cmd, body: noExpiry }), false);
    assert.equal(validate({ ...cmd, body: { ...cmd.body, kind: 'rm -rf' } }), false);
    const upd = example<{ body: Record<string, unknown> }>('ws-command-update.sample.json');
    assert.equal(validate({ ...upd, body: { ...upd.body, state: 'canceled' } }), false);
    assert.ok(validate({ ...upd, body: { ...upd.body, future: 1 } }));
  });

  it('P4-2:agent.log_level 指令、agent.diagnose / logs.collect 結果、附檔上傳回應', () => {
    for (const f of ['ws-command-log-level', 'ws-command-update-diagnose', 'ws-command-update-logs']) check(CONTRACT_IDS.wsEnvelope, `${f}.sample.json`);
    check(COMMAND_FILE_ID, 'command-file-response.sample.json');
    const validate = ajv.getSchema(COMMAND_FILE_ID)!;
    const sample = example<Record<string, unknown>>('command-file-response.sample.json');
    assert.equal(validate({ ...sample, sha256: 'ABC' }), false);
    const { file_id: _f, ...noId } = sample;
    assert.equal(validate(noId), false);
  });

  it('P7:software.install / uninstall 參數快照、system.reboot 參數、安裝結果與錯誤代碼範例', () => {
    for (const f of [
      'ws-command-software-install',
      'ws-command-software-uninstall',
      'ws-command-system-reboot',
      'ws-command-update-software-install',
      'ws-command-update-software-failed',
    ])
      check(CONTRACT_IDS.wsEnvelope, `${f}.sample.json`);
    // 主機產生的快照欄位與範例一致(Agent 以同一份範例測解析)
    const install = example<{ body: { params: Record<string, unknown> } }>('ws-command-software-install.sample.json').body.params;
    const pkg = {
      packageId: String(install.package_id),
      name: String(install.name),
      version: String(install.version),
      sha256: String(install.sha256),
      sizeBytes: Number(install.size_bytes),
      installerType: install.installer_type,
      installArgs: String(install.install_args),
      uninstallArgs: '',
      detectType: (install.detect as { type: string }).type,
      detectValue: (install.detect as { value: string }).value,
      rebootPolicy: install.reboot_policy,
      signerThumbprints: install.signer_thumbprints,
    } as unknown as PackageRecord;
    assert.deepEqual(installSnapshot(pkg), install);
    const uninstall = example<{ body: { params: Record<string, unknown> } }>('ws-command-software-uninstall.sample.json').body.params;
    assert.deepEqual(uninstallSnapshot(pkg), uninstall);
    assert.deepEqual(argsErrors('installArgs', String(install.install_args)), []);
    assert.equal(paramErrors('system.reboot', example<{ body: { params: unknown } }>('ws-command-system-reboot.sample.json').body.params), null);
    assert.notEqual(paramErrors('system.reboot', { delay_sec: 90000 }), null);
    assert.notEqual(paramErrors('system.reboot', { message: '\u202Eevil' }), null);
    const res = example<{ body: { result: Record<string, unknown> } }>('ws-command-update-software-install.sample.json').body.result;
    assert.match(String(res.signer), /^[0-9a-f]{40}$/);
    assert.ok(JSON.stringify(res).length <= 4000);
  });

  it('相容規則:不認得的欄位與 type 通過信封驗證;已知 type 缺必要欄位不通過', () => {
    const validate = compileWsEnvelope(CONTRACTS_DIR);
    assert.ok(validate({ v: 1, type: 'future_type', id: 'x', body: { anything: 1 } }));
    assert.ok(validate({ ...example('ws-heartbeat.sample.json'), extra: true }));
    assert.equal(validate({ v: 1, type: 'hello', id: 'x', body: { host_name: 'PC' } }), false);
    assert.equal(validate({ v: 2, type: 'heartbeat', id: 'x' }), false);
  });

  it('inventory 多出欄位仍通過(舊版 Server 收新版 Agent);缺少既有欄位不通過', () => {
    const validate = ajv.getSchema(CONTRACT_IDS.inventory)!;
    const sample = example<Record<string, Record<string, unknown>>>('inventory.sample.json');
    assert.ok(validate({ ...sample, future_field: 1, inventory: { ...sample.inventory, future_section: {} } }));
    const { system: _omit, ...noSystem } = sample.inventory!;
    assert.equal(validate({ ...sample, inventory: noSystem }), false);
  });

  it('範例已去識別化(文件用 IP / MAC、EXAMPLE 字樣)', () => {
    const text = JSON.stringify(example('inventory.sample.json'));
    for (const ip of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? [])
      assert.match(ip, /^(192\.0\.2|198\.51\.100|203\.0\.113)\./, `範例含非文件用 IPv4:${ip}`);
    for (const mac of text.match(/\b([0-9A-F]{2}:){5}[0-9A-F]{2}\b/gi) ?? []) assert.match(mac, /^00:00:5E:00:53:/i, `範例含非文件用 MAC:${mac}`);
  });
});
