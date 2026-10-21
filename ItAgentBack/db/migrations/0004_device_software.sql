/*
  0004 軟體清單查詢表(PLATFORM-PLAN P3;設計 docs/P3-DATA-DESIGN.md §2)— SQL Server 2012 相容。
  只新增資料表,舊版服務照常運作。既有裝置的軟體清單由服務啟動時從 device_inventory.payload 回填(SQL 2012 無 JSON 函式)。
  **部署順序**:先套用本 migration,再部署新版 endpoint-server(新版寫入資產時會替換 device_software)。
*/
-- 每台裝置最新一份資產的軟體清單,隨資產寫入整批替換(同 device_nic 做法);依名稱找電腦
CREATE TABLE ita.device_software (
  id           INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_device_software PRIMARY KEY,
  device_ref   INT               NOT NULL CONSTRAINT fk_device_software_device REFERENCES ita.device (id),
  name         NVARCHAR(400)     NOT NULL,
  version      NVARCHAR(100)     NULL,
  publisher    NVARCHAR(255)     NULL,
  install_date VARCHAR(16)       NULL
);
GO
CREATE INDEX ix_device_software_device ON ita.device_software (device_ref);
CREATE INDEX ix_device_software_name ON ita.device_software (name) INCLUDE (device_ref);
GO
