import { icon } from './icons.js';
import { esc, bytes, duration, fmtShort, clamp } from './util.js';
import * as M from './mock.js';
import * as Pages from './pages.js';
import { devApi } from './devdata.js';

// ------------------------------------------------------------ 後端（Tauri）或瀏覽器預覽用的假資料

const T = window.__TAURI__;
const api = T
  ? {
      collect: () => T.core.invoke('collect'),
      live: () => T.core.invoke('live_stats'),
      exportJson: () => T.core.invoke('export_json'),
      reveal: (path) => T.core.invoke('reveal_file', { path }),
      openRustDesk: () => T.core.invoke('open_rustdesk'),
      deployCatalog: () => T.core.invoke('deploy_catalog'),
      deployInstall: (ids) => T.core.invoke('deploy_install', { ids }),
      deployUninstall: (id) => T.core.invoke('deploy_uninstall', { id }),
      onDeploy: (cb) => T.event.listen('deploy-progress', (e) => cb(e.payload)),
      win: T.window.getCurrentWindow(),
    }
  : devApi;

// ------------------------------------------------------------ 狀態

const state = {
  page: 'overview',
  snap: null,
  collecting: false,
  collectedAt: null,
  cpuHist: [],
  tickets: [],
  anns: M.sampleAnnouncements(),
  draft: { title: '', category: 'hw', urgency: 'normal', description: '', attach: true },
  attachment: [],
  selectedTicket: 1001,
  swFilter: '',
  consent: 'ask',
  ackShown: false,
  lastExport: null,
  // 軟體派送：catalog 來自後端；tasks 以軟體 id 為鍵，記錄最近一次進度事件
  deploy: { catalog: null, selected: new Set(), tasks: {}, log: [] },
};

const NAV = [
  ['overview', 'home', '總覽'],
  ['hardware', 'cpu', '硬體資訊'],
  ['network', 'globe', '網路'],
  ['software', 'apps', '已安裝軟體'],
  ['deploy', 'download', '軟體派送'],
  ['security', 'shield', '安全與控管'],
  ['tickets', 'lifebuoy', '報修單'],
  ['announcements', 'megaphone', '公告'],
  ['remote', 'remote', '遠端協助'],
  ['about', 'info', '功能說明'],
];
const NEEDS_DATA = new Set(['overview', 'hardware', 'network', 'software', 'security', 'tickets', 'remote']);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------ 外框

function buildShell() {
  $('#nav').innerHTML =
    '<span class="nav-pill" id="nav-pill"></span>' +
    NAV.map(([id, ico, label]) => `<a class="nav-item" data-action="goto" data-page="${id}">${icon(ico)}<span>${label}</span><b class="badge" data-badge="${id}"></b></a>`).join('');
  $('#btn-min').innerHTML = icon('min');
  $('#btn-max').innerHTML = icon('max');
  $('#btn-close').innerHTML = icon('close');
  $('#btn-refresh').innerHTML = `${icon('refresh')}<span>重新蒐集</span>`;
  $('#btn-export').innerHTML = `${icon('download')}<span>匯出</span>`;
  $('#foot-note').innerHTML = `
    <div class="perf" id="perf">
      <div class="perf-head">${icon('pulse')}效能模式</div>
      <div class="segmented sm"><span class="thumb"></span>
        <button data-action="perf-set" data-v="auto">自動</button>
        <button data-action="perf-set" data-v="full">完整</button>
        <button data-action="perf-set" data-v="lite">精簡</button>
      </div>
      <div class="perf-note"></div>
    </div>
    <div class="demo-note"><span class="pill-note">${icon('shield', 'width="13" height="13"')}Demo 模式</span><br>資料只存在記憶體，不會寫入資料庫</div>`;
  applyTheme(currentTheme());
}

function currentTheme() {
  try {
    const saved = localStorage.getItem('rustit-theme');
    if (saved) return saved;
  } catch { /* 私密模式等情況讀不到 */ }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#btn-theme').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  $('#btn-theme').title = theme === 'dark' ? '切換為淺色' : '切換為深色';
}

/** 液態選取膠囊移到目前頁面，移動時帶果凍形變。 */
function movePill(animate = true) {
  const item = $(`.nav-item[data-page="${state.page}"]`);
  const pill = $('#nav-pill');
  if (!item || !pill) return;
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el === item));
  pill.style.setProperty('--y', `${item.offsetTop}px`);
  if (animate) {
    pill.classList.remove('jelly');
    void pill.offsetWidth;
    pill.classList.add('jelly');
  }
}

function updateBadges() {
  const unread = state.anns.filter((a) => !a.read).length;
  const open = state.tickets.filter((t) => t.status !== 'closed').length;
  const set = (id, n) => {
    const el = $(`[data-badge="${id}"]`);
    if (el && el.textContent !== String(n || '')) el.textContent = n || '';
  };
  set('announcements', unread);
  set('tickets', open);
  set('deploy', Object.values(state.deploy.tasks).filter(Pages.isActive).length);
}

function updateTopbar() {
  const s = state.snap;
  $('#host-chip').innerHTML = s
    ? `<span class="dot"></span><b>${esc(s.info.system.host_name)}</b><span>${esc(s.info.system.user_name)}</span>`
    : '<span class="dot" style="background:var(--warn);box-shadow:0 0 10px var(--warn)"></span><span>蒐集中…</span>';
  $('#collect-time').textContent = state.collecting
    ? '蒐集中…'
    : s ? `蒐集於 ${fmtShort(state.collectedAt)} · ${s.info.collect_ms} ms` : '';
  $('#btn-refresh').disabled = state.collecting;
  $('#btn-refresh').classList.toggle('spin', state.collecting);
  $('#btn-export').disabled = !s;
}

// ------------------------------------------------------------ 頁面

function pageHtml() {
  if (NEEDS_DATA.has(state.page) && !state.snap) return Pages.loading();
  switch (state.page) {
    case 'overview': return Pages.overview(state);
    case 'hardware': return Pages.hardware(state);
    case 'network': return Pages.network(state);
    case 'software': return Pages.software(state);
    case 'security': return Pages.security(state);
    case 'tickets': return Pages.tickets(state);
    case 'announcements': return Pages.announcements(state);
    case 'remote': return Pages.remote(state);
    case 'deploy': return Pages.deploy(state);
    default: return Pages.about(state);
  }
}

/** animate=false 用於同一頁內的狀態更新，不重播進場動畫。 */
function render(animate = true) {
  const page = $('#page');
  page.classList.toggle('static', !animate);
  page.innerHTML = pageHtml();
  afterRender();
  updateBadges();
}

function afterRender() {
  if (state.page === 'overview' && state.snap) {
    // 下一個 frame 再設定數值，圓環才會從 0 轉到目標值。
    requestAnimationFrame(() => {
      paintLive();
      paintSpark();
    });
  }
  if (state.page === 'software' && state.snap) paintSoftware();
  if (state.page === 'deploy' && !state.deploy.catalog) loadCatalog();
  requestAnimationFrame(() => $$('.segmented').forEach((seg) => placeThumb(seg, false)));
}

let navToken = 0;
function navigate(page) {
  if (page === state.page) return;
  state.page = page;
  movePill(true);
  shiftAurora();
  const el = $('#page');
  const token = ++navToken;
  el.classList.add('leaving');
  setTimeout(() => {
    if (token !== navToken) return;
    el.classList.remove('leaving');
    $('#content').scrollTop = 0;
    render(true);
  }, 170);
}

// 分段控制的滑動膠囊
function placeThumb(seg, animate = true) {
  const on = $('button.on', seg);
  const thumb = $('.thumb', seg);
  if (!on || !thumb) { if (thumb) thumb.style.opacity = 0; return; }
  thumb.style.opacity = 1;
  if (!animate) thumb.style.transition = 'none';
  thumb.style.setProperty('--tx', `${on.offsetLeft}px`);
  thumb.style.setProperty('--tw', `${on.offsetWidth}px`);
  if (!animate) { void thumb.offsetWidth; thumb.style.transition = ''; }
  else { thumb.classList.remove('jelly'); void thumb.offsetWidth; thumb.classList.add('jelly'); }
}

function selectSeg(btn) {
  const seg = btn.closest('.segmented');
  $$('button', seg).forEach((b) => b.classList.toggle('on', b === btn));
  placeThumb(seg, true);
}

// ------------------------------------------------------------ 資料

/** silent：背景更新資料（例如安裝完成後），不重播動畫也不跳提示。 */
async function collect({ silent = false } = {}) {
  if (state.collecting) return;
  state.collecting = true;
  updateTopbar();
  if (silent) {
    try {
      state.snap = await api.collect();
      state.collectedAt = new Date();
    } catch { /* 背景更新失敗就維持舊資料 */ }
    state.collecting = false;
    updateTopbar();
    if (NEEDS_DATA.has(state.page) && !['tickets', 'deploy'].includes(state.page)) render(false);
    return;
  }
  try {
    const snap = await api.collect();
    state.snap = snap;
    state.collectedAt = new Date();
    const sys = snap.info.system;
    state.attachment = [
      ['電腦名稱', sys.host_name],
      ['IP', snap.primary_ip ?? '—'],
      ['資產識別碼', snap.asset_key],
      ['登入者', sys.user_name],
      ['作業系統', sys.os_name],
    ];
    if (!state.tickets.length) state.tickets = M.sampleTickets(state.attachment);
    state.collecting = false;
    updateTopbar();
    detectLowEnd(); // 有了記憶體與顯示卡資訊，再判斷一次
    render(true);
    probeFps();
    if (snap.hardware_changes) {
      const [a, r] = snap.hardware_changes;
      toast(a.length || r.length ? `偵測到硬體變更：新增 ${a.length}、移除 ${r.length}` : '重新蒐集完成，硬體沒有變更');
    }
    if (!state.ackShown) {
      state.ackShown = true;
      setTimeout(showMustAck, 900);
    }
  } catch (e) {
    state.collecting = false;
    updateTopbar();
    toast(`蒐集失敗：${e}`, false);
  }
}

let liveBusy = false;
let lastLive = null;
async function tickLive() {
  if (liveBusy || paused) return;
  liveBusy = true;
  try {
    lastLive = await api.live();
    state.cpuHist.push(lastLive.cpu);
    if (state.cpuHist.length > 60) state.cpuHist.shift();
    if (state.page === 'overview' && state.snap) {
      paintLive(false);
      paintSpark();
    }
  } catch { /* 忽略單次失敗 */ }
  liveBusy = false;
}

function setRing(id, pct, foot) {
  const ring = $(`#ring-${id}`);
  if (!ring) return;
  const f = ring.parentElement.querySelector('[data-foot]');
  if (f && foot && f.textContent !== foot) f.textContent = foot;
  // 變化不到 0.5% 就不動畫面，避免每秒都重繪
  const first = ring.dataset.pct === undefined;
  const last = Number(ring.dataset.pct ?? -1);
  if (Math.abs(pct - last) < 0.5) return;
  ring.dataset.pct = pct;
  // 只有進入頁面時從 0 轉到目前值；之後每秒直接更新。
  // 實測每秒播放過渡與數字滾動，會讓 CPU 從約 0.2% 升到 6%。
  ring.classList.toggle('instant', !first);
  const bar = $('.bar', ring);
  const c = parseFloat(bar.getAttribute('stroke-dasharray'));
  const offset = c * (1 - clamp(pct, 0, 100) / 100);
  bar.style.strokeDashoffset = offset;
  $('.glow', ring).style.strokeDashoffset = offset;
  const num = $('[data-num]', ring);
  const target = Math.round(pct);
  if (!first) {
    num.textContent = target;
    return;
  }
  const from = Number(num.textContent) || 0;
  if (from !== target) {
    const start = performance.now();
    const step = (now) => {
      const t = clamp((now - start) / 700, 0, 1);
      num.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

function paintLive() {
  if (!lastLive) return;
  const l = lastLive;
  setRing('cpu', l.cpu, `${state.snap.info.cpu.logical} 執行緒`);
  setRing('mem', (l.mem_used / l.mem_total) * 100, `${bytes(l.mem_used)} / ${bytes(l.mem_total)}`);
  const vol = state.snap.info.volumes.find((v) => v.mount_point.toUpperCase().startsWith('C:')) ?? state.snap.info.volumes[0];
  if (vol) setRing('disk', ((vol.total - vol.available) / vol.total) * 100, `可用 ${bytes(vol.available)}`);
  setText('#uptime', duration(l.uptime));
  if (state.cpuHist.length) setText('#cpu-peak', `${Math.max(...state.cpuHist).toFixed(0)}%`);
}

/** 文字沒變就不寫入 DOM，避免無謂的重繪。 */
function setText(sel, text) {
  const el = $(sel);
  if (el && el.textContent !== text) el.textContent = text;
}

/** 平滑曲線（Catmull-Rom → Bézier），每秒直接替換路徑，不做補間動畫。 */
function paintSpark() {
  const line = $('#spark-line');
  const area = $('#spark-area');
  if (!line) return;
  const W = 300, H = 110, N = 60;
  const h = state.cpuHist;
  const vals = Array.from({ length: N }, (_, i) => {
    const k = i - (N - h.length);
    return k >= 0 ? h[k] : (h[0] ?? 0);
  });
  const pts = vals.map((v, i) => [(i / (N - 1)) * W, H - 6 - (clamp(v, 0, 100) / 100) * (H - 14)]);
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < N - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(N - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  line.style.d = `path("${d}")`;
  area.style.d = `path("${d} L ${W} ${H} L 0 ${H} Z")`;
}

function paintSoftware() {
  const { html, count } = Pages.softwareRows(state);
  $('#sw-rows').innerHTML = html;
  const c = $('#sw-count');
  if (c) c.textContent = state.swFilter ? `顯示 ${count} / ${state.snap.info.software.length} 項` : `共 ${count} 項`;
}

// ------------------------------------------------------------ 軟體派送

async function loadCatalog() {
  try {
    state.deploy.catalog = await api.deployCatalog();
    // 已安裝或已不存在的軟體不能再被勾選
    for (const id of [...state.deploy.selected]) {
      const c = state.deploy.catalog.find((x) => x.id === id);
      if (!c || c.installed) state.deploy.selected.delete(id);
    }
  } catch (e) {
    toast(`讀取軟體目錄失敗：${e}`, false);
    return;
  }
  if (state.page === 'deploy') render(false);
}

/** 只更新單一卡片與下方操作列，避免下載進度每 0.1 秒重繪整頁。 */
function paintDeploy(id) {
  if (state.page !== 'deploy') return;
  const c = state.deploy.catalog?.find((x) => x.id === id);
  const card = $(`#dep-${id}`);
  if (c && card) {
    card.className = `glass tile dep-card ${Pages.cardClass(state, c)}`;
    $(`#dep-status-${id}`).innerHTML = Pages.deployStatus(state, c);
  }
  const bar = $('#dep-bar');
  if (bar) bar.innerHTML = Pages.deployBar(state);
  const log = $('#dep-log');
  if (log) log.innerHTML = Pages.deployLog(state);
}

const STAGE_LOG = {
  queued: ['排入派送佇列', 'muted'],
  downloading: ['開始下載', 'info'],
  verifying: ['驗證數位簽章', 'info'],
  elevating: ['等待 UAC 確認', 'warn'],
  running: ['靜默執行中', 'info'],
  checking: ['確認結果', 'info'],
};

function onDeployProgress(p) {
  const d = state.deploy;
  const prev = d.tasks[p.id];
  d.tasks[p.id] = p;
  const name = d.catalog?.find((c) => c.id === p.id)?.name ?? p.id;
  const verb = p.action === 'install' ? '安裝' : '移除';
  const terminal = ['done', 'failed', 'cancelled'].includes(p.stage);

  if (terminal) {
    const tone = p.stage === 'done' ? 'good' : p.stage === 'cancelled' ? 'warn' : 'bad';
    d.log.push({ at: new Date(), name, text: p.message, tone });
    toast(`${name}：${p.message}`, p.stage === 'done');
    // 重新偵測安裝狀態（會重繪卡片），再讓卡片閃一下成功 / 失敗的光暈
    loadCatalog().then(() => {
      const card = state.page === 'deploy' && $(`#dep-${p.id}`);
      if (card) card.classList.add(p.stage === 'done' ? 'flash-good' : 'flash-bad');
    });
    // 背景更新電腦資料（軟體清單、總覽的數字）
    collect({ silent: true });
  } else if (!prev || prev.stage !== p.stage || prev.action !== p.action) {
    const [text, tone] = STAGE_LOG[p.stage] ?? [p.message, 'muted'];
    d.log.push({ at: new Date(), name, text: `${verb}：${text}`, tone });
  }
  if (d.log.length > 60) d.log.splice(0, d.log.length - 60);
  paintDeploy(p.id);
  updateBadges();
}

/** 會真的安裝軟體，所以一定要先確認。 */
async function confirmDeploy(ids) {
  const items = (state.deploy.catalog ?? []).filter((c) => ids.includes(c.id) && !c.installed);
  if (!items.length) return;
  const choice = await modal({
    html: `
      <div class="kicker" style="color:var(--info)">${icon('download')}開始派送</div>
      <h2>要安裝 ${items.length} 個軟體到這台電腦嗎？</h2>
      <div class="meta">${items.map((c) => esc(c.name)).join('、')}</div>
      <div class="body">將從原廠網站下載、驗證數位簽章後靜默安裝，每個軟體安裝前 Windows 都會跳出 UAC 確認，按「否」可以取消該項。</div>`,
    buttons: [
      { id: 'cancel', label: '取消' },
      { id: 'ok', label: '開始安裝', cls: 'primary', icon: 'download' },
    ],
  });
  if (choice === 'ok') startDeploy(items.map((c) => c.id));
}

async function startDeploy(ids) {
  const d = state.deploy;
  const todo = ids.filter((id) => {
    const c = d.catalog?.find((x) => x.id === id);
    return c && !c.installed && !Pages.isActive(d.tasks[id]);
  });
  if (!todo.length) return;
  todo.forEach((id) => d.selected.delete(id));
  try {
    await api.deployInstall(todo);
  } catch (e) {
    toast(`派送失敗：${e}`, false);
  }
}

// ------------------------------------------------------------ 彈窗與提示

function toast(text, ok = true) {
  const el = document.createElement('div');
  el.className = 'toast glass liquid';
  el.innerHTML = `<span class="t-ico ${ok ? '' : 'err'}">${icon(ok ? 'check' : 'x')}</span><span class="t-text">${esc(text)}</span>`;
  $('#toast-root').append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  }, 3600);
}

/** 開啟玻璃彈窗；回傳被按下的按鈕 id（點背景關閉時為 null）。 */
function modal({ html, buttons, dismissable = true }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal glass liquid">${html}<div class="actions">${buttons
      .map((b) => `<button class="btn ${b.cls ?? ''}" data-modal="${b.id}">${b.icon ? icon(b.icon) : ''}${esc(b.label)}</button>`)
      .join('')}</div></div>`;
    const close = (id) => {
      back.classList.add('closing');
      back.addEventListener('animationend', () => back.remove(), { once: true });
      // 動畫沒跑完（例如視窗在背景）也要移除，免得留下擋住點擊的遮罩
      setTimeout(() => back.remove(), 400);
      resolve(id);
    };
    back.addEventListener('click', (e) => {
      const b = e.target.closest('[data-modal]');
      if (b) close(b.dataset.modal);
      else if (dismissable && e.target === back) close(null);
    });
    $('#modal-root').append(back);
  });
}

async function showMustAck() {
  const a = state.anns.find((x) => x.mustAck && !x.read);
  if (!a) return;
  await modal({
    dismissable: false,
    html: `
      <div class="kicker">${icon('megaphone')}重要公告</div>
      <h2>${esc(a.title)}</h2>
      <div class="meta">${esc(a.author)} · ${fmtShort(a.published)}</div>
      <div class="body">${esc(a.body)}</div>`,
    buttons: [{ id: 'ok', label: '我已閱讀', cls: 'primary', icon: 'check' }],
  });
  a.read = true;
  updateBadges();
  if (state.page === 'announcements' || state.page === 'overview') render(false);
}

async function remoteRequest(ticketId) {
  if (state.consent === 'auto') {
    toast('免同意模式：IT 已直接連線（Demo 未實際建立連線）');
    return;
  }
  const choice = await modal({
    dismissable: false,
    html: `
      <div class="avatar">${icon('remote')}</div>
      <h2>IT 陳志明 要求遠端連線</h2>
      <div class="meta">關聯工單 #${ticketId ?? 1001} · 透過公司 RustDesk 伺服器</div>
      <div class="body">允許後，IT 人員可以看到並操作您的畫面。連線期間畫面上方會持續顯示提示，您可以隨時中斷。</div>`,
    buttons: [
      { id: 'deny', label: '拒絕', icon: 'x' },
      { id: 'allow', label: '允許連線', cls: 'good', icon: 'check' },
    ],
  });
  toast(choice === 'allow' ? '已允許遠端連線（Demo 未實際建立連線）' : '已拒絕遠端連線，IT 會收到通知', choice === 'allow');
}

// ------------------------------------------------------------ 動作

const selectedTicket = () => state.tickets.find((t) => t.id === state.selectedTicket);
const refreshTickets = () => render(false);

const actions = {
  goto: (el) => navigate(el.dataset.page),
  'win-min': () => api.win?.minimize(),
  'win-max': () => api.win?.toggleMaximize(),
  'win-close': () => api.win?.close(),
  theme: () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('rustit-theme', next); } catch { /* 忽略 */ }
    applyTheme(next);
  },
  refresh: () => collect(),
  export: async () => {
    try {
      const path = await api.exportJson();
      state.lastExport = path;
      toast(`已匯出：${path}`);
      api.reveal(path).catch(() => {});
    } catch (e) {
      toast(`匯出失敗：${e}`, false);
    }
  },
  'set-cat': (el) => {
    state.draft.category = el.dataset.v;
    $$('.chips-select button').forEach((b) => b.classList.toggle('on', b === el));
  },
  'set-urg': (el) => {
    state.draft.urgency = el.dataset.v;
    selectSeg(el);
    $('#sla-hint').textContent = `SLA ${M.urgency(el.dataset.v).sla} 小時內解決`;
  },
  'submit-ticket': () => {
    if (!state.draft.title.trim()) return;
    const id = Math.max(1000, ...state.tickets.map((t) => t.id)) + 1;
    const t = M.newTicket(id, state.draft, state.attachment);
    state.tickets.unshift(t);
    state.selectedTicket = id;
    state.draft = { title: '', category: 'hw', urgency: 'normal', description: '', attach: true };
    refreshTickets();
    toast(`已送出報修單 #${id}，系統已指派給 ${t.assignee}`);
  },
  'select-ticket': (el) => {
    state.selectedTicket = Number(el.dataset.id);
    refreshTickets();
  },
  't-advance': () => { M.advance(selectedTicket()); refreshTickets(); },
  't-parts': () => { M.waitParts(selectedTicket()); refreshTickets(); },
  't-confirm': () => { M.confirmClose(selectedTicket()); refreshTickets(); toast('報修單已結案，歡迎留下評分'); },
  't-reject': () => { M.reject(selectedTicket()); refreshTickets(); },
  't-rate': (el) => { selectedTicket().rating = Number(el.dataset.v); refreshTickets(); },
  't-remote': () => remoteRequest(state.selectedTicket),
  'read-one': (el) => {
    const a = state.anns.find((x) => x.id === el.dataset.id);
    if (a) a.read = true;
    render(false);
  },
  'read-all': () => { state.anns.forEach((a) => (a.read = true)); render(false); },
  'copy-id': async () => {
    const id = state.snap?.info.rustdesk.id;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      toast(`已複製 RustDesk ID ${id}`);
    } catch {
      toast('無法存取剪貼簿', false);
    }
  },
  'open-rustdesk': () => api.openRustDesk().catch((e) => toast(`無法開啟 RustDesk：${e}`, false)),
  'set-consent': (el) => { state.consent = el.dataset.v; selectSeg(el); },
  'perf-set': (el) => {
    perf.setting = el.dataset.v;
    try { localStorage.setItem('rustit-perf', perf.setting); } catch { /* 忽略 */ }
    selectSeg(el);
    applyPerf();
  },
  'simulate-remote': () => remoteRequest(),
  'dep-toggle': (el) => {
    const id = el.dataset.id;
    const c = state.deploy.catalog?.find((x) => x.id === id);
    if (!c || c.installed || Pages.isActive(state.deploy.tasks[id])) return;
    const sel = state.deploy.selected;
    if (sel.has(id)) sel.delete(id); else sel.add(id);
    paintDeploy(id);
  },
  'dep-bundle': () => {
    const d = state.deploy;
    const ids = (d.catalog ?? []).filter((c) => !c.installed && !Pages.isActive(d.tasks[c.id])).map((c) => c.id);
    if (!ids.length) { toast('組合內的軟體都已安裝'); return; }
    ids.forEach((id) => { d.selected.add(id); paintDeploy(id); });
  },
  'dep-clear': () => {
    const ids = [...state.deploy.selected];
    state.deploy.selected.clear();
    ids.forEach(paintDeploy);
  },
  'dep-start': () => confirmDeploy([...state.deploy.selected]),
  'dep-retry': (el) => confirmDeploy([el.dataset.id]),
  'dep-refresh': () => { state.deploy.catalog = null; render(false); },
  'dep-uninstall': async (el) => {
    const c = state.deploy.catalog?.find((x) => x.id === el.dataset.id);
    if (!c?.installed) return;
    const choice = await modal({
      html: `
        <div class="kicker" style="color:var(--bad)">${icon('alert')}移除軟體</div>
        <h2>確定要移除 ${esc(c.installed.name)}？</h2>
        <div class="meta">版本 ${esc(c.installed.version)} · ${esc(c.installed.publisher)}</div>
        <div class="body">將以靜默方式執行解除安裝程式（參數 ${esc(c.uninstall_args)}），Windows 會先跳出 UAC 確認。</div>`,
      buttons: [
        { id: 'cancel', label: '取消' },
        { id: 'ok', label: '移除', cls: 'primary', icon: 'x' },
      ],
    });
    if (choice !== 'ok') return;
    try {
      await api.deployUninstall(c.id);
    } catch (e) {
      toast(`移除失敗：${e}`, false);
    }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el, e);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'sw-filter') {
    state.swFilter = t.value;
    paintSoftware();
  } else if (t.dataset.bind) {
    state.draft[t.dataset.bind] = t.value;
    const btn = $('#submit-ticket');
    if (btn) btn.disabled = !state.draft.title.trim();
  } else if (t.dataset.bindCheck) {
    state.draft[t.dataset.bindCheck] = t.checked;
    const prev = $('#attach-preview');
    if (prev) prev.style.display = t.checked ? '' : 'none';
  }
});

// 游標反光（只在完整特效模式）。背景不再跟著滑鼠移動：背景一動，所有玻璃都要重算模糊。
let pointerFrame = 0;
document.addEventListener('pointermove', (e) => {
  if (pointerFrame || paused || effectiveMode() === 'lite') return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0;
    const g = e.target.closest?.('.glass');
    if (g) {
      const r = g.getBoundingClientRect();
      g.style.setProperty('--mx', `${e.clientX - r.left}px`);
      g.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
  });
});

// ------------------------------------------------------------ 效能：背景暫停與效能模式

/**
 * 不在前景：暫停循環動畫與即時更新（.idle）。
 * 最小化或隱藏：暫停所有動畫（.paused）。
 * `paused` 變數代表「不在前景」，用來停止輪詢與游標反光。
 */
let paused = false;
let windowFocused = true;
let minimized = false;

function refreshPause() {
  // Windows 上焦點實際落在內嵌的 WebView，Tauri 的視窗焦點事件不一定可靠，兩者任一成立就算在前景。
  const focused = document.hasFocus() || (api.win ? windowFocused : false);
  const hidden = document.hidden || minimized;
  const next = hidden || !focused;
  const root = document.documentElement.classList;
  root.toggle('paused', hidden);
  root.toggle('idle', next);
  if (next === paused) return;
  paused = next;
  if (!paused) tickLive(); // 回到前景立刻更新一次
}

document.addEventListener('visibilitychange', refreshPause);
addEventListener('focus', refreshPause);
addEventListener('blur', refreshPause);
document.addEventListener('pointerdown', () => setTimeout(refreshPause));
// 補抓漏掉的焦點事件；只讀一個布林值，成本可以忽略
setInterval(refreshPause, 2000);
if (api.win) {
  api.win.isFocused().then((f) => { windowFocused = f; refreshPause(); }).catch(() => {});
  api.win.onFocusChanged(({ payload }) => { windowFocused = payload; refreshPause(); });
  api.win.onResized(async () => {
    try { minimized = await api.win.isMinimized(); } catch { /* 取不到就維持原狀 */ }
    refreshPause();
  });
}

/** 效能模式：auto（依偵測結果）、full（完整特效）、lite（精簡）。 */
const perf = { setting: 'auto', lowEnd: false, reasons: [], notified: false };
const fpsProbe = { result: null, running: false };

try {
  const saved = localStorage.getItem('rustit-perf');
  if (['auto', 'full', 'lite'].includes(saved)) perf.setting = saved;
} catch { /* 私密模式等情況讀不到 */ }

function effectiveMode() {
  return perf.setting === 'auto' ? (perf.lowEnd ? 'lite' : 'full') : perf.setting;
}

function applyPerf() {
  const before = document.documentElement.dataset.perf;
  const mode = effectiveMode();
  document.documentElement.dataset.perf = mode;
  const box = $('#perf');
  if (box) {
    $$('button', box).forEach((b) => b.classList.toggle('on', b.dataset.v === perf.setting));
    placeThumb($('.segmented', box), false);
    $('.perf-note', box).textContent =
      perf.setting === 'lite' ? '精簡：關閉模糊、折射與大部分動畫'
        : perf.setting === 'full' ? '完整：玻璃模糊、折射與動畫全開'
          : perf.lowEnd ? `自動：偵測到 ${perf.reasons.join('、')}，已改用精簡模式`
            : '自動：這台電腦效能足夠，使用完整特效';
  }
  if (before === 'full' && mode === 'lite' && perf.setting === 'auto' && !perf.notified) {
    perf.notified = true;
    toast(`偵測到 ${perf.reasons.join('、')}，已自動切換為精簡模式`);
  }
}

/** 依硬體與實測畫面更新率判斷是否為低階電腦。 */
function detectLowEnd() {
  const reasons = [];
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) reasons.push('系統設定為減少動畫');
  const cores = navigator.hardwareConcurrency || 0;
  if (cores && cores <= 4) reasons.push(`只有 ${cores} 個執行緒`);
  const info = state.snap?.info;
  const memGb = info ? info.memory_total / 1024 ** 3 : navigator.deviceMemory; // deviceMemory 最多只回報 8
  if (memGb && memGb < 7.5) reasons.push(`記憶體 ${Math.round(memGb)} GB`);
  if (info?.gpus.some((g) => /basic (display|render)/i.test(g.name))) reasons.push('沒有安裝顯示卡驅動');
  if (fpsProbe.result !== null && fpsProbe.result < 40) reasons.push(`畫面只有 ${Math.round(fpsProbe.result)} fps`);
  perf.reasons = reasons;
  perf.lowEnd = reasons.length > 0;
  applyPerf();
}

/** 在第一次進場動畫期間量畫面更新率；太低代表這台電腦跑不動特效。 */
function probeFps() {
  if (fpsProbe.running || fpsProbe.result !== null || paused || effectiveMode() === 'lite') return;
  fpsProbe.running = true;
  let frames = 0;
  const start = performance.now();
  const step = (now) => {
    frames++;
    if (now - start < 1200) return requestAnimationFrame(step);
    fpsProbe.running = false;
    // 期間被切到背景就不採計，下次再量
    if (paused) return;
    fpsProbe.result = frames / ((now - start) / 1000);
    detectLowEnd();
  };
  requestAnimationFrame(step);
}

/** 換頁時讓背景光暈平移一次（1.8 秒），之後保持靜止。 */
const AURORA = [[0, 0, 1], [3, -2, 1.04], [-3, 2, 1.03], [2, 3, 1.05], [-2, -3, 1.02], [4, 1, 1.04], [-4, -1, 1.03], [1, -4, 1.05], [-1, 4, 1.02], [3, 3, 1.03]];
function shiftAurora() {
  const i = Math.max(0, NAV.findIndex(([id]) => id === state.page));
  const [x, y, s] = AURORA[i % AURORA.length];
  const a = $('#aurora').style;
  a.setProperty('--ax', `${x}%`);
  a.setProperty('--ay', `${y}%`);
  a.setProperty('--as', s);
}

addEventListener('resize', () => {
  movePill(false);
  $$('.segmented').forEach((seg) => placeThumb(seg, false));
});

// 標題列：雙擊最大化 / 還原（拖曳由 data-tauri-drag-region 處理）
$('#titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  api.win?.toggleMaximize();
});

// 字型可能晚一點才載入，載入後再校正膠囊位置
document.fonts?.ready.then(() => {
  movePill(false);
  $$('.segmented').forEach((seg) => placeThumb(seg, false));
});

// ------------------------------------------------------------ 啟動

buildShell();
detectLowEnd();
shiftAurora();
api.onDeploy(onDeployProgress);
movePill(false);
updateTopbar();
render(true);
collect();
tickLive();
setInterval(tickLive, 1000);
// 每 30 秒刷新 SLA 倒數（正在輸入時跳過，避免游標跑掉）
setInterval(() => {
  const typing = document.activeElement?.matches('input, textarea');
  if (state.page === 'tickets' && !typing && !paused) render(false);
}, 30000);
