import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck } from '../lib/data/ledger.js';
import { runDailyJobs } from '../services/jobs/index.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
const KEY = 'cd'.repeat(32);
const at = date => () => new Date(`${date}T17:00:00Z`);

let app, scope;
before(async () => {
  app = await startApp({ env: { SETTINGS_KEY: KEY } });
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

const jobs = date => runDailyJobs({ pool: app.db.pool, env: {}, now: at(date) });
const created = res => Number(/\/vtxns\/(\d+)/.exec(res.headers.get('location'))[1]);
const template = (vendor, fields, cats) => {
  const p = new URLSearchParams(fields);
  for (const c of cats) { p.append('cat_account', String(c.account)); p.append('cat_desc', c.desc ?? ''); p.append('cat_amount', c.amount); p.append('cat_job', ''); p.append('cat_po', ''); }
  return app.post(`/vendors/${vendor}/recurring`, p);
};

test('recurring rent check: created on schedule with the next check number, once per date, catching up', async () => {
  const landlord = app.ids.vendors.landlord;
  assert.equal((await app.get(`/vendors/${landlord}/recurring/new`)).status, 200);
  const res = await template(landlord, { name: 'Warehouse rent', txnType: 'check', mode: 'scheduled', unit: 'month', count: '1', startDate: '2026-10-15',
    accountId: String(app.ids.accounts.checking) }, [{ account: app.ids.accounts.rent, amount: '3500.00', desc: 'Rent' }]);
  assert.equal(res.status, 303);
  const tab = await (await app.get(`/vendors/${landlord}?tab=recurring`)).text();
  assert.match(tab, /Warehouse rent/);
  assert.match(tab, /10\/15\/26/);

  const before = (await app.db.pool.query(`SELECT count(*)::int AS n FROM txn WHERE vendor_id = $1 AND type = 'check'`, [landlord])).rows[0].n;
  await jobs('2026-10-14');
  assert.equal((await app.db.pool.query(`SELECT count(*)::int AS n FROM txn WHERE vendor_id = $1 AND type = 'check'`, [landlord])).rows[0].n, before);
  await jobs('2026-12-20'); // Oct 15, Nov 15, Dec 15
  await jobs('2026-12-20'); // again: nothing new
  const made = (await app.db.pool.query(
    `SELECT txn_date, doc_number, total_cents FROM txn WHERE vendor_id = $1 AND type = 'check' AND recurring_template_id IS NOT NULL ORDER BY txn_date`, [landlord])).rows;
  assert.deepEqual(made.map(r => r.txn_date), ['2026-10-15', '2026-11-15', '2026-12-15']);
  assert.ok(made.every(r => r.total_cents === 350000 && /^\d+$/.test(r.doc_number)));
  assert.equal(new Set(made.map(r => r.doc_number)).size, 3, 'each check gets its own number');
  assert.match(await (await app.get(`/vendors/${landlord}?tab=activity`)).text(), /from recurring template “Warehouse rent”/);
});

test('recurring bill waits for approval; reminder templates only remind; use, pause, delete', async () => {
  const electric = app.ids.vendors.electric;
  await template(electric, { name: 'Electric', txnType: 'bill', mode: 'scheduled', unit: 'month', count: '1', startDate: '2026-10-20' },
    [{ account: app.ids.accounts.utilities, amount: '780.00' }]);
  await template(electric, { name: 'Meter check', txnType: 'expense', mode: 'reminder', unit: 'week', count: '2', startDate: '2026-10-13',
    accountId: String(app.ids.accounts.card) }, [{ account: app.ids.accounts.utilities, amount: '25.00' }]);
  await jobs('2026-10-21');
  const bill = (await app.db.pool.query(`SELECT approval_status, total_cents FROM txn WHERE vendor_id = $1 AND type = 'bill' AND recurring_template_id IS NOT NULL`, [electric])).rows;
  assert.deepEqual(bill, [{ approval_status: 'awaiting', total_cents: 78000 }]);
  assert.equal((await app.db.pool.query(`SELECT count(*)::int AS n FROM txn WHERE vendor_id = $1 AND type = 'expense'`, [electric])).rows[0].n, 0);
  assert.match(await (await app.get(`/vendors/${electric}?tab=activity`)).text(), /Reminder: create the expense from recurring template “Meter check”/);

  const ids = (await app.db.pool.query('SELECT template_id, name FROM recurring_template WHERE vendor_id = $1 ORDER BY name', [electric])).rows;
  const meter = ids.find(r => r.name === 'Meter check').template_id;
  const use = await (await app.get(`/vtxns/new?template=${meter}`)).text();
  assert.match(use, /New expense/);
  assert.match(use, /value="25\.00"/);
  assert.equal((await app.post(`/vrecurring/${meter}/pause`)).status, 303);
  assert.match(await (await app.get(`/vendors/${electric}?tab=recurring`)).text(), /Paused/);
  assert.equal((await app.get(`/vrecurring/${meter}`)).status, 200);
  assert.equal((await app.post(`/vrecurring/${meter}/delete`)).status, 303);
  const dupe = await template(electric, { name: 'Electric', txnType: 'bill', mode: 'unscheduled' }, [{ account: app.ids.accounts.utilities, amount: '1.00' }]);
  assert.equal(dupe.status, 422);
});

test('scheduled payment: the daily job pays the bill on its date; paying by hand clears the schedule', async () => {
  const mill = app.ids.vendors.mill;
  const mk = async amount => {
    const p = new URLSearchParams({ type: 'bill', vendor_id: String(mill), txn_date: TODAY });
    p.append('cat_account', String(app.ids.accounts.feed_purchases)); p.append('cat_desc', ''); p.append('cat_amount', amount); p.append('cat_job', ''); p.append('cat_po', '');
    const id = created(await app.post('/vtxns', p));
    return id;
  };
  const bill = await mk('900.00');
  const early = await app.post(`/vtxns/${bill}/schedule`, { pay_date: '2026-10-20', account_id: String(app.ids.accounts.checking), method: 'ACH' });
  assert.match(await (await app.get(early.headers.get('location'))).text(), /Approve the bill before scheduling/);
  await app.post(`/vtxns/${bill}/approve`);
  assert.equal((await app.post(`/vtxns/${bill}/schedule`, { pay_date: '2026-10-01', account_id: String(app.ids.accounts.checking), method: 'ACH' })).headers.get('location'), `/vtxns/${bill}`);
  assert.equal((await app.db.pool.query('SELECT scheduled_pay_date FROM txn WHERE txn_id = $1', [bill])).rows[0].scheduled_pay_date, null, 'a past date is refused');
  await app.post(`/vtxns/${bill}/schedule`, { pay_date: '2026-10-20', account_id: String(app.ids.accounts.checking), method: 'ACH' });
  assert.match(await (await app.get(`/vtxns/${bill}`)).text(), /scheduled for 10\/20\/26/);
  assert.match(await (await app.get(`/vendors/${mill}?tab=transactions&type=open_bills`)).text(), /Payment scheduled 10\/20/);

  await jobs('2026-10-19');
  assert.equal((await app.db.pool.query('SELECT open_cents FROM txn WHERE txn_id = $1', [bill])).rows[0].open_cents, 90000);
  const summary = await jobs('2026-10-22');
  assert.equal(summary.billsPaid, 1);
  const after = (await app.db.pool.query('SELECT open_cents, scheduled_pay_date FROM txn WHERE txn_id = $1', [bill])).rows[0];
  assert.deepEqual(after, { open_cents: 0, scheduled_pay_date: null });
  const pay = (await app.db.pool.query(`SELECT p.txn_date, p.payment_method FROM application a JOIN txn p ON p.txn_id = a.credit_txn_id WHERE a.charge_txn_id = $1`, [bill])).rows[0];
  assert.deepEqual(pay, { txn_date: '2026-10-20', payment_method: 'ACH' }, 'paid on the scheduled day');

  const second = await mk('100.00');
  await app.post(`/vtxns/${second}/approve`);
  await app.post(`/vtxns/${second}/schedule`, { pay_date: '2026-11-01', account_id: String(app.ids.accounts.checking), method: 'Check' });
  await app.post('/pay-bills', { account_id: String(app.ids.accounts.checking), txn_date: TODAY, method: 'ACH', bill: String(second), [`pay_${second}`]: '100.00' });
  assert.equal((await app.db.pool.query('SELECT scheduled_pay_date FROM txn WHERE txn_id = $1', [second])).rows[0].scheduled_pay_date, null);
  assert.equal((await jobs('2026-11-02')).billsPaid, 0);

  const third = await mk('50.00');
  await app.post(`/vtxns/${third}/approve`);
  await app.post(`/vtxns/${third}/schedule`, { pay_date: '2026-11-05', account_id: String(app.ids.accounts.checking), method: 'ACH' });
  assert.equal((await app.post(`/vtxns/${third}/unschedule`)).status, 303);
  assert.equal((await app.db.pool.query('SELECT scheduled_pay_date FROM txn WHERE txn_id = $1', [third])).rows[0].scheduled_pay_date, null);
});

test('ask vendor for info: single-use public link, encrypted submission, accept field by field', async () => {
  const v = app.ids.vendors.trucking;
  const ask = await app.post(`/vendors/${v}/ask`);
  assert.equal(ask.status, 200);
  const page = await ask.text();
  const link = /value="(http:\/\/[^"]+\/vendor-info\/([A-Za-z0-9_-]{43}))"/.exec(page);
  assert.ok(link, 'the page shows the link to copy');
  const path = new URL(link[1]).pathname;
  assert.match(page, /Recorded as sent/);
  assert.match(await (await app.get(`/vendors/${v}`)).text(), /Waiting for Cross Plains Trucking to fill in their details/);

  // The vendor, with no account.
  const form = await fetch(app.base + path);
  assert.equal(form.status, 200);
  const cookie = form.headers.getSetCookie()[0].split(';')[0];
  const nonce = /name="nonce" value="([^"]+)"/.exec(await form.text())[1];
  const post = (body, withCookie = true) => fetch(app.base + path, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(withCookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
  assert.equal((await post({ nonce, company: 'X' }, false)).status, 403, 'needs the form cookie');
  const bad = await post({ nonce, taxId: '12-34' });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /9-digit EIN/);
  const ok = await post({ nonce, company: 'Cross Plains Trucking LLC', line1: '3300 County Rd 210', city: 'Muenster', state: 'TX', postal: '76252',
    taxId: '75-1234567', bankRouting: '111000025', bankAccount: '000123456789', bankAccount2: '000123456789' });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Thank you/);
  assert.equal((await post({ nonce, company: 'again' })).status, 404, 'the link works once');
  const stored = (await app.db.pool.query('SELECT submission_enc FROM vendor_info_request WHERE vendor_id = $1 AND status = $2', [v, 'submitted'])).rows[0];
  assert.match(stored.submission_enc, /^v1:/);
  assert.doesNotMatch(stored.submission_enc, /1234567|123456789/);

  // Review: nothing changed yet; accept the address, company and bank but not the tax ID.
  assert.equal((await app.db.pool.query('SELECT bank_account_last4 FROM vendor WHERE vendor_id = $1', [v])).rows[0].bank_account_last4, null);
  const vp = await (await app.get(`/vendors/${v}`)).text();
  const reviewHref = /href="(\/vendors\/\d+\/info\/\d+)">Review and accept/.exec(vp)[1];
  const review = await (await app.get(reviewHref)).text();
  assert.match(review, /•••6789 \(routing 111000025\)/);
  assert.match(review, /•••4567/);
  assert.doesNotMatch(review, /000123456789|75-1234567/);
  const accept = new URLSearchParams({ do: 'accept' });
  for (const k of ['company', 'address', 'bank']) accept.append('accept', k);
  assert.equal((await app.post(reviewHref, accept)).status, 303);
  const row = (await app.db.pool.query('SELECT company_name, billing_address, bank_account_last4, tax_id_last4 FROM vendor WHERE vendor_id = $1', [v])).rows[0];
  assert.deepEqual([row.company_name, row.billing_address.city, row.bank_account_last4, row.tax_id_last4], ['Cross Plains Trucking LLC', 'Muenster', '6789', null]);
  assert.match(await (await app.get(`/vendors/${v}?tab=activity`)).text(), /Accepted the vendor’s company name, address, bank account/);
  assert.equal((await app.post(reviewHref, accept)).status, 422, 'already resolved');
});

test('ask vendor for info is refused without SETTINGS_KEY', async () => {
  const plain = await startApp();
  try {
    const res = await plain.post(`/vendors/${plain.ids.vendors.trucking}/ask`);
    assert.equal(res.status, 303);
    assert.match(await (await plain.get(res.headers.get('location'))).text(), /needs SETTINGS_KEY/);
  } finally { await plain.close(); }
});

test('1099 summary: bank payments to tracked vendors, card payments left out, threshold, missing tax IDs, export', async () => {
  // A card payment to a tracked vendor doesn't count.
  const p = new URLSearchParams({ type: 'expense', vendor_id: String(app.ids.vendors.repair), txn_date: TODAY, account_id: String(app.ids.accounts.card), payment_method: 'Credit card' });
  p.append('cat_account', String(app.ids.accounts.repairs)); p.append('cat_desc', ''); p.append('cat_amount', '999.00'); p.append('cat_job', ''); p.append('cat_po', '');
  await app.post('/vtxns', p);
  const page = await (await app.get('/vendors/1099?year=2026')).text();
  assert.match(page, /1099-NEC summary, 2026/);
  assert.match(page, /Mill Road Properties/);
  assert.match(page, /\$999\.00/, 'shown as left out');
  assert.match(page, /missing a tax ID/);
  const { rows } = await app.db.pool.query(
    `SELECT coalesce(sum(t.total_cents), 0)::bigint AS n FROM txn t JOIN account a ON a.account_id = t.account_id
      WHERE t.vendor_id = $1 AND t.type IN ('bill_payment', 'check', 'expense') AND t.voided_at IS NULL AND a.type = 'bank' AND t.txn_date BETWEEN '2026-01-01' AND '2026-12-31'`,
    [app.ids.vendors.landlord]);
  const csv = await (await app.get('/vendors/1099.csv?year=2026')).text();
  assert.match(csv, /^Vendor,Company,Address/);
  assert.match(csv, new RegExp(`Mill Road Properties,Mill Road Properties LLC,"220 Commerce St, Gainesville, TX 76240",,${(rows[0].n / 100).toFixed(2)},Yes`));
  assert.doesNotMatch(csv, /Lone Star Feed Mill/, 'untracked vendors aren’t on the 1099 list');
});

// A vendor's name as an exact piece of a page (for matching).
const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, c => `\\${c}`);
test('Contractors lists the 1099 vendors; vendors paid over the threshold can be ticked and tracked from the 1099 page', async () => {
  const page = await (await app.get('/vendors/1099?year=2026')).text();
  const untracked = [...page.matchAll(/<input type="checkbox" name="vendor" value="(\d+)">/g)].map(m => Number(m[1]));
  assert.ok(untracked.length, 'some vendors were paid over the threshold without being tracked');
  const pick = untracked[0];
  const { rows: [before] } = await app.db.pool.query('SELECT track_1099, display_name FROM vendor WHERE vendor_id = $1', [pick]);
  assert.equal(before.track_1099, false);
  const name = new RegExp(`>${escRe(before.display_name)}<`);
  assert.doesNotMatch(await (await app.get('/vendors?show=contractors')).text(), name);
  const res = await app.post('/vendors/1099/track', new URLSearchParams([['vendor', String(pick)], ['year', '2026']]));
  assert.equal(res.status, 303);
  assert.equal((await app.db.pool.query('SELECT track_1099 FROM vendor WHERE vendor_id = $1', [pick])).rows[0].track_1099, true);
  assert.match(await (await app.get('/vendors?show=contractors')).text(), name);
  assert.equal((await app.post('/vendors/1099/track', new URLSearchParams([['year', '2026']]))).status, 303, 'nothing ticked: a message, nothing changed');
  const home = await (await app.get('/home')).text();
  assert.match(home, /href="\/vendors\?show=contractors"[^>]*>Contractors</);
});

test('the Contractors list says what it shows; only people who can track see the tick boxes (Codex builds #1, #3)', async () => {
  assert.match(await (await app.get('/vendors?show=contractors')).text(), /Showing vendors tracked for 1099s\./);
  const { ten99Page } = await import('../lib/views/vendor-auto.js');
  const data = { year: 2026, tracked: [], untrackedOver: [{ vendor_id: 1, display_name: 'Any Vendor', paid_cents: 100000 }], totals: { vendors: 0, paidCents: 0, missingTaxIds: 0 } };
  assert.doesNotMatch(String(ten99Page({ entityName: 'x', csrf: 'c', data, years: [2026], canTrack: false })), /name="vendor"/);
  assert.match(String(ten99Page({ entityName: 'x', csrf: 'c', data, years: [2026], canTrack: true })), /name="vendor" value="1"/);
});
