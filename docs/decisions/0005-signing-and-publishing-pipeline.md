# 0005：簽章與上架流程改善（簽章工作站、ITApp 上傳、公司重簽）

- 日期：2026-10-28
- 狀態：建議中（待需求方確認「待決事項」；依賴 [0003](0003-code-signing-pki.md) 的 AD CS 確認）
- 相關：[0002](0002-software-deployment.md)（軟體派送）、[0003](0003-code-signing-pki.md)（程式碼簽章與 PKI）、[RUNBOOK](../RUNBOOK.md) §1（Agent 發版）、§4（廠商換憑證）、[P6-UPGRADE-DESIGN](../P6-UPGRADE-DESIGN.md)、[P7-SOFTWARE-DESIGN](../P7-SOFTWARE-DESIGN.md) §3.3、§5.2、§8.2-13、§8.2-14

## 背景：目前的流程（測試區）

| 流程 | 目前做法 | 問題 |
| --- | --- | --- |
| Agent / Watchdog 發版 | CI `build:release` 產出未簽章檔 → 簽章人員下載到**自己的電腦**執行 `sign-release.ps1` → `publish-release.ps1` 經 ssh 以 root 進主機 docker、用 endpoint-server 的 SQL 帳號登錄草稿 | 綁在一台個人電腦與一個人；簽章人員要有主機管理權（§8.2-13） |
| 監控 MSI | 開發機執行 `build-agent-msi.ps1`（設定隨部署區寫入） | 同上 |
| 軟體派送套件 | IT 直接把安裝檔放進 NAS `RustIT\<區>\software`；廠商沒簽章的（7-Zip MSI）由簽章人員加簽；端點 `[software] trusted_signers` 列**各廠商**的葉憑證指紋，由 MSI / GPO 寫入 | 每新增一個廠商、廠商每年換憑證，都要更新全公司 GPO（RUNBOOK §4 六個步驟）；NAS 兩區寫入權只靠腳本分開（§8.2-14） |

這些是測試階段的過渡做法：正式憑證（AD CS）尚未確認，私鑰暫放簽章人員電腦。

## 結論

1. **軟體套件改由 GigaItApp 上傳登錄**，不再由 IT 手動放 NAS。
2. **所有派送套件一律以公司「軟體發佈憑證」重新簽章**；端點 `[software] trusted_signers` 只列公司自己的指紋（新舊並列，1–2 個），不再列廠商指紋。廠商換憑證不再影響端點。
3. **不採用「主機下發本機信任清單」**：本機清單是主機改不了的防線（P7 §5「兩人覆核三道」之一），主機可改就等於主機被入侵即可對全公司以 SYSTEM 執行任意程式。
4. **Agent 發版與軟體重簽共用一個「簽章工作站」程式**：只從 NAS 佇列拉工作、不開任何連入 port、只簽已核可且雜湊相符的檔案。第一階段在簽章人員電腦手動執行（即「地端工具」），第二階段搬到專用簽章機常駐。同一支程式，換執行位置。
5. **上架腳本不再經 ssh root 與 SQL 寫入帳號**：登錄改走 GigaItApp（讀取簽章工作站輸出、由 endpoint-server 驗證）。
6. **Agent 發版憑證與軟體發佈憑證分開**：分別對應端點 `[upgrade]`、`[software]` 兩個信任清單（P7 M3 已分開），一張外洩不影響另一條通道。

## 目標流程

### 軟體派送

```
IT 在 GigaItApp 上傳安裝檔
  → endpoint-server 存入 NAS incoming\、算 SHA-256、檢查廠商原簽章（記錄，作為覆核資料）、建立 draft（未簽）
  → 第二人（簽章核可角色，≠ 上傳者）在 GigaItApp「核可簽章」
  → endpoint-server 在 NAS sign-queue\ 寫入工作單（檔名、SHA-256、核可人）
  → 簽章工作站拉工作：再驗雜湊 → 依本機規則檢查廠商原簽章 → 以軟體發佈憑證簽章 → 寫入 signed\ 與簽章紀錄
  → endpoint-server 驗證簽章者 = 設定的軟體發佈憑證指紋 → draft 可派 pilot
  → pilot 測試「已重簽的檔案」→ tested → 第二人 published（沿用 P7 狀態機）
```

- **先簽再測**：pilot 測的必須是最後派送的同一個檔案。重簽會換掉檔案的簽章區，少數自解壓 / 自我檢查的安裝程式可能因此失效，pilot 測試會抓到。
- **簽章前要兩個人**：上傳者 ≠ 核可簽章者。否則單一 IT 帳號被盜就能取得公司簽章，直接推到 pilot 環。
- **簽章工作站的獨立規則**（不聽主機的）：本機維護「可接受的廠商簽章者」清單；廠商原簽章有效且在清單內才自動簽，未簽章或不在清單內的檔案要在工作站上人工確認（第一階段本來就是人工）。主機被入侵時，攻擊者偽造的工作單過不了這一關。
- 每筆簽章寄通知給簽章人員（逐人寄，見 W10 通知規則），並設每日簽章上限。

### Agent / Watchdog 發版

```
受保護 tag → CI build:release（未簽章，現況）
  → 簽章人員在 GigaItApp 選擇 pipeline 產物「送簽」（或工作站直接以唯讀 Token 讀 GitLab 產物）
  → 簽章工作站：核對 SHA256SUMS.txt → 以 Agent 發版憑證簽章 → 輸出到 NAS releases\<區>\（沿用 sign-release.ps1 的檢查）
  → IT 在 GigaItApp「登錄草稿」：endpoint-server 讀 SIGNED-INFO、驗雜湊與簽章者後建立版本（取代 publish-release.ps1 的 ssh + SQL）
  → 發佈環（沿用 P6）
```

監控 MSI 也改在 CI 依部署區建置（`build-agent-msi.ps1 -Env`），再交工作站簽章；MSI 內的 `trusted_signers` 等設定由 CI 變數提供（不是機密）。

### 為什麼經 NAS 交換、不讓工作站呼叫 API

- 工作站只需要 NAS 讀寫權，不需要 BFF 帳號或機器憑證，也不開連入 port。
- 佇列與輸出目錄依部署區分開（`RustIT\test\…`、`RustIT\prod\…`），NAS 寫入群組分開（即 §8.2-14），正式區佇列只有正式簽章人員與工作站寫得進去。
- endpoint-server 永遠**重新驗證**工作站的輸出（雜湊、簽章者），不採信工作站寫的紀錄檔。

## 簽章工作站的金鑰保管

| 方式 | 適合 | 代價 |
| --- | --- | --- |
| **A. 專用 VM，AD CS 憑證存在 `LocalMachine\My`、私鑰不可匯出（建議第二階段）** | 常駐自動簽 | VM 本身要加固：不加入一般使用者登入、只開 NAS 出站、本機系統管理員限簽章人員 |
| B. USB 硬體金鑰（YubiKey 等） | 金鑰不離開硬體 | 每次簽章要 PIN / 觸碰，難以無人值守；適合第一階段在簽章人員電腦使用 |
| C. 網路 HSM | 規模大、要稽核 | 成本高，目前規模不需要 |
| 不採用：放在 GitLab Runner / CI 變數 | — | RUNBOOK §1「CI 與 Runner 沒有私鑰」維持不變；Runner 執行任意分支的程式，風險太大 |

## 可選的後續：端點改依「公司 CA + 範本」比對

目前端點以**葉憑證指紋**比對，公司憑證續約（一般 1–2 年）仍要走一次 RUNBOOK §4 的新舊並列流程。可改為「簽章鏈到公司 CA，且葉憑證含軟體發佈範本的 OID / EKU」即接受，續約不必改端點設定。代價是要改 Agent（`rustit-common::authenticode`、`agent.toml` 新欄位）並發版，且信任範圍變成「CA 簽發的所有同範本憑證」，範本申請權限必須嚴格控管。等公司憑證第一次續約前再決定。

## 分階段

| 階段 | 內容 | 前置 |
| --- | --- | --- |
| **S1 正式區上線前** | 登錄改走 GigaItApp（取代 `publish-release.ps1` 的 ssh + SQL，§8.2-13）；NAS 兩區寫入群組分開（§8.2-14）；GigaItApp 上傳軟體（存 NAS `incoming\`）；`sign-release.ps1` 擴充為「簽章工作站」程式，在簽章人員電腦手動執行，讀 NAS 佇列 | 無（可用測試憑證先做） |
| **S2 正式憑證** | AD CS 申請「Agent 發版」「軟體發佈」兩張憑證；派送套件全部改為公司重簽；端點 `[software] trusted_signers` 改成只列公司指紋（MSI / GPO 一次性更新）；舊廠商指紋依 RUNBOOK §4 第 6 步汰除 | 0003 的 AD CS 待確認事項 |
| **S3 專用簽章機** | 工作站程式搬到專用 VM 常駐；GigaItApp「核可簽章」角色與通知；每日上限 | S2 |
| 可選 | 端點改依 CA + 範本比對 | 公司憑證第一次續約前 |

## 不採用的做法

| 做法 | 理由 |
| --- | --- |
| 主機下發 `trusted_signers` 給端點（端點自動信任） | 失去主機改不了的防線；主機被入侵即可推任意程式 |
| 繼續列廠商指紋，改成 GPO 自動化更新 | 每新增廠商、每次續約都要動全公司設定，問題沒有消失 |
| 私鑰放 CI / Runner | 見上表；違反 RUNBOOK §1 |
| 未簽章套件只憑主機雜湊放行 | P7 §9-2 已決定不採用 |

## 對現有設計的影響

- **P7 狀態機不變**（draft → tested → published → revoked）；draft 多一個「待簽 / 已簽」子狀態，未簽的 draft 不能派送。
- `software_package` 增加上傳者、簽章核可人、原廠簽章者、重簽後雜湊等欄位（migration，S1 / S2 實作時設計）。`signer_thumbprints` 改為固定填公司軟體發佈憑證指紋，`observed_signers` 仍記 Agent 回報值。
- 主機軟體庫的「檔案被換掉」檢查（P7-1）改以重簽後的雜湊為準。
- 檔案上傳可沿用 `giga-file-service` 的上傳元件或直接由 endpoint-server 收檔；實作前比較兩者（跨 repo 要先同意）。

## 待決事項

- [ ] 是否同意「所有派送套件一律公司重簽」（取代列廠商指紋）。
- [ ] 簽章核可角色：由誰擔任（簽章人員 / IT 主管），是否與目錄 `published` 的第二人分開。
- [ ] 第二階段簽章機放在哪裡（主機 3 旁的 VM / 獨立實體機），金鑰採 A 還是 B。
- [ ] Agent 發版「送簽」：簽章人員在 GigaItApp 選 pipeline，還是工作站以唯讀 GitLab Token 直接讀受保護 tag 的產物。
- [ ] 上傳檔案大小上限與 NAS `incoming\` 保留期限。
- [ ] 0003 的 AD CS 待確認事項（架構、CRL HTTP 發佈點、簽章人員）。
