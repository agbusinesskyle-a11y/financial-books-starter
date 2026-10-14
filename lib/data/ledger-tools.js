import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, nextDocNumber } from './writes.js';
import { repost } from './ledger.js';
import { applyTxnDimensions, checkLineClasses } from './accounting.js';
import { assertNotReconciled } from './locks.js';
import { isIsoDate } from '../domain/dates.js';
import { parseMoney, parseSignedMoney, formatCents } from '../domain/money.js';
import { normalSign } from '../domain/ledger.js';

// Journal entries, transfers, credit card payments, and reconciliation.

const fail = message => { throw new ValidationError(message); };
export const LEDGER_TYPES = ['journal_entry', 'transfer', 'cc_payment', 'fx_revaluation'];
// Accounts whose balance another list must agree with (A/R, A/P, inventory) or that deposits draw from.
const BLOCKED = ['ar', 'ap', 'undeposited', 'inventory'];
export const TRANSFER_TYPES = ['bank', 'credit_card', 'other_current_asset', 'other_asset'];

async function accountsById(tx, { orgId, entityId }) {
  const { rows } = await tx.query('SELECT account_id, name, type, system_key, active FROM account WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  return new Map(rows.map(a => [a.account_id, a]));
}

export async function getLedgerTxn(db, { orgId, entityId, txnId }) {
  const { rows: [t] } = await db.query(
    `SELECT t.*, fa.name AS from_name, ta.name AS to_name, r.doc_number AS reverses_number,
            (SELECT x.txn_id FROM txn x WHERE x.reverses_txn_id = t.txn_id LIMIT 1) AS reversed_by,
            (SELECT coalesce(array_agg(tt.tag_id), '{}') FROM txn_tag tt WHERE tt.txn_id = t.txn_id) AS tag_ids,
            EXISTS (SELECT 1 FROM reconciled_item i WHERE i.txn_id = t.txn_id) AS reconciled
       FROM txn t LEFT JOIN account fa ON fa.account_id = t.account_id LEFT JOIN account ta ON ta.account_id = t.to_account_id
       LEFT JOIN txn r ON r.txn_id = t.reverses_txn_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.txn_id = $3 AND t.type = ANY($4)`, [orgId, entityId, txnId, LEDGER_TYPES]);
  if (!t) return null;
  const { rows: lines } = await db.query(
    `SELECT l.line_no, l.account_id, a.name AS account_name, l.amount_cents, l.description, l.customer_id, c.display_name AS customer_name,
            l.vendor_id, v.display_name AS vendor_name, l.class_id
       FROM txn_line l JOIN account a ON a.account_id = l.account_id LEFT JOIN customer c ON c.customer_id = l.customer_id
       LEFT JOIN vendor v ON v.vendor_id = l.vendor_id WHERE l.txn_id = $1 ORDER BY l.line_no`, [txnId]);
  return { ...t, lines };
}

// ---- journal entries ----

// lines: [{ accountId, debit, credit, description, party ('c:ID' | 'v:ID' | ''), classId }] (strings). reverseOn: a date for an
// automatic reversing entry (new entries only). Returns the entry's id.
export async function saveJournalEntry(pool, args) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, args.orgId, args.entityId);
    return writeJournalEntry(tx, args);
  });
}

// The same inside the caller's transaction (the caller holds the entity lock).
export async function writeJournalEntry(tx, { orgId, entityId, txnId = null, actor, txnDate, docNumber, memo, lines: rows, reverseOn = '', dims = {}, override = false, adjusting = false }) {
  if (!isIsoDate(txnDate)) fail('Enter a valid date.');
  if (reverseOn && (!isIsoDate(reverseOn) || reverseOn <= txnDate)) fail('The reversing date must be after the entry date.');
  const isNew = !txnId;
  const accounts = await accountsById(tx, { orgId, entityId });
  const lines = [];
  for (const [i, r] of rows.entries()) {
    const blank = !r.accountId && !String(r.debit ?? '').trim() && !String(r.credit ?? '').trim() && !String(r.description ?? '').trim();
    if (blank) continue;
    const where = `Line ${i + 1}`;
    const a = accounts.get(Number(r.accountId));
    if (!a || !a.active) fail(`${where}: choose an account.`);
    if (BLOCKED.includes(a.system_key)) fail(`${where}: “${a.name}” is kept by its own transactions (invoices, bills, deposits, stock). Use those instead.`);
    const debit = String(r.debit ?? '').trim() ? parseMoney(r.debit) : 0;
    const credit = String(r.credit ?? '').trim() ? parseMoney(r.credit) : 0;
    if (debit === null || credit === null || debit < 0 || credit < 0) fail(`${where}: amounts look like 125.00.`);
    if ((debit > 0) === (credit > 0)) fail(`${where}: enter a debit or a credit (one of them).`);
    const party = /^([cv]):(\d{1,18})$/.exec(String(r.party ?? ''));
    lines.push({ accountId: a.account_id, amount: debit - credit, description: String(r.description ?? '').trim().slice(0, 500) || null,
      customerId: party?.[1] === 'c' ? Number(party[2]) : null, vendorId: party?.[1] === 'v' ? Number(party[2]) : null,
      classId: /^\d{1,18}$/.test(String(r.classId ?? '')) ? Number(r.classId) : null });
  }
  if (lines.length < 2) fail('A journal entry needs at least two lines.');
  const debits = lines.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const credits = -lines.filter(l => l.amount < 0).reduce((s, l) => s + l.amount, 0);
  if (debits !== credits) fail(`Debits (${formatCents(debits)}) and credits (${formatCents(credits)}) must be equal. The difference is ${formatCents(Math.abs(debits - credits))}.`);
  await checkLineClasses(tx, { orgId, entityId, classIds: lines.map(l => l.classId) });
  for (const l of lines) {
    if (l.customerId && !(await tx.query('SELECT 1 FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3', [orgId, entityId, l.customerId])).rowCount) fail('Choose a valid customer.');
    if (l.vendorId && !(await tx.query('SELECT 1 FROM vendor WHERE org_id = $1 AND entity_id = $2 AND vendor_id = $3', [orgId, entityId, l.vendorId])).rowCount) fail('Choose a valid vendor.');
  }
  const memoText = String(memo ?? '').trim().slice(0, 1000) || null;
  let number = String(docNumber ?? '').trim().slice(0, 30);
  if (txnId) {
    const { rows: [t] } = await tx.query(`SELECT * FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3 AND type = 'journal_entry' FOR UPDATE`, [orgId, entityId, txnId]);
    if (!t) fail('Journal entry not found.');
    if (t.voided_at) fail('This journal entry is voided.');
    await assertNotReconciled(tx, { orgId, txnId, override });
    number ||= t.doc_number;
    await tx.query('UPDATE txn SET txn_date = $3, doc_number = $4, memo = $5, total_cents = $6, is_adjusting = $7, updated_at = now() WHERE txn_id = $2 AND org_id = $1',
      [orgId, txnId, txnDate, number, memoText, debits, Boolean(adjusting)]);
    await tx.query('DELETE FROM txn_line WHERE txn_id = $1', [txnId]);
  } else {
    number ||= await nextDocNumber(tx, orgId, entityId, 'journal_entry');
    txnId = (await tx.query(`INSERT INTO txn (org_id, entity_id, type, doc_number, txn_date, memo, total_cents, open_cents, is_adjusting) VALUES ($1,$2,'journal_entry',$3,$4,$5,$6,0,$7) RETURNING txn_id`,
      [orgId, entityId, number, txnDate, memoText, debits, Boolean(adjusting)])).rows[0].txn_id;
  }
  await writeLines(tx, orgId, txnId, lines);
  await applyTxnDimensions(tx, { orgId, entityId, txnId, dims });
  await repost(tx, orgId, txnId);
  if (reverseOn && isNew) {
    const revId = (await tx.query(
      `INSERT INTO txn (org_id, entity_id, type, doc_number, txn_date, memo, total_cents, open_cents, reverses_txn_id) VALUES ($1,$2,'journal_entry',$3,$4,$5,$6,0,$7) RETURNING txn_id`,
      [orgId, entityId, await nextDocNumber(tx, orgId, entityId, 'journal_entry'), reverseOn, `Reverses ${number}`, debits, txnId])).rows[0].txn_id;
    await writeLines(tx, orgId, revId, lines.map(l => ({ ...l, amount: -l.amount })));
    await applyTxnDimensions(tx, { orgId, entityId, txnId: revId, dims });
    await repost(tx, orgId, revId);
  }
  return txnId;
}

async function writeLines(tx, orgId, txnId, lines) {
  for (const [i, l] of lines.entries()) {
    await tx.query(
      `INSERT INTO txn_line (org_id, txn_id, line_no, account_id, description, quantity, rate_cents, amount_cents, customer_id, vendor_id, class_id)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10)`, [orgId, txnId, i + 1, l.accountId, l.description, Math.abs(l.amount), l.amount, l.customerId, l.vendorId, l.classId]);
  }
}

// ---- transfers and credit card payments ----

// type 'transfer' (between bank, card and other asset accounts) or 'cc_payment' (from a bank account to a credit card).
export async function saveTransfer(pool, args) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, args.orgId, args.entityId);
    return writeTransfer(tx, args);
  });
}

// The same inside the caller's transaction (the caller holds the entity lock).
export async function writeTransfer(tx, { orgId, entityId, type, txnId = null, fromId, toId, amountText, txnDate, memo, dims = {}, override = false }) {
  if (!['transfer', 'cc_payment'].includes(type)) fail('Unknown transaction type.');
  if (!isIsoDate(txnDate)) fail('Enter a valid date.');
  const amount = parseMoney(String(amountText ?? '').trim());
  if (amount === null || amount <= 0) fail('Enter the amount, like 500.00.');
  const accounts = await accountsById(tx, { orgId, entityId });
  const from = accounts.get(fromId), to = accounts.get(toId);
  const ok = a => a && a.active && TRANSFER_TYPES.includes(a.type) && !BLOCKED.includes(a.system_key);
  if (type === 'cc_payment') {
    if (!from || from.type !== 'bank' || !from.active) fail('Choose the bank account the payment comes from.');
    if (!to || to.type !== 'credit_card' || !to.active) fail('Choose the credit card being paid.');
  } else {
    if (!ok(from)) fail('Choose the account the money comes from (bank, credit card or other asset).');
    if (!ok(to)) fail('Choose the account the money goes to (bank, credit card or other asset).');
  }
  if (from.account_id === to.account_id) fail('Choose two different accounts.');
  const memoText = String(memo ?? '').trim().slice(0, 1000) || null;
  if (txnId) {
    const { rows: [t] } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3 AND type = $4 FOR UPDATE', [orgId, entityId, txnId, type]);
    if (!t) fail('Not found.');
    if (t.voided_at) fail('This transaction is voided.');
    await assertNotReconciled(tx, { orgId, txnId, override });
    await tx.query('UPDATE txn SET account_id = $3, to_account_id = $4, total_cents = $5, txn_date = $6, memo = $7, updated_at = now() WHERE org_id = $1 AND txn_id = $2',
      [orgId, txnId, from.account_id, to.account_id, amount, txnDate, memoText]);
  } else {
    txnId = (await tx.query(`INSERT INTO txn (org_id, entity_id, type, txn_date, memo, total_cents, open_cents, account_id, to_account_id) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8) RETURNING txn_id`,
      [orgId, entityId, type, txnDate, memoText, amount, from.account_id, to.account_id])).rows[0].txn_id;
  }
  await applyTxnDimensions(tx, { orgId, entityId, txnId, dims });
  await repost(tx, orgId, txnId);
  return txnId;
}

export async function voidLedgerTxn(pool, { orgId, entityId, txnId, override = false }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows: [t] } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3 AND type = ANY($4) FOR UPDATE', [orgId, entityId, txnId, LEDGER_TYPES]);
    if (!t) fail('Not found.');
    if (t.type === 'fx_revaluation') fail('A revaluation and its reversal stay together. To redo it, revalue again at a later date.');
    if (t.voided_at) fail('Already voided.');
    await assertNotReconciled(tx, { orgId, txnId, override });
    await tx.query('UPDATE txn SET voided_at = now(), total_cents = 0, updated_at = now() WHERE txn_id = $1', [txnId]);
    await repost(tx, orgId, txnId);
  });
}

export async function deleteLedgerTxn(pool, args) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, args.orgId, args.entityId);
    return deleteLedgerTxnTx(tx, args);
  });
}

// The same inside the caller's transaction (the caller holds the entity lock).
export async function deleteLedgerTxnTx(tx, { orgId, entityId, txnId, override = false }) {
  const { rows: [t] } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3 AND type = ANY($4) FOR UPDATE', [orgId, entityId, txnId, LEDGER_TYPES]);
  if (!t) fail('Not found.');
  if (t.type === 'fx_revaluation') fail('A revaluation and its reversal stay together. To redo it, revalue again at a later date.');
  await assertNotReconciled(tx, { orgId, txnId, override });
  await tx.query('DELETE FROM txn WHERE txn_id = $1', [txnId]);
}

// ---- reconcile ----

export const RECONCILE_TYPES = ['bank', 'credit_card', 'other_current_asset'];

// Accounts that can be reconciled, with their last finished reconciliation.
export async function reconcileAccounts(db, { orgId, entityId }) {
  const { rows } = await db.query(
    `SELECT a.account_id, a.name, a.type,
            (SELECT max(r.statement_date) FROM reconciliation r WHERE r.account_id = a.account_id) AS last_date,
            (SELECT r.ending_cents FROM reconciliation r WHERE r.account_id = a.account_id ORDER BY r.statement_date DESC, r.rec_id DESC LIMIT 1) AS last_ending
       FROM account a WHERE a.org_id = $1 AND a.entity_id = $2 AND a.active AND a.type = ANY($3) AND a.system_key IS DISTINCT FROM 'undeposited'
      ORDER BY a.type, a.name`, [orgId, entityId, RECONCILE_TYPES]);
  return rows;
}

// Where a reconciliation of `accountId` starts: the cleared balance so far (normal sign: what's in the bank, or what's owed on a
// card), every transaction not cleared yet up to `through`, and past reconciliations.
export async function reconcileState(db, { orgId, entityId, accountId, through = null }) {
  const { rows: [account] } = await db.query('SELECT account_id, name, type FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND type = ANY($4)',
    [orgId, entityId, accountId, RECONCILE_TYPES]);
  if (!account) return null;
  const sign = normalSign(account.type);
  const { rows: [b] } = await db.query(
    `SELECT (coalesce((SELECT sum(i.amount_cents) FROM reconciled_item i JOIN reconciliation r ON r.rec_id = i.rec_id WHERE r.org_id = $1 AND i.account_id = $2), 0)
           + coalesce((SELECT sum(j.amount_cents) FROM reconciled_adjustment j JOIN reconciliation r ON r.rec_id = j.rec_id WHERE r.org_id = $1 AND j.account_id = $2), 0))::bigint AS n`,
    [orgId, accountId]);
  const { rows: items } = await db.query(
    `SELECT p.txn_id, t.type, t.txn_date, t.doc_number, t.payment_ref, t.memo, sum(p.amount_cents)::bigint AS amount_cents,
            coalesce(c.display_name, v.display_name) AS party,
            -- The bank has shown it (matched or added from a bank item of this account, stage B3): cleared.
            EXISTS (SELECT 1 FROM bank_feed_link k JOIN bank_feed_item b ON b.item_id = k.item_id JOIN ledgerline_account l ON l.entity_id = b.entity_id AND l.ll_account_id = b.ll_account_id
                     WHERE k.txn_id = p.txn_id AND l.books_account_id = $2
                       AND b.bank_state = 'active' AND NOT b.pending AND b.attention IS NULL AND ($3::date IS NULL OR b.posted_date <= $3::date)) AS bank_cleared
       FROM posting p JOIN txn t ON t.txn_id = p.txn_id LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE p.org_id = $1 AND p.account_id = $2 AND ($3::date IS NULL OR t.txn_date <= $3::date)
        AND NOT EXISTS (SELECT 1 FROM reconciled_item i WHERE i.txn_id = p.txn_id AND i.account_id = p.account_id)
      GROUP BY p.txn_id, t.type, t.txn_date, t.doc_number, t.payment_ref, t.memo, c.display_name, v.display_name
     HAVING sum(p.amount_cents) <> 0
      ORDER BY t.txn_date, p.txn_id`, [orgId, accountId, through]);
  const { rows: history } = await db.query(
    'SELECT rec_id, statement_date, beginning_cents, ending_cents, completed_at, completed_by FROM reconciliation WHERE org_id = $1 AND account_id = $2 ORDER BY statement_date DESC, rec_id DESC',
    [orgId, accountId]);
  // Reconciled transactions changed or deleted since (admin override): the books no longer show what was cleared.
  const { rows: changed } = await db.query(
    `SELECT i.txn_id, i.amount_cents + coalesce((SELECT sum(j.amount_cents) FROM reconciled_adjustment j WHERE j.txn_id = i.txn_id AND j.account_id = i.account_id), 0) AS amount_cents,
            coalesce(t.type, i.txn_type) AS type, coalesce(t.txn_date, i.txn_date) AS txn_date, coalesce(t.doc_number, t.payment_ref, i.doc) AS doc,
            i.party, r.statement_date, t.txn_id IS NULL AS deleted, t.voided_at IS NOT NULL AS voided,
            coalesce((SELECT sum(p.amount_cents) FROM posting p WHERE p.txn_id = i.txn_id AND p.account_id = i.account_id), 0)::bigint AS now_cents
       FROM reconciled_item i JOIN reconciliation r ON r.rec_id = i.rec_id LEFT JOIN txn t ON t.txn_id = i.txn_id
      WHERE r.org_id = $1 AND i.account_id = $2`, [orgId, accountId]);
  const discrepancies = changed.filter(c => Number(c.now_cents) !== Number(c.amount_cents))
    .map(c => ({ ...c, was: Number(c.amount_cents) * sign, now: Number(c.now_cents) * sign, difference: (Number(c.now_cents) - Number(c.amount_cents)) * sign }));
  // Each discrepancy is also a line to tick on this statement (the change since it was reconciled).
  const changes = discrepancies.map(d => ({ txn_id: d.txn_id, type: d.type, txn_date: d.txn_date, doc_number: d.doc, payment_ref: null, memo: 'Change since reconciled',
    party: d.party, amount_cents: Number(d.now_cents) - Number(d.amount_cents), adjustment: true }));
  return { account, sign, beginning: Number(b.n) * sign, items: [...items, ...changes].map(i => ({ ...i, amount: Number(i.amount_cents) * sign })), history, discrepancies };
}

// Finishes a reconciliation: the cleared transactions must bring the beginning balance to the statement's ending balance.
export async function finishReconciliation(pool, { orgId, entityId, accountId, statementDate, endingText, txnIds, actor }) {
  if (!isIsoDate(statementDate)) fail('Enter the statement date.');
  const ending = parseSignedMoney(String(endingText ?? '').trim());
  if (ending === null) fail('Enter the statement’s ending balance, like 4,210.55.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const state = await reconcileState(tx, { orgId, entityId, accountId, through: statementDate });
    if (!state) fail('Choose an account to reconcile.');
    const last = state.history[0];
    if (last && statementDate <= last.statement_date) fail(`This account is already reconciled through ${last.statement_date}. Choose a later statement date.`);
    const byId = new Map(state.items.map(i => [i.txn_id, i]));
    const chosen = [...new Set(txnIds)].map(id => byId.get(id) ?? fail('One of the ticked transactions is already reconciled or after the statement date.'));
    const cleared = chosen.reduce((s, i) => s + i.amount, 0);
    const difference = ending - (state.beginning + cleared);
    if (difference !== 0) fail(`The difference is ${formatCents(difference)}. Tick the transactions on the statement until it’s $0.00.`);
    const { rows: [rec] } = await tx.query(
      `INSERT INTO reconciliation (org_id, entity_id, account_id, statement_date, beginning_cents, ending_cents, completed_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING rec_id`,
      [orgId, entityId, accountId, statementDate, state.beginning, ending, actor]);
    for (const i of chosen) {
      await tx.query(`INSERT INTO ${i.adjustment ? 'reconciled_adjustment' : 'reconciled_item'} (rec_id, txn_id, account_id, amount_cents, txn_type, txn_date, doc, party)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [rec.rec_id, i.txn_id, accountId, i.amount_cents, i.type, i.txn_date, i.doc_number ?? i.payment_ref ?? null, i.party ?? null]);
    }
    return rec.rec_id;
  });
}

// Undoes the newest reconciliation of an account (its transactions become uncleared and editable again).
export async function undoLastReconciliation(pool, { orgId, entityId, accountId }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    // Only this company's reconciliations (the account id comes from the URL).
    const { rows: [r] } = await tx.query(
      'SELECT rec_id, statement_date FROM reconciliation WHERE org_id = $1 AND entity_id = $3 AND account_id = $2 ORDER BY statement_date DESC, rec_id DESC LIMIT 1',
      [orgId, accountId, entityId]);
    if (!r) fail('There’s no reconciliation to undo.');
    await tx.query('DELETE FROM reconciliation WHERE rec_id = $1', [r.rec_id]);
    return r.statement_date;
  });
}

export async function getReconciliation(db, { orgId, entityId, recId }) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, a.name AS account_name, a.type AS account_type FROM reconciliation r JOIN account a ON a.account_id = r.account_id
      WHERE r.org_id = $1 AND r.entity_id = $2 AND r.rec_id = $3`, [orgId, entityId, recId]);
  if (!r) return null;
  const sign = normalSign(r.account_type);
  const { rows: items } = await db.query(
    `SELECT i.txn_id, i.amount_cents, coalesce(t.type, i.txn_type) AS type, coalesce(t.txn_date, i.txn_date) AS txn_date, coalesce(t.doc_number, i.doc) AS doc_number,
            t.payment_ref, coalesce(c.display_name, v.display_name, i.party) AS party, t.txn_id IS NULL AS deleted
       FROM reconciled_item i LEFT JOIN txn t ON t.txn_id = i.txn_id LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE i.rec_id = $1
     UNION ALL
     SELECT j.txn_id, j.amount_cents, j.txn_type, j.txn_date, j.doc, NULL, coalesce(j.party, '') || ' (change since reconciled)', false
       FROM reconciled_adjustment j WHERE j.rec_id = $1
     ORDER BY 4, 1`, [recId]);
  return { ...r, items: items.map(i => ({ ...i, amount: Number(i.amount_cents) * sign })) };
}
