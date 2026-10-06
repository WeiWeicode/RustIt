# RustIt

公司內部 IT 資產管理平台（對標 IP-guard、SmartIT）。需求見 [docs/PRD.md](docs/PRD.md)，架構與跨專案對應見 [docs/PROJECT-MAP.md](docs/PROJECT-MAP.md)。進行中的整合工作(Agent → Node.js Endpoint Server → GigaItApp)見 [docs/INTEGRATION-PLAN.md](docs/INTEGRATION-PLAN.md);AI 協作準則見 [AGENT.md](AGENT.md)。

## 專案結構

```
RustAgent/        Rust:端點電腦上的程式(Cargo workspace,以下指令都在此目錄執行)
├─ crates/
│  ├─ collector/  端點資料蒐集函式庫(WMI、登錄檔、sysinfo),Demo 與 Agent 共用
│  ├─ demo/       單機 Demo(Tauri),不連伺服器、不寫資料庫
│  │  ├─ src/     Rust 後端:蒐集、即時使用率、匯出 JSON、開啟 RustDesk
│  │  └─ ui/      介面(HTML/CSS/JS,Liquid Glass 風格),編譯時嵌入 exe
│  └─ native/     同一個 Demo 的原生介面版(egui),用來和 WebView2 版比較效能
├─ docs/          介面技術比較(ui-performance-comparison.md)與截圖
└─ scripts/       bench.ps1:並排量測兩個版本的記憶體、CPU、行程數
ItAgentBack/      Node.js(Fastify + TypeScript):Endpoint Server(建置中,INTEGRATION-PLAN M1)
docs/             共用文件:PRD、專案地圖、整合計畫、架構決策、資料契約(contracts/)、修正紀錄
```

## Demo

以下 `cargo` 與 `scripts/` 指令都在 `RustAgent/` 目錄執行。

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

## 原生版（egui）

`crates/native` 是同一個 Demo 改用 [egui](https://github.com/emilk/egui) 直接繪製的版本，資料一樣來自
`rustit-collector`，配色與版面沿用 WebView 版，用來比較兩種介面技術的效能。

```bash
cargo run -p rustit-native
```

編譯單一 exe（輸出在 `target/release/rustit-native.exe`，約 7 MB，內嵌圖示與版本資訊；可直接複製到其他 Windows 10/11 電腦執行，需要支援 OpenGL 2.0 的顯示卡驅動）。要給別人試用時，複製成 `dist/RustIt-Native.exe`，和 WebView 版的 `dist/RustIt-Demo.exe` 放在一起：

```bash
cargo build -p rustit-native --release
```

- 頁面：總覽、硬體資訊、網路、已安裝軟體、安全與控管、遠端協助，另外多一頁「效能比較」，
  顯示本程式的啟動時間、記憶體、CPU 與每幀耗時（可勾選「持續重繪」做壓力測試）。
- 沒有做的：報修單、公告、軟體派送（都是 WebView 版前端的模擬流程，與效能比較無關），
  以及背景模糊與折射特效（egui 沒有 backdrop-filter，卡片是半透明色塊，接近 WebView 版的「精簡」模式）。
- 行為與 WebView 版一致：視窗不在前景時暫停每秒更新；只有總覽與效能頁會每秒重繪，其他頁面閒置時完全不重繪。
- 繪圖後端預設 OpenGL（glow）。也可以改用 wgpu（DirectX 12 / Vulkan），但在實測的 NVIDIA 顯示卡上記憶體多約 3 倍、
  執行檔大一倍，所以不當預設：

  ```bash
  cargo build -p rustit-native --release --no-default-features --features wgpu
  ```

### 並排比較

先編譯兩個版本，再執行量測腳本。腳本會依序啟動兩個 exe，等資料蒐集完成後取樣 30 秒，
加總主程式與所有子行程（WebView2 的 `msedgewebview2.exe`）的記憶體、CPU、執行緒與控制代碼。
量測期間不要切換視窗（兩個版本在背景時都會暫停更新）。

```bash
cargo build --release -p rustit-native -p rustit-demo
```

```bash
powershell -ExecutionPolicy Bypass -File scripts/bench.ps1 -Runs 3
```

2026-09-28 在開發機上的結果（總覽頁，取樣 30 秒 × 3 次平均），完整說明、截圖與取捨見
[RustAgent/docs/ui-performance-comparison.md](RustAgent/docs/ui-performance-comparison.md)：

| 項目 | 原生 egui | WebView2 完整特效 | WebView2 精簡 |
| --- | ---: | ---: | ---: |
| 行程數 / 執行緒 | 1 / 14 | 7 / 245 | 7 / 244 |
| 工作集（MB） | 88.7 | 480.8 | 455.6 |
| 私有記憶體（MB） | 100.6 | 469.7 | 376.8 |
| CPU（毫秒 / 每秒） | 15.6 | 28.2 | 27.2 |
| 執行檔（MB） | 6.7 | 9.7 | 9.7 |

- 腳本會自動關掉 WebView2 版啟動時的「重要公告」彈窗（加上 `-KeepAnnouncement` 則保留），讓兩個版本停在同一個畫面。
- CPU 以 CPU 週期計算；每次量測都會確認視窗在前景，不在前景的那次不列入平均。
- 表格裡的「視窗出現」不能直接比較：原生版畫好第一幀才顯示視窗，WebView 版先顯示空白視窗再載入網頁。

## 開發環境

- Rust stable（MSVC 工具鏈）
- Visual Studio 2022 Build Tools（C++ 工作負載）
- WebView2 Runtime（Windows 11 內建）
