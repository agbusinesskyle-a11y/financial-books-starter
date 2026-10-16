// test/tax-periods.test.js — Codex t1-r1 B8: an initial (first-year) period is a requested claim until it is verified with
// evidence; obvious chronology conflicts are refused; only a verified initial period has zero beginnings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { createCompany } from '../lib/data/companies.js';
import { ValidationError } from '../lib/data/writes.js';
import { saveProfile, openPeriod, getPeriod, verifyInitial, setPredecessor } from '../lib/tax/periods.js';
import { importBaseline } from '../lib/tax/baselines.js';

let db, pool, orgId;
const company = async (name, dateStarted = null) => {
  const scope = { orgId, entityId: await createCompany(pool, { orgId, name, timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...scope, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted }, reason: 'setup', actor: 'tester' });
  return scope;
};
before(async () => {
  db = await freshDb(); pool = db.pool;
  orgId = (await writeSample(pool, generateSample({ asOf: '2026-10-12' }))).orgId;
});
after(async () => { await db.drop(); });

test('an established company cannot open a later period as initial: its earlier periods and its start date say otherwise', async () => {
  // The review's case: started 2010, 2025 and 2026 on file, then a 2027 "initial" period.
  const old = await company('Old Ranch', '2010-01-01');
  await openPeriod(pool, { ...old, year: 2025, actor: 'tester' });
  await openPeriod(pool, { ...old, year: 2026, actor: 'tester' });
  await assert.rejects(openPeriod(pool, { ...old, year: 2027, initial: true, actor: 'tester' }), e => e instanceof ValidationError && /earlier period/.test(e.message));
  // The same company with no periods on file yet: its start date alone is the conflict (a reconstructed first Tax Books year
  // is not a first year; its openings stay unknown).
  const reconstructed = await company('Reconstructed Ranch', '2010-01-01');
  await assert.rejects(openPeriod(pool, { ...reconstructed, year: 2025, initial: true, actor: 'tester' }), e => e instanceof ValidationError && /started on 2010-01-01/.test(e.message));
  // A start date after the period is a conflict too.
  const future = await company('Future Ranch', '2026-03-01');
  await assert.rejects(openPeriod(pool, { ...future, year: 2025, initial: true, actor: 'tester' }), e => e instanceof ValidationError && /started on 2026-03-01/.test(e.message));
  // The database refuses the same when the module is bypassed.
  const insert = (scope, year) => pool.query(`INSERT INTO tax_return (org_id, entity_id, period_start, period_end, return_type, form_edition, tax_method, book_basis, initial_status)
    VALUES ($1, $2, $3, $4, 'form_1065', $5, 'cash', 'accrual', 'requested')`, [scope.orgId, scope.entityId, `${year}-01-01`, `${year}-12-31`, year]);
  await assert.rejects(insert(old, 2027), /earlier period/);
  await assert.rejects(insert(reconstructed, 2025), /started on 2010-01-01/);
});

test('a new company’s initial period is requested — openings unknown, not zero — until an admin verifies it with evidence', async () => {
  const fresh = await company('Fresh Ranch', '2025-06-01');
  const r = await openPeriod(pool, { ...fresh, year: 2025, initial: true, periodStart: '2025-06-01', actor: 'tester' });
  let p = await getPeriod(pool, { ...fresh, returnId: r });
  assert.deepEqual([p.initial, p.initial_status, p.opening_state], [true, 'requested', 'unknown'], 'a requested first year has unknown openings');
  await assert.rejects(verifyInitial(pool, { ...fresh, returnId: r, verifiedBy: 'admin', evidence: '' }), e => e instanceof ValidationError && /evidence/.test(e.message));
  await assert.rejects(verifyInitial(pool, { ...fresh, returnId: r, verifiedBy: '', evidence: 'Articles filed 2025-06-01' }), e => e instanceof ValidationError && /who verified/.test(e.message));
  await verifyInitial(pool, { ...fresh, returnId: r, verifiedBy: 'admin', evidence: 'Articles of organization filed 2025-06-01; EIN letter' });
  p = await getPeriod(pool, { ...fresh, returnId: r });
  assert.deepEqual([p.initial_status, p.opening_state, p.initial_verified_by, p.initial_evidence], ['verified', 'zero', 'admin', 'Articles of organization filed 2025-06-01; EIN letter']);
  // A verified first year has no predecessor, and nothing may be opened before it.
  await assert.rejects(openPeriod(pool, { ...fresh, year: 2024, actor: 'tester' }), e => e instanceof ValidationError && /initial period/.test(e.message));
  await assert.rejects(pool.query(`INSERT INTO tax_return (org_id, entity_id, period_start, period_end, return_type, form_edition, tax_method, book_basis) VALUES ($1, $2, '2024-01-01', '2024-12-31', 'form_1065', 2024, 'cash', 'accrual')`,
    [fresh.orgId, fresh.entityId]), /initial period/);
  // Verification is a reason and a reviewer together (CHECK), and is never written as the bare flag.
  await assert.rejects(pool.query(`UPDATE tax_return SET initial_evidence = NULL WHERE return_id = $1`, [r]), /check constraint/);
  await assert.rejects(pool.query(`UPDATE tax_return SET initial = false WHERE return_id = $1`, [r]), /initial/);
  // A verified non-initial period cannot exist: verification belongs to an initial claim.
  const plain = await company('Plain Ranch', '2024-03-01');
  const r2 = await openPeriod(pool, { ...plain, year: 2025, actor: 'tester' });
  await assert.rejects(verifyInitial(pool, { ...plain, returnId: r2, verifiedBy: 'admin', evidence: 'x' }), e => e instanceof ValidationError && /not an initial period/.test(e.message));
});

test('openings: zero only for a verified initial period; a period without predecessor evidence is unknown; an initial period has no predecessor', async () => {
  const co = await company('Openings Ranch', '2020-01-01');
  const r = await openPeriod(pool, { ...co, year: 2026, actor: 'tester' });
  assert.equal((await getPeriod(pool, { ...co, returnId: r })).opening_state, 'unknown', 'no predecessor yet: unknown, never zero');
  const { baselineId } = await importBaseline(pool, { ...co, actor: 'tester', payload: { importKey: 'filed-2025', payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1065', formEdition: 2025,
    bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges', sourcePeriodStart: '2025-01-01', sourcePeriodEnd: '2025-12-31',
    facts: [{ factKind: 'schedule_l_end', fieldId: 'f1065.L.1', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '100', state: 'known', reviewStatus: 'verified' }] } });
  await setPredecessor(pool, { ...co, returnId: r, baselineId });
  assert.equal((await getPeriod(pool, { ...co, returnId: r })).opening_state, 'baseline');
  // A first year with a predecessor is a contradiction: refused by the module and by the CHECK.
  const born = await company('Born Ranch', '2025-02-01');
  const first = await openPeriod(pool, { ...born, year: 2025, initial: true, periodStart: '2025-02-01', actor: 'tester' });
  const { baselineId: stray } = await importBaseline(pool, { ...born, actor: 'tester', payload: { importKey: 'stray-2024', payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1065', formEdition: 2024,
    bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges', sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2025-01-31',
    facts: [{ factKind: 'schedule_l_end', measurement: 'end', effectiveOn: '2025-01-31', amountCents: '1', state: 'known' }] } });
  await assert.rejects(setPredecessor(pool, { ...born, returnId: first, baselineId: stray }), e => e instanceof ValidationError && /initial period has no predecessor/.test(e.message));
  await assert.rejects(pool.query('UPDATE tax_return SET predecessor_baseline_id = $2 WHERE return_id = $1', [first, stray]), /check constraint/);
});

// Codex t1-r2 B8: no grace interval. A company that started even months before the period is reconstructing its first Tax Books
// year; an initial period starts on the start date, and verifying one needs that date on file.
test('an initial period starts the day the company started; verification needs the start date; the date cannot move under it', async () => {
  const halfYear = await company('Half Year Ranch', '2024-07-01');
  await assert.rejects(openPeriod(pool, { ...halfYear, year: 2025, initial: true, actor: 'tester' }), e => e instanceof ValidationError && /started on 2024-07-01/.test(e.message));
  await assert.rejects(pool.query(`INSERT INTO tax_return (org_id, entity_id, period_start, period_end, return_type, form_edition, tax_method, book_basis, initial_status)
    VALUES ($1, $2, '2025-01-01', '2025-12-31', 'form_1065', 2025, 'cash', 'accrual', 'requested')`, [halfYear.orgId, halfYear.entityId]), /started on 2024-07-01/);
  // No start date yet: the request is allowed (openings unknown), the verification is not.
  const undated = await company('Undated Ranch');
  const r = await openPeriod(pool, { ...undated, year: 2025, initial: true, actor: 'tester' });
  await assert.rejects(verifyInitial(pool, { ...undated, returnId: r, verifiedBy: 'admin', evidence: 'Articles filed' }), e => e instanceof ValidationError && /start date|started/.test(e.message));
  await assert.rejects(pool.query(`UPDATE tax_return SET initial_status = 'verified', initial_verified_by = 'x', initial_evidence = 'y', initial_verified_at = now() WHERE return_id = $1`, [r]), /start date/);
  // Once the start date is recorded as the period's first day the verification goes through, and the date cannot then move.
  const fields = { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 };
  await assert.rejects(saveProfile(pool, { ...undated, fields: { ...fields, dateStarted: '2024-07-01' }, actor: 'tester' }), e => e instanceof ValidationError && /must be that day/.test(e.message));
  await saveProfile(pool, { ...undated, fields: { ...fields, dateStarted: '2025-01-01' }, actor: 'tester' });
  await verifyInitial(pool, { ...undated, returnId: r, verifiedBy: 'admin', evidence: 'Articles filed 2025-01-01' });
  assert.equal((await getPeriod(pool, { ...undated, returnId: r })).opening_state, 'zero');
  await assert.rejects(saveProfile(pool, { ...undated, fields: { ...fields, dateStarted: '' }, actor: 'tester' }), e => e instanceof ValidationError && /cannot be cleared/.test(e.message));
});
