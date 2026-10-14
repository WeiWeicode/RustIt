/*
  0002 離線補傳與端點事件(PLATFORM-PLAN P2 §4.2、§5.2,A1 硬體指紋、A2 時鐘偏差)— SQL Server 2012 相容。
  只新增欄位與索引,舊版服務照常運作(新欄位皆可為 NULL)。說明見 docs/DB_SCHEMA.md。
  主機下發設定先由服務設定提供(全部裝置相同);逐台設定(ita.device_setting)待 GigaItApp 有編輯畫面時再加。
*/

-- 裝置:硬體指紋(疑似同一台)、時鐘偏差、合併與退役(A1、A2)
ALTER TABLE ita.device ADD
  hw_fingerprint   CHAR(64)      NULL,
  clock_skew_ms    INT           NULL,
  clock_checked_at DATETIME2(3)  NULL,
  merged_into      INT           NULL CONSTRAINT fk_device_merged_into REFERENCES ita.device (id),
  retired_at       DATETIME2(3)  NULL;
GO
ALTER TABLE ita.device DROP CONSTRAINT ck_device_status;
GO
ALTER TABLE ita.device ADD CONSTRAINT ck_device_status CHECK (status IN ('active', 'disabled', 'retired'));
GO
CREATE INDEX ix_device_hw_fingerprint ON ita.device (hw_fingerprint) WHERE hw_fingerprint IS NOT NULL;
GO

-- 端點事件:occurred_at 沿用(端點上的發生時間;主機自己產生的稽核仍為寫入時間),另記收到時間、Agent 的事件 ID(去重)與內容
ALTER TABLE ita.device_event ADD
  received_at DATETIME2(3)      NULL,
  event_uid   UNIQUEIDENTIFIER  NULL,
  data        NVARCHAR(4000)    NULL;
GO
CREATE UNIQUE INDEX ux_device_event_uid ON ita.device_event (device_ref, event_uid) WHERE event_uid IS NOT NULL;
CREATE INDEX ix_device_event_type ON ita.device_event (event_type, occurred_at);
GO
