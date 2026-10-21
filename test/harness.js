import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createPool } from '../lib/db.js';
import { runMigrations } from '../lib/migrate.js';

export const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';

// A throwaway, fully migrated database. Call drop() in an after() hook.
export async function freshDb({ migrate = true } = {}) {
  const name = `fb_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = createPool({ DATABASE_URL: url.toString(), ALLOW_SUPERUSER: '1' });
  if (migrate) await runMigrations(pool);
  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      try { await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await c.end(); }
    },
  };
}
