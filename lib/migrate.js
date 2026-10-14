import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './db.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const LOCK_KEY = 74_120_001; // advisory lock id for "financial-books migrate"

// Applies every not-yet-applied migrations/*.sql in filename order, each in its own transaction.
// A session advisory lock, held on one dedicated connection for the whole run, serializes runners.
export async function runMigrations(pool, dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const lock = await pool.connect();
  const applied = [], skipped = [];
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await lock.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const name of files) {
      const sql = await readFile(join(dir, name), 'utf8');
      const did = await withTransaction(pool, async tx => {
        const { rowCount } = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
        if (rowCount) return false;
        await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        return true;
      });
      (did ? applied : skipped).push(name);
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    lock.release();
  }
  return { applied, skipped };
}
