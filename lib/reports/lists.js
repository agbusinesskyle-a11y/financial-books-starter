import { normalSign } from '../domain/ledger.js';
import { TYPE_LABELS } from '../domain/status.js';
import { accountLabel, PL_TYPES } from './statements.js';
import { txnInfo, MAX_DETAIL_ROWS } from './detail.js';

// Table reports that aren't grouped by account: Journal, Transaction List with Splits, Transaction List by Date,
// Account List. Same shape as detail.js: { columns: [{ key, label, money? }], rows: [{ kind, cells, … }] }.

const AR_AP_DOCS = new Set(['invoice', 'credit_memo', 'late_fee', 'bill', 'vendor_credit', 'item_receipt']);
const byDateThenTxn = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.txnId - b.txnId || b.amount - a.amount);

// Journal (debit/credit columns, a total per transaction and a grand total) and Transaction List with Splits (one
// signed amount): every ledger line in the period, grouped by transaction in date order.
export async function journalReport(db, { orgId, accounts, lines, from, to, names, numbers = true, variant = 'journal' }) {
  const byId = new Map(accounts.map(a => [a.account_id, a]));
  const inRange = lines.filter(l => (!from || l.date >= from) && l.date <= to).sort(byDateThenTxn);
  const truncated = inRange.length > MAX_DETAIL_ROWS;
  const shown = truncated ? inRange.slice(0, MAX_DETAIL_ROWS) : inRange;
  const info = await txnInfo(db, { orgId, txnIds: [...new Set(shown.map(l => l.txnId))], accountsById: byId, numbers });
  const rows = [];
  let dr = 0, cr = 0, txnDr = 0, txnCr = 0, current = null;
  const closeTxn = () => {
    if (current !== null && variant === 'journal') rows.push({ kind: 'total', label: '', cells: { debit: txnDr, credit: txnCr } });
    txnDr = 0; txnCr = 0;
  };
  for (const l of shown) {
    const first = l.txnId !== current;
    if (first) { closeTxn(); current = l.txnId; }
    const t = info.get(l.txnId);
    const a = byId.get(l.accountId);
    const cells = { date: first ? l.date : '', type: first ? t?.type ?? '' : '', num: first ? t?.num ?? '' : '',
      name: (l.customerId && names.customers.get(l.customerId)) || (l.vendorId && names.vendors.get(l.vendorId)) || t?.name || '',
      memo: t?.memo ?? '', account: a ? accountLabel(a, numbers) : '' };
    if (variant === 'journal') { cells.debit = l.amount > 0 ? l.amount : null; cells.credit = l.amount < 0 ? -l.amount : null; } else cells.amount = l.amount;
    if (l.amount > 0) { dr += l.amount; txnDr += l.amount; } else { cr -= l.amount; txnCr -= l.amount; }
    rows.push({ kind: 'line', txnId: first ? l.txnId : null, txnType: l.type, accountId: l.accountId, sub: !first, cells });
  }
  closeTxn();
  if (variant === 'journal' && shown.length) rows.push({ kind: 'total', label: 'Total', grand: true, cells: { debit: dr, credit: cr } });
  const columns = [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' }, { key: 'name', label: 'Name' },
    { key: 'memo', label: 'Memo/Description' }, { key: 'account', label: 'Account' },
    ...(variant === 'journal' ? [{ key: 'debit', label: 'Debit', money: true }, { key: 'credit', label: 'Credit', money: true }] : [{ key: 'amount', label: 'Amount', money: true }])];
  return { columns, rows, truncated, totals: { debit: dr, credit: cr } };
}

// Transaction List by Date: one row per transaction, including ones that don't post (estimates, purchase orders).
// filters: { customer, vendor, class, location, tag, account } id lists (null = "not specified").
// types: only these transaction types; bankOnly: only transactions that touch a bank account (both applied before the row limit).
export async function transactionList(db, { orgId, entityId, accounts, from, to, filters, numbers = true, types = null, bankOnly = false }) {
  const byId = new Map(accounts.map(a => [a.account_id, a]));
  const { rows: txns } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, t.doc_number, t.payment_ref, t.memo, t.total_cents::bigint AS total, t.voided_at,
            t.customer_id, t.vendor_id, t.class_id, t.location_id, c.display_name AS customer_name, v.display_name AS vendor_name,
            (SELECT coalesce(array_agg(tag_id), '{}') FROM txn_tag x WHERE x.txn_id = t.txn_id) AS tag_ids
       FROM txn t LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND ($3::date IS NULL OR t.txn_date >= $3::date) AND t.txn_date <= $4::date
        AND ($5::text[] IS NULL OR t.type = ANY($5::text[]))
      ORDER BY t.txn_date, t.txn_id`, [orgId, entityId, from, to, types]);
  const ids = txns.map(t => Number(t.txn_id));
  const { rows: posts } = ids.length ? await db.query(
    `SELECT txn_id, account_id, sum(amount_cents)::bigint AS amount FROM posting WHERE org_id = $1 AND txn_id = ANY($2::bigint[])
      GROUP BY txn_id, account_id ORDER BY txn_id, min(line_no), account_id`, [orgId, ids]) : { rows: [] };
  const postsOf = new Map();
  for (const p of posts) {
    const k = Number(p.txn_id);
    if (!postsOf.has(k)) postsOf.set(k, []);
    postsOf.get(k).push({ accountId: Number(p.account_id), amount: Number(p.amount) });
  }
  // Names on lines (a journal entry naming a customer or vendor on a line counts for that name, as in QBO): per transaction,
  // each named party with the amount of its lines.
  const lineParties = new Map();
  if (ids.length) {
    const { rows } = await db.query(
      `SELECT txn_id, customer_id, vendor_id, coalesce(sum(amount_cents) FILTER (WHERE amount_cents > 0), 0)::bigint AS dr,
              coalesce(-sum(amount_cents) FILTER (WHERE amount_cents < 0), 0)::bigint AS cr
         FROM posting WHERE org_id = $1 AND txn_id = ANY($2::bigint[]) AND (customer_id IS NOT NULL OR vendor_id IS NOT NULL)
          AND txn_id IN (SELECT txn_id FROM txn WHERE org_id = $1 AND type = 'journal_entry')
        GROUP BY txn_id, customer_id, vendor_id`, [orgId, ids]);
    for (const r of rows) {
      const k = Number(r.txn_id);
      if (!lineParties.has(k)) lineParties.set(k, { customers: new Map(), vendors: new Map() });
      const amt = Math.max(Number(r.dr), Number(r.cr));
      if (r.customer_id !== null) lineParties.get(k).customers.set(Number(r.customer_id), amt);
      if (r.vendor_id !== null) lineParties.get(k).vendors.set(Number(r.vendor_id), amt);
    }
  }
  const want = (list, v) => !list?.length || list.includes(v === null || v === undefined ? null : Number(v));
  const wantParty = (list, own, lines) => !list?.length || (own !== null && own !== undefined ? list.includes(Number(own)) : (lines?.size ? [...lines.keys()].some(x => list.includes(x)) : list.includes(null)));
  // Projects and products are on the lines (and a project can be on the transaction).
  const lineDims = new Map();
  if ((filters.project?.length || filters.item?.length) && ids.length) {
    const { rows } = await db.query(`SELECT txn_id, array_agg(DISTINCT project_id) AS projects, array_agg(DISTINCT item_id) AS items FROM txn_line
                                      WHERE org_id = $1 AND txn_id = ANY($2::bigint[]) GROUP BY txn_id`, [orgId, ids]);
    for (const r of rows) lineDims.set(Number(r.txn_id), { projects: (r.projects ?? []).filter(x => x !== null).map(Number), items: (r.items ?? []).filter(x => x !== null).map(Number) });
  }
  const { rows: txnProjects } = filters.project?.length && ids.length
    ? await db.query('SELECT txn_id, project_id FROM txn WHERE org_id = $1 AND txn_id = ANY($2::bigint[]) AND project_id IS NOT NULL', [orgId, ids]) : { rows: [] };
  const projectOf = new Map(txnProjects.map(r => [Number(r.txn_id), Number(r.project_id)]));
  const hasAny = (want, have) => want.some(x => (x === null ? !have.length : have.includes(x)));
  const sys = p => byId.get(p.accountId)?.system_key;
  const label = p => (byId.get(p.accountId) ? accountLabel(byId.get(p.accountId), numbers) : '');
  const rows = [];
  for (const t of txns) {
    const id = Number(t.txn_id);
    const ps = postsOf.get(id) ?? [];
    const tags = (t.tag_ids ?? []).map(Number);
    const lp = lineParties.get(id);
    if (!wantParty(filters.customer, t.customer_id, lp?.customers) || !wantParty(filters.vendor, t.vendor_id, lp?.vendors)
      || !want(filters.class, t.class_id) || !want(filters.location, t.location_id)) continue;
    if (filters.tag?.length && !filters.tag.some(x => (x === null ? !tags.length : tags.includes(x)))) continue;
    if (filters.account?.length && !ps.some(p => filters.account.includes(p.accountId))) continue;
    if (bankOnly && !ps.some(p => byId.get(p.accountId)?.type === 'bank')) continue;
    if (filters.project?.length && !hasAny(filters.project, [...new Set([...(lineDims.get(id)?.projects ?? []), ...(projectOf.has(id) ? [projectOf.get(id)] : [])])])) continue;
    if (filters.item?.length && !hasAny(filters.item, lineDims.get(id)?.items ?? [])) continue;
    // The main account: A/R or A/P for customer and vendor documents, else the bank, card or Undeposited Funds side.
    const main = (AR_AP_DOCS.has(t.type) && ps.find(p => ['ar', 'ap'].includes(sys(p))))
      || ps.find(p => ['bank', 'credit_card'].includes(byId.get(p.accountId)?.type) || sys(p) === 'undeposited') || ps[0];
    const others = ps.filter(p => p !== main);
    // A transaction without its own customer/vendor (a journal entry) carries the names on its lines.
    const lineCustomers = t.customer_id === null && lp?.customers.size ? Object.fromEntries(lp.customers) : null;
    const lineVendors = t.vendor_id === null && lp?.vendors.size ? Object.fromEntries(lp.vendors) : null;
    rows.push({ kind: 'line', txnId: id, txnType: t.type, lineCustomers, lineVendors,
      customerId: t.customer_id === null ? null : Number(t.customer_id), vendorId: t.vendor_id === null ? null : Number(t.vendor_id), cells: {
      date: t.date, type: TYPE_LABELS[t.type] ?? t.type, num: t.doc_number ?? t.payment_ref ?? '', posting: ps.length ? 'Yes' : 'No',
      name: t.customer_name ?? t.vendor_name ?? '', memo: t.voided_at ? `Voided${t.memo ? ` · ${t.memo}` : ''}` : t.memo ?? '',
      account: main ? label(main) : '', split: others.length > 1 ? '-Split-' : others[0] ? label(others[0]) : '',
      amount: t.voided_at ? 0 : Number(t.total) } });
    if (rows.length >= MAX_DETAIL_ROWS) break;
  }
  const columns = [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' }, { key: 'posting', label: 'Posting' },
    { key: 'name', label: 'Name' }, { key: 'memo', label: 'Memo/Description' }, { key: 'account', label: 'Account' }, { key: 'split', label: 'Split account' },
    { key: 'amount', label: 'Amount', money: true }];
  return { columns, rows, truncated: rows.length >= MAX_DETAIL_ROWS };
}

// Account List: every account with its type, description and balance as of the date (normal direction; income and
// expense accounts show no balance, as in QuickBooks).
export function accountList({ accounts, lines, asOf, show = 'active', numbers = true, typeLabel }) {
  const bal = new Map();
  for (const l of lines) if (l.date <= asOf) bal.set(l.accountId, (bal.get(l.accountId) ?? 0) + l.amount);
  const keep = a => (show === 'all' ? true : show === 'non_zero' ? Boolean(bal.get(a.account_id)) : a.active);
  const rows = accounts.filter(keep).map(a => ({ kind: 'line', accountId: a.account_id, cells: {
    account: accountLabel(a, numbers), type: typeLabel(a.type), description: `${a.description ?? ''}${a.active ? '' : ' (inactive)'}`.trim(),
    balance: PL_TYPES.includes(a.type) ? null : (bal.get(a.account_id) ?? 0) * normalSign(a.type) } }));
  const columns = [{ key: 'account', label: 'Account' }, { key: 'type', label: 'Type' }, { key: 'description', label: 'Description' }, { key: 'balance', label: 'Balance', money: true }];
  return { columns, rows };
}
