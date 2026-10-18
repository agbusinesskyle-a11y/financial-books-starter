// test/tax-t3-fixtures.js — sample books and helpers for the Tax Books T3 tests. Sample names only. Not a test file.
// Documents (invoices, payments, bills, deposits) are written by SQL with their postings and applications, the way the T2 tests do, so a
// test states every posting it relies on; journal entries go through the app (lib/data/ledger-tools.js).
import { saveBindings } from '../lib/tax/bindings.js';
export { t2Db, company, acct, je, lineOf, period, activity } from './tax-t2-fixtures.js';

export const bind = (pool, C, ret, accountId, measurement, rows, extra = {}) => saveBindings(pool, { ...C, returnId: ret, sourceEntityId: C.entityId, accountId, measurement, rows, actor: 'tester', ...extra });
// Bind a balance account's beginning and ending balances to one line.
export async function bindBalance(pool, C, ret, accountId, destination, treatment = 'input') {
  for (const m of ['begin', 'end']) await bind(pool, C, ret, accountId, m, [{ treatment, destination }]);
}
// The engine arrives in Task 8; imported when first used, so the earlier tasks' tests load without it.
export const compute = async (pool, C, ret) => (await import('../lib/tax/engine/compute.js')).computeReturn(pool, { ...C, returnId: ret });
// The value of one collection key in a computed result (exact BigInt cents, or null when unknown).
export const valueOf = (r, key) => { const v = r.values.get(key); return v === undefined ? undefined : v.cents; };
export const errorsOf = (r, code) => r.checks.filter(c => c.level === 'error' && (!code || c.code === code));

async function sys(pool, C, key) {
  const { rows: [a] } = await pool.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND system_key = $3', [C.orgId, C.entityId, key]);
  return Number(a.account_id);
}
async function inTxn(pool, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function party(c, C, kind) {
  const table = kind === 'customer' ? 'customer' : 'vendor';
  const { rows: [x] } = await c.query(`SELECT ${table}_id AS id FROM ${table} WHERE org_id = $1 AND entity_id = $2 AND display_name = $3`, [C.orgId, C.entityId, `Sample ${kind}`]);
  if (x) return x.id;
  const { rows: [y] } = await c.query(`INSERT INTO ${table} (org_id, entity_id, display_name) VALUES ($1,$2,$3) RETURNING ${table}_id AS id`, [C.orgId, C.entityId, `Sample ${kind}`]);
  return y.id;
}
const post = (c, C, txnId, date, legs) => Promise.all(legs.map(([accountId, cents], i) => c.query(
  'INSERT INTO posting (org_id, entity_id, txn_id, line_no, account_id, amount_cents, txn_date) VALUES ($1,$2,$3,$4,$5,$6,$7)', [C.orgId, C.entityId, txnId, i + 1, accountId, String(cents), date])));
// An invoice: A/R debit, each income line a credit. lines: [[incomeAccountId, cents], ...]. Returns the txn id.
export async function invoice(pool, C, date, lines, { doc = null } = {}) {
  const ar = await sys(pool, C, 'ar'), total = lines.reduce((t, [, c]) => t + c, 0);
  return inTxn(pool, async c => {
    const cust = await party(c, C, 'customer');
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, customer_id, type, doc_number, txn_date, due_date, total_cents, open_cents) VALUES ($1,$2,$3,'invoice',$4,$5,$5,$6,0) RETURNING txn_id`,
      [C.orgId, C.entityId, cust, doc, date, total]);
    await post(c, C, t.txn_id, date, [[ar, total], ...lines.map(([a, x]) => [a, -x])]);
    return Number(t.txn_id);
  });
}
// A customer payment into a bank account (A/R credit), optionally applied to invoices: applications [[invoiceId, cents, appliedOn]].
export async function payment(pool, C, date, cents, bank, applications = []) {
  const ar = await sys(pool, C, 'ar');
  return inTxn(pool, async c => {
    const cust = await party(c, C, 'customer');
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, total_cents, open_cents, account_id) VALUES ($1,$2,$3,'payment',$4,$5,0,$6) RETURNING txn_id`,
      [C.orgId, C.entityId, cust, date, cents, bank]);
    await post(c, C, t.txn_id, date, [[bank, cents], [ar, -cents]]);
    for (const [inv, x, on] of applications) await c.query('INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1,$2,$3,$4,$5)', [C.orgId, t.txn_id, inv, x, on]);
    return Number(t.txn_id);
  });
}
export async function apply(pool, C, creditId, chargeId, cents, on) {
  await pool.query('INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1,$2,$3,$4,$5)', [C.orgId, creditId, chargeId, cents, on]);
}
// A credit memo (income debit, A/R credit).
export async function creditMemo(pool, C, date, lines) {
  const ar = await sys(pool, C, 'ar'), total = lines.reduce((t, [, c]) => t + c, 0);
  return inTxn(pool, async c => {
    const cust = await party(c, C, 'customer');
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, total_cents, open_cents) VALUES ($1,$2,$3,'credit_memo',$4,$5,0) RETURNING txn_id`, [C.orgId, C.entityId, cust, date, total]);
    await post(c, C, t.txn_id, date, [...lines.map(([a, x]) => [a, x]), [ar, -total]]);
    return Number(t.txn_id);
  });
}
// A bill: each cost line a debit (an expense or an inventory account), A/P credit.
export async function bill(pool, C, date, lines) {
  const ap = await sys(pool, C, 'ap'), total = lines.reduce((t, [, c]) => t + c, 0);
  return inTxn(pool, async c => {
    const v = await party(c, C, 'vendor');
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, vendor_id, type, txn_date, due_date, total_cents, open_cents, approval_status) VALUES ($1,$2,$3,'bill',$4,$4,$5,0,'approved') RETURNING txn_id`, [C.orgId, C.entityId, v, date, total]);
    await post(c, C, t.txn_id, date, [...lines.map(([a, x]) => [a, x]), [ap, -total]]);
    return Number(t.txn_id);
  });
}
// A bill payment from a bank or card account, applied to bills: [[billId, cents, appliedOn]].
export async function billPayment(pool, C, date, cents, from, applications = []) {
  const ap = await sys(pool, C, 'ap');
  return inTxn(pool, async c => {
    const v = await party(c, C, 'vendor');
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, vendor_id, type, txn_date, total_cents, open_cents, account_id) VALUES ($1,$2,$3,'bill_payment',$4,$5,0,$6) RETURNING txn_id`,
      [C.orgId, C.entityId, v, date, cents, from]);
    await post(c, C, t.txn_id, date, [[ap, cents], [from, -cents]]);
    for (const [b, x, on] of applications) await c.query('INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1,$2,$3,$4,$5)', [C.orgId, t.txn_id, b, x, on]);
    return Number(t.txn_id);
  });
}
// An expense paid from a bank or card account: cost lines debited, the account credited.
export async function expense(pool, C, date, from, lines) {
  const total = lines.reduce((t, [, c]) => t + c, 0);
  return inTxn(pool, async c => {
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, type, txn_date, total_cents, open_cents, account_id) VALUES ($1,$2,'expense',$3,$4,0,$5) RETURNING txn_id`, [C.orgId, C.entityId, date, total, from]);
    await post(c, C, t.txn_id, date, [...lines, [from, -total]]);
    return Number(t.txn_id);
  });
}
// A bank deposit whose lines credit accounts directly (a merchant settlement to income).
export async function deposit(pool, C, date, bank, lines) {
  const total = lines.reduce((t, [, c]) => t + c, 0);
  return inTxn(pool, async c => {
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, type, txn_date, total_cents, open_cents, account_id) VALUES ($1,$2,'deposit',$3,$4,0,$5) RETURNING txn_id`, [C.orgId, C.entityId, date, total, bank]);
    await post(c, C, t.txn_id, date, [[bank, total], ...lines.map(([a, x]) => [a, -x])]);
    return Number(t.txn_id);
  });
}
// A card-liability repayment (bank to card).
export async function cardPayment(pool, C, date, bank, card, cents) {
  return inTxn(pool, async c => {
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, type, txn_date, total_cents, open_cents, account_id, to_account_id) VALUES ($1,$2,'cc_payment',$3,$4,0,$5,$6) RETURNING txn_id`, [C.orgId, C.entityId, date, cents, bank, card]);
    await post(c, C, t.txn_id, date, [[card, cents], [bank, -cents]]);
    return Number(t.txn_id);
  });
}
// Answer what the books never say: no K-1s received, and every typed item not entered marked not applicable (one person's act).
export async function answerTypedItems(pool, C, ret, { except = [] } = {}) {
  const { saveManualItem, markRemainingNotApplicable, manualNeeds, K1_ANSWER } = await import('../lib/tax/manual.js');
  const { rows: [r] } = await pool.query(`SELECT return_id, entity_id, return_type, form_edition, period_start::text AS period_start, period_end::text AS period_end FROM tax_return WHERE return_id = $1`, [ret]);
  const S = { ...C, returnId: ret };
  await saveManualItem(pool, { ...S, itemKey: K1_ANSWER, status: 'not_applicable', enteredBy: 'tester' });
  const needs = await manualNeeds(pool, { orgId: C.orgId, ret: { ...r, return_id: Number(r.return_id), entity_id: Number(r.entity_id), form_edition: Number(r.form_edition) } });
  await markRemainingNotApplicable(pool, { ...S, keys: needs.map(n => n.key).filter(k => !except.includes(k)), enteredBy: 'tester' });
}
// A journal entry written by SQL, as an import can leave one (on A/R or A/P, which the app's own form refuses), optionally numbered.
export async function importedJe(pool, C, date, legs, { doc = null } = {}) {
  const total = legs.reduce((t, [, c]) => t + (c > 0 ? c : 0), 0);
  return inTxn(pool, async c => {
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, type, doc_number, txn_date, total_cents, open_cents) VALUES ($1,$2,'journal_entry',$3,$4,$5,0) RETURNING txn_id`, [C.orgId, C.entityId, doc, date, total]);
    await post(c, C, t.txn_id, date, legs);
    return Number(t.txn_id);
  });
}
// Any transaction with exactly these legs (debits positive), written by SQL: an invoice that also relieves inventory, an inventory
// adjustment, a vendor credit. type decides the party the row needs.
export async function rawTxn(pool, C, type, date, legs, { total = null, accountId = null } = {}) {
  const sum = total ?? legs.reduce((t, [, c]) => t + (c > 0 ? c : 0), 0);
  return inTxn(pool, async c => {
    const cust = ['invoice', 'payment', 'sales_receipt', 'credit_memo'].includes(type) ? await party(c, C, 'customer') : null;
    const vend = ['bill', 'bill_payment', 'vendor_credit', 'item_receipt'].includes(type) ? await party(c, C, 'vendor') : null;
    const { rows: [t] } = await c.query(`INSERT INTO txn (org_id, entity_id, customer_id, vendor_id, type, txn_date, due_date, total_cents, open_cents, approval_status, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10) RETURNING txn_id`,
      [C.orgId, C.entityId, cust, vend, type, date, ['invoice', 'bill'].includes(type) ? date : null, sum, type === 'bill' ? 'approved' : null, accountId]);
    await post(c, C, t.txn_id, date, legs);
    return Number(t.txn_id);
  });
}
// A predecessor's filed Schedule L, complete: the given facts ([fieldId, cents, rowKey?]) and an explicit zero for every other balance line
// of the form, the per-owner lines included (a baseline that omits a line leaves it unknown, never zero).
export async function scheduleLFacts(returnType, given) {
  const { catalogFor } = await import('../lib/tax/catalog/index.js');
  const lines = catalogFor(returnType, 2025).lines.filter(l => l.cls === 'balance' && l.kind !== 'computed' && l.id.includes('.L.'));
  return [...given, ...lines.filter(l => !given.some(([id]) => id === l.id)).map(l => [l.id, 0])];
}
