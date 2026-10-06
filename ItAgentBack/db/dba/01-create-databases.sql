/*
  ItAgentBack 資料庫與帳號(INTEGRATION-PLAN §3.2、決策 D2、D8)— SQL Server 2012(10.10.130.220)
  由 DBA / 使用者以 sa 在 master 執行一次;AI 不以 sa 連線(HANDOFF §4)。比照 Gateway db/dba/05-poc-test-db.sql。

  建立:
    - giganexus_It_Agent_test      開發 + 測試區共用
    - giganexus_It_Agent_poc_test  整合測試專用(npm run test:int 會清空並重建 schema ita,不可指向前者)
    - 登入 ita_app(讀寫)/ ita_migrate(建表、migration)
  正式庫 giganexus_It_Agent(帳號 ita_prod_app / ita_prod_migrate)隨正式區(2026-12)另建,不在本檔。

  權限:
    - ita_migrate:db_ddladmin + schema ita CONTROL(建表、清空重建;migration 紀錄表也在 schema ita)
    - ita_app:經 ita_app_role 讀寫 schema ita;不能改結構
  執行前把兩個 <請自訂強密碼> 換成實際密碼;執行後把帳密放進 ItAgentBack/.env(不進版控)與主機 2 機密。
*/

USE [master];
GO
CREATE LOGIN [ita_app]     WITH PASSWORD = N'<請自訂強密碼>', DEFAULT_DATABASE = [master], CHECK_POLICY = ON;
CREATE LOGIN [ita_migrate] WITH PASSWORD = N'<請自訂強密碼>', DEFAULT_DATABASE = [master], CHECK_POLICY = ON;
GO

CREATE DATABASE [giganexus_It_Agent_test];
GO
ALTER DATABASE [giganexus_It_Agent_test] SET COMPATIBILITY_LEVEL = 110;
GO
CREATE DATABASE [giganexus_It_Agent_poc_test];
GO
ALTER DATABASE [giganexus_It_Agent_poc_test] SET COMPATIBILITY_LEVEL = 110;
GO

-- ---------- giganexus_It_Agent_test ----------
USE [giganexus_It_Agent_test];
GO
CREATE SCHEMA [ita] AUTHORIZATION [dbo];
GO
CREATE USER [ita_migrate] FOR LOGIN [ita_migrate] WITH DEFAULT_SCHEMA = [ita];
EXEC sp_addrolemember N'db_ddladmin', N'ita_migrate';
GRANT CONTROL ON SCHEMA::[ita] TO [ita_migrate];
GO
CREATE ROLE [ita_app_role];
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::[ita] TO [ita_app_role];
CREATE USER [ita_app] FOR LOGIN [ita_app] WITH DEFAULT_SCHEMA = [ita];
EXEC sp_addrolemember N'ita_app_role', N'ita_app';
GO

-- ---------- giganexus_It_Agent_poc_test(權限同上) ----------
USE [giganexus_It_Agent_poc_test];
GO
CREATE SCHEMA [ita] AUTHORIZATION [dbo];
GO
CREATE USER [ita_migrate] FOR LOGIN [ita_migrate] WITH DEFAULT_SCHEMA = [ita];
EXEC sp_addrolemember N'db_ddladmin', N'ita_migrate';
GRANT CONTROL ON SCHEMA::[ita] TO [ita_migrate];
GO
CREATE ROLE [ita_app_role];
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::[ita] TO [ita_app_role];
CREATE USER [ita_app] FOR LOGIN [ita_app] WITH DEFAULT_SCHEMA = [ita];
EXEC sp_addrolemember N'ita_app_role', N'ita_app';
GO

-- 預設資料庫改為開發 / 測試庫(資料庫建立後才能指定)
USE [master];
GO
ALTER LOGIN [ita_app]     WITH DEFAULT_DATABASE = [giganexus_It_Agent_test];
ALTER LOGIN [ita_migrate] WITH DEFAULT_DATABASE = [giganexus_It_Agent_test];
GO

-- 確認:兩個庫的相容層級為 110;兩個庫各有 ita_app_role → ita_app、db_ddladmin → ita_migrate
SELECT name, compatibility_level FROM sys.databases WHERE name LIKE N'giganexus[_]It[_]Agent%';
GO
USE [giganexus_It_Agent_test];
SELECT DB_NAME() AS db, r.name AS role_name, m.name AS member
FROM sys.database_role_members rm
JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
WHERE m.name LIKE N'ita[_]%';
GO
USE [giganexus_It_Agent_poc_test];
SELECT DB_NAME() AS db, r.name AS role_name, m.name AS member
FROM sys.database_role_members rm
JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
WHERE m.name LIKE N'ita[_]%';
GO
