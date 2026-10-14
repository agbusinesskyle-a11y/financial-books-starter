import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { getSummary } from '../lib/data/customers.js';
import { getTransaction } from '../lib/data/transactions.js';
import {
  ValidationError, saveSalesDoc, savePayment, applyCredit, voidTxn, deleteTxn, saveCustomer,
  listOpenCharges, listOpenCredits, listItems, listTerms,
} from '../lib/data/writes.js';

const TODAY = '2026-10-12';
let db, ids, scope, newCustomer;
const actor = 'tester';

before(async () => {
  db = await freshDb();
  ids = await writeSample(db.pool, generateSample({ asOf: TODAY }));
  scope = { orgId: ids.orgId, entityId: ids.entityId };
  // A clean customer so balances in these tests start from zero.
  newCustomer = await saveCustomer(db.pool, { ...scope, actor, fields: { displayName: 'Test Ranch', email: 'test@ranch.example', isNew: true, lateFeesEnabled: true, active: true } });
});
after(async () => { await db.drop(); });

const summary = () => getSummary(db.pool, { orgId: ids.orgId, customerId: newCustomer, today: TODAY });
const txn = id => getTransaction(db.pool, { orgId: ids.orgId, id });
const invoice = (lines, extra = {}) => saveSalesDoc(db.pool, { ...scope, actor, customerId: newCustomer, type: 'invoice', txnDate: '2026-10-01', lines, ...extra });
const isValidation = re => err => err instanceof ValidationError && re.test(err.message);

test('reads for the forms', async () => {
  const items = await listItems(db.pool, scope);
  assert.ok(items.length >= 5 && items.every(i => i.kind !== 'system'));
  const terms = await listTerms(db.pool, scope);
  assert.deepEqual(terms.map(t => t.name), ['Due on receipt', 'Net 15', 'Net 30']);
});

test('invoice: totals, auto number, due date from terms, activity', async () => {
  const [item] = await listItems(db.pool, scope);
  const net30 = (await listTerms(db.pool, scope)).find(t => t.name === 'Net 30');
  const id = await invoice([
    { itemId: String(item.item_id), quantity: '2.5', rate: '' },        // rate from the item
    { description: 'Custom work', quantity: '1', rate: '100.00' },
    { itemId: '', description: '', quantity: '', rate: '' },           // blank row ignored
  ], { termsId: net30.terms_id });
  const t = await txn(id);
  assert.equal(t.lines.length, 2);
  assert.equal(t.total_cents, Math.round(2.5 * item.rate_cents) + 10000);
  assert.equal(t.open_cents, t.total_cents);
  assert.equal(t.due_date, '2026-10-31');
  assert.match(t.doc_number, /^INV-\d{4}$/);
  assert.deepEqual(await summary(), { openCents: t.total_cents, overdueCents: 0 });
  const ev = await db.pool.query(`SELECT kind FROM activity_event WHERE txn_id = $1`, [id]);
  assert.deepEqual(ev.rows.map(r => r.kind), ['invoice_created']);
});

test('invoice validation', async () => {
  await assert.rejects(invoice([]), isValidation(/at least one line/));
  await assert.rejects(invoice([{ description: 'x', quantity: '0', rate: '5' }]), isValidation(/Line 1: quantity/));
  await assert.rejects(invoice([{ description: 'x', quantity: '1', rate: '-5' }]), isValidation(/Line 1: rate/));
  await assert.rejects(invoice([{ itemId: '999999', quantity: '1', rate: '5' }]), isValidation(/product or service/));
  await assert.rejects(invoice([{ description: 'x', quantity: '1', rate: '5' }], { dueDate: '2026-09-01' }), isValidation(/due date/));
  await assert.rejects(invoice([{ description: 'x', quantity: '1', rate: '0' }]), isValidation(/more than \$0.00/));
  const id = await invoice([{ description: 'x', quantity: '1', rate: '5' }], { docNumber: 'CUSTOM-1' });
  assert.equal((await txn(id)).doc_number, 'CUSTOM-1');
  await assert.rejects(invoice([{ description: 'x', quantity: '1', rate: '5' }], { docNumber: 'CUSTOM-1' }), isValidation(/already used/));
});

test('payment applies to invoices; overpayment stays unapplied; over-applying rejected', async () => {
  const a = await invoice([{ description: 'A', quantity: '1', rate: '300' }], { dueDate: '2026-10-05' });
  const b = await invoice([{ description: 'B', quantity: '1', rate: '200' }], { dueDate: '2026-10-20' });
  const before = await summary();
  await assert.rejects(savePayment(db.pool, { ...scope, actor, customerId: newCustomer, txnDate: TODAY, amountCents: 100,
    applications: [{ chargeTxnId: a, amountCents: 200 }] }), isValidation(/only received/));
  await assert.rejects(savePayment(db.pool, { ...scope, actor, customerId: newCustomer, txnDate: TODAY, amountCents: 50000,
    applications: [{ chargeTxnId: a, amountCents: 40000 }] }), isValidation(/only has \$300.00 open/));
  const pay = await savePayment(db.pool, { ...scope, actor, customerId: newCustomer, txnDate: TODAY, amountCents: 60000, paymentMethod: 'Check', paymentRef: 'Check 1',
    applications: [{ chargeTxnId: a, amountCents: 30000 }, { chargeTxnId: b, amountCents: 20000 }] });
  assert.equal((await txn(a)).open_cents, 0);
  assert.equal((await txn(b)).open_cents, 0);
  assert.equal((await txn(pay)).open_cents, 10000);
  const after = await summary();
  assert.equal(after.openCents, before.openCents - 60000);
  // Editing the payment replaces its applications.
  await savePayment(db.pool, { ...scope, actor, txnId: pay, customerId: newCustomer, txnDate: TODAY, amountCents: 30000,
    applications: [{ chargeTxnId: a, amountCents: 30000 }] });
  assert.equal((await txn(a)).open_cents, 0);
  assert.equal((await txn(b)).open_cents, 20000);
  assert.equal((await txn(pay)).open_cents, 0);
  const charges = await listOpenCharges(db.pool, { orgId: ids.orgId, customerId: newCustomer, paymentTxnId: pay });
  assert.equal(charges.find(c => c.txn_id === a).applied_cents, 30000);
  assert.equal(charges.find(c => c.txn_id === a).open_cents, 30000);
});

test('cannot apply to another customer’s invoice', async () => {
  const theirs = (await db.pool.query(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND open_cents > 0 LIMIT 1`, [ids.customers.redriver])).rows[0].txn_id;
  await assert.rejects(savePayment(db.pool, { ...scope, actor, customerId: newCustomer, txnDate: TODAY, amountCents: 100,
    applications: [{ chargeTxnId: theirs, amountCents: 100 }] }), isValidation(/different customer/));
});

test('editing an invoice below its applied amount is rejected', async () => {
  const inv = await invoice([{ description: 'C', quantity: '1', rate: '100' }]);
  await savePayment(db.pool, { ...scope, actor, customerId: newCustomer, txnDate: TODAY, amountCents: 8000, applications: [{ chargeTxnId: inv, amountCents: 8000 }] });
  await assert.rejects(invoice([{ description: 'C', quantity: '1', rate: '50' }], { txnId: inv }), isValidation(/already applied/));
  await invoice([{ description: 'C', quantity: '2', rate: '100' }], { txnId: inv });
  const t = await txn(inv);
  assert.equal(t.total_cents, 20000);
  assert.equal(t.open_cents, 12000);
});

test('credit memo applies to an invoice', async () => {
  const inv = await invoice([{ description: 'D', quantity: '1', rate: '75' }]);
  const cm = await saveSalesDoc(db.pool, { ...scope, actor, customerId: newCustomer, type: 'credit_memo', txnDate: TODAY, lines: [{ description: 'Return', quantity: '1', rate: '25' }] });
  assert.ok((await listOpenCredits(db.pool, { orgId: ids.orgId, customerId: newCustomer })).some(c => c.txn_id === cm));
  await assert.rejects(applyCredit(db.pool, { ...scope, actor, creditTxnId: cm, appliedOn: TODAY, applications: [{ chargeTxnId: inv, amountCents: 3000 }] }), isValidation(/Only \$25.00/));
  await applyCredit(db.pool, { ...scope, actor, creditTxnId: cm, appliedOn: TODAY, applications: [{ chargeTxnId: inv, amountCents: 2500 }] });
  assert.equal((await txn(cm)).open_cents, 0);
  assert.equal((await txn(inv)).open_cents, 5000);
});

test('sales receipt is paid on creation', async () => {
  const before = await summary();
  const sr = await saveSalesDoc(db.pool, { ...scope, actor, customerId: newCustomer, type: 'sales_receipt', txnDate: TODAY, paymentMethod: 'Cash',
    lines: [{ description: 'Counter sale', quantity: '3', rate: '10' }] });
  const t = await txn(sr);
  assert.equal(t.total_cents, 3000);
  assert.equal(t.open_cents, 0);
  assert.match(t.doc_number, /^SR-/);
  assert.deepEqual(await summary(), before);
});

test('void restores the other side, keeps lines, and locks the transaction', async () => {
  const inv = await invoice([{ description: 'E', quantity: '1', rate: '40' }]);
  const pay = await savePayment(db.pool, { ...scope, actor, customerId: newCustomer, txnDate: TODAY, amountCents: 4000, applications: [{ chargeTxnId: inv, amountCents: 4000 }] });
  await voidTxn(db.pool, { ...scope, actor, txnId: pay });
  assert.equal((await txn(inv)).open_cents, 4000);
  const voided = await txn(pay);
  assert.ok(voided.voided_at);
  assert.equal(voided.total_cents, 0);
  await assert.rejects(voidTxn(db.pool, { ...scope, actor, txnId: pay }), isValidation(/already voided/));
  await voidTxn(db.pool, { ...scope, actor, txnId: inv });
  const vi = await txn(inv);
  assert.equal(vi.lines.length, 1);
  await assert.rejects(invoice([{ description: 'E', quantity: '1', rate: '40' }], { txnId: inv }), isValidation(/voided/));
});

test('deleting an applied payment reopens the invoice; deleting a paid invoice frees its payment (as QBO)', async () => {
  const inv = await invoice([{ description: 'F', quantity: '1', rate: '10' }]);
  const pay = await savePayment(db.pool, { ...scope, actor, customerId: newCustomer, txnDate: TODAY, amountCents: 1000, applications: [{ chargeTxnId: inv, amountCents: 1000 }] });
  await deleteTxn(db.pool, { ...scope, actor, txnId: pay });
  assert.equal(await txn(pay), null);
  assert.equal((await txn(inv)).open_cents, 1000, 'invoice open again');
  const pay2 = await savePayment(db.pool, { ...scope, actor, customerId: newCustomer, txnDate: TODAY, amountCents: 1000, applications: [{ chargeTxnId: inv, amountCents: 1000 }] });
  await deleteTxn(db.pool, { ...scope, actor, txnId: inv });
  assert.equal(await txn(inv), null);
  assert.equal((await txn(pay2)).open_cents, 1000, 'payment is an unapplied credit');
  await deleteTxn(db.pool, { ...scope, actor, txnId: pay2 });
  const ev = await db.pool.query(`SELECT summary FROM activity_event WHERE kind = 'txn_deleted' AND customer_id = $1`, [newCustomer]);
  assert.equal(ev.rowCount, 3);
});

test('customers: create, edit, duplicate name', async () => {
  const id = await saveCustomer(db.pool, { ...scope, actor, fields: { displayName: 'Another Co', email: 'a@b.example', billingLine1: '1 Main', billingCity: 'Krum', billingState: 'TX', shippingSameAsBilling: true, isNew: true, active: true } });
  await assert.rejects(saveCustomer(db.pool, { ...scope, actor, fields: { displayName: 'Another Co', isNew: true } }), isValidation(/already exists/));
  await assert.rejects(saveCustomer(db.pool, { ...scope, actor, fields: { displayName: '   ' } }), isValidation(/display name/));
  await assert.rejects(saveCustomer(db.pool, { ...scope, actor, fields: { displayName: 'X', email: 'nope' } }), isValidation(/email/));
  await saveCustomer(db.pool, { ...scope, actor, customerId: id, fields: { displayName: 'Another Co LLC', phone: '(940) 555-0000', active: false } });
  const { rows } = await db.pool.query('SELECT display_name, phone, active, billing_address FROM customer WHERE customer_id = $1', [id]);
  assert.deepEqual(rows[0], { display_name: 'Another Co LLC', phone: '(940) 555-0000', active: false, billing_address: null });
});
