import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from './writes.js';
import { writeVendorDoc, deleteVendorTxnTx } from './payables.js';
import { writeDeposit, deleteDepositTx, listUndeposited } from './deposits.js';
import { writeJournalEntry, writeTransfer, deleteLedgerTxnTx, TRANSFER_TYPES } from './ledger-tools.js';
import { assertNotReconciled } from './locks.js';
import { applyTxnDimensions } from './accounting.js';
import { normalSign } from '../domain/ledger.js';
import { formatCents, parseMoney } from '../domain/money.js';

// Bank transactions (stage B3, QBO's Banking page): each bank item from ledgerline is reviewed once —
// matched to what's already in the books, added as a new transaction, recorded as a transfer, or excluded — and can be
// undone. Amounts on bank items use the bank sign (money in positive); a books transaction's effect on the account is the
// sum of its postings there, which has the same sign for bank and card accounts (a card charge credits the card).

const fail = message => { throw new ValidationError(message); };
const MATCH_DAYS_BEFORE = 60; // a check written two months before it cleared still matches
const MATCH_DAYS_AFTER = 10;
const CONFIDENT_DAYS = 5;
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

// The company's fed accounts, as cards across the top: bank balance (ledgerline) vs. books balance, items to review.
export async function bankAccounts(db, { orgId, entityId }) {
  const { rows } = await db.query(`
    SELECT l.ll_account_id::text AS id, l.display_name, l.institution_name, l.mask, l.kind, l.bank_balance_cents, l.balance_as_of, l.balance_stale,
           l.connection_state, l.books_account_id, a.name AS books_name, a.type AS books_type,
           coalesce((SELECT sum(p.amount_cents) FROM posting p WHERE p.account_id = a.account_id), 0)::bigint AS books_signed,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.entity_id = l.entity_id AND i.ll_account_id = l.ll_account_id AND i.bank_state = 'active' AND i.review_state = 'new' AND NOT i.pending) AS to_review,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.entity_id = l.entity_id AND i.ll_account_id = l.ll_account_id AND i.attention IS NOT NULL) AS attention,
           (SELECT max(v.period_end) FROM ledgerline_verified_month v WHERE v.entity_id = l.entity_id AND v.ll_account_id = l.ll_account_id) AS verified_through
      FROM ledgerline_account l JOIN account a ON a.account_id = l.books_account_id
     WHERE l.org_id = $1 AND l.entity_id = $2 AND l.include
     ORDER BY CASE WHEN a.type = 'bank' THEN 0 WHEN a.type = 'credit_card' THEN 1 ELSE 2 END, lower(a.name)`, [orgId, entityId]);
  return rows.map(r => ({ ...r, books_balance_cents: Number(r.books_signed) * normalSign(r.books_type) }));
}

const TAB_SQL = {
  review: `i.bank_state = 'active' AND i.review_state = 'new'`,
  categorized: `(i.review_state IN ('added', 'matched') OR i.attention IS NOT NULL)`,
  excluded: `i.review_state = 'excluded' AND i.bank_state = 'active'`,
};
// Bank items of one fed account on one tab, newest first, with what each became.
export async function listBankItems(db, { orgId, entityId, llAccountId, tab = 'review', limit = 300, offset = 0 }) {
  if (!TAB_SQL[tab]) fail('Unknown tab.');
  const { rows } = await db.query(`
    SELECT i.item_id, i.ll_account_id::text AS ll_account_id, i.posted_date, i.authorized_date, i.amount_cents, i.description, i.merchant_name, i.category,
           i.check_number, i.pending, i.bank_state, i.review_state, i.attention, i.reviewed_by, i.reviewed_at,
           (SELECT r.name FROM bank_rule r WHERE r.rule_id = i.rule_id) AS rule_name,
           coalesce((SELECT json_agg(json_build_object('txn_id', t.txn_id, 'type', t.type, 'doc_number', t.doc_number, 'txn_date', t.txn_date, 'how', k.how,
                       'party', coalesce(c.display_name, v.display_name)) ORDER BY t.txn_date, t.txn_id)
                     FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id LEFT JOIN customer c ON c.customer_id = t.customer_id
                     LEFT JOIN vendor v ON v.vendor_id = t.vendor_id WHERE k.item_id = i.item_id), '[]') AS links
      FROM bank_feed_item i
     WHERE i.org_id = $1 AND i.entity_id = $2 AND i.ll_account_id = $3::uuid AND ${TAB_SQL[tab]}
     ORDER BY i.pending DESC, i.posted_date DESC, i.item_id DESC LIMIT $4 OFFSET $5`, [orgId, entityId, llAccountId, limit, offset]);
  return rows;
}

export async function tabCounts(db, { orgId, entityId, llAccountId }) {
  const { rows: [r] } = await db.query(`SELECT
      count(*) FILTER (WHERE ${TAB_SQL.review})::int AS review, count(*) FILTER (WHERE ${TAB_SQL.categorized})::int AS categorized,
      count(*) FILTER (WHERE ${TAB_SQL.excluded})::int AS excluded
    FROM bank_feed_item i WHERE i.org_id = $1 AND i.entity_id = $2 AND i.ll_account_id = $3::uuid`, [orgId, entityId, llAccountId]);
  return r;
}

// One bank item of this company with its fed account's books account.
export async function getBankItem(db, { orgId, entityId, itemId, lock = false }) {
  const { rows: [i] } = await db.query(`
    SELECT i.*, i.ll_account_id::text AS ll_account, l.books_account_id, a.type AS books_type, a.name AS books_name
      FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id JOIN account a ON a.account_id = l.books_account_id
     WHERE i.org_id = $1 AND i.entity_id = $2 AND i.item_id = $3 AND l.include${lock ? ' FOR UPDATE OF i' : ''}`, [orgId, entityId, Number(itemId) || 0]);
  return i ?? null;
}

const reviewable = item => {
  if (!item) fail('Bank item not found.');
  if (item.bank_state !== 'active') fail('The bank removed this item, so it can’t be added or matched.');
  if (item.pending) fail('This item is still pending at the bank. It can be added once it posts.');
  if (item.review_state !== 'new') fail('This item has already been reviewed. Undo it first to change it.');
};

// Books transactions this bank item could be: same account, near the date and not already used by another bank item of
// the account. exact: the same amount (best first). others: smaller amounts in the same direction, to tick several that
// together make up the bank item (with `others: true`). For money into a bank account, also payments waiting in
// Undeposited Funds (several can be grouped into one deposit); pass `undeposited` to reuse a list already loaded.
export async function matchCandidates(db, { orgId, entityId, item, others = false, undeposited: waiting = null }) {
  const { rows: all } = await db.query(`
    SELECT t.txn_id, t.type, t.doc_number, t.payment_ref, t.txn_date, t.memo, coalesce(c.display_name, v.display_name) AS party, s.amount_cents
      FROM (SELECT p.txn_id, sum(p.amount_cents)::bigint AS amount_cents FROM posting p WHERE p.org_id = $1 AND p.account_id = $2 GROUP BY p.txn_id) s
      JOIN txn t ON t.txn_id = s.txn_id LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
     WHERE t.entity_id = $3 AND t.voided_at IS NULL AND t.txn_date BETWEEN $5::date - $6::int AND $5::date + $7::int
       AND CASE WHEN $10::boolean THEN sign(s.amount_cents) = sign($4::bigint) AND abs(s.amount_cents) <= abs($4::bigint) ELSE s.amount_cents = $4 END
       AND NOT EXISTS (SELECT 1 FROM bank_feed_link k JOIN bank_feed_item o ON o.item_id = k.item_id
                        WHERE k.txn_id = t.txn_id AND o.entity_id = t.entity_id AND o.ll_account_id = $8::uuid AND o.item_id <> $9)`,
    [orgId, item.books_account_id, entityId, item.amount_cents, item.posted_date, MATCH_DAYS_BEFORE, MATCH_DAYS_AFTER, item.ll_account, item.item_id, others]);
  const rows = all.filter(r => Number(r.amount_cents) === Number(item.amount_cents));
  const words = String(item.description ?? '').toUpperCase();
  const scored = rows.map(r => {
    let score = 100 - Math.abs(dayDiff(item.posted_date, r.txn_date));
    if (item.check_number && r.doc_number === item.check_number) score += 100;
    if (r.party && words.includes(String(r.party).toUpperCase().split(/\s+/)[0])) score += 20;
    return { ...r, score, days: dayDiff(item.posted_date, r.txn_date) };
  }).sort((a, b) => b.score - a.score || a.txn_id - b.txn_id);
  const rest = all.filter(r => Number(r.amount_cents) !== Number(item.amount_cents))
    .sort((a, b) => Math.abs(dayDiff(item.posted_date, a.txn_date)) - Math.abs(dayDiff(item.posted_date, b.txn_date)) || a.txn_id - b.txn_id).slice(0, 40);
  let undeposited = [];
  if (item.books_type === 'bank' && item.amount_cents > 0) {
    undeposited = (waiting ?? await listUndeposited(db, { orgId, entityId }))
      .filter(u => u.total_cents <= item.amount_cents && u.txn_date <= item.posted_date && dayDiff(item.posted_date, u.txn_date) <= MATCH_DAYS_BEFORE)
      .sort((a, b) => (a.total_cents === item.amount_cents ? -1 : 0) - (b.total_cents === item.amount_cents ? -1 : 0) || String(b.txn_date).localeCompare(a.txn_date));
  }
  return { exact: scored, others: rest, undeposited };
}

// What the screen suggests for an item: a confident match (exactly one candidate, within a few days, or the same check
// number), else nothing yet (rules and AI come in stages B4–B5).
export function confidentMatch(candidates, item) {
  const near = candidates.exact.filter(c => Math.abs(c.days) <= CONFIDENT_DAYS || (item.check_number && c.doc_number === item.check_number));
  return near.length === 1 ? near[0] : null;
}

async function linkTxns(tx, { orgId, item, txnIds, how, actor }) {
  for (const id of txnIds) {
    await tx.query('INSERT INTO bank_feed_link (org_id, item_id, txn_id, how, linked_by) VALUES ($1, $2, $3, $4, $5)', [orgId, item.item_id, id, how, actor]);
  }
  await tx.query(`UPDATE bank_feed_item SET review_state = $2, reviewed_at = now(), reviewed_by = $3, attention = NULL, updated_at = now() WHERE item_id = $1`,
    [item.item_id, how === 'matched' ? 'matched' : 'added', actor]);
}

// Match a bank item to books transactions already on its account, and/or to payments waiting in Undeposited Funds (put into
// one new deposit dated the bank date). Together they must equal the bank amount.
export async function matchItem(pool, { orgId, entityId, itemId, txnIds = [], undepositedIds = [], actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
    reviewable(item);
    const ids = [...new Set(txnIds.map(Number).filter(Number.isSafeInteger))];
    const waiting = [...new Set(undepositedIds.map(Number).filter(Number.isSafeInteger))];
    if (!ids.length && !waiting.length) fail('Choose what this bank item matches.');
    const cands = await matchCandidatesAny(tx, { orgId, entityId, item, ids });
    let total = 0;
    for (const id of ids) {
      const c = cands.get(id) ?? fail('One of the chosen transactions isn’t on this account, is already matched to another bank item, or is voided.');
      total += Number(c.amount_cents);
    }
    let depositId = null;
    if (waiting.length) {
      if (item.books_type !== 'bank' || item.amount_cents <= 0) fail('Only money into a bank account can be matched to payments waiting to be deposited.');
      depositId = await writeDeposit(tx, { orgId, entityId, actor, accountId: item.books_account_id, txnDate: item.posted_date, sourceTxnIds: waiting,
        memo: `Bank deposit: ${item.description}`.slice(0, 1000) });
      total += Number((await tx.query('SELECT total_cents FROM txn WHERE txn_id = $1', [depositId])).rows[0].total_cents);
    }
    if (total !== Number(item.amount_cents)) {
      fail(`The chosen transactions add up to ${formatCents(Math.abs(total))}, but the bank shows ${formatCents(Math.abs(item.amount_cents))}. They must be equal.`);
    }
    if (ids.length) await linkTxns(tx, { orgId, item, txnIds: ids, how: 'matched', actor });
    if (depositId) await linkTxns(tx, { orgId, item, txnIds: [depositId], how: 'grouped', actor });
    if (ids.length && depositId) await tx.query(`UPDATE bank_feed_item SET review_state = 'matched' WHERE item_id = $1`, [item.item_id]);
    return { matched: ids, depositId };
  });
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

// Add a bank item to the books as a new transaction on its account, dated the bank date:
//  money out of a bank or card → an expense (a check when the bank shows a check number);
//  money into a bank account → a deposit;
//  anything else (a card refund, loan activity) → a journal entry.
// lines: [{ accountId, amount, description, classId }] — the category split; amounts are positive and must add up to the
// bank amount. payee: 'v:ID' (vendor) or 'c:ID' (customer).
export async function addItem(pool, { orgId, entityId, itemId, payee = '', lines = [], memo = '', dims = {}, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
    reviewable(item);
    const amount = Math.abs(Number(item.amount_cents));
    const filled = lines.filter(l => l.accountId || String(l.amount ?? '').trim());
    const split = filled.map((l, i) => {
      const cents = String(l.amount ?? '').trim() ? parseMoney(String(l.amount).trim()) : (filled.length === 1 ? amount : null);
      if (cents === null || cents <= 0) fail(`Line ${i + 1}: enter an amount like 25.00.`);
      if (!l.accountId) fail(`Line ${i + 1}: choose a category.`);
      if (Number(l.accountId) === Number(item.books_account_id)) fail(`Line ${i + 1}: the category can’t be ${item.books_name} itself — use Transfer for money between accounts.`);
      return { accountId: Number(l.accountId), cents, description: String(l.description ?? '').trim().slice(0, 300), classId: l.classId || null };
    });
    if (!split.length) fail('Choose a category.');
    const sum = split.reduce((s, l) => s + l.cents, 0);
    if (sum !== amount) fail(`The split adds up to ${formatCents(sum)}; the bank shows ${formatCents(amount)}.`);
    const party = /^([cv]):(\d{1,18})$/.exec(String(payee ?? ''));
    const vendorId = party?.[1] === 'v' ? Number(party[2]) : null, customerId = party?.[1] === 'c' ? Number(party[2]) : null;
    const memoText = (String(memo ?? '').trim() || item.description).slice(0, 1000);
    const out = Number(item.amount_cents) < 0;
    let txnId;
    if (out && ['bank', 'credit_card'].includes(item.books_type)) {
      if (customerId) fail('Money paid out goes to a vendor. Choose a vendor or leave the payee empty.');
      const check = item.books_type === 'bank' && /^\d{1,10}$/.test(item.check_number ?? '');
      txnId = await writeVendorDoc(tx, { orgId, entityId, actor, type: check ? 'check' : 'expense', vendorId, txnDate: item.posted_date, accountId: item.books_account_id,
        paymentMethod: item.books_type === 'credit_card' ? 'Credit card' : null, docNumber: check ? item.check_number : '', memo: memoText,
        categoryLines: split.map(l => ({ accountId: l.accountId, amount: (l.cents / 100).toFixed(2), description: l.description, classId: l.classId })), itemLines: [] });
    } else if (!out && item.books_type === 'bank') {
      if (vendorId) fail('Money received comes from a customer. Choose a customer or leave the payee empty.');
      txnId = await writeDeposit(tx, { orgId, entityId, actor, accountId: item.books_account_id, txnDate: item.posted_date, memo: memoText, sourceTxnIds: [],
        otherLines: split.map(l => ({ accountId: l.accountId, customerId, description: l.description || item.description, amount: (l.cents / 100).toFixed(2) })) });
    } else {
      // The fed account moves by the bank amount; the categories take the other side.
      const money = c => (c / 100).toFixed(2);
      const p = vendorId ? `v:${vendorId}` : customerId ? `c:${customerId}` : '';
      txnId = await writeJournalEntry(tx, { orgId, entityId, actor, txnDate: item.posted_date, docNumber: '', memo: memoText, lines: [
        { accountId: item.books_account_id, debit: out ? '' : money(amount), credit: out ? money(amount) : '', description: item.description, party: '' },
        ...split.map(l => ({ accountId: l.accountId, debit: out ? money(l.cents) : '', credit: out ? '' : money(l.cents), description: l.description, party: p, classId: l.classId })),
      ] });
    }
    // Whatever was created must move the fed account by exactly the bank amount.
    const { rows: [m] } = await tx.query('SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM posting WHERE txn_id = $1 AND account_id = $2', [txnId, item.books_account_id]);
    if (Number(m.n) !== Number(item.amount_cents)) throw new Error(`bank add posted ${m.n} to the account, expected ${item.amount_cents}`);
    // Class and location (from a rule, or the form).
    if (dims.classId || dims.locationId) await applyTxnDimensions(tx, { orgId, entityId, txnId, dims });
    await linkTxns(tx, { orgId, item, txnIds: [txnId], how: 'added', actor });
    return txnId;
  });
}

// Money between two of the company's accounts. If the other account is fed too and has the opposite bank item within a few
// days, both bank items are recorded by the one transfer.
// `matchOther` false (a practice copy): the other account's bank line is left for a person to match.
export async function transferItem(pool, { orgId, entityId, itemId, otherAccountId, memo = '', actor, matchOther = true }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
    reviewable(item);
    const { rows: [other] } = await tx.query(`SELECT account_id, name, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active`,
      [orgId, entityId, Number(otherAccountId) || 0]);
    if (!other || other.system_key || !['bank', 'credit_card', 'other_current_asset', 'other_asset', 'other_current_liability', 'long_term_liability'].includes(other.type)) {
      fail('Choose the other bank, card, loan or asset account.');
    }
    if (Number(other.account_id) === Number(item.books_account_id)) fail('Choose a different account.');
    const out = Number(item.amount_cents) < 0;
    const amount = Math.abs(Number(item.amount_cents));
    const from = out ? Number(item.books_account_id) : Number(other.account_id), to = out ? Number(other.account_id) : Number(item.books_account_id);
    const types = new Map([[Number(item.books_account_id), item.books_type], [Number(other.account_id), other.type]]);
    const memoText = (String(memo ?? '').trim() || item.description).slice(0, 1000);
    let txnId;
    if (types.get(from) === 'bank' && types.get(to) === 'credit_card') {
      txnId = await writeTransfer(tx, { orgId, entityId, type: 'cc_payment', fromId: from, toId: to, amountText: (amount / 100).toFixed(2), txnDate: item.posted_date, memo: memoText });
    } else if (TRANSFER_TYPES.includes(types.get(from)) && TRANSFER_TYPES.includes(types.get(to))) {
      txnId = await writeTransfer(tx, { orgId, entityId, type: 'transfer', fromId: from, toId: to, amountText: (amount / 100).toFixed(2), txnDate: item.posted_date, memo: memoText });
    } else {
      // Loans and other liabilities: a journal entry moving the money from one to the other.
      const money = (amount / 100).toFixed(2);
      txnId = await writeJournalEntry(tx, { orgId, entityId, actor, txnDate: item.posted_date, docNumber: '', memo: memoText, lines: [
        { accountId: to, debit: money, credit: '', description: item.description, party: '' },
        { accountId: from, debit: '', credit: money, description: item.description, party: '' }] });
    }
    await linkTxns(tx, { orgId, item, txnIds: [txnId], how: 'added', actor });
    // The other side, if it's fed and waiting.
    const { rows: [pair] } = !matchOther ? { rows: [] } : await tx.query(`
      SELECT i.item_id FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id
       WHERE i.org_id = $1 AND i.entity_id = $2 AND l.books_account_id = $3 AND l.include AND i.review_state = 'new' AND i.bank_state = 'active' AND NOT i.pending
         AND i.amount_cents = $4 AND abs(i.posted_date - $5::date) <= $6
       ORDER BY abs(i.posted_date - $5::date), i.item_id LIMIT 1 FOR UPDATE OF i`,
      [orgId, entityId, other.account_id, -Number(item.amount_cents), item.posted_date, CONFIDENT_DAYS]);
    if (pair) await linkTxns(tx, { orgId, item: { item_id: pair.item_id }, txnIds: [txnId], how: 'matched', actor });
    return { txnId, pairedItemId: pair?.item_id ?? null };
  });
}

export async function excludeItems(pool, { orgId, entityId, itemIds, actor }) {
  const ids = [...new Set(itemIds.map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) fail('Choose the bank items to exclude.');
  const { rowCount } = await pool.query(`UPDATE bank_feed_item SET review_state = 'excluded', reviewed_at = now(), reviewed_by = $4, updated_at = now()
    WHERE org_id = $1 AND entity_id = $2 AND item_id = ANY($3::bigint[]) AND review_state = 'new'`, [orgId, entityId, ids, actor]);
  return rowCount;
}

// Undo a review. Excluded → back to review. Matched → unlinked (the books transaction stays). Added or grouped → the
// transaction it created is deleted (refused if it's reconciled), and the bank item goes back to review — as QBO does.
// A transaction that also records another bank item (a paired transfer) stays, and that other item now owns it, so
// undoing the other side later deletes it. All in one transaction under the company lock.
export async function undoItem(pool, { orgId, entityId, itemId, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const item = await getBankItem(tx, { orgId, entityId, itemId, lock: true });
    if (!item) fail('Bank item not found.');
    if (item.review_state === 'excluded') {
      await tx.query(`UPDATE bank_feed_item SET review_state = 'new', reviewed_at = NULL, reviewed_by = NULL, updated_at = now() WHERE item_id = $1`, [item.item_id]);
      return 'restored';
    }
    if (item.review_state === 'new') fail('This item hasn’t been reviewed.');
    const { rows: links } = await tx.query(`SELECT k.txn_id, k.how, t.type FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1`, [item.item_id]);
    const created = [];
    for (const l of links.filter(x => x.how !== 'matched')) {
      const { rows: [other] } = await tx.query('SELECT item_id FROM bank_feed_link WHERE txn_id = $1 AND item_id <> $2 ORDER BY item_id LIMIT 1', [l.txn_id, item.item_id]);
      if (other) await tx.query(`UPDATE bank_feed_link SET how = $3 WHERE txn_id = $1 AND item_id = $2`, [l.txn_id, other.item_id, l.how]);
      else created.push(l);
    }
    for (const l of created) await assertNotReconciled(tx, { orgId, txnId: l.txn_id });
    // Unlink first (the deletes below would otherwise send the item back through the trigger mid-way).
    await tx.query('DELETE FROM bank_feed_link WHERE item_id = $1', [item.item_id]);
    for (const l of created) {
      if (l.type === 'deposit') await deleteDepositTx(tx, { orgId, entityId, txnId: l.txn_id, actor });
      else if (['expense', 'check'].includes(l.type)) await deleteVendorTxnTx(tx, { orgId, entityId, txnId: l.txn_id, actor });
      else await deleteLedgerTxnTx(tx, { orgId, entityId, txnId: l.txn_id });
    }
    await tx.query(`UPDATE bank_feed_item SET review_state = 'new', reviewed_at = NULL, reviewed_by = NULL, attention = NULL, rule_id = NULL, updated_at = now()
      WHERE item_id = $1`, [item.item_id]);
    return created.length ? 'deleted' : 'unmatched';
  });
}

// Accept every confident match on an account in one go (the "batch accept" of QBO's For review tab).
export async function acceptConfident(pool, { orgId, entityId, llAccountId, itemIds = null, actor }) {
  const items = await listBankItems(pool, { orgId, entityId, llAccountId, tab: 'review', limit: 1000 });
  let matched = 0;
  for (const row of items.filter(i => !i.pending && (!itemIds || itemIds.map(Number).includes(Number(i.item_id))))) {
    const item = await getBankItem(pool, { orgId, entityId, itemId: row.item_id });
    const m = confidentMatch(await matchCandidates(pool, { orgId, entityId, item }), item);
    if (!m) continue;
    try { await matchItem(pool, { orgId, entityId, itemId: item.item_id, txnIds: [m.txn_id], actor }); matched++; } catch (error) {
      if (!(error instanceof ValidationError)) throw error; // someone else got there first
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
