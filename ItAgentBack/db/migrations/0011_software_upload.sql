/*
  0011 軟體套件上傳與送簽(S1-3;設計 docs/S1-SIGNING-DESIGN.md §4、ADR 0005)— SQL Server 2012 相容。
  ita.software_upload:IT 上傳(或以網路芳鄰放進 NAS incoming\ 後登錄)的原始安裝檔;第二人核可後寫送簽工作單(sign-queue\),
  簽章工作站以軟體發佈憑證重簽後放進軟體庫(software\),endpoint-server 重算雜湊確認後標記 signed。
  uploaded →(第二人核可)queued →(工作站結果、主機重算相符)signed;uploaded / queued 可駁回,工作站拒絕或結果不符為 rejected。
  只新增資料表,舊版服務照常運作。說明見 docs/DB_SCHEMA.md。
*/

CREATE TABLE ita.software_upload (
  id                    INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_software_upload PRIMARY KEY,
  upload_id             UNIQUEIDENTIFIER  NOT NULL,
  -- 相對路徑 {軟體}/{版本}/{檔名}(以 / 分隔,規則與軟體庫相同):incoming\ 內的原始檔與簽章後軟體庫內的目標位置相同
  file_name             NVARCHAR(260)     NOT NULL,
  -- 上傳完成(或登錄)時由 Server 讀檔計算;核可時再算一次
  sha256                CHAR(64)          NOT NULL,
  size_bytes            BIGINT            NOT NULL,
  state                 VARCHAR(16)       NOT NULL CONSTRAINT df_software_upload_state DEFAULT 'uploaded',
  -- upload = 經 API 串流上傳;incoming = 網路芳鄰放進 incoming\ 後登錄(過渡期,§9-2)
  source                VARCHAR(16)       NOT NULL,
  notes                 NVARCHAR(1000)    NULL,
  uploaded_by_emp       NVARCHAR(64)      NOT NULL,
  uploaded_by_name      NVARCHAR(100)     NULL,
  uploaded_at           DATETIME2(3)      NOT NULL CONSTRAINT df_software_upload_uploaded_at DEFAULT SYSUTCDATETIME(),
  approved_by_emp       NVARCHAR(64)      NULL,
  approved_by_name      NVARCHAR(100)     NULL,
  approved_at           DATETIME2(3)      NULL,
  -- 駁回(rejected_by_emp 有值)或工作站拒絕 / 結果不符(rejected_by_emp 為 NULL)
  reject_code           VARCHAR(40)       NULL,
  reject_reason         NVARCHAR(500)     NULL,
  rejected_by_emp       NVARCHAR(64)      NULL,
  rejected_at           DATETIME2(3)      NULL,
  -- 工作站回報(只供覆核顯示,不作為安全判斷)
  vendor_signer         CHAR(40)          NULL,
  vendor_signer_subject NVARCHAR(400)     NULL,
  vendor_check          VARCHAR(16)       NULL,
  signed_signer         CHAR(40)          NULL,
  sign_operator         NVARCHAR(100)     NULL,
  -- 主機以軟體庫實際檔案重算的雜湊(等於工作站回報的 signed_sha256 才標記 signed)
  signed_sha256         CHAR(64)          NULL,
  signed_at             DATETIME2(3)      NULL,
  request_id            VARCHAR(64)       NULL,
  CONSTRAINT uq_software_upload_upload_id UNIQUE (upload_id),
  CONSTRAINT ck_software_upload_state CHECK (state IN ('uploaded', 'queued', 'signed', 'rejected')),
  CONSTRAINT ck_software_upload_source CHECK (source IN ('upload', 'incoming')),
  CONSTRAINT ck_software_upload_size CHECK (size_bytes > 0),
  -- 送簽要兩個人(ADR 0005):核可人不可是上傳者;程式先檢查,這裡是第二道防線
  CONSTRAINT ck_software_upload_approver CHECK (approved_by_emp IS NULL OR approved_by_emp <> uploaded_by_emp)
);
GO
-- 同一個路徑同時只能有一筆進行中(uploaded / queued);signed / rejected 不限制(同路徑可重新上傳)
-- 條件明確列出受限的狀態:ck_software_upload_state 新增狀態時要檢查這個條件
CREATE UNIQUE INDEX ux_software_upload_file_active ON ita.software_upload (file_name) WHERE state IN ('uploaded', 'queued');
GO
CREATE INDEX ix_software_upload_state ON ita.software_upload (state, uploaded_at);
GO
