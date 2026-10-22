import { createHash } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, savePaymentTx, deleteTxnTx } from './writes.js';
import { writeVendorDoc, deleteVendorTxnTx, payBillsTx } from './payables.js';
import { writeDeposit, deleteDepositTx, listUndeposited } from './deposits.js';
import { writeJournalEntry, writeTransfer, deleteLedgerTxnTx, TRANSFER_TYPES } from './ledger-tools.js';
import { assertNotReconciled } from './locks.js';
import { applyTxnDimensions } from './accounting.js';
import { repost } from './ledger.js';
import { normalSign } from '../domain/ledger.js';
import { fileAttachments, unfileAttachments } from './bank-extras.js';
import { writeVendorDoc as writeBill } from './payables.js';
import { formatCents, parseMoney } from '../domain/money.js';
import { namedParties, namedIn } from '../bankfeed/wording.js';

// Bank transactions (stage B3, QBO's Banking page): each bank item from ledgerline is reviewed once —
// matched to what's already in the books, added as a new transaction, recorded as a transfer, or excluded — and can be
// undone. Amounts on bank items use the bank sign (money in positive); a books transaction's effect on the account is the
// sum of its postings there, which has the same sign for bank and card accounts (a card charge credits the card).
//
// Bank review v2: every operation runs under the company lock and checks, after taking it, that the bank
// line, the chosen books transactions, the possible duplicates and (for Undo) the plan are still what the person saw —
// `expect` — and refuses (StaleError) when anything moved. Each operation has a pool form and a `…Tx` form for callers
// that already hold the lock (a batch, an automatic rule).

const fail = message => { throw new ValidationError(message); };
const MATCH_DAYS_BEFORE = 60; // a check written two months before it cleared still matches
const MATCH_DAYS_AFTER = 10;
const CONFIDENT_DAYS = 5;
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 24);
const locked = (pool, { orgId, entityId }, fn) => withTransaction(pool, async tx => { await lockEntity(tx, orgId, entityId); return fn(tx); });

// Accounts a bank line can move money to as a transfer (a card payment, savings, a loan): picking one of these as the
// whole category records a transfer, not an expense.
const TRANSFER_TO = ['bank', 'credit_card', 'other_current_liability', 'long_term_liability'];
const TRANSFER_OTHER = ['bank', 'credit_card', 'other_current_asset', 'other_asset', 'other_current_liability', 'long_term_liability'];

// The company's fed accounts, as cards across the top: bank balance (ledgerline) vs. books balance, items to review.
export async function bankAccounts(db, { orgId, entityId }) {
  const { rows } = await db.query(`
    SELECT l.ll_account_id::text AS id, l.display_name, l.institution_name, l.mask, l.kind, l.bank_balance_cents, l.balance_as_of, l.balance_stale,
           l.connection_state, l.books_account_id, a.name AS books_name, a.type AS books_type,
           coalesce((SELECT sum(p.amount_cents) FROM posting p WHERE p.account_id = a.account_id), 0)::bigint AS books_signed,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.entity_id = l.entity_id AND i.ll_account_id = l.ll_account_id AND i.bank_state = 'active' AND i.review_state = 'new' AND NOT i.pending) AS to_review,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.entity_id = l.entity_id AND i.ll_account_id = l.ll_account_id AND i.attention IS NOT NULL) AS attention,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.entity_id = l.entity_id AND i.ll_account_id = l.ll_account_id AND i.bank_state = 'active' AND i.review_state = 'new' AND i.pending) AS pending,
           (SELECT max(v.period_end) FROM ledgerline_verified_month v WHERE v.entity_id = l.entity_id AND v.ll_account_id = l.ll_account_id) AS verified_through
      FROM ledgerline_account l JOIN account a ON a.account_id = l.books_account_id
     WHERE l.org_id = $1 AND l.entity_id = $2 AND l.include
     ORDER BY CASE WHEN a.type = 'bank' THEN 0 WHEN a.type = 'credit_card' THEN 1 ELSE 2 END, lower(a.name)`, [orgId, entityId]);
  return rows.map(r => ({ ...r, books_balance_cents: Number(r.books_signed) * normalSign(r.books_type) }));
}

// For review: waiting. Categorized: in the books (added or matched). Excluded. Changed: anything the bank changed or
// removed after it was reviewed, or whose books transaction was edited or deleted, until a person looks at it — shown
// apart, not mixed into Categorized.
const TAB_SQL = {
  review: `i.bank_state = 'active' AND i.review_state = 'new'`,
  categorized: `i.review_state IN ('added', 'matched')`,
  excluded: `i.review_state = 'excluded' AND i.bank_state = 'active'`,
  changed: `i.attention IS NOT NULL`,
};
export const BANK_TABS = Object.keys(TAB_SQL);
const MADE = `('added', 'matched', 'transfer', 'settled')`;

// List filters and order (stage BR-6, QBO's filter on Categorized/Excluded): text (the bank's descriptions, the merchant, the
// payee recorded), posted-date range, amount range (its size), money in or out, a category the item went to, the rule that
// decided it, and how it was decided. f: { q, from, to, min, max (cents), dir: 'in'|'out', category, rule, how }.
export const BANK_SORTS = { new: 'i.pending DESC, i.posted_date DESC, i.item_id DESC', old: 'i.pending DESC, i.posted_date ASC, i.item_id ASC',
  big: 'abs(i.amount_cents) DESC, i.posted_date DESC, i.item_id DESC', small: 'abs(i.amount_cents) ASC, i.posted_date DESC, i.item_id DESC' };
export const BANK_HOW = { person: ['manual', 'row'], batch: ['batch'], auto: ['auto'] };
const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(v)) ? v : null);
function filterSql(f = {}, params) {
  const add = v => { params.push(v); return `$${params.length}`; };
  const out = [];
  if (String(f.q ?? '').trim()) {
    const q = add(`%${likeText(f.q)}%`);
    out.push(`(i.description ILIKE ${q} OR i.original_description ILIKE ${q} OR i.merchant_name ILIKE ${q}
      OR EXISTS (SELECT 1 FROM bank_feed_link k WHERE k.item_id = i.item_id AND txn_party(k.txn_id) ILIKE ${q}))`);
  }
  if (isoDate(f.from)) out.push(`i.posted_date >= ${add(f.from)}::date`);
  if (isoDate(f.to)) out.push(`i.posted_date <= ${add(f.to)}::date`);
  if (Number.isSafeInteger(f.min) && f.min >= 0) out.push(`abs(i.amount_cents) >= ${add(f.min)}`);
  if (Number.isSafeInteger(f.max) && f.max >= 0) out.push(`abs(i.amount_cents) <= ${add(f.max)}`);
  if (f.dir === 'in') out.push('i.amount_cents > 0');
  if (f.dir === 'out') out.push('i.amount_cents < 0');
  if (Number.isSafeInteger(f.category)) {
    out.push(`EXISTS (SELECT 1 FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id WHERE k.item_id = i.item_id AND p.account_id = ${add(f.category)})`);
  }
  if (Number.isSafeInteger(f.rule)) {
    const n = add(f.rule);
    out.push(`(i.rule_id = ${n} OR EXISTS (SELECT 1 FROM bank_review_event e WHERE e.entity_id = i.entity_id AND e.ll_transaction_id = i.ll_transaction_id
      AND e.kind IN ${MADE} AND e.rule_id = ${n}))`);
  }
  if (BANK_HOW[f.how]) {
    out.push(`(SELECT e.source FROM bank_review_event e WHERE e.entity_id = i.entity_id AND e.ll_transaction_id = i.ll_transaction_id AND e.kind IN ${MADE}
      ORDER BY e.event_id DESC LIMIT 1) = ANY(${add(BANK_HOW[f.how])}::text[])`);
  }
  return out.length ? ` AND ${out.join(' AND ')}` : '';
}

// How many items of a fed account's tab fit the filters, and their ids (in the list's order) — for "all N matching".
export async function countBankItems(db, { orgId, entityId, llAccountId, tab = 'review', filters = {} }) {
  if (!TAB_SQL[tab]) fail('Unknown tab.');
  const params = [orgId, entityId, llAccountId];
  const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM bank_feed_item i WHERE i.org_id = $1 AND i.entity_id = $2 AND i.ll_account_id = $3::uuid
    AND ${TAB_SQL[tab]}${filterSql(filters, params)}`, params);
  return r.n;
}
export async function matchingItemIds(db, { orgId, entityId, llAccountId, tab = 'review', filters = {} }) {
  if (!TAB_SQL[tab]) fail('Unknown tab.');
  const params = [orgId, entityId, llAccountId];
  const { rows } = await db.query(`SELECT i.item_id FROM bank_feed_item i WHERE i.org_id = $1 AND i.entity_id = $2 AND i.ll_account_id = $3::uuid
    AND ${TAB_SQL[tab]} AND NOT i.pending${filterSql(filters, params)} ORDER BY ${BANK_SORTS.new} LIMIT 5001`, params);
  return rows.map(x => Number(x.item_id));
}

// Bank items of one fed account on one tab (newest first unless sorted otherwise), with what each became and how it was
// decided (made_event: the decision that put it in the books; last_event: the latest step, e.g. Checked), and the
// categories it went to.
export async function listBankItems(db, { orgId, entityId, llAccountId, tab = 'review', limit = 300, offset = 0, filters = {}, sort = 'new' }) {
  if (!TAB_SQL[tab]) fail('Unknown tab.');
  const params = [orgId, entityId, llAccountId, limit, offset];
  const where = filterSql(filters, params);
  const { rows } = await db.query(`
    SELECT i.item_id, i.ll_account_id::text AS ll_account_id, i.posted_date, i.authorized_date, i.amount_cents, i.description, i.original_description, i.merchant_name, i.category,
           i.check_number, i.pending, i.bank_state, i.review_state, i.attention, i.reviewed_by, i.reviewed_at, i.auto_hold, i.revision, i.review_version,
           coalesce((SELECT r.name FROM bank_rule r WHERE r.rule_id = i.rule_id),
             (SELECT e.rule_name FROM bank_review_event e WHERE e.entity_id = i.entity_id AND e.ll_transaction_id = i.ll_transaction_id AND e.kind IN ${MADE}
               ORDER BY e.event_id DESC LIMIT 1)) AS rule_name,
           (SELECT json_build_object('kind', e.kind, 'source', e.source, 'basis', e.basis, 'rule_name', e.rule_name, 'separate', e.separate, 'actor', e.actor, 'at', e.at)
              FROM bank_review_event e WHERE e.entity_id = i.entity_id AND e.ll_transaction_id = i.ll_transaction_id AND e.kind IN ${MADE}
             ORDER BY e.event_id DESC LIMIT 1) AS made_event,
           (SELECT json_build_object('kind', e.kind, 'source', e.source, 'actor', e.actor, 'at', e.at)
              FROM bank_review_event e WHERE e.entity_id = i.entity_id AND e.ll_transaction_id = i.ll_transaction_id ORDER BY e.event_id DESC LIMIT 1) AS last_event,
           coalesce((SELECT json_agg(json_build_object('txn_id', t.txn_id, 'type', t.type, 'doc_number', t.doc_number, 'txn_date', t.txn_date, 'how', k.how,
                       'party', txn_party(t.txn_id)) ORDER BY t.txn_date, t.txn_id)
                     FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = i.item_id), '[]') AS links,
           (SELECT string_agg(DISTINCT a.name, ', ') FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id JOIN account a ON a.account_id = p.account_id
             WHERE k.item_id = i.item_id AND p.account_id <> l.books_account_id) AS categories,
           (SELECT count(*)::int FROM bank_item_attachment f WHERE f.entity_id = i.entity_id AND f.ll_transaction_id = i.ll_transaction_id) AS files,
           (SELECT n.note FROM bank_item_note n WHERE n.entity_id = i.entity_id AND n.ll_transaction_id = i.ll_transaction_id ORDER BY n.at DESC, n.note_id DESC LIMIT 1) AS note
      FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id
     WHERE i.org_id = $1 AND i.entity_id = $2 AND i.ll_account_id = $3::uuid AND ${TAB_SQL[tab]}${where}
     ORDER BY ${BANK_SORTS[sort] ?? BANK_SORTS.new} LIMIT $4 OFFSET $5`, params);
  return rows;
}

// How many items come before this one on a tab, in the list's order (newest first, pending on top) — to land back on the
// page that shows it.
export async function positionInTab(db, { orgId, entityId, llAccountId, tab = 'review', itemId }) {
  if (!TAB_SQL[tab]) return 0;
  const { rows: [r] } = await db.query(`
    SELECT count(*)::int AS n FROM bank_feed_item i, bank_feed_item t
     WHERE t.item_id = $4 AND i.org_id = $1 AND i.entity_id = $2 AND i.ll_account_id = $3::uuid AND ${TAB_SQL[tab]}
       AND (i.pending::int, i.posted_date, i.item_id) > (t.pending::int, t.posted_date, t.item_id)`, [orgId, entityId, llAccountId, Number(itemId) || 0]);
  return r?.n ?? 0;
}

export async function tabCounts(db, { orgId, entityId, llAccountId }) {
  const { rows: [r] } = await db.query(`SELECT
      count(*) FILTER (WHERE ${TAB_SQL.review})::int AS review, count(*) FILTER (WHERE ${TAB_SQL.categorized})::int AS categorized,
      count(*) FILTER (WHERE ${TAB_SQL.excluded})::int AS excluded, count(*) FILTER (WHERE ${TAB_SQL.changed})::int AS changed
    FROM bank_feed_item i WHERE i.org_id = $1 AND i.entity_id = $2 AND i.ll_account_id = $3::uuid`, [orgId, entityId, llAccountId]);
  return r;
}

// The whole history of a bank line (all the item rows it has had), newest first.
export async function itemHistory(db, { orgId, entityId, item }) {
  const { rows } = await db.query(`SELECT event_id, item_id, kind, source, basis, rule_name, separate, actor, at, txn_ids, detail FROM bank_review_event
    WHERE org_id = $1 AND entity_id = $2 AND ll_transaction_id = $3 ORDER BY event_id DESC LIMIT 50`, [orgId, entityId, item.ll_transaction_id]);
  return rows;
}

// One bank item of this company with its fed account's books account.
export async function getBankItem(db, { orgId, entityId, itemId, lock = false }) {
  const { rows: [i] } = await db.query(`
    SELECT i.*, i.ll_account_id::text AS ll_account, l.books_account_id, a.type AS books_type, a.name AS books_name,
           -- Texted receipts matched to this line and waiting on its review that still fit it (stage S3): the same amount,
           -- the line dated 2 days before to 7 after the receipt, no other card's last four. Part of what a page showed.
           (SELECT string_agg(r.receipt_id::text, ',' ORDER BY r.receipt_id) FROM receipt r
             WHERE r.org_id = i.org_id AND r.entity_id = i.entity_id AND r.item_id = i.item_id AND r.status = 'review'
               AND (r.extracted->>'total_cents')::bigint = -i.amount_cents
               AND i.posted_date BETWEEN coalesce((r.extracted->>'date')::date, r.created_at::date) - 2 AND coalesce((r.extracted->>'date')::date, r.created_at::date) + 7
               AND (r.extracted->>'card_last4' IS NULL OR l.mask IS NULL OR l.mask = r.extracted->>'card_last4')) AS receipt_ids
      FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id JOIN account a ON a.account_id = l.books_account_id
     WHERE i.org_id = $1 AND i.entity_id = $2 AND i.item_id = $3 AND l.include${lock ? ' FOR UPDATE OF i' : ''}`, [orgId, entityId, Number(itemId) || 0]);
  if (i?.receipt_ids) i.receipt_ids = await fittingReceipts(db, { orgId, item: i });
  return i ?? null;
}
// …and whose vendor every vendor the bank text names agrees with (a corrected or different charge doesn't take it).
async function fittingReceipts(db, { orgId, item }) {
  const ids = item.receipt_ids.split(',').map(Number);
  const { rows: vendors } = await db.query('SELECT vendor_id, display_name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active', [orgId, item.entity_id]);
  const named = namedParties(vendors.map(v => ({ key: `v:${v.vendor_id}`, name: v.display_name })), item).map(p => p.key);
  if (!named.length) return item.receipt_ids;
  const { rows } = await db.query('SELECT receipt_id, vendor_id, extracted FROM receipt WHERE org_id = $1 AND receipt_id = ANY($2::bigint[]) ORDER BY receipt_id', [orgId, ids]);
  // A receipt not yet tied to a vendor (it wasn't one of the company's when it came in) fits by the name it was read with.
  const nameOf = new Map(vendors.map(v => [`v:${v.vendor_id}`, v.display_name]));
  const agrees = r => (r.vendor_id ? named.every(k => k === `v:${r.vendor_id}`)
    : named.length === 1 && Boolean(r.extracted?.vendor) && namedIn(nameOf.get(named[0]), { description: r.extracted.vendor }));
  return rows.filter(agrees).map(r => r.receipt_id).join(',') || null;
}

// ---- what the person saw ----

// The bank line as a page showed it: its bank revision and facts, and its review step. A form carries it back (`rev`).
export const itemToken = i => `${i.item_id}:${i.revision}:${i.amount_cents}:${i.posted_date}:${i.review_state}:${i.pending ? 1 : 0}:${i.review_version}${i.receipt_ids ? `:r${i.receipt_ids}` : ''}`;
// The possible duplicates a person acknowledged with "This is a separate transaction".
export const evidenceToken = dupes => hash(dupes.map(d => `${d.reason}:${d.txn_id}:${d.version ?? ''}`).sort().join('|'));
export class StaleError extends ValidationError {}
const STALE = 'This bank item changed since the page was shown (the bank sent a correction, or someone else reviewed it). Check it again below.';
function checkRev(item, expect) {
  if (expect?.rev !== undefined && expect.rev !== itemToken(item)) throw new StaleError(STALE);
}
// The versions of books transactions (txn_version), one query.
export async function txnVersions(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query('SELECT txn_id, txn_version(txn_id) AS v FROM txn WHERE txn_id = ANY($1::bigint[])', [ids.map(Number)]);
  return new Map(rows.map(r => [Number(r.txn_id), r.v]));
}

const reviewable = item => {
  if (!item) fail('Bank item not found.');
  if (item.bank_state !== 'active') fail('The bank removed this item, so it can’t be added or matched.');
  if (item.pending) fail('This item is still pending at the bank. It can be added once it posts.');
  if (item.review_state !== 'new') fail('This item has already been reviewed. Undo it first to change it.');
};

// ---- candidates and duplicates ----

// Books transactions this bank item could be: same account, near the date and not already used by another bank item of
// the account. exact: the same amount (best first). others: smaller amounts in the same direction, to tick several that
// together make up the bank item (with `others: true`). For money into a bank account, also payments waiting in
// Undeposited Funds (several can be grouped into one deposit; up to 10% more than the bank amount, for a deposit less a fee
// made up with an adjustment); pass `undeposited` to reuse a list already loaded.
// Each carries `version` (txn_version) so a Match form can prove it matches what was shown.
export async function matchCandidates(db, { orgId, entityId, item, others = false, undeposited: waiting = null }) {
  const { rows: all } = await db.query(`
    SELECT t.txn_id, t.type, t.doc_number, t.payment_ref, t.txn_date, t.memo, txn_version(t.txn_id) AS version, txn_party(t.txn_id) AS party, s.amount_cents
      FROM (SELECT p.txn_id, sum(p.amount_cents)::bigint AS amount_cents FROM posting p WHERE p.org_id = $1 AND p.account_id = $2 GROUP BY p.txn_id) s
      JOIN txn t ON t.txn_id = s.txn_id
     WHERE t.entity_id = $3 AND t.voided_at IS NULL AND t.txn_date BETWEEN $5::date - $6::int AND $5::date + $7::int
       AND CASE WHEN $10::boolean THEN sign(s.amount_cents) = sign($4::bigint) AND abs(s.amount_cents) <= abs($4::bigint) ELSE s.amount_cents = $4 END
       AND NOT EXISTS (SELECT 1 FROM bank_feed_link k JOIN bank_feed_item o ON o.item_id = k.item_id
                        WHERE k.txn_id = t.txn_id AND o.entity_id = t.entity_id AND o.ll_account_id = $8::uuid AND o.item_id <> $9)`,
    [orgId, item.books_account_id, entityId, item.amount_cents, item.posted_date, MATCH_DAYS_BEFORE, MATCH_DAYS_AFTER, item.ll_account, item.item_id, others]);
  const rows = all.filter(r => Number(r.amount_cents) === Number(item.amount_cents));
  const words = String(item.description ?? '').toUpperCase();
  const scored = rows.map(r => {
    let score = 100 - Math.abs(dayDiff(item.posted_date, r.txn_date));
    const sameCheck = Boolean(checkNo(item.check_number) && checkNo(r.doc_number) === checkNo(item.check_number));
    const checkConflict = checkConflicts(item, r);
    if (sameCheck) score += 100;
    if (checkConflict) score -= 200;
    if (r.party && r.party !== 'Multiple' && words.includes(String(r.party).toUpperCase().split(/\s+/)[0])) score += 20;
    return { ...r, score, days: dayDiff(item.posted_date, r.txn_date), sameCheck, checkConflict };
  }).sort((a, b) => b.score - a.score || a.txn_id - b.txn_id);
  const rest = all.filter(r => Number(r.amount_cents) !== Number(item.amount_cents))
    .sort((a, b) => Math.abs(dayDiff(item.posted_date, a.txn_date)) - Math.abs(dayDiff(item.posted_date, b.txn_date)) || a.txn_id - b.txn_id).slice(0, 40);
  let undeposited = [];
  if (item.books_type === 'bank' && item.amount_cents > 0) {
    undeposited = (waiting ?? await listUndeposited(db, { orgId, entityId }))
      .filter(u => u.total_cents <= Math.round(item.amount_cents * 1.1) && u.txn_date <= item.posted_date && dayDiff(item.posted_date, u.txn_date) <= MATCH_DAYS_BEFORE)
      .sort((a, b) => (a.total_cents === item.amount_cents ? -1 : 0) - (b.total_cents === item.amount_cents ? -1 : 0) || String(b.txn_date).localeCompare(a.txn_date));
  }
  return { exact: scored, others: rest, undeposited };
}

// Find match (QBO's search on the match screen): books transactions on the item's account by text (party, number, memo),
// date range (default 90 days before to 20 after the bank date), amount (exact, either sign) and type. Each says why it
// is listed — days from the bank date, same or different check number — and whether another bank line of the account
// already records it (shown, not selectable).
export const FIND_TYPES = ['expense', 'check', 'bill_payment', 'deposit', 'payment', 'sales_receipt', 'journal_entry', 'transfer', 'cc_payment', 'refund_receipt', 'cc_credit'];
export async function findMatches(db, { orgId, entityId, item, q = '', from = null, to = null, amountCents = null, type = '' }) {
  const iso = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) && !Number.isNaN(Date.parse(s)) ? s : null);
  const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const start = iso(from) ?? shift(item.posted_date, -90), end = iso(to) ?? shift(item.posted_date, 20);
  const { rows } = await db.query(`
    SELECT t.txn_id, t.type, t.doc_number, t.payment_ref, t.txn_date, t.memo, txn_version(t.txn_id) AS version, txn_party(t.txn_id) AS party, s.amount_cents,
           (SELECT o.item_id FROM bank_feed_link k JOIN bank_feed_item o ON o.item_id = k.item_id
             WHERE k.txn_id = t.txn_id AND o.entity_id = t.entity_id AND o.ll_account_id = $4::uuid AND o.item_id <> $5 LIMIT 1) AS elsewhere
      FROM (SELECT p.txn_id, sum(p.amount_cents)::bigint AS amount_cents FROM posting p WHERE p.org_id = $1 AND p.account_id = $2 GROUP BY p.txn_id HAVING sum(p.amount_cents) <> 0) s
      JOIN txn t ON t.txn_id = s.txn_id
     WHERE t.entity_id = $3 AND t.voided_at IS NULL AND t.txn_date BETWEEN $6::date AND $7::date
       AND ($8::bigint IS NULL OR abs(s.amount_cents) = $8)
       AND ($9 = '' OR t.type = $9)
       AND ($10 = '' OR txn_party(t.txn_id) ILIKE '%' || $10 || '%' OR t.doc_number ILIKE '%' || $10 || '%' OR t.payment_ref ILIKE '%' || $10 || '%'
            OR t.memo ILIKE '%' || $10 || '%')
     ORDER BY abs(t.txn_date - $11::date), t.txn_id LIMIT 100`,
    [orgId, item.books_account_id, entityId, item.ll_account, item.item_id, start, end, Number.isSafeInteger(amountCents) && amountCents > 0 ? amountCents : null,
      FIND_TYPES.includes(type) ? type : '', likeText(q), item.posted_date]);
  return { from: start, to: end, rows: rows.map(r => ({ ...r, days: dayDiff(r.txn_date, item.posted_date),
    sameCheck: Boolean(checkNo(item.check_number) && checkNo(r.doc_number) === checkNo(item.check_number)), checkConflict: checkConflicts(item, r),
    elsewhere: r.elsewhere ? Number(r.elsewhere) : null })) };
}

// What the screen suggests for an item: a confident match (exactly one candidate, within a few days, or the same check
// number), else nothing yet. A candidate whose check number differs from the bank's is a different check: never confident.
export function confidentMatch(candidates, item) {
  const same = c => c.sameCheck ?? Boolean(checkNo(item.check_number) && checkNo(c.doc_number) === checkNo(item.check_number));
  const conflict = c => c.checkConflict ?? checkConflicts(item, c);
  const near = candidates.exact.filter(c => !conflict(c) && (Math.abs(c.days) <= CONFIDENT_DAYS || same(c)));
  return near.length === 1 ? near[0] : null;
}

// Check numbers compared as numbers ("0101" is check 101); anything that isn't a plain number isn't a check number.
// The books number checks with 1–9 digits (lib/data/payables.js). A longer bank reference is kept in the memo, not made a check
// number (never cut short).
// The memo for what a bank line records: the person's (or the bank description), plus the bank's check reference when the
// books can't carry it as a check number and the memo doesn't already have it.
// prefix (e.g. "Adjustment: ") is part of the 1,000 characters; the reference counts as kept only if it is whole in what's kept.
const memoWithRef = (memo, item, prefix = '') => {
  const text = `${prefix}${String(memo ?? '').trim() || String(item.description ?? '')}`;
  const ref = String(item.check_number ?? '').trim();
  if (!ref || bookCheckNo(ref) || text.slice(0, 1000).includes(ref)) return text.slice(0, 1000);
  const tail = ` (bank ref ${ref.slice(0, 200)})`;
  return `${text.slice(0, 1000 - tail.length)}${tail}`;
};
const bookCheckNo = s => /^\d{1,9}$/.test(String(s ?? '').trim());
const checkNo = s => (/^\d{1,10}$/.test(String(s ?? '').trim()) ? String(Number(String(s).trim())) : null);
// The bank says check N and the books transaction is a check (or bill payment) numbered something else.
export function checkConflicts(item, c) {
  const bank = checkNo(item.check_number), books = checkNo(c.doc_number);
  return Boolean(bank && books && bank !== books && ['check', 'bill_payment'].includes(c.type));
}

// What the books may already hold for this bank item — the evidence that blocks adding it as something new. Only a person
// on the item page can say it's separate, and only for the evidence they were shown. Never limited by a screen's filters:
//   on_account — exact-amount transactions on its account from 60 days before (180 for a check) to 10 after, not tied to
//                another bank line of the account, and not a different check;
//   claimed    — the same, tied to another live bank line of the account dated within a few days, or carrying the same
//                check number: maybe two purchases, maybe one sent twice — a person decides (an ordinary charge for the
//                same amount weeks apart is a separate charge);
//   replaced   — tied to a bank line the bank later removed: this one may be its replacement;
//   open_bill / open_invoice — an open bill (money out) or invoice (money in) for exactly this amount, however old, approved
//                or not (the evidence; which of them can be paid from here is a separate question — stage S4);
//   waiting    — for money into a bank account, payments waiting in Undeposited Funds for exactly this amount or up to 5%
//                more (a deposit less a processor's fee).
// `except`: transaction ids not to count (one just created for this very line).
export async function possibleDuplicates(db, { orgId, entityId, item, except = [] }) {
  const amount = Number(item.amount_cents), before = checkNo(item.check_number) ? 180 : MATCH_DAYS_BEFORE;
  const skip = new Set(except.map(Number));
  const { rows: onAccount } = await db.query(`
    SELECT t.txn_id, t.type, t.doc_number, t.txn_date, txn_party(t.txn_id) AS party, txn_version(t.txn_id) AS version, s.amount_cents,
           (SELECT bool_or(o.bank_state = 'active') FROM bank_feed_link k JOIN bank_feed_item o ON o.item_id = k.item_id
             WHERE k.txn_id = t.txn_id AND o.entity_id = t.entity_id AND o.ll_account_id = $8::uuid AND o.item_id <> $9) AS claimed_active,
           (SELECT bool_or(o.bank_state = 'active' AND abs(o.posted_date - $5::date) <= $10) FROM bank_feed_link k JOIN bank_feed_item o ON o.item_id = k.item_id
             WHERE k.txn_id = t.txn_id AND o.entity_id = t.entity_id AND o.ll_account_id = $8::uuid AND o.item_id <> $9) AS claimed_near,
           (SELECT array_agg(o.check_number) FROM bank_feed_link k JOIN bank_feed_item o ON o.item_id = k.item_id
             WHERE k.txn_id = t.txn_id AND o.entity_id = t.entity_id AND o.ll_account_id = $8::uuid AND o.item_id <> $9 AND o.check_number IS NOT NULL) AS claim_checks,
           (SELECT min(o.item_id) FROM bank_feed_link k JOIN bank_feed_item o ON o.item_id = k.item_id
             WHERE k.txn_id = t.txn_id AND o.entity_id = t.entity_id AND o.ll_account_id = $8::uuid AND o.item_id <> $9) AS claimed_by
      FROM (SELECT p.txn_id, sum(p.amount_cents)::bigint AS amount_cents FROM posting p WHERE p.org_id = $1 AND p.account_id = $2 GROUP BY p.txn_id) s
      JOIN txn t ON t.txn_id = s.txn_id
     WHERE t.entity_id = $3 AND t.voided_at IS NULL AND s.amount_cents = $4 AND t.txn_date BETWEEN $5::date - $6::int AND $5::date + $7::int`,
    [orgId, item.books_account_id, entityId, amount, item.posted_date, before, MATCH_DAYS_AFTER, item.ll_account, item.item_id, CONFIDENT_DAYS]);
  const out = [];
  for (const r of onAccount) {
    if (checkConflicts(item, r) || skip.has(Number(r.txn_id))) continue;
    // Tied to another live bank line: evidence when they're a few days apart (the same purchase sent twice) or carry the
    // same check number (the same check, however far apart); last month's charge for the same amount is last month's.
    const bankCheck = checkNo(item.check_number);
    const sameCheck = Boolean(bankCheck && (checkNo(r.doc_number) === bankCheck || (r.claim_checks ?? []).some(c => checkNo(c) === bankCheck)));
    if (r.claimed_active && !r.claimed_near && !sameCheck) continue;
    out.push({ ...r, reason: r.claimed_active ? 'claimed' : r.claimed_by ? 'replaced' : 'on_account' });
  }
  if (amount < 0 && ['bank', 'credit_card'].includes(item.books_type)) {
    const { rows } = await db.query(`SELECT t.txn_id, t.type, t.doc_number, t.txn_date, txn_party(t.txn_id) AS party, txn_version(t.txn_id) AS version, -t.open_cents AS amount_cents FROM txn t
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'bill' AND t.voided_at IS NULL AND t.currency IS NULL AND t.open_cents = $3`,
    [orgId, entityId, -amount]);
    out.push(...rows.filter(r => !skip.has(Number(r.txn_id))).map(r => ({ ...r, reason: 'open_bill' })));
  }
  if (amount > 0 && item.books_type === 'bank') {
    const { rows } = await db.query(`SELECT t.txn_id, t.type, t.doc_number, t.txn_date, txn_party(t.txn_id) AS party, txn_version(t.txn_id) AS version, t.open_cents AS amount_cents FROM txn t
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'invoice' AND t.voided_at IS NULL AND t.currency IS NULL AND t.open_cents = $3`,
    [orgId, entityId, amount]);
    out.push(...rows.filter(r => !skip.has(Number(r.txn_id))).map(r => ({ ...r, reason: 'open_invoice' })));
    const waiting = (await listUndeposited(db, { orgId, entityId }))
      .filter(u => Number(u.total_cents) >= amount && Number(u.total_cents) * 100 <= amount * 105 && u.txn_date <= item.posted_date
        && dayDiff(item.posted_date, u.txn_date) <= MATCH_DAYS_BEFORE && !skip.has(Number(u.txn_id)));
    const versions = await txnVersions(db, waiting.map(u => u.txn_id));
    out.push(...waiting.map(u => ({ txn_id: u.txn_id, type: u.type, doc_number: u.doc_number, txn_date: u.txn_date, party: u.customer_name, amount_cents: u.total_cents,
      version: versions.get(Number(u.txn_id)), reason: 'waiting' })));
  }
  return out;
}
const REASON_TEXT = { on_account: '', claimed: ' (already matched to another bank line)', replaced: ' (on a bank line the bank removed)', open_bill: ' (open bill)',
  open_invoice: ' (open invoice)', waiting: ' (waiting to be deposited)' };
const dupeText = list => list.slice(0, 3).map(d => `${TYPE_NAMES[d.type] ?? d.type}${d.doc_number ? ` ${d.doc_number}` : ''}${d.party ? ` · ${d.party}` : ''} · ${d.txn_date}${REASON_TEXT[d.reason] ?? ''}`).join('; ');
const TYPE_NAMES = { expense: 'Expense', check: 'Check', deposit: 'Deposit', transfer: 'Transfer', cc_payment: 'Credit card payment', cc_credit: 'Credit card credit', journal_entry: 'Journal entry',
  bill_payment: 'Bill payment', payment: 'Payment', sales_receipt: 'Sales receipt', refund_receipt: 'Refund', vendor_credit: 'Vendor credit', bill: 'Bill', invoice: 'Invoice', late_fee: 'Late fee' };
export class DuplicateError extends ValidationError {
  constructor(list) {
    super(`This may already be in the books: ${dupeText(list)}${list.length > 3 ? ` and ${list.length - 3} more` : ''}. Match it instead, or tick “This is a separate transaction” if it really is a new one.`);
    this.duplicates = list;
  }
}
// A new transaction for this line is allowed when nothing could already be it, or when a person on the item page said it's
// separate having seen exactly the evidence there is now.
// A person says it's separate: on the item page, or on a For review row that showed the evidence (stage S1: the row carries
// the evidence token it showed — "Post as new"). Rules, history, batches and automatic adds never do.
const personSeparate = (separate, source, expect) => Boolean(separate && (source === 'manual' || (source === 'row' && expect?.evidence)));
function guardNew(dupes, { separate, source, expect }) {
  if (!dupes.length) return;
  if (!personSeparate(separate, source, expect)) throw new DuplicateError(dupes);
  if (expect?.evidence !== undefined && expect.evidence !== evidenceToken(dupes)) {
    throw new StaleError('Something else in the books may now be this item. Look at the list again before saying it’s separate.');
  }
}

// Cash already recorded by an integration has no "separate transaction" override.
// Follow grouped deposits back to their receipts, retaining claimed/replaced bank evidence.
async function assertNoIntegrationCashTx(tx, { orgId, entityId, item }) {
  const candidates = (await possibleDuplicates(tx, { orgId, entityId, item }))
    .filter(d => ['on_account', 'claimed', 'replaced', 'waiting'].includes(d.reason));
  const linked = async ids => ids.length ? (await tx.query(`SELECT DISTINCT t.txn_id FROM txn t
    WHERE t.org_id=$1 AND t.entity_id=$2 AND t.txn_id=ANY($3::bigint[]) AND EXISTS (
      SELECT 1 FROM external_ref r JOIN txn cash ON cash.txn_id=r.txn_id AND cash.org_id=r.org_id AND cash.entity_id=r.entity_id
      WHERE r.org_id=$1 AND r.entity_id=$2 AND cash.type IN ('payment','bill_payment') AND cash.voided_at IS NULL
        AND (r.txn_id=t.txn_id OR r.txn_id IN (SELECT source_txn_id FROM deposit_line WHERE deposit_txn_id=t.txn_id)))`,
    [orgId, entityId, ids])).rows : [];
  if ((await linked(candidates.map(d => d.txn_id))).length) fail('Match the existing integration payment instead of recording cash again.');
  // A reviewed fee-net group can post as a gross deposit plus a separate fee journal.
  // Neither transaction alone equals the replacement bank line, so retain the group's net evidence.
  const groups = (await tx.query(`SELECT array_agg(DISTINCT t.txn_id) AS ids
    FROM bank_feed_item b JOIN bank_feed_link k ON k.item_id=b.item_id AND k.org_id=b.org_id
    JOIN txn t ON t.txn_id=k.txn_id AND t.org_id=b.org_id AND t.entity_id=b.entity_id
    JOIN posting p ON p.txn_id=t.txn_id AND p.org_id=t.org_id AND p.account_id=$4
    WHERE b.org_id=$1 AND b.entity_id=$2 AND b.ll_account_id=$3::uuid AND b.item_id<>$5 AND t.voided_at IS NULL
      AND b.posted_date BETWEEN $6::date-$7::int AND $6::date+$8::int
      AND (b.bank_state<>'active' OR abs(b.posted_date-$6::date)<=$9)
    GROUP BY b.item_id HAVING sum(p.amount_cents)=$10`,
    [orgId,entityId,item.ll_account,item.books_account_id,item.item_id,item.posted_date,MATCH_DAYS_BEFORE,MATCH_DAYS_AFTER,CONFIDENT_DAYS,item.amount_cents])).rows;
  if ((await linked(groups.flatMap(g=>g.ids))).length) fail('Match the existing integration payment group instead of recording cash again.');
  if ((Number(item.amount_cents)>0 && item.books_type==='bank') || (Number(item.amount_cents)<0 && ['bank','credit_card'].includes(item.books_type))) {
    const incoming=Number(item.amount_cents)>0;
    const waiting = incoming ? (await listUndeposited(tx, { orgId, entityId }))
      .filter(u => u.txn_date <= item.posted_date && dayDiff(item.posted_date, u.txn_date) <= MATCH_DAYS_BEFORE) : [];
    const direct = (await tx.query(`SELECT t.txn_id,t.type,t.doc_number,abs(sum(p.amount_cents))::bigint AS total_cents
      FROM txn t JOIN posting p ON p.txn_id=t.txn_id AND p.org_id=t.org_id AND p.account_id=$3
      WHERE t.org_id=$1 AND t.entity_id=$2 AND t.voided_at IS NULL
        AND t.type=ANY($8::text[])
        AND t.txn_date BETWEEN $4::date-$5::int AND $4::date+$6::int
        AND (NOT EXISTS (SELECT 1 FROM bank_feed_link k JOIN bank_feed_item b ON b.item_id=k.item_id
          WHERE k.txn_id=t.txn_id AND b.entity_id=$2 AND b.ll_account_id=$7::uuid)
          OR EXISTS (SELECT 1 FROM bank_feed_link k JOIN bank_feed_item b ON b.item_id=k.item_id
            WHERE k.txn_id=t.txn_id AND b.entity_id=$2 AND b.ll_account_id=$7::uuid
              AND b.posted_date BETWEEN $4::date-$5::int AND $4::date+$6::int
              AND (b.bank_state<>'active' OR abs(b.posted_date-$4::date)<=$10)))
      GROUP BY t.txn_id HAVING sign(sum(p.amount_cents))=$9`,
      [orgId,entityId,item.books_account_id,item.posted_date,MATCH_DAYS_BEFORE,MATCH_DAYS_AFTER,item.ll_account,
        incoming?['payment','deposit','sales_receipt']:['bill_payment','check','expense'],incoming?1:-1,CONFIDENT_DAYS])).rows.filter(r=>!checkConflicts(item,r));
    const pool = [...waiting,...direct];
    // The feed does not identify receipt/payment groups or fees. Incoming cash must cover the net deposit;
    // outgoing cash may be smaller than the withdrawal because a fee increases it. Without a supported
    // fee bound, any eligible outgoing integration cash holds creation for explicit matching/review.
    // Nearby claimed cash (including removed bank items whose claims remain) stays eligible:
    // a replacement can include a different fee, so the prior group's exact total is not enough.
    // This is a conservative hold, not a claim that a particular subset has been proved to match.
    const total = pool.reduce((n, u) => n + BigInt(u.total_cents), 0n);
    if ((!incoming || total >= BigInt(Math.abs(Number(item.amount_cents)))) && (await linked(pool.map(u => u.txn_id))).length) {
      fail('Match the existing integration payment group; grouped or fee-adjusted cash requires explicit matching.');
    }
  }
}

// ---- history ----

// One review decision, kept for good: how it was chosen, the bank line's facts then (detail.item) and exactly what was
// recorded (detail.plan); a rule is kept as it was (every field, with when it was last changed).
export async function recordEvent(tx, { orgId, entityId, itemId, kind, source = 'manual', basis = null, rule = null, separate = false, payee = null, accountIds = [], txnIds = [],
  detail = null, actor }) {
  await tx.query(`INSERT INTO bank_review_event (org_id, entity_id, item_id, ll_transaction_id, kind, source, basis, rule_id, rule_name, rule_snapshot, separate, payee, account_ids,
      txn_ids, detail, actor)
    SELECT $1, $2, $3, i.ll_transaction_id, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           coalesce($14::jsonb, '{}'::jsonb) || jsonb_build_object('item', jsonb_build_object('revision', i.revision, 'amount_cents', i.amount_cents, 'posted_date', i.posted_date,
             'description', i.description, 'original_description', i.original_description, 'merchant_name', i.merchant_name, 'check_number', i.check_number))
           -- The texted receipts the review took (stage S3): which, what each said, and where its photo went.
           || coalesce((SELECT jsonb_build_object('receipts', jsonb_agg(jsonb_build_object('receipt_id', r.receipt_id, 'vendor_id', r.vendor_id, 'account_id', r.account_id,
                 'txn_id', r.txn_id, 'read', r.extracted) ORDER BY r.receipt_id))
                FROM receipt r WHERE r.item_id = i.item_id AND r.status = 'added' AND $4 IN ('added', 'matched', 'transfer', 'settled')), '{}'::jsonb), $15
      FROM bank_feed_item i WHERE i.item_id = $3`, [orgId, entityId, itemId, kind, source, basis, rule?.rule_id ?? null, rule?.name ?? null,
    rule ? JSON.stringify({ ...rule, ll_account: undefined, account_name: undefined, feed_name: undefined, feed_books_name: undefined, auto_added: undefined }) : null,
    Boolean(separate), payee || null, accountIds.map(Number).filter(Boolean), txnIds.map(Number).filter(Boolean), detail ? JSON.stringify(detail) : null, actor]);
}

// A review step: the item's review version moves on; reviewing it (anything but Undo) lifts a hold.
async function stepItem(tx, itemId, sql, params = []) {
  await tx.query(`UPDATE bank_feed_item SET ${sql}, review_version = review_version + 1, updated_at = now() WHERE item_id = $1`, [itemId, ...params]);
}
async function liftHold(tx, itemId) {
  await tx.query(`DELETE FROM bank_item_hold h USING bank_feed_item b WHERE b.item_id = $1 AND h.entity_id = b.entity_id AND h.ll_transaction_id = b.ll_transaction_id`, [itemId]);
}

async function linkTxns(tx, { orgId, item, txnIds, how, actor }) {
  for (const id of txnIds) {
    await tx.query('INSERT INTO bank_feed_link (org_id, item_id, txn_id, how, linked_by, txn_version, last_seen_version) VALUES ($1, $2, $3, $4, $5, txn_version($3), txn_version($3))',
      [orgId, item.item_id, id, how, actor]);
  }
  await stepItem(tx, item.item_id, `review_state = $2, reviewed_at = now(), reviewed_by = $3, attention = NULL, parked_attention = NULL, auto_hold = false`, [how === 'matched' ? 'matched' : 'added', actor]);
  await liftHold(tx, item.item_id);
  await claimReceipts(tx, { orgId, item, actor });
  // Files added on the bank item go onto the transaction it became (stage BR-7).
  await fileAttachments(tx, { orgId, item, actor });
  await pointReceipts(tx, { orgId, item });
}

// The texted receipts matched to this line that the page showed (item.receipt_ids, read with the line under its lock) go
// with it, whichever way it's reviewed (stage S3). A review that links in several steps (a settlement) claims them once:
// the ones it already took in this same review count as shown. Anything else changed → a person looks again.
async function claimReceipts(tx, { orgId, item, actor }) {
  const ids = String(item.receipt_ids ?? '').split(',').filter(x => /^\d{1,18}$/.test(x)).map(Number);
  if (!ids.length) return;
  const { rows } = await tx.query(`SELECT receipt_id, status FROM receipt
      WHERE org_id = $1 AND entity_id = $2 AND item_id = $3 AND status IN ('review', 'added') AND receipt_id = ANY($4::bigint[]) ORDER BY receipt_id FOR UPDATE`,
  [orgId, item.entity_id, item.item_id, ids]);
  if (rows.length !== ids.length) throw new StaleError('A receipt matched to this bank item changed since the page was shown. Look at it again.');
  for (const r of rows) if (r.status === 'review') await giveReceiptTx(tx, { orgId, item, receiptId: r.receipt_id, actor, file: false });
}

// Gives a texted receipt to a bank line (stage S3) — the one way a receipt's photo reaches the books. The caller holds the
// company lock (receipt writers take it too) and the line. The photo becomes one of the line's files, owned by the receipt
// (so Undo leaves it on the line and Reject takes it away); the receipt is marked added to the line; and if the line is
// already in the books (file), it is filed now, the receipt pointing at the transaction it was filed on.
export async function giveReceiptTx(tx, { orgId, item, receiptId, actor, file = true }) {
  const { rows: [r] } = await tx.query(`SELECT receipt_id, filename, content, size_bytes FROM receipt
      WHERE org_id = $1 AND entity_id = $2 AND receipt_id = $3 AND status IN ('received', 'waiting', 'review') FOR UPDATE`, [orgId, item.entity_id, receiptId]);
  if (!r) throw new StaleError('This receipt changed meanwhile. Look at it on the Receipts page.');
  if (r.content) {
    await tx.query(`INSERT INTO bank_item_attachment (org_id, entity_id, ll_transaction_id, filename, size_bytes, sha256, content, uploaded_by, receipt_id)
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9 WHERE NOT EXISTS (SELECT 1 FROM bank_item_attachment WHERE entity_id = $2 AND ll_transaction_id = $3 AND receipt_id = $9)`,
    [orgId, item.entity_id, item.ll_transaction_id, String(r.filename || 'receipt').slice(0, 200), r.size_bytes ?? r.content.length,
      createHash('sha256').update(r.content).digest('hex'), r.content, `Texted receipt (${actor})`, r.receipt_id]);
  }
  await tx.query(`UPDATE receipt SET status = 'added', item_id = $3, txn_id = NULL, decided_by = $4, updated_at = now() WHERE org_id = $1 AND receipt_id = $2`,
    [orgId, r.receipt_id, item.item_id, actor]);
  if (file) {
    await fileAttachments(tx, { orgId, item, actor });
    await pointReceipts(tx, { orgId, item });
  }
}

// A receipt a line took points at the transaction its photo was filed on (after each link: a settlement links several).
async function pointReceipts(tx, { orgId, item }) {
  await tx.query(`UPDATE receipt r SET txn_id = d.txn_id, updated_at = now() FROM bank_item_attachment a JOIN document d ON d.document_id = a.document_id
      WHERE a.receipt_id = r.receipt_id AND r.org_id = $1 AND r.item_id = $2 AND r.status = 'added' AND r.txn_id IS DISTINCT FROM d.txn_id AND d.txn_id IS NOT NULL`,
  [orgId, item.item_id]);
}

// ---- match ----

// Match a bank item to books transactions already on its account, and/or to payments waiting in Undeposited Funds (put into
// one new deposit dated the bank date). Together they must equal the bank amount.
// expect: { rev, versions: Map(txnId → txn_version as shown) }.
export const matchItem = (pool, a) => locked(pool, a, tx => matchItemTx(tx, a));
export async function matchItemTx(tx, { orgId, entityId, itemId, txnIds = [], undepositedIds = [], actor, source = 'manual', basis = 'person', expect = null }) {
  const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
  reviewable(item);
  checkRev(item, expect);
  const ids = [...new Set(txnIds.map(Number).filter(Number.isSafeInteger))];
  const waiting = [...new Set(undepositedIds.map(Number).filter(Number.isSafeInteger))];
  if (!ids.length && !waiting.length) fail('Choose what this bank item matches.');
  if (expect?.versions) {
    const now = await txnVersions(tx, [...ids, ...waiting]);
    for (const id of [...ids, ...waiting]) {
      if (!expect.versions.has(id) || expect.versions.get(id) !== now.get(id)) throw new StaleError('One of the chosen transactions was changed since the page was shown. Check it again below.');
    }
  }
  const cands = await matchCandidatesAny(tx, { orgId, entityId, item, ids });
  let total = 0;
  for (const id of ids) {
    const c = cands.get(id) ?? fail('One of the chosen transactions isn’t on this account, is already matched to another bank item, or is voided.');
    total += Number(c.amount_cents);
  }
  let depositId = null;
  if (waiting.length) {
    if (item.books_type !== 'bank' || item.amount_cents <= 0) fail('Only money into a bank account can be matched to payments waiting to be deposited.');
    const fits = new Set((await listUndeposited(tx, { orgId, entityId }))
      .filter(u => u.txn_date <= item.posted_date && dayDiff(item.posted_date, u.txn_date) <= MATCH_DAYS_BEFORE).map(u => Number(u.txn_id)));
    if (waiting.some(id => !fits.has(id))) fail('One of the chosen payments is no longer waiting to be deposited before this bank date. Check the list again.');
    depositId = await writeDeposit(tx, { orgId, entityId, actor, accountId: item.books_account_id, txnDate: item.posted_date, sourceTxnIds: waiting,
      memo: memoWithRef(`Bank deposit: ${item.description}`, item) });
    total += Number((await tx.query('SELECT total_cents FROM txn WHERE txn_id = $1', [depositId])).rows[0].total_cents);
  }
  if (total !== Number(item.amount_cents)) {
    fail(`The chosen transactions add up to ${formatCents(Math.abs(total))}, but the bank shows ${formatCents(Math.abs(item.amount_cents))}. They must be equal.`);
  }
  if (ids.length) await linkTxns(tx, { orgId, item, txnIds: ids, how: 'matched', actor });
  if (depositId) await linkTxns(tx, { orgId, item, txnIds: [depositId], how: 'grouped', actor });
  if (ids.length && depositId) await tx.query(`UPDATE bank_feed_item SET review_state = 'matched' WHERE item_id = $1`, [item.item_id]);
  await recordEvent(tx, { orgId, entityId, itemId: item.item_id, kind: 'matched', source, basis, txnIds: [...ids, ...(depositId ? [depositId] : [])],
    detail: { plan: { kind: 'match', txnIds: ids, grouped: waiting, depositId } }, actor });
  return { matched: ids, depositId };
}

// Any amount (several transactions can make up one bank item), same account, not voided, not used by another bank item.
async function matchCandidatesAny(tx, { orgId, entityId, item, ids }) {
  if (!ids.length) return new Map();
  const { rows } = await tx.query(`
    SELECT t.txn_id, sum(p.amount_cents)::bigint AS amount_cents FROM posting p JOIN txn t ON t.txn_id = p.txn_id
     WHERE p.org_id = $1 AND p.account_id = $2 AND t.entity_id = $3 AND t.voided_at IS NULL AND t.txn_id = ANY($4::bigint[])
       AND NOT EXISTS (SELECT 1 FROM bank_feed_link k JOIN bank_feed_item o ON o.item_id = k.item_id WHERE k.txn_id = t.txn_id AND o.entity_id = t.entity_id AND o.ll_account_id = $5::uuid)
     GROUP BY t.txn_id HAVING sum(p.amount_cents) <> 0`, [orgId, item.books_account_id, entityId, ids, item.ll_account]);
  return new Map(rows.map(r => [Number(r.txn_id), r]));
}

// ---- settle ----

const likeText = s => String(s ?? '').trim().slice(0, 100).replace(/[\\%_]/g, c => `\\${c}`);

// Open bills (money out of a bank or card account) and open invoices and late fees (money into a bank account) the bank
// line could pay, in the company's own currency: those open for exactly the bank amount first, then the nearest dates.
// `q` narrows by party or number. A bill waiting for approval is listed (it can't be paid until approved).
// Each carries `version` so the form can prove it pays what was shown.
export async function settleCandidates(db, { orgId, entityId, item, q = '' }) {
  const out = Number(item.amount_cents) < 0;
  if (out ? !['bank', 'credit_card'].includes(item.books_type) : item.books_type !== 'bank') return [];
  const { rows } = await db.query(`
    SELECT t.txn_id, t.type, t.doc_number, t.txn_date, t.due_date, t.total_cents, t.open_cents, txn_version(t.txn_id) AS version, txn_party(t.txn_id) AS party,
           t.type = 'bill' AND t.approval_status IS DISTINCT FROM 'approved' AS needs_approval
      FROM txn t
     WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = ANY($3::text[]) AND t.voided_at IS NULL AND t.open_cents > 0 AND t.currency IS NULL
       AND (t.type <> 'bill' OR t.approval_status IS DISTINCT FROM 'rejected')
       AND ($4 = '' OR txn_party(t.txn_id) ILIKE '%' || $4 || '%' OR t.doc_number ILIKE '%' || $4 || '%')
     ORDER BY (t.open_cents = $5) DESC, abs(t.txn_date - $6::date), t.txn_id LIMIT 60`,
    [orgId, entityId, out ? ['bill'] : ['invoice', 'late_fee'], likeText(q), Math.abs(Number(item.amount_cents)), item.posted_date]);
  return rows.map(r => ({ ...r, total_cents: Number(r.total_cents), open_cents: Number(r.open_cents) }));
}

// Settle a bank line, QBO's "Find match" with open documents and "Resolve difference": in one step it can
//  - match books transactions already on the account (txnIds) and group payments waiting in Undeposited Funds into a
//    deposit (undepositedIds), as Match does;
//  - pay open bills (money out: one bill payment per vendor) or open invoices (money in: one received payment per customer),
//    on the fed account, dated the bank date, each applied for the amount chosen (part payments leave the rest open);
//  - make up a difference with adjustment lines (a bank fee, a discount taken, interest) in one journal entry on the account.
// settle: [{ txnId, amountCents }]; adjustments: [{ accountId, cents, description }] with cents in the bank line's direction
// (+ adds to what the bank line moved, − takes off). Everything created belongs to the bank line — Undo deletes it and the
// documents are open again; what existed before is only matched. The parts must come to exactly the bank amount.
// expect: { rev, versions: Map(txnId → txn_version as shown) } covering every chosen transaction and document.
export const settleItem = (pool, a) => locked(pool, a, tx => settleItemTx(tx, a));
export async function settleItemTx(tx, { orgId, entityId, itemId, txnIds = [], undepositedIds = [], settle = [], adjustments = [], memo = '', actor, source = 'manual',
  expect = null }) {
  const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
  reviewable(item);
  checkRev(item, expect);
  // What the page showed the books may hold for this line (a row's Match on a suggested bill or invoice carries it): still
  // exactly that, or a person looks again (stage S4).
  if (expect?.evidence !== undefined && expect.evidence !== evidenceToken(await possibleDuplicates(tx, { orgId, entityId, item }))) {
    throw new StaleError('Something else in the books may now be this item. Look at it again.');
  }
  const out = Number(item.amount_cents) < 0, sign = out ? -1 : 1;
  const ids = [...new Set(txnIds.map(Number).filter(Number.isSafeInteger))];
  const waiting = [...new Set(undepositedIds.map(Number).filter(Number.isSafeInteger))];
  const pay = settle.filter(s => s.amountCents !== 0 || s.txnId);
  for (const s of pay) {
    if (!Number.isSafeInteger(Number(s.txnId)) || !Number.isSafeInteger(s.amountCents) || s.amountCents <= 0) fail('Enter a positive amount for each document you’re paying.');
  }
  const payIds = pay.map(s => Number(s.txnId));
  if (new Set(payIds).size !== payIds.length) fail('Each document can be paid once.');
  if (!ids.length && !waiting.length && !pay.length) fail('Choose what this bank item matches or pays.');
  const adj = adjustments.filter(a => a.accountId || a.cents);
  for (const [i, a] of adj.entries()) {
    if (!a.accountId) fail(`Adjustment ${i + 1}: choose a category.`);
    if (!Number.isSafeInteger(a.cents) || a.cents === 0) fail(`Adjustment ${i + 1}: enter an amount like 2.50 or -2.50.`);
    if (Number(a.accountId) === Number(item.books_account_id)) fail(`Adjustment ${i + 1}: the category can’t be ${item.books_name} itself.`);
  }
  if (pay.length || adj.length) {
    // A fee-only adjustment on explicitly selected existing cash records an expense, never another payment.
    // Adjustment cents follow the bank direction: positive for withdrawal fees, negative for deposit fees.
    const feeAccounts = !pay.length && (ids.length || waiting.length) && adj.length && adj.every(a => sign * a.cents < 0)
      ? (await tx.query(`SELECT account_id FROM account WHERE org_id=$1 AND entity_id=$2 AND active
          AND type IN ('expense','other_expense') AND account_id=ANY($3::bigint[])`, [orgId, entityId, adj.map(a => Number(a.accountId))])).rows : [];
    const feeOnly = !pay.length && adj.length && adj.every(a => feeAccounts.some(x => x.account_id === Number(a.accountId)));
    if (!feeOnly) await assertNoIntegrationCashTx(tx, { orgId, entityId, item });
  }
  if (expect?.versions) {
    const now = await txnVersions(tx, [...ids, ...waiting, ...payIds]);
    for (const id of [...ids, ...waiting, ...payIds]) {
      if (!expect.versions.has(id) || expect.versions.get(id) !== now.get(id)) throw new StaleError('One of the chosen transactions was changed since the page was shown. Check it again below.');
    }
  }
  // What it all comes to, before anything is written.
  const cands = await matchCandidatesAny(tx, { orgId, entityId, item, ids });
  let total = 0;
  for (const id of ids) total += Number((cands.get(id) ?? fail('One of the chosen transactions isn’t on this account, is already matched to another bank item, or is voided.')).amount_cents);
  if (waiting.length) {
    if (item.books_type !== 'bank' || !(item.amount_cents > 0)) fail('Only money into a bank account can be matched to payments waiting to be deposited.');
    const fits = new Map((await listUndeposited(tx, { orgId, entityId }))
      .filter(u => u.txn_date <= item.posted_date && dayDiff(item.posted_date, u.txn_date) <= MATCH_DAYS_BEFORE).map(u => [Number(u.txn_id), u]));
    for (const id of waiting) total += Number((fits.get(id) ?? fail('One of the chosen payments is no longer waiting to be deposited before this bank date. Check the list again.')).total_cents);
  }
  let docs = [];
  if (pay.length) {
    if (out ? !['bank', 'credit_card'].includes(item.books_type) : item.books_type !== 'bank') {
      fail(out ? 'Bills are paid from a bank or credit card account.' : 'Invoices are paid into a bank account.');
    }
    docs = (await tx.query(`SELECT txn_id, type, doc_number, vendor_id, customer_id, open_cents, currency, approval_status FROM txn
      WHERE org_id = $1 AND entity_id = $2 AND txn_id = ANY($3::bigint[]) AND voided_at IS NULL FOR UPDATE`, [orgId, entityId, payIds])).rows;
    const byId = new Map(docs.map(d => [Number(d.txn_id), d]));
    for (const s of pay) {
      const d = byId.get(Number(s.txnId));
      if (!d || !(out ? ['bill'] : ['invoice', 'late_fee']).includes(d.type) || d.currency) fail(out ? 'Only open bills in the company’s currency can be paid from here.' : 'Only open invoices in the company’s currency can be paid from here.');
      if (s.amountCents > Number(d.open_cents)) fail(`${TYPE_NAMES[d.type] ?? d.type}${d.doc_number ? ` ${d.doc_number}` : ''} only has ${formatCents(Number(d.open_cents))} open.`);
      total += sign * s.amountCents;
    }
  }
  const adjNet = adj.reduce((s, a) => s + a.cents, 0);
  total += sign * adjNet;
  if (total !== Number(item.amount_cents)) {
    fail(`Together these come to ${formatCents(Math.abs(total))}${Math.sign(total) && Math.sign(total) !== Math.sign(Number(item.amount_cents)) ? ' the other way' : ''}, but the bank shows ${formatCents(Math.abs(Number(item.amount_cents)))}. Add an adjustment for the difference of ${formatCents(Math.abs(Number(item.amount_cents) - total))}.`);
  }
  const memoText = memoWithRef(memo, item);
  const created = [];
  let depositId = null;
  if (waiting.length) {
    depositId = await writeDeposit(tx, { orgId, entityId, actor, accountId: item.books_account_id, txnDate: item.posted_date, sourceTxnIds: waiting,
      memo: memoWithRef(`Bank deposit: ${item.description}`, item) });
  }
  if (pay.length && out) {
    // A check pays one vendor; otherwise one payment per vendor, by card or bank transfer.
    const check = item.books_type === 'bank' && bookCheckNo(item.check_number);
    if (check && new Set(docs.map(d => Number(d.vendor_id))).size > 1) fail(`Check ${item.check_number} pays one vendor. Choose bills from a single vendor.`);
    for (const d of docs) if (d.approval_status !== 'approved') fail(`Bill${d.doc_number ? ` ${d.doc_number}` : ''} needs approval before it can be paid.`);
    created.push(...await payBillsTx(tx, { orgId, entityId, actor, accountId: item.books_account_id, txnDate: item.posted_date,
      method: check ? 'Check' : item.books_type === 'credit_card' ? 'Credit card' : 'Other', checkNo: check ? item.check_number : '', memo: memoText,
      payments: pay.map(s => ({ billId: Number(s.txnId), amountCents: s.amountCents, creditCents: 0 })), activitySuffix: ' · from a bank line' }));
  } else if (pay.length) {
    const byCustomer = new Map();
    for (const s of pay) {
      const c = Number(docs.find(d => Number(d.txn_id) === Number(s.txnId)).customer_id);
      if (!byCustomer.has(c)) byCustomer.set(c, []);
      byCustomer.get(c).push({ chargeTxnId: Number(s.txnId), amountCents: s.amountCents });
    }
    for (const [customerId, applications] of byCustomer) {
      created.push(await savePaymentTx(tx, { orgId, entityId, customerId, actor, txnDate: item.posted_date, depositToId: item.books_account_id,
        amountCents: applications.reduce((s, a) => s + a.amountCents, 0), paymentMethod: item.check_number ? 'Check' : null, paymentRef: item.check_number ?? null,
        memo: memoText, applications }));
    }
  }
  let journalId = null;
  if (adj.length) {
    const money = c => (Math.abs(c) / 100).toFixed(2);
    // The fed account moves by the adjustments' total (in bank sign: + is a debit on a bank or card account); each category
    // takes the other side.
    const net = sign * adjNet;
    journalId = await writeJournalEntry(tx, { orgId, entityId, actor, txnDate: item.posted_date, docNumber: '', memo: memoWithRef(memo, item, 'Adjustment: '), lines: [
      ...(net ? [{ accountId: item.books_account_id, debit: net > 0 ? money(net) : '', credit: net < 0 ? money(net) : '', description: item.description, party: '' }] : []),
      ...adj.map(a => ({ accountId: Number(a.accountId), debit: sign * a.cents < 0 ? money(a.cents) : '', credit: sign * a.cents > 0 ? money(a.cents) : '',
        description: String(a.description ?? '').trim().slice(0, 300) || item.description, party: '' })),
    ] });
    created.push(journalId);
  }
  // Everything together must move the fed account by exactly the bank amount.
  const all = [...ids, ...(depositId ? [depositId] : []), ...created];
  const { rows: [m] } = await tx.query('SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM posting WHERE txn_id = ANY($1::bigint[]) AND account_id = $2', [all, item.books_account_id]);
  if (Number(m.n) !== Number(item.amount_cents)) throw new Error(`bank settle posted ${m.n} to the account, expected ${item.amount_cents}`);
  if (created.length) await linkTxns(tx, { orgId, item, txnIds: created, how: 'added', actor });
  if (depositId) await linkTxns(tx, { orgId, item, txnIds: [depositId], how: 'grouped', actor });
  if (ids.length) await linkTxns(tx, { orgId, item, txnIds: ids, how: 'matched', actor });
  await tx.query(`UPDATE bank_feed_item SET review_state = $2 WHERE item_id = $1`, [item.item_id, ids.length ? 'matched' : 'added']);
  await recordEvent(tx, { orgId, entityId, itemId: item.item_id, kind: 'settled', source, basis: 'person', accountIds: adj.map(a => Number(a.accountId)), txnIds: all,
    detail: { plan: { kind: 'settle', matched: ids, grouped: waiting, depositId, paid: pay.map(s => ({ txnId: Number(s.txnId), cents: s.amountCents })),
      payments: created.filter(id => id !== journalId), adjustments: adj.map(a => ({ accountId: Number(a.accountId), cents: a.cents, description: a.description ?? '' })), journalId } }, actor });
  return { matched: ids, depositId, payments: created.filter(id => id !== journalId), journalId };
}

// ---- add ----

// Add a bank item to the books as a new transaction on its account, dated the bank date:
//  money out of a bank or card → an expense (a check when the bank shows a check number);
//  money into a bank account → a deposit;
//  money into a card (a card refund), with a vendor or no payee → a credit card credit;
//  a refund (a customer on money out, a vendor on money into a bank), a card refund from a customer, loan activity → a
//  journal entry, the payee on the category lines;
//  the whole amount to another bank, card or loan account → a transfer (transferItemTx).
// lines: [{ accountId, amount, description, classId }] — the category split; amounts are positive and must add up to the
// bank amount. payee: 'v:ID' (vendor) or 'c:ID' (customer).
// Refused while the books may already hold the item (possibleDuplicates) unless a person says it's a separate
// transaction (`separate`) having seen that evidence (expect.evidence); rules, history, batches and automatic adds never do.
// source/basis/rule: how it was chosen, kept in the review history (a rule also marks the item "added by rule").
export const addItem = (pool, a) => locked(pool, a, tx => addItemTx(tx, a));
export async function addItemTx(tx, { orgId, entityId, itemId, payee = '', lines = [], memo = '', dims = {}, actor, separate = false, source = 'manual',
  basis = 'person', rule = null, expect = null, matchOther = true }) {
  const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
  reviewable(item);
  checkRev(item, expect);
  await assertNoIntegrationCashTx(tx, { orgId, entityId, item });
  // A line a person held (undid it, or deleted its books transaction) is never added by anything automatic.
  if (source === 'auto' && item.auto_hold) fail('A person undid this item, so it waits for a person to review it.');
  const amount = Math.abs(Number(item.amount_cents));
  const filled = lines.filter(l => l.accountId || String(l.amount ?? '').trim());
  const split = filled.map((l, i) => {
    // A line can be negative (a discount on a purchase, a processor's fee kept from a deposit) as long as the split comes to
    // the bank amount.
    const text = String(l.amount ?? '').trim();
    const cents = text ? (text.startsWith('-') ? -parseMoney(text.slice(1).trim()) : parseMoney(text)) : (filled.length === 1 ? amount : null);
    if (cents === null || Number.isNaN(cents) || cents === 0 || (filled.length === 1 && cents < 0)) fail(`Line ${i + 1}: enter an amount like 25.00 (or -2.50 to take some off).`);
    if (!l.accountId) fail(`Line ${i + 1}: choose a category.`);
    if (Number(l.accountId) === Number(item.books_account_id)) fail(`Line ${i + 1}: the category can’t be ${item.books_name} itself — use Transfer for money between accounts.`);
    return { accountId: Number(l.accountId), cents, description: String(l.description ?? '').trim().slice(0, 300), classId: l.classId ? Number(l.classId) : null };
  });
  if (!split.length) fail('Choose a category.');
  const sum = split.reduce((s, l) => s + l.cents, 0);
  if (sum !== amount) fail(`The split adds up to ${formatCents(sum)}; the bank shows ${formatCents(amount)}.`);
  // The whole amount to another bank, card or loan account is a transfer.
  if (split.length === 1) {
    const { rows: [target] } = await tx.query('SELECT type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3', [orgId, entityId, split[0].accountId]);
    if (target && !target.system_key && TRANSFER_TO.includes(target.type)) {
      const r = await transferItemTx(tx, { orgId, entityId, itemId, otherAccountId: split[0].accountId, memo, actor, matchOther, separate, source, basis, rule, expect,
        dims: { ...dims, ...(split[0].classId && !dims.classId ? { classId: split[0].classId } : {}) } });
      return r.txnId;
    }
  }
  guardNew(await possibleDuplicates(tx, { orgId, entityId, item }), { separate, source, expect });
  const party = /^([cv]):(\d{1,18})$/.exec(String(payee ?? ''));
  const vendorId = party?.[1] === 'v' ? Number(party[2]) : null, customerId = party?.[1] === 'c' ? Number(party[2]) : null;
  // The payee is one of this company's, and still active — read under the company lock, which deactivating one also takes.
  if (party) {
    const { rows: [who] } = await tx.query(vendorId ? 'SELECT active FROM vendor WHERE org_id = $1 AND entity_id = $2 AND vendor_id = $3'
      : 'SELECT active FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3', [orgId, entityId, vendorId ?? customerId]);
    if (!who) fail('That payee isn’t one of this company’s.');
    if (!who.active) fail('That payee is inactive. Make it active again, or choose another.');
  }
  const memoText = memoWithRef(memo, item);
  const out = Number(item.amount_cents) < 0;
  const refund = (out && customerId) || (!out && vendorId);
  let txnId;
  if (out && !refund && ['bank', 'credit_card'].includes(item.books_type)) {
    const check = item.books_type === 'bank' && bookCheckNo(item.check_number);
    txnId = await writeVendorDoc(tx, { orgId, entityId, actor, type: check ? 'check' : 'expense', vendorId, txnDate: item.posted_date, accountId: item.books_account_id,
      paymentMethod: item.books_type === 'credit_card' ? 'Credit card' : null, docNumber: check ? item.check_number : '', memo: memoText,
      categoryLines: split.map(l => ({ accountId: l.accountId, amount: (l.cents / 100).toFixed(2), description: l.description, classId: l.classId })), itemLines: [] });
  } else if (!out && !customerId && item.books_type === 'credit_card') {
    // A card refund: QBO's credit card credit, the mirror of a card expense (a negative line takes some off, as there).
    txnId = await writeVendorDoc(tx, { orgId, entityId, actor, type: 'cc_credit', vendorId, txnDate: item.posted_date, accountId: item.books_account_id,
      docNumber: '', memo: memoText,
      categoryLines: split.map(l => ({ accountId: l.accountId, amount: (l.cents / 100).toFixed(2), description: l.description, classId: l.classId })), itemLines: [] });
  } else if (!out && !refund && item.books_type === 'bank' && split.filter(l => l.cents < 0).length <= 1 && !split.some(l => l.cents < 0 && l.classId)) {
    // A negative line on a deposit is money kept back from it (a processor's fee): the deposit's cash back. (Cash back carries
    // no class: a classed negative line goes through a journal entry below.)
    const back = split.find(l => l.cents < 0);
    txnId = await writeDeposit(tx, { orgId, entityId, actor, accountId: item.books_account_id, txnDate: item.posted_date, memo: memoText, sourceTxnIds: [],
      otherLines: split.filter(l => l.cents > 0).map(l => ({ accountId: l.accountId, customerId, description: l.description || item.description, amount: (l.cents / 100).toFixed(2), classId: l.classId })),
      ...(back ? { cashBack: { accountId: back.accountId, amount: (-back.cents / 100).toFixed(2), memo: back.description } } : {}) });
  } else {
    // The fed account moves by the bank amount; the categories take the other side, with the payee (a negative line the
    // same side as the account).
    const money = c => (Math.abs(c) / 100).toFixed(2);
    const p = vendorId ? `v:${vendorId}` : customerId ? `c:${customerId}` : '';
    txnId = await writeJournalEntry(tx, { orgId, entityId, actor, txnDate: item.posted_date, docNumber: '', memo: memoText, lines: [
      { accountId: item.books_account_id, debit: out ? '' : money(amount), credit: out ? money(amount) : '', description: item.description, party: '' },
      ...split.map(l => ({ accountId: l.accountId, debit: out === l.cents > 0 ? money(l.cents) : '', credit: out === l.cents > 0 ? '' : money(l.cents), description: l.description, party: p, classId: l.classId })),
    ] });
  }
  // Class and location (from a rule, or the form) go on the transaction, then its postings are written again so reports
  // by class and location see them.
  const d = { ...(dims.classId ? { classId: Number(dims.classId) } : {}), ...(dims.locationId ? { locationId: Number(dims.locationId) } : {}) };
  if (d.classId || d.locationId) {
    await applyTxnDimensions(tx, { orgId, entityId, txnId, dims: d });
    await repost(tx, orgId, txnId);
  }
  // Whatever was created must move the fed account by exactly the bank amount.
  const { rows: [m] } = await tx.query('SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM posting WHERE txn_id = $1 AND account_id = $2', [txnId, item.books_account_id]);
  if (Number(m.n) !== Number(item.amount_cents)) throw new Error(`bank add posted ${m.n} to the account, expected ${item.amount_cents}`);
  await linkTxns(tx, { orgId, item, txnIds: [txnId], how: 'added', actor });
  if (rule) await tx.query('UPDATE bank_feed_item SET rule_id = $2 WHERE item_id = $1', [item.item_id, rule.rule_id]);
  await recordEvent(tx, { orgId, entityId, itemId: item.item_id, kind: 'added', source, basis: rule ? 'rule' : basis, rule, separate: personSeparate(separate, source, expect),
    payee: party ? `${party[1]}:${party[2]}` : null, accountIds: split.map(l => l.accountId), txnIds: [txnId],
    detail: { plan: { kind: refund ? 'refund' : 'add', payee: party ? `${party[1]}:${party[2]}` : null, memo: memoText, lines: split, dims: d } }, actor });
  return txnId;
}

// ---- backdated bill (stage BR-7) ----

// QBO's "Create a bill" on a bank line: the bill, dated when the vendor billed it, and its payment from the fed account on
// the bank date — both belong to the bank line (Undo deletes the payment, then the bill). Money out of a bank or card account
// only. lines: [{ accountId, amount, description }] as on Add (negative lines allowed; they must come to the bank amount).
// Refused while the books may already hold the item, as Add is. A bill needing approval is approved by the person if they
// can approve bills (canApprove), else refused.
export const backdatedBill = (pool, a) => locked(pool, a, tx => backdatedBillTx(tx, a));
export async function backdatedBillTx(tx, { orgId, entityId, itemId, vendorId, billDate, docNumber = '', lines = [], memo = '', actor, canApprove = false, separate = false,
  expect = null }) {
  const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
  reviewable(item);
  checkRev(item, expect);
  await assertNoIntegrationCashTx(tx, { orgId, entityId, item });
  const amount = -Number(item.amount_cents);
  if (amount <= 0 || !['bank', 'credit_card'].includes(item.books_type)) fail('A bill is paid with money out of a bank or card account.');
  if (!Number.isSafeInteger(Number(vendorId)) || !Number(vendorId)) fail('Choose the vendor who sent the bill.');
  const { rows: [vend] } = await tx.query('SELECT active FROM vendor WHERE org_id = $1 AND entity_id = $2 AND vendor_id = $3', [orgId, entityId, Number(vendorId)]);
  if (!vend?.active) fail('That vendor is inactive or isn’t one of this company’s. Choose another.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(billDate ?? '')) || Number.isNaN(Date.parse(billDate))) fail('Enter the bill date.');
  if (billDate > String(item.posted_date)) fail('The bill date can’t be after the bank date it was paid.');
  const filled = lines.filter(l => l.accountId || String(l.amount ?? '').trim());
  if (!filled.length) fail('Choose a category.');
  const split = filled.map((l, i) => {
    const text = String(l.amount ?? '').trim();
    const cents = text ? (text.startsWith('-') ? -parseMoney(text.slice(1).trim()) : parseMoney(text)) : (filled.length === 1 ? amount : null);
    if (cents === null || Number.isNaN(cents) || cents === 0 || (filled.length === 1 && cents < 0)) fail(`Line ${i + 1}: enter an amount like 25.00.`);
    if (!l.accountId) fail(`Line ${i + 1}: choose a category.`);
    return { accountId: Number(l.accountId), cents, description: String(l.description ?? '').trim().slice(0, 300) };
  });
  const sum = split.reduce((t, l) => t + l.cents, 0);
  if (sum !== amount) fail(`The bill’s lines add up to ${formatCents(sum)}; the bank shows ${formatCents(amount)}.`);
  guardNew(await possibleDuplicates(tx, { orgId, entityId, item }), { separate, source: 'manual', expect });
  const memoText = memoWithRef(memo, item);
  const billId = await writeBill(tx, { orgId, entityId, actor, type: 'bill', vendorId: Number(vendorId), txnDate: billDate, dueDate: billDate,
    docNumber: String(docNumber ?? '').trim().slice(0, 30), memo: memoText, itemLines: [],
    categoryLines: split.map(l => ({ accountId: l.accountId, amount: (l.cents / 100).toFixed(2), description: l.description })) });
  const { rows: [b] } = await tx.query('SELECT approval_status FROM txn WHERE txn_id = $1', [billId]);
  if (b.approval_status !== 'approved') {
    if (!canApprove) fail('This company approves bills before they’re paid, and you can’t approve bills. Add the bill for approval, then match its payment here.');
    await tx.query(`UPDATE txn SET approval_status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE txn_id = $1`, [billId, actor]);
  }
  const check = item.books_type === 'bank' && bookCheckNo(item.check_number);
  const [paymentId] = await payBillsTx(tx, { orgId, entityId, actor, accountId: item.books_account_id, txnDate: item.posted_date,
    method: check ? 'Check' : item.books_type === 'credit_card' ? 'Credit card' : 'Other', checkNo: check ? item.check_number : '', memo: memoText,
    payments: [{ billId, amountCents: amount, creditCents: 0 }], activitySuffix: ' · from a bank line' });
  const { rows: [m] } = await tx.query('SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM posting WHERE txn_id = ANY($1::bigint[]) AND account_id = $2',
    [[billId, paymentId], item.books_account_id]);
  if (Number(m.n) !== Number(item.amount_cents)) throw new Error(`backdated bill posted ${m.n} to the account, expected ${item.amount_cents}`);
  await linkTxns(tx, { orgId, item, txnIds: [billId, paymentId], how: 'added', actor });
  await recordEvent(tx, { orgId, entityId, itemId: item.item_id, kind: 'added', source: 'manual', basis: 'person', separate: separate && Boolean(expect?.evidence),
    payee: `v:${Number(vendorId)}`, accountIds: split.map(l => l.accountId), txnIds: [billId, paymentId],
    detail: { plan: { kind: 'backdated_bill', billDate, billId, paymentId, lines: split, memo: memoText } }, actor });
  return { billId, paymentId };
}

// ---- transfer ----

// Money between two of the company's accounts.
// If the books already hold this movement — a pure movement of exactly this amount between the two accounts (+X on one,
// −X on the other, nothing else), not yet tied to another bank line of this account — the bank item is matched to it
// instead of recording it again; several such → a person chooses on the Match list. Anything else that could already be
// the item blocks a new transfer the same way Add is blocked.
// If the other account is fed too and exactly one waiting bank line there is the opposite of this one (within a few days)
// and nothing else in the books could be that line, it is recorded by the same transfer; otherwise it's left for a person.
// `matchOther` false (a practice copy): the other account's bank line is always left for a person to match.
export const transferItem = (pool, a) => locked(pool, a, tx => transferItemTx(tx, a));
export async function transferItemTx(tx, { orgId, entityId, itemId, otherAccountId, memo = '', actor, matchOther = true, separate = false, source = 'manual', basis = 'person',
  rule = null, expect = null, dims = {} }) {
  const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
  reviewable(item);
  checkRev(item, expect);
  const { rows: [other] } = await tx.query(`SELECT account_id, name, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active`,
    [orgId, entityId, Number(otherAccountId) || 0]);
  if (!other || other.system_key || !TRANSFER_OTHER.includes(other.type)) fail('Choose the other bank, card, loan or asset account.');
  if (Number(other.account_id) === Number(item.books_account_id)) fail('Choose a different account.');
  const dupes = await possibleDuplicates(tx, { orgId, entityId, item });
  // What the page showed must still be what's in the books — before reusing a transfer as much as before recording one.
  if (dupes.length && expect?.evidence !== undefined && expect.evidence !== evidenceToken(dupes)) {
    throw new StaleError('The books changed since the page was shown (a possible match was added or edited). Check it again below.');
  }
  const separateOk = personSeparate(separate, source, expect);
  const ids = separateOk ? [] : dupes.filter(d => d.reason === 'on_account').map(d => Number(d.txn_id));
  const { rows: same } = ids.length ? await tx.query(`SELECT txn_id FROM posting WHERE org_id = $1 AND txn_id = ANY($4::bigint[]) GROUP BY txn_id
    HAVING count(DISTINCT account_id) = 2 AND coalesce(sum(amount_cents) FILTER (WHERE account_id = $2), 0) = $5
       AND coalesce(sum(amount_cents) FILTER (WHERE account_id = $3), 0) = -$5::bigint`,
    [orgId, item.books_account_id, other.account_id, ids, Number(item.amount_cents)]) : { rows: [] };
  if (same.length === 1 && dupes.length === 1) {
    const txnId = Number(same[0].txn_id);
    await linkTxns(tx, { orgId, item, txnIds: [txnId], how: 'matched', actor });
    await recordEvent(tx, { orgId, entityId, itemId: item.item_id, kind: 'matched', source, basis: 'match', accountIds: [other.account_id], txnIds: [txnId],
      detail: { plan: { kind: 'transfer', otherAccountId: Number(other.account_id), existing: txnId } }, actor });
    return { txnId, pairedItemId: null, matchedExisting: true };
  }
  if (same.length >= 1) fail(`The books may already have this transfer between ${item.books_name} and ${other.name}${dupes.length > 1 ? ', along with other possibilities' : ''}. Match the right one instead, or tick “This is a separate transaction”.`);
  await assertNoIntegrationCashTx(tx, { orgId, entityId, item });
  guardNew(dupes, { separate, source, expect });
  const out = Number(item.amount_cents) < 0;
  const amount = Math.abs(Number(item.amount_cents));
  const from = out ? Number(item.books_account_id) : Number(other.account_id), to = out ? Number(other.account_id) : Number(item.books_account_id);
  const types = new Map([[Number(item.books_account_id), item.books_type], [Number(other.account_id), other.type]]);
  const memoText = memoWithRef(memo, item);
  const d = { ...(dims.classId ? { classId: Number(dims.classId) } : {}), ...(dims.locationId ? { locationId: Number(dims.locationId) } : {}) };
  let txnId;
  if (types.get(from) === 'bank' && types.get(to) === 'credit_card') {
    txnId = await writeTransfer(tx, { orgId, entityId, type: 'cc_payment', fromId: from, toId: to, amountText: (amount / 100).toFixed(2), txnDate: item.posted_date, memo: memoText, dims: d });
  } else if (TRANSFER_TYPES.includes(types.get(from)) && TRANSFER_TYPES.includes(types.get(to))) {
    txnId = await writeTransfer(tx, { orgId, entityId, type: 'transfer', fromId: from, toId: to, amountText: (amount / 100).toFixed(2), txnDate: item.posted_date, memo: memoText, dims: d });
  } else {
    // Loans and other liabilities: a journal entry moving the money from one to the other.
    const money = (amount / 100).toFixed(2);
    txnId = await writeJournalEntry(tx, { orgId, entityId, actor, txnDate: item.posted_date, docNumber: '', memo: memoText, lines: [
      { accountId: to, debit: money, credit: '', description: item.description, party: '', classId: d.classId ?? null },
      { accountId: from, debit: '', credit: money, description: item.description, party: '', classId: d.classId ?? null }] });
  }
  // Class and location on the transaction and every posting.
  if (d.classId || d.locationId) {
    await applyTxnDimensions(tx, { orgId, entityId, txnId, dims: d });
    await repost(tx, orgId, txnId);
  }
  await linkTxns(tx, { orgId, item, txnIds: [txnId], how: 'added', actor });
  if (rule) await tx.query('UPDATE bank_feed_item SET rule_id = $2 WHERE item_id = $1', [item.item_id, rule.rule_id]);
  // The other side, if it's fed and waiting — only when exactly one line there fits and nothing else in the books could be it.
  const { rows: pairs } = !matchOther ? { rows: [] } : await tx.query(`
    SELECT i.item_id FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id
     WHERE i.org_id = $1 AND i.entity_id = $2 AND l.books_account_id = $3 AND l.include AND i.review_state = 'new' AND i.bank_state = 'active' AND NOT i.pending
       AND NOT i.auto_hold AND i.amount_cents = $4 AND abs(i.posted_date - $5::date) <= $6
     ORDER BY i.item_id FOR UPDATE OF i`,
    [orgId, entityId, other.account_id, -Number(item.amount_cents), item.posted_date, CONFIDENT_DAYS]);
  let pair = null, pairNote = null;
  if (pairs.length === 1) {
    const counterpart = await getBankItem(tx, { orgId, entityId, itemId: pairs[0].item_id, lock: true });
    const theirs = await possibleDuplicates(tx, { orgId, entityId, item: counterpart, except: [txnId] });
    if (theirs.length) pairNote = 'the other account’s bank line may already be something else in the books; left for review';
    else pair = pairs[0];
  } else if (pairs.length > 1) pairNote = 'several bank lines on the other account fit; left for review';
  if (pair) {
    await linkTxns(tx, { orgId, item: { item_id: pair.item_id }, txnIds: [txnId], how: 'matched', actor });
    await recordEvent(tx, { orgId, entityId, itemId: pair.item_id, kind: 'matched', source, basis: 'match', accountIds: [item.books_account_id], txnIds: [txnId],
      detail: { plan: { kind: 'transfer other side', fromItem: Number(item.item_id), txnId } }, actor });
  }
  await recordEvent(tx, { orgId, entityId, itemId: item.item_id, kind: 'transfer', source, basis: rule ? 'rule' : basis, rule, separate: personSeparate(separate, source, expect),
    accountIds: [other.account_id], txnIds: [txnId],
    detail: { plan: { kind: 'transfer', otherAccountId: Number(other.account_id), memo: memoText, dims: d, txnId }, pairedItem: pair ? Number(pair.item_id) : null, pairing: pairNote }, actor });
  return { txnId, pairedItemId: pair?.item_id ?? null, ambiguousPair: Boolean(pairNote), pairNote };
}

// ---- exclude ----

// Exclude waiting items. expect.revs: Map(itemId → itemToken as shown); a changed item is skipped, not excluded.
// Returns { excluded: [itemId], skipped: [{ itemId, reason }] }.
export async function excludeItemsTx(tx, { orgId, entityId, itemIds, actor, source = 'manual', expect = null }) {
  const ids = [...new Set(itemIds.map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) fail('Choose the bank items to exclude.');
  const excluded = [], skipped = [];
  for (const id of ids) {
    const item = await getBankItem(tx, { orgId, entityId, itemId: id, lock: true });
    if (!item) { skipped.push({ itemId: id, reason: 'not found' }); continue; }
    if (item.review_state !== 'new') { skipped.push({ itemId: id, reason: 'already reviewed' }); continue; }
    if (expect?.revs?.has(id) && expect.revs.get(id) !== itemToken(item)) { skipped.push({ itemId: id, reason: 'changed since the page was shown — review it' }); continue; }
    await stepItem(tx, id, `review_state = 'excluded', reviewed_at = now(), reviewed_by = $2, auto_hold = false`, [actor]);
    await liftHold(tx, id);
    await recordEvent(tx, { orgId, entityId, itemId: id, kind: 'excluded', source, basis: 'person', actor });
    excluded.push(id);
  }
  return { excluded, skipped };
}
export async function excludeItems(pool, a) {
  return (await locked(pool, a, tx => excludeItemsTx(tx, a))).excluded.length;
}

// ---- undo ----

// What Undo would do to a reviewed item, worked out without changing anything — the confirmation shows it, the form carries
// its token, and undoItem does exactly it:
//   { kind: 'restore'|'unmatch'|'delete'|'handover', deletes: [txn], keeps: [txn], handsTo: [{ txn, itemId }], token }.
// A transaction this item created that also records another bank line (a paired transfer) is not deleted: that other line
// keeps it, as the one that added it. Created documents are deleted payments-first (anything that pays or groups others
// before what it pays).
const DELETE_ORDER = ['bill_payment', 'payment', 'deposit', 'journal_entry', 'transfer', 'cc_payment', 'expense', 'check', 'cc_credit', 'bill'];
export async function undoPlan(db, { orgId, entityId, itemId }) {
  const item = await getBankItem(db, { orgId, entityId, itemId });
  if (!item) fail('Bank item not found.');
  const plan = item.review_state === 'excluded' ? { kind: 'restore', deletes: [], keeps: [], handsTo: [] }
    : item.review_state === 'new' ? { kind: 'none', deletes: [], keeps: [], handsTo: [] } : null;
  if (plan) return { ...plan, token: hash(`${itemToken(item)}|${plan.kind}`) };
  const { rows: links } = await db.query(`SELECT k.txn_id, k.how, t.type, t.doc_number, t.txn_date, txn_version(t.txn_id) AS version,
      (SELECT min(o.item_id) FROM bank_feed_link o WHERE o.txn_id = k.txn_id AND o.item_id <> k.item_id) AS other_item
      FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1 ORDER BY t.txn_id`, [item.item_id]);
  const deletes = links.filter(l => l.how !== 'matched' && !l.other_item)
    .sort((a, b) => (DELETE_ORDER.indexOf(a.type) + 1 || 99) - (DELETE_ORDER.indexOf(b.type) + 1 || 99) || Number(b.txn_id) - Number(a.txn_id));
  const handsTo = links.filter(l => l.how !== 'matched' && l.other_item).map(l => ({ txn: l, itemId: Number(l.other_item) }));
  const keeps = links.filter(l => l.how === 'matched');
  const kind = deletes.length ? 'delete' : handsTo.length ? 'handover' : 'unmatch';
  const token = hash([itemToken(item), kind, ...deletes.map(t => `d${t.txn_id}@${t.version}`), ...keeps.map(t => `k${t.txn_id}@${t.version}`),
    ...handsTo.map(h => `h${h.txn.txn_id}>${h.itemId}`)].join('|'));
  return { kind, deletes, keeps, handsTo, token };
}
export function undoConfirmText(plan) {
  const name = t => `${TYPE_NAMES[t.type] ?? t.type}${t.doc_number ? ` ${t.doc_number}` : ''}`;
  if (plan.kind === 'restore' || plan.kind === 'none') return null;
  const parts = [];
  if (plan.deletes.length) {
    parts.push(`${plan.deletes.map(name).join(', ')} ${plan.deletes.length === 1 ? 'is' : 'are'} deleted${plan.deletes.some(t => ['bill_payment', 'payment'].includes(t.type))
      ? ' (what it paid is open again)' : ''}`);
  }
  if (plan.handsTo.length) parts.push(`${plan.handsTo.map(h => name(h.txn)).join(', ')} stays — the other account’s bank line still records it`);
  if (plan.keeps.length) parts.push(`the match to ${plan.keeps.map(name).join(', ')} is removed (${plan.keeps.length === 1 ? 'it stays' : 'they stay'} in the books)`);
  return `Undo? ${parts.join('; ')}. The bank item goes back to For review.`;
}

// Undo a review, exactly as planned (expect.plan: the plan token the page showed). Excluded → back to review. Matched →
// unlinked (the books transaction stays). Added or grouped → what it created is deleted (refused if reconciled) — as QBO
// does. A person's Undo holds the bank line from automatic rules (they still suggest) until it is reviewed again, even if
// the item row is later dropped and pulled back in.
export const undoItem = (pool, a) => locked(pool, a, tx => undoItemTx(tx, a));
export async function undoItemTx(tx, { orgId, entityId, itemId, actor, source = 'manual', expect = null }) {
  const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
  if (!item) fail('Bank item not found.');
  const plan = await undoPlan(tx, { orgId, entityId, itemId: item.item_id });
  if (expect?.plan !== undefined && expect.plan !== plan.token) throw new StaleError('This item changed since the page was shown, so Undo would do something different now. Check it again below.');
  if (item.review_state === 'excluded') {
    // Back to For review by a person's Undo: held from automatic rules until a person reviews it again.
    await stepItem(tx, item.item_id, `review_state = 'new', reviewed_at = NULL, reviewed_by = NULL, attention = NULL, parked_attention = NULL, auto_hold = true`);
    await tx.query(`INSERT INTO bank_item_hold (org_id, entity_id, ll_transaction_id, reason, actor) VALUES ($1, $2, $3, 'undone', $4)
      ON CONFLICT (entity_id, ll_transaction_id) DO UPDATE SET reason = EXCLUDED.reason, warn = false, actor = EXCLUDED.actor, at = now()`, [orgId, entityId, item.ll_transaction_id, actor]);
    await recordEvent(tx, { orgId, entityId, itemId: item.item_id, kind: 'restored', source, basis: 'person', actor });
    return 'restored';
  }
  if (item.review_state === 'new') fail('This item hasn’t been reviewed.');
  for (const h of plan.handsTo) {
    await tx.query(`UPDATE bank_feed_link SET how = 'added' WHERE txn_id = $1 AND item_id = $2`, [h.txn.txn_id, h.itemId]);
    await stepItem(tx, h.itemId, `review_state = CASE WHEN review_state = 'matched' THEN 'added' ELSE review_state END`);
  }
  for (const l of plan.deletes) await assertNotReconciled(tx, { orgId, txnId: l.txn_id });
  // The bank review's own Undo: unlinking and deleting here is not a "changed in the books" event.
  await tx.query(`SELECT set_config('fb.bank_undo', 'on', true)`);
  await unfileAttachments(tx, { item, txnIds: [...plan.keeps, ...plan.handsTo.map(x => x.txn)].map(t => t.txn_id) });
  await tx.query('DELETE FROM bank_feed_link WHERE item_id = $1', [item.item_id]);
  for (const l of plan.deletes) {
    if (l.type === 'deposit') await deleteDepositTx(tx, { orgId, entityId, txnId: l.txn_id, actor });
    else if (['expense', 'check', 'cc_credit', 'bill', 'bill_payment'].includes(l.type)) await deleteVendorTxnTx(tx, { orgId, entityId, txnId: l.txn_id, actor });
    else if (['journal_entry', 'transfer', 'cc_payment'].includes(l.type)) await deleteLedgerTxnTx(tx, { orgId, entityId, txnId: l.txn_id });
    else if (l.type === 'payment') await deleteTxnTx(tx, { orgId, entityId, txnId: l.txn_id, actor });
    else fail(`A ${TYPE_NAMES[l.type] ?? l.type} added from a bank item can’t be undone here yet. Delete it from its own page.`);
  }
  await tx.query(`SELECT set_config('fb.bank_undo', '', true)`);
  await stepItem(tx, item.item_id, `review_state = 'new', reviewed_at = NULL, reviewed_by = NULL, attention = NULL, parked_attention = NULL, rule_id = NULL, auto_hold = true`);
  // Receipts the review took (stage S3) wait on its review again.
  await tx.query(`UPDATE receipt SET status = 'review', txn_id = NULL, updated_at = now() WHERE org_id = $1 AND entity_id = $2 AND item_id = $3 AND status = 'added'`,
    [orgId, entityId, item.item_id]);
  await tx.query(`INSERT INTO bank_item_hold (org_id, entity_id, ll_transaction_id, reason, actor) VALUES ($1, $2, $3, 'undone', $4)
    ON CONFLICT (entity_id, ll_transaction_id) DO UPDATE SET reason = EXCLUDED.reason, actor = EXCLUDED.actor, at = now()`, [orgId, entityId, item.ll_transaction_id, actor]);
  await recordEvent(tx, { orgId, entityId, itemId: item.item_id, kind: 'undone', source, basis: 'person',
    txnIds: [...plan.deletes, ...plan.handsTo.map(h => h.txn), ...plan.keeps].map(t => t.txn_id),
    detail: { plan: { kind: plan.kind, deleted: plan.deletes.map(t => Number(t.txn_id)), kept: plan.keeps.map(t => Number(t.txn_id)),
      handedTo: plan.handsTo.map(h => ({ txnId: Number(h.txn.txn_id), itemId: h.itemId })) } }, actor });
  return plan.deletes.length ? 'deleted' : plan.handsTo.length ? 'handed' : 'unmatched';
}

// A person has looked at a line the bank changed or removed, or whose books transaction was edited or deleted, after it
// was reviewed: the flag is cleared (the books are not touched — Undo is the way to change them).
export const markChecked = (pool, a) => locked(pool, a, tx => markCheckedTx(tx, a));
export async function markCheckedTx(tx, { orgId, entityId, itemId, actor, expect = null }) {
  const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
  if (!item) fail('Bank item not found.');
  checkRev(item, expect);
  if (!item.attention) fail('Nothing to check on this item.');
  await stepItem(tx, item.item_id, 'attention = NULL, parked_attention = NULL');
  // The books as they are now are what the person checked.
  await tx.query('UPDATE bank_feed_link SET txn_version = txn_version(txn_id), last_seen_version = txn_version(txn_id) WHERE item_id = $1', [item.item_id]);
  await tx.query('UPDATE bank_item_hold SET warn = false WHERE entity_id = $1 AND ll_transaction_id = $2', [entityId, item.ll_transaction_id]);
  await recordEvent(tx, { orgId, entityId, itemId: item.item_id, kind: 'checked', source: 'manual', basis: 'person', detail: { was: item.attention }, actor });
}

// Accept every confident match on an account in one go (the "batch accept" of QBO's For review tab; used by tests and
// tools — the screen uses acceptSuggestions with the plans it showed).
export async function acceptConfident(pool, { orgId, entityId, llAccountId, itemIds = null, actor }) {
  const items = await listBankItems(pool, { orgId, entityId, llAccountId, tab: 'review', limit: 1000 });
  let matched = 0;
  for (const row of items.filter(i => !i.pending && (!itemIds || itemIds.map(Number).includes(Number(i.item_id))))) {
    try {
      const ok = await locked(pool, { orgId, entityId }, async tx => {
        const item = await getBankItem(tx, { orgId, entityId, itemId: row.item_id, lock: true });
        if (!item || item.review_state !== 'new') return false;
        const m = confidentMatch(await matchCandidates(tx, { orgId, entityId, item }), item);
        if (!m) return false;
        await matchItemTx(tx, { orgId, entityId, itemId: item.item_id, txnIds: [m.txn_id], actor, source: 'batch', basis: 'match' });
        return true;
      });
      if (ok) matched++;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
  }
  return matched;
}

// Ledgerline's verified months for a books account (stage B6), newest first, each checked against the books:
//   closing    — the certified statement's closing balance (account orientation: in the account, or owed);
//   cleared    — the books' opening balance plus every transaction the bank feed cleared by the month end;
//   waiting    — bank items through the month end still waiting for review (and excluded ones, shown apart);
//   difference — what's left: closing − cleared − waiting − excluded. Not $0.00 means the books disagree with a month
//                ledgerline proved against the bank statement.
export async function verifiedMonths(db, { orgId, entityId, accountId }) {
  const { rows } = await db.query(`
    SELECT v.period_start, v.period_end, v.opening_cents, v.closing_cents, v.certified_at, a.type,
           coalesce((SELECT sum(p.amount_cents) FROM posting p JOIN txn t ON t.txn_id = p.txn_id
                      WHERE p.account_id = l.books_account_id AND (
                        (t.system_kind = 'opening_balance' AND t.txn_date <= v.period_end)
                        OR EXISTS (SELECT 1 FROM bank_feed_link k JOIN bank_feed_item b ON b.item_id = k.item_id
                                    WHERE k.txn_id = p.txn_id AND b.entity_id = l.entity_id AND b.ll_account_id = l.ll_account_id
                                      AND b.bank_state = 'active' AND b.posted_date <= v.period_end))), 0)::bigint AS cleared_signed,
           coalesce((SELECT sum(b.amount_cents) FROM bank_feed_item b WHERE b.entity_id = l.entity_id AND b.ll_account_id = l.ll_account_id
                      AND b.bank_state = 'active' AND NOT b.pending AND b.posted_date <= v.period_end AND b.review_state = 'new'), 0)::bigint AS waiting_signed,
           (SELECT count(*)::int FROM bank_feed_item b WHERE b.entity_id = l.entity_id AND b.ll_account_id = l.ll_account_id
              AND b.bank_state = 'active' AND NOT b.pending AND b.posted_date <= v.period_end AND b.review_state = 'new') AS waiting_count,
           coalesce((SELECT sum(b.amount_cents) FROM bank_feed_item b WHERE b.entity_id = l.entity_id AND b.ll_account_id = l.ll_account_id
                      AND b.bank_state = 'active' AND NOT b.pending AND b.posted_date <= v.period_end AND b.review_state = 'excluded'), 0)::bigint AS excluded_signed
      FROM ledgerline_verified_month v JOIN ledgerline_account l ON l.entity_id = v.entity_id AND l.ll_account_id = v.ll_account_id
      JOIN account a ON a.account_id = l.books_account_id
     WHERE v.org_id = $1 AND v.entity_id = $2 AND l.books_account_id = $3 AND l.include
     ORDER BY v.period_end DESC`, [orgId, entityId, Number(accountId) || 0]);
  return rows.map(r => {
    const sign = normalSign(r.type);
    const cleared = Number(r.cleared_signed) * sign, waiting = Number(r.waiting_signed) * sign, excluded = Number(r.excluded_signed) * sign;
    const closing = r.closing_cents === null ? null : Number(r.closing_cents);
    return { periodStart: r.period_start, periodEnd: r.period_end, opening: r.opening_cents === null ? null : Number(r.opening_cents), closing,
      cleared, waiting, waitingCount: r.waiting_count, excluded, difference: closing === null ? null : closing - cleared - waiting - excluded };
  });
}
