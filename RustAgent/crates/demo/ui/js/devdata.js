// 在一般瀏覽器預覽 ui/ 時使用的假資料（Tauri 內不會用到）。
const sample = {
  info: {
    system: {
      host_name: 'DEMO-PC', user_name: 'CORP\\demo.user', domain: 'CORP', part_of_domain: true,
      manufacturer: 'Contoso', model: 'Workstation 7', os_name: 'Windows 11 Pro', os_version: '11 (26100)',
      os_display_version: '24H2', os_build: '26100.4770', arch: 'x86_64', boot_time: Math.floor(Date.now() / 1000) - 3 * 86400,
    },
    identity: {
      bios_serial: 'CN0DEMO123', bios_vendor: 'Contoso BIOS', bios_version: '1.2.3', board_manufacturer: 'Contoso',
      board_product: 'Board X1', board_serial: 'BX1-0001', system_uuid: '00000000-1111-2222-3333-444444444444',
    },
    cpu: { name: 'Intel(R) Core(TM) i7-13700 CPU', cores: 16, logical: 24, max_mhz: 2100 },
    memory_total: 34359738368,
    memory_modules: [
      { slot: 'DIMM1', capacity: 17179869184, speed_mhz: 4800, manufacturer: 'Samsung', part_number: 'M425R2GA3BB0' },
      { slot: 'DIMM2', capacity: 17179869184, speed_mhz: 4800, manufacturer: 'Samsung', part_number: 'M425R2GA3BB0' },
    ],
    physical_disks: [{ model: 'NVMe SSD 1TB', serial: 'S6DEMO000001', size: 1024209543168, interface: 'SCSI', media_type: 'Fixed hard disk media' }],
    volumes: [
      { mount_point: 'C:\\', label: '', file_system: 'NTFS', total: 1022870155264, available: 402870155264, removable: false },
      { mount_point: 'D:\\', label: 'Data', file_system: 'NTFS', total: 2000398934016, available: 1600398934016, removable: false },
    ],
    gpus: [{ name: 'Intel(R) UHD Graphics 770', driver_version: '31.0.101.5186', resolution: '2560 × 1440' }],
    network: [{ description: 'Intel(R) Ethernet Connection I219-LM', mac: '00:11:22:33:44:55', ips: ['10.0.8.23', 'fe80::1'], gateways: ['10.0.8.1'], dns: ['10.0.0.10', '10.0.0.11'], dhcp_enabled: true }],
    software: [
      ['7-Zip 24.08', '24.08', 'Igor Pavlov', '2026-03-02'], ['Adobe Acrobat', '25.001', 'Adobe', '2026-05-11'],
      ['Google Chrome', '140.0.7339', 'Google LLC', '2026-09-20'], ['Microsoft 365', '16.0.19127', 'Microsoft Corporation', '2026-09-01'],
      ['Microsoft Teams', '25.1', 'Microsoft Corporation', '2026-08-30'], ['Notepad++', '8.7', 'Notepad++ Team', '2026-01-15'],
      ['RustDesk', '1.4.9', 'RustDesk', '2026-09-16'], ['Steam', '', 'Valve Corporation', '2026-04-04'],
      ['Visual Studio Code', '1.104', 'Microsoft Corporation', '2026-09-10'], ['qBittorrent 5.0', '5.0', 'The qBittorrent project', '2026-02-02'],
    ].map(([name, version, publisher, install_date]) => ({ name, version, publisher, install_date })),
    security: {
      antivirus: [{ name: 'Windows Defender', enabled: true, up_to_date: true }],
      recent_hotfixes: [{ id: 'KB5062660', description: 'Update', installed_on: '8/3/2026' }, { id: 'KB5056579', description: 'Security Update', installed_on: '7/29/2026' }],
    },
    usb: { storage_policy: 'Allowed', storage_history: [{ friendly_name: 'SanDisk Ultra USB Device', serial: '4C530001' }] },
    rustdesk: { installed: true, version: '1.4.9', exe_path: 'C:\\Program Files\\RustDesk\\rustdesk.exe', id: '123456789', custom_server: 'rd.corp.local' },
    collect_ms: 1830,
    warnings: [],
  },
  asset_key: 'CN0DEMO123',
  bios_placeholder: false,
  primary_ip: '10.0.8.23',
  hardware_changes: null,
};

// 軟體派送的模擬：用計時器送出與 Rust 端相同格式的進度事件
const catalog = [
  { id: 'firefox', name: 'Mozilla Firefox', publisher: 'Mozilla', description: '開放原始碼網頁瀏覽器（繁體中文，64 位元）', installer_kind: 'EXE（NSIS）', install_args: '/S /MaintenanceService=false', uninstall_args: '/S', signer: 'Mozilla Corporation', source: 'download.mozilla.org', installed: null },
  { id: 'winrar', name: 'WinRAR', publisher: 'win.rar GmbH', description: '壓縮 / 解壓縮工具（繁體中文，64 位元，商業軟體）', installer_kind: 'EXE（WinRAR 安裝程式）', install_args: '/S', uninstall_args: '/S', signer: 'win.rar GmbH', source: 'www.rarlab.com', installed: null },
];
const sizes = { firefox: 92968216, winrar: 3870328 };
let listener = () => {};
let queue = Promise.resolve();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (id, action, stage, percent, message, downloaded = 0, total = 0) =>
  listener({ id, action, stage, percent, downloaded, total, message });

async function simulate(id, action) {
  const c = catalog.find((x) => x.id === id);
  if (action === 'install') {
    const total = sizes[id];
    for (let got = 0; got < total; got += total / 25) {
      emit(id, action, 'downloading', (got / total) * 100, `${id}.exe · 18.4 MB/s`, got, total);
      await wait(120);
    }
    emit(id, action, 'verifying', -1, '驗證數位簽章…'); await wait(900);
    emit(id, action, 'elevating', -1, '等待 Windows 的 UAC 確認…'); await wait(1500);
    emit(id, action, 'running', -1, '靜默執行中…'); await wait(2000);
    emit(id, action, 'checking', -1, '確認安裝結果…'); await wait(700);
    c.installed = { name: `${c.name} 1.0`, version: '1.0', publisher: c.publisher, uninstall_string: '', quiet_uninstall_string: '', install_location: '' };
    emit(id, action, 'done', 100, `安裝完成：${c.installed.name}`);
  } else {
    emit(id, action, 'verifying', 100, '解除安裝程式：uninstall.exe'); await wait(500);
    emit(id, action, 'elevating', -1, '等待 Windows 的 UAC 確認…'); await wait(1200);
    emit(id, action, 'running', -1, '靜默執行中…'); await wait(1500);
    emit(id, action, 'checking', -1, '確認已移除…'); await wait(600);
    const name = c.installed.name;
    c.installed = null;
    emit(id, action, 'done', 100, `已移除 ${name}`);
  }
}

function enqueue(ids, action) {
  ids.forEach((id) => emit(id, action, 'queued', 0, '排隊中'));
  ids.forEach((id) => { queue = queue.then(() => simulate(id, action)); });
}

let collected = 0;
export const devApi = {
  deployCatalog: async () => structuredClone(catalog),
  deployInstall: async (ids) => enqueue(ids, 'install'),
  deployUninstall: async (id) => enqueue([id], 'uninstall'),
  onDeploy: (cb) => { listener = cb; },
  collect: () => new Promise((r) => setTimeout(() => {
    collected++;
    r({ ...sample, hardware_changes: collected > 1 ? [[], []] : null });
  }, 1200)),
  live: async () => ({
    cpu: 12 + Math.random() * 30,
    mem_used: 16e9 + Math.random() * 2e9,
    mem_total: 34359738368,
    uptime: 3 * 86400 + Math.floor(performance.now() / 1000),
  }),
  exportJson: async () => 'C:\\RustIt\\rustit-DEMO-PC.json',
  reveal: async () => {},
  openRustDesk: async () => {},
  win: null,
};
