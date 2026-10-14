import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startApp } from './app-harness.js';
import { settingsKey, encryptSecret, decryptSecret } from '../lib/secrets.js';

const KEY = randomBytes(32).toString('hex');
const sent = [];
let failNext = null;
// Stands in for nodemailer's SMTP transport: records options and every message.
const makeTransport = options => ({
  options,
  async sendMail(message) {
    if (failNext) { const e = failNext; failNext = null; throw e; }
    sent.push({ options, message });
    return { messageId: 'x' };
  },
});

let app;
before(async () => { app = await startApp({ env: { SETTINGS_KEY: KEY }, makeTransport }); });
after(async () => { await app.close(); });

const flash = async path => /class="flash (ok|error)" role="status">([^<]*)</.exec(await (await app.get(path)).text())?.slice(1);
const SMTP = { mode: 'smtp', fromName: 'Sample Feed Co.', fromEmail: 'billing@samplefeed.example', replyTo: 'office@samplefeed.example',
  host: 'smtp.gmail.com', port: '587', security: 'starttls', user: 'billing@samplefeed.example', password: 'app-password-123' };

test('secrets round-trip and reject the wrong key', () => {
  const key = settingsKey({ SETTINGS_KEY: KEY });
  const stored = encryptSecret(key, 'hunter2');
  assert.ok(!stored.includes('hunter2'));
  assert.equal(decryptSecret(key, stored), 'hunter2');
  assert.throws(() => decryptSecret(randomBytes(32), stored));
  assert.equal(settingsKey({}), null);
  assert.throws(() => settingsKey({ SETTINGS_KEY: 'abcd' }), /32 bytes/);
});

test('email starts as record-only and is reachable from the top nav', async () => {
  const customers = await (await app.get('/customers')).text();
  assert.match(customers, /href="\/settings"/);
  assert.match(await (await app.get('/settings')).text(), /href="\/settings\/email"/, 'Settings opens a list of sections');
  const page = await (await app.get('/settings/email')).text();
  assert.match(page, /Email isn’t connected/);
  assert.match(page, /value="record" checked/);
});

test('company details save and show in the header', async () => {
  const res = await app.post('/settings/company', { name: 'Sample Feed & Supply', email: 'office@samplefeed.example', phone: '(940) 555-0100', line1: '100 Mill Rd', city: 'Gainesville', state: 'TX', postal: '76240' });
  assert.equal(res.status, 303);
  const [kind] = await flash('/settings/company');
  assert.equal(kind, 'ok');
  assert.match(await (await app.get('/customers')).text(), /Sample Feed &amp; Supply/);
  assert.equal((await app.post('/settings/company', { name: '  ' })).status, 422);
});

test('SMTP settings validate, encrypt the password, and keep it when left blank', async () => {
  const missing = await app.post('/settings/email', { ...SMTP, host: '' });
  assert.equal(missing.status, 422);
  assert.match(await missing.text(), /Enter your mail server/);
  assert.equal((await app.post('/settings/email', SMTP)).status, 303);
  const row = async () => (await app.db.pool.query('SELECT * FROM email_settings')).rows[0];
  const first = await row();
  assert.equal(first.mode, 'smtp');
  assert.ok(first.smtp_password_enc.startsWith('v1:'));
  assert.ok(!first.smtp_password_enc.includes('app-password-123'));
  const page = await (await app.get('/settings/email')).text();
  assert.ok(!page.includes('app-password-123'));
  assert.match(page, /Saved — leave blank to keep/);
  assert.match(page, /Sending from billing@samplefeed\.example/);
  assert.equal((await app.post('/settings/email', { ...SMTP, password: '' })).status, 303);
  assert.equal((await row()).smtp_password_enc, first.smtp_password_enc);
});

test('test email goes through the company’s mail server; failures are shown and remembered', async () => {
  sent.length = 0;
  assert.equal((await app.post('/settings/email/test', { to: 'owner@example.com' })).status, 303);
  assert.match((await flash('/settings/email'))[1], /Test email sent to owner@example.com/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options.auth, { user: 'billing@samplefeed.example', pass: 'app-password-123' });
  assert.equal(sent[0].options.host, 'smtp.gmail.com');
  assert.equal(sent[0].options.requireTLS, true);
  assert.equal(sent[0].message.from, '"Sample Feed Co." <billing@samplefeed.example>');
  assert.equal(sent[0].message.replyTo, 'office@samplefeed.example');
  assert.match(await (await app.get('/settings/email')).text(), /Test email succeeded/);
  failNext = new Error('535 Username and Password not accepted');
  await app.post('/settings/email/test', { to: 'owner@example.com' });
  assert.match((await flash('/settings/email'))[1], /failed: 535 Username/);
  assert.match(await (await app.get('/settings/email')).text(), /Last test failed/);
});

test('sending an invoice uses the company’s email settings', async () => {
  sent.length = 0;
  const cust = app.ids.customers.prairie;
  const inv = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND voided_at IS NULL LIMIT 1`, [cust])).rows[0].txn_id;
  assert.equal((await app.post(`/txns/${inv}/send`)).status, 303);
  assert.match((await flash(`/txns/${inv}`))[1], /emailed\./);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.to, 'orders@prairiecreekfeed.example');
  assert.equal(sent[0].message.attachments[0].contentType, 'application/pdf');
  const m = (await app.db.pool.query('SELECT status, from_addr FROM message WHERE related_txn_id = $1', [inv])).rows[0];
  assert.deepEqual(m, { status: 'sent', from_addr: '"Sample Feed Co." <billing@samplefeed.example>' });
});

test('switching back to record-only stops real sends', async () => {
  sent.length = 0;
  assert.equal((await app.post('/settings/email', { ...SMTP, mode: 'record', password: '' })).status, 303);
  const inv = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE type = 'invoice' AND voided_at IS NULL AND customer_id = $1 LIMIT 1`, [app.ids.customers.prairie])).rows[0].txn_id;
  await app.post(`/txns/${inv}/send`);
  assert.match((await flash(`/txns/${inv}`))[1], /Settings → Email/);
  assert.equal(sent.length, 0);
});

test('a password can’t be saved without SETTINGS_KEY', async () => {
  const noKey = await startApp({ makeTransport });
  try {
    const res = await noKey.post('/settings/email', SMTP);
    assert.equal(res.status, 422);
    assert.match(await res.text(), /no SETTINGS_KEY/);
  } finally { await noKey.close(); }
});
