//! 安裝 / 移除參數檢查(P7-SOFTWARE-DESIGN §2.3、資安稽核 D3 / H2)。
//!
//! 主機登錄與建立指令時已驗過(ItAgentBack `argsErrors`);Agent 執行前**再驗一次**,不符回 `INVALID_PARAMS`。
//! 規則與 ItAgentBack 逐條對應,兩邊吃同一份測試向量 `docs/contracts/install-args.vectors.json`(本檔測試)。
//! 參數只允許 ASCII 白名單字元,所以以位元組處理。

use super::Installer;

/// 長度上限(與主機 ARGS_MAX 相同)
pub const ARGS_MAX: usize = 500;

/// 字元白名單 `[A-Za-z0-9 /\-_=.:,"{}()+]`(不含 `& | ; < > ^ \` $ \ @ [ ] ~ ? %` 與換行)
fn allowed(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b" /-_=.:,\"{}()+".contains(&b)
}

/// 不可指到其他可執行檔、轉換檔、回應檔、設定檔:`\.(msi|…|json)\b`
const FILE_EXTS: [&str; 19] = [
    "msi", "msp", "mst", "exe", "dll", "bat", "cmd", "ps1", "vbs", "js", "inf", "iss", "ini",
    "xml", "txt", "log", "reg", "cfg", "json",
];

fn word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn names_file(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    let b = lower.as_bytes();
    b.iter().enumerate().any(|(i, &c)| {
        c == b'.'
            && FILE_EXTS.iter().any(|ext| {
                let end = i + 1 + ext.len();
                lower[i + 1..].starts_with(ext) && (end == b.len() || !word(b[end]))
            })
    })
}

/// 禁止的屬性(完全比對,不分大小寫);另含 `CONFIG*`、`INI*`、`REBOOT*`、`*FILE`
const BANNED_PROPS: [&str; 28] = [
    "TRANSFORMS",
    "TRANSFORMSATSOURCE",
    "TRANSFORMSSECURE",
    "PATCH",
    "MSIPATCHREMOVE",
    "PATCHNEWPACKAGECODE",
    "SOURCELIST",
    "INSTALLSOURCE",
    "SOURCEDIR",
    "ADDSOURCE",
    "ADVERTISE",
    "MSINEWINSTANCE",
    "MSIINSTANCEGUID",
    "REINSTALL",
    "REINSTALLMODE",
    // 改變安裝方式(ACTION=ADMIN 等)、Restart Manager 關閉程式(L2);REBOOT* 見 banned_prop
    "ACTION",
    "EXECUTEACTION",
    "MSIRMSHUTDOWN",
    "MSIRESTARTMANAGERCONTROL",
    "MSIDISABLERMRESTART",
    "MSILOGGINGMODE",
    "LIMITUI",
    "ARPSYSTEMCOMPONENT",
    "ARPNOREMOVE",
    "MSIINSTALLPERUSER",
    "ROOTDRIVE",
    "SETTINGS",
    "XML",
];

fn banned_prop(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    BANNED_PROPS.contains(&n.as_str())
        || n.starts_with("CONFIG")
        || n.starts_with("INI")
        || n.starts_with("REBOOT")
        || n.ends_with("FILE")
}

/// 禁止的開關(去掉開頭的 / - --,比對 `:` 之前的名稱,完全比對、不分大小寫);字首規則見 [`banned_switch`]
const BANNED_SWITCHES: [&str; 33] = [
    "log",
    "loadinf",
    "saveinf",
    "f1",
    "f2",
    "r",
    "v",
    "b",
    "z",
    "y",
    "i",
    "p",
    "t",
    "a",
    "x",
    "update",
    "package",
    "uninstall",
    "repair",
    "modify",
    "layout",
    "config",
    "configure",
    "settings",
    "response",
    "unattend",
    "answerfile",
    "password",
    "restartexitcode",
    "debugwnd",
    "silent",
    "ncrc",
    "ini",
];

fn banned_switch(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    // l[*!+voiwearucmpx]*:/l、/lv、/l*v 等記錄檔開關
    let msi_log = n.starts_with('l') && n[1..].bytes().all(|c| b"*!+voiwearucmpx".contains(&c));
    // 字首規則:j.*、parent.*、burn\..*(Burn 內部參數)
    msi_log
        || BANNED_SWITCHES.contains(&n.as_str())
        || n.starts_with('j')
        || n.starts_with("parent")
        || n.starts_with("burn.")
}

/// 重開機與強制關閉程式類開關(`/forcerestart`、`/promptrestart`、`-reboot`、`/RESTARTAPPLICATIONS`、`/FORCECLOSEAPPLICATIONS`…):
/// 重開機由 Agent 依 `reboot_policy` 處理,只允許 no 開頭的(`/norestart`、`/NOCLOSEAPPLICATIONS`;L2)。對應 ItAgentBack `RESTART_SWITCH`
fn restart_switch(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    !n.starts_with("no")
        && ["restart", "reboot", "closeapplications"]
            .iter()
            .any(|w| n.contains(w))
}

/// exe / burn / 未指定類型:名稱含這些字的開關多半是寫檔或指定路徑
fn write_switch(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [
        "log", "out", "file", "dump", "trace", "save", "path", "report",
    ]
    .iter()
    .any(|w| n.contains(w))
}

/// 屬性名稱 `^[A-Za-z_][A-Za-z0-9_.]*$`
fn prop_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b[1..]
            .iter()
            .all(|&c| c.is_ascii_alphanumeric() || c == b'_' || c == b'.')
}

/// `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`(MSI 產品代碼)
pub fn is_guid(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 38
        && b[0] == b'{'
        && b[37] == b'}'
        && b[1..37].iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

const PATH_MSG: &str =
    "路徑只允許 C:/Program Files/ 或 C:/Program Files (x86)/ 底下(路徑用 /,不可含 :、..)";

/// 值的檢查(路徑、UNC、{ }、( ))
fn value_error(value: &str) -> Option<&'static str> {
    if value.is_empty() {
        return None;
    }
    if value.contains("//") {
        return Some("不可使用網路路徑(UNC)");
    }
    if value.contains("..") {
        return Some("路徑不可含 ..");
    }
    if value.contains(['{', '}']) && !is_guid(value) {
        return Some("{ } 只能用於 GUID(MSI 產品代碼)");
    }
    let b = value.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        // ^[Cc]:/Program Files( (x86))?/[^:]*$(不分大小寫)
        let lower = value.to_ascii_lowercase();
        let rest = ["c:/program files/", "c:/program files (x86)/"]
            .iter()
            .find_map(|p| lower.strip_prefix(p));
        return match rest {
            Some(r) if !r.contains(':') => None,
            _ => Some(PATH_MSG),
        };
    }
    // 不是磁碟機路徑:不可含 / : ( )(根目錄、相對路徑、替代資料流)
    if value.contains(['/', ':', '(', ')']) {
        return Some(PATH_MSG);
    }
    None
}

/// 一個參數:名稱(不含空白、引號與 =)+ 可選的 `=值`(值可用引號包住整個值),後面必須是空白或結尾。
/// 回傳 (結束位置, 名稱, 值);`值` 為 None 表示沒有 `=`
fn token(s: &str, pos: usize) -> Option<(usize, &str, Option<&str>)> {
    let b = s.as_bytes();
    let mut i = pos;
    while i < b.len() && !matches!(b[i], b' ' | b'"' | b'=') {
        i += 1;
    }
    if i == pos {
        return None;
    }
    let name = &s[pos..i];
    let boundary = |j: usize| j == b.len() || b[j] == b' ';
    if i < b.len() && b[i] == b'=' {
        let start = i + 1;
        if start < b.len() && b[start] == b'"' {
            let close = s[start + 1..].find('"').map(|k| start + 1 + k)?;
            return boundary(close + 1).then(|| (close + 1, name, Some(&s[start..=close])));
        }
        let mut j = start;
        while j < b.len() && !matches!(b[j], b' ' | b'"') {
            j += 1;
        }
        return boundary(j).then(|| (j, name, Some(&s[start..j])));
    }
    boundary(i).then_some((i, name, None))
}

fn unquote(v: &str) -> &str {
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        &v[1..v.len() - 1]
    } else {
        v
    }
}

/// 依安裝程式類型檢查每個參數(D3)
fn grammar_error(v: &str, kind: Option<Installer>) -> Option<String> {
    let mut rest = v.trim();
    // NSIS 的 /D= 必須放最後、不可加引號,值可含空白:(^|\s)/D=([^"]*)$
    if kind == Some(Installer::Nsis) {
        let lower = rest.to_ascii_lowercase();
        let found = lower.match_indices("/d=").find(|(i, _)| {
            (*i == 0 || rest.as_bytes()[i - 1] == b' ') && !rest[i + 3..].contains('"')
        });
        if let Some((i, _)) = found {
            // 值裡不可再夾開關(類型標錯時,不是 NSIS 的安裝程式會把它當成開關)
            let d = rest[i + 3..].as_bytes();
            if d.windows(2)
                .any(|w| w[0].is_ascii_whitespace() && matches!(w[1], b'/' | b'-'))
            {
                return Some("/D= 的路徑裡不可再含 / 或 - 開頭的參數(/D= 必須放最後)".into());
            }
            if let Some(e) = value_error(rest[i + 3..].trim()) {
                return Some(e.into());
            }
            rest = rest[..i].trim();
        }
    }
    let mut pos = 0;
    while pos < rest.len() {
        if rest.as_bytes()[pos] == b' ' {
            pos += 1;
            continue;
        }
        let Some((end, name, raw)) = token(rest, pos) else {
            return Some("引號只能包住整個值(例如 NAME=\"C:/Program Files/App\")".into());
        };
        pos = end;
        let value = raw.map(unquote).unwrap_or("");
        if name.starts_with(['/', '-']) {
            if kind == Some(Installer::Msi) {
                return Some("MSI 只接受「屬性=值」;/qn /norestart 與記錄檔由 Agent 加上".into());
            }
            let sw = name
                .strip_prefix("--")
                .or_else(|| name.strip_prefix(['/', '-']))
                .unwrap_or(name);
            let sw_name = sw.split(':').next().unwrap_or(sw);
            // InstallShield 等會把 /v 後面緊接的內容原樣交給 msiexec(/vREMOVE=ALL、/v/qn):
            // Inno 以外一律不接受 v 開頭的開關(Inno 的 /VERYSILENT 是正常開關;2026-10-27 資安 M1)
            if kind != Some(Installer::Inno) && sw_name.starts_with(['v', 'V']) {
                return Some(format!(
                    "不可使用 {name}(v 開頭的開關可能把參數轉交 msiexec)"
                ));
            }
            if banned_switch(sw_name) {
                return Some(format!(
                    "不可使用 {name}(會讀寫外部檔案、轉交其他安裝程式或改變安裝方式)"
                ));
            }
            if restart_switch(sw_name) {
                return Some(format!(
                    "不可使用 {name}(重開機由 Agent 依重開機政策處理,只允許 /norestart 這類)"
                ));
            }
            if !matches!(kind, Some(Installer::Inno | Installer::Nsis)) && write_switch(sw_name) {
                return Some(format!("不可使用 {name}(可能以 SYSTEM 寫檔)"));
            }
            // /switch:value 的值同樣檢查
            let colon = sw.find(':').map(|k| &sw[k + 1..]).unwrap_or("");
            if let Some(e) = value_error(colon).or_else(|| value_error(value)) {
                return Some(e.into());
            }
        } else if raw.is_some() {
            if !prop_name(name) {
                return Some(format!("屬性名稱 {name} 不正確"));
            }
            if banned_prop(name) {
                return Some(format!(
                    "不可設定 {name}(讀外部檔案、改變安裝方式或隱藏安裝)"
                ));
            }
            // REMOVE=ALL 會把安裝變成移除整個產品(L2;REMOVE={產品代碼} / 功能名稱仍可用)
            if name.eq_ignore_ascii_case("REMOVE")
                && value
                    .split(',')
                    .any(|x| x.trim().eq_ignore_ascii_case("ALL"))
            {
                return Some(format!("不可設定 {name}=ALL(會移除整個產品)"));
            }
            if let Some(e) = value_error(value) {
                return Some(e.into());
            }
        } else {
            if kind == Some(Installer::Msi) {
                return Some("MSI 只接受「屬性=值」".into());
            }
            if let Some(e) = value_error(name) {
                return Some(e.into());
            }
        }
    }
    None
}

/// 參數不可含機密:`(token|password|passwd|pwd|secret|api[_-]?key|key)\s*[=:]`(PIDKEY= / PRODUCTKEY= 也擋)
fn has_secret(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    [
        "token", "password", "passwd", "pwd", "secret", "apikey", "api_key", "api-key", "key",
    ]
    .iter()
    .any(|k| {
        lower.match_indices(k).any(|(i, _)| {
            let after = lower[i + k.len()..].trim_start_matches(' ');
            after.starts_with(['=', ':'])
        })
    })
}

/// 參數錯誤;通過回 None。`kind` 為 None 時套用通用規則(與主機 `argsErrors` 相同)
pub fn args_error(v: &str, kind: Option<Installer>) -> Option<String> {
    if v.is_empty() {
        return None;
    }
    if v.chars().count() > ARGS_MAX {
        return Some(format!("最多 {ARGS_MAX} 字"));
    }
    if !v.bytes().all(allowed) {
        return Some(
            "只允許英數字、空白與 / - _ = . : , \" { } ( ) +(不可含 & | ; < > ^ ` $ \\ @ [ ] % 與換行;路徑請用 /)"
                .into(),
        );
    }
    if names_file(v) {
        return Some(
            "不可指到其他檔案(.msi / .exe / .mst / .dll / 指令檔 / 回應檔 / 設定檔)".into(),
        );
    }
    if let Some(e) = grammar_error(v, kind) {
        return Some(e);
    }
    if has_secret(v) {
        return Some("不可含序號、密碼、金鑰類參數".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/contracts/install-args.vectors.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn kind(v: &Value) -> Option<Installer> {
        v["installer_type"]
            .as_str()
            .map(|t| Installer::parse(t).unwrap())
    }

    /// 契約:ItAgentBack 與 Agent 吃同一份向量(AGENT.md §7.3)
    #[test]
    fn contract_vectors() {
        let v = vectors();
        let mut wrong = Vec::new();
        for c in v["valid"].as_array().unwrap() {
            let args = c["args"].as_str().unwrap();
            if let Some(e) = args_error(args, kind(c)) {
                wrong.push(format!("應通過:{c} → {e}"));
            }
        }
        for c in v["invalid"].as_array().unwrap() {
            let args = c["args"].as_str().unwrap();
            if args_error(args, kind(c)).is_none() {
                wrong.push(format!("應拒絕:{c}"));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn edge_cases() {
        assert!(args_error("", Some(Installer::Msi)).is_none());
        assert!(args_error(&"A".repeat(501), None).is_some());
        assert!(args_error("A=1\nB=2", None).is_some(), "換行");
        assert!(args_error("A=\"x\"y", None).is_some(), "引號只能包住整個值");
        assert!(args_error("A=\"x", None).is_some(), "引號未結束");
        assert!(args_error("X=a.msix", None).is_none(), ".msix 不是 .msi");
        assert!(args_error("PRODUCTKEY = 1", None).is_some(), "機密(含空白)");
        assert!(
            args_error("/LANG=english", Some(Installer::Inno)).is_none(),
            "l 開頭但不是記錄檔開關"
        );
        assert!(args_error("/LV", Some(Installer::Exe)).is_some());
        assert!(
            args_error("--jsonlog", Some(Installer::Exe)).is_some(),
            "j.*"
        );
        assert!(
            args_error("-parentx", Some(Installer::Burn)).is_some(),
            "parent.*"
        );
        assert!(
            args_error("/S /d=C:/Program Files/A b", Some(Installer::Nsis)).is_none(),
            "/d= 不分大小寫"
        );
        assert!(
            args_error("/D=C:/Program Files/a /S", Some(Installer::Nsis)).is_some(),
            "/D= 吃到結尾:值裡夾 /S 會被 NSIS 當成路徑(不靜默),類型標錯時又會被當成開關,一律拒絕(L2)"
        );
        assert!(
            args_error("INSTALLDIR=\"c:/program files/x\"", Some(Installer::Msi)).is_none(),
            "磁碟機路徑不分大小寫"
        );
        assert!(
            args_error("INSTALLDIR=c:/program files/x", Some(Installer::Msi)).is_some(),
            "含空白的值未加引號會拆成兩個參數"
        );
        assert!(is_guid("{12345678-1234-1234-1234-123456789abc}"));
        assert!(!is_guid("{12345678-1234-1234-1234-123456789abcd}"));
    }
}
