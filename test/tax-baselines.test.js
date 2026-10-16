// test/tax-baselines.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { createCompany } from '../lib/data/companies.js';
import { saveProfile, openPeriod, getPeriod, setPredecessor } from '../lib/tax/periods.js';
import { importBaseline, listBaselines, baselineFacts, bridgeOpening, approveBridge, listBridge } from '../lib/tax/baselines.js';
import { ValidationError } from '../lib/data/writes.js';

let db, pool, S, B, A;
const payload = (over = {}) => ({
  importKey: 'filed-2025-1065', payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1065', formEdition: 2025, bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges',
  sourcePeriodStart: '2025-01-01', sourcePeriodEnd: '2025-12-31', sourceDocument: { hash: 'sha256:abc', pages: '1-41' }, extractionStatus: 'verified',
  facts: [
    { factKind: 'schedule_l_end', fieldId: 'f1065.L.1', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '10328600', state: 'known', provenance: { page: 14, field: 'Schedule L line 1(d)' }, reviewStatus: 'verified' },
    { factKind: 'schedule_l_end', fieldId: 'f1065.L.3', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '23114600', state: 'known', provenance: { page: 14 }, reviewStatus: 'verified' },
    { factKind: 'tax_capital', interestKey: 'partner-1', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '71525000', state: 'known', provenance: { page: 27, field: 'K-1 item L ending' }, reviewStatus: 'verified' },
    { factKind: 'outside_basis', interestKey: 'partner-1', measurement: 'end', effectiveOn: '2025-12-31', amountCents: null, state: 'unknown', provenance: { note: 'basis worksheet not in package' }, reviewStatus: 'raw' },
  ], ...over });

before(async () => {
  db = await freshDb(); pool = db.pool;
  const ids = await writeSample(pool, generateSample({ asOf: '2026-10-12' }));
  S = { orgId: ids.orgId, entityId: ids.entityId }; A = ids.accounts;
  B = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Second Ranch', timeZone: 'America/Chicago' }) };
  for (const scope of [S, B]) await saveProfile(pool, { ...scope, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
});
after(async () => { await db.drop(); });

test('a baseline has identity; its payload is versioned; importing the same payload twice creates nothing new; unknown stays unknown', async () => {
  const b1 = await importBaseline(pool, { ...S, payload: payload(), actor: 'tester' });
  const again = await importBaseline(pool, { ...S, payload: payload(), actor: 'tester' });
  assert.equal(again.baselineId, b1.baselineId); assert.equal(again.created, false);
  assert.equal((await listBaselines(pool, S)).length, 1);
  const facts = await baselineFacts(pool, { ...S, baselineId: b1.baselineId });
  assert.equal(facts.length, 4);
  const basis = facts.find(f => f.fact_kind === 'outside_basis');
  assert.deepEqual([basis.state, basis.amount_cents], ['unknown', null], 'unknown is not zero');
  assert.equal(facts.find(f => f.field_id === 'f1065.L.1').amount_cents, 10328600);
  // A corrected payload (version 2) keeps version 1 readable and supersedes the first baseline.
  const b2 = await importBaseline(pool, { ...S, payload: payload({ payloadVersion: 2, kind: 'corrected', supersedesBaselineId: b1.baselineId,
    facts: [{ factKind: 'schedule_l_end', fieldId: 'f1065.L.1', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '10328600', state: 'known', provenance: { page: 14, correction: 'line 22→23 APIC' }, reviewStatus: 'verified' }] }), actor: 'tester' });
  assert.notEqual(b2.baselineId, b1.baselineId);
  assert.equal((await baselineFacts(pool, { ...S, baselineId: b1.baselineId })).length, 4, 'the old payload is still there');
  // Refused: a fact with an unknown catalog id, a known fact with no amount, a payload without identity.
  await assert.rejects(importBaseline(pool, { ...S, payload: payload({ importKey: 'x', facts: [{ factKind: 'form_line', fieldId: 'f1065.p1.99', measurement: 'activity', effectiveOn: '2025-12-31', amountCents: '1', state: 'known', provenance: {} }] }), actor: 'tester' }), /f1065\.p1\.99/);
  await assert.rejects(importBaseline(pool, { ...S, payload: payload({ importKey: 'y', facts: [{ factKind: 'tax_capital', interestKey: 'p', measurement: 'end', effectiveOn: '2025-12-31', amountCents: null, state: 'known', provenance: {} }] }), actor: 'tester' }), /known fact needs an amount/);
  await assert.rejects(importBaseline(pool, { ...S, payload: payload({ importKey: 'z', returnType: 'form_9999' }), actor: 'tester' }), /return type/);
});

test('the profile does not gate the return type: a filed 1120-S imports under a 1065 profile (periods, not profiles, decide)', async () => {
  const r = await importBaseline(pool, { ...S, payload: payload({ importKey: 'filed-2023-1120s', returnType: 'form_1120s', formEdition: 2023, sourcePeriodStart: '2023-01-01', sourcePeriodEnd: '2023-12-31',
    facts: [{ factKind: 'aaa', measurement: 'end', effectiveOn: '2023-12-31', amountCents: '500000', state: 'known', provenance: {} }] }), actor: 'tester' });
  assert.equal(r.created, true);
});

test('bad amounts and a missing measurement are refused as validation errors, naming the fact', async () => {
  const fact = over => ({ factKind: 'tax_capital', interestKey: 'p', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '1', state: 'known', provenance: {}, ...over });
  for (const bad of ['12.50', '1,000', '', 12.5, 100]) {
    await assert.rejects(importBaseline(pool, { ...S, payload: payload({ importKey: 'amt', facts: [fact({ amountCents: bad })] }), actor: 'tester' }),
      e => e instanceof ValidationError && /tax_capital: amountCents must be a string of integer cents/.test(e.message), `amount ${JSON.stringify(bad)}`);
  }
  await assert.rejects(importBaseline(pool, { ...S, payload: payload({ importKey: 'meas', facts: [{ factKind: 'form_line', fieldId: 'f1065.p1.1a', effectiveOn: '2025-12-31', amountCents: '1', state: 'known', provenance: {} }] }), actor: 'tester' }),
    e => e instanceof ValidationError && /form_line f1065\.p1\.1a: measurement must be/.test(e.message));
  assert.equal((await listBaselines(pool, S)).filter(b => ['amt', 'meas'].includes(b.import_key)).length, 0, 'nothing was stored');
});

test('two facts with the same identity in one payload, and a formEdition that is not a year, are validation errors naming the fact (never a database error)', async () => {
  // Two tax_capital 'end' facts that both forgot interestKey collide on the baseline_fact_identity index.
  // (A per-interest kind without its interestKey is refused on its own — see the B7 subject-key test below — so the collision is
  // shown with a kind that needs no key: two carryforward 'end' facts with no keys at all.)
  const twin = { factKind: 'carryforward', measurement: 'end', effectiveOn: '2025-12-31', state: 'known', provenance: {} };
  await assert.rejects(importBaseline(pool, { ...S, payload: payload({ importKey: 'dup', facts: [{ ...twin, amountCents: '100' }, { ...twin, amountCents: '200' }] }), actor: 'tester' }),
    e => e instanceof ValidationError && /carryforward: two facts share the same identity/.test(e.message));
  // The same pair told apart by a key is fine.
  assert.equal((await importBaseline(pool, { ...S, payload: payload({ importKey: 'dup', facts: [{ ...twin, partyKey: 'p1', amountCents: '100' }, { ...twin, partyKey: 'p2', amountCents: '200' }] }), actor: 'tester' })).created, true);
  for (const bad of [undefined, 'abc', 2025.5, 1999, 2101]) {
    await assert.rejects(importBaseline(pool, { ...S, payload: payload({ importKey: 'ed', formEdition: bad }), actor: 'tester' }),
      e => e instanceof ValidationError && /formEdition must be a year between 2000 and 2100/.test(e.message), `formEdition ${JSON.stringify(bad)}`);
  }
  assert.equal((await listBaselines(pool, S)).filter(b => b.import_key === 'ed').length, 0, 'nothing was stored');
});

test('the same identity with different content is refused, not silently discarded; a padded importKey is the same key', async () => {
  const same = await importBaseline(pool, { ...S, payload: payload({ importKey: '  filed-2025-1065  ' }), actor: 'tester' });
  assert.equal(same.created, false, 'surrounding whitespace does not make a new identity');
  // Same content, different commentary (provenance, review status): still the same payload.
  const commentary = payload(); commentary.facts = commentary.facts.map(f => ({ ...f, provenance: { page: 99 }, reviewStatus: 'raw' }));
  assert.equal((await importBaseline(pool, { ...S, payload: commentary, actor: 'tester' })).created, false);
  // A changed amount under version 1 of the same key is refused and names the way out.
  const changed = payload(); changed.facts = changed.facts.map(f => f.fieldId === 'f1065.L.1' ? { ...f, amountCents: '10328601' } : f);
  await assert.rejects(importBaseline(pool, { ...S, payload: changed, actor: 'tester' }), e => e instanceof ValidationError && /payloadVersion 1 of importKey filed-2025-1065 already exists with different content; use a new payloadVersion/.test(e.message));
  // A changed header (book basis) is refused the same way; the fact set alone does not define the payload.
  await assert.rejects(importBaseline(pool, { ...S, payload: payload({ bookBasis: 'cash' }), actor: 'tester' }), /different content/);
  assert.equal((await listBaselines(pool, S)).filter(b => b.import_key === 'filed-2025-1065').length, 2, 'versions 1 and 2 only');
});

test('a predecessor must be the same company, same return type, ending the day before the period starts', async () => {
  const b = (await listBaselines(pool, S))[0].baseline_id;
  const r2026 = await openPeriod(pool, { ...S, year: 2026, actor: 'tester' });
  await setPredecessor(pool, { ...S, returnId: r2026, baselineId: b });
  assert.equal((await getPeriod(pool, { ...S, returnId: r2026 })).predecessor_baseline_id, b);
  // Same org, wrong company: refused by the module and by the trigger.
  const rB = await openPeriod(pool, { ...B, year: 2026, actor: 'tester' });
  await assert.rejects(setPredecessor(pool, { ...B, returnId: rB, baselineId: b }), /another company/);
  await assert.rejects(pool.query('UPDATE tax_return SET predecessor_baseline_id = $1 WHERE return_id = $2', [b, rB]), /another company/);
  // Wrong adjacency: a 2025 baseline cannot precede a 2027 period.
  const r2027 = await openPeriod(pool, { ...S, year: 2027, actor: 'tester' });
  await assert.rejects(setPredecessor(pool, { ...S, returnId: r2027, baselineId: b }), /day before/);
});

test('an opening bridge allocates a filed aggregate across accounts, reviewed; an account of another company is refused', async () => {
  const b = (await listBaselines(pool, S))[0].baseline_id;
  const cash = (await baselineFacts(pool, { ...S, baselineId: b })).find(f => f.field_id === 'f1065.L.1').fact_id;
  const r2026 = (await pool.query(`SELECT return_id FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_end = '2026-12-31'`, [S.orgId, S.entityId])).rows[0].return_id;
  await bridgeOpening(pool, { ...S, returnId: r2026, factId: cash, rows: [{ accountId: A.checking, allocatedCents: '10000000', explanation: 'operating' }, { accountId: A.savings, allocatedCents: '328600', explanation: 'savings' }], approvedBy: 'tester' });
  const rows = await listBridge(pool, { ...S, returnId: r2026 });
  assert.deepEqual(rows.map(r => [r.account_id, r.allocated_cents]), [[A.checking, 10000000], [A.savings, 328600]]);
  assert.deepEqual(await listBridge(pool, { ...B, returnId: r2026 }), [], 'another company of the same org sees nothing of this period');
  await assert.rejects(bridgeOpening(pool, { ...S, returnId: r2026, factId: cash, rows: [{ accountId: A.checking, allocatedCents: '103286.00', explanation: 'x' }], approvedBy: 'tester' }),
    e => e instanceof ValidationError && /allocatedCents for account \d+: amountCents must be a string of integer cents/.test(e.message));
  await assert.rejects(bridgeOpening(pool, { ...S, returnId: r2026, factId: cash, rows: [{ accountId: A.checking, allocatedCents: '1', explanation: 'short' }], approvedBy: 'tester' }), /must total/);
  // The same account twice is one row's identity (opening_bridge UNIQUE), so it is refused by name, not by the database.
  await assert.rejects(bridgeOpening(pool, { ...S, returnId: r2026, factId: cash, rows: [{ accountId: A.checking, allocatedCents: '10000000', explanation: 'a' }, { accountId: A.checking, allocatedCents: '328600', explanation: 'b' }], approvedBy: 'tester' }),
    e => e instanceof ValidationError && new RegExp(`account ${A.checking} appears twice`).test(e.message));
  assert.deepEqual((await listBridge(pool, { ...S, returnId: r2026 })).map(r => [r.account_id, r.allocated_cents]), [[A.checking, 10000000], [A.savings, 328600]], 'the earlier bridge is untouched');
  const { rows: [bAcct] } = await pool.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 LIMIT 1', [B.orgId, B.entityId]);
  await assert.rejects(bridgeOpening(pool, { ...S, returnId: r2026, factId: cash, rows: [{ accountId: bAcct.account_id, allocatedCents: '10328600', explanation: 'x' }], approvedBy: 'tester' }), /another company/);
});

// Codex t1-r1 B7: the baseline's declared consolidation policy is identity, stored and compared like the book basis, and a
// predecessor on another policy is a reviewed exception or refused — by the module and by the trigger.
test('a baseline keeps its declared consolidation policy; a predecessor on another policy needs a reviewed exception', async () => {
  const C = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Third Ranch', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...C, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  const p = payload({ importKey: 'standalone-2025', consolidationPolicy: 'none' });
  const { baselineId } = await importBaseline(pool, { ...C, payload: p, actor: 'tester' });
  assert.equal((await listBaselines(pool, C)).find(b => b.baseline_id === baselineId).consolidation_policy, 'none', 'the declared policy is stored, not defaulted');
  // The policy is content: the same identity with the other policy is refused; a payload that does not say is refused.
  await assert.rejects(importBaseline(pool, { ...C, payload: { ...p, consolidationPolicy: 'inclusion_edges' }, actor: 'tester' }), /different content/);
  const { consolidationPolicy, ...silent } = payload({ importKey: 'silent-2025' });
  assert.equal(consolidationPolicy, 'inclusion_edges');
  await assert.rejects(importBaseline(pool, { ...C, payload: silent, actor: 'tester' }), e => e instanceof ValidationError && /consolidationPolicy/.test(e.message));
  // A 2026 period (inclusion_edges) refuses the standalone baseline without a reviewed exception — module and trigger.
  const r = await openPeriod(pool, { ...C, year: 2026, actor: 'tester' });
  await assert.rejects(setPredecessor(pool, { ...C, returnId: r, baselineId }), e => e instanceof ValidationError && /consolidation/.test(e.message));
  await assert.rejects(pool.query('UPDATE tax_return SET predecessor_baseline_id = $1 WHERE return_id = $2', [baselineId, r]), /consolidation/);
  await assert.rejects(setPredecessor(pool, { ...C, returnId: r, baselineId, consolidationException: { reason: 'standalone books only' } }), /consolidation/, 'a reason without a reviewer is not an exception');
  await setPredecessor(pool, { ...C, returnId: r, baselineId, consolidationException: { reason: 'Child had no activity in 2025; the standalone balance sheet is complete', by: 'reviewer' } });
  const got = await getPeriod(pool, { ...C, returnId: r });
  assert.deepEqual([got.predecessor_baseline_id, got.predecessor_consolidation_exception_by], [baselineId, 'reviewer']);
  // An exception recorded where the policies match is a false record (trigger), as for the book basis.
  await assert.rejects(pool.query(`UPDATE tax_return SET consolidation_policy = 'none' WHERE return_id = $1`, [r]), /policies match/);
});

// Codex t1-r1 B7: an opening is the predecessor's END-of-period balance-sheet fact as of its last day, and an approved bridge
// needs a verified fact. A draft allocation may reference an unreviewed fact; it is approved only once the fact is verified.
test('only an end-of-period Schedule L fact dated the predecessor end is bridged, and an approved bridge needs a verified fact', async () => {
  const D = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Fourth Ranch', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...D, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  const { rows: [acct] } = await pool.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 LIMIT 1', [D.orgId, D.entityId]);
  const f = over => ({ factKind: 'schedule_l_end', fieldId: 'f1065.L.1', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '5000', state: 'known', provenance: {}, reviewStatus: 'verified', ...over });
  const { baselineId } = await importBaseline(pool, { ...D, payload: payload({ importKey: 'eligibility-2025', facts: [
    f({}), f({ measurement: 'begin', effectiveOn: '2025-01-01' }), f({ fieldId: 'f1065.L.3', effectiveOn: '2025-06-30' }),
    { factKind: 'tax_capital', interestKey: 'partner-1', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '5000', state: 'known', provenance: {}, reviewStatus: 'verified' },
    f({ fieldId: 'f1065.L.2a', reviewStatus: 'raw' })] }), actor: 'tester' });
  const facts = await baselineFacts(pool, { ...D, baselineId });
  const id = pred => facts.find(pred).fact_id;
  const good = id(x => x.field_id === 'f1065.L.1' && x.measurement === 'end');
  const begin = id(x => x.measurement === 'begin');
  const midYear = id(x => x.field_id === 'f1065.L.3');
  const capital = id(x => x.fact_kind === 'tax_capital');
  const raw = id(x => x.field_id === 'f1065.L.2a');
  const r = await openPeriod(pool, { ...D, year: 2026, actor: 'tester' });
  await setPredecessor(pool, { ...D, returnId: r, baselineId });
  const rows = [{ accountId: acct.account_id, allocatedCents: '5000', explanation: 'cash' }];
  const bridge = (factId, approvedBy = 'tester') => bridgeOpening(pool, { ...D, returnId: r, factId, rows, approvedBy });
  // The review's case: the prior year's BEGINNING cash is not the following year's opening.
  await assert.rejects(bridge(begin), e => e instanceof ValidationError && /end-of-period/.test(e.message));
  await assert.rejects(bridge(midYear), e => e instanceof ValidationError && /2025-12-31/.test(e.message));
  await assert.rejects(bridge(capital), e => e instanceof ValidationError && /Schedule L/.test(e.message));
  await assert.rejects(bridge(raw), e => e instanceof ValidationError && /verified/.test(e.message), 'an approved bridge of an unreviewed fact');
  // A draft (no approver) of the unreviewed fact is kept; it is approved only after the fact's own review.
  await bridge(raw, null);
  assert.deepEqual((await listBridge(pool, { ...D, returnId: r })).map(x => [x.fact_id, x.approved_by]), [[raw, null]]);
  await assert.rejects(approveBridge(pool, { ...D, returnId: r, factId: raw, approvedBy: 'tester' }), e => e instanceof ValidationError && /verified/.test(e.message));
  await pool.query(`UPDATE baseline_fact SET review_status = 'verified' WHERE fact_id = $1`, [raw]);
  await approveBridge(pool, { ...D, returnId: r, factId: raw, approvedBy: 'second reviewer' });
  await bridge(good);
  assert.deepEqual((await listBridge(pool, { ...D, returnId: r })).map(x => [x.fact_id, x.approved_by]), [[good, 'tester'], [raw, 'second reviewer']]);
  // The fact's review cannot be withdrawn under an approved allocation (two approvals, kept separate, in order).
  await assert.rejects(pool.query(`UPDATE baseline_fact SET review_status = 'raw' WHERE fact_id = $1`, [raw]), /approved opening bridge/);
  // The database refuses the same openings when the module is bypassed.
  const sql = (factId, approvedBy) => pool.query('INSERT INTO opening_bridge (org_id, return_id, fact_id, account_id, allocated_cents, approved_by) VALUES ($1,$2,$3,$4,1,$5)', [D.orgId, r, factId, acct.account_id, approvedBy]);
  await assert.rejects(sql(begin, null), /end-of-period/);
  await assert.rejects(sql(midYear, null), /predecessor's end/);
  await assert.rejects(sql(capital, null), /Schedule L/);
  const { rows: [{ fact_id: rawSql }] } = await pool.query(`INSERT INTO baseline_fact (org_id, baseline_id, payload_version, fact_kind, field_id, measurement, effective_on, amount_cents, state)
    VALUES ($1,$2,1,'schedule_l_end','f1065.L.10a','end','2025-12-31',1,'known') RETURNING fact_id`, [D.orgId, baselineId]);
  await assert.rejects(sql(rawSql, 'reviewer'), /verified/);
  await sql(rawSql, null);
});

// Codex t1-r1 B7: a typed per-interest, per-loan, per-activity or per-asset fact names its subject; one anonymous fact is refused
// even when nothing collides with it.
test('typed per-interest, per-loan, per-activity and per-asset facts need their stable subject keys at import', async () => {
  const one = fact => payload({ importKey: `keys-${fact.factKind}`, facts: [{ measurement: 'end', effectiveOn: '2025-12-31', amountCents: '1', state: 'known', provenance: {}, ...fact }] });
  for (const [fact, re] of [[{ factKind: 'tax_capital' }, /tax_capital: .*interestKey/], [{ factKind: 'outside_basis', amountCents: null, state: 'unknown' }, /outside_basis: .*interestKey/],
    [{ factKind: 'stock_basis' }, /stock_basis: .*interestKey/], [{ factKind: 'debt_basis', interestKey: 'sh-1' }, /debt_basis: .*loanKey/], [{ factKind: 'liability' }, /liability: .*interestKey or loanKey/],
    [{ factKind: 'suspended_loss', interestKey: 'p-1' }, /suspended_loss: .*activityKey/], [{ factKind: 'asset' }, /asset: .*assetKey/], [{ factKind: 'k1_item' }, /k1_item: .*interestKey or partyKey/]]) {
    await assert.rejects(importBaseline(pool, { ...S, payload: one(fact), actor: 'tester' }), e => e instanceof ValidationError && re.test(e.message), JSON.stringify(fact));
  }
  for (const fact of [{ factKind: 'tax_capital', interestKey: 'p-1' }, { factKind: 'debt_basis', interestKey: 'sh-1', loanKey: 'loan-1' }, { factKind: 'liability', loanKey: 'loan-1' },
    { factKind: 'suspended_loss', interestKey: 'p-1', activityKey: 'act-1' }, { factKind: 'asset', assetKey: 'truck-1' }, { factKind: 'aaa' }]) {
    assert.equal((await importBaseline(pool, { ...S, payload: one(fact), actor: 'tester' })).created, true, JSON.stringify(fact));
  }
});

// Codex t1-r1 B11: a filed return's statement rows keep their own identity (rowKey), and a filed figure with no supported
// catalog field keeps an explicit historical id instead of being forced onto an unrelated line or left anonymous.
test('statement rows are separate facts by rowKey; historical ids are accepted for filed imports only; other unknown ids are refused', async () => {
  const row = (rowKey, cents) => ({ factKind: 'form_line', fieldId: 'f1065.k.20c', rowKey, measurement: 'activity', effectiveOn: '2025-12-31', amountCents: cents, state: 'known', provenance: {}, reviewStatus: 'verified' });
  const hist = { factKind: 'form_line', fieldId: 'hist.f1065.item_f_total_assets', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '99900', state: 'known', provenance: {}, reviewStatus: 'verified' };
  const p = payload({ importKey: 'filed-2025-rows', facts: [row('gross-receipts-448c', '1000'), row('business-interest-expense', '2000'), hist] });
  const r = await importBaseline(pool, { ...B, payload: p, actor: 'tester' });
  const facts = await baselineFacts(pool, { ...B, baselineId: r.baselineId });
  assert.deepEqual(facts.filter(f => f.field_id === 'f1065.k.20c').map(f => f.row_key).sort(), ['business-interest-expense', 'gross-receipts-448c']);
  assert.ok(facts.some(f => f.field_id === 'hist.f1065.item_f_total_assets'));
  assert.equal((await importBaseline(pool, { ...B, payload: p, actor: 'tester' })).created, false, 'the same rows import once');
  await assert.rejects(importBaseline(pool, { ...B, payload: payload({ importKey: 'filed-2025-dup', facts: [row('same', '1'), row('same', '2')] }), actor: 'tester' }), /same identity/);
  await assert.rejects(importBaseline(pool, { ...B, payload: payload({ importKey: 'filed-2025-bad', facts: [{ ...hist, fieldId: 'f1065.p1.F' }] }), actor: 'tester' }), /Unknown catalog id f1065.p1.F/);
});

// Codex t1-r2 N1: a corrected payload keeps the filed import's historical figures and statement rows; v1 stays as it was.
test('a corrected baseline keeps historical figures and statement rows; reimporting it changes nothing; v1 is untouched', async () => {
  const C = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Corrected Ranch', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...C, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  const hist = (cents) => ({ factKind: 'form_line', fieldId: 'hist.f1065.item_f_total_assets', measurement: 'end', effectiveOn: '2025-12-31', amountCents: cents, state: 'known', provenance: {}, reviewStatus: 'verified' });
  const row = (rowKey, cents) => ({ factKind: 'form_line', fieldId: 'f1065.k.20c', rowKey, measurement: 'activity', effectiveOn: '2025-12-31', amountCents: cents, state: 'known', provenance: {}, reviewStatus: 'verified' });
  const v1 = await importBaseline(pool, { ...C, payload: payload({ importKey: 'filed-2025-corr', facts: [hist('500000'), row('a', '100'), row('b', '200')] }), actor: 'tester' });
  const v2payload = payload({ importKey: 'filed-2025-corr', payloadVersion: 2, kind: 'corrected', supersedesBaselineId: v1.baselineId, facts: [hist('510000'), row('a', '100'), row('b', '250')] });
  const v2 = await importBaseline(pool, { ...C, payload: v2payload, actor: 'tester' });
  assert.equal(v2.created, true);
  assert.equal((await importBaseline(pool, { ...C, payload: v2payload, actor: 'tester' })).created, false, 'the corrected payload imports once');
  const amounts = async id => Object.fromEntries((await baselineFacts(pool, { ...C, baselineId: id })).map(f => [`${f.field_id}|${f.row_key ?? ''}`, String(f.amount_cents)]));
  assert.deepEqual(await amounts(v1.baselineId), { 'hist.f1065.item_f_total_assets|': '500000', 'f1065.k.20c|a': '100', 'f1065.k.20c|b': '200' });
  assert.deepEqual(await amounts(v2.baselineId), { 'hist.f1065.item_f_total_assets|': '510000', 'f1065.k.20c|a': '100', 'f1065.k.20c|b': '250' });
  await assert.rejects(importBaseline(pool, { ...C, payload: payload({ importKey: 'own-final', kind: 'final_revision', facts: [hist('1')] }), actor: 'tester' }), /historical ids are for filed returns/);
});
