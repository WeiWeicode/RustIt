# P3 資料呈現設計

> 草案 2026-10-16,分支 `docs/p3-design`(從 `gitlab/develop` b9c4ae2 開)。依據:PLATFORM-PLAN §3.3、§4.3、§4.10 A1、§5.1、§7、§8 P3 列;指南 ENDPOINT-AGENT-GUIDE §3.3、§8.2–§8.3。
> **2026-10-16 需求方確認**:§7 第 2 項改為**現在做分頁**、第 5 項 P3-1 ~ P3-3 都由 Claude 這次一起做,其餘照建議。

## 0. 現況與缺口

| 項目 | 現況(develop) | P3 要補 |
| --- | --- | --- |
| 詳情 API | `GET /v1/devices/{id}` 已回完整 `inventory`(camelCase) | 疑似同一台清單、合併 / 退役資訊 |
| 清單 API | 回全部裝置,無篩選 | 篩選:關鍵字(名稱、IP、MAC、裝置代碼、使用者)、軟體名稱、OS、在線、狀態;預設不列退役與已合併 |
| 軟體查詢 | 只存在 `device_inventory.payload`(NVARCHAR(MAX)) | 新資料表 `ita.device_software`,依名稱找電腦 |
| 事件 | `ita.device_event` 有資料(稽核 + 端點事件),沒有查詢 API | `GET /v1/devices/{id}/events` |
| 下載 JSON | 無 | `GET /v1/devices/{id}/inventory.json` |
| 硬體指紋 | P2 已寫 `hw_fingerprint`、`suspected_duplicate` 事件、`merged_into` / `retired_at` 欄位 | 合併、退役 API 與畫面 |
| GigaItApp 詳情 | 「概要」(硬體、安全、磁碟、網卡擠在一頁)+「指令」 | 分 Tab:概要 / 硬體 / 網路 / 軟體 / 安全與周邊 / 事件 / 指令 |

## 1. 分批

| 批 | 內容 | repo | 需要同意 |
| --- | --- | --- | --- |
| **P3-1** | migration `0004_device_software.sql`;清單篩選、`/events`、`/inventory.json`、疑似同一台;舊資料回填軟體表 | RustIt | migration 套用 `giganexus_It_Agent_test` 前 |
| **P3-2** | GigaItApp 詳情分 Tab、清單篩選列、下載 JSON | GigaItApp | 動 GigaItApp 前 |
| **P3-3** | 合併、退役 API(`endpoint.command.admin`)與畫面;`gateway-rbac.yaml` 新增按鈕節點 | RustIt、GigaItApp | 權限授予哪個角色(§7 第 3 項) |
| **P3-4** | 測試區驗證(§6) | — | VM 改名、簽新憑證由需求方執行 |

P3-1 ~ P3-3 由 Claude 一起做(需求方 2026-10-16)。

## 2. 資料表(`0004_device_software.sql`,SQL Server 2012)

```sql
-- 每台裝置最新一份資產的軟體清單,隨 saveInventory 整批替換(同 device_nic 做法)
CREATE TABLE ita.device_software (
  id           INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_device_software PRIMARY KEY,
  device_ref   INT            NOT NULL CONSTRAINT fk_device_software_device REFERENCES ita.device (id),
  name         NVARCHAR(400)  NOT NULL,
  version      NVARCHAR(100)  NULL,
  publisher    NVARCHAR(255)  NULL,
  install_date VARCHAR(16)    NULL   -- 原樣保存 Agent 的字串(登錄檔 yyyymmdd)
);
CREATE INDEX ix_device_software_device ON ita.device_software (device_ref);
CREATE INDEX ix_device_software_name ON ita.device_software (name) INCLUDE (device_ref);
```

- 只新增資料表,舊版服務不受影響。`name` 超過 400 字截斷(索引鍵上限 900 bytes)。
- **回填**:migration 不解析 JSON(SQL 2012 無 JSON 函式);服務啟動時對「有 inventory、沒有 software 列」的裝置,從 `payload` 解析後補寫一次(冪等,寫入失敗只記 warn)。
- 依名稱搜尋用 `LIKE N'%' + @q + N'%'`(跳脫 `%`、`_`、`[`);幾百台 × 數百筆在可接受範圍,量大時再改全文檢索。

## 3. 管理 API(`:51240`,對外 `/api/endpoint/*`)

| 方法 | 路徑 | `x-permission` | 說明 | 批 |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/devices` | `endpoint.device.read` | **分頁**:`page`(1 起)、`pageSize`(預設 50,上限 200),回應加 `total`、`page`、`pageSize`(`items` 不變;依電腦名稱排序)。查詢參數(皆可省略):`q`(電腦名稱、使用者、IP、MAC、裝置代碼,部分比對)、`software`(軟體名稱部分比對)、`os`、`online`(`true`/`false`)、`status`(`active`/`disabled`/`retired`,預設 `active,disabled`)。回應只新增欄位:`suspectedDuplicate`(boolean)、`mergedInto`(deviceId 或 null) | P3-1 |
| `GET` | `/v1/devices/{id}` | `endpoint.device.read` | 只新增:`suspectedDuplicates`(同硬體指紋、未合併的其他裝置摘要)、`mergedInto`、`retiredAt`、`clockSkewMs` | P3-1 |
| `GET` | `/v1/devices/{id}/events` | `endpoint.device.read` | 事件清單,依寫入順序新到舊;`?cursor=<上一頁 nextCursor>&limit=50`(上限 200),回 `{ items, nextCursor }`(與指令清單相同);欄位 `id`、`type`、`occurredAt`、`receivedAt`、`detail`、`data`(端點事件的 JSON) | P3-1 |
| `GET` | `/v1/devices/{id}/inventory.json` | `endpoint.device.read` | 最新資產原樣(資料契約 snake_case),`Content-Disposition: attachment; filename="<電腦名稱>-<yyyyMMdd>.json"`;無資產回 404 `ITA_INVENTORY_NOT_FOUND` | P3-1 |
| `PUT` | `/v1/devices/{id}/status` | `endpoint.command.admin` | 指南 §8.3 既有草案:`{ status: 'active' \| 'disabled' \| 'retired', reason }`;停用 / 退役時立即關閉 WebSocket。`x-audit-level: meta` | P3-3 |
| `POST` | `/v1/devices/{id}/merge` | `endpoint.command.admin` | `{ sourceDeviceId, reason, force? }`:把 `sourceDeviceId`(重灌後的新登錄)併入 `{id}`(舊裝置),見 §4。`x-audit-level: meta`;不用 `Idempotency-Key`,重送(含並行)回 `alreadyMerged: true` | P3-3 |

- 錯誤代碼只新增:`ITA_INVENTORY_NOT_FOUND`、`ITA_MERGE_INVALID`(`details.reason`:`same_device`、`fingerprint_mismatch`、`overlap`、`target_online`、`target_retired`、`source_not_active`、`source_merged`、`target_merged`)、`ITA_DEVICE_STATUS_INVALID`(已合併的裝置不能變更狀態)。
- 清單分頁在 service:SQL 依篩選取出全部符合的列,在線篩選(狀態在 Redis)後再分頁;台數到數千台時改為 SQL 分頁(無在線篩選時)。
- 資料範圍依 `cos` 過濾仍待指南 §10 E6,本階段不做。→ 2026-10-16 已另案完成(`E6-COMPANY-SCOPE-DESIGN.md`):清單只列所屬公司、範圍外回 404,回應加 `company`、`companySource`,新路由 `PUT /v1/devices/{id}/company`。

## 4. 合併(A1)

方向:**保留舊裝置**(deviceId、首次連線時間、指令紀錄不變),新登錄的裝置併入。單一 SQL 交易:

1. 前置檢查(service):不是同一台、目標不在線、目標未退役、來源為 active。**硬體指紋由端點自行回報,只是提示**(算法公開,知道 BIOS 序號與 UUID 即可偽造):指紋不同、或來源的首次連線早於目標最後回報超過 15 分鐘(兩台曾同時使用,不像重灌)時,需 IT 確認後帶 `force: true`。
2. 交易內鎖定兩列(`UPDLOCK, HOLDLOCK`)再檢查一次(並行的同一請求回 `alreadyMerged`)。
3. 來源的 `cert_dn` 改為 `merged:<來源 device_id>`(釋放唯一鍵),目標的 `cert_dn` / `cert_fp` / `computer_name` / `agent_version` / `hw_fingerprint` / 時鐘偏差改為來源的值(來源才是目前在用的那台);**目標的狀態不變**(不能藉合併解除停用 / 退役)。
4. 兩台尚未結束的指令一律取消(`DEVICE_MERGED`):舊裝置排隊的指令不可送到合併後連線的 Agent。之後 `device_event`、`command`(`command_batch` 不動)的 `device_ref` 由來源改為目標;端點事件 `event_uid` 唯一索引以 `(device_ref, event_uid)`,UUID 不會重複。
5. `device_inventory` / `device_nic` / `device_software`:取 `collected_at` 較新的一份放到目標,另一份刪除。
6. 來源設 `status = 'retired'`、`merged_into = 目標`、`retired_at`;目標寫 `merged` 事件(detail:來源 deviceId、舊 DN、操作人工號)。

交易後:**先關閉兩台的 WebSocket**(避免清理期間 Agent 仍以來源身分寫入;Agent 重連時依 DN 找到目標裝置,不需要改 Agent),再改 Mongo `snapshots` / `heartbeats` 的 `device_id`、清除 Redis 兩台的 hash 與來源的 online 鍵(失敗只記 warn,Mongo 可重建)。

退役:`status = 'retired'`、`retired_at`,關閉 WebSocket;Agent 之後連線回 403 `ITA_DEVICE_RETIRED`(P2 已實作)。資料依保存期限清除屬 B5,不在 P3。

## 5. GigaItApp(P3-2、P3-3)

| 位置 | 內容 |
| --- | --- |
| 電腦清單 | 篩選列:關鍵字、軟體名稱、OS、在線、顯示退役;欄位加「疑似同一台」標記 |
| 詳情 Tab | **概要**(狀態、使用者、OS、型號、序號、Agent、時鐘偏差、憑證;疑似同一台提示與「合併」按鈕)/ **硬體**(CPU、記憶體模組、實體磁碟、磁碟區、顯示卡、主機板與 BIOS)/ **網路**(網卡、IP、閘道、DNS、DHCP)/ **軟體**(表格 + 名稱篩選、筆數)/ **安全與周邊**(防毒、最近更新、USB 儲存原則與紀錄、RustDesk)/ **事件**(含 `offline_period`、`suspected_duplicate`、`clock_skew`)/ **指令**(既有) |
| 按鈕 | 「下載資產 JSON」(read);「合併」「退役」「停用 / 啟用」(新按鈕節點,`includes: [endpoint.command.admin]`) |

Tab 只在切換時載入(事件、軟體表格大),沿用 `DeviceCommands` 的做法。

## 6. 測試與驗證

- ItAgentBack:`device_software` 替換與回填、篩選參數(含 LIKE 跳脫)、`/events` 分頁、`inventory.json` 標頭、合併交易各檢查與回滾、退役後 403;`npm test`、`npm run test:int`(`giganexus_It_Agent_poc_test`)。
- 測試區(PLATFORM-PLAN P3 完成標準):
  1. 在 GigaItApp 依軟體名稱、IP、電腦名稱各找到 VM 與自己的電腦;各 Tab 有資料;下載 JSON 可開啟。
  2. **疑似同一台**:VM 還原檢查點只會沿用同一 DN,不會觸發。改為 VM 改電腦名稱 → 需求方以新名稱在主機 2 執行 `host2-issue-test-device-cert.sh` 簽新憑證並匯入(舊憑證移除)→ 重啟服務 → 出現新裝置且標記「疑似同一台」。
  3. 合併後:清單只剩一台、deviceId 為舊的、事件與指令紀錄連續、Agent 自動重連到舊裝置;退役另一台測試裝置後 Agent 連線被拒。

## 6.1 實作與驗證(2026-10-16,分支 `feature/p3-data`、GigaItApp `feature/p3-device-tabs`)

- ItAgentBack:`npm test` 104 項、`npm run test:int` 9 項(SQL Server 2012 `giganexus_It_Agent_poc_test`:軟體表與回填、篩選、事件、狀態、兩種方向的合併與指令取消)全部通過;本機 ItAgentBack(唯讀)對 `giganexus_It_Agent_test` 實測分頁、關鍵字、OS、退役篩選、事件游標、下載 JSON 標頭、詳情的時鐘偏差。軟體名稱篩選在 0004 套用前回 503(預期,確認部署順序)。
- 整合測試抓到:`LIKE N'%"software":[{%'` 的 `[` 在 SQL Server LIKE 是字元集合開頭,改為跳脫。
- `code-reviewer`、`security-auditor` 子代理審查後的修正:合併後先關閉 WebSocket 再清理;回填改游標並在交易內鎖住資產列重讀(與資產寫入不重複、不飢餓,無法解析的記 warn);合併不覆蓋目標狀態、目標退役或來源停用 / 退役拒絕;合併取消兩台未完成的指令(避免偽造指紋取得舊裝置的排隊指令);新登錄早於舊裝置最後回報需 force;並行重送回 `alreadyMerged`;`setStatus` 交易內確認未合併;LIKE 參數長度放寬為跳脫後上限;交易後也關閉目標連線。
- **未處理(已知)**:資料範圍依 `cos` 過濾(指南 §10 E6)仍未做,目前有 `endpoint.device.read` 即可看全部公司的電腦、有 `endpoint.command.admin` 即可管理全部;上線前必須完成(列入指南 §11)。→ 2026-10-16 已完成並上測試區(`E6-COMPANY-SCOPE-DESIGN.md` §6.1)。合併路由尚未寫入指南 §8.3 表格(需 Gateway repo 同意)。
- **部署與測試區驗證**(2026-10-16):1. migration 0004 套用到 `giganexus_It_Agent_test` → 2. RustIt 合併 develop(MR !23,OpenAPI 批次 110 已發佈,建立 `endpoint.command.admin`,啟動時回填 3 台軟體清單)→ 3. GigaItApp 合併 develop(MR !4、!5,rbac-test 套用 `it.endpoint-device.admin`)。測試區 VM(`DESKTOP-1TB2UMP`,Agent 0.4.1)實測:清單分頁 / 篩選、7 個 Tab、下載 JSON、**停用 → 啟用(期間排隊指令於重連後送出)、退役 → 改回使用中皆正常**;VM 改名重簽憑證驗證「疑似同一台」與合併尚未測。
- **P3-4 測試區驗證(2026-10-19)**:VM 改名 `RUSTIT-P34` 並換新憑證 → 出現疑似同一台 → 合併後 deviceId、首次連線、事件都連續。第一次合併後 Agent 暫停 10 分鐘才重連(close 4403 被當成停用),MR !27 改用 close 4410 後重測，合併後 1 秒重連。另外 Agent 0.4.2(MR !28)停用改每 1 分鐘重試。見 `test-reports/2026-10-19-p3-merge-e6-scope.md`。**P3 完成標準全部達成。**

## 7. 決定事項(2026-10-16)

| # | 問題 | 建議 |
| --- | --- | --- |
| 1 | 軟體查詢用新資料表 `ita.device_software`(migration 0004),還是直接 `LIKE` 搜 `payload` | **新資料表**:可依名稱建索引,軟體 Tab 與之後 P5 軟體增刪比對也用得到 |
| 2 | 清單要不要現在做分頁(指南 §8.3 寫「分頁」) | ~~先不做~~ → **決定:現在做**(主機端分頁,§3) |
| 3 | 合併、退役、停用用 `endpoint.command.admin`(指南 §8.2 已定義「停用 / 啟用裝置」屬此等級),目前只授予 it-admin? | **用 admin、只給 it-admin**;admin 路徑原訂 P6 才開,這次先開裝置狀態與合併兩條,指令的 `admin-commands` 仍等 P6 |
| 4 | 合併方向:保留舊裝置(deviceId 不變) | **保留舊裝置**(PLATFORM-PLAN A1 原文「併入舊裝置」) |
| 5 | P3-1 / P3-2 誰寫 | **決定:Claude 這次一起做**,不交給同仁 |
| 6 | 「事件」Tab 放 P3 還是 P5 | **P3 先做清單**(合併前要看得到 `suspected_duplicate`);P5 再加軟硬體變更事件與告警 |
| 7 | 變更歷程(`/history`,Mongo 快照)| **延到 P5**(與軟硬體變更比對一起做) |
