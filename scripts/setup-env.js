// First-time setup: writes a new .env with YOUR OWN secrets, and (optionally) creates your local database.
//
//   node scripts/setup-env.js                      asks a few questions
//   node scripts/setup-env.js --yes [options]      no questions (anything not given gets a default or is generated)
//
// Options:
//   --admin-url <url>     a Postgres superuser address, used once to create the database and its app role
//                         (default postgres://postgres@127.0.0.1:5432/postgres). Not saved anywhere.
//   --db-name <name>      the database to create (default: books)
//   --db-role <name>      the login role the app runs as (default: books_app). It gets a random password.
//   --database-url <url>  skip creating anything and use this database address as-is
//   --org <slug>          short name for your books: lowercase letters, digits and _ (default: mybooks)
//   --name <your name>    shown as the owner in the audit log (default: owner)
//   --password <text>     the sign-in password (or set SETUP_PASSWORD). Without it you're asked, or with --yes one is
//                         generated and shown once.
//   --port <n>            the port the app listens on (default 3000)
//   --out <file>          where to write (default .env). An existing file is never overwritten.
//   --no-qr               don't draw the QR code (the otpauth:// link is still printed)
//
// What it writes: SETTINGS_KEY (encrypts passwords and keys you save in Settings), APP_LOGIN_PASSWORD_HASH (bcrypt of
// your password — the password itself is not stored), APP_TOTP_SECRET (for your authenticator app), DATABASE_URL,
// APP_ORG, APP_OPERATOR_NAME, PORT and NODE_ENV=development. BOOKS_MODE is left unset (normal books).
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import * as OTPAuth from 'otpauth';
import qrcode from 'qrcode-generator';
import { makeTotp } from '../lib/auth.js';

const args = process.argv.slice(2);
const flag = k => args.includes(`--${k}`);
const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const yes = flag('yes');
const out = opt('out') ?? '.env';
const fail = message => { console.error(`setup-env: ${message}`); process.exit(1); };

if (existsSync(out)) fail(`${out} already exists — not overwriting it. Move it aside first if you really want new secrets.`);

function ask(question, { hidden = false, fallback = '' } = {}) {
  if (yes || !process.stdin.isTTY) return Promise.resolve(fallback);
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(s); else if (!/[\r\n]/.test(s)) process.stdout.write('*'); };
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim() || fallback); });
  });
}

const ident = /^[a-z_][a-z0-9_]*$/;
const org = opt('org') ?? await ask('Short name for your books (lowercase, e.g. mybooks): ', { fallback: 'mybooks' });
if (!/^[a-z0-9_]+$/.test(org)) fail('--org must be lowercase letters, digits and _ only.');
const operator = opt('name') ?? await ask('Your name (shown in the audit log): ', { fallback: 'owner' });
const port = opt('port') ?? '3000';
if (!/^\d{2,5}$/.test(port)) fail('--port must be a number.');

// The sign-in password.
let password = opt('password') ?? process.env.SETUP_PASSWORD ?? '';
let generated = false;
if (!password) {
  password = await ask('Choose a sign-in password (12+ characters; leave empty to generate one): ', { hidden: true });
  if (password) {
    const again = await ask('Type it again: ', { hidden: true });
    if (again !== password) fail('The two passwords didn’t match. Nothing was written.');
  }
}
if (!password) { password = randomBytes(15).toString('base64url'); generated = true; }
if (password.length < 12) fail('Use a password of at least 12 characters.');

// The database.
let databaseUrl = opt('database-url');
if (!databaseUrl) {
  const adminUrl = opt('admin-url') ?? await ask('Postgres superuser address [postgres://postgres@127.0.0.1:5432/postgres]: ',
    { fallback: 'postgres://postgres@127.0.0.1:5432/postgres' });
  const dbName = opt('db-name') ?? 'books';
  const role = opt('db-role') ?? 'books_app';
  if (!ident.test(dbName) || !ident.test(role)) fail('--db-name and --db-role must be lowercase letters, digits and _.');
  databaseUrl = await createDatabase(adminUrl, dbName, role);
}

async function createDatabase(adminUrl, dbName, role) {
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  try { await admin.connect(); } catch (error) { fail(`couldn’t connect to Postgres with the superuser address (${error.message}). Is Postgres running?`); }
  try {
    if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
      fail(`a role named ${role} already exists on this server. Pick another with --db-role, or pass --database-url.`);
    }
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount) {
      fail(`a database named ${dbName} already exists. Pick another with --db-name, or pass --database-url.`);
    }
    const rolePassword = randomBytes(24).toString('base64url');
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${rolePassword}'`);
    await admin.query(`CREATE DATABASE ${dbName} OWNER ${role}`);
    const inDb = new URL(adminUrl);
    inDb.pathname = `/${dbName}`;
    const c = new pg.Client({ connectionString: inDb.toString() });
    await c.connect();
    try { await c.query(`ALTER SCHEMA public OWNER TO ${role}`); } finally { await c.end(); }
    const url = new URL(adminUrl);
    url.username = role;
    url.password = rolePassword;
    url.pathname = `/${dbName}`;
    url.search = '';
    console.log(`Created database ${dbName} and its login role ${role}.`);
    return url.toString();
  } finally {
    await admin.end().catch(() => {});
  }
}

// The secrets.
const settingsKey = randomBytes(32).toString('hex'); // 64 hex characters = the 32 bytes lib/secrets.js expects
const hash = bcrypt.hashSync(password, 12);
const totpSecret = new OTPAuth.Secret({ size: 20 }).base32;
const totp = makeTotp(totpSecret, operator);

const env = `# Financial Books settings — made by scripts/setup-env.js on ${new Date().toISOString().slice(0, 10)}.
# KEEP THIS FILE PRIVATE. Never commit it, email it or paste it anywhere. Back it up somewhere safe (a password manager):
# without SETTINGS_KEY, passwords and keys saved in Settings can't be read again.

NODE_ENV=development
PORT=${port}

# Your database (the app's own login role, not the superuser).
DATABASE_URL=${databaseUrl}

# Which books this app opens (the org's short name).
APP_ORG=${org}
APP_OPERATOR_NAME=${operator.replace(/[\r\n]/g, ' ')}

# Encrypts secrets saved in Settings (email password, AI keys, text-receipt token, invited people's authenticators).
SETTINGS_KEY=${settingsKey}

# Owner sign-in: your password (stored only as a bcrypt hash) plus a 6-digit code from your authenticator app.
APP_LOGIN_PASSWORD_HASH=${hash}
APP_TOTP_SECRET=${totpSecret}

# BOOKS_MODE is left unset: normal books. See .env.example for everything else you can set.
`;
writeFileSync(out, env, { mode: 0o600, flag: 'wx' });

console.log(`\nWrote ${out}.`);
if (generated) console.log(`\nYour sign-in password (shown only this once — save it in your password manager now):\n\n    ${password}\n`);
console.log('\nAdd the books to your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …):');
if (!flag('no-qr')) {
  const qr = qrcode(0, 'L');
  qr.addData(totp.toString());
  qr.make();
  console.log(qr.createASCII(1, 2));
}
console.log(`${flag('no-qr') ? 'Add' : 'Scan the code above, or add'} this link / key by hand:\n    ${totp.toString()}\n    key: ${totpSecret}`);
console.log('\nNext: npm run migrate, then npm run new-books -- --company "Your Company Name", then npm run dev.');
