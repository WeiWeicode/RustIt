# S1 簽章上架優化:設計(ADR 0005 第一階段)

> 草案 2026-10-28,分支 `docs/s1-signing-design`(疊在 `docs/adr-0005-signing-pipeline` 上,MR !73 合併後改以 develop 為基底)。依據:[ADR 0005](decisions/0005-signing-and-publishing-pipeline.md) §分階段 S1、[ADR 0003](decisions/0003-code-signing-pki.md)、[RUNBOOK](RUNBOOK.md) §1、[P7-SOFTWARE-DESIGN](P7-SOFTWARE-DESIGN.md) §3、§4、§8.2-13、§8.2-14;甘特圖 W6-25。
> **狀態**:需求方 2026-10-28 確認 §9 全部照建議(A),並同意 Gateway、GigaItApp 跨 repo 修改。S1-2 `release` 模式完成;**S1-1 程式完成**(分支 `feature/s1-1-release-registry`、Gateway `feature/openapi-api-key-auth`),待 Gateway 合併部署、IT 建立 API Key 後實測;S1-3 起未開工。

## 0. 範圍

S1 的目標:正式區上線前,**簽章人員不需要主機管理權**、**IT 不需要直接寫軟體庫**、套件**送簽要經第二人核可**。仍用測試憑證、仍在簽章人員電腦執行簽章(專用簽章機是 S3)。

| 子階段 | 內容 | 改哪裡 | 擋在哪 |
| --- | --- | --- | --- |
| **S1-1 版本查重改走 API** | `publish-release.ps1` 的版本表查詢改呼叫唯讀 API(API Key),移除 ssh + root + SQL 帳號(§8.2-13) | ItAgentBack 新增唯讀路由;**Gateway 支援 OpenAPI 宣告 `api_key` 路由**;腳本 | Gateway 修改需同意(§9-1) |
| **S1-2 簽章工作站(手動版)** | 新腳本 `signing-workstation.ps1`:`release` 模式 = 簽章 + 上架一次完成;`software` 模式 = 處理 NAS 送簽佇列 | RustAgent/installer | 無(可先做) |
| **S1-3 套件上傳與送簽(後端)** | 上傳到 NAS `incoming\`、送簽核可(上傳者 ≠ 核可人)、寫送簽工作單、讀簽章結果 | ItAgentBack、migration 0011、compose 掛載 | 上傳方式(§9-2)、核可角色(§9-3) |
| **S1-4 GigaItApp 畫面** | 「軟體庫 › 上傳」「待簽章」「核可簽章」 | GigaItApp | S1-3 API;跨 repo 需同意 |
| **S1-5 NAS 權限** | `RustIT\test` / `RustIT\prod` 寫入群組分開(§8.2-14),新增 `incoming\`、`sign-queue\` 的權限 | NAS 管理員 | 需求方安排 |

**S1 不做**:正式憑證、端點信任清單改為只信任公司指紋(S2)、專用簽章機與自動常駐(S3)、Agent 依 CA + 範本比對(可選)。

**順序**:S1-2 先做(不依賴任何決定)→ S1-1(Gateway 同意後)→ S1-3 → S1-4;S1-5 平行。

## 1. NAS 目錄與權限(S1-5)

每區(`test` / `prod`)各一套,兩區寫入群組分開:

| 目錄 | 內容 | endpoint-server(主機掛載) | 簽章工作站 / 簽章人員 | IT |
| --- | --- | --- | --- | --- |
| `RustIT\<區>\releases\` | Agent / Watchdog 已簽章版本檔(現況) | 唯讀 | 讀寫 | — |
| `RustIT\<區>\software\` | 派送套件(**只放已簽章的檔案**) | 唯讀 | 讀寫 | 讀(S1 起不再寫) |
| `RustIT\<區>\incoming\` | 上傳的原始安裝檔(未簽) | **讀寫** | 唯讀 | 依 §9-2 |
| `RustIT\<區>\sign-queue\` | 送簽工作單(`<uploadId>.json`)與簽章結果(`<uploadId>.result.json`) | **讀寫** | 讀寫 | — |

- 主機仍**寫不到** `software\` 與 `releases\`:主機被入侵也不能自己放檔案進軟體庫,只能寫工作單,而工作單要過簽章工作站的獨立檢查(§3.3)。
- endpoint-server 新增兩個讀寫掛載 `INCOMING_DIR`、`SIGN_QUEUE_DIR`(compose:`/srv/giganexus/nas-rustit/<區>/incoming`、`/sign-queue`);主機 2 的 NAS 掛載腳本(`host2-set-nas-credentials.sh`)要加這兩個子目錄的讀寫掛載,其餘維持唯讀。

## 2. S1-1 版本查重改走 API

### 2.1 現況與問題

`publish-release.ps1` 2a 步經 `ssh host2` → `wsl -u root -e docker exec endpoint-server node -e …`,在容器內用 endpoint-server 的 SQL 帳號(有寫入權)查 `ita.agent_release`。簽章人員因此要有主機 root 權限;唯讀只靠程式碼。

### 2.2 做法

- ItAgentBack 新增 `GET /v1/releases/registry?component=&version=`(operationId `endpoint.release.registry`):回 `{ "environment": "test", "items": [{ component, version, status }] }`;只查詢、不含檔案路徑與簽章者。`environment` 取自 `GW_ENV`,腳本以此確認查到的是目標區(取代現在比對資料庫名稱,資安稽核 M1)。
- Gateway 路由 `auth_mode = api_key`,權限代碼 `endpoint.release.registry`(新):IT 在 Gateway 建立 API Key `rustit-publish-<區>`,只授這個權限、限定來源 IP(簽章人員電腦 / 簽章機)。
- 腳本加 `-ApiKeyFile <路徑>`(檔案只有本人可讀;不接受命令列明文),以 `X-Api-Key` 呼叫 `https://<gateway>/api/endpoint/releases/registry`;`-SkipRegistryCheck` 保留。ssh 只剩「放好後確認主機唯讀掛載讀得到」(`-MountCheckDir`),該步改為可選(預設關閉,改由 `GET /v1/releases/files` 確認:檔案出現在未登錄清單即代表主機讀得到——這支是使用者路由,改由腳本印出提示,登錄畫面自然會看到)。

### 2.3 需要 Gateway 修改(跨 repo)

Gateway 的 OpenAPI 轉路由(`bff/src/cli/openapi.ts`)目前只產生 `public` / `authenticated` / `permission`,**不能宣告 `api_key` 路由**;自動註冊(`autoRegister`)也同樣。兩個做法:

| 做法 | 改動 | 缺點 |
| --- | --- | --- |
| **A. OpenAPI 擴充 `x-auth-mode: api_key`(建議)** | Gateway `openapi.ts` 讀 operation 的 `x-auth-mode`(只接受 `api_key`),`authMode = api_key`、`x-permission` 為 API Key 須具備的權限;BACKEND-GUIDE §6 補說明;Gherkin `service-registration.feature` 補場景 | 要改 Gateway 並發版 |
| B. IT 在路由管理手動把該路由改為 `api_key` | 不改程式 | 每次自動註冊重新產生草稿時可能被蓋回 `permission`;容易忘 |

## 3. S1-2 簽章工作站(手動版)

新腳本 `RustAgent/installer/signing-workstation.ps1`,在簽章人員電腦執行;**不取代** `sign-release.ps1` / `publish-release.ps1`(兩者保留,工作站呼叫它們的核對邏輯,避免兩份實作)。S3 時同一支腳本搬到專用簽章機以排程執行。

### 3.1 `release` 模式

```
signing-workstation.ps1 release -Artifact <CI 產物 zip 或解壓目錄> -Environment test -Thumbprint <指紋> [-ApiKeyFile <檔>]
```

一次完成:解壓(zip 時)→ `sign-release.ps1` 的核對與簽章 → `publish-release.ps1` 的核對、查重、放到 NAS → 印出登錄資料。任一步失敗就停止,不會「簽了但沒放」又不知道。

### 3.2 `software` 模式

```
signing-workstation.ps1 software -Environment test -Thumbprint <指紋> [-Job <uploadId>] [-DryRun]
```

逐筆處理 `sign-queue\*.json`(沒有 `.result.json` 的):

1. 讀工作單(§4.3 格式),檢查欄位與路徑規則(三段路徑、副檔名,與 `software-files.ts` 相同)。
2. 從 `incoming\` 複製到本機暫存,**重算 SHA-256 = 工作單的 `sha256`**;不符 → 結果 `rejected / HASH_MISMATCH`。
3. **廠商原簽章檢查(工作站自己的規則,不聽主機)**:`Get-AuthenticodeSignature`;
   - 有效且簽章者指紋在工作站本機 `vendor-signers.json`(簽章人員維護,不進 repo 的實際清單;repo 只放範例)→ 可簽;
   - 未簽章 / 不在清單 / 無效 → 停下來顯示檔案資訊,**簽章人員輸入 `yes` 才簽**(第一階段本來就是人工);`-Unattended`(S3 用)時直接 `rejected / VENDOR_NOT_ALLOWED`。
4. 以軟體發佈憑證 `signtool sign /fd SHA256 /tr <時間戳記> /td SHA256 /sha1 <指紋>` 簽章(會**取代**原有簽章),`signtool verify /pa`。
5. 不覆蓋地放到 `software\{軟體}\{版本}\{檔名}`(沿用 `publish-release.ps1` 的暫存檔 → 重算 → `File.Move` 作法)。
6. 寫 `<uploadId>.result.json`(§4.3),最後才寫,寫入即代表完成。

> **待驗證(ADR 0005「先做」第 2 項)**:重簽會取代廠商簽章、改變檔案的簽章區,少數自解壓 / 自我檢查的安裝程式可能失效。S1-2 完成後先在 VM 以 Notepad++(NSIS)驗證,失敗就退回「附加簽章 `/as`」或改設計。

## 4. S1-3 套件上傳與送簽(後端)

### 4.1 流程

```
上傳(IT)─► uploaded ─(第二人核可)─► queued ─(工作站)─► signed ─► 一般 P7 登錄(draft → tested → published)
                    └─(駁回)─► rejected            └─(工作站拒絕)─► rejected
```

- **既有 P7 流程不改**:`signed` 之後,檔案已在 `software\`,出現在「尚未登錄的安裝檔」,IT 照現在的方式登錄。登錄時若該檔案來自上傳紀錄,自動帶入原廠簽章者、上傳者、核可人供覆核參考。
- S1 期間仍允許簽章人員直接把檔案放進 `software\`(過渡);S2 起登錄時要求檔案有對應的 `signed` 上傳紀錄(§9-5)。

### 4.2 資料(migration 0011,`ita.software_upload`)

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `upload_id` | `UNIQUEIDENTIFIER` PK | |
| `software` / `version` / `file_name` | `NVARCHAR(100)` ×3 | 目標三段路徑(與 `software-files.ts` 同規則) |
| `incoming_path` | `NVARCHAR(400)` | `incoming\` 內的相對路徑(`{upload_id}\{file_name}`) |
| `sha256` / `size_bytes` | `CHAR(64)` / `BIGINT` | 上傳完成時計算 |
| `state` | `VARCHAR(16)` | `uploaded` / `queued` / `signed` / `rejected`(CHECK) |
| `uploaded_by_emp` / `uploaded_at` | | |
| `approved_by_emp` / `approved_at` | | 送簽核可人;**≠ uploaded_by_emp**(服務層 + CHECK) |
| `reject_code` / `reject_reason` / `rejected_by` | | 駁回或工作站拒絕 |
| `vendor_signer` / `vendor_signer_subject` | | 工作站回報的原廠簽章者(未簽章為 NULL) |
| `signed_sha256` / `signed_signer` / `signed_at` | | 工作站結果;主機另以 `software\` 實際檔案重算比對 |
| `row_ver` | `ROWVERSION` | 狀態條件更新 |

### 4.3 送簽工作單與結果(檔案契約,`docs/contracts/sign-job.schema.json`)

```json
{ "schema": "sign-job/1", "upload_id": "…", "environment": "test",
  "software": "Notepad++", "version": "8.7.1", "file_name": "npp.8.7.1.Installer.x64.exe",
  "incoming_path": "…/npp.8.7.1.Installer.x64.exe", "sha256": "…", "size_bytes": 1234,
  "uploaded_by": "S1xxxxx", "approved_by": "S1yyyyy", "approved_at": "…" }
```

```json
{ "schema": "sign-result/1", "upload_id": "…", "state": "signed",
  "vendor_signer": "…|null", "vendor_signer_subject": "…|null", "vendor_check": "allowlist|manual",
  "signed_file": "Notepad++/8.7.1/npp.8.7.1.Installer.x64.exe", "signed_sha256": "…", "signed_signer": "…",
  "signed_at": "…", "operator": "<Windows 帳號>", "reject_code": null }
```

endpoint-server 每分鐘掃 `sign-queue\*.result.json`:`signed` 時**重算** `software\` 實際檔案的 SHA-256 必須等於 `signed_sha256`,不符記 `rejected / RESULT_MISMATCH` 並告警;不採信結果檔自報的其他欄位作為安全判斷(只做顯示)。

### 4.4 API(`/v1/software/uploads`,`endpoint.software.manage`)

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `POST` | `/v1/software/uploads` | 上傳(§9-2 決定方式);回 `uploadId`、`sha256` |
| `GET` | `/v1/software/uploads?state=` | 清單 |
| `POST` | `/v1/software/uploads/{id}/approve` | 第二人核可送簽(≠ 上傳者、需全部公司角色);寫工作單 → `queued`;`x-audit-level: meta` |
| `POST` | `/v1/software/uploads/{id}/reject` | 駁回(`uploaded` / `queued`) |

### 4.5 上傳方式(§9-2)

安裝檔常超過 100 MB(上限 `SOFTWARE_MAX_BYTES` 4 GB);BFF 本體上限 10 MB,`giga-file-service` 單檔 30 MB,**都不夠**。

| 做法 | 改動 | 評估 |
| --- | --- | --- |
| **A. Gateway Nginx 直送(建議)** | 比照 `/api/file/files`:`location = /api/endpoint/software/uploads` POST 以 `auth_request` 向 BFF 驗證(登入、權限、CSRF)後**串流**到 `endpoint-api`,`client_max_body_size 4g`、`proxy_request_buffering off`;endpoint-server 邊收邊算 SHA-256 寫入 `incoming\` | 一致的網頁操作;要改 Gateway `portal.conf`(跨 repo) |
| B. IT 以 SMB 放 `incoming\`,畫面「登錄上傳」 | 不改 Gateway;IT 要有 `incoming\` 寫入權 | 仍是手動放檔,但不再碰 `software\`;可當 A 的過渡 |

## 5. S1-4 GigaItApp 畫面(跨 repo)

「端點管理 › 軟體目錄」新增「上傳與簽章」Tab:上傳(A)/ 登錄 incoming 檔案(B)、清單(狀態、上傳者、核可人、原廠簽章者)、核可 / 駁回按鈕(**上傳者本人的核可按鈕停用**,沿用 P7 發佈按鈕依角色停用的作法)。權限沿用 `endpoint.software.manage`;按鈕權限碼依 §9-3。

## 6. 安全

| 威脅 | 防線 |
| --- | --- |
| 單一 IT 帳號被盜,上傳惡意程式取得公司簽章 | 送簽要第二人核可;工作站對非白名單廠商要人工確認 |
| 主機被入侵,偽造工作單 | 主機寫不到 `software\`;工作站重算雜湊、獨立的廠商白名單;每筆簽章都有結果檔與稽核 |
| 結果檔被竄改 | 主機重算 `software\` 實際檔案雜湊;後續 Agent 仍驗 Authenticode 與本機信任清單 |
| API Key 外洩(S1-1) | 只授唯讀 `endpoint.release.registry`、限定來源 IP、可隨時停用 |
| 跨區誤放 | 工作單帶 `environment`,工作站只處理與 `-Environment` 相同的;NAS 兩區寫入群組分開 |

## 7. 測試

- **ItAgentBack**:`software-upload-service` 單元測試(狀態機、上傳者 ≠ 核可人、全部公司角色、路徑規則、重複上傳同一路徑、結果檔雜湊不符);`registry` 路由(只回指定欄位、`environment`);契約測試吃 `docs/contracts/examples/sign-job*.json`;`test:int` SQL store 狀態條件更新。
- **腳本**:`signing-workstation.ps1 -DryRun`;Pester 測試工作單驗證(路徑、雜湊、環境不符)。
- **VM 驗收**:Notepad++(NSIS)、7-Zip(MSI)經上傳 → 核可 → 工作站簽章 → 登錄 → pilot 派送成功;非白名單廠商需人工確認;偽造工作單(雜湊不符)被拒。

## 8. 文件

- RUNBOOK §1 改為工作站 `release` 模式;新增「套件上傳與送簽」章節;§4 廠商換憑證在 S2 後簡化。
- `PROJECT-MAP.md`、`contracts/README.md`、Gateway `ENDPOINT-AGENT-GUIDE`(新路由與 API Key,需同意)、架構 JSON(新目錄與流程)。

## 9. 待確認

> 需求方 2026-10-28:全部照建議(粗體選項),同意跨 repo 修改。

| # | 問題 | 選項(建議在前) |
| --- | --- | --- |
| 1 | S1-1 是否同意改 Gateway,讓 OpenAPI 宣告 `api_key` 路由 | **A. 加 `x-auth-mode: api_key`(Gateway MR)** / B. IT 手動改路由 / C. S1-1 延後,先維持 ssh 查詢 |
| 2 | 套件上傳方式 | **A. Gateway Nginx 直送(Gateway MR)**,過渡期先做 B / B. 只做 SMB 放 `incoming\` |
| 3 | 送簽核可人 | **A. 另一位 `endpoint.software.manage` 且可管理所有公司的人(與 P7 發佈第二人同一群人)** / B. 新角色「簽章核可」只給簽章人員與 IT 主管 |
| 4 | 是否同意 `release` 模式整合簽章與上架(舊腳本保留) | **同意** / 不需要 |
| 5 | S1 期間是否仍允許直接放檔案到 `software\` | **S1 允許(過渡)、S2 起要求有 signed 上傳紀錄** / 立即禁止 |
| 6 | 工作站廠商白名單初始內容 | **Notepad++、7-Zip(未簽,需人工)兩筆,其他遇到再加** / 不設白名單、每筆人工 |
| 7 | 開發順序 | **S1-2 → S1-1 → S1-3 → S1-4** / 先做上傳(S1-3、S1-4) |
