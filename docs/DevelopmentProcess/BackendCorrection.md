# 後端修改紀錄(ItAgentBack)

新紀錄加在最上方;格式見 `AGENT.md` §10。本檔自 P7-1 起記錄 `ItAgentBack/` 的修改,先前的後端變更記在 `NewFeatures.md` / `BugFix.md`。

## 2026-10-28 重啟 Agent 後第一筆派送偶發下載 404(重連 hello 退回新連線已送出的指令)
- 內容:0.9.4 VM 重驗(報告 §11.4)重啟 Agent 後第一筆派送回 `DOWNLOAD_FAILED` 404 `ITA_PACKAGE_NOT_FOUND`。指令紀錄 send_count 1、sent_at .269、推送 .297、下載 .324、acked / started .328。根因:Agent 要等第一次蒐集(約 30 秒)才連 WebSocket;`connected()` 登記後就算在線,此時派送的指令由 `trySend()` 直接推送到新連線,接著 hello 處理完的 `onHello()` 以 `requeueSent(deviceRef)` 把該裝置**所有** sent 改回 queued,連剛推送到新連線的也一起改;Agent 立刻下載時 `download()` 的 `activeInstallPackages()`(sent / acked / running)查不到 → 404;Agent 的 running 又能從 queued 直接跳過去,所以 onHello 的重送沒送出、send_count 仍是 1。修正:`requeueSent(deviceRef, sentBefore?)` 只退回 `sent_at < sentBefore`;`onHello(ctx, deviceRef, connectedAt?)` 傳這條連線的登記時間(`DeviceService.connectedAt()`);連線已被取代或已關閉時不做 hello 補送(新連線的 hello / 斷線處理會處理)。斷線處理不變(全部退回)。Agent 不用改,無 migration。
- 已知限制(code-reviewer、security-auditor Low):以牆鐘比先後。① `trySend` 的 sent_at 取在 claim(SQL)之前,派送在途時新連線剛好登記,sent_at 早於 connectedAt 仍會被退回(極窄窗口,同樣的 404 仍可能發生,重派即可);② 舊連線上的指令與新連線登記同一毫秒,或主機時鐘被往後撥,舊連線上的指令不會被退回,卡在 sent 到逾期(佔並行名額,不越權、不重複執行)。根治要每條連線給序號並記在指令上(需加欄位 / migration),這次不做。
- 檔案:`ItAgentBack/src/{agent-app.ts,services/command-dispatcher.ts,services/device-service.ts,stores/types.ts,stores/sql-command-store.ts}`;測試 `test/{commands.test.ts,helpers.ts,int/stores.int.test.ts}`。
- 驗證:`npm run typecheck` 通過;`npm test` 226/226(新增:新連線已送出的維持 sent 不重送、舊連線的退回重送;`connectedAt` 取代 / 關閉回 null);`test:int` 14/14(本機 Docker Desktop + `giganexus_It_Agent_poc_test`,含 `requeueSent` 的 sentBefore 正反向)。

## 2026-10-27 P7 驗收後修正:延後回報、撤回釋放安裝檔路徑(migration 0010)
- 內容:需求方 2026-10-27 決定(設計 §8.1.5)。分支 `feature/p7-0.9.3`。(1)`command-dispatcher.ts` `deferredOf`:`software.install` 的 running 帶 `result.deferred`(只收 `battery` / `metered` 與可解析時間)時暫存為 result 並重設執行逾時(`CommandPatch.resetTimeout`,`sql-command-store.ts`);不帶時清除。(2)migration 0010:`uq_software_package_file` 改篩選唯一索引(只限未撤回),`unregisteredFiles` 不算已撤回;**只寫未套用**。
- 檔案:`src/services/command-dispatcher.ts`、`src/stores/types.ts`、`src/stores/sql-command-store.ts`、`src/services/software-service.ts`、`db/migrations/0010_software_file_release.sql`、`docs/DB_SCHEMA.md`;測試 `test/software.test.ts`、`test/software-helpers.ts`、`test/helpers.ts`、`test/int/stores.int.test.ts`。
- 驗證:`npm run typecheck` 通過、`npm test` 224/224、`test:int` 14/14(本機 Docker Desktop + `giganexus_It_Agent_poc_test`,含 0010 篩選索引:撤回後同檔重新登錄、未撤回仍佔用)。

## 2026-10-27 P7 VM 驗收修正:套件安裝逾時(migration 0009)、禁止 REMOVE=ALL 與 /v、版本與角色欄位
- 內容:需求方 2026-10-27 決定(設計 §8.1.4)。分支 `feature/p7-acceptance-fixes`。
  - B-1:migration `0009_software_timeout.sql`(`software_package.timeout_sec INT NOT NULL DEFAULT 1800`、CHECK 300–7200;既有資料以預設值補 1800)。**只寫未套用測試區**,需求方看過後再經同意套用 `giganexus_It_Agent_test`;部署順序:先 0009、再新版 endpoint-server。登錄 / 修改 API(schema + 服務層)驗範圍;取代固定的 `INSTALL_TIMEOUT_SEC`,`software.install` / `software.uninstall` 快照帶套件值;主機指令逾時 `commandTimeoutSec`(`commands/kinds.ts`)= 類型逾時 + 超過 1800 的部分(`command-dispatcher.ts` acked / running 時使用);修改逾時不退回 draft。
  - L2:`argsErrors` 拒絕 `REMOVE=ALL`;資安稽核 M1:Inno 以外拒絕 `v` 開頭的開關;契約向量同步。
  - B-2 / B-5:套件詳情的測試機結果加 `installedVersion`、`previousVersion`、`alreadyInstalled`(Agent 0.9.2 回報,`reportedVersion` 再淨化,資安 L3);詳情加 `viewerScopeAll`(GigaItApp 依此停用發佈)。
  - Gateway OpenAPI 不需要再發佈(2026-10-27 部署後確認:路由表不存請求 / 回應 schema,註冊結果不變、`pendingPublish: false`)。
- 檔案:`ItAgentBack/db/migrations/0009_software_timeout.sql`、`src/{commands/kinds.ts,routes/software.ts,services/software-service.ts,services/command-dispatcher.ts,stores/types.ts,stores/sql-software-store.ts}`、`test/{software.test.ts,software-helpers.ts,contract.test.ts,int/stores.int.test.ts}`、`docs/DB_SCHEMA.md`、`docs/PROJECT-MAP.md`。
- 驗證:`npm run typecheck` 通過;`npm test` 221/221;`test:int` 14/14(本機 Docker Desktop 的 Mongo / Redis + `giganexus_It_Agent_poc_test`,整合測試重建 schema 時已含 0009;測試區資料庫未動)。

## 2026-10-22 P7-5 新增 GET /batches 批次清單(給 GigaItApp 待核可清單)
- 內容:GigaItApp 軟體派送畫面需要「待核可批次清單」,原有 API 只能 `GET /batches/{id}`、`GET /commands`(無批次狀態篩選)。新增 `GET /v1/batches`(`endpoint.command.batch.list`,`endpoint.device.read`):`state`、`cursor`、`limit`(≤100)、新到舊;`state=pending_approval` 另限 24 小時核可期限內(逾期的等每分鐘掃描設為 expired);含資料範圍外電腦的批次略過(同 `getBatch`,E6),游標取自掃描到的最後一筆。需求方 2026-10-22 同意跨 repo 修改。部署後 Gateway 需再發佈 OpenAPI 批次。
- 檔案:`ItAgentBack/src/routes/commands.ts`、`src/services/command-dispatcher.ts`(`listBatches`)、`src/stores/{types,sql-command-store}.ts`(`listBatches`、抽出 `toBatch`)、`test/{helpers,software,scope}.test.ts`、`test/int/stores.int.test.ts`、`docs/contracts/command-kinds.md`、`docs/P7-SOFTWARE-DESIGN.md` §3.5
- 驗證:`npm run typecheck` 通過、`npm test` 212/212。**`test:int`(SQL 版 `listBatches`)尚未執行**:本機 Docker 未啟動,整合測試需要本機 Mongo / Redis;int 測試已寫在 `stores.int.test.ts` 批次核可案例末段,待能啟動 Docker 的環境執行。

## 2026-10-22 P7-4-1 NAS 唯讀掛載帳密腳本
- 內容:新增 `host2-set-nas-credentials.sh`(需求方在主機 2 WSL 以 sudo 執行,AI 不經手帳密):帳密以隱藏輸入寫入 root 專屬的 `/srv/giganexus/nas-secrets/rustit-nas.cred`(0400,不放 `ita-secrets`,避免被 chown 給容器內 node);以 CIFS 唯讀(`ro,nosuid,nodev,noexec`)掛載 `//10.10.130.31/docker-folder/RustIT` 到 `/srv/giganexus/nas-rustit`,檢查 `releases/`、`software/` 並做寫入測試確認唯讀;印出 `ita.env` 的 `ITA_RELEASES_HOST_DIR` / `ITA_SOFTWARE_HOST_DIR` 與 fstab 建議行,不自動改 `ita.env`、fstab 與 compose(compose 已支援這兩個變數,切換由需求方決定)。
- 檔案:`ItAgentBack/deploy/host2-set-nas-credentials.sh`、`docs/PROJECT-MAP.md`、`docs/HANDOFF.md`
- 驗證:`sh -n` 語法檢查通過;尚未在主機 2 執行(需 NAS 帳密與 cifs-utils)。

## 2026-10-22 P7-3 新增 system.reboot.cancel 指令類型
- 內容:`ItAgentBack/src/commands/kinds.ts` 新增 `system.reboot.cancel`(admin、無參數 `NO_PARAMS`、有效 1 小時 / 逾時 5 分鐘、每台未結束 1 筆);不受串行與累計核可限制(取消不造成破壞)。需求方 2026-10-22 決定 M2(設計 §8.1.3);Agent 端 0.9.0 實作(`AgentCorrection.md` 同日記錄)。部署後 GigaItApp 才能使用,「取消重新開機」按鈕屬 P7-5。
- 檔案:`ItAgentBack/src/commands/kinds.ts`、`ItAgentBack/test/contract.test.ts`、`docs/contracts/examples/ws-command-system-reboot-cancel.sample.json`(commit `1b383f7`)、`docs/contracts/command-kinds.md`。
- 驗證:`npm run typecheck` 通過,`npm test` 211/211(`1b383f7` 時,主工作階段執行)。契約測試隨 commit 更新(文件回寫未重跑)。

## 2026-10-21 P7-1 需求方決定 D1~D6 與資安稽核修補
- 內容:需求方決定 D1~D6 全部照建議;依資安稽核(2026-10-21 重跑)修補,細節與編號見 `P7-SOFTWARE-DESIGN.md` §8.1.1。
  - D2-1:同一人 24 小時內累計派送 > 20 台需第二人核可(軟體安裝 / 移除一組、`system.reboot` 一組);單台超過時建立待核可的單台批次,`CommandView` 加 `batchState`;「計數 → 建立」程序內序列化;`ita.command` 加索引 `ix_command_creator`。
  - D2-2(H3):`software_package.editors` 記錄上次發佈以來的修改人,發佈人不可在其中(新錯誤 `ITA_REVIEWER_SAME_AS_EDITOR`、`ITA_REVIEWER_NOT_PERSON`);改重開機政策也退回 `draft`(L1)。
  - D3(H2):安裝參數依 `installer_type` 逐一檢查,禁止讀寫外部檔案 / 改變安裝方式,路徑只限 Program Files;測試向量 `docs/contracts/install-args.vectors.json`。
  - D4:告警規則 `software_install_failed`、`reboot_pending`、`software_file_tampered`;`kindHooks.onFinal` 終態處理。
  - C1:`software_package.revoked_from`,只有從 `published` 撤回的套件可對所有電腦派送移除。M1:下載時雜湊不符取消此套件排隊中的安裝(`PACKAGE_FILE_CHANGED`);M2:退回 `draft` 取消尚未送出的 `software.*`(`PACKAGE_CHANGED`)、下載需快照與目錄一致;M3:有上限指令「計數 → 送出」序列化;M4:修改日誌記新舊值;M5:未發佈套件派測試機需全部公司角色;M6:清單只算已發佈套件的已安裝台數;L2/L3/L6/L7/L8/L9 見設計文件。
  - migration 0008(仍只套用 `_poc_test`)新增 `editors`、`revoked_from`、`ix_command_creator`,CHECK `ck_software_package_reviewer` 改寫。
  - 未修(HANDOFF「P7-1 資安稽核剩餘項目」):M1 主動定期重算雜湊、L4、L5、L10、L11;L12 接受(前提已有寫入權);L13 既有相依套件。
  - 測試發現:`sql-monitor-store.ts` 的 `reboot_since` 子查詢誤用 `ita.device.boot_time`(欄位在 `ita.device_inventory`),整合測試 P5 失敗、自動告警掃描整批失效;已在主工作階段修正(見測試報告)。
  - 核可路由(`07d5307`):非軟體批次(`system.reboot` 等)改走 `POST /v1/batches/{id}/approve-command`、`/reject-command`(`endpoint.command.admin`),軟體批次仍走 `/approve`、`/reject`(`endpoint.software.manage`),不符 `403 ITA_APPROVAL_ROUTE_MISMATCH`;只動路由與服務層。
- 檔案:`ItAgentBack/src/services/{software-service,command-dispatcher,alert-service}.ts`、`src/stores/{types,sql-software-store,sql-command-store,sql-monitor-store}.ts`、`src/routes/{alerts,commands,software}.ts`、`src/server.ts`、`db/migrations/0008_software.sql`、`docs/contracts/{command-kinds.md,install-args.vectors.json}`、`ItAgentBack/docs/DB_SCHEMA.md`、`test/*`
- 驗證:`npm run typecheck` 無錯誤;`npm test` 210/210;`npm run test:int` 13/13(`giganexus_It_Agent_poc_test`、本機 Docker Mongo / Redis)。第一次整合測試 12/13 的失敗與修正見 `docs/test-reports/2026-10-21-p7-1-backend.md`。

## 2026-10-20 P7-1 軟體目錄與下載、批次第二人核可、指令派送器擴充
- 內容:新功能細節見 `NewFeatures.md` 同日「P7-1 軟體目錄與下載(後端)」。後端既有程式的修改:
  - `CommandDispatcher`:`KindHook.check` 可回傳取代 `params` 的物件(目錄快照)、新增選填 `checkBatch`(整批檢查,單台也呼叫)、`apply` 改為選填;`createBatch` 可指定 `maxConcurrent`(1–20)並回傳 `state` / `requiresApproval`;admin 批次超過門檻建立為 `pending_approval`(指令有效期限另加 24 小時,核可時重設);`trySend` 不送待核可 / 駁回 / 逾期批次的指令;`limitedKinds` 全域並行上限與補送(指令結束、核可、每分鐘掃描);每分鐘掃描逾期的待核可批次;批次全部結束時 `state = done`(0008 之前的批次在畫面以「全部指令已結束」顯示 done)。
  - `SqlCommandStore`:查詢帶 `b.state`;建立批次寫 `requires_approval` / `state`;新增 `approveBatch`、`rejectBatch`、`expirePendingBatches`、`finishBatchIfDone`、`activeOfKinds`、`queuedOfKinds`。
  - `GET /v1/batches/{id}` 回應加 `state`、核可 / 駁回資訊;`POST /v1/batches/basic-commands` 回應加 `state`、`requiresApproval`(basic 批次一律 running)。
  - `release-files.ts` 的 realpath 檢查、SHA-256 快取與 `parseRange` 搬到 `rooted-files.ts`(行為不變,`release.test.ts` 照常通過)。
  - `system.reboot` 由「不認得的類型」變成 admin 類型:basic 路徑送它改回 `400 ENDPOINT_COMMAND_LEVEL_MISMATCH`(`commands.test.ts` 兩處預期隨之更新)。
  - 未設定 `SOFTWARE_DIR` 時 `software.*` 指令建立一律回 `404 ITA_PACKAGE_NOT_FOUND`(沒有目錄快照的軟體指令不可送到 Agent)。
- 部署注意:**必須先套用 migration 0008,再部署新版 endpoint-server**(新版所有指令查詢都讀 `command_batch.state`)。測試區 compose 已加 `SOFTWARE_DIR=/srv/software`(主機 2 `/srv/giganexus/ita-software` 唯讀掛載;不存在時 Docker 建立空目錄,軟體 API 照常運作、清單為空;放入安裝檔由需求方處理或經同意後經 `ssh host2` 複製,設計 §4)。
- 檔案:`ItAgentBack/src/services/command-dispatcher.ts`、`src/stores/{types,sql-command-store}.ts`、`src/routes/commands.ts`、`src/services/{release-files,rooted-files}.ts`、`src/server.ts`、`deploy/docker-compose.yml`、`test/{helpers,commands.test,scope.test}.ts`
- 驗證:`npm run typecheck`、`npm test` 199/199、`npm run test:int` 13/13、`npm run build`。
