// 格式化與小工具

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 所有來自電腦或使用者的文字都必須經過 esc 才能放進 HTML。 */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const dash = (s) => (s === undefined || s === null || s === '' ? '—' : s);

export function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${units[u]}`;
}

export function duration(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d} 天 ${h} 小時 ${m} 分` : `${h} 小時 ${m} 分`;
}

const pad = (n) => String(n).padStart(2, '0');
export const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const fmtDateTime = (d) => `${fmtDate(d)} ${fmtTime(d)}`;
export const fmtShort = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${fmtTime(d)}`;

export function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早安';
  if (h < 13) return '午安';
  if (h < 18) return '午安';
  return '晚安';
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 數字由 0 滾動到目標值（ease-out）。 */
export function countUp(el, to, format = (v) => Math.round(v), ms = 1100) {
  const start = performance.now();
  const step = (now) => {
    const t = clamp((now - start) / ms, 0, 1);
    const e = 1 - Math.pow(1 - t, 4);
    el.textContent = format(to * e);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 用量對應顏色等級。 */
export const level = (pct) => (pct < 60 ? '' : pct < 85 ? 'warn' : 'bad');
