import { withTransaction } from '../db.js';
import { ValidationError } from '../data/writes.js';
import { getBankItem, matchCandidates, confidentMatch, matchItem, addItem } from '../data/banking.js';
import { parseMoney } from '../domain/money.js';

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

// Form values → a checked rule. f.conditions: [{ field, op, value, value2 }] as typed (amounts like 25.00).
export async function saveRule(pool, { orgId, entityId, ruleId = null, fields: f, actor }) {
  const name = String(f.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!name) fail('Give the rule a name.');
  if (!['in', 'out'].includes(f.money)) fail('Choose money in or money out.');
  const conditions = [];
  for (const [i, c] of (f.conditions ?? []).entries()) {
    const value = String(c.value ?? '').trim();
    if (!value && !String(c.value2 ?? '').trim()) continue;
    const where = `Condition ${i + 1}`;
    if (c.field === 'description') {
      if (!TEXT_OPS[c.op]) fail(`${where}: choose how the description is compared.`);
      if (!value) fail(`${where}: enter the text to look for.`);
      conditions.push({ field: 'description', op: c.op, value: value.slice(0, 200) });
    } else if (c.field === 'amount') {
      if (!AMOUNT_OPS[c.op]) fail(`${where}: choose how the amount is compared.`);
      const a = parseMoney(value), b = c.op === 'between' ? parseMoney(String(c.value2 ?? '').trim()) : null;
      if (a === null || a < 0 || (c.op === 'between' && (b === null || b < a))) fail(`${where}: enter amounts like 25.00${c.op === 'between' ? ', the second not smaller than the first' : ''}.`);
      conditions.push({ field: 'amount', op: c.op, value: a, ...(c.op === 'between' ? { value2: b } : {}) });
    } else fail(`${where}: choose description or amount.`);
  }
  if (!conditions.length) fail('Add at least one condition, like “Description contains SHELL”.');
  const payee = /^[cv]:\d{1,18}$/.test(String(f.payee ?? '')) ? f.payee : null;
  const accountId = Number(f.accountId) || null;
  const classId = Number(f.classId) || null, locationId = Number(f.locationId) || null;
  if (!accountId && !payee) fail('Choose what the rule assigns: at least a category or a payee.');
  if (f.mode === 'auto' && !accountId) fail('A rule that adds items automatically needs a category.');
  const llAccount = String(f.llAccount ?? '') || null;
  return withTransaction(pool, async tx => {
    if (llAccount && !(await tx.query('SELECT 1 FROM ledgerline_account WHERE org_id = $1 AND entity_id = $2 AND ll_account_id::text = $3', [orgId, entityId, llAccount])).rowCount) {
      fail('Choose one of this company’s bank accounts, or all of them.');
    }
    if (accountId) {
      const { rows: [a] } = await tx.query('SELECT system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active', [orgId, entityId, accountId]);
      if (!a || ['ar', 'ap', 'undeposited'].includes(a.system_key)) fail('Choose a category the books can use.');
    }
    if (payee) {
      const [kind, id] = payee.split(':');
      const table = kind === 'v' ? 'vendor' : 'customer';
      if (!(await tx.query(`SELECT 1 FROM ${table} WHERE org_id = $1 AND entity_id = $2 AND ${table}_id = $3`, [orgId, entityId, Number(id)])).rowCount) fail('Choose a valid payee.');
    }
    if (classId && !(await tx.query('SELECT 1 FROM class WHERE org_id = $1 AND entity_id = $2 AND class_id = $3', [orgId, entityId, classId])).rowCount) fail('Choose a valid class.');
    if (locationId && !(await tx.query('SELECT 1 FROM location WHERE org_id = $1 AND entity_id = $2 AND location_id = $3', [orgId, entityId, locationId])).rowCount) fail('Choose a valid location.');
    const dupe = await tx.query('SELECT 1 FROM bank_rule WHERE org_id = $1 AND entity_id = $2 AND lower(name) = lower($3) AND rule_id <> coalesce($4, 0)', [orgId, entityId, name, ruleId]);
    if (dupe.rowCount) fail(`A rule named “${name}” already exists.`);
    const values = [orgId, entityId, name, Math.max(0, Math.min(9999, Number(f.priority) || 100)), f.active !== false, f.money, llAccount, f.matchAll !== false,
      JSON.stringify(conditions), payee, accountId, classId, locationId, String(f.memo ?? '').trim().slice(0, 500) || null, f.mode === 'auto' ? 'auto' : 'suggest'];
    if (ruleId) {
      const { rowCount } = await tx.query(`UPDATE bank_rule SET name = $3, priority = $4, active = $5, money = $6, ll_account_id = $7, match_all = $8, conditions = $9,
          payee = $10, account_id = $11, class_id = $12, location_id = $13, memo = $14, mode = $15, updated_at = now()
        WHERE org_id = $1 AND entity_id = $2 AND rule_id = $16`, [...values, ruleId]);
      if (!rowCount) fail('Rule not found.');
      return Number(ruleId);
    }
    const { rows: [r] } = await tx.query(`INSERT INTO bank_rule (org_id, entity_id, name, priority, active, money, ll_account_id, match_all, conditions, payee, account_id,
        class_id, location_id, memo, mode, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING rule_id`, [...values, actor]);
    return Number(r.rule_id);
  });
}

export async function deleteRule(pool, { orgId, entityId, ruleId }) {
  const { rowCount } = await pool.query('DELETE FROM bank_rule WHERE org_id = $1 AND entity_id = $2 AND rule_id = $3', [orgId, entityId, Number(ruleId) || 0]);
  if (!rowCount) fail('Rule not found.');
}

const testText = (text, c) => {
  const t = String(text ?? '').toUpperCase(), v = String(c.value).toUpperCase();
  return c.op === 'contains' ? t.includes(v) : c.op === 'not_contains' ? !t.includes(v) : c.op === 'is' ? t.trim() === v.trim() : t.startsWith(v);
};
const testAmount = (cents, c) => (c.op === 'equals' ? cents === c.value : c.op === 'more' ? cents > c.value : c.op === 'less' ? cents < c.value
  : cents >= c.value && cents <= c.value2);

// Does a rule fit a bank item? Amount conditions compare the size of the amount (money in/out is its own setting).
export function ruleFits(rule, item) {
  if (!rule.active) return false;
  if ((rule.money === 'out') !== (Number(item.amount_cents) < 0)) return false;
  if (rule.ll_account_id && String(rule.ll_account_id) !== String(item.ll_account ?? item.ll_account_id)) return false;
  const tests = (rule.conditions ?? []).map(c => (c.field === 'amount' ? testAmount(Math.abs(Number(item.amount_cents)), c)
    : testText(`${item.description ?? ''} ${c.op === 'not_contains' || c.op === 'is' || c.op === 'starts' ? '' : item.merchant_name ?? ''}`.trim(), c)));
  if (!tests.length) return false;
  return rule.match_all ? tests.every(Boolean) : tests.some(Boolean);
}

// ---- learning from history ----

// The part of a bank description that names who it was: no store numbers, reference numbers, dates or punctuation.
export function payeeKey(text) {
  return String(text ?? '').toUpperCase()
    .replace(/\b(POS|ACH|DEBIT|CREDIT|PURCHASE|CHECKCARD|CHECK CARD|RECURRING|PAYMENT|ONLINE|WEB|PPD|ID|REF|TRANSFER|TO|FROM)\b/g, ' ')
    .replace(/[^A-Z ]+/g, ' ').replace(/\b[A-Z]\b/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
}

// How this company added earlier bank items: key → [{ payee, accountId, classId, locationId, count }], most used first.
export async function learnedHistory(db, { orgId, entityId }) {
  const { rows } = await db.query(`
    SELECT i.description, i.merchant_name, i.amount_cents < 0 AS out, t.vendor_id, t.customer_id, t.class_id, t.location_id,
           (SELECT array_agg(DISTINCT p.account_id) FROM posting p WHERE p.txn_id = t.txn_id AND p.account_id <> l.books_account_id) AS others
      FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id
      JOIN bank_feed_link k ON k.item_id = i.item_id AND k.how = 'added' JOIN txn t ON t.txn_id = k.txn_id
     WHERE i.org_id = $1 AND i.entity_id = $2 AND t.type IN ('expense', 'check', 'deposit', 'journal_entry') AND t.voided_at IS NULL
     ORDER BY i.posted_date DESC LIMIT 5000`, [orgId, entityId]);
  const byKey = new Map();
  for (const r of rows) {
    if (!r.others || r.others.length !== 1) continue; // only single-category adds teach anything
    const key = `${r.out ? 'out' : 'in'}|${payeeKey(r.merchant_name || r.description)}`;
    if (key.endsWith('|')) continue;
    const payee = r.vendor_id ? `v:${r.vendor_id}` : r.customer_id ? `c:${r.customer_id}` : null;
    const sig = `${payee}|${r.others[0]}|${r.class_id ?? ''}|${r.location_id ?? ''}`;
    const list = byKey.get(key) ?? new Map();
    const e = list.get(sig) ?? { payee, accountId: Number(r.others[0]), classId: r.class_id, locationId: r.location_id, count: 0 };
    e.count++;
    list.set(sig, e);
    byKey.set(key, list);
  }
  return new Map([...byKey].map(([k, list]) => [k, [...list.values()].sort((a, b) => b.count - a.count)]));
}

// ---- one suggestion per item ----

// ctx: { rules, history } loaded once per page. Returns null or
// { source: 'match'|'rule'|'history', confidence: 'high'|'medium'|'low', txn?, rule?, payee, accountId, classId, locationId, memo, count, of }.
export async function suggestFor(db, { orgId, entityId, item, rules, history, undeposited = null }) {
  const cands = await matchCandidates(db, { orgId, entityId, item, undeposited });
  const m = confidentMatch(cands, item);
  if (m) return { source: 'match', confidence: 'high', txn: m };
  const rule = rules.find(r => ruleFits(r, item));
  if (rule) return { source: 'rule', confidence: 'high', rule, payee: rule.payee, accountId: rule.account_id ? Number(rule.account_id) : null,
    classId: rule.class_id, locationId: rule.location_id, memo: rule.memo };
  const list = history.get(`${Number(item.amount_cents) < 0 ? 'out' : 'in'}|${payeeKey(item.merchant_name || item.description)}`);
  if (list?.length) {
    const top = list[0], of = list.reduce((s, e) => s + e.count, 0);
    const confidence = top.count === of && of >= 3 ? 'high' : top.count >= 2 && top.count / of >= 2 / 3 ? 'medium' : 'low';
    return { source: 'history', confidence, payee: top.payee, accountId: top.accountId, classId: top.classId, locationId: top.locationId, memo: null, count: top.count, of };
  }
  // AI vendor research (stage B5) on this payee, not rejected: a suggestion a person still has to accept.
  const { rows: [r] } = await db.query(`SELECT research_id, proposal, vendor_id FROM vendor_research WHERE org_id = $1 AND entity_id = $2 AND status = 'done'
      AND decision IS DISTINCT FROM 'rejected' AND (item_id = $3 OR (payee_key = $4 AND payee_key <> '')) ORDER BY (item_id = $3) DESC, created_at DESC LIMIT 1`,
  [orgId, entityId, item.item_id, payeeKey(item.merchant_name || item.description)]);
  if (r) {
    const vendorId = r.vendor_id ?? r.proposal.vendor_id;
    return { source: 'ai', confidence: r.proposal.confidence, payee: vendorId ? `v:${vendorId}` : null, accountId: r.proposal.category_account_id,
      classId: null, locationId: null, memo: null, research: r.proposal };
  }
  return null;
}

// Accept what's suggested: matches, rule suggestions and high-confidence history (QBO's batch "Accept" on For review).
export async function acceptSuggestions(pool, { orgId, entityId, llAccountId, itemIds = null, actor }) {
  const { rows } = await pool.query(`SELECT item_id FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND ll_account_id = $3::uuid AND review_state = 'new'
      AND bank_state = 'active' AND NOT pending ORDER BY posted_date, item_id`, [orgId, entityId, llAccountId]);
  const wanted = itemIds ? new Set(itemIds.map(Number)) : null;
  const rules = await listRules(pool, { orgId, entityId });
  const history = await learnedHistory(pool, { orgId, entityId });
  let accepted = 0;
  for (const { item_id: id } of rows.filter(r => !wanted || wanted.has(Number(r.item_id)))) {
    const item = await getBankItem(pool, { orgId, entityId, itemId: id });
    const s = await suggestFor(pool, { orgId, entityId, item, rules, history });
    // AI proposals are never accepted in bulk: each one is looked at.
    if (!s || s.source === 'ai' || s.confidence !== 'high' || (s.source !== 'match' && !s.accountId)) continue;
    try {
      if (s.source === 'match') await matchItem(pool, { orgId, entityId, itemId: id, txnIds: [s.txn.txn_id], actor });
      else await addItem(pool, { orgId, entityId, itemId: id, payee: s.payee ?? '', memo: s.memo ?? '', dims: dimsOf(s), lines: [{ accountId: s.accountId, amount: '' }], actor });
      accepted++;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error; // e.g. a payee that doesn't fit the direction: left for review
    }
  }
  return accepted;
}
const dimsOf = s => ({ ...(s.classId ? { classId: Number(s.classId) } : {}), ...(s.locationId ? { locationId: Number(s.locationId) } : {}) });

// Auto rules, after each pull and when an auto rule is saved: add every waiting item an auto rule fits, unless the books
// already have a match for it (then it's left for review, where the match is suggested).
export async function applyAutoRules(pool, { orgId, entityId, actor = 'bank rule' }) {
  const rules = (await listRules(pool, { orgId, entityId })).filter(r => r.active && r.mode === 'auto');
  if (!rules.length) return 0;
  const { rows } = await pool.query(`SELECT item_id FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND review_state = 'new' AND bank_state = 'active'
    AND NOT pending ORDER BY posted_date, item_id`, [orgId, entityId]);
  const all = await listRules(pool, { orgId, entityId });
  let added = 0;
  for (const { item_id: id } of rows) {
    const item = await getBankItem(pool, { orgId, entityId, itemId: id });
    if (!item) continue;
    const rule = all.find(r => ruleFits(r, item)); // the first rule that fits decides, auto or not
    if (!rule || rule.mode !== 'auto' || !rule.account_id) continue;
    if (confidentMatch(await matchCandidates(pool, { orgId, entityId, item }), item)) continue;
    try {
      await addItem(pool, { orgId, entityId, itemId: id, payee: rule.payee ?? '', memo: rule.memo ?? '', dims: dimsOf({ classId: rule.class_id, locationId: rule.location_id }),
        lines: [{ accountId: rule.account_id, amount: '' }], actor: `${actor}: ${rule.name}` });
      await pool.query('UPDATE bank_feed_item SET rule_id = $2 WHERE item_id = $1', [id, rule.rule_id]);
      added++;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
  }
  return added;
}
