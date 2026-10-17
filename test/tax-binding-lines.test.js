// test/tax-binding-lines.test.js — line attribution: once per line, at its current amount, consumed before the account's set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, lineOf, period, party } from './tax-t2-fixtures.js';
import { saveBindings, attributeLine, removeAttribution, listAttributions, listBindings } from '../lib/tax/bindings.js';
import { measureLines } from '../lib/tax/measure.js';

let t, pool, orgId, K, ret, draw, bank, owners, txns;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  K = { orgId, entityId: await company(pool, orgId, 'Kestrel Partners') };
  ret = await period(pool, K, 2025, 'form_1065', { taxMethod: 'accrual' });
  draw = await acct(pool, K, 'Owner’s Draw'); bank = await acct(pool, K, 'Checking');
  owners = [await party(pool, orgId, 'Ash Sample Partner'), await party(pool, orgId, 'Birch Sample Partner'), await party(pool, orgId, 'Cedar Sample Partner')];
  txns = [];
  for (const [i, cents] of [30000, 20000, 10000].entries()) txns.push(await je(pool, K, `2025-0${i + 2}-01`, [[draw, cents], [bank, -cents]]));
});
after(async () => { await t.db.drop(); });

// The transaction version the page shows for a line (measureLines txnVersion): an attribution names it.
const shownVersion = async (txnId, accountId) => ((await measureLines(pool, { orgId, sourceEntityId: K.entityId, accountIds: [accountId], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(accountId) ?? [])
  .find(l => l.txnId === Number(txnId))?.txnVersion ?? 'none';
const at = async (txnId, accountId, target, lineNo = null, expectTxnVersion = null) => attributeLine(pool, { ...K, returnId: ret, sourceEntityId: K.entityId, accountId, txnId,
  lineNo: lineNo ?? await lineOf(pool, txnId, accountId), expectTxnVersion: expectTxnVersion ?? await shownVersion(txnId, accountId), target, actor: 'tester' });
const draws = (owner, amount) => ({ treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: owner, amount });

test('a line is attributed once, at its current amount; lines of other accounts, system lines and wrong treatments are refused', async () => {
  const id = await at(txns[0], draw, { treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: owners[0] });
  const [l] = await listAttributions(pool, { ...K, returnId: ret });
  assert.deepEqual([l.binding_line_id, l.amount_text, l.treatment, l.interest_party_id, l.slot_key], [id, '30000', 'equity_event', owners[0], null]);
  assert.match(l.pending[0].reason, /not on file yet/, 'no owner interest on file: pending, never zero');
  assert.match(l.txn_version, /^[0-9a-f]{32}$/);
  await assert.rejects(at(txns[0], draw, { treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: owners[1] }), /already attributed/);
  await assert.rejects(at(txns[0], draw, { treatment: 'not_tax', memo: 'not ours' }, await lineOf(pool, txns[0], bank)), /does not post to this account/);
  await assert.rejects(at(txns[1], draw, { treatment: 'not_tax', memo: 'not ours' }, 0), /numbered transaction line/);
  await assert.rejects(at(txns[1], draw, { treatment: 'input', destination: 'f1065.p1.9' }), /balance-sheet account’s activity/);
});

test('precedence at write time: the account’s dollar split totals what the line attributions leave, and moves when they move', async () => {
  const save = rows => saveBindings(pool, { ...K, returnId: ret, sourceEntityId: K.entityId, accountId: draw, measurement: 'activity', split: 'amounts', rows, actor: 'tester' });
  await assert.rejects(save([draws(owners[1], '250.00'), draws(owners[2], '100.00')]), /total \$350\.00; the activity left after line attributions is \$300\.00/);
  await save([draws(owners[1], '200.00'), draws(owners[2], '100.00')]);
  assert.equal((await listBindings(pool, { ...K, returnId: ret })).filter(b => b.account_id === draw).length, 2);
  // Removing the attribution gives its line back to the account: the same split no longer totals the remainder.
  const [l] = await listAttributions(pool, { ...K, returnId: ret });
  await removeAttribution(pool, { ...K, returnId: ret, sourceEntityId: K.entityId, bindingLineId: l.binding_line_id });
  await assert.rejects(save([draws(owners[1], '200.00'), draws(owners[2], '100.00')]), /the activity left after line attributions is \$600\.00/);
  await assert.rejects(removeAttribution(pool, { ...K, returnId: ret, sourceEntityId: K.entityId, bindingLineId: l.binding_line_id }), /not on this period/);
});

test('an attribution is saved only for the transaction version the page showed (B5)', async () => {
  const shown = await shownVersion(txns[1], draw);
  // Someone edits the transaction's memo (same cents) after the page was shown.
  await je(pool, K, '2025-03-01', [[draw, 20000], [bank, -20000]], { memo: 'Edited after display', txnId: txns[1] });
  await assert.rejects(at(txns[1], draw, { treatment: 'not_tax', memo: 'Paid for the owner’s own car' }, null, shown), /changed since the page was shown/);
  await assert.rejects(attributeLine(pool, { ...K, returnId: ret, sourceEntityId: K.entityId, accountId: draw, txnId: txns[1], lineNo: await lineOf(pool, txns[1], draw), target: { treatment: 'not_tax', memo: 'x y z' }, actor: 'tester' }), /did not say which version/);
  await at(txns[1], draw, { treatment: 'not_tax', memo: 'Paid for the owner’s own car' });
});

test('on a cash-method return single lines are the cash layer’s to route (Codex r2 B3): refused; the account’s whole binding routes its cash', async () => {
  const Q = { orgId, entityId: await company(pool, orgId, 'Quail Cash Partners') };
  const qRet = await period(pool, Q, 2025, 'form_1065', { taxMethod: 'cash' });
  const qRent = await acct(pool, Q, 'Rent & Lease'), qBank = await acct(pool, Q, 'Checking');
  const txn = await je(pool, Q, '2025-03-01', [[qRent, 4000], [qBank, -4000]]);
  const [l] = (await measureLines(pool, { orgId, sourceEntityId: Q.entityId, accountIds: [qRent], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(qRent);
  await assert.rejects(attributeLine(pool, { ...Q, returnId: qRet, sourceEntityId: Q.entityId, accountId: qRent, txnId: txn, lineNo: l.lineNo, expectTxnVersion: l.txnVersion,
    target: { treatment: 'input', destination: 'f1065.p1.13' }, actor: 'tester' }), /routed by the cash layer/);
  await saveBindings(pool, { ...Q, returnId: qRet, sourceEntityId: Q.entityId, accountId: qRent, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.13' }], actor: 'tester' });
});
