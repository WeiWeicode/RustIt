// Release 版不跳出命令列視窗。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! RustIt 原生版：與 `crates/demo`（Tauri + WebView2）功能相同的介面，改用 egui 直接繪製，
//! 用來比較兩種介面技術的啟動時間、記憶體與 CPU。資料蒐集同樣來自 `rustit-collector`。

mod app;
mod data;
mod pages;
mod perf;
mod theme;
mod widgets;

use eframe::egui::{self, FontData, FontDefinitions, FontFamily};
use std::path::Path;
use std::sync::Arc;

fn main() {
    if let Err(e) = run() {
        // Release 版沒有命令列視窗，啟動失敗要用對話框告訴使用者，否則程式會無聲無息地結束。
        // 最常見的原因是沒有安裝顯示卡驅動（例如部分虛擬機只有 OpenGL 1.1）。
        let text = format!(
            "無法啟動 RustIt 原生版：{e}\n\n這個版本需要支援 OpenGL 2.0 以上的顯示卡驅動程式。\
             沒有安裝顯示卡驅動的電腦（例如部分虛擬機）請改用 WebView2 版（RustIt-Demo.exe）。"
        );
        use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
        use windows::core::HSTRING;
        unsafe { MessageBoxW(None, &HSTRING::from(text), &HSTRING::from("RustIt 資產管理"), MB_OK | MB_ICONERROR) };
        std::process::exit(1);
    }
}

fn run() -> eframe::Result {
    let mut viewport = egui::ViewportBuilder::default()
        .with_title("RustIt 資產管理（原生版）")
        .with_inner_size([1280.0, 820.0])
        .with_min_inner_size([980.0, 660.0]);
    if let Ok(icon) = eframe::icon_data::from_png_bytes(include_bytes!("../../demo/icons/128x128.png")) {
        viewport = viewport.with_icon(icon);
    }
    let options = eframe::NativeOptions { viewport, centered: true, ..Default::default() };
    eframe::run_native(
        "rustit-native",
        options,
        Box::new(|cc| {
            install_fonts(&cc.egui_ctx);
            theme::install(&cc.egui_ctx);
            Ok(Box::new(app::App::new(&cc.egui_ctx, renderer_name(cc))))
        }),
    )
}

/// 實際使用的繪圖後端，顯示在側邊欄與效能頁。
fn renderer_name(cc: &eframe::CreationContext<'_>) -> String {
    #[cfg(feature = "wgpu")]
    if let Some(rs) = &cc.wgpu_render_state {
        return format!("wgpu（{:?}）", rs.adapter.get_info().backend);
    }
    #[cfg(feature = "glow")]
    if cc.gl.is_some() {
        return "OpenGL（glow）".into();
    }
    "未知".into()
}

/// 以記憶體對應（mmap）開啟字型檔：只有實際用到的字形表會讀進來，
/// 且屬於可共用的檔案頁面，不會把 20 MB 的微軟正黑體整個複製到私有記憶體。
fn map_font(path: &Path) -> Option<&'static [u8]> {
    let file = std::fs::File::open(path).ok()?;
    // SAFETY：系統字型檔在程式執行期間不會被改寫。
    let map = unsafe { memmap2::Mmap::map(&file) }.ok()?;
    Some(&**Box::leak(Box::new(map)))
}

/// 拉丁字母用 Segoe UI，中文用微軟正黑體 UI（TTC 的第 2 個字型），
/// 缺字時退回 egui 內建字型（含圖示與 emoji）。粗體另外建一個字型家族。
fn install_fonts(ctx: &egui::Context) {
    let dir = Path::new(&std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into())).join("Fonts");
    let mut fonts = FontDefinitions::default();
    let mut load = |name: &str, candidates: &[(&str, u32)]| -> Option<String> {
        candidates.iter().find_map(|(file, index)| {
            let bytes = map_font(&dir.join(file))?;
            let mut data = FontData::from_static(bytes);
            data.index = *index;
            fonts.font_data.insert(name.to_string(), Arc::new(data));
            Some(name.to_string())
        })
    };
    let latin = load("segoe", &[("segoeui.ttf", 0)]);
    let cjk = load("jhenghei", &[("msjh.ttc", 1), ("msjh.ttf", 0), ("msyh.ttc", 1)]);
    let latin_bold = load("segoe-bold", &[("segoeuib.ttf", 0)]);
    let cjk_bold = load("jhenghei-bold", &[("msjhbd.ttc", 1), ("msjhbd.ttf", 0), ("msyhbd.ttc", 1)]);
    let mono = load("cascadia", &[("CascadiaMono.ttf", 0), ("consola.ttf", 0)]);

    let defaults = fonts.families.get(&FontFamily::Proportional).cloned().unwrap_or_default();
    let with = |first: &[&Option<String>], rest: &[String]| -> Vec<String> {
        first.iter().filter_map(|n| (*n).clone()).chain(rest.iter().cloned()).collect()
    };
    let proportional = with(&[&latin, &cjk], &defaults);
    let bold = with(&[&latin_bold, &cjk_bold, &latin, &cjk], &defaults);
    let mono_defaults = fonts.families.get(&FontFamily::Monospace).cloned().unwrap_or_default();
    let monospace = with(&[&mono, &cjk], &mono_defaults);
    fonts.families.insert(FontFamily::Proportional, proportional);
    fonts.families.insert(FontFamily::Monospace, monospace);
    fonts.families.insert(theme::bold(), bold);
    ctx.set_fonts(fonts);
}
