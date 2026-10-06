/** npm run db:migrate(開發讀 .env);容器內:node dist/src/migrate.js。以 ita_migrate 套用 db/migrations/ 尚未執行的檔案 */
import path from 'node:path';
import { connect, migrate, migrateConfig } from './db/migrator.js';

const cfg = migrateConfig();
const pool = await connect(cfg);
try {
  const done = await migrate(pool, path.resolve(process.cwd(), 'db/migrations'));
  console.log(done.length ? `${cfg.database}:套用 ${done.length} 個 migration` : `${cfg.database}:已是最新`);
} finally {
  await pool.close();
}
