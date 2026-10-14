import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { verifiedMonths, bankAccounts, listBankItems, tabCounts, getBankItem, matchCandidates, confidentMatch, matchItem, addItem, transferItem, excludeItems, undoItem,
  } from '../../lib/data/banking.js';
import { listRules, getRule, saveRule, deleteRule, learnedHistory, suggestFor, acceptSuggestions, applyAutoRules, payeeKey } from '../../lib/bankfeed/rules.js';
import { bankingPage, bankItemPage } from '../../lib/views/banking.js';
import { rulesPage, ruleForm } from '../../lib/views/bank-rules.js';
import { canAccess } from '../../lib/domain/roles.js';
import { listUndeposited } from '../../lib/data/deposits.js';
import { settingsKey } from '../../lib/secrets.js';
import { getAiSettings, PROVIDERS } from '../../lib/ai/provider.js';
import { researchItem, latestResearch, acceptResearch, rejectResearch, getResearch } from '../../lib/ai/vendor-research.js';
import { isPractice } from '../../lib/domain/practice.js';

// Bank transactions (stage B3): /banking (cards, tabs, batch accept/exclude) and /banking/item/:id (match, add, transfer,
// exclude, undo). Reviewing is for people who keep the books (admin, standard); reports-only people can look.
const PAGE = 50;
const GROUP = { income: 'Income', other_income: 'Other income', cost_of_goods_sold: 'Cost of goods sold', expense: 'Expenses', other_expense: 'Other expenses',
  bank: 'Bank', credit_card: 'Credit cards', other_current_asset: 'Other current assets', fixed_asset: 'Fixed assets', other_asset: 'Other assets',
  other_current_liability: 'Other current liabilities', long_term_liability: 'Long-term liabilities', equity: 'Equity' };

export async function bankingRoutes(h) {
  const accountNames = async () => new Map((await h.pool.query('SELECT account_id, name FROM account WHERE org_id = $1 AND entity_id = $2', [h.scope.orgId, h.scope.entityId]))
    .rows.map(a => [Number(a.account_id), a.name]));
  const { req, path, query, form, pool, page, base, go, takeFlash, ctx, scope, actor, who } = h;
  if (path !== '/banking' && !path.startsWith('/banking/')) return false;
  const canReview = canAccess(who.role, 'POST', '/banking/batch');
  const accounts = await bankAccounts(pool, scope);
  for (const a of accounts) a.verified = (await verifiedMonths(pool, { ...scope, accountId: a.books_account_id }))[0] ?? null;

  if (path === '/banking' && req.method === 'GET') {
    const current = accounts.find(a => a.id === query.account) ?? accounts[0] ?? null;
    const tab = ['review', 'categorized', 'excluded'].includes(query.tab) ? query.tab : 'review';
    const pageNo = Math.max(1, Math.min(1000, Number(query.page) || 1));
    let items = [], counts = { review: 0, categorized: 0, excluded: 0 }, more = false;
    const suggestions = new Map();
    if (current) {
      const rows = await listBankItems(pool, { ...scope, llAccountId: current.id, tab, limit: PAGE + 1, offset: PAGE * (pageNo - 1) });
      more = rows.length > PAGE;
      items = rows.slice(0, PAGE);
      counts = await tabCounts(pool, { ...scope, llAccountId: current.id });
      if (tab === 'review') {
        const rules = await listRules(pool, scope), history = await learnedHistory(pool, scope), undeposited = await listUndeposited(pool, scope);
        for (const i of items.filter(x => !x.pending)) {
          const item = await getBankItem(pool, { ...scope, itemId: i.item_id });
          const s = await suggestFor(pool, { ...scope, item, rules, history, undeposited });
          if (s) suggestions.set(Number(i.item_id), s);
        }
      }
    }
    page(bankingPage({ ...base(), flash: takeFlash(), timeZone: ctx.timeZone, accounts, current, tab, items, counts, suggestions, accountNames: await accountNames(), page: pageNo, more,
      canRefresh: canAccess(who.role, 'POST', '/bank-feeds/refresh'), canReview }));
    return true;
  }

  if (path === '/banking/batch') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const account = accounts.find(a => a.id === form.get('account')) ?? (() => { throw new HttpError(404, 'Account not found'); })();
    const back = `/banking?account=${account.id}&tab=review`;
    const ticked = form.getAll('item');
    try {
      if (form.get('action') === 'exclude') {
        const n = await excludeItems(pool, { ...scope, itemIds: ticked, actor });
        return go(back, 'ok', `${n} bank item${n === 1 ? '' : 's'} excluded.`) ?? true;
      }
      // A practice copy accepts only the items a person ticked, never everything at once.
      if (isPractice(h.env) && !ticked.length) return go(back, 'warn', 'Practice copy: tick the items to accept.') ?? true;
      const n = await acceptSuggestions(pool, { ...scope, llAccountId: account.id, itemIds: ticked.length ? ticked : null, actor });
      return go(back, n ? 'ok' : 'warn', n ? `${n} suggestion${n === 1 ? '' : 's'} accepted.` : 'Nothing sure enough to accept. Review the items one by one.') ?? true;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return go(back, 'error', error.message) ?? true;
    }
  }

  const rm = /^\/banking\/rules(?:\/(new|\d{1,18}))?(\/delete)?$/.exec(path);
  if (rm) return ruleRoutes(h, rm, { canReview });

  // AI vendor research: accept or reject a proposal (stage B5).
  const rr = /^\/banking\/research\/(\d{1,18})\/(accept|reject)$/.exec(path);
  if (rr) {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
    const r = await getResearch(pool, { ...scope, researchId: rr[1] }) ?? (() => { throw new HttpError(404, 'Research not found'); })();
    const back = `/banking/item/${r.item_id}`;
    try {
      if (rr[2] === 'reject') {
        await rejectResearch(pool, { ...scope, researchId: r.research_id, actor });
        return go(back, 'ok', 'Research rejected.') ?? true;
      }
      const a = await acceptResearch(pool, { ...scope, researchId: r.research_id, actor, key: settingsKey(h.env) });
      return go(`${back}?payee=v:${a.vendorId}${a.accountId ? `&category=${a.accountId}` : ''}`, 'ok', 'Accepted — the vendor and category are filled in below. Check them, then Add.') ?? true;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return go(back, 'error', error.message) ?? true;
    }
  }

  const m = /^\/banking\/item\/(\d{1,18})(\/(match|add|transfer|exclude|undo|research))?$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const item = await getBankItem(pool, { ...scope, itemId: m[1] });
  if (!item) throw new HttpError(404, 'Bank item not found');
  const here = `/banking/item/${item.item_id}`;
  const show = async (error = null, v = null, status = 200) => {
    const waiting = item.review_state === 'new' && item.bank_state === 'active' && !item.pending;
    const candidates = waiting ? await matchCandidates(pool, { ...scope, item, others: true }) : { exact: [], others: [], undeposited: [] };
    const { rows: links } = await pool.query(`SELECT t.txn_id, t.type, t.doc_number, t.txn_date, k.how, coalesce(c.display_name, v.display_name) AS party
      FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE k.item_id = $1 ORDER BY t.txn_date, t.txn_id`, [item.item_id]);
    const { rows: accts } = await pool.query(`SELECT account_id, name, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(name)`,
      [scope.orgId, scope.entityId]);
    const usable = accts.filter(a => Number(a.account_id) !== Number(item.books_account_id) && !['ar', 'ap', 'undeposited'].includes(a.system_key));
    const categories = Object.entries(GROUP).map(([type, label]) => [label, usable.filter(a => a.type === type)]).filter(([, list]) => list.length);
    const transferTo = usable.filter(a => !a.system_key && ['bank', 'credit_card', 'other_current_asset', 'other_asset', 'other_current_liability', 'long_term_liability'].includes(a.type));
    const { rows: vendors } = await pool.query(`SELECT 'v:' || vendor_id AS key, display_name AS name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(display_name)`,
      [scope.orgId, scope.entityId]);
    const { rows: customers } = await pool.query(`SELECT 'c:' || customer_id AS key, display_name AS name FROM customer WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(display_name)`,
      [scope.orgId, scope.entityId]);
    const suggestion = waiting ? await suggestFor(pool, { ...scope, item, rules: await listRules(pool, scope), history: await learnedHistory(pool, scope) }) : null;
    const aiSettings = await getAiSettings(pool, scope);
    const ai = { on: aiSettings.provider !== 'off' && aiSettings.hasKey && canReview, providerName: PROVIDERS[aiSettings.provider], canSetUp: ctx.orgAdmin };
    // After accepting research, the Add form starts from it.
    const prefill = /^v:\d{1,18}$/.test(query.payee ?? '') ? { payee: query.payee, memo: '', lines: [{ accountId: /^\d{1,18}$/.test(query.category ?? '') ? query.category : '' }] } : null;
    page(bankItemPage({ ...base(), flash: takeFlash(), item, candidates, suggested: suggestion?.source === 'match' ? suggestion.txn : null, suggestion, vendors, customers, categories,
      research: waiting ? await latestResearch(pool, { ...scope, item }) : null, ai, prefill,
      transferTo, links, error, v, canReview }), status);
    return true;
  };
  if (!m[2]) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    return show();
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const back = `/banking?account=${item.ll_account}&tab=review`;
  let v = null;
  try {
    switch (m[3]) {
      case 'match':
        await matchItem(pool, { ...scope, itemId: item.item_id, txnIds: form.getAll('txn'), undepositedIds: form.getAll('waiting'), actor });
        return go(back, 'ok', `Matched: ${item.description}.`) ?? true;
      case 'add': {
        const accountsIn = form.getAll('line_account'), amounts = form.getAll('line_amount'), descs = form.getAll('line_description');
        v = { payee: form.get('payee') ?? '', memo: form.get('memo') ?? '',
          lines: accountsIn.map((a, i) => ({ accountId: a, amount: amounts[i] ?? '', description: descs[i] ?? '' })) };
        await addItem(pool, { ...scope, itemId: item.item_id, payee: v.payee, memo: v.memo, lines: v.lines, actor });
        return go(back, 'ok', `Added: ${item.description}.`) ?? true;
      }
      case 'transfer':
        await transferItem(pool, { ...scope, itemId: item.item_id, otherAccountId: form.get('other'), actor, matchOther: !isPractice(h.env) });
        return go(back, 'ok', `Transfer recorded: ${item.description}.`) ?? true;
      case 'research':
        if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
        await researchItem(pool, { ...scope, itemId: item.item_id, actor, key: settingsKey(h.env), fetchImpl: h.aiFetch });
        return go(here, 'ok', 'Researched — see “Who is this?” below.') ?? true;
      case 'exclude':
        await excludeItems(pool, { ...scope, itemIds: [item.item_id], actor });
        return go(back, 'ok', `Excluded: ${item.description}.`) ?? true;
      case 'undo': {
        const r = await undoItem(pool, { ...scope, itemId: item.item_id, actor });
        return go(here, 'ok', r === 'deleted' ? 'Undone — the transaction it added was deleted, and the item is back for review.'
          : r === 'unmatched' ? 'Undone — the match was removed; the books transaction stays.' : 'Back for review.') ?? true;
      }
    }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return show(error.message, v, 422);
  }
  throw new HttpError(404, 'Not found');
}

// Banking → Rules: list, new (optionally from a bank item), edit, delete. Saving an auto rule applies it to waiting items.
async function ruleRoutes(h, rm, { canReview }) {
  const { req, query, form, pool, page, base, go, takeFlash, scope, actor } = h;
  if (!canReview) throw new HttpError(403, 'Only people who keep the books can change rules.');
  const [, which, del] = rm;
  const rule = which && which !== 'new' ? (await getRule(pool, { ...scope, ruleId: which }) ?? (() => { throw new HttpError(404, 'Rule not found'); })()) : null;
  const lists = async () => {
    const q = (sql) => pool.query(sql, [scope.orgId, scope.entityId]).then(r => r.rows);
    const accts = await q('SELECT account_id, name, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(name)');
    const usable = accts.filter(a => !['ar', 'ap', 'undeposited'].includes(a.system_key));
    const vendors = await q(`SELECT 'v:' || vendor_id AS key, display_name AS name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(display_name)`);
    const customers = await q(`SELECT 'c:' || customer_id AS key, display_name AS name FROM customer WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(display_name)`);
    const classes = await q('SELECT class_id, name FROM class WHERE org_id = $1 AND entity_id = $2 ORDER BY lower(name)');
    const locations = await q('SELECT location_id, name FROM location WHERE org_id = $1 AND entity_id = $2 ORDER BY lower(name)');
    return { feeds: await bankAccounts(pool, scope), payees: [...vendors, ...customers], classes, locations,
      categories: Object.entries(GROUP).map(([type, label]) => [label, usable.filter(a => a.type === type)]).filter(([, l]) => l.length) };
  };
  const showForm = async (v, error = null, status = 200) => { page(ruleForm({ ...base(), flash: takeFlash(), rule, v, error, ...(await lists()) }), status); return true; };

  if (!which) {
    if (req.method === 'GET') {
      const { payees } = await lists();
      page(rulesPage({ ...base(), flash: takeFlash(), rules: await listRules(pool, scope), payeeNames: new Map(payees.map(p => [p.key, p.name])) }));
      return true;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  }
  if (del) {
    if (req.method !== 'POST' || !rule) throw new HttpError(405, 'Method not allowed');
    await deleteRule(pool, { ...scope, ruleId: rule.rule_id });
    return go('/banking/rules', 'ok', `Rule “${rule.name}” deleted.`) ?? true;
  }
  if (req.method === 'GET') {
    if (rule) {
      return showForm({ name: rule.name, priority: rule.priority, active: rule.active, money: rule.money, llAccount: rule.ll_account ?? '', matchAll: rule.match_all,
        conditions: rule.conditions, payee: rule.payee ?? '', accountId: rule.account_id ?? '', classId: rule.class_id ?? '', locationId: rule.location_id ?? '',
        memo: rule.memo ?? '', mode: rule.mode });
    }
    // New, maybe from a bank item: money direction, the account, and the payee part of its description.
    const item = query.from ? await getBankItem(pool, { ...scope, itemId: query.from }) : null;
    const key = item ? payeeKey(item.merchant_name || item.description) : '';
    const name = key.split(' ').filter(Boolean).map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    return showForm(item ? { name, money: Number(item.amount_cents) < 0 ? 'out' : 'in', llAccount: item.ll_account,
      conditions: key ? [{ field: 'description', op: 'contains', value: key.split(' ')[0] }] : [], mode: 'suggest' } : { money: 'out', mode: 'suggest' });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const fields = form.getAll('cond_field'), ops = form.getAll('cond_op'), vals = form.getAll('cond_value'), vals2 = form.getAll('cond_value2');
  const v = { name: form.get('name') ?? '', priority: form.get('priority') ?? '', money: form.get('money'), llAccount: form.get('llAccount') ?? '',
    matchAll: form.get('matchAll') !== '0', conditions: fields.map((f, i) => ({ field: f, op: ops[i], value: vals[i] ?? '', value2: vals2[i] ?? '' })),
    payee: form.get('payee') ?? '', accountId: form.get('accountId') ?? '', classId: form.get('classId') ?? '', locationId: form.get('locationId') ?? '',
    memo: form.get('memo') ?? '', mode: form.get('mode'), active: form.get('active') === '1' };
  try {
    await saveRule(pool, { ...scope, ruleId: rule?.rule_id ?? null, fields: v, actor });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return showForm(v, error.message, 422);
  }
  // In a practice copy an automatic rule only suggests (lib/domain/practice.js).
  const practice = isPractice(h.env);
  const added = v.mode === 'auto' && v.active && !practice ? await applyAutoRules(pool, scope) : 0;
  return go('/banking/rules', 'ok', `Rule “${v.name.trim()}” saved.${added ? ` It added ${added} waiting bank item${added === 1 ? '' : 's'}.` : ''}${practice && v.mode === 'auto' ? ' Practice copy: it suggests, it doesn’t add.' : ''}`) ?? true;
}
