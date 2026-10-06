/*
  0001 初始結構(INTEGRATION-PLAN §3.1;說明見 docs/DB_SCHEMA.md)— SQL Server 2012 相容(DATABASE.md §0:無 JSON 函式、無 CREATE OR ALTER)
  以 ita_migrate 執行(npm run db:migrate);schema ita 由 db/dba/01-create-databases.sql 建立。
  時間一律 UTC(SYSUTCDATETIME)。批次以單獨一行 GO 分隔。
*/

CREATE TABLE ita.device (
  id                INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_device PRIMARY KEY,
  device_id         UNIQUEIDENTIFIER  NOT NULL CONSTRAINT df_device_device_id DEFAULT NEWID(),
  cert_dn           NVARCHAR(450)     NOT NULL,
  cert_fp           CHAR(40)          NOT NULL,
  computer_name     NVARCHAR(255)     NOT NULL,
  status            VARCHAR(16)       NOT NULL CONSTRAINT df_device_status DEFAULT 'active',
  agent_version     VARCHAR(32)       NULL,
  first_seen_at     DATETIME2(3)      NOT NULL,
  last_seen_at      DATETIME2(3)      NOT NULL,
  last_inventory_at DATETIME2(3)      NULL,
  created_at        DATETIME2(3)      NOT NULL CONSTRAINT df_device_created_at DEFAULT SYSUTCDATETIME(),
  created_by        NVARCHAR(64)      NOT NULL,
  updated_at        DATETIME2(3)      NOT NULL CONSTRAINT df_device_updated_at DEFAULT SYSUTCDATETIME(),
  updated_by        NVARCHAR(64)      NOT NULL,
  row_ver           ROWVERSION        NOT NULL,
  CONSTRAINT uq_device_device_id UNIQUE (device_id),
  CONSTRAINT uq_device_cert_dn UNIQUE (cert_dn),
  CONSTRAINT ck_device_status CHECK (status IN ('active', 'disabled'))
);
GO
CREATE INDEX ix_device_computer_name ON ita.device (computer_name);
GO

-- 每台裝置最新的一份資產:查詢用的摘要欄位 + 完整 payload(Agent 的 ComputerInfo JSON,資料庫只當字串存)
CREATE TABLE ita.device_inventory (
  device_ref         INT              NOT NULL CONSTRAINT pk_device_inventory PRIMARY KEY
                                      CONSTRAINT fk_device_inventory_device REFERENCES ita.device (id),
  agent_seq          BIGINT           NOT NULL,
  content_hash       CHAR(64)         NOT NULL,
  collected_at       DATETIME2(3)     NOT NULL,
  received_at        DATETIME2(3)     NOT NULL,
  host_name          NVARCHAR(255)    NOT NULL,
  user_name          NVARCHAR(255)    NULL,
  domain             NVARCHAR(255)    NULL,
  part_of_domain     BIT              NULL,
  manufacturer       NVARCHAR(255)    NULL,
  model              NVARCHAR(255)    NULL,
  os_name            NVARCHAR(255)    NULL,
  os_version         NVARCHAR(100)    NULL,
  os_display_version NVARCHAR(50)     NULL,
  os_build           NVARCHAR(50)     NULL,
  arch               VARCHAR(32)      NULL,
  boot_time          DATETIME2(0)     NULL,
  bios_serial        NVARCHAR(255)    NULL,
  system_uuid        NVARCHAR(64)     NULL,
  cpu_name           NVARCHAR(255)    NULL,
  cpu_cores          INT              NULL,
  cpu_logical        INT              NULL,
  memory_total       BIGINT           NULL,
  primary_ip         VARCHAR(45)      NULL,
  payload            NVARCHAR(MAX)    NOT NULL,
  created_at         DATETIME2(3)     NOT NULL CONSTRAINT df_device_inventory_created_at DEFAULT SYSUTCDATETIME(),
  created_by         NVARCHAR(64)     NOT NULL,
  updated_at         DATETIME2(3)     NOT NULL CONSTRAINT df_device_inventory_updated_at DEFAULT SYSUTCDATETIME(),
  updated_by         NVARCHAR(64)     NOT NULL,
  row_ver            ROWVERSION       NOT NULL
);
GO

-- 網卡位址:一張網卡的每個 IP 一列(沒有 IP 的網卡一列 ip_address = NULL),可依 IP / MAC 查詢;隨最新資產整批替換
CREATE TABLE ita.device_nic (
  id           INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_device_nic PRIMARY KEY,
  device_ref   INT               NOT NULL CONSTRAINT fk_device_nic_device REFERENCES ita.device (id),
  nic_index    INT               NOT NULL,
  description  NVARCHAR(255)     NULL,
  mac          VARCHAR(32)       NULL,
  ip_address   VARCHAR(45)       NULL,
  is_ipv6      BIT               NOT NULL CONSTRAINT df_device_nic_is_ipv6 DEFAULT 0,
  has_gateway  BIT               NOT NULL CONSTRAINT df_device_nic_has_gateway DEFAULT 0,
  dhcp_enabled BIT               NOT NULL CONSTRAINT df_device_nic_dhcp DEFAULT 0
);
GO
CREATE INDEX ix_device_nic_device ON ita.device_nic (device_ref);
CREATE INDEX ix_device_nic_mac ON ita.device_nic (mac);
CREATE INDEX ix_device_nic_ip ON ita.device_nic (ip_address);
GO

-- 稽核(ENDPOINT-AGENT-GUIDE §3.3、§5.4):首次登錄、新指紋、停用 / 啟用、重複 DN
CREATE TABLE ita.device_event (
  id          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_device_event PRIMARY KEY,
  device_ref  INT                  NULL CONSTRAINT fk_device_event_device REFERENCES ita.device (id),
  event_type  VARCHAR(32)          NOT NULL,
  cert_dn     NVARCHAR(450)        NULL,
  cert_fp     CHAR(40)             NULL,
  detail      NVARCHAR(1000)       NULL,
  request_id  VARCHAR(64)          NULL,
  occurred_at DATETIME2(3)         NOT NULL CONSTRAINT df_device_event_occurred_at DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX ix_device_event_device ON ita.device_event (device_ref, occurred_at);
GO
