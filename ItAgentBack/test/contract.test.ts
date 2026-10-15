/**
 * 契約測試(AGENT.md §7.3):docs/contracts/examples 的範例必須通過 schema;RustAgent 的 cargo test 吃同一份範例。
 * 改契約時兩邊測試一起更新。
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { CONTRACT_IDS, compileWsEnvelope, loadContract } from '../src/contracts.js';
import { CONTRACTS_DIR, example } from './helpers.js';

const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv) => Ajv;
const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));
for (const name of ['inventory', 'ws-envelope', 'sync', 'event'] as const) ajv.addSchema(loadContract(name, CONTRACTS_DIR));

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
      'event-response.sample.json',
      'event.sample.json',
      'inventory-response.sample.json',
      'inventory.sample.json',
      'sync-response.sample.json',
      'sync.sample.json',
      'ws-command-update-ack.sample.json',
      'ws-command-update.sample.json',
      'ws-command.sample.json',
      'ws-heartbeat-ack.sample.json',
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

  it('sync 請求與回應(P2)', () => {
    check(CONTRACT_IDS.sync, 'sync.sample.json');
    check(`${CONTRACT_IDS.sync}#/definitions/SyncResponse`, 'sync-response.sample.json');
  });

  it('WebSocket 信封:hello / hello_ack / heartbeat / heartbeat_ack / unsupported', () => {
    for (const f of ['ws-hello', 'ws-hello-ack', 'ws-heartbeat', 'ws-heartbeat-ack', 'ws-unsupported']) check(CONTRACT_IDS.wsEnvelope, `${f}.sample.json`);
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
