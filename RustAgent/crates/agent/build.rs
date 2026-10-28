//! exe 版本資源(P6-UPGRADE-DESIGN §8.2):Watchdog 升級 Agent 前比對下載檔的 ProductVersion 與目標版本。
//! 版本取 `RUSTIT_BUILD_VERSION`(測試版 0.7.1 / 0.7.2-broken 等用)或 Cargo.toml,同時以 `RUSTIT_VERSION` 給程式使用。

fn main() {
    println!("cargo:rerun-if-env-changed=RUSTIT_BUILD_VERSION");
    let version = std::env::var("RUSTIT_BUILD_VERSION")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap());
    let version = version.trim();
    println!("cargo:rustc-env=RUSTIT_VERSION={version}");
    if std::env::var("CARGO_CFG_WINDOWS").is_err() {
        return;
    }
    let nums: Vec<u16> = version
        .split('-')
        .next()
        .unwrap_or_default()
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .chain(std::iter::repeat(0))
        .take(3)
        .collect();
    let rc = format!(
        r#"1 VERSIONINFO
FILEVERSION {a},{b},{c},0
PRODUCTVERSION {a},{b},{c},0
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "CompanyName", "GigaNexus"
      VALUE "FileDescription", "GigaNexus Agent"
      VALUE "FileVersion", "{v}"
      VALUE "ProductName", "GigaNexus Agent"
      VALUE "ProductVersion", "{v}"
      VALUE "OriginalFilename", "rustit-agent.exe"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#,
        a = nums[0],
        b = nums[1],
        c = nums[2],
        v = version
    );
    let path = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("version.rc");
    std::fs::write(&path, rc).unwrap();
    embed_resource::compile(&path, embed_resource::NONE)
        .manifest_optional()
        .unwrap();
}
