//! 本機加密(INTEGRATION-PLAN D4、PLATFORM-PLAN §4.2):欄位內容以 AES-256-GCM 加密;金鑰以 Windows DPAPI
//! **執行帳號範圍**保護後存 `state\store.key`(服務為 LocalSystem → 只有以 SYSTEM 執行的行程能解開)。
//! - 複製 `state\` 到別台電腦無法解密;同一台電腦的一般使用者即使讀得到檔案也解不開(不只依賴目錄 ACL)。
//! - 不用電腦範圍(CRYPTPROTECT_LOCAL_MACHINE):同機任何帳號都能解開,ACL 設錯或開發模式時保護失效(資安稽核 M1)。
//! - 限制:本機 Administrators 可經 SYSTEM 解開;整顆硬碟被取走需靠 BitLocker;映像派送前要刪除 `state\` 並 sysprep。
//!
//! 不採 SQLCipher(Windows 建置需 OpenSSL,D4)。非 Windows(只供單元測試)不保護金鑰。

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use std::path::Path;

const KEY_FILE: &str = "store.key";
const NONCE_LEN: usize = 12;

pub struct Cipher(Aes256Gcm);

/// 金鑰錯誤:Unreadable 表示金鑰檔存在但解不開(不是這台電腦 / 帳號、內容毀損),只能重建;Io 可能是暫時性的,不重建
#[derive(Debug)]
pub enum KeyError {
    Unreadable(String),
    Io(String),
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyError::Unreadable(m) | KeyError::Io(m) => f.write_str(m),
        }
    }
}

impl Cipher {
    /// 讀取金鑰;不存在時產生新金鑰並以 DPAPI 保護後寫入(先寫暫存檔再改名,避免寫一半)
    pub fn load_or_create(dir: &Path) -> Result<Self, KeyError> {
        let path = dir.join(KEY_FILE);
        let key: [u8; 32] = if path.exists() {
            let blob = std::fs::read(&path)
                .map_err(|e| KeyError::Io(format!("無法讀取金鑰 {}:{e}", path.display())))?;
            let raw = unprotect(&blob).map_err(KeyError::Unreadable)?;
            raw.as_slice()
                .try_into()
                .map_err(|_| KeyError::Unreadable(format!("金鑰長度錯誤({} 位元組)", raw.len())))?
        } else {
            let key = Aes256Gcm::generate_key(&mut OsRng);
            let blob = protect(key.as_slice()).map_err(KeyError::Io)?;
            let tmp = dir.join(format!("{KEY_FILE}.tmp"));
            std::fs::write(&tmp, &blob)
                .map_err(|e| KeyError::Io(format!("無法寫入金鑰 {}:{e}", tmp.display())))?;
            std::fs::rename(&tmp, &path)
                .map_err(|e| KeyError::Io(format!("無法寫入金鑰 {}:{e}", path.display())))?;
            key.into()
        };
        Ok(Self(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))))
    }

    /// nonce(12 位元組,每次隨機)‖ 密文含驗證標籤
    pub fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let mut out = nonce.to_vec();
        out.extend(
            self.0
                .encrypt(&nonce, plain)
                .map_err(|_| "加密失敗".to_string())?,
        );
        Ok(out)
    }

    pub fn open(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        if data.len() < NONCE_LEN {
            return Err("密文長度不足".into());
        }
        let (nonce, ct) = data.split_at(NONCE_LEN);
        self.0
            .decrypt(Nonce::from_slice(nonce), ct)
            .map_err(|_| "解密失敗(金鑰不符或資料毀損)".to_string())
    }
}

#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    dpapi(data, true)
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    dpapi(data, false)
}

/// 應用程式專屬的附加熵:通用的 DPAPI 傾印工具不能直接套用(防禦縱深)
#[cfg(windows)]
const ENTROPY: &[u8] = b"GigaNexus RustIt Agent store key v1";

/// DPAPI 執行帳號範圍(不帶 CRYPTPROTECT_LOCAL_MACHINE)
#[cfg(windows)]
fn dpapi(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    let len = u32::try_from(data.len()).map_err(|_| "資料過大".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: len,
        pbData: data.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY:input / entropy 指向有效的唯讀資料(DPAPI 不寫入);output 由 DPAPI 以 LocalAlloc 配置,複製後以 LocalFree 釋放
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        return Err(if encrypt {
            format!("DPAPI 保護金鑰失敗:{err}")
        } else {
            format!("DPAPI 無法解開金鑰(不是這台電腦或執行帳號產生的?):{err}")
        });
    }
    if output.pbData.is_null() || output.cbData == 0 {
        return Err("DPAPI 回傳空內容".into());
    }
    // SAFETY:DPAPI 成功時 output 指向 cbData 位元組;複製後先清零再釋放(金鑰不留在已釋放的記憶體)
    let out = unsafe {
        let slice = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let copy = slice.to_vec();
        std::ptr::write_bytes(slice.as_mut_ptr(), 0, slice.len());
        LocalFree(output.pbData.cast());
        copy
    };
    Ok(out)
}

#[cfg(not(windows))]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(not(windows))]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip_and_key_persists() {
        let dir = tempfile::tempdir().unwrap();
        let c = Cipher::load_or_create(dir.path()).unwrap();
        let sealed = c.seal(b"PC-EXAMPLE-01").unwrap();
        assert_ne!(&sealed[NONCE_LEN..], b"PC-EXAMPLE-01");
        assert_ne!(c.seal(b"PC-EXAMPLE-01").unwrap(), sealed, "每次 nonce 不同");
        let again = Cipher::load_or_create(dir.path()).unwrap();
        assert_eq!(again.open(&sealed).unwrap(), b"PC-EXAMPLE-01");
    }

    #[test]
    fn other_key_or_tampered_data_fails() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let sealed = Cipher::load_or_create(a.path())
            .unwrap()
            .seal(b"x")
            .unwrap();
        assert!(
            Cipher::load_or_create(b.path())
                .unwrap()
                .open(&sealed)
                .is_err()
        );
        let mut bad = sealed.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(
            Cipher::load_or_create(a.path())
                .unwrap()
                .open(&bad)
                .is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn key_file_is_dpapi_protected_with_entropy() {
        let dir = tempfile::tempdir().unwrap();
        Cipher::load_or_create(dir.path()).unwrap();
        let blob = std::fs::read(dir.path().join(KEY_FILE)).unwrap();
        assert!(blob.len() > 32, "DPAPI 包裝後比原始金鑰長");
        assert!(unprotect(&blob[..blob.len() - 1]).is_err());
        // 不帶附加熵(通用工具)解不開
        let input = windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_ptr().cast_mut(),
        };
        let mut out = windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            windows_sys::Win32::Security::Cryptography::CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                windows_sys::Win32::Security::Cryptography::CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        assert_eq!(ok, 0);
        assert!(matches!(
            Cipher::load_or_create(dir.path()).map(|_| ()),
            Ok(())
        ));
    }

    #[test]
    fn unreadable_key_is_classified() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(KEY_FILE), b"short").unwrap();
        assert!(matches!(
            Cipher::load_or_create(dir.path()),
            Err(KeyError::Unreadable(_))
        ));
    }
}
