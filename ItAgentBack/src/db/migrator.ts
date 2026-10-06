/**
 * 手寫 SQL migration(決策 D3:不用 ORM;SQL Server 2012 相容需人工審查)。
 *   - db/migrations/*.sql 依檔名排序執行,每個檔案一個交易;批次以單獨一行 GO 分隔
 *   - 已套用的版本記在 ita.schema_migration(含 SHA-256);已套用的檔案被修改時停止並報錯,改以新檔案修正
 *   - 以 ita_migrate 執行(db_ddladmin + schema ita CONTROL;db/dba/01-create-databases.sql)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sql from 'mssql';

export interface MigrateSqlConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** ITA_DB_HOST / PORT / NAME + ITA_MIGRATE_USER / ITA_MIGRATE_PASSWORD(_FILE);database 可指定(整合測試用 ITA_TEST_DB_NAME) */
export function migrateConfig(env: NodeJS.ProcessEnv = process.env, database?: string): MigrateSqlConfig {
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} 未設定`);
    return v;
  };
  const password = env.ITA_MIGRATE_PASSWORD_FILE ? readFileSync(env.ITA_MIGRATE_PASSWORD_FILE, 'utf8').trim() : need('ITA_MIGRATE_PASSWORD');
  return {
    server: need('ITA_DB_HOST'),
    port: Number(env.ITA_DB_PORT ?? 1433),
    database: database ?? need('ITA_DB_NAME'),
    user: need('ITA_MIGRATE_USER'),
    password,
  };
}

export async function connect(cfg: MigrateSqlConfig): Promise<sql.ConnectionPool> {
  return new sql.ConnectionPool({
    ...cfg,
    connectionTimeout: 10000,
    requestTimeout: 60000,
    options: { encrypt: false, trustServerCertificate: true, appName: 'it-agent-back-migrate' },
  }).connect();
}

const splitBatches = (text: string) =>
  text
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter((b) => b.replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '').trim().length > 0);

export async function migrate(pool: sql.ConnectionPool, dir: string, log: (msg: string) => void = console.log): Promise<string[]> {
  await pool.request().batch(`
    IF OBJECT_ID(N'ita.schema_migration', N'U') IS NULL
      CREATE TABLE ita.schema_migration (
        version    VARCHAR(100) NOT NULL CONSTRAINT pk_schema_migration PRIMARY KEY,
        checksum   CHAR(64)     NOT NULL,
        applied_at DATETIME2(3) NOT NULL CONSTRAINT df_schema_migration_applied_at DEFAULT SYSUTCDATETIME()
      );`);
  const applied = new Map(
    ((await pool.request().query('SELECT version, checksum FROM ita.schema_migration')).recordset as { version: string; checksum: string }[]).map((r) => [
      r.version,
      r.checksum,
    ]),
  );

  const done: string[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const version = file.replace(/\.sql$/, '');
    const text = readFileSync(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(text).digest('hex');
    const prev = applied.get(version);
    if (prev) {
      if (prev !== checksum) throw new Error(`migration ${file} 已套用後被修改(checksum 不符);請新增一個 migration 檔修正,不要改已套用的檔案`);
      continue;
    }
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const batch of splitBatches(text)) await new sql.Request(tx).batch(batch);
      await new sql.Request(tx)
        .input('v', sql.VarChar(100), version)
        .input('c', sql.Char(64), checksum)
        .query('INSERT INTO ita.schema_migration (version, checksum) VALUES (@v, @c)');
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw new Error(`migration ${file} 失敗:${(err as Error).message}`);
    }
    log(`已套用 ${file}`);
    done.push(version);
  }
  return done;
}

/** 清空 schema ita(只限整合測試庫,名稱必須以 _poc_test 結尾;不可指向開發 / 測試 / 正式庫) */
export async function resetSchema(pool: sql.ConnectionPool): Promise<void> {
  const db = String((await pool.request().query('SELECT DB_NAME() AS db')).recordset[0].db);
  if (!db.endsWith('_poc_test')) throw new Error(`拒絕清空 ${db}:只允許整合測試庫(*_poc_test)`);
  await pool.request().batch(`
    DECLARE @sql NVARCHAR(MAX) = N'';
    SELECT @sql = @sql + N'ALTER TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N' DROP CONSTRAINT ' + QUOTENAME(f.name) + N';'
      FROM sys.foreign_keys f JOIN sys.tables t ON t.object_id = f.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = N'ita';
    SELECT @sql = @sql + N'DROP TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N';'
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = N'ita';
    EXEC sp_executesql @sql;`);
}
