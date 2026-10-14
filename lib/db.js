import pg from 'pg';

// DATE columns come back as 'YYYY-MM-DD' strings, never as JS Dates shifted by the host time zone.
pg.types.setTypeParser(1082, value => value);
// bigint (cents) fits safely in a JS number for any realistic amount; refuse anything that does not.
pg.types.setTypeParser(20, value => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint out of safe range: ${value}`);
  return n;
});

export function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createPool(env = process.env) {
  const connectionString = requireEnv(env, 'DATABASE_URL');
  const user = decodeURIComponent(new URL(connectionString).username);
  if (user === 'postgres' && env.ALLOW_SUPERUSER !== '1') {
    throw new Error('postgres runtime connection refused; ALLOW_SUPERUSER=1 required');
  }
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 30000, max: Number(process.env.DB_POOL_MAX) || 10 });
  pool.on('error', () => {}); // Callers log sanitized errors; never print a DSN.
  return pool;
}

// Runs fn(client) inside one transaction; rolls back on any throw.
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
