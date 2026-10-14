import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { ledgerCheck } from '../lib/data/ledger.js';
import { periodStart } from '../lib/data/budgets.js';
import { zipFiles } from '../lib/zip.js';
import { startApp } from './app-harness.js';

let app, scope;
before(async () => {
  app = await startApp();
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

const q = async (sql, params = []) => (await app.db.pool.query(sql, params)).rows;
const upload = (path, fields) => {
  const fd = new FormData();
  fd.set('csrf', app.csrf);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return app.raw(path, { method: 'POST', body: fd });
};

test('zip: entries keep folders but can’t climb out, and duplicate names are numbered', () => {
  const zip = zipFiles([{ name: '../../evil.txt', data: Buffer.from('x') }, { name: 'A/b.txt', data: Buffer.from('hello hello hello hello') }, { name: 'A/b.txt', data: Buffer.from('y') }]);
  const names = [];
  for (let i = 0; i < zip.length - 4; i++) {
    if (zip.readUInt32LE(i) === 0x02014b50) { const n = zip.readUInt16LE(i + 28); names.push(zip.subarray(i + 46, i + 46 + n).toString()); }
  }
  assert.deepEqual(names, ['evil.txt', 'A/b.txt', 'A/b (2).txt']);
  // The second entry is deflated and comes back intact.
  const local = zip.indexOf(Buffer.from('A/b.txt')) + 7;
  const size = zip.readUInt32LE(zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 1) + 18);
  assert.equal(inflateRawSync(zip.subarray(local, local + size)).toString(), 'hello hello hello hello');
});

test('fiscal periods follow the first month of the fiscal year', () => {
  assert.equal(periodStart(2026, 1, 1), '2026-01-01');
  assert.equal(periodStart(2027, 7, 1), '2026-07-01');
  assert.equal(periodStart(2027, 7, 12), '2027-06-01');
});

test('import customers, products and accounts: preview shows problems, import saves the good rows', async () => {
  const csv = 'Name,Email,City,Terms\nNew Pasture Co,np@example.com,Denton,\nHilltop Dairy,,,\nBad Email,nope,,\n,orphan@example.com,,\nNet Ranch,,,Net 99\n';
  const preview = await upload('/import/customers', { csv, step: 'preview' });
  assert.equal(preview.status, 200);
  const page = await preview.text();
  assert.match(page, /1 of 5 rows ready/);
  assert.match(page, /already exists/);
  assert.match(page, /isn’t an email address/);
  assert.match(page, /No terms called/);
  const done = await upload('/import/customers', { csv, step: 'import' });
  assert.equal(done.status, 303);
  assert.equal((await q(`SELECT count(*)::int AS n FROM customer WHERE display_name = 'New Pasture Co' AND billing_address->>'city' = 'Denton'`))[0].n, 1);

  const items = 'Name,Type,Price,Income account\nMineral Tub,Product,45.50,Feed Sales\nFarm Visit,Service,90,\nStock Tank,Inventory,300,\n';
  assert.match(await (await upload('/import/items', { csv: items, step: 'preview' })).text(), /2 of 3 rows ready/);
  assert.equal((await upload('/import/items', { csv: items, step: 'import' })).status, 303);
  const tub = (await q(`SELECT i.rate_cents, a.name FROM item i JOIN account a ON a.account_id = i.income_account_id WHERE i.name = 'Mineral Tub'`))[0];
  assert.equal(Number(tub.rate_cents), 4550);
  assert.equal(tub.name, 'Feed Sales');

  const accounts = 'Name,Number,Type,Parent\nVet Supplies,6150,Expense,\nVaccines,6151,Expense,Vet Supplies\nWrong,,Spaceship,\nMy A/R,,Accounts receivable (A/R),\n';
  const ap = await (await upload('/import/accounts', { csv: accounts, step: 'preview' })).text();
  assert.match(ap, /2 of 4 rows ready/);
  assert.match(ap, /built in/);
  assert.equal((await upload('/import/accounts', { csv: accounts, step: 'import' })).status, 303);
  const vaccines = (await q(`SELECT a.type, p.name AS parent FROM account a JOIN account p ON p.account_id = a.parent_id WHERE a.name = 'Vaccines'`))[0];
  assert.deepEqual(vaccines, { type: 'expense', parent: 'Vet Supplies' });
});

test('export: one workbook with every list and transaction, and a ZIP of attachments', async () => {
  const res = await app.get('/export/books.xlsx');
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Customers', 'Vendors', 'Products and services', 'Chart of accounts', 'Transactions', 'General ledger']);
  const gl = wb.getWorksheet('General ledger');
  let debits = 0, credits = 0;
  gl.eachRow((row, i) => { if (i > 1) { debits += Number(row.getCell(8).value ?? 0); credits += Number(row.getCell(9).value ?? 0); } });
  assert.ok(Math.abs(debits - credits) < 0.005, 'the exported ledger balances');
  const fd = new FormData();
  fd.set('csrf', app.csrf);
  fd.set('file', new Blob([Buffer.from('%PDF-1.4 sample')]), 'contract.pdf');
  fd.set('note', 'Signed');
  assert.equal((await app.raw(`/customers/${app.ids.customers.hilltop}/documents`, { method: 'POST', body: fd })).status, 303);
  const zip = await app.get('/export/documents.zip');
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await zip.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.ok(buf.includes(Buffer.from('/contract.pdf')));
  const list = await (await app.get('/attachments?q=contract')).text();
  assert.match(list, /contract\.pdf/);
  assert.doesNotMatch(await (await app.get('/attachments?party=vendors&q=contract')).text(), /contract\.pdf/);
});

test('all recurring lists customer and vendor templates together', async () => {
  const page = await (await app.get('/all-recurring')).text();
  const n = (await q('SELECT count(*)::int AS n FROM recurring_template WHERE org_id = $1', [app.ids.orgId]))[0].n;
  if (n) assert.equal((page.match(/<tr>/g) ?? []).length - 1, n);
  else assert.match(page, /No recurring templates yet/);
});

test('budgets: from last year’s actuals, edited by month, shown beside actuals; split by class', async () => {
  const bad = await app.post('/budgets', { name: '', fiscalYear: '2027', subdivide: 'none', startFrom: 'blank' });
  assert.equal(bad.status, 422);
  const res = await app.post('/budgets', { name: 'FY2027 plan', fiscalYear: '2027', subdivide: 'none', startFrom: 'actuals' });
  assert.equal(res.status, 303);
  const id = Number(/\/budgets\/(\d+)/.exec(res.headers.get('location'))[1]);
  const copied = (await q('SELECT count(*)::int AS n, coalesce(sum(amount_cents), 0)::bigint AS total FROM budget_line WHERE budget_id = $1', [id]))[0];
  assert.ok(copied.n > 0, 'last year (2026) actuals copied');
  const rent = app.ids.accounts.rent;
  const save = await app.post(`/budgets/${id}`, { [`c_${rent}_1`]: '1500', [`c_${rent}_2`]: '1,500.00', [`c_${rent}_3`]: '' });
  assert.equal(save.status, 303);
  const rows = await q('SELECT period, amount_cents FROM budget_line WHERE budget_id = $1 AND account_id = $2 ORDER BY period', [id, rent]);
  assert.deepEqual(rows.filter(r => r.period <= 3).map(r => [r.period, Number(r.amount_cents)]), [[1, 150000], [2, 150000]]);
  assert.equal((await app.post(`/budgets/${id}`, { [`c_${rent}_1`]: 'lots' })).status, 422);
  const grid = await (await app.get(`/budgets/${id}?actuals=1`)).text();
  assert.match(grid, /class="muted actual"/);
  assert.match(grid, /Jan 27/);

  await app.post('/settings/classes', { name: 'Retail' });
  const mismatch = await app.post('/budgets', { name: 'By class', fiscalYear: '2027', subdivide: 'class', startFrom: `budget:${id}` });
  assert.equal(mismatch.status, 422, 'copies must be split the same way');
  const split = await app.post('/budgets', { name: 'By class', fiscalYear: '2027', subdivide: 'class', startFrom: 'blank' });
  const sid = Number(/\/budgets\/(\d+)/.exec(split.headers.get('location'))[1]);
  assert.match(await (await app.get(`/budgets/${sid}`)).text(), /Choose which one to budget for/);
  const cls = (await q(`SELECT class_id FROM class WHERE name = 'Retail'`))[0].class_id;
  assert.equal((await app.post(`/budgets/${sid}?dim=${cls}`, { [`c_${rent}_4`]: '99' })).status, 303);
  assert.equal((await q('SELECT dim_id FROM budget_line WHERE budget_id = $1 AND period = 4 AND account_id = $2', [sid, rent]))[0].dim_id, cls);
  assert.equal((await app.post(`/budgets/${sid}/delete`)).status, 303);
});

test('zip: streaming writes the same archive, one file at a time, waiting for a slow reader', async () => {
  const { streamZip } = await import('../lib/zip.js');
  const { Writable } = await import('node:stream');
  const files = Array.from({ length: 40 }, (_, i) => ({ name: `Vendor ${i % 4}/receipt-${i}.txt`, data: Buffer.from(`receipt ${i} `.repeat(200 + i)), date: '2026-10-01T12:00:00Z' }));
  const chunks = [];
  let waits = 0;
  const slow = new Writable({ highWaterMark: 1024, write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); waits++; setImmediate(cb); } });
  async function* oneByOne() { for (const f of files) yield f; }
  await streamZip(slow, oneByOne());
  assert.ok(waits > 40);
  assert.ok(Buffer.concat(chunks).equals(zipFiles(files)), 'byte for byte the same as the in-memory archive');
});
