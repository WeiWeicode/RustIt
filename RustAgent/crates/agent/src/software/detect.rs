//! 「已安裝」判斷(P7-SOFTWARE-DESIGN §5.1 `detect.rs`):以整台電腦的登錄檔 Uninstall 項目(collector `machine_uninstall_entries`,
//! 只有 HKLM)比對指令快照的 `detect`。安裝後確認與移除輪詢都用它。
//!
//! - `msi_product_code`:子機碼名稱 = `{產品代碼}`(不分大小寫)
//! - `display_name`:DisplayName 符合 SQL `LIKE` 樣式,只有 `%` 是萬用字元(主機把 `_`、`[` 當一般字元跳脫),不分大小寫
//!
//! 安裝時再比對 DisplayVersion 與套件版本([`installed_state`];P7 VM 驗收 B-2,0.9.2):較舊就安裝(升級),相同或較新才算已安裝。
//! **版本無法解析時採保守做法:退回只看「是否存在」(0.9.1 的行為)**——不重新安裝(避免對版本格式不明的軟體反覆安裝或降版),
//! 安裝後找得到項目即算完成;結果帶 `version_unknown`,IT 需要換版本時先移除再安裝。

use super::{Detect, DetectKind};
use rustit_collector::UninstallEntry;
use std::cmp::Ordering;

/// 版本字串轉數字序列:去掉前後空白與開頭的 `v`,取第一個空白之前,以 `.` 分段;每段 1–9 位數字、最多 8 段,否則無法解析
pub fn parse_version(s: &str) -> Option<Vec<u64>> {
    let s = s.trim();
    let s = s.strip_prefix(['v', 'V']).unwrap_or(s);
    let s = s.split_whitespace().next()?;
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() > 8 {
        return None;
    }
    parts
        .iter()
        .map(|p| {
            (!p.is_empty() && p.len() <= 9 && p.bytes().all(|c| c.is_ascii_digit()))
                .then(|| p.parse().ok())
                .flatten()
        })
        .collect()
}

/// 比較兩個版本(段數不同時,短的補 0:`24.09` = `24.09.00.0`);任一方無法解析回 None
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let (a, b) = (parse_version(a)?, parse_version(b)?);
    let n = a.len().max(b.len());
    let at = |v: &[u64], i: usize| v.get(i).copied().unwrap_or(0);
    Some(
        (0..n)
            .map(|i| at(&a, i).cmp(&at(&b, i)))
            .find(|o| o.is_ne())
            .unwrap_or(Ordering::Equal),
    )
}

/// 符合 `detect` 的項目與套件版本比對的結果(字串為偵測到的 DisplayVersion)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Installed {
    /// 沒有符合的項目
    Absent,
    /// 有,但版本都比套件舊(可解析的最高版本)
    Older(String),
    /// 有相同或較新的版本
    Current(String),
    /// 有,但版本無法比較(套件版本或 DisplayVersion 無法解析):保守視為已安裝
    Unknown(String),
}

/// 純函式:多個符合的項目(例如舊版 32 位元與新版 64 位元並存)時,任一個相同或較新即為 `Current`;
/// 沒有相同或較新、但有版本無法解析的項目 → `Unknown`;全部可解析且較舊 → `Older`(最高的那個)
pub fn installed_state(entries: &[UninstallEntry], package_version: &str) -> Installed {
    let Some(first) = entries.first() else {
        return Installed::Absent;
    };
    if parse_version(package_version).is_none() {
        return Installed::Unknown(first.version.clone());
    }
    let mut newest: Option<&str> = None;
    let mut unknown: Option<&str> = None;
    for e in entries {
        match compare_versions(&e.version, package_version) {
            Some(Ordering::Less) => {
                if newest.is_none_or(|n| compare_versions(&e.version, n) == Some(Ordering::Greater))
                {
                    newest = Some(&e.version);
                }
            }
            Some(_) => return Installed::Current(e.version.clone()),
            None => unknown = unknown.or(Some(&e.version)),
        }
    }
    match (unknown, newest) {
        (Some(v), _) => Installed::Unknown(v.to_string()),
        (None, Some(v)) => Installed::Older(v.to_string()),
        (None, None) => Installed::Absent,
    }
}

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

/// 全部符合的項目(依登錄檔順序;移除流程取第一個)
pub fn find_all(entries: Vec<UninstallEntry>, d: &Detect) -> Vec<UninstallEntry> {
    entries.into_iter().filter(|e| matches(d, e)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare() {
        use Ordering::*;
        let c = compare_versions;
        assert_eq!(c("8.8.9", "8.9.8"), Some(Less));
        assert_eq!(c("8.9.8", "8.8.9"), Some(Greater));
        assert_eq!(c("26.05", "26.05.2"), Some(Less), "短的補 0");
        assert_eq!(c("26.05.2", "26.05"), Some(Greater));
        assert_eq!(
            c("24.09.00.0", "24.09"),
            Some(Equal),
            "7-Zip MSI 的 DisplayVersion"
        );
        assert_eq!(c("24.9", "24.09"), Some(Equal), "前導 0 以數字比較");
        assert_eq!(c("21.07", "24.09"), Some(Less));
        assert_eq!(c("10.0", "9.9"), Some(Greater), "數字比較不是字串比較");
        assert_eq!(c("v1.2.3", "1.2.3"), Some(Equal));
        assert_eq!(c("8.7.1 (64-bit)", "8.7.1"), Some(Equal), "取空白之前");
        assert_eq!(c("1.2.3-beta", "1.2.3"), None, "後綴無法解析");
        assert_eq!(c("", "1.0"), None, "沒有 DisplayVersion");
        assert_eq!(c("1..2", "1.2"), None);
        assert_eq!(c("1.2", "2024 R2"), Some(Less), "取空白之前:2024");
        assert_eq!(c("1.2", "R2"), None);
        assert_eq!(c("1234567890", "1"), None, "單段超過 9 位");
        assert_eq!(c("1.2.3.4.5.6.7.8.9", "1"), None, "超過 8 段");
    }

    #[test]
    fn installed_state_rules() {
        let e = |v: &str| UninstallEntry {
            version: v.into(),
            ..Default::default()
        };
        assert_eq!(installed_state(&[], "8.9.8"), Installed::Absent);
        assert_eq!(
            installed_state(&[e("8.8.9")], "8.9.8"),
            Installed::Older("8.8.9".into())
        );
        assert_eq!(
            installed_state(&[e("8.9.8")], "8.9.8"),
            Installed::Current("8.9.8".into())
        );
        assert_eq!(
            installed_state(&[e("9.0")], "8.9.8"),
            Installed::Current("9.0".into()),
            "較新也算"
        );
        assert_eq!(
            installed_state(&[e("21.07"), e("26.05.0.0")], "26.05"),
            Installed::Current("26.05.0.0".into()),
            "舊版 32 位元與新版並存"
        );
        assert_eq!(
            installed_state(&[e("1.0"), e("8.8.1"), e("2.0")], "8.9.8"),
            Installed::Older("8.8.1".into()),
            "都較舊:回報最高的"
        );
        assert_eq!(
            installed_state(&[e("")], "8.9.8"),
            Installed::Unknown("".into()),
            "沒有版本:保守視為已安裝"
        );
        assert_eq!(
            installed_state(&[e("8.8.9"), e("x")], "8.9.8"),
            Installed::Unknown("x".into())
        );
        assert_eq!(
            installed_state(&[e("8.8.9")], "2024-R2"),
            Installed::Unknown("8.8.9".into()),
            "套件版本無法解析"
        );
    }

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
