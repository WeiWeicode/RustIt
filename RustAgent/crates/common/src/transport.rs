//! 傳輸層:HTTPS 回報(`reqwest`)與 WebSocket(`tokio-tungstenite`)共用同一個 rustls ClientConfig(指南 §6.2)。
//! 失敗分三類(指南 §4.2、PLATFORM-PLAN A3):被拒(憑證、身分、停用、契約不符)每 10 分鐘重試;
//! 主機忙碌(429)照 Retry-After 等待再加 0–30% 隨機,不計入指數退避;其他(網路、5xx)指數退避。

use crate::backoff::{Backoff, CERT_RETRY};
use crate::config::Settings;
use crate::tls;
use rustls::ClientConfig;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream, tungstenite};
use url::Url;

pub type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// 單則 WebSocket 訊息上限 1 MB(指南 §5.5)
const WS_MAX_MESSAGE: usize = 1024 * 1024;
/// 429 沒帶 Retry-After 時的等待
const DEFAULT_BUSY: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum SendError {
    /// 憑證問題、身分不被接受、裝置停用、內容不符契約(HTTP 400 / 401 / 403、close 4403):不快速重試
    Rejected(String),
    /// 網路中斷、Gateway / Server 暫時不可用(5xx):指數退避
    Retry(String),
    /// 主機忙碌(HTTP 429):等 Retry-After(秒)再加 0–30% 隨機,不計入指數退避(A3)
    Busy(Duration, String),
}

impl SendError {
    /// 下一次重試前的等待
    pub fn wait(&self, backoff: &mut Backoff) -> Duration {
        match self {
            SendError::Rejected(_) => CERT_RETRY,
            SendError::Retry(_) => backoff.next_delay(),
            SendError::Busy(after, _) => after.mul_f64(1.0 + fastrand::f64() * 0.3),
        }
    }

    /// 離線原因分類(event.schema.json OfflinePeriod.reason)
    pub fn reason(&self) -> &'static str {
        match self {
            SendError::Rejected(_) => "rejected",
            SendError::Busy(..) => "server_busy",
            SendError::Retry(m) => {
                let lower = m.to_lowercase();
                if m.starts_with("HTTP 5") {
                    "server_error"
                } else if lower.contains("dns") || lower.contains("resolve") {
                    "dns"
                } else if ["certificate", "tls", "handshake", "invalidcert"]
                    .iter()
                    .any(|k| lower.contains(k))
                {
                    "tls"
                } else {
                    "network"
                }
            }
        }
    }

    /// 裝置被主機停用(HTTP 403 ITA_DEVICE_DISABLED / ITA_DEVICE_RETIRED、WebSocket close 4403)
    pub fn is_device_disabled(&self) -> bool {
        matches!(self, SendError::Rejected(m) if m.contains("ITA_DEVICE_DISABLED") || m.contains("ITA_DEVICE_RETIRED") || m.contains("close 4403"))
    }

    /// 主機收到但內容不符契約(HTTP 400):連線正常,問題在這筆資料
    pub fn is_bad_request(&self) -> bool {
        matches!(self, SendError::Rejected(m) if m.starts_with("HTTP 400"))
    }

    /// 是否算「連不上主機」(記入離線期間):429 忙碌、400 內容錯誤、裝置被停用 / 退役時主機有回應,不算
    pub fn counts_as_offline(&self) -> bool {
        !matches!(self, SendError::Busy(..)) && !self.is_bad_request() && !self.is_device_disabled()
    }
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SendError::Rejected(m) => write!(f, "被拒(10 分鐘後重試):{m}"),
            SendError::Retry(m) => write!(f, "{m}"),
            SendError::Busy(after, m) => write!(f, "主機忙碌(約 {} 秒後重試):{m}", after.as_secs()),
        }
    }
}

/// HTTP 狀態分類;回應內容只取前 300 字(錯誤格式 { code, message, requestId },不含個資)
pub fn classify(status: u16, body: &str, retry_after: Option<&str>) -> SendError {
    let summary = format!(
        "HTTP {status} {}",
        body.chars().take(300).collect::<String>()
    );
    match status {
        400 | 401 | 403 => SendError::Rejected(summary),
        429 => {
            let after = retry_after
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(|s| Duration::from_secs(s.clamp(1, 3600)))
                .unwrap_or(DEFAULT_BUSY);
            SendError::Busy(after, summary)
        }
        _ => SendError::Retry(summary),
    }
}

pub struct Transport {
    http: reqwest::Client,
    server: Url,
    user_agent: String,
    tls: Option<Arc<ClientConfig>>,
    /// dev 模擬 Nginx 的 x-client-cert-* 標頭
    extra_headers: Vec<(&'static str, String)>,
}

impl Transport {
    /// `user_agent` 例:`giganexus-agent/0.1.0`(指南 §5.6)
    pub fn new(settings: &Settings, user_agent: &str) -> Result<Self, String> {
        // reqwest 以 rustls-no-provider 建置:先指定行程預設的加密套件(ring),http 開發模式也需要
        let _ = rustls::crypto::ring::default_provider().install_default();
        let tls = match &settings.tls {
            Some(t) => Some(tls::client_config(t)?),
            None => None,
        };
        let mut builder = reqwest::Client::builder()
            .user_agent(user_agent)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(90));
        if let Some(cfg) = &tls {
            builder = builder.tls_backend_preconfigured(ClientConfig::clone(cfg));
        }
        let http = builder
            .build()
            .map_err(|e| format!("無法建立 HTTP 用戶端:{e}"))?;

        let extra_headers = match &settings.dev_cert_headers {
            Some((dn, fp)) => vec![
                ("x-client-cert-dn", dn.clone()),
                ("x-client-cert-fp", fp.clone()),
                ("x-client-verify", "SUCCESS".to_string()),
            ],
            None => Vec::new(),
        };
        Ok(Self {
            http,
            server: settings.server.clone(),
            user_agent: user_agent.to_string(),
            tls,
            extra_headers,
        })
    }

    /// `POST <server><path>`(JSON);成功回傳解析後的回應,失敗依 §4.2 分類
    pub async fn post_json<Req: Serialize + ?Sized, Res: DeserializeOwned>(
        &self,
        path: &str,
        body: &Req,
    ) -> Result<Res, SendError> {
        let url = self
            .server
            .join(path)
            .map_err(|e| SendError::Rejected(format!("路徑錯誤 {path}:{e}")))?;
        let mut rb = self.http.post(url).json(body);
        for (k, v) in &self.extra_headers {
            rb = rb.header(*k, v);
        }
        let res = rb
            .send()
            .await
            .map_err(|e| SendError::Retry(format!("回報連線失敗:{}", error_chain(&e))))?;
        read_json(res).await
    }

    /// `POST <server><path>`,本體為原始位元組(指令附檔,P4-2;`docs/contracts/command-file.schema.json`)
    pub async fn post_bytes<Res: DeserializeOwned>(
        &self,
        path: &str,
        content_type: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<Res, SendError> {
        let url = self
            .server
            .join(path)
            .map_err(|e| SendError::Rejected(format!("路徑錯誤 {path}:{e}")))?;
        let mut rb = self
            .http
            .post(url)
            .header("content-type", content_type)
            // 大檔在慢速網路(VPN、Wi-Fi)以每秒 100 KB 估算,至少 60 秒
            .timeout(Duration::from_secs((body.len() as u64 / 100_000).max(60)))
            .body(body);
        for (k, v) in self
            .extra_headers
            .iter()
            .map(|(k, v)| (*k, v))
            .chain(headers.iter().map(|(k, v)| (*k, v)))
        {
            rb = rb.header(k, v);
        }
        let res = rb
            .send()
            .await
            .map_err(|e| SendError::Retry(format!("上傳連線失敗:{}", error_chain(&e))))?;
        read_json(res).await
    }

    /// `GET <server><path>`,只回傳 HTTP 狀態(遠端診斷 agent.diagnose 的 Gateway 檢查)
    pub async fn get_status(&self, path: &str) -> Result<u16, SendError> {
        let url = self
            .server
            .join(path)
            .map_err(|e| SendError::Rejected(format!("路徑錯誤 {path}:{e}")))?;
        let mut rb = self.http.get(url);
        for (k, v) in &self.extra_headers {
            rb = rb.header(*k, v);
        }
        let res = rb
            .send()
            .await
            .map_err(|e| SendError::Retry(format!("連線失敗:{}", error_chain(&e))))?;
        Ok(res.status().as_u16())
    }

    /// WebSocket 位址:`<server><path>`,https → wss、http → ws
    fn ws_url(&self, path: &str) -> Result<Url, SendError> {
        let mut url = self
            .server
            .join(path)
            .map_err(|e| SendError::Rejected(format!("路徑錯誤 {path}:{e}")))?;
        let scheme = if self.server.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        url.set_scheme(scheme)
            .map_err(|_| SendError::Rejected("無法建立 WebSocket 位址".into()))?;
        Ok(url)
    }

    pub async fn connect_ws(&self, path: &str) -> Result<WsStream, SendError> {
        let mut request = self
            .ws_url(path)?
            .as_str()
            .into_client_request()
            .map_err(|e| SendError::Rejected(format!("WebSocket 位址錯誤:{e}")))?;
        let headers = request.headers_mut();
        let ua = HeaderValue::from_str(&self.user_agent)
            .map_err(|e| SendError::Rejected(e.to_string()))?;
        headers.insert("user-agent", ua);
        for (k, v) in &self.extra_headers {
            let value = HeaderValue::from_str(v)
                .map_err(|e| SendError::Rejected(format!("{k} 無效:{e}")))?;
            headers.insert(*k, value);
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(WS_MAX_MESSAGE))
            .max_frame_size(Some(WS_MAX_MESSAGE));
        let connector = self.tls.as_ref().map(|c| Connector::Rustls(c.clone()));
        match tokio_tungstenite::connect_async_tls_with_config(
            request,
            Some(config),
            false,
            connector,
        )
        .await
        {
            Ok((ws, _)) => Ok(ws),
            Err(tungstenite::Error::Http(res)) => {
                let body = res
                    .body()
                    .as_ref()
                    .map(|b| String::from_utf8_lossy(b).into_owned())
                    .unwrap_or_default();
                let retry_after = res
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok());
                Err(classify(res.status().as_u16(), &body, retry_after))
            }
            Err(e) => Err(SendError::Retry(format!("WebSocket 連線失敗:{e}"))),
        }
    }
}

/// 成功回傳解析後的 JSON,失敗依 §4.2 分類
async fn read_json<Res: DeserializeOwned>(res: reqwest::Response) -> Result<Res, SendError> {
    let status = res.status();
    if status.is_success() {
        return res
            .json::<Res>()
            .await
            .map_err(|e| SendError::Retry(format!("回應格式錯誤:{e}")));
    }
    let retry_after = res
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = res.text().await.unwrap_or_default();
    Err(classify(status.as_u16(), &body, retry_after.as_deref()))
}

/// 錯誤連同底層原因(例 reqwest 的「error sending request」之下的 DNS / 連線 / TLS 錯誤),供日誌與離線原因分類
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let part = s.to_string();
        if !text.contains(&part) {
            text.push(':');
            text.push_str(&part);
        }
        source = s.source();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cert_errors_are_not_retried_quickly() {
        let mut b = Backoff::new();
        assert_eq!(classify(400, "", None).wait(&mut b), CERT_RETRY);
        assert_eq!(
            classify(403, r#"{"code":"ITA_DEVICE_DISABLED"}"#, None).wait(&mut b),
            CERT_RETRY
        );
        assert!(classify(503, "", None).wait(&mut b) <= Duration::from_millis(1200));
        assert!(matches!(classify(502, "", None), SendError::Retry(_)));
    }

    /// 429 照 Retry-After 等待(加 0–30% 隨機),不推進指數退避(A3)
    #[test]
    fn busy_waits_retry_after_without_backoff() {
        let mut b = Backoff::new();
        let e = classify(429, r#"{"code":"ITA_BUSY"}"#, Some("45"));
        for _ in 0..20 {
            let d = e.wait(&mut b);
            assert!(
                d >= Duration::from_secs(45) && d <= Duration::from_millis(58_500),
                "{d:?}"
            );
        }
        assert!(
            b.next_delay() <= Duration::from_millis(1200),
            "429 不計入退避"
        );
        assert!(matches!(classify(429, "", None), SendError::Busy(d, _) if d == DEFAULT_BUSY));
        assert!(
            matches!(classify(429, "", Some("abc")), SendError::Busy(d, _) if d == DEFAULT_BUSY)
        );
    }

    #[test]
    fn offline_reasons() {
        assert_eq!(classify(403, "", None).reason(), "rejected");
        assert_eq!(classify(429, "", None).reason(), "server_busy");
        assert_eq!(classify(503, "", None).reason(), "server_error");
        let r = |m: &str| SendError::Retry(m.into()).reason();
        assert_eq!(
            r("回報連線失敗:error sending request:client error (Connect):dns error:No such host"),
            "dns"
        );
        assert_eq!(
            r("WebSocket 連線失敗:TLS error:invalid peer certificate: UnknownIssuer"),
            "tls"
        );
        assert_eq!(
            r("WebSocket 連線失敗:IO error: (os error 10060)"),
            "network"
        );
        assert!(classify(403, r#"{"code":"ITA_DEVICE_DISABLED"}"#, None).is_device_disabled());
        assert!(!classify(403, r#"{"code":"DEVICE_UNAUTHORIZED"}"#, None).is_device_disabled());
        assert!(SendError::Rejected("裝置已被 IT 停用(close 4403)".into()).is_device_disabled());
        // 主機有回應的錯誤不算離線;其他 403(憑證、身分)與網路錯誤算
        assert!(!classify(403, r#"{"code":"ITA_DEVICE_DISABLED"}"#, None).counts_as_offline());
        assert!(!classify(403, r#"{"code":"ITA_DEVICE_RETIRED"}"#, None).counts_as_offline());
        assert!(!SendError::Rejected("裝置已被 IT 停用(close 4403)".into()).counts_as_offline());
        assert!(!classify(400, "", None).counts_as_offline());
        assert!(!classify(429, "", None).counts_as_offline());
        assert!(classify(403, r#"{"code":"DEVICE_UNAUTHORIZED"}"#, None).counts_as_offline());
        assert!(SendError::Retry("IO error: (os error 10060)".into()).counts_as_offline());
        assert!(
            !classify(401, r#"{"requestId":"a4403b"}"#, None).is_device_disabled(),
            "requestId 含 4403 不算"
        );
        assert!(
            classify(400, "", None).is_bad_request()
                && !classify(400, "", None).counts_as_offline()
        );
        assert!(!classify(429, "", None).counts_as_offline());
        assert!(
            classify(403, "", None).counts_as_offline()
                && classify(503, "", None).counts_as_offline()
        );
    }
}
