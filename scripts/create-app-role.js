import pg from 'pg';
import crypto from 'node:crypto';

// One-time hosting setup, run with the database's superuser DATABASE_URL on a NEW, EMPTY database (before any migration):
// creates the non-superuser role the app and its migrations run as (the app refuses a superuser connection), makes it
// the owner of the public schema, and prints the role's connection string — set that as the app's DATABASE_URL and run
// the migrations with it, so every table belongs to the role.
//   DATABASE_URL=<superuser url> node scripts/create-app-role.js [role] [--rotate]
// It refuses a database that already has tables (their owner would stay the superuser) and an existing role unless
// --rotate is given (which changes the role's password: update the app's DATABASE_URL at once).
const args = process.argv.slice(2);
const role = args.find(a => !a.startsWith('--')) || 'fb_app';
const rotate = args.includes('--rotate');
if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('Role names are lowercase letters, digits and _.');
const url = new URL(process.env.DATABASE_URL);
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
  if (exists && !rotate) throw new Error(`Role ${role} already exists. Use --rotate to give it a new password (then update the app's DATABASE_URL).`);
  const tables = (await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner <> $1", [role])).rows[0].n;
  // Tables owned by anyone else (e.g. migrated as the superuser) would stay out of the role's reach: refuse, new role or rotation alike.
  if (tables) throw new Error(`This database has ${tables} table(s) owned by another role. Run this on a new, empty database, before the migrations (or move those tables to ${role} first).`);
  const password = crypto.randomBytes(24).toString('base64url');
  await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  const db = url.pathname.slice(1);
  await client.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO ${role}`);
  await client.query(`ALTER SCHEMA public OWNER TO ${role}`);
  const out = new URL(url);
  out.username = role;
  out.password = password;
  console.log(out.toString());
} finally {
  await client.end();
}
