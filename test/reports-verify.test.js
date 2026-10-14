import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { runReport, hasColumns, drillHref } from '../lib/reports/engine.js';
import { REPORTS } from '../lib/reports/registry.js';
import { startApp } from './app-harness.js';

// Full verification of every report: many option combinations, internal consistency (totals add up, columns add up to
// their total), drill-downs that add up to the amount clicked, and exports that carry the same numbers.
const TODAY = '2026-10-12';
let app, scope, ctx, pool, cust, vend;
const problems = [];
const note = (key, query, message) => problems.push(`${key} ${JSON.stringify(query)}: ${message}`);

before(async () => {
  app = await startApp();
  pool = app.db.pool;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  const [accounting, accounts, sys] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope), systemAccounts(pool, scope.orgId, scope.entityId)]);
  ctx = { accounting, accounts, retainedAccountId: sys.retained, sys };
  cust = (await pool.query(`SELECT customer_id FROM txn WHERE org_id = $1 AND type = 'invoice' AND open_cents > 0 ORDER BY txn_id LIMIT 1`, [scope.orgId])).rows[0].customer_id;
  vend = (await pool.query(`SELECT vendor_id FROM txn WHERE org_id = $1 AND type = 'bill' ORDER BY txn_id LIMIT 1`, [scope.orgId])).rows[0].vendor_id;
});
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});
const run = (key, query) => runReport(pool, { ...scope, key, query, today: TODAY, ...ctx });

// Columns whose total isn't the sum of the lines above it.
const RUNNING = new Set(['balance', 'rate', 'value', 'cost', 'avg', 'booked', 'revalued', 'foreign', 'onhand', 'beginning', 'ending', 'estimated', 'left']);

function checkSummary(def, q, r) {
  for (const row of r.rows) {
    if (!row.cells) continue;
    if (row.cells.length !== r.columns.length) note(def.key, q, `row “${row.label}” has ${row.cells.length} cells for ${r.columns.length} columns`);
    for (const c of row.cells) if ('v' in c && c.v !== null && !Number.isSafeInteger(c.v)) note(def.key, q, `row “${row.label}” has a non-integer amount ${c.v}`);
  }
  // A Total column equals the sum of the columns it totals (time buckets or customers, classes…).
  const totalAt = r.columns.findIndex(c => c.kind === 'value' && c.base?.total);
  const parts = r.columns.map((c, i) => [c, i]).filter(([c]) => c.kind === 'value' && c.base && !c.base.total && c.base.of === null && c.base.key !== 'total' && !c.base.cmp);
  if (totalAt >= 0 && parts.length > 0 && !['asof'].includes(def.kind)) {
    // (Cash at the beginning and end of a period are balances, not flows: a total column isn't their sum.)
    for (const row of r.rows.filter(x => x.cells && !['beginning', 'ending'].includes(x.key))) {
      const sum = parts.reduce((s, [, i]) => s + (row.cells[i].v ?? 0), 0);
      if (sum !== (row.cells[totalAt].v ?? 0)) note(def.key, q, `row “${row.label}”: columns add to ${sum}, total says ${row.cells[totalAt].v}`);
    }
  }
}

function checkDetail(def, q, r) {
  const money = r.columns.filter(c => c.money && !RUNNING.has(c.key) && !c.noTotal);
  let block = [];
  const blockTotals = [];
  for (const row of r.rows) {
    if (row.kind === 'section') { block = []; continue; }
    if (row.kind === 'line') { block.push(row); continue; }
    if (row.kind !== 'total') continue;
    if (row.grand) {
      for (const c of money) {
        if (row.cells?.[c.key] === undefined || row.cells[c.key] === null) continue;
        const pool = blockTotals.length ? blockTotals : r.rows.filter(x => x.kind === 'line' && !x.sub);
        const sum = pool.reduce((s, x) => s + (x.cells?.[c.key] ?? 0), 0);
        // Deposits, checks and journal entries total their header lines only.
        if (sum !== row.cells[c.key] && !['deposit_detail', 'check_detail', 'journal'].includes(def.key)) note(def.key, q, `grand total ${c.key} ${row.cells[c.key]} ≠ ${sum}`);
      }
      continue;
    }
    for (const c of money) {
      if (row.cells?.[c.key] === undefined || row.cells[c.key] === null) continue;
      const sum = block.reduce((s, x) => s + (x.cells[c.key] ?? 0), 0);
      if (sum !== row.cells[c.key]) note(def.key, q, `“${row.label}” ${c.key} ${row.cells[c.key]} ≠ lines ${sum}`);
    }
    blockTotals.push(row);
    block = [];
  }
}

// The total a drill-down target shows (what the clicked amount should equal).
function targetTotal(target) {
  if (target.detail) {
    const totals = target.rows.filter(x => x.kind === 'total' && !x.grand);
    const grand = target.rows.find(x => x.kind === 'total' && x.grand);
    const key = target.columns.find(c => c.key === 'open') ? 'open' : 'amount';
    if (grand?.cells?.[key] !== undefined) return grand.cells[key];
    return totals.reduce((s, x) => s + (x.cells?.[key] ?? 0), 0);
  }
  return null;
}

const variants = def => {
  const v = [{}, { run: '1', basis: 'cash' }, { run: '1', period: 'last_year' }, { run: '1', period: 'all' }, { run: '1', show: 'all' }, { run: '1', show: 'non_zero' },
    { run: '1', customer: String(cust) }, { run: '1', vendor: String(vend) },
    { run: '1', c_fmt_neg: 'paren', c_fmt_div: '1', c_empty: 'dash', c_title: 'Checked', c_banded: '1', c_hide_company: '1' }];
  if (hasColumns(def)) {
    v.push({ run: '1', period: 'this_year_to_date', columns: 'months' }, { run: '1', period: 'this_year_to_date', columns: 'customer' },
      { run: '1', period: 'this_year_to_date', columns: 'class' }, { run: '1', columns: 'quarters', period: 'this_year' },
      { run: '1', cmp_py: '1', cmp_pp: '1', chg: '1', pchg: '1' }, { run: '1', cmp_ytd: '1', cmp_pyytd: '1' },
      { run: '1', pct_row: '1', pct_col: '1', pct_income: '1', pct_expense: '1', columns: 'months', period: 'this_quarter' },
      { run: '1', c_calc_formula: 'C1 * 2', c_calc_name: 'Double' });
  }
  if (def.timeColumns) v.push({ run: '1', columns: 'months', period: 'this_year_to_date' });
  if (def.aging) v.push({ run: '1', aging_days: '15', aging_periods: '8' }, { run: '1', period: 'custom', to: '2026-03-31' });
  return v;
};

test('every report, every option: runs, adds up, and drills down to the same amounts', { timeout: 30 * 60_000 }, async () => {
  let runs = 0, drills = 0;
  for (const def of REPORTS) {
    for (const q of variants(def)) {
      let r;
      try { r = await run(def.key, q); } catch (error) { note(def.key, q, `threw ${error.stack?.split('\n').slice(0, 3).join(' | ')}`); continue; }
      runs++;
      if (!r || !Array.isArray(r.rows) || !Array.isArray(r.columns)) { note(def.key, q, 'no rows or columns'); continue; }
      if (r.detail) checkDetail(def, q, r); else checkSummary(def, q, r);
      if (q.c_calc_formula && !r.detail && r.columns.at(-1).label !== 'Double') note(def.key, q, 'calculated column missing');
      if (q.c_calc_formula && !r.detail) {
        for (const row of r.rows.filter(x => x.cells?.[0] && 'v' in x.cells[0] && x.cells[0].v !== null)) {
          if (row.cells.at(-1).v !== row.cells[0].v * 2) { note(def.key, q, `calculated column wrong on “${row.label}”`); break; }
        }
      }
      // Drill-downs: up to six amounts per report, the target's total must equal the amount clicked.
      if (!r.drill || Object.keys(q).length > 2) continue;
      let tried = 0;
      for (const row of r.rows) {
        if (!row.cells || tried >= 6) continue;
        for (const [i, col] of r.columns.entries()) {
          const d = r.drill(row, col);
          if (!d || !row.cells[i]?.v || tried >= 6) continue;
          tried++; drills++;
          const href = drillHref(r, d);
          const [path, qs] = href.split('?');
          const key = path.split('/').at(-1);
          const target = await run(key, Object.fromEntries(new URLSearchParams(qs)));
          const total = targetTotal(target);
          // The cash flow shows the cash effect (an asset going up is cash going down) and the trial balance shows credits as
          // positive amounts, so those match the account's detail in size, not sign.
          const same = ['cashflow', 'tb'].includes(def.kind) ? Math.abs(total ?? 0) === Math.abs(row.cells[i].v) : total === row.cells[i].v;
          if (total !== null && !same && !['kpis', 'project_profit', 'income_by_customer', 'budget_vs_actuals'].includes(def.kind)) {
            note(def.key, q, `drill “${row.label}” / ${col.label}: ${row.cells[i].v} but ${key} totals ${total}`);
          }
          const res = await app.get(href);
          if (res.status !== 200) note(def.key, q, `drill link ${href} → ${res.status}`);
        }
      }
    }
  }
  console.log(`verified ${runs} report runs and ${drills} drill-downs across ${REPORTS.length} reports`);
  assert.deepEqual(problems, []);
});

test('every report’s Excel and CSV carry the same numbers as the page; PDFs open', { timeout: 30 * 60_000 }, async () => {
  const bad = [];
  for (const def of REPORTS) {
    const r = await run(def.key, {});
    const xres = await app.get(`/reports/r/${def.key}.xlsx`);
    if (xres.status !== 200) { bad.push(`${def.key}.xlsx → ${xres.status}`); continue; }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await xres.arrayBuffer()));
    const ws = wb.worksheets[0];
    const sheet = [];
    // A formula cell holds its cached result (Excel also recalculates on open).
    ws.eachRow(row => sheet.push(row.values.slice(1).map(v => (v && typeof v === 'object' && 'formula' in v ? (v.result ?? 0) : v))));
    if (!r.detail) {
      for (const row of r.rows.filter(x => x.cells && x.cells[0] && 'v' in x.cells[0] && x.cells[0].v !== null)) {
        const line = sheet.find(s => s[0] === row.label && typeof s[1] === 'number');
        if (!line) { bad.push(`${def.key}: Excel has no row “${row.label}”`); continue; }
        if (Math.round(Number(line[1]) * 100) !== row.cells[0].v) { bad.push(`${def.key}: Excel “${row.label}” ${line[1]} ≠ ${row.cells[0].v / 100}`); }
      }
    } else {
      const moneyAt = r.columns.findIndex(c => c.money);
      const lines = r.rows.filter(x => x.kind === 'line');
      if (moneyAt >= 0 && lines.length) {
        const sheetSum = sheet.slice(0).filter(s => typeof s[moneyAt] === 'number' && s.length >= r.columns.length - 1).reduce((s, x) => s + Math.round(x[moneyAt] * 100), 0);
        const pageSum = r.rows.filter(x => x.kind !== 'section').reduce((s, x) => s + (x.cells?.[r.columns[moneyAt].key] ?? 0), 0);
        if (sheetSum !== pageSum) bad.push(`${def.key}: Excel ${r.columns[moneyAt].key} column sums to ${sheetSum}, page ${pageSum}`);
      }
    }
    const csv = await (await app.get(`/reports/r/${def.key}.csv`)).text();
    const csvLines = csv.trim().split('\r\n').length;
    const expected = r.rows.length;
    if (csvLines < expected) bad.push(`${def.key}: CSV has ${csvLines} lines for ${expected} rows`);
    const pdf = Buffer.from(await (await app.get(`/reports/r/${def.key}.pdf`)).arrayBuffer());
    if (pdf.subarray(0, 4).toString() !== '%PDF') bad.push(`${def.key}: PDF didn’t open`);
  }
  assert.deepEqual(bad, []);
});
