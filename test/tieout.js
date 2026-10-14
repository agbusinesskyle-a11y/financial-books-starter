import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { getSummary } from '../lib/data/customers.js';
import { getVendor } from '../lib/data/vendors.js';
import { runReport } from '../lib/reports/engine.js';
import { homeData } from '../lib/data/home.js';

// The deep tie-out checker. snapshot() reads the books every way the app shows them; checkTied() proves those views agree
// with each other; expectChange() proves an action moved exactly what it should (and nothing else).

export const TODAY = '2026-10-12';

export function tieout(app) {
  const pool = app.db.pool;
  const scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  let sys = null;
  const ctx = async () => {
    const [accounting, accounts, s] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope), systemAccounts(pool, scope.orgId, scope.entityId)]);
    sys = s;
    return { accounting, accounts, retainedAccountId: s.retained, sys: s };
  };
  const run = async (key, query, basis = 'accrual') => runReport(pool, { ...scope, key, query: { run: '1', basis, ...query }, today: TODAY, ...(await ctx()) });
  const rowsBy = (report, key) => new Map(report.rows.filter(r => r[key]).map(r => [Number(r[key]), r.values.at(-1)]));
  const total = (report, re) => report.rows.find(r => re.test(r.label ?? ''))?.values?.at(-1) ?? 0;

  async function snapshot() {
    const check = await ledgerCheck(pool, scope);
    const posts = (await pool.query(`SELECT account_id, sum(amount_cents)::bigint AS s FROM posting WHERE org_id = $1 AND entity_id = $2 GROUP BY account_id`,
      [scope.orgId, scope.entityId])).rows;
    const accounts = new Map(posts.map(r => [Number(r.account_id), Number(r.s)]));
    const customers = (await pool.query('SELECT customer_id FROM customer WHERE org_id = $1 AND entity_id = $2', [scope.orgId, scope.entityId])).rows.map(r => Number(r.customer_id));
    const vendors = (await pool.query('SELECT vendor_id FROM vendor WHERE org_id = $1 AND entity_id = $2', [scope.orgId, scope.entityId])).rows.map(r => Number(r.vendor_id));
    const cust = new Map(), vend = new Map();
    for (const id of customers) cust.set(id, await getSummary(pool, { orgId: scope.orgId, customerId: id, today: TODAY }));
    for (const id of vendors) vend.set(id, await getVendor(pool, { ...scope, vendorId: id, today: TODAY }));
    const [arAging, cbs, apAging, vbs, tb, bs, pl, inv, bsCash, plCash, home] = await Promise.all([
      run('ar_aging_summary', { period: 'today' }), run('customer_balance_summary', { period: 'today' }),
      run('ap_aging_summary', { period: 'today' }), run('vendor_balance_summary', { period: 'today' }),
      run('trial_balance', { period: 'today' }), run('balance_sheet', { period: 'today' }), run('profit_and_loss', { period: 'this_year_to_date' }),
      run('inventory_valuation_summary', { period: 'today' }),
      run('balance_sheet', { period: 'today' }, 'cash'), run('profit_and_loss', { period: 'this_year_to_date' }, 'cash'),
      homeData(pool, { ...scope, today: TODAY }),
    ]);
    const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM txn WHERE org_id = $1) AS txns, (SELECT count(*)::int FROM activity_event WHERE org_id = $1) AS events,
      (SELECT count(*)::int FROM audit_log) AS audits, (SELECT count(*)::int FROM posting WHERE org_id = $1) AS postings`, [scope.orgId])).rows[0];
    const pnlIds = new Set((await pool.query(`SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2
      AND type IN ('income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense')`, [scope.orgId, scope.entityId])).rows.map(r => Number(r.account_id)));
    return { check, accounts, cust, vend, arAging, cbs, apAging, vbs, tb, bs, pl, inv, bsCash, plCash, home, counts, sys, pnlIds };
  }

  // Every view of the books agrees with every other.
  function checkTied(s, label = '') {
    const at = msg => `${label ? `${label}: ` : ''}${msg}`;
    const c = s.check;
    assert.ok(c.balanced, at(`ledger out of balance ${c.debits} vs ${c.credits}`));
    assert.ok(c.arMatches, at(`A/R ledger ${c.arLedger} ≠ open items ${c.arOpen}`));
    assert.ok(c.apMatches, at(`A/P ledger ${c.apLedger} ≠ open items ${c.apOpen}`));
    assert.ok(c.inventoryMatches, at(`inventory ledger ${c.inventoryLedger} ≠ on hand ${c.inventoryOnHand}`));
    // Customers: page balance = A/R aging = customer balance summary; all of them = A/R account.
    const aging = rowsBy(s.arAging, 'partyId'), cbs = rowsBy(s.cbs, 'partyId');
    let custSum = 0;
    for (const [id, sum] of s.cust) {
      custSum += sum.openCents;
      assert.equal(aging.get(id) ?? 0, sum.openCents, at(`customer ${id}: A/R aging ≠ customer page`));
      assert.equal(cbs.get(id) ?? 0, sum.openCents, at(`customer ${id}: balance summary ≠ customer page`));
    }
    assert.equal(custSum, s.accounts.get(s.sys.ar) ?? 0, at('customers’ balances ≠ A/R account'));
    assert.equal(s.home.ar.open, custSum, at('Home A/R ≠ customers'));
    // Vendors: page balance = A/P aging = vendor balance summary; all of them = A/P account.
    const apAging = rowsBy(s.apAging, 'partyId'), vbs = rowsBy(s.vbs, 'partyId');
    let vendSum = 0;
    for (const [id, v] of s.vend) {
      const open = Number(v.open_cents);
      vendSum += open;
      assert.equal(apAging.get(id) ?? 0, open, at(`vendor ${id}: A/P aging ≠ vendor page`));
      assert.equal(vbs.get(id) ?? 0, open, at(`vendor ${id}: balance summary ≠ vendor page`));
    }
    assert.equal(vendSum, -(s.accounts.get(s.sys.ap) ?? 0), at('vendors’ balances ≠ A/P account'));
    assert.equal(s.home.ap.open, vendSum, at('Home A/P ≠ vendors'));
    // Trial balance and Balance Sheet balance, on both bases; this year's net income is the same on the P&L and the BS.
    const tbTotal = s.tb.rows.find(r => r.label === 'Total').values;
    assert.equal(tbTotal[0], tbTotal[1], at('trial balance debits ≠ credits'));
    for (const [bs, pl, basis] of [[s.bs, s.pl, 'accrual'], [s.bsCash, s.plCash, 'cash']]) {
      assert.equal(total(bs, /^Total for Assets$/), total(bs, /^Total for Liabilities and Equity$/), at(`${basis} Balance Sheet doesn’t balance`));
      assert.equal(bs.netIncome?.at?.(-1) ?? bs.netIncome, total(pl, /^Net Income$/), at(`${basis} BS net income ≠ P&L`));
    }
    assert.equal(total(s.bs, /^Total for Accounts Receivable$/), custSum, at('BS A/R ≠ customers'));
    // Trial balance per account = the postings (balance-sheet accounts all time; income and expense accounts this fiscal
    // year, with earlier years' profit rolled into Retained Earnings — so those rows together equal all their postings).
    let rolled = 0, rolledTb = 0;
    for (const r of s.tb.rows.filter(x => x.accountId)) {
      const tbv = r.values[0] - r.values[1];
      if (s.pnlIds.has(r.accountId) || r.accountId === s.sys.retained) { rolledTb += tbv; continue; }
      assert.equal(tbv, s.accounts.get(r.accountId) ?? 0, at(`TB ${r.label} ≠ postings`));
    }
    for (const [id, v] of s.accounts) if (s.pnlIds.has(id) || id === s.sys.retained) rolled += v;
    assert.equal(rolledTb, rolled, at('TB income, expense and retained earnings ≠ their postings'));
    assert.equal(s.inv.rows.find(r => r.kind === 'total').cells.value, s.check.inventoryOnHand, at('inventory valuation ≠ items on hand'));
    assert.equal(s.inv.rows.filter(r => r.kind === 'line').reduce((t, r) => t + r.cells.value, 0), s.check.inventoryOnHand, at('inventory valuation lines ≠ total'));
  }

  // What changed between two snapshots. accounts: { [systemKey or accountId]: debit-positive cents }.
  function expectChange(a, b, { accounts = {}, customers = {}, vendors = {}, net = null, label = '' } = {}) {
    const at = msg => `${label ? `${label}: ` : ''}${msg}`;
    const want = new Map();
    for (const [k, v] of Object.entries(accounts)) want.set(/^\d+$/.test(k) ? Number(k) : b.sys[k] ?? assert.fail(`no system account ${k}`), v);
    const ids = new Set([...a.accounts.keys(), ...b.accounts.keys(), ...want.keys()]);
    for (const id of ids) {
      const d = (b.accounts.get(id) ?? 0) - (a.accounts.get(id) ?? 0);
      assert.equal(d, want.get(id) ?? 0, at(`account ${id} moved ${d}`));
    }
    for (const [id, sum] of b.cust) {
      const d = sum.openCents - (a.cust.get(id)?.openCents ?? 0);
      assert.equal(d, customers[id] ?? 0, at(`customer ${id} balance moved ${d}`));
    }
    for (const [id, v] of b.vend) {
      const d = Number(v.open_cents) - Number(a.vend.get(id)?.open_cents ?? 0);
      assert.equal(d, vendors[id] ?? 0, at(`vendor ${id} balance moved ${d}`));
    }
    if (net !== null) assert.equal(total(b.pl, /^Net Income$/) - total(a.pl, /^Net Income$/), net, at('net income change'));
  }

  // The transaction shows wherever it should: in its party's history and activity, the general ledger on each account it
  // posts to, and the audit log.
  async function expectHistory(txnId, { activity = true } = {}) {
    const { rows: [t] } = await pool.query('SELECT txn_id, type, customer_id, vendor_id, txn_date::text AS d FROM txn WHERE txn_id = $1', [txnId]);
    assert.ok(t, `txn ${txnId} exists`);
    const posted = (await pool.query('SELECT DISTINCT account_id FROM posting WHERE txn_id = $1', [txnId])).rows.map(r => Number(r.account_id));
    if (posted.length) {
      const gl = await run('general_ledger', { period: 'custom', from: t.d, to: t.d });
      for (const acc of posted) {
        let inSection = false, found = false;
        for (const r of gl.rows) {
          if (r.kind === 'section') inSection = Number(r.accountId) === acc;
          if (inSection && Number(r.txnId) === txnId) found = true;
        }
        assert.ok(found, `txn ${txnId} (${t.type}) missing from the general ledger under account ${acc}`);
      }
    }
    if (t.customer_id) {
      const r = await run('transaction_list_by_customer', { period: 'all', customer: String(t.customer_id) });
      assert.ok(r.rows.some(x => Number(x.txnId) === txnId), `txn ${txnId} missing from Transaction List by Customer`);
      const page = await (await app.get(`/customers/${t.customer_id}?tab=transactions&date=all`)).text();
      if (t.type !== 'deposit') assert.ok(page.includes(`/txns/${txnId}`), `txn ${txnId} missing from the customer page`);
    }
    if (t.vendor_id) {
      const r = await run('transaction_list_by_vendor', { period: 'all', vendor: String(t.vendor_id) });
      assert.ok(r.rows.some(x => Number(x.txnId) === txnId), `txn ${txnId} missing from Transaction List by Vendor`);
    }
    if (activity) {
      const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM activity_event WHERE txn_id = $1', [txnId]);
      assert.ok(n.n > 0, `txn ${txnId} has no activity history`);
    }
    const { rows: [au] } = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'txn' AND row_id = $1`, [txnId]);
    assert.ok(au.n > 0, `txn ${txnId} not in the audit log`);
  }

  return { pool, scope, run, snapshot, checkTied, expectChange, expectHistory, sys: () => sys };
}
