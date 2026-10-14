import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freshDb } from './harness.js';
import { startBooks } from '../lib/data/companies.js';
import { DEMO_NOTE } from '../lib/domain/demo.js';

// The public demo from the command line, as a host runs it: the app, migrations and jobs refuse to start in demo mode on a
// database demo-reset didn't make (and normal books refuse a demo database); demo-reset refuses real books and exits
// non-zero; and `npm run demo-start` (reset if new, migrate, app) brings a new, empty database up as the demo.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Only what the tools need: nothing from the developer's own environment (APP_ORG, SETTINGS_KEY, …) leaks in.
const envFor = (url, more = {}) => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: url, ALLOW_SUPERUSER: '1', ...more });

function run(script, env, { args = [], until = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${script} timed out:\n${out}`)); }, timeoutMs);
    const seen = chunk => {
      out += chunk;
      if (until && until.test(out)) { clearTimeout(timer); resolve({ code: null, out, child }); }
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test('in demo mode the app, migrations and jobs refuse a database demo-reset didn’t make; demo-reset refuses real books', async () => {
  const real = await freshDb();
  try {
    await startBooks(real.pool, { slug: 'mybooks', companyName: 'My Company LLC', timeZone: 'America/Chicago' });
    const env = envFor(real.url, { DEMO_MODE: '1' });
    for (const script of ['services/app/index.js', 'services/migrate/index.js', 'services/jobs/index.js']) {
      const r = await run(script, { ...env, PORT: '39871' });
      assert.equal(r.code, 1, `${script}: ${r.out}`);
      assert.match(r.out, /DEMO_MODE=1 refused: this database is not a demo database[^]*no demo mark[^]*books other than the sample/, script);
    }
    const reset = await run('scripts/demo-reset.js', env);
    assert.equal(reset.code, 1);
    assert.match(reset.out, /demo-reset failed: demo-reset refused: this database has data but no demo mark — it may be real books\. Nothing was changed/);
    assert.equal((await run('scripts/demo-reset.js', env, { args: ['--if-new'] })).code, 1);
    const noFlag = await run('scripts/demo-reset.js', envFor(real.url));
    assert.equal(noFlag.code, 1);
    assert.match(noFlag.out, /only runs with DEMO_MODE=1/);
    const typo = await run('services/app/index.js', envFor(real.url, { DEMO_MODE: 'true' }));
    assert.equal(typo.code, 1);
    assert.match(typo.out, /DEMO_MODE must be "1"/);
    const realServer = await run('services/app/index.js', envFor(real.url, { DEMO_MODE: '1', SETTINGS_KEY: 'a'.repeat(64) }));
    assert.equal(realServer.code, 1);
    assert.match(realServer.out, /SETTINGS_KEY is set/);
    assert.equal((await real.pool.query('SELECT count(*)::int AS n FROM org')).rows[0].n, 1, 'nothing changed');
  } finally { await real.drop(); }
});

test('demo-start on a new database: builds the demo, migrates, serves it without sign-in; normal books then refuse it', async () => {
  const db = await freshDb({ migrate: false });
  let app;
  try {
    const env = envFor(db.url, { DEMO_MODE: '1', PORT: '39872' });
    const reset = await run('scripts/demo-reset.js', env, { args: ['--if-new'] });
    assert.equal(reset.code, 0, reset.out);
    assert.match(reset.out, /built the sample books as of \d{4}-\d{2}-\d{2}/);
    const again = await run('scripts/demo-reset.js', env, { args: ['--if-new'] });
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /already a demo database; left as it is/);
    const migrate = await run('services/migrate/index.js', env);
    assert.equal(migrate.code, 0, migrate.out);
    const jobs = await run('services/jobs/index.js', env);
    assert.equal(jobs.code, 0, jobs.out);
    assert.match(jobs.out, /public demo — daily jobs are off/);
    app = await run('services/app/index.js', env, { until: /listening on/ });
    assert.match(app.out, /public demo: no sign-in/);
    const res = await fetch('http://127.0.0.1:39872/customers', { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(DEMO_NOTE));
    // The nightly reset (the cron job) on the running demo.
    const nightly = await run('scripts/demo-reset.js', env);
    assert.equal(nightly.code, 0, nightly.out);
    assert.match(nightly.out, /rebuilt the sample books/);
    assert.equal((await fetch('http://127.0.0.1:39872/customers', { redirect: 'manual' })).status, 200);
    // Normal books never open a demo database.
    for (const script of ['services/migrate/index.js', 'services/jobs/index.js']) {
      const r = await run(script, envFor(db.url));
      assert.equal(r.code, 1, script);
      assert.match(r.out, /public demo that `npm run demo-reset` wipes every night/, script);
    }
  } finally {
    app?.child?.kill();
    await db.drop();
  }
});
