// test/tax-contracts.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { createCompany } from '../lib/data/companies.js';
import { ValidationError } from '../lib/data/writes.js';
import { saveParty, getParty, listParties, saveGrantorReporting, grantorOwnersOn, saveHouseholdMembers } from '../lib/tax/parties.js';
import { getProfile, saveProfile, openPeriod, listPeriods, getPeriod, yearEndFromFiscalStart } from '../lib/tax/periods.js';
import { catalogFor } from '../lib/tax/catalog/index.js';
import { saveActivity, listActivities, includeBooks, listInclusions, saveTreatment } from '../lib/tax/activities.js';

let db, pool;
// The sample company (an org and an entity) for the module tests below; the direct-SQL contract tests make their own orgs.
let ids, S, B;
const KEY = 'a'.repeat(64); // 32 bytes hex for tests
before(async () => {
  db = await freshDb(); pool = db.pool;
  ids = await writeSample(pool, generateSample({ asOf: '2026-10-12' }));
  S = { orgId: ids.orgId, entityId: ids.entityId };
  B = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Second Ranch', timeZone: 'America/Chicago' }) };
});
after(async () => { await db.drop(); });

const tables = async () => (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name LIKE 'tax\\_%' OR table_name IN ('grantor_reporting','baseline_fact','opening_bridge','activity_inclusion','activity_treatment')) ORDER BY 1`)).rows.map(r => r.table_name);

test('migration 064 creates the T1 tables with audit triggers and scope keys', async () => {
  const got = await tables();
  for (const t of ['tax_party', 'grantor_reporting', 'tax_household_member', 'tax_profile', 'tax_return', 'tax_baseline', 'baseline_fact', 'opening_bridge',
    'tax_activity', 'activity_inclusion', 'activity_treatment', 'tax_provider_assignment']) assert.ok(got.includes(t), `table ${t}`);
  const { rows: trig } = await pool.query(`SELECT event_object_table AS t FROM information_schema.triggers WHERE trigger_name = 'audit' GROUP BY 1`);
  const audited = new Set(trig.map(r => r.t));
  for (const t of ['tax_party', 'grantor_reporting', 'tax_household_member', 'tax_profile', 'tax_return', 'tax_baseline', 'baseline_fact', 'opening_bridge', 'tax_activity', 'activity_inclusion', 'activity_treatment', 'tax_provider_assignment']) assert.ok(audited.has(t), `audit on ${t}`);
  // Every T1 table is org-scoped.
  const { rows: cols } = await pool.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'org_id' AND table_name = ANY($1)`, [got]);
  assert.equal(cols.length, got.length, 'org_id on every tax table');
});

// Direct-SQL contract tests (spec §11): the constraints and triggers of migration 064 must hold when the lib/tax modules are
// bypassed, so every rule is exercised here against the database itself. Each test gets its own organization of sample
// companies, each with one account; rows are inserted with plain SQL, never through a module.
let orgSeq = 0;
async function insert(table, row, returning) {
  const cols = Object.keys(row);
  const { rows: [r] } = await pool.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${returning}`, Object.values(row));
  return r[returning];
}
async function org(companies) {
  const n = ++orgSeq;
  const out = { orgId: await insert('org', { slug: `tax_contracts_${n}`, name: `Sample Organization ${n}` }, 'org_id') };
  for (const name of companies) {
    const entityId = await insert('entity', { org_id: out.orgId, name: `${name} Sample Co` }, 'entity_id');
    const accountId = await insert('account', { org_id: out.orgId, entity_id: entityId, name: 'Checking', number: '1000', type: 'bank' }, 'account_id');
    out[name] = { entityId, accountId };
  }
  return out;
}
// A calendar-year return period; `more` adds or overrides columns (predecessor_baseline_id, the basis exception, ...).
const period = (orgId, entityId, { year = 2025, returnType = 'form_1065', bookBasis = 'accrual', ...more } = {}) =>
  insert('tax_return', { org_id: orgId, entity_id: entityId, period_start: `${year}-01-01`, period_end: `${year}-12-31`, return_type: returnType, form_edition: year, tax_method: 'cash', book_basis: bookBasis, ...more }, 'return_id');
const baseline = (orgId, entityId, { year = 2024, returnType = 'form_1065', bookBasis = 'accrual', kind = 'imported_filed', importKey = `filed-${year}`, ...more } = {}) =>
  insert('tax_baseline', { org_id: orgId, entity_id: entityId, source_period_start: `${year}-01-01`, source_period_end: `${year}-12-31`, return_type: returnType, form_edition: year, book_basis: bookBasis, consolidation_policy: 'inclusion_edges', kind, import_key: importKey, ...more }, 'baseline_id');
const fact = (orgId, baselineId, over = {}) =>
  insert('baseline_fact', { org_id: orgId, baseline_id: baselineId, payload_version: 1, fact_kind: 'schedule_l_end', field_id: 'f1065.L.1', measurement: 'end', effective_on: '2024-12-31', amount_cents: 100, state: 'known', review_status: 'verified', ...over }, 'fact_id');
const profile = (orgId, entityId, returnType) =>
  insert('tax_profile', { org_id: orgId, entity_id: entityId, return_type: returnType, activity_kind: returnType === 'disregarded' ? 'trade' : null }, 'entity_id');
const activity = (orgId, entityId, name = 'Own activity') =>
  insert('tax_activity', { org_id: orgId, return_entity_id: entityId, kind: 'holding', name, schedule: 'p1', effective_from: '2025-01-01' }, 'activity_id');
const include = (orgId, returnId, activityId, sourceEntityId, { year = 2025, periodStart = `${year}-01-01`, periodEnd = `${year}-12-31` } = {}) =>
  insert('activity_inclusion', { org_id: orgId, return_id: returnId, activity_id: activityId, source_entity_id: sourceEntityId, period_start: periodStart, period_end: periodEnd, source_book_basis: 'accrual', approved_by: 'reviewer' }, 'inclusion_id');
const bridge = (orgId, returnId, factId, accountId) =>
  insert('opening_bridge', { org_id: orgId, return_id: returnId, fact_id: factId, account_id: accountId, allocated_cents: 100, approved_by: 'reviewer' }, 'bridge_id');

test('activity_inclusion: the database refuses own books, another company’s activity, a period mismatch and a second owner', async () => {
  const o = await org(['Parent', 'Child', 'Other']);
  const r = await period(o.orgId, o.Parent.entityId);
  const own = await activity(o.orgId, o.Parent.entityId);
  const otherActivity = await activity(o.orgId, o.Other.entityId);
  await period(o.orgId, o.Child.entityId, { returnType: 'disregarded' });
  await assert.rejects(include(o.orgId, r, own, o.Parent.entityId), /its own books/);
  await assert.rejects(include(o.orgId, r, otherActivity, o.Child.entityId), /another company/);
  await assert.rejects(include(o.orgId, r, own, o.Child.entityId, { year: 2024 }), /period must match/);
  await include(o.orgId, r, own, o.Child.entityId);
  // One income-tax owner per source company per period: the same child on another activity of the same return is a duplicate too.
  await assert.rejects(include(o.orgId, r, await activity(o.orgId, o.Parent.entityId, 'Second activity'), o.Child.entityId), /activity_inclusion_one_owner/);
});

test('activity_inclusion: only a company with a disregarded return for THAT period can be included; a profile is not evidence; nothing fails open', async () => {
  const o = await org(['Parent', 'Silent', 'Defaulted', 'Payer', 'Flipped', 'Newborn']);
  const r = await period(o.orgId, o.Parent.entityId);
  const act = await activity(o.orgId, o.Parent.entityId);
  // No period on file for the source: nothing says it is disregarded for 2025, so it is refused (spec §0 rule 2).
  await assert.rejects(include(o.orgId, r, act, o.Silent.entityId), /only a disregarded company.*no disregarded return period/);
  // A disregarded profile is defaults for the NEXT period (§4.2), not evidence about 2025 (§0 rule 3): refused all the same.
  await profile(o.orgId, o.Defaulted.entityId, 'disregarded');
  await assert.rejects(include(o.orgId, r, act, o.Defaulted.entityId), /only a disregarded company.*no disregarded return period/);
  // The profile says disregarded, but the source files its own 1120-S for 2025: a K-1 payer for that period, never included (§4.4).
  await profile(o.orgId, o.Payer.entityId, 'disregarded');
  await period(o.orgId, o.Payer.entityId, { returnType: 'form_1120s' });
  await assert.rejects(include(o.orgId, r, act, o.Payer.entityId), /files its own return/);
  // The profile says form_1065 for the next period, but the 2025 period itself is disregarded: periods win over profiles.
  await profile(o.orgId, o.Flipped.entityId, 'form_1065');
  await period(o.orgId, o.Flipped.entityId, { returnType: 'disregarded' });
  await include(o.orgId, r, act, o.Flipped.entityId);
  // A company formed mid-year has an initial disregarded period from its first day; that period covers the parent's
  // calendar-year inclusion (overlap, not equal dates).
  await period(o.orgId, o.Newborn.entityId, { returnType: 'disregarded', period_start: '2025-06-01', initial_status: 'requested' });
  await include(o.orgId, r, await activity(o.orgId, o.Parent.entityId, 'Newborn activity'), o.Newborn.entityId);
});

test('activity_inclusion: one owner per source per period is judged on overlap, not equal dates (an initial mid-year parent)', async () => {
  const o = await org(['Alpha', 'Beta', 'Child', 'Child2']);
  for (const k of ['Child', 'Child2']) await period(o.orgId, o[k].entityId, { returnType: 'disregarded' });
  const alpha = await period(o.orgId, o.Alpha.entityId);
  const beta = await period(o.orgId, o.Beta.entityId, { period_start: '2025-06-01', initial_status: 'requested' });
  await include(o.orgId, alpha, await activity(o.orgId, o.Alpha.entityId), o.Child.entityId);
  // Beta's inclusion period must match Beta's return (2025-06-01..12-31); it overlaps Alpha's and would put Child's books in two returns.
  await assert.rejects(include(o.orgId, beta, await activity(o.orgId, o.Beta.entityId), o.Child.entityId, { periodStart: '2025-06-01' }), /activity_inclusion_one_owner/);
  // The other order: the mid-year owner first, then the full-year one.
  await include(o.orgId, beta, await activity(o.orgId, o.Beta.entityId, 'Second'), o.Child2.entityId, { periodStart: '2025-06-01' });
  await assert.rejects(include(o.orgId, alpha, await activity(o.orgId, o.Alpha.entityId, 'Second'), o.Child2.entityId), /activity_inclusion_one_owner/);
  // Another year does not overlap: the same child in the same parent's next return is fine.
  await period(o.orgId, o.Child.entityId, { year: 2026, returnType: 'disregarded' });
  await include(o.orgId, await period(o.orgId, o.Alpha.entityId, { year: 2026 }), await activity(o.orgId, o.Alpha.entityId, 'Next year'), o.Child.entityId, { year: 2026 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM activity_inclusion WHERE org_id = $1', [o.orgId])).rows[0].n, 3);
});

test('tax_return: the inclusion rules hold from the return side — an included company cannot file, the evidence and owner periods stay put, disregarded or filing is never both', async () => {
  const o = await org(['Parent', 'Child', 'Other', 'Both']);
  const child = await period(o.orgId, o.Child.entityId, { returnType: 'disregarded' });
  const parent = await period(o.orgId, o.Parent.entityId);
  await include(o.orgId, parent, await activity(o.orgId, o.Parent.entityId), o.Child.entityId);
  // While included, the child cannot get a filing return for an overlapping period — a full year or an initial mid-year one —
  // and its disregarded period cannot be flipped to one (a K-1 payer is never included, checked from both sides).
  await assert.rejects(period(o.orgId, o.Child.entityId, { returnType: 'form_1120s' }), /cannot file its own return/);
  await assert.rejects(period(o.orgId, o.Child.entityId, { returnType: 'form_1120s', period_start: '2025-06-01', initial_status: 'requested' }), /cannot file its own return/);
  await assert.rejects(pool.query(`UPDATE tax_return SET return_type = 'form_1120s' WHERE return_id = $1`, [child]), /cannot file its own return/);
  // The disregarded period that is the evidence keeps its dates and company and is not deleted; other columns may change.
  await assert.rejects(pool.query(`UPDATE tax_return SET period_start = '2025-06-01', initial_status = 'requested' WHERE return_id = $1`, [child]), /remove that inclusion first/);
  await assert.rejects(pool.query('UPDATE tax_return SET entity_id = $2 WHERE return_id = $1', [child, o.Other.entityId]), /remove that inclusion first/);
  await assert.rejects(pool.query('DELETE FROM tax_return WHERE return_id = $1', [child]), /remove that inclusion first/);
  await pool.query(`UPDATE tax_return SET status = 'review' WHERE return_id = $1`, [child]);
  // The period that owns the inclusion keeps its company and dates (the edge was checked against them); other columns may change.
  await assert.rejects(pool.query(`UPDATE tax_return SET period_start = '2025-06-01', initial_status = 'requested' WHERE return_id = $1`, [parent]), /remove the inclusions first/);
  await assert.rejects(pool.query('UPDATE tax_return SET entity_id = $2 WHERE return_id = $1', [parent, o.Other.entityId]), /remove the inclusions first/);
  await pool.query(`UPDATE tax_return SET status = 'review' WHERE return_id = $1`, [parent]);
  // Once the inclusion is removed these are ordinary changes again.
  await pool.query('DELETE FROM activity_inclusion WHERE org_id = $1 AND return_id = $2', [o.orgId, parent]);
  await pool.query('DELETE FROM tax_return WHERE return_id = $1', [child]);
  await period(o.orgId, o.Child.entityId, { returnType: 'form_1120s' });
  // A company is disregarded or files its own return for a period, never both — in either order, and on overlap.
  await period(o.orgId, o.Both.entityId, { returnType: 'disregarded' });
  await assert.rejects(period(o.orgId, o.Both.entityId, { returnType: 'form_1065' }), /never both; an overlapping disregarded period/);
  await assert.rejects(period(o.orgId, o.Both.entityId, { returnType: 'form_1065', period_start: '2025-06-01', initial_status: 'requested' }), /never both; an overlapping disregarded period/);
  await assert.rejects(period(o.orgId, o.Child.entityId, { returnType: 'disregarded' }), /never both; an overlapping filing period/);
  // Periods that do not overlap never conflict here (a change of return type between periods is reviewed elsewhere, spec §2).
  await period(o.orgId, o.Both.entityId, { year: 2026, returnType: 'form_1065' });
});

test('tax_return: exactly one period covers any date for a company — a second return type for the same dates, or an initial mid-year period inside a full year, is refused', async () => {
  const o = await org(['Solo']);
  await period(o.orgId, o.Solo.entityId);
  // Same dates, another filing type: not a duplicate under the natural key, and both filing (the 'never both' trigger says nothing),
  // yet a second 2025 period for the company (spec §2).
  await assert.rejects(period(o.orgId, o.Solo.entityId, { returnType: 'form_1120s' }), /tax_return_one_period/);
  // An initial 2025-06-01..12-31 period of the same type overlaps the full year.
  await assert.rejects(period(o.orgId, o.Solo.entityId, { period_start: '2025-06-01', initial_status: 'requested' }), /tax_return_one_period/);
  // Adjacent years do not overlap (the range is closed on both ends: 2025-12-31 and 2026-01-01 are different days).
  await period(o.orgId, o.Solo.entityId, { year: 2026 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tax_return WHERE org_id = $1', [o.orgId])).rows[0].n, 2);
});

test('activity_inclusion: an edge that would close a cycle is refused, at any depth', async () => {
  const o = await org(['Alder', 'Birch', 'Cedar']);
  // Three disregarded companies, each with its own disregarded 2025 period (tiered single-member companies).
  const r = {};
  for (const k of ['Alder', 'Birch', 'Cedar']) { await profile(o.orgId, o[k].entityId, 'disregarded'); r[k] = await period(o.orgId, o[k].entityId, { returnType: 'disregarded' }); }
  await include(o.orgId, r.Alder, await activity(o.orgId, o.Alder.entityId), o.Birch.entityId); // Alder includes Birch
  await include(o.orgId, r.Birch, await activity(o.orgId, o.Birch.entityId), o.Cedar.entityId); // Birch includes Cedar
  // Cedar including Alder would close Alder → Birch → Cedar → Alder; Birch including Alder would close Alder → Birch → Alder.
  await assert.rejects(include(o.orgId, r.Cedar, await activity(o.orgId, o.Cedar.entityId), o.Alder.entityId), /cycle/);
  await assert.rejects(include(o.orgId, r.Birch, await activity(o.orgId, o.Birch.entityId, 'Back'), o.Alder.entityId), /cycle/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM activity_inclusion WHERE org_id = $1', [o.orgId])).rows[0].n, 2);
  // The same rule on UPDATE: re-pointing Birch's edge at Alder would close a loop; an ordinary change to an edge is not a cycle.
  const birchEdge = (await pool.query('SELECT inclusion_id FROM activity_inclusion WHERE org_id = $1 AND return_id = $2', [o.orgId, r.Birch])).rows[0].inclusion_id;
  await assert.rejects(pool.query('UPDATE activity_inclusion SET source_entity_id = $2 WHERE inclusion_id = $1', [birchEdge, o.Alder.entityId]), /cycle/);
  await pool.query(`UPDATE activity_inclusion SET approved_by = 'second reviewer' WHERE inclusion_id = $1`, [birchEdge]);
});

test('opening_bridge: the account and the fact’s baseline both belong to the return’s company', async () => {
  const o = await org(['Parent', 'Other']);
  const own = await baseline(o.orgId, o.Parent.entityId);
  const ownFact = await fact(o.orgId, own);
  const otherFact = await fact(o.orgId, await baseline(o.orgId, o.Other.entityId));
  const r = await period(o.orgId, o.Parent.entityId, { predecessor_baseline_id: own });
  await assert.rejects(bridge(o.orgId, r, ownFact, o.Other.accountId), /account belongs to another company/);
  await assert.rejects(bridge(o.orgId, r, otherFact, o.Parent.accountId), /baseline belongs to another company/);
  await bridge(o.orgId, r, ownFact, o.Parent.accountId);
});

test('opening_bridge: a fact is bridged only from the period’s predecessor baseline, and the predecessor stays while bridges stand', async () => {
  const o = await org(['Parent', 'Newborn']);
  // Two baselines of the same company for 2024: the filed import and the corrected one that supersedes it; the period chose the corrected.
  const filed = await baseline(o.orgId, o.Parent.entityId);
  const corrected = await baseline(o.orgId, o.Parent.entityId, { kind: 'corrected', supersedes_baseline_id: filed, importKey: 'corrected-2024' });
  const filedFact = await fact(o.orgId, filed);
  const correctedFact = await fact(o.orgId, corrected);
  const r = await period(o.orgId, o.Parent.entityId, { predecessor_baseline_id: corrected });
  // Same company, but not the period's predecessor: the superseded baseline's fact is not this period's opening.
  await assert.rejects(bridge(o.orgId, r, filedFact, o.Parent.accountId), /the fact must belong to the period's predecessor baseline/);
  await bridge(o.orgId, r, correctedFact, o.Parent.accountId);
  // While a bridge allocates the predecessor's facts, the predecessor is neither cleared nor changed; other columns may change.
  await assert.rejects(pool.query('UPDATE tax_return SET predecessor_baseline_id = NULL WHERE return_id = $1', [r]), /remove the opening bridges before changing the predecessor/);
  await assert.rejects(pool.query('UPDATE tax_return SET predecessor_baseline_id = $2 WHERE return_id = $1', [r, filed]), /remove the opening bridges before changing the predecessor/);
  await pool.query(`UPDATE tax_return SET status = 'review' WHERE return_id = $1`, [r]);
  // Once the bridges are removed, changing the predecessor is an ordinary (predecessor-checked) change again.
  await pool.query('DELETE FROM opening_bridge WHERE org_id = $1 AND return_id = $2', [o.orgId, r]);
  await pool.query('UPDATE tax_return SET predecessor_baseline_id = $2 WHERE return_id = $1', [r, filed]);
  // A period with no predecessor has nothing to bridge — here an initial period (no predecessor; zero openings once verified, §4.3) — whatever
  // baselines its company has on file.
  const initial = await period(o.orgId, o.Newborn.entityId, { period_start: '2025-06-01', initial_status: 'requested' });
  const strayFact = await fact(o.orgId, await baseline(o.orgId, o.Newborn.entityId));
  await assert.rejects(bridge(o.orgId, initial, strayFact, o.Newborn.accountId), /the fact must belong to the period's predecessor baseline/);
});

test('tax_baseline: a corrected baseline supersedes only a baseline of the same company', async () => {
  const o = await org(['Parent', 'Other']);
  const filed = await baseline(o.orgId, o.Parent.entityId);
  await assert.rejects(baseline(o.orgId, o.Other.entityId, { kind: 'corrected', supersedes_baseline_id: filed, importKey: 'corrected-2024' }), /tax_baseline_supersedes_same_company/);
  await baseline(o.orgId, o.Parent.entityId, { kind: 'corrected', supersedes_baseline_id: filed, importKey: 'corrected-2024' });
});

test('tax_return: a predecessor is the same company, same return type, adjacent, and on the period’s basis unless a reviewed exception is recorded', async () => {
  const o = await org(['Parent', 'Other']);
  const accrual2024 = await baseline(o.orgId, o.Parent.entityId);
  await assert.rejects(period(o.orgId, o.Other.entityId, { predecessor_baseline_id: accrual2024 }), /another company/);
  await assert.rejects(period(o.orgId, o.Parent.entityId, { returnType: 'form_1120s', predecessor_baseline_id: accrual2024 }), /another return type/);
  await assert.rejects(period(o.orgId, o.Parent.entityId, { year: 2026, predecessor_baseline_id: accrual2024 }), /day before/);
  // A cash-basis Schedule L never silently seeds an accrual period's openings (spec §4.3).
  const cash2024 = await baseline(o.orgId, o.Parent.entityId, { bookBasis: 'cash', importKey: 'filed-2024-cash' });
  await assert.rejects(period(o.orgId, o.Parent.entityId, { predecessor_baseline_id: cash2024 }), /basis/);
  // The exception is a reason and the person who accepted it, together, and only with a predecessor.
  const exception = { predecessor_basis_exception_reason: 'Books moved to accrual on 2025-01-01; openings restated', predecessor_basis_exception_by: 'reviewer' };
  await assert.rejects(period(o.orgId, o.Parent.entityId, { predecessor_baseline_id: cash2024, predecessor_basis_exception_reason: exception.predecessor_basis_exception_reason }), /check constraint/);
  await assert.rejects(period(o.orgId, o.Parent.entityId, exception), /check constraint/);
  const r = await period(o.orgId, o.Parent.entityId, { predecessor_baseline_id: cash2024, ...exception });
  // An exception recorded where the bases match would be a false record; clearing it with the change is fine.
  await assert.rejects(pool.query('UPDATE tax_return SET predecessor_baseline_id = $2 WHERE return_id = $1', [r, accrual2024]), /bases match/);
  await pool.query('UPDATE tax_return SET predecessor_baseline_id = $2, predecessor_basis_exception_reason = NULL, predecessor_basis_exception_by = NULL WHERE return_id = $1', [r, accrual2024]);
});

test('baseline_fact: known ⇔ amount in both directions; one fact per identity even when the identity keys are NULL; a fact carries its baseline’s payload version', async () => {
  const o = await org(['Parent']);
  const b = await baseline(o.orgId, o.Parent.entityId);
  await assert.rejects(fact(o.orgId, b, { state: 'known', amount_cents: null }), /check constraint/);
  await assert.rejects(fact(o.orgId, b, { state: 'unknown', amount_cents: 5 }), /check constraint/);
  const unknownBasis = { fact_kind: 'outside_basis', field_id: null, interest_key: null, state: 'unknown', amount_cents: null };
  await fact(o.orgId, b, unknownBasis);
  await assert.rejects(fact(o.orgId, b, unknownBasis), /baseline_fact_identity/);
  await fact(o.orgId, b, { ...unknownBasis, interest_key: 'partner-1' }); // a key makes a different identity
  // payload_version has one home: a baseline row holds one payload version, so a fact at another version under it is refused;
  // a new version of the payload is a new baseline row (same import key, version 2), and its facts carry version 2.
  await assert.rejects(fact(o.orgId, b, { ...unknownBasis, payload_version: 2 }), /baseline_fact_payload_version/);
  // Importing the same payload twice creates nothing new: the import identity is (company, import key, payload version).
  await assert.rejects(baseline(o.orgId, o.Parent.entityId), /tax_baseline_import_identity/);
  const b2 = await baseline(o.orgId, o.Parent.entityId, { kind: 'corrected', supersedes_baseline_id: b, payload_version: 2 });
  await fact(o.orgId, b2, { ...unknownBasis, payload_version: 2 });
  await assert.rejects(fact(o.orgId, b2, { ...unknownBasis, payload_version: 1 }), /baseline_fact_payload_version/);
});

test('tax_return: short_period is derived from the dates — true only for an initial period starting after January 1', async () => {
  const o = await org(['Steady', 'Newborn']);
  const shortPeriod = async returnId => (await pool.query('SELECT short_period FROM tax_return WHERE return_id = $1', [returnId])).rows[0].short_period;
  assert.equal(await shortPeriod(await period(o.orgId, o.Steady.entityId)), false);
  assert.equal(await shortPeriod(await period(o.orgId, o.Newborn.entityId, { period_start: '2025-06-01', initial_status: 'requested' })), true);
  // Only an initial period may start mid-year (spec §2: the one supported short period), and the flag is never written by hand.
  await assert.rejects(period(o.orgId, o.Steady.entityId, { year: 2026, period_start: '2026-06-01' }), /check constraint/);
  await assert.rejects(period(o.orgId, o.Steady.entityId, { year: 2026, short_period: false }), /short_period/);
});

test('parties: people, trusts and companies; tax ids encrypted; a grantor trust reports to people by exact share and date', async () => {
  const pat = await saveParty(pool, { ...S, fields: { kind: 'individual', name: 'Pat Owner', taxId: '123-45-6789' }, env: { SETTINGS_KEY: KEY } });
  const sam = await saveParty(pool, { ...S, fields: { kind: 'individual', name: 'Sam Owner', taxId: '' }, env: { SETTINGS_KEY: KEY } });
  const trust = await saveParty(pool, { ...S, fields: { kind: 'grantor_trust', name: 'Owner Family Trust', taxId: '98-7654321' }, env: { SETTINGS_KEY: KEY } });
  const co = await saveParty(pool, { ...S, fields: { kind: 'entity_in_org', name: 'Second Ranch', entityId: B.entityId }, env: {} });
  const all = await listParties(pool, S);
  const byId = new Map(all.map(p => [p.party_id, p]));
  assert.equal(byId.get(pat).tax_id_last4, '6789');
  assert.equal(byId.get(pat).has_tax_id, true);
  assert.ok(!Object.hasOwn(byId.get(pat), 'tax_id_enc'), 'the encrypted value never leaves the data layer');
  assert.equal(byId.get(sam).has_tax_id, false);
  assert.equal(byId.get(co).entity_id, B.entityId);
  // Refused: a tax id without SETTINGS_KEY; a company party pointing at nothing; a second party for the same company.
  await assert.rejects(saveParty(pool, { ...S, fields: { kind: 'individual', name: 'X', taxId: '111-22-3333' }, env: {} }), /SETTINGS_KEY/);
  await assert.rejects(saveParty(pool, { ...S, fields: { kind: 'entity_in_org', name: 'Y' }, env: {} }), /Choose the company/);
  await assert.rejects(saveParty(pool, { ...S, fields: { kind: 'entity_in_org', name: 'Dup', entityId: B.entityId }, env: {} }), /already/);
  // Update path: a changed kind is saved; a blank taxId keeps the saved one; clearTaxId='1' removes it; an unknown id is refused.
  assert.equal(await saveParty(pool, { ...S, partyId: pat, fields: { kind: 'individual', name: 'Pat Owner-Smith', taxId: '' }, env: {} }), pat);
  assert.deepEqual([(await getParty(pool, { ...S, partyId: pat })).name, (await getParty(pool, { ...S, partyId: pat })).tax_id_last4], ['Pat Owner-Smith', '6789']);
  await saveParty(pool, { ...S, partyId: sam, fields: { kind: 'entity_outside', name: 'Sam Owner', taxId: '', clearTaxId: '1' }, env: {} });
  assert.deepEqual([(await getParty(pool, { ...S, partyId: sam })).kind, (await getParty(pool, { ...S, partyId: sam })).has_tax_id], ['entity_outside', false]);
  await saveParty(pool, { ...S, partyId: sam, fields: { kind: 'individual', name: 'Sam Owner', taxId: '222-33-4444' }, env: { SETTINGS_KEY: KEY } });
  assert.deepEqual([(await getParty(pool, { ...S, partyId: sam })).kind, (await getParty(pool, { ...S, partyId: sam })).tax_id_last4], ['individual', '4444']);
  await saveParty(pool, { ...S, partyId: sam, fields: { kind: 'individual', name: 'Sam Owner', taxId: '', clearTaxId: '1' }, env: {} });
  assert.equal((await getParty(pool, { ...S, partyId: sam })).has_tax_id, false);
  await assert.rejects(saveParty(pool, { ...S, partyId: 999999, fields: { kind: 'individual', name: 'Nobody' }, env: {} }), /Party not found/);
  // Grantor reporting: shares total exactly 1 on every date. One call = one effective_from; an interval is closed only by the
  // next call (effective_to = the day before), so intervals for one trust never overlap and a per-row `to` is refused.
  const owners = async on => (await grantorOwnersOn(pool, { ...S, trustPartyId: trust, on })).map(r => [r.owner_party_id, r.share_num, r.share_den]);
  await saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: pat, shareNum: 1, shareDen: 2, from: '2025-01-01' }, { ownerPartyId: sam, shareNum: 1, shareDen: 2, from: '2025-01-01' }], method: 'optional_1', reviewedBy: 'tester' });
  assert.deepEqual(await owners('2024-12-31'), [], 'nothing before the first effective_from');
  assert.deepEqual(await owners('2025-12-31'), [[pat, 1, 2], [sam, 1, 2]]);
  await assert.rejects(saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: pat, shareNum: 1, shareDen: 3, from: '2026-01-01' }], method: 'optional_1', reviewedBy: 'tester' }), /shares must total 1/);
  await assert.rejects(saveGrantorReporting(pool, { ...S, trustPartyId: pat, rows: [{ ownerPartyId: sam, shareNum: 1, shareDen: 1, from: '2026-01-01' }], method: 'optional_1', reviewedBy: 'tester' }), /not a grantor trust/);
  await assert.rejects(saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: pat, shareNum: 1, shareDen: 2, from: '2026-01-01' }, { ownerPartyId: pat, shareNum: 1, shareDen: 2, from: '2026-01-01' }], method: 'optional_1', reviewedBy: 'tester' }), /once per change/);
  await assert.rejects(saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: pat, shareNum: 1, shareDen: 1, from: '2026-01-01', to: '2026-06-30' }], method: 'optional_1', reviewedBy: 'tester' }), /end date/);
  await assert.rejects(saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: pat, shareNum: 1, shareDen: 1, from: '2026-01-01', to: 'nope' }], method: 'optional_1', reviewedBy: 'tester' }), /end date/);
  assert.deepEqual(await owners('2026-06-30'), [[pat, 1, 2], [sam, 1, 2]], 'refused calls change nothing');
  // A later change closes the earlier open interval the day before and takes over from its date.
  await saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: pat, shareNum: 1, shareDen: 1, from: '2026-04-01' }], method: 'optional_2', reviewedBy: 'tester' });
  assert.deepEqual(await owners('2026-03-31'), [[pat, 1, 2], [sam, 1, 2]]);
  assert.deepEqual(await owners('2026-04-01'), [[pat, 1, 1]]);
  assert.deepEqual(await owners('2026-12-31'), [[pat, 1, 1]]);
  const { rows: closed } = await pool.query('SELECT effective_to::text FROM grantor_reporting WHERE org_id = $1 AND trust_party_id = $2 AND effective_from = $3 ORDER BY owner_party_id', [S.orgId, trust, '2025-01-01']);
  assert.deepEqual(closed.map(r => r.effective_to), ['2026-03-31', '2026-03-31']);
  // A change dated on or before an existing later change is refused: that change is the one to edit.
  await assert.rejects(saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: sam, shareNum: 1, shareDen: 1, from: '2026-02-01' }], method: 'optional_1', reviewedBy: 'tester' }), /later owner change already exists/);
  await assert.rejects(saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: sam, shareNum: 1, shareDen: 1, from: '2026-04-01' }], method: 'optional_1', reviewedBy: 'tester' }), /later owner change already exists/);
  assert.deepEqual(await owners('2026-02-15'), [[pat, 1, 2], [sam, 1, 2]], 'refused calls change nothing');
  // Migration 064's rules reach the form as messages, not pg errors: the trust is not its own owner (CHECK), every owner is a party of this org (FK).
  await assert.rejects(saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: trust, shareNum: 1, shareDen: 1, from: '2027-01-01' }], method: 'optional_1', reviewedBy: 'tester' }), /cannot be its own owner/);
  await assert.rejects(saveGrantorReporting(pool, { ...S, trustPartyId: trust, rows: [{ ownerPartyId: 999999, shareNum: 1, shareDen: 1, from: '2027-01-01' }], method: 'optional_1', reviewedBy: 'tester' }), /Owner not found/);
  assert.deepEqual(await owners('2027-06-30'), [[pat, 1, 1]], 'refused calls change nothing');
  // Household members: taxpayer and spouse are two parties.
  await saveHouseholdMembers(pool, { ...S, members: [{ partyId: pat, role: 'taxpayer', from: '2025-01-01' }, { partyId: sam, role: 'spouse', from: '2025-01-01' }] });
  await assert.rejects(saveHouseholdMembers(pool, { ...S, members: [{ partyId: pat, role: 'taxpayer', from: '2025-01-01' }, { partyId: sam, role: 'taxpayer', from: '2025-01-01' }] }), /one taxpayer/);
  // Mirrors of the table's CHECK, FK and PRIMARY KEY: a role outside taxpayer/spouse, a party not in this org, the same party listed twice.
  await assert.rejects(saveHouseholdMembers(pool, { ...S, members: [{ partyId: pat, role: 'taxpayer', from: '2025-01-01' }, { partyId: sam, role: 'dependent', from: '2025-01-01' }] }), /taxpayer or spouse/);
  await assert.rejects(saveHouseholdMembers(pool, { ...S, members: [{ partyId: pat, role: 'taxpayer', from: '2025-01-01' }, { partyId: 999999, role: 'spouse', from: '2025-01-01' }] }), /Party not found/);
  await assert.rejects(saveHouseholdMembers(pool, { ...S, members: [{ partyId: pat, role: 'taxpayer', from: '2025-01-01' }, { partyId: pat, role: 'spouse', from: '2025-01-01' }] }), /once/);
  const { rows: household } = await pool.query('SELECT party_id, role FROM tax_household_member WHERE org_id = $1 AND entity_id = $2 AND effective_to IS NULL ORDER BY role', [S.orgId, S.entityId]);
  assert.deepEqual(household.map(r => [r.party_id, r.role]), [[sam, 'spouse'], [pat, 'taxpayer']], 'refused calls change nothing');
});

test('profiles are defaults for the next period; changing the return type needs a reason; periods are calendar years bound to one edition', async () => {
  assert.equal(yearEndFromFiscalStart(1), 12); assert.equal(yearEndFromFiscalStart(7), 6); assert.equal(yearEndFromFiscalStart(2), 1);
  let p = await getProfile(pool, S);
  assert.deepEqual([p.return_type, p.year_end_month, p.accountant_may_edit], ['none', 12, true], 'a company with no profile shows defaults');
  await saveProfile(pool, { ...S, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12, businessCode: '459990', dateStarted: '2022-09-14', stateCodes: 'NM, AZ' }, reason: 'as filed', actor: 'tester' });
  p = await getProfile(pool, S);
  assert.deepEqual([p.return_type, p.tax_method_default, p.business_code, p.state_codes], ['form_1065', 'cash', '459990', ['NM', 'AZ']]);
  await assert.rejects(saveProfile(pool, { ...S, fields: { returnType: 'form_1120s', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: '', actor: 'tester' }), /reason/);
  await assert.rejects(saveProfile(pool, { ...S, fields: { returnType: 'disregarded', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'x', actor: 'tester' }), /what kind of activity/);
  await assert.rejects(saveProfile(pool, { ...S, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 6 }, reason: 'x', actor: 'tester' }), /calendar years/);

  const r = await openPeriod(pool, { ...S, year: 2025, actor: 'tester' });
  const got = await getPeriod(pool, { ...S, returnId: r });
  assert.deepEqual([got.period_start, got.period_end, got.return_type, got.form_edition, got.tax_method, got.book_basis, got.status, got.initial], ['2025-01-01', '2025-12-31', 'form_1065', 2025, 'cash', 'accrual', 'open', false]);
  assert.ok(catalogFor(got.return_type, got.form_edition), 'the period is bound to an edition that exists');
  await assert.rejects(openPeriod(pool, { ...S, year: 2025, actor: 'tester' }), /already exists/);
  // tax_return_one_period refuses ANY overlapping period for the company, whatever its return type (§2: one period covers a
  // date). After a reviewed change of return type the module still says so itself, as a ValidationError, not a raw pg error.
  await saveProfile(pool, { ...S, fields: { returnType: 'form_1120s', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'S election', actor: 'tester' });
  await assert.rejects(openPeriod(pool, { ...S, year: 2025, actor: 'tester' }), err => err instanceof ValidationError && /A 2025 period already exists/.test(err.message));
  await saveProfile(pool, { ...S, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'back as filed', actor: 'tester' });
  // An initial (first-year) period may start mid-year; a 2026 period is allowed but computes nothing until its edition ships.
  // A `profile` override is only for a company with no stored profile: a stored profile is the defaults for the next period
  // (§4.2) and changing it is a reviewed saveProfile change, so an override on top of it is refused, not merged.
  await assert.rejects(openPeriod(pool, { ...S, year: 2026, actor: 'tester', profile: { returnType: 'form_1120s' } }), err => err instanceof ValidationError && /already has a tax profile/.test(err.message));
  // Override values are validated like saveProfile's, as ValidationErrors rather than raw pg CHECK errors.
  await assert.rejects(openPeriod(pool, { ...B, year: 2025, actor: 'tester', profile: { returnType: 'form_1065', taxMethodDefault: 'hybrid' } }), err => err instanceof ValidationError && /cash or accrual/.test(err.message));
  await assert.rejects(openPeriod(pool, { ...B, year: 2025, actor: 'tester', profile: { returnType: 'form_1065', bookBasisDefault: 'tax' } }), err => err instanceof ValidationError && /basis/.test(err.message));
  await assert.rejects(openPeriod(pool, { ...B, year: 2025, actor: 'tester', profile: { returnType: 'form_990' } }), err => err instanceof ValidationError && /return type/.test(err.message));
  const first = await openPeriod(pool, { ...B, year: 2025, initial: true, periodStart: '2025-01-08', actor: 'tester', profile: { returnType: 'form_1065', taxMethodDefault: 'cash' } });
  const firstRow = await getPeriod(pool, { ...B, returnId: first });
  assert.deepEqual([firstRow.period_start, firstRow.tax_method, firstRow.book_basis], ['2025-01-08', 'cash', 'accrual'], 'an override names only what it changes; the rest comes from the module defaults');
  const next = await openPeriod(pool, { ...S, year: 2026, actor: 'tester' });
  assert.equal((await getPeriod(pool, { ...S, returnId: next })).computes, false, 'no 2026 catalog yet: computes = false, never a fallback to 2025');
  assert.equal((await listPeriods(pool, S)).length, 2);
});

test('activities belong to a return entity; a disregarded company enters only through an approved inclusion edge', async () => {
  // S files a 1065 (Task 8). B already files its own 2025 return (Task 8's test), so it is a K-1 payer, never includable.
  // K is a disregarded child of S. Periods, not profiles: K needs a disregarded 2025 period on file before it can be included.
  const K = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Kid Ranch', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...K, fields: { returnType: 'disregarded', activityKind: 'trade', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  await openPeriod(pool, { ...K, year: 2025, actor: 'tester' });
  const holding = await saveActivity(pool, { ...S, fields: { kind: 'holding', name: 'Own activity', schedule: 'p1', from: '2017-01-05' } });
  const ranch = await saveActivity(pool, { ...S, fields: { kind: 'trade', name: 'Kid Ranch (disregarded)', schedule: 'p1', from: '2025-01-01' } });
  assert.equal((await listActivities(pool, S)).length, 2);
  const period2025 = (await listPeriods(pool, S)).find(p => p.period_end === '2025-12-31').return_id;
  const edge = await includeBooks(pool, { ...S, returnId: period2025, activityId: ranch, sourceEntityId: K.entityId, approvedBy: 'tester' });
  const edges = await listInclusions(pool, { ...S, returnId: period2025 });
  assert.deepEqual(edges.map(e => [e.inclusion_id, e.source_entity_id, e.period_start, e.period_end, e.source_book_basis]), [[edge, K.entityId, '2025-01-01', '2025-12-31', 'accrual']]);
  // Refused: including the return's own books; including the same source twice; including a company that files its own return (B).
  await assert.rejects(includeBooks(pool, { ...S, returnId: period2025, activityId: holding, sourceEntityId: S.entityId, approvedBy: 'tester' }), /its own books/);
  await assert.rejects(includeBooks(pool, { ...S, returnId: period2025, activityId: holding, sourceEntityId: K.entityId, approvedBy: 'tester' }), /already included/);
  await assert.rejects(includeBooks(pool, { ...S, returnId: period2025, activityId: holding, sourceEntityId: B.entityId, approvedBy: 'tester' }), /only a disregarded company/);
  // A company with only a profile (no disregarded period on file) is not evidence either.
  const D = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Fourth Co', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...D, fields: { returnType: 'disregarded', activityKind: 'trade', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  await assert.rejects(includeBooks(pool, { ...S, returnId: period2025, activityId: holding, sourceEntityId: D.entityId, approvedBy: 'tester' }), /open a disregarded period/);
  // A treatment is per recipient party, activity and period; unknown participation is allowed but reported as unresolved.
  // (The parties test above renamed Pat to 'Pat Owner-Smith'.)
  const pat = (await listParties(pool, S)).find(p => p.name === 'Pat Owner-Smith').party_id;
  await saveTreatment(pool, { ...S, activityId: ranch, recipientPartyId: pat, periodStart: '2025-01-01', periodEnd: '2025-12-31', participation: 'material', reviewedBy: 'tester' });
  await assert.rejects(saveTreatment(pool, { ...S, activityId: ranch, recipientPartyId: pat, periodStart: '2025-01-01', periodEnd: '2025-12-31', participation: 'sometimes' }), /participation/);
  // A treatment's period is a return period of this company (the T3+ lookup reads treatments by the return's dates): a bad,
  // missing or reversed date, or dates that match no period, is a form message, not a database error and not a hidden row.
  for (const [periodStart, periodEnd, re] of [['2025-1-1', '2025-12-31', /period start/], ['2025-01-01', undefined, /period end/], ['2025-12-31', '2025-01-01', /before the start/], ['2025-02-01', '2025-12-31', /no return period/]]) {
    await assert.rejects(saveTreatment(pool, { ...S, activityId: ranch, recipientPartyId: pat, periodStart, periodEnd, participation: 'passive' }),
      err => err instanceof ValidationError && re.test(err.message), `${periodStart}..${periodEnd}`);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM activity_treatment WHERE org_id = $1 AND activity_id = $2', [S.orgId, ranch])).rows[0].n, 1);
  // Company scope: a caller opening B cannot write a treatment on S's activity, nor read S's inclusion rows by return_id.
  await assert.rejects(saveTreatment(pool, { ...B, activityId: ranch, recipientPartyId: pat, periodStart: '2025-01-01', periodEnd: '2025-12-31', participation: 'passive' }), /Activity not found on this return/);
  const { rows: [kept] } = await pool.query('SELECT participation FROM activity_treatment WHERE org_id = $1 AND activity_id = $2 AND recipient_party_id = $3', [S.orgId, ranch, pat]);
  assert.equal(kept.participation, 'material', 'the refused call changed nothing');
  assert.deepEqual(await listInclusions(pool, { ...B, returnId: period2025 }), []);
  assert.equal((await listInclusions(pool, { ...S, returnId: period2025 })).length, 1);
  // An inclusion can be added only while the period is open, the same gate removeInclusion applies.
  await pool.query(`UPDATE tax_return SET status = 'review' WHERE org_id = $1 AND return_id = $2`, [S.orgId, period2025]);
  await assert.rejects(includeBooks(pool, { ...S, returnId: period2025, activityId: holding, sourceEntityId: K.entityId, approvedBy: 'tester' }), /period is review, not open/);
  await pool.query(`UPDATE tax_return SET status = 'open' WHERE org_id = $1 AND return_id = $2`, [S.orgId, period2025]);
  // Rental days are tax inputs (Schedule E allocation): non-negative whole days up to a year, blank stored as null, never a silent 0.
  const rental = (days) => saveActivity(pool, { ...S, fields: { kind: 'rental', name: 'Cabin', schedule: 'sch_e1', from: '2025-01-01', property: { address: '1 Lake Rd', type: 'single_family', ...days } } });
  for (const bad of [{ fairRentalDays: 'abc' }, { fairRentalDays: -1 }, { fairRentalDays: 1.5 }, { fairRentalDays: 400 }, { personalUseDays: 'abc' }, { personalUseDays: -3 }, { personalUseDays: 2.5 }, { personalUseDays: 367 }]) {
    await assert.rejects(rental(bad), err => err instanceof ValidationError && /days/.test(err.message), JSON.stringify(bad));
  }
  await assert.rejects(rental({ fairRentalDays: 300, personalUseDays: 100 }), /together/);
  // A reversed date range is the module's message (mirroring 064's CHECK), not a raw database error.
  await assert.rejects(saveActivity(pool, { ...S, fields: { kind: 'trade', name: 'Backwards', schedule: 'p1', from: '2025-06-01', to: '2025-01-31' } }), err => err instanceof ValidationError && /end date is before the start/.test(err.message));
  await assert.rejects(saveActivity(pool, { ...S, fields: { kind: 'trade', name: 'Backwards', schedule: 'p1', from: '2025-06-01', disposedOn: '2024-12-31' } }), err => err instanceof ValidationError && /disposal date is before the start/.test(err.message));
  const cabin = await rental({ fairRentalDays: '0', personalUseDays: '' });
  const { rows: [cabinRow] } = await pool.query('SELECT property FROM tax_activity WHERE org_id = $1 AND activity_id = $2', [S.orgId, cabin]);
  assert.deepEqual([cabinRow.property.fairRentalDays, cabinRow.property.personalUseDays], [0, null]);
  const cabin2 = await rental({ fairRentalDays: ' 200 ', personalUseDays: 14 });
  const { rows: [cabin2Row] } = await pool.query('SELECT property FROM tax_activity WHERE org_id = $1 AND activity_id = $2', [S.orgId, cabin2]);
  assert.deepEqual([cabin2Row.property.fairRentalDays, cabin2Row.property.personalUseDays], [200, 14]);
});
