//! 各頁內容，對應 WebView 版 `ui/js/pages.js`。報修單、公告、軟體派送是前端的模擬流程，
//! 與效能比較無關，原生版沒有實作；另外新增「效能比較」頁。

use crate::app::{App, Page};
use crate::data::{self, Snapshot, bytes, dash, duration};
use crate::perf::{self, FRAME_HISTORY};
use crate::theme::{Theme, Tone, bold_font};
use crate::widgets::{Cell, W, card, card_row, chip, grad, head, head_r, kv, meter, note, page_head, ring, spark, status_link, status_row, table};
use eframe::egui::{Align, Button, Color32, FontId, Frame, Label, Layout, Margin, RichText, Spinner, Stroke, TextEdit, Ui};
use rustit_collector::{ComputerInfo, UsbPolicy};

impl App {
    pub fn page_ui(&mut self, ui: &mut Ui, t: &Theme) {
        let needs_data = !matches!(self.page, Page::Perf);
        if needs_data && self.snap.is_none() {
            loading(ui, t);
            return;
        }
        match self.page {
            Page::Overview => self.overview(ui, t),
            Page::Hardware => hardware(ui, t, self.snap.as_ref().unwrap()),
            Page::Network => network(ui, t, &self.snap.as_ref().unwrap().info),
            Page::Software => self.software(ui, t),
            Page::Security => security(ui, t, &self.snap.as_ref().unwrap().info),
            Page::Remote => self.remote(ui, t),
            Page::Perf => self.perf(ui, t),
        }
    }

    // ------------------------------------------------------------ 總覽

    fn overview(&mut self, ui: &mut Ui, t: &Theme) {
        let now = ui.input(|i| i.time);
        // 進入頁面時圓環從 0 轉到目前值（0.7 秒，ease-out）；之後每秒直接更新，不做補間。
        let k = ((now - self.page_entered) / 0.7).clamp(0.0, 1.0) as f32;
        if k < 1.0 {
            ui.ctx().request_repaint();
        }
        let ease = 1.0 - (1.0 - k).powi(3);
        let mut goto = None;
        let s = self.snap.as_ref().unwrap();
        let info = &s.info;
        let sys = &info.system;
        let user = sys.user_name.rsplit('\\').next().unwrap_or_default();
        let st = statuses(info);
        let issues = st.iter().filter(|x| x.tone != Tone::Good).count();

        card(ui, t, |ui| {
            ui.horizontal(|ui| {
                crate::widgets::icon_box(ui, "✨", grad::VIOLET, 50.0);
                ui.add_space(6.0);
                ui.vertical(|ui| {
                    ui.label(RichText::new(format!("{}，{user}", data::greeting())).font(bold_font(22.0)).color(t.text));
                    let msg = if issues > 0 { format!("這台電腦有 {issues} 個項目值得留意，其餘一切正常。") } else { "這台電腦一切正常。".into() };
                    ui.label(RichText::new(msg).color(t.text2));
                });
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    chip(ui, t, Tone::Good, &format!("蒐集 {} ms", info.collect_ms), false);
                    chip(ui, t, Tone::Violet, &format!("{} 顆硬碟", info.physical_disks.len()), false);
                    chip(ui, t, Tone::Info, &format!("{} 個軟體", info.software.len()), false);
                });
            });
        });

        let domain = if sys.part_of_domain { ("AD 網域", "已加入網域") } else { ("工作群組", "未加入網域") };
        let stats = [
            ("🖥", "電腦名稱", sys.host_name.clone(), format!("{} {}", sys.manufacturer, sys.model)),
            ("👤", "登入者", sys.user_name.clone(), "目前登入的帳號".into()),
            ("🏢", domain.0, sys.domain.clone(), domain.1.into()),
            (
                "📶",
                "IP 位址",
                s.primary_ip.clone().unwrap_or_default(),
                info.network.first().map(|n| format!("MAC {}", n.mac)).unwrap_or_default(),
            ),
        ];
        card_row(ui, t, "ov-stats", &[1.0; 4], |i, ui| {
            let (icon, label, value, hint) = &stats[i];
            ui.label(RichText::new(format!("{icon}  {label}")).size(12.5).color(t.text3));
            ui.add(Label::new(RichText::new(dash(value)).font(bold_font(19.0)).color(t.text)).truncate());
            ui.add(Label::new(RichText::new(hint.trim()).size(12.0).color(t.text3)).truncate());
        });

        let live = self.live;
        let sys_vol = info
            .volumes
            .iter()
            .find(|v| v.mount_point.to_uppercase().starts_with("C:"))
            .or(info.volumes.first());
        card_row(ui, t, "ov-live", &[2.0, 1.0], |i, ui| {
            if i == 0 {
                head(ui, t, "📈", "即時使用率", "每秒更新", grad::BLUE);
                ui.columns(3, |cols| {
                    let (cpu, cpu_foot) = live.map_or((0.0, "—".into()), |l| (l.cpu, format!("{} 執行緒", info.cpu.logical)));
                    ring(&mut cols[0], t, cpu * ease, "CPU", &cpu_foot, grad::BLUE);
                    let (mem, mem_foot) = live.map_or((0.0, "—".into()), |l| {
                        (l.mem_used as f32 / l.mem_total.max(1) as f32 * 100.0, format!("{} / {}", bytes(l.mem_used), bytes(l.mem_total)))
                    });
                    ring(&mut cols[1], t, mem * ease, "記憶體", &mem_foot, grad::VIOLET);
                    if let Some(v) = sys_vol {
                        let pct = (v.total - v.available) as f32 / v.total.max(1) as f32 * 100.0;
                        ring(&mut cols[2], t, pct * ease, v.mount_point.trim_end_matches('\\'), &format!("可用 {}", bytes(v.available)), grad::TEAL);
                    }
                });
            } else {
                head(ui, t, "⚙", "CPU 走勢", "最近 60 秒", grad::VIOLET);
                spark(ui, t, &self.cpu_hist, 60);
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    let up = live.map_or_else(|| "—".into(), |l| duration(l.uptime));
                    ui.label(RichText::new("已開機").color(t.text3));
                    ui.label(RichText::new(up).font(bold_font(13.5)).color(t.text));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let peak = self.cpu_hist.iter().copied().fold(None, |m: Option<f32>, v| Some(m.map_or(v, |m| m.max(v))));
                        ui.label(RichText::new(peak.map_or("—".into(), |p| format!("{p:.0}%"))).font(bold_font(13.5)).color(t.text));
                        ui.label(RichText::new("峰值").color(t.text3));
                    });
                });
            }
        });

        card_row(ui, t, "ov-status", &[1.0, 1.0], |i, ui| {
            if i == 0 {
                head(ui, t, "✨", "狀態摘要", "", grad::GREEN);
                for x in &st {
                    if status_link(ui, t, x.icon, x.name, &x.text, x.tone).clicked() {
                        goto = Some(x.page);
                    }
                }
            } else {
                head(ui, t, "📋", "系統", "", grad::AMBER);
                kv(
                    ui,
                    t,
                    &[
                        ("作業系統", format!("{} {}", sys.os_name, sys.os_display_version)),
                        ("組建", sys.os_build.clone()),
                        ("主機板", format!("{} {}", info.identity.board_manufacturer, info.identity.board_product)),
                        ("處理器", info.cpu.name.clone()),
                        ("記憶體", bytes(info.memory_total)),
                        ("開機時間", data::fmt_datetime(sys.boot_time)),
                        ("資產識別碼", s.asset_key.clone()),
                    ],
                );
            }
        });

        card(ui, t, |ui| {
            head(ui, t, "💽", "磁碟區", &format!("{} 個", info.volumes.len()), grad::TEAL);
            volumes(ui, t, info);
        });

        if !info.warnings.is_empty() {
            card(ui, t, |ui| {
                head(ui, t, "⚠", "蒐集警告", "", grad::AMBER);
                for w in &info.warnings {
                    ui.add(Label::new(RichText::new(w).color(t.warn)).wrap());
                }
            });
        }

        if let Some(page) = goto {
            self.goto(page, now);
        }
    }

    // ------------------------------------------------------------ 軟體

    fn software(&mut self, ui: &mut Ui, t: &Theme) {
        let list = &self.snap.as_ref().unwrap().info.software;
        let mut filter = std::mem::take(&mut self.sw_filter);
        page_head(ui, t, "已安裝軟體", "讀取登錄檔 Uninstall 機碼，與「設定 › 應用程式」相同的清單", |ui| {
            ui.add(TextEdit::singleline(&mut filter).hint_text("🔍 搜尋名稱或發行者").desired_width(280.0).margin(Margin::symmetric(10, 7)));
        });
        self.sw_filter = filter;

        let hits = list.iter().filter(|x| blacklist_hit(&x.name).is_some()).count();
        if hits > 0 {
            note(ui, t, &format!("範例黑名單規則（P2P、遊戲平台）命中 {hits} 項，以橘色標示。正式版會通知 IT，也能設定自動結束程式。"));
        }
        let f = self.sw_filter.trim().to_lowercase();
        let rows: Vec<_> = list
            .iter()
            .filter(|x| f.is_empty() || x.name.to_lowercase().contains(&f) || x.publisher.to_lowercase().contains(&f))
            .collect();
        let count = if f.is_empty() { format!("共 {} 項", rows.len()) } else { format!("顯示 {} / {} 項", rows.len(), list.len()) };
        card(ui, t, |ui| {
            head(ui, t, "📦", "軟體清單", &count, grad::BLUE);
            if rows.is_empty() {
                ui.label(RichText::new("沒有符合的軟體").color(t.text3));
                return;
            }
            table(
                ui,
                t,
                &[("名稱", W::Fr(2.6)), ("版本", W::Fr(1.0)), ("發行者", W::Fr(1.5)), ("安裝日期", W::Px(96.0))],
                rows.len(),
                |r, c| {
                    let x = rows[r];
                    match c {
                        0 => Cell::new(&x.name).badge(blacklist_hit(&x.name).map(|why| (Tone::Warn, why))),
                        1 => Cell::new(&x.version).dim().mono(),
                        2 => Cell::new(&x.publisher).dim(),
                        _ => Cell::new(&x.install_date).dim(),
                    }
                },
                |r| blacklist_hit(&rows[r].name).is_some(),
            );
        });
    }

    // ------------------------------------------------------------ 遠端協助

    fn remote(&mut self, ui: &mut Ui, t: &Theme) {
        let rd = &self.snap.as_ref().unwrap().info.rustdesk;
        let mut action = None;
        page_head(ui, t, "遠端協助", "IT 透過公司自架的 RustDesk 伺服器一鍵連線到這台電腦（PRD 6）", |_| {});
        let steps: [(&str, Option<bool>, String); 7] = [
            ("檢查是否已安裝", Some(rd.installed), if rd.installed { format!("已安裝 {}", rd.version) } else { "未安裝".into() }),
            ("從公司伺服器下載", None, "正式版：下載後驗證 SHA-256".into()),
            ("靜默安裝", Some(rd.installed), if rd.installed { "已完成".into() } else { "msiexec /i rustdesk.msi /qn".into() }),
            (
                "設定自架伺服器",
                Some(!rd.custom_server.is_empty()),
                if rd.custom_server.is_empty() { "尚未設定（rustdesk.exe --config）".into() } else { rd.custom_server.clone() },
            ),
            ("設定連線密碼", None, "Demo 不變更密碼（rustdesk.exe --password）".into()),
            ("回報 ID 給後台", Some(!rd.id.is_empty()), if rd.id.is_empty() { "讀不到 ID".into() } else { rd.id.clone() }),
            ("守護與自動修復", None, "正式版：每次掃描檢查服務與設定".into()),
        ];
        card_row(ui, t, "remote", &[1.0, 1.0], |i, ui| {
            if i == 0 {
                head_r(ui, t, "🎧", "本機 RustDesk", "", grad::BLUE, |ui| {
                    if rd.installed {
                        chip(ui, t, Tone::Good, &format!("已安裝 {}", rd.version), true);
                    } else {
                        chip(ui, t, Tone::Bad, "未安裝", true);
                    }
                });
                ui.label(RichText::new("RustDesk ID").size(12.5).color(t.text3));
                ui.label(RichText::new(group3(&rd.id)).font(bold_font(32.0)).color(t.text));
                ui.horizontal(|ui| {
                    let copy = Button::new(RichText::new("📋 複製 ID").color(Color32::WHITE)).fill(t.accent).stroke(Stroke::NONE);
                    if ui.add_enabled(!rd.id.is_empty(), copy).clicked() {
                        action = Some(RemoteAction::Copy);
                    }
                    if ui.add_enabled(!rd.exe_path.is_empty(), Button::new("▶ 開啟 RustDesk")).clicked() {
                        action = Some(RemoteAction::Open);
                    }
                });
                ui.add_space(4.0);
                let server = if !rd.installed {
                    String::new()
                } else if rd.custom_server.is_empty() {
                    "RustDesk 公共伺服器（正式版改為公司自架）".into()
                } else {
                    format!("{}（自架）", rd.custom_server)
                };
                kv(ui, t, &[("連線伺服器", server), ("執行檔", rd.exe_path.clone())]);
            } else {
                head(ui, t, "✔", "Agent 自動部署流程", "本機檢查結果", grad::GREEN);
                for (n, (name, ok, detail)) in steps.iter().enumerate() {
                    let (icon, tone) = match ok {
                        None => ("–", Tone::Muted),
                        Some(true) => ("✔", Tone::Good),
                        Some(false) => ("✖", Tone::Bad),
                    };
                    status_row(ui, t, icon, &format!("{}. {name}", n + 1), detail, tone, 150.0);
                }
            }
        });

        match action {
            Some(RemoteAction::Copy) => {
                ui.ctx().copy_text(rd.id.clone());
                let msg = format!("已複製 RustDesk ID {}", rd.id);
                self.toast(msg, true);
            }
            Some(RemoteAction::Open) => {
                let result = std::process::Command::new(&rd.exe_path).spawn();
                if let Err(e) = result {
                    self.toast(format!("無法開啟 RustDesk：{e}"), false);
                }
            }
            None => {}
        }
    }

    // ------------------------------------------------------------ 效能比較

    fn perf(&mut self, ui: &mut Ui, t: &Theme) {
        page_head(ui, t, "效能比較", "原生 egui 版本身的資源用量；與 WebView2 版並排比較請用 scripts/bench.ps1", |_| {});
        let u = self.usage.unwrap_or_default();
        let fr = &self.frames;
        let (build_avg, build_max) = perf::avg_max(&fr.build_ms);
        let (cpu_avg, cpu_max) = perf::avg_max(&fr.frame_cpu_ms);
        let stats = [
            ("啟動到第一個畫面", fr.first_frame_ms.map_or("—".into(), |ms| format!("{ms:.0} ms")), "從行程建立算起，含載入 DLL、繪圖後端、字型"),
            ("記憶體（工作集）", bytes(u.working_set), "與工作管理員「詳細資料」的工作集相同"),
            ("私有記憶體", bytes(u.private), "本行程獨占、無法與其他程式共用的部分"),
            ("CPU", format!("{:.2}%", u.cpu), "最近 1 秒平均，全部邏輯處理器為 100%"),
        ];
        card_row(ui, t, "perf-stats", &[1.0; 4], |i, ui| {
            let (label, value, hint) = &stats[i];
            ui.label(RichText::new(*label).size(12.5).color(t.text3));
            ui.label(RichText::new(value).font(bold_font(22.0)).color(t.text));
            ui.add(Label::new(RichText::new(*hint).size(12.0).color(t.text3)).wrap());
        });

        let mut continuous = self.continuous;
        card(ui, t, |ui| {
            head_r(ui, t, "⏱", "畫面更新", "最近 120 幀", grad::VIOLET, |ui| {
                ui.checkbox(&mut continuous, "持續重繪（壓力測試）");
            });
            ui.horizontal_wrapped(|ui| {
                chip(ui, t, Tone::Info, &format!("最近 1 秒繪製 {} 幀", fr.fps()), true);
                chip(ui, t, Tone::Violet, &format!("建構介面 平均 {build_avg:.2} ms · 最高 {build_max:.2} ms"), false);
                chip(ui, t, Tone::Violet, &format!("每幀 CPU 平均 {cpu_avg:.2} ms · 最高 {cpu_max:.2} ms"), false);
                chip(ui, t, Tone::Muted, &format!("累計 {} 幀", fr.total_frames), false);
            });
            ui.add_space(6.0);
            ui.label(RichText::new("每幀 CPU 時間（建構介面 + 排版 + 送出繪圖指令，不含等待垂直同步）").size(12.5).color(t.text3));
            crate::widgets::frame_bars(ui, t, &fr.frame_cpu_ms, FRAME_HISTORY);
            ui.add(
                Label::new(
                    RichText::new(
                        "egui 是「有變動才重繪」：沒有滑鼠、鍵盤輸入，也沒有資料更新時完全不畫，閒置時 FPS 為 0。\
                         這一頁與總覽每秒更新一次數字，所以約 1 fps。勾選「持續重繪」可看到每一幀的真實成本與畫面上限（受垂直同步限制）。",
                    )
                    .size(12.5)
                    .color(t.text2),
                )
                .wrap(),
            );
        });
        self.continuous = continuous;

        card_row(ui, t, "perf-arch", &[1.0, 1.0], |i, ui| {
            if i == 0 {
                head(ui, t, "⚡", "原生版（這個程式）", "", grad::AMBER);
                kv(
                    ui,
                    t,
                    &[
                        ("行程數", "1".into()),
                        ("介面", "egui 立即模式，Rust 直接產生三角形網格".into()),
                        ("繪圖", format!("{}，與介面同一條執行緒", self.renderer)),
                        ("字型", "直接對應系統字型檔（Segoe UI、微軟正黑體），不複製進記憶體".into()),
                        ("執行檔", bytes(self.exe_size)),
                    ],
                );
            } else {
                head(ui, t, "🌐", "WebView2 版（Tauri）", "", grad::BLUE);
                kv(
                    ui,
                    t,
                    &[
                        ("行程數", "1 + msedgewebview2.exe × 6（瀏覽器、GPU、網頁轉譯、網路、儲存、當機回報）".into()),
                        ("介面", "HTML / CSS / JavaScript，DOM 排版與樣式計算".into()),
                        ("繪圖", "Chromium 合成器 + GPU 行程（DirectX）".into()),
                        ("特效", "背景模糊、SVG 折射、CSS 動畫（可切換精簡模式）".into()),
                        ("資料傳遞", "Rust 序列化成 JSON，經 IPC 交給 JavaScript".into()),
                    ],
                );
            }
        });

        card(ui, t, |ui| {
            head(ui, t, "📊", "並排比較兩個版本", "同一台電腦、同樣停在總覽頁", grad::TEAL);
            ui.add(
                Label::new(
                    RichText::new(
                        "在專案根目錄執行下列指令：腳本會先後啟動兩個 exe，各自等待資料蒐集完成，再取樣 30 秒，\
                         加總主程式與所有子行程（WebView2 的 msedgewebview2.exe）的記憶體、CPU、執行緒與控制代碼，最後列出對照表。\
                         量測期間請不要切換視窗（兩個版本在背景時都會暫停更新）。",
                    )
                    .color(t.text2),
                )
                .wrap(),
            );
            let cmd = "powershell -ExecutionPolicy Bypass -File scripts\\bench.ps1";
            ui.horizontal(|ui| {
                Frame::new()
                    .fill(t.glass2)
                    .corner_radius(10)
                    .inner_margin(Margin::symmetric(12, 8))
                    .show(ui, |ui| ui.label(RichText::new(cmd).font(FontId::monospace(13.0)).color(t.text)));
                if ui.button("📋 複製").clicked() {
                    ui.ctx().copy_text(cmd.into());
                }
            });
        });
        if self.continuous {
            ui.ctx().request_repaint();
        }
    }
}

enum RemoteAction {
    Copy,
    Open,
}

fn loading(ui: &mut Ui, t: &Theme) {
    ui.add_space(ui.available_height().min(600.0) * 0.3);
    ui.vertical_centered(|ui| {
        ui.add(Spinner::new().size(42.0).color(t.accent));
        ui.add_space(18.0);
        ui.label(RichText::new("正在蒐集這台電腦的資料").font(bold_font(22.0)).color(t.text));
        ui.label(RichText::new("讀取硬體、網路、軟體與安全狀態，約需 2 秒…").color(t.text2));
    });
}

/// RustDesk ID 每三碼加一個空白（與 WebView 版相同）。
fn group3(id: &str) -> String {
    if id.is_empty() {
        return "— — —".into();
    }
    let chars: Vec<char> = id.chars().collect();
    chars.chunks(3).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join(" ")
}

const BLACKLIST: [(&str, &str); 7] = [
    ("torrent", "P2P"),
    ("emule", "P2P"),
    ("迅雷", "P2P"),
    ("thunder", "P2P"),
    ("steam", "遊戲平台"),
    ("epic games", "遊戲平台"),
    ("battle.net", "遊戲平台"),
];

fn blacklist_hit(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    BLACKLIST.iter().find(|(k, _)| n.contains(k)).map(|(_, why)| *why)
}

struct Status {
    icon: &'static str,
    name: &'static str,
    tone: Tone,
    text: String,
    page: Page,
}

/// 狀態摘要。WebView 版還有「公告」「報修單」兩項，屬於模擬資料，原生版不列。
fn statuses(info: &ComputerInfo) -> Vec<Status> {
    let sys = &info.system;
    let av = &info.security.antivirus;
    let rd = &info.rustdesk;
    let (tone, text) = if sys.part_of_domain {
        (Tone::Good, format!("已加入 AD 網域 {}", sys.domain))
    } else {
        (Tone::Warn, "未加入網域（在家測試屬正常）".into())
    };
    let domain = Status { icon: "🏢", name: "網域", tone, text, page: Page::Overview };
    let (tone, text) = match av.iter().find(|a| a.enabled) {
        Some(a) if a.up_to_date => (Tone::Good, format!("{} 已啟用，病毒碼最新", a.name)),
        Some(a) => (Tone::Warn, format!("{} 病毒碼過期", a.name)),
        None if av.is_empty() => (Tone::Bad, "未偵測到防毒軟體".into()),
        None => (Tone::Bad, "防毒軟體未啟用".into()),
    };
    let antivirus = Status { icon: "🛡", name: "防毒", tone, text, page: Page::Security };
    let (tone, text) = match info.usb.storage_policy {
        UsbPolicy::Blocked => (Tone::Good, "USB 儲存裝置已封鎖".into()),
        UsbPolicy::Allowed => (Tone::Warn, format!("允許（曾插入 {} 個裝置）", info.usb.storage_history.len())),
        UsbPolicy::Unknown => (Tone::Warn, "無法讀取".into()),
    };
    let usb = Status { icon: "🔌", name: "USB 儲存", tone, text, page: Page::Security };
    let (tone, text) = match (rd.installed, rd.id.is_empty()) {
        (true, false) => (Tone::Good, format!("RustDesk {} · ID {}", rd.version, rd.id)),
        (true, true) => (Tone::Warn, "已安裝，但讀不到 ID".into()),
        (false, _) => (Tone::Bad, "未安裝（正式版由 Agent 自動安裝）".into()),
    };
    let remote = Status { icon: "🎧", name: "遠端協助", tone, text, page: Page::Remote };
    vec![domain, antivirus, usb, remote]
}

fn volumes(ui: &mut Ui, t: &Theme, info: &ComputerInfo) {
    for v in &info.volumes {
        let pct = if v.total > 0 { (v.total - v.available) as f32 / v.total as f32 * 100.0 } else { 0.0 };
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new(&v.mount_point).font(bold_font(14.0)).color(t.text));
            if !v.label.is_empty() {
                ui.label(RichText::new(&v.label).size(12.0).color(t.text3));
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let text = format!("{pct:.0}% · 可用 {} / {}", bytes(v.available), bytes(v.total));
                ui.label(RichText::new(text).size(12.5).color(t.text2));
            });
        });
        meter(ui, t, pct);
    }
}

// ------------------------------------------------------------ 硬體

fn hardware(ui: &mut Ui, t: &Theme, s: &Snapshot) {
    let info = &s.info;
    let id = &info.identity;
    page_head(ui, t, "硬體資訊", "透過 WMI 蒐集，資產以 BIOS 序號 / 系統 UUID 唯一識別（PRD 2）", |_| {});

    card_row(ui, t, "hw-top", &[1.0, 1.0], |i, ui| {
        if i == 0 {
            head(ui, t, "⚙", "處理器", "", grad::BLUE);
            ui.add(Label::new(RichText::new(&info.cpu.name).font(bold_font(19.0)).color(t.text)).wrap());
            ui.add_space(6.0);
            ui.horizontal_wrapped(|ui| {
                chip(ui, t, Tone::Info, &format!("{} 核心", info.cpu.cores), false);
                chip(ui, t, Tone::Violet, &format!("{} 執行緒", info.cpu.logical), false);
                chip(ui, t, Tone::Muted, &format!("{} MHz", info.cpu.max_mhz), false);
                chip(ui, t, Tone::Muted, &info.system.arch, false);
            });
        } else {
            head(ui, t, "📋", "主機板與 BIOS", "", grad::AMBER);
            let serial = if s.bios_placeholder { format!("{}（預設值，改用 UUID）", id.bios_serial) } else { id.bios_serial.clone() };
            kv(
                ui,
                t,
                &[
                    ("廠牌 / 型號", format!("{} {}", info.system.manufacturer, info.system.model)),
                    ("主機板", format!("{} {}", id.board_manufacturer, id.board_product)),
                    ("BIOS", format!("{} {}", id.bios_vendor, id.bios_version)),
                    ("BIOS 序號", serial),
                    ("系統 UUID", id.system_uuid.clone()),
                ],
            );
        }
    });

    card(ui, t, |ui| {
        let sub = format!("共 {} · {} 條", bytes(info.memory_total), info.memory_modules.len());
        head(ui, t, "💾", "記憶體", &sub, grad::VIOLET);
        for chunk in info.memory_modules.chunks(4) {
            ui.columns(4, |cols| {
                for (m, ui) in chunk.iter().zip(cols.iter_mut()) {
                    Frame::new()
                        .fill(t.glass)
                        .stroke(Stroke::new(1.0, t.rim))
                        .corner_radius(16)
                        .inner_margin(Margin::symmetric(14, 12))
                        .show(ui, |ui| {
                            ui.set_min_width(ui.available_width());
                            ui.spacing_mut().item_spacing.y = 3.0;
                            ui.label(RichText::new(dash(&m.slot)).size(12.0).color(t.text3));
                            ui.label(RichText::new(bytes(m.capacity)).font(bold_font(19.0)).color(t.text));
                            ui.add(Label::new(RichText::new(format!("{} · {} MHz", dash(&m.manufacturer), m.speed_mhz)).size(12.5).color(t.text2)).truncate());
                            ui.add(Label::new(RichText::new(dash(&m.part_number)).font(FontId::monospace(11.5)).color(t.text3)).truncate());
                        });
                }
            });
        }
    });

    card(ui, t, |ui| {
        head(ui, t, "💽", "實體硬碟", &format!("{} 顆", info.physical_disks.len()), grad::TEAL);
        let disks = &info.physical_disks;
        table(
            ui,
            t,
            &[("型號", W::Fr(2.0)), ("序號", W::Fr(2.2)), ("容量", W::Px(100.0)), ("介面", W::Px(80.0))],
            disks.len(),
            |r, c| {
                let d = &disks[r];
                match c {
                    0 => Cell::new(&d.model),
                    1 => Cell::new(d.serial.trim_end_matches('.')).dim().mono(),
                    2 => Cell::new(bytes(d.size)),
                    _ => Cell::new(&d.interface).dim(),
                }
            },
            |_| false,
        );
    });

    card(ui, t, |ui| {
        head(ui, t, "💽", "磁碟區", "", grad::GREEN);
        volumes(ui, t, info);
    });

    card_row(ui, t, "hw-bottom", &[1.0, 1.0], |i, ui| {
        if i == 0 {
            head(ui, t, "🖥", "顯示卡", "", grad::PINK);
            for g in &info.gpus {
                ui.label(RichText::new(&g.name).font(bold_font(14.0)).color(t.text));
                let res = if g.resolution.is_empty() { String::new() } else { format!(" · {}", g.resolution) };
                ui.label(RichText::new(format!("驅動 {}{res}", g.driver_version)).size(12.5).color(t.text3));
                ui.add_space(4.0);
            }
        } else {
            head(ui, t, "🔄", "硬體變更偵測", "", grad::SLATE);
            match &s.hardware_changes {
                None => {
                    ui.add(
                        Label::new(
                            RichText::new("目前是第一次蒐集。按右上角「重新蒐集」後會與這次結果比對，記憶體、硬碟、顯示卡若有拆換會列在這裡。")
                                .color(t.text2),
                        )
                        .wrap(),
                    );
                }
                Some((added, removed)) if added.is_empty() && removed.is_empty() => {
                    chip(ui, t, Tone::Good, "與上次蒐集相比，硬體沒有變更", true);
                }
                Some((added, removed)) => {
                    chip(ui, t, Tone::Warn, "偵測到硬體變更，正式版會通知 IT", true);
                    for p in added {
                        ui.label(RichText::new(format!("＋ {p}")).color(t.warn));
                    }
                    for p in removed {
                        ui.label(RichText::new(format!("－ {p}")).color(t.bad));
                    }
                }
            }
        }
    });
}

// ------------------------------------------------------------ 網路

fn network(ui: &mut Ui, t: &Theme, info: &ComputerInfo) {
    page_head(ui, t, "網路", "目前啟用的網路介面卡（Win32_NetworkAdapterConfiguration）", |_| {});
    for n in &info.network {
        let (v4, v6): (Vec<&String>, Vec<&String>) = n.ips.iter().partition(|ip| ip.contains('.'));
        let join = |v: Vec<&String>| v.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
        card(ui, t, |ui| {
            head_r(ui, t, "📶", &n.description, "", grad::TEAL, |ui| {
                if n.dhcp_enabled {
                    chip(ui, t, Tone::Info, "DHCP", false);
                } else {
                    chip(ui, t, Tone::Violet, "固定 IP", false);
                }
            });
            ui.columns(2, |cols| {
                kv(&mut cols[0], t, &[("MAC", n.mac.clone()), ("IPv4", join(v4)), ("IPv6", join(v6))]);
                kv(
                    &mut cols[1],
                    t,
                    &[
                        ("預設閘道", n.gateways.join(", ")),
                        ("DNS", n.dns.join(", ")),
                        ("DHCP", if n.dhcp_enabled { "啟用" } else { "停用" }.into()),
                    ],
                );
            });
        });
    }
    card(ui, t, |ui| {
        head(ui, t, "🛡", "網路控管", "正式版功能", grad::SLATE);
        for (icon, name, desc) in [
            ("⚠", "未授權設備偵測", "網路掃描發現的 MAC 不在資產清冊即告警"),
            ("🌐", "網站封鎖 / 程式連線限制", "Agent 透過 Windows Filtering Platform 執行"),
            ("📈", "流量統計", "依程式統計上傳 / 下載流量"),
        ] {
            status_row(ui, t, icon, name, desc, Tone::Muted, 200.0);
        }
    });
}

// ------------------------------------------------------------ 安全

fn security(ui: &mut Ui, t: &Theme, info: &ComputerInfo) {
    let sys = &info.system;
    let usb = info.usb.storage_policy;
    page_head(ui, t, "安全與控管", "防毒、Windows 更新、USB 儲存裝置（PRD 4.3、5.2）", |_| {});
    card_row(ui, t, "sec-top", &[1.0, 1.0], |i, ui| {
        if i == 0 {
            head(ui, t, "🛡", "防毒軟體", "", grad::GREEN);
            if info.security.antivirus.is_empty() {
                chip(ui, t, Tone::Bad, "未偵測到防毒軟體", true);
            }
            for a in &info.security.antivirus {
                ui.label(RichText::new(&a.name).font(bold_font(18.0)).color(t.text));
                ui.horizontal_wrapped(|ui| {
                    chip(ui, t, if a.enabled { Tone::Good } else { Tone::Bad }, if a.enabled { "即時防護已啟用" } else { "即時防護未啟用" }, true);
                    chip(ui, t, if a.up_to_date { Tone::Good } else { Tone::Warn }, if a.up_to_date { "病毒碼為最新" } else { "病毒碼過期" }, true);
                });
                ui.add_space(6.0);
            }
        } else {
            head(ui, t, "🔄", "Windows 更新", "", grad::BLUE);
            kv(
                ui,
                t,
                &[("版本", format!("{} {}", sys.os_name, sys.os_display_version)), ("組建（含累積更新）", sys.os_build.clone())],
            );
            ui.add_space(6.0);
            ui.label(RichText::new("最近安裝的更新（QFE）").size(12.5).color(t.text3));
            ui.horizontal_wrapped(|ui| {
                for h in &info.security.recent_hotfixes {
                    chip(ui, t, Tone::Muted, &format!("{} · {}", h.id, h.installed_on), false).on_hover_text(&h.description);
                }
            });
        }
    });

    card(ui, t, |ui| {
        head_r(ui, t, "🔌", "USB 儲存裝置控管", "", grad::AMBER, |ui| match usb {
            UsbPolicy::Blocked => {
                chip(ui, t, Tone::Good, "目前政策：已封鎖", true);
            }
            UsbPolicy::Allowed => {
                chip(ui, t, Tone::Warn, "目前政策：允許（未控管）", true);
            }
            UsbPolicy::Unknown => {
                chip(ui, t, Tone::Warn, "無法讀取", true);
            }
        });
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new("IT 可下達的政策").color(t.text3));
            for (i, label) in ["允許", "唯讀", "封鎖", "白名單裝置"].into_iter().enumerate() {
                let on = (usb == UsbPolicy::Allowed && i == 0) || (usb == UsbPolicy::Blocked && i == 2);
                chip(ui, t, if on { Tone::Info } else { Tone::Muted }, label, on);
            }
            ui.label(RichText::new("正式版由 IT 後台依 AD OU 下達").size(12.5).color(t.text3));
        });
        ui.add_space(6.0);
        let history = &info.usb.storage_history;
        ui.label(RichText::new(format!("曾插入過的 USB 儲存裝置（{} 個）", history.len())).size(12.5).color(t.text3));
        if history.is_empty() {
            ui.label(RichText::new("沒有紀錄").color(t.text3));
        } else {
            table(
                ui,
                t,
                &[("裝置", W::Fr(2.0)), ("序號", W::Fr(1.0))],
                history.len(),
                |r, c| if c == 0 { Cell::new(&history[r].friendly_name) } else { Cell::new(&history[r].serial).dim().mono() },
                |_| false,
            );
        }
    });
}

