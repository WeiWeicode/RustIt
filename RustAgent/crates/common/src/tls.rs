//! TLS 與裝置憑證(ENDPOINT-AGENT-GUIDE §3.4、§6.2):建立**一個** `rustls::ClientConfig`,HTTPS 與 WebSocket 共用。
//!
//! 憑證來源抽成 [`CertSource`](指南 §3.4 明確要求),回傳 rustls 的挑選器,**每次 TLS 握手重新挑選**:
//! - [`PemFiles`]:開發與測試區的 PEM 檔(臨時 PKI,決策 D7)。
//! - [`WindowsStore`]:正式區 `LocalMachine\My`;私鑰留在 CNG 內簽章(rustls-cng),不可匯出也能用;自動續約後不需重啟。
//!
//! 加密套件用 ring(MSVC 只需 C 編譯器;不用 aws-lc-rs 以免 Windows 建置需要 CMake / NASM)。

use crate::config::{ClientCert, TlsSettings};
use rustls::client::ResolvesClientCert;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::sign::CertifiedKey;
use rustls::{ClientConfig, RootCertStore, SignatureScheme};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 裝置憑證來源:提供每次握手使用的挑選器
pub trait CertSource: Send + Sync {
    fn resolver(&self) -> Result<Arc<dyn ResolvesClientCert>, String>;
}

/// PEM 檔(開發與測試區:giga-api-gateway-bff/deploy/gen-temp-pki.sh 簽發)
pub struct PemFiles {
    pub cert_file: PathBuf,
    pub key_file: PathBuf,
}

impl CertSource for PemFiles {
    fn resolver(&self) -> Result<Arc<dyn ResolvesClientCert>, String> {
        let chain = CertificateDer::pem_file_iter(&self.cert_file)
            .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            .map_err(|e| format!("無法讀取裝置憑證 {}:{e}", self.cert_file.display()))?;
        if chain.is_empty() {
            return Err(format!("裝置憑證檔沒有憑證:{}", self.cert_file.display()));
        }
        let key = PrivateKeyDer::from_pem_file(&self.key_file)
            .map_err(|e| format!("無法讀取裝置私鑰 {}:{e}", self.key_file.display()))?;
        let signing_key = rustls::crypto::ring::default_provider()
            .key_provider
            .load_private_key(key)
            .map_err(|e| format!("裝置私鑰格式不支援:{e}"))?;
        let certified = CertifiedKey::new(chain, signing_key);
        certified
            .keys_match()
            .map_err(|e| format!("裝置憑證與私鑰不符:{e}"))?;
        Ok(Arc::new(Fixed(Arc::new(certified))))
    }
}

/// 固定一張憑證(PEM)
#[derive(Debug)]
struct Fixed(Arc<CertifiedKey>);

impl ResolvesClientCert for Fixed {
    fn resolve(&self, _hints: &[&[u8]], _schemes: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }

    fn has_certs(&self) -> bool {
        true
    }
}

/// 依設定建立憑證來源
pub fn cert_source(client: &ClientCert) -> Result<Box<dyn CertSource>, String> {
    match client {
        ClientCert::Pem {
            cert_file,
            key_file,
        } => Ok(Box::new(PemFiles {
            cert_file: cert_file.clone(),
            key_file: key_file.clone(),
        })),
        #[cfg(windows)]
        ClientCert::Store { issuer } => Ok(Box::new(WindowsStore {
            issuer: issuer.clone(),
        })),
        #[cfg(not(windows))]
        ClientCert::Store { .. } => Err("store_issuer(Windows 憑證存放區)只支援 Windows".into()),
    }
}

/// 信任 ca_file 的根憑證(企業根 CA / 臨時 PKI),依設定出示裝置憑證
pub fn client_config(tls: &TlsSettings) -> Result<Arc<ClientConfig>, String> {
    let resolver = cert_source(&tls.client)?.resolver()?;
    build_config(&tls.ca_file, resolver)
}

fn build_config(
    ca_file: &Path,
    resolver: Arc<dyn ResolvesClientCert>,
) -> Result<Arc<ClientConfig>, String> {
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
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS 設定錯誤:{e}"))?
        .with_root_certificates(roots)
        .with_client_cert_resolver(resolver);
    // :9443 只走 HTTP/1.1(WebSocket 以 Upgrade 建立,指南 §4),不送 ALPN
    Ok(Arc::new(config))
}

/// 從候選憑證(DER)挑出裝置憑證(指南 §3.4):在效期內、EKU 含用戶端驗證,多張時取 `NotAfter` 最晚的一張。
/// 簽發者已由呼叫端篩選;無法解析的憑證略過。回傳索引。
pub fn pick_device_cert<D: AsRef<[u8]>>(candidates: &[D], now_unix: i64) -> Option<usize> {
    candidates
        .iter()
        .enumerate()
        .filter_map(|(i, der)| {
            let (_, cert) = x509_parser::parse_x509_certificate(der.as_ref()).ok()?;
            let validity = cert.validity();
            let in_period = validity.not_before.timestamp() <= now_unix
                && now_unix <= validity.not_after.timestamp();
            let client_auth = cert
                .extended_key_usage()
                .ok()
                .flatten()
                .is_some_and(|eku| eku.value.client_auth);
            (in_period && client_auth).then(|| (i, validity.not_after.timestamp()))
        })
        .max_by_key(|(_, not_after)| *not_after)
        .map(|(i, _)| i)
}

/// Windows `LocalMachine\My` 的裝置憑證(正式區;需以 LocalSystem 執行才能使用私鑰,指南 §6.1)
#[cfg(windows)]
pub struct WindowsStore {
    /// 簽發者名稱含此字串(Agent 專用中繼 CA)
    pub issuer: String,
}

#[cfg(windows)]
impl CertSource for WindowsStore {
    fn resolver(&self) -> Result<Arc<dyn ResolvesClientCert>, String> {
        use rustls_cng::store::{CertStore, CertStoreType};
        let store = CertStore::open(CertStoreType::LocalMachine, "My")
            .map_err(|e| format!("無法開啟憑證存放區 LocalMachine\\My:{e}"))?;
        let resolver = StoreResolver {
            store,
            issuer: self.issuer.clone(),
        };
        // 啟動時先挑一次只為了記錄;找不到不擋啟動:握手時不出示憑證 → Gateway 拒絕 → 每 10 分鐘重試(指南 §4.2)
        match resolver.pick() {
            Ok(k) => log::info!(
                "裝置憑證來源:LocalMachine\\My,簽發者含「{}」,共 {} 張憑證鏈",
                self.issuer,
                k.cert.len()
            ),
            Err(e) => log::warn!("{e}"),
        }
        Ok(Arc::new(resolver))
    }
}

#[cfg(windows)]
struct StoreResolver {
    store: rustls_cng::store::CertStore,
    issuer: String,
}

#[cfg(windows)]
impl std::fmt::Debug for StoreResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreResolver")
            .field("issuer", &self.issuer)
            .finish()
    }
}

#[cfg(windows)]
impl StoreResolver {
    fn pick(&self) -> Result<CertifiedKey, String> {
        use rustls_cng::signer::CngSigningKey;
        let contexts = self
            .store
            .find_by_issuer_str(&self.issuer)
            .map_err(|e| format!("查詢 LocalMachine\\My 失敗:{e}"))?;
        let ders: Vec<&[u8]> = contexts.iter().map(|c| c.as_der()).collect();
        let now = chrono::Utc::now().timestamp();
        let i = pick_device_cert(&ders, now).ok_or_else(|| {
            format!(
                "LocalMachine\\My 沒有可用的裝置憑證(簽發者含「{}」、在效期內、EKU 含用戶端驗證)",
                self.issuer
            )
        })?;
        let ctx = &contexts[i];
        // silent:服務沒有桌面,不可跳出任何提示
        let key = ctx
            .acquire_key(true)
            .map_err(|e| format!("無法取用裝置憑證私鑰(需以 LocalSystem 執行):{e}"))?;
        let signing_key = CngSigningKey::new(key).map_err(|e| format!("裝置憑證私鑰不支援:{e}"))?;
        // 憑證鏈(不含根);中繼 CA 不在本機存放區時只送葉憑證,由 Gateway 的 Agent CA 鏈補足
        let chain: Vec<CertificateDer<'static>> = match ctx.as_chain_der() {
            Ok(c) if !c.is_empty() => c.into_iter().map(CertificateDer::from).collect(),
            _ => vec![CertificateDer::from(ctx.as_der().to_vec())],
        };
        Ok(CertifiedKey::new(chain, Arc::new(signing_key)))
    }
}

#[cfg(windows)]
impl ResolvesClientCert for StoreResolver {
    fn resolve(&self, _hints: &[&[u8]], schemes: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        let key = match self.pick() {
            Ok(k) => k,
            Err(e) => {
                log::warn!("{e}");
                return None;
            }
        };
        if key.key.choose_scheme(schemes).is_none() {
            log::warn!("裝置憑證的金鑰演算法不在 Gateway 接受的簽章方式內");
            return None;
        }
        Some(Arc::new(key))
    }

    fn has_certs(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{CertificateParams, ExtendedKeyUsagePurpose, KeyPair, date_time_ymd};

    fn cert(
        not_before: (i32, u8, u8),
        not_after: (i32, u8, u8),
        eku: &[ExtendedKeyUsagePurpose],
    ) -> Vec<u8> {
        let mut p = CertificateParams::new(vec!["pc-example-01.example.test".into()]).unwrap();
        p.not_before = date_time_ymd(not_before.0, not_before.1, not_before.2);
        p.not_after = date_time_ymd(not_after.0, not_after.1, not_after.2);
        p.extended_key_usages = eku.to_vec();
        p.self_signed(&KeyPair::generate().unwrap())
            .unwrap()
            .der()
            .to_vec()
    }

    fn ts(y: i32, m: u8, d: u8) -> i64 {
        date_time_ymd(y, m, d).unix_timestamp()
    }

    /// 在效期內、EKU 含用戶端驗證的憑證中取 NotAfter 最晚的;其餘略過
    #[test]
    fn picks_latest_valid_client_cert() {
        use ExtendedKeyUsagePurpose::{ClientAuth, ServerAuth};
        let candidates = vec![
            cert((2026, 1, 1), (2027, 1, 1), &[ClientAuth]), // 0 有效
            cert((2026, 6, 1), (2027, 6, 1), &[ClientAuth, ServerAuth]), // 1 有效、最晚到期
            cert((2026, 1, 1), (2028, 1, 1), &[ServerAuth]), // 2 沒有用戶端驗證
            cert((2025, 1, 1), (2026, 1, 1), &[ClientAuth]), // 3 已過期
            cert((2027, 1, 1), (2029, 1, 1), &[ClientAuth]), // 4 尚未生效
            cert((2026, 1, 1), (2030, 1, 1), &[]),           // 5 沒有 EKU
            b"not a certificate".to_vec(),                   // 6 無法解析
        ];
        assert_eq!(pick_device_cert(&candidates, ts(2026, 10, 13)), Some(1));
        // 續約後:新憑證 NotAfter 較晚 → 改用新的
        let mut renewed = candidates.clone();
        renewed.push(cert((2026, 10, 1), (2027, 10, 1), &[ClientAuth]));
        assert_eq!(pick_device_cert(&renewed, ts(2026, 10, 13)), Some(7));
        assert_eq!(pick_device_cert(&candidates[2..], ts(2026, 10, 13)), None);
        assert_eq!(pick_device_cert::<Vec<u8>>(&[], 0), None);
    }
}
