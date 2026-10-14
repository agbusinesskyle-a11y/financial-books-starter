import { TYPE_LABELS } from '../domain/status.js';
import { toHome } from '../domain/fx.js';
import { rateOn } from '../data/currencies.js';

// Exchange gains and losses (multicurrency). Realized: what was posted to Exchange Gain or Loss when foreign invoices,
// bills and credits were settled at a different rate. Unrealized: what the open foreign documents would gain or lose if
// valued at the exchange rate on the report date (nothing is posted; Tools → Revalue posts it at month-end).

export async function realizedGains(db, { orgId, entityId, lines, from, to, fxAccountId, names }) {
  const mine = lines.filter(l => l.accountId === fxAccountId && (!from || l.date >= from) && l.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.txnId - b.txnId));
  const ids = [...new Set(mine.map(l => l.txnId))];
  const { rows } = ids.length ? await db.query(
    `SELECT t.txn_id, t.type, coalesce(t.doc_number, t.payment_ref) AS num, t.currency, t.exchange_rate::float8 AS rate FROM txn t WHERE t.org_id = $1 AND t.txn_id = ANY($2::bigint[])`,
    [orgId, ids]) : { rows: [] };
  const info = new Map(rows.map(r => [Number(r.txn_id), r]));
  const out = mine.map(l => {
    const t = info.get(l.txnId) ?? {};
    return { kind: 'line', txnId: l.txnId, txnType: l.type, cells: { date: l.date, type: TYPE_LABELS[l.type] ?? l.type, num: t.num ?? '',
      name: names.customers.get(l.customerId) ?? names.vendors.get(l.vendorId) ?? '', currency: t.currency ?? '', rate: t.rate ? String(t.rate) : '', amount: -l.amount } };
  });
  if (out.length) out.push({ kind: 'total', label: 'Total realized gain (loss)', grand: true, cells: { amount: out.reduce((s, r) => s + r.cells.amount, 0) } });
  return { rows: out, columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' }, { key: 'name', label: 'Name' },
    { key: 'currency', label: 'Currency' }, { key: 'rate', label: 'Exchange rate' }, { key: 'amount', label: 'Gain (loss)', money: true }] };
}

const AR = { charges: ['invoice', 'late_fee'], credits: ['payment', 'credit_memo'] };
const AP = { charges: ['bill', 'item_receipt'], credits: ['bill_payment', 'vendor_credit'] };

export async function unrealizedGains(db, { orgId, entityId, to }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, coalesce(t.doc_number, t.payment_ref) AS num, t.currency, t.exchange_rate::float8 AS booked_rate,
            coalesce(c.display_name, v.display_name) AS name,
            t.total_cents - coalesce((SELECT sum(a.amount_cents) FROM application a WHERE (a.charge_txn_id = t.txn_id OR a.credit_txn_id = t.txn_id) AND a.applied_on <= $3::date), 0) AS home_open,
            t.foreign_total_cents - coalesce((SELECT sum(a.foreign_cents) FROM application a WHERE (a.charge_txn_id = t.txn_id OR a.credit_txn_id = t.txn_id) AND a.applied_on <= $3::date), 0) AS foreign_open
       FROM txn t LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.currency IS NOT NULL AND t.voided_at IS NULL AND t.txn_date <= $3::date
        AND t.type = ANY($4::text[]) ORDER BY t.currency, t.txn_date, t.txn_id`, [orgId, entityId, to, [...AR.charges, ...AR.credits, ...AP.charges, ...AP.credits]]);
  const rates = new Map();
  const out = [];
  for (const r of rows.filter(x => Number(x.foreign_open) !== 0)) {
    if (!rates.has(r.currency)) rates.set(r.currency, await rateOn(db, { orgId, entityId, code: r.currency, date: to }));
    const rate = rates.get(r.currency);
    if (rate === null) continue;
    const revalued = toHome(r.foreign_open, rate);
    // Receivables gain when the foreign amount is worth more; payables gain when it is worth less. Credits run backwards.
    const receivable = AR.charges.includes(r.type) || AR.credits.includes(r.type);
    const credit = AR.credits.includes(r.type) || AP.credits.includes(r.type);
    const sign = (receivable ? 1 : -1) * (credit ? -1 : 1);
    out.push({ kind: 'line', txnId: Number(r.txn_id), txnType: r.type, cells: { date: r.date, type: TYPE_LABELS[r.type], num: r.num ?? '', name: r.name ?? '',
      currency: r.currency, foreign: Number(r.foreign_open), booked: Number(r.home_open), rate: String(rate), revalued, amount: sign * (revalued - Number(r.home_open)) } });
  }
  if (out.length) out.push({ kind: 'total', label: 'Total unrealized gain (loss)', grand: true, cells: { amount: out.reduce((s, r) => s + r.cells.amount, 0) } });
  return { rows: out, columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' }, { key: 'name', label: 'Name' },
    { key: 'currency', label: 'Currency' }, { key: 'rate', label: 'Rate on date' }, { key: 'foreign', label: 'Open (foreign)', money: true, noTotal: true },
    { key: 'booked', label: 'Open (USD, booked)', money: true, noTotal: true }, { key: 'revalued', label: 'Open (USD, at rate)', money: true, noTotal: true },
    { key: 'amount', label: 'Gain (loss)', money: true }] };
}

