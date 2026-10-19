/** 部署區設定(RustIt AGENT.md §6):dev 旁路只限 dev、test / prod 機密只接受 _FILE、:51241 必須 TLS 與信任來源 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const dir = mkdtempSync(path.join(tmpdir(), 'ita-config-'));
const file = (name: string, content = 'x') => {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
};

const devEnv = {
  GW_ENV: 'dev',
  SERVICE_CODE: 'endpoint-api',
  GW_BASE_URL: 'https://gw.example',
  ITA_DB_HOST: '127.0.0.1',
  ITA_DB_NAME: 'giganexus_It_Agent_test',
  ITA_DB_USER: 'ita_app',
  ITA_DB_PASSWORD: 'p',
  MONGO_URL: 'mongodb://127.0.0.1:27027',
  REDIS_URL: 'redis://127.0.0.1:6389',
  DEV_TRUST_CLIENT_HEADERS: '1',
};

const testEnv = {
  ...devEnv,
  GW_ENV: 'test',
  DEV_TRUST_CLIENT_HEADERS: undefined,
  ITA_DB_PASSWORD: undefined,
  MONGO_URL: undefined,
  REDIS_URL: undefined,
  GW_API_KEY_FILE: file('gw_api_key'),
  SERVICE_ADVERTISE_URL: 'https://endpoint-server:51240',
  ITA_DB_PASSWORD_FILE: file('db'),
  MONGO_URL_FILE: file('mongo', 'mongodb://mongo:27017'),
  REDIS_URL_FILE: file('redis', 'redis://redis:6379'),
  AGENT_TLS_CERT_FILE: file('crt'),
  AGENT_TLS_KEY_FILE: file('key'),
  AGENT_TRUSTED_PROXIES: '172.16.0.0/12',
  COMMAND_FILES_DIR: '/data/command-files',
  ENDPOINT_SCOPE_ALL_ROLES: 'it-admin',
};

const clean = (e: Record<string, string | undefined>) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;

describe('部署區設定', () => {
  it('dev:可用旁路,Agent 通道為 HTTP,Redis 前綴與 Mongo 資料庫帶部署區', () => {
    const c = loadConfig(clean({ ...devEnv, DEV_SKIP_TOKEN: '1' }));
    assert.equal(c.trustedProxies, null);
    assert.equal(c.devSkipToken, true);
    assert.equal(c.agentTls, null);
    assert.equal(c.redisPrefix, 'ita:dev:');
    assert.equal(c.mongoDb, 'ita_dev');
    assert.equal(c.gateway.project, 'RustIt');
    assert.deepEqual([c.host, c.port, c.agentPort], ['127.0.0.1', 51240, 51241]);
    assert.deepEqual([c.commandFilesDir, c.commandFileKeepDays], ['data/dev/command-files', 14]);
  });

  it('test:機密從 _FILE 讀取,TLS 與信任來源必填', () => {
    const c = loadConfig(clean(testEnv));
    assert.equal(c.mongoUrl, 'mongodb://mongo:27017');
    assert.deepEqual(c.trustedProxies, ['172.16.0.0/12']);
    assert.ok(c.agentTls);
    assert.equal(c.redisPrefix, 'ita:test:');
    assert.equal(c.host, '0.0.0.0');
  });

  it('非 dev 設定任一 dev 旁路即啟動失敗', () => {
    assert.throws(() => loadConfig(clean({ ...testEnv, DEV_TRUST_CLIENT_HEADERS: '1' })), /DEV_TRUST_CLIENT_HEADERS 只能在 GW_ENV=dev/);
    assert.throws(() => loadConfig(clean({ ...testEnv, DEV_SKIP_TOKEN: '0' })), /DEV_SKIP_TOKEN 只能在 GW_ENV=dev/);
  });

  it('test / prod 不接受明文密碼與連線字串', () => {
    assert.throws(() => loadConfig(clean({ ...testEnv, ITA_DB_PASSWORD_FILE: undefined, ITA_DB_PASSWORD: 'p' })), /ITA_DB_PASSWORD_FILE/);
    assert.throws(() => loadConfig(clean({ ...testEnv, MONGO_URL_FILE: undefined, MONGO_URL: 'mongodb://x' })), /MONGO_URL_FILE/);
  });

  it('缺少必要設定時啟動失敗,不套預設值', () => {
    assert.throws(() => loadConfig(clean({ ...testEnv, AGENT_TLS_CERT_FILE: undefined })), /AGENT_TLS_CERT_FILE/);
    assert.throws(() => loadConfig(clean({ ...testEnv, AGENT_TRUSTED_PROXIES: undefined })), /AGENT_TRUSTED_PROXIES/);
    assert.throws(() => loadConfig(clean({ ...devEnv, DEV_TRUST_CLIENT_HEADERS: undefined })), /AGENT_TRUSTED_PROXIES/);
    assert.throws(() => loadConfig(clean({ ...devEnv, ITA_DB_HOST: undefined })), /ITA_DB_HOST/);
    assert.throws(() => loadConfig(clean({ ...devEnv, PORT: '8080' })), /51200–51300/);
    assert.throws(() => loadConfig(clean({ ...testEnv, COMMAND_FILES_DIR: undefined })), /COMMAND_FILES_DIR/);
  });

  it('指令附檔保存天數只能 14–30(PLATFORM-PLAN B5)', () => {
    assert.equal(loadConfig(clean({ ...testEnv, COMMAND_FILE_KEEP_DAYS: '30' })).commandFileKeepDays, 30);
    assert.throws(() => loadConfig(clean({ ...testEnv, COMMAND_FILE_KEEP_DAYS: '7' })), /COMMAND_FILE_KEEP_DAYS/);
    assert.throws(() => loadConfig(clean({ ...testEnv, COMMAND_FILE_KEEP_DAYS: '31' })), /COMMAND_FILE_KEEP_DAYS/);
  });

  it('監測(P5):健康摘要預設開、告警門檻預設值;磁碟關閉門檻不可低於開啟門檻', () => {
    const c = loadConfig(clean(testEnv));
    assert.equal(c.agentSettings.health_enabled, true);
    assert.deepEqual(c.alertThresholds, { offlineDays: 7, diskFreePct: 10, diskClearPct: 15, restarts24h: 3, certDays: 30, silentMin: 15 });
    assert.equal(loadConfig(clean({ ...testEnv, AGENT_HEALTH_ENABLED: '0' })).agentSettings.health_enabled, false);
    // 只調高開啟門檻時,關閉門檻至少等於開啟門檻
    assert.equal(loadConfig(clean({ ...testEnv, ALERT_DISK_FREE_PCT: '20' })).alertThresholds.diskClearPct, 20);
    assert.throws(() => loadConfig(clean({ ...testEnv, ALERT_DISK_FREE_PCT: '20', ALERT_DISK_CLEAR_PCT: '10' })), /ALERT_DISK_CLEAR_PCT/);
    assert.throws(() => loadConfig(clean({ ...testEnv, ALERT_OFFLINE_DAYS: '0' })), /ALERT_OFFLINE_DAYS/);
  });

  it('資料範圍(E6):test / prod 必須設定全部公司角色(可為空字串),dev 預設空', () => {
    assert.throws(() => loadConfig(clean({ ...testEnv, ENDPOINT_SCOPE_ALL_ROLES: undefined })), /ENDPOINT_SCOPE_ALL_ROLES 未設定/);
    assert.deepEqual(loadConfig(clean({ ...testEnv, ENDPOINT_SCOPE_ALL_ROLES: '' })).scopeAllRoles, []);
    assert.deepEqual(loadConfig(clean({ ...testEnv, ENDPOINT_SCOPE_ALL_ROLES: ' it-admin , endpoint-all,it-admin' })).scopeAllRoles, ['it-admin', 'endpoint-all']);
    assert.deepEqual(loadConfig(clean(devEnv)).scopeAllRoles, []);
  });

  it('網域 → 公司對應(E6):格式錯誤、名稱過長、同一網域兩家公司即啟動失敗', () => {
    const c = loadConfig(clean({ ...testEnv, ENDPOINT_COMPANY_DOMAINS: '碩禾=gsc.com.tw, GSMC.com.tw;鹽城碩禾=ygdmc.gsc.com.tw;' }));
    assert.deepEqual([...c.companyDomains], [
      ['gsc.com.tw', '碩禾'],
      ['gsmc.com.tw', '碩禾'],
      ['ygdmc.gsc.com.tw', '鹽城碩禾'],
    ]);
    assert.equal(loadConfig(clean(testEnv)).companyDomains.size, 0);
    for (const bad of ['碩禾', '=gsc.com.tw', '碩禾=gsc', '碩禾=a..b', `${'公'.repeat(21)}=gsc.com.tw`, '碩禾=gsc.com.tw;禾迅=GSC.com.tw'])
      assert.throws(() => loadConfig(clean({ ...testEnv, ENDPOINT_COMPANY_DOMAINS: bad })), /ENDPOINT_COMPANY_DOMAINS 格式錯誤/, bad);
  });
});
