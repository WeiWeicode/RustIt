/*
  0009 軟體套件安裝逾時(P7 VM 驗收 B-1,需求方 2026-10-27 決定;設計 docs/P7-SOFTWARE-DESIGN.md §1、§2.2)— SQL Server 2012 相容。
  ita.software_package 加 timeout_sec:Agent 執行安裝 / 移除程式的逾時(秒),範圍 300–7200,預設 1800。
  原本固定 1800(software-service.ts INSTALL_TIMEOUT_SEC),既有套件補 1800,行為不變。
  只新增有預設值的欄位,舊版服務照常運作(不讀此欄位,快照仍帶 1800)。說明見 docs/DB_SCHEMA.md。
*/

-- NOT NULL + DEFAULT:新增欄位時以預設值填入既有的列(既有套件 = 1800)
ALTER TABLE ita.software_package ADD timeout_sec INT NOT NULL CONSTRAINT df_software_package_timeout DEFAULT 1800;
GO
-- 程式先檢查(登錄 / 修改 API 回 400),這裡是第二道防線
ALTER TABLE ita.software_package ADD CONSTRAINT ck_software_package_timeout CHECK (timeout_sec BETWEEN 300 AND 7200);
GO
