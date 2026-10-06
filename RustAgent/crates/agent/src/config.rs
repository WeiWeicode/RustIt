//! 設定檔 `agent.toml`(INTEGRATION-PLAN M2)。
//!
//! ```toml
//! server_url = "https://10.10.130.124:9443"   # Gateway 以 IP 設定(Gateway PRD Q1);本機開發 http://127.0.0.1:51291
//! inventory_interval_sec = 3600               # 選用,預設 1 小時
//! startup_jitter_sec = 30                     # 選用,啟動隨機延遲上限(指南 §6.3 第 1 步)
//!
//! [tls]                                       # https 必填:本階段只支援 PEM 檔(憑證來源 trait,見 tls.rs)
//! ca_file = "pki/ca.crt"
//! cert_file = "pki/agent.crt"
//! key_file = "pki/agent.key"
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
    pub tls: Option<TlsFiles>,
    pub dev: Option<DevConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TlsFiles {
    pub ca_file: PathBuf,
    pub cert_file: PathBuf,
    pub key_file: PathBuf,
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
    pub tls: Option<TlsFiles>,
    /// dev 模擬 Nginx 的憑證標頭(DN, 指紋)
    pub dev_cert_headers: Option<(String, String)>,
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
        let loopback = matches!(server.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        match server.scheme() {
            "https" if self.tls.is_none() => return Err("server_url 為 https 時必須設定 [tls](ca_file、cert_file、key_file)".into()),
            "https" => {}
            "http" if !loopback => return Err("http 只允許本機開發(127.0.0.1 / localhost);連 Gateway 請用 https://<gateway-ip>:9443".into()),
            "http" => {}
            other => return Err(format!("server_url 只接受 http / https:{other}")),
        }
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
        let tls = self.tls.map(|t| TlsFiles {
            ca_file: base_dir.join(t.ca_file),
            cert_file: base_dir.join(t.cert_file),
            key_file: base_dir.join(t.key_file),
        });
        Ok(Settings {
            server,
            inventory_interval: Duration::from_secs(self.inventory_interval_sec),
            startup_jitter: Duration::from_secs(self.startup_jitter_sec),
            tls,
            dev_cert_headers,
        })
    }
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
    }
}
