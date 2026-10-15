/*
  0003 指令通道(PLATFORM-PLAN P4 §4.4、§5.2;ENDPOINT-AGENT-GUIDE §8.3–§8.5)— SQL Server 2012 相容。
  ita.command_batch(多台同一指令;第二人核可欄位 B1 先建,邏輯在 P7)、ita.command(一筆 = 一台電腦一個動作,含稽核)、
  ita.command_file(診斷檔案索引 A4;程式在 P4-2)。只新增資料表,舊版服務照常運作。說明見 docs/DB_SCHEMA.md。
*/

CREATE TABLE ita.command_batch (
  id                BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_command_batch PRIMARY KEY,
  batch_id          UNIQUEIDENTIFIER     NOT NULL,
  kind              VARCHAR(64)          NOT NULL,
  level             VARCHAR(8)           NOT NULL,
  params            NVARCHAR(4000)       NOT NULL,
  target_count      INT                  NOT NULL,
  max_concurrent    INT                  NOT NULL CONSTRAINT df_command_batch_max_concurrent DEFAULT 20,
  requires_approval BIT                  NOT NULL CONSTRAINT df_command_batch_requires_approval DEFAULT 0,
  approved_by_emp   NVARCHAR(64)         NULL,
  approved_by_name  NVARCHAR(100)        NULL,
  approved_at       DATETIME2(3)         NULL,
  idempotency_key   VARCHAR(128)         NULL,
  created_by_emp    NVARCHAR(64)         NOT NULL,
  created_by_name   NVARCHAR(100)        NULL,
  request_id        VARCHAR(64)          NULL,
  created_at        DATETIME2(3)         NOT NULL CONSTRAINT df_command_batch_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_command_batch_batch_id UNIQUE (batch_id),
  CONSTRAINT ck_command_batch_level CHECK (level IN ('basic', 'admin')),
  CONSTRAINT ck_command_batch_max_concurrent CHECK (max_concurrent > 0)
);
GO
CREATE UNIQUE INDEX ux_command_batch_idem ON ita.command_batch (created_by_emp, idempotency_key) WHERE idempotency_key IS NOT NULL;
GO

CREATE TABLE ita.command (
  id              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_command PRIMARY KEY,
  command_id      UNIQUEIDENTIFIER     NOT NULL,
  batch_ref       BIGINT               NULL CONSTRAINT fk_command_batch REFERENCES ita.command_batch (id),
  device_ref      INT                  NOT NULL CONSTRAINT fk_command_device REFERENCES ita.device (id),
  cert_dn         NVARCHAR(450)        NOT NULL,
  kind            VARCHAR(64)          NOT NULL,
  level           VARCHAR(8)           NOT NULL,
  params          NVARCHAR(4000)       NOT NULL,
  state           VARCHAR(16)          NOT NULL CONSTRAINT df_command_state DEFAULT 'queued',
  progress        TINYINT              NULL,
  result_summary  NVARCHAR(4000)       NULL,
  error_code      VARCHAR(64)          NULL,
  error_message   NVARCHAR(1000)       NULL,
  expires_at      DATETIME2(3)         NOT NULL,
  timeout_at      DATETIME2(3)         NULL,
  send_count      INT                  NOT NULL CONSTRAINT df_command_send_count DEFAULT 0,
  idempotency_key VARCHAR(128)         NULL,
  created_by_emp  NVARCHAR(64)         NOT NULL,
  created_by_name NVARCHAR(100)        NULL,
  request_id      VARCHAR(64)          NULL,
  created_at      DATETIME2(3)         NOT NULL CONSTRAINT df_command_created_at DEFAULT SYSUTCDATETIME(),
  sent_at         DATETIME2(3)         NULL,
  acked_at        DATETIME2(3)         NULL,
  started_at      DATETIME2(3)         NULL,
  finished_at     DATETIME2(3)         NULL,
  updated_at      DATETIME2(3)         NOT NULL CONSTRAINT df_command_updated_at DEFAULT SYSUTCDATETIME(),
  row_ver         ROWVERSION           NOT NULL,
  CONSTRAINT uq_command_command_id UNIQUE (command_id),
  CONSTRAINT ck_command_level CHECK (level IN ('basic', 'admin')),
  CONSTRAINT ck_command_state CHECK (state IN ('queued', 'sent', 'acked', 'running', 'succeeded', 'failed', 'canceled', 'expired')),
  CONSTRAINT ck_command_progress CHECK (progress IS NULL OR progress <= 100)
);
GO
-- 重連補送、裝置指令紀錄
CREATE INDEX ix_command_device_state ON ita.command (device_ref, state, created_at);
-- 逾期 / 逾時掃描
CREATE INDEX ix_command_state_expires ON ita.command (state, expires_at);
CREATE INDEX ix_command_batch ON ita.command (batch_ref) WHERE batch_ref IS NOT NULL;
-- 全部指令紀錄(新到舊)
CREATE INDEX ix_command_created_at ON ita.command (created_at);
CREATE UNIQUE INDEX ux_command_idem ON ita.command (created_by_emp, idempotency_key) WHERE idempotency_key IS NOT NULL;
GO

-- 診斷檔案(logs.collect / agent.diagnose 上傳的檔案;A4、保存期限 B5)
CREATE TABLE ita.command_file (
  id           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_command_file PRIMARY KEY,
  file_id      UNIQUEIDENTIFIER     NOT NULL,
  command_ref  BIGINT               NOT NULL CONSTRAINT fk_command_file_command REFERENCES ita.command (id),
  file_name    NVARCHAR(255)        NOT NULL,
  size_bytes   BIGINT               NOT NULL,
  sha256       CHAR(64)             NOT NULL,
  storage_path NVARCHAR(400)        NOT NULL,
  created_at   DATETIME2(3)         NOT NULL CONSTRAINT df_command_file_created_at DEFAULT SYSUTCDATETIME(),
  expires_at   DATETIME2(3)         NOT NULL,
  CONSTRAINT uq_command_file_file_id UNIQUE (file_id)
);
GO
CREATE INDEX ix_command_file_command ON ita.command_file (command_ref);
CREATE INDEX ix_command_file_expires ON ita.command_file (expires_at);
GO
