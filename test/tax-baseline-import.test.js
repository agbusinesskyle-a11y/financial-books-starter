// test/tax-baseline-import.test.js — the CLI imports a payload once, says so the second time, and refuses a company outside the org.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { saveProfile } from '../lib/tax/periods.js';

let db, dir, file, slug, entityId;
const run = args => promisify(execFile)(process.execPath, ['scripts/tax-baseline-import.mjs', ...args], { env: { ...process.env, DATABASE_URL: db.url, ALLOW_SUPERUSER: '1' } });
before(async () => {
  db = await freshDb();
  const ids = await writeSample(db.pool, generateSample({ asOf: '2026-10-12' }));
  entityId = ids.entityId;
  slug = (await db.pool.query('SELECT slug FROM org WHERE org_id = $1', [ids.orgId])).rows[0].slug;
  await saveProfile(db.pool, { orgId: ids.orgId, entityId, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  dir = await mkdtemp(join(tmpdir(), 'fb-baseline-'));
  file = join(dir, 'payload.json');
  await writeFile(file, JSON.stringify({
    importKey: 'filed-2025-sample', payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1065', formEdition: 2025, bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges',
    sourcePeriodStart: '2025-01-01', sourcePeriodEnd: '2025-12-31', sourceDocument: { hash: 'sha256:abc', pages: '1-4' }, extractionStatus: 'verified',
    facts: [{ factKind: 'schedule_l_end', fieldId: 'f1065.L.1', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '125000', state: 'known', provenance: {}, reviewStatus: 'verified' }],
  }));
});
after(async () => { await db.drop(); await rm(dir, { recursive: true, force: true }); });

test('the baseline CLI imports once, reports the same baseline on a repeat, and refuses a company outside the org', async () => {
  const first = await run([slug, String(entityId), file]);
  assert.match(first.stdout, /^imported baseline \d+ for .+ \(1 facts\)/);
  const again = await run([slug, String(entityId), file]);
  assert.match(again.stdout, /^already imported as baseline \d+/);
  assert.equal(/\d+/.exec(first.stdout)[0], /\d+/.exec(again.stdout)[0]);
  await assert.rejects(run([slug, '999999', file]), e => /no company 999999/.test(e.stderr) && e.code === 1);
  await assert.rejects(run([slug, 'x', file]), e => e.code === 2);
});
