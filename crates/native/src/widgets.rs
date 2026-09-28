//! 共用元件：卡片、標題列、標籤、鍵值表、圓環、走勢圖、表格。
//! 樣式對應 WebView 版 `ui/js/pages.js` 的同名片段。

use crate::data::dash;
use crate::theme::{Theme, Tone, bold_font};
use eframe::egui::epaint::text::{LayoutJob, TextWrapping};
use eframe::egui::epaint::{ColorMode, PathShape, PathStroke, RectShape};
use eframe::egui::{
    self, Align, Align2, Color32, CornerRadius, CursorIcon, FontId, Frame, Id, Label, Layout, Margin, Mesh, Pos2, Rect,
    Response, RichText, Sense, Stroke, StrokeKind, Ui, pos2, vec2,
};
use std::collections::VecDeque;
use std::f32::consts::{FRAC_PI_2, TAU};
use std::sync::Arc;

pub const GAP: f32 = 14.0;
const SPACING: egui::Vec2 = vec2(8.0, 6.0);
const PAD: i8 = 18;

pub type Grad = (Color32, Color32);

/// 圖示底色（pages.js 的 `C`）。
pub mod grad {
    use super::Grad;
    use eframe::egui::Color32;
    const fn c(rgb: u32) -> Color32 {
        Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
    }
    pub const BLUE: Grad = (c(0x38bdf8), c(0x6366f1));
    pub const VIOLET: Grad = (c(0x8b5cf6), c(0xd946ef));
    pub const PINK: Grad = (c(0xf472b6), c(0xe11d48));
    pub const GREEN: Grad = (c(0x34d399), c(0x059669));
    pub const AMBER: Grad = (c(0xfbbf24), c(0xf97316));
    pub const TEAL: Grad = (c(0x2dd4bf), c(0x0ea5e9));
    pub const SLATE: Grad = (c(0x94a3b8), c(0x475569));
    pub const ROSE: Grad = (c(0xfb7185), c(0xe11d48));
}

// ------------------------------------------------------------ 漸層

/// 2×2 雙色貼圖，線性取樣就成為對角漸層；依顏色快取在 egui 的記憶體裡。
fn grad_texture(ctx: &egui::Context, g: Grad) -> egui::TextureId {
    let key = Id::new(("grad", g.0.to_array(), g.1.to_array()));
    if let Some(tex) = ctx.data(|d| d.get_temp::<egui::TextureHandle>(key)) {
        return tex.id();
    }
    let mid = g.0.lerp_to_gamma(g.1, 0.5);
    let image = egui::ColorImage::new([2, 2], vec![g.0, mid, mid, g.1]);
    let tex = ctx.load_texture("gradient", image, egui::TextureOptions::LINEAR);
    let id = tex.id();
    ctx.data_mut(|d| d.insert_temp(key, tex));
    id
}

/// 圓角漸層矩形（有反鋸齒，因為仍是一般的矩形，只是貼了漸層貼圖）。
pub fn grad_rect(ui: &Ui, rect: Rect, radius: impl Into<CornerRadius>, g: Grad) {
    let uv = Rect::from_min_max(pos2(0.25, 0.25), pos2(0.75, 0.75));
    let tex = grad_texture(ui.ctx(), g);
    ui.painter().add(RectShape::filled(rect, radius, Color32::WHITE).with_texture(tex, uv));
}

pub fn icon_box(ui: &mut Ui, icon: &str, g: Grad, size: f32) {
    let (rect, _) = ui.allocate_exact_size(vec2(size, size), Sense::hover());
    if ui.is_rect_visible(rect) {
        grad_rect(ui, rect, (size * 0.3) as u8, g);
        ui.painter().text(rect.center(), Align2::CENTER_CENTER, icon, FontId::proportional(size * 0.5), Color32::WHITE);
    }
}

// ------------------------------------------------------------ 卡片

pub fn card_frame(t: &Theme) -> Frame {
    Frame::new().fill(t.glass).stroke(Stroke::new(1.0, t.rim)).corner_radius(20).inner_margin(PAD)
}

/// 填滿整列寬度的卡片。
pub fn card<R>(ui: &mut Ui, t: &Theme, add: impl FnOnce(&mut Ui) -> R) -> R {
    card_frame(t)
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing = SPACING;
            ui.set_min_width(ui.available_width());
            add(ui)
        })
        .inner
}

/// 並排的卡片，寬度依 `weights` 分配；高度對齊最高的一張。
///
/// 立即模式下要先畫過一次才知道高度，所以記住量到的高度，變動時要求 egui 重跑這一幀
/// （`request_discard`，同一幀內完成，畫面不會閃）。
pub fn card_row(ui: &mut Ui, t: &Theme, id: &str, weights: &[f32], mut add: impl FnMut(usize, &mut Ui)) {
    let id = ui.id().with(id);
    let target: f32 = ui.data(|d| d.get_temp(id)).unwrap_or(0.0);
    let total: f32 = weights.iter().sum();
    let avail = ui.available_width() - GAP * (weights.len() - 1) as f32;
    let mut tallest = 0.0f32;
    ui.horizontal_top(|ui| {
        ui.spacing_mut().item_spacing.x = GAP;
        for (i, w) in weights.iter().enumerate() {
            let width = (avail * w / total).floor();
            ui.allocate_ui_with_layout(vec2(width, 0.0), Layout::top_down(Align::Min), |ui| {
                card_frame(t).show(ui, |ui| {
                    ui.spacing_mut().item_spacing = SPACING;
                    ui.set_min_width(ui.available_width());
                    add(i, ui);
                    let natural = ui.min_rect().height();
                    tallest = tallest.max(natural);
                    // 不用 set_min_height：它是從目前游標往下再保留一段高度，而不是從頂端算起
                    ui.expand_to_include_y(ui.min_rect().top() + target);
                });
            });
        }
    });
    if (tallest - target).abs() > 0.5 {
        ui.data_mut(|d| d.insert_temp(id, tallest));
        ui.ctx().request_discard("card_row 高度改變");
    }
}

pub fn head(ui: &mut Ui, t: &Theme, icon: &str, title: &str, sub: &str, g: Grad) {
    head_r(ui, t, icon, title, sub, g, |_| {});
}

/// 卡片標題列；`right` 放在右側，先排右側再把剩下的寬度給標題（過長時截斷）。
pub fn head_r(ui: &mut Ui, t: &Theme, icon: &str, title: &str, sub: &str, g: Grad, right: impl FnOnce(&mut Ui)) {
    ui.horizontal(|ui| {
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            right(ui);
            ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                icon_box(ui, icon, g, 30.0);
                ui.add_space(4.0);
                ui.add(Label::new(RichText::new(title).font(bold_font(15.5)).color(t.text)).truncate());
                if !sub.is_empty() {
                    ui.add(Label::new(RichText::new(sub).size(12.5).color(t.text3)).truncate());
                }
            });
        });
    });
    ui.add_space(6.0);
}

pub fn page_head(ui: &mut Ui, t: &Theme, title: &str, sub: &str, right: impl FnOnce(&mut Ui)) {
    ui.horizontal(|ui| {
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            right(ui);
            ui.with_layout(Layout::top_down(Align::Min), |ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                ui.label(RichText::new(title).font(bold_font(26.0)).color(t.text));
                ui.add(Label::new(RichText::new(sub).size(13.5).color(t.text2)).wrap());
            });
        });
    });
}

pub fn note(ui: &mut Ui, t: &Theme, text: &str) {
    Frame::new()
        .fill(t.info.gamma_multiply(0.1))
        .stroke(Stroke::new(1.0, t.info.gamma_multiply(0.28)))
        .corner_radius(14)
        .inner_margin(Margin::symmetric(14, 10))
        .show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.horizontal_top(|ui| {
                ui.label(RichText::new("ℹ").color(t.info));
                ui.add(Label::new(RichText::new(text).color(t.text2)).wrap());
            });
        });
}

// ------------------------------------------------------------ 小元件

pub fn chip(ui: &mut Ui, t: &Theme, tone: Tone, text: &str, dot: bool) -> Response {
    let c = t.tone(tone);
    let galley = ui.painter().layout_no_wrap(text.to_owned(), FontId::proportional(12.0), c);
    let dot_w = if dot { 11.0 } else { 0.0 };
    let (rect, resp) = ui.allocate_exact_size(vec2(galley.size().x + dot_w + 18.0, galley.size().y + 6.0), Sense::hover());
    if ui.is_rect_visible(rect) {
        let p = ui.painter();
        p.rect(rect, 11, c.gamma_multiply(0.13), Stroke::new(1.0, c.gamma_multiply(0.3)), StrokeKind::Inside);
        if dot {
            p.circle_filled(pos2(rect.left() + 12.0, rect.center().y), 3.0, c);
        }
        p.galley(pos2(rect.left() + 9.0 + dot_w, rect.center().y - galley.size().y / 2.0), galley, c);
    }
    resp
}

/// 左欄為名稱、右欄為值的清單（值過長時換行）。
pub fn kv(ui: &mut Ui, t: &Theme, rows: &[(&str, String)]) {
    const KEY_W: f32 = 136.0;
    ui.scope(|ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        for (i, (k, v)) in rows.iter().enumerate() {
            if i > 0 {
                let y = ui.cursor().top();
                ui.painter().hline(ui.max_rect().x_range(), y, Stroke::new(1.0, t.line));
            }
            ui.add_space(7.0);
            ui.horizontal_top(|ui| {
                ui.allocate_ui_with_layout(vec2(KEY_W, 0.0), Layout::top_down(Align::Min), |ui| {
                    ui.set_width(KEY_W);
                    ui.label(RichText::new(*k).color(t.text3));
                });
                ui.allocate_ui_with_layout(vec2(ui.available_width(), 0.0), Layout::top_down(Align::Min), |ui| {
                    ui.add(Label::new(RichText::new(dash(v)).color(t.text)).wrap());
                });
            });
            ui.add_space(7.0);
        }
    });
}

/// 用量對應顏色等級（util.js 的 `level`）。
pub fn level(t: &Theme, pct: f32) -> Grad {
    if pct < 60.0 {
        (t.info, t.accent2)
    } else if pct < 85.0 {
        grad::AMBER
    } else {
        grad::ROSE
    }
}

pub fn meter(ui: &mut Ui, t: &Theme, pct: f32) {
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 8.0), Sense::hover());
    if !ui.is_rect_visible(rect) {
        return;
    }
    ui.painter().rect_filled(rect, 4, t.glass2);
    let w = rect.width() * (pct / 100.0).clamp(0.0, 1.0);
    if w > 0.5 {
        grad_rect(ui, Rect::from_min_size(rect.min, vec2(w.max(8.0), rect.height())), 4, level(t, pct));
    }
}

/// 狀態列：圖示、名稱、說明（名稱欄寬 `name_w`）。
pub fn status_row(ui: &mut Ui, t: &Theme, icon: &str, name: &str, text: &str, tone: Tone, name_w: f32) -> Response {
    status_impl(ui, t, [icon, name, text], tone, name_w, false)
}

/// 可點的狀態列（總覽的狀態摘要），說明文字用狀態色，右側有箭頭。
pub fn status_link(ui: &mut Ui, t: &Theme, icon: &str, name: &str, text: &str, tone: Tone) -> Response {
    status_impl(ui, t, [icon, name, text], tone, 90.0, true)
}

fn status_impl(ui: &mut Ui, t: &Theme, [icon, name, text]: [&str; 3], tone: Tone, name_w: f32, clickable: bool) -> Response {
    let sense = if clickable { Sense::click() } else { Sense::hover() };
    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 42.0), sense);
    if ui.is_rect_visible(rect) {
        let p = ui.painter();
        let c = t.tone(tone);
        if clickable && resp.hovered() {
            p.rect_filled(rect, 12, t.glass2);
        }
        let ic = pos2(rect.left() + 21.0, rect.center().y);
        p.circle_filled(ic, 15.0, c.gamma_multiply(0.16));
        p.text(ic, Align2::CENTER_CENTER, icon, FontId::proportional(14.0), c);
        p.text(pos2(rect.left() + 46.0, rect.center().y), Align2::LEFT_CENTER, name, bold_font(14.0), t.text);
        let right = if clickable { rect.right() - 28.0 } else { rect.right() - 8.0 };
        let val = Rect::from_min_max(pos2(rect.left() + 46.0 + name_w, rect.top()), pos2(right, rect.bottom()));
        cell_text(ui, val, text, FontId::proportional(13.5), if clickable { c } else { t.text2 });
        if clickable {
            p.text(pos2(rect.right() - 12.0, rect.center().y), Align2::RIGHT_CENTER, "›", FontId::proportional(20.0), t.text3);
        }
    }
    if clickable { resp.on_hover_cursor(CursorIcon::PointingHand) } else { resp }
}

/// 單行文字，超出寬度以「…」截斷；截斷時滑鼠移上去顯示全文。
fn cell_text(ui: &Ui, rect: Rect, text: &str, font: FontId, color: Color32) {
    let mut job = LayoutJob::simple_singleline(text.to_owned(), font, color);
    job.wrap = TextWrapping { max_width: rect.width().max(1.0), max_rows: 1, break_anywhere: true, overflow_character: Some('…') };
    let galley = ui.painter().layout_job(job);
    let elided = galley.elided;
    let pos = pos2(rect.left(), rect.center().y - galley.size().y / 2.0);
    ui.painter().with_clip_rect(rect.expand(1.0).intersect(ui.clip_rect())).galley(pos, galley, color);
    if elided && ui.rect_contains_pointer(rect) {
        ui.interact(rect, ui.id().with(("cell", rect.min.x as i32, rect.min.y as i32)), Sense::hover())
            .on_hover_text(text);
    }
}

// ------------------------------------------------------------ 表格

#[derive(Clone, Copy)]
pub enum W {
    Fr(f32),
    Px(f32),
}

pub struct Cell {
    pub text: String,
    pub dim: bool,
    pub mono: bool,
    pub badge: Option<(Tone, &'static str)>,
}

impl Cell {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into(), dim: false, mono: false, badge: None }
    }
    pub fn dim(mut self) -> Self {
        self.dim = true;
        self
    }
    pub fn mono(mut self) -> Self {
        self.mono = true;
        self
    }
    pub fn badge(mut self, badge: Option<(Tone, &'static str)>) -> Self {
        self.badge = badge;
        self
    }
}

const ROW_H: f32 = 36.0;
const COL_GAP: f32 = 12.0;

/// 表格。整張表先一次配置好高度，只繪製落在可視範圍內的列，
/// 所以幾千列也只畫看得到的十幾列。`hit` 為 true 的列以橘色底標示（黑名單）。
pub fn table(ui: &mut Ui, t: &Theme, cols: &[(&str, W)], rows: usize, mut cell: impl FnMut(usize, usize) -> Cell, hit: impl Fn(usize) -> bool) {
    let width = ui.available_width();
    let fixed: f32 = cols.iter().map(|(_, w)| if let W::Px(px) = w { *px } else { 0.0 }).sum();
    let frs: f32 = cols.iter().map(|(_, w)| if let W::Fr(f) = w { *f } else { 0.0 }).sum();
    let flex = (width - fixed - COL_GAP * (cols.len() + 1) as f32).max(0.0);
    let mut xs = Vec::with_capacity(cols.len());
    let mut x = COL_GAP;
    for (_, w) in cols {
        let cw = match w {
            W::Px(px) => *px,
            W::Fr(f) => flex * f / frs.max(0.001),
        };
        xs.push((x, cw));
        x += cw + COL_GAP;
    }

    ui.scope(|ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        // 表頭
        let (head, _) = ui.allocate_exact_size(vec2(width, 30.0), Sense::hover());
        for ((title, _), (x, cw)) in cols.iter().zip(&xs) {
            let r = Rect::from_min_size(pos2(head.left() + x, head.top()), vec2(*cw, head.height()));
            cell_text(ui, r, title, FontId::proportional(12.0), t.text3);
        }
        ui.painter().hline(head.x_range(), head.bottom(), Stroke::new(1.0, t.line));
        if rows == 0 {
            return;
        }

        let (body, _) = ui.allocate_exact_size(vec2(width, ROW_H * rows as f32), Sense::hover());
        let clip = ui.clip_rect().intersect(body);
        if clip.height() <= 0.0 {
            return;
        }
        let first = ((clip.top() - body.top()) / ROW_H).floor().max(0.0) as usize;
        let last = (((clip.bottom() - body.top()) / ROW_H).ceil() as usize).min(rows);
        let hovered = ui
            .input(|i| i.pointer.hover_pos())
            .filter(|p| ui.rect_contains_pointer(body) && body.contains(*p))
            .map(|p| ((p.y - body.top()) / ROW_H) as usize);
        let p = ui.painter().clone();
        for r in first..last {
            let row = Rect::from_min_size(pos2(body.left(), body.top() + r as f32 * ROW_H), vec2(width, ROW_H));
            if hit(r) {
                p.rect_filled(row.shrink2(vec2(0.0, 1.0)), 8, t.warn.gamma_multiply(0.1));
            } else if hovered == Some(r) {
                p.rect_filled(row.shrink2(vec2(0.0, 1.0)), 8, t.glass2);
            }
            if r > 0 {
                p.hline(row.x_range(), row.top(), Stroke::new(1.0, t.line));
            }
            for (c, (x, cw)) in xs.iter().enumerate() {
                let Cell { text, dim, mono, badge } = cell(r, c);
                let font = if mono { FontId::monospace(12.5) } else { FontId::proportional(13.5) };
                let color = if dim { t.text2 } else { t.text };
                let mut rect = Rect::from_min_size(pos2(row.left() + x, row.top()), vec2(*cw, ROW_H));
                if let Some((tone, label)) = badge {
                    // 標籤靠右放在儲存格內，文字寬度扣掉標籤
                    let bw = p.layout_no_wrap(label.to_owned(), FontId::proportional(12.0), Color32::WHITE).size().x + 24.0;
                    rect.max.x -= bw;
                    let mut child = ui.new_child(
                        egui::UiBuilder::new()
                            .max_rect(Rect::from_min_max(pos2(rect.right() + 6.0, row.top()), pos2(rect.right() + bw, row.bottom())))
                            .layout(Layout::left_to_right(Align::Center)),
                    );
                    chip(&mut child, t, tone, label, false);
                }
                cell_text(ui, rect, dash(&text), font, color);
            }
        }
    });
}

// ------------------------------------------------------------ 圓環與走勢圖

/// 使用率圓環：軌道 + 漸層弧線 + 光暈，中間為百分比。
pub fn ring(ui: &mut Ui, t: &Theme, pct: f32, label: &str, foot: &str, g: Grad) {
    const SIZE: f32 = 132.0;
    const R: f32 = 54.0;
    let pct = if pct.is_finite() { pct.clamp(0.0, 100.0) } else { 0.0 };
    ui.vertical_centered(|ui| {
        let (rect, _) = ui.allocate_exact_size(vec2(SIZE, SIZE), Sense::hover());
        if ui.is_rect_visible(rect) {
            let c = rect.center();
            let p = ui.painter();
            p.circle_stroke(c, R, Stroke::new(10.0, t.glass2));
            let frac = pct / 100.0;
            if frac > 0.002 {
                let n = ((72.0 * frac).ceil() as usize).max(2);
                let pts: Vec<Pos2> = (0..=n)
                    .map(|k| {
                        let a = -FRAC_PI_2 + frac * TAU * k as f32 / n as f32;
                        c + vec2(a.cos(), a.sin()) * R
                    })
                    .collect();
                let (c1, c2) = g;
                let along = move |q: Pos2| {
                    let v = q - c;
                    let a = (v.y.atan2(v.x) + FRAC_PI_2).rem_euclid(TAU) / TAU;
                    c1.lerp_to_gamma(c2, (a / frac).min(1.0))
                };
                p.add(PathShape::line(pts.clone(), PathStroke::new(20.0, c2.gamma_multiply(0.14))));
                p.circle_filled(pts[0], 5.0, c1);
                p.circle_filled(pts[n], 5.0, c2);
                p.add(PathShape::line(
                    pts,
                    PathStroke { width: 10.0, color: ColorMode::UV(Arc::new(move |_, q| along(q))), kind: StrokeKind::Middle },
                ));
            }
            let num = p.layout_no_wrap(format!("{pct:.0}"), bold_font(30.0), t.text);
            let unit = p.layout_no_wrap("%".into(), FontId::proportional(13.0), t.text2);
            let w = num.size().x + unit.size().x + 1.0;
            let top = c.y - 24.0;
            let left = c.x - w / 2.0;
            let unit_y = top + num.size().y - unit.size().y - 5.0;
            p.galley(pos2(left, top), num.clone(), t.text);
            p.galley(pos2(left + num.size().x + 1.0, unit_y), unit, t.text2);
            p.text(pos2(c.x, top + num.size().y + 2.0), Align2::CENTER_TOP, label, FontId::proportional(12.5), t.text2);
        }
        ui.label(RichText::new(foot).size(12.5).color(t.text2));
    });
}

/// Catmull-Rom → Bézier 平滑曲線，每段取 `steps` 個點。
fn smooth(pts: &[Pos2], steps: usize) -> Vec<Pos2> {
    let n = pts.len();
    let mut out = Vec::with_capacity(n * steps + 1);
    for i in 0..n.saturating_sub(1) {
        let (p0, p1, p2, p3) = (pts[i.saturating_sub(1)], pts[i], pts[i + 1], pts[(i + 2).min(n - 1)]);
        let c1 = p1 + (p2 - p0) / 6.0;
        let c2 = p2 - (p3 - p1) / 6.0;
        for k in 0..steps {
            let s = k as f32 / steps as f32;
            let u = 1.0 - s;
            let v = p1.to_vec2() * (u * u * u) + c1.to_vec2() * (3.0 * u * u * s) + c2.to_vec2() * (3.0 * u * s * s) + p2.to_vec2() * (s * s * s);
            out.push(v.to_pos2());
        }
    }
    if let Some(last) = pts.last() {
        out.push(*last);
    }
    out
}

/// CPU 走勢：最近 `n` 秒，資料不足時左側以第一筆補齊（與 WebView 版相同）。
pub fn spark(ui: &mut Ui, t: &Theme, hist: &VecDeque<f32>, n: usize) {
    const H: f32 = 110.0;
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), H), Sense::hover());
    if !ui.is_rect_visible(rect) {
        return;
    }
    let p = ui.painter();
    for k in 1..4 {
        p.hline(rect.x_range(), rect.top() + H * k as f32 / 4.0, Stroke::new(1.0, t.line));
    }
    let pad = n - hist.len().min(n);
    let first = hist.front().copied().unwrap_or(0.0);
    let pts: Vec<Pos2> = (0..n)
        .map(|i| {
            let v = if i >= pad { hist[i - pad] } else { first };
            pos2(rect.left() + i as f32 / (n - 1) as f32 * rect.width(), rect.bottom() - 6.0 - v.clamp(0.0, 100.0) / 100.0 * (H - 14.0))
        })
        .collect();
    let curve = smooth(&pts, 6);

    // 曲線下方的漸層面積：每一小段一個四邊形，顏色依高度由半透明淡到透明
    let fill = Color32::from_rgb(0x81, 0x8c, 0xf8);
    let at = |y: f32| fill.gamma_multiply(0.45 * (1.0 - (y - rect.top()) / H).clamp(0.0, 1.0));
    let mut mesh = Mesh::default();
    for w in curve.windows(2) {
        let i = mesh.vertices.len() as u32;
        mesh.colored_vertex(w[0], at(w[0].y));
        mesh.colored_vertex(w[1], at(w[1].y));
        mesh.colored_vertex(pos2(w[1].x, rect.bottom()), Color32::TRANSPARENT);
        mesh.colored_vertex(pos2(w[0].x, rect.bottom()), Color32::TRANSPARENT);
        mesh.add_triangle(i, i + 1, i + 2);
        mesh.add_triangle(i, i + 2, i + 3);
    }
    p.add(mesh);

    let (left, width) = (rect.left(), rect.width());
    let stops = [Color32::from_rgb(0x38, 0xbd, 0xf8), Color32::from_rgb(0x81, 0x8c, 0xf8), Color32::from_rgb(0xe8, 0x79, 0xf9)];
    let color = move |q: Pos2| {
        let s = ((q.x - left) / width).clamp(0.0, 1.0);
        if s < 0.55 { stops[0].lerp_to_gamma(stops[1], s / 0.55) } else { stops[1].lerp_to_gamma(stops[2], (s - 0.55) / 0.45) }
    };
    p.add(PathShape::line(curve, PathStroke { width: 2.2, color: ColorMode::UV(Arc::new(move |_, q| color(q))), kind: StrokeKind::Middle }));
}

/// 每幀耗時長條圖（效能頁），虛線為 60 fps 的 16.7 ms 預算。
pub fn frame_bars(ui: &mut Ui, t: &Theme, values: &VecDeque<f32>, capacity: usize) {
    const H: f32 = 90.0;
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), H), Sense::hover());
    if !ui.is_rect_visible(rect) {
        return;
    }
    let p = ui.painter();
    let budget = 1000.0 / 60.0;
    let max = values.iter().copied().fold(budget, f32::max) * 1.1;
    let y = |v: f32| rect.bottom() - v / max * H;
    let bw = rect.width() / capacity as f32;
    let offset = capacity - values.len();
    for (i, v) in values.iter().enumerate() {
        let x = rect.left() + (offset + i) as f32 * bw;
        let bar = Rect::from_min_max(pos2(x + bw * 0.15, y(*v).min(rect.bottom() - 1.0)), pos2(x + bw * 0.85, rect.bottom()));
        p.rect_filled(bar, 1, if *v > budget { t.warn } else { t.accent });
    }
    let by = y(budget);
    p.add(egui::Shape::dashed_line(&[pos2(rect.left(), by), pos2(rect.right(), by)], Stroke::new(1.0, t.text3), 4.0, 4.0));
    p.text(pos2(rect.right(), by - 2.0), Align2::RIGHT_BOTTOM, "16.7 ms（60 fps）", FontId::proportional(11.0), t.text3);
}
