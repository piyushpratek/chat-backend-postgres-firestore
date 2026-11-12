import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pool } from './postgres';

export async function migrate(): Promise<void> {
  const sql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Run directly: `npm run migrate`
if (require.main === module) {
  migrate()
    .then(() => {
      console.log('Database schema is up to date.');
      return pool.end();
    })
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
