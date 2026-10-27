/*
  0010 撤回的套件釋放安裝檔路徑(P7 驗收後修正 Agent 0.9.3 項目 5,需求方 2026-10-27 決定;設計 docs/P7-SOFTWARE-DESIGN.md §8.1.5)— SQL Server 2012 相容。
  0008 的 uq_software_package_file UNIQUE (file_name) 涵蓋已撤回的列:撤回後同一個檔案不能重新登錄,只能複製到新資料夾。
  改為篩選唯一索引:只限制未撤回(draft / tested / published)的列。版本號規則不變(uq_software_package_version 仍涵蓋已撤回的列)。
  撤回是終態(沒有「取消撤回」),不會出現兩筆未撤回的列共用檔案。
  舊版服務照常運作:舊版只在登錄時依約束回 409,放寬後只是多允許「撤回後重新登錄」。說明見 docs/DB_SCHEMA.md。
*/

ALTER TABLE ita.software_package DROP CONSTRAINT uq_software_package_file;
GO
-- 篩選索引(與 0006 ux_device_alert_open 相同做法;寫入的連線需 ANSI_NULLS / QUOTED_IDENTIFIER ON,mssql 驅動預設即是)
CREATE UNIQUE INDEX ux_software_package_file_active ON ita.software_package (file_name) WHERE status IN ('draft', 'tested', 'published');
GO
