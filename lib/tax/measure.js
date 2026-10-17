// lib/tax/measure.js
// Raw book measurements for Tax Books bindings (spec §4.5, §13.1 T2, §13.1 T3): per account of one company and one period, the
// beginning balance, the period's activity, the ending balance, gross debits and credits, the posting count and the number of posting
// lines (transaction × line), whether a settlement linked to the period touches it, and a version of each measurement that changes
// whenever the rows behind it change. These are STAGING measurements (Codex t2-plan-r1 B3): the books as posted (accrual postings),
// basis 'as_posted' — not resolved book-basis Schedule L values for cash-basis books, and not tax recognition (the cash layer, T3).
// Amounts come out of SQL as text and become BigInt: lib/reports/ledger-data.js and statements.js convert to Number; the tax path never does.
import { createHash } from 'node:crypto';
import { PL_TYPES } from '../reports/statements.js';

const big = v => BigInt(v ?? '0');
const md5 = text => createHash('md5').update(text).digest('hex');
// One posting's identity for a version: its transaction, line, amount and date — not posting_id, which a repost renumbers without
// changing anything a measurement depends on.
const ROW = `p.txn_id || ':' || coalesce(p.line_no::text, '-') || ':' || p.amount_cents || ':' || p.txn_date`;
const ORDER = 'ORDER BY p.txn_id, p.line_no NULLS FIRST, p.amount_cents, p.txn_date';

// Map accountId → { accountId, entityId, name, number, type, systemKey, active, pl, basis: 'as_posted', begin, activity, end, grossDebit,
// grossCredit, postings, lineGroups, cashTouched, versions: { begin, activity, end } }, every account of the company.
// cashTouched (a conservative candidate set for a cash-method return, B3): the account is posted by a document or payment that an
// application links to another, where the payment's date, the document's date or the application's date falls in the period — a
// December receipt applied in January to a January invoice touches the invoice's accounts in December's year. T3's cash layer decides
// what is recognized; T2 only refuses to treat such an account as out of scope.
export async function measureAccounts(db, { orgId, sourceEntityId, periodStart, periodEnd }) {
  const { rows } = await db.query(
    `SELECT a.account_id, a.entity_id, a.name, a.number, a.type, a.system_key, a.active,
            coalesce(sum(p.amount_cents) FILTER (WHERE p.txn_date < $3::date), 0)::text AS before_cents,
            coalesce(sum(p.amount_cents) FILTER (WHERE p.txn_date >= $3::date), 0)::text AS activity_cents,
            coalesce(sum(p.amount_cents) FILTER (WHERE p.txn_date >= $3::date AND p.amount_cents > 0), 0)::text AS debit_cents,
            coalesce(-sum(p.amount_cents) FILTER (WHERE p.txn_date >= $3::date AND p.amount_cents < 0), 0)::text AS credit_cents,
            count(p.posting_id) FILTER (WHERE p.txn_date >= $3::date)::int AS postings,
            count(DISTINCT (p.txn_id, coalesce(p.line_no, 0))) FILTER (WHERE p.txn_date >= $3::date)::int AS line_groups,
            md5(coalesce(string_agg(${ROW}, ',' ${ORDER}) FILTER (WHERE p.txn_date < $3::date), '')) AS before_version,
            md5(coalesce(string_agg(${ROW}, ',' ${ORDER}) FILTER (WHERE p.txn_date >= $3::date), '')) AS activity_version,
            EXISTS (SELECT 1 FROM application ap JOIN txn c ON c.txn_id = ap.credit_txn_id JOIN txn h ON h.txn_id = ap.charge_txn_id
                      JOIN posting q ON q.org_id = ap.org_id AND q.txn_id IN (ap.charge_txn_id, ap.credit_txn_id)
                     WHERE ap.org_id = $1 AND q.account_id = a.account_id
                       AND (ap.applied_on BETWEEN $3::date AND $4::date OR c.txn_date BETWEEN $3::date AND $4::date OR h.txn_date BETWEEN $3::date AND $4::date)) AS cash_touched
       FROM account a LEFT JOIN posting p ON p.org_id = a.org_id AND p.account_id = a.account_id AND p.txn_date <= $4::date
      WHERE a.org_id = $1 AND a.entity_id = $2
      GROUP BY a.account_id ORDER BY a.number NULLS LAST, a.name`, [orgId, sourceEntityId, periodStart, periodEnd]);
  // Earlier years' profit, for the retained-earnings account's beginning (the books close income and expense into it every year,
  // statements.js closeYears; Tax Books periods are calendar years). Only as complete as the imported history: a raw beginning is not a
  // reviewed opening (T3's opening bridges stay mandatory).
  const { rows: [plBefore] } = await db.query(
    `SELECT coalesce(sum(p.amount_cents), 0)::text AS cents, md5(coalesce(string_agg(${ROW}, ',' ${ORDER}), '')) AS version
       FROM posting p JOIN account a ON a.org_id = p.org_id AND a.account_id = p.account_id
      WHERE p.org_id = $1 AND p.entity_id = $2 AND p.txn_date < $3::date AND a.type = ANY($4::text[])`, [orgId, sourceEntityId, periodStart, PL_TYPES]);
  const out = new Map();
  for (const r of rows) {
    const pl = PL_TYPES.includes(r.type), retained = r.system_key === 'retained';
    const begin = pl ? 0n : big(r.before_cents) + (retained ? big(plBefore.cents) : 0n);
    const beginVersion = pl ? md5('pl-begins-at-zero') : retained ? md5(`${r.before_version}|${plBefore.version}`) : r.before_version;
    const activity = big(r.activity_cents);
    out.set(Number(r.account_id), {
      accountId: Number(r.account_id), entityId: Number(r.entity_id), name: r.name, number: r.number, type: r.type, systemKey: r.system_key, active: r.active, pl, basis: 'as_posted',
      begin, activity, end: begin + activity, grossDebit: big(r.debit_cents), grossCredit: big(r.credit_cents), postings: r.postings, lineGroups: r.line_groups, cashTouched: r.cash_touched,
      versions: { begin: beginVersion, activity: r.activity_version, end: md5(`${beginVersion}|${r.activity_version}`) },
    });
  }
  return out;
}

// Map accountId → the period's posting lines of each account: [{ txnId, lineNo, cents, date, type, docNumber, memo, txnVersion }], one
// entry per (transaction, line) with the line's total on the account and the transaction's current txn_version() (migration 055). A
// posting with no line number (a system leg) has lineNo null. Ordered by date, transaction and line.
export async function measureLines(db, { orgId, sourceEntityId, accountIds, periodStart, periodEnd }) {
  const { rows } = await db.query(
    `SELECT p.account_id, p.txn_id, p.line_no, sum(p.amount_cents)::text AS cents, min(p.txn_date)::text AS date, t.type, t.doc_number, coalesce(max(p.memo), t.memo) AS memo,
            txn_version(p.txn_id) AS txn_version
       FROM posting p JOIN txn t ON t.org_id = p.org_id AND t.txn_id = p.txn_id
      WHERE p.org_id = $1 AND p.entity_id = $2 AND p.account_id = ANY($3::bigint[]) AND p.txn_date BETWEEN $4::date AND $5::date
      GROUP BY p.account_id, p.txn_id, p.line_no, t.type, t.doc_number, t.memo
      ORDER BY p.account_id, min(p.txn_date), p.txn_id, p.line_no NULLS FIRST`, [orgId, sourceEntityId, accountIds, periodStart, periodEnd]);
  const out = new Map();
  for (const r of rows) {
    const k = Number(r.account_id);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ txnId: Number(r.txn_id), lineNo: r.line_no === null ? null : Number(r.line_no), cents: big(r.cents), date: r.date, type: r.type, docNumber: r.doc_number, memo: r.memo, txnVersion: r.txn_version });
  }
  return out;
}
// The current txn_version() of some transactions (a deleted one is absent).
export async function txnVersions(db, { orgId, txnIds }) {
  if (!txnIds.length) return new Map();
  const { rows } = await db.query('SELECT txn_id, txn_version(txn_id) AS v FROM txn WHERE org_id = $1 AND txn_id = ANY($2::bigint[])', [orgId, txnIds]);
  return new Map(rows.map(r => [Number(r.txn_id), r.v]));
}

// BigInt cents as display text ("-$1,234.50"); lib/domain/money.js formatCents takes a safe Number and is not used for tax amounts.
export function dollars(cents) {
  const c = BigInt(cents), neg = c < 0n, a = neg ? -c : c;
  return `${neg ? '-' : ''}$${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(a % 100n).padStart(2, '0')}`;
}
