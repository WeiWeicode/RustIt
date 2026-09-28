// 報修單與公告的模擬資料（只存在記憶體，關閉即消失）

export const CATEGORIES = [
  { id: 'hw', label: '硬體', assignee: 'IT 陳志明' },
  { id: 'sw', label: '軟體', assignee: 'IT 林雅婷' },
  { id: 'net', label: '網路', assignee: 'IT 張家豪' },
  { id: 'acct', label: '帳號 / 權限', assignee: 'IT 林雅婷' },
  { id: 'other', label: '其他', assignee: 'IT 陳志明' },
];

export const URGENCIES = [
  { id: 'low', label: '低', sla: 72 },
  { id: 'normal', label: '一般', sla: 24 },
  { id: 'high', label: '高', sla: 8 },
  { id: 'critical', label: '緊急', sla: 4 },
];

/** 報修單狀態（PRD 4.1）。`step` 是進度條上的位置；等待零件與處理中同一格。 */
export const STATUS = {
  new: { label: '新建', tone: 'info', step: 0 },
  assigned: { label: '已指派', tone: 'info', step: 1 },
  working: { label: '處理中', tone: 'warn', step: 2 },
  parts: { label: '等待零件', tone: 'muted', step: 2 },
  confirm: { label: '待使用者確認', tone: 'violet', step: 3 },
  closed: { label: '結案', tone: 'good', step: 4 },
};
export const STEP_LABELS = ['新建', '已指派', '處理中', '待確認', '結案'];

export const category = (id) => CATEGORIES.find((c) => c.id === id);
export const urgency = (id) => URGENCIES.find((u) => u.id === id);

const HOUR = 3600e3;
const DAY = 24 * HOUR;

export function dueOf(t) {
  return new Date(t.created.getTime() + urgency(t.urgency).sla * HOUR);
}

/** 回傳 { tone, text } */
export function slaOf(t) {
  if (t.status === 'closed') return { tone: 'good', text: '已結案' };
  if (t.status === 'parts') return { tone: 'muted', text: '暫停計時' };
  const left = dueOf(t) - Date.now();
  if (left < 0) return { tone: 'bad', text: `逾時 ${Math.ceil(-left / HOUR)} 小時` };
  const h = Math.floor(left / HOUR);
  const m = Math.floor((left % HOUR) / 60e3);
  return { tone: h < 2 ? 'warn' : 'good', text: `剩 ${h} 小時 ${m} 分` };
}

const log = (t, text) => t.log.push({ at: new Date(), text });

/** 模擬 IT 處理下一步 */
export function advance(t) {
  const next = {
    new: ['assigned', `系統依類別指派給 ${t.assignee}`],
    assigned: ['working', `${t.assignee} 開始處理`],
    working: ['confirm', `${t.assignee} 已處理完成，請確認`],
    parts: ['working', '零件已到貨，繼續處理'],
  }[t.status];
  if (!next) return;
  t.status = next[0];
  log(t, next[1]);
}
export function waitParts(t) { t.status = 'parts'; log(t, '等待零件 / 廠商，SLA 暫停計時'); }
export function confirmClose(t) { t.status = 'closed'; log(t, '使用者確認結案'); }
export function reject(t) { t.status = 'working'; log(t, `使用者退回，通知 ${t.assignee}`); }

export function newTicket(id, draft, attachment) {
  const now = new Date();
  const t = {
    id,
    title: draft.title.trim(),
    category: draft.category,
    urgency: draft.urgency,
    description: draft.description.trim(),
    status: 'new',
    assignee: category(draft.category).assignee,
    created: now,
    attachment: draft.attach ? attachment : [],
    log: [{ at: now, text: '使用者建立報修單' }],
    rating: 0,
  };
  advance(t);
  return t;
}

export function sampleTickets(attachment) {
  const now = Date.now();
  const printer = {
    id: 1001,
    title: '3F 事務機無法列印',
    category: 'hw',
    urgency: 'normal',
    description: '送出列印後一直顯示「等待中」，重新開機也一樣。',
    status: 'working',
    assignee: 'IT 陳志明',
    created: new Date(now - 5 * HOUR),
    attachment,
    log: [
      { at: new Date(now - 5 * HOUR), text: '使用者建立報修單' },
      { at: new Date(now - 5 * HOUR + 60e3), text: '系統依類別指派給 IT 陳志明' },
      { at: new Date(now - 4 * HOUR), text: 'IT 陳志明 開始處理' },
    ],
    rating: 0,
  };
  const visio = {
    id: 1000,
    title: '申請安裝 Visio',
    category: 'sw',
    urgency: 'low',
    description: '專案需要畫流程圖，申請安裝 Visio。',
    status: 'closed',
    assignee: 'IT 林雅婷',
    created: new Date(now - 3 * DAY),
    attachment,
    log: [
      { at: new Date(now - 3 * DAY), text: '使用者建立報修單' },
      { at: new Date(now - 3 * DAY + 60e3), text: '系統依類別指派給 IT 林雅婷' },
      { at: new Date(now - 2 * DAY), text: '已透過 Agent 派送安裝' },
      { at: new Date(now - 2 * DAY + 3 * HOUR), text: '使用者確認結案' },
    ],
    rating: 5,
  };
  return [printer, visio];
}

export function sampleAnnouncements() {
  const now = Date.now();
  return [
    {
      id: 'erp',
      title: '【系統維護】本週六 22:00–24:00 ERP 停機維護',
      body: '維護期間 ERP 與請購系統暫停服務，請提前完成當日單據。\n如有緊急需求請洽 IT 分機 1234。',
      author: 'IT 林雅婷',
      audience: '全公司',
      published: new Date(now - 3 * HOUR),
      mustAck: true,
      read: false,
    },
    {
      id: 'phish',
      title: '資安宣導：近期出現假冒人資的釣魚郵件',
      body: '主旨為「年終獎金調整通知」的郵件為釣魚信，請勿點擊連結或開啟附件。\n若已點擊，請立即通報 IT。',
      author: 'IT 張家豪',
      audience: '全公司',
      published: new Date(now - DAY),
      mustAck: false,
      read: false,
    },
    {
      id: 'agent',
      title: 'RustIt 資產管理 Agent 上線通知',
      body: 'IT 將於下週起分批安裝 RustIt Agent，用於資產盤點、報修與遠端協助。\nAgent 不會蒐集檔案內容、螢幕畫面或鍵盤輸入。',
      author: 'IT 陳志明',
      audience: '全公司',
      published: new Date(now - 4 * DAY),
      mustAck: false,
      read: true,
    },
  ];
}
