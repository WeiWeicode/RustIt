//! 「已安裝」判斷(P7-SOFTWARE-DESIGN §5.1 `detect.rs`):以整台電腦的登錄檔 Uninstall 項目(collector `machine_uninstall_entries`,
//! 只有 HKLM)比對指令快照的 `detect`。安裝後確認與移除輪詢都用它。
//!
//! - `msi_product_code`:子機碼名稱 = `{產品代碼}`(不分大小寫)
//! - `display_name`:DisplayName 符合 SQL `LIKE` 樣式,只有 `%` 是萬用字元(主機把 `_`、`[` 當一般字元跳脫),不分大小寫

use super::{Detect, DetectKind};
use rustit_collector::UninstallEntry;

/// SQL LIKE(只支援 `%`),不分大小寫
pub fn like(text: &str, pattern: &str) -> bool {
    let t = text.to_lowercase();
    let p = pattern.to_lowercase();
    let parts: Vec<&str> = p.split('%').collect();
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if parts.len() == 1 {
        return t == p;
    }
    if !t.starts_with(first) {
        return false;
    }
    let mut pos = first.len();
    for mid in &parts[1..parts.len() - 1] {
        match t[pos..].find(mid) {
            Some(i) => pos += i + mid.len(),
            None => return false,
        }
    }
    t.len() >= pos + last.len() && t[pos..].ends_with(last)
}

pub fn matches(d: &Detect, e: &UninstallEntry) -> bool {
    match d.kind {
        DetectKind::ProductCode => e.key.eq_ignore_ascii_case(&d.value),
        DetectKind::DisplayName => !e.name.is_empty() && like(&e.name, &d.value),
    }
}

/// 第一個符合的項目
pub fn find(entries: Vec<UninstallEntry>, d: &Detect) -> Option<UninstallEntry> {
    entries.into_iter().find(|e| matches(d, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_patterns() {
        assert!(like("7-Zip 24.09 (x64 edition)", "7-Zip%"));
        assert!(like("7-ZIP 24.09", "7-zip%"), "不分大小寫");
        assert!(!like("My 7-Zip", "7-Zip%"));
        assert!(like("Notepad++ (64-bit x64)", "Notepad++%"));
        assert!(like("Mozilla Firefox (x64 zh-TW)", "%Firefox%"));
        assert!(like("Foo Bar Baz", "Foo%Baz"));
        assert!(!like("Foo Bar", "Foo%Baz"));
        assert!(like("Exact", "exact"));
        assert!(!like("Exact name", "Exact"));
        assert!(like("a_b", "a_b"), "_ 是一般字元");
        assert!(!like("axb", "a_b"));
        assert!(!like("ab", "a%b%b"), "片段不可重疊");
        assert!(like("abab", "a%b%b"));
    }

    #[test]
    fn product_code_and_name() {
        let e = UninstallEntry {
            key: "{23170F69-40C1-2702-2409-000001000000}".into(),
            name: "7-Zip 24.09 (x64 edition)".into(),
            windows_installer: true,
            ..Default::default()
        };
        let code = Detect {
            kind: DetectKind::ProductCode,
            value: "{23170f69-40c1-2702-2409-000001000000}".into(),
        };
        assert!(matches(&code, &e));
        let name = Detect {
            kind: DetectKind::DisplayName,
            value: "7-Zip%".into(),
        };
        assert!(matches(&name, &e));
        let empty = UninstallEntry::default();
        let any = Detect {
            kind: DetectKind::DisplayName,
            value: "%".into(),
        };
        assert!(!matches(&any, &empty), "沒有 DisplayName 的項目不算");
    }
}
