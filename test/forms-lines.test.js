import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { tieout } from './tieout.js';
import { pastedRows } from '../services/app/index.js';

// Stage F3: QBO's line tools — subtotal and text lines (shown, never posted), lines pasted from a spreadsheet, and the
// duplicate / delete / clear / add buttons on every line.
const TODAY = '2026-10-12';
let app, C, items, t;
before(async () => {
  app = await startApp();
  C = Object.values(app.ids.customers)[0];
  ({ rows: items } = await app.db.pool.query(`SELECT item_id, name, rate_cents FROM item WHERE entity_id = $1 AND kind <> 'inventory' AND rate_cents > 0 ORDER BY item_id LIMIT 2`, [app.ids.entityId]));
  t = tieout(app);
});
after(async () => { await app.close(); });

// rows: [{ kind?, item?, desc?, qty?, rate? }]
const doc = (type, rows, more = {}) => {
  const p = new URLSearchParams({ type, customer_id: String(C), txn_date: TODAY, then: 'save', ...more });
  for (const r of rows) {
    p.append('line_kind', r.kind ?? 'item'); p.append('line_item', r.item ? String(r.item) : ''); p.append('line_desc', r.desc ?? ''); p.append('line_qty', r.qty ?? '');
    p.append('line_rate', r.rate ?? ''); p.append('line_service', ''); p.append('line_est', ''); p.append('line_bill', ''); p.append('line_time', '');
  }
  return p;
};
const idOf = r => Number(/\/txns\/(\d+)/.exec(r.headers.get('location'))[1]);

test('subtotal and text lines: on the invoice and its PDF, never in the books', async () => {
  const [a, b] = items;
  const before = await t.snapshot();
  const r = await app.post('/txns', doc('invoice', [
    { kind: 'subtotal', desc: 'Nothing above me' },
    { item: a.item_id, qty: '2', rate: '10.00' }, { item: b.item_id, qty: '1', rate: '5.00' },
    { kind: 'subtotal', desc: 'Hay' },
    { kind: 'text', desc: 'Delivered to the north barn' },
    { item: a.item_id, qty: '1', rate: '7.50' },
    { kind: 'text', desc: '' },
  ]));
  assert.equal(r.status, 303, await r.clone().text());
  const id = idOf(r);
  const { rows: lines } = await app.db.pool.query('SELECT line_no, kind, description, amount_cents FROM txn_line WHERE txn_id = $1 ORDER BY line_no', [id]);
  assert.deepEqual(lines.map(l => [l.kind, l.description, Number(l.amount_cents)]), [
    ['item', a.name, 2000], ['item', b.name, 500], ['subtotal', 'Hay', 0], ['text', 'Delivered to the north barn', 0], ['item', a.name, 750]],
  'a subtotal at the top and an empty text line are dropped');
  const { rows: [x] } = await app.db.pool.query('SELECT total_cents FROM txn WHERE txn_id = $1', [id]);
  assert.equal(Number(x.total_cents), 3250);
  const after = await t.snapshot();
  t.checkTied(after, 'subtotal/text lines');
  // Only the product lines post: A/R up by the total, income the other side, nothing for the subtotal or the text.
  const { rows: posts } = await app.db.pool.query(`SELECT a.system_key, a.type, p.line_no, p.amount_cents FROM posting p JOIN account a ON a.account_id = p.account_id WHERE p.txn_id = $1`, [id]);
  assert.equal(posts.filter(p => p.system_key === 'ar').reduce((s2, p) => s2 + Number(p.amount_cents), 0), 3250);
  assert.equal(posts.filter(p => p.type === 'income').reduce((s2, p) => s2 + Number(p.amount_cents), 0), -3250);
  assert.ok(!posts.some(p => [3, 4].includes(p.line_no)), 'no postings for lines 3 and 4');
  const page = await (await app.get(`/txns/${id}`)).text();
  assert.match(page, /<tr class="subtotal-line"><td>3<\/td><td colspan="4">Hay<\/td><td class="num">\$25\.00<\/td><\/tr>/);
  assert.match(page, /<tr class="text-line"><td>4<\/td><td colspan="5"><em>Delivered to the north barn<\/em><\/td><\/tr>/);
  const pdf = await app.get(`/txns/${id}.pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  // The editor shows them as subtotal / text rows again.
  const edit = await (await app.get(`/txns/${id}/edit`)).text();
  assert.match(edit, /<tr data-line class="subtotal-line">/);
  assert.match(edit, /name="line_kind" value="text"/);
  // Only words is not an invoice.
  const bad = await app.post('/txns', doc('invoice', [{ kind: 'text', desc: 'Just a note' }]));
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /Add at least one line/);
});

test('the database keeps subtotal and text lines worth nothing', async () => {
  const { rows: [l] } = await app.db.pool.query(`SELECT txn_id, line_no FROM txn_line WHERE kind = 'subtotal' LIMIT 1`);
  await assert.rejects(app.db.pool.query('UPDATE txn_line SET amount_cents = 100 WHERE txn_id = $1 AND line_no = $2', [l.txn_id, l.line_no]), /txn_line_kind_amount/);
});

test('lines pasted from a spreadsheet (without the page’s help)', async () => {
  assert.deepEqual(pastedRows('Hay\tSmall bales\t20\t$12.50\r\n\n"Feed, sweet",x,1,3'), [['Hay', 'Small bales', '20', '12.50'], ['"Feed', 'sweet"', 'x', '1', '3']]);
  const [a] = items;
  const p = doc('invoice', [{ item: items[1].item_id, qty: '1', rate: '1.00' }], { paste_lines: `${a.name.toUpperCase()}\tFrom the sheet\t3\t4.00\nMystery thing\t\t2\t1.50` });
  const r = await app.post('/txns', p);
  assert.equal(r.status, 303, await r.clone().text());
  const { rows } = await app.db.pool.query('SELECT item_id, description, quantity::float8 AS q, amount_cents FROM txn_line WHERE txn_id = $1 ORDER BY line_no', [idOf(r)]);
  assert.deepEqual(rows.slice(1).map(x => [x.item_id === null ? null : Number(x.item_id), x.description, x.q, Number(x.amount_cents)]),
    [[Number(a.item_id), 'From the sheet', 3, 1200], [null, 'Mystery thing', 2, 300]], 'the product is found by name, else the name is the description');
});

test('a whole estimate invoiced brings its subtotal and text lines', async () => {
  const [a] = items;
  const est = await app.post('/txns', doc('estimate', [{ item: a.item_id, qty: '1', rate: '9.00' }, { kind: 'subtotal', desc: 'Part one' }, { kind: 'text', desc: 'Thanks!' }]));
  const id = idOf(est);
  const page = await (await app.get(`/txns/${id}/invoice?mode=full`)).text();
  assert.match(page, /name="line_kind" value="subtotal"/);
  assert.match(page, /name="line_kind" value="text"/);
});

test('every line has duplicate and delete; the table has add subtotal, add text, clear and paste', async () => {
  const page = await (await app.get('/txns/new?type=invoice')).text();
  assert.match(page, /data-dup-line aria-label="Duplicate line 1"/);
  assert.match(page, /data-del-line aria-label="Delete line 1"/);
  for (const k of ['data-add-kind="subtotal"', 'data-add-kind="text"', 'data-clear-lines', 'data-paste-apply', '<template data-row="item">', '<template data-row="subtotal">'])
    assert.ok(page.includes(k), k);
  // Recurring templates keep the plain table (they don't store line kinds).
  const tpl = await (await app.get(`/customers/${C}/recurring/new`)).text();
  assert.doesNotMatch(tpl, /data-dup-line/);
});
