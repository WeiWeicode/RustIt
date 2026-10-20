//! 本機具名管道 `\\.\pipe\giganexus-agent-v1`(ENDPOINT-AGENT-GUIDE §7.2;契約 `docs/contracts/pipe.schema.json`)。
//!
//! - 伺服端是 Agent,ACL 只允許 SYSTEM、Administrators;用戶端是 Watchdog
//! - 每條連線一則請求、一則回應(各一行 JSON,`\n` 結尾,單則上限 [`MAX_LINE`]),之後由伺服端關閉
//! - 用戶端以 `GetNamedPipeServerProcessId` 取得伺服端 PID,與 SCM 的 Agent PID 比對(防冒充,由呼叫端比對)

use crate::envelope::Envelope;
use std::os::windows::io::AsRawHandle;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};

pub const PIPE_NAME: &str = r"\\.\pipe\giganexus-agent-v1";
/// 只允許 SYSTEM 與 Administrators(指南 §7.2);P:不繼承
const PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)";
/// 單則訊息上限
pub const MAX_LINE: usize = 4096;
const ERROR_PIPE_BUSY: i32 = 231;

/// 以 SDDL 建立的安全性屬性;Drop 時釋放
struct SecurityAttributes {
    sa: SECURITY_ATTRIBUTES,
    sd: PSECURITY_DESCRIPTOR,
}

impl SecurityAttributes {
    fn new() -> Result<Self, String> {
        let sddl: Vec<u16> = PIPE_SDDL.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY:SDDL 以 NUL 結尾;sd 由 LocalFree 釋放(Drop)
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "管道 ACL 格式錯誤:{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self {
            sa: SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd,
                bInheritHandle: 0,
            },
            sd,
        })
    }
}

impl Drop for SecurityAttributes {
    fn drop(&mut self) {
        // SAFETY:sd 由 ConvertStringSecurityDescriptorToSecurityDescriptorW 配置
        unsafe { LocalFree(self.sd as _) };
    }
}

/// 建立一個管道執行個體;`first` 為 true 時要求必須是第一個(別的行程先建立同名管道就失敗,防冒充)
pub fn create_server(first: bool) -> Result<NamedPipeServer, String> {
    let mut attrs = SecurityAttributes::new()?;
    let mut opts = ServerOptions::new();
    opts.first_pipe_instance(first).reject_remote_clients(true);
    // SAFETY:attrs 活到 create 回傳之後(系統在建立時複製安全性描述元)
    unsafe {
        opts.create_with_security_attributes_raw(PIPE_NAME, &mut attrs.sa as *mut _ as *mut _)
    }
    .map_err(|e| format!("無法建立本機管道 {PIPE_NAME}:{e}"))
}

/// 伺服端:連線用戶端的 PID(P6-2 prepare_shutdown 只接受 Watchdog 服務)
pub fn client_pid(server: &NamedPipeServer) -> Result<u32, String> {
    let mut pid = 0u32;
    // SAFETY:server 的控制代碼在此期間有效
    if unsafe { GetNamedPipeClientProcessId(server.as_raw_handle() as _, &mut pid) } == 0 {
        return Err(format!(
            "無法取得管道用戶端 PID:{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(pid)
}

/// 讀一行(上限 MAX_LINE),不含換行
pub async fn read_line<R: AsyncRead + Unpin>(r: R) -> Result<String, String> {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        let chunk = reader
            .fill_buf()
            .await
            .map_err(|e| format!("讀取管道失敗:{e}"))?;
        if chunk.is_empty() {
            break;
        }
        if let Some(i) = chunk.iter().position(|b| *b == b'\n') {
            buf.extend_from_slice(&chunk[..i]);
            break;
        }
        let n = chunk.len();
        buf.extend_from_slice(chunk);
        reader.consume(n);
        if buf.len() > MAX_LINE {
            return Err("管道訊息超過上限".into());
        }
    }
    if buf.len() > MAX_LINE {
        return Err("管道訊息超過上限".into());
    }
    String::from_utf8(buf).map_err(|_| "管道訊息不是 UTF-8".into())
}

pub async fn write_line<W: AsyncWrite + Unpin>(w: &mut W, env: &Envelope) -> Result<(), String> {
    let mut text = serde_json::to_string(env).map_err(|e| e.to_string())?;
    text.push('\n');
    w.write_all(text.as_bytes())
        .await
        .map_err(|e| format!("寫入管道失敗:{e}"))?;
    w.flush().await.map_err(|e| format!("寫入管道失敗:{e}"))
}

/// 用戶端錯誤
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipeError {
    /// 管道伺服端不是預期的行程(冒充;指南 §7.2「不一致即中斷並記錄」)
    Impersonation {
        server_pid: u32,
        expected_pid: u32,
    },
    Other(String),
}

impl std::fmt::Display for PipeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Impersonation {
                server_pid,
                expected_pid,
            } => {
                write!(
                    f,
                    "本機管道伺服端 PID {server_pid} 不是 Agent 服務({expected_pid}),已中斷"
                )
            }
            Self::Other(e) => f.write_str(e),
        }
    }
}

/// 用戶端:確認伺服端 PID 是 `expected_pid` 後才送出請求(不符立即中斷,不寫入任何資料),等一則回應。管道忙碌時短暫重試
pub async fn request(
    req: &Envelope,
    expected_pid: u32,
    timeout: Duration,
) -> Result<Envelope, PipeError> {
    let work = async {
        let mut tries = 0;
        let mut client = loop {
            match ClientOptions::new().open(PIPE_NAME) {
                Ok(c) => break c,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tries < 10 => {
                    tries += 1;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) => return Err(PipeError::Other(format!("無法連線本機管道:{e}"))),
            }
        };
        let mut pid = 0u32;
        // SAFETY:client 的控制代碼在此期間有效
        if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle() as _, &mut pid) } == 0 {
            return Err(PipeError::Other(format!(
                "無法取得管道伺服端 PID:{}",
                std::io::Error::last_os_error()
            )));
        }
        if pid != expected_pid {
            return Err(PipeError::Impersonation {
                server_pid: pid,
                expected_pid,
            });
        }
        write_line(&mut client, req)
            .await
            .map_err(PipeError::Other)?;
        let line = read_line(&mut client).await.map_err(PipeError::Other)?;
        serde_json::from_str(&line).map_err(|e| PipeError::Other(format!("管道回應格式錯誤:{e}")))
    };
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| PipeError::Other("本機管道逾時".to_string()))?
}
