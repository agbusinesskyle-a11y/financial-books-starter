import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { saveAiSettings } from '../lib/ai/provider.js';
import { settingsKey } from '../lib/secrets.js';
import { sniffType, checkBillReading } from '../lib/ai/read-bill.js';

// Stage F6: upload a bill or receipt on a new bill / expense / check. The AI provider reads it and fills the form in;
// saving attaches the file. Nothing is saved by reading.
const ENV = { SETTINGS_KEY: 'cd'.repeat(32) };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
let reading = null, fails = false;
const aiCalls = [];
const aiFetch = async (url, init) => {
  aiCalls.push(JSON.parse(init.body));
  if (fails) return { ok: false, status: 529, json: async () => ({ error: { message: 'Overloaded' } }), text: async () => 'Overloaded' };
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(reading) }], usage: { input_tokens: 900, output_tokens: 60 }, stop_reason: 'end_turn' }) };
};
let app, S, V, vendorName, vendorAccount;
before(async () => {
  app = await startApp({ aiFetch, env: ENV });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  const { rows: [v] } = await app.db.pool.query(`SELECT vendor_id, display_name, default_expense_account_id FROM vendor WHERE entity_id = $1 AND default_expense_account_id IS NOT NULL ORDER BY vendor_id LIMIT 1`, [S.entityId]);
  ({ vendor_id: V, display_name: vendorName, default_expense_account_id: vendorAccount } = v);
  await saveAiSettings(app.db.pool, { ...S, provider: 'anthropic', apiKey: 'sk-ant-test-0000000000000000000000000000', key: settingsKey(ENV), actor: 'tester' });
});
after(async () => { await app.close(); });

const upload = async (type, data = PDF, name = 'bill.pdf') => {
  const fd = new FormData();
  fd.set('csrf', app.csrf);
  fd.set('type', type);
  fd.set('file', new Blob([data]), name);
  return app.raw('/vtxns/read', { method: 'POST', body: fd });
};
const count = async () => Number((await app.db.pool.query(`SELECT count(*) FROM txn WHERE entity_id = $1`, [S.entityId])).rows[0].count);

test('file kinds and readings', () => {
  assert.equal(sniffType(PDF), 'application/pdf');
  assert.equal(sniffType(JPEG), 'image/jpeg');
  assert.equal(sniffType(Buffer.from('hello world!')), null);
  const r = checkBillReading('Sure: {"vendor":"X","date":"2026-10-01","due_date":"2026-10-31","number":" INV 99 ","total":"12.50","confidence":"high"}');
  assert.deepEqual([r.vendor, r.date, r.due_date, r.number, r.total_cents], ['X', '2026-10-01', '2026-10-31', 'INV 99', 1250]);
});

test('a bill is read into the form, and saving attaches the file', async () => {
  const page = await (await app.get('/vtxns/new?type=bill')).text();
  assert.match(page, /action="\/vtxns\/read" enctype="multipart\/form-data"/);
  reading = { vendor: vendorName.toUpperCase(), date: '2026-10-02', due_date: '2026-11-01', number: 'A-5521', total: 1234.56, summary: 'Range cubes', confidence: 'high' };
  const before = await count();
  aiCalls.length = 0;
  const r = await upload('bill');
  assert.equal(r.status, 200);
  const form = await r.text();
  assert.equal(await count(), before, 'reading saves nothing');
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].messages[0].content[0].type, 'document', 'the PDF is sent to the model');
  assert.match(form, new RegExp(`<option value="${V}" selected>`));
  assert.match(form, /name="txn_date" value="2026-10-02"/);
  assert.match(form, /name="due_date" value="2026-11-01"/);
  assert.match(form, /name="doc_number" value="A-5521"/);
  assert.match(form, /name="cat_amount" value="1234\.56"/);
  assert.match(form, new RegExp(`<option value="${vendorAccount}" selected>`));
  assert.match(form, /Filled in from bill\.pdf/);
  const uploadId = /name="upload_id" value="(\d+)"/.exec(form)[1];
  assert.doesNotMatch(form, /data-upload-bill/, 'no second upload box');
  const file = await app.get(`/vtxns/uploads/${uploadId}`);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  // Save it (as the filled-in form would post).
  const p = new URLSearchParams({ type: 'bill', vendor_id: String(V), txn_date: '2026-10-02', due_date: '2026-11-01', doc_number: 'A-5521', memo: 'Range cubes',
    upload_id: uploadId, then: 'close' });
  p.append('cat_account', String(vendorAccount)); p.append('cat_desc', 'Range cubes'); p.append('cat_amount', '1234.56');
  const saved = await app.post('/vtxns', p);
  assert.equal(saved.status, 303, await saved.clone().text());
  const id = Number(/\/vtxns\/(\d+)/.exec(saved.headers.get('location'))[1]);
  const { rows: docs } = await app.db.pool.query('SELECT filename, vendor_id, note FROM document WHERE txn_id = $1', [id]);
  assert.deepEqual(docs.map(d => [d.filename, Number(d.vendor_id), d.note]), [['bill.pdf', V, 'Uploaded on the form']]);
  // An upload is used once.
  const again = await app.post('/vtxns', new URLSearchParams([...p.entries()].map(([k, v]) => [k, k === 'doc_number' ? 'A-5522' : v])));
  assert.equal(again.status, 303);
  const id2 = Number(/\/vtxns\/(\d+)/.exec(again.headers.get('location'))[1]);
  assert.equal((await app.db.pool.query('SELECT 1 FROM document WHERE txn_id = $1', [id2])).rowCount, 0);
});

test('an unknown vendor, a photo on an expense, and a reading that fails', async () => {
  reading = { vendor: 'Nowhere Hardware 4471', date: '2026-10-05', total: 18.4, summary: 'Bolts', confidence: 'medium' };
  const r = await upload('expense', JPEG, 'receipt.jpg');
  const form = await r.text();
  assert.match(form, /“Nowhere Hardware 4471” isn’t one of your vendors yet/);
  assert.match(form, /medium confidence/);
  assert.match(form, /name="cat_amount" value="18\.40"/);
  assert.doesNotMatch(form, /name="doc_number" value="[^"]+"/, 'no bill number on an expense');
  fails = true;
  const bad = await (await upload('check')).text();
  fails = false;
  assert.match(bad, /couldn’t be read/);
  assert.match(bad, /name="upload_id" value="\d+"/, 'the file still rides along');
});

test('wrong files and other companies’ uploads are refused', async () => {
  const r = await upload('bill', Buffer.from('just some text'), 'notes.txt');
  assert.equal(r.status, 422);
  assert.match(await r.text(), /Upload a PDF, JPEG, PNG/);
  assert.equal((await app.get('/vtxns/uploads/999999999')).status, 404);
});
