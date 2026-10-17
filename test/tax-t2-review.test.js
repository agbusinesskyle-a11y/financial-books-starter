// test/tax-t2-review.test.js — regressions from the Codex implementation review of T2 (t2-r1): a saved mapping is re-checked against the
// account as it is now (B3), cash-touched balance accounts stay in coverage (B4), the manifest follows every resolved reference (B1) and the
// packet boundary checks what a packet consumes against the current approved portions (B2). Sample names only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, lineOf, period, activity, party, include } from './tax-t2-fixtures.js';
import { saveBindings, attributeLine, copyForward, resolveReferences, listBindings, listAttributions } from '../lib/tax/bindings.js';
import { coverage, destinationTotals, needsOf, allocationOwners } from '../lib/tax/coverage.js';
import { currentPartition } from '../lib/tax/manifest.js';
import { toPacketParts } from '../lib/tax/partition.js';
import { assignPacket, assignProvider, substituteProvider, collectionKey } from '../lib/tax/providers.js';
import { saveInterest } from '../lib/tax/ownership.js';
import { measureLines } from '../lib/tax/measure.js';
import { saveAccount } from '../lib/data/ledger.js';
import { saveCompany } from '../lib/data/settings.js';
import { deleteLedgerTxn } from '../lib/data/ledger-tools.js';
import { openPeriod } from '../lib/tax/periods.js';

let t, pool, orgId;
before(async () => { t = await t2Db(); pool = t.pool; orgId = t.orgId; });
after(async () => { await t.db.drop(); });

const accountIn = (cov, id) => cov.sources[0].accounts.find(a => a.accountId === id);
const retype = (S, accountId, name, type) => saveAccount(pool, { ...S, accountId, fields: { name, type, number: '', parentId: '', description: '', active: true } });

test('B3: a saved mapping is checked against the account as it is now — a wage mapping on an account retyped to an asset blocks; so do a line and a copied default', async () => {
  const S = { orgId, entityId: await company(pool, orgId, 'Retype Sample Partners') };
  const ret = await period(pool, S, 2025, 'form_1065', { taxMethod: 'accrual' });
  const wages = await acct(pool, S, 'Wages'), bank = await acct(pool, S, 'Checking');
  const save = args => saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, actor: 'tester', ...args });
  // The review's reproduction: wages mapped to page 1 line 9, the journal deleted, the unused account retyped to a prepaid asset, reposted.
  const first = await je(pool, S, '2025-03-01', [[wages, 10000], [bank, -10000]]);
  await save({ accountId: wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }] });
  await deleteLedgerTxn(pool, { ...S, txnId: first });
  await retype(S, wages, 'Prepaid Services', 'other_current_asset');
  await je(pool, S, '2025-04-01', [[wages, 10000], [bank, -10000]]);
  await save({ accountId: wages, measurement: 'end', rows: [{ treatment: 'statement_row', destination: 'f1065.L.6' }] });
  await save({ accountId: bank, measurement: 'end', rows: [{ treatment: 'input', destination: 'f1065.L.1' }] });
  const c = await coverage(pool, { ...S, returnId: ret });
  const a = accountIn(c, wages);
  assert.equal(a.results.activity.status, 'unresolved', 'the wage routing of a balance-sheet account is not a mapping any more');
  assert.match(a.results.activity.reasons.join(' '), /balance-sheet account/);
  assert.equal(a.status, 'unresolved');
  assert.ok(c.totals.blocking >= 1);
  const totals = destinationTotals(c);
  assert.equal(totals.complete, false);
  assert.equal(totals.authoritative.get('f1065.p1.9|activity').cents, null, 'no false deduction');
  // A line attribution follows the same rule (the account's type changed under it; simulated in SQL, as the ledger forbids it with postings).
  const L = { orgId, entityId: await company(pool, orgId, 'Retype Line Partners') };
  const lRet = await period(pool, L, 2025, 'form_1065', { taxMethod: 'accrual' });
  const lWages = await acct(pool, L, 'Wages'), lBank = await acct(pool, L, 'Checking');
  const txn = await je(pool, L, '2025-03-01', [[lWages, 10000], [lBank, -10000]]);
  const [line] = (await measureLines(pool, { orgId, sourceEntityId: L.entityId, accountIds: [lWages], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(lWages);
  await attributeLine(pool, { ...L, returnId: lRet, sourceEntityId: L.entityId, accountId: lWages, txnId: txn, lineNo: await lineOf(pool, txn, lWages), expectTxnVersion: line.txnVersion,
    target: { treatment: 'input', destination: 'f1065.p1.9' }, actor: 'tester' });
  assert.equal(accountIn(await coverage(pool, { ...L, returnId: lRet }), lWages).results.activity.status, 'complete');
  await pool.query(`UPDATE account SET type = 'other_current_asset' WHERE org_id = $1 AND account_id = $2`, [orgId, lWages]);
  const lc = accountIn(await coverage(pool, { ...L, returnId: lRet }), lWages);
  assert.equal(lc.results.activity.status, 'unresolved');
  assert.match(lc.results.activity.reasons.join(' '), /balance-sheet account/);
  // A company default copied into a period, the account retyped afterwards: the copied binding blocks too.
  const D = { orgId, entityId: await company(pool, orgId, 'Retype Default Partners') };
  const d25 = await period(pool, D, 2025, 'form_1065', { taxMethod: 'accrual' });
  const dWages = await acct(pool, D, 'Wages'), dBank = await acct(pool, D, 'Checking');
  await je(pool, D, '2025-03-01', [[dWages, 10000], [dBank, -10000]]);
  await saveBindings(pool, { ...D, returnId: d25, sourceEntityId: D.entityId, accountId: dWages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }], makeDefault: true, actor: 'tester' });
  const d26 = Number(await openPeriod(pool, { ...D, year: 2026, actor: 'tester' }));
  await je(pool, D, '2026-03-01', [[dWages, 10000], [dBank, -10000]]);
  await copyForward(pool, { ...D, returnId: d26, actor: 'tester' });
  assert.equal(accountIn(await coverage(pool, { ...D, returnId: d26 }), dWages).results.activity.status, 'complete');
  await pool.query(`UPDATE account SET type = 'other_current_asset' WHERE org_id = $1 AND account_id = $2`, [orgId, dWages]);
  assert.equal(accountIn(await coverage(pool, { ...D, returnId: d26 }), dWages).results.activity.status, 'unresolved');
});

test('B4: on a cash-method return a balance account a linked settlement touches stays in coverage with zero raw figures — inventory and a clearing account need a disposition', async () => {
  const S = { orgId, entityId: await company(pool, orgId, 'Prepaid Sample Partners') };
  const ret = await period(pool, S, 2025, 'form_1065', { taxMethod: 'cash' });
  const trade = await activity(pool, S, { name: 'Prepaid trade' });
  const inventory = await acct(pool, S, 'Sample Inventory Purchases', 'inventory'), clearing = await acct(pool, S, 'Sample Freight Clearing', 'other_current_asset');
  const bank = await acct(pool, S, 'Checking');
  const { rows: [ap] } = await pool.query(`SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND system_key = 'ap'`, [orgId, S.entityId]);
  // A January 2026 bill (inventory and freight clearing) paid in December 2025, the payment applied to it: the review's prepayment.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [v] } = await c.query(`INSERT INTO vendor (org_id, entity_id, display_name) VALUES ($1, $2, 'Sample Supplier') RETURNING vendor_id`, [orgId, S.entityId]);
    const { rows: [bill] } = await c.query(`INSERT INTO txn (org_id, entity_id, vendor_id, type, txn_date, due_date, total_cents, open_cents, approval_status)
      VALUES ($1, $2, $3, 'bill', '2026-01-10', '2026-01-10', 50000, 0, 'approved') RETURNING txn_id`, [orgId, S.entityId, v.vendor_id]);
    const { rows: [pay] } = await c.query(`INSERT INTO txn (org_id, entity_id, vendor_id, type, txn_date, total_cents, open_cents, account_id)
      VALUES ($1, $2, $3, 'bill_payment', '2025-12-20', 50000, 0, $4) RETURNING txn_id`, [orgId, S.entityId, v.vendor_id, bank]);
    await c.query(`INSERT INTO posting (org_id, entity_id, txn_id, line_no, account_id, amount_cents, txn_date) VALUES
      ($1, $2, $3, 1, $5, 30000, '2026-01-10'), ($1, $2, $3, 2, $6, 20000, '2026-01-10'), ($1, $2, $3, 3, $7, -50000, '2026-01-10'),
      ($1, $2, $4, 1, $7, 50000, '2025-12-20'), ($1, $2, $4, 2, $8, -50000, '2025-12-20')`, [orgId, S.entityId, bill.txn_id, pay.txn_id, inventory, clearing, ap.account_id, bank]);
    await c.query(`INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1, $2, $3, 50000, '2026-01-10')`, [orgId, pay.txn_id, bill.txn_id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  const save = (accountId, measurement, rows) => saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId, measurement, rows, actor: 'tester' });
  await save(bank, 'end', [{ treatment: 'input', destination: 'f1065.L.1' }]);
  await save(Number(ap.account_id), 'end', [{ treatment: 'input', destination: 'f1065.L.15' }]);
  const cov = await coverage(pool, { ...S, returnId: ret });
  for (const id of [inventory, clearing]) {
    const a = accountIn(cov, id);
    assert.ok(a, 'the cash-touched account is in coverage');
    assert.deepEqual([a.begin, a.activity, a.end, a.postings, a.cashTouched], [0n, 0n, 0n, 0, true]);
    assert.deepEqual(a.needs, ['activity']);
    assert.equal(a.status, 'uncovered');
  }
  assert.ok(cov.totals.blocking >= 2);
  assert.equal(destinationTotals(cov).complete, false, 'omission never makes the mapping complete');
  // Disposed of explicitly — the inventory as a COGS workpaper input (the cash layer decides what is recognized, T3), the clearing account
  // as not on the return with its reason — the return is covered.
  await save(inventory, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: trade }]);
  await save(clearing, 'activity', [{ treatment: 'not_tax', memo: 'Freight clearing: settles into inventory when the bill posts' }]);
  const after2 = await coverage(pool, { ...S, returnId: ret });
  assert.deepEqual([accountIn(after2, inventory).status, accountIn(after2, clearing).status], ['complete', 'complete']);
  // needsOf on its own: a cash-touched balance account with nothing raw needs its activity disposed of; off a cash-sensitive source it is out.
  const m = { type: 'inventory', postings: 0, begin: 0n, end: 0n, cashTouched: true };
  assert.deepEqual(needsOf(m, { cashSensitive: true }), ['activity']);
  assert.deepEqual(needsOf(m, { cashSensitive: false }), []);
});

// A packet of one provider for one account measurement's CURRENT partition (manifest.js currentPartition, coverage's owners), publishing slot.
async function packetOf(S, retId, accountId, measurement, slot, tag, { provider = 'books', review = 'unreviewed' } = {}) {
  const cov = await coverage(pool, { ...S, returnId: retId }), owners = allocationOwners(cov);
  const cur = await currentPartition(pool, { orgId, returnId: retId, sourceEntityId: S.entityId, accountId, measurement });
  const parts = toPacketParts(cur.partition, { provider, ownerOf: x => owners.get(`${S.entityId}/${accountId}/${measurement}/${x.kind}:${x.id}`), ...cur });
  return { providerKind: provider, schemaVersion: 1, sourceVersion: `${provider}@${tag}`, sourceRefs: parts.sourceRefs, completeness: 'complete', review: { state: review, by: 'tester' },
    values: [{ slotKey: slot, amountCents: parts.cents.toString() }], relatedOutputs: [], consumedSlices: parts.consumedSlices };
}
const requestOf = retId => slots => ({ returnId: retId, revisionContext: 'working', slots, period: { start: '2025-01-01', end: '2025-12-31' }, method: 'accrual', bookBasis: 'accrual' });
const slotsOf = async (S, retId) => [...(await listBindings(pool, { ...S, returnId: retId })).map(b => b.slot_key), ...(await listAttributions(pool, { ...S, returnId: retId })).map(l => l.slot_key)];
const liveCount = async retId => (await pool.query('SELECT count(*)::int AS n FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, retId])).rows[0].n;

test('B1: re-resolving an owner changes the manifest — a packet built for the earlier interest is refused, first and as a replacement; account and line bindings', async () => {
  for (const form of ['account', 'line']) {
    const S = { orgId, entityId: await company(pool, orgId, `Successor ${form} Sample Corp`) };
    const ret = await period(pool, S, 2025, 'form_1120s', { taxMethod: 'accrual' });
    const wages = await acct(pool, S, 'Wages'), bank = await acct(pool, S, 'Checking');
    const officer = await party(pool, orgId, `Sample ${form} Officer`);
    const txn = await je(pool, S, '2025-04-01', [[wages, 10000], [bank, -10000]]);
    await saveInterest(pool, { ...S, fields: { partyId: officer, role: 'shareholder', from: '2020-01-01', profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
    const target = { treatment: 'input', destination: 'f1120s.p1.7', interestPartyId: officer };
    if (form === 'account') await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: wages, measurement: 'activity', rows: [target], actor: 'tester' });
    else {
      const [l] = (await measureLines(pool, { orgId, sourceEntityId: S.entityId, accountIds: [wages], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(wages);
      await attributeLine(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: wages, txnId: txn, lineNo: await lineOf(pool, txn, wages), expectTxnVersion: l.txnVersion, target, actor: 'tester' });
    }
    const [slot1] = await slotsOf(S, ret);
    const old = await packetOf(S, ret, wages, 'activity', slot1, 'i1');
    // The same shareholder's successor interest from January 1: unresolved until re-resolved, then the binding feeds the new interest's slot.
    await saveInterest(pool, { ...S, fields: { partyId: officer, role: 'shareholder', from: '2025-01-01', profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
    assert.equal(accountIn(await coverage(pool, { ...S, returnId: ret }), wages).results.activity.status, 'unresolved', form);
    await resolveReferences(pool, { ...S, returnId: ret });
    const [slot2] = await slotsOf(S, ret);
    assert.notEqual(slot2, slot1, form);
    const request = requestOf(ret);
    // The obsolete packet's first assignment is refused, under either slot, and nothing goes live.
    await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request([slot1]), packet: old }), /earlier mapping/, form);
    await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request([slot2]), packet: { ...old, values: [{ ...old.values[0], slotKey: slot2 }] } }), /earlier mapping/, form);
    assert.equal(await liveCount(ret), 0);
    await assignPacket(pool, { ...S, returnId: ret, request: request([slot2]), packet: await packetOf(S, ret, wages, 'activity', slot2, 'i2') });
    // A correction of the selected interest (same id, a new version): a replacement built before the re-resolution is refused, one rebuilt
    // after it applies.
    await saveInterest(pool, { ...S, fields: { partyId: officer, role: 'shareholder', from: '2025-01-01', profit: '1/1', loss: '1/1', capital: '' }, actor: 'tester' });
    const stale = await packetOf(S, ret, wages, 'activity', slot2, 'i2-stale', { review: 'reviewed' });
    assert.equal((await resolveReferences(pool, { ...S, returnId: ret })).updated, 1, form);
    assert.deepEqual(await slotsOf(S, ret), [slot2], 'the same slot');
    const rec = { collections: [{ collectionKey: collectionKey(slot2, { returnType: 'form_1120s', edition: 2025 }), oldCents: '10000', newCents: '10000' }], relatedOutputs: [] };
    const swap = packet => substituteProvider(pool, { ...S, returnId: ret, from: { providerKind: 'books', sourceVersion: 'books@i2' }, retire: [slot2], request: request([slot2]), packet,
      reviewedBy: 'tester', reconciliation: rec });
    await assert.rejects(swap(stale), /earlier mapping/, form);
    await swap(await packetOf(S, ret, wages, 'activity', slot2, 'i2-fresh', { review: 'reviewed' }));
    // The stable owner reference copy-forward uses is unchanged.
    const rows = [...await listBindings(pool, { ...S, returnId: ret }), ...await listAttributions(pool, { ...S, returnId: ret })];
    assert.ok(rows.length === 1 && Number(rows[0].interest_party_id) === officer && rows[0].target_key.includes(`o=${officer}`));
  }
});

test('B2: the boundary checks what a packet consumes against the approved portions of the current manifest — no invented portion, no line inside a residual, no portion of another provider or slot', async () => {
  const S = { orgId, entityId: await company(pool, orgId, 'Portion Sample Partners') };
  const ret = await period(pool, S, 2025, 'form_1065', { taxMethod: 'accrual' });
  const trade = await activity(pool, S, { name: 'Portion trade' });
  const wages = await acct(pool, S, 'Wages'), rent = await acct(pool, S, 'Rent & Lease'), bank = await acct(pool, S, 'Checking');
  const txn = await je(pool, S, '2025-04-01', [[wages, 10000], [bank, -10000]]);
  await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }], actor: 'tester' });
  const request = requestOf(ret);
  const valid = await packetOf(S, ret, wages, 'activity', 'f1065.p1.9|activity', 'valid');
  assert.deepEqual(valid.consumedSlices.map(s => s.txn), ['rest']);
  const forged = (slot, tag, slices, extra = {}) => ({ ...valid, sourceVersion: `books@${tag}`, values: [{ slotKey: slot, amountCents: '10000' }], consumedSlices: slices, ...extra });
  const realLine = { entity: String(S.entityId), account: String(wages), txn: String(txn), line: String(await lineOf(pool, txn, wages)), measurement: 'activity' };
  // A portion of the right manifest published to a slot its routing does not feed is refused before anything is live.
  await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.13|activity']), packet: forged('f1065.p1.13|activity', 'wrong-slot', valid.consumedSlices) }),
    /routed to f1065\.p1\.9\|activity/);
  await assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.9|activity']), packet: valid });
  // The review's two forgeries, naming the identical current manifest: the actual journal line already inside the residual, and a residual
  // portion that does not exist.
  await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.13|activity']), packet: forged('f1065.p1.13|activity', 'real-line', [realLine]) }),
    /not an approved portion/);
  await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.11|activity']),
    packet: forged('f1065.p1.11|activity', 'invented', [{ ...valid.consumedSlices[0], line: 'b999999999' }]) }), /not an approved portion/);
  // Books slices are consumed only through their books partition: a packet that names none is refused too.
  await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.13|activity']),
    packet: forged('f1065.p1.13|activity', 'no-ref', [realLine], { sourceRefs: [{ kind: 'manual_item', id: 'wages', version: 'v1' }] }) }), /without naming its books partition/);
  assert.equal(await liveCount(ret), 1);
  // A batch replacement is held to the same rule: the books packet swapped for one consuming the actual line instead of the residual.
  const rec = { collections: [{ collectionKey: collectionKey('f1065.p1.9|activity', { returnType: 'form_1065', edition: 2025 }), oldCents: '10000', newCents: '10000' }], relatedOutputs: [] };
  await assert.rejects(substituteProvider(pool, { ...S, returnId: ret, from: { providerKind: 'books', sourceVersion: 'books@valid' }, retire: ['f1065.p1.9|activity'], request: request(['f1065.p1.9|activity']),
    packet: forged('f1065.p1.9|activity', 'swap-line', [realLine], { review: { state: 'reviewed', by: 'tester' } }), reviewedBy: 'tester', reconciliation: rec }), /not an approved portion/);
  // Another provider cannot take the books' portion, and a packet publishing a slot must consume every approved portion routed to it.
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
  await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: wages, measurement: 'activity', split: 'shares', actor: 'tester',
    rows: [{ treatment: 'input', destination: 'f1065.p1.9', share: '1/2' }, { treatment: 'cogs_input', destination: 'f1125a.main.3', activityId: trade, share: '1/2' }] });
  const cogsSlot = `f1125a.main.3|activity=act:${trade}|activity`;
  const books = await packetOf(S, ret, wages, 'activity', 'f1065.p1.9|activity', 'split');
  const cogs = await packetOf(S, ret, wages, 'activity', cogsSlot, 'split', { provider: 'cogs_workpaper' });
  await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request([cogsSlot]), packet: { ...cogs, consumedSlices: [...cogs.consumedSlices, ...books.consumedSlices] } }),
    /belongs to books/);
  await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request([cogsSlot]), packet: { ...cogs, consumedSlices: [] } }), /does not consume every approved portion/);
  await assignPacket(pool, { ...S, returnId: ret, request: request([cogsSlot]), packet: cogs });
  await assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.9|activity']), packet: books });
  // One provider may publish one source's slots in separate packets: a line to one slot, the residual to another.
  await je(pool, S, '2025-05-01', [[rent, 30000], [bank, -30000]]);
  const rentTxn = await je(pool, S, '2025-06-01', [[rent, 20000], [bank, -20000]]);
  const [, june] = (await measureLines(pool, { orgId, sourceEntityId: S.entityId, accountIds: [rent], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(rent);
  await attributeLine(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: rent, txnId: rentTxn, lineNo: await lineOf(pool, rentTxn, rent), expectTxnVersion: june.txnVersion,
    target: { treatment: 'input', destination: 'f1065.p1.13' }, actor: 'tester' });
  await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: rent, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.11' }], actor: 'tester' });
  const both = await packetOf(S, ret, rent, 'activity', 'f1065.p1.13|activity', 'rent');
  const lineOnly = { ...both, sourceVersion: 'books@rent-line', consumedSlices: both.consumedSlices.filter(s => s.txn !== 'rest'), values: [{ slotKey: 'f1065.p1.13|activity', amountCents: '20000' }] };
  const restOnly = { ...both, sourceVersion: 'books@rent-rest', consumedSlices: both.consumedSlices.filter(s => s.txn === 'rest'), values: [{ slotKey: 'f1065.p1.11|activity', amountCents: '30000' }] };
  await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.13|activity']), packet: { ...lineOnly, consumedSlices: both.consumedSlices } }), /routed to f1065\.p1\.11/);
  await assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.13|activity']), packet: lineOnly });
  await assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.11|activity']), packet: restOnly });
  assert.equal(await liveCount(ret), 4);
});

test('t2-r1 non-blocking 1: a snapshot transaction can neither bind through an edge removed while it held its snapshot nor change a company EIN', async () => {
  // The review’s binding probe: a snapshot writer holds the graph of its first statement, so it could bind through an edge removed meanwhile; it is refused.
  const P = { orgId, entityId: await company(pool, orgId, 'Snapshot Parent Partners') };
  const C = { orgId, entityId: await company(pool, orgId, 'Snapshot Child LLC') };
  const ret = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  await period(pool, C, 2025, 'disregarded', { taxMethod: 'accrual' });
  const wages = await acct(pool, C, 'Wages');
  const act = await activity(pool, P, { name: 'Snapshot trade' });
  const edge = await include(pool, P, ret, act, C.entityId);
  const c = await pool.connect();
  try {
    for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
      await c.query(`BEGIN ISOLATION LEVEL ${level}`);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM activity_inclusion WHERE org_id = $1 AND inclusion_id = $2', [orgId, edge])).rows[0].n, 1);
      await assert.rejects(c.query(`INSERT INTO tax_binding (org_id, return_id, source_entity_id, inclusion_path, account_id, measurement, treatment, destination, activity_id, slot_key, target_key, source_version, catalog_edition)
        VALUES ($1, $2, $3, $4, $5, 'activity', 'input', 'f1065.p1.9', $6, 'f1065.p1.9|activity', $7, 'snapshot', 2025)`, [orgId, ret, C.entityId, [edge], wages, act, `input|f1065.p1.9|a=${act}|o=-|k=-`]),
      /READ COMMITTED/, level);
      await c.query('ROLLBACK');
    }
    // saveCompany inside a caller's snapshot transaction cannot change the EIN (it could miss a reconciliation committed while it waited).
    const env = { SETTINGS_KEY: 'cd'.repeat(32) };
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(saveCompany(c, { orgId, entityId: P.entityId, fields: { name: 'Snapshot Parent Partners', ein: '333333333' }, env }), /READ COMMITTED/);
    await c.query('ROLLBACK');
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await saveCompany(c, { orgId, entityId: P.entityId, fields: { name: 'Snapshot Parent Partners', ein: '' }, env });
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await saveCompany(c, { orgId, entityId: P.entityId, fields: { name: 'Snapshot Parent Partners', ein: '333333333' }, env });
    await c.query('COMMIT');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  assert.equal((await pool.query('SELECT ein_last4 FROM entity WHERE org_id = $1 AND entity_id = $2', [orgId, P.entityId])).rows[0].ein_last4, '3333');
});

test('t2-r1 non-blocking 2: moving a period to another company re-checks that company’s roster', async () => {
  const P = { orgId, entityId: await company(pool, orgId, 'Period Target Partners') };
  const S = { orgId, entityId: await company(pool, orgId, 'Period Source Corp') };
  await period(pool, P, 2024, 'form_1065');
  const partner = await party(pool, orgId, 'Sample Period Partner');
  await saveInterest(pool, { ...P, fields: { partyId: partner, role: 'general_partner', from: '2024-01-01', profit: '100%', loss: '100%', capital: '100%' }, actor: 'tester' });
  const moved = await period(pool, S, 2025, 'form_1120s');
  await assert.rejects(pool.query('UPDATE tax_return SET entity_id = $3 WHERE org_id = $1 AND return_id = $2', [orgId, moved, P.entityId]), /takes no general_partner/);
});

// One 10,000-cent wages posting of an accrual partnership mapped whole to page 1 line 9 (the round-2 fixtures).
async function wagesFixture(name) {
  const S = { orgId, entityId: await company(pool, orgId, name) };
  const ret = await period(pool, S, 2025, 'form_1065', { taxMethod: 'accrual' });
  const wages = await acct(pool, S, 'Wages'), bank = await acct(pool, S, 'Checking');
  const txn = await je(pool, S, '2025-04-01', [[wages, 10000], [bank, -10000]]);
  await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }], actor: 'tester' });
  const realLine = { entity: String(S.entityId), account: String(wages), txn: String(txn), line: String(await lineOf(pool, txn, wages)), measurement: 'activity' };
  return { S, ret, wages, txn, realLine };
}

test('t2-r2 B2a: the single-slot assignment holds authority only — the packet the boundary refuses cannot go live through it', async () => {
  const { S, ret, wages, realLine } = await wagesFixture('Single Slot Sample Partners');
  const request = requestOf(ret);
  const valid = await packetOf(S, ret, wages, 'activity', 'f1065.p1.9|activity', 'valid');
  await assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.9|activity']), packet: valid });
  const forged = { ...valid, sourceVersion: 'books@forged', values: [{ slotKey: 'f1065.p1.13|activity', amountCents: '10000' }], consumedSlices: [realLine] };
  await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.13|activity']), packet: forged }), /not an approved portion/);
  // The review's reproduction: the same packet as a persisted snapshot through assignProvider.
  for (const sourceRef of [{ packet: { ...forged, slots: ['f1065.p1.13|activity'] }, value: forged.values[0], request: request(['f1065.p1.13|activity']) }, { value: forged.values[0] }, { packet: forged }]) {
    await assert.rejects(assignProvider(pool, { ...S, returnId: ret, slotKey: 'f1065.p1.13|activity', providerKind: 'books', schemaVersion: 1, sourceVersion: 'books@forged', sourceRef }), /authority only/);
  }
  assert.equal(await liveCount(ret), 1);
  // Metadata-only authority stays available.
  await assignProvider(pool, { ...S, returnId: ret, slotKey: 'f1065.p1.13|activity', providerKind: 'manual', schemaVersion: 1, sourceVersion: 'manual:rent@1', sourceRef: { note: 'reviewed lease' } });
  assert.equal(await liveCount(ret), 2);
});

test('t2-r2 B2b: a books claim is checked whatever its spelling — another company, a padded id, a foreign account or a non-books entity on a books packet is refused; real provider records stay allowed', async () => {
  const { S, ret, wages, realLine } = await wagesFixture('Spelling Sample Partners');
  const outsider = await company(pool, orgId, 'Spelling Outside LLC');
  const outsiderBank = await acct(pool, { orgId, entityId: outsider }, 'Checking');
  const request = requestOf(ret);
  const valid = await packetOf(S, ret, wages, 'activity', 'f1065.p1.9|activity', 'valid');
  await assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.9|activity']), packet: valid });
  const forged = (slot, tag, slices) => ({ ...valid, sourceVersion: `books@${tag}`, values: [{ slotKey: slot, amountCents: '10000' }], consumedSlices: slices });
  const cases = [
    ['f1065.p1.13|activity', 'other-company', [{ ...realLine, entity: String(outsider) }], /not a company whose books this return includes/],
    ['f1065.p1.11|activity', 'padded', [{ ...realLine, entity: `0${S.entityId}` }], /not a canonical books identity/],
    ['f1065.p1.11|activity', 'spaced', [{ ...realLine, account: ` ${wages}` }], /not a canonical books identity/],
    ['f1065.p1.11|activity', 'foreign-account', [{ ...realLine, account: String(outsiderBank) }], /is not an account of company/],
    ['f1065.p1.11|activity', 'opaque', [{ ...realLine, entity: 'e:1' }], /books packet consumes only books slices/],
  ];
  for (const [slot, tag, slices, re] of cases) await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request([slot]), packet: forged(slot, tag, slices) }), re, tag);
  assert.equal(await liveCount(ret), 1);
  // The same through a reviewed replacement (the review's nonexistent residual on another company).
  const rec = { collections: [{ collectionKey: collectionKey('f1065.p1.9|activity', { returnType: 'form_1065', edition: 2025 }), oldCents: '10000', newCents: '10000' }], relatedOutputs: [] };
  await assert.rejects(substituteProvider(pool, { ...S, returnId: ret, from: { providerKind: 'books', sourceVersion: 'books@valid' }, retire: ['f1065.p1.9|activity'], request: request(['f1065.p1.9|activity']),
    packet: { ...forged('f1065.p1.9|activity', 'swap', [{ ...valid.consumedSlices[0], entity: String(outsider), line: 'b999999999' }]), review: { state: 'reviewed', by: 'tester' } }, reviewedBy: 'tester', reconciliation: rec }),
  /not a company whose books this return includes/);
  assert.equal(await liveCount(ret), 1);
  // A workpaper's own records (no company id) remain the provider's own slices on a slot the books do not feed.
  const trade = await activity(pool, S, { name: 'Spelling trade' });
  const slot = `f1125a.main.2|activity=act:${trade}|activity`;
  await assignPacket(pool, { ...S, returnId: ret, request: request([slot]), packet: { providerKind: 'cogs_workpaper', schemaVersion: 1, sourceVersion: 'wp@1', sourceRefs: [{ kind: 'workpaper', id: 'count', version: '1' }],
    completeness: 'complete', review: { state: 'reviewed', by: 'tester' }, values: [{ slotKey: slot, amountCents: '2500' }], relatedOutputs: [], consumedSlices: [{ entity: 'wp:count', txn: 'sheet-1', measurement: 'activity' }] } });
  assert.equal(await liveCount(ret), 2);
});

test('t2-r2 R2-B1: an initial assignment is checked under the authority it creates — a complete cash-layer packet takes the slot, one omitting its portion is refused and leaves nothing', async () => {
  const { S, ret, wages } = await wagesFixture('Initial Authority Sample Partners');
  const request = requestOf(ret);
  const cur = await currentPartition(pool, { orgId, returnId: ret, sourceEntityId: S.entityId, accountId: wages, measurement: 'activity' });
  // The cash layer's packet, built as if the slot were the cash layer's: every allocation of the partition is its portion.
  const parts = toPacketParts(cur.partition, { provider: 'cash_layer', ownerOf: () => 'cash_layer', ...cur });
  const cash = slices => ({ providerKind: 'cash_layer', schemaVersion: 1, sourceVersion: `cash@${slices.length}`, sourceRefs: parts.sourceRefs, completeness: 'complete', review: { state: 'reviewed', by: 'tester' },
    values: [{ slotKey: 'f1065.p1.9|activity', amountCents: '10000' }], relatedOutputs: [], consumedSlices: slices });
  for (const sourceRefs of [parts.sourceRefs, [{ kind: 'cash_ledger', id: 'c', version: '1' }]]) {
    await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.9|activity']), packet: { ...cash([]), sourceRefs } }), /does not consume every approved portion/);
  }
  assert.equal(await liveCount(ret), 0);
  await assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.9|activity']), packet: cash(parts.consumedSlices) });
  const owners = allocationOwners(await coverage(pool, { ...S, returnId: ret }));
  assert.equal(owners.get(`${S.entityId}/${wages}/activity/binding:${cur.partition.rowIds[0]}`), 'cash_layer');
  assert.equal(await liveCount(ret), 1);
});

test('t2-r3 R3-B1: every books partition an incoming packet names is checked — a stale manifest on first assignment or a new dependency in a replacement, an outside or malformed one on a return with no bindings', async () => {
  const { S, ret, wages } = await wagesFixture('Named Partition Sample Partners');
  const request = requestOf(ret);
  const stale = (await packetOf(S, ret, wages, 'activity', 'f1065.p1.9|activity', 'captured')).sourceRefs;
  await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.11' }], actor: 'tester' });
  assert.notEqual((await packetOf(S, ret, wages, 'activity', 'f1065.p1.11|activity', 'now')).sourceRefs[0].version, stale[0].version);
  const named = (slot, tag, sourceRefs = stale) => ({ providerKind: 'books', schemaVersion: 1, sourceVersion: `books@${tag}`, sourceRefs, completeness: 'complete', review: { state: 'reviewed', by: 'tester' },
    values: [{ slotKey: slot, amountCents: '10000' }], relatedOutputs: [], consumedSlices: [] });
  // 1. The review's reproduction: a first assignment naming only the obsolete manifest and consuming nothing.
  await assert.rejects(assignPacket(pool, { ...S, returnId: ret, request: request(['f1065.p1.13|activity']), packet: named('f1065.p1.13|activity', 'stale-only') }), /earlier mapping/);
  assert.equal(await liveCount(ret), 0);
  // 2. A replacement introducing that dependency over a metadata-only authority.
  await assignProvider(pool, { ...S, returnId: ret, slotKey: 'f1065.p1.15|activity', providerKind: 'manual', schemaVersion: 1, sourceVersion: 'manual:interest@1' });
  const rec = { collections: [{ collectionKey: collectionKey('f1065.p1.15|activity', { returnType: 'form_1065', edition: 2025 }), oldCents: null, newCents: '10000', reason: 'books' }], relatedOutputs: [] };
  await assert.rejects(substituteProvider(pool, { ...S, returnId: ret, from: { providerKind: 'manual', sourceVersion: 'manual:interest@1' }, retire: ['f1065.p1.15|activity'], request: request(['f1065.p1.15|activity']),
    packet: named('f1065.p1.15|activity', 'stale-swap'), reviewedBy: 'tester', reconciliation: rec }), /earlier mapping/);
  assert.deepEqual((await pool.query('SELECT provider_kind FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret])).rows.map(r => r.provider_kind), ['manual']);
  // 3. A return with no bindings: an outside, an unmeasured and a malformed partition id are refused, nothing kept.
  const E = { orgId, entityId: await company(pool, orgId, 'Unbound Sample Partners') };
  const eRet = await period(pool, E, 2025, 'form_1065', { taxMethod: 'accrual' });
  const ref = id => [{ kind: 'books_partition', id, version: 'invented', normalization: 'as_posted' }];
  for (const [id, re] of [['999999999/999999999/activity', /books this return does not include/], [`${E.entityId}/999999999/activity`, /not a complete, permitted mapping/],
    [`0${E.entityId}/1/activity`, /not a books partition id/], ['books', /not a books partition id/]]) {
    await assert.rejects(assignPacket(pool, { ...E, returnId: eRet, request: requestOf(eRet)(['f1065.p1.13|activity']), packet: named('f1065.p1.13|activity', `outside-${id}`, ref(id)) }), re, id);
  }
  assert.equal(await liveCount(eRet), 0);
});
