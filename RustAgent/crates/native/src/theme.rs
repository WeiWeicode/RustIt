//! 配色與背景。顏色取自 WebView 版的 `ui/css/app.css`，讓兩個版本看起來一致、比較時條件相同。
//!
//! 原生版不做背景模糊與折射（egui 沒有 backdrop-filter）：卡片是半透明色塊疊在靜態光暈上，
//! 接近 WebView 版的「精簡」模式。

use eframe::egui::{self, Color32, CornerRadius, FontFamily, FontId, LayerId, Mesh, Pos2, Rect, Shadow, Stroke, TextStyle, Visuals, pos2};

const fn rgba(r: u8, g: u8, b: u8, a: f32) -> Color32 {
    Color32::from_rgba_unmultiplied_const(r, g, b, (a * 255.0) as u8)
}

const fn hex(rgb: u32) -> Color32 {
    Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Good,
    Warn,
    Bad,
    Info,
    Violet,
    Muted,
}

pub struct Theme {
    pub dark: bool,
    pub bg0: Color32,
    pub bg1: Color32,
    pub glass: Color32,
    pub glass2: Color32,
    pub glass3: Color32,
    pub rim: Color32,
    pub line: Color32,
    /// 不透明面板（提示、彈出視窗）。
    pub solid: Color32,
    pub text: Color32,
    pub text2: Color32,
    pub text3: Color32,
    pub accent: Color32,
    pub accent2: Color32,
    pub good: Color32,
    pub warn: Color32,
    pub bad: Color32,
    pub info: Color32,
    pub violet: Color32,
    pub muted: Color32,
    pub aurora: [Color32; 5],
}

pub const DARK: Theme = Theme {
    dark: true,
    bg0: hex(0x060a18),
    bg1: hex(0x121a3a),
    glass: rgba(255, 255, 255, 0.065),
    glass2: rgba(255, 255, 255, 0.11),
    glass3: rgba(255, 255, 255, 0.18),
    rim: rgba(255, 255, 255, 0.12),
    line: rgba(255, 255, 255, 0.09),
    solid: rgba(24, 30, 58, 0.97),
    text: rgba(255, 255, 255, 0.95),
    text2: rgba(228, 234, 255, 0.68),
    text3: rgba(228, 234, 255, 0.44),
    accent: hex(0x6b8cff),
    accent2: hex(0xb07cff),
    good: hex(0x34d399),
    warn: hex(0xfbbf24),
    bad: hex(0xfb7185),
    info: hex(0x60a5fa),
    violet: hex(0xc084fc),
    muted: hex(0x94a3b8),
    aurora: [
        rgba(59, 130, 246, 0.5),
        rgba(168, 85, 247, 0.46),
        rgba(236, 72, 153, 0.36),
        rgba(20, 184, 166, 0.34),
        rgba(245, 158, 11, 0.2),
    ],
};

pub const LIGHT: Theme = Theme {
    dark: false,
    bg0: hex(0xdfe6f6),
    bg1: hex(0xf4f6fc),
    glass: rgba(255, 255, 255, 0.42),
    glass2: rgba(255, 255, 255, 0.6),
    glass3: rgba(255, 255, 255, 0.78),
    rim: rgba(255, 255, 255, 0.9),
    line: rgba(20, 30, 70, 0.08),
    solid: rgba(255, 255, 255, 0.97),
    text: rgba(12, 18, 38, 0.92),
    text2: rgba(30, 38, 70, 0.64),
    text3: rgba(30, 38, 70, 0.42),
    accent: hex(0x3b63f6),
    accent2: hex(0x8b5cf6),
    good: hex(0x059669),
    warn: hex(0xd97706),
    bad: hex(0xe11d48),
    info: hex(0x2563eb),
    violet: hex(0x9333ea),
    muted: hex(0x64748b),
    aurora: [
        rgba(96, 165, 250, 0.5),
        rgba(192, 132, 252, 0.46),
        rgba(244, 114, 182, 0.36),
        rgba(45, 212, 191, 0.34),
        rgba(251, 191, 36, 0.3),
    ],
};

/// 標題用的粗體字型家族（見 `main.rs` 的字型設定）。
pub fn bold() -> FontFamily {
    FontFamily::Name("bold".into())
}

pub fn bold_font(size: f32) -> FontId {
    FontId::new(size, bold())
}

impl Theme {
    pub fn of(ctx: &egui::Context) -> &'static Theme {
        if ctx.theme() == egui::Theme::Dark { &DARK } else { &LIGHT }
    }

    pub fn tone(&self, tone: Tone) -> Color32 {
        match tone {
            Tone::Good => self.good,
            Tone::Warn => self.warn,
            Tone::Bad => self.bad,
            Tone::Info => self.info,
            Tone::Violet => self.violet,
            Tone::Muted => self.muted,
        }
    }

    fn visuals(&self) -> Visuals {
        let mut v = if self.dark { Visuals::dark() } else { Visuals::light() };
        let radius = CornerRadius::same(10);
        v.panel_fill = Color32::TRANSPARENT;
        v.window_fill = self.solid;
        v.window_stroke = Stroke::new(1.0, self.rim);
        v.window_corner_radius = CornerRadius::same(16);
        v.window_shadow = Shadow { offset: [0, 14], blur: 36, spread: 0, color: Color32::from_black_alpha(90) };
        v.popup_shadow = v.window_shadow;
        v.extreme_bg_color = self.glass;
        v.text_edit_bg_color = Some(self.glass2);
        v.faint_bg_color = self.glass;
        v.weak_text_color = Some(self.text3);
        v.hyperlink_color = self.info;
        v.selection.bg_fill = self.accent.gamma_multiply(0.45);
        v.selection.stroke = Stroke::new(1.0, self.text);
        let w = &mut v.widgets;
        w.noninteractive.fg_stroke = Stroke::new(1.0, self.text);
        w.noninteractive.bg_stroke = Stroke::new(1.0, self.line);
        w.noninteractive.corner_radius = radius;
        for (wv, fill) in [(&mut w.inactive, self.glass2), (&mut w.hovered, self.glass3), (&mut w.active, self.glass3), (&mut w.open, self.glass3)] {
            wv.bg_fill = fill;
            wv.weak_bg_fill = fill;
            wv.fg_stroke = Stroke::new(1.5, self.text);
            wv.bg_stroke = Stroke::new(1.0, self.rim);
            wv.corner_radius = radius;
            wv.expansion = 0.0;
        }
        w.hovered.bg_stroke = Stroke::new(1.0, self.accent.gamma_multiply(0.6));
        v
    }
}

pub fn install(ctx: &egui::Context) {
    ctx.set_visuals_of(egui::Theme::Dark, DARK.visuals());
    ctx.set_visuals_of(egui::Theme::Light, LIGHT.visuals());
    ctx.all_styles_mut(|s| {
        s.text_styles = [
            (TextStyle::Small, FontId::proportional(12.0)),
            (TextStyle::Body, FontId::proportional(14.0)),
            (TextStyle::Button, FontId::proportional(14.0)),
            (TextStyle::Heading, FontId::new(24.0, bold())),
            (TextStyle::Monospace, FontId::monospace(13.0)),
        ]
        .into();
        s.spacing.item_spacing = egui::vec2(8.0, 6.0);
        s.spacing.button_padding = egui::vec2(12.0, 6.0);
    });
}

/// 靜態背景：底色漸層 + 五團光暈，位置與 WebView 版的 `.backdrop`、`.aurora` 相同。
/// 每幀只是一個約 300 個頂點的網格，成本可以忽略。
pub fn paint_backdrop(ctx: &egui::Context, t: &Theme) {
    let r = ctx.content_rect();
    let (w, h) = (r.width(), r.height());
    let at = |x: f32, y: f32| pos2(r.left() + x * w, r.top() + y * h);
    let mut mesh = Mesh::default();
    rect_fill(&mut mesh, r, t.bg0);
    glow(&mut mesh, at(0.12, -0.1), 1400.0 * 0.6, 900.0 * 0.6, t.bg1);
    glow(&mut mesh, at(1.1, 1.1), 1200.0 * 0.55, 900.0 * 0.55, t.bg1);
    // CSS：radial-gradient(34% 40% at 20% 20%, color, transparent 72%)，畫布比視窗大 18%
    for (i, (x, y, rx, ry)) in [
        (0.092, 0.092, 0.333, 0.392),
        (0.962, 0.310, 0.313, 0.372),
        (0.418, 1.044, 0.372, 0.352),
        (0.908, 1.017, 0.294, 0.333),
        (-0.098, 0.745, 0.274, 0.294),
    ]
    .into_iter()
    .enumerate()
    {
        glow(&mut mesh, at(x, y), rx * w, ry * h, t.aurora[i]);
    }
    ctx.layer_painter(LayerId::background()).add(mesh);
}

fn rect_fill(mesh: &mut Mesh, r: Rect, c: Color32) {
    let i = mesh.vertices.len() as u32;
    for p in [r.left_top(), r.right_top(), r.right_bottom(), r.left_bottom()] {
        mesh.colored_vertex(p, c);
    }
    mesh.add_triangle(i, i + 1, i + 2);
    mesh.add_triangle(i, i + 2, i + 3);
}

/// 橢圓放射漸層：中心為 `c`，線性淡出到邊緣透明。
fn glow(mesh: &mut Mesh, center: Pos2, rx: f32, ry: f32, c: Color32) {
    const N: u32 = 48;
    let i = mesh.vertices.len() as u32;
    mesh.colored_vertex(center, c);
    for k in 0..N {
        let a = k as f32 / N as f32 * std::f32::consts::TAU;
        mesh.colored_vertex(center + egui::vec2(a.cos() * rx, a.sin() * ry), Color32::TRANSPARENT);
    }
    for k in 0..N {
        mesh.add_triangle(i, i + 1 + k, i + 1 + (k + 1) % N);
    }
}
