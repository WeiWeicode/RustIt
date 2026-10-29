/*
  ItAgentBack 正式庫與帳號(INTEGRATION-PLAN §3.2、決策 D2、D8)— SQL Server 2012(10.10.130.220)
  由 DBA / 使用者以 sa 在 master 執行一次;AI 不以 sa 連線(HANDOFF §4)。權限與 01-create-databases.sql 相同,帳號與測試區分開。

  建立:
    - giganexus_It_Agent           正式庫(已存在則略過建立,只補 schema 與帳號)
    - 登入 ita_prod_app(讀寫)/ ita_prod_migrate(建表、migration)
  執行前把兩個 <請自訂強密碼> 換成實際密碼(與測試區不同);執行後:
    - ita_prod_app:主機 3 執行 sudo sh /srv/giganexus/deploy/host3-set-ita-db.sh(寫入 ita_db_password、ita.env 的 ITA_DB_USER)
    - ita_prod_migrate:開發機在 ItAgentBack/ 執行一次 migration(docs/RUNBOOK.md「正式區」),之後不放在任何主機
*/

USE [master];
GO
CREATE LOGIN [ita_prod_app]     WITH PASSWORD = N'<請自訂強密碼>', DEFAULT_DATABASE = [master], CHECK_POLICY = ON;
CREATE LOGIN [ita_prod_migrate] WITH PASSWORD = N'<請自訂強密碼>', DEFAULT_DATABASE = [master], CHECK_POLICY = ON;
GO

IF DB_ID(N'giganexus_It_Agent') IS NULL
  CREATE DATABASE [giganexus_It_Agent];
GO
ALTER DATABASE [giganexus_It_Agent] SET COMPATIBILITY_LEVEL = 110;
GO

USE [giganexus_It_Agent];
GO
IF SCHEMA_ID(N'ita') IS NULL
  EXEC (N'CREATE SCHEMA [ita] AUTHORIZATION [dbo]');
GO
CREATE USER [ita_prod_migrate] FOR LOGIN [ita_prod_migrate] WITH DEFAULT_SCHEMA = [ita];
EXEC sp_addrolemember N'db_ddladmin', N'ita_prod_migrate';
GRANT CONTROL ON SCHEMA::[ita] TO [ita_prod_migrate];
GO
IF DATABASE_PRINCIPAL_ID(N'ita_app_role') IS NULL
  CREATE ROLE [ita_app_role];
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::[ita] TO [ita_app_role];
CREATE USER [ita_prod_app] FOR LOGIN [ita_prod_app] WITH DEFAULT_SCHEMA = [ita];
EXEC sp_addrolemember N'ita_app_role', N'ita_prod_app';
GO

USE [master];
GO
ALTER LOGIN [ita_prod_app]     WITH DEFAULT_DATABASE = [giganexus_It_Agent];
ALTER LOGIN [ita_prod_migrate] WITH DEFAULT_DATABASE = [giganexus_It_Agent];
GO

-- 確認:相容層級 110;ita_app_role → ita_prod_app、db_ddladmin → ita_prod_migrate;測試區帳號 ita_app / ita_migrate 不應出現在本庫
SELECT name, compatibility_level FROM sys.databases WHERE name = N'giganexus_It_Agent';
GO
USE [giganexus_It_Agent];
SELECT DB_NAME() AS db, r.name AS role_name, m.name AS member
FROM sys.database_role_members rm
JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
WHERE m.name LIKE N'ita[_]%';
GO
