import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshDb } from './harness.js';
import { runMigrations, MIGRATIONS_DIR } from '../lib/migrate.js';
import { execFileSync } from 'node:child_process';
import { symlink } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { withTransaction } from '../lib/db.js';
import { repost } from '../lib/data/ledger.js';

// Bank review v2: upgrading books that already have reviewed bank items. The books are made by the code as it
// was before 055 (the last commit without it: git archive), then today's migrations run; each linked transaction's version
// is recorded as it is, and nothing unchanged may look changed afterwards (Codex round 4, finding 4).
const REPO = fileURLToPath(new URL('..', import.meta.url));
let db, dir, old;
before(async () => {
  db = await freshDb({ migrate: false });
  dir = await mkdtemp(join(tmpdir(), 'fb-mig-'));
  for (const f of (await readdir(MIGRATIONS_DIR)).filter(n => /^\d{3}_/.test(n) && n < '055')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
  await runMigrations(db.pool, dir);
  // The code before bank review v2.
  old = await mkdtemp(join(tmpdir(), 'fb-old-'));
  // The commit before the one that added 055 (or, before 055 is committed, the latest).
  const added = execFileSync('git', ['log', '--format=%H', '-1', '--diff-filter=A', '--', 'migrations/055_bank_review_v2.sql'], { cwd: REPO, encoding: 'utf8' }).trim();
  const rev = added ? `${added}~1` : 'HEAD';
  execFileSync('sh', ['-c', `git -c core.autocrlf=false archive ${rev} lib | tar -x -C "${old.replace(/\\/g, '/')}"`], { cwd: REPO });
  await symlink(join(REPO, 'node_modules'), join(old, 'node_modules'), 'junction');
});
after(async () => { await db.drop(); await rm(dir, { recursive: true, force: true }); await rm(old, { recursive: true, force: true }); });

test('existing linked deposits keep a matching version after migration 055; an unchanged repost flags nothing', async () => {
  const { generateSample } = await import(pathToFileURL(join(old, 'lib/seed/generate.js')).href);
  const { writeSample } = await import(pathToFileURL(join(old, 'lib/data/seed.js')).href);
  const { createPool } = await import(pathToFileURL(join(old, 'lib/db.js')).href);
  const oldPool = createPool({ DATABASE_URL: db.url, ALLOW_SUPERUSER: '1' });
  const ids = await writeSample(oldPool, generateSample({ asOf: '2026-10-12' }));
  await oldPool.end();
  const orgId = ids.orgId, entityId = ids.entityId;
  const { rows: [dep] } = await db.pool.query(`SELECT txn_id, txn_date, total_cents, account_id FROM txn WHERE entity_id = $1 AND type = 'deposit' ORDER BY txn_id LIMIT 1`, [entityId]);
  // A bank line already reviewed as that deposit (as books from before 055 would have).
  const llEntity = '00000000-0000-4000-8000-0000000000e1', llAccount = '00000000-0000-4000-8000-0000000000a1', llTxn = '00000000-0000-4000-8000-0000000000b1';
  await db.pool.query(`INSERT INTO ledgerline_link (org_id, entity_id, ll_entity_id, ll_entity_name, linked_by) VALUES ($1, $2, $3, 'Sample', 'test')`, [orgId, entityId, llEntity]);
  await db.pool.query(`INSERT INTO ledgerline_account (org_id, entity_id, ll_account_id, display_name, kind, books_account_id) VALUES ($1, $2, $3, 'Checking', 'checking', $4)`,
    [orgId, entityId, llAccount, dep.account_id]);
  const { rows: [item] } = await db.pool.query(`INSERT INTO bank_feed_item (org_id, entity_id, ll_transaction_id, ll_account_id, revision, pending, posted_date, amount_cents, description, review_state)
    VALUES ($1, $2, $3, $4, 1, false, $5, $6, 'DEPOSIT', 'matched') RETURNING item_id`, [orgId, entityId, llTxn, llAccount, dep.txn_date, dep.total_cents]);
  await db.pool.query(`INSERT INTO bank_feed_link (org_id, item_id, txn_id, how, linked_by) VALUES ($1, $2, $3, 'matched', 'test')`, [orgId, item.item_id, dep.txn_id]);

  await runMigrations(db.pool); // 055 and anything after
  const { rows: [k] } = await db.pool.query('SELECT txn_version, last_seen_version, txn_version(txn_id) AS now FROM bank_feed_link WHERE item_id = $1', [item.item_id]);
  assert.equal(k.txn_version, k.now);
  assert.equal(k.last_seen_version, k.now);
  await withTransaction(db.pool, tx => repost(tx, orgId, dep.txn_id));
  const { rows: [after1] } = await db.pool.query('SELECT attention, review_version FROM bank_feed_item WHERE item_id = $1', [item.item_id]);
  assert.deepEqual([after1.attention, Number(after1.review_version)], [null, 0]);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM bank_review_event WHERE item_id = $1', [item.item_id])).rows[0].n, 0);
});
