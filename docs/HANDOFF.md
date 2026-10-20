# 交接:RustIt 第二階段(端點平台框架)

> 給接手的 AI 與工程師。**先讀 `../AGENT.md`,再讀 [PLATFORM-PLAN.md](PLATFORM-PLAN.md)**(第二階段計畫、階段 P0–P8、決定事項);本文只補「現在做到哪、下一步、哪些要先問」。基本階段的完整過程見 [INTEGRATION-PLAN.md](INTEGRATION-PLAN.md) 與 [DevelopmentProcess/NewFeatures.md](DevelopmentProcess/NewFeatures.md)。

## 1. 目前狀態

| 項目 | 狀態 |
| --- | --- |
| 基本階段(INTEGRATION-PLAN M0–M4、M6) | ✅ 完成:Agent 經 Gateway `:9443` 回報 ItAgentBack,GigaItApp「電腦清單」看得到 |
| `RustAgent/crates/collector` | ✅ 硬體、軟體、網路、防毒、USB 儲存、RustDesk 狀態 |
| `RustAgent/crates/watchdog`(`rustit-watchdog`) | **0.2.0 升級 Agent 實作完成(P6-2,待 VM 驗收)**;✅ **0.1.0**(P5-2,MR !32 已合併 develop,2026-10-19 測試區 VM 驗收 7 項通過):`GigaNexusWatchdog` 服務看守 Agent、自己經 `:9443` 上報 |
| `RustAgent/crates/agent`(`rustit-agent`) | ✅ **0.6.0**(develop;2026-10-19 測試區 VM 由 0.4.2 升級驗收通過,驗收後已解除安裝):0.5.0(P5-1)心跳健康摘要、上次結束原因、hello 憑證到期日;0.6.0(P5-2)本機管道、看守 Watchdog、服務 ACL。0.4.2:2026-10-19 停用改每 1 分鐘重試; 前景執行(`run`)與 **Windows 服務**(`service`;開發用 `install` / `uninstall`,P1 第一批);HTTPS 回報、WebSocket hello / 心跳、退避重連、裝置憑證(PEM 檔或 Windows `LocalMachine\My`,P1 PoC 實測通過)、服務模式檔案日誌、監控 MSI(未簽章,P1 VM 驗證通過)。**P2**:本機加密暫存 `state\store.db`(資產 / 事件 outbox、連線紀錄)、離線照常蒐集與 `/sync` 補傳、`offline_period`、USB 插拔與 `agent_started` 事件、429 依 Retry-After、主機下發設定(2026-10-15 VM 驗證通過,見下方 P2-3)。**P4-1(0.3.0,已合併 develop)**:指令執行器 `inventory.collect` / `agent.restart` / `message.show`、本機 `command_log` 去重與待回報狀態。**P4-2(0.4.0,已合併 develop,2026-10-15 測試區 VM 驗證通過)**:`agent.diagnose`、`logs.collect`(日誌 zip 上傳)、`agent.log_level` |
| `RustAgent/crates/demo` | 示範介面;**將改造為使用者端程式 `desktop`**(P8),`src/deploy.rs` 是軟體派送的參考實作(P7 移植到 Agent) |
| `RustAgent/crates/native` | ✅ 已移除(P1;最後版本 `3ba3827`) |
| `ItAgentBack` | ✅ 測試區(主機 2,`endpoint-server` + `ita-mongo` / `ita-redis`,CI `develop` 部署);管理 API `GET /v1/devices[/{deviceId}]`;**P4-2(已合併 develop,路由 Gateway v51 已發佈)**:指令附檔上傳 `POST /agent/v1/commands/{id}/files`、下載 `GET /v1/commands/{id}/files/{fileId}`、volume `ita_command_files`(保存 14 天);不需新 migration。**P4-1(已合併 develop)**:指令派送器與 basic 指令 API(`/v1/devices/{id}/basic-commands`、`/v1/batches/basic-commands`、`/v1/commands[/{id}[/cancel]]`、`/v1/batches/{id}`),migration 0003 已套用 `giganexus_It_Agent_test`(2026-10-15,經需求方同意);giga-observe 監控已接。**P2 主機端已上測試區**(2026-10-14,MR !10):`/sync`、`/events`、429、時鐘偏差、硬體指紋、主機下發設定;migration 0002 已套用 `giganexus_It_Agent_test` |
| GigaItApp 電腦清單 | ✅ 清單 + 詳情(概要、磁碟、網卡) |
| INTEGRATION-PLAN M5(離線暫存、`/sync`) | 併入 PLATFORM-PLAN P2(✅ 完成) |
| 第二階段計畫 | ✅ `PLATFORM-PLAN.md` v0.4 **定案**(P0,2026-10-13):根目錄 `PROJECT-MAP.md` / `workspace.json`(cbf6db9)、Gateway `ENDPOINT-AGENT-GUIDE.md` v0.5(7319e87)已同步;甘特圖 W6-13 ~ W6-24(P0–P8、上線前準備),舊 W6-1 ~ W6-6、W6-12 已由新任務取代 |

## 2. 下一步

0. **下一階段:P7 軟體派送(2026-10-20 設計草案)**:[P7-SOFTWARE-DESIGN.md](P7-SOFTWARE-DESIGN.md) 已寫好,§9 全部已確認(11 項先用需求方本機電腦 + VM);可開工 P7-1(後端、migration 0008)。
0. **目前階段:P6 升級(甘特圖 W6-19)**:設計 [P6-UPGRADE-DESIGN.md](P6-UPGRADE-DESIGN.md),2026-10-20 需求方確認 §9 全部照建議;分批 P6-1(版本登錄與發佈環,後端)→ P6-2(Watchdog 升級 Agent)→ P6-3(Agent 升級 Watchdog)→ P6-4(Windows Runner + 人工簽章,P6-1~3 驗收後)→ P6-5(GigaItApp,動手前另外確認)→ P6-6 收尾。**P6-1 實作完成**(分支 `feature/p6-1-release`,測試 178/178、整合 12/12);待:migration 0007 套用 `giganexus_It_Agent_test`(需求方看過後)→ MR 合併 develop 部署 → Gateway OpenAPI 草稿批次發佈 → 主機 2 建 `/srv/giganexus/ita-releases/`。P6-1 已合併 develop(MR !37)。**P6-2 實作完成**(分支 `feature/p6-2-watchdog-upgrade`,Watchdog 0.2.0 / Agent 0.7.0 / MSI 0.7.0;審查後調整見設計 §8.3);待 VM 驗收(設計 §8.4:需求方建立測試簽章憑證、建 MSI 與 0.7.1 / 壞版本、主機 2 建 `/srv/giganexus/ita-releases/`、OpenAPI 批次發佈後登錄版本)。下一批 P6-3(Agent 替換 Watchdog,`replace_watchdog`)。前置條件替代:測試簽章憑證(正式 AD CS 憑證待 IT)、主機 2 `/srv/giganexus/ita-releases/`(NAS 掛載待帳密,與 P7 一起)。
   - 以下為 P5 紀錄(已完成)。
0. **P5 監測(甘特圖 W6-18)**
   - **範圍**:PLATFORM-PLAN §4.3(三層資料：健康摘要附在心跳、事件、Server 比對軟硬體變更、固定告警規則)、§4.10 A5(Agent 被停用 / 移除偵測)、§8 P5 完成標準;Watchdog 規格見 Gateway `ENDPOINT-AGENT-GUIDE.md` §7。
   - **完成標準**:結束 Agent 行程 → Watchdog 重啟並上報;以管理員手動停止 Agent 服務 → 產生事件與告警;插 USB 隨身碟 → 事件出現(P2 已有);移除一個軟體 → 下次蒐集產生變更事件。
   - **進度(2026-10-19,設計 [P5-MONITOR-DESIGN.md](P5-MONITOR-DESIGN.md),需求方確認 §9 全部照建議)**:
     - **P5-1 ✅ 已合併 develop(MR !31,`91ee86c`)並部署測試區**:migration 0006 已套用 `giganexus_It_Agent_test`;健康摘要、資產變更事件、告警 API(`/v1/alerts`、`/v1/devices/{id}/health`);Agent 0.5.0。**待辦**:Gateway OpenAPI 草稿批次發佈(新 API 才會出現在 `/api/endpoint/*`)。
     - **P5-2 ✅ 已合併 develop(MR !32,`568aca9`)並於 2026-10-19 測試區 VM 驗收 7 項通過**(報告 [test-reports/2026-10-19-p5-watchdog-0.6.0.md](test-reports/2026-10-19-p5-watchdog-0.6.0.md):安裝兩個服務、結束行程 → `agent_restarted`、停止服務 → `agent_tampered`、軟體安裝 / 移除事件、停用 Watchdog 被改回、一般使用者停止被拒、解除安裝不互拉)。**VM 目前已解除安裝 Agent**,之後測試要重裝 0.6.0 MSI。實作摘要:`watchdog` crate(Watchdog 0.1.0)、Agent 0.6.0(本機管道、看守 Watchdog、服務 ACL)、監控 MSI 含兩個服務、`POST /agent/v1/watchdog/report`、`agent_tampered`;子代理審查(含 1 High)已修正(設計 §8.3)。本機測試與端到端(前景 Watchdog → 本機 Server)通過;**管道、SCM 看守、服務 ACL、MSI 安裝 / 升級 / 解除安裝要在 VM 驗證**(本機非系統管理員無法測)。合併後 endpoint-server 只多 `watchdog/report` 路由與事件白名單,不需新 migration。測試區 MSI:`dist/msi/GigaNexusAgent-0.6.0-test.msi`(本機建置,SHA-256 `5fd145df…5c4471`;合併後以 develop 重建)。
     - **P5-3 ✅ GigaItApp 監測畫面已上測試區(2026-10-20,GigaItApp MR !7,`092adea`)**:OpenAPI 批次已發佈、includes 已綁、CI rbac-test 已套用。測試區瀏覽器驗證通過:清單健康欄與告警數、「健康與 Agent」Tab、事件標籤、「告警」Tab(未結束 / 已關閉 / 全部、嚴重度篩選、點列開詳情)、關閉告警(VM `agent_tampered` 由 S112009 確認關閉,稽核顯示確認人與說明,`openAlerts` 歸 0)。未驗:關閉衝突(409,需兩人同時關閉)。**P5-4 ✅(2026-10-20)**:Gateway ENDPOINT-AGENT-GUIDE v0.10(Gateway MR !6;§6.3 / §7.2 / §7.3 / §8.3 已在 v0.9 回寫,v0.10 補 VM 驗收、告警 detail 規則、GigaItApp 告警權限)、甘特圖 W6-18 100% done(API 已更新,根目錄 MR !7)。**P5 測試區完成;下一階段 P6 升級(甘特圖 W6-19)**。
     - **後續**:告警 `detail` 保留第一次觸發原因(設計預期,畫面已加「首次:」提示);關閉告警權限要與一般指令分開時,ItAgentBack 註冊新權限代碼(資安審查 Medium,指南 §8.6);關閉衝突 409 未實測;其他項目見設計 §8.1、§8.3「未處理」。
     - VM 驗收:完成標準 4 項(設計 §0 表)。VM 先建檢查點「P5 前(0.4.2)」,再裝 0.6.0 MSI(同時驗 P5-1 與 P5-2)。
   - **建議做法**:比照 P3 / P4,先寫設計 `docs/P5-MONITOR-DESIGN.md`(分批、資料表 / migration、契約擴充、告警規則、Watchdog 與 Agent 互相看守、MSI 加第二個服務、GigaItApp 畫面),經需求方確認後再實作;牽涉服務、安全與契約,由 Claude 主寫。
   - **要先同意**:migration 套用測試庫、契約變更、MSI 加 Watchdog 服務、GigaItApp 告警頁與 `gateway-rbac.yaml`、指南回寫(§5、§7)、合併 develop(測試區共用)。
   - **測試環境**:主機 2 Hyper-V VM(名稱 `RUSTIT-P34`、憑證 `CN=DESKTOP-1TB2UMP`、deviceId `de87bce2`、Agent 0.4.2;檢查點「匯入憑證」「P3-4 改名前(0.4.1)」;Claude 可經 `ssh host2` 操作 Hyper-V,VM 內指令由需求方執行)。E6 測試帳號 V112001(碩禾、禾迅)、V114007(禾迅),個人權限「電腦清單」。對外 API 是 `/api/endpoint/*`(沒有 `/v1`)。
   - **close code 規則**:4403 = 停用 / 退役(Agent 暫停;停用每 1 分鐘、退役 10 分鐘重試)、4409 = 被新連線取代、4410 = 合併(立即重連)。新的關閉原因要另訂代碼，不要沿用 4403。

   **前一階段(2026-10-19 收尾)**:
   - **P3 完成、E6 測試區驗證通過(2026-10-19)**:見 [test-reports/2026-10-19-p3-merge-e6-scope.md](test-reports/2026-10-19-p3-merge-e6-scope.md)。P3-4 合併驗證通過;修正兩個問題:合併改用 close 4410(MR !27,endpoint-server `8235dc10`)、Agent **0.4.2** 停用改每 1 分鐘重試(MR !28,`5d04604`;VM 已升級 0.4.2,MSI SHA-256 `88d9a774…dcbd0dac`)。E6:批次 112 已發佈，以 V112001(碩禾、禾迅)、V114007(禾迅)驗證資料範圍。VM 目前名稱 `RUSTIT-P34`、憑證 `CN=DESKTOP-1TB2UMP`(deviceId 仍為 `de87bce2`),檢查點多了「P3-4 改名前(0.4.1)」。
   - **待辦**:指南 §5.4(close 4410)、§8.3(合併路由)回寫(Gateway,需同意);E6-2 GigaItApp 公司欄 / 篩選 / 指定按鈕、E6-3 指南回寫(需同意);甘特圖 W6-16 已改 100% done(根目錄 !5、甘特圖 API)。
   - VM `DESKTOP-1TB2UMP` 已由需求方升級 Agent **0.4.1**(2026-10-16;MSI SHA-256 `880e46d9…da794c`,自 develop `8568f55` 建置);已確認收集日誌 zip 內檔案時間為日誌修改時間(正常,非 1980-01-01)。
   - **P3 資料呈現已上測試區(2026-10-16)**:RustIt MR !23(endpoint-server `807c7a12`,OpenAPI 批次 110 已發佈,新增權限 `endpoint.command.admin`,啟動時回填 3 台軟體清單)、GigaItApp MR !4、!5(詳情固定 85vh 高度、篩選列換行);migration 0004 已套用;rbac-test 已重跑(`it.endpoint-device.admin` → `endpoint.command.admin`,it-admin)。瀏覽器實測(需求方登入):清單分頁 / 軟體篩選 / 清除、VM 詳情 7 個 Tab、事件 21 筆、下載 JSON、**停用 → 啟用(期間排隊指令於重連後送出)、退役 → 改回使用中皆正常**。P3-4(VM 改名後的疑似同一台與合併)已於 2026-10-19 驗證通過(見上)。合併路由寫入指南 §8.3(需 Gateway 同意)。
   - **E6 資料範圍依公司已上測試區(2026-10-16)**:RustIt MR !25(endpoint-server `3081af75`),migration 0005 已套用,主機 2 `ita.env` 已加 `ENDPOINT_SCOPE_ALL_ROLES=it-admin`、`ENDPOINT_COMPANY_DOMAINS=碩禾=gsc.com.tw,gsmc.com.tw`;回填後開發機兩筆登錄為碩禾、VM 未指定(只有 it-admin 看得到),見 `E6-COMPANY-SCOPE-DESIGN.md` §6.1。批次 112 已發佈，非 it-admin 帳號驗證已於 2026-10-19 通過(見上)。注意:改 `ENDPOINT_COMPANY_DOMAINS` 後要重啟 endpoint-server,且 `domain` 來源的裝置等下次資產變動才重算。Gateway ENDPOINT-AGENT-GUIDE v0.8 已回寫 E6(Gateway 分支 `docs/endpoint-guide-v0.8`,待合併);甘特圖 W6-16 90%、W6-24 註記 B9 後端完成。E6-2(GigaItApp 公司欄 / 篩選 / 指定按鈕)、E6-3(指南 §8.2、§8.3、§10.2 E6、§11 回寫)待同意。上線檢查加入「正式區裝置憑證 CN 必須是 FQDN」。
   - P4 後續(未排程,見 `P4-COMMAND-DESIGN.md` §6.1、§8.4):WebSocket 訊息速率上限、`result` 依類型以 schema 限制、慢速上傳佔用回報名額、`ita.command_file.command_ref` 唯一索引(多實例前)、附檔總量上限與磁碟告警、批次下指令畫面。
1. **P1 已完成**(2026-10-14 Hyper-V VM 驗證 7 項通過,見下方「P1 收尾:VM 測試」)。Win11 VM 可之後補測;VM 保留作 P2 以後的測試機(檢查點「匯入憑證」)。
2. **P3 資料呈現已完成**(2026-10-19);**P8-1 使用者端外殼與我的電腦**可交給同仁並行(甘特圖 W6-21)。
3. **P2 已完成**(主機端與 Agent 端已合併 `develop`;2026-10-15 P2-3 VM 驗證 7 項通過,見下方)。驗證時發現裝置被停用期間會記成 `offline_period`(rejected),已於 0.2.1 排除(BugFix.md 2026-10-15;測試區 VM 已升級)。**P4 指令通道已完成**(測試區;設計 `P4-COMMAND-DESIGN.md`,需求方 2026-10-15 確認;甘特圖 W6-17;Gateway 指南 v0.6 已回寫):P4-1 已合併 develop;P4-2 已合併並於 2026-10-15 測試區 VM 驗證通過(見下方「P4 測試區 VM 驗證」;含 P4-1 的服務模式 `agent.restart`);`endpoint.command.basic` 已由 GigaItApp `gateway-rbac.yaml` 按鈕節點 `it.endpoint-device.command` 授予 it-admin(GigaItApp MR !1)。**P4-3(2026-10-15,GigaItApp MR !2)**:電腦詳情「指令」Tab(六個指令、結果、日誌下載、指令紀錄、取消)與「端點管理 › 指令紀錄」Tab,本機連測試區 Gateway 對 VM 實測通過(GigaItApp NewFeatures 2026-10-15);已合併(GigaItApp `02f12d2`),「指令紀錄」Tab 由 CI rbac-test 套用權限後可見。小項已修(BugFix.md 2026-10-15,Agent 0.4.1:zip 檔案時間、瞬間完成的指令補 started_at;VM 已於 2026-10-16 升級 0.4.1)。

### P5-3 交接:GigaItApp 監測畫面(✅ 2026-10-20 完成,以下保留為紀錄)

> 需求方 2026-10-19 同意範圍,同日暫停;改 GigaItApp 已獲同意(電腦清單健康欄與告警數、詳情「健康與 Agent」Tab、事件 Tab 新類型標籤、「告警」Tab、`gateway-rbac.yaml` 加 `it.endpoint-alert.list` / `it.endpoint-alert.resolve`,**includes 等 OpenAPI 發佈後再綁**)。設計 [P5-MONITOR-DESIGN.md](P5-MONITOR-DESIGN.md) §3.3(API)、§4(規則)、§7(畫面)。

**開工前先讀**:`../GigaItApp/AGENT.md`(§8 前端規則:`G*` 元件、懶加載、`v-can` / `can()`、不用 `v-html`)、`../GigaItApp/docs/PROJECT-MAP.md`、本節。

**已寫好的程式(未提交)**:GigaItApp 分支 `feature/p5-monitor-ui`(從 `gitlab/develop` `a373550` 開),改動存在 `git stash`(`stash@{0}`,訊息「P5-3 監測畫面(暫停…)」),**只在需求方這台開發機**。恢復:

```bash
git -C GigaItApp switch feature/p5-monitor-ui
git -C GigaItApp stash pop
```

| 檔案 | 內容 | 狀態 |
| --- | --- | --- |
| `frontend/src/api/types.ts` | `EndpointHealth`、`EndpointWatchdog`、`EndpointAlert(Page)`、`EndpointHealthSeries`;`EndpointDevice` 加 `health`、`openAlerts`;詳情加 `certNotAfter`、`watchdog`、`alerts` | 完成 |
| `frontend/src/api/endpoint.ts` | `alertApi`(list / resolve)、`deviceApi.health`、`ALERT_RULE_LABELS` / 嚴重度、`alertSummary()`(依規則把 detail 摘要成文字)、`EVENT_LABELS` / `EVENT_TONES` 加 P5 事件類型 | 完成 |
| `frontend/src/api/auth.ts` | `UI.alertList = it.endpoint-alert.list`、`UI.alertResolve = it.endpoint-alert.resolve` | 完成 |
| `frontend/src/router.ts` | 「電腦清單」頁加「告警」Tab(`/endpoint/devices/alerts`,permission `UI.alertList`,requires `EP.deviceRead`) | 完成 |
| `frontend/src/pages/endpoint/Alerts.vue`(新) | 告警清單:狀態(未結束 / 已關閉 / 全部)、規則、嚴重度篩選,nextCursor 載入更多;點列開電腦詳情;關閉按鈕(`can(UI.alertResolve) && can(EP.commandBasic)`) | 完成 |
| `frontend/src/components/endpoint/AlertResolve.vue`(新) | 關閉告警對話框(必填說明) | 完成 |
| `frontend/src/components/endpoint/DeviceHealth.vue`(新) | 詳情「健康與 Agent」Tab:目前健康(進度條)、Agent / Watchdog(憑證到期、服務狀態、24 小時重啟)、24 小時走勢(`GAreaChart`)、此台未結束告警與關閉 | 完成 |
| `frontend/src/pages/endpoint/DeviceDetail.vue` | 加「健康與 Agent」Tab(在「事件」前) | 完成 |
| `frontend/src/pages/endpoint/Devices.vue` | 「健康」欄(CPU / 記憶體 / 磁碟剩餘,門檻標色)、名稱旁未結束告警數徽章 | 完成 |
| `frontend/src/components/endpoint/DeviceEvents.vue` | P5 事件摘要:軟體安裝 / 移除 / 更新 / 大量、硬體變更、Agent 重啟原因、服務被停止、啟動類型被改、程式被換、`agent_started` 上次結束原因 | 完成 |
| `deploy/gateway-rbac.yaml` | 節點 `it.endpoint-alert.list`(tab,parent `it.endpoint-device.read`,sort 30)、`it.endpoint-alert.resolve`(button);it-admin 角色加兩個節點;**includes 先不綁**(註解寫明待補 `[endpoint.device.read]` / `[endpoint.command.basic]`) | 完成 |

`npm run typecheck`(vue-tsc)已通過;**尚未**瀏覽器驗證、Prettier、`npm run build`。

**剩下要做**

1. **前置(需求方)**:Gateway 發佈 ItAgentBack OpenAPI 草稿批次(P5-1 的 `GET /v1/alerts`、`POST /v1/alerts/{id}/resolve`、`GET /v1/devices/{id}/health`;P5-2 合併後的 `watchdog/report` 不經 BFF,不影響畫面)。未發佈前經 BFF 呼叫 `/api/endpoint/alerts` 會 404。
2. 恢復 stash → 瀏覽器驗證(下方方式)→ 視需要調整版面(375px 不可整頁水平捲動)。
3. 綁 includes:OpenAPI 發佈後,`it.endpoint-alert.list` 加 `includes: [endpoint.device.read]`、`it.endpoint-alert.resolve` 加 `includes: [endpoint.command.basic]`(兩個權限代碼早已存在)。合併 develop 後由 CI rbac-test 套用,「告警」Tab 才會出現在測試區。
4. GigaItApp 文件:`docs/DevelopmentProcess/NewFeatures.md`(或 FrontendCorrection)、`docs/PROJECT-MAP.md`(新頁面 / 元件)、視需要 `docs/PRD.md`(電腦清單 FR-8.x)、`docs/API.md` 不需要(端點 API 不在 itapp-api)。
5. 子代理審查(code-reviewer;權限按鈕屬資安項目可加 security-auditor)→ commit → 推 GitLab `feature/p5-monitor-ui` → 開 MR(合併由需求方)。
6. 收尾:本檔「目前狀態」、P5 設計 §0 進度、甘特圖 W6-18。

**驗證方式**

- 本機:根目錄 `.claude/launch.json` 的 `itagentback`(RustIt `ItAgentBack`,DEV_SKIP_TOKEN,本機 51296 / 51297)+ `itapp-web-endpoint`(GigaItApp 5179,`ENDPOINT_LOCAL` 把 `/api/endpoint/*` 轉給本機 ItAgentBack,其餘 `/api` 走測試區 Gateway 登入)。登入由需求方在瀏覽器完成(AI 不輸入帳密)。
- 本機 ItAgentBack 要在含 P5 的程式上(RustIt `develop` 已含 P5-1;`feature/p5-2-watchdog` 含 P5-2);`.env` 已設 `ENDPOINT_COMPANY_DOMAINS`(未設會把共用測試庫開發機的公司改回未指定)。本機 Server 每 5 分鐘也會評估共用測試庫的告警。
- 要有資料:前景 Agent 0.5.0 以上連本機 Server(`cargo run -p rustit-agent -- run --config crates/agent/agent.dev.toml`)就有健康與走勢;告警可暫時調低 `ALERT_DISK_FREE_PCT` 觸發 `disk_low`,驗證後改回並關閉告警(P5-1 時做過,見 NewFeatures 2026-10-19)。
- 「告警」Tab 受 `it.endpoint-alert.list` 控制,測試區 rbac 套用前本機看不到;可先驗詳情「健康與 Agent」Tab、清單欄位、事件標籤,告警 Tab 等 rbac-test 套用後在測試區驗。

**注意**

- 告警 `detail`、事件 `data`、`agentLastError` 都來自端點回報,一律以文字顯示(已用 `alertSummary()` / `summary()` 轉文字)。
- 清單「有未結束告警」篩選:後端 `GET /v1/devices` 目前沒有這個參數(設計 §7 有列),要做得先改 ItAgentBack(RustIt repo),這次先不做。
- 關閉告警權限沿用 `endpoint.command.basic`(設計 §9-2);自動類規則條件仍成立時 5 分鐘後會再開一筆,畫面已提示。

### P4 測試區 VM 驗證(2026-10-15)

| 項目 | 結果 |
| --- | --- |
| 環境 | VM `DESKTOP-1TB2UMP` 由 0.2.0 升級 0.4.0 測試區 MSI(SHA-256 `f72cac1f…e44d64`),經 Gateway `:9443`;指令經 BFF `/api/endpoint/*`(Gateway 路由 v51),以 GigaItApp 登入工作階段在瀏覽器 Console 呼叫 |
| `agent.diagnose` | succeeded(0.3 秒):gateway ok 40 ms、dns skipped(工作群組)、clock ok、**cert ok(讀 `LocalMachine\My`,2027-10-14 到期)**、disk warn(C:\ 2.5 GB / 8%)、wmi ok 174 ms、store ok;`service_mode: true` |
| `logs.collect` | succeeded:2 天(VM 10/14 才安裝)、20,074 bytes、上傳 SHA-256 與主機相符、保存至 10/29;下載 zip 可開啟,含 `agent-2026-10-14.log`、`agent-2026-10-15.log`(原始 359 KB) |
| `agent.log_level` | debug 10 分鐘:日誌只多 `rustit_agent` 的 DEBUG(無第三方套件);`Restart-Service` 後「沿用暫時日誌等級」;14:20:53 到期後 14:21:04 恢復 info。連下 3 次時後兩次 `previous` 為 debug、到期時間延後 |
| `agent.restart`(P4-1) | succeeded:以結束代碼 3 停止 → 10 秒後失敗復原重啟 → 回報;`sendCount: 2`(重啟前未送出 acked,重連後重送),Agent 以 command_id 去重,未重複重啟 |
| 離線補送 | VM 中斷網路時建立 `agent.diagnose` → queued;接回網路後 06:28:27 送出並 succeeded,`sendCount: 1` |
| 發現並修正 | 自動註冊被 Gateway 拒絕(IMPORT_HAS_ERRORS,BugFix.md 2026-10-15,MR !17);瀏覽器 Console 測試的 CSRF Token 會因續期更換,輔助程式須每次重新讀 `gn_csrf` |

### P2-3:VM 驗證(完成標準 PLATFORM-PLAN §4.2)

| 步驟 | 內容 |
| --- | --- |
| 準備 | Agent 分支合併後 `build-agent-msi.ps1 -Env test` 重建 MSI;VM 還原「匯入憑證」檢查點後安裝(或直接升級安裝)。確認連線後建立「P2 已安裝」檢查點 |
| 1. 離線 1 小時 | Hyper-V 中斷 VM 網路介面卡(或 VM 內停用網卡),期間 `Restart-Service GigaNexusAgent` 一次。USB 事件**不能在 VM 驗證**:Agent 只認可移除磁碟區(`DRIVE_REMOVABLE`),附加的 VHD 是固定磁碟、第 2 代 VM 沒有軟碟或 USB 直通;改在自己的電腦以前景模式插拔真的隨身碟(另備一份 `server_url` 指向連不到位址的 agent.toml 模擬離線,兩份放同一目錄共用 `state\`) |
| 2. 恢復 | 接回網路;主機應收到最新資產(多份時經 `/sync`)、USB 事件(occurred_at 為插拔當下)、**一筆** `offline_period`(開始 / 結束 / 原因 network、跨越服務重啟),沒有重複資料 |
| 3. 離線重開機 | 離線狀態下重開機(停止超過 10 分鐘才開機則該段以最後嘗試結束),持久化資料仍在(`C:\ProgramData\GigaNexus\Agent\state\` 有 store.db / store.key),恢復後補傳 |
| 4. 換電腦無法解密 | 把 `state\` 複製到另一台電腦(或開發機)以前景模式指向它啟動 → 日誌「本機暫存無法使用…改名保留並重建」,舊資料無法讀出 |
| 5. 時鐘偏差 | VM 時間調快 10 分鐘(先關閉時間同步)→ 主機寫 `clock_skew` 事件、Agent 日誌警告 |
| 6. 停用 | 主機將裝置設為 disabled(目前無管理 API,需以 SQL 更新 `ita.device.status`,先取得同意)→ Agent 暫停蒐集;恢復 active 後繼續 |
| 查詢 | `ita.device_event`(event_uid 非 NULL 為端點事件)、`ita.device`(`clock_skew_ms`)。`docker logs` 在主機 2 讀不到較新的紀錄(2026-10-15 只讀到 10/14 13:13,疑似日誌輪替),以資料庫為準。VM 的 `C:\ProgramData\GigaNexus\Agent` 只允許 SYSTEM、Administrators,一般檔案總管會顯示「找不到」,改用系統管理員 PowerShell;讀日誌加 `-Encoding UTF8` |
| 結果(2026-10-15) | **7 項全部通過**(VM `DESKTOP-1TB2UMP`,0.2.0 MSI 升級安裝)。1–2:離線 19 分鐘(中間重啟服務 2 次)與 16.7 小時各只有一筆 `offline_period`(network),恢復後 6 份離線資產經 `/sync` 全部 stored,無重複。3:離線中 Windows Update 重開機 2 次(00:27、00:37),停機不到 10 分鐘延續同一段,事件留在本機恢復後補傳。4:複製 `state\` 以登入者身分前景啟動 → DPAPI 解不開,改名 `.unreadable-…` 後重建。5:時間調快 10 分鐘 → `clock_skew_ms` 599868、`clock_skew` 事件。6:SQL 設 disabled 後重啟服務 → 三個通道 403、暫停蒐集;改回 active 後 10 分鐘內恢復。7(自己的電腦,隨身碟):連線中插拔即時送達;離線插拔後恢復,`usb_*` 的 occurred_at 為插拔當下、同一段 `offline_period`(tls) |

注意:`429`、`400` 與裝置停用 / 退役(0.2.1 起)主機有回應,不算離線,停用的回應還會結束進行中的離線期間;不到 60 秒的中斷不送 `offline_period`;離線期間 Agent 重啟(10 分鐘內)延續同一段。DPAPI 改為執行帳號範圍(SYSTEM),前景模式以登入者身分建立的 `state\` 不能給服務使用(反之亦然)。

### P1 收尾:VM 測試(完成標準 PLATFORM-PLAN §4.1、§4.10 A8)

| 項目 | 內容 |
| --- | --- |
| VM | 主機 2 Hyper-V;Win10 22H2 與 Win11 各一台(先做一台也可),2 vCPU / 4 GB / 64 GB,網路接得到 `10.10.130.124:9443`(外部虛擬交換器;Default Switch 是 NAT,**已確認(2026-10-14)來源 IP 會變成主機 2 的 `10.10.130.124`**,防火牆「GigaNexus Agent 9443」要允許 `10.10.130.124`,加 VM 自己的 `172.27.x.x` 無效) |
| 準備 | 裝好 Windows、加入網域(或先不加)、建立「乾淨」檢查點;測試用裝置憑證:由使用者在主機 2 執行 `RustAgent/installer/host2-issue-test-device-cert.sh <VM 電腦名稱>`(臨時 Agent CA 簽發,產出 `C:\Users\user\agent-certs\<電腦名稱>\` 的 PFX 與密碼檔),PFX 匯入 VM 的 `LocalMachine\My`(不加 `-Exportable`)後刪除主機 2 與 VM 上的副本 |
| MSI | `RustAgent/installer/build-agent-msi.ps1 -Env test …` 產生 `dist/msi/GigaNexusAgent-<版本>-test.msi` |
| 驗證 | 1. `msiexec /i … /qn /l*v install.log` 成功;2. `sc qfailure GigaNexusAgent` 為 10 / 30 / 60 秒(服務自行套用);3. 重開機後未登入也自動連線(GigaItApp 電腦清單出現 VM);4. 強制結束行程後自動重啟;5. `icacls C:\ProgramData\GigaNexus\Agent` 只有 SYSTEM、Administrators;6. `msiexec /x` 後服務與 `Program Files\GigaNexus\Agent` 移除、日誌保留;7. 還原檢查點重複安裝 |
| 已知 | 開發機實測(2026-10-13):MSI 安裝 / 解除安裝成功、服務以 `LocalMachine\My` 憑證啟動;當時發現服務自行套用失敗復原少了 `SERVICE_START` 權限(已修,VM 驗證通過)。ACL 套用前就存在的舊日誌檔仍保有原權限,新檔案才繼承 |
| 結果(2026-10-14) | Win10 VM `DESKTOP-1TB2UMP`(Default Switch,工作群組):**7 項全部通過**。首次安裝因缺 `VCRUNTIME140.dll` 回 1920 / 1603,改靜態連結 C 執行階段後通過(BugFix.md)。服務端紀錄:強制結束 → WebSocket 1006 → 28 秒後重連;重開機停在登入畫面即重連(關機時送 1001 正常關閉);解除安裝後 1001 且不再連線;還原檢查點重裝沿用同一 deviceId。使用者登入密碼變更不影響(電腦憑證屬 `LocalMachine`) |

主機 2 注意:2026-10-13 啟用 Hyper-V 重開機後,開機排程 `WSL-GigaNexus`(以 `user` 執行 `wsl -d Ubuntu -u root --exec /bin/sleep infinity`)失敗(結果 -1),WSL 未常駐,整個測試區 Gateway 停擺;手動 `Start-ScheduledTask -TaskName WSL-GigaNexus` 後恢復。之後主機 2 重開機要確認此排程(建議為開機觸發加 1 分鐘延遲,需同意後設定)。

## 3. 已決定(不要重新討論)

| # | 決定 | 出處 |
| --- | --- | --- |
| D1 | Endpoint Server 用 Node.js(Fastify + TypeScript),Rust 只做端點 | ADR 0004 |
| D2 | 資料庫:正式 `giganexus_It_Agent`、開發 + 測試共用 `giganexus_It_Agent_test`、整合測試 `giganexus_It_Agent_poc_test`;主機 `10.10.130.220`;SQL Server 2012 語法、手寫 migration、內網 `encrypt: false` | INTEGRATION-PLAN D2、D3、D8 |
| D3 | SQL Server 是唯一真相;Mongo(快照、心跳)與 Redis(在線)可重建 | INTEGRATION-PLAN §3.1 |
| D4 | Agent 通訊:HTTPS 回報 + 一條 WebSocket(不用 gRPC);Agent 與 Server 只靠 `docs/contracts/` 溝通 | ADR 0001、`AGENT.md` §7.3 |
| D5 | 指令只開放固定類型,依風險拆 basic / admin 路徑,權限在 BFF 檢查 | 指南 §8.2–§8.3 |
| D6 | Agent / Watchdog 升級不覆寫自己,由對方替換 | 指南 §6.5、§7.4 |
| D7 | 軟體派送:安裝檔放 NAS,伺服器以 HTTPS(mTLS)提供,Agent 驗 SHA-256 與簽章者 | ADR 0002(方案 B) |
| D8 | 本機持久化:SQLite + AES-256-GCM + DPAPI;連不上主機也要記錄(P2) | INTEGRATION-PLAN D4、PLATFORM-PLAN §4.2 |
| D9 | 監控服務與使用者端程式分開;使用者端由 Demo 改造,egui 原生版移除 | PLATFORM-PLAN §4.8、§11 Q1–Q2 |
| D10 | 軟體庫 NAS `\\10.10.130.31\docker-folder\RustIT\`,帳密只給後端 | PLATFORM-PLAN §4.6 |
| D11 | 建置與簽章:Windows Runner(先放主機 2,不放 AD 主機)建置 + 人工簽章 | PLATFORM-PLAN §4.9 |

## 4. 需要使用者親自做的事(AI 不可代做)

- **資料庫**:建庫、建帳號、任何 `sa` 操作;AI 產出 T-SQL,由使用者執行。migration 由開發者電腦 `npm run db:migrate` 套用到 `giganexus_It_Agent_test`。
- **主機 2 機密**:`ItAgentBack/deploy/host2-set-secrets.sh` 由使用者執行(密碼隱藏輸入);裝置憑證取走後刪除主機上的副本。
- **憑證與簽章**:AD CS 範本、程式碼簽章憑證、NAS 掛載帳號由 IT / 使用者處理。
- **任何真實帳密**:不要印在對話或寫進 repo。

## 5. 要先取得同意才能做的事

| 動作 | 說明 |
| --- | --- |
| 改 GigaItApp(詳情 Tab、指令按鈕、新選單、`gateway-rbac.yaml`) | 各階段動手前簡短確認;API 權限要等 ItAgentBack 註冊 OpenAPI 後才綁 `includes` |
| 改 Gateway(指南修訂、BFF 權限) | PLATFORM-PLAN §10、§12 |
| 改根目錄 repo(`PROJECT-MAP.md`、`workspace.json`、甘特圖) | 根目錄 `AGENT.md` §4.4 |
| 合併到 `develop`(觸發測試區部署)、主機 2 設定(NAS 掛載、`ita.env`) | 測試區共用,合併前提醒在群組告知 |
| 在任何**別人**的電腦安裝 Agent 或下指令 | 只用自己的電腦測試(`AGENT.md` §5) |

## 6. 開工前先讀 / 先查

1. `../AGENT.md`(分工、部署區、Rust 與 Node.js 規則、Git 分支)。
2. `PLATFORM-PLAN.md`(本階段)→ 對應階段的指南章節:`../../giga-api-gateway-bff/docs/ENDPOINT-AGENT-GUIDE.md` §6(Agent)、§7(Watchdog 與管道)、§8(管理 API 與指令)。
3. `PROJECT-MAP.md`(目錄與檔案職責)、`../ItAgentBack/docs/DB_SCHEMA.md`(資料表與寫入順序)、`contracts/README.md`(相容規則)。
4. 測試區 Agent 套件:`RustAgent/dist/rustit-agent-test/`(exe + `agent.toml` + `pki/`,不進版控,含私鑰)。

## 7. 完成後的收尾

- `docs/DevelopmentProcess/` 留紀錄(格式見 `AGENT.md` §10);改結構時同步 `docs/PROJECT-MAP.md`;`../GigaNexusAIPlan/architecture/*.json` 有變就 `npm run arch:check`。
- 甘特圖:經 API 更新對應任務進度(根目錄記憶 `schedule-source-gantt`)。
- 本文件「目前狀態」與「下一步」隨階段更新。
