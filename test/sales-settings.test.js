import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ledgerCheck } from '../lib/data/ledger.js';
import { runDailyJobs } from '../services/jobs/index.js';
import { renderEmail, fillTemplate } from '../lib/data/sales-settings.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
const sent = [];
const mailer = { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } };
let app, scope;
before(async () => {
  app = await startApp({ mailer, env: { SETTINGS_KEY: 'cd'.repeat(32) } });
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

const q = async (sql, params = []) => (await app.db.pool.query(sql, params)).rows;
const salesOn = (more = {}) => app.post('/settings/sales', { customNumbers: '1', serviceDate: '1', discount: '1', shipping: '1', deposit: '1',
  defaultDelivery: 'none', statementKind: 'balance_forward', statementAging: '1', ...more });

async function newCustomer(name, more = {}) {
  const res = await app.post('/customers', { displayName: name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, active: '1', sendReminders: '1', ...more });
  assert.equal(res.status, 303);
  return Number(/\/customers\/(\d+)/.exec(res.headers.get('location'))[1]);
}

function invoice(customerId, { lines = [['Feed', '2', '50']], ...rest } = {}) {
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(customerId), txn_date: TODAY, after_save: 'none', ...rest });
  for (const [desc, qty, rate, service = ''] of lines) {
    p.append('line_item', ''); p.append('line_desc', desc); p.append('line_qty', qty); p.append('line_rate', rate); p.append('line_service', service);
  }
  return app.post('/txns', p);
}
const lastInvoice = async customerId => (await q(`SELECT * FROM txn WHERE customer_id = $1 AND type = 'invoice' ORDER BY txn_id DESC LIMIT 1`, [customerId]))[0];
const balance = async key => Number((await q(`SELECT coalesce(sum(p.amount_cents), 0)::bigint AS n FROM posting p JOIN account a ON a.account_id = p.account_id
  WHERE a.system_key = $1 AND a.entity_id = $2`, [key, app.ids.entityId]))[0].n);

test('templates fill placeholders and add the footer', () => {
  assert.equal(fillTemplate('Hi {customer}, {unknown} {amount}', { customer: 'Ann', amount: '$5.00' }), 'Hi Ann, {unknown} $5.00');
  const e = renderEmail({ templates: { invoice: { subject: 'Bill {number}' } } }, 'invoice', { number: 'INV-9', customer: 'Ann', company: 'Co' }, 'Pay by check');
  assert.equal(e.subject, 'Bill INV-9');
  assert.match(e.text, /^Dear Ann,/);
  assert.match(e.text, /Pay by check$/);
});

test('discount and shipping change the total and post to Discounts Given and Shipping Income', async () => {
  assert.equal((await salesOn()).status, 303);
  const c = await newCustomer('Discount Dairy');
  const editor = await (await app.get(`/txns/new?type=invoice&customer=${c}`)).text();
  assert.match(editor, /name="discount_value"/);
  assert.match(editor, /name="line_service"/);
  const res = await invoice(c, { lines: [['Feed', '2', '50', '2026-10-01']], discount_kind: 'percent', discount_value: '10', shipping: '15' });
  assert.equal(res.status, 303, await res.clone().text());
  const t = await lastInvoice(c);
  assert.equal(Number(t.total_cents), 10000 - 1000 + 1500);
  assert.equal(Number(t.discount_cents), 1000);
  assert.equal((await q('SELECT to_char(service_date, \'YYYY-MM-DD\') AS d FROM txn_line WHERE txn_id = $1', [t.txn_id]))[0].d, '2026-10-01');
  assert.equal(await balance('discounts'), 1000, 'discount debits Discounts Given');
  assert.equal(await balance('shipping_income'), -1500, 'shipping credits Shipping Income');
  const pdf = await app.get(`/txns/${t.txn_id}.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.equal((await invoice(c, { discount_kind: 'amount', discount_value: '500' })).status, 422, 'discount bigger than the lines');
});

test('a deposit on an invoice is a payment into Undeposited Funds applied to it, and can be changed or removed', async () => {
  const c = await newCustomer('Deposit Ranch');
  assert.equal((await invoice(c, { lines: [['Hay', '10', '20']], deposit_amount: '50', deposit_method: 'Check' })).status, 303);
  const t = await lastInvoice(c);
  assert.equal(Number(t.open_cents), 15000);
  const [pay] = await q('SELECT * FROM txn WHERE deposit_for_txn_id = $1', [t.txn_id]);
  assert.equal(pay.type, 'payment');
  assert.equal(Number(pay.total_cents), 5000);
  assert.equal(Number(pay.open_cents), 0);
  assert.equal(pay.payment_method, 'Check');
  assert.match(await (await app.get(`/txns/${t.txn_id}/edit`)).text(), /name="deposit_amount" value="50.00"/);

  const edit = (amount) => {
    const p = new URLSearchParams({ type: 'invoice', customer_id: String(c), txn_date: TODAY, doc_number: t.doc_number, deposit_amount: amount, deposit_method: 'Check' });
    p.append('line_item', ''); p.append('line_desc', 'Hay'); p.append('line_qty', '10'); p.append('line_rate', '20'); p.append('line_service', '');
    return app.post(`/txns/${t.txn_id}`, p);
  };
  assert.equal((await edit('80')).status, 303);
  assert.equal(Number((await lastInvoice(c)).open_cents), 12000);
  assert.equal(Number((await q('SELECT total_cents FROM txn WHERE deposit_for_txn_id = $1', [t.txn_id]))[0].total_cents), 8000);
  assert.equal((await edit('500')).status, 422, 'deposit over the open balance');
  assert.equal((await edit('')).status, 303);
  assert.equal(Number((await lastInvoice(c)).open_cents), 20000);
  assert.equal((await q('SELECT count(*)::int AS n FROM txn WHERE deposit_for_txn_id = $1', [t.txn_id]))[0].n, 0);
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches, JSON.stringify(check));
});

test('invoice numbers continue from the setting; with custom numbers off, typed numbers are ignored; default terms apply', async () => {
  const terms = (await q('SELECT terms_id, due_days FROM terms WHERE org_id = $1 AND due_days = 30', [app.ids.orgId]))[0];
  assert.equal((await salesOn({ nextInvoiceNumber: '5000', customNumbers: '', defaultTermsId: String(terms.terms_id) })).status, 303);
  const c = await newCustomer('Numbered Farms');
  assert.doesNotMatch(await (await app.get(`/txns/new?type=invoice&customer=${c}`)).text(), /name="doc_number"/);
  assert.equal((await invoice(c, { doc_number: 'MINE-1' })).status, 303);
  const t = await lastInvoice(c);
  assert.equal(t.doc_number, 'INV-5000');
  assert.equal(t.due_date, '2026-11-11', 'Net 30 from the company default');
  assert.equal((await salesOn({ nextInvoiceNumber: '10' })).status, 422, 'can’t go back below a used number');
  assert.equal((await salesOn()).status, 303);
});

test('email templates, copies and “email me a copy” are used when sending; after-save email sends at once', async () => {
  await app.post('/settings/company', { name: 'Sample Feed Co.', email: 'owner@samplefeed.example' });
  const fields = { cc: 'books@samplefeed.example', bcc: '', copyMe: '1', tpl_invoice_subject: 'Your bill {number} ({balance})', tpl_invoice_greeting: 'Howdy {customer},',
    tpl_invoice_body: 'Pay {amount} by {due_date}.', rule_days: '' };
  assert.equal((await app.post('/settings/messages', fields)).status, 303);
  assert.equal((await app.post('/settings/form-styles', { accent: '#aa3300', font: 'times', showLogo: '1', showTerms: '1', footer: 'Checks to Sample Feed Co.' })).status, 303);
  const c = await newCustomer('Template Acres');
  sent.length = 0;
  assert.equal((await invoice(c, { after_save: 'email' })).status, 303);
  const t = await lastInvoice(c);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, `Your bill ${t.doc_number} ($100.00)`);
  assert.match(sent[0].text, /^Howdy Template Acres,\n\nPay \$100\.00 by/);
  assert.match(sent[0].text, /Checks to Sample Feed Co\.$/);
  assert.equal(sent[0].cc, 'books@samplefeed.example');
  assert.equal(sent[0].bcc, 'owner@samplefeed.example');
  assert.equal((await app.post('/settings/messages', { ...fields, cc: 'not an email' })).status, 422);
});

test('form styles: bad colors are refused; the preview is a PDF and works with a logo', async () => {
  assert.equal((await app.post('/settings/form-styles', { accent: 'red', font: 'helvetica' })).status, 422);
  const fd = new FormData();
  fd.set('csrf', app.csrf);
  fd.set('logo', new Blob([await readFile(new URL('../public/icons/icon-192.png', import.meta.url))]), 'logo.png');
  assert.equal((await app.raw('/settings/company/logo', { method: 'POST', body: fd })).status, 303);
  const res = await app.post('/settings/form-styles/preview.pdf', { accent: '#225588', font: 'courier', showLogo: '1', showServiceDate: '1', footer: 'Preview footer' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.ok(Buffer.from(await res.arrayBuffer()).length > 3000, 'the logo is embedded');
  assert.equal((await app.get('/settings/form-styles')).status, 200);
});

test('reminders: turned on from today, sent once per invoice per rule by the daily job, opted-out customers skipped', async () => {
  const bad = await app.post('/settings/messages', new URLSearchParams([['remindersOn', '1'], ['rule_days', ''], ['rule_days', '']]));
  assert.equal(bad.status, 422);
  assert.equal((await app.post('/settings/messages', new URLSearchParams([['remindersOn', '1'], ['rule_days', '7'], ['rule_days', '-3'], ['rule_days', '']]))).status, 303);
  const [s] = await q('SELECT reminders_from, reminder_rules FROM sales_settings WHERE entity_id = $1', [app.ids.entityId]);
  assert.equal(s.reminders_from, TODAY);
  assert.deepEqual(s.reminder_rules, [{ days: -3 }, { days: 7 }]);

  const yes = await newCustomer('Reminded Ranch');
  const no = await newCustomer('Quiet Ranch', { sendReminders: '' });
  for (const c of [yes, no]) assert.equal((await invoice(c, { due_date: '2026-10-15' })).status, 303);
  const run = () => runDailyJobs({ pool: app.db.pool, mailer, now: () => new Date('2026-10-12T17:00:00Z') });
  sent.length = 0;
  await run();
  const ours = m => /^Reminder/.test(m.subject) && /(reminded|quiet)\.ranch@/.test(m.to);
  const reminders = sent.filter(ours);
  assert.equal(reminders.length, 1, 'only the -3 day reminder for the customer who wants them');
  assert.equal(reminders[0].to, 'reminded.ranch@example.com');
  assert.ok(sent.filter(m => /^Reminder/.test(m.subject)).length >= 1);
  sent.length = 0;
  await run();
  assert.equal(sent.filter(m => /^Reminder/.test(m.subject)).length, 0, 'never twice');
  const msgs = await q(`SELECT count(*)::int AS n FROM message WHERE customer_id = $1 AND subject LIKE 'Reminder%'`, [yes]);
  assert.equal(msgs[0].n, 1, 'logged in Conversations');
  assert.equal((await q(`SELECT count(*)::int AS n FROM invoice_reminder r JOIN txn t ON t.txn_id = r.txn_id WHERE t.due_date < $1`, [TODAY]))[0].n, 0,
    'invoices due before reminders were turned on are left alone');
});

test('statement defaults: the default kind is preselected and the aging table can be left off', async () => {
  assert.equal((await salesOn({ statementKind: 'open_item', statementAging: '' })).status, 303);
  const page = await (await app.get(`/customers/${app.ids.customers.hilltop}?tab=statements`)).text();
  assert.match(page, /value="open_item"[^>]*checked|value="open_item" selected|<option value="open_item" selected/);
  const res = await app.post(`/customers/${app.ids.customers.hilltop}/statements`, { kind: 'open_item', statementDate: TODAY, startDate: '2026-09-12', endDate: TODAY, action: 'save' });
  assert.equal(res.status, 303);
  const [st] = await q('SELECT content FROM statement WHERE customer_id = $1 ORDER BY statement_id DESC LIMIT 1', [app.ids.customers.hilltop]);
  assert.equal(st.content.show_aging, false);
});
