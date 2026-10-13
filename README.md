# RustIt

公司內部 IT 資產管理平台（對標 IP-guard、SmartIT）。需求見 [docs/PRD.md](docs/PRD.md)，架構與跨專案對應見 [docs/PROJECT-MAP.md](docs/PROJECT-MAP.md)。基本階段(Agent → Node.js Endpoint Server → GigaItApp 電腦清單)已在測試區運作([docs/INTEGRATION-PLAN.md](docs/INTEGRATION-PLAN.md));第二階段(常駐服務、監測、指令、升級、軟體派送)見 [docs/PLATFORM-PLAN.md](docs/PLATFORM-PLAN.md),目前進度見 [docs/HANDOFF.md](docs/HANDOFF.md);AI 協作準則見 [AGENT.md](AGENT.md)。

## 專案結構

```
RustAgent/        Rust:端點電腦上的程式(Cargo workspace,以下指令都在此目錄執行)
├─ crates/
│  ├─ collector/  端點資料蒐集函式庫(WMI、登錄檔、sysinfo),Demo 與 Agent 共用
│  ├─ agent/      端點 Agent(rustit-agent):HTTPS 回報 + WebSocket 心跳,經 Gateway :9443(目前前景執行,服務化見 PLATFORM-PLAN P1)
│  └─ demo/       單機 Demo(Tauri),不連伺服器、不寫資料庫(將改造為使用者端程式 desktop,PLATFORM-PLAN P8)
│     ├─ src/     Rust 後端:蒐集、即時使用率、匯出 JSON、開啟 RustDesk
│     └─ ui/      介面(HTML/CSS/JS,Liquid Glass 風格),編譯時嵌入 exe
└─ docs/          介面技術比較紀錄(ui-performance-comparison.md)與截圖
ItAgentBack/      Node.js(Fastify + TypeScript):Endpoint Server(測試區運作中;開發與部署見 ItAgentBack/README.md)
docs/             共用文件:PRD、專案地圖、整合計畫、架構決策、資料契約(contracts/)、修正紀錄
```

## Agent

本機連 ItAgentBack(dev):先依 [ItAgentBack/README.md](ItAgentBack/README.md) 啟動後端,再在 `RustAgent/` 執行:

```bash
cargo run -p rustit-agent -- run --config crates/agent/agent.dev.toml
```

測試 / 建置:`cargo test -p rustit-agent`、`cargo build -p rustit-agent --release`。測試區套件放 `RustAgent/dist/rustit-agent-test/`(含裝置私鑰,不進版控)。

建置監控 MSI(需 WiX v5:`dotnet tool install --global wix --version 5.0.2`;v6 起企業使用需付費,不使用)。依部署區各建一個,輸出到 `dist/msi/`:

```bash
powershell -ExecutionPolicy Bypass -File installer\build-agent-msi.ps1 -Env test -Gateway 10.10.130.124:9443 -StoreIssuer "GigaNexus Temporary Agent CA (test)" -CaFile dist\rustit-agent-test\pki\ca.crt
```

MSI 安裝後裝置憑證一律讀 `LocalMachine\My`(`store_issuer`),設定在 `%ProgramData%\GigaNexus\Agent\agent.toml`。

以 Windows 服務執行(開發測試用,需系統管理員 PowerShell;正式安裝改用 MSI,PLATFORM-PLAN P1):

```bash
.\rustit-agent.exe install --config .\agent.toml
```

```bash
.\rustit-agent.exe uninstall
```

服務名稱 `GigaNexusAgent`(LocalSystem、自動啟動、失敗後 10 / 30 / 60 秒重啟);日誌在 `%ProgramData%\GigaNexus\Agent\logs\agent-YYYY-MM-DD.log`,等級可在 `agent.toml` 設 `log_level`。

## Demo(將改造為使用者端程式)

> Demo 保留使用者會用的頁面(我的電腦、公告、報修、遠端協助),改造為使用者端程式 `desktop`;軟體派送頁移除、IT 畫面改到 GigaItApp;原生版(egui)已移除(PLATFORM-PLAN §3.3)。

以下 `cargo` 指令都在 `RustAgent/` 目錄執行。

打開後可看到這台電腦的硬體、網路、已安裝軟體、防毒 / USB / RustDesk 狀態，
以及報修單、公告、遠端協助的模擬流程。介面由 Windows 內建的 WebView2 顯示。

```bash
cargo run -p rustit-demo
```

編譯單一 exe（輸出在 `target/release/rustit-demo.exe`，約 8 MB，可直接複製到其他 Windows 10/11 電腦執行）：

```bash
cargo build -p rustit-demo --release
```

只改介面時，可以用瀏覽器預覽 `crates/demo/ui`（沒有 Tauri 時會自動改用 `ui/js/devdata.js` 的假資料）：

```bash
python -m http.server 5178 --directory crates/demo/ui
```

只看蒐集結果（JSON）：

```bash
cargo run -p rustit-collector --example dump
```

## 介面技術比較(紀錄)

2026-09-28 以原生 egui 版(`crates/native`)與 WebView2 版(Demo)並排量測,結論是使用者端程式採 Tauri + WebView2、平時只有托盤、開視窗才建立 WebView2(PLATFORM-PLAN §4.8)。`crates/native` 與量測腳本 `scripts/bench.ps1` 已於 PLATFORM-PLAN P1 移除(最後版本見 commit `3ba3827`);完整數據、截圖與取捨保留在 [RustAgent/docs/ui-performance-comparison.md](RustAgent/docs/ui-performance-comparison.md)。

| 項目 | 原生 egui | WebView2 完整特效 | WebView2 精簡 |
| --- | ---: | ---: | ---: |
| 行程數 / 執行緒 | 1 / 14 | 7 / 245 | 7 / 244 |
| 工作集（MB） | 88.7 | 480.8 | 455.6 |
| 私有記憶體（MB） | 100.6 | 469.7 | 376.8 |
| CPU（毫秒 / 每秒） | 15.6 | 28.2 | 27.2 |
| 執行檔（MB） | 6.7 | 9.7 | 9.7 |

## 開發環境

- Rust stable（MSVC 工具鏈）
- Visual Studio 2022 Build Tools（C++ 工作負載）
- WebView2 Runtime（Windows 11 內建）
