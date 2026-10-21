# 後端修改紀錄(ItAgentBack)

新紀錄加在最上方;格式見 `AGENT.md` §10。本檔自 P7-1 起記錄 `ItAgentBack/` 的修改,先前的後端變更記在 `NewFeatures.md` / `BugFix.md`。

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
