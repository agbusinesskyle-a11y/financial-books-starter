// test/tax-coverage.test.js — coverage over gross activity and nonzero balances, own, included and nested books; routing versus authority;
// live rechecks of transactions, activities and references; unknown never zero; one end-to-end path from a binding to a T1 packet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, lineOf, period, activity, include, party } from './tax-t2-fixtures.js';
import { saveBindings, attributeLine, removeAttribution, listAttributions } from '../lib/tax/bindings.js';
import { coverage, destinationTotals, needsOf, allocationOwners } from '../lib/tax/coverage.js';
import { provePartition, toPacketParts, buildPartition } from '../lib/tax/partition.js';
import { slotAuthority, roleOf } from '../lib/tax/authority.js';
import { assignProvider, assignPacket, substituteProvider, substituteProviders, validatePacket, aggregate, collectionKey } from '../lib/tax/providers.js';
import { approvedOf, currentPartition } from '../lib/tax/manifest.js';
import { measureLines } from '../lib/tax/measure.js';
import { deleteLedgerTxn } from '../lib/data/ledger-tools.js';
import { saveActivity } from '../lib/tax/activities.js';
import { saveProfile, openPeriod } from '../lib/tax/periods.js';
import { catalogFor } from '../lib/tax/catalog/index.js';

let t, pool, orgId, C, ret, A, wagesTxn;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  C = { orgId, entityId: await company(pool, orgId, 'Cedar Partners') };
  ret = await period(pool, C, 2025, 'form_1065', { taxMethod: 'accrual' });
  A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Other Expenses', 'Loan Payable', 'Retained Earnings', 'Rent & Lease', 'Depreciation']) A[n] = await acct(pool, C, n);
  A.Clearing = await acct(pool, C, 'Payroll Clearing', 'other_current_asset');
  await je(pool, C, '2024-06-01', [[A.Checking, 100000], [A.Services, -100000]]);
  await je(pool, C, '2024-07-01', [[A.Checking, 50000], [A['Loan Payable'], -50000]]);
  wagesTxn = await je(pool, C, '2025-03-01', [[A.Wages, 30000], [A.Checking, -30000]]);
  await je(pool, C, '2025-03-05', [[A.Clearing, 5000], [A.Checking, -5000]]);
  await je(pool, C, '2025-03-06', [[A.Checking, 5000], [A.Clearing, -5000]]);
  await je(pool, C, '2025-04-01', [[A['Other Expenses'], 4000], [A.Checking, -4000]]);
  await je(pool, C, '2025-04-09', [[A.Checking, 4000], [A['Other Expenses'], -4000]]);
});
after(async () => { await t.db.drop(); });

const cov = (canOpen = () => true, resolvers = undefined) => coverage(pool, { ...C, returnId: ret, canOpen, ...(resolvers ? { resolvers } : {}) });
const accountOf = (c, id) => c.sources[0].accounts.find(a => a.accountId === id);
const bind = (accountId, measurement, rows, extra = {}) => saveBindings(pool, { ...C, returnId: ret, sourceEntityId: C.entityId, accountId, measurement, rows, actor: 'tester', ...extra });

test('coverage takes every account with a nonzero balance or ANY activity — gross; a zero-balance clearing account needs its activity disposed of', async () => {
  const c = await cov();
  const want = { Checking: ['begin', 'end'], Wages: ['activity'], 'Other Expenses': ['activity'], Clearing: ['activity'], 'Loan Payable': ['begin', 'end'], 'Retained Earnings': ['begin', 'end'] };
  for (const [name, needs] of Object.entries(want)) {
    const a = accountOf(c, A[name]);
    assert.ok(a, `${name} is in coverage`);
    assert.deepEqual(a.needs, needs, name);
    assert.equal(a.status, 'uncovered', name);
  }
  assert.equal(accountOf(c, A['Other Expenses']).activity, 0n, 'it nets to zero');
  assert.equal(accountOf(c, A.Services), undefined, 'last year’s income account with nothing this year is out of scope');
  assert.deepEqual([c.totals.accounts, c.totals.uncovered, c.totals.blocking, c.totals.complete], [6, 6, 6, 0]);
  // A zero ending balance is not a disposition of what passed through the clearing account.
  await bind(A.Clearing, 'end', [{ treatment: 'statement_row', destination: 'f1065.L.6' }]);
  assert.equal(accountOf(await cov(), A.Clearing).status, 'uncovered');
});

test('bound everywhere it is needed, the return is covered; the accrual books are authoritative and every amount is exact', async () => {
  await bind(A.Checking, 'begin', [{ treatment: 'input', destination: 'f1065.L.1' }]);
  await bind(A.Checking, 'end', [{ treatment: 'input', destination: 'f1065.L.1' }]);
  await bind(A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  await bind(A['Other Expenses'], 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  await bind(A.Clearing, 'activity', [{ treatment: 'not_tax', memo: 'Payroll clearing: wages are bound on the wages account' }]);
  for (const m of ['begin', 'end']) {
    await bind(A['Loan Payable'], m, [{ treatment: 'input', destination: 'f1065.L.19b' }]);
    await bind(A['Retained Earnings'], m, [{ treatment: 'input', destination: 'f1065.L.21' }]);
  }
  const c = await cov();
  assert.deepEqual([c.totals.complete, c.totals.blocking], [6, 0]);
  const { authoritative, complete } = destinationTotals(c);
  assert.equal(complete, true);
  assert.equal(authoritative.get('f1065.p1.9|activity').cents, 30000n);
  assert.equal(authoritative.get('f1065.L.1|begin').cents, 150000n);
  assert.equal(authoritative.get('f1065.L.1|end').cents, 120000n);
  assert.equal(authoritative.get('f1065.L.21|begin').cents, -100000n, 'a credit balance stays as the books hold it; the sign facts apply in T3');
  assert.deepEqual(authoritative.get('f1065.p1.21|activity').members.map(m => m.rowLabel), ['Other Expenses'], 'statement rows keep their source');
});

test('routing is not authority (B1): a manual comparison, a COGS input, a reviewed manual replacement and competing providers', async () => {
  await bind(A.Depreciation, 'activity', [{ treatment: 'manual_feed', destination: 'f1065.p1.16a' }]);
  await je(pool, C, '2025-05-01', [[A.Depreciation, 2000], [A.Checking, -2000]]);
  const trade = await activity(pool, C, { name: 'Cedar trade' });
  A.Purchases = await acct(pool, C, 'Feed Purchases', 'cost_of_goods_sold');
  await je(pool, C, '2025-05-02', [[A.Purchases, 8000], [A.Checking, -8000]]);
  await bind(A.Purchases, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: trade }]);
  await je(pool, C, '2025-06-01', [[A['Rent & Lease'], 120000], [A.Checking, -120000]]);
  await bind(A['Rent & Lease'], 'activity', [{ treatment: 'input', destination: 'f1065.p1.13' }]);
  let totals = destinationTotals(await cov());
  assert.equal(totals.authoritative.get('f1065.p1.16a|activity'), undefined, 'a book figure shown beside a typed item is never the tax amount');
  assert.equal(totals.comparisons.get('f1065.p1.16a|activity').cents, 2000n);
  assert.equal(totals.inputs.get('cogs_workpaper').get(`f1125a.main.2|activity=act:${trade}|activity`).cents, 8000n);
  assert.equal(totals.authoritative.get('f1065.p1.13|activity').cents, 120000n);
  // A reviewed manual value takes the rent line (T1 assignProvider, audited): the routing stays and becomes comparison evidence.
  await assignProvider(pool, { ...C, returnId: ret, slotKey: 'f1065.p1.13|activity', providerKind: 'manual', schemaVersion: 1, sourceVersion: 'manual:rent@v1' });
  totals = destinationTotals(await cov());
  assert.equal(totals.authoritative.get('f1065.p1.13|activity'), undefined);
  assert.equal(totals.comparisons.get('f1065.p1.13|activity').cents, 120000n);
  await assert.rejects(assignProvider(pool, { ...C, returnId: ret, slotKey: 'f1065.p1.13|activity', providerKind: 'cash_layer', schemaVersion: 1, sourceVersion: 'cash:1@v1' }), /already has a provider/);
  // The same routing on a cash-method return is the cash layer's input, not a books amount; one owner per slot.
  const line = catalogFor('form_1065', 2025).byId.get('f1065.p1.9');
  const cash = slotAuthority(line, { taxMethod: 'cash' }).authority;
  assert.deepEqual([cash, roleOf({ treatment: 'input', authority: cash }).role], ['cash_layer', 'input']);
  const L1 = catalogFor('form_1065', 2025).byId.get('f1065.L.1');
  assert.deepEqual(slotAuthority(L1, { taxMethod: 'accrual', anyCash: true }), { authority: 'cash_layer', problem: null }, 'a slot a cash-basis source feeds is the cash layer’s as a whole');
  assert.match(slotAuthority(L1, { taxMethod: 'accrual', assignment: 'books', anyCash: true }).problem, /assign it to the cash layer/);
});

test('unknown is never zero: a pending owner row nulls only the slots it feeds; independent slots keep their totals', async () => {
  const partner = await party(pool, orgId, 'Robin Sample Partner');
  await bind(A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9', share: '1/2' }, { treatment: 'guaranteed_payment', destination: 'services', interestPartyId: partner, share: '1/2' }], { split: 'shares' });
  const c = await cov();
  assert.equal(accountOf(c, A.Wages).status, 'unresolved');
  const { authoritative, complete } = destinationTotals(c);
  assert.equal(authoritative.get('f1065.p1.9|activity').cents, null, 'never the known half read as the total');
  assert.equal(authoritative.get('f1065.L.1|end').cents, 120000n - 2000n - 8000n - 120000n, 'an independent schedule can still be drafted');
  assert.equal(complete, false);
  await bind(A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
});

test('a dollar split goes stale when its account changes; a same-cents transaction change makes a line attribution stale (B5)', async () => {
  await bind(A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9', amount: '200.00' }, { treatment: 'statement_row', destination: 'f1065.p1.21', amount: '100.00' }], { split: 'amounts' });
  assert.equal(accountOf(await cov(), A.Wages).status, 'complete');
  await je(pool, C, '2025-03-01', [[A.Wages, 35000], [A.Checking, -35000]], { txnId: wagesTxn });
  let a = accountOf(await cov(), A.Wages);
  assert.equal(a.status, 'stale');
  assert.match(a.results.activity.reasons.join(' '), /dollar split/);
  await bind(A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  // Attribute the wages line, then change only the transaction's memo: the cents are the same, the decision is stale.
  const lines = (await measureLines(pool, { orgId, sourceEntityId: C.entityId, accountIds: [A.Wages], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(A.Wages);
  await attributeLine(pool, { ...C, returnId: ret, sourceEntityId: C.entityId, accountId: A.Wages, txnId: wagesTxn, lineNo: lines[0].lineNo, expectTxnVersion: lines[0].txnVersion, target: { treatment: 'input', destination: 'f1065.p1.9' }, actor: 'tester' });
  assert.equal(accountOf(await cov(), A.Wages).status, 'complete');
  await je(pool, C, '2025-03-01', [[A.Wages, 35000], [A.Checking, -35000]], { txnId: wagesTxn, memo: 'Memo edited, same cents' });
  a = accountOf(await cov(), A.Wages);
  assert.equal(a.status, 'stale');
  assert.match(a.results.activity.reasons.join(' '), /transaction of line .* changed/);
  await pool.query('DELETE FROM tax_binding_line WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
});

test('line attributions and the account binding consume every posting line once; the proof holds and the partition travels to a valid T1 packet', async () => {
  const rent = A['Rent & Lease'];
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
  const june = (await pool.query(`SELECT txn_id FROM posting WHERE account_id = $1 ORDER BY txn_date LIMIT 1`, [rent])).rows[0].txn_id;
  await je(pool, C, '2025-07-01', [[rent, 80000], [A.Checking, -80000]]);
  const lines = (await measureLines(pool, { orgId, sourceEntityId: C.entityId, accountIds: [rent], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(rent);
  await attributeLine(pool, { ...C, returnId: ret, sourceEntityId: C.entityId, accountId: rent, txnId: june, lineNo: await lineOf(pool, june, rent), expectTxnVersion: lines[0].txnVersion, target: { treatment: 'input', destination: 'f1065.p1.13' }, actor: 'tester' });
  await bind(rent, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  const c = await cov();
  const a = accountOf(c, rent);
  assert.equal(a.status, 'complete');
  // The proof, against what measureAccounts and measureLines say on their own.
  assert.equal(provePartition(a.results.activity, { measured: { cents: a.activity, version: a.versions.activity, lineGroups: a.lineGroups }, lines }), true);
  assert.deepEqual(a.results.activity.allocations.map(x => [x.kind, x.cents]), [['line', 120000n], ['binding', 80000n]]);
  // The books packet T3 will build: T1-valid, the partition's slices consumed once, the same amounts.
  const measuredRent = { cents: a.activity, version: a.versions.activity, lineGroups: a.lineGroups };
  const owners = allocationOwners(c);
  const ownerOf = x => owners.get(`${C.entityId}/${rent}/activity/${x.kind}:${x.id}`);
  assert.deepEqual(a.results.activity.allocations.map(ownerOf), ['books', 'books']);
  const approvedNow = () => approvedOf(pool, { orgId, returnId: ret, sourceEntityId: C.entityId, accountId: rent, measurement: 'activity' });
  const parts = toPacketParts(a.results.activity, { provider: 'books', ownerOf, measured: measuredRent, lines, approved: await approvedNow() });
  const packet = { providerKind: 'books', schemaVersion: 1, sourceVersion: 'books@t2-test', sourceRefs: parts.sourceRefs, completeness: 'complete', review: { state: 'unreviewed' },
    values: [{ slotKey: 'f1065.p1.13|activity', amountCents: '120000' }, { slotKey: 'f1065.p1.21|activity', statementRows: [{ label: 'Rent & Lease', amountCents: '80000' }] }],
    relatedOutputs: [], consumedSlices: parts.consumedSlices };
  assert.deepEqual(validatePacket(packet, { returnType: 'form_1065', edition: 2025 }), []);
  assert.equal(aggregate([packet], { returnType: 'form_1065', edition: 2025 }).get('f1065.p1.13|activity').cents, 120000n);
  const { authoritative } = destinationTotals(c);
  assert.equal(authoritative.get('f1065.p1.13|activity').cents, 120000n);
  assert.equal(authoritative.get('f1065.p1.21|activity').cents, 80000n, 'July rent plus Other Expenses, which nets to zero');
  // The boundary (Codex r2 B2): the packet goes live through T1; a packet from ANOTHER mapping of the same source — the residual re-saved,
  // unchanged postings, a new binding id — is refused by T1 itself, however different its slice ids.
  const request = slots => ({ returnId: ret, revisionContext: 'working', slots, period: { start: '2025-01-01', end: '2025-12-31' }, method: 'accrual', bookBasis: 'accrual' });
  // Published slot by slot: the p1.13 packet consumes the attributed line routed there, not the residual routed to p1.21 (Codex t2-r1 B2).
  await assignPacket(pool, { ...C, returnId: ret, request: request(['f1065.p1.13|activity']), packet: { ...packet, values: [packet.values[0]], consumedSlices: packet.consumedSlices.filter(s => s.txn !== 'rest') } });
  await bind(rent, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: 'Rent, re-saved' }]);
  const again = accountOf(await cov(), rent);
  assert.throws(() => toPacketParts(a.results.activity, { provider: 'books', ownerOf, measured: measuredRent, lines, approved: null }), /approved mapping/);
  const reParts = toPacketParts(again.results.activity, { provider: 'books', ownerOf: () => 'books', measured: measuredRent, lines, approved: await approvedNow() });
  assert.notEqual(reParts.sourceRefs[0].version, parts.sourceRefs[0].version);
  const later = { ...packet, sourceVersion: 'books@t2-test-2', sourceRefs: reParts.sourceRefs, values: [packet.values[1]], consumedSlices: reParts.consumedSlices.filter(s => s.txn === 'rest') };
  await assert.rejects(assignPacket(pool, { ...C, returnId: ret, request: request(['f1065.p1.21|activity']), packet: later }), /earlier mapping/);
  // A reviewed manual value replaces the books packet through T1's audited substitution; the routing stays, now comparison evidence (r2 hardening 4).
  const manual = { providerKind: 'manual', schemaVersion: 1, sourceVersion: 'manual:rent@v2', sourceRefs: [{ kind: 'manual', id: 'rent', version: 'v2' }], completeness: 'complete',
    review: { state: 'reviewed', by: 'tester' }, values: [{ slotKey: 'f1065.p1.13|activity', amountCents: '119000' }], relatedOutputs: [], consumedSlices: [] };
  const ck = collectionKey('f1065.p1.13|activity', { returnType: 'form_1065', edition: 2025 });
  await substituteProvider(pool, { ...C, returnId: ret, from: { providerKind: 'books', sourceVersion: 'books@t2-test' }, retire: ['f1065.p1.13|activity'], request: request(['f1065.p1.13|activity']),
    packet: manual, reviewedBy: 'tester', reconciliation: { collections: [{ collectionKey: ck, oldCents: '120000', newCents: '119000', reason: 'Reviewed lease schedule' }], relatedOutputs: [] } });
  const after = destinationTotals(await cov());
  assert.equal(after.authoritative.get('f1065.p1.13|activity'), undefined);
  assert.equal(after.comparisons.get('f1065.p1.13|activity').cents, 120000n);
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
});

test('live rechecks (B5): an activity that ends, or a K-1 selection that changes, turns a saved mapping unresolved', async () => {
  const rental = await activity(pool, C, { name: 'Cedar rental', kind: 'rental', schedule: 'f8825', from: '2020-01-01' });
  A.Rents = await acct(pool, C, 'Rents Received', 'income');
  await je(pool, C, '2025-08-01', [[A.Checking, 9000], [A.Rents, -9000]]);
  await bind(A.Rents, 'activity', [{ treatment: 'input', destination: 'f8825.main.2a', activityId: rental }]);
  assert.equal(accountOf(await cov(), A.Rents).status, 'complete');
  await saveActivity(pool, { ...C, activityId: rental, fields: { kind: 'rental', name: 'Cedar rental', schedule: 'f8825', from: '2020-01-01', to: '2024-12-31', disposedOn: '' } });
  const a = accountOf(await cov(), A.Rents);
  assert.equal(a.status, 'unresolved');
  assert.match(a.results.activity.reasons.join(' '), /not in effect in this period any more/);
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND account_id = $2', [orgId, A.Rents]);
  await pool.query(`UPDATE tax_activity SET effective_to = NULL WHERE org_id = $1 AND activity_id = $2`, [orgId, rental]);
  // A K-1 booked account: saved while the resolver selected record 7 version 1; coverage asks again and gets version 2.
  const payer = await party(pool, orgId, 'Outside Cedar Partnership', 'entity_outside');
  A.K1 = await acct(pool, C, 'Partnership Income', 'other_income');
  await je(pool, C, '2025-09-01', [[A.Checking, 5000], [A.K1, -5000]]);
  const v1 = { interest: async () => ({ status: 'pending', reason: 'none' }), k1: async () => ({ status: 'selected', id: 7, version: 'k1-7@1' }) };
  await bind(A.K1, 'activity', [{ treatment: 'k1_booked', k1IssuerPartyId: payer }], { resolvers: v1 });
  assert.equal(accountOf(await cov(undefined, v1), A.K1).status, 'complete');
  const v2 = { ...v1, k1: async () => ({ status: 'selected', id: 7, version: 'k1-7@2-corrected' }) };
  assert.match(accountOf(await cov(undefined, v2), A.K1).results.activity.reasons.join(' '), /K-1 record selected for this period changed/);
  assert.equal(accountOf(await cov(), A.K1).status, 'unresolved', 'with T2’s own resolvers nothing is selected: pending');
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND account_id = $2', [orgId, A.K1]);
});

test('included and nested books (B4): a two-level chain is covered; a hidden company anywhere on the path blocks without being read; a part-year path blocks', async () => {
  const K = { orgId, entityId: await company(pool, orgId, 'Cedar Child LLC') };
  const G = { orgId, entityId: await company(pool, orgId, 'Cedar Grandchild LLC') };
  const kRet = await period(pool, K, 2025, 'disregarded');
  await period(pool, G, 2025, 'disregarded');
  const act = await activity(pool, C, { name: 'Cedar trade, child' });
  const kAct = await activity(pool, K, { name: 'Child trade' });
  await include(pool, K, kRet, kAct, G.entityId);
  await include(pool, C, ret, act, K.entityId);
  for (const S of [K, G]) {
    const bank = await acct(pool, S, 'Checking'), sales = await acct(pool, S, 'Services');
    await je(pool, S, '2025-05-01', [[bank, 25000], [sales, -25000]]);
  }
  let c = await cov();
  const child = c.sources.find(s => s.entityId === K.entityId), grand = c.sources.find(s => s.entityId === G.entityId);
  assert.deepEqual([child.own, child.path.length, child.activityName], [false, 1, 'Cedar trade, child']);
  assert.deepEqual([grand.path.length, grand.activityName, grand.status], [2, 'Cedar trade, child', 'measured'], 'the grandchild joins the top activity');
  assert.deepEqual(grand.accounts.map(a => a.name).sort(), ['Checking', 'Services']);
  // The grandchild's books bind on the parent return, through the whole path.
  const gSales = (await pool.query(`SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = 'Services'`, [orgId, G.entityId])).rows[0].account_id;
  await saveBindings(pool, { ...C, returnId: ret, sourceEntityId: G.entityId, accountId: gSales, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.1a' }], actor: 'tester' });
  c = await cov();
  assert.equal(c.sources.find(s => s.entityId === G.entityId).accounts.find(a => a.accountId === Number(gSales)).status, 'complete');
  // Hidden grandchild; hidden middle company: blocked, not measured.
  for (const hiddenId of [G.entityId, K.entityId]) {
    c = await cov(id => id !== hiddenId);
    const g = c.sources.find(s => s.entityId === G.entityId);
    assert.deepEqual([g.status, g.accounts.length], ['hidden', 0], `hidden ${hiddenId}`);
    assert.ok(c.totals.hidden >= 1 && destinationTotals(c).complete === false);
  }
  // A child whose first period starts mid-year includes its own child for that part year only: the grandchild cannot be combined yet.
  const K2 = { orgId, entityId: await company(pool, orgId, 'Cedar Startup LLC') };
  const G2 = { orgId, entityId: await company(pool, orgId, 'Cedar Startup Sub LLC') };
  await saveProfile(pool, { ...K2, fields: { returnType: 'disregarded', activityKind: 'trade', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-04-01' }, reason: 'setup', actor: 'tester' });
  const k2Ret = Number(await openPeriod(pool, { ...K2, year: 2025, initial: true, periodStart: '2025-04-01', actor: 'tester' }));
  await saveProfile(pool, { ...G2, fields: { returnType: 'disregarded', activityKind: 'trade', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  await openPeriod(pool, { ...G2, year: 2025, actor: 'tester' });
  await include(pool, K2, k2Ret, await activity(pool, K2, { name: 'Startup trade', from: '2025-04-01' }), G2.entityId);
  await include(pool, C, ret, await activity(pool, C, { name: 'Cedar startup trade' }), K2.entityId);
  c = await cov();
  assert.equal(c.sources.find(s => s.entityId === G2.entityId).status, 'blocked');
  assert.ok(c.totals.blocked >= 1);
});

test('each source keeps its own book basis (B3): an accrual parent with a cash-basis child, a cash parent with an accrual child', async () => {
  const P2 = { orgId, entityId: await company(pool, orgId, 'Basis Parent Partners') };
  const p2Ret = await period(pool, P2, 2025, 'form_1065', { taxMethod: 'accrual', bookBasis: 'accrual' });
  const K3 = { orgId, entityId: await company(pool, orgId, 'Basis Child LLC') };
  await period(pool, K3, 2025, 'disregarded', { bookBasis: 'cash' });
  await include(pool, P2, p2Ret, await activity(pool, P2, { name: 'Basis trade' }), K3.entityId);
  const c = await coverage(pool, { ...P2, returnId: p2Ret });
  const own = c.sources[0], child = c.sources.find(s => s.entityId === K3.entityId);
  assert.deepEqual([own.cashSensitive, child.bookBasis, child.cashSensitive, child.recognition], [false, 'cash', true, 'cash_layer']);
  const P3 = { orgId, entityId: await company(pool, orgId, 'Cash Parent Partners') };
  const p3Ret = await period(pool, P3, 2025, 'form_1065', { taxMethod: 'cash', bookBasis: 'accrual' });
  const K4 = { orgId, entityId: await company(pool, orgId, 'Accrual Child LLC') };
  await period(pool, K4, 2025, 'disregarded', { bookBasis: 'accrual' });
  await include(pool, P3, p3Ret, await activity(pool, P3, { name: 'Cash trade' }), K4.entityId);
  const c3 = await coverage(pool, { ...P3, returnId: p3Ret });
  assert.deepEqual(c3.sources.map(s => s.cashSensitive), [true, true], 'a cash-method return recognizes every source by cash');
  assert.ok(c3.totals.recognitionPending >= 2);
});

test('needsOf: a cash-touched account is in scope on a cash-sensitive source only; an equity account that moved needs its activity', () => {
  const m = { type: 'income', postings: 0, begin: 0n, end: 0n, cashTouched: true };
  assert.deepEqual(needsOf(m, { cashSensitive: true }), ['activity']);
  assert.deepEqual(needsOf(m, { cashSensitive: false }), []);
  assert.deepEqual(needsOf({ type: 'equity', postings: 3, begin: 0n, end: 500n, cashTouched: false }, { cashSensitive: false }), ['end', 'activity']);
  assert.deepEqual(needsOf({ type: 'other_current_asset', postings: 2, begin: 0n, end: 0n, cashTouched: false }, { cashSensitive: false }), ['activity']);
});

test('owner items become mapped once their references resolve (Codex r2 N1): an equity event and a guaranteed payment, account and line forms', async () => {
  const partner = await party(pool, orgId, 'Robin Resolved Partner');
  // The partner's interest is on file for the whole year (ownership_interest); T2's own resolver selects it.
  await pool.query(`INSERT INTO ownership_interest (org_id, entity_id, party_id, role, effective_from, profit_num, profit_den, loss_num, loss_den, capital_num, capital_den, created_by)
    VALUES ($1,$2,$3,'general_partner','2020-01-01',1,2,1,2,1,2,'tester')`, [orgId, C.entityId, partner]);
  const selected = undefined;
  A.Draws = await acct(pool, C, 'Partner Draws', 'equity');
  await je(pool, C, '2025-10-01', [[A.Draws, 6000], [A.Checking, -6000]]);
  for (const m of ['end', 'activity']) {
    await bind(A.Draws, m, m === 'end' ? [{ treatment: 'input', destination: 'f1065.L.21' }] : [{ treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: partner }], { resolvers: selected });
  }
  A.Fees = await acct(pool, C, 'Partner Fees', 'expense');
  const feeTxn = await je(pool, C, '2025-10-02', [[A.Fees, 3000], [A.Checking, -3000]]);
  await je(pool, C, '2025-10-03', [[A.Fees, 1000], [A.Checking, -1000]]);
  const fl = (await measureLines(pool, { orgId, sourceEntityId: C.entityId, accountIds: [A.Fees], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(A.Fees);
  const first = fl.find(l => l.txnId === Number(feeTxn));
  await attributeLine(pool, { ...C, returnId: ret, sourceEntityId: C.entityId, accountId: A.Fees, txnId: feeTxn, lineNo: first.lineNo, expectTxnVersion: first.txnVersion,
    target: { treatment: 'guaranteed_payment', destination: 'services', interestPartyId: partner }, actor: 'tester', resolvers: selected });
  await bind(A.Fees, 'activity', [{ treatment: 'guaranteed_payment', destination: 'capital', interestPartyId: partner }], { resolvers: selected });
  const c = await cov(undefined, selected);
  assert.equal(accountOf(c, A.Draws).status, 'complete', accountOf(c, A.Draws).results.activity.reasons.join(' '));
  assert.equal(accountOf(c, A.Fees).status, 'complete', accountOf(c, A.Fees).results.activity.reasons.join(' '));
  // Once the interest ends before the year, they wait — with the CURRENT reason, never a stale one.
  await pool.query(`UPDATE ownership_interest SET effective_to = '2024-12-31' WHERE org_id = $1 AND party_id = $2`, [orgId, partner]);
  assert.match(accountOf(await cov(), A.Fees).results.activity.reasons.join(' '), /not on file yet/);
  for (const id of [A.Draws, A.Fees]) await pool.query('DELETE FROM tax_binding_line WHERE org_id = $1 AND account_id = $2', [orgId, id]);
  for (const id of [A.Draws, A.Fees]) await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND account_id = $2', [orgId, id]);
});

test('an account emptied of its only line keeps its orphan attribution visible and stale (Codex r2 N2, B8): deleted, or moved to another account', async () => {
  for (const how of ['deleted', 'moved']) {
    const id = await acct(pool, C, `Sole Line ${how}`, 'expense');
    const txn = await je(pool, C, '2025-11-01', [[id, 2500], [A.Checking, -2500]]);
    const [l] = (await measureLines(pool, { orgId, sourceEntityId: C.entityId, accountIds: [id], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(id);
    await attributeLine(pool, { ...C, returnId: ret, sourceEntityId: C.entityId, accountId: id, txnId: txn, lineNo: l.lineNo, expectTxnVersion: l.txnVersion, target: { treatment: 'input', destination: 'f1065.p1.11' }, actor: 'tester' });
    if (how === 'deleted') await deleteLedgerTxn(pool, { ...C, txnId: txn, actor: 'tester' });
    else await je(pool, C, '2025-11-01', [[A['Other Expenses'], 2500], [A.Checking, -2500]], { txnId: txn });
    const a = accountOf(await cov(), id);
    assert.ok(a, `${how}: the account is still listed because a mapping names it`);
    assert.equal(a.status, 'stale', how);
    assert.deepEqual(a.lines, [], `${how}: a known empty line set`);
    assert.equal(a.attributions.length, 1, `${how}: the orphan is listed`);
    assert.equal(destinationTotals(await cov()).authoritative.get('f1065.p1.11|activity')?.cents ?? null, null, `${how}: its slot has no total`);
    await removeAttribution(pool, { ...C, returnId: ret, sourceEntityId: C.entityId, bindingLineId: a.attributions[0].binding_line_id });
    assert.equal(accountOf(await cov(), id), undefined, `${how}: once removed, the empty account is out of scope`);
  }
});

test('mixed basis (Codex r2 B1): an accrual parent and its cash-basis child on one Schedule L line have ONE owner, the cash layer, through to the packets', async () => {
  const P = { orgId, entityId: await company(pool, orgId, 'Mixed Basis Partners') };
  const pRet = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual', bookBasis: 'accrual' });
  const K = { orgId, entityId: await company(pool, orgId, 'Mixed Basis Child LLC') };
  await period(pool, K, 2025, 'disregarded', { bookBasis: 'cash' });
  await include(pool, P, pRet, await activity(pool, P, { name: 'Mixed trade' }), K.entityId);
  const pBank = await acct(pool, P, 'Checking'), pSales = await acct(pool, P, 'Services'), kBank = await acct(pool, K, 'Checking'), kSales = await acct(pool, K, 'Services');
  await je(pool, P, '2025-02-01', [[pBank, 70000], [pSales, -70000]]);
  await je(pool, K, '2025-02-01', [[kBank, 30000], [kSales, -30000]]);
  for (const [src, id] of [[P.entityId, pBank], [K.entityId, kBank]]) {
    await saveBindings(pool, { ...P, returnId: pRet, sourceEntityId: src, accountId: id, measurement: 'end', rows: [{ treatment: 'input', destination: 'f1065.L.1' }], actor: 'tester' });
  }
  const c = await coverage(pool, { ...P, returnId: pRet });
  const t = destinationTotals(c);
  assert.equal(t.authoritative.get('f1065.L.1|end'), undefined, 'no books subtotal beside a cash-layer input');
  const slot = t.inputs.get('cash_layer').get('f1065.L.1|end');
  assert.deepEqual([slot.cents, slot.members.map(m => m.sourceEntityId).sort()], [100000n, [P.entityId, K.entityId].sort()]);
  // Through to packets: both partitions' portions belong to the cash layer; the books packet gets none of them.
  const owners = allocationOwners(c);
  for (const [s, id] of [[P.entityId, pBank], [K.entityId, kBank]]) {
    const src = c.sources.find(x => x.entityId === s), a = src.accounts.find(x => x.accountId === id), p = a.results.end;
    const ownerOf = x => owners.get(`${s}/${id}/end/${x.kind}:${x.id}`);
    const measured = { cents: a.end, version: a.versions.end };
    const approved = await approvedOf(pool, { orgId, returnId: pRet, sourceEntityId: s, accountId: id, measurement: 'end' });
    assert.equal(toPacketParts(p, { provider: 'books', ownerOf, measured, approved }).consumedSlices.length, 0);
    assert.equal(toPacketParts(p, { provider: 'cash_layer', ownerOf, measured, approved }).cents, s === P.entityId ? 70000n : 30000n);
  }
  // The child hidden from this viewer (Codex r3 B1): the slot does NOT become a 70,000-cent books amount — it has no owner and no total,
  // and nothing of the parent's visible portion exports.
  const hiddenCov = await coverage(pool, { ...P, returnId: pRet, canOpen: id => id !== K.entityId });
  const th = destinationTotals(hiddenCov);
  assert.match(th.problems.get('f1065.L.1|end'), /cannot be read here/);
  assert.equal(th.authoritative.get('f1065.L.1|end').cents, null);
  assert.equal(th.inputs.get('cash_layer'), undefined);
  const hOwners = allocationOwners(hiddenCov);
  const own = hiddenCov.sources[0].accounts.find(x => x.accountId === pBank);
  const hOwnerOf = x => hOwners.get(`${P.entityId}/${pBank}/end/${x.kind}:${x.id}`);
  const ap = await approvedOf(pool, { orgId, returnId: pRet, sourceEntityId: P.entityId, accountId: pBank, measurement: 'end' });
  for (const provider of ['books', 'cash_layer']) {
    assert.equal(toPacketParts(own.results.end, { provider, ownerOf: hOwnerOf, measured: { cents: own.end, version: own.versions.end }, approved: ap }).consumedSlices.length, 0, provider);
  }
  // An assignment of that slot to the books is a mismatch: no total anywhere, the return not complete.
  await assignProvider(pool, { ...P, returnId: pRet, slotKey: 'f1065.L.1|end', providerKind: 'books', schemaVersion: 1, sourceVersion: 'books@mixed' });
  const t2 = destinationTotals(await coverage(pool, { ...P, returnId: pRet }));
  assert.match(t2.problems.get('f1065.L.1|end'), /cash layer/);
  assert.equal(t2.authoritative.get('f1065.L.1|end').cents, null);
  assert.equal(t2.complete, false);
});

test('a stored mapping whose source the live graph no longer reaches is a blocked source of its own, never dropped (Codex r2 B5)', async () => {
  const P = { orgId, entityId: await company(pool, orgId, 'Stranded Partners') };
  const pRet = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  const K = { orgId, entityId: await company(pool, orgId, 'Stranded Child LLC') };
  await period(pool, K, 2025, 'disregarded');
  const edge = await include(pool, P, pRet, await activity(pool, P, { name: 'Stranded trade' }), K.entityId);
  const kBank = await acct(pool, K, 'Checking');
  await je(pool, K, '2025-02-01', [[kBank, 1000], [await acct(pool, K, 'Services'), -1000]]);
  await saveBindings(pool, { ...P, returnId: pRet, sourceEntityId: K.entityId, accountId: kBank, measurement: 'end', rows: [{ treatment: 'input', destination: 'f1065.L.1' }], actor: 'tester' });
  const pBank = await acct(pool, P, 'Checking');
  await je(pool, P, '2025-02-01', [[pBank, 4000], [await acct(pool, P, 'Services'), -4000]]);
  await saveBindings(pool, { ...P, returnId: pRet, sourceEntityId: P.entityId, accountId: pBank, measurement: 'end', rows: [{ treatment: 'input', destination: 'f1065.L.1' }], actor: 'tester' });
  assert.equal(destinationTotals(await coverage(pool, { ...P, returnId: pRet })).authoritative.get('f1065.L.1|end').cents, 5000n);
  // Simulate a graph change outside T2's writes (the edge guard switched off for the test only).
  await pool.query('ALTER TABLE activity_inclusion DISABLE TRIGGER activity_inclusion_bound');
  try { await pool.query('DELETE FROM activity_inclusion WHERE org_id = $1 AND inclusion_id = $2', [orgId, edge]); }
  finally { await pool.query('ALTER TABLE activity_inclusion ENABLE TRIGGER activity_inclusion_bound'); }
  const c = await coverage(pool, { ...P, returnId: pRet });
  const s = c.sources.find(x => x.entityId === K.entityId);
  assert.deepEqual([s.status, s.stranded], ['blocked', true]);
  assert.ok(c.totals.blocked >= 1 && c.totals.blocking >= 1 && destinationTotals(c).complete === false);
  // Its slot is unknown too, though the parent's own amount on it is measured (Codex r3 B1).
  assert.equal(destinationTotals(c).authoritative.get('f1065.L.1|end').cents, null);
});

test('packets are checked against the CURRENT approved mapping (Codex r3 B2), and a source spread over two providers is refreshed together (R3-N1)', async () => {
  const W = { orgId, entityId: await company(pool, orgId, 'Willow Partners') };
  const wRet = await period(pool, W, 2025, 'form_1065', { taxMethod: 'accrual' });
  const trade = await activity(pool, W, { name: 'Willow trade' });
  const wages = await acct(pool, W, 'Wages'), bank = await acct(pool, W, 'Checking');
  await je(pool, W, '2025-03-01', [[wages, 10000], [bank, -10000]]);
  const save = () => saveBindings(pool, { ...W, returnId: wRet, sourceEntityId: W.entityId, accountId: wages, measurement: 'activity', split: 'shares', actor: 'tester',
    rows: [{ treatment: 'input', destination: 'f1065.p1.9', share: '1/2' }, { treatment: 'cogs_input', destination: 'f1125a.main.3', activityId: trade, share: '1/2' }] });
  await save();
  const cogsSlot = `f1125a.main.3|activity=act:${trade}|activity`;
  const request = slots => ({ returnId: wRet, revisionContext: 'working', slots, period: { start: '2025-01-01', end: '2025-12-31' }, method: 'accrual', bookBasis: 'accrual' });
  // Both packets of the current mapping, built against it (manifest.js currentPartition: the saved rows over a fresh measurement).
  const build = async (tag, review = 'unreviewed') => {
    const cov2 = await coverage(pool, { ...W, returnId: wRet }), owners = allocationOwners(cov2);
    const cur = await currentPartition(pool, { orgId, returnId: wRet, sourceEntityId: W.entityId, accountId: wages, measurement: 'activity' });
    const p = cov2.sources[0].accounts.find(x => x.accountId === wages).results.activity;
    const ownerOf = x => owners.get(`${W.entityId}/${wages}/activity/${x.kind}:${x.id}`);
    const pk = (provider, slot) => { const parts = toPacketParts(p, { provider, ownerOf, measured: cur.measured, lines: cur.lines, approved: cur.approved });
      return { providerKind: provider, schemaVersion: 1, sourceVersion: `${provider}@${tag}`, sourceRefs: parts.sourceRefs, completeness: 'complete', review: { state: review, by: 'tester' },
        values: [{ slotKey: slot, amountCents: parts.cents.toString() }], relatedOutputs: [], consumedSlices: parts.consumedSlices }; };
    return { books: pk('books', 'f1065.p1.9|activity'), cogs: pk('cogs_workpaper', cogsSlot) };
  };
  const a = await build('a');
  // Obsolete before it is ever assigned: the mapping is re-saved (new binding ids, same figures) — packet A is refused though nothing is live.
  await save();
  await assert.rejects(assignPacket(pool, { ...W, returnId: wRet, request: request(['f1065.p1.9|activity']), packet: a.books }), /earlier mapping/);
  const b = await build('b');
  await assignPacket(pool, { ...W, returnId: wRet, request: request(['f1065.p1.9|activity']), packet: b.books });
  await assignPacket(pool, { ...W, returnId: wRet, request: request([cogsSlot]), packet: b.cogs });
  // Re-saved again: one provider at a time can never refresh (each replacement meets the other's live earlier manifest)...
  await save();
  const c2 = await build('c', 'reviewed');
  const ck = slot => collectionKey(slot, { returnType: 'form_1065', edition: 2025 });
  const rec = slot => ({ collections: [{ collectionKey: ck(slot), oldCents: '5000', newCents: '5000' }], relatedOutputs: [] });
  const swapBooks = { from: { providerKind: 'books', sourceVersion: 'books@b' }, retire: ['f1065.p1.9|activity'], request: request(['f1065.p1.9|activity']), packet: c2.books, reconciliation: rec('f1065.p1.9|activity') };
  const swapCogs = { from: { providerKind: 'cogs_workpaper', sourceVersion: 'cogs_workpaper@b' }, retire: [cogsSlot], request: request([cogsSlot]), packet: c2.cogs, reconciliation: rec(cogsSlot) };
  await assert.rejects(substituteProvider(pool, { ...W, returnId: wRet, reviewedBy: 'tester', ...swapBooks }), /earlier mapping/);
  await assert.rejects(substituteProvider(pool, { ...W, returnId: wRet, reviewedBy: 'tester', ...swapCogs }), /earlier mapping/);
  // ...an obsolete replacement is refused too...
  await assert.rejects(substituteProviders(pool, { ...W, returnId: wRet, reviewedBy: 'tester', replacements: [{ ...swapBooks, packet: { ...b.books, sourceVersion: 'books@old', review: { state: 'reviewed', by: 'tester' } } }, swapCogs] }), /earlier mapping/);
  // ...and both together, in one transaction, apply.
  await substituteProviders(pool, { ...W, returnId: wRet, reviewedBy: 'tester', replacements: [swapBooks, swapCogs] });
  const { rows } = await pool.query(`SELECT provider_kind, source_version FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2 ORDER BY provider_kind`, [orgId, wRet]);
  assert.deepEqual(rows.map(r => r.source_version), ['books@c', 'cogs_workpaper@c']);
});

// Packets for one account's current partition, one per provider that owns part of it (Codex r4 tests).
async function packetsFor(S, retId, accountId, slots, tag, review = 'unreviewed', extraMeasured = {}) {
  const cov2 = await coverage(pool, { ...S, returnId: retId }), owners = allocationOwners(cov2);
  const cur = await currentPartition(pool, { orgId, returnId: retId, sourceEntityId: S.entityId, accountId, measurement: 'activity' });
  // A normalized partition (what T3 will build) is the same saved rows over the measurement on another basis.
  const p = extraMeasured.normalization
    ? buildPartition({ entityId: S.entityId, accountId, measurement: 'activity', measured: { ...cur.measured, ...extraMeasured }, lines: cur.lines, ...cur.approved })
    : cov2.sources[0].accounts.find(x => x.accountId === accountId).results.activity;
  const ownerOf = x => owners.get(`${S.entityId}/${accountId}/activity/${x.kind}:${x.id}`);
  const out = {};
  for (const [provider, slot] of Object.entries(slots)) {
    const parts = toPacketParts(p, { provider, ownerOf, measured: { ...cur.measured, ...extraMeasured }, lines: cur.lines, approved: cur.approved });
    out[provider] = { providerKind: provider, schemaVersion: 1, sourceVersion: `${provider}@${tag}`, sourceRefs: parts.sourceRefs, completeness: 'complete', review: { state: review, by: 'tester' },
      values: [{ slotKey: slot, amountCents: parts.cents.toString() }], relatedOutputs: [], consumedSlices: parts.consumedSlices };
  }
  return out;
}
const req = (retId, start, end) => slots => ({ returnId: retId, revisionContext: 'working', slots, period: { start, end }, method: 'accrual', bookBasis: 'accrual' });
const recOf = (slot, cents) => ({ collections: [{ collectionKey: collectionKey(slot, { returnType: 'form_1065', edition: 2025 }), oldCents: cents, newCents: cents }], relatedOutputs: [] });

test('publication checks the current, PERMITTED mapping (Codex r4 R4-N1): an ended activity, a retired packet’s source, a normalized partition', async () => {
  const Y = { orgId, entityId: await company(pool, orgId, 'Yew Partners') };
  const yRet = await period(pool, Y, 2025, 'form_1065', { taxMethod: 'accrual' });
  const trade = await activity(pool, Y, { name: 'Yew trade', from: '2020-01-01' });
  const wages = await acct(pool, Y, 'Wages');
  await je(pool, Y, '2025-03-01', [[wages, 10000], [await acct(pool, Y, 'Checking'), -10000]]);
  const save = () => saveBindings(pool, { ...Y, returnId: yRet, sourceEntityId: Y.entityId, accountId: wages, measurement: 'activity', split: 'shares', actor: 'tester',
    rows: [{ treatment: 'input', destination: 'f1065.p1.9', share: '1/2' }, { treatment: 'cogs_input', destination: 'f1125a.main.3', activityId: trade, share: '1/2' }] });
  await save();
  const cogsSlot = `f1125a.main.3|activity=act:${trade}|activity`, slots = { books: 'f1065.p1.9|activity', cogs_workpaper: cogsSlot };
  const request = req(yRet, '2025-01-01', '2025-12-31');
  // 1. The activity ends before the year: coverage calls the mapping unresolved, and so does the boundary.
  const a = await packetsFor(Y, yRet, wages, slots, 'a');
  await saveActivity(pool, { ...Y, activityId: trade, fields: { kind: 'trade', name: 'Yew trade', schedule: 'p1', from: '2020-01-01', to: '2024-12-31', disposedOn: '' } });
  await assert.rejects(assignPacket(pool, { ...Y, returnId: yRet, request: request([cogsSlot]), packet: a.cogs_workpaper }), /not a complete, permitted mapping/);
  await saveActivity(pool, { ...Y, activityId: trade, fields: { kind: 'trade', name: 'Yew trade', schedule: 'p1', from: '2020-01-01', to: '', disposedOn: '' } });
  // 2. A retired packet's source stays checked: both packets live, the mapping re-saved, the books packet replaced by a manual value that
  //    names no books partition — refused, since the COGS packet would stay live on the earlier mapping.
  await assignPacket(pool, { ...Y, returnId: yRet, request: request([slots.books]), packet: a.books });
  await assignPacket(pool, { ...Y, returnId: yRet, request: request([cogsSlot]), packet: a.cogs_workpaper });
  await save();
  const manual = { providerKind: 'manual', schemaVersion: 1, sourceVersion: 'manual:wages@1', sourceRefs: [{ kind: 'manual', id: 'wages', version: '1' }], completeness: 'complete',
    review: { state: 'reviewed', by: 'tester' }, values: [{ slotKey: slots.books, amountCents: '5000' }], relatedOutputs: [], consumedSlices: [] };
  await assert.rejects(substituteProvider(pool, { ...Y, returnId: yRet, reviewedBy: 'tester', from: { providerKind: 'books', sourceVersion: 'books@a' }, retire: [slots.books], request: request([slots.books]),
    packet: manual, reconciliation: recOf(slots.books, '5000') }), /earlier mapping/);
  // Together with a fresh COGS packet it applies.
  const b = await packetsFor(Y, yRet, wages, slots, 'b', 'reviewed');
  await substituteProviders(pool, { ...Y, returnId: yRet, reviewedBy: 'tester', replacements: [
    { from: { providerKind: 'books', sourceVersion: 'books@a' }, retire: [slots.books], request: request([slots.books]), packet: manual, reconciliation: recOf(slots.books, '5000') },
    { from: { providerKind: 'cogs_workpaper', sourceVersion: 'cogs_workpaper@a' }, retire: [cogsSlot], request: request([cogsSlot]), packet: b.cogs_workpaper, reconciliation: recOf(cogsSlot, '5000') }] });
  // 3. A partition on another measurement basis is T3's to publish (R4-N4): proved, but refused at the boundary in T2.
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, yRet]);
  const n = await packetsFor(Y, yRet, wages, slots, 'n', 'unreviewed', { normalization: 'closings_removed:sample' });
  assert.equal(n.books.sourceRefs[0].normalization, 'closings_removed:sample');
  await assert.rejects(assignPacket(pool, { ...Y, returnId: yRet, request: request([slots.books]), packet: n.books }), /published by stage T3/);
});

test('publication holds the included books it reads (Codex r4 R4-N1): a child journal entry in flight is waited for, and its new figures refuse the stale packet', async () => {
  const P = { orgId, entityId: await company(pool, orgId, 'Rowan Partners') };
  const pRet = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  const K = { orgId, entityId: await company(pool, orgId, 'Rowan Child LLC') };
  await period(pool, K, 2025, 'disregarded');
  await include(pool, P, pRet, await activity(pool, P, { name: 'Rowan trade' }), K.entityId);
  const kBank = await acct(pool, K, 'Checking'), kSales = await acct(pool, K, 'Services');
  const txn = await je(pool, K, '2025-02-01', [[kBank, 10000], [kSales, -10000]]);
  await saveBindings(pool, { ...P, returnId: pRet, sourceEntityId: K.entityId, accountId: kBank, measurement: 'end', rows: [{ treatment: 'input', destination: 'f1065.L.1' }], actor: 'tester' });
  const cov2 = await coverage(pool, { ...P, returnId: pRet }), owners = allocationOwners(cov2);
  const cur = await currentPartition(pool, { orgId, returnId: pRet, sourceEntityId: K.entityId, accountId: kBank, measurement: 'end' });
  const p = cov2.sources.find(s => s.entityId === K.entityId).accounts.find(x => x.accountId === kBank).results.end;
  const parts = toPacketParts(p, { provider: 'books', ownerOf: x => owners.get(`${K.entityId}/${kBank}/end/${x.kind}:${x.id}`), measured: cur.measured, lines: cur.lines, approved: cur.approved });
  const packet = { providerKind: 'books', schemaVersion: 1, sourceVersion: 'books@rowan', sourceRefs: parts.sourceRefs, completeness: 'complete', review: { state: 'unreviewed' },
    values: [{ slotKey: 'f1065.L.1|end', amountCents: '10000' }], relatedOutputs: [], consumedSlices: parts.consumedSlices };
  // The child's journal entry is reposted (20,000 cents) and held just before its COMMIT, with the child company locked as every ledger write does.
  const c = await pool.connect();
  let reached, release;
  const atCommit = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
  const held = { connect: async () => ({ query: async (sql, params) => { if (sql === 'COMMIT') { reached(); await gate; } return c.query(sql, params); }, release: () => {} }) };
  const write = je(held, K, '2025-02-01', [[kBank, 20000], [kSales, -20000]], { txnId: txn });
  await atCommit;
  const publish = assignPacket(pool, { ...P, returnId: pRet, request: req(pRet, '2025-01-01', '2025-12-31')(['f1065.L.1|end']), packet });
  const state = await Promise.race([publish.then(() => 'done', () => 'done'), new Promise(r => setTimeout(() => r('waiting'), 300))]);
  assert.equal(state, 'waiting', 'the publication waits for the child’s books');
  release();
  await write;
  c.release();
  await assert.rejects(publish, /earlier mapping/, 'and then sees the new figures: the 10,000-cent packet is not the current mapping');
});

test('a batch is checked on its FINAL state (Codex r4 R4-N2): two providers exchange attributed lines; a batch consuming one line twice is refused', async () => {
  const Z = { orgId, entityId: await company(pool, orgId, 'Zelkova Partners') };
  const zRet = await period(pool, Z, 2025, 'form_1065', { taxMethod: 'accrual' });
  const trade = await activity(pool, Z, { name: 'Zelkova trade' });
  const wages = await acct(pool, Z, 'Wages'), bank = await acct(pool, Z, 'Checking');
  const t1 = await je(pool, Z, '2025-03-01', [[wages, 5000], [bank, -5000]]), t2 = await je(pool, Z, '2025-04-01', [[wages, 5000], [bank, -5000]]);
  const cogsSlot = `f1125a.main.3|activity=act:${trade}|activity`, slots = { books: 'f1065.p1.9|activity', cogs_workpaper: cogsSlot };
  const books = { treatment: 'input', destination: 'f1065.p1.9' }, cogs = { treatment: 'cogs_input', destination: 'f1125a.main.3', activityId: trade };
  const attribute = async (pairs) => {
    await pool.query('DELETE FROM tax_binding_line WHERE org_id = $1 AND return_id = $2', [orgId, zRet]);
    const lines = (await measureLines(pool, { orgId, sourceEntityId: Z.entityId, accountIds: [wages], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(wages);
    for (const [txnId, target] of pairs) {
      const l = lines.find(x => x.txnId === Number(txnId));
      await attributeLine(pool, { ...Z, returnId: zRet, sourceEntityId: Z.entityId, accountId: wages, txnId, lineNo: l.lineNo, expectTxnVersion: l.txnVersion, target, actor: 'tester' });
    }
  };
  const request = req(zRet, '2025-01-01', '2025-12-31');
  await attribute([[t1, books], [t2, cogs]]);
  const a = await packetsFor(Z, zRet, wages, slots, 'a');
  await assignPacket(pool, { ...Z, returnId: zRet, request: request([slots.books]), packet: a.books });
  await assignPacket(pool, { ...Z, returnId: zRet, request: request([cogsSlot]), packet: a.cogs_workpaper });
  const swap = (from, next) => [
    { from: { providerKind: 'books', sourceVersion: `books@${from}` }, retire: [slots.books], request: request([slots.books]), packet: next.books, reconciliation: recOf(slots.books, '5000') },
    { from: { providerKind: 'cogs_workpaper', sourceVersion: `cogs_workpaper@${from}` }, retire: [cogsSlot], request: request([cogsSlot]), packet: next.cogs_workpaper, reconciliation: recOf(cogsSlot, '5000') }];
  // The lines exchange destinations; both orders of the batch apply (no single switch could).
  await attribute([[t1, cogs], [t2, books]]);
  const b = await packetsFor(Z, zRet, wages, slots, 'b', 'reviewed');
  await substituteProviders(pool, { ...Z, returnId: zRet, reviewedBy: 'tester', replacements: swap('a', b) });
  await attribute([[t1, books], [t2, cogs]]);
  const c2 = await packetsFor(Z, zRet, wages, slots, 'c', 'reviewed');
  await substituteProviders(pool, { ...Z, returnId: zRet, reviewedBy: 'tester', replacements: swap('b', c2).reverse() });
  // A batch whose final state consumes one line twice is refused, and changes nothing.
  await attribute([[t1, cogs], [t2, books]]);
  const d = await packetsFor(Z, zRet, wages, slots, 'd', 'reviewed');
  const twice = { ...d.cogs_workpaper, consumedSlices: [...d.cogs_workpaper.consumedSlices, ...d.books.consumedSlices] };
  await assert.rejects(substituteProviders(pool, { ...Z, returnId: zRet, reviewedBy: 'tester', replacements: swap('c', { ...d, cogs_workpaper: twice }) }), /consumed by two replacement packets/);
  const { rows } = await pool.query('SELECT source_version FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2 ORDER BY 1', [orgId, zRet]);
  assert.deepEqual(rows.map(r => r.source_version), ['books@c', 'cogs_workpaper@c']);
});
