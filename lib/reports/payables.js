import { TYPE_LABELS } from '../domain/status.js';
import { formatAddress } from '../views/format.js';
import { accountLabel } from './statements.js';
import { THRESHOLD_CENTS } from '../data/ten99.js';

// Vendor-side reports built from documents (bill payments, bills and what paid them, checks, 1099 payments) and the
// list reports (contacts, phone numbers, products, terms, payment methods, classes, locations, employees).

const docLine = (t, cells, more = {}) => ({ kind: 'line', txnId: Number(t.txn_id), txnType: t.type, cells, ...more });
const range = `($3::date IS NULL OR t.txn_date >= $3::date) AND t.txn_date <= $4::date`;
const want = (list, id) => !list.length || list.includes(Number(id));

function sections(rows, keyOf, labelOf, lineOf, { totalKey = 'amount', totalLabel = 'Total' } = {}) {
  const out = [];
  let grand = 0;
  for (const k of [...new Set(rows.map(keyOf))]) {
    const mine = rows.filter(r => keyOf(r) === k);
    out.push({ kind: 'section', label: labelOf(mine[0]) });
    let sum = 0;
    for (const r of mine) { const l = lineOf(r); sum += l.cells[totalKey] ?? 0; out.push(l); }
    out.push({ kind: 'total', label: `Total for ${labelOf(mine[0])}`, cells: { [totalKey]: sum } });
    grand += sum;
  }
  if (out.length) out.push({ kind: 'total', label: totalLabel, grand: true, cells: { [totalKey]: grand } });
  return { rows: out, total: grand };
}

// Bill Payment List: bill payments in the period, grouped by the account they were paid from.
export async function billPaymentList(db, { orgId, entityId, from, to, vendors, accountsById }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, coalesce(t.doc_number, t.payment_ref) AS num, t.payment_method, t.memo, t.total_cents::bigint AS total,
            t.account_id, t.vendor_id, v.display_name
       FROM txn t JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'bill_payment' AND t.voided_at IS NULL AND ${range}
      ORDER BY t.account_id, t.txn_date, t.txn_id`, [orgId, entityId, from, to]);
  const label = r => (accountsById.get(Number(r.account_id)) ? accountLabel(accountsById.get(Number(r.account_id))) : 'No account');
  const res = sections(rows.filter(r => want(vendors, r.vendor_id)), r => Number(r.account_id), label,
    r => docLine(r, { date: r.date, num: r.num ?? '', name: r.display_name, method: r.payment_method ?? '', memo: r.memo ?? '', amount: Number(r.total) }));
  return { ...res, columns: [{ key: 'date', label: 'Date' }, { key: 'num', label: 'No.' }, { key: 'name', label: 'Vendor' }, { key: 'method', label: 'Payment method' },
    { key: 'memo', label: 'Memo/Description' }, { key: 'amount', label: 'Amount', money: true }] };
}

// Bills and Applied Payments: each bill dated in the period followed by the payments and credits applied to it.
export async function billsAndPayments(db, { orgId, entityId, from, to, vendors }) {
  const { rows: bills } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, t.doc_number, t.memo, t.total_cents::bigint AS total, t.vendor_id, v.display_name
       FROM txn t JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type IN ('bill', 'item_receipt') AND t.voided_at IS NULL AND ${range}
      ORDER BY v.display_name, t.txn_date, t.txn_id`, [orgId, entityId, from, to]);
  const list = bills.filter(b => want(vendors, b.vendor_id));
  const { rows: apps } = list.length ? await db.query(
    `SELECT a.charge_txn_id, a.amount_cents::bigint AS amount, a.applied_on::text AS date, c.txn_id, c.type, coalesce(c.doc_number, c.payment_ref) AS num, c.memo
       FROM application a JOIN txn c ON c.txn_id = a.credit_txn_id WHERE a.org_id = $1 AND a.charge_txn_id = ANY($2::bigint[]) AND a.applied_on <= $3::date
      ORDER BY a.applied_on, c.txn_id`, [orgId, list.map(b => b.txn_id), to]) : { rows: [] };
  const out = [];
  let grand = 0;
  for (const id of [...new Set(list.map(b => Number(b.vendor_id)))]) {
    const mine = list.filter(b => Number(b.vendor_id) === id);
    out.push({ kind: 'section', label: mine[0].display_name });
    let net = 0;
    for (const b of mine) {
      out.push(docLine(b, { date: b.date, type: TYPE_LABELS[b.type], num: b.doc_number ?? '', memo: b.memo ?? '', amount: Number(b.total) }));
      net += Number(b.total);
      for (const a of apps.filter(x => Number(x.charge_txn_id) === Number(b.txn_id))) {
        out.push({ kind: 'line', sub: true, txnId: Number(a.txn_id), txnType: a.type, cells: { date: a.date, type: TYPE_LABELS[a.type], num: a.num ?? '', memo: a.memo ?? '', amount: -Number(a.amount) } });
        net -= Number(a.amount);
      }
    }
    out.push({ kind: 'total', label: `Still owed to ${mine[0].display_name}`, cells: { amount: net } });
    grand += net;
  }
  if (out.length) out.push({ kind: 'total', label: 'Total still owed', grand: true, cells: { amount: grand } });
  return { rows: out, total: grand, columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' },
    { key: 'memo', label: 'Memo/Description' }, { key: 'amount', label: 'Amount', money: true }] };
}

// 1099 Contractor Balance Summary / Detail: what was paid from a bank account (check, ACH, cash) to vendors tracked for
// 1099 in the period — the same rule as Vendors → 1099 summary (card payments are reported by the card company).
export async function ten99(db, { orgId, entityId, from, to, vendors, detail = false, accountsById }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, coalesce(t.doc_number, t.payment_ref) AS num, t.memo, t.total_cents::bigint AS total,
            t.account_id, t.vendor_id, v.display_name, v.tax_id_last4
       FROM txn t JOIN vendor v ON v.vendor_id = t.vendor_id JOIN account a ON a.account_id = t.account_id AND a.type = 'bank'
      WHERE t.org_id = $1 AND t.entity_id = $2 AND v.track_1099 AND t.type IN ('bill_payment', 'check', 'expense') AND t.voided_at IS NULL AND ${range}
      ORDER BY v.display_name, t.txn_date, t.txn_id`, [orgId, entityId, from, to]);
  const list = rows.filter(r => want(vendors, r.vendor_id));
  if (detail) {
    const res = sections(list, r => Number(r.vendor_id), r => r.display_name, r => docLine(r, { date: r.date, type: TYPE_LABELS[r.type], num: r.num ?? '',
      memo: r.memo ?? '', account: accountsById.get(Number(r.account_id)) ? accountLabel(accountsById.get(Number(r.account_id))) : '', amount: Number(r.total) }));
    return { ...res, columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' },
      { key: 'memo', label: 'Memo/Description' }, { key: 'account', label: 'Paid from' }, { key: 'amount', label: 'Amount', money: true }] };
  }
  const by = new Map();
  for (const r of list) {
    if (!by.has(Number(r.vendor_id))) by.set(Number(r.vendor_id), { name: r.display_name, taxId: r.tax_id_last4, v: 0 });
    by.get(Number(r.vendor_id)).v += Number(r.total);
  }
  const out = [...by].map(([id, p]) => ({ kind: 'line', partyId: id, href: `/vendors/${id}`, cells: { name: p.name, tax_id: p.taxId ? `•••••${p.taxId}` : 'Missing',
    over: p.v >= THRESHOLD_CENTS ? 'Yes' : 'No', amount: p.v } }));
  if (out.length) out.push({ kind: 'total', label: 'Total', grand: true, cells: { amount: out.reduce((s, r) => s + r.cells.amount, 0) } });
  return { rows: out, columns: [{ key: 'name', label: 'Vendor' }, { key: 'tax_id', label: 'Tax ID' }, { key: 'over', label: `$${THRESHOLD_CENTS / 100} or more` },
    { key: 'amount', label: 'Paid from bank accounts', money: true }] };
}

// Check Detail: checks — and bill payments and expenses paid by check — with what each one paid for.
export async function checkDetail(db, { orgId, entityId, from, to, vendors, accountsById, numbers = true }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, coalesce(t.doc_number, t.payment_ref) AS num, t.memo, t.total_cents::bigint AS total, t.vendor_id,
            coalesce(v.display_name, c.display_name) AS name, t.account_id
       FROM txn t LEFT JOIN vendor v ON v.vendor_id = t.vendor_id LEFT JOIN customer c ON c.customer_id = t.customer_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.voided_at IS NULL AND ${range}
        AND (t.type = 'check' OR (t.type IN ('bill_payment', 'expense') AND t.payment_method = 'Check'))
      ORDER BY t.txn_date, t.txn_id`, [orgId, entityId, from, to]);
  const list = rows.filter(r => want(vendors, r.vendor_id ?? 0));
  const { rows: legs } = list.length ? await db.query(
    `SELECT txn_id, account_id, sum(amount_cents)::bigint AS amount FROM posting WHERE org_id = $1 AND txn_id = ANY($2::bigint[]) AND amount_cents > 0
      GROUP BY txn_id, account_id ORDER BY txn_id, min(line_no)`, [orgId, list.map(r => r.txn_id)]) : { rows: [] };
  const out = [];
  let grand = 0;
  for (const t of list) {
    const bank = accountsById.get(Number(t.account_id));
    out.push(docLine(t, { date: t.date, type: TYPE_LABELS[t.type], num: t.num ?? '', name: t.name ?? '', memo: t.memo ?? '', account: bank ? accountLabel(bank, numbers) : '',
      amount: Number(t.total) }));
    for (const l of legs.filter(x => Number(x.txn_id) === Number(t.txn_id))) {
      const a = accountsById.get(Number(l.account_id));
      out.push({ kind: 'line', sub: true, accountId: Number(l.account_id), cells: { date: '', type: '', num: '', name: '', memo: '', account: a ? accountLabel(a, numbers) : '', amount: -Number(l.amount) } });
    }
    grand += Number(t.total);
  }
  if (out.length) out.push({ kind: 'total', label: 'Total checks', grand: true, cells: { amount: grand } });
  return { rows: out, total: grand, columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' },
    { key: 'name', label: 'Name' }, { key: 'memo', label: 'Memo/Description' }, { key: 'account', label: 'Account' }, { key: 'amount', label: 'Amount', money: true }] };
}

// ---- lists ----

const contactCols = [{ key: 'name', label: 'Name' }, { key: 'company', label: 'Company' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
  { key: 'address', label: 'Billing address' }];
const phoneCols = [{ key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'mobile', label: 'Mobile' }];

export async function contactList(db, { orgId, entityId, party, phones = false, show = 'active' }) {
  const table = party === 'vendor' ? 'vendor' : 'customer';
  const { rows } = await db.query(
    `SELECT ${table}_id AS id, display_name, company_name, phone, mobile, email, billing_address, active FROM ${table}
      WHERE org_id = $1 AND entity_id = $2 ${show === 'all' ? '' : 'AND active'} ORDER BY lower(display_name)`, [orgId, entityId]);
  return { columns: phones ? phoneCols : contactCols, rows: rows.map(r => ({ kind: 'line', href: `/${table}s/${r.id}`, cells: {
    name: `${r.display_name}${r.active ? '' : ' (inactive)'}`, company: r.company_name ?? '', phone: r.phone ?? '', mobile: r.mobile ?? '', email: r.email ?? '',
    address: formatAddress(r.billing_address) ?? '' } })) };
}

export async function productList(db, { orgId, entityId, accountsById, show = 'active' }) {
  const { rows } = await db.query(
    `SELECT item_id, name, sku, kind, description, rate_cents::bigint AS rate, purchase_cost_cents::bigint AS cost, qty_on_hand, income_account_id, active FROM item
      WHERE org_id = $1 AND entity_id = $2 AND kind <> 'system' ${show === 'all' ? '' : 'AND active'} ORDER BY lower(name)`, [orgId, entityId]);
  const KIND = { product: 'Non-inventory', service: 'Service', inventory: 'Inventory' };
  return { columns: [{ key: 'name', label: 'Product/Service' }, { key: 'sku', label: 'SKU' }, { key: 'kind', label: 'Type' }, { key: 'description', label: 'Description' },
    { key: 'account', label: 'Income account' }, { key: 'qty', label: 'Qty on hand' }, { key: 'cost', label: 'Cost', money: true }, { key: 'rate', label: 'Sales price', money: true }],
  rows: rows.map(r => ({ kind: 'line', href: `/settings/items/${r.item_id}`, cells: { name: `${r.name}${r.active ? '' : ' (inactive)'}`, sku: r.sku ?? '', kind: KIND[r.kind] ?? r.kind,
    description: r.description ?? '', account: accountsById.get(Number(r.income_account_id))?.name ?? '',
    qty: r.kind === 'inventory' ? Number(r.qty_on_hand).toLocaleString('en-US', { maximumFractionDigits: 3 }) : '', cost: r.cost === null ? null : Number(r.cost), rate: Number(r.rate) } })) };
}

export async function simpleList(db, { orgId, entityId, kind }) {
  if (kind === 'terms') {
    const { rows } = await db.query('SELECT name, due_days FROM terms WHERE org_id = $1 AND entity_id = $2 ORDER BY due_days, name', [orgId, entityId]);
    return { columns: [{ key: 'name', label: 'Terms' }, { key: 'days', label: 'Due in (days)' }], rows: rows.map(r => ({ kind: 'line', cells: { name: r.name, days: String(r.due_days) } })) };
  }
  if (kind === 'payment_methods') {
    const { rows } = await db.query(
      `SELECT payment_method AS name, count(*) AS n, max(txn_date)::text AS last FROM txn WHERE org_id = $1 AND entity_id = $2 AND payment_method IS NOT NULL
        GROUP BY payment_method ORDER BY lower(payment_method)`, [orgId, entityId]);
    return { columns: [{ key: 'name', label: 'Payment method' }, { key: 'n', label: 'Transactions' }, { key: 'last', label: 'Last used' }],
      rows: rows.map(r => ({ kind: 'line', cells: { name: r.name, n: String(r.n), last: r.last } })) };
  }
  if (kind === 'classes' || kind === 'locations') {
    const one = kind === 'classes' ? 'class' : 'location';
    const { rows } = await db.query(`SELECT name, active FROM ${one} WHERE org_id = $1 AND entity_id = $2 ORDER BY lower(name)`, [orgId, entityId]);
    return { columns: [{ key: 'name', label: one === 'class' ? 'Class' : 'Location' }, { key: 'active', label: 'Status' }],
      rows: rows.map(r => ({ kind: 'line', cells: { name: r.name, active: r.active ? 'Active' : 'Inactive' } })) };
  }
  if (kind === 'employees') {
    const { rows } = await db.query('SELECT name, email, role, active, last_login_at FROM app_user WHERE org_id = $1 ORDER BY lower(name)', [orgId]);
    return { columns: [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role', label: 'Role' }, { key: 'active', label: 'Status' }],
      rows: rows.map(r => ({ kind: 'line', cells: { name: r.name, email: r.email, role: r.role, active: r.active ? 'Active' : 'Inactive' } })) };
  }
  return { columns: [], rows: [] };
}

// Transaction List by Tag Group: each tag (under its group) with its transactions; untagged ones last.
export function groupByTag(list, { tagsByTxn, tags, groups }) {
  const rows = [];
  const tagIds = [...tags.keys()].sort((a, b) => `${groups.get(a) ?? ''} ${tags.get(a)}`.localeCompare(`${groups.get(b) ?? ''} ${tags.get(b)}`));
  for (const id of tagIds) {
    const mine = list.rows.filter(r => tagsByTxn.get(r.txnId)?.has(id));
    if (!mine.length) continue;
    const label = groups.get(id) ? `${groups.get(id)}: ${tags.get(id)}` : tags.get(id);
    rows.push({ kind: 'section', label }, ...mine, { kind: 'total', label: `Total for ${label}`, cells: { amount: mine.reduce((s, r) => s + r.cells.amount, 0) } });
  }
  return { rows, columns: list.columns, truncated: list.truncated };
}

