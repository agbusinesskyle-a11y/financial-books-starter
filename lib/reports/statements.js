import { normalSign } from '../domain/ledger.js';
import { fiscalYearOf } from './periods.js';

// Financial statements (Profit and Loss, Balance Sheet, Trial Balance) as rows × data columns, built from ledger lines.
// A data column is { from, to, match?(line) } — from = null means "from the beginning".
// A row is { kind: 'section' | 'account' | 'total' | 'computed', label, depth, values: [cents per column] | null,
//   accountId?, accountIds? (what an amount drills into), parent?, grand?, key? }.
// Amounts are shown in each account's normal direction: income, liabilities and equity positive when they are credits.

export const PL_TYPES = ['income', 'cost_of_goods_sold', 'expense', 'other_income', 'other_expense'];
export const PL_SECTIONS = [
  ['income', 'Income', ['income']],
  ['cogs', 'Cost of Goods Sold', ['cost_of_goods_sold']],
  ['expenses', 'Expenses', ['expense']],
  ['other_income', 'Other Income', ['other_income']],
  ['other_expenses', 'Other Expenses', ['other_expense']],
];

// Sums lines into Map(accountId -> [cents per column]); also returns the accounts that had any line at all.
export function sumByAccount(lines, columns) {
  const sums = new Map(), active = new Set();
  columns.forEach((c, i) => {
    for (const l of lines) {
      if ((c.from && l.date < c.from) || l.date > c.to || (c.match && !c.match(l))) continue;
      if (!sums.has(l.accountId)) sums.set(l.accountId, Array(columns.length).fill(0));
      sums.get(l.accountId)[i] += l.amount;
      active.add(l.accountId);
    }
  });
  return { sums, active };
}

export const add = (a, b) => a.map((x, i) => x + (b[i] ?? 0));
const sub = (a, b) => a.map((x, i) => x - (b[i] ?? 0));
const zero = n => Array(n).fill(0);
export const accountLabel = (a, numbers = true) => (numbers && a.number ? `${a.number} ${a.name}` : a.name);

// Rows for the accounts of some types: each top-level account, or a parent with its sub-accounts and a "Total for" line.
// show: 'active' (had transactions), 'non_zero' (a balance in some column) or 'all' (every active account too).
function accountRows(accounts, { sums, active }, types, n, { show, depth, numbers }) {
  const inSet = accounts.filter(a => types.includes(a.type));
  const values = a => (sums.get(a.account_id) ?? zero(n)).map(x => x * normalSign(a.type));
  const keep = (a, v) => (show === 'all' ? a.active || v.some(Boolean) : show === 'non_zero' ? v.some(Boolean) : active.has(a.account_id) || v.some(Boolean));
  const rows = [];
  let total = zero(n);
  for (const a of inSet.filter(x => !x.parent_id || !inSet.some(p => p.account_id === x.parent_id))) {
    const own = values(a);
    const kids = inSet.filter(c => c.parent_id === a.account_id).map(c => ({ c, v: values(c) }));
    const sum = kids.reduce((s, k) => add(s, k.v), own);
    const shown = kids.filter(k => keep(k.c, k.v));
    total = add(total, sum);
    if (!shown.length) {
      if (keep(a, sum) || kids.some(k => k.v.some(Boolean))) {
        rows.push({ kind: 'account', label: accountLabel(a, numbers), depth, accountId: a.account_id, accountIds: [a.account_id, ...kids.map(k => k.c.account_id)], values: sum });
      }
      continue;
    }
    rows.push({ kind: 'account', label: accountLabel(a, numbers), depth, accountId: a.account_id, accountIds: [a.account_id], values: own, parent: true });
    for (const k of shown) rows.push({ kind: 'account', label: accountLabel(k.c, numbers), depth: depth + 1, accountId: k.c.account_id, accountIds: [k.c.account_id], values: k.v });
    rows.push({ kind: 'total', label: `Total for ${accountLabel(a, numbers)}`, depth, accountIds: [a.account_id, ...kids.map(k => k.c.account_id)], values: sum });
  }
  return { rows, total };
}

// Profit and Loss. titles: renamed section titles (Customize), keyed like PL_SECTIONS and the computed rows.
export function profitAndLoss({ accounts, lines, columns, show = 'active', numbers = true, summary = false }) {
  const n = columns.length;
  const sums = sumByAccount(lines, columns);
  const rows = [], part = {};
  for (const [key, title, types] of PL_SECTIONS) {
    const { rows: r, total } = accountRows(accounts, sums, types, n, { show, depth: 1, numbers });
    part[key] = total;
    const ids = accounts.filter(a => types.includes(a.type)).map(a => a.account_id);
    if (summary) rows.push({ kind: 'account', label: title, depth: 0, values: total, section: key, accountIds: ids });
    else if (r.length || total.some(Boolean)) {
      rows.push({ kind: 'section', label: title, depth: 0, values: null, section: key });
      rows.push(...r);
      rows.push({ kind: 'total', label: `Total for ${title}`, depth: 0, values: total, section: key, accountIds: ids });
    }
    if (key === 'cogs') rows.push({ kind: 'computed', label: 'Gross Profit', depth: 0, values: sub(part.income, part.cogs), key: 'gross_profit' });
    if (key === 'expenses') rows.push({ kind: 'computed', label: 'Net Operating Income', depth: 0, values: sub(sub(part.income, part.cogs), part.expenses), key: 'net_operating_income' });
  }
  const netOther = sub(part.other_income, part.other_expenses);
  rows.push({ kind: 'computed', label: 'Net Other Income', depth: 0, values: netOther, key: 'net_other_income' });
  const netIncome = add(sub(sub(part.income, part.cogs), part.expenses), netOther);
  rows.push({ kind: 'computed', label: 'Net Income', depth: 0, values: netIncome, key: 'net_income', grand: true });
  return { rows, totals: { ...part, netIncome } };
}

// [key, title, children]: children are either more groups or [key, title | null, account types] leaves.
const BS = [
  ['assets', 'Assets', [
    ['current_assets', 'Current Assets', [['bank', 'Bank Accounts', ['bank']], ['ar', 'Accounts Receivable', ['accounts_receivable']],
      ['other_current', 'Other Current Assets', ['other_current_asset', 'inventory']]]],
    ['fixed_assets', 'Fixed Assets', [['fixed', null, ['fixed_asset']]]],
    ['other_assets', 'Other Assets', [['other', null, ['other_asset']]]],
  ]],
  ['liabilities_equity', 'Liabilities and Equity', [
    ['liabilities', 'Liabilities', [
      ['current_liabilities', 'Current Liabilities', [['ap', 'Accounts Payable', ['accounts_payable']], ['cc', 'Credit Cards', ['credit_card']],
        ['other_current_liab', 'Other Current Liabilities', ['other_current_liability']]]],
      ['long_term', 'Long-Term Liabilities', [['lt', null, ['long_term_liability']]]],
    ]],
    ['equity', 'Equity', [['equity_accounts', null, ['equity']]]],
  ]],
];
const isLeaf = node => typeof node[2][0] === 'string';

// Income and expenses dated before the fiscal year containing each column's date roll into Retained Earnings; from then
// to the date they are this year's Net Income.
function closeYears(accounts, lines, columns, fiscalStartMonth) {
  const n = columns.length;
  const pl = new Set(accounts.filter(a => PL_TYPES.includes(a.type)).map(a => a.account_id));
  const retained = zero(n), netIncome = zero(n);
  columns.forEach((c, i) => {
    const fyStart = fiscalYearOf(c.to, fiscalStartMonth).start;
    for (const l of lines) {
      if (l.date > c.to || !pl.has(l.accountId) || (c.match && !c.match(l))) continue;
      if (l.date < fyStart) retained[i] -= l.amount; else netIncome[i] -= l.amount;
    }
  });
  return { retained, netIncome, pl };
}

// Balance Sheet: each column is as of its `to` date. summary: one line per group instead of every account.
export function balanceSheet({ accounts, lines, columns, fiscalStartMonth = 1, retainedAccountId, show = 'active', numbers = true, summary = false }) {
  const n = columns.length;
  const asOf = columns.map(c => ({ ...c, from: null }));
  const sums = sumByAccount(lines, asOf);
  const { retained, netIncome } = closeYears(accounts, lines, asOf, fiscalStartMonth);
  const rows = [];
  const walk = (node, depth) => {
    const [key, title, kids] = node;
    let total = zero(n);
    rows.push({ kind: 'section', label: title, depth, values: null, key });
    for (const kid of kids) {
      if (!isLeaf(kid)) { total = add(total, walk(kid, depth + 1)); continue; }
      const [k, t, types] = kid;
      const inner = depth + (t ? 2 : 1);
      let { rows: r, total: s } = accountRows(accounts, sums, types, n, { show, depth: inner, numbers });
      if (k === 'equity_accounts') {
        const at = r.findIndex(x => x.accountId === retainedAccountId && !x.parent);
        if (at >= 0) r[at] = { ...r[at], values: add(r[at].values, retained), accountIds: null };
        else if (retained.some(Boolean)) r.push({ kind: 'account', label: 'Retained Earnings', depth: inner, values: retained });
        r.push({ kind: 'computed', label: 'Net Income', depth: inner, values: netIncome, key: 'net_income' });
        s = add(add(s, retained), netIncome);
      }
      const ids = accounts.filter(a => types.includes(a.type)).map(a => a.account_id);
      if (summary) {
        // A sub-group (Bank Accounts, Accounts Receivable…) gets one line; a group without sub-groups is just its total line.
        if (t && (r.length || s.some(Boolean))) rows.push({ kind: 'account', label: t, depth: depth + 1, values: s, accountIds: ids });
      } else if (t) {
        if (r.length) rows.push({ kind: 'section', label: t, depth: depth + 1, values: null }, ...r, { kind: 'total', label: `Total for ${t}`, depth: depth + 1, values: s, accountIds: ids });
      } else rows.push(...r);
      total = add(total, s);
    }
    rows.push({ kind: 'total', label: `Total for ${title}`, depth, values: total, key, grand: depth === 0 });
    return total;
  };
  const [assets, liabilitiesEquity] = BS.map(node => walk(node, 0));
  return { rows, totals: { assets, liabilitiesEquity }, retained, netIncome };
}

// Trial balance as of a date: balance-sheet accounts from the beginning, income and expense accounts for the fiscal year
// so far, and earlier years' profit in Retained Earnings. Columns: Debit, Credit.
export function trialBalance({ accounts, lines, asOf, fiscalStartMonth = 1, retainedAccountId, show = 'active', numbers = true }) {
  const fyStart = fiscalYearOf(asOf, fiscalStartMonth).start;
  const { retained, pl } = closeYears(accounts, lines, [{ to: asOf }], fiscalStartMonth);
  const bal = new Map(), active = new Set();
  for (const l of lines) {
    if (l.date > asOf || (pl.has(l.accountId) && l.date < fyStart)) continue;
    bal.set(l.accountId, (bal.get(l.accountId) ?? 0) + l.amount);
    active.add(l.accountId);
  }
  if (retained[0]) bal.set(retainedAccountId, (bal.get(retainedAccountId) ?? 0) - retained[0]);
  const rows = [];
  let debit = 0, credit = 0;
  for (const a of accounts) {
    const v = bal.get(a.account_id) ?? 0;
    const keep = show === 'all' ? a.active || v : show === 'non_zero' ? v : active.has(a.account_id) || v;
    if (!keep) continue;
    rows.push({ kind: 'account', label: accountLabel(a, numbers), depth: 0, accountId: a.account_id,
      accountIds: a.account_id === retainedAccountId && retained[0] ? null : [a.account_id], values: [v > 0 ? v : 0, v < 0 ? -v : 0] });
    if (v > 0) debit += v; else credit -= v;
  }
  rows.push({ kind: 'computed', label: 'Total', depth: 0, values: [debit, credit], grand: true });
  return { rows, debit, credit };
}

// Statement of Cash Flows (indirect method): net income, then the change in every other non-cash account over each
// column's range, grouped into operating, investing and financing. Every posting balances, so the net change equals
// the change in the bank accounts: beginning cash + net change = ending cash.
const CF_SECTIONS = [
  ['operating', ['accounts_receivable', 'other_current_asset', 'inventory', 'accounts_payable', 'credit_card', 'other_current_liability']],
  ['investing', ['fixed_asset', 'other_asset']],
  ['financing', ['long_term_liability', 'equity']],
];
export function cashFlows({ accounts, lines, columns, show = 'active', numbers = true }) {
  const n = columns.length;
  const { sums, active } = sumByAccount(lines, columns);
  const byType = types => accounts.filter(a => types.includes(a.type));
  const change = a => (sums.get(a.account_id) ?? zero(n)).map(x => -x);
  const keep = (a, v) => (show === 'all' ? a.active || v.some(Boolean) : show === 'non_zero' ? v.some(Boolean) : active.has(a.account_id) || v.some(Boolean));
  const netIncome = byType(PL_TYPES).reduce((s, a) => add(s, change(a)), zero(n));
  const rows = [];
  const part = {};
  const flat = (types, depth) => {
    let total = zero(n);
    const out = [];
    for (const a of byType(types)) {
      const v = change(a);
      total = add(total, v);
      if (keep(a, v)) out.push({ kind: 'account', label: accountLabel(a, numbers), depth, accountId: a.account_id, accountIds: [a.account_id], values: v });
    }
    return { out, total };
  };
  const op = flat(CF_SECTIONS[0][1], 2);
  rows.push({ kind: 'section', label: 'Operating Activities', depth: 0, values: null },
    { kind: 'computed', label: 'Net Income', depth: 1, values: netIncome, key: 'net_income' },
    { kind: 'section', label: 'Adjustments to reconcile Net Income to Net Cash provided by operations:', depth: 1, values: null },
    ...op.out,
    { kind: 'total', label: 'Total Adjustments to reconcile Net Income to Net Cash provided by operations:', depth: 1, values: op.total });
  part.operating = add(netIncome, op.total);
  rows.push({ kind: 'total', label: 'Net cash provided by operating activities', depth: 0, values: part.operating, key: 'operating' });
  for (const [key, types] of CF_SECTIONS.slice(1)) {
    const s = flat(types, 1);
    part[key] = s.total;
    const title = key === 'investing' ? 'Investing Activities' : 'Financing Activities';
    rows.push({ kind: 'section', label: title, depth: 0, values: null }, ...s.out,
      { kind: 'total', label: `Net cash provided by ${key} activities`, depth: 0, values: s.total, key });
  }
  const net = add(add(part.operating, part.investing), part.financing);
  const banks = new Set(byType(['bank']).map(a => a.account_id));
  const beginning = columns.map(c => (c.from ? lines.filter(l => banks.has(l.accountId) && l.date < c.from && (!c.match || c.match(l))).reduce((s, l) => s + l.amount, 0) : 0));
  const ending = add(beginning, net);
  rows.push({ kind: 'computed', label: 'Net cash increase for period', depth: 0, values: net, key: 'net_change' },
    { kind: 'computed', label: 'Cash at beginning of period', depth: 0, values: beginning, key: 'beginning' },
    { kind: 'computed', label: 'Cash at end of period', depth: 0, values: ending, key: 'ending', grand: true });
  return { rows, totals: { ...part, netIncome, net, beginning, ending } };
}

// Adjusted Trial Balance: the trial balance as of the date, with the adjusting journal entries dated in the period
// pulled out into their own columns. Columns: Unadjusted Dr/Cr, Adjustments Dr/Cr, Adjusted Dr/Cr.
export function adjustedTrialBalance({ accounts, lines, from, asOf, isAdjusting, fiscalStartMonth = 1, retainedAccountId, show = 'active', numbers = true }) {
  const adjusted = trialBalance({ accounts, lines, asOf, fiscalStartMonth, retainedAccountId, show: 'all', numbers });
  const adj = new Map();
  for (const l of lines) {
    if (!isAdjusting(l.txnId) || l.date > asOf || (from && l.date < from)) continue;
    adj.set(l.accountId, (adj.get(l.accountId) ?? 0) + l.amount);
  }
  const split = v => [v > 0 ? v : 0, v < 0 ? -v : 0];
  const rows = [];
  const tot = zero(6);
  for (const r of adjusted.rows.filter(x => x.kind === 'account')) {
    const after = r.values[0] - r.values[1];
    const a = adj.get(r.accountId) ?? 0;
    const values = [...split(after - a), ...split(a), ...split(after)];
    const keep = show === 'all' || values.some(Boolean);
    if (!keep) continue;
    rows.push({ ...r, values });
    values.forEach((v, i) => { tot[i] += v; });
  }
  rows.push({ kind: 'computed', label: 'Total', depth: 0, values: tot, grand: true });
  return { rows, totals: tot };
}
