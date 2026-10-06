//! 傳輸層:HTTPS 回報(`reqwest`)與 WebSocket(`tokio-tungstenite`)共用同一個 rustls ClientConfig(指南 §6.2)。
//! 失敗分兩類(指南 §4.2):被拒(憑證、身分、停用、契約不符)每 10 分鐘重試;其他(網路、429、5xx)指數退避。

use crate::backoff::{Backoff, CERT_RETRY};
use crate::config::Settings;
use crate::protocol::{AGENT_VERSION, InventoryRequest, InventoryResponse};
use crate::tls::{self, PemFiles};
use rustls::ClientConfig;
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

#[derive(Debug)]
pub enum SendError {
    /// 憑證問題、身分不被接受、裝置停用、內容不符契約(HTTP 400 / 401 / 403、close 4403):不快速重試
    Rejected(String),
    /// 網路中斷、Gateway / Server 暫時不可用(429、5xx):指數退避
    Retry(String),
}

impl SendError {
    /// 下一次重試前的等待
    pub fn wait(&self, backoff: &mut Backoff) -> Duration {
        match self {
            SendError::Rejected(_) => CERT_RETRY,
            SendError::Retry(_) => backoff.next_delay(),
        }
    }
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SendError::Rejected(m) => write!(f, "被拒(10 分鐘後重試):{m}"),
            SendError::Retry(m) => write!(f, "{m}"),
        }
    }
}

/// HTTP 狀態分類;回應內容只取前 300 字(錯誤格式 { code, message, requestId },不含個資)
pub fn classify(status: u16, body: &str) -> SendError {
    let summary = format!(
        "HTTP {status} {}",
        body.chars().take(300).collect::<String>()
    );
    match status {
        400 | 401 | 403 => SendError::Rejected(summary),
        _ => SendError::Retry(summary),
    }
}

pub struct Transport {
    http: reqwest::Client,
    inventory_url: Url,
    ws_url: Url,
    tls: Option<Arc<ClientConfig>>,
    /// dev 模擬 Nginx 的 x-client-cert-* 標頭
    extra_headers: Vec<(&'static str, String)>,
}

impl Transport {
    pub fn new(settings: &Settings) -> Result<Self, String> {
        // reqwest 以 rustls-no-provider 建置:先指定行程預設的加密套件(ring),http 開發模式也需要
        let _ = rustls::crypto::ring::default_provider().install_default();
        let tls = match &settings.tls {
            Some(t) => Some(tls::client_config(
                &t.ca_file,
                &PemFiles {
                    cert_file: t.cert_file.clone(),
                    key_file: t.key_file.clone(),
                },
            )?),
            None => None,
        };
        let mut builder = reqwest::Client::builder()
            .user_agent(format!("giganexus-agent/{AGENT_VERSION}"))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(90));
        if let Some(cfg) = &tls {
            builder = builder.tls_backend_preconfigured(ClientConfig::clone(cfg));
        }
        let http = builder
            .build()
            .map_err(|e| format!("無法建立 HTTP 用戶端:{e}"))?;

        let inventory_url = settings
            .server
            .join("/agent/v1/inventory")
            .map_err(|e| e.to_string())?;
        let mut ws_url = settings
            .server
            .join("/agent/v1/ws")
            .map_err(|e| e.to_string())?;
        let scheme = if settings.server.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        ws_url
            .set_scheme(scheme)
            .map_err(|_| "無法建立 WebSocket 位址".to_string())?;

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
            inventory_url,
            ws_url,
            tls,
            extra_headers,
        })
    }

    pub async fn post_inventory(
        &self,
        req: &InventoryRequest,
    ) -> Result<InventoryResponse, SendError> {
        let mut rb = self.http.post(self.inventory_url.clone()).json(req);
        for (k, v) in &self.extra_headers {
            rb = rb.header(*k, v);
        }
        let res = rb
            .send()
            .await
            .map_err(|e| SendError::Retry(format!("回報連線失敗:{e}")))?;
        let status = res.status();
        if status.is_success() {
            return res
                .json::<InventoryResponse>()
                .await
                .map_err(|e| SendError::Retry(format!("回應格式錯誤:{e}")));
        }
        let body = res.text().await.unwrap_or_default();
        Err(classify(status.as_u16(), &body))
    }

    pub async fn connect_ws(&self) -> Result<WsStream, SendError> {
        let mut request = self
            .ws_url
            .as_str()
            .into_client_request()
            .map_err(|e| SendError::Rejected(format!("WebSocket 位址錯誤:{e}")))?;
        let headers = request.headers_mut();
        let ua = HeaderValue::from_str(&format!("giganexus-agent/{AGENT_VERSION}"))
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
                Err(classify(res.status().as_u16(), &body))
            }
            Err(e) => Err(SendError::Retry(format!("WebSocket 連線失敗:{e}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cert_errors_are_not_retried_quickly() {
        let mut b = Backoff::new();
        assert_eq!(classify(400, "").wait(&mut b), CERT_RETRY);
        assert_eq!(
            classify(403, r#"{"code":"ITA_DEVICE_DISABLED"}"#).wait(&mut b),
            CERT_RETRY
        );
        assert!(classify(503, "").wait(&mut b) <= Duration::from_millis(1200));
        assert!(matches!(classify(502, ""), SendError::Retry(_)));
        assert!(matches!(classify(429, ""), SendError::Retry(_)));
    }
}
