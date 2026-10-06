//! TLS 與裝置憑證(ENDPOINT-AGENT-GUIDE §3.4、§6.2):建立**一個** `rustls::ClientConfig`,HTTPS 與 WebSocket 共用。
//!
//! 憑證來源抽成 [`CertSource`](指南 §3.4 明確要求):本階段只有 PEM 檔(臨時 PKI,決策 D7);
//! 正式區改讀 Windows `LocalMachine\My`(rustls-cng,私鑰不可匯出)時另外實作,不影響傳輸層。
//! 加密套件用 ring(MSVC 只需 C 編譯器;不用 aws-lc-rs 以免 Windows 建置需要 CMake / NASM)。

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ClientConfig, RootCertStore};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 裝置憑證來源
pub trait CertSource: Send + Sync {
    /// 回傳(憑證鏈, 私鑰)
    fn load(&self) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String>;
}

/// PEM 檔(開發與測試區:giga-api-gateway-bff/deploy/gen-temp-pki.sh 簽發)
pub struct PemFiles {
    pub cert_file: PathBuf,
    pub key_file: PathBuf,
}

impl CertSource for PemFiles {
    fn load(&self) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
        let chain = CertificateDer::pem_file_iter(&self.cert_file)
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(|e| format!("無法讀取裝置憑證 {}:{e}", self.cert_file.display()))?;
        if chain.is_empty() {
            return Err(format!("裝置憑證檔沒有憑證:{}", self.cert_file.display()));
        }
        let key = PrivateKeyDer::from_pem_file(&self.key_file)
            .map_err(|e| format!("無法讀取裝置私鑰 {}:{e}", self.key_file.display()))?;
        Ok((chain, key))
    }
}

/// 信任 ca_file 的根憑證(企業根 CA / 臨時 PKI),出示裝置憑證
pub fn client_config(ca_file: &Path, source: &dyn CertSource) -> Result<Arc<ClientConfig>, String> {
    let mut roots = RootCertStore::empty();
    let cas = CertificateDer::pem_file_iter(ca_file)
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("無法讀取根憑證 {}:{e}", ca_file.display()))?;
    for ca in cas {
        roots
            .add(ca)
            .map_err(|e| format!("根憑證無效 {}:{e}", ca_file.display()))?;
    }
    if roots.is_empty() {
        return Err(format!("根憑證檔沒有憑證:{}", ca_file.display()));
    }
    let (chain, key) = source.load()?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS 設定錯誤:{e}"))?
        .with_root_certificates(roots)
        .with_client_auth_cert(chain, key)
        .map_err(|e| format!("裝置憑證與私鑰不符或格式不支援:{e}"))?;
    // :9443 只走 HTTP/1.1(WebSocket 以 Upgrade 建立,指南 §4),不送 ALPN
    Ok(Arc::new(config))
}
