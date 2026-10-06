# ItAgentBack — RustIt Endpoint Server(Node.js)

Fastify + TypeScript。兩個 listener、兩套信任來源(RustIt `AGENT.md` §7.2、Gateway `ENDPOINT-AGENT-GUIDE.md` §5):

| Port | 服務代碼 | 對象 | 身分 |
| --- | --- | --- | --- |
| 51240 | `endpoint-api` | 管理 API `/v1/devices[/{deviceId}]`(對外 `/api/endpoint/...`,權限 `endpoint.device.read` 由 BFF 檢查) | `X-Internal-Token`(aud = `endpoint-api`) |
| 51241 | `endpoint-agent` | Agent 通道 `POST /agent/v1/inventory`、WS `/agent/v1/ws`(經 Gateway `:9443`) | Nginx 的 `x-client-cert-dn` / `-fp` / `x-client-verify` |

儲存:SQL Server(唯一真相)、MongoDB(快照歷史)、Redis(在線狀態);結構見 [docs/DB_SCHEMA.md](docs/DB_SCHEMA.md)。資料契約在 `../docs/contracts/`(與 RustAgent 共用,不複製)。

## 本機開發

```bash
cp .env.example .env            # 填 ITA_DB_PASSWORD、ITA_MIGRATE_PASSWORD、ITA_MONGO_PASSWORD、ITA_REDIS_PASSWORD(連線字串內的密碼一致)
npm install                     # @giganexus/backend-sdk 取自 GitLab npm Registry,需環境變數 GITLAB_NPM_TOKEN
docker compose -f deploy/docker-compose.dev.yml --env-file .env up -d   # Mongo / Redis,只綁 127.0.0.1
npm run db:migrate              # 以 ita_migrate 套用 db/migrations
npm run dev                     # dev 預設只聽 127.0.0.1
```

- dev 旁路:`DEV_TRUST_CLIENT_HEADERS=1`(本機 Agent 直連,自帶憑證標頭)、`DEV_SKIP_TOKEN=1`(本機 GigaItApp 直連);`GW_ENV` 非 `dev` 時有設定就啟動失敗。
- Windows 若保留了 51176–51275(`netsh int ipv4 show excludedportrange protocol=tcp`),本機 `.env` 改 `PORT=51290`、`AGENT_PORT=51291`;測試區 / 正式區固定 51240 / 51241。
- Agent:`cd ../RustAgent && cargo run -p rustit-agent -- run --config crates/agent/agent.dev.toml`。

## 指令

| 指令 | 說明 |
| --- | --- |
| `npm test` | 單元與契約測試(記憶體儲存,不需資料庫) |
| `npm run test:int` | 整合測試:真實 SQL Server(`ITA_TEST_DB_NAME`,必須是 `*_poc_test`,每次清空重建)+ 本機 Mongo / Redis |
| `npm run typecheck` / `npm run build` | 型別檢查 / 建置(只取 `src/`) |
| `npm run db:migrate` | 套用 migration(容器內 `node dist/src/migrate.js`) |
| `npm run -s openapi` | 輸出管理 API 的 OpenAPI |
