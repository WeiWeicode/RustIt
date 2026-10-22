//! 軟體派送流程測試(P7-SOFTWARE-DESIGN §8.1 Agent 列):以假環境驗證每個分支,不連網、不執行安裝程式。

use super::*;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::Mutex;

const SIGNER: &str = "b1c2d3e4f5a60718293a4b5c6d7e8f9012345678";
const OTHER: &str = "0000000000000000000000000000000000000001";

/// 一次下載的劇本
#[derive(Clone)]
enum Dl {
    /// 從 offset 寫到結尾
    Full,
    /// 寫到第 n 個位元組後中斷(可重試)
    Cut(u64),
    /// 主機拒絕(不重試)
    Denied,
    Range416,
}

struct Fake {
    content: Vec<u8>,
    installed: Mutex<bool>,
    /// 執行後是否改變「已安裝」(安裝 → true、移除 → false);false = 執行了但登錄檔沒變
    run_changes: bool,
    entry: UninstallEntry,
    downloads: Mutex<VecDeque<Dl>>,
    offsets: Mutex<Vec<u64>>,
    signer: Result<(String, String), String>,
    exits: Mutex<VecDeque<Result<Exit, String>>>,
    runs: Mutex<Vec<CmdLine>>,
    sleeps: Mutex<Vec<Duration>>,
    progress: Mutex<Vec<u8>>,
    collected: Mutex<u32>,
    free: u64,
    /// 依序回傳的電源狀態;用完後為「不限制」
    power: Mutex<VecDeque<power::PowerState>>,
    drains: Mutex<Vec<Duration>>,
}

impl Fake {
    fn new(content: &[u8]) -> Self {
        Self {
            content: content.to_vec(),
            installed: Mutex::new(false),
            run_changes: true,
            entry: UninstallEntry {
                key: "{23170F69-40C1-2702-2409-000001000000}".into(),
                name: "7-Zip 24.09 (x64 edition)".into(),
                windows_installer: true,
                ..Default::default()
            },
            downloads: Mutex::new(VecDeque::new()),
            offsets: Mutex::new(Vec::new()),
            signer: Ok((SIGNER.into(), "Example Software Ltd.".into())),
            exits: Mutex::new(VecDeque::new()),
            runs: Mutex::new(Vec::new()),
            sleeps: Mutex::new(Vec::new()),
            progress: Mutex::new(Vec::new()),
            collected: Mutex::new(0),
            free: u64::MAX,
            power: Mutex::new(VecDeque::new()),
            drains: Mutex::new(Vec::new()),
        }
    }
    fn exits(self, e: &[Result<Exit, String>]) -> Self {
        *self.exits.lock().unwrap() = e.iter().cloned().collect();
        self
    }
    fn downloads(self, d: &[Dl]) -> Self {
        *self.downloads.lock().unwrap() = d.iter().cloned().collect();
        self
    }
    fn runs(&self) -> usize {
        self.runs.lock().unwrap().len()
    }
}

impl Env for Fake {
    async fn find(&self, d: &Detect) -> Option<UninstallEntry> {
        (*self.installed.lock().unwrap() && detect::matches(d, &self.entry))
            .then(|| self.entry.clone())
    }
    fn prepare_dir(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())
    }
    fn free_bytes(&self, _: &Path) -> Result<u64, String> {
        Ok(self.free)
    }
    async fn download(
        &self,
        _: &str,
        part: &Path,
        offset: u64,
        limit: u64,
    ) -> Result<Fetched, DlError> {
        self.offsets.lock().unwrap().push(offset);
        let step = self
            .downloads
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Dl::Full);
        let write = |end: usize| {
            let mut data = std::fs::read(part).unwrap_or_default();
            data.truncate(offset as usize);
            data.extend_from_slice(&self.content[offset as usize..end]);
            std::fs::write(part, &data).unwrap();
            data.len() as u64
        };
        match step {
            Dl::Full => {
                assert!(self.content.len() as u64 <= limit);
                Ok(Fetched::Done(write(self.content.len())))
            }
            Dl::Cut(n) => {
                write(n as usize);
                Err(DlError {
                    permanent: false,
                    message: "下載中斷".into(),
                })
            }
            Dl::Denied => Err(DlError {
                permanent: true,
                message: "HTTP 404 ITA_PACKAGE_NOT_FOUND".into(),
            }),
            Dl::Range416 => Ok(Fetched::RangeNotSatisfiable),
        }
    }
    fn signer(&self, _: &Path) -> Result<(String, String), String> {
        self.signer.clone()
    }
    async fn run(&self, cmd: &CmdLine, _: Duration, drain: Duration) -> Result<Exit, String> {
        self.drains.lock().unwrap().push(drain);
        self.runs.lock().unwrap().push(cmd.clone());
        let exit = self
            .exits
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(Exit::Code(0)));
        if self.run_changes && matches!(exit, Ok(Exit::Code(0 | 3010 | 1641 | 1638 | 1605))) {
            let mut i = self.installed.lock().unwrap();
            *i = !*i;
        }
        exit
    }
    fn check_uninstaller(&self, _: &Path) -> Result<(), String> {
        Ok(())
    }
    fn msiexec(&self) -> PathBuf {
        PathBuf::from(r"C:\Windows\System32\msiexec.exe")
    }
    async fn sleep(&self, d: Duration) {
        self.sleeps.lock().unwrap().push(d);
    }
    fn progress(&self, pct: u8) {
        self.progress.lock().unwrap().push(pct);
    }
    async fn collect(&self) {
        *self.collected.lock().unwrap() += 1;
    }
    async fn power(&self) -> power::PowerState {
        self.power.lock().unwrap().pop_front().unwrap_or_default()
    }
}

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

fn install_params(content: &[u8], signers: &[&str]) -> Install {
    parse_install(&json!({
        "package_id": "4f3e2d1c-0b9a-4876-9543-210fedcba987",
        "name": "7-Zip",
        "version": "24.09",
        "url": "/agent/v1/packages/4f3e2d1c-0b9a-4876-9543-210fedcba987",
        "sha256": sha(content),
        "size_bytes": content.len(),
        "installer_type": "msi",
        "install_args": "ALLUSERS=1",
        "signer_thumbprints": signers,
        "detect": { "type": "display_name", "value": "7-Zip%" },
        "timeout_sec": 1800,
        "reboot_policy": "never"
    }))
    .unwrap()
}

fn uninstall_params(kind: &str, args: &str) -> Uninstall {
    parse_uninstall(&json!({
        "package_id": "4f3e2d1c-0b9a-4876-9543-210fedcba987",
        "name": "7-Zip",
        "version": "24.09",
        "installer_type": kind,
        "uninstall_args": args,
        "detect": { "type": "display_name", "value": "7-Zip%" },
        "timeout_sec": 1800
    }))
    .unwrap()
}

fn paths() -> (tempfile::TempDir, Paths) {
    let dir = tempfile::tempdir().unwrap();
    let p = Paths {
        root: dir.path().join("cache").join("software"),
        logs: dir.path().join("logs").join("software"),
    };
    (dir, p)
}

const CMD: &str = "6c1d9e2f-3a4b-4c5d-8e6f-7a8b9c0d1e21";
const PKG: &str = "4f3e2d1c-0b9a-4876-9543-210fedcba987";
const TRUSTED: &[&str] = &[SIGNER];

fn trusted() -> Vec<String> {
    TRUSTED.iter().map(|s| s.to_string()).collect()
}

async fn run_install(env: &Fake, p: &Install, paths: &Paths) -> Result<Value, Failure> {
    install(env, paths, CMD, p, &trusted()).await
}

#[tokio::test]
async fn install_msi_succeeds_and_cleans_up() {
    let content = b"MSI package bytes";
    let env = Fake::new(content);
    let (_d, paths) = paths();
    let r = run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap();
    assert_eq!(r["exit_code"], 0);
    assert_eq!(r["detected"], true);
    assert_eq!(r["already_installed"], false);
    assert_eq!(r["reboot_required"], false);
    assert_eq!(r["signer"], SIGNER);
    assert_eq!(r["signer_subject"], "Example Software Ltd.");
    let runs = env.runs.lock().unwrap().clone();
    assert_eq!(runs.len(), 1);
    let line = runs[0].command_line();
    let staged = paths.staging(CMD).join("installer.msi");
    assert!(
        line.starts_with(r#""C:\Windows\System32\msiexec.exe" /i ""#),
        "{line}"
    );
    assert!(
        line.contains(&staged.display().to_string()),
        "從 staging 執行:{line}"
    );
    assert!(line.ends_with("ALLUSERS=1"), "{line}");
    assert_eq!(*env.collected.lock().unwrap(), 1, "立即重新蒐集");
    assert!(!paths.staging(CMD).exists(), "staging 已刪除");
    assert!(
        !paths.package(PKG).join("installer.msi").exists(),
        "安裝檔已刪除"
    );
    let progress = env.progress.lock().unwrap().clone();
    assert!(
        progress.contains(&85) && progress.contains(&95),
        "{progress:?}"
    );
}

#[tokio::test]
async fn already_installed_skips_everything() {
    let content = b"x";
    let env = Fake::new(content);
    *env.installed.lock().unwrap() = true;
    let (_d, paths) = paths();
    let r = run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap();
    assert_eq!(r["already_installed"], true);
    assert_eq!(r["detected"], true);
    assert!(env.offsets.lock().unwrap().is_empty(), "沒有下載");
    assert_eq!(env.runs(), 0);
}

#[tokio::test]
async fn hash_mismatch_never_runs_installer() {
    let env = Fake::new(b"tampered!");
    let (_d, paths) = paths();
    // 快照是另一份內容(大小相同)
    let f = run_install(&env, &install_params(b"original!", &[SIGNER]), &paths)
        .await
        .unwrap_err();
    assert_eq!(f.code, "HASH_MISMATCH");
    assert_eq!(env.runs(), 0);
    assert!(
        !paths.package(PKG).join("installer.msi").exists(),
        "不符的檔案已刪除"
    );
}

#[tokio::test]
async fn signature_and_signer_checks() {
    let content = b"signed?";
    let (_d, paths) = paths();
    let mut env = Fake::new(content);
    env.signer = Err("簽章無效或不受信任(WinVerifyTrust 0x800B0100,未簽章)".into());
    let f = run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap_err();
    assert_eq!(f.code, "SIGNATURE_INVALID");
    assert_eq!(env.runs(), 0);

    // 主機清單有、本機清單沒有
    let env = Fake::new(content);
    let f = install(
        &env,
        &paths,
        CMD,
        &install_params(content, &[SIGNER]),
        &[OTHER.to_string()],
    )
    .await
    .unwrap_err();
    assert_eq!(f.code, "SIGNER_NOT_TRUSTED");
    assert_eq!(f.result.unwrap()["signer"], SIGNER, "回報實際簽章者");
    assert_eq!(env.runs(), 0);

    // 本機有、主機清單沒有
    let env = Fake::new(content);
    let f = run_install(&env, &install_params(content, &[OTHER]), &paths)
        .await
        .unwrap_err();
    assert_eq!(f.code, "SIGNER_NOT_TRUSTED");
    assert_eq!(env.runs(), 0);
}

#[tokio::test]
async fn draft_package_requires_local_list() {
    let content = b"draft";
    let (_d, paths) = paths();
    // draft(主機清單空):簽章者在本機清單內 → 安裝並回報實際簽章者
    let env = Fake::new(content);
    let r = run_install(&env, &install_params(content, &[]), &paths)
        .await
        .unwrap();
    assert_eq!(r["signer"], SIGNER);
    assert_eq!(env.runs(), 1);
    // 不在本機清單 → 拒絕(資安 C2:主機被入侵也不能用空清單推任意已簽章程式)
    let env = Fake::new(content);
    let f = install(
        &env,
        &paths,
        CMD,
        &install_params(content, &[]),
        &[OTHER.to_string()],
    )
    .await
    .unwrap_err();
    assert_eq!(f.code, "SIGNER_NOT_TRUSTED");
    assert_eq!(f.result.unwrap()["signer"], SIGNER, "仍回報實際簽章者");
    assert_eq!(env.runs(), 0);
    let env = Fake::new(content);
    let f = install(&env, &paths, CMD, &install_params(content, &[]), &[])
        .await
        .unwrap_err();
    assert_eq!(
        f.code, "SIGNER_NOT_TRUSTED",
        "本機清單空白 → 不接受任何套件"
    );
    let mut env = Fake::new(content);
    env.signer = Err("未簽章".into());
    let f = run_install(&env, &install_params(content, &[]), &paths)
        .await
        .unwrap_err();
    assert_eq!(f.code, "SIGNATURE_INVALID", "未簽章在任何狀態都拒絕");
}

#[tokio::test]
async fn exit_codes() {
    let content = b"codes";
    let (_d, paths) = paths();
    let p = install_params(content, &[SIGNER]);

    let env = Fake::new(content).exits(&[Ok(Exit::Code(3010))]);
    let r = run_install(&env, &p, &paths).await.unwrap();
    assert_eq!(
        (r["exit_code"].as_u64(), r["reboot_required"].as_bool()),
        (Some(3010), Some(true))
    );

    let env = Fake::new(content).exits(&[Ok(Exit::Code(1638))]);
    let r = run_install(&env, &p, &paths).await.unwrap();
    assert_eq!(r["already_installed"], true);

    let env = Fake::new(content).exits(&[Ok(Exit::Code(1603))]);
    let f = run_install(&env, &p, &paths).await.unwrap_err();
    assert_eq!(f.code, "INSTALL_FAILED");
    assert_eq!(f.result.unwrap()["exit_code"], 1603);

    let env = Fake::new(content).exits(&[Ok(Exit::Timeout)]);
    assert_eq!(
        run_install(&env, &p, &paths).await.unwrap_err().code,
        "INSTALL_TIMEOUT"
    );

    let env = Fake::new(content).exits(&[Err("無法啟動".into())]);
    assert_eq!(
        run_install(&env, &p, &paths).await.unwrap_err().code,
        "EXECUTION_FAILED"
    );
}

#[tokio::test]
async fn busy_1618_retries_then_gives_up() {
    let content = b"busy";
    let (_d, paths) = paths();
    let p = install_params(content, &[SIGNER]);
    let env = Fake::new(content).exits(&[Ok(Exit::Code(1618)), Ok(Exit::Code(0))]);
    assert_eq!(run_install(&env, &p, &paths).await.unwrap()["exit_code"], 0);
    assert_eq!(env.runs(), 2);
    assert!(env.sleeps.lock().unwrap().contains(&BUSY_WAIT));

    let env = Fake::new(content).exits(&vec![Ok(Exit::Code(1618)); 4]);
    assert_eq!(
        run_install(&env, &p, &paths).await.unwrap_err().code,
        "INSTALL_BUSY"
    );
    assert_eq!(env.runs(), 4, "第一次 + 重試 3 次");
}

#[tokio::test]
async fn detect_failed_after_success_code() {
    let content = b"nodetect";
    let mut env = Fake::new(content);
    env.run_changes = false;
    let (_d, paths) = paths();
    let f = run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap_err();
    assert_eq!(f.code, "DETECT_FAILED");
    assert_eq!(f.result.unwrap()["detected"], false);
    let polls = env
        .sleeps
        .lock()
        .unwrap()
        .iter()
        .filter(|d| **d == DETECT_INTERVAL)
        .count();
    assert_eq!(polls as u32, DETECT_POLLS - 1, "輪詢 120 秒");
}

#[tokio::test]
async fn download_resumes_and_retries() {
    let content = b"0123456789abcdef";
    let env = Fake::new(content).downloads(&[Dl::Cut(6), Dl::Full]);
    let (_d, paths) = paths();
    run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap();
    assert_eq!(
        *env.offsets.lock().unwrap(),
        vec![0, 6],
        "以 Range 從中斷處續傳"
    );
    assert!(
        env.sleeps
            .lock()
            .unwrap()
            .contains(&Duration::from_secs(download::RETRY_WAIT[0]))
    );

    let env = Fake::new(content).downloads(&[Dl::Range416, Dl::Full]);
    run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap();

    let env = Fake::new(content).downloads(&[Dl::Cut(1), Dl::Cut(2), Dl::Cut(3)]);
    let f = run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap_err();
    assert_eq!(f.code, "DOWNLOAD_FAILED");
    assert!(
        paths.package(PKG).join("installer.msi.part").exists(),
        "保留 .part 供下次續傳"
    );
}

#[tokio::test]
async fn download_denied_is_not_retried() {
    let content = b"denied";
    let env = Fake::new(content).downloads(&[Dl::Denied]);
    let (_d, paths) = paths();
    let f = run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap_err();
    assert_eq!(f.code, "DOWNLOAD_FAILED");
    assert_eq!(env.offsets.lock().unwrap().len(), 1);
    assert_eq!(env.runs(), 0);
}

#[tokio::test]
async fn reuses_complete_download() {
    let content = b"cached";
    let env = Fake::new(content).downloads(&[Dl::Denied]);
    let (_d, paths) = paths();
    let dir = paths.package(PKG);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("installer.msi"), content).unwrap();
    run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap();
    assert!(
        env.offsets.lock().unwrap().is_empty(),
        "已完整且雜湊相符就不下載"
    );
}

#[tokio::test]
async fn disk_full() {
    let content = b"big";
    let mut env = Fake::new(content);
    env.free = download::FREE_MARGIN;
    let (_d, paths) = paths();
    let f = run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap_err();
    assert_eq!(f.code, "DISK_FULL");
    assert!(env.offsets.lock().unwrap().is_empty());
}

#[tokio::test]
async fn uninstall_flows() {
    let (_d, paths) = paths();
    // 沒有安裝
    let env = Fake::new(b"");
    let r = uninstall(&env, &paths, CMD, &uninstall_params("msi", ""))
        .await
        .unwrap();
    assert_eq!(r["already_absent"], true);
    assert_eq!(env.runs(), 0);

    // MSI:以產品代碼移除,輪詢到消失
    let env = Fake::new(b"");
    *env.installed.lock().unwrap() = true;
    let r = uninstall(&env, &paths, CMD, &uninstall_params("msi", ""))
        .await
        .unwrap();
    assert_eq!(
        (r["exit_code"].as_u64(), r["already_absent"].as_bool()),
        (Some(0), Some(false))
    );
    let line = env.runs.lock().unwrap()[0].command_line();
    assert!(
        line.contains("/x {23170F69-40C1-2702-2409-000001000000} /qn /norestart"),
        "{line}"
    );
    assert_eq!(*env.collected.lock().unwrap(), 1);

    // NSIS 移除程式自我複製後結束:登錄檔一直還在 → DETECT_FAILED
    let mut env = Fake::new(b"");
    env.run_changes = false;
    env.entry = UninstallEntry {
        key: "7-Zip".into(),
        name: "7-Zip 24.09".into(),
        uninstall_string: r#""C:\Program Files\7-Zip\Uninstall.exe""#.into(),
        ..Default::default()
    };
    *env.installed.lock().unwrap() = true;
    let f = uninstall(&env, &paths, CMD, &uninstall_params("nsis", "/S"))
        .await
        .unwrap_err();
    assert_eq!(f.code, "DETECT_FAILED");
    assert_eq!(env.runs.lock().unwrap()[0].args, "/S");

    // 沒有靜默參數
    let mut env = Fake::new(b"");
    env.entry.windows_installer = false;
    env.entry.key = "App".into();
    env.entry.uninstall_string = r#""C:\Program Files\A\u.exe""#.into();
    *env.installed.lock().unwrap() = true;
    let f = uninstall(&env, &paths, CMD, &uninstall_params("exe", ""))
        .await
        .unwrap_err();
    assert_eq!(f.code, "UNINSTALL_NOT_SUPPORTED");
    assert_eq!(env.runs(), 0);

    // 移除失敗
    let env = Fake::new(b"").exits(&[Ok(Exit::Code(1603))]);
    *env.installed.lock().unwrap() = true;
    let f = uninstall(&env, &paths, CMD, &uninstall_params("msi", ""))
        .await
        .unwrap_err();
    assert_eq!(f.code, "INSTALL_FAILED");
}

#[test]
fn contract_samples_parse() {
    let read = |name: &str| -> Value {
        let path = format!(
            "{}/../../../docs/contracts/examples/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    };
    let i =
        parse_install(&read("ws-command-software-install.sample.json")["body"]["params"]).unwrap();
    assert_eq!(
        (i.installer, i.size_bytes, i.signers.len()),
        (Installer::Msi, 1_572_864, 1)
    );
    assert_eq!(i.timeout, Duration::from_secs(1800));
    let u = parse_uninstall(&read("ws-command-software-uninstall.sample.json")["body"]["params"])
        .unwrap();
    assert_eq!(
        (u.installer, u.uninstall_args.as_str()),
        (Installer::Msi, "")
    );
}

#[test]
fn snapshot_is_validated_again() {
    let base = json!({
        "package_id": "4f3e2d1c-0b9a-4876-9543-210fedcba987",
        "name": "7-Zip",
        "version": "24.09",
        "url": "/agent/v1/packages/4f3e2d1c-0b9a-4876-9543-210fedcba987",
        "sha256": "9b1d2c3a4f5e6d7c8b9a0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4",
        "size_bytes": 10,
        "installer_type": "msi",
        "install_args": "",
        "signer_thumbprints": [],
        "detect": { "type": "display_name", "value": "7-Zip%" }
    });
    assert!(parse_install(&base).is_ok());
    let bad = |k: &str, v: Value| {
        let mut p = base.clone();
        p[k] = v;
        parse_install(&p).map(|_| ()).unwrap_err().code
    };
    assert_eq!(
        bad("url", json!("https://evil.example/x.msi")),
        "INVALID_PARAMS"
    );
    assert_eq!(
        bad(
            "url",
            json!("/agent/v1/packages/00000000-0000-0000-0000-000000000000")
        ),
        "INVALID_PARAMS"
    );
    assert_eq!(bad("install_args", json!("TRANSFORMS=x")), "INVALID_PARAMS");
    assert_eq!(bad("install_args", json!("a & calc")), "INVALID_PARAMS");
    assert_eq!(bad("size_bytes", json!(0)), "INVALID_PARAMS");
    assert_eq!(bad("size_bytes", json!(MAX_SIZE + 1)), "INVALID_PARAMS");
    assert_eq!(bad("sha256", json!("ABC")), "INVALID_PARAMS");
    assert_eq!(bad("installer_type", json!("bat")), "INVALID_PARAMS");
    assert_eq!(bad("signer_thumbprints", json!(["xyz"])), "INVALID_PARAMS");
    assert_eq!(
        bad("detect", json!({ "type": "display_name", "value": "%" })),
        "INVALID_PARAMS"
    );
    assert_eq!(
        bad(
            "detect",
            json!({ "type": "msi_product_code", "value": "7-Zip" })
        ),
        "INVALID_PARAMS"
    );
    assert_eq!(bad("timeout_sec", json!(10)), "INVALID_PARAMS");
    assert_eq!(bad("name", json!("a\u{202E}b")), "INVALID_PARAMS");
    assert_eq!(bad("ignore_power", json!("yes")), "INVALID_PARAMS");
}

#[test]
fn log_tail_reads_utf16_and_redacts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.log");
    let mut text = String::new();
    for i in 0..30 {
        text.push_str(&format!("MSI (s) line {i}\r\n"));
    }
    text.push_str("Property(S): PASSWORD=hunter2\r\n");
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    std::fs::write(&path, bytes).unwrap();
    let tail = log_tail(&path).unwrap();
    assert_eq!(tail.lines().count(), 20);
    assert!(tail.starts_with("MSI (s) line 11"), "{tail}");
    assert!(!tail.contains("hunter2"), "遮罩:{tail}");
    assert!(log_tail(&dir.path().join("none.log")).is_none());
}

#[test]
fn purge_removes_only_stale_entries() {
    let (_d, paths) = paths();
    let fresh = paths.package(PKG);
    std::fs::create_dir_all(&fresh).unwrap();
    std::fs::create_dir_all(paths.staging("x")).unwrap();
    std::fs::create_dir_all(&paths.logs).unwrap();
    purge_stale(&paths);
    assert!(
        fresh.exists() && paths.staging("x").exists(),
        "未超過 24 小時不刪"
    );
}

const BATTERY: power::PowerState = power::PowerState {
    on_battery: true,
    metered: false,
};
const METERED: power::PowerState = power::PowerState {
    on_battery: false,
    metered: true,
};

#[tokio::test]
async fn a6_defers_until_power_returns() {
    let content = b"a6";
    let env = Fake::new(content);
    *env.power.lock().unwrap() = [BATTERY, BATTERY].into_iter().collect();
    let p = install_params(content, &[SIGNER]);
    defer(&env, &p, power::DEFER_MAX).await.unwrap();
    let waits = env.sleeps.lock().unwrap().clone();
    assert_eq!(waits, vec![power::CHECK_EVERY; 2], "每 5 分鐘重新檢查");
    assert_eq!(
        env.progress.lock().unwrap().clone(),
        vec![0, 0],
        "延後期間以進度 0 讓主機重設逾時"
    );
}

#[tokio::test]
async fn a6_ignore_power_skips_battery_only() {
    let content = b"a6";
    let mut p = install_params(content, &[SIGNER]);
    p.ignore_power = true;
    let env = Fake::new(content);
    *env.power.lock().unwrap() = [BATTERY].into_iter().collect();
    defer(&env, &p, power::DEFER_MAX).await.unwrap();
    assert!(env.sleeps.lock().unwrap().is_empty());

    let env = Fake::new(content);
    *env.power.lock().unwrap() = vec![METERED; 100].into_iter().collect();
    let f = defer(&env, &p, Duration::from_secs(600)).await.unwrap_err();
    assert_eq!(f.code, "DEFERRED_TIMEOUT", "計量網路不因 ignore_power 略過");
    assert_eq!(
        env.sleeps.lock().unwrap().len(),
        2,
        "上限 10 分鐘 = 檢查 2 次"
    );
}

#[tokio::test]
async fn a6_deadline_shorter_than_check_interval() {
    let content = b"a6";
    let env = Fake::new(content);
    *env.power.lock().unwrap() = vec![BATTERY; 10].into_iter().collect();
    let p = install_params(content, &[SIGNER]);
    let f = defer(&env, &p, Duration::from_secs(90)).await.unwrap_err();
    assert_eq!(f.code, "DEFERRED_TIMEOUT");
    assert_eq!(
        *env.sleeps.lock().unwrap(),
        vec![Duration::from_secs(90)],
        "不超過指令剩餘時間"
    );
    let f = defer(&env, &p, Duration::ZERO).await.unwrap_err();
    assert_eq!(f.code, "DEFERRED_TIMEOUT", "已過期不等待");
}

#[test]
fn cached_download_is_not_deferred() {
    let content = b"cached-a6";
    let (_d, paths) = paths();
    let p = install_params(content, &[SIGNER]);
    assert!(!cached(&paths, &p));
    std::fs::create_dir_all(paths.package(PKG)).unwrap();
    std::fs::write(paths.package(PKG).join("installer.msi"), content).unwrap();
    assert!(cached(&paths, &p));
}

#[tokio::test]
async fn failures_clean_up_staging_and_download() {
    let content = b"cleanup";
    let (_d, paths) = paths();
    let p = install_params(content, &[SIGNER]);
    for env in [
        Fake::new(content).exits(&[Ok(Exit::Code(1603))]),
        Fake::new(content).exits(&[Ok(Exit::Timeout)]),
    ] {
        run_install(&env, &p, &paths).await.unwrap_err();
        assert!(!paths.staging(CMD).exists(), "失敗後 staging 已刪除");
        assert!(
            !paths.package(PKG).join("installer.msi").exists(),
            "失敗後安裝檔已刪除"
        );
    }
    let env = Fake::new(content);
    install(&env, &paths, CMD, &p, &[OTHER.to_string()])
        .await
        .unwrap_err();
    assert!(
        !paths.staging(CMD).exists(),
        "SIGNER_NOT_TRUSTED 後 staging 已刪除"
    );
}

#[tokio::test]
async fn range_416_restarts_from_zero() {
    let content = b"0123456789";
    let env = Fake::new(content).downloads(&[Dl::Cut(4), Dl::Range416, Dl::Full]);
    let (_d, paths) = paths();
    run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap();
    assert_eq!(
        *env.offsets.lock().unwrap(),
        vec![0, 4, 0],
        "416 後刪除 .part 從頭下載"
    );
}

#[tokio::test]
async fn complete_part_file_is_used_without_download() {
    let content = b"part-complete";
    let env = Fake::new(content).downloads(&[Dl::Denied]);
    let (_d, paths) = paths();
    std::fs::create_dir_all(paths.package(PKG)).unwrap();
    std::fs::write(paths.package(PKG).join("installer.msi.part"), content).unwrap();
    run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap();
    assert!(
        env.offsets.lock().unwrap().is_empty(),
        "改名前中斷的完整 .part 直接採用"
    );
}

#[tokio::test]
async fn drain_limits_per_action() {
    let content = b"drain";
    let (_d, paths) = paths();
    let env = Fake::new(content);
    run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap();
    assert_eq!(
        *env.drains.lock().unwrap(),
        vec![Duration::from_secs(1800)],
        "安裝:子行程等到逾時"
    );
    let env = Fake::new(b"");
    *env.installed.lock().unwrap() = true;
    uninstall(&env, &paths, CMD, &uninstall_params("msi", ""))
        .await
        .unwrap();
    assert_eq!(
        *env.drains.lock().unwrap(),
        vec![install::DRAIN_MAX],
        "移除:最多 5 分鐘"
    );
}

#[tokio::test]
async fn uninstall_exit_paths() {
    let (_d, paths) = paths();
    let p = uninstall_params("msi", "");
    let env = Fake::new(b"").exits(&[Ok(Exit::Code(1618)), Ok(Exit::Code(1605))]);
    *env.installed.lock().unwrap() = true;
    let r = uninstall(&env, &paths, CMD, &p).await.unwrap();
    assert_eq!(r["exit_code"], 1605, "1605 以登錄檔輪詢確認");
    assert!(env.sleeps.lock().unwrap().contains(&BUSY_WAIT));
    let env = Fake::new(b"").exits(&[Ok(Exit::Timeout)]);
    *env.installed.lock().unwrap() = true;
    assert_eq!(
        uninstall(&env, &paths, CMD, &p).await.unwrap_err().code,
        "INSTALL_TIMEOUT"
    );
}

#[tokio::test]
async fn command_id_must_be_uuid() {
    let content = b"id";
    let (_d, paths) = paths();
    for id in [r"c:\windows", r"..\..\users", "x"] {
        let env = Fake::new(content);
        let f = install(
            &env,
            &paths,
            id,
            &install_params(content, &[SIGNER]),
            &trusted(),
        )
        .await
        .unwrap_err();
        assert_eq!(f.code, "INVALID_PARAMS", "{id}");
        assert!(env.offsets.lock().unwrap().is_empty());
        let f = uninstall(&env, &paths, id, &uninstall_params("msi", ""))
            .await
            .unwrap_err();
        assert_eq!(f.code, "INVALID_PARAMS", "{id}");
    }
}

#[test]
fn purge_removes_stale_entries() {
    let (_d, paths) = paths();
    std::fs::create_dir_all(&paths.root).unwrap();
    std::fs::create_dir_all(&paths.logs).unwrap();
    let old = std::time::SystemTime::now() - Duration::from_secs(15 * 24 * 3600);
    let stale_log = paths.logs.join("old.log");
    let stale_part = paths.root.join("stray.part");
    for f in [&stale_log, &stale_part] {
        std::fs::write(f, b"x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(f)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }
    let fresh_log = paths.logs.join("new.log");
    std::fs::write(&fresh_log, b"x").unwrap();
    purge_stale(&paths);
    assert!(
        !stale_log.exists() && !stale_part.exists(),
        "過期的記錄與殘留已刪除"
    );
    assert!(fresh_log.exists());
}

#[test]
fn held_installer_cannot_be_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("installer.exe");
    std::fs::write(&f, b"MZ").unwrap();
    let hold = hold_readonly(&f).unwrap();
    assert!(
        std::fs::OpenOptions::new().write(true).open(&f).is_err(),
        "持有期間不可寫入"
    );
    assert!(std::fs::remove_file(&f).is_err(), "持有期間不可刪除");
    assert_eq!(std::fs::read(&f).unwrap(), b"MZ", "仍可讀取");
    drop(hold);
    assert!(std::fs::OpenOptions::new().write(true).open(&f).is_ok());
}

#[tokio::test]
async fn installer_gets_private_temp() {
    let content = b"temp";
    let env = Fake::new(content);
    let (_d, paths) = paths();
    run_install(&env, &install_params(content, &[SIGNER]), &paths)
        .await
        .unwrap();
    let temp = env.runs.lock().unwrap()[0].temp.clone();
    assert_eq!(temp, Some(paths.staging(CMD).join("tmp")));
}

#[test]
fn held_exe_can_still_run() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("installer.exe");
    let system = install::msiexec_path().parent().unwrap().to_path_buf();
    std::fs::copy(system.join("where.exe"), &exe).unwrap();
    let _hold = hold_readonly(&exe).unwrap();
    let cmd = CmdLine {
        program: exe.clone(),
        args: "/Q rustit-no-such-file-xyz".into(),
        temp: None,
    };
    assert_eq!(
        install::run_job(&cmd, Duration::from_secs(30), install::DRAIN_MAX).unwrap(),
        Exit::Code(1),
        "持有拒寫控制代碼時仍可執行"
    );
}
