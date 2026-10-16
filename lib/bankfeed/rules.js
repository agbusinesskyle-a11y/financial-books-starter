import { createHash } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError } from '../data/writes.js';
import { getBankItem, matchCandidates, confidentMatch, matchItemTx, addItemTx, possibleDuplicates, itemToken } from '../data/banking.js';
import { lockEntity } from '../data/writes.js';
import { parseMoney } from '../domain/money.js';
import { wordingHistory, wordingSuggestion, namedParties, researchKey, wordingAccounts } from './wording.js';
import { researchFits } from '../ai/vendor-research.js';

// Bank rules and learning (stage B4). For each bank item waiting for review, one suggestion, with where it came from:
//   match   — exactly one books transaction fits (stage B3);
//   rule    — the first rule (by priority) whose conditions fit;
//   history — how earlier bank items with the same description were added (payee and category), with how sure it is.
// "auto" rules add an item as soon as it arrives, unless the books already have a match for it.

const fail = message => { throw new ValidationError(message); };
export const TEXT_OPS = { contains: 'contains', not_contains: 'doesn’t contain', is: 'is exactly', starts: 'starts with' };
export const AMOUNT_OPS = { equals: 'equals', more: 'is more than', less: 'is less than', between: 'is between' };

// ---- rules ----

export async function listRules(db, { orgId, entityId }) {
  const { rows } = await db.query(`
    SELECT r.*, r.ll_account_id::text AS ll_account, a.name AS account_name, l.display_name AS feed_name, ba.name AS feed_books_name,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.rule_id = r.rule_id) AS auto_added
      FROM bank_rule r LEFT JOIN account a ON a.account_id = r.account_id
      LEFT JOIN ledgerline_account l ON l.entity_id = r.entity_id AND l.ll_account_id = r.ll_account_id LEFT JOIN account ba ON ba.account_id = l.books_account_id
     WHERE r.org_id = $1 AND r.entity_id = $2 ORDER BY r.priority, r.rule_id`, [orgId, entityId]);
  return rows;
}

export async function getRule(db, { orgId, entityId, ruleId }) {
  const { rows: [r] } = await db.query('SELECT *, ll_account_id::text AS ll_account FROM bank_rule WHERE org_id = $1 AND entity_id = $2 AND rule_id = $3',
    [orgId, entityId, Number(ruleId) || 0]);
  return r ?? null;
}

// Form values → a checked rule, not saved (the rule form's Save and Test both use it). f.conditions: [{ field, op, value,
// value2 }] as typed (amounts like 25.00; field description, bank_text or amount). f.llAccounts: the fed accounts (none:
// all). f.splits: [{ accountId, percent, amount, description }] as typed — when two or more are filled the rule splits
// (fixed amounts first, then percentages of what's left, which must come to 100%) and f.accountId is not used. Every id is
// checked against this company. Returns the row values saveRule stores.
export async function checkRule(db, { orgId, entityId, ruleId = null, fields: f }) {
  const name = String(f.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!name) fail('Give the rule a name.');
  if (!['in', 'out'].includes(f.money)) fail('Choose money in or money out.');
  const conditions = [];
  for (const [i, c] of (f.conditions ?? []).entries()) {
    const value = String(c.value ?? '').trim();
    if (!value && !String(c.value2 ?? '').trim()) continue;
    const where = `Condition ${i + 1}`;
    if (c.field === 'description' || c.field === 'bank_text') {
      if (!TEXT_OPS[c.op]) fail(`${where}: choose how the ${c.field === 'bank_text' ? 'bank text' : 'description'} is compared.`);
      if (!value) fail(`${where}: enter the text to look for.`);
      conditions.push({ field: c.field, op: c.op, value: value.slice(0, 200) });
    } else if (c.field === 'amount') {
      if (!AMOUNT_OPS[c.op]) fail(`${where}: choose how the amount is compared.`);
      const a = parseMoney(value), b = c.op === 'between' ? parseMoney(String(c.value2 ?? '').trim()) : null;
      if (a === null || a < 0 || (c.op === 'between' && (b === null || b < a))) fail(`${where}: enter amounts like 25.00${c.op === 'between' ? ', the second not smaller than the first' : ''}.`);
      conditions.push({ field: 'amount', op: c.op, value: a, ...(c.op === 'between' ? { value2: b } : {}) });
    } else fail(`${where}: choose description, bank text or amount.`);
  }
  if (!conditions.length) fail('Add at least one condition, like “Description contains SHELL”.');
  const payee = /^[cv]:\d{1,18}$/.test(String(f.payee ?? '')) ? f.payee : null;
  const classId = Number(f.classId) || null, locationId = Number(f.locationId) || null;
  const splits = [];
  for (const [i, s] of (f.splits ?? []).entries()) {
    const pct = String(s.percent ?? '').trim().replace(/%$/, ''), amt = String(s.amount ?? '').trim();
    if (!String(s.accountId ?? '').trim() && !pct && !amt) continue;
    const where = `Split line ${i + 1}`;
    if (!Number(s.accountId)) fail(`${where}: choose a category.`);
    if (pct && amt) fail(`${where}: enter a percentage or an amount, not both.`);
    const description = String(s.description ?? '').trim().slice(0, 300);
    if (pct) {
      const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(pct);
      const bp = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
      if (!bp || bp > 10000) fail(`${where}: enter a percentage like 60 or 12.5.`);
      splits.push({ accountId: Number(s.accountId), percent: bp, description });
    } else {
      const cents = parseMoney(amt);
      if (!cents) fail(`${where}: enter a percentage like 60, or an amount like 25.00.`);
      splits.push({ accountId: Number(s.accountId), cents, description });
    }
  }
  if (splits.length === 1) fail('A split needs two lines or more. For one category, choose it above.');
  if (splits.length) {
    const pcts = splits.filter(s => s.percent !== undefined);
    if (!pcts.length) fail('A split needs at least one percentage line to take what’s left after the fixed amounts.');
    if (pcts.reduce((t, s) => t + s.percent, 0) !== 10000) fail('The split’s percentages must come to 100%.');
  }
  const accountId = splits.length ? splits[0].accountId : Number(f.accountId) || null;
  if (!accountId && !payee) fail('Choose what the rule assigns: at least a category or a payee.');
  if (f.mode === 'auto' && !accountId) fail('A rule that adds items automatically needs a category.');
  const llAccounts = [...new Set((f.llAccounts ?? (f.llAccount ? [f.llAccount] : [])).map(String).filter(Boolean))];
  for (const id of llAccounts) {
    if (!(await db.query('SELECT 1 FROM ledgerline_account WHERE org_id = $1 AND entity_id = $2 AND ll_account_id::text = $3', [orgId, entityId, id])).rowCount) {
      fail('Choose this company’s bank accounts, or all of them.');
    }
  }
  for (const id of new Set([accountId, ...splits.map(s => s.accountId)].filter(Boolean))) {
    const { rows: [a] } = await db.query('SELECT system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active', [orgId, entityId, id]);
    if (!a || ['ar', 'ap', 'undeposited'].includes(a.system_key)) fail('Choose a category the books can use.');
  }
  if (payee) {
    const [kind, id] = payee.split(':');
    const table = kind === 'v' ? 'vendor' : 'customer';
    if (!(await db.query(`SELECT 1 FROM ${table} WHERE org_id = $1 AND entity_id = $2 AND ${table}_id = $3`, [orgId, entityId, Number(id)])).rowCount) fail('Choose a valid payee.');
  }
  if (classId && !(await db.query('SELECT 1 FROM class WHERE org_id = $1 AND entity_id = $2 AND class_id = $3', [orgId, entityId, classId])).rowCount) fail('Choose a valid class.');
  if (locationId && !(await db.query('SELECT 1 FROM location WHERE org_id = $1 AND entity_id = $2 AND location_id = $3', [orgId, entityId, locationId])).rowCount) fail('Choose a valid location.');
  const dupe = await db.query('SELECT 1 FROM bank_rule WHERE org_id = $1 AND entity_id = $2 AND lower(name) = lower($3) AND rule_id <> coalesce($4, 0)', [orgId, entityId, name, ruleId]);
  if (dupe.rowCount) fail(`A rule named “${name}” already exists.`);
  return { name, priority: priorityOf(f.priority), active: f.active !== false, money: f.money, ll_account_id: llAccounts.length === 1 ? llAccounts[0] : null,
    ll_account_ids: llAccounts.length ? llAccounts : null, match_all: f.matchAll !== false, conditions, payee, account_id: accountId, class_id: classId,
    location_id: locationId, memo: String(f.memo ?? '').trim().slice(0, 500) || null, memo_mode: f.memoMode === 'append' ? 'append' : 'replace',
    mode: f.mode === 'auto' ? 'auto' : 'suggest', splits: splits.length ? splits : null };
}

export async function saveRule(pool, { orgId, entityId, ruleId = null, fields: f, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const r = await checkRule(tx, { orgId, entityId, ruleId, fields: f });
    const values = [orgId, entityId, r.name, r.priority, r.active, r.money, r.ll_account_id, r.match_all, JSON.stringify(r.conditions), r.payee, r.account_id, r.class_id,
      r.location_id, r.memo, r.mode, r.ll_account_ids, r.splits ? JSON.stringify(r.splits) : null, r.memo_mode];
    if (ruleId) {
      const { rowCount } = await tx.query(`UPDATE bank_rule SET name = $3, priority = $4, active = $5, money = $6, ll_account_id = $7, match_all = $8, conditions = $9,
          payee = $10, account_id = $11, class_id = $12, location_id = $13, memo = $14, mode = $15, ll_account_ids = $16, splits = $17, memo_mode = $18, updated_at = now()
        WHERE org_id = $1 AND entity_id = $2 AND rule_id = $19`, [...values, ruleId]);
      if (!rowCount) fail('Rule not found.');
      return Number(ruleId);
    }
    const { rows: [x] } = await tx.query(`INSERT INTO bank_rule (org_id, entity_id, name, priority, active, money, ll_account_id, match_all, conditions, payee, account_id,
        class_id, location_id, memo, mode, ll_account_ids, splits, memo_mode, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING rule_id`, [...values, actor]);
    return Number(x.rule_id);
  });
}

// The order a rule runs in: blank means 100; otherwise a whole number 0–9999, kept exactly (0 runs first).
export function priorityOf(text) {
  const s = String(text ?? '').trim();
  if (!s) return 100;
  if (!/^\d{1,4}$/.test(s)) fail('Order: enter a whole number from 0 to 9999 (lower runs first).');
  return Number(s);
}

export async function deleteRule(pool, { orgId, entityId, ruleId }) {
  await withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rowCount } = await tx.query('DELETE FROM bank_rule WHERE org_id = $1 AND entity_id = $2 AND rule_id = $3', [orgId, entityId, Number(ruleId) || 0]);
    if (!rowCount) fail('Rule not found.');
  });
}

const testText = (text, c) => {
  const t = String(text ?? '').toUpperCase(), v = String(c.value).toUpperCase();
  return c.op === 'contains' ? t.includes(v) : c.op === 'not_contains' ? !t.includes(v) : c.op === 'is' ? t.trim() === v.trim() : t.startsWith(v);
};
const testAmount = (cents, c) => (c.op === 'equals' ? cents === c.value : c.op === 'more' ? cents > c.value : c.op === 'less' ? cents < c.value
  : cents >= c.value && cents <= c.value2);

// The fed accounts a rule applies to (empty: all of them).
export const ruleAccounts = rule => (rule.ll_account_ids?.length ? rule.ll_account_ids.map(String) : rule.ll_account_id ? [String(rule.ll_account_id)] : []);

// Does a rule fit a bank item? Amount conditions compare the size of the amount (money in/out is its own setting); "bank
// text" conditions look at the bank's own original description. A split whose fixed amounts come to more than the bank
// amount doesn't fit.
export function ruleFits(rule, item) {
  if (!rule.active) return false;
  if ((rule.money === 'out') !== (Number(item.amount_cents) < 0)) return false;
  const accounts = ruleAccounts(rule);
  if (accounts.length && !accounts.includes(String(item.ll_account ?? item.ll_account_id))) return false;
  const tests = (rule.conditions ?? []).map(c => (c.field === 'amount' ? testAmount(Math.abs(Number(item.amount_cents)), c)
    : c.field === 'bank_text' ? testText(item.original_description ?? item.description ?? '', c)
    : testText(`${item.description ?? ''} ${c.op === 'not_contains' || c.op === 'is' || c.op === 'starts' ? '' : item.merchant_name ?? ''}`.trim(), c)));
  if (!tests.length) return false;
  if (!(rule.match_all ? tests.every(Boolean) : tests.some(Boolean))) return false;
  return ruleAction(rule, item) !== null;
}

// What a rule records for a bank line: the category lines (the whole amount to its category, or its split — fixed amounts
// first, then percentages of what's left, the last percentage line taking the rounding; a line that comes to nothing is
// left out), the payee, the memo (the rule's, or the bank description with the rule's added), class and location.
// lines: [{ accountId, cents, amount (text), description }] — empty for a rule that only sets a payee. Null when the split's
// fixed amounts come to more than the bank amount.
export function ruleAction(rule, item) {
  const amount = Math.abs(Number(item.amount_cents));
  let lines = [];
  if (rule.splits?.length) {
    const fixed = rule.splits.filter(s => s.cents !== undefined && s.cents !== null).reduce((t, s) => t + Number(s.cents), 0);
    if (fixed > amount) return null;
    const share = amount - fixed;
    const pcts = rule.splits.filter(s => s.percent !== undefined && s.percent !== null);
    let given = 0;
    lines = rule.splits.map(s => {
      if (s.percent === undefined || s.percent === null) return { accountId: Number(s.accountId), cents: Number(s.cents), description: s.description ?? '' };
      const last = s === pcts[pcts.length - 1];
      const cents = last ? share - given : Math.floor((share * Number(s.percent)) / 10000);
      given += cents;
      return { accountId: Number(s.accountId), cents, description: s.description ?? '' };
    }).filter(l => l.cents > 0);
  } else if (rule.account_id) lines = [{ accountId: Number(rule.account_id), cents: amount, description: '' }];
  const memo = rule.memo ? (rule.memo_mode === 'append' ? `${item.description ?? ''} ${rule.memo}`.trim() : rule.memo) : '';
  return { lines: lines.map(l => ({ ...l, amount: (l.cents / 100).toFixed(2) })), payee: rule.payee ?? '', memo,
    dims: { ...(rule.class_id ? { classId: Number(rule.class_id) } : {}), ...(rule.location_id ? { locationId: Number(rule.location_id) } : {}) } };
}

// ---- learning from history ----

// The part of a bank description that names who it was: no store numbers, reference numbers, dates or punctuation.
export function payeeKey(text) {
  return String(text ?? '').toUpperCase()
    .replace(/\b(POS|ACH|DEBIT|CREDIT|PURCHASE|CHECKCARD|CHECK CARD|RECURRING|PAYMENT|ONLINE|WEB|PPD|ID|REF|TRANSFER|TO|FROM)\b/g, ' ')
    .replace(/[^A-Z ]+/g, ' ').replace(/\b[A-Z]\b/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
}

// How this company added earlier bank items: key → [{ payee, accountId, classId, locationId, count }], most used first.
// wording: a wording corpus already loaded (a batch reuses the one it loaded first: wording suggestions are never taken by
// a batch, so an older corpus can only make a plan differ from what was shown — skipped — never post something unseen).
export async function learnedHistory(db, { orgId, entityId, wording = null }) {
  const { rows } = await db.query(`
    SELECT i.description, i.merchant_name, i.amount_cents < 0 AS out, txn_party_key(t.txn_id) AS party_key, t.class_id, t.location_id,
           (SELECT array_agg(DISTINCT p.account_id) FROM posting p WHERE p.txn_id = t.txn_id AND p.account_id <> l.books_account_id) AS others
      FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id
      JOIN bank_feed_link k ON k.item_id = i.item_id AND k.how = 'added' JOIN txn t ON t.txn_id = k.txn_id
     WHERE i.org_id = $1 AND i.entity_id = $2 AND t.type IN ('expense', 'check', 'deposit', 'journal_entry', 'cc_credit') AND t.voided_at IS NULL
       -- Only a transaction that is the whole bank line teaches (not a settlement's fee adjustment).
       AND (SELECT coalesce(sum(p.amount_cents), 0) FROM posting p WHERE p.txn_id = t.txn_id AND p.account_id = l.books_account_id) = i.amount_cents
       AND NOT EXISTS (SELECT 1 FROM posting p JOIN account a ON a.account_id = p.account_id WHERE p.txn_id = t.txn_id AND a.system_key IN ('ar', 'ap', 'undeposited'))
     ORDER BY i.posted_date DESC LIMIT 5000`, [orgId, entityId]);
  const byKey = new Map();
  for (const r of rows) {
    if (!r.others || r.others.length !== 1) continue; // only single-category adds teach anything
    const key = `${r.out ? 'out' : 'in'}|${payeeKey(r.merchant_name || r.description)}`;
    if (key.endsWith('|')) continue;
    const payee = r.party_key ?? null;
    const sig = `${payee}|${r.others[0]}|${r.class_id ?? ''}|${r.location_id ?? ''}`;
    const list = byKey.get(key) ?? new Map();
    const e = list.get(sig) ?? { payee, accountId: Number(r.others[0]), classId: r.class_id, locationId: r.location_id, count: 0 };
    e.count++;
    list.set(sig, e);
    byKey.set(key, list);
  }
  const out = new Map([...byKey].map(([k, list]) => [k, [...list.values()].sort((a, b) => b.count - a.count)]));
  out.books = await booksHistory(db, { orgId, entityId });
  out.wording = wording ?? await wordingHistory(db, { orgId, entityId });
  out.active = await activeRecords(db, { orgId, entityId });
  out.openParties = await openParties(db, { orgId, entityId });
  // The company's credit card accounts, with the last fours their feeds bring in (card payments, stage S1).
  out.cards = (await db.query(`SELECT a.account_id, a.name, coalesce(array_agg(l.mask) FILTER (WHERE l.mask IS NOT NULL), '{}') AS masks
      FROM account a LEFT JOIN ledgerline_account l ON l.entity_id = a.entity_id AND l.books_account_id = a.account_id
     WHERE a.org_id = $1 AND a.entity_id = $2 AND a.type = 'credit_card' AND a.active GROUP BY a.account_id, a.name`, [orgId, entityId])).rows
    .map(r => ({ id: Number(r.account_id), name: r.name, masks: r.masks.map(String) }));
  // Every active vendor and customer by name: who a bank line names (stage S4).
  out.parties = (await db.query(`SELECT 'v:' || vendor_id AS key, display_name AS name, 'vendor' AS kind FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active
    UNION ALL SELECT 'c:' || customer_id, display_name, 'customer' FROM customer WHERE org_id = $1 AND entity_id = $2 AND active`, [orgId, entityId])).rows;
  return out;
}

// The books' own history (stage BR-4): what each vendor's expenses, checks and bills went to over the last 24 months
// (imported QuickBooks history counts) — the categories they debited, by how many transactions used each and when last.
// key: the vendor's name as a payee key, to recognise it in a bank description.
export async function booksHistory(db, { orgId, entityId }) {
  const { rows: vendors } = await db.query('SELECT vendor_id, display_name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active', [orgId, entityId]);
  const { rows } = await db.query(`
    WITH v AS (SELECT t.txn_id, t.vendor_id, t.txn_date, t.account_id AS paid_from FROM txn t
                WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type IN ('expense', 'check', 'bill') AND t.voided_at IS NULL AND t.vendor_id IS NOT NULL
                  AND t.txn_date >= current_date - interval '24 months')
    -- What each purchase was for: every posting apart from the one on the account it was paid from (an expense or check) or
    -- on A/P (a bill), with its sign. Only a purchase that went wholly to one ordinary account — one account, debited, not a
    -- system account (stock, A/R, …) — teaches that account for a whole bank line. A split purchase, a negative line, a card
    -- payment with a fee, stock: they only count in "of".
    , parts AS (SELECT v.txn_id, v.vendor_id, v.txn_date, p.account_id, p.amount_cents, a.system_key FROM v JOIN posting p ON p.txn_id = v.txn_id
                  JOIN account a ON a.account_id = p.account_id
                 WHERE p.account_id IS DISTINCT FROM v.paid_from AND a.system_key IS DISTINCT FROM 'ap')
    , whole AS (SELECT txn_id, vendor_id, max(txn_date) AS txn_date, min(account_id) AS account_id FROM parts GROUP BY txn_id, vendor_id
                HAVING count(DISTINCT account_id) = 1 AND bool_and(system_key IS NULL) AND bool_and(amount_cents > 0))
    SELECT w.vendor_id, w.account_id, count(*)::int AS count, max(w.txn_date)::text AS last,
           (SELECT count(*)::int FROM v x WHERE x.vendor_id = w.vendor_id) AS of
      FROM whole w GROUP BY w.vendor_id, w.account_id`, [orgId, entityId]);
  const byVendor = new Map();
  for (const r of rows) {
    const list = byVendor.get(Number(r.vendor_id)) ?? [];
    list.push({ accountId: Number(r.account_id), count: r.count, last: r.last, of: r.of });
    byVendor.set(Number(r.vendor_id), list);
  }
  for (const list of byVendor.values()) list.sort((a, b) => b.count - a.count || b.last.localeCompare(a.last) || a.accountId - b.accountId);
  return { vendors: vendors.map(v => ({ id: Number(v.vendor_id), name: v.display_name, key: payeeKey(v.display_name) })).filter(v => v.key.length >= 3), byVendor };
}

// The one vendor a bank description names, if exactly one does: the same payee key, or (four letters or more) one key
// starting with the other — "HOME DEPOT" in "THE HOME DEPOT" doesn't count, "LOWES" for "LOWES HOME" does.
export function vendorFor(books, item) {
  if (!books) return null;
  const k = payeeKey(item.merchant_name || item.description);
  if (!k) return null;
  const exact = books.vendors.filter(v => v.key === k);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const near = k.length >= 4 ? books.vendors.filter(v => v.key.length >= 4 && (v.key.startsWith(`${k} `) || k.startsWith(`${v.key} `))) : [];
  return near.length === 1 ? near[0] : null;
}

// The company's active categories and payees (v:/c: keys): a suggestion never names an inactive record.
async function activeRecords(db, { orgId, entityId }) {
  const { rows } = await db.query(`SELECT 'a:' || account_id AS k FROM account WHERE org_id = $1 AND entity_id = $2 AND active
    UNION ALL SELECT 'v:' || vendor_id FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active
    UNION ALL SELECT 'c:' || customer_id FROM customer WHERE org_id = $1 AND entity_id = $2 AND active`, [orgId, entityId]);
  return new Set(rows.map(r => r.k));
}
// Who has open bills (money out) or open invoices (money in), with how many and how much (stage S4).
async function openParties(db, { orgId, entityId }) {
  const { rows } = await db.query(`SELECT txn_party_key(t.txn_id) AS key, txn_party(t.txn_id) AS name, t.type, count(*)::int AS n, sum(t.open_cents)::bigint AS total
      FROM txn t WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type IN ('bill', 'invoice') AND t.voided_at IS NULL AND t.open_cents > 0 AND t.currency IS NULL
     GROUP BY 1, 2, 3`, [orgId, entityId]);
  return rows.filter(r => r.key).map(r => ({ key: r.key, name: r.name, type: r.type, n: r.n, total: Number(r.total) }));
}
// The one party with open documents the bank line names (by the bank wording's payee, or its name in the text), if
// exactly one does: "34 open invoices from Q&Z Farm & Home" — for a person to choose which in Find match. Never a guess at
// which documents.
function openDocsHint(history, item, worded) {
  const out = Number(item.amount_cents) < 0;
  if (out ? !['bank', 'credit_card'].includes(item.books_type) : item.books_type !== 'bank') return null;
  const who = namedBy(history, item, worded);
  if (who.length !== 1) return null;
  const open = (history?.openParties ?? []).find(p => p.type === (out ? 'bill' : 'invoice') && p.key === who[0]);
  return open ? { ...open } : null;
}
// Who the bank line names: the bank wording's payee, and the vendors and customers whose names are in its text (the most
// specific of overlapping names). Keys, distinct.
function namedBy(history, item, worded) {
  const keys = new Set(namedParties(history?.parties ?? [], item).map(p => p.key));
  if (worded?.payee) keys.add(worded.payee);
  return [...keys];
}
// The one open bill or invoice this bank line pays (stage S4), when that is all the books hold that could be it: exactly
// one open document for exactly the amount, nothing on the account, nothing waiting. Eligible only if it could be paid
// from here — home currency, dated by 10 days after the bank date, a bill approved — and its party is active. Sure when
// the bank names its party. A person's Match settles it (never a batch).
async function settleSuggestion(db, { orgId, entityId, item, dupes, worded, history }) {
  if (!dupes.length || !dupes.every(d => d.reason === 'open_bill' || d.reason === 'open_invoice') || dupes.length !== 1) return null;
  const { rows: [t] } = await db.query(`SELECT t.txn_id, t.type, t.doc_number, t.txn_date, t.open_cents, t.approval_status, txn_party_key(t.txn_id) AS key,
      txn_party(t.txn_id) AS party, txn_version(t.txn_id) AS version, (t.txn_date <= $4::date + 10) AS in_time
      FROM txn t WHERE t.org_id = $1 AND t.entity_id = $2 AND t.txn_id = $3 AND t.voided_at IS NULL AND t.currency IS NULL`,
  [orgId, entityId, dupes[0].txn_id, item.posted_date]);
  if (!t || Number(t.open_cents) !== Math.abs(Number(item.amount_cents)) || !t.in_time || !t.key) return null;
  if (t.type === 'bill' && t.approval_status !== 'approved') return null;
  if (history?.active && !history.active.has(t.key)) return null;
  // The bank names exactly this party: sure. Names nobody: maybe (a person checks). Names anyone else, or several: not
  // suggested (the named party's open documents are pointed to instead).
  const who = namedBy(history, item, worded);
  if (who.length && !(who.length === 1 && who[0] === t.key)) return null;
  const named = who.length === 1;
  return { source: 'settle', confidence: named ? 'high' : 'medium', named, dupes,
    doc: { txn_id: Number(t.txn_id), type: t.type, doc_number: t.doc_number, txn_date: t.txn_date, open_cents: Number(t.open_cents), party: t.party, version: t.version } };
}
function wordingFor(history, item) {
  if (!history?.wording) return null;
  const active = history.active;
  const w = wordingSuggestion(history.wording, item, { usable: (accountId, payee) => !active || (active.has(`a:${accountId}`) && (!payee || active.has(payee))) });
  return w ? { source: 'history', basis: 'wording', confidence: w.confidence, payee: w.payee, accountId: w.accountId, classId: null, locationId: null, memo: null,
    count: w.count, of: w.of, last: w.last } : null;
}

// ---- one suggestion per item ----

// ctx: { rules, history } loaded once per page. Returns null or
// { source: 'match'|'possible'|'rule'|'history'|'ai', basis?, confidence: 'high'|'medium'|'low', txn?, rule?, payee, accountId, classId, locationId, memo, count, of }.
// Order: a match or anything the books may already hold (a decision for a person) → a rule → how this payee's bank lines
// were reviewed here (a person's own decisions, high or medium) → the same bank wording as earlier transactions in the
// books → the vendor's books history → AI research → anything only weakly suggested. Every suggestion names only active
// records of this company; one that doesn't gives way to the next.
export async function suggestFor(db, { orgId, entityId, item, rules, history, undeposited = null }) {
  const worded = wordingFor(history, item);
  const cands = await matchCandidates(db, { orgId, entityId, item, undeposited });
  const m = confidentMatch(cands, item);
  // Something in the books could already be this item (two candidates, one from weeks ago, a payment waiting to be
  // deposited): a decision for a person — never a new transaction from a rule or history.
  const dupes = await possibleDuplicates(db, { orgId, entityId, item });
  if (m) {
    // One transaction fits — sure only when nothing else could be this line and it isn't for a different payee than the
    // bank wording names.
    const others = dupes.filter(d => Number(d.txn_id) !== Number(m.txn_id));
    const { rows: [k] } = worded?.payee ? await db.query('SELECT txn_party_key($1) AS key', [m.txn_id]) : { rows: [] };
    if (!others.length && !(k?.key && k.key !== worded.payee)) return { source: 'match', confidence: 'high', txn: m };
    // The evidence exactly as possibleDuplicates gives it (the row's "Post as new" carries its token); the match itself
    // only when it isn't evidence there (then nothing blocks a new one).
    const list = dupes.length ? dupes : [{ ...m, reason: 'on_account' }];
    return withOpenDocs({ source: 'possible', confidence: 'low', count: list.length, dupes: list, txn: m, fill: await categorize(db, { orgId, entityId, item, rules, history, worded }) },
      history, item, worded);
  }
  // A possible duplicate is still a person's decision (never batch, never a rule's add), but the row is filled in with what
  // it would be if it is a new one, for "Post as new" (stage S1).
  if (dupes.length) {
    const settle = await settleSuggestion(db, { orgId, entityId, item, dupes, worded, history });
    if (settle) return settle;
    return withOpenDocs({ source: 'possible', confidence: 'low', count: dupes.length, dupes, txn: dupes[0], fill: await categorize(db, { orgId, entityId, item, rules, history, worded }) },
      history, item, worded);
  }
  return withOpenDocs(await categorize(db, { orgId, entityId, item, rules, history, worded }), history, item, worded);
}
// A party the line names has open documents (several, or none for this exact amount): shown with whatever is suggested,
// or alone, as a pointer to Find match. Changes nothing a batch would do.
function withOpenDocs(s, history, item, worded) {
  const hint = openDocsHint(history, item, worded);
  if (!hint) return s;
  return s ? { ...s, openDocs: hint } : { source: 'open_docs', confidence: 'low', openDocs: hint };
}

// A pending line (stage S2): what it will be suggested as once it posts — the same order as suggestFor without matching
// or the duplicate check (its amount and date can still change; it's worked out again when it posts). Never actionable.
export async function previewFor(db, { orgId, entityId, item, rules, history }) {
  if (!item?.pending) return null;
  return categorize(db, { orgId, entityId, item, rules, history, worded: wordingFor(history, item) });
}

// A payment to a credit card out of a bank account (QuickBooks' Credit card payment): "CRD EPAY", "CARD PMT", "PAYMENT TO …
// CARD", "AMEX EPAYMENT", "CARDMEMBER SERV"… Its category is the company's card account it pays: the one whose last four the
// text names, else the only one whose name has the card company's name, else the company's only card. Posting it records a
// card payment (a transfer to the card), paired with the card feed's payment line where there is exactly one.
// Card wording said outright; or a card company's name with a payment word ("AMERICAN EXPRESS ACH PMT").
const CARD_PAYMENT = /\b(CRD EPAY|CREDIT CRD|CARD PMT|CRD PMT|CC PMT|PAYMENT TO .{0,24}CARD|CARD PAYMENT|CARDMEMBER SERV)\b/i;
const PAY_WORD = /\b(PMT|PAYMENT|EPAY|E-PAY|AUTOPAY|AUTO PAY)\b/i;
// A loan, mortgage or lease payment to the same bank is not a card payment.
const NOT_CARD = /\b(LOAN|MORTGAGE|MTG|LEASE|HELOC|AUTO FIN|AUTO LN)\b/i;
// Whole words only: "CHASE" isn't in "PURCHASE", "CITI" isn't "CITIZENS".
const ISSUERS = [['CHASE', /\bCHASE\b/i], ['AMEX', /\bAMEX\b|\bAMERICAN EXPRESS\b/i], ['CITI', /\bCITI(CARD|BANK)?\b/i], ['DISCOVER', /\bDISCOVER\b/i],
  ['CAPITAL ONE', /\bCAPITAL ONE\b|\bCAP ONE\b/i], ['BARCLAY', /\bBARCLAYS?\b/i], ['WELLS', /\bWELLS FARGO\b/i], ['BANK OF AMERICA', /\bBANK OF AMERICA\b|\bBK OF AMER\b/i],
  ['US BANK', /\bU\.?S\.? BANK\b/i], ['SYNCHRONY', /\bSYNCHRONY\b|\bSYNCB\b/i]];
// Whether a bank text is a payment to a card (also used to keep automatic research off such lines).
export function saysCardPayment(text) {
  const issuers = ISSUERS.filter(([, re]) => re.test(text));
  return !NOT_CARD.test(text) && (CARD_PAYMENT.test(text) || (issuers.length === 1 && issuers[0][0] === 'AMEX' && PAY_WORD.test(text)));
}
function cardPaymentFor(history, item) {
  const text = `${item.description ?? ''} ${item.original_description ?? ''}`;
  const said = CARD_PAYMENT.test(text);
  // The card companies the text names: more than one is no answer. A card company's name with a payment word counts only
  // for American Express (cards only); any other bank's name needs card wording too.
  const issuers = ISSUERS.filter(([, re]) => re.test(text));
  const issuer = issuers.length === 1 ? issuers[0] : null;
  if (!(Number(item.amount_cents) < 0) || item.books_type !== 'bank' || NOT_CARD.test(text) || issuers.length > 1) return null;
  if (!(said || (issuer?.[0] === 'AMEX' && PAY_WORD.test(text)))) return null;
  const cards = (history?.cards ?? []);
  if (!cards.length) return null;
  // The whole number the text gives ("ending in 10001" is 10001, not 1000).
  const fours = [...new Set(wordingAccounts(text).concat([...text.matchAll(/ENDING IN (\d+)/gi)].map(m => m[1])))];
  // A card never named for a different card company than the text names.
  const fits = c => !issuer || !ISSUERS.some(([k, re]) => k !== issuer[0] && re.test(c.name));
  const numbered = f => cards.filter(c => c.masks.includes(f) || new RegExp(`(^|\\D)${f}(\\D|$)`).test(c.name));
  let pick, why;
  if (fours.length) {
    // Every number the text names must point at the same one card of this company; a number that names none (another
    // company's card, or a mistake) is no answer — never another card.
    const each = fours.map(numbered);
    if (each.some(m => m.length !== 1) || new Set(each.map(m => m[0].id)).size !== 1) return null;
    pick = each[0];
    why = 'its last four';
  } else {
    pick = issuer ? cards.filter(c => issuer[1].test(c.name)) : [];
    why = 'the card company';
    // The company's only card, only when the text says outright it's a card payment.
    if (pick.length !== 1 && said && cards.length === 1) { pick = cards; why = 'the company’s only card'; }
  }
  if (pick.length !== 1 || !fits(pick[0])) return null;
  // Sure (so batch Accept may take it) only when the text's own number names the card; by the card company's name or as
  // the only card it's likely — a person posts it.
  const s = { source: 'history', basis: 'card', confidence: why === 'its last four' ? 'high' : 'medium', payee: null, accountId: pick[0].id, classId: null, locationId: null,
    memo: null, cardWhy: why };
  return usable(history, s) ? s : null;
}

// What a bank line would be if it's new: a rule, then the history sources, then AI research (see suggestFor).
async function categorize(db, { orgId, entityId, item, rules, history, worded }) {
  const rule = rules.find(r => ruleFits(r, item));
  // (A rule comes first; then a card payment's card.)
  const card = !rule ? cardPaymentFor(history, item) : null;
  if (card) return card;
  if (rule) {
    const act = ruleAction(rule, item);
    const s = { source: 'rule', confidence: 'high', rule, payee: rule.payee, accountId: act.lines[0]?.accountId ?? null, lines: act.lines, split: act.lines.length > 1,
      classId: rule.class_id, locationId: rule.location_id, memo: act.memo };
    // A rule naming an inactive account or payee suggests nothing (a person fixes the rule or reviews the line), rather than
    // something the rule didn't say.
    return usable(history, s) ? s : null;
  }
  const ok = x => x && usable(history, x);
  let reviewed = null;
  const list = history.get(`${Number(item.amount_cents) < 0 ? 'out' : 'in'}|${payeeKey(item.merchant_name || item.description)}`);
  if (list?.length) {
    const top = list[0], of = list.reduce((t, e) => t + e.count, 0);
    const confidence = top.count === of && of >= 3 ? 'high' : top.count >= 2 && top.count / of >= 2 / 3 ? 'medium' : 'low';
    reviewed = { source: 'history', confidence, payee: top.payee, accountId: top.accountId, classId: top.classId, locationId: top.locationId, memo: null, count: top.count, of };
  }
  if (ok(reviewed) && reviewed.confidence !== 'low') return reviewed;
  if (ok(worded)) return worded;
  // The vendor the description names, and what its transactions in the books went to (money out only).
  let books = null;
  const vendor = Number(item.amount_cents) < 0 ? vendorFor(history.books, item) : null;
  const past = vendor ? history.books.byVendor.get(vendor.id) : null;
  if (past?.length) {
    const top = past[0], of = top.of;
    const confidence = top.count === of && of >= 3 ? 'high' : top.count >= 2 && top.count / of >= 2 / 3 ? 'medium' : 'low';
    books = { source: 'history', basis: 'books', confidence, payee: `v:${vendor.id}`, vendorName: vendor.name, accountId: top.accountId, classId: null, locationId: null,
      memo: null, count: top.count, of };
  }
  if (ok(books) && books.confidence !== 'low') return books;
  // AI vendor research (stage B5; on its own after a pull, S5) on this payee, not rejected: a suggestion a person still has
  // to accept. Research proposes vendors: money out only (a deposit is never made a vendor's refund by it).
  // Only while the line still has the payee identity it was researched under (a bank correction since then: not used).
  // The vendor carries to the payee's other lines; the category only to a line of a like amount (half to twice), as
  // what a purchase was for depends on the purchase (stage S5).
  const { rows: found } = Number(item.amount_cents) < 0 ? await db.query(`SELECT research_id, proposal, vendor_id, item_id, amount_cents, payee_key, context FROM vendor_research
      WHERE org_id = $1 AND entity_id = $2 AND status = 'done' AND decision IS DISTINCT FROM 'rejected' AND payee_key = $4 AND payee_key <> ''
      ORDER BY (item_id = $3) DESC, created_at DESC LIMIT 20`, [orgId, entityId, item.item_id, researchKey(item)]) : { rows: [] };
  const r = found.find(x => researchFits(x, item).fits);
  if (r) {
    const vendorId = r.vendor_id ?? r.proposal.vendor_id;
    const like = researchFits(r, item).category;
    const ai = { source: 'ai', confidence: like ? r.proposal.confidence : 'low', payee: vendorId ? `v:${vendorId}` : null, accountId: like ? r.proposal.category_account_id : null,
      classId: null, locationId: null, memo: null, research: like ? r.proposal : { ...r.proposal, category_account_id: null } };
    if (ok(ai)) return ai;
  }
  return [reviewed, books].find(ok) ?? null;
}

// Every account a suggestion would post to, and its payee, still active in this company (history.active, loaded with
// the history; without it — a caller that didn't load it — nothing is ruled out here and the writers check).
function usable(history, s) {
  const active = history?.active;
  if (!active) return true;
  const accounts = s.lines?.length ? s.lines.map(l => l.accountId) : [s.accountId];
  return accounts.every(a => a == null || active.has(`a:${a}`)) && (!s.payee || active.has(s.payee));
}

// What a suggestion would do — everything that would reach the books, plus the versions it was worked out from (the bank
// line's token, the rule as last changed, the matched transaction's version) — as a short fingerprint the list sends back
// with each ticked item, so a batch does exactly what the person saw. The plan text starts with its kind
// ('match:' / 'rule:' / 'history:'). Null for suggestions a batch never accepts (AI, possible matches, anything not sure).
export function planOf(s, item) {
  if (!s || s.confidence !== 'high') return null;
  const rev = `|${itemToken(item)}`;
  if (s.source === 'match') return `match:${s.txn.txn_id}@${s.txn.version ?? ''}${rev}`;
  if (!s.accountId || !['rule', 'history'].includes(s.source) || s.basis === 'wording') return null;
  const what = s.lines?.length ? s.lines.map(l => `${l.accountId}=${l.cents}`).join(',') : s.accountId;
  const tail = `${what}:${s.payee ?? ''}:${s.classId ?? ''}:${s.locationId ?? ''}:${s.memo ?? ''}`;
  return s.source === 'rule' ? `rule:${s.rule.rule_id}@${stamp(s.rule.updated_at)}:${tail}${rev}` : `history:${tail}${rev}`;
}
const stamp = d => (d ? new Date(d).toISOString() : '');
// A rule as it stood: its id and when it was last changed. Forms that fill in from a rule carry it; a rule changed since is refused.
export const ruleStamp = r => `${r.rule_id}@${stamp(r.updated_at)}`;
export const intentOf = (s, item) => {
  const plan = planOf(s, item);
  return plan ? `${plan.split(':')[0]}:${createHash('sha256').update(plan).digest('hex').slice(0, 24)}` : null;
};

// Accept what's suggested for the ticked items (QBO's batch "Accept" on For review): matches, rule suggestions and
// high-confidence history. intents: Map(itemId → intentOf as shown on the page). Each item is planned again and done
// inside its own transaction under the company lock — the plan worked out there must be exactly the one shown, or the item
// is skipped, never turned into something else. Two ticked items showing the same match are both left.
// matchOther: false in a practice copy (a transfer leaves the other account's line for a person).
// Returns { accepted, skipped, results: [{ itemId, description, outcome: 'accepted'|'skipped', reason, txnId }] } — an
// outcome for every ticked item.
// preloaded: the history read before the lock (tests pass an older one, as if the books changed meanwhile).
export async function acceptSuggestions(pool, { orgId, entityId, llAccountId, itemIds, intents = new Map(), revs = null, actor, matchOther = true, preloaded = null }) {
  const wanted = [...new Set((itemIds ?? []).map(Number).filter(Number.isSafeInteger))];
  if (!wanted.length) fail('Tick the items to accept.');
  const { rows } = await pool.query(`SELECT item_id, description FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND ll_account_id = $3::uuid
      AND item_id = ANY($4::bigint[]) ORDER BY posted_date, item_id`, [orgId, entityId, llAccountId, wanted]);
  const results = [];
  const note = (r, outcome, reason = null, txnId = null) => results.push({ itemId: Number(r.item_id), description: r.description, outcome, reason, txnId });
  for (const id of wanted.filter(w => !rows.some(r => Number(r.item_id) === w))) note({ item_id: id, description: '' }, 'skipped', 'not found on this account');
  // A first look, outside the lock, only to find ticked items that showed the same match.
  const rules0 = await listRules(pool, { orgId, entityId }), history0 = preloaded ?? await learnedHistory(pool, { orgId, entityId });
  const shownMatch = new Map();
  for (const r of rows) {
    const item = await getBankItem(pool, { orgId, entityId, itemId: r.item_id });
    if (!item || item.review_state !== 'new') continue;
    const s = await suggestFor(pool, { orgId, entityId, item, rules: rules0, history: history0 });
    if (s?.source === 'match' && intents.get(Number(r.item_id)) === intentOf(s, item)) shownMatch.set(Number(r.item_id), Number(s.txn.txn_id));
  }
  const counts = new Map();
  for (const t of shownMatch.values()) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const r of rows) {
    const id = Number(r.item_id);
    if (shownMatch.has(id) && counts.get(shownMatch.get(id)) > 1) { note(r, 'skipped', 'another ticked item shows the same match'); continue; }
    try {
      const done = await withTransaction(pool, async tx => {
        await lockEntity(tx, orgId, entityId);
        const item = await getBankItem(tx, { orgId, entityId, itemId: id, lock: true });
        if (!item || item.review_state !== 'new' || item.bank_state !== 'active' || item.pending) return { reason: 'already reviewed or not ready' };
        // The row as the page showed it (revs: the list's rev_<id>), checked as well as the plan.
        if (revs && revs.get(id) !== itemToken(item)) return { reason: 'changed since the page was shown — review it' };
        const rulesNow = await listRules(tx, { orgId, entityId });
        let s = await suggestFor(tx, { orgId, entityId, item, rules: rulesNow, history: await learnedHistory(tx, { orgId, entityId, wording: history0.wording }) });
        // The wording corpus loaded before the lock may be out of date, and wording can turn a match down (another payee):
        // anything but a rule (which comes before wording and needs none) is worked out again with the books as they are now.
        // (Only for a line that would be accepted: the rest are skipped anyway.)
        if (s && s.source !== 'rule' && intentOf(s, item)) s = await suggestFor(tx, { orgId, entityId, item, rules: rulesNow, history: await learnedHistory(tx, { orgId, entityId }) });
        const intent = intentOf(s, item);
        if (!intent) return { reason: s?.source === 'possible' ? 'may already be in the books — review it' : 'nothing sure enough to accept' };
        if (!intents.has(id)) return { reason: 'no suggestion was shown for it — review it' };
        if (intents.get(id) !== intent) return { reason: 'changed since the page was shown — review it' };
        if (s.source === 'match') {
          await matchItemTx(tx, { orgId, entityId, itemId: id, txnIds: [s.txn.txn_id], actor, source: 'batch', basis: 'match' });
          return { txnId: Number(s.txn.txn_id) };
        }
        return { txnId: await addItemTx(tx, { orgId, entityId, itemId: id, payee: s.payee ?? '', memo: s.memo ?? '', dims: dimsOf(s),
          lines: s.lines?.length ? s.lines.map(l => ({ accountId: l.accountId, amount: l.amount, description: l.description })) : [{ accountId: s.accountId, amount: '' }],
          actor, source: 'batch', basis: s.source, rule: s.source === 'rule' ? s.rule : null, matchOther }) };
      });
      if (done.reason) note(r, 'skipped', done.reason);
      else note(r, 'accepted', null, done.txnId);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      note(r, 'skipped', error.message); // e.g. a payee that doesn't fit the direction: left for review
    }
  }
  return { accepted: results.filter(x => x.outcome === 'accepted').length, skipped: results.filter(x => x.outcome === 'skipped'), results };
}
const dimsOf = s => ({ ...(s.classId ? { classId: Number(s.classId) } : {}), ...(s.locationId ? { locationId: Number(s.locationId) } : {}) });

// Auto rules, after each pull and when an auto rule is saved: add every waiting item an auto rule fits, unless the books
// may already hold it (one candidate or several — then it's left for review, where the candidates are shown) or a person
// held it (undid it, or deleted its books transaction). Each item is decided and done under the company lock.
export async function applyAutoRules(pool, { orgId, entityId, actor = 'bank rule' }) {
  const rules = (await listRules(pool, { orgId, entityId })).filter(r => r.active && r.mode === 'auto');
  if (!rules.length) return 0;
  const { rows } = await pool.query(`SELECT item_id FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND review_state = 'new' AND bank_state = 'active'
    AND NOT pending AND NOT auto_hold ORDER BY posted_date, item_id`, [orgId, entityId]);
  let added = 0;
  for (const { item_id: id } of rows) {
    try {
      const did = await withTransaction(pool, async tx => {
        await lockEntity(tx, orgId, entityId);
        const item = await getBankItem(tx, { orgId, entityId, itemId: id, lock: true });
        if (!item || item.review_state !== 'new' || item.bank_state !== 'active' || item.pending || item.auto_hold) return false;
        const rule = (await listRules(tx, { orgId, entityId })).find(r => ruleFits(r, item)); // the first rule that fits decides, auto or not
        const act = rule ? ruleAction(rule, item) : null;
        if (!rule || rule.mode !== 'auto' || !act?.lines.length) return false;
        if ((await possibleDuplicates(tx, { orgId, entityId, item })).length) return false;
        await addItemTx(tx, { orgId, entityId, itemId: id, payee: act.payee, memo: act.memo, dims: act.dims,
          lines: act.lines.map(l => ({ accountId: l.accountId, amount: l.amount, description: l.description })), actor: `${actor}: ${rule.name}`, source: 'auto', basis: 'rule', rule });
        return true;
      });
      if (did) added++;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
  }
  return added;
}

// The item page's categorization history (stage BR-4, QBO's history panel): the categories used for this payee — by earlier
// bank reviews with the same description, and by the books' own transactions with the vendor it names (last 24 months) —
// with how often, when last, and the latest few transactions behind each.
export async function categoryHistory(db, { orgId, entityId, item, history }) {
  const out = Number(item.amount_cents) < 0;
  const key = payeeKey(item.merchant_name || item.description);
  const rows = new Map();
  const row = id => rows.get(id) ?? rows.set(id, { accountId: id, bank: 0, books: 0, last: '', examples: [] }).get(id);
  if (key) {
    const { rows: done } = await db.query(`
      SELECT i.item_id, i.description, i.merchant_name, i.posted_date::text AS d, i.amount_cents, t.txn_id, t.type, t.doc_number, txn_party_key(t.txn_id) AS party_key,
             (SELECT array_agg(DISTINCT p.account_id) FROM posting p WHERE p.txn_id = t.txn_id AND p.account_id <> l.books_account_id) AS others
        FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id
        JOIN bank_feed_link k ON k.item_id = i.item_id AND k.how = 'added' JOIN txn t ON t.txn_id = k.txn_id
       WHERE i.org_id = $1 AND i.entity_id = $2 AND i.item_id <> $3 AND (i.amount_cents < 0) = $4 AND t.voided_at IS NULL
         AND (SELECT coalesce(sum(p.amount_cents), 0) FROM posting p WHERE p.txn_id = t.txn_id AND p.account_id = l.books_account_id) = i.amount_cents
       AND NOT EXISTS (SELECT 1 FROM posting p JOIN account a ON a.account_id = p.account_id WHERE p.txn_id = t.txn_id AND a.system_key IN ('ar', 'ap', 'undeposited'))
       ORDER BY i.posted_date DESC, i.item_id DESC LIMIT 5000`, [orgId, entityId, item.item_id, out]);
    for (const r of done.filter(r => payeeKey(r.merchant_name || r.description) === key && r.others?.length === 1)) {
      const x = row(Number(r.others[0]));
      x.bank++;
      if (r.d > x.last) x.last = r.d;
      if (x.examples.length < 5) x.examples.push({ txn_id: r.txn_id, type: r.type, doc_number: r.doc_number, txn_date: r.d, amount_cents: Math.abs(Number(r.amount_cents)) });
    }
  }
  const vendor = out ? vendorFor(history?.books, item) : null;
  for (const b of vendor ? history.books.byVendor.get(vendor.id) ?? [] : []) {
    const x = row(b.accountId);
    x.books += b.count;
    if (b.last > x.last) x.last = b.last;
  }
  if (vendor) {
    const { rows: recent } = await db.query(`
      SELECT p.account_id, t.txn_id, t.type, t.doc_number, t.txn_date::text AS txn_date, p.amount_cents FROM txn t JOIN posting p ON p.txn_id = t.txn_id
        JOIN account a ON a.account_id = p.account_id
       WHERE t.org_id = $1 AND t.entity_id = $2 AND t.vendor_id = $3 AND t.type IN ('expense', 'check', 'bill') AND t.voided_at IS NULL AND p.amount_cents > 0
         AND a.system_key IS NULL AND a.type NOT IN ('bank', 'credit_card') AND t.txn_date >= current_date - interval '24 months'
       ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT 200`, [orgId, entityId, vendor.id]);
    for (const r of recent) {
      const x = rows.get(Number(r.account_id));
      if (x && x.examples.length < 5 && !x.examples.some(e => Number(e.txn_id) === Number(r.txn_id))) x.examples.push({ ...r, amount_cents: Number(r.amount_cents) });
    }
  }
  for (const x of rows.values()) x.examples.sort((a, b) => String(b.txn_date).localeCompare(String(a.txn_date)));
  return { key, vendor, rows: [...rows.values()].sort((a, b) => b.bank + b.books - (a.bank + a.books) || b.last.localeCompare(a.last)) };
}

// ---- rules v2: preview, export, import (stage BR-5) ----

// Test a rule before saving it (QBO's rule preview): the bank lines waiting for review that it fits, what it would record
// for each, and — where a rule earlier in the order fits first — the rule that is used instead. rule: checkRule's values
// plus rule_id (null for a new rule).
export async function previewRule(db, { orgId, entityId, rule }) {
  const others = (await listRules(db, { orgId, entityId })).filter(r => Number(r.rule_id) !== Number(rule.rule_id));
  const self = { ...rule, active: true };
  const order = [...others, self].sort((a, b) => a.priority - b.priority || (Number(a.rule_id) || Infinity) - (Number(b.rule_id) || Infinity));
  const { rows } = await db.query(`
    SELECT i.*, i.ll_account_id::text AS ll_account, l.books_account_id, a.type AS books_type, a.name AS books_name FROM bank_feed_item i
      JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id JOIN account a ON a.account_id = l.books_account_id
     WHERE i.org_id = $1 AND i.entity_id = $2 AND i.review_state = 'new' AND i.bank_state = 'active' AND NOT i.pending
     ORDER BY i.posted_date DESC, i.item_id DESC LIMIT 2000`, [orgId, entityId]);
  const caught = [];
  for (const item of rows) {
    if (!ruleFits(self, item)) continue;
    const first = order.find(r => ruleFits(r, item));
    // As the planner decides: something already in the books comes before any rule.
    const m = confidentMatch(await matchCandidates(db, { orgId, entityId, item }), item);
    const hold = m ? 'match' : (await possibleDuplicates(db, { orgId, entityId, item })).length ? 'duplicate' : rule.mode === 'auto' && item.auto_hold ? 'undone' : null;
    caught.push({ item, action: ruleAction(self, item), usedInstead: first === self ? null : first, hold, match: m });
  }
  return caught;
}

const EXPORT_FORMAT = 'financial-books-bank-rules';
// Every rule with names in place of ids — categories by number and name, payees by kind and name, the fed accounts by their
// books account's name — so a company's rules can be kept or brought into another company.
export async function exportRules(db, { orgId, entityId }) {
  const q = sql => db.query(sql, [orgId, entityId]).then(r => r.rows);
  const accounts = new Map((await q('SELECT account_id, name, number FROM account WHERE org_id = $1 AND entity_id = $2')).map(a => [Number(a.account_id), a]));
  // Every fed account by the books account it's mapped to, and by the bank's own name and last digits (an account not
  // brought into the books still keeps a rule's scope).
  const feeds = new Map((await q(`SELECT l.ll_account_id::text AS id, a.name AS books, l.display_name AS feed, l.mask FROM ledgerline_account l
    LEFT JOIN account a ON a.account_id = l.books_account_id WHERE l.org_id = $1 AND l.entity_id = $2`)).map(f => [f.id, { books: f.books ?? null, feed: f.feed, mask: f.mask ?? null }]));
  const parties = new Map([...(await q(`SELECT 'v:' || vendor_id AS key, display_name AS name FROM vendor WHERE org_id = $1 AND entity_id = $2`)),
    ...(await q(`SELECT 'c:' || customer_id AS key, display_name AS name FROM customer WHERE org_id = $1 AND entity_id = $2`))].map(p => [p.key, p.name]));
  const classes = new Map((await q('SELECT class_id, name FROM class WHERE org_id = $1 AND entity_id = $2')).map(c => [Number(c.class_id), c.name]));
  const locations = new Map((await q('SELECT location_id, name FROM location WHERE org_id = $1 AND entity_id = $2')).map(l => [Number(l.location_id), l.name]));
  const acct = id => (id ? { name: accounts.get(Number(id))?.name ?? null, number: accounts.get(Number(id))?.number ?? null } : null);
  return { format: EXPORT_FORMAT, version: 1, rules: (await listRules(db, { orgId, entityId })).map(r => ({
    name: r.name, order: r.priority, on: r.active, money: r.money, accounts: ruleAccounts(r).map(id => feeds.get(id) ?? { books: null, feed: null, mask: null, missing: true }), matchAll: r.match_all,
    conditions: r.conditions, payee: r.payee ? { kind: r.payee.startsWith('v:') ? 'vendor' : 'customer', name: parties.get(r.payee) ?? null } : null,
    category: r.splits?.length ? null : acct(r.account_id),
    split: r.splits?.length ? r.splits.map(s => ({ category: acct(s.accountId), ...(s.percent !== undefined && s.percent !== null ? { percent: s.percent / 100 } : { amount: (s.cents / 100).toFixed(2) }),
      description: s.description ?? '' })) : null,
    class: r.class_id ? classes.get(Number(r.class_id)) ?? null : null, location: r.location_id ? locations.get(Number(r.location_id)) ?? null : null,
    memo: r.memo, memoMode: r.memo_mode, how: r.mode })) };
}

// Bring rules in from an export: each is matched to this company's records by name (a category by number and name, or by a
// name only one account has) and saved through the same checks as the rule form. A rule whose name is taken, or that names
// something this company doesn't have, is skipped with the reason. Returns [{ name, outcome: 'added'|'skipped', reason }].
export async function importRules(pool, { orgId, entityId, data, actor }) {
  let parsed;
  try { parsed = typeof data === 'string' ? JSON.parse(data) : data; } catch { fail('That isn’t a rules export (it isn’t valid JSON).'); }
  if (parsed?.format !== EXPORT_FORMAT || !Array.isArray(parsed.rules)) fail('That isn’t a Financial Books rules export.');
  if (parsed.rules.length > 500) fail('An import can bring in up to 500 rules at a time.');
  const q = sql => pool.query(sql, [orgId, entityId]).then(r => r.rows);
  const accounts = await q('SELECT account_id, name, number FROM account WHERE org_id = $1 AND entity_id = $2 AND active');
  const feeds = await q(`SELECT l.ll_account_id::text AS id, a.name AS books, l.display_name AS feed, l.mask FROM ledgerline_account l
    LEFT JOIN account a ON a.account_id = l.books_account_id WHERE l.org_id = $1 AND l.entity_id = $2`);
  // A rule's bank account: by the books account it's mapped to, else by the bank's name and last digits. One that can't be
  // found skips the rule — a rule limited to some accounts is never brought in for all of them.
  const feedOf = f => {
    const d = typeof f === 'string' ? { books: f } : f ?? {};
    if (d.missing) throw new ValidationError('it was limited to a bank account that no longer exists');
    const label = d.books ?? `${d.feed ?? 'an account'}${d.mask ? ` ••${d.mask}` : ''}`;
    const byBooks = d.books ? feeds.filter(x => same(x.books, d.books)) : [];
    const hit = byBooks.length || !d.feed ? byBooks : feeds.filter(x => same(x.feed, d.feed) && same(x.mask ?? '', d.mask ?? ''));
    if (hit.length !== 1) throw new ValidationError(hit.length ? `more than one bank account is “${label}”` : `this company has no bank account “${label}”`);
    return hit[0].id;
  };
  const vendors = await q('SELECT vendor_id AS id, display_name AS name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active');
  const customers = await q('SELECT customer_id AS id, display_name AS name FROM customer WHERE org_id = $1 AND entity_id = $2 AND active');
  const classes = await q('SELECT class_id AS id, name FROM class WHERE org_id = $1 AND entity_id = $2');
  const locations = await q('SELECT location_id AS id, name FROM location WHERE org_id = $1 AND entity_id = $2');
  const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const one = (list, test, what) => {
    const hit = list.filter(test);
    if (hit.length !== 1) throw new ValidationError(hit.length ? `more than one record is ${what}` : `this company has no ${what}`);
    return hit[0];
  };
  const account = a => {
    if (!a?.name) throw new ValidationError('a category is missing');
    const byBoth = a.number ? accounts.filter(x => same(x.name, a.name) && same(x.number, a.number)) : [];
    return Number((byBoth.length === 1 ? byBoth[0] : one(accounts, x => same(x.name, a.name), `category “${a.name}”`)).account_id);
  };
  const results = [];
  for (const r of parsed.rules) {
    const name = String(r?.name ?? '').trim();
    try {
      const fields = {
        name, priority: String(r.order ?? ''), active: r.on !== false, money: r.money, matchAll: r.matchAll !== false, mode: r.how === 'auto' ? 'auto' : 'suggest',
        llAccounts: (r.accounts ?? []).map(feedOf),
        conditions: (r.conditions ?? []).map(c => ({ field: c.field, op: c.op, value: c.field === 'amount' ? (Number(c.value) / 100).toFixed(2) : c.value,
          value2: c.value2 !== undefined && c.value2 !== null ? (Number(c.value2) / 100).toFixed(2) : '' })),
        payee: r.payee ? `${r.payee.kind === 'vendor' ? 'v' : 'c'}:${one(r.payee.kind === 'vendor' ? vendors : customers, p => same(p.name, r.payee.name), `${r.payee.kind} “${r.payee.name}”`).id}` : '',
        accountId: r.category ? String(account(r.category)) : '',
        splits: (r.split ?? []).map(s => ({ accountId: String(account(s.category)), percent: s.percent !== undefined ? String(s.percent) : '', amount: s.amount ?? '', description: s.description ?? '' })),
        classId: r.class ? String(one(classes, c => same(c.name, r.class), `class “${r.class}”`).id) : '',
        locationId: r.location ? String(one(locations, l => same(l.name, r.location), `location “${r.location}”`).id) : '',
        memo: r.memo ?? '', memoMode: r.memoMode };
      await saveRule(pool, { orgId, entityId, fields, actor });
      results.push({ name, outcome: 'added' });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      results.push({ name: name || '(no name)', outcome: 'skipped', reason: error.message.replace(/\.$/, '') });
    }
  }
  return results;
}
