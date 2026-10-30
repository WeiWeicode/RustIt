# GigaNexus 端點憑證 AD CS 申請說明

2026-10-30 · Jiang Jia Wei(線上版:Claude Docs「GigaNexus 端點憑證 AD CS 申請說明」;兩邊不一致時以 IT 回覆後更新的版本為準)

## 申請事項

請 IT 以公司 AD CS 為 GigaNexus 端點監控 Agent 發放電腦憑證,讓網域電腦自動取得與續約,取代目前在 Gateway 主機上手動簽發的臨時憑證。

| # | 項目 | 說明 |
| --- | --- | --- |
| 1 | Agent 專用中繼 CA | 只簽 GigaNexus 端點憑證的簽發 CA(企業 CA,加入網域的 Windows Server)。Gateway 只信任這張 CA,公司 CA 簽的其他憑證不會被當成端點憑證 |
| 2 | 憑證範本「GigaNexus Agent」 | 電腦憑證,只做用戶端驗證;規格見「憑證範本規格」 |
| 3 | GPO 電腦憑證自動註冊 | gsmc.com.tw、gsc.com.tw(含 ygdmc.gsc.com.tw)的電腦;先開一個試點 OU 或群組 |
| 4 | 根 CA 派送 | 公司根 CA 憑證進電腦的 `LocalMachine\Root`(網域通常已由 GPO 派送,確認即可) |
| 5 | CRL 發佈 | 根 CA 與中繼 CA 的 CRL 都要能從 Gateway 主機 10.10.130.122 以 HTTP 下載 |
| 6 | 非網域電腦流程 | 禾迅等不加網域的電腦,以同一範本人工簽發 |

## 背景

GigaNexus 端點管理(RustIt)在每台 Windows 電腦安裝監控服務 Agent,蒐集硬體、軟體與資安狀態,並接受 IT 的遠端指令。Agent 以雙向 TLS(mTLS)連到 Gateway 的 `10.10.130.122:9443`,用電腦憑證證明「我是哪一台電腦」;沒有有效憑證就連不上。

憑證的主體(電腦 FQDN)就是端點在系統裡的身分,系統也依它的網域尾碼判定電腦屬於哪家公司。所以憑證必須由 IT 簽發、私鑰不可匯出,不能讓使用者自己弄一張。

目前(2026-10 起)測試區與正式區各用一套「臨時 CA」,放在 Gateway 主機上,由我們一台一台簽 PFX、人工匯入。這種做法不能擴大到全公司:沒有自動續約、沒有正式的撤銷流程,而且 CA 私鑰放在對外服務的主機上。

## 運作流程

全部自動進行,IT 只在建置時設定一次;之後的日常工作只有撤銷。

1. 網域電腦套用 GPO 後,依「GigaNexus Agent」範本向 Agent 專用中繼 CA 申請憑證,存進 `LocalMachine\My`(私鑰不可匯出)。
2. Agent 服務(LocalSystem)每次連線都重新挑憑證:簽發者是中繼 CA、用途含用戶端驗證、在效期內,多張時取最晚到期的一張。
3. Agent 連 `10.10.130.122:9443`,Gateway(Nginx)以中繼 CA 與根 CA 驗證憑證鏈,並檢查 CRL;簽發者不在白名單內一律拒絕。
4. Gateway 把憑證主體與指紋轉給端點服務,以完整主體為電腦身分,依 FQDN 網域歸屬公司。
5. 憑證快到期時 Windows 自動續約,指紋會改變;Agent 下次連線自動改用新憑證,不必重新安裝。
6. 電腦報廢或遺失:IT 在 CA 撤銷 → CRL 更新 → Gateway 定期下載 CRL 後,這台就連不上。

## 憑證範本規格

範本建議從內建「Workstation Authentication」複製修改;需要配合的重點是金鑰必須存在 CNG(KSP),Agent 以 Windows CNG 使用不可匯出的私鑰。

| 項目 | 要求 |
| --- | --- |
| 範本名稱 | GigaNexus Agent |
| 用途(EKU) | 只有 Client Authentication |
| 金鑰 | ECDSA P-256 或 RSA 2048 以上;提供者類別 Key Storage Provider(CNG) |
| 私鑰匯出 | 不允許 |
| 主體名稱 | 由 AD 資訊建立,格式選「DNS 名稱」(CN = 電腦 FQDN,例 `PC0123.gsmc.com.tw`) |
| SAN | DNS 名稱(預設即可) |
| 效期 | 1 年(建議) |
| 續約期間 | 6 週(預設即可) |
| 權限 | 試點電腦群組「讀取、註冊、自動註冊」;試點後再改 Domain Computers |

主體一定要是 FQDN:三個網域可能有同名電腦,系統也靠網域尾碼判定所屬公司。

## 非網域電腦

不加網域的電腦(例如禾迅)無法自動註冊,用同一個範本人工簽發。金鑰在該電腦上產生,不經過 IT 的電腦。

1. 在該電腦以系統管理員執行 `certreq -new agent.inf agent.csr`(`agent.inf` 設 `MachineKeySet = TRUE`、`Exportable = FALSE`,主體 `CN=<公司代碼>-<電腦名稱>`)。
2. IT 以「GigaNexus Agent」範本簽發 `agent.csr`,交回 `agent.cer`。
3. 在該電腦執行 `certreq -accept agent.cer`,憑證與私鑰配對後存入 `LocalMachine\My`。

這類電腦需要人工續約;系統會在到期前 30 天提醒 IT。所以需要範本允許「由要求提供主體名稱」,或另開一個人工簽發用的範本(請 IT 決定)。

## 請 IT 回覆與提供

先請 IT 回答前三題,我們依此決定 Gateway 的信任設定與時程。

**問題**

- [ ] 公司是否已有 AD CS?根 CA 與簽發 CA 在哪台主機、一層還是兩層?
- [ ] 能否另開一張「Agent 專用中繼 CA」?不行時,能否至少用專用範本(我們改以範本識別)?
- [ ] gsmc.com.tw、gsc.com.tw、ygdmc.gsc.com.tw 是否都由同一套 CA 與 GPO 管理?
- [ ] CRL 發佈在哪裡(HTTP 網址)?更新頻率與效期?主機 3(10.10.130.122)能否連到?
- [ ] 試點群組:建議 IT 部門自己的 5–10 台電腦。
- [ ] 非網域電腦要共用範本還是另開範本?

**請提供給我們**

- [ ] 根 CA 與 Agent 中繼 CA 的公開憑證(`.cer`,Base64)
- [ ] 兩張 CA 的 CRL 網址
- [ ] 範本名稱與 OID
- [ ] 試點電腦已取得憑證的通知(我們從端點管理畫面確認連線)

## 我們的配合與過渡期

拿到 CA 憑證與 CRL 網址後,由 GigaNexus 專案完成下列變更;IT 不需要動 Gateway 主機。

| 位置 | 變更 |
| --- | --- |
| Gateway :9443 | 信任鏈改為公司根 CA + Agent 中繼 CA;簽發者白名單加入中繼 CA |
| CRL | Gateway 主機定時下載兩張 CA 的 CRL 並重新載入;CRL 過期時 Gateway 會拒絕所有 Agent,這項上線前必須完成 |
| Agent 安裝檔(MSI) | 簽發者名稱改為中繼 CA、內建公司根 CA,重建後派送 |
| 端點服務 | 公司網域對照表加入 ygdmc.gsc.com.tw(鹽城碩禾) |

**過渡期**:IT 完成前,正式區繼續用臨時 CA 為少數試點電腦人工簽發。切換時兩套 CA 會短暫並存,試點電腦拿到 AD CS 憑證後,再停用臨時 CA。

---

相關規格:Gateway `docs/ENDPOINT-AGENT-GUIDE.md` §3(裝置身分與憑證)、§10 E1 / E2 / E8 / G1;本 repo `docs/RUNBOOK.md` §1.2(臨時 CA 簽發)、`AGENT.md` §6。
