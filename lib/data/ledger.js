import { formId } from '../domain/ids.js';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from './writes.js';
import { itemsTouching, replayItems, inventoryAccounts } from './inventory.js';
import { SYSTEM_ACCOUNTS, TYPE_LABEL, TYPE_GROUP, RESERVED_TYPES, LOAN_TYPES, normalSign, postingsFor } from '../domain/ledger.js';

const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;

// ---- system accounts and posting ----

// Creates any missing system accounts for a company; returns { key: account_id }.
export async function ensureSystemAccounts(tx, orgId, entityId) {
  for (const a of SYSTEM_ACCOUNTS) {
    await tx.query(
      `INSERT INTO account (org_id, entity_id, name, number, type, system_key)
       SELECT $1, $2, $3, CASE WHEN EXISTS (SELECT 1 FROM account WHERE org_id = $1 AND entity_id = $2 AND number = $4) THEN NULL ELSE $4 END, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM account WHERE org_id = $1 AND entity_id = $2 AND system_key = $6)`,
      [orgId, entityId, a.name, a.number, a.type, a.key]);
  }
  return systemAccounts(tx, orgId, entityId);
}

export async function systemAccounts(db, orgId, entityId) {
  const { rows } = await db.query('SELECT system_key, account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND system_key IS NOT NULL',
    [orgId, entityId]);
  return Object.fromEntries(rows.map(r => [r.system_key, r.account_id]));
}

// Rewrites one transaction's postings from its current rows. Call inside the write's own transaction,
// after the txn, its lines and any deposit lines are saved. The deferred trigger re-checks the balance at commit.
// With replay (the default), inventory items on the transaction first get their average cost recomputed, which
// can repost later sales of those items too.
export async function repost(tx, orgId, txnId, { replay = true } = {}) {
  const items = replay ? await itemsTouching(tx, orgId, txnId) : [];
  await tx.query('DELETE FROM posting WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]);
  if (items.length) await replayItems(tx, orgId, items, { skip: txnId });
  await writePostings(tx, orgId, [txnId]);
}

// Many transactions at once — what repost(…, { replay: false }) does for each, in a handful of statements (used by the
// inventory replay, which can touch thousands of sales after one back-dated purchase).
export async function repostMany(tx, orgId, txnIds) {
  const ids = [...new Set(txnIds.map(Number))];
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await tx.query('DELETE FROM posting WHERE org_id = $1 AND txn_id = ANY($2::bigint[])', [orgId, chunk]);
    await writePostings(tx, orgId, chunk);
  }
}

// Postings for transactions whose old postings are already gone: load everything for the batch, compute, insert once.
async function writePostings(tx, orgId, ids) {
  const { rows: txns } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND txn_id = ANY($2::bigint[])', [orgId, ids]);
  if (!txns.length) return;
  const { rows: allLines } = await tx.query(
    `SELECT l.txn_id, l.line_no, l.kind, l.item_id, l.account_id, l.customer_id, l.vendor_id, l.project_id, l.amount_cents, l.cost_cents, l.class_id,
            i.income_account_id, i.expense_account_id
       FROM txn_line l LEFT JOIN item i ON i.item_id = l.item_id
      WHERE l.org_id = $1 AND l.txn_id = ANY($2::bigint[]) ORDER BY l.txn_id, l.line_no`, [orgId, ids]);
  const deposits = txns.filter(t => t.type === 'deposit').map(t => t.txn_id);
  const { rows: allDeposit } = deposits.length
    ? await tx.query('SELECT * FROM deposit_line WHERE org_id = $1 AND deposit_txn_id = ANY($2::bigint[]) ORDER BY deposit_txn_id, line_no', [orgId, deposits])
    : { rows: [] };
  const group = (rows, key) => rows.reduce((m, r) => m.set(Number(r[key]), [...(m.get(Number(r[key])) ?? []), r]), new Map());
  const linesOf = group(allLines, 'txn_id'), depositOf = group(allDeposit, 'deposit_txn_id');
  const perEntity = new Map();
  for (const entityId of new Set(txns.map(t => Number(t.entity_id)))) {
    const itemIds = [...new Set(allLines.filter(l => l.item_id && txns.some(t => Number(t.txn_id) === Number(l.txn_id) && Number(t.entity_id) === entityId)).map(l => l.item_id))];
    perEntity.set(entityId, { sys: await systemAccounts(tx, orgId, entityId), inv: await inventoryAccounts(tx, { orgId, entityId, itemIds }) });
  }
  const out = [];
  for (const t of txns) {
    const lines = linesOf.get(Number(t.txn_id)) ?? [];
    const { sys, inv } = perEntity.get(Number(t.entity_id));
    const income = new Map(lines.map(l => [l.item_id, l.income_account_id]));
    const expense = new Map(lines.map(l => [l.item_id, l.expense_account_id]));
    const postings = postingsFor({ txn: t, lines, depositLines: depositOf.get(Number(t.txn_id)) ?? [], sys, incomeAccount: id => (id ? income.get(id) : null),
      expenseAccount: id => (id ? expense.get(id) : null), inventory: id => inv.get(id) ?? null });
    for (const p of postings) {
      out.push({ entity_id: t.entity_id, txn_id: t.txn_id, line_no: p.lineNo ?? null, account_id: p.accountId, amount_cents: p.amountCents, txn_date: t.txn_date,
        customer_id: p.customerId ?? null, vendor_id: p.vendorId ?? null, project_id: p.projectId ?? null, item_id: p.itemId ?? null, memo: t.memo,
        class_id: p.classId ?? null, location_id: p.locationId ?? null });
    }
  }
  for (let i = 0; i < out.length; i += 5000) {
    await tx.query(`INSERT INTO posting (org_id, entity_id, txn_id, line_no, account_id, amount_cents, txn_date, customer_id, vendor_id, project_id, item_id, memo,
        class_id, location_id)
      SELECT $1, x.entity_id, x.txn_id, x.line_no, x.account_id, x.amount_cents, x.txn_date, x.customer_id, x.vendor_id, x.project_id, x.item_id, x.memo,
        x.class_id, x.location_id
        FROM jsonb_to_recordset($2::jsonb) AS x(entity_id bigint, txn_id bigint, line_no int, account_id bigint, amount_cents bigint, txn_date date,
          customer_id bigint, vendor_id bigint, project_id bigint, item_id bigint, memo text, class_id bigint, location_id bigint)`,
    [orgId, JSON.stringify(out.slice(i, i + 5000))]);
  }
  await recheckBankLinks(tx, ids);
}

// Bank items this transaction was matched to or added from (stage B3): when a transaction behind a bank item is edited
// after the bank line was reviewed or last checked (anything that reaches the books — accounts, amounts, payee, project,
// memo, class, a void), or the transactions no longer move the account by the bank amount, the item is flagged 'books'
// (changed in the books). Every new edit — even with a flag already showing — moves the item's review version (so a page
// showing the earlier state can't clear it) and is recorded in its history. Back to what was reviewed: the flag goes.
// The bank's own flags ('changed', 'removed') stay in front.
async function recheckBankLinks(tx, txnIds) {
  await tx.query(`
    WITH cur AS (
      SELECT k.item_id, k.txn_id, txn_version(k.txn_id) AS v, k.txn_version AS acked, k.last_seen_version AS seen
        FROM bank_feed_link k WHERE k.item_id IN (SELECT item_id FROM bank_feed_link WHERE txn_id = ANY($1::bigint[]))),
    seen AS (
      UPDATE bank_feed_link k SET last_seen_version = cur.v FROM cur
       WHERE k.item_id = cur.item_id AND k.txn_id = cur.txn_id AND k.last_seen_version IS DISTINCT FROM cur.v RETURNING k.item_id),
    off AS (
      -- Changed since it was reviewed or last checked: a linked transaction's version differs from the one acknowledged (an
      -- amount difference someone checked stays answered until the books move again). Links from before versions were kept
      -- fall back to comparing the amount.
      SELECT i.item_id, (EXISTS (SELECT 1 FROM cur WHERE cur.item_id = i.item_id AND cur.acked IS NOT NULL AND cur.acked IS DISTINCT FROM cur.v)
               OR (EXISTS (SELECT 1 FROM cur WHERE cur.item_id = i.item_id AND cur.acked IS NULL)
                   AND i.amount_cents <> coalesce((SELECT sum(p.amount_cents) FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id
                         WHERE k.item_id = i.item_id AND p.account_id = l.books_account_id), 0))) AS mismatch,
             EXISTS (SELECT 1 FROM seen WHERE seen.item_id = i.item_id) AS moved
        FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id
       WHERE i.item_id IN (SELECT item_id FROM cur) AND i.review_state IN ('added', 'matched')),
    upd AS (
      UPDATE bank_feed_item b SET attention = CASE WHEN b.attention IN ('changed', 'removed') THEN b.attention WHEN off.mismatch THEN 'books' END,
             parked_attention = CASE WHEN b.attention = 'removed' AND off.mismatch AND b.parked_attention IS NULL THEN 'books'
                                     WHEN NOT off.mismatch AND b.parked_attention = 'books' THEN NULL ELSE b.parked_attention END,
             review_version = b.review_version + 1, updated_at = now()
        FROM off WHERE b.item_id = off.item_id
         AND (off.moved OR (off.mismatch AND b.attention IS NULL) OR (NOT off.mismatch AND b.attention = 'books')
              OR (NOT off.mismatch AND b.parked_attention = 'books'))
      RETURNING b.org_id, b.entity_id, b.item_id, b.ll_transaction_id, off.mismatch, off.moved)
    INSERT INTO bank_review_event (org_id, entity_id, item_id, ll_transaction_id, kind, source, txn_ids, actor)
    SELECT org_id, entity_id, item_id, ll_transaction_id, 'books_changed', 'books', $1::bigint[], coalesce(nullif(current_setting('app.actor', true), ''), 'system')
      FROM upd WHERE mismatch AND moved`, [txnIds.map(Number)]);
}

// Brings every company onto the ledger: system accounts exist, and every live transaction without
// postings gets them. Safe to run any number of times (migrate runs it after the SQL migrations).
// `repair` false (a practice copy): only count transactions missing their postings — no system accounts, no postings.
export async function ensureLedger(pool, { repair = true } = {}) {
  const { rows: entities } = await pool.query('SELECT org_id, entity_id FROM entity ORDER BY entity_id');
  let reposted = 0;
  for (const e of entities) {
    reposted += await withTransaction(pool, async tx => {
      if (repair) {
        await lockEntity(tx, e.org_id, e.entity_id);
        await ensureSystemAccounts(tx, e.org_id, e.entity_id);
      }
      const { rows } = await tx.query(
        `SELECT t.txn_id FROM txn t WHERE t.org_id = $1 AND t.entity_id = $2 AND t.voided_at IS NULL AND t.total_cents > 0 AND t.type NOT IN ('purchase_order', 'estimate')
            AND NOT EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.txn_id) ORDER BY t.txn_id`, [e.org_id, e.entity_id]);
      if (repair) for (const r of rows) await repost(tx, e.org_id, r.txn_id);
      return rows.length;
    });
  }
  return { entities: entities.length, reposted: repair ? reposted : 0, missing: repair ? 0 : reposted };
}

// ---- chart of accounts ----

export async function listAccounts(db, { orgId, entityId, includeInactive = true }) {
  const { rows } = await db.query(
    `SELECT a.*, p.name AS parent_name,
            coalesce((SELECT sum(amount_cents) FROM posting WHERE account_id = a.account_id), 0)::bigint AS raw_balance
       FROM account a LEFT JOIN account p ON p.account_id = a.parent_id
      WHERE a.org_id = $1 AND a.entity_id = $2 ${includeInactive ? '' : 'AND a.active'}
      ORDER BY a.number NULLS LAST, lower(a.name)`, [orgId, entityId]);
  return rows.map(a => ({ ...a, type_label: TYPE_LABEL[a.type], group: TYPE_GROUP[a.type], balance_cents: a.raw_balance * normalSign(a.type) }));
}

export async function accountsOfTypes(db, { orgId, entityId, types }) {
  const { rows } = await db.query(
    `SELECT account_id, name, number, type, system_key FROM account
      WHERE org_id = $1 AND entity_id = $2 AND active AND type = ANY($3) ORDER BY number NULLS LAST, lower(name)`,
    [orgId, entityId, types]);
  return rows;
}

export async function getAccount(db, { orgId, entityId, accountId }) {
  const all = await listAccounts(db, { orgId, entityId });
  return all.find(a => a.account_id === accountId) ?? null;
}

// fields: { name, number, type, parentId, description, active } (form strings / booleans).
export async function saveAccount(pool, { orgId, entityId, accountId = null, fields: f }) {
  const name = text(f.name, 100);
  if (!name) fail('Give the account a name.');
  const number = text(f.number, 20);
  if (number && !/^[0-9A-Za-z.-]+$/.test(number)) fail('Account numbers can use digits, letters, dots and dashes.');
  const parentId = formId(f.parentId, () => fail('One of the choices isn’t valid. Reload the page and try again.'));
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    let existing = null;
    if (accountId) {
      existing = (await tx.query('SELECT * FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 FOR UPDATE',
        [orgId, entityId, accountId])).rows[0] ?? fail('Account not found.');
    }
    const type = existing?.system_key ? existing.type : f.type;
    if (!TYPE_LABEL[type]) fail('Choose an account type.');
    if (!existing?.system_key && RESERVED_TYPES.has(type)) fail(`Only the built-in ${TYPE_LABEL[type]} account can have that type.`);
    const active = existing?.system_key ? true : f.active !== false;
    if (existing && existing.type !== type) {
      const used = await tx.query('SELECT 1 FROM posting WHERE account_id = $1 LIMIT 1', [accountId]);
      if (used.rowCount && TYPE_GROUP[existing.type] !== TYPE_GROUP[type]) {
        fail(`This account has transactions, so it can only move to another ${TYPE_GROUP[existing.type]} type.`);
      }
      // A loan paired with another company's (Loans page) stays on its side of the books: a receivable for a payable. Its
      // sub-accounts take the new type too, so theirs count.
      if (!LOAN_TYPES.includes(type) || TYPE_GROUP[existing.type] !== TYPE_GROUP[type]) {
        const paired = (await tx.query('SELECT name FROM account WHERE org_id = $1 AND (account_id = $2 OR parent_id = $2) AND loan_other_account_id IS NOT NULL LIMIT 1',
          [orgId, accountId])).rows[0];
        if (paired) fail(`“${paired.name}” is paired with a loan in another company, so it stays a loan on the ${TYPE_GROUP[existing.type]} side. Clear the pairing on Lending → Loans first.`);
      }
    }
    if (parentId !== null) {
      if (existing?.system_key) fail('Built-in accounts can’t be sub-accounts.');
      const p = (await tx.query('SELECT type, parent_id FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3',
        [orgId, entityId, parentId])).rows[0] ?? fail('Choose a valid parent account.');
      if (parentId === accountId) fail('An account can’t be its own parent.');
      if (p.parent_id !== null) fail('Sub-accounts go one level deep: pick a top-level parent.');
      if (p.type !== type) fail('A sub-account must have the same type as its parent.');
      if (accountId) {
        const kids = await tx.query('SELECT 1 FROM account WHERE parent_id = $1 LIMIT 1', [accountId]);
        if (kids.rowCount) fail('This account has sub-accounts, so it can’t become a sub-account itself.');
      }
    }
    if (existing && !active && existing.active) await assertCanRetire(tx, orgId, existing, 'made inactive');
    const values = [name, number, type, parentId, text(f.description, 300), active];
    try {
      if (existing) {
        await tx.query(`UPDATE account SET name = $3, number = $4, type = $5, parent_id = $6, description = $7, active = $8
                         WHERE org_id = $1 AND account_id = $2`, [orgId, accountId, ...values]);
        if (existing.type !== type) {
          await tx.query('UPDATE account SET type = $3 WHERE org_id = $1 AND parent_id = $2', [orgId, accountId, type]);
        }
        return accountId;
      }
      return (await tx.query(
        `INSERT INTO account (org_id, entity_id, name, number, type, parent_id, description, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING account_id`, [orgId, entityId, ...values])).rows[0].account_id;
    } catch (error) {
      if (error?.code === '23505') fail(/number/.test(error.constraint ?? error.detail ?? '') ? `Account number ${number} is already used.` : `An account named “${name}” already exists.`);
      throw error;
    }
  });
}

async function assertCanRetire(tx, orgId, a, verb) {
  if (a.system_key) fail(`“${a.name}” is built in and can’t be ${verb}.`);
  const bal = (await tx.query('SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM posting WHERE account_id = $1', [a.account_id])).rows[0].n;
  if (bal !== 0) fail(`“${a.name}” still has a balance. Move it to another account before it can be ${verb}.`);
  const kids = await tx.query('SELECT 1 FROM account WHERE parent_id = $1 AND active LIMIT 1', [a.account_id]);
  if (kids.rowCount) fail(`“${a.name}” has active sub-accounts.`);
  const items = await tx.query('SELECT name FROM item WHERE income_account_id = $1 AND active LIMIT 1', [a.account_id]);
  if (items.rowCount) fail(`“${items.rows[0].name}” uses “${a.name}” as its income account. Change the product first.`);
}

export async function deleteAccount(pool, { orgId, entityId, accountId }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const a = (await tx.query('SELECT * FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 FOR UPDATE',
      [orgId, entityId, accountId])).rows[0] ?? fail('Account not found.');
    await assertCanRetire(tx, orgId, a, 'deleted');
    // Paired with the same loan in another company (Loans page): both accounts name each other, so unpair it first.
    if (a.loan_other_account_id) fail(`“${a.name}” is paired with a loan in another company. Clear that on Lending → Loans first.`);
    const used = await tx.query(
      `SELECT 1 FROM posting WHERE account_id = $1 UNION ALL SELECT 1 FROM txn WHERE account_id = $1
       UNION ALL SELECT 1 FROM deposit_line WHERE account_id = $1 UNION ALL SELECT 1 FROM item WHERE income_account_id = $1
       UNION ALL SELECT 1 FROM account WHERE parent_id = $1 LIMIT 1`, [accountId]);
    const inUse = () => fail(`“${a.name}” has been used, so it can’t be deleted. Make it inactive instead.`);
    if (used.rowCount) inUse();
    // Anything else that still names the account (a voided transaction's lines, recurring templates, items, budgets…)
    // is caught by the database's references and gets the same message.
    try {
      await tx.query('DELETE FROM account WHERE org_id = $1 AND account_id = $2', [orgId, accountId]);
    } catch (error) {
      if (error.code === '23503') inUse();
      throw error;
    }
    return a;
  });
}

// Newest-first register for one account with a running balance (in the account's normal direction).
export async function accountRegister(db, { orgId, accountId, type, limit = 500 }) {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT p.posting_id, p.txn_id, p.txn_date, p.amount_cents, p.line_no, t.type, t.doc_number, t.payment_ref, t.memo, t.voided_at,
              c.display_name AS customer_name, c.customer_id, v.display_name AS vendor_name, v.vendor_id,
              sum(p.amount_cents) OVER (ORDER BY p.txn_date, p.posting_id) AS running
         FROM posting p JOIN txn t ON t.txn_id = p.txn_id LEFT JOIN customer c ON c.customer_id = p.customer_id
         LEFT JOIN vendor v ON v.vendor_id = coalesce(p.vendor_id, t.vendor_id)
        WHERE p.org_id = $1 AND p.account_id = $2) r
      ORDER BY txn_date DESC, posting_id DESC LIMIT $3`, [orgId, accountId, limit]);
  const sign = normalSign(type);
  return rows.map(r => ({ ...r, amount: r.amount_cents * sign, balance: Number(r.running) * sign }));
}

// Whole-company checks: debits = credits, and A/R equals what customers owe.
export async function ledgerCheck(db, { orgId, entityId }) {
  const { rows: [tb] } = await db.query(
    `SELECT coalesce(sum(amount_cents) FILTER (WHERE amount_cents > 0), 0)::bigint AS debits,
            coalesce(-sum(amount_cents) FILTER (WHERE amount_cents < 0), 0)::bigint AS credits
       FROM posting WHERE org_id = $1 AND entity_id = $2`, [orgId, entityId]);
  const { rows: [ar] } = await db.query(
    // (A revaluation and its next-day reversal are both posted at once, so together they add nothing here.)
    `SELECT coalesce((SELECT sum(p.amount_cents) FROM posting p JOIN account a ON a.account_id = p.account_id
                       WHERE p.org_id = $1 AND p.entity_id = $2 AND a.system_key = 'ar'), 0)::bigint AS ledger,
            coalesce((SELECT sum(CASE WHEN type IN ('invoice', 'late_fee') THEN open_cents ELSE -open_cents END) FROM txn
                       WHERE org_id = $1 AND entity_id = $2 AND type IN ('invoice', 'late_fee', 'payment', 'credit_memo')), 0)::bigint AS open`,
    [orgId, entityId]);
  const { rows: [ap] } = await db.query(
    `SELECT coalesce((SELECT -sum(p.amount_cents) FROM posting p JOIN account a ON a.account_id = p.account_id
                       WHERE p.org_id = $1 AND p.entity_id = $2 AND a.system_key = 'ap'), 0)::bigint AS ledger,
            coalesce((SELECT sum(CASE WHEN type IN ('bill', 'item_receipt') THEN open_cents ELSE -open_cents END) FROM txn
                       WHERE org_id = $1 AND entity_id = $2 AND type IN ('bill', 'item_receipt', 'vendor_credit', 'bill_payment')), 0)::bigint AS open`,
    [orgId, entityId]);
  const { rows: [iv] } = await db.query(
    `SELECT coalesce((SELECT sum(p.amount_cents) FROM posting p JOIN item i ON i.item_id = p.item_id AND i.kind = 'inventory'
                       JOIN account a ON a.account_id = p.account_id AND a.account_id = coalesce(i.asset_account_id, (SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND system_key = 'inventory'))
                      WHERE p.org_id = $1 AND p.entity_id = $2), 0)::bigint AS ledger,
            coalesce((SELECT sum(value_cents) FROM item WHERE org_id = $1 AND entity_id = $2 AND kind = 'inventory'), 0)::bigint AS onhand`, [orgId, entityId]);
  return { debits: tb.debits, credits: tb.credits, balanced: tb.debits === tb.credits, arLedger: ar.ledger, arOpen: ar.open, arMatches: ar.ledger === ar.open,
    apLedger: ap.ledger, apOpen: ap.open, apMatches: ap.ledger === ap.open,
    inventoryLedger: iv.ledger, inventoryOnHand: iv.onhand, inventoryMatches: iv.ledger === iv.onhand };
}
