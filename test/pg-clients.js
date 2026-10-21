// Rebuild tests use the same client overrides and platform defaults as the CLIs.
const client = name => process.env[name.toUpperCase()] || (process.platform === 'win32'
  ? `C:/tools/pgsql18/bin/${name}.exe` : name);
export const PG_DUMP = client('pg_dump');
export const PG_RESTORE = client('pg_restore');
export const PSQL = client('psql');
