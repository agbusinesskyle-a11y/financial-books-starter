import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseMultipart, boundaryOf, MultipartError } from '../lib/multipart.js';
import { cleanFilename, downloadType, attachmentHeader } from '../lib/data/documents.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';

// ---- multipart and file-name handling ----

const multipart = (boundary, parts) => Buffer.concat([...parts.flatMap(p => [
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}\r\n` +
    (p.type ? `Content-Type: ${p.type}\r\n` : '') + '\r\n'),
  Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value), Buffer.from('\r\n'),
]), Buffer.from(`--${boundary}--\r\n`)]);

test('multipart: fields and a binary file survive intact', () => {
  const bytes = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255, 254]); // includes CR LF and "--"
  const body = multipart('XyZ', [{ name: 'csrf', value: 'tok' }, { name: 'file', filename: 'ticket.pdf', type: 'application/pdf', value: bytes }, { name: 'note', value: 'Signed ✓' }]);
  const { fields, files } = parseMultipart(body, 'XyZ');
  assert.equal(fields.get('csrf'), 'tok');
  assert.equal(fields.get('note'), 'Signed ✓');
  assert.equal(files.length, 1);
  assert.deepEqual([files[0].filename, files[0].contentType], ['ticket.pdf', 'application/pdf']);
  assert.ok(files[0].data.equals(bytes));
  assert.equal(parseMultipart(multipart('b', [{ name: 'file', filename: '', value: '' }]), 'b').files.length, 0, 'no file chosen');
  assert.equal(boundaryOf('multipart/form-data; boundary=----WebKitFormBoundaryAbC123'), '----WebKitFormBoundaryAbC123');
  assert.equal(boundaryOf('application/x-www-form-urlencoded'), null);
  assert.throws(() => parseMultipart(Buffer.from('garbage'), 'b'), MultipartError);
  assert.throws(() => parseMultipart(Buffer.from('--b\r\nContent-Disposition: form-data; name="x"\r\n\r\nno end'), 'b'), MultipartError);
});

test('file names are cleaned and downloads are typed by extension', () => {
  assert.equal(cleanFilename('C:\\Users\\pat\\Desktop\\bill "final".pdf'), 'bill final.pdf');
  assert.equal(cleanFilename('../../etc/passwd'), 'passwd');
  assert.equal(cleanFilename('..'), null);
  assert.equal(cleanFilename(`${'a'.repeat(300)}.pdf`).length, 200);
  assert.ok(cleanFilename(`${'a'.repeat(300)}.pdf`).endsWith('.pdf'));
  assert.equal(downloadType('Photo.JPG'), 'image/jpeg');
  assert.equal(downloadType('page.html'), 'application/octet-stream');
  assert.equal(downloadType('logo.svg'), 'application/octet-stream');
  assert.equal(attachmentHeader('Récibo.pdf'), `attachment; filename="R_cibo.pdf"; filename*=UTF-8''R%C3%A9cibo.pdf`);
});

// ---- through the app ----

let app, cust;
before(async () => {
  app = await startApp();
  cust = app.ids.customers.crosstimbers;
});
after(async () => { await app.close(); });

const upload = (path, parts, { csrf = app.csrf } = {}) => {
  const boundary = '----fbtest' + Math.random().toString(16).slice(2);
  return app.raw(path, {
    method: 'POST', body: multipart(boundary, [{ name: 'csrf', value: csrf }, ...parts]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
};
const lines = (desc, qty, rate) => { const p = new URLSearchParams(); p.append('line_item', ''); p.append('line_desc', desc); p.append('line_qty', qty); p.append('line_rate', rate); return p; };

test('projects: create, assign invoices, totals, edit, delete rules', async () => {
  assert.match(await (await app.get(`/customers/${cust}?tab=projects`)).text(), /No projects for/);
  const created = await app.post(`/customers/${cust}/projects`, { name: 'Barn rebuild', status: 'in_progress', startDate: '2026-10-01', endDate: '', description: 'Feed for the crew' });
  assert.equal(created.status, 303);
  const projectId = Number(/\/projects\/(\d+)/.exec(created.headers.get('location'))[1]);
  assert.equal((await app.post(`/customers/${cust}/projects`, { name: 'Barn rebuild' })).status, 422, 'names are unique per customer');

  const form = await (await app.get(`/txns/new?type=invoice&customer=${cust}&project=${projectId}`)).text();
  assert.match(form, new RegExp(`<option value="${projectId}" selected>Barn rebuild</option>`));
  const inv = lines('Range cubes', '4', '250');
  for (const [k, v] of Object.entries({ type: 'invoice', customer_id: String(cust), txn_date: TODAY, project_id: String(projectId) })) inv.set(k, v);
  assert.equal((await app.post('/txns', inv)).status, 303);
  const invId = (await app.db.pool.query('SELECT txn_id FROM txn WHERE project_id = $1', [projectId])).rows[0].txn_id;
  assert.match(await (await app.get(`/txns/${invId}`)).text(), /Barn rebuild<\/a>/);

  // Pay half of it.
  assert.equal((await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: TODAY, amount: '400.00', [`apply_${invId}`]: '400.00' })).status, 303);
  const page = await (await app.get(`/projects/${projectId}`)).text();
  assert.match(page, /<dt>Invoiced<\/dt><dd>\$1,000\.00<\/dd>/);
  assert.match(page, /<dt>Paid<\/dt><dd>\$400\.00<\/dd>/);
  assert.match(page, /<dt>Open<\/dt><dd>\$600\.00<\/dd>/);
  assert.match(await (await app.get(`/customers/${cust}?tab=projects`)).text(), /Barn rebuild/);

  // Another customer's project can't be used.
  const other = (await app.db.pool.query(`INSERT INTO project (org_id, customer_id, name) VALUES ($1, $2, 'Elsewhere') RETURNING project_id`,
    [app.ids.orgId, app.ids.customers.hilltop])).rows[0].project_id;
  inv.set('project_id', String(other));
  const bad = await app.post('/txns', inv);
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /this customer’s projects/);

  assert.equal((await app.post(`/projects/${projectId}`, { name: 'Barn rebuild', status: 'completed', startDate: '2026-10-01', endDate: '2026-09-01' })).status, 422);
  assert.equal((await app.post(`/projects/${projectId}`, { name: 'Barn rebuild', status: 'completed', startDate: '2026-10-01', endDate: '2026-10-30' })).status, 303);
  assert.match(await (await app.get(`/projects/${projectId}`)).text(), /Completed/);
  assert.equal((await app.post(`/projects/${projectId}/delete`)).headers.get('location'), `/projects/${projectId}`);
  assert.match(await (await app.get(`/projects/${projectId}`)).text(), /has transactions/);
  const empty = (await app.db.pool.query(`INSERT INTO project (org_id, customer_id, name) VALUES ($1, $2, 'Empty') RETURNING project_id`, [app.ids.orgId, cust])).rows[0].project_id;
  assert.equal((await app.post(`/projects/${empty}/delete`)).headers.get('location'), `/customers/${cust}?tab=projects`);
});

test('documents: upload, attach to a transaction, download, delete', async () => {
  const content = Buffer.concat([Buffer.from('%PDF-1.4 delivery ticket '), Buffer.alloc(2048, 7)]);
  const txnId = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' LIMIT 1`, [cust])).rows[0].txn_id;
  const res = await upload(`/customers/${cust}/documents`, [{ name: 'file', filename: 'Ticket #4411.pdf', type: 'application/pdf', value: content },
    { name: 'txn_id', value: String(txnId) }, { name: 'note', value: 'Signed by Dale' }]);
  assert.equal(res.status, 303);
  const tab = await (await app.get(`/customers/${cust}?tab=documents`)).text();
  assert.match(tab, /Document added\./);
  assert.match(tab, /Ticket #4411\.pdf/);
  assert.match(tab, /Signed by Dale/);
  const doc = (await app.db.pool.query('SELECT document_id, sha256, size_bytes FROM document WHERE customer_id = $1', [cust])).rows[0];
  assert.equal(doc.sha256, createHash('sha256').update(content).digest('hex'));
  assert.match(await (await app.get(`/txns/${txnId}`)).text(), /Ticket #4411\.pdf/);

  const dl = await app.get(`/documents/${doc.document_id}`);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="Ticket #4411\.pdf"/);
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(content));
  assert.match(await (await app.get(`/customers/${cust}?tab=activity`)).text(), /Document “Ticket #4411\.pdf” added to Invoice/);

  // An HTML upload is stored but only ever downloaded as bytes.
  await upload(`/customers/${cust}/documents`, [{ name: 'file', filename: 'x.html', type: 'text/html', value: '<script>alert(1)</script>' }]);
  const html = (await app.db.pool.query(`SELECT document_id FROM document WHERE filename = 'x.html'`)).rows[0].document_id;
  assert.equal((await app.get(`/documents/${html}`)).headers.get('content-type'), 'application/octet-stream');

  assert.equal((await app.post(`/documents/${doc.document_id}/delete`)).status, 303);
  assert.equal((await app.get(`/documents/${doc.document_id}`)).status, 404);
});

test('documents: rejected uploads', async () => {
  const noFile = await upload(`/customers/${cust}/documents`, [{ name: 'file', filename: '', value: '' }]);
  assert.equal(noFile.status, 422);
  assert.match(await noFile.text(), /Choose a file/);
  assert.equal((await upload(`/customers/${cust}/documents`, [{ name: 'file', filename: 'a.txt', value: 'x' }], { csrf: 'nope' })).status, 403);
  const foreign = (await app.db.pool.query('SELECT txn_id FROM txn WHERE customer_id <> $1 LIMIT 1', [cust])).rows[0].txn_id;
  const wrongTxn = await upload(`/customers/${cust}/documents`, [{ name: 'file', filename: 'a.txt', value: 'x' }, { name: 'txn_id', value: String(foreign) }]);
  assert.equal(wrongTxn.status, 422);
  assert.equal((await upload('/txns', [{ name: 'file', filename: 'a.txt', value: 'x' }])).status, 415);
  const tooBig = await upload(`/customers/${cust}/documents`, [{ name: 'file', filename: 'big.bin', value: Buffer.alloc(10 * 1024 * 1024 + 70 * 1024) }]);
  assert.equal(tooBig.status, 413);
});
