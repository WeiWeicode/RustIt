/*
  0007 升級:版本登錄與發佈環(PLATFORM-PLAN P6 §4.5;設計 docs/P6-UPGRADE-DESIGN.md §1)— SQL Server 2012 相容。
  ita.agent_release(版本登錄)、ita.release_ring(各環 × 元件的目標版本)、ita.device_upgrade(各裝置 × 元件的升級進度,1:1)、
  ita.device 加 ring(所屬發佈環,預設 all)。
  只新增資料表與有預設值的欄位,舊版服務照常運作。說明見 docs/DB_SCHEMA.md。
*/

CREATE TABLE ita.agent_release (
  id                 INT IDENTITY(1,1) NOT NULL CONSTRAINT pk_agent_release PRIMARY KEY,
  release_id         UNIQUEIDENTIFIER  NOT NULL,
  component          VARCHAR(16)       NOT NULL,
  version            VARCHAR(32)       NOT NULL,
  -- 版本檔目錄 {component}/{version}/ 底下的檔名(主機只接受 [A-Za-z0-9._-])
  file_name          NVARCHAR(128)     NOT NULL,
  -- 登錄時由 Server 讀檔計算,不接受人工輸入
  sha256             CHAR(64)          NOT NULL,
  size_bytes         BIGINT            NOT NULL,
  -- 預期簽章者憑證 SHA-1 指紋(40 碼小寫十六進位,逗號分隔;換憑證時可同時列新舊)
  signer_thumbprints VARCHAR(400)      NOT NULL,
  status             VARCHAR(16)       NOT NULL CONSTRAINT df_agent_release_status DEFAULT 'draft',
  notes              NVARCHAR(1000)    NULL,
  created_by_emp     NVARCHAR(64)      NOT NULL,
  created_by_name    NVARCHAR(100)     NULL,
  created_at         DATETIME2(3)      NOT NULL CONSTRAINT df_agent_release_created_at DEFAULT SYSUTCDATETIME(),
  published_by_emp   NVARCHAR(64)      NULL,
  published_at       DATETIME2(3)      NULL,
  revoked_by_emp     NVARCHAR(64)      NULL,
  revoked_at         DATETIME2(3)      NULL,
  request_id         VARCHAR(64)       NULL,
  CONSTRAINT uq_agent_release_release_id UNIQUE (release_id),
  CONSTRAINT uq_agent_release_version UNIQUE (component, version),
  CONSTRAINT ck_agent_release_component CHECK (component IN ('agent', 'watchdog', 'desktop')),
  CONSTRAINT ck_agent_release_status CHECK (status IN ('draft', 'published', 'revoked')),
  CONSTRAINT ck_agent_release_size CHECK (size_bytes > 0)
);
GO

-- 各環 × 元件的目標版本;target_version NULL = 不升級(維持現況)。可設比目前舊的版本(降版走同一流程)
CREATE TABLE ita.release_ring (
  ring               VARCHAR(16)       NOT NULL,
  component          VARCHAR(16)       NOT NULL,
  target_version     VARCHAR(32)       NULL,
  -- 這個目標開始生效的時間(推進限制:pilot 同一版本未滿 24 小時不可設給 it / all;version_mismatch 告警的起算點)
  target_set_at      DATETIME2(3)      NULL,
  updated_by_emp     NVARCHAR(64)      NULL,
  updated_by_name    NVARCHAR(100)     NULL,
  updated_at         DATETIME2(3)      NOT NULL CONSTRAINT df_release_ring_updated_at DEFAULT SYSUTCDATETIME(),
  request_id         VARCHAR(64)       NULL,
  CONSTRAINT pk_release_ring PRIMARY KEY (ring, component),
  CONSTRAINT ck_release_ring_ring CHECK (ring IN ('pilot', 'it', 'all')),
  CONSTRAINT ck_release_ring_component CHECK (component IN ('agent', 'watchdog', 'desktop'))
);
GO
INSERT INTO ita.release_ring (ring, component)
SELECT r.ring, c.component
FROM (SELECT 'pilot' AS ring UNION ALL SELECT 'it' UNION ALL SELECT 'all') r
CROSS JOIN (SELECT 'agent' AS component UNION ALL SELECT 'watchdog') c;
GO

ALTER TABLE ita.device ADD ring VARCHAR(16) NOT NULL CONSTRAINT df_device_ring DEFAULT 'all';
GO
ALTER TABLE ita.device ADD CONSTRAINT ck_device_ring CHECK (ring IN ('pilot', 'it', 'all'));
GO

-- 各裝置 × 元件的升級進度(Watchdog 上報的 upgrade、agent.upgrade 強制版本、同版本失敗次數)
CREATE TABLE ita.device_upgrade (
  device_ref         INT               NOT NULL CONSTRAINT fk_device_upgrade_device REFERENCES ita.device (id),
  component          VARCHAR(16)       NOT NULL,
  target_version     VARCHAR(32)       NULL,
  from_version       VARCHAR(32)       NULL,
  state              VARCHAR(16)       NOT NULL,
  -- 同一目標版本的失敗次數(換目標版本時歸零;達 2 次不再自動下發)
  attempts           INT               NOT NULL CONSTRAINT df_device_upgrade_attempts DEFAULT 0,
  error_code         VARCHAR(32)       NULL,
  error_message      NVARCHAR(300)     NULL,
  -- agent.upgrade 指定版本(強制升級 / 降版):優先於所屬環的目標
  forced_version     VARCHAR(32)       NULL,
  forced_by_emp      NVARCHAR(64)      NULL,
  forced_at          DATETIME2(3)      NULL,
  started_at         DATETIME2(3)      NULL,
  updated_at         DATETIME2(3)      NOT NULL CONSTRAINT df_device_upgrade_updated_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_device_upgrade PRIMARY KEY (device_ref, component),
  CONSTRAINT ck_device_upgrade_component CHECK (component IN ('agent', 'watchdog', 'desktop')),
  CONSTRAINT ck_device_upgrade_state CHECK (state IN ('pending', 'downloading', 'verifying', 'installing', 'succeeded', 'failed', 'rolled_back')),
  CONSTRAINT ck_device_upgrade_attempts CHECK (attempts >= 0)
);
GO
-- 並行上限計算:進行中的台數
CREATE INDEX ix_device_upgrade_state ON ita.device_upgrade (state, updated_at);
GO
