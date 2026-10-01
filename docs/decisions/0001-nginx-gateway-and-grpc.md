# 0001：經由 nginx 連到後端，Agent 通訊採 gRPC

- 日期：2026-09-27
- 狀態：**決策一已採用；決策二改採替代方案（2026-10-01）**：Agent 通訊改為 **HTTPS 回報 + WebSocket 接收指令**，不使用 gRPC
- 相關：[PRD](../PRD.md) 第 3 節（系統架構）、第 7 節（非功能需求）

## 結論

> **2026-10-01 更新**：需求方決定 Agent 改採本文「替代方案」：**全部 REST/JSON + 指令通道用 WebSocket**（1,000 台以內已足夠，兩端共用 serde 資料結構）。Gateway 端的規格以 `../giga-api-gateway-bff/docs/ENDPOINT-AGENT-GUIDE.md`（v0.3）與 Gateway PRD v0.9 §7.6 為準：Agent 經 Gateway `:9443`（mTLS、HTTP/1.1）連到 Endpoint Server `:51241`。以下「決策二」與 nginx 設定示意保留為當時的評估紀錄。

1. 所有 HTTP 流量都經過公司的 nginx（GigaNexus Gateway）再到後端，只有 RustDesk 直接連線。
2. ~~Agent 與後端之間用 **gRPC**（`tonic`）~~ → Agent 以 **HTTPS 回報資料、WebSocket 接收指令**（`axum` + `tokio-tungstenite`）；Web 後台與使用者介面用 **REST/JSON**（`axum`）。

```
Agent（每台電腦） ──gRPC + mTLS──┐
                                 ├─► nginx ─┬─► 後端 gRPC  :50051 ─┐
Web 後台 / 使用者介面 ──HTTPS────┘           └─► 後端 REST  :8080  ─┴─► PostgreSQL

RustDesk 用戶端 ─────── TCP/UDP 21115–21119 ───────► RustDesk 伺服器（hbbs / hbbr）
```

## 背景

- 公司已有一台 nginx 作為 IP gateway，維運人員熟悉它的設定。
- 預計規模約 2,000 台端點，每台 Agent 會常駐一條連線，用來接收 IT 下達的指令。
- Agent 會分批升級，新舊版本會同時存在一段時間。
- 瀏覽器無法直接使用 gRPC。

## 決策一：經過 nginx

### 理由

- **單一入口**：公司憑證、TLS、存取紀錄、IP 白名單、限流集中管理。
- **後端不直接暴露**：後端換版或加第二台做負載平衡時，Agent 端不用改設定。
- **Web 前端靜態檔**直接由 nginx 提供。

### 注意事項

| 項目 | 說明 |
| --- | --- |
| Agent 身分驗證（mTLS） | TLS 在 nginx 解開，由 nginx 驗證 Agent 的用戶端憑證（`ssl_verify_client`），再把驗證結果與憑證指紋用 header 傳給後端。首次註冊時 Agent 還沒有憑證，所以設為 `optional`，由後端判斷哪些 API 必須有憑證。 |
| 後端只信任 nginx | 後端只綁內網位址或用防火牆限制來源為 nginx，否則憑證指紋、`X-Forwarded-For` 等 header 可被偽造。 |
| 長連線數量 | 2,000 台 Agent 就是 2,000 條常駐連線，nginx 每條會用掉 2 個連線名額。確認 `worker_connections`、`worker_rlimit_nofile` 夠大，逾時設長（例如 1 小時），避免連線被切斷後不斷重連。 |
| 共用設備的風險 | 若這台 nginx 也服務其他系統，改設定前要和負責人協調。nginx 停擺時 Agent 先把資料暫存在本機，恢復後補傳（PRD 第 7 節）。 |
| AD 單一登入 | Windows 整合驗證要用 Kerberos。NTLM 需要固定同一條連線，nginx 免費版無法正確轉送。PRD 規劃的 LDAPS 帳密登入不受影響。 |
| RustDesk 不走 nginx | hbbs / hbbr 使用 TCP/UDP 21115–21119，不是 HTTP，直接連 RustDesk 伺服器。 |

## 決策二：Agent 用 gRPC，Web 用 REST

| 連線 | 採用 | 理由 |
| --- | --- | --- |
| Agent ↔ 後端 | gRPC（`tonic`） | IT 下指令需要雙向長連線，直接用 gRPC 的雙向 stream，不用另外設計 WebSocket 協定。protobuf 對欄位增減的相容性好，適合新舊版 Agent 並存。兩端都是 Rust，共用 `.proto` 定義。 |
| Web 後台、使用者介面 ↔ 後端 | REST/JSON（`axum`） | 瀏覽器不能直接用 gRPC，要多一層 gRPC-Web 轉換。REST 好除錯、可產生 API 文件，報表與表單類功能最順手。 |

後端可以在同一個程式裡同時提供 gRPC（:50051）與 REST（:8080），也可以合併成一個 port，依請求的 content-type 分流。

### 效能不是選 gRPC 的理由

以 2,000 台估算：

- 心跳每 60 秒一次，約每秒 33 個請求。
- 完整資產資料每台每天約 20 KB，全公司約 40 MB。

這個量用 JSON 也綽綽有餘。gRPC 的價值在於強型別的介面定義與雙向串流。

### gRPC 的成本

- 編譯需要 `protoc`，可用 `protoc-bin-vendored` 內建，不必另外安裝。
- 除錯要用 `grpcurl` 之類的工具。
- nginx 需要 HTTP/2 與 gRPC 模組（1.13.10 以上，官方版本預設都有）。

### 替代方案

全部用 REST/JSON，指令通道改用 WebSocket。兩端都是 Rust，可以直接共用 serde 資料結構，同樣可行、架構更單純；代價是新舊版本的相容性要靠團隊自己的規範維持（例如新欄位一律 `#[serde(default)]`）。

## nginx 設定示意

```nginx
# Agent：gRPC + 用戶端憑證
server {
    listen 443 ssl;
    http2 on;                               # nginx 1.25.1 以前改寫在 listen 那行：listen 443 ssl http2;
    server_name agent.rustit.corp.local;
    ssl_certificate         /etc/nginx/certs/rustit.crt;
    ssl_certificate_key     /etc/nginx/certs/rustit.key;
    ssl_client_certificate  /etc/nginx/certs/rustit-agent-ca.pem;
    ssl_verify_client       optional;       # 首次註冊還沒有憑證

    location / {
        grpc_pass grpc://10.0.0.20:50051;
        grpc_set_header X-Client-Verify      $ssl_client_verify;
        grpc_set_header X-Client-Fingerprint $ssl_client_fingerprint;
        grpc_read_timeout 1h;               # 指令通道是長連線
        grpc_send_timeout 1h;
    }
}

# Web 後台 + REST API
server {
    listen 443 ssl;
    http2 on;
    server_name rustit.corp.local;
    ssl_certificate     /etc/nginx/certs/rustit.crt;
    ssl_certificate_key /etc/nginx/certs/rustit.key;

    location /api/ {
        proxy_pass http://10.0.0.20:8080;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    location / {
        root /srv/rustit/web;
        try_files $uri /index.html;
    }
}
```

主機名稱與 IP（`agent.rustit.corp.local`、`rustit.corp.local`、`10.0.0.20`）為示意，實際值待定。

## 待確認

- [ ] nginx 版本與模組：執行 `nginx -V`，確認版本 ≥ 1.13.10，並有 `http_ssl`、`http_v2` 模組。
- [ ] 這台 nginx 是否也服務其他系統？設定變更由誰負責審核？
- [ ] 目前的 `worker_connections` / `worker_rlimit_nofile` 設定值。
- [ ] Agent 用戶端憑證由誰簽發：公司既有的 AD CS，或 RustIt 自建 CA？
- [ ] 後端主機的內網 IP 與防火牆規則（只允許 nginx 連入）。
- [x] 最終採用 gRPC，或改用「全部 REST + WebSocket」的替代方案。→ **REST + WebSocket**（2026-10-01）
