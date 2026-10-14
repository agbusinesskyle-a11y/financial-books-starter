import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { getSummary } from '../lib/data/customers.js';
import { runReport } from '../lib/reports/engine.js';
import { startApp } from './app-harness.js';

// Stage C1: the customer page header and edit form match QBO — every customer field, sub-customers, opening balance,
// Make inactive / active, Merge contacts, the Recent/Name customer list and the credit-limit warning.
const TODAY = '2026-10-12';
let app, pool, scope;
before(async () => { app = await startApp(); pool = app.db.pool; scope = { orgId: app.ids.orgId, entityId: app.ids.entityId }; });
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const customer = id => one('SELECT * FROM customer WHERE customer_id = $1', [id]);
const fullForm = (over = {}) => {
  const p = new URLSearchParams({ displayName: 'Brazos Valley Ranch', companyName: 'Brazos Valley Ranch LLC', email: 'office@brazos.example',
    title: 'Ms.', firstName: 'Ana', middleName: 'Q', lastName: 'Ruiz', suffix: 'Jr.', cc: 'a@brazos.example, b@brazos.example', bcc: 'books@brazos.example',
    phone: '555-0100', mobile: '555-0101', fax: '555-0102', otherPhone: '555-0103', website: 'brazos.example', checkName: 'Brazos Valley Ranch LLC',
    creditLimit: '2,500.00', customerType: 'Ranch', invoiceLanguage: 'Spanish', source: 'Trade show', referredBy: 'Hilltop Dairy', jobTitle: 'Owner',
    contactRole: 'Buyer', preferredContact: 'mobile', industry: 'Cattle', emailMarketing: '1', shippingSameAsBilling: '1', active: '1', lateFeesEnabled: '1',
    preferredDelivery: 'email', ...over });
  p.append('addrLabel', 'North pasture'); p.append('addrLine1', '1 Gate Rd'); p.append('addrCity', 'Waco'); p.append('addrState', 'TX'); p.append('addrPostal', '76701');
  p.append('addrLabel', ''); p.append('addrLine1', ''); p.append('addrCity', ''); p.append('addrState', ''); p.append('addrPostal', '');
  p.append('socialNetwork', 'Facebook'); p.append('socialUrl', 'facebook.com/brazos');
  p.append('socialNetwork', ''); p.append('socialUrl', '');
  return p;
};

test('every QBO customer field saves and shows on Customer Details', async () => {
  const id = app.ids.customers.brazos;
  const res = await app.post(`/customers/${id}`, fullForm());
  assert.equal(res.status, 303);
  const c = await customer(id);
  assert.deepEqual([c.title, c.first_name, c.middle_name, c.last_name, c.suffix], ['Ms.', 'Ana', 'Q', 'Ruiz', 'Jr.']);
  assert.equal(c.cc, 'a@brazos.example, b@brazos.example');
  assert.equal(c.website, 'https://brazos.example', 'a bare domain gets https://');
  assert.equal(Number(c.credit_limit_cents), 250000);
  assert.equal(c.invoice_language, 'Spanish');
  assert.equal(c.preferred_contact, 'mobile');
  assert.equal(c.email_marketing, true);
  assert.deepEqual(c.other_addresses, [{ label: 'North pasture', line1: '1 Gate Rd', city: 'Waco', state: 'TX', postal: '76701' }], 'blank rows dropped');
  assert.deepEqual(c.social, [{ network: 'Facebook', url: 'https://facebook.com/brazos' }]);
  const details = await (await app.get(`/customers/${id}?tab=details`)).text();
  for (const s of ['Ms. Ana Q Ruiz Jr.', 'books@brazos.example', '555-0102', 'brazos.example', '$2,500.00', 'Ranch', 'Spanish', 'Trade show', 'Hilltop Dairy',
    'Mobile', 'Cattle', 'North pasture', 'Gave permission', 'Facebook']) assert.ok(details.includes(s), s);
  // The edit form shows them back.
  const form = await (await app.get(`/customers/${id}/edit`)).text();
  assert.match(form, /name="firstName" value="Ana"/);
  assert.match(form, /name="creditLimit" value="2500.00"/);
  assert.match(form, /<option value="Spanish" selected>/);
});

test('bad input is refused with the form kept', async () => {
  const id = app.ids.customers.brazos;
  for (const [over, msg] of [[{ cc: 'not-an-email' }, /Cc: “not-an-email” isn’t a valid email/], [{ creditLimit: 'lots' }, /Credit limit should be an amount/],
    [{ website: 'http://' }, /Enter a website/]]) {
    const res = await app.post(`/customers/${id}`, fullForm(over));
    assert.equal(res.status, 422);
    assert.match(await res.text(), msg);
  }
  // Older forms that don't send the new fields leave them alone.
  await app.post(`/customers/${id}`, { displayName: 'Brazos Valley Ranch', email: 'office@brazos.example', active: '1', shippingSameAsBilling: '1' });
  assert.equal((await customer(id)).first_name, 'Ana');
});

test('display name comes from the company or the person when left blank', async () => {
  let res = await app.post('/customers', fullForm({ displayName: '', companyName: '', firstName: 'Wade', lastName: 'Tull', title: '', middleName: '', suffix: '', cc: '', bcc: '' }));
  assert.equal(res.status, 303);
  const id = Number(/\/customers\/(\d+)/.exec(res.headers.get('location'))[1]);
  assert.equal((await customer(id)).display_name, 'Wade Tull');
  res = await app.post('/customers', fullForm({ displayName: '', companyName: 'Tull Hay', cc: '', bcc: '' }));
  assert.equal((await customer(Number(/\/customers\/(\d+)/.exec(res.headers.get('location'))[1]))).display_name, 'Tull Hay');
});

test('sub-customers: a parent from the list, never a loop', async () => {
  const parent = app.ids.customers.hilltop, child = app.ids.customers.brazos;
  assert.equal((await app.post(`/customers/${child}`, fullForm({ isSub: '1', parentCustomerId: String(parent) }))).status, 303);
  assert.equal(Number((await customer(child)).parent_customer_id), parent);
  assert.match(await (await app.get(`/customers/${child}?tab=details`)).text(), new RegExp(`href="/customers/${parent}">`));
  const loop = await app.post(`/customers/${parent}`, fullForm({ displayName: (await customer(parent)).display_name, isSub: '1', parentCustomerId: String(child) }));
  assert.equal(loop.status, 422);
  assert.match(await loop.text(), /can’t be under itself or one of its own sub-customers/);
  // Unticking "Is a sub-customer" clears the parent.
  await app.post(`/customers/${child}`, fullForm({ parentCustomerId: String(parent) }));
  assert.equal((await customer(child)).parent_customer_id, null);
});

test('opening balance: an invoice to Opening Balance Equity that the customer owes', async () => {
  const res = await app.post('/customers', fullForm({ displayName: 'Opening Co', companyName: '', cc: '', bcc: '', creditLimit: '', openingBalance: '1,250.00', openingAsOf: '2026-09-30' }));
  assert.equal(res.status, 303);
  const id = Number(/\/customers\/(\d+)/.exec(res.headers.get('location'))[1]);
  const inv = await one(`SELECT txn_id, type, total_cents, open_cents, txn_date::text AS d, system_kind FROM txn WHERE customer_id = $1`, [id]);
  assert.deepEqual([inv.type, Number(inv.total_cents), Number(inv.open_cents), inv.d, inv.system_kind], ['invoice', 125000, 125000, '2026-09-30', 'opening_balance']);
  const sys = await systemAccounts(pool, scope.orgId, scope.entityId);
  const posts = (await pool.query('SELECT account_id, amount_cents FROM posting WHERE txn_id = $1', [inv.txn_id])).rows.map(r => [Number(r.account_id), Number(r.amount_cents)]);
  assert.deepEqual(posts.sort(), [[sys.ar, 125000], [sys.opening_equity, -125000]].sort());
  assert.equal((await getSummary(pool, { orgId: scope.orgId, customerId: id, today: TODAY })).openCents, 125000);
  const bad = await app.post('/customers', fullForm({ displayName: 'Opening Two', companyName: '', cc: '', bcc: '', openingBalance: 'lots' }));
  assert.equal(bad.status, 422);
  assert.equal((await one(`SELECT count(*)::int AS n FROM customer WHERE display_name = 'Opening Two'`)).n, 0, 'nothing saved');
});

test('Edit ▾: make inactive and active again', async () => {
  const id = app.ids.customers.hilltop;
  const page = await (await app.get(`/customers/${id}`)).text();
  assert.match(page, /class="split-button"/);
  assert.match(page, />Make inactive</);
  assert.match(page, /href="\/customers\/\d+\/merge">Merge contacts/);
  await app.post(`/customers/${id}/active`, { active: '0' });
  assert.equal((await customer(id)).active, false);
  assert.match(await (await app.get(`/customers/${id}`)).text(), />Make active</);
  await app.post(`/customers/${id}/active`, { active: '1' });
  assert.equal((await customer(id)).active, true);
});

test('Merge contacts moves everything and keeps the books right', async () => {
  const from = app.ids.customers.brazos, into = app.ids.customers.hilltop;
  const before = await Promise.all([from, into].map(c => getSummary(pool, { orgId: scope.orgId, customerId: c, today: TODAY })));
  const n = (await one('SELECT count(*)::int AS n FROM txn WHERE customer_id = $1', [from])).n;
  assert.ok(n > 0);
  assert.equal((await app.post(`/customers/${from}/merge`, { into: String(from) })).status, 422, 'not into itself');
  const res = await app.post(`/customers/${from}/merge`, { into: String(into) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/customers/${into}`);
  assert.equal(await customer(from), undefined, 'the merged customer is gone');
  const after = await getSummary(pool, { orgId: scope.orgId, customerId: into, today: TODAY });
  assert.equal(after.openCents, before[0].openCents + before[1].openCents);
  assert.equal((await one('SELECT count(*)::int AS n FROM posting WHERE customer_id = $1', [from])).n, 0, 'postings follow');
  // The A/R report per customer still ties to the customer page.
  const [accounting, accounts, sys] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope), systemAccounts(pool, scope.orgId, scope.entityId)]);
  const aging = await runReport(pool, { ...scope, key: 'ar_aging_summary', query: { period: 'today', run: '1', customer: String(into) }, today: TODAY, accounting, accounts, retainedAccountId: sys.retained, sys });
  assert.equal(aging.rows.at(-1).values.at(-1), after.openCents);
});

test('customer list beside the page: + new, Recent or Name, collapse', async () => {
  const id = app.ids.customers.hilltop;
  const recent = await (await app.get(`/customers/${id}`)).text();
  assert.match(recent, /aria-label="Create a new customer"/);
  assert.match(recent, /data-collapse-side/);
  assert.match(recent, /Recently viewed/);
  const byName = await (await app.get(`/customers/${id}?side=name`)).text();
  assert.match(byName, /All customers/);
  const names = [...byName.matchAll(/<li class="[^"]*">\s*<a href="\/customers\/\d+\?side=name"><strong>([^<]+)<\/strong>/g)].map(m => m[1]);
  assert.ok(names.length > 5);
  assert.deepEqual(names, [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  for (const label of ['Send email', 'Call', 'Add note', 'Video call']) assert.match(recent, new RegExp(`aria-label="${label}"`), label);
});

test('saving an invoice over the credit limit warns but saves', async () => {
  const id = app.ids.customers.hilltop;
  const c = await customer(id);
  await pool.query('UPDATE customer SET credit_limit_cents = 100 WHERE customer_id = $1', [id]);
  const inv = new URLSearchParams({ type: 'invoice', customer_id: String(id), txn_date: TODAY });
  inv.append('line_item', ''); inv.append('line_desc', 'Mineral'); inv.append('line_qty', '1'); inv.append('line_rate', '50');
  const res = await app.post('/txns', inv);
  assert.equal(res.status, 303);
  const page = await (await app.get(res.headers.get('location'))).text();
  assert.match(page, /over their \$1\.00 credit limit/);
  await pool.query('UPDATE customer SET credit_limit_cents = $2 WHERE customer_id = $1', [id, c.credit_limit_cents]);
});
