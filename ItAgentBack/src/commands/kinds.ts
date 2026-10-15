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
  params: Record<string, unknown>;
}

const NO_PARAMS = { type: 'object', additionalProperties: false, properties: {} };
/** 顯示給使用者的文字:不可含控制字元(text 允許換行)與雙向文字控制字元(避免倒轉、偽裝網址) */
const SAFE_TEXT = '^[^\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*$';
const SAFE_LINE = '^[^\\u0000-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*$';
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
