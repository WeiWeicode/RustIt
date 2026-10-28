/*
  0008 軟體派送:軟體目錄與批次核可(PLATFORM-PLAN P7 §4.6、B1;設計 docs/P7-SOFTWARE-DESIGN.md §1、§6)— SQL Server 2012 相容。
  ita.software_package(軟體目錄;draft → tested → published → revoked,兩人覆核)、
  ita.command_batch 加 state(第二人核可閘門)與駁回欄位。
  只新增資料表與有預設值的欄位,舊版服務照常運作(既有批次 state = running)。說明見 docs/DB_SCHEMA.md。
*/

CREATE TABLE ita.software_package (
  id                 INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_software_package PRIMARY KEY,
  package_id         UNIQUEIDENTIFIER  NOT NULL,
  name               NVARCHAR(100)     NOT NULL,
  version            NVARCHAR(50)      NOT NULL,
  -- 軟體庫 SOFTWARE_DIR 底下的相對路徑 {軟體}/{版本}/{檔名}(以 / 分隔;每段只接受 [A-Za-z0-9._ +-],主機登錄與下載時驗證)
  file_name          NVARCHAR(260)     NOT NULL,
  -- 登錄時由 Server 讀檔計算,不接受人工輸入;下載前再比對一次
  sha256             CHAR(64)          NOT NULL,
  size_bytes         BIGINT            NOT NULL,
  installer_type     VARCHAR(16)       NOT NULL,
  -- 靜默安裝 / 移除的額外參數(字元白名單,設計 §2.3;不得含機密)
  install_args       NVARCHAR(500)     NULL,
  uninstall_args     NVARCHAR(500)     NULL,
  detect_type        VARCHAR(16)       NOT NULL,
  detect_value       NVARCHAR(400)     NOT NULL,
  reboot_policy      VARCHAR(16)       NOT NULL CONSTRAINT df_software_package_reboot DEFAULT 'never',
  -- 預期簽章者憑證 SHA-1 指紋(40 碼小寫十六進位,逗號分隔);tested 之前為 NULL
  signer_thumbprints VARCHAR(400)      NULL,
  -- 測試機 Agent 回報的實際簽章者(標記 tested 時寫入;IT 填的 signer_thumbprints 必須在其中)
  observed_signers   VARCHAR(400)      NULL,
  -- 授權數;NULL = 不限(只做派送時的上限檢查,以 device_software 的 display_name 樣式計數)
  license_limit      INT               NULL,
  status             VARCHAR(16)       NOT NULL CONSTRAINT df_software_package_status DEFAULT 'draft',
  notes              NVARCHAR(1000)    NULL,
  created_by_emp     NVARCHAR(64)      NOT NULL,
  created_by_name    NVARCHAR(100)     NULL,
  created_at         DATETIME2(3)      NOT NULL CONSTRAINT df_software_package_created_at DEFAULT SYSUTCDATETIME(),
  updated_by_emp     NVARCHAR(64)      NULL,
  updated_at         DATETIME2(3)      NULL,
  -- 上次發佈以來改過安裝參數 / 偵測規則 / 重開機政策的人(工號,逗號分隔;D2-2:發佈人不可在其中)
  editors            NVARCHAR(1000)    NULL,
  tested_by_emp      NVARCHAR(64)      NULL,
  tested_at          DATETIME2(3)      NULL,
  published_by_emp   NVARCHAR(64)      NULL,
  published_by_name  NVARCHAR(100)     NULL,
  published_at       DATETIME2(3)      NULL,
  revoked_by_emp     NVARCHAR(64)      NULL,
  revoked_at         DATETIME2(3)      NULL,
  -- 撤回前的狀態:只有從 published 撤回的套件可對所有電腦派送移除(未經覆核的移除參數只限 pilot)
  revoked_from       VARCHAR(16)       NULL,
  request_id         VARCHAR(64)       NULL,
  CONSTRAINT uq_software_package_package_id UNIQUE (package_id),
  CONSTRAINT uq_software_package_version UNIQUE (name, version),
  -- 同一個檔案只能登錄一次(換檔要放新版本資料夾、重新登錄)
  CONSTRAINT uq_software_package_file UNIQUE (file_name),
  CONSTRAINT ck_software_package_installer CHECK (installer_type IN ('msi', 'inno', 'nsis', 'burn', 'exe')),
  CONSTRAINT ck_software_package_detect CHECK (detect_type IN ('msi_product_code', 'display_name')),
  CONSTRAINT ck_software_package_reboot CHECK (reboot_policy IN ('never', 'required')),
  CONSTRAINT ck_software_package_status CHECK (status IN ('draft', 'tested', 'published', 'revoked')),
  CONSTRAINT ck_software_package_size CHECK (size_bytes > 0),
  CONSTRAINT ck_software_package_license CHECK (license_limit IS NULL OR license_limit >= 0),
  -- 兩人覆核(ADR 0002、D2-2):發佈人不可是登錄人,也不可是上次發佈以來的修改人;程式先檢查,這裡是第二道防線
  CONSTRAINT ck_software_package_reviewer CHECK (published_by_emp IS NULL OR (published_by_emp <> created_by_emp
    AND CHARINDEX(N',' + published_by_emp + N',', N',' + ISNULL(editors, N'') + N',') = 0))
);
GO
CREATE INDEX ix_software_package_status ON ita.software_package (status, created_at);
GO

-- 批次狀態(B1 第二人核可):pending_approval 的批次指令留在 queued 不送出;核可後 running;24 小時無人核可 expired、駁回 rejected(指令皆 canceled)
ALTER TABLE ita.command_batch ADD state VARCHAR(16) NOT NULL CONSTRAINT df_command_batch_state DEFAULT 'running';
GO
ALTER TABLE ita.command_batch ADD CONSTRAINT ck_command_batch_state CHECK (state IN ('pending_approval', 'running', 'done', 'rejected', 'expired'));
GO
ALTER TABLE ita.command_batch ADD
  rejected_by_emp  NVARCHAR(64)  NULL,
  rejected_by_name NVARCHAR(100) NULL,
  rejected_at      DATETIME2(3)  NULL,
  reject_reason    NVARCHAR(500) NULL;
GO
-- 核可人不可是建立人(程式先檢查,這裡是第二道防線)
ALTER TABLE ita.command_batch ADD CONSTRAINT ck_command_batch_approver CHECK (approved_by_emp IS NULL OR approved_by_emp <> created_by_emp);
GO
-- 待核可逾期掃描
CREATE INDEX ix_command_batch_state ON ita.command_batch (state, created_at);
GO
-- 同一人 24 小時內累計派送台數(D2-1:逐台或多批小批次累計超過門檻也要核可)
CREATE INDEX ix_command_creator ON ita.command (created_by_emp, created_at) INCLUDE (kind, device_ref, batch_ref);
GO
