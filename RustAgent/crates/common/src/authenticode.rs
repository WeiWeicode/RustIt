//! Authenticode 簽章驗證(P6-UPGRADE-DESIGN §5.1、§8.2、§9-2;ADR 0003):Watchdog 升級 Agent(P6-2)、Agent 替換 Watchdog(P6-3)、
//! 軟體派送(P7)共用。
//!
//! - [`signer_thumbprint`]:`WinVerifyTrust`(`WINTRUST_ACTION_GENERIC_VERIFY_V2`,鏈要到 `LocalMachine` 信任的根)通過後,
//!   取主要簽章者憑證的 SHA-1 指紋(小寫十六進位)。未簽章、簽章損壞、鏈不受信任、憑證過期(且沒有時間戳記)都回錯誤
//! - [`signer_allowed`]:簽章者必須**同時**在主機下發的 `signer_thumbprints` 與本機信任清單(`agent.toml` `[upgrade] trusted_signers`)內;
//!   主機清單不能單獨放行(主機被入侵也不能推任意程式)
//!
//! 建鏈只用本機憑證存放區(`WTD_CACHE_ONLY_URL_RETRIEVAL`):根與中繼憑證要事先在 `LocalMachine` 存放區。
//! 撤銷檢查:測試期的自簽憑證沒有 CRL、內網也不一定連得到外部 CRL,目前不做(`WTD_REVOKE_NONE`);正式 AD CS 憑證到位後再評估(上線檢查)。

/// 簽章者是否同時在主機清單與本機清單內(大小寫不分)
pub fn signer_allowed(signer: &str, host: &[String], local: &[String]) -> bool {
    let hit = |list: &[String]| list.iter().any(|t| t.eq_ignore_ascii_case(signer));
    !signer.is_empty() && hit(host) && hit(local)
}

/// 驗證檔案的 Authenticode 簽章,回傳主要簽章者憑證的 SHA-1 指紋(40 個小寫十六進位字元)
#[cfg(windows)]
pub fn signer_thumbprint(path: &std::path::Path) -> Result<String, String> {
    signer_details(path).map(|(thumbprint, _)| thumbprint)
}

/// 同 [`signer_thumbprint`],另回傳簽章者名稱(憑證主體的顯示名稱,通常是 CN;軟體派送回報 `signer_subject`,P7)
#[cfg(windows)]
pub fn signer_details(path: &std::path::Path) -> Result<(String, String), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Security::Cryptography::{
        CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_SHA1_HASH_PROP_ID, CertGetCertificateContextProperty,
        CertGetNameStringW,
    };
    use windows_sys::Win32::Security::WinTrust::{
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO,
        WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE,
        WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE, WTHelperGetProvCertFromChain,
        WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide.as_ptr(),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        dwStateAction: WTD_STATEACTION_VERIFY,
        // 只用本機憑證存放區建鏈,不依檔案內憑證的 AIA 網址連網抓中繼憑證(http / ldap / UNC 會讓端點以電腦帳戶連到任意位址,資安 M2)
        dwProvFlags: WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    };
    data.Anonymous.pFile = &mut file;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY:data / file / wide 活到兩次呼叫結束;INVALID_HANDLE_VALUE = 沒有互動使用者(不顯示 UI)
    let status = unsafe {
        WinVerifyTrust(
            INVALID_HANDLE_VALUE as _,
            &mut action,
            &mut data as *mut _ as *mut _,
        )
    };
    let result = if status != 0 {
        Err(format!(
            "簽章無效或不受信任(WinVerifyTrust 0x{:08X}{})",
            status as u32,
            trust_hint(status)
        ))
    } else {
        // SAFETY:驗證成功時 hWVTStateData 有效,到 WTD_STATEACTION_CLOSE 前取得的指標都有效
        unsafe {
            let prov = WTHelperProvDataFromStateData(data.hWVTStateData);
            let signer = if prov.is_null() {
                std::ptr::null_mut()
            } else {
                WTHelperGetProvSignerFromChain(prov, 0, 0, 0)
            };
            let cert = if signer.is_null() {
                std::ptr::null_mut()
            } else {
                WTHelperGetProvCertFromChain(signer, 0)
            };
            if cert.is_null() || (*cert).pCert.is_null() {
                Err("無法取得簽章者憑證".to_string())
            } else {
                let mut hash = [0u8; 20];
                let mut len = hash.len() as u32;
                if CertGetCertificateContextProperty(
                    (*cert).pCert,
                    CERT_SHA1_HASH_PROP_ID,
                    hash.as_mut_ptr() as *mut _,
                    &mut len,
                ) == 0
                    || len != 20
                {
                    Err(format!(
                        "無法取得簽章者憑證指紋:{}",
                        std::io::Error::last_os_error()
                    ))
                } else {
                    let mut name = [0u16; 256];
                    let n = CertGetNameStringW(
                        (*cert).pCert,
                        CERT_NAME_SIMPLE_DISPLAY_TYPE,
                        0,
                        std::ptr::null(),
                        name.as_mut_ptr(),
                        name.len() as u32,
                    );
                    // n 含結尾 NUL;取不到名稱(n <= 1)時為空字串,不影響驗證結果
                    let subject = String::from_utf16_lossy(&name[..(n as usize).saturating_sub(1)]);
                    Ok((hex::encode(hash), subject))
                }
            }
        }
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    // SAFETY:釋放 WTD_STATEACTION_VERIFY 配置的狀態(驗證失敗時也要呼叫)
    unsafe {
        WinVerifyTrust(
            INVALID_HANDLE_VALUE as _,
            &mut action,
            &mut data as *mut _ as *mut _,
        )
    };
    result
}

/// 常見 WinVerifyTrust 錯誤的說明(日誌與回報用)
#[cfg(windows)]
fn trust_hint(status: i32) -> &'static str {
    match status as u32 {
        0x800B_0100 => ",未簽章",
        0x8009_6010 => ",簽章與檔案內容不符",
        0x800B_0109 => ",根憑證不受信任",
        0x800B_0101 => ",憑證已過期",
        0x800B_010C => ",憑證已撤銷",
        0x800B_0004 => ",發行者不受信任",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signer_must_be_in_both_lists() {
        let a = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678".to_string();
        let b = "ffffffffffffffffffffffffffffffffffffffff".to_string();
        let (one_a, one_b) = (std::slice::from_ref(&a), std::slice::from_ref(&b));
        assert!(signer_allowed(
            &a.to_uppercase(),
            one_a,
            &[b.clone(), a.clone()]
        ));
        assert!(!signer_allowed(&a, one_a, &[]), "本機清單空白:不放行");
        assert!(!signer_allowed(&a, &[], one_a), "主機沒列:不放行");
        assert!(!signer_allowed(&a, one_b, one_a));
        assert!(!signer_allowed("", &[String::new()], &[String::new()]));
    }

    /// 未簽章的檔案(測試程式自己)一律拒絕
    #[cfg(windows)]
    #[test]
    fn unsigned_file_is_rejected() {
        let exe = std::env::current_exe().unwrap();
        let e = signer_thumbprint(&exe).unwrap_err();
        assert!(e.contains("WinVerifyTrust"), "{e}");
        let dir = tempfile_dir();
        let f = dir.join("plain.exe");
        std::fs::write(&f, b"MZ not really").unwrap();
        assert!(signer_thumbprint(&f).is_err());
        assert!(signer_thumbprint(&dir.join("missing.exe")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 已簽章檔案(需手動準備):`RUSTIT_SIGNED_TEST_FILE`、`RUSTIT_SIGNED_TEST_THUMBPRINT`,
    /// 簽章憑證的根要在 LocalMachine\Root(installer\new-test-signing-cert.ps1)
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn signed_file_reports_thumbprint() {
        let file = std::env::var("RUSTIT_SIGNED_TEST_FILE").unwrap();
        let want = std::env::var("RUSTIT_SIGNED_TEST_THUMBPRINT").unwrap();
        assert_eq!(
            signer_thumbprint(std::path::Path::new(&file)).unwrap(),
            want.to_lowercase()
        );
    }

    #[cfg(windows)]
    fn tempfile_dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rustit-authenticode-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
