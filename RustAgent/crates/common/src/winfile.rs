//! 升級用的檔案查詢(P6-UPGRADE-DESIGN §5.1、§8.2):磁碟剩餘空間、exe 的產品版本(版本資源 `ProductVersion`,由各 crate 的 build.rs 寫入)。

use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// 目錄所在磁碟、此帳號可用的剩餘位元組
pub fn free_bytes(dir: &Path) -> Result<u64, String> {
    let w = wide(dir.as_os_str());
    let mut free = 0u64;
    // SAFETY:w 以 NUL 結尾;其他輸出參數可為 NULL
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            w.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(format!(
            "無法取得 {} 的磁碟剩餘空間:{}",
            dir.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(free)
}

/// exe 版本資源的 `ProductVersion` 字串(semver,可帶 `-後綴`);沒有版本資源時回 None
pub fn product_version(path: &Path) -> Option<String> {
    let w = wide(path.as_os_str());
    let mut handle = 0u32;
    // SAFETY:w 以 NUL 結尾
    let size = unsafe { GetFileVersionInfoSizeW(w.as_ptr(), &mut handle) };
    if size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size as usize];
    // SAFETY:buf 長度為 size
    if unsafe { GetFileVersionInfoW(w.as_ptr(), 0, size, buf.as_mut_ptr() as *mut _) } == 0 {
        return None;
    }
    // 第一個語言 / 字碼頁
    let mut ptr = std::ptr::null_mut();
    let mut len = 0u32;
    let q = wide(std::ffi::OsStr::new(r"\VarFileInfo\Translation"));
    // SAFETY:回傳的指標指向 buf 內部,buf 活到函式結束
    if unsafe { VerQueryValueW(buf.as_ptr() as *const _, q.as_ptr(), &mut ptr, &mut len) } == 0
        || len < 4
    {
        return None;
    }
    // SAFETY:len >= 4,ptr 指向兩個 u16(語言、字碼頁)
    let (lang, cp) = unsafe {
        let p = ptr as *const u16;
        (*p, *p.add(1))
    };
    let q = wide(std::ffi::OsStr::new(&format!(
        r"\StringFileInfo\{lang:04x}{cp:04x}\ProductVersion"
    )));
    // SAFETY:同上
    if unsafe { VerQueryValueW(buf.as_ptr() as *const _, q.as_ptr(), &mut ptr, &mut len) } == 0
        || len == 0
    {
        return None;
    }
    // SAFETY:ptr 指向 len 個 u16(含結尾 NUL)
    let s = unsafe { std::slice::from_raw_parts(ptr as *const u16, len as usize) };
    let s = String::from_utf16_lossy(s);
    let s = s.trim_end_matches('\0').trim();
    (!s.is_empty()).then(|| s.to_string())
}

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// 目錄必須是一般目錄,不是 junction、符號連結等 reparse point(升級快取不可被導向別處;Watchdog 與 Agent 共用)
pub fn not_reparse(dir: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    let m =
        std::fs::symlink_metadata(dir).map_err(|e| format!("無法讀取 {}:{e}", dir.display()))?;
    if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !m.is_dir() {
        return Err(format!("{} 不是一般目錄(連結)", dir.display()));
    }
    Ok(())
}

/// 檔案存在時必須是一般檔案(不是 reparse point、不是目錄);回傳是否存在
pub fn plain_file(path: &Path) -> Result<bool, String> {
    use std::os::windows::fs::MetadataExt;
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("無法讀取 {}:{e}", path.display())),
        Ok(m) if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !m.is_file() => {
            Err(format!("{} 不是一般檔案(連結)", path.display()))
        }
        Ok(_) => Ok(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junctions_are_not_plain_directories() {
        struct Tmp(std::path::PathBuf);
        impl Drop for Tmp {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        impl Tmp {
            fn path(&self) -> &Path {
                &self.0
            }
        }
        let dir = Tmp(std::env::temp_dir().join(format!(
            "rustit-reparse-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
        std::fs::create_dir_all(dir.path()).unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        assert!(not_reparse(&target).is_ok());
        assert!(not_reparse(&dir.path().join("missing")).is_err());
        let file = target.join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(not_reparse(&file).is_err(), "檔案不是目錄");
        assert_eq!(plain_file(&file), Ok(true));
        assert_eq!(plain_file(&target.join("none")), Ok(false));
        assert!(plain_file(&target).is_err(), "目錄不是檔案");
        // junction 不需要系統管理員權限
        let link = dir.path().join("link");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .unwrap();
        assert!(made.status.success(), "建立 junction 失敗:{made:?}");
        assert!(not_reparse(&link).is_err(), "junction 要拒絕");
        // 經過 junction 的路徑本身不是 reparse point,呼叫端要逐層檢查(cache\ 與 cache\watchdog\ 各查一次)
        assert!(plain_file(&link.join("f.txt")).unwrap());
    }

    #[test]
    fn free_space_and_missing_version() {
        assert!(free_bytes(&std::env::temp_dir()).unwrap() > 0);
        // 測試程式沒有版本資源
        assert_eq!(product_version(&std::env::current_exe().unwrap()), None);
        assert_eq!(product_version(Path::new(r"C:\no\such\file.exe")), None);
    }

    /// 系統檔有版本資源
    #[test]
    fn reads_product_version_of_system_file() {
        let notepad = Path::new(r"C:\Windows\System32\notepad.exe");
        if notepad.is_file() {
            assert!(product_version(notepad).is_some());
        }
    }
}
