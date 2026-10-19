/*
  0005 裝置所屬公司(ENDPOINT-AGENT-GUIDE §8.2「資料範圍」、§10.2 E6;設計 docs/E6-COMPANY-SCOPE-DESIGN.md §3.1)— SQL Server 2012 相容。
  只新增可為 NULL 的欄位,舊版服務照常運作。既有裝置的公司由服務啟動時依憑證 DN / 回報網域判定(判不出維持 NULL)。
  **部署順序**:先套用本 migration,再部署新版 endpoint-server(新版查詢會讀這兩個欄位)。
*/
-- 名稱同 Gateway gw.company.comp_name(內部 Token 的 cos);NULL = 未指定(只有全部公司角色看得到)
-- company_source:cert(憑證 DN)/ domain(Agent 回報的網域)/ manual(IT 指定,之後不自動改);NULL = 未判定
ALTER TABLE ita.device ADD
  company        NVARCHAR(20)  NULL,
  company_source VARCHAR(8)    NULL;
GO
ALTER TABLE ita.device ADD CONSTRAINT ck_device_company_source
  CHECK (company_source IS NULL OR company_source IN ('cert', 'domain', 'manual'));
GO
CREATE INDEX ix_device_company ON ita.device (company);
GO
