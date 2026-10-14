import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { validRouting, validBankAccount, validTaxId } from '../lib/domain/vendors.js';
import { parseCsv, headerKey } from '../lib/domain/csv.js';
import { startApp } from './app-harness.js';

const KEY = 'ab'.repeat(32);

test('routing, account and tax ID checks', () => {
  assert.equal(validRouting('122100024'), '122100024');
  assert.equal(validRouting('122 100 024'), '122100024');
  assert.equal(validRouting('122100025'), null, 'bad checksum');
  assert.equal(validRouting('12210002'), null);
  assert.equal(validBankAccount('0000001761'), '0000001761');
  assert.equal(validBankAccount('12a4'), null);
  assert.equal(validTaxId('12-3456789'), '12-3456789');
  assert.equal(validTaxId('123456789'), '12-3456789');
  assert.equal(validTaxId('123-45-6789'), '123-45-6789');
  assert.equal(validTaxId('000000000'), null);
  assert.equal(validTaxId('1234'), null);
});

test('CSV parsing: quotes, commas, newlines, BOM, CRLF', () => {
  assert.deepEqual(parseCsv('﻿Name,Notes\r\n"Smith, Jo","Said ""hi""\nthen left"\r\n\r\nB,\n'),
    [['Name', 'Notes'], ['Smith, Jo', 'Said "hi"\nthen left'], ['B', '']]);
  assert.throws(() => parseCsv('a,"b'), /never closed/);
  assert.equal(headerKey('1099 Tracking'), '1099tracking');
});

let app, scope;
before(async () => {
  app = await startApp({ env: { SETTINGS_KEY: KEY } });
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => { await app.close(); });

const vendorForm = (extra = {}) => ({ displayName: 'Hardin Grain', companyName: 'Hardin Grain LLC', email: 'pay@hardingrain.example', phone: '(940) 555-0101',
  line1: 'PO Box 12', city: 'Valley View', state: 'TX', postal: '76272', track1099: '1', ...extra });

test('vendor list: summary bar, seeded vendors, search, sort, inactive, export', async () => {
  const page = await (await app.get('/vendors')).text();
  assert.match(page, /Unbilled last 365 days/);
  assert.match(page, /open purchase order/);
  assert.match(page, /paid last 30 days/);
  assert.match(page, /Panhandle Hay Co\./);
  assert.match(page, /Cross Plains Trucking/);
  assert.match(await (await app.get('/vendors?q=trucking')).text(), /Cross Plains Trucking/);
  assert.doesNotMatch(await (await app.get('/vendors?q=trucking')).text(), /Panhandle Hay/);
  const sorted = await (await app.get('/vendors?sort=name&dir=desc')).text();
  assert.ok(sorted.indexOf('Texoma Electric') < sorted.indexOf('Brazos Valley Fuel'));
  const csv = await app.get('/vendors.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const body = await csv.text();
  assert.match(body, /^Vendor,Company,Email/);
  assert.match(body, /Lone Star Feed Mill,"Lone Star Feed Mill, Inc\."/);
});

test('create a vendor with bank details and tax ID; secrets are encrypted and masked', async () => {
  const res = await app.post('/vendors', vendorForm({ bankRouting: '122100024', bankAccount: '0000001761', taxId: '12-3456789', termsId: String(app.ids.terms.net30) }));
  assert.equal(res.status, 303);
  const id = Number(/\/vendors\/(\d+)/.exec(res.headers.get('location'))[1]);
  const row = (await app.db.pool.query('SELECT * FROM vendor WHERE vendor_id = $1', [id])).rows[0];
  assert.match(row.bank_account_enc, /^v1:/);
  assert.match(row.tax_id_enc, /^v1:/);
  assert.doesNotMatch(JSON.stringify(row), /0000001761|3456789/, 'numbers never stored in clear');
  assert.equal(row.bank_account_last4, '1761');
  const page = await (await app.get(`/vendors/${id}`)).text();
  assert.match(page, /•••1761/);
  assert.match(page, /Routing 122100024/);
  assert.doesNotMatch(page, /0000001761/);
  const details = await (await app.get(`/vendors/${id}?tab=details`)).text();
  assert.match(details, /•••6789/);
  assert.match(details, /Net 30/);
  const edit = await (await app.get(`/vendors/${id}/edit`)).text();
  assert.doesNotMatch(edit, /0000001761|3456789|122100024/, 'the edit form never sends secrets back');

  // Blank keeps; a bad number is refused; clear removes.
  assert.equal((await app.post(`/vendors/${id}`, vendorForm({ active: '1', notes: 'Pays by ACH' }))).status, 303);
  assert.equal((await app.db.pool.query('SELECT bank_account_last4 FROM vendor WHERE vendor_id = $1', [id])).rows[0].bank_account_last4, '1761');
  const bad = await app.post(`/vendors/${id}`, vendorForm({ active: '1', bankRouting: '122100025', bankAccount: '1234' }));
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /valid 9-digit routing/);
  assert.equal((await app.post(`/vendors/${id}`, vendorForm({ active: '1', clearBank: '1' }))).status, 303);
  assert.equal((await app.db.pool.query('SELECT bank_account_enc FROM vendor WHERE vendor_id = $1', [id])).rows[0].bank_account_enc, null);
  assert.match(await (await app.get(`/vendors/${id}?tab=activity`)).text(), /bank details removed/);

  const dup = await app.post('/vendors', vendorForm());
  assert.equal(dup.status, 422);
  assert.match(await dup.text(), /already exists/);
});

test('without SETTINGS_KEY bank details are refused, everything else saves', async () => {
  const plain = await startApp();
  try {
    const res = await plain.post('/vendors', vendorForm({ displayName: 'No Key Vendor', bankRouting: '122100024', bankAccount: '12345678' }));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /needs SETTINGS_KEY/);
    assert.equal((await plain.post('/vendors', vendorForm({ displayName: 'No Key Vendor' }))).status, 303);
  } finally { await plain.close(); }
});

test('make inactive (one and batch), and the inactive filter', async () => {
  const fuel = app.ids.vendors.fuel, office = app.ids.vendors.office;
  assert.equal((await app.post(`/vendors/${fuel}/inactive`)).status, 303);
  assert.doesNotMatch(await (await app.get('/vendors')).text(), /<strong>Brazos Valley Fuel<\/strong>/);
  assert.match(await (await app.get('/vendors?inactive=1')).text(), /Brazos Valley Fuel/);
  assert.equal((await app.post(`/vendors/${fuel}/active`)).status, 303);
  const body = new URLSearchParams({ action: 'inactive' });
  body.append('ids', String(office)); body.append('ids', String(fuel));
  assert.equal((await app.post('/vendors/batch', body)).status, 303);
  const n = (await app.db.pool.query('SELECT count(*)::int AS n FROM vendor WHERE vendor_id = ANY($1) AND NOT active', [[fuel, office]])).rows[0].n;
  assert.equal(n, 2);
  await app.db.pool.query('UPDATE vendor SET active = true WHERE vendor_id = ANY($1)', [[fuel, office]]);
});

test('batch email records a message per vendor with an email', async () => {
  const body = new URLSearchParams({ action: 'email' });
  body.append('ids', String(app.ids.vendors.mill)); body.append('ids', String(app.ids.vendors.repair));
  const compose = await app.post('/vendors/batch', body);
  assert.equal(compose.status, 200);
  assert.match(await compose.text(), /Email 2 vendors/);
  const send = new URLSearchParams({ subject: 'Holiday hours', body: 'We close at noon on the 24th.' });
  send.append('ids', String(app.ids.vendors.mill)); send.append('ids', String(app.ids.vendors.repair));
  const res = await app.post('/vendors/email', send);
  assert.equal(res.status, 303);
  const msgs = (await app.db.pool.query('SELECT vendor_id, status, to_addr FROM message WHERE vendor_id IS NOT NULL ORDER BY vendor_id')).rows;
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every(m => m.status === 'logged'));
  assert.match(await (await app.get(`/vendors/${app.ids.vendors.mill}?tab=activity`)).text(), /Email “Holiday hours”/);
});

test('documents on a vendor', async () => {
  const boundary = '----fbv';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${app.csrf}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="W-9.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 w9\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nSigned 2026\r\n--${boundary}--\r\n`);
  const v = app.ids.vendors.trucking;
  const res = await app.raw(`/vendors/${v}/documents`, { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(res.status, 303);
  const tab = await (await app.get(`/vendors/${v}?tab=documents`)).text();
  assert.match(tab, /W-9\.pdf/);
  assert.match(tab, /Signed 2026/);
  const docId = (await app.db.pool.query('SELECT document_id FROM document WHERE vendor_id = $1', [v])).rows[0].document_id;
  assert.equal((await app.get(`/documents/${docId}`)).headers.get('content-type'), 'application/pdf');
  assert.equal((await app.post(`/documents/${docId}/delete`)).headers.get('location'), `/vendors/${v}?tab=documents`);
});

test('merge moves history and documents, then deletes the merged vendor', async () => {
  const a = Number(/\/vendors\/(\d+)/.exec((await app.post('/vendors', vendorForm({ displayName: 'Hardin Grain (old)' }))).headers.get('location'))[1]);
  const into = app.ids.vendors.mill;
  const page = await (await app.get(`/vendors/${a}/merge`)).text();
  assert.match(page, /0 transactions/);
  assert.equal((await app.post(`/vendors/${a}/merge`, { into: String(a) })).status, 422);
  const res = await app.post(`/vendors/${a}/merge`, { into: String(into) });
  assert.equal(res.status, 303);
  assert.equal((await app.get(`/vendors/${a}`)).status, 404);
  const history = await (await app.get(`/vendors/${into}?tab=activity`)).text();
  assert.match(history, /Hardin Grain \(old\) merged into Lone Star Feed Mill/);
  assert.match(history, /Vendor Hardin Grain \(old\) created/, 'the old vendor’s history moved over');
});

test('import vendors from CSV: preview with errors, then import the good rows', async () => {
  const csv = 'Vendor Name,Company,Email,Phone,City,State,ZIP,Terms,1099 Tracking,Favorite color\n' +
    'Sunset Machinery,Sunset Machinery Co.,parts@sunset.example,(940) 555-0199,Denton,TX,76201,Net 30,yes,blue\n' +
    'Panhandle Hay Co.,,,,,,,,,\n' +
    'Bad Email Co,,not-an-email,,,,,,,\n' +
    'Gulf Coast Seed,,,,,,,Net 99,,\n' +
    'Valley Vet Supply,,orders@valleyvet.example,,,,,,no,\n';
  const preview = await app.post('/vendors/import', { csv, step: 'preview' });
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /2 of 5 rows ready to import/);
  assert.match(html, /already exists/);
  assert.match(html, /isn’t an email address/);
  assert.match(html, /No terms called “Net 99”/);
  assert.match(html, /Ignored columns: Favorite color/);
  const done = await app.post('/vendors/import', { csv, step: 'import' });
  assert.equal(done.status, 303);
  assert.match(await (await app.get('/vendors')).text(), /2 vendors imported; 3 rows skipped/);
  const sunset = (await app.db.pool.query(`SELECT * FROM vendor WHERE display_name = 'Sunset Machinery'`)).rows[0];
  assert.equal(sunset.track_1099, true);
  assert.equal(sunset.billing_address.city, 'Denton');
  assert.equal((await app.post('/vendors/import', { csv: 'Company\nX', step: 'preview' })).status, 422, 'needs a Name column');
});

test('vendor pages fit the shared layout and every tab renders', async () => {
  const id = app.ids.vendors.hayfarm;
  for (const tab of ['transactions', 'details', 'recurring', 'documents', 'activity']) {
    const res = await app.get(`/vendors/${id}?tab=${tab}`);
    assert.equal(res.status, 200, tab);
    assert.match(await res.text(), /<link rel="manifest"/);
  }
  assert.equal((await app.get('/vendors/999999')).status, 404);
  assert.equal((await app.get('/vendors/new')).status, 200);
  assert.equal((await app.get('/vendors/import')).status, 200);
});
