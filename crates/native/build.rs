//! 在 exe 裡嵌入圖示與版本資訊（檔案總管的圖示、「內容 › 詳細資料」會顯示）。
//! 圖示沿用 WebView 版的 `crates/demo/icons/icon.ico`。

use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let icon = manifest_dir.parent().unwrap().join("demo").join("icons").join("icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());

    let version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let mut parts = version.split('.').map(|p| p.parse::<u16>().unwrap_or(0));
    let [major, minor, patch] = [(); 3].map(|_| parts.next().unwrap_or(0));
    let numeric = format!("{major},{minor},{patch},0");
    // .rc 字串裡的反斜線是跳脫字元，路徑改用正斜線
    let icon = icon.display().to_string().replace('\\', "/");

    let rc = format!(
        r#"#pragma code_page(65001)
1 ICON "{icon}"
1 VERSIONINFO
FILEVERSION {numeric}
PRODUCTVERSION {numeric}
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040404B0"
    BEGIN
      VALUE "CompanyName", "RustIt"
      VALUE "FileDescription", "RustIt 資產管理（原生版）"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "rustit-native"
      VALUE "OriginalFilename", "RustIt-Native.exe"
      VALUE "ProductName", "RustIt 資產管理"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x0404, 1200
  END
END
"#
    );
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("app.rc");
    std::fs::write(&out, rc).unwrap();
    embed_resource::compile(&out, embed_resource::NONE).manifest_optional().unwrap();
}
