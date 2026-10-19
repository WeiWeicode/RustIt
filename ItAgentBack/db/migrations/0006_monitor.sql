/*
  0006 監測(PLATFORM-PLAN P5 §4.3、§4.10 A5;設計 docs/P5-MONITOR-DESIGN.md §1)— SQL Server 2012 相容。
  ita.device_health(最近健康摘要與 Watchdog 狀態,1:1;Watchdog 欄位 P5-2 才寫入)、ita.device_alert(告警)。
  只新增資料表,舊版服務照常運作。主機產生的軟硬體變更事件寫既有 ita.device_event(event_uid NULL、內容在 data)。
  說明見 docs/DB_SCHEMA.md。
*/

CREATE TABLE ita.device_health (
  device_ref          INT            NOT NULL CONSTRAINT pk_device_health PRIMARY KEY
                                     CONSTRAINT fk_device_health_device REFERENCES ita.device (id),
  -- 心跳的健康摘要(每 5 分鐘落盤一次,與 last_seen_at 同節奏)
  health_at           DATETIME2(3)   NULL,
  cpu_pct             TINYINT        NULL,
  mem_used_pct        TINYINT        NULL,
  disk_min_free_pct   TINYINT        NULL,
  disk_min_free_drive VARCHAR(8)     NULL,
  uptime_s            INT            NULL,
  agent_rss_mb        INT            NULL,
  -- 裝置憑證到期日(hello 或 Watchdog 回報,取最新)
  cert_not_after      DATETIME2(3)   NULL,
  -- Watchdog 回報(P5-2)
  watchdog_version    VARCHAR(32)    NULL,
  watchdog_report_at  DATETIME2(3)   NULL,
  agent_service_state VARCHAR(16)    NULL,
  agent_start_type    VARCHAR(16)    NULL,
  agent_status_ok     BIT            NULL,
  agent_last_error    NVARCHAR(300)  NULL,
  agent_restarts_24h  INT            NULL,
  updated_at          DATETIME2(3)   NOT NULL CONSTRAINT df_device_health_updated_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT ck_device_health_cpu CHECK (cpu_pct IS NULL OR cpu_pct <= 100),
  CONSTRAINT ck_device_health_mem CHECK (mem_used_pct IS NULL OR mem_used_pct <= 100),
  CONSTRAINT ck_device_health_disk CHECK (disk_min_free_pct IS NULL OR disk_min_free_pct <= 100)
);
GO

-- 告警(規則固定,P5-MONITOR-DESIGN §4):同一台同一規則只有一筆未結束;條件持續成立只更新 last_seen_at / detail
CREATE TABLE ita.device_alert (
  id               BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_device_alert PRIMARY KEY,
  alert_id         UNIQUEIDENTIFIER     NOT NULL,
  device_ref       INT                  NOT NULL CONSTRAINT fk_device_alert_device REFERENCES ita.device (id),
  [rule]           VARCHAR(32)          NOT NULL,
  severity         VARCHAR(8)           NOT NULL,
  state            VARCHAR(16)          NOT NULL CONSTRAINT df_device_alert_state DEFAULT 'open',
  opened_at        DATETIME2(3)         NOT NULL CONSTRAINT df_device_alert_opened_at DEFAULT SYSUTCDATETIME(),
  last_seen_at     DATETIME2(3)         NOT NULL CONSTRAINT df_device_alert_last_seen_at DEFAULT SYSUTCDATETIME(),
  resolved_at      DATETIME2(3)         NULL,
  resolved_by      VARCHAR(8)           NULL,
  resolved_by_emp  NVARCHAR(64)         NULL,
  resolved_by_name NVARCHAR(100)        NULL,
  resolve_note     NVARCHAR(500)        NULL,
  detail           NVARCHAR(2000)       NULL,
  event_ref        BIGINT               NULL CONSTRAINT fk_device_alert_event REFERENCES ita.device_event (id),
  request_id       VARCHAR(64)          NULL,
  CONSTRAINT uq_device_alert_alert_id UNIQUE (alert_id),
  CONSTRAINT ck_device_alert_severity CHECK (severity IN ('warn', 'critical')),
  CONSTRAINT ck_device_alert_state CHECK (state IN ('open', 'resolved')),
  CONSTRAINT ck_device_alert_resolved_by CHECK (resolved_by IS NULL OR resolved_by IN ('auto', 'manual'))
);
GO
CREATE UNIQUE INDEX ux_device_alert_open ON ita.device_alert (device_ref, [rule]) WHERE state = 'open';
CREATE INDEX ix_device_alert_state ON ita.device_alert (state, opened_at);
CREATE INDEX ix_device_alert_device ON ita.device_alert (device_ref, opened_at);
GO
