//! 版本號(semver `x.y.z`,可帶 `-後綴`;契約 watchdog.schema.json UpgradeTarget)比較與檢查(P6-UPGRADE-DESIGN §8.2)。

use std::cmp::Ordering;

/// `x.y.z[-後綴]` 的數字部分;格式不符回 None(各段 1–4 位數字,後綴 1–20 個 `[0-9A-Za-z.-]`,與契約的 url 規則相同)
pub fn core(v: &str) -> Option<(u32, u32, u32)> {
    let (main, suffix) = match v.split_once('-') {
        Some((m, s)) => (m, Some(s)),
        None => (v, None),
    };
    if let Some(s) = suffix
        && (s.is_empty()
            || s.len() > 20
            || !s
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
    {
        return None;
    }
    let mut parts = main.split('.');
    let mut next = || -> Option<u32> {
        let p = parts.next()?;
        (!p.is_empty() && p.len() <= 4 && p.chars().all(|c| c.is_ascii_digit()))
            .then(|| p.parse().ok())
            .flatten()
    };
    let r = (next()?, next()?, next()?);
    parts.next().is_none().then_some(r)
}

/// 只比數字部分(`0.7.2-broken` 與 `0.7.2` 相同);任一格式不符回 None
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    Some(core(a)?.cmp(&core(b)?))
}

/// 下載路徑 `/agent/v1/releases/{component}/{version}/{file}` 的元件與版本段必須與目標一致;回傳檔名
pub fn release_file<'a>(url: &'a str, component: &str, version: &str) -> Result<&'a str, String> {
    let rest = url
        .strip_prefix("/agent/v1/releases/")
        .ok_or_else(|| format!("下載路徑不是版本檔:{url}"))?;
    let mut it = rest.split('/');
    let (c, v, f) = match (it.next(), it.next(), it.next(), it.next()) {
        (Some(c), Some(v), Some(f), None) => (c, v, f),
        _ => return Err(format!("下載路徑格式錯誤:{url}")),
    };
    if c != component || v != version {
        return Err(format!(
            "下載路徑 {url} 與目標 {component} {version} 不一致"
        ));
    }
    let ok_file = !f.is_empty()
        && f.len() <= 128
        && !f.starts_with('.')
        && f.chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if !ok_file {
        return Err(format!("下載檔名不合法:{f}"));
    }
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_compares() {
        assert_eq!(core("0.7.0"), Some((0, 7, 0)));
        assert_eq!(core("0.7.2-broken"), Some((0, 7, 2)));
        for bad in [
            "",
            "0.7",
            "0.7.0.1",
            "a.b.c",
            "0.7.0-",
            "0.7.0-x/y",
            "12345.0.0",
        ] {
            assert_eq!(core(bad), None, "{bad}");
        }
        assert_eq!(compare("0.6.0", "0.7.0"), Some(Ordering::Less));
        assert_eq!(compare("0.10.0", "0.9.9"), Some(Ordering::Greater));
        assert_eq!(compare("0.7.2-broken", "0.7.2"), Some(Ordering::Equal));
        assert_eq!(compare("x", "0.7.0"), None);
    }

    #[test]
    fn release_url_must_match_target() {
        let url = "/agent/v1/releases/agent/0.7.1/rustit-agent.exe";
        assert_eq!(
            release_file(url, "agent", "0.7.1").unwrap(),
            "rustit-agent.exe"
        );
        assert!(release_file(url, "agent", "0.7.2").is_err());
        assert!(release_file(url, "watchdog", "0.7.1").is_err());
        for bad in [
            "https://evil.example/agent/v1/releases/agent/0.7.1/a.exe",
            "/agent/v1/releases/agent/0.7.1/../x.exe",
            "/agent/v1/releases/agent/0.7.1/sub/a.exe",
            "/agent/v1/releases/agent/0.7.1/.hidden",
            "/agent/v1/releases/agent/0.7.1/a b.exe",
        ] {
            assert!(release_file(bad, "agent", "0.7.1").is_err(), "{bad}");
        }
    }
}
