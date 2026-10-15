//! 指令 `logs.collect`:收集 Agent 日誌並上傳為指令附檔(PLATFORM-PLAN A4;`docs/contracts/command-kinds.md`)。
//!
//! 日誌目錄最近 `days` 天的 `agent-YYYY-MM-DD.log` → 逐行遮罩(第二道防線:日誌本來就不可含私鑰與 Token,AGENT.md §7.1)
//! → 每天壓成一個 zip 項目,壓縮後總和超過 20 MB 時從最舊的日期開始捨棄 → `POST /agent/v1/commands/{id}/files`(重試 3 次)。
//! 每天只壓縮一次(先各自壓成單一項目,再原樣搬進最終 zip),避免為了湊大小反覆壓縮佔用使用者電腦的 CPU。

use chrono::NaiveDate;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// 壓縮後上限(與主機 FILE_MAX_BYTES 相同)
pub const MAX_ZIP_BYTES: usize = 20 * 1024 * 1024;
/// 預留給 zip 中央目錄等結構
const ZIP_OVERHEAD: usize = 64 * 1024;
const MASK: &str = "***";
/// `key=value` 形式要遮罩值的鍵(不分大小寫)
const SECRET_KEYS: [&str; 3] = ["token=", "password=", "secret="];

/// 日誌目錄中最近 `days` 天(含今天)的日誌檔,新到舊
pub fn select_files(
    dir: &Path,
    prefix: &str,
    days: u32,
    today: NaiveDate,
) -> Vec<(NaiveDate, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let oldest = today - chrono::Duration::days(i64::from(days.max(1)) - 1);
    let mut files: Vec<(NaiveDate, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let date = name.strip_prefix(prefix)?.strip_suffix(".log")?;
            let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
            (date >= oldest && date <= today).then(|| (date, e.path()))
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    files
}

/// 遮罩私鑰區塊、`Bearer <值>`、`token=` / `password=` / `secret=` 之後的值
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_key = false;
    for line in text.split_inclusive('\n') {
        if in_key {
            if line.contains("-----END") && line.contains("PRIVATE KEY-----") {
                in_key = false;
            }
            continue;
        }
        if line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----") {
            out.push_str("[已遮罩:私鑰]\n");
            in_key =
                !(line.contains("-----END") && line.rfind("-----END") > line.find("-----BEGIN"));
            continue;
        }
        out.push_str(&redact_line(line));
    }
    out
}

/// 值在 `line[start..]` 的範圍:以引號開頭時到對應的引號為止,否則到空白、引號或分隔符號為止
fn value_span(line: &str, start: usize) -> (usize, usize) {
    let rest = &line[start..];
    if let Some(q) = rest.chars().next().filter(|c| matches!(c, '"' | '\'')) {
        let s = start + 1;
        return (s, s + line[s..].find(q).unwrap_or(line.len() - s));
    }
    let len = rest
        .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ';' | '&' | ')' | '}'))
        .unwrap_or(rest.len());
    (start, start + len)
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    // (開始, 結束) 要換成 *** 的範圍;to_ascii_lowercase 不改變位元組位置
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut from = 0;
    while let Some(i) = lower[from..].find("bearer ") {
        let (start, end) = value_span(line, from + i + "bearer ".len());
        if end > start {
            spans.push((start, end));
        }
        from = end.max(start);
    }
    for key in SECRET_KEYS {
        let mut from = 0;
        while let Some(i) = lower[from..].find(key) {
            let (start, end) = value_span(line, from + i + key.len());
            if end > start {
                spans.push((start, end));
            }
            from = end.max(start);
        }
    }
    if spans.is_empty() {
        return line.to_string();
    }
    spans.sort();
    let mut out = String::with_capacity(line.len());
    let mut pos = 0;
    for (s, e) in spans {
        if s < pos {
            continue;
        }
        out.push_str(&line[pos..s]);
        out.push_str(MASK);
        pos = e;
    }
    out.push_str(&line[pos..]);
    out
}

/// 壓縮好的日誌
#[derive(Debug)]
pub struct Bundle {
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub days_included: usize,
    pub truncated: bool,
}

/// 單一項目的 zip(只用來量壓縮後大小,之後原樣搬進最終 zip)
fn single(name: &str, content: &[u8]) -> Result<Vec<u8>, String> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    w.start_file(name, opts)
        .map_err(|e| format!("壓縮 {name} 失敗:{e}"))?;
    w.write_all(content)
        .map_err(|e| format!("壓縮 {name} 失敗:{e}"))?;
    Ok(w.finish()
        .map_err(|e| format!("壓縮 {name} 失敗:{e}"))?
        .into_inner())
}

/// 依新到舊加入,壓縮後總和超過 `max` 就停止(較舊的捨棄,truncated)
pub fn bundle(files: &[(NaiveDate, PathBuf)], max: usize) -> Result<Bundle, String> {
    let mut parts: Vec<Vec<u8>> = Vec::new();
    let mut total = ZIP_OVERHEAD;
    let mut truncated = false;
    for (_, path) in files {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let raw = std::fs::read(path).map_err(|e| format!("無法讀取 {name}:{e}"))?;
        let part = single(&name, redact(&String::from_utf8_lossy(&raw)).as_bytes())?;
        if total + part.len() > max {
            truncated = true;
            break;
        }
        total += part.len();
        parts.push(part);
    }
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for part in &parts {
        let mut archive =
            ZipArchive::new(Cursor::new(part.as_slice())).map_err(|e| format!("壓縮檔錯誤:{e}"))?;
        let file = archive
            .by_index_raw(0)
            .map_err(|e| format!("壓縮檔錯誤:{e}"))?;
        w.raw_copy_file(file)
            .map_err(|e| format!("壓縮檔錯誤:{e}"))?;
    }
    let bytes = w
        .finish()
        .map_err(|e| format!("壓縮檔錯誤:{e}"))?
        .into_inner();
    Ok(Bundle {
        sha256: hex::encode(Sha256::digest(&bytes)),
        days_included: parts.len(),
        truncated,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn selects_recent_days_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "agent-2026-10-13.log",
            "agent-2026-10-14.log",
            "agent-2026-10-15.log",
            "agent-2026-10-10.log",
            "watchdog-2026-10-15.log",
            "agent-x.log",
        ] {
            std::fs::write(dir.path().join(name), "x").unwrap();
        }
        let got: Vec<NaiveDate> = select_files(dir.path(), "agent-", 3, d("2026-10-15"))
            .into_iter()
            .map(|(d, _)| d)
            .collect();
        assert_eq!(got, vec![d("2026-10-15"), d("2026-10-14"), d("2026-10-13")]);
        assert_eq!(
            select_files(dir.path(), "agent-", 1, d("2026-10-15")).len(),
            1
        );
        assert!(select_files(&dir.path().join("none"), "agent-", 3, d("2026-10-15")).is_empty());
    }

    #[test]
    fn redacts_secrets() {
        let text = "a\n-----BEGIN PRIVATE KEY-----\nMIIEv\nabc\n-----END PRIVATE KEY-----\nAuthorization: Bearer eyJhbGc.x.y end\nurl?token=abc123&x=1 password=p@ss secret='s'\n普通訊息\n";
        let r = redact(text);
        assert!(!r.contains("MIIEv") && !r.contains("abc\n"), "{r}");
        assert!(r.contains("[已遮罩:私鑰]"));
        assert!(r.contains("Bearer *** end"), "{r}");
        assert!(r.contains("token=***&x=1"), "{r}");
        assert!(r.contains("password=*** "), "{r}");
        assert!(r.contains("secret='***'"), "{r}");
        assert!(r.contains("普通訊息"));
        assert_eq!(redact("TOKEN=Abc\n"), "TOKEN=***\n", "不分大小寫");
        assert_eq!(
            redact("-----BEGIN EC PRIVATE KEY-----\nzz\n"),
            "[已遮罩:私鑰]\n",
            "沒有結尾也不輸出內容"
        );
    }

    #[test]
    fn bundles_and_truncates_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let mut files = Vec::new();
        for (i, date) in ["2026-10-15", "2026-10-14", "2026-10-13"]
            .iter()
            .enumerate()
        {
            let p = dir.path().join(format!("agent-{date}.log"));
            // 不易壓縮的內容,讓大小可預測
            let content: String = (0..20_000)
                .map(|k| format!("{:x}", (k * 2_654_435_761u64 + i as u64) % 4_294_967_291))
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(&p, content).unwrap();
            files.push((d(date), p));
        }
        let all = bundle(&files, MAX_ZIP_BYTES).unwrap();
        assert_eq!((all.days_included, all.truncated), (3, false));
        let mut archive = ZipArchive::new(Cursor::new(all.bytes.clone())).unwrap();
        assert_eq!(archive.len(), 3);
        let mut s = String::new();
        archive
            .by_name("agent-2026-10-15.log")
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        assert!(s.starts_with('0'));
        assert_eq!(all.sha256, hex::encode(Sha256::digest(&all.bytes)));
        let newest = std::fs::read_to_string(&files[0].1).unwrap();
        let first = single("agent-2026-10-15.log", redact(&newest).as_bytes())
            .unwrap()
            .len();
        let cut = bundle(&files, ZIP_OVERHEAD + first + 1).unwrap();
        assert_eq!(
            (cut.days_included, cut.truncated),
            (1, true),
            "超過上限捨棄較舊的日期"
        );
        let mut a = ZipArchive::new(Cursor::new(cut.bytes)).unwrap();
        assert!(a.by_name("agent-2026-10-15.log").is_ok());
    }
}
