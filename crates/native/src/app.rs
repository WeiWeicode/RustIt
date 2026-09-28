//! 外框：標題列、側邊欄、提示訊息與主迴圈。各頁內容在 `pages.rs`。

use crate::data::{self, LiveStats, Msg, Snapshot};
use crate::perf::{FrameStats, ProcessUsage};
use crate::theme::{self, Theme, bold_font};
use crate::widgets::{self, GAP};
use eframe::egui::{
    self, Align, Align2, Button, CentralPanel, Color32, FontId, Frame, Label, Layout, Margin, Order, Panel, RichText, ScrollArea,
    Sense, Spinner, Stroke, Ui, pos2, vec2,
};
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Overview,
    Hardware,
    Network,
    Software,
    Security,
    Remote,
    Perf,
}

const NAV: [(Page, &str, &str); 7] = [
    (Page::Overview, "🏠", "總覽"),
    (Page::Hardware, "🖥", "硬體資訊"),
    (Page::Network, "🌐", "網路"),
    (Page::Software, "📦", "已安裝軟體"),
    (Page::Security, "🛡", "安全與控管"),
    (Page::Remote, "🎧", "遠端協助"),
    (Page::Perf, "⚡", "效能比較"),
];

struct Toast {
    text: String,
    ok: bool,
    until: Instant,
}

pub struct App {
    pub page: Page,
    pub snap: Option<Snapshot>,
    pub collecting: bool,
    pub live: Option<LiveStats>,
    pub usage: Option<ProcessUsage>,
    pub cpu_hist: VecDeque<f32>,
    pub sw_filter: String,
    /// 進入目前頁面的時間（egui 時間，秒），用來播放圓環從 0 轉到目前值的動畫。
    pub page_entered: f64,
    /// 壓力測試：每一幀都重繪。
    pub continuous: bool,
    pub frames: FrameStats,
    pub exe_size: u64,
    /// 實際使用的繪圖後端（OpenGL 或 wgpu）。
    pub renderer: String,
    toasts: Vec<Toast>,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    /// 視窗在前景且未最小化；背景取樣執行緒依此暫停。
    active: Arc<AtomicBool>,
    /// 目前頁面有每秒更新的數字；背景取樣執行緒依此決定要不要喚醒介面。
    live_repaint: Arc<AtomicBool>,
}

impl App {
    pub fn new(ctx: &egui::Context, renderer: String) -> Self {
        let (tx, rx) = channel();
        let active = Arc::new(AtomicBool::new(true));
        let live_repaint = Arc::new(AtomicBool::new(true));
        data::spawn_ticker(tx.clone(), ctx.clone(), active.clone(), live_repaint.clone());
        let mut app = Self {
            page: Page::Overview,
            snap: None,
            collecting: false,
            live: None,
            usage: None,
            cpu_hist: VecDeque::with_capacity(60),
            sw_filter: String::new(),
            page_entered: 0.0,
            continuous: false,
            frames: FrameStats::new(),
            exe_size: std::env::current_exe().and_then(std::fs::metadata).map_or(0, |m| m.len()),
            renderer,
            toasts: Vec::new(),
            tx,
            rx,
            active,
            live_repaint,
        };
        app.collect(ctx);
        app
    }

    pub fn collect(&mut self, ctx: &egui::Context) {
        if self.collecting {
            return;
        }
        self.collecting = true;
        data::spawn_collect(self.tx.clone(), ctx.clone());
    }

    pub fn goto(&mut self, page: Page, now: f64) {
        if self.page != page {
            self.page = page;
            self.page_entered = now;
        }
    }

    pub fn toast(&mut self, text: impl Into<String>, ok: bool) {
        self.toasts.push(Toast { text: text.into(), ok, until: Instant::now() + Duration::from_millis(3600) });
    }

    fn drain(&mut self, now: f64) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                Msg::Collected(info) => {
                    let first = self.snap.is_none();
                    let snap = Snapshot::new(*info, self.snap.as_ref().map(|s| &s.info));
                    if let Some((added, removed)) = &snap.hardware_changes {
                        self.toast(
                            if added.is_empty() && removed.is_empty() {
                                "重新蒐集完成，硬體沒有變更".to_string()
                            } else {
                                format!("偵測到硬體變更：新增 {}、移除 {}", added.len(), removed.len())
                            },
                            true,
                        );
                    }
                    self.snap = Some(snap);
                    self.collecting = false;
                    if first {
                        self.page_entered = now;
                    }
                }
                Msg::Tick(live, usage) => {
                    if self.cpu_hist.len() == 60 {
                        self.cpu_hist.pop_front();
                    }
                    self.cpu_hist.push_back(live.cpu);
                    self.live = Some(live);
                    self.usage = Some(usage);
                }
            }
        }
    }

    fn export(&mut self) {
        let Some(snap) = &self.snap else { return };
        match data::export_json(&snap.info) {
            Ok(path) => {
                data::reveal(&path);
                self.toast(format!("已匯出：{}", path.display()), true);
            }
            Err(e) => self.toast(format!("匯出失敗：{e}"), false),
        }
    }

    // ------------------------------------------------------------ 標題列

    fn topbar(&mut self, ui: &mut Ui, t: &Theme) {
        let ctx = ui.ctx().clone();
        ui.horizontal(|ui| {
            ui.label(RichText::new("RustIt").font(bold_font(18.0)).color(t.text));
            ui.label(RichText::new("資產管理").size(13.0).color(t.text3));
            widgets::chip(ui, t, theme::Tone::Violet, "原生 egui", false);
            ui.add_space(10.0);
            match &self.snap {
                Some(s) => {
                    let (r, _) = ui.allocate_exact_size(vec2(8.0, 8.0), Sense::hover());
                    ui.painter().circle_filled(r.center(), 4.0, t.good);
                    ui.label(RichText::new(&s.info.system.host_name).font(bold_font(14.0)).color(t.text));
                    ui.label(RichText::new(&s.info.system.user_name).color(t.text2));
                }
                None => {
                    let (r, _) = ui.allocate_exact_size(vec2(8.0, 8.0), Sense::hover());
                    ui.painter().circle_filled(r.center(), 4.0, t.warn);
                    ui.label(RichText::new("蒐集中…").color(t.text2));
                }
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let export = Button::new(RichText::new("⬇ 匯出").color(Color32::WHITE)).fill(t.accent).stroke(Stroke::NONE);
                if ui.add_enabled(self.snap.is_some(), export).on_hover_text("匯出 Agent 將回報給伺服器的資料").clicked() {
                    self.export();
                }
                if self.collecting {
                    ui.add_enabled(false, Button::new("重新蒐集"));
                    ui.add(Spinner::new().size(16.0).color(t.text2));
                } else if ui.button("🔄 重新蒐集").clicked() {
                    self.collect(&ctx);
                }
                let (icon, tip, next) = if t.dark { ("☀", "切換為淺色", egui::Theme::Light) } else { ("🌙", "切換為深色", egui::Theme::Dark) };
                if ui.button(icon).on_hover_text(tip).clicked() {
                    ctx.set_theme(next);
                }
                let when = match (&self.snap, self.collecting) {
                    (_, true) => "蒐集中…".to_string(),
                    (Some(s), false) => format!("蒐集於 {} · {} ms", data::fmt_short(s.collected_at), s.info.collect_ms),
                    (None, false) => String::new(),
                };
                ui.label(RichText::new(when).size(12.5).color(t.text3));
            });
        });
    }

    // ------------------------------------------------------------ 側邊欄

    fn sidebar(&mut self, ui: &mut Ui, t: &Theme, now: f64) {
        ui.spacing_mut().item_spacing.y = 4.0;
        for (page, icon, label) in NAV {
            let selected = self.page == page;
            let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 40.0), Sense::click());
            let p = ui.painter();
            if selected {
                p.rect_filled(rect, 12, t.glass3);
                p.rect_filled(egui::Rect::from_center_size(pos2(rect.left() + 3.0, rect.center().y), vec2(3.0, 18.0)), 2, t.accent);
            } else if resp.hovered() {
                p.rect_filled(rect, 12, t.glass);
            }
            let color = if selected { t.text } else { t.text2 };
            p.text(pos2(rect.left() + 24.0, rect.center().y), Align2::CENTER_CENTER, icon, FontId::proportional(15.0), if selected { t.accent } else { t.text2 });
            let font = if selected { bold_font(14.0) } else { FontId::proportional(14.0) };
            p.text(pos2(rect.left() + 44.0, rect.center().y), Align2::LEFT_CENTER, label, font, color);
            if resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                self.goto(page, now);
            }
        }

        ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
            ui.spacing_mut().item_spacing.y = 3.0;
            ui.add(Label::new(RichText::new("資料只存在記憶體，不會寫入資料庫").size(11.5).color(t.text3)).wrap());
            widgets::chip(ui, t, theme::Tone::Info, "Demo 模式", true);
            ui.add_space(8.0);
            let usage = self.usage.map_or_else(
                || "—".to_string(),
                |u| format!("記憶體 {} · CPU {:.1}%", data::bytes(u.working_set), u.cpu),
            );
            ui.label(RichText::new(usage).size(12.0).color(t.text2));
            ui.label(RichText::new(format!("本程式用量 · {}", self.renderer)).size(11.5).color(t.text3));
        });
    }

    fn toasts(&mut self, ctx: &egui::Context, t: &Theme) {
        let now = Instant::now();
        self.toasts.retain(|x| x.until > now);
        let Some(next) = self.toasts.iter().map(|x| x.until).min() else { return };
        ctx.request_repaint_after(next - now);
        egui::Area::new(egui::Id::new("toasts"))
            .anchor(Align2::RIGHT_BOTTOM, vec2(-20.0, -20.0))
            .order(Order::Foreground)
            .interactable(false)
            .show(ctx, |ui| {
                for x in &self.toasts {
                    Frame::new()
                        .fill(t.solid)
                        .stroke(Stroke::new(1.0, t.rim))
                        .corner_radius(14)
                        .inner_margin(Margin::symmetric(14, 10))
                        .shadow(ctx.global_style().visuals.popup_shadow)
                        .show(ui, |ui| {
                            ui.set_max_width(420.0);
                            ui.horizontal(|ui| {
                                let (icon, c) = if x.ok { ("✔", t.good) } else { ("✖", t.bad) };
                                ui.label(RichText::new(icon).color(c));
                                ui.add(Label::new(RichText::new(&x.text).color(t.text)).wrap());
                            });
                        });
                    ui.add_space(8.0);
                }
            });
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut Ui, frame: &mut eframe::Frame) {
        let started = Instant::now();
        let ctx = ui.ctx().clone();
        let now = ctx.input(|i| i.time);
        self.drain(now);

        // 與 WebView 版一致：不在前景就暫停每秒取樣；只有顯示即時數字的頁面才每秒重繪。
        let (focused, minimized) = ctx.input(|i| (i.viewport().focused.unwrap_or(true), i.viewport().minimized.unwrap_or(false)));
        self.active.store(focused && !minimized, Ordering::Relaxed);
        self.live_repaint.store(matches!(self.page, Page::Overview | Page::Perf), Ordering::Relaxed);

        let t = Theme::of(&ctx);
        theme::paint_backdrop(&ctx, t);

        Panel::top("topbar")
            .frame(Frame::new().fill(t.glass).inner_margin(Margin::symmetric(18, 10)).stroke(Stroke::new(1.0, t.line)))
            .show(ui, |ui| self.topbar(ui, t));
        Panel::left("sidebar")
            .exact_size(214.0)
            .resizable(false)
            .frame(Frame::new().fill(t.glass).inner_margin(Margin::symmetric(12, 14)).stroke(Stroke::new(1.0, t.line)))
            .show(ui, |ui| self.sidebar(ui, t, now));
        CentralPanel::no_frame().show(ui, |ui| {
            ScrollArea::vertical().auto_shrink([false, false]).id_salt(self.page as u8).show(ui, |ui| {
                Frame::new().inner_margin(Margin { left: 24, right: 24, top: 20, bottom: 28 }).show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = GAP;
                    self.page_ui(ui, t);
                });
            });
        });
        self.toasts(&ctx, t);

        if self.continuous {
            ctx.request_repaint();
        }
        self.frames.record(started.elapsed(), frame.info().cpu_usage, ctx.current_pass_index() > 0);
    }
}
