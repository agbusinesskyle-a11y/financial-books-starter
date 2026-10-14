import { normalSign } from '../domain/ledger.js';
import { TYPE_LABELS } from '../domain/status.js';
import { fiscalYearOf } from './periods.js';
import { accountLabel, PL_TYPES } from './statements.js';

// Transaction-level reports grouped by account (Transaction Detail by Account, General Ledger, P&L Detail, Balance Sheet
// Detail): for each account a heading, an optional beginning balance, one row per ledger line in the period with a running
// balance, and a total. Amounts are in the account's normal direction.
// A table report's columns: { key, label, money? }. Money columns come last; a total row fills only those.
const col = (key, label, money = false) => ({ key, label, money });
export const DETAIL_COLUMNS = [col('date', 'Date'), col('type', 'Transaction type'), col('num', 'No.'), col('name', 'Name'), col('memo', 'Memo/Description'),
  col('split', 'Split account'), col('amount', 'Amount', true), col('balance', 'Balance', true)];
export const MAX_DETAIL_ROWS = 5000;

// What each line's transaction looks like on a report: type, number, name, memo, and its other accounts (the "split").
export async function txnInfo(db, { orgId, txnIds, accountsById, numbers = true }) {
  if (!txnIds.length) return new Map();
  const [{ rows: txns }, { rows: posts }] = await Promise.all([
    db.query(`SELECT t.txn_id, t.type, t.doc_number, t.payment_ref, t.memo, c.display_name AS customer_name, v.display_name AS vendor_name
                FROM txn t LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
               WHERE t.org_id = $1 AND t.txn_id = ANY($2::bigint[])`, [orgId, txnIds]),
    db.query('SELECT DISTINCT txn_id, account_id FROM posting WHERE org_id = $1 AND txn_id = ANY($2::bigint[])', [orgId, txnIds]),
  ]);
  const accountsOf = new Map();
  for (const p of posts) { if (!accountsOf.has(p.txn_id)) accountsOf.set(p.txn_id, new Set()); accountsOf.get(p.txn_id).add(Number(p.account_id)); }
  return new Map(txns.map(t => [Number(t.txn_id), {
    type: TYPE_LABELS[t.type] ?? t.type, num: t.doc_number ?? t.payment_ref ?? '', name: t.customer_name ?? t.vendor_name ?? '', memo: t.memo ?? '',
    split: accountId => {
      const others = [...(accountsOf.get(Number(t.txn_id)) ?? [])].filter(id => id !== accountId);
      if (others.length > 1) return '-Split-';
      const a = accountsById.get(others[0]);
      return a ? accountLabel(a, numbers) : '';
    },
  }]));
}

// opts: { from, to, accountIds (null = all of `types`), types, beginning: 'none' | 'all' (GL / BS detail), fiscalStartMonth }.
// lines must reach back to the beginning when a beginning balance is wanted.
export async function detailReport(db, { orgId, accounts, lines, from, to, types, accountIds = null, beginning = 'none', fiscalStartMonth = 1, names, numbers = true }) {
  const byId = new Map(accounts.map(a => [a.account_id, a]));
  const wanted = accounts.filter(a => types.includes(a.type) && (!accountIds || accountIds.includes(a.account_id)));
  const wantedIds = new Set(wanted.map(a => a.account_id));
  const inRange = lines.filter(l => wantedIds.has(l.accountId) && (!from || l.date >= from) && l.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.txnId - b.txnId));
  const truncated = inRange.length > MAX_DETAIL_ROWS;
  const shown = truncated ? inRange.slice(0, MAX_DETAIL_ROWS) : inRange;
  const info = await txnInfo(db, { orgId, txnIds: [...new Set(shown.map(l => l.txnId))], accountsById: byId, numbers });
  // Beginning balances: balance-sheet accounts from the start of the books, income and expenses from the fiscal year start.
  const opening = new Map();
  if (beginning === 'all' && from) {
    const fyStart = fiscalYearOf(from, fiscalStartMonth).start;
    for (const l of lines) {
      if (!wantedIds.has(l.accountId) || l.date >= from) continue;
      if (PL_TYPES.includes(byId.get(l.accountId).type) && l.date < fyStart) continue;
      opening.set(l.accountId, (opening.get(l.accountId) ?? 0) + l.amount);
    }
  }
  const byAccount = new Map();
  for (const l of shown) { if (!byAccount.has(l.accountId)) byAccount.set(l.accountId, []); byAccount.get(l.accountId).push(l); }
  const rows = [];
  let grand = 0;
  for (const a of wanted) {
    const own = byAccount.get(a.account_id) ?? [];
    const sign = normalSign(a.type);
    const start = (opening.get(a.account_id) ?? 0) * sign;
    if (!own.length && !start) continue;
    const label = accountLabel(a, numbers);
    rows.push({ kind: 'section', label, depth: 0, accountId: a.account_id });
    let balance = start;
    if (beginning === 'all') rows.push({ kind: 'line', depth: 1, cells: { date: '', type: 'Beginning Balance', num: '', name: '', memo: '', split: '', amount: null, balance } });
    let total = 0;
    for (const l of own) {
      const t = info.get(l.txnId);
      const amount = l.amount * sign;
      total += amount; balance += amount;
      rows.push({ kind: 'line', depth: 1, txnId: l.txnId, txnType: l.type, cells: { date: l.date, type: t?.type ?? '', num: t?.num ?? '',
        name: (l.customerId && names.customers.get(l.customerId)) || (l.vendorId && names.vendors.get(l.vendorId)) || t?.name || '',
        memo: t?.memo ?? '', split: t?.split(a.account_id) ?? '', amount, balance } });
    }
    rows.push({ kind: 'total', label: `Total for ${label}`, depth: 0, cells: { amount: total, balance: beginning === 'all' ? balance : null } });
    grand += total;
  }
  return { rows, truncated, total: grand };
}
