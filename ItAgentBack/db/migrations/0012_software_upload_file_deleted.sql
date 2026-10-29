/*
  0012 刪除上傳區原始檔的紀錄(S1 簽章上架,需求方 2026-10-29 決定;設計 docs/S1-SIGNING-DESIGN.md §4.4)— SQL Server 2012 相容。
  被駁回(rejected)的上傳,原始檔仍留在 NAS incoming\,同路徑無法再上傳;IT 可在 GigaItApp 刪除原始檔,紀錄保留,
  這兩個欄位記錄刪除人與時間(畫面顯示「原始檔已刪除」並隱藏刪除按鈕)。只有 rejected 的紀錄可刪(程式條件更新,這裡的 CHECK 是第二道防線)。
  只新增可為 NULL 的欄位,舊版服務照常運作(不讀這兩個欄位)。說明見 docs/DB_SCHEMA.md。
*/

ALTER TABLE ita.software_upload ADD file_deleted_by_emp NVARCHAR(64) NULL, file_deleted_at DATETIME2(3) NULL;
GO
ALTER TABLE ita.software_upload ADD CONSTRAINT ck_software_upload_file_deleted CHECK (file_deleted_at IS NULL OR state = 'rejected');
GO
