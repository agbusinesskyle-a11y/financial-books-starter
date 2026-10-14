import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { runReport } from '../lib/reports/engine.js';
import { startApp } from './app-harness.js';

// Reports R4b — the report builder.
const TODAY = '2026-10-12';
let app, scope, ctx, pool;
before(async () => {
  app = await startApp();
  pool = app.db.pool;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  const [accounting, accounts, sys] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope), systemAccounts(pool, scope.orgId, scope.entityId)]);
  ctx = { accounting, accounts, retainedAccountId: sys.retained, sys };
});
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});
const run = (query = {}) => runReport(pool, { ...scope, key: 'report_builder', query: { run: '1', period: 'this_year_to_date', ...query }, today: TODAY, ...ctx });
const q = async (sql, params = [scope.orgId, scope.entityId]) => (await pool.query(sql, params)).rows;
const lines = r => r.rows.filter(x => x.kind === 'line');

test('invoices: every invoice in the period with its open balance and status; grouped totals add up', async () => {
  const rep = await run({ b_source: 'invoices', b_group: 'name' });
  const invoices = await q(`SELECT txn_id, open_cents::bigint AS open, total_cents::bigint AS total, due_date::text AS due, voided_at FROM txn
     WHERE org_id = $1 AND entity_id = $2 AND type = 'invoice' AND txn_date BETWEEN '2026-01-01' AND '${TODAY}'`);
  assert.equal(lines(rep).length, invoices.length);
  assert.deepEqual(rep.columns.map(c => c.key), ['date', 'num', 'name', 'due', 'status', 'amount', 'open']);
  for (const r of lines(rep)) {
    const inv = invoices.find(i => Number(i.txn_id) === r.txnId);
    if (inv.voided_at) { assert.equal(r.cells.status, 'Voided'); continue; }
    assert.equal(r.cells.open, Number(inv.open));
    assert.equal(r.cells.status, Number(inv.open) === 0 ? 'Paid' : inv.due < TODAY ? 'Overdue' : 'Open', `invoice ${r.cells.num}`);
  }
  const groupTotals = rep.rows.filter(r => r.kind === 'total' && !r.grand);
  const grand = rep.rows.find(r => r.grand);
  assert.equal(groupTotals.reduce((s, r) => s + r.cells.amount, 0), grand.cells.amount);
  assert.equal(grand.cells.open, invoices.filter(i => !i.voided_at).reduce((s, i) => s + Number(i.open), 0));
  assert.ok(rep.rows.filter(r => r.kind === 'section').every(r => /\(\d+\)$/.test(r.label)), 'each group shows its count');
});

test('each starting point brings in only its own transactions; columns, sorting and month grouping work', async () => {
  for (const [source, types] of [['sales', ['invoice', 'sales_receipt', 'credit_memo']], ['expenses', ['expense', 'check', 'bill', 'vendor_credit']], ['bills', ['bill']], ['journal', ['journal_entry']]]) {
    const rep = await run({ b_source: source });
    const [{ n }] = await q(`SELECT count(*) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = ANY($3) AND txn_date BETWEEN '2026-01-01' AND '${TODAY}'`,
      [scope.orgId, scope.entityId, types]);
    assert.equal(lines(rep).length, Number(n), source);
    assert.ok(lines(rep).every(r => types.includes(r.txnType)), source);
  }
  const banking = await run({ b_source: 'banking' });
  const bankIds = new Set((await q(`SELECT DISTINCT p.txn_id FROM posting p JOIN account a ON a.account_id = p.account_id
     WHERE p.org_id = $1 AND p.entity_id = $2 AND a.type = 'bank' AND p.txn_date BETWEEN '2026-01-01' AND '${TODAY}'`)).map(r => Number(r.txn_id)));
  assert.ok(lines(banking).length > 0);
  assert.ok(lines(banking).every(r => bankIds.has(r.txnId)));

  const sorted = await run({ b_source: 'expenses', b_sort: 'amount', b_dir: 'desc', b_date: '1', b_name: '1', b_amount: '1', b_status: '1' });
  assert.deepEqual(sorted.columns.map(c => c.key), ['date', 'name', 'status', 'amount']);
  const amounts = lines(sorted).map(r => r.cells.amount);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a));

  const byMonth = await run({ b_source: 'sales', b_group: 'month' });
  const sections = byMonth.rows.filter(r => r.kind === 'section').map(r => r.label);
  assert.match(sections[0], /^January 2026 \(\d+\)$/);
});

test('the builder page, exports, and saving a built report keep every choice', async () => {
  const qs = 'run=1&period=this_year_to_date&b_source=bills&b_group=status&b_date=1&b_name=1&b_amount=1&b_open=1&b_approval=1';
  const page = await (await app.get(`/reports/r/report_builder?${qs}`)).text();
  assert.match(page, /<option value="bills" selected>/);
  assert.match(page, /name="b_approval" value="1" checked/);
  assert.doesNotMatch(page, /name="b_memo" value="1" checked/);
  for (const ext of ['.csv', '.xlsx', '.pdf']) assert.equal((await app.get(`/reports/r/report_builder${ext}?${qs}`)).status, 200, ext);
  const res = await app.post('/reports/r/report_builder/save', { q: qs, name: 'Bills by status', mode: 'new' });
  const id = Number(/saved=(\d+)/.exec(res.headers.get('location'))[1]);
  const back = (await app.get(`/reports/saved/${id}`)).headers.get('location');
  assert.match(back, /b_source=bills/);
  assert.match(back, /b_approval=1/);
  assert.match(await (await app.get('/reports/custom')).text(), /Bills by status/);
  assert.match(await (await app.get('/reports/custom')).text(), /href="\/reports\/r\/report_builder">Create new report/);
});
