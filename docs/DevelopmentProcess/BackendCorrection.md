# 後端修改紀錄(ItAgentBack)

新紀錄加在最上方;格式見 `AGENT.md` §10。本檔自 P7-1 起記錄 `ItAgentBack/` 的修改,先前的後端變更記在 `NewFeatures.md` / `BugFix.md`。

## 2026-10-20 P7-1 軟體目錄與下載、批次第二人核可、指令派送器擴充
- 內容:新功能細節見 `NewFeatures.md` 同日「P7-1 軟體目錄與下載(後端)」。後端既有程式的修改:
  - `CommandDispatcher`:`KindHook.check` 可回傳取代 `params` 的物件(目錄快照)、新增選填 `checkBatch`(整批檢查,單台也呼叫)、`apply` 改為選填;`createBatch` 可指定 `maxConcurrent`(1–20)並回傳 `state` / `requiresApproval`;admin 批次超過門檻建立為 `pending_approval`(指令有效期限另加 24 小時,核可時重設);`trySend` 不送待核可 / 駁回 / 逾期批次的指令;`limitedKinds` 全域並行上限與補送(指令結束、核可、每分鐘掃描);每分鐘掃描逾期的待核可批次;批次全部結束時 `state = done`(0008 之前的批次在畫面以「全部指令已結束」顯示 done)。
  - `SqlCommandStore`:查詢帶 `b.state`;建立批次寫 `requires_approval` / `state`;新增 `approveBatch`、`rejectBatch`、`expirePendingBatches`、`finishBatchIfDone`、`activeOfKinds`、`queuedOfKinds`。
  - `GET /v1/batches/{id}` 回應加 `state`、核可 / 駁回資訊;`POST /v1/batches/basic-commands` 回應加 `state`、`requiresApproval`(basic 批次一律 running)。
  - `release-files.ts` 的 realpath 檢查、SHA-256 快取與 `parseRange` 搬到 `rooted-files.ts`(行為不變,`release.test.ts` 照常通過)。
  - `system.reboot` 由「不認得的類型」變成 admin 類型:basic 路徑送它改回 `400 ENDPOINT_COMMAND_LEVEL_MISMATCH`(`commands.test.ts` 兩處預期隨之更新)。
  - 未設定 `SOFTWARE_DIR` 時 `software.*` 指令建立一律回 `404 ITA_PACKAGE_NOT_FOUND`(沒有目錄快照的軟體指令不可送到 Agent)。
- 部署注意:**必須先套用 migration 0008,再部署新版 endpoint-server**(新版所有指令查詢都讀 `command_batch.state`)。測試區 compose 已加 `SOFTWARE_DIR=/srv/software`(主機 2 `/srv/giganexus/ita-software` 唯讀掛載,目錄需事先建立)。
- 檔案:`ItAgentBack/src/services/command-dispatcher.ts`、`src/stores/{types,sql-command-store}.ts`、`src/routes/commands.ts`、`src/services/{release-files,rooted-files}.ts`、`src/server.ts`、`deploy/docker-compose.yml`、`test/{helpers,commands.test,scope.test}.ts`
- 驗證:`npm run typecheck`、`npm test` 199/199、`npm run test:int` 13/13、`npm run build`。
