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
for (const name of ['inventory', 'ws-envelope', 'sync'] as const) ajv.addSchema(loadContract(name, CONTRACTS_DIR));

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
      'inventory-response.sample.json',
      'inventory.sample.json',
      'sync-response.sample.json',
      'sync.sample.json',
      'ws-heartbeat-ack.sample.json',
      'ws-heartbeat.sample.json',
      'ws-hello-ack.sample.json',
      'ws-hello.sample.json',
      'ws-unsupported.sample.json',
    ]);
  });

  it('inventory 請求與回應', () => {
    check(CONTRACT_IDS.inventory, 'inventory.sample.json');
    check(`${CONTRACT_IDS.inventory}#/definitions/InventoryResponse`, 'inventory-response.sample.json');
  });

  it('sync 請求與回應(M5)', () => {
    check(CONTRACT_IDS.sync, 'sync.sample.json');
    check(`${CONTRACT_IDS.sync}#/definitions/SyncResponse`, 'sync-response.sample.json');
  });

  it('WebSocket 信封:hello / hello_ack / heartbeat / heartbeat_ack / unsupported', () => {
    for (const f of ['ws-hello', 'ws-hello-ack', 'ws-heartbeat', 'ws-heartbeat-ack', 'ws-unsupported']) check(CONTRACT_IDS.wsEnvelope, `${f}.sample.json`);
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
