// 各頁面：回傳 HTML 字串。所有動態文字都經過 esc()。
import { icon } from './icons.js';
import { esc, dash, bytes, duration, fmtDateTime, fmtShort, greeting, level } from './util.js';
import { CATEGORIES, URGENCIES, STATUS, STEP_LABELS, category, urgency, slaOf, dueOf } from './mock.js';

// ------------------------------------------------------------ 共用片段

let seq = 0;
const nextI = () => seq++;

const tile = (inner, cls = '') => `<section class="glass tile reveal ${cls}" style="--i:${nextI()}">${inner}</section>`;

const head = (ico, title, sub = '', [c1, c2] = ['#5b8cff', '#a855f7'], right = '') => `
  <div class="tile-head">
    <div class="tile-icon" style="--c1:${c1};--c2:${c2}">${icon(ico)}</div>
    <h3>${title}</h3>${sub ? `<span class="sub">${sub}</span>` : ''}
    <div class="grow"></div>${right}
  </div>`;

const kv = (rows) =>
  `<div class="kv">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(dash(v))}</div>`).join('')}</div>`;

export const chip = (tone, text, dot = true) => `<span class="chip ${tone}">${dot ? '<i class="d"></i>' : ''}${esc(text)}</span>`;

const pageHead = (title, sub, right = '') => `
  <div class="page-head reveal" style="--i:${nextI()}">
    <div class="grow"><h1>${title}</h1><p>${sub}</p></div>${right}
  </div>`;

const note = (text) => `<div class="note reveal" style="--i:${nextI()}">${icon('info')}<span>${text}</span></div>`;

const C = {
  blue: ['#38bdf8', '#6366f1'],
  violet: ['#8b5cf6', '#d946ef'],
  pink: ['#f472b6', '#e11d48'],
  green: ['#34d399', '#059669'],
  amber: ['#fbbf24', '#f97316'],
  teal: ['#2dd4bf', '#0ea5e9'],
  slate: ['#94a3b8', '#475569'],
};

function meter(pct, i = 0) {
  const lv = level(pct);
  return `<div class="meter ${lv}"><i style="--w:${pct.toFixed(1)}%;--i:${i}"></i></div>`;
}

// 狀態摘要（總覽與 hero 共用）
function statuses(s) {
  const { info } = s.snap;
  const sys = info.system;
  const av = info.security.antivirus;
  const on = av.find((a) => a.enabled);
  const rd = info.rustdesk;
  const unread = s.anns.filter((a) => !a.read).length;
  const open = s.tickets.filter((t) => t.status !== 'closed').length;
  const usb = info.usb.storage_policy;
  return [
    {
      name: '網域', ico: 'building', page: 'overview',
      ...(sys.part_of_domain
        ? { tone: 'good', text: `已加入 AD 網域 ${sys.domain}` }
        : { tone: 'warn', text: '未加入網域（在家測試屬正常）' }),
    },
    {
      name: '防毒', ico: 'shield', page: 'security',
      ...(on
        ? on.up_to_date
          ? { tone: 'good', text: `${on.name} 已啟用，病毒碼最新` }
          : { tone: 'warn', text: `${on.name} 病毒碼過期` }
        : { tone: 'bad', text: av.length ? '防毒軟體未啟用' : '未偵測到防毒軟體' }),
    },
    {
      name: 'USB 儲存', ico: 'usb', page: 'security',
      ...(usb === 'Blocked'
        ? { tone: 'good', text: 'USB 儲存裝置已封鎖' }
        : { tone: 'warn', text: usb === 'Allowed' ? `允許（曾插入 ${info.usb.storage_history.length} 個裝置）` : '無法讀取' }),
    },
    {
      name: '遠端協助', ico: 'remote', page: 'remote',
      ...(rd.installed
        ? rd.id ? { tone: 'good', text: `RustDesk ${rd.version} · ID ${rd.id}` } : { tone: 'warn', text: '已安裝，但讀不到 ID' }
        : { tone: 'bad', text: '未安裝（正式版由 Agent 自動安裝）' }),
    },
    {
      name: '公告', ico: 'megaphone', page: 'announcements',
      ...(unread ? { tone: 'warn', text: `${unread} 則未讀` } : { tone: 'good', text: '全部已讀' }),
    },
    {
      name: '報修單', ico: 'lifebuoy', page: 'tickets',
      ...(open ? { tone: 'warn', text: `${open} 張處理中` } : { tone: 'good', text: '沒有未結案的報修' }),
    },
  ];
}

const toneVar = (tone) => `var(--${tone === 'muted' ? 'muted' : tone})`;

// ------------------------------------------------------------ 載入中

export function loading() {
  seq = 0;
  return `
    <div class="loading reveal" style="--i:0">
      <div>
        <div class="liquid-orb" style="margin:0 auto 28px"></div>
        <h2>正在蒐集這台電腦的資料</h2>
        <p>讀取硬體、網路、軟體與安全狀態，約需 2 秒…</p>
      </div>
    </div>`;
}

// ------------------------------------------------------------ 總覽

function ring(id, label, [c1, c2]) {
  const r = 54;
  const c = (2 * Math.PI * r).toFixed(1);
  return `
    <div>
      <div class="ring" id="ring-${id}" style="--glow:${c2}">
        <svg viewBox="0 0 132 132">
          <defs><linearGradient id="rg-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
          <circle class="track" cx="66" cy="66" r="${r}"/>
          <circle class="glow" cx="66" cy="66" r="${r}" stroke="url(#rg-${id})" stroke-dasharray="${c}" stroke-dashoffset="${c}"/>
          <circle class="bar" cx="66" cy="66" r="${r}" stroke="url(#rg-${id})" stroke-dasharray="${c}" stroke-dashoffset="${c}"/>
        </svg>
        <div class="center"><div class="num"><span data-num>0</span><small>%</small></div><div class="cap">${label}</div></div>
      </div>
      <div class="ring-foot" data-foot>—</div>
    </div>`;
}

export function overview(s) {
  seq = 0;
  const { info } = s.snap;
  const sys = info.system;
  const user = sys.user_name.split('\\').pop();
  const st = statuses(s);
  const issues = st.filter((x) => x.tone !== 'good').length;
  const sysVol = info.volumes.find((v) => v.mount_point.toUpperCase().startsWith('C:')) ?? info.volumes[0];

  return `
    <section class="glass hero reveal" style="--i:${nextI()}">
      <div class="hero-orb">${icon('sparkle')}</div>
      <div class="grow">
        <h2>${greeting()}，${esc(user)}</h2>
        <p>${issues ? `這台電腦有 <b>${issues}</b> 個項目值得留意，其餘一切正常。` : '這台電腦一切正常。'}</p>
      </div>
      <div class="row">
        ${chip('info', `${info.software.length} 個軟體`, false)}
        ${chip('violet', `${info.physical_disks.length} 顆硬碟`, false)}
        ${chip('good', `蒐集 ${info.collect_ms} ms`, false)}
      </div>
    </section>

    <div class="grid cols-4">
      ${[
        ['monitor', '電腦名稱', sys.host_name, `${sys.manufacturer} ${sys.model}`.trim()],
        ['user', '登入者', sys.user_name, '目前登入的帳號'],
        ['building', sys.part_of_domain ? 'AD 網域' : '工作群組', sys.domain, sys.part_of_domain ? '已加入網域' : '未加入網域'],
        ['wifi', 'IP 位址', s.snap.primary_ip ?? '', info.network[0]?.mac ? `MAC ${info.network[0].mac}` : ''],
      ].map(([ico, label, value, hint]) => tile(`
        <div class="stat">
          <div class="label">${icon(ico)}${esc(label)}</div>
          <div class="value" title="${esc(value)}">${esc(dash(value))}</div>
          <div class="hint">${esc(hint)}</div>
        </div>`, 'hover-lift')).join('')}
    </div>

    <div class="grid cols-3">
      ${tile(`
        ${head('pulse', '即時使用率', '每秒更新', C.blue)}
        <div class="rings">
          ${ring('cpu', 'CPU', C.blue)}
          ${ring('mem', '記憶體', C.violet)}
          ${ring('disk', esc(sysVol?.mount_point.replace('\\', '') ?? '磁碟'), C.teal)}
        </div>`, 'span-2')}
      ${tile(`
        ${head('cpu', 'CPU 走勢', '最近 60 秒', C.violet)}
        <svg class="spark" viewBox="0 0 300 110" preserveAspectRatio="none">
          <line class="gridline" x1="0" y1="27.5" x2="300" y2="27.5" vector-effect="non-scaling-stroke"/>
          <line class="gridline" x1="0" y1="55" x2="300" y2="55" vector-effect="non-scaling-stroke"/>
          <line class="gridline" x1="0" y1="82.5" x2="300" y2="82.5" vector-effect="non-scaling-stroke"/>
          <path class="area" id="spark-area"/>
          <path class="line" id="spark-line" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="row mt-8" style="justify-content:space-between">
          <span class="muted">已開機 <b id="uptime" style="color:var(--text)">—</b></span>
          <span class="muted">峰值 <b id="cpu-peak" style="color:var(--text)">—</b></span>
        </div>`)}
    </div>

    <div class="grid cols-2">
      ${tile(`
        ${head('sparkle', '狀態摘要', '', C.green)}
        <div class="status-list">
          ${st.map((x) => `
            <div class="status-row" data-action="goto" data-page="${x.page}" style="--c:${toneVar(x.tone)}">
              <div class="ico">${icon(x.ico)}</div>
              <div class="name">${esc(x.name)}</div>
              <div class="val">${esc(x.text)}</div>
              <div class="chev">${icon('chevron')}</div>
            </div>`).join('')}
        </div>`)}
      ${tile(`
        ${head('board', '系統', '', C.amber)}
        ${kv([
          ['作業系統', `${sys.os_name} ${sys.os_display_version}`],
          ['組建', sys.os_build],
          ['主機板', `${info.identity.board_manufacturer} ${info.identity.board_product}`],
          ['處理器', info.cpu.name],
          ['記憶體', bytes(info.memory_total)],
          ['開機時間', fmtDateTime(new Date(sys.boot_time * 1000))],
          ['資產識別碼', s.snap.asset_key],
        ])}`)}
    </div>

    ${tile(`${head('disk', '磁碟區', `${info.volumes.length} 個`, C.teal)}${volumes(info)}`)}

    ${info.warnings.length ? tile(`${head('alert', '蒐集警告', '', C.amber)}${info.warnings.map((w) => `<div class="mt-8" style="color:var(--warn)">${esc(w)}</div>`).join('')}`) : ''}
  `;
}

function volumes(info) {
  return info.volumes.map((v, i) => {
    const used = v.total - v.available;
    const pct = v.total ? (used / v.total) * 100 : 0;
    return `
      <div class="volume">
        <div class="name">${esc(v.mount_point)}${v.label ? `<small>${esc(v.label)}</small>` : ''}</div>
        ${meter(pct, i)}
        <div class="info">${pct.toFixed(0)}% · 可用 ${bytes(v.available)} / ${bytes(v.total)}</div>
      </div>`;
  }).join('');
}

// ------------------------------------------------------------ 硬體

export function hardware(s) {
  seq = 0;
  const { info } = s.snap;
  const id = info.identity;
  const changes = s.snap.hardware_changes;
  let changeHtml;
  if (!changes) {
    changeHtml = `<p class="muted" style="margin:0">目前是第一次蒐集。按右上角「重新蒐集」後會與這次結果比對，記憶體、硬碟、顯示卡若有拆換會列在這裡。</p>`;
  } else if (!changes[0].length && !changes[1].length) {
    changeHtml = chip('good', '與上次蒐集相比，硬體沒有變更');
  } else {
    changeHtml = `${chip('warn', '偵測到硬體變更，正式版會通知 IT')}
      <div class="mt-8">${changes[0].map((p) => `<div style="color:var(--warn)">＋ ${esc(p)}</div>`).join('')}
      ${changes[1].map((p) => `<div style="color:var(--bad)">－ ${esc(p)}</div>`).join('')}</div>`;
  }

  return `
    ${pageHead('硬體資訊', '透過 WMI 蒐集，資產以 BIOS 序號 / 系統 UUID 唯一識別（PRD 2）')}

    <div class="grid cols-2">
      ${tile(`
        ${head('cpu', '處理器', '', C.blue)}
        <div class="stat"><div class="value" style="font-size:19px;white-space:normal">${esc(info.cpu.name)}</div></div>
        <div class="row wrap mt-14">
          ${chip('info', `${info.cpu.cores} 核心`, false)}
          ${chip('violet', `${info.cpu.logical} 執行緒`, false)}
          ${chip('muted', `${info.cpu.max_mhz} MHz`, false)}
          ${chip('muted', info.system.arch, false)}
        </div>`, 'hover-lift')}
      ${tile(`
        ${head('board', '主機板與 BIOS', '', C.amber)}
        ${kv([
          ['廠牌 / 型號', `${info.system.manufacturer} ${info.system.model}`],
          ['主機板', `${id.board_manufacturer} ${id.board_product}`],
          ['BIOS', `${id.bios_vendor} ${id.bios_version}`],
          ['BIOS 序號', s.snap.bios_placeholder ? `${id.bios_serial}（預設值，改用 UUID）` : id.bios_serial],
          ['系統 UUID', id.system_uuid],
        ])}`)}
    </div>

    ${tile(`
      ${head('memory', '記憶體', `共 ${bytes(info.memory_total)} · ${info.memory_modules.length} 條`, C.violet)}
      <div class="grid cols-4">
        ${info.memory_modules.map((m) => `
          <div class="glass tile hover-lift" style="padding:14px 16px;border-radius:18px">
            <div class="muted" style="font-size:12px">${esc(dash(m.slot))}</div>
            <div class="stat"><div class="value" style="margin-top:4px">${bytes(m.capacity)}</div></div>
            <div class="muted mt-8" style="font-size:12.5px">${esc(dash(m.manufacturer))} · ${m.speed_mhz} MHz</div>
            <div class="muted mono" style="font-size:11.5px">${esc(dash(m.part_number))}</div>
          </div>`).join('')}
      </div>`)}

    ${tile(`
      ${head('disk', '實體硬碟', `${info.physical_disks.length} 顆`, C.teal)}
      <div class="table" style="--cols:minmax(0,2fr) minmax(0,2.2fr) 110px 90px">
        <div class="tr th"><div>型號</div><div>序號</div><div>容量</div><div>介面</div></div>
        ${info.physical_disks.map((d, i) => `
          <div class="tr row-in" style="--i:${i}">
            <div class="td" title="${esc(d.model)}">${esc(dash(d.model))}</div>
            <div class="td mono dim" title="${esc(d.serial)}">${esc(dash(d.serial.replace(/\.$/, '')))}</div>
            <div class="td">${bytes(d.size)}</div>
            <div class="td dim">${esc(dash(d.interface))}</div>
          </div>`).join('')}
      </div>`)}

    ${tile(`${head('disk', '磁碟區', '', C.green)}${volumes(info)}`)}

    <div class="grid cols-2">
      ${tile(`
        ${head('monitor', '顯示卡', '', C.pink)}
        ${info.gpus.map((g) => `
          <div style="padding:6px 0">
            <div style="font-weight:600">${esc(g.name)}</div>
            <div class="muted" style="font-size:12.5px">驅動 ${esc(g.driver_version)}${g.resolution ? ` · ${esc(g.resolution)}` : ''}</div>
          </div>`).join('')}`)}
      ${tile(`${head('refresh', '硬體變更偵測', '', C.slate)}${changeHtml}`)}
    </div>
  `;
}

// ------------------------------------------------------------ 網路

export function network(s) {
  seq = 0;
  const { info } = s.snap;
  return `
    ${pageHead('網路', '目前啟用的網路介面卡（Win32_NetworkAdapterConfiguration）')}
    ${info.network.map((n) => {
      const v4 = n.ips.filter((ip) => ip.includes('.'));
      const v6 = n.ips.filter((ip) => !ip.includes('.'));
      return tile(`
        ${head('wifi', esc(n.description), '', C.teal, `<div class="row">${chip(n.dhcp_enabled ? 'info' : 'violet', n.dhcp_enabled ? 'DHCP' : '固定 IP', false)}</div>`)}
        <div class="grid cols-2">
          <div>${kv([['MAC', n.mac], ['IPv4', v4.join(', ')], ['IPv6', v6.join(', ')]])}</div>
          <div>${kv([['預設閘道', n.gateways.join(', ')], ['DNS', n.dns.join(', ')], ['DHCP', n.dhcp_enabled ? '啟用' : '停用']])}</div>
        </div>`, 'hover-lift');
    }).join('')}
    ${tile(`
      ${head('shield', '網路控管', '正式版功能', C.slate)}
      <div class="status-list">
        ${[
          ['alert', '未授權設備偵測', '網路掃描發現的 MAC 不在資產清冊即告警'],
          ['globe', '網站封鎖 / 程式連線限制', 'Agent 透過 Windows Filtering Platform 執行'],
          ['pulse', '流量統計', '依程式統計上傳 / 下載流量'],
        ].map(([ico, name, desc]) => `
          <div class="status-row" style="--c:var(--muted);grid-template-columns:38px 200px 1fr">
            <div class="ico">${icon(ico)}</div><div style="font-weight:560">${name}</div><div class="muted">${desc}</div>
          </div>`).join('')}
      </div>`)}
  `;
}

// ------------------------------------------------------------ 軟體

const BLACKLIST = [
  ['torrent', 'P2P'], ['emule', 'P2P'], ['迅雷', 'P2P'], ['thunder', 'P2P'],
  ['steam', '遊戲平台'], ['epic games', '遊戲平台'], ['battle.net', '遊戲平台'],
];
export const blacklistHit = (name) => BLACKLIST.find(([k]) => name.toLowerCase().includes(k))?.[1];

export function software(s) {
  seq = 0;
  const { info } = s.snap;
  const hits = info.software.filter((x) => blacklistHit(x.name)).length;
  return `
    ${pageHead('已安裝軟體', '讀取登錄檔 Uninstall 機碼，與「設定 › 應用程式」相同的清單',
      `<div class="search" style="width:300px">${icon('search')}<input class="input" id="sw-filter" placeholder="搜尋名稱或發行者" value="${esc(s.swFilter)}"></div>`)}
    ${hits ? note(`範例黑名單規則（P2P、遊戲平台）命中 <b>${hits}</b> 項，以橘色標示。正式版會通知 IT，也能設定自動結束程式。`) : ''}
    ${tile(`
      ${head('apps', '軟體清單', `<span id="sw-count"></span>`, C.blue)}
      <div class="table" style="--cols:minmax(0,2.6fr) minmax(0,1fr) minmax(0,1.5fr) 104px">
        <div class="tr th"><div>名稱</div><div>版本</div><div>發行者</div><div>安裝日期</div></div>
        <div id="sw-rows"></div>
      </div>`)}
  `;
}

export function softwareRows(s) {
  const f = s.swFilter.trim().toLowerCase();
  const list = s.snap.info.software.filter((x) => !f || x.name.toLowerCase().includes(f) || x.publisher.toLowerCase().includes(f));
  const html = list.map((x, i) => {
    const why = blacklistHit(x.name);
    return `
      <div class="tr row-in ${why ? 'hit' : ''}" style="--i:${i}">
        <div class="td" title="${esc(x.name)}">${esc(x.name)}${why ? ` <span class="chip warn" style="margin-left:6px">${esc(why)}</span>` : ''}</div>
        <div class="td dim mono">${esc(dash(x.version))}</div>
        <div class="td dim" title="${esc(x.publisher)}">${esc(dash(x.publisher))}</div>
        <div class="td dim">${esc(dash(x.install_date))}</div>
      </div>`;
  }).join('');
  return { html: html || '<div class="empty" style="padding:14px 12px">沒有符合的軟體</div>', count: list.length };
}

// ------------------------------------------------------------ 安全

export function security(s) {
  seq = 0;
  const { info } = s.snap;
  const sys = info.system;
  const usb = info.usb.storage_policy;
  const av = info.security.antivirus;
  return `
    ${pageHead('安全與控管', '防毒、Windows 更新、USB 儲存裝置（PRD 4.3、5.2）')}
    <div class="grid cols-2">
      ${tile(`
        ${head('shield', '防毒軟體', '', C.green)}
        ${av.length ? av.map((a) => `
          <div style="padding:4px 0 8px">
            <div style="font-size:18px;font-weight:650;font-family:var(--font-display)">${esc(a.name)}</div>
            <div class="row wrap mt-8">
              ${chip(a.enabled ? 'good' : 'bad', a.enabled ? '即時防護已啟用' : '即時防護未啟用')}
              ${chip(a.up_to_date ? 'good' : 'warn', a.up_to_date ? '病毒碼為最新' : '病毒碼過期')}
            </div>
          </div>`).join('') : chip('bad', '未偵測到防毒軟體')}`, 'hover-lift')}
      ${tile(`
        ${head('refresh', 'Windows 更新', '', C.blue)}
        ${kv([['版本', `${sys.os_name} ${sys.os_display_version}`], ['組建（含累積更新）', sys.os_build]])}
        <div class="muted mt-14" style="font-size:12.5px">最近安裝的更新（QFE）</div>
        <div class="row wrap mt-8">${info.security.recent_hotfixes.map((h) => `<span class="chip muted" title="${esc(h.description)}">${esc(h.id)} · ${esc(h.installed_on)}</span>`).join('')}</div>`)}
    </div>
    ${tile(`
      ${head('usb', 'USB 儲存裝置控管', '', C.amber,
        chip(usb === 'Blocked' ? 'good' : 'warn', usb === 'Blocked' ? '目前政策：已封鎖' : usb === 'Allowed' ? '目前政策：允許（未控管）' : '無法讀取'))}
      <div class="row wrap" style="gap:14px">
        <span class="muted">IT 可下達的政策</span>
        <div class="segmented disabled" title="正式版由 IT 後台依 AD OU 下達">
          <span class="thumb"></span>
          ${['允許', '唯讀', '封鎖', '白名單裝置'].map((l, i) =>
            `<button class="${(usb === 'Allowed' && i === 0) || (usb === 'Blocked' && i === 2) ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <span class="muted" style="font-size:12.5px">正式版由 IT 後台依 AD OU 下達</span>
      </div>
      <div class="muted mt-14" style="font-size:12.5px">曾插入過的 USB 儲存裝置（${info.usb.storage_history.length} 個）</div>
      <div class="table mt-8" style="--cols:minmax(0,2fr) minmax(0,1fr)">
        ${info.usb.storage_history.map((d, i) => `
          <div class="tr row-in" style="--i:${i}"><div class="td">${esc(d.friendly_name)}</div><div class="td dim mono">${esc(d.serial)}</div></div>`).join('') || '<div class="empty">沒有紀錄</div>'}
      </div>`)}
  `;
}

// ------------------------------------------------------------ 報修單

export function tickets(s) {
  seq = 0;
  const d = s.draft;
  const attach = s.attachment;
  return `
    ${pageHead('報修單', '使用者報修 → 自動指派 → IT 處理 → 使用者確認結案（PRD 4.1）')}
    ${note('報修單只存在記憶體，不會送到伺服器。可以用下方「IT 端（模擬）」按鈕體驗完整流程。')}
    <div class="grid cols-2">
      ${tile(`
        ${head('send', '新增報修', '', C.blue)}
        <div class="field"><label>標題</label><input class="input" data-bind="title" placeholder="例如：螢幕閃爍、無法連上共用資料夾" value="${esc(d.title)}"></div>
        <div class="field mt-14"><label>類別</label>
          <div class="chips-select">${CATEGORIES.map((c) => `<button data-action="set-cat" data-v="${c.id}" class="${d.category === c.id ? 'on' : ''}">${c.label}</button>`).join('')}</div>
        </div>
        <div class="field mt-14"><label>緊急程度</label>
          <div class="row wrap">
            <div class="segmented" data-seg="urgency"><span class="thumb"></span>
              ${URGENCIES.map((u) => `<button data-action="set-urg" data-v="${u.id}" class="${d.urgency === u.id ? 'on' : ''}">${u.label}</button>`).join('')}
            </div>
            <span class="muted" id="sla-hint">SLA ${urgency(d.urgency).sla} 小時內解決</span>
          </div>
        </div>
        <div class="field mt-14"><label>描述</label><textarea class="input" data-bind="description" placeholder="發生了什麼事？什麼時候開始的？">${esc(d.description)}</textarea></div>
        <div class="row mt-14" style="justify-content:space-between">
          <label class="switch"><input type="checkbox" data-bind-check="attach" ${d.attach ? 'checked' : ''}><span class="track"><span class="knob"></span></span><span>自動附上這台電腦的資訊</span></label>
          <button class="btn primary" data-action="submit-ticket" id="submit-ticket" ${d.title.trim() ? '' : 'disabled'}>${icon('send')}送出報修</button>
        </div>
        <div class="attach mt-14" id="attach-preview" style="${d.attach ? '' : 'display:none'}">
          ${attach.map(([k, v]) => `<span>${esc(k)}<b>${esc(v)}</b></span>`).join('')}
        </div>`)}
      ${tile(`
        ${head('lifebuoy', '我的報修單', `${s.tickets.length} 張`, C.violet)}
        <div class="table" style="--cols:62px minmax(0,1fr) auto">
          ${s.tickets.map((t, i) => {
            const st = STATUS[t.status];
            const sla = slaOf(t);
            return `
              <div class="tr clickable row-in ${s.selectedTicket === t.id ? 'sel' : ''}" style="--i:${i}" data-action="select-ticket" data-id="${t.id}">
                <div class="td mono dim">#${t.id}</div>
                <div class="td"><div style="font-weight:560;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div>
                  <div class="muted" style="font-size:12px">${category(t.category).label} · ${urgency(t.urgency).label} · ${esc(t.assignee)}</div></div>
                <div class="td" style="text-align:right">${chip(st.tone, st.label)}<div style="font-size:12px;margin-top:4px;color:${toneVar(sla.tone)}">${sla.text}</div></div>
              </div>`;
          }).join('')}
        </div>`)}
    </div>
    <div id="ticket-detail">${ticketDetail(s)}</div>
  `;
}

export function ticketDetail(s) {
  const t = s.tickets.find((x) => x.id === s.selectedTicket);
  if (!t) return '';
  const st = STATUS[t.status];
  const sla = slaOf(t);
  const step = st.step;
  const canAdvance = ['new', 'assigned', 'working', 'parts'].includes(t.status);
  return tile(`
    ${head('lifebuoy', `#${t.id} ${esc(t.title)}`, '', C.blue, `<div class="row">${chip(st.tone, st.label)}${chip(sla.tone, `SLA ${sla.text}`, false)}</div>`)}
    <div class="steps" style="--p:${step / 4}">
      <span class="fill"></span>
      ${STEP_LABELS.map((l, i) => `
        <div class="step ${i < step || t.status === 'closed' ? 'done' : ''} ${i === step && t.status !== 'closed' ? 'current' : ''}">
          <span class="dot">${icon(i < step || t.status === 'closed' ? 'check' : 'clock')}</span>${i === 2 && t.status === 'parts' ? '等待零件' : l}
        </div>`).join('')}
    </div>
    <div class="grid cols-2">
      <div>
        ${kv([
          ['類別', category(t.category).label],
          ['緊急程度', `${urgency(t.urgency).label}（${urgency(t.urgency).sla} 小時內解決）`],
          ['處理人', t.assignee],
          ['建立時間', fmtDateTime(t.created)],
          ['SLA 期限', fmtDateTime(dueOf(t))],
          ['描述', t.description],
        ])}
        ${t.attachment.length ? `<div class="muted mt-14" style="font-size:12.5px">自動附帶的電腦資訊</div>
          <div class="attach mt-8">${t.attachment.map(([k, v]) => `<span>${esc(k)}<b>${esc(v)}</b></span>`).join('')}</div>` : ''}
      </div>
      <div>
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">處理歷程</div>
        <div class="timeline">${t.log.map((l) => `<div class="tl-item"><time>${fmtShort(l.at)}</time>${esc(l.text)}</div>`).join('')}</div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="row wrap" style="justify-content:space-between;gap:14px">
      <div class="actions">
        <span class="who">IT 端（模擬）</span>
        <button class="btn sm" data-action="t-advance" ${canAdvance ? '' : 'disabled'}>${icon('play')}處理下一步</button>
        <button class="btn sm" data-action="t-parts" ${t.status === 'working' ? '' : 'disabled'}>${icon('pause')}等待零件</button>
        <button class="btn sm" data-action="t-remote" ${t.status !== 'closed' ? '' : 'disabled'}>${icon('remote')}從工單遠端連線</button>
      </div>
      <div class="actions">
        ${t.status === 'confirm' ? `
          <span class="who">使用者端</span>
          <button class="btn sm good" data-action="t-confirm">${icon('check')}確認結案</button>
          <button class="btn sm" data-action="t-reject">${icon('undo')}還沒好，退回</button>` : ''}
        ${t.status === 'closed' ? `
          <span class="who">滿意度</span>
          <span class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-action="t-rate" data-v="${n}" class="${n <= t.rating ? 'on' : ''}">★</button>`).join('')}</span>` : ''}
      </div>
    </div>`);
}

// ------------------------------------------------------------ 公告

export function announcements(s) {
  seq = 0;
  const unread = s.anns.filter((a) => !a.read).length;
  return `
    ${pageHead('公告', 'IT 發布的公告，可指定 OU / 群組、強制彈窗、追蹤已讀（PRD 4.2）',
      unread ? `<button class="btn" data-action="read-all">${icon('check')}全部標為已讀</button>` : '')}
    ${note('以下為範例公告。重要公告會在程式啟動時強制彈窗，需按「我已閱讀」。')}
    ${s.anns.map((a) => tile(`
      <div class="ann ${a.read ? 'read' : ''}">
        <div class="ann-mark">${a.read ? '' : '<span class="pulse-dot"></span>'}</div>
        <div class="grow">
          <h3>${esc(a.title)} ${a.mustAck ? chip('warn', '重要', false) : ''}</h3>
          <div class="meta">${esc(a.author)} · 對象：${esc(a.audience)} · ${fmtDateTime(a.published)}</div>
          <div class="body">${esc(a.body)}</div>
        </div>
        <div>${a.read ? chip('muted', '已讀', false) : `<button class="btn sm" data-action="read-one" data-id="${a.id}">${icon('check')}${a.mustAck ? '我已閱讀' : '標為已讀'}</button>`}</div>
      </div>`, 'hover-lift')).join('')}
  `;
}

// ------------------------------------------------------------ 遠端協助

export function remote(s) {
  seq = 0;
  const rd = s.snap.info.rustdesk;
  const steps = [
    ['檢查是否已安裝', rd.installed, rd.installed ? `已安裝 ${rd.version}` : '未安裝'],
    ['從公司伺服器下載', null, '正式版：下載後驗證 SHA-256'],
    ['靜默安裝', rd.installed, rd.installed ? '已完成' : 'msiexec /i rustdesk.msi /qn'],
    ['設定自架伺服器', !!rd.custom_server, rd.custom_server || '尚未設定（rustdesk.exe --config）'],
    ['設定連線密碼', null, 'Demo 不變更密碼（rustdesk.exe --password）'],
    ['回報 ID 給後台', !!rd.id, rd.id || '讀不到 ID'],
    ['守護與自動修復', null, '正式版：每次掃描檢查服務與設定'],
  ];
  return `
    ${pageHead('遠端協助', 'IT 透過公司自架的 RustDesk 伺服器一鍵連線到這台電腦（PRD 6）')}
    <div class="grid cols-2">
      ${tile(`
        ${head('remote', '本機 RustDesk', '', C.blue, rd.installed ? chip('good', `已安裝 ${rd.version}`) : chip('bad', '未安裝'))}
        <div class="muted" style="font-size:12.5px">RustDesk ID</div>
        <div class="rd-id">${esc(rd.id ? rd.id.replace(/(\d{3})(?=\d)/g, '$1 ') : '— — —')}</div>
        <div class="row mt-14">
          <button class="btn primary" data-action="copy-id" ${rd.id ? '' : 'disabled'}>${icon('copy')}複製 ID</button>
          <button class="btn" data-action="open-rustdesk" ${rd.exe_path ? '' : 'disabled'}>${icon('play')}開啟 RustDesk</button>
        </div>
        <div class="mt-14">${kv([
          ['連線伺服器', rd.installed ? (rd.custom_server ? `${rd.custom_server}（自架）` : 'RustDesk 公共伺服器（正式版改為公司自架）') : ''],
          ['執行檔', rd.exe_path],
        ])}</div>`)}
      ${tile(`
        ${head('key', 'IT 端連線（模擬）', '', C.violet)}
        <p class="muted" style="margin:0 0 14px;line-height:1.7">IT 在後台的資產頁或工單頁按「遠端連線」，會用左邊的 ID 與加密保存的密碼直接連線，每次連線都寫入稽核紀錄。</p>
        <div class="field"><label>使用者同意模式（後台可依 OU 設定）</label>
          <div class="segmented" data-seg="consent"><span class="thumb"></span>
            <button data-action="set-consent" data-v="ask" class="${s.consent === 'ask' ? 'on' : ''}">需使用者同意</button>
            <button data-action="set-consent" data-v="auto" class="${s.consent === 'auto' ? 'on' : ''}">免同意（無人值守）</button>
          </div>
        </div>
        <button class="btn primary mt-14" data-action="simulate-remote">${icon('remote')}模擬 IT 發起遠端連線</button>`)}
    </div>
    ${tile(`
      ${head('check', 'Agent 自動部署流程', '本機檢查結果', C.green)}
      <div class="checklist">
        ${steps.map(([name, ok, detail], i) => `
          <div class="check-row">
            <span class="mark ${ok === null ? 'skip' : ok ? 'ok' : 'no'}" style="--i:${i}">${icon(ok === null ? 'minus' : ok ? 'check' : 'x')}</span>
            <span style="font-weight:560">${i + 1}. ${name}</span>
            <span class="detail">${esc(detail)}</span>
          </div>`).join('')}
      </div>`)}
  `;
}

// ------------------------------------------------------------ 功能說明

export function about() {
  seq = 0;
  const rows = [
    ['電腦資料蒐集（硬體、軟體、網路）', '2、5.1', 'good', '實際讀取本機'],
    ['資產唯一識別碼（BIOS 序號 / UUID）', '2', 'good', '實際讀取本機'],
    ['硬體變更偵測', '2、5.2', 'good', '重新蒐集後比對'],
    ['防毒與 Windows 更新狀態', '4.3', 'good', '實際讀取本機'],
    ['USB 儲存政策與插入紀錄', '5.2', 'good', '讀取；封鎖為正式版'],
    ['軟體黑名單偵測', '5.3', 'good', '範例規則'],
    ['RustDesk 狀態與 ID', '6', 'good', '實際讀取本機'],
    ['報修單流程與 SLA', '4.1', 'warn', '模擬，資料存在記憶體'],
    ['公告、強制彈窗、已讀', '4.2', 'warn', '範例資料'],
    ['IT 發起遠端連線（使用者同意）', '6', 'warn', '模擬彈窗'],
    ['軟體派送：背景安裝 / 移除', '5.5', 'good', '實際安裝 Firefox、WinRAR'],
    ['匯出 Agent 回報資料', '3', 'good', '右上角「匯出」'],
    ['AD 登入、後端 API、資料庫、報表', '3、4.3', 'muted', '正式版'],
    ['USB 封鎖、網站封鎖、遠端指令', '5.2–5.4', 'muted', '正式版'],
  ];
  return `
    ${pageHead('功能說明', '這個 Demo 對應 docs/PRD.md 的哪些功能')}
    ${tile(`
      ${head('info', '功能對照', '', C.blue)}
      <div class="table" style="--cols:minmax(0,2fr) 110px 200px">
        <div class="tr th"><div>功能</div><div>PRD 章節</div><div>Demo 狀態</div></div>
        ${rows.map(([f, sec, tone, text], i) => `
          <div class="tr row-in" style="--i:${i}"><div class="td">${f}</div><div class="td dim">${sec}</div><div class="td">${chip(tone, text)}</div></div>`).join('')}
      </div>`)}
    ${tile(`
      ${head('sparkle', '技術說明', '', C.violet)}
      <div class="status-list">
        ${[
          ['apps', '單一 exe', 'Rust + Tauri，介面由 Windows 內建的 WebView2 顯示，不需額外安裝'],
          ['cpu', '共用蒐集模組', 'rustit-collector 之後直接給 Windows 服務 Agent 使用'],
          ['disk', '資料來源', 'WMI（硬體、網路、防毒）、登錄檔（軟體、USB、系統版本）、sysinfo（即時使用率）'],
          ['shield', '不做任何變更', 'Demo 不連伺服器、不寫資料庫，也不會變更系統設定'],
        ].map(([ico, name, desc]) => `
          <div class="status-row" style="--c:var(--accent);grid-template-columns:38px 130px 1fr">
            <div class="ico">${icon(ico)}</div><div style="font-weight:560">${name}</div><div class="muted">${desc}</div>
          </div>`).join('')}
      </div>`)}
  `;
}

// ------------------------------------------------------------ 軟體派送

const LOGO = {
  firefox: { ico: 'globe', c: ['#ff9500', '#9059ff'] },
  winrar: { ico: 'folder', c: ['#8b5cf6', '#2563eb'] },
};
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
export const isActive = (task) => task && !TERMINAL.has(task.stage);

const STEPS = {
  install: [['下載', ['downloading']], ['驗證簽章', ['verifying']], ['靜默安裝', ['elevating', 'running']], ['確認', ['checking']]],
  uninstall: [['準備', ['queued', 'verifying']], ['靜默移除', ['elevating', 'running']], ['確認', ['checking']]],
};

function stepIndex(task) {
  if (task.stage === 'done') return 99;
  return STEPS[task.action].findIndex(([, stages]) => stages.includes(task.stage));
}

export function deploy(s) {
  seq = 0;
  const d = s.deploy;
  const cards = d.catalog
    ? d.catalog.map((c) => `
        <section class="glass tile reveal dep-card ${cardClass(s, c)}" style="--i:${nextI()}" id="dep-${c.id}" data-action="dep-toggle" data-id="${c.id}">
          ${deployCard(s, c)}
        </section>`).join('')
    : `<div class="glass tile reveal" style="--i:${nextI()}"><div class="row"><span class="btn icon ghost spin">${icon('refresh')}</span><span class="muted">讀取軟體目錄與安裝狀態…</span></div></div>`;
  return `
    ${pageHead('軟體派送', 'IT 勾選軟體後，由 Agent 在背景下載、驗證簽章、靜默安裝（PRD 5.5）',
      `<button class="btn" data-action="dep-refresh">${icon('refresh')}重新偵測</button>`)}
    ${note('Demo 會<b>真的</b>下載並安裝 / 移除到這台電腦。Demo 以一般使用者執行，每次安裝或移除 Windows 都會跳出 UAC 確認；正式版由 Agent（SYSTEM 服務）執行，不會跳出。')}
    ${tile(`
      ${head('sparkle', '軟體組合', '正式版可綁定 AD OU，新電腦加入就自動安裝', C.violet)}
      <div class="row wrap">
        <button class="bundle" data-action="dep-bundle">
          <span class="bundle-ico">${icon('apps')}</span>
          <span><b>新人標準包</b><small>Mozilla Firefox + WinRAR</small></span>
          <span class="chev">${icon('chevron')}</span>
        </button>
      </div>`)}
    <div class="grid cols-2">${cards}</div>
    <div class="glass dep-bar reveal" id="dep-bar" style="--i:${nextI()}">${deployBar(s)}</div>
    ${tile(`${head('clock', '派送紀錄', '只保留在記憶體', C.slate)}<div id="dep-log">${deployLog(s)}</div>`)}
  `;
}

export function cardClass(s, c) {
  const task = s.deploy.tasks[c.id];
  const selectable = !c.installed && !isActive(task);
  return [selectable ? 'selectable' : '', selectable && s.deploy.selected.has(c.id) ? 'selected' : '', isActive(task) ? 'busy' : ''].join(' ');
}

export function deployCard(s, c) {
  const logo = LOGO[c.id] ?? { ico: 'apps', c: C.blue };
  return `
    <div class="dep-top">
      <div class="app-logo" style="--c1:${logo.c[0]};--c2:${logo.c[1]}">${icon(logo.ico)}</div>
      <div class="grow" style="min-width:0">
        <h3>${esc(c.name)}</h3>
        <div class="muted" style="font-size:12.5px">${esc(c.publisher)} · ${esc(c.description)}</div>
      </div>
      <span class="checkbox" title="${c.installed ? '已安裝' : '勾選以派送'}">${icon('check')}</span>
    </div>
    <div class="dep-meta">
      <span class="chip muted">${esc(c.installer_kind)}</span>
      <span class="chip muted">靜默參數 <code class="k">${esc(c.install_args)}</code></span>
      <span class="chip muted">${icon('shield', 'width="12" height="12"')}簽章 ${esc(c.signer)}</span>
      <span class="chip muted">來源 ${esc(c.source)}</span>
    </div>
    <div class="dep-status" id="dep-status-${c.id}">${deployStatus(s, c)}</div>`;
}

export function deployStatus(s, c) {
  const task = s.deploy.tasks[c.id];
  if (isActive(task)) {
    const idx = stepIndex(task);
    const steps = STEPS[task.action].map(([label], i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${label}</span>`).join('');
    const pct = task.percent;
    const bytesText = task.total ? `${bytes(task.downloaded)} / ${bytes(task.total)}` : task.percent >= 0 ? `${task.percent.toFixed(0)}%` : '';
    return `
      <div class="mini-steps">${steps}</div>
      <div class="meter live ${pct < 0 || task.stage === 'queued' ? 'indeterminate' : ''}"><i style="--w:${Math.max(0, pct).toFixed(1)}%"></i></div>
      <div class="dep-msg"><span>${task.action === 'uninstall' ? '移除 · ' : ''}${esc(task.message)}</span><span class="mono">${bytesText}</span></div>
      ${task.stage === 'elevating' ? `<div class="uac-hint">${icon('shield')}請在 Windows 的「使用者帳戶控制」視窗按「是」，允許${task.action === 'install' ? '安裝' : '移除'}</div>` : ''}`;
  }
  const last = task ? `<div class="dep-msg" style="margin-top:10px"><span style="color:${task.stage === 'done' ? 'var(--good)' : task.stage === 'cancelled' ? 'var(--warn)' : 'var(--bad)'}">${esc(task.message)}</span></div>` : '';
  if (c.installed) {
    return `
      <div class="row" style="justify-content:space-between">
        <div class="row">${chip('good', `已安裝 ${c.installed.version}`)}</div>
        <button class="btn sm" data-action="dep-uninstall" data-id="${c.id}">${icon('x')}移除</button>
      </div>${last}`;
  }
  const retry = task && task.stage !== 'done' ? `<button class="btn sm" data-action="dep-retry" data-id="${c.id}">${icon('refresh')}重試</button>` : '';
  return `
    <div class="row" style="justify-content:space-between">
      <div class="row">${chip('muted', '未安裝')}${s.deploy.selected.has(c.id) ? chip('info', '已勾選') : ''}</div>
      ${retry}
    </div>${last}`;
}

export function deployBar(s) {
  const d = s.deploy;
  const names = (d.catalog ?? []).filter((c) => d.selected.has(c.id)).map((c) => c.name);
  const running = Object.values(d.tasks).filter(isActive).length;
  return `
    <div class="grow">
      <div style="font-weight:650">${names.length ? `已勾選 ${names.length} 個軟體` : '勾選上方的軟體，或套用軟體組合'}</div>
      <div class="muted" style="font-size:12.5px">${names.length ? esc(names.join('、')) : running ? `${running} 個工作進行中，依序執行` : '同一台電腦一次只執行一個安裝，其餘排隊'}</div>
    </div>
    ${names.length ? `<button class="btn ghost" data-action="dep-clear">清除</button>` : ''}
    <button class="btn primary" data-action="dep-start" ${names.length ? '' : 'disabled'}>${icon('download')}開始派送</button>`;
}

export function deployLog(s) {
  const log = s.deploy.log;
  if (!log.length) return '<div class="empty">還沒有派送紀錄</div>';
  return `<div class="timeline">${log.map((l) => `<div class="tl-item"><time>${fmtShort(l.at)}</time><b>${esc(l.name)}</b>　<span style="color:${toneVar(l.tone)}">${esc(l.text)}</span></div>`).join('')}</div>`;
}
