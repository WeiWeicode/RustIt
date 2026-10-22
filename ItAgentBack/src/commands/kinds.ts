/**
 * 指令類型表(docs/contracts/command-kinds.md;ENDPOINT-AGENT-GUIDE §8.3):只開放固定類型,新增時 Agent 與本服務一起發版。
 * 等級決定管理 API 的路徑(basic-commands / admin-commands),由 BFF 檢查權限;本服務檢查類型與路徑等級相符。
 * params 以 JSON Schema 驗證;參數不得含機密(需要機密的動作由主機持有),因此原樣保存於 SQL(重連補送要用)。
 */
import { Ajv, type ValidateFunction } from 'ajv';
import type { CommandLevel } from '../stores/types.js';

export interface CommandKind {
  kind: string;
  level: CommandLevel;
  /** 預設有效期限(秒):Agent 確認收到前超過即 expired */
  expiresSec: number;
  /** 執行逾時(秒):acked 後超過仍未到終態即 failed TIMEOUT */
  timeoutSec: number;
  /** 同一台電腦尚未結束的同類型指令上限(避免洗版、反覆重啟;超過 409 ITA_COMMAND_LIMIT) */
  maxPending?: number;
  /** Agent 可上傳指令附檔(POST /agent/v1/commands/{id}/files;P4-2) */
  files?: boolean;
  params: Record<string, unknown>;
}

const NO_PARAMS = { type: 'object', additionalProperties: false, properties: {} };
/** 顯示給使用者的文字:不可含控制字元(text 允許換行)與雙向文字控制字元(避免倒轉、偽裝網址) */
const SAFE_TEXT = '^[^\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*$';
const SAFE_LINE = '^[^\\u0000-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*$';
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** 軟體派送類型:同時執行的總數受 SOFTWARE_MAX_CONCURRENT 限制(跨批次與單台,P7 §3.1、§8.2-4) */
export const SOFTWARE_KINDS: readonly string[] = ['software.install', 'software.uninstall'];
/** message.show 內文最多行數 */
export const MESSAGE_MAX_LINES = 30;

export const COMMAND_KINDS: readonly CommandKind[] = [
  { kind: 'inventory.collect', level: 'basic', expiresSec: 3600, timeoutSec: 600, params: NO_PARAMS },
  { kind: 'agent.restart', level: 'basic', expiresSec: 3600, timeoutSec: 300, maxPending: 1, params: NO_PARAMS },
  {
    kind: 'message.show',
    level: 'basic',
    expiresSec: 3600,
    timeoutSec: 120,
    maxPending: 3,
    params: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 1000, pattern: SAFE_TEXT },
        title: { type: 'string', minLength: 1, maxLength: 64, pattern: SAFE_LINE },
        timeout_sec: { type: 'integer', minimum: 0, maximum: 3600 },
      },
    },
  },
  // 遠端診斷(PLATFORM-PLAN A4,P4-2):結果小的回 result;日誌以 HTTPS 上傳為指令附檔
  { kind: 'agent.diagnose', level: 'basic', expiresSec: 3600, timeoutSec: 180, maxPending: 1, params: NO_PARAMS },
  {
    kind: 'logs.collect',
    level: 'basic',
    expiresSec: 3600,
    timeoutSec: 900,
    maxPending: 1,
    files: true,
    params: { type: 'object', additionalProperties: false, properties: { days: { type: 'integer', minimum: 1, maximum: 14 } } },
  },
  {
    kind: 'agent.log_level',
    level: 'basic',
    expiresSec: 3600,
    timeoutSec: 60,
    maxPending: 1,
    params: {
      type: 'object',
      additionalProperties: false,
      required: ['level'],
      properties: {
        level: { type: 'string', enum: ['debug', 'trace', 'default'] },
        duration_min: { type: 'integer', minimum: 5, maximum: 1440 },
      },
    },
  },
  // 升級(PLATFORM-PLAN P6;P6-UPGRADE-DESIGN §2.3):交給 Watchdog 立即上報取得目標;指定 version = 這台強制升級 / 降版(建立時由 ReleaseService 檢查與記錄)
  {
    kind: 'agent.upgrade',
    level: 'admin',
    expiresSec: 3600,
    timeoutSec: 300,
    maxPending: 1,
    params: {
      type: 'object',
      additionalProperties: false,
      required: ['component'],
      properties: {
        component: { type: 'string', enum: ['agent', 'watchdog'] },
        version: { type: 'string', pattern: '^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}(?:-[0-9A-Za-z.-]{1,20})?$' },
      },
    },
  },
  // 軟體派送(PLATFORM-PLAN P7;P7-SOFTWARE-DESIGN §2):IT 只送 packageId,建立時由 SoftwareService(kindHook)查目錄、
  // 檢查狀態 / pilot / 授權數,把參數換成目錄快照(Agent 只信任快照)。有效 24 小時(離線太久回來不再執行過期的安裝)
  {
    kind: 'software.install',
    level: 'admin',
    expiresSec: 86400,
    timeoutSec: 4 * 3600,
    maxPending: 3,
    params: {
      type: 'object',
      additionalProperties: false,
      required: ['packageId'],
      properties: {
        packageId: { type: 'string', pattern: UUID },
        // A6:略過電池延後(不略過計量網路;§5.4)
        ignorePower: { type: 'boolean' },
      },
    },
  },
  {
    kind: 'software.uninstall',
    level: 'admin',
    expiresSec: 86400,
    timeoutSec: 3600,
    maxPending: 3,
    params: { type: 'object', additionalProperties: false, required: ['packageId'], properties: { packageId: { type: 'string', pattern: UUID } } },
  },
  // 重新開機(§2.5;Agent 端流程在 P7-3):給使用者儲存工作的時間、訊息同 message.show 的安全文字規則
  {
    kind: 'system.reboot',
    level: 'admin',
    expiresSec: 4 * 3600,
    timeoutSec: 1800,
    maxPending: 1,
    params: {
      type: 'object',
      additionalProperties: false,
      properties: {
        delay_sec: { type: 'integer', minimum: 0, maximum: 86400 },
        message: { type: 'string', minLength: 1, maxLength: 200, pattern: SAFE_LINE },
        force: { type: 'boolean' },
      },
    },
  },
];

/** 建立指令時可覆寫的有效期限範圍(秒) */
export const EXPIRES_MIN_SEC = 60;
export const EXPIRES_MAX_SEC = 86400;

const ajv = new Ajv({ strict: true, allErrors: true });
const validators = new Map<string, ValidateFunction>(COMMAND_KINDS.map((k) => [k.kind, ajv.compile(k.params)]));

export function kindOf(kind: string): CommandKind | undefined {
  return COMMAND_KINDS.find((k) => k.kind === kind);
}

/** 參數驗證錯誤(欄位、訊息);通過回 null */
export function paramErrors(kind: string, params: unknown): { field: string; message: string }[] | null {
  const validate = validators.get(kind);
  if (!validate) return null;
  if (!validate(params))
    return (validate.errors ?? []).map((e) => ({ field: `params${e.instancePath.replace(/\//g, '.')}` || 'params', message: e.message ?? '' }));
  if (kind === 'message.show' && String((params as { text: string }).text).split('\n').length > MESSAGE_MAX_LINES)
    return [{ field: 'params.text', message: `最多 ${MESSAGE_MAX_LINES} 行` }];
  return null;
}
