//! 設定檔 `agent.toml`(INTEGRATION-PLAN M2)。
//!
//! ```toml
//! server_url = "https://10.10.130.124:9443"   # Gateway 以 IP 設定(Gateway PRD Q1);本機開發 http://127.0.0.1:51291
//! inventory_interval_sec = 3600               # 選用,預設 1 小時
//! startup_jitter_sec = 30                     # 選用,啟動隨機延遲上限(指南 §6.3 第 1 步)
//! log_level = "info"                          # 選用,服務模式的檔案日誌等級(error / warn / info / debug / trace);前景執行用 RUST_LOG
//!
//! [tls]                                       # https 必填;裝置憑證二選一(憑證來源見 tls.rs)
//! ca_file = "pki/ca.crt"
//! cert_file = "pki/agent.crt"                 # (一)PEM 檔:開發與測試區
//! key_file = "pki/agent.key"
//! # store_issuer = "GigaNexus Agent CA"       # (二)Windows LocalMachine\My:簽發者名稱含此字串,每次握手重新挑選(指南 §3.4)
//!
//! [upgrade]                                   # 選用(P6-2):升級檔簽章者 SHA-1 指紋的本機信任清單,MSI 寫入;沒有設定 = 不接受任何升級檔
//! trusted_signers = ["a1b2…"]                 # 必須同時在主機下發的 signer_thumbprints 內(P6-UPGRADE-DESIGN §9-2)
//!
//! [software]                                  # 選用(P7-3):軟體派送安裝檔簽章者的本機信任清單,與升級分開(廠商憑證不可用來升級 Agent,資安 M3);
//! trusted_signers = ["c3d4…"]                 # 沒有設定 = 不接受任何派送的套件(含 draft)
//!
//! [dev]                                       # 只允許 http://127.0.0.1 / localhost:直連 ItAgentBack(DEV_TRUST_CLIENT_HEADERS)
//! simulate_client_cert = true                 # 自行帶 x-client-cert-* 標頭,模擬 Nginx
//! client_cert_dn = "O=GigaNexus Dev,CN=PC-001" # 選用,預設 O=GigaNexus Dev,CN=<電腦名稱>
//! ```
//! 相對路徑以設定檔所在目錄為準。設定錯誤時啟動失敗,不套預設值繞過。

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::Url;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    pub server_url: String,
    #[serde(default = "default_inventory_interval")]
    pub inventory_interval_sec: u64,
    #[serde(default = "default_startup_jitter")]
    pub startup_jitter_sec: u64,
    pub log_level: Option<String>,
    pub tls: Option<TlsConfig>,
    pub upgrade: Option<UpgradeConfig>,
    pub software: Option<SoftwareConfig>,
    pub dev: Option<DevConfig>,
}

/// `[software]`(P7-3):軟體派送安裝檔簽章者的本機信任清單(與 `[upgrade]` 分開,資安 M3)
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SoftwareConfig {
    #[serde(default)]
    pub trusted_signers: Vec<String>,
}

/// `[upgrade]`(P6-2):升級檔簽章者的本機信任清單
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpgradeConfig {
    #[serde(default)]
    pub trusted_signers: Vec<String>,
}

/// 本機信任清單上限(與主機 signer_thumbprints 相同)
const MAX_TRUSTED_SIGNERS: usize = 8;

/// `[tls]`:裝置憑證二選一 — PEM 檔(`cert_file` + `key_file`)或 Windows 憑證存放區(`store_issuer`)
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TlsConfig {
    pub ca_file: PathBuf,
    pub cert_file: Option<PathBuf>,
    pub key_file: Option<PathBuf>,
    pub store_issuer: Option<String>,
}

/// 驗證後的 TLS 設定
#[derive(Debug, Clone, PartialEq)]
pub struct TlsSettings {
    /// 信任的根憑證(企業根 CA / 臨時 PKI)
    pub ca_file: PathBuf,
    pub client: ClientCert,
}

/// 裝置憑證來源(指南 §3.4)
#[derive(Debug, Clone, PartialEq)]
pub enum ClientCert {
    /// PEM 檔(開發與測試區)
    Pem {
        cert_file: PathBuf,
        key_file: PathBuf,
    },
    /// `LocalMachine\My` 中簽發者名稱含此字串的憑證;每次握手重新挑選
    Store { issuer: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevConfig {
    #[serde(default)]
    pub simulate_client_cert: bool,
    pub client_cert_dn: Option<String>,
}

fn default_inventory_interval() -> u64 {
    3600
}

fn default_startup_jitter() -> u64 {
    30
}

/// 驗證後的設定
#[derive(Debug, Clone)]
pub struct Settings {
    pub server: Url,
    pub inventory_interval: Duration,
    pub startup_jitter: Duration,
    /// 服務模式的日誌等級;未設定時 info
    pub log_level: Option<log::LevelFilter>,
    pub tls: Option<TlsSettings>,
    /// dev 模擬 Nginx 的憑證標頭(DN, 指紋)
    pub dev_cert_headers: Option<(String, String)>,
    /// 升級檔簽章者 SHA-1 指紋的本機信任清單(小寫;空白 = 不接受任何升級檔)
    pub trusted_signers: Vec<String>,
    /// 軟體派送安裝檔簽章者的本機信任清單(小寫;空白 = 不接受任何派送的套件)
    pub software_signers: Vec<String>,
    /// 本機持久化目錄(store.db、金鑰):設定檔所在目錄下的 `state`(服務模式為 `%ProgramData%\GigaNexus\Agent\state`,PLATFORM-PLAN §4.2)
    pub state_dir: PathBuf,
}

impl AgentConfig {
    pub fn load(path: &Path) -> Result<Settings, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("無法讀取設定檔 {}:{e}", path.display()))?;
        let cfg: AgentConfig =
            toml::from_str(&text).map_err(|e| format!("設定檔 {} 格式錯誤:{e}", path.display()))?;
        cfg.validate(path.parent().unwrap_or(Path::new(".")), &host_name())
    }

    pub fn validate(self, base_dir: &Path, host: &str) -> Result<Settings, String> {
        let server =
            Url::parse(&self.server_url).map_err(|e| format!("server_url 不是合法的 URL:{e}"))?;
        // 帳密與查詢參數會出現在日誌與上傳的錯誤訊息裡(資安稽核 L2)
        if !server.username().is_empty() || server.password().is_some() || server.query().is_some()
        {
            return Err("server_url 不可包含帳密或查詢參數".into());
        }
        let loopback = matches!(server.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        match server.scheme() {
            "https" if self.tls.is_none() => return Err("server_url 為 https 時必須設定 [tls](ca_file,以及 cert_file + key_file 或 store_issuer)".into()),
            "https" => {}
            "http" if !loopback => return Err("http 只允許本機開發(127.0.0.1 / localhost);連 Gateway 請用 https://<gateway-ip>:9443".into()),
            "http" => {}
            other => return Err(format!("server_url 只接受 http / https:{other}")),
        }
        let log_level = match self.log_level.as_deref() {
            None => None,
            Some(v) => Some(
                v.parse::<log::LevelFilter>()
                    .ok()
                    .filter(|l| *l != log::LevelFilter::Off)
                    .ok_or_else(|| {
                        format!("log_level 只接受 error / warn / info / debug / trace:{v}")
                    })?,
            ),
        };
        if self.inventory_interval_sec < 60 {
            return Err("inventory_interval_sec 不可小於 60".into());
        }
        let dev_cert_headers = match self.dev {
            Some(dev) if dev.simulate_client_cert => {
                if server.scheme() != "http" || !loopback {
                    return Err(
                        "[dev] 只能用在 http://127.0.0.1 / localhost(直連本機 ItAgentBack)".into(),
                    );
                }
                let dn = dev
                    .client_cert_dn
                    .unwrap_or_else(|| format!("O=GigaNexus Dev,CN={host}"));
                Some((dn.clone(), dev_fingerprint(&dn)))
            }
            _ => None,
        };
        let tls = match self.tls {
            None => None,
            Some(t) => {
                let client = match (t.cert_file, t.key_file, t.store_issuer) {
                    (Some(cert), Some(key), None) => ClientCert::Pem {
                        cert_file: base_dir.join(cert),
                        key_file: base_dir.join(key),
                    },
                    (None, None, Some(issuer)) if !issuer.trim().is_empty() => ClientCert::Store {
                        issuer: issuer.trim().to_string(),
                    },
                    _ => {
                        return Err("[tls] 裝置憑證二選一:cert_file + key_file(PEM 檔),或 store_issuer(Windows 憑證存放區的簽發者名稱)".into());
                    }
                };
                Some(TlsSettings {
                    ca_file: base_dir.join(t.ca_file),
                    client,
                })
            }
        };
        let trusted_signers = signer_list(
            "upgrade",
            self.upgrade.map(|u| u.trusted_signers).unwrap_or_default(),
        )?;
        let software_signers = signer_list(
            "software",
            self.software.map(|s| s.trusted_signers).unwrap_or_default(),
        )?;
        Ok(Settings {
            server,
            inventory_interval: Duration::from_secs(self.inventory_interval_sec),
            startup_jitter: Duration::from_secs(self.startup_jitter_sec),
            log_level,
            tls,
            dev_cert_headers,
            trusted_signers,
            software_signers,
            state_dir: base_dir.join("state"),
        })
    }
}

/// 簽章者清單:SHA-1 指紋(40 個十六進位字元)轉小寫、去重,最多 [`MAX_TRUSTED_SIGNERS`] 個;格式不符拒絕
fn signer_list(section: &str, list: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for t in list {
        let t = t.trim().to_ascii_lowercase();
        if t.len() != 40 || !t.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!(
                "[{section}] trusted_signers 必須是 40 個十六進位字元的 SHA-1 指紋:{t}"
            ));
        }
        if !out.contains(&t) {
            out.push(t);
        }
    }
    if out.len() > MAX_TRUSTED_SIGNERS {
        return Err(format!(
            "[{section}] trusted_signers 最多 {MAX_TRUSTED_SIGNERS} 個"
        ));
    }
    Ok(out)
}

/// dev 用的假指紋:DN 的 SHA-256 取前 40 個十六進位字元(格式同 Nginx 的 SHA-1 指紋);同一個 DN 固定不變
pub fn dev_fingerprint(dn: &str) -> String {
    hex::encode(Sha256::digest(dn.as_bytes()))[..40].to_string()
}

pub fn host_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "UNKNOWN".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Settings, String> {
        toml::from_str::<AgentConfig>(text)
            .map_err(|e| e.to_string())?
            .validate(Path::new("C:/agent"), "PC-TEST")
    }

    /// 本機開發:模擬 Nginx 的憑證標頭
    #[test]
    fn dev_simulates_client_cert_headers() {
        let s =
            parse("server_url = \"http://127.0.0.1:51291\"\n[dev]\nsimulate_client_cert = true\n")
                .unwrap();
        let (dn, fp) = s.dev_cert_headers.unwrap();
        assert_eq!(dn, "O=GigaNexus Dev,CN=PC-TEST");
        assert_eq!(fp.len(), 40);
        assert_eq!(fp, dev_fingerprint("O=GigaNexus Dev,CN=PC-TEST"));
        assert_eq!(s.inventory_interval, Duration::from_secs(3600));
        assert_eq!(s.startup_jitter, Duration::from_secs(30));
    }

    /// https 必須有 [tls],相對路徑以設定檔目錄為準
    #[test]
    fn https_requires_tls_relative_to_config_dir() {
        assert!(
            parse("server_url = \"https://10.10.130.124:9443\"")
                .unwrap_err()
                .contains("[tls]")
        );
        let s = parse("server_url = \"https://10.10.130.124:9443\"\n[tls]\nca_file = \"pki/ca.crt\"\ncert_file = \"a.crt\"\nkey_file = \"a.key\"\n").unwrap();
        assert_eq!(
            s.tls.unwrap().ca_file,
            Path::new("C:/agent").join("pki/ca.crt")
        );
        assert!(s.dev_cert_headers.is_none());
    }

    /// 裝置憑證二選一:PEM 檔或憑證存放區;兩者都有、都沒有、只有一半都拒絕
    #[test]
    fn client_cert_is_pem_or_store() {
        let https = "server_url = \"https://10.10.130.124:9443\"\n[tls]\nca_file = \"ca.crt\"\n";
        let s = parse(&format!("{https}store_issuer = \" GigaNexus Agent CA \"\n")).unwrap();
        assert_eq!(
            s.tls.unwrap().client,
            ClientCert::Store {
                issuer: "GigaNexus Agent CA".into()
            }
        );
        let s = parse(&format!(
            "{https}cert_file = \"a.crt\"\nkey_file = \"a.key\"\n"
        ))
        .unwrap();
        assert_eq!(
            s.tls.unwrap().client,
            ClientCert::Pem {
                cert_file: Path::new("C:/agent").join("a.crt"),
                key_file: Path::new("C:/agent").join("a.key")
            }
        );
        for bad in [
            "",
            "cert_file = \"a.crt\"\n",
            "store_issuer = \"  \"\n",
            "cert_file = \"a.crt\"\nkey_file = \"a.key\"\nstore_issuer = \"X\"\n",
        ] {
            assert!(
                parse(&format!("{https}{bad}"))
                    .unwrap_err()
                    .contains("二選一"),
                "{bad:?}"
            );
        }
    }

    /// 拒絕不安全或錯誤的設定
    #[test]
    fn rejects_unsafe_or_invalid_settings() {
        assert!(
            parse("server_url = \"http://10.10.130.124:9443\"")
                .unwrap_err()
                .contains("本機開發")
        );
        let dev_on_https = "server_url = \"https://10.10.130.124:9443\"\n[tls]\nca_file = \"c\"\ncert_file = \"a\"\nkey_file = \"k\"\n[dev]\nsimulate_client_cert = true\n";
        assert!(parse(dev_on_https).unwrap_err().contains("[dev]"));
        assert!(parse("server_url = \"http://127.0.0.1:1\"\ninventory_interval_sec = 5").is_err());
        assert!(parse("server_url = \"http://127.0.0.1:1\"\nunknown_key = 1").is_err());
        assert!(parse("server_url = \"http://127.0.0.1:1\"\nlog_level = \"off\"").is_err());
        assert!(parse("server_url = \"http://127.0.0.1:1\"\nlog_level = \"verbose\"").is_err());
    }

    /// [software] 與 [upgrade] 分開(資安 M3)
    #[test]
    fn software_signers_are_separate() {
        let a = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
        let b = "c3d4e5f60718293a4b5c6d7e8f9012345678a1b2";
        let s = parse(&format!(
            "server_url = \"http://127.0.0.1:1\"\n[upgrade]\ntrusted_signers = [\"{a}\"]\n[software]\ntrusted_signers = [\"{}\"]\n",
            b.to_uppercase()
        ))
        .unwrap();
        assert_eq!(
            (s.trusted_signers, s.software_signers),
            (vec![a.to_string()], vec![b.to_string()])
        );
        let s = parse("server_url = \"http://127.0.0.1:1\"\n").unwrap();
        assert!(s.software_signers.is_empty(), "沒有設定 = 不接受任何套件");
        assert!(
            parse("server_url = \"http://127.0.0.1:1\"\n[software]\ntrusted_signers = [\"xyz\"]\n")
                .unwrap_err()
                .contains("[software]")
        );
    }

    /// [upgrade] trusted_signers:轉小寫、去重;格式不符拒絕
    #[test]
    fn trusted_signers_are_validated() {
        let base = "server_url = \"http://127.0.0.1:1\"
";
        assert!(parse(base).unwrap().trusted_signers.is_empty());
        let a = "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678";
        let s = parse(&format!(
            "{base}[upgrade]
trusted_signers = [\"{a}\", \" {} \"]
",
            a.to_lowercase()
        ))
        .unwrap();
        assert_eq!(s.trusted_signers, [a.to_lowercase()]);
        for bad in ["\"abc\"", "\"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\""] {
            assert!(
                parse(&format!(
                    "{base}[upgrade]
trusted_signers = [{bad}]
"
                ))
                .unwrap_err()
                .contains("trusted_signers"),
                "{bad}"
            );
        }
        assert!(
            parse(&format!(
                "{base}[upgrade]
other = 1
"
            ))
            .is_err()
        );
    }

    /// 服務模式日誌等級:選用,預設不設定(info)
    #[test]
    fn log_level_is_optional() {
        assert_eq!(
            parse("server_url = \"http://127.0.0.1:1\"")
                .unwrap()
                .log_level,
            None
        );
        assert_eq!(
            parse("server_url = \"http://127.0.0.1:1\"\nlog_level = \"debug\"")
                .unwrap()
                .log_level,
            Some(log::LevelFilter::Debug)
        );
    }
}
