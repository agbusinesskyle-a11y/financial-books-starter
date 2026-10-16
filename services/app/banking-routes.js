import { isDemo, DEMO_BATCH_MAX } from '../../lib/domain/demo.js';
import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { verifiedMonths, bankAccounts, listBankItems, tabCounts, getBankItem, matchCandidates, matchItem, addItem, addItemTx, transferItem, excludeItems, excludeItemsTx, undoItem,
  undoPlan, undoConfirmText, markChecked, possibleDuplicates, BANK_TABS, DuplicateError, StaleError, itemToken, evidenceToken, txnVersions, itemHistory, positionInTab,
  settleItem, settleItemTx, settleCandidates, findMatches, countBankItems, matchingItemIds, BANK_SORTS, BANK_HOW, undoItemTx, addItemTx as addOneTx } from '../../lib/data/banking.js';
import { parseMoney } from '../../lib/domain/money.js';
import { addBankAttachment, listBankAttachments, getBankAttachment, deleteBankAttachment, addBankNote, listBankNotes } from '../../lib/data/bank-extras.js';
import { attachmentHeader, downloadType } from '../../lib/data/documents.js';
import { backdatedBill } from '../../lib/data/banking.js';

// The bank item page takes a file (stage BR-7).
// A payee key (v:/c:) as its name in this company, for showing only.
async function payeeName(db, { orgId, entityId }, key) {
  const m = /^([vc]):(\d{1,18})$/.exec(String(key ?? ''));
  if (!m) return null;
  const { rows: [r] } = await db.query(m[1] === 'v' ? 'SELECT display_name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND vendor_id = $3'
    : 'SELECT display_name FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3', [orgId, entityId, Number(m[2])]);
  return r?.display_name ?? null;
}

export const BANK_UPLOAD_PATH = /^\/banking\/item\/\d{1,18}\/attach$/;
import { withTransaction } from '../../lib/db.js';
import { lockEntity } from '../../lib/data/writes.js';
import { listRules, getRule, saveRule, deleteRule, learnedHistory, suggestFor, previewFor, acceptSuggestions, applyAutoRules, payeeKey, intentOf, categoryHistory, ruleStamp, ruleAction,
  checkRule, previewRule, exportRules, importRules, ruleAccounts } from '../../lib/bankfeed/rules.js';
import { dimensionChoices } from '../../lib/data/accounting.js';
import { categoryChoices, payeeChoices, resolveCategory, resolvePayee, categoryName, pickerSnapshot, snapshotChoices, atSnapshot } from '../../lib/bankfeed/pickers.js';
import { saveVendor } from '../../lib/data/vendors.js';
import { saveCustomer } from '../../lib/data/writes.js';
import { bankingPage, bankItemPage, batchResultsPage, batchConfirmPage } from '../../lib/views/banking.js';
import { rulesPage, ruleForm, rulesImportPage } from '../../lib/views/bank-rules.js';
import { canAccess } from '../../lib/domain/roles.js';
import { listUndeposited } from '../../lib/data/deposits.js';
import { settingsKey } from '../../lib/secrets.js';
import { getAiSettings, PROVIDERS } from '../../lib/ai/provider.js';
import { researchItem, latestResearch, acceptResearch, rejectResearch, getResearch, researchFits } from '../../lib/ai/vendor-research.js';
import { isPractice } from '../../lib/domain/practice.js';

// Bank transactions (stage B3): /banking (cards, tabs, batch accept/exclude) and /banking/item/:id (match, add, transfer,
// exclude, undo). Reviewing is for people who keep the books (admin, standard); reports-only people can look.
const PAGE = 50;
const PAGE_SIZES = [50, 100, 200, 300];
// The list's filters, order and page size from the address (stage BR-6); raw: what to keep in links and forms.
export function listQuery(q = {}) {
  const money = v => { const c = parseMoney(String(v ?? '').trim()); return c === null ? null : c; };
  const id = v => (/^\d{1,18}$/.test(String(v ?? '')) ? Number(v) : null);
  const raw = {};
  for (const k of ['q', 'from', 'to', 'min', 'max', 'dir', 'category', 'rule', 'how', 'sort', 'size']) if (String(q[k] ?? '').trim()) raw[k] = String(q[k]).trim().slice(0, 100);
  return { raw, sort: BANK_SORTS[raw.sort] ? raw.sort : 'new', size: PAGE_SIZES.includes(Number(raw.size)) ? Number(raw.size) : PAGE,
    filters: { q: raw.q ?? '', from: raw.from ?? null, to: raw.to ?? null, min: money(raw.min), max: money(raw.max), dir: raw.dir, category: id(raw.category),
      rule: id(raw.rule), how: BANK_HOW[raw.how] ? raw.how : null } };
}
const hasFilters = list => Object.keys(list.raw).some(k => !['sort', 'size'].includes(k));
const locked = (pool, { orgId, entityId }, fn) => withTransaction(pool, async tx => { await lockEntity(tx, orgId, entityId); return fn(tx); });
// A read-only, repeatable-read snapshot for building a page.
async function snapshot(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}
const GROUP = { income: 'Income', other_income: 'Other income', cost_of_goods_sold: 'Cost of goods sold', expense: 'Expenses', other_expense: 'Other expenses',
  bank: 'Bank', credit_card: 'Credit cards', other_current_asset: 'Other current assets', fixed_asset: 'Fixed assets', other_asset: 'Other assets',
  other_current_liability: 'Other current liabilities', long_term_liability: 'Long-term liabilities', equity: 'Equity' };

export async function bankingRoutes(h) {
  // The picker lists a page shows, kept as snapshots (their hashes go in its forms), and the ones a form says it was shown.
  const shownLists = async (cats, payees) => ({ catsV: await pickerSnapshot(h.pool, { ...h.scope, kind: 'category', choices: cats }),
    payeesV: await pickerSnapshot(h.pool, { ...h.scope, kind: 'payee', choices: payees }) });
  const shownChoices = async f => ({ cats: await snapshotChoices(h.pool, { ...h.scope, kind: 'category', hash: f.get('cats_v') }),
    payees: await snapshotChoices(h.pool, { ...h.scope, kind: 'payee', hash: f.get('payees_v') }) });
  // A form shown again after an error: each choice it kept is resolved with the list the page showed and carried as that
  // record ({ id } / { key }); the new page prints the record's label from the very list whose snapshot it attaches (or leaves
  // the field empty when the record isn't on it any more), so the label and the new snapshot always agree. A choice whose
  // page list is unknown is dropped; text the old list didn't have is kept as typed.
  const carryChoices = async f => {
    const shown = await shownChoices(f);
    const carry = (resolve, list, kind) => text => {
      if (!String(text ?? '').trim()) return text ?? '';
      if (!list) return '';
      const r = resolve(list, text);
      if (!r || r.error || r.unknown !== undefined) return text;
      return kind === 'payee' ? { key: r.key } : { id: r.id };
    };
    return { category: carry(resolveCategory, shown.cats, 'category'), payee: carry(resolvePayee, shown.payees, 'payee') };
  };
  const accountNames = async () => new Map((await h.pool.query('SELECT account_id, name FROM account WHERE org_id = $1 AND entity_id = $2', [h.scope.orgId, h.scope.entityId]))
    .rows.map(a => [Number(a.account_id), a.name]));
  const { req, path, query, form, pool, page, base, go, takeFlash, ctx, scope, actor, who } = h;
  if (path !== '/banking' && !path.startsWith('/banking/')) return false;
  const canReview = canAccess(who.role, 'POST', '/banking/batch');
  const accounts = await bankAccounts(pool, scope);
  for (const a of accounts) a.verified = (await verifiedMonths(pool, { ...scope, accountId: a.books_account_id }))[0] ?? null;

  // The list page. draft: { itemId, payee, category, error, create } — a row whose post failed, shown again with what was
  // typed (when the page works without JavaScript).
  const showList = async (current, tab, pageNo, { draft = null, status = 200, focus = null, list = listQuery() } = {}) => {
    let items = [], counts = { review: 0, categorized: 0, excluded: 0, changed: 0 }, more = false, total = 0, rules = [];
    const suggestions = new Map(), intents = new Map(), undo = new Map(), previews = new Map(), receipts = new Map();
    let cats = [], payees = [];
    // One consistent snapshot: every row, its suggestion and the plan it carries are read at the same moment.
    if (current) await snapshot(pool, async db => {
      const rows = await listBankItems(db, { ...scope, llAccountId: current.id, tab, limit: list.size + 1, offset: list.size * (pageNo - 1), filters: list.filters, sort: list.sort });
      more = rows.length > list.size;
      items = rows.slice(0, list.size);
      counts = await tabCounts(db, { ...scope, llAccountId: current.id });
      total = hasFilters(list) ? await countBankItems(db, { ...scope, llAccountId: current.id, tab, filters: list.filters }) : counts[tab] ?? 0;
      rules = await listRules(db, scope);
      cats = await categoryChoices(db, scope);
      // Categorized and Excluded: each row's Undo, with exactly what it would do.
      if (tab !== 'review' && canReview) {
        for (const i of items) {
          if (i.review_state === 'new') continue;
          const plan = await undoPlan(db, { ...scope, itemId: i.item_id });
          undo.set(Number(i.item_id), { token: plan.token, confirm: undoConfirmText(plan) });
        }
      }
      if (tab === 'review') {
        const history = await learnedHistory(db, scope), undeposited = await listUndeposited(db, scope);
        payees = await payeeChoices(db, scope);
        for (const i of items.filter(x => !x.pending)) {
          const item = await getBankItem(db, { ...scope, itemId: i.item_id });
          if (!item) continue;
          // The row shows the bank line the suggestion was worked out from (it may have been corrected since the list was read).
          for (const k of ['revision', 'review_version', 'amount_cents', 'posted_date', 'review_state', 'pending', 'description', 'merchant_name', 'check_number', 'receipt_ids']) i[k] = item[k];
          const s = await suggestFor(db, { ...scope, item, rules, history, undeposited });
          if (s) suggestions.set(Number(i.item_id), s);
          const intent = intentOf(s, item);
          if (intent) intents.set(Number(i.item_id), intent);
        }
        // Texted receipts matched to these lines (stage S3): shown on the row, and they fill in what the row leaves empty.
        const { rows: rcpts } = await db.query(`SELECT r.receipt_id, r.item_id, r.vendor_id, r.account_id, r.extracted, r.created_at, r.content_type, s.name AS sender
            FROM receipt r LEFT JOIN sms_sender s ON s.sender_id = r.sender_id
           WHERE r.org_id = $1 AND r.entity_id = $2 AND r.status = 'review' AND r.item_id = ANY($3::bigint[]) ORDER BY r.receipt_id`,
        [scope.orgId, scope.entityId, items.map(x => Number(x.item_id))]);
        // Only the ones that still fit the line as it is now (the same set a review takes: getBankItem's receipt_ids).
        const fitting = new Map(items.map(x => [Number(x.item_id), new Set(String(x.receipt_ids ?? '').split(',').filter(Boolean))]));
        for (const r of rcpts.filter(x => fitting.get(Number(x.item_id))?.has(String(x.receipt_id)))) (receipts.get(Number(r.item_id)) ?? receipts.set(Number(r.item_id), []).get(Number(r.item_id))).push(r);
        // Pending lines: what they'll be suggested as once they post (stage S2), shown only.
        for (const i of items.filter(x => x.pending)) {
          const item = await getBankItem(db, { ...scope, itemId: i.item_id });
          const p = item ? await previewFor(db, { ...scope, item, rules, history }) : null;
          if (p) previews.set(Number(i.item_id), { s: p, payee: await payeeName(db, scope, p.payee) });
        }
      }
    });
    page(bankingPage({ ...base(), flash: takeFlash(), timeZone: ctx.timeZone, accounts, current, tab, items, counts, suggestions, intents, previews, receipts, accountNames: await accountNames(), page: pageNo, more,
      canRefresh: canAccess(who.role, 'POST', '/bank-feeds/refresh'), canReview, practice: isPractice(h.env), cats, payees, draft, focus, list, total, rules, undo,
      filtered: hasFilters(list), ...(await shownLists(cats, payees)) }), status);
    return true;
  };

  if (path === '/banking' && req.method === 'GET') {
    const current = accounts.find(a => a.id === query.account) ?? accounts[0] ?? null;
    const tab = BANK_TABS.includes(query.tab) ? query.tab : 'review';
    const pageNo = Math.max(1, Math.min(1000, Number(query.page) || 1));
    return showList(current, tab, pageNo, { focus: /^\d{1,18}$/.test(query.focus ?? '') ? Number(query.focus) : null, list: listQuery(query) });
  }

  // CSV of a tab as filtered (stage BR-6): every matching item, not only the page shown.
  if (path === '/banking/export.csv' && req.method === 'GET') {
    const current = accounts.find(a => a.id === query.account) ?? (() => { throw new HttpError(404, 'Account not found'); })();
    const tab = BANK_TABS.includes(query.tab) ? query.tab : 'categorized';
    const list = listQuery(query);
    const rows = await listBankItems(pool, { ...scope, llAccountId: current.id, tab, limit: 20000, offset: 0, filters: list.filters, sort: list.sort });
    // A cell a spreadsheet could read as a formula — = + - @ first, even after spaces or control characters, or starting with a
    // tab or line break — is made text with a leading apostrophe; quotes and line breaks are quoted.
    const cell = v => {
      let t = String(v ?? '');
      if (/^[\s\x00-\x1f]*[=+\-@]/.test(t) || /^[\t\r\n]/.test(t)) t = `'${t}`;
      return /[",\r\n\t]/.test(t) || t.startsWith("'") ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const money = c => (c ? (Math.abs(c) / 100).toFixed(2) : '');
    const lines = [['Date', 'Description', 'Bank text', 'Spent', 'Received', 'Status', 'Recorded as', 'Payee', 'Category', 'Rule', 'How', 'By'].join(',')];
    for (const i of rows) {
      const amt = Number(i.amount_cents);
      lines.push([i.posted_date, i.description, i.original_description, amt < 0 ? money(amt) : '', amt > 0 ? money(amt) : '',
        i.review_state === 'new' ? 'For review' : i.review_state === 'excluded' ? 'Excluded' : i.review_state === 'matched' ? 'Matched' : 'Added',
        i.links.map(l => `${l.type}${l.doc_number ? ` ${l.doc_number}` : ''}`).join('; '), [...new Set(i.links.map(l => l.party).filter(Boolean))].join('; '), i.categories ?? '',
        i.rule_name ?? '', i.made_event?.source ?? '', i.made_event?.actor ?? i.reviewed_by ?? ''].map(cell).join(','));
    }
    h.send(h.res, 200, `${lines.join('\r\n')}\r\n`, { ...h.extra, 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="bank-${tab}-${current.books_name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.csv"` });
    return true;
  }

  // One row of For review, reviewed in place (stage BR-2): Post (add as the payee and category in the row) or Match (the
  // match the row shows). A page with JavaScript posts it in the background and gets JSON back; without, the browser goes
  // back to the list at the next row (or the row again, with what was typed and why it didn't go through).
  const rowM = /^\/banking\/item\/(\d{1,18})\/row$/.exec(path);
  if (rowM) {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
    const json = String(req.headers.accept ?? '').includes('application/json');
    const item = await getBankItem(pool, { ...scope, itemId: rowM[1] }) ?? (() => { throw new HttpError(404, 'Bank item not found'); })();
    const current = accounts.find(a => a.id === item.ll_account) ?? null;
    // What was typed, and the rule (as it stood) that filled the row in, kept to show again if it can't go through.
    const ruleId = /^\d{1,18}$/.test(form.get('rule') ?? '') ? form.get('rule') : null;
    const draft = { itemId: Number(item.item_id), payee: form.get('payee') ?? '', category: form.get('category') ?? '', memo: form.get('memo') ?? '',
      rule: ruleId, ruleAt: ruleId ? form.get('rule_at') ?? '' : null,
      // The history suggestion the row showed, if it showed one.
      hist: form.get('basis') === 'history' ? { account: form.get('hist_account') ?? '', payee: form.get('hist_payee') ?? '', classId: form.get('hist_class') ?? '',
        locationId: form.get('hist_location') ?? '' } : null };
    const next = /^\d{1,18}$/.test(form.get('next') ?? '') ? Number(form.get('next')) : null;
    const fail = async (error, extra = {}) => {
      if (json) { h.send(h.res, 422, JSON.stringify({ ok: false, error, ...extra }), { ...h.extra, 'Content-Type': 'application/json; charset=utf-8' }); return true; }
      const at = await positionInTab(pool, { ...scope, llAccountId: item.ll_account, itemId: item.item_id });
      const carry = await carryChoices(form);
      const kept = { ...draft, category: carry.category(draft.category), payee: extra.create ? draft.payee : carry.payee(draft.payee) };
      // A row whose rule changed is shown afresh, with the rule as it is now — not as typed.
      return showList(current, 'review', Math.floor(at / PAGE) + 1, { draft: extra.fresh ? { itemId: draft.itemId, fresh: true, error } : { ...kept, error, ...extra },
        status: 422, focus: Number(item.item_id) });
    };
    try {
      const rev = form.get('rev');
      if (!rev) throw new StaleError('This page is out of date. Reload it.');
      let message;
      if (form.get('mode') === 'settle') {
        // The open bill or invoice the row suggested (stage S4): under the company lock it must still be the one suggested,
        // as it was (version) with the same evidence around it; then it's settled as the item page's Match would.
        const txn = Number(form.get('txn'));
        await locked(pool, scope, async tx => {
          const now = await getBankItem(tx, { ...scope, itemId: item.item_id, lock: true });
          const again = now ? await suggestFor(tx, { ...scope, item: now, rules: await listRules(tx, scope), history: await learnedHistory(tx, scope) }) : null;
          if (again?.source !== 'settle' || again.doc.txn_id !== txn) throw new StaleError('This bank item’s suggestion changed since the page was shown. Look at it again.');
          return settleItemTx(tx, { ...scope, itemId: item.item_id, settle: [{ txnId: txn, amountCents: Math.abs(Number(now.amount_cents)) }], actor, source: 'row',
            expect: { rev, versions: new Map([[txn, form.get('ver') ?? '']]), evidence: form.get('evidence') ?? '' } });
        });
        message = `Matched: ${item.description}.`;
      } else if (form.get('mode') === 'match') {
        const txn = Number(form.get('txn'));
        await matchItem(pool, { ...scope, itemId: item.item_id, txnIds: [txn], actor, source: 'row', basis: 'match',
          expect: { rev, versions: new Map([[txn, form.get('ver') ?? '']]) } });
        message = `Matched: ${item.description}.`;
      } else {
        // The rule that filled the row in must still be as it was when the page was shown (checked first, and again under the
        // company lock): otherwise the row is shown again with the rule as it is now.
        const staleRule = 'The rule that filled this row in was changed since the page was shown. Check the row again.';
        if (ruleId && !sameRule(await getRule(pool, { ...scope, ruleId }), draft.ruleAt)) return fail(staleRule, { fresh: true });
        const cats = await categoryChoices(pool, scope), payees = await payeeChoices(pool, scope);
        // Everything typed is checked before anything is created.
        // Names are resolved with the lists the page showed (its snapshot): they mean the records the person saw.
        const shown = await shownChoices(form);
        const c = atSnapshot(resolveCategory, { shown: shown.cats, current: cats, text: draft.category, kind: 'category' });
        if (!c) return fail('Choose a category.');
        if (c.error) return fail(c.error);
        const p = atSnapshot(resolvePayee, { shown: shown.payees, current: payees, text: draft.payee, kind: 'payee' });
        if (p?.error) return fail(p.error);
        // Create vendor / Create customer means a new one: if the name now fits someone (added meanwhile), it's refused, never
        // quietly given to them.
        if (p?.key && ['vendor', 'customer'].includes(form.get('create'))) return fail(createdMeanwhile(draft.payee, p.key));
        const kind = p?.unknown ? form.get('create') : null;
        if (p?.unknown && !['vendor', 'customer'].includes(kind)) return fail(`“${p.unknown}” isn’t a vendor or customer yet.`, { create: p.unknown });
        // A rule filled the row in and the person kept what it said: the rule is the reason, and its class and location go on
        // the transaction — the rule read under the lock, exactly as it stood when the page was shown.
        const post = async (tx, payeeKey) => {
          const r = ruleId ? await getRule(tx, { ...scope, ruleId }) : null;
          if (ruleId && !sameRule(r, draft.ruleAt)) throw new RuleChangedError(staleRule);
          await stillUsable(tx, scope, { payeeKey, accountIds: [c.id] });
          const rule = r && Number(r.account_id) === c.id && !r.splits && (payeeKey || null) === (r.payee ?? null) ? r : null;
          // A history suggestion posted as shown (same category and payee) keeps the class and location it showed (they are
          // checked against the company's classes and locations as they're applied).
          const hist = !rule && draft.hist && Number(draft.hist.account) === c.id && (payeeKey || '') === (draft.hist.payee || '') ? draft.hist : null;
          const dimsOf = x => ({ ...(/^\d{1,18}$/.test(String(x.classId ?? '')) ? { classId: Number(x.classId) } : {}),
            ...(/^\d{1,18}$/.test(String(x.locationId ?? '')) ? { locationId: Number(x.locationId) } : {}) });
          return addItemTx(tx, { ...scope, itemId: item.item_id, payee: payeeKey ?? '', memo: form.has('memo') ? draft.memo : rule ? ruleAction(rule, item).memo : '', lines: [{ accountId: c.id, amount: '' }],
            actor, source: 'row', basis: rule ? 'rule' : hist ? 'history' : 'person', rule, matchOther: !isPractice(h.env),
            dims: rule ? dimsOf({ classId: rule.class_id, locationId: rule.location_id }) : hist ? dimsOf(hist) : {},
            // "Post as new" on a row that showed what the books may already hold: separate, for exactly that evidence.
            ...(form.get('separate') === '1' ? { separate: true, expect: { rev, evidence: form.get('evidence') || undefined } } : { expect: { rev } }) });
        };
        // A new vendor or customer is created in the same transaction as the posting: if the posting is refused, it isn't kept.
        await createAndPost(h, { kind, name: p?.unknown, payeeKey: p?.key ?? '', post });
        message = `Posted: ${item.description} → ${categoryName(cats, c.id)}.`;
      }
      if (json) { h.send(h.res, 200, JSON.stringify({ ok: true, message, itemId: Number(item.item_id), next }), { ...h.extra, 'Content-Type': 'application/json; charset=utf-8' }); return true; }
      const at = next ? await positionInTab(pool, { ...scope, llAccountId: item.ll_account, itemId: next }) : 0;
      return go(`/banking?account=${item.ll_account}&tab=review&page=${Math.floor(at / PAGE) + 1}${next ? `&focus=${next}#item-${next}` : ''}`, 'ok', message) ?? true;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return fail(error.message, error instanceof DuplicateError ? { duplicate: true } : error instanceof RuleChangedError ? { fresh: true } : {});
    }
  }

  if (path === '/banking/batch') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const account = accounts.find(a => a.id === form.get('account')) ?? (() => { throw new HttpError(404, 'Account not found'); })();
    const tab = BANK_TABS.includes(form.get('tab')) ? form.get('tab') : 'review';
    const list = listQuery(Object.fromEntries([...new URLSearchParams(form.get('list') ?? '')]));
    const back = `/banking?${new URLSearchParams({ account: account.id, tab, ...list.raw })}`;
    // "All N matching" (all=<action>:<count>): every item the filters fit now — refused unless it's still exactly the count the
    // person was shown.
    const allM = /^(exclude|assign|undo):(\d{1,5})$/.exec(form.get('all') ?? '');
    const all = allM ? Number(allM[2]) : null;
    const action = allM ? allM[1] : ['accept', 'exclude', 'assign', 'undo'].includes(form.get('action')) ? form.get('action') : 'accept';
    if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
    const ticked = [...new Set(form.getAll('item'))].slice(0, 1000);
    try {
      // "All N matching", step one: record exactly which items match now, each as it is now (its revision, or its Undo plan),
      // and show them. Nothing is changed until the person confirms that list (/banking/batch/confirm).
      if (all !== null) {
        if (action === 'accept') return go(back, 'warn', 'Accept works on ticked items, each as its row shows it.') ?? true;
        const sel = await recordSelection(h, { account, tab, list, action, count: all });
        if (sel.count !== all) return go(back, 'warn', `${sel.count} items match now, not ${all}. Check the list and try again.`) ?? true;
        page(batchConfirmPage({ ...base(), action, back, ...sel }));
        return true;
      }
      // Only what a person ticked, in every mode: none, nothing happens.
      if (!ticked.length) return go(back, 'warn', 'Tick the items first.') ?? true;
      if (action === 'assign' || action === 'undo') {
        const what = action === 'assign' ? await assignChoice(h, form) : {};
        const tokens = new Map(ticked.map(id => [Number(id), form.get(action === 'assign' ? `rev_${id}` : `plan_${id}`)]).filter(([, v]) => v));
        const results = await batchEach(h, { ids: ticked, action, tokens, ...what });
        page(batchResultsPage({ ...base(), action, back, results }));
        return true;
      }
      // Each ticked item carries the bank line as shown (rev_) and, for Accept, the plan it showed (intent_); anything that
      // changed since is skipped, not turned into something else. Every ticked item gets its outcome on the results page.
      const names = new Map((await pool.query('SELECT item_id, description FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND item_id = ANY($3::bigint[])',
        [scope.orgId, scope.entityId, ticked.map(Number).filter(Number.isSafeInteger)])).rows.map(r => [Number(r.item_id), r.description]));
      let results;
      if (action === 'exclude') {
        const revs = new Map(ticked.map(id => [Number(id), form.get(`rev_${id}`)]).filter(([, v]) => v));
        const missing = ticked.map(Number).filter(id => !revs.has(id));
        const r = await locked(pool, scope, tx => excludeItemsTx(tx, { ...scope, itemIds: ticked.filter(id => revs.has(Number(id))), actor, source: 'batch', expect: { revs } }))
          .catch(error => { if (error instanceof ValidationError && !revs.size) return { excluded: [], skipped: [] }; throw error; });
        results = [...r.excluded.map(id => ({ itemId: id, outcome: 'excluded' })), ...r.skipped.map(s => ({ ...s, outcome: 'skipped' })),
          ...missing.map(id => ({ itemId: id, outcome: 'skipped', reason: 'the page didn’t show it — reload and try again' }))];
      } else {
        const intents = new Map(ticked.map(id => [Number(id), form.get(`intent_${id}`)]).filter(([, v]) => v));
        const revs = new Map(ticked.map(id => [Number(id), form.get(`rev_${id}`)]).filter(([, v]) => v));
        results = (await acceptSuggestions(pool, { ...scope, llAccountId: account.id, itemIds: ticked, intents, revs, actor, matchOther: !isPractice(h.env) })).results;
      }
      page(batchResultsPage({ ...base(), action, back,
        results: results.map(x => ({ ...x, description: x.description || names.get(Number(x.itemId)) || `Item ${x.itemId}` })) }));
      return true;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return go(back, 'error', error.message) ?? true;
    }
  }

  // "All N matching", step two: carry out exactly the recorded list, each item checked as a ticked row is (its revision, or its
  // Undo plan); anything that changed since it was shown is left, with the reason.
  if (path === '/banking/batch/confirm') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
    const id = /^[0-9a-f-]{36}$/.test(form.get('selection') ?? '') ? form.get('selection') : null;
    const { rows: [sel] } = id ? await pool.query(`DELETE FROM bank_batch_selection WHERE org_id = $1 AND entity_id = $2 AND selection_id = $3 AND actor = $4
        AND created_at > now() - interval '1 hour' RETURNING *`, [scope.orgId, scope.entityId, id, actor]) : { rows: [] };
    if (!sel) return go('/banking', 'warn', 'That list has expired or was already done. Show the list again.') ?? true;
    // In the public demo the recorded list itself is held to the batch limit too, not only the request that made it.
    if (isDemo(h.env) && sel.items.length > DEMO_BATCH_MAX) return go('/banking', 'warn', `That list has ${sel.items.length} items; the demo does at most ${DEMO_BATCH_MAX} at a time.`) ?? true;
    const back = `/banking?${new URLSearchParams({ account: sel.ll_account_id, tab: sel.tab, ...Object.fromEntries(new URLSearchParams(sel.list)) })}`;
    const tokens = new Map(sel.items.map(([itemId, token]) => [Number(itemId), token]));
    let results;
    if (sel.action === 'exclude') {
      const names = await itemNames(h, [...tokens.keys()]);
      const r = await locked(pool, scope, tx => excludeItemsTx(tx, { ...scope, itemIds: [...tokens.keys()], actor, source: 'batch', expect: { revs: tokens } }));
      results = [...r.excluded.map(i => ({ itemId: i, outcome: 'excluded' })), ...r.skipped.map(x => ({ ...x, outcome: 'skipped' }))]
        .map(x => ({ ...x, description: names.get(Number(x.itemId)) ?? `Item ${x.itemId}` }));
    } else {
      results = await batchEach(h, { ids: [...tokens.keys()], action: sel.action, tokens,
        ...(sel.action === 'assign' ? { lines: [{ accountId: sel.detail.accountId, amount: '' }], payee: sel.detail.payee ?? '' } : {}) });
    }
    page(batchResultsPage({ ...base(), action: sel.action, back, results }));
    return true;
  }

  const rm = /^\/banking\/rules(?:\/(new|export|import|\d{1,18}))?(\/delete)?$/.exec(path);
  if (rm) return ruleRoutes(h, rm, { canReview });

  // AI vendor research: accept or reject a proposal (stage B5).
  const rr = /^\/banking\/research\/(\d{1,18})\/(accept|reject)$/.exec(path);
  if (rr) {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
    const r = await getResearch(pool, { ...scope, researchId: rr[1] }) ?? (() => { throw new HttpError(404, 'Research not found'); })();
    // Back to the bank line the person was on (research can be shared by a payee's lines).
    const onItem = /^\d{1,18}$/.test(form.get('item') ?? '') ? Number(form.get('item')) : Number(r.item_id);
    const back = `/banking/item/${onItem}`;
    try {
      if (rr[2] === 'reject') {
        await rejectResearch(pool, { ...scope, researchId: r.research_id, actor });
        return go(back, 'ok', 'Research rejected.') ?? true;
      }
      const a = await acceptResearch(pool, { ...scope, researchId: r.research_id, itemId: onItem, actor, key: settingsKey(h.env) });
      return go(`${back}?research=${r.research_id}`, 'ok', 'Accepted — the vendor and category are filled in below. Check them, then Add.') ?? true;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return go(back, 'error', error.message) ?? true;
    }
  }

  // A file on the bank line: download, or remove (stage BR-7).
  const fm = /^\/banking\/item\/(\d{1,18})\/attachment\/(\d{1,18})(\/delete)?$/.exec(path);
  if (fm) {
    if (fm[3]) {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
      try {
        await deleteBankAttachment(pool, { ...scope, itemId: fm[1], attachmentId: fm[2] });
        return go(`/banking/item/${fm[1]}`, 'ok', 'File removed from the bank item.') ?? true;
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return go(`/banking/item/${fm[1]}`, 'error', error.message) ?? true;
      }
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const a = await getBankAttachment(pool, { ...scope, itemId: fm[1], attachmentId: fm[2] }) ?? (() => { throw new HttpError(404, 'File not found'); })();
    h.send(h.res, 200, a.content, { ...h.extra, 'Content-Type': downloadType(a.filename), 'Content-Disposition': attachmentHeader(a.filename), 'X-Content-Type-Options': 'nosniff' });
    return true;
  }

  const m = /^\/banking\/item\/(\d{1,18})(\/(match|add|transfer|exclude|undo|research|checked|attach|note|bill))?$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const listed = await getBankItem(pool, { ...scope, itemId: m[1] });
  if (!listed) throw new HttpError(404, 'Bank item not found');
  const item = listed;
  const here = `/banking/item/${item.item_id}`;
  // The item page is read from one consistent snapshot: the facts shown, the candidates, the possible duplicates, the Undo
  // plan and every token the forms carry describe the same moment.
  const show = (error = null, v = null, status = 200, dupes = null, createPayee = null, mv = null) => snapshot(pool, async db => {
    const item = (await getBankItem(db, { ...scope, itemId: listed.item_id })) ?? listed;
    const waiting = item.review_state === 'new' && item.bank_state === 'active' && !item.pending;
    const candidates = waiting ? await matchCandidates(db, { ...scope, item, others: true }) : { exact: [], others: [], undeposited: [] };
    // Find match: a search the person ran (stage BR-3), and the open bills or invoices this line could pay.
    const find = waiting && query.find === '1' ? { q: String(query.q ?? '').slice(0, 100), from: query.from ?? '', to: query.to ?? '', amount: String(query.amount ?? '').slice(0, 20),
      type: query.type ?? '' } : null;
    const found = find ? await findMatches(db, { ...scope, item, q: find.q, from: find.from, to: find.to, type: find.type,
      amountCents: parseMoney(find.amount.replace(/^-/, '')) }) : null;
    const settleDocs = waiting ? await settleCandidates(db, { ...scope, item, q: find?.q ?? '' }) : [];
    const wv = await txnVersions(db, candidates.undeposited.map(u => u.txn_id));
    for (const u of candidates.undeposited) u.version = wv.get(Number(u.txn_id));
    const { rows: links } = await db.query(`SELECT t.txn_id, t.type, t.doc_number, t.txn_date, k.how, txn_party(t.txn_id) AS party
      FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1 ORDER BY t.txn_date, t.txn_id`, [item.item_id]);
    const events = await itemHistory(db, { ...scope, item });
    const { rows: accts } = await db.query(`SELECT account_id, name, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(name)`,
      [scope.orgId, scope.entityId]);
    const usable = accts.filter(a => Number(a.account_id) !== Number(item.books_account_id) && !['ar', 'ap', 'undeposited'].includes(a.system_key));
    const categories = Object.entries(GROUP).map(([type, label]) => [label, usable.filter(a => a.type === type)]).filter(([, list]) => list.length);
    const transferTo = usable.filter(a => !a.system_key && ['bank', 'credit_card', 'other_current_asset', 'other_asset', 'other_current_liability', 'long_term_liability'].includes(a.type));
    const { rows: vendors } = await db.query(`SELECT 'v:' || vendor_id AS key, display_name AS name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(display_name)`,
      [scope.orgId, scope.entityId]);
    const { rows: customers } = await db.query(`SELECT 'c:' || customer_id AS key, display_name AS name FROM customer WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(display_name)`,
      [scope.orgId, scope.entityId]);
    const learned = waiting || item.pending ? await learnedHistory(db, scope) : null;
    const pendingPreview = item.pending && item.review_state === 'new' ? await previewFor(db, { ...scope, item, rules: await listRules(db, scope), history: learned }) : null;
    const preview = pendingPreview ? { s: pendingPreview, payee: await payeeName(db, scope, pendingPreview.payee), names: await accountNames() } : null;
    const suggestion = waiting ? await suggestFor(db, { ...scope, item, rules: await listRules(db, scope), history: learned }) : null;
    const hist = waiting ? await categoryHistory(db, { ...scope, item, history: learned }) : null;
    const aiSettings = await getAiSettings(db, scope);
    const ai = { on: aiSettings.provider !== 'off' && aiSettings.hasKey && canReview, providerName: PROVIDERS[aiSettings.provider], canSetUp: ctx.orgAdmin };
    // After accepting research, the Add form starts from it.
    // …and Assign from the history panel fills in its category (and the vendor it names).
    // An accepted research fills the form only while it still applies to the line as it is now (worked out again here from
    // the research, never from the address): its vendor, and its category when that carries (stage S5).
    const accepted = waiting && /^\d{1,18}$/.test(query.research ?? '') ? await getResearch(db, { ...scope, researchId: query.research }) : null;
    const fit = accepted?.decision === 'accepted' && accepted.vendor_id ? researchFits(accepted, item) : { fits: false };
    const prefill = fit.fits ? { from: 'research', payee: `v:${accepted.vendor_id}`, memo: '', lines: [{ accountId: fit.category ? String(accepted.proposal.category_account_id ?? '') : '' }] }
      : query.from === 'history' && /^\d{1,18}$/.test(query.category ?? '')
      ? { from: 'history', payee: /^v:\d{1,18}$/.test(query.payee ?? '') ? query.payee : '', memo: '', lines: [{ accountId: query.category }] } : null;
    const plan = item.review_state !== 'new' ? await undoPlan(db, { ...scope, itemId: item.item_id }) : null;
    const shownDupes = dupes ?? (waiting ? await possibleDuplicates(db, { ...scope, item }) : []);
    page(bankItemPage({ ...base(), flash: takeFlash(), item, candidates, suggested: suggestion?.source === 'match' ? suggestion.txn : null, suggestion, vendors, customers, categories,
      research: waiting ? await latestResearch(db, { ...scope, item }) : null, ai, prefill, rev: itemToken(item), preview,
      // The texted receipts this line will take when it's reviewed (exactly the set its token carries — stage S3).
      receipts: item.receipt_ids ? (await db.query(`SELECT r.receipt_id, r.extracted, r.created_at, r.vendor_id, r.account_id, s.name AS sender FROM receipt r LEFT JOIN sms_sender s ON s.sender_id = r.sender_id
        WHERE r.org_id = $1 AND r.receipt_id = ANY($2::bigint[]) ORDER BY r.receipt_id`, [scope.orgId, item.receipt_ids.split(',').map(Number)])).rows : [],
      dupes: shownDupes, evidence: evidenceToken(shownDupes), dims: await dimensionChoices(db, scope), events,
      undoConfirm: plan ? undoConfirmText(plan) : null, undoToken: plan?.token ?? null, practice: isPractice(h.env),
      files: await listBankAttachments(db, { ...scope, item }), notes: await listBankNotes(db, { ...scope, item }), canApprove: Boolean(who.canApproveBills),
      ...await (async () => { const c = await categoryChoices(db, scope), p = await payeeChoices(db, scope); return { cats: c, payeeList: p, ...(await shownLists(c, p)) }; })(),
      createPayee, find, found, settleDocs, mv, hist,
      transferTo, links, error, v, canReview }), status);
    return true;
  });
  if (!m[2]) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    return show();
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
  const back = `/banking?account=${item.ll_account}&tab=review`;
  let v = null, createPayee = null, mv = null;
  // What the page showed, checked again under the company lock by each operation: the bank line (rev), the transactions
  // ticked (ver_<id>), the possible duplicates acknowledged (evidence), the Undo plan (plan). A form without them is old.
  const rev = form.get('rev');
  try {
    if (['match', 'add', 'transfer', 'exclude', 'checked', 'bill'].includes(m[3]) && !rev) throw new StaleError('This page is out of date. Check the item again below.');
    if (m[3] === 'undo' && !form.get('plan')) throw new StaleError('This page is out of date. Check the item again below.');
    switch (m[3]) {
      case 'match': {
        // What was ticked and typed, kept to show again if it can't go through.
        const payIds = form.getAll('pay').filter(x => /^\d{1,18}$/.test(x));
        const adjAccounts = form.getAll('adj_account'), adjAmounts = form.getAll('adj_amount'), adjDescs = form.getAll('adj_description');
        mv = { txn: form.getAll('txn'), waiting: form.getAll('waiting'), pay: new Map(payIds.map(id => [id, form.get(`pay_amt_${id}`) ?? ''])),
          adj: adjAccounts.map((a, i) => ({ account: a, amount: adjAmounts[i] ?? '', description: adjDescs[i] ?? '' })).filter(a => a.account.trim() || a.amount.trim()) };
        const ids = [...form.getAll('txn'), ...form.getAll('waiting'), ...payIds].map(Number);
        const versions = new Map(ids.filter(id => form.get(`ver_${id}`)).map(id => [id, form.get(`ver_${id}`)]));
        if (!payIds.length && !mv.adj.length) {
          await matchItem(pool, { ...scope, itemId: item.item_id, txnIds: form.getAll('txn'), undepositedIds: form.getAll('waiting'), actor, expect: { rev, versions } });
          return go(back, 'ok', `Matched: ${item.description}.`) ?? true;
        }
        const cats = await categoryChoices(pool, scope), shown = await shownChoices(form);
        const money = t => { const s = String(t ?? '').trim(); const c = s.startsWith('-') ? -parseMoney(s.slice(1).trim()) : parseMoney(s); return c === null || Number.isNaN(c) ? NaN : c; };
        const settle = payIds.map(id => {
          const c = money(mv.pay.get(id));
          if (!Number.isSafeInteger(c) || c <= 0) throw new ValidationError('Enter the amount paid on each ticked bill or invoice, like 125.00.');
          return { txnId: Number(id), amountCents: c };
        });
        const adjustments = mv.adj.map((a, i) => {
          const c = atSnapshot(resolveCategory, { shown: shown.cats, current: cats, text: a.account, kind: 'category' });
          if (!c) throw new ValidationError(`Adjustment ${i + 1}: choose a category.`);
          if (c.error) throw new ValidationError(`Adjustment ${i + 1}: ${c.error}`);
          const cents = money(a.amount);
          if (!Number.isSafeInteger(cents) || cents === 0) throw new ValidationError(`Adjustment ${i + 1}: enter an amount like 2.50 or -2.50.`);
          return { accountId: c.id, cents, description: a.description };
        });
        const r = await settleItem(pool, { ...scope, itemId: item.item_id, txnIds: form.getAll('txn'), undepositedIds: form.getAll('waiting'), settle, adjustments,
          memo: form.get('memo') ?? '', actor, expect: { rev, versions } });
        return go(back, 'ok', `${r.payments.length ? 'Paid' : 'Matched'}: ${item.description}${r.journalId ? ', with an adjustment for the difference' : ''}.`) ?? true;
      }
      case 'add': {
        const accountsIn = form.getAll('line_account'), amounts = form.getAll('line_amount'), descs = form.getAll('line_description'), classes = form.getAll('line_class');
        const ruleId = /^\d{1,18}$/.test(form.get('rule') ?? '') ? form.get('rule') : null;
        v = { payee: form.get('payee') ?? '', memo: form.get('memo') ?? '', classId: form.get('class_id') ?? '', locationId: form.get('location_id') ?? '',
          separate: form.get('separate') === '1', rule: ruleId, ruleAt: ruleId ? form.get('rule_at') ?? '' : null,
          lines: accountsIn.map((a, i) => ({ accountId: a, amount: amounts[i] ?? '', description: descs[i] ?? '', classId: classes[i] || null })) };
        // The rule that filled the form in must still be as it was when the page was shown (checked first, and again under the
        // company lock): otherwise the page is shown again with the rule as it is now.
        const staleRule = 'The rule that filled this form in was changed since the page was shown. Check it again below.';
        if (ruleId && !sameRule(await getRule(pool, { ...scope, ruleId }), v.ruleAt)) throw new StaleError(staleRule);
        // The pickers send what was typed (kept in v to show again); resolved ids go only to the posting.
        const cats = await categoryChoices(pool, scope), payees = await payeeChoices(pool, scope);
        const shown = await shownChoices(form);
        const lines = v.lines.map(l => {
          const c = atSnapshot(resolveCategory, { shown: shown.cats, current: cats, text: l.accountId, kind: 'category' });
          if (c?.error) throw new ValidationError(c.error);
          return { ...l, accountId: c ? String(c.id) : '' };
        });
        const p = atSnapshot(resolvePayee, { shown: shown.payees, current: payees, text: v.payee, kind: 'payee' });
        if (p?.error) throw new ValidationError(p.error);
        if (p?.key && ['vendor', 'customer'].includes(form.get('create'))) throw new ValidationError(createdMeanwhile(v.payee, p.key));
        const kind = p?.unknown ? form.get('create') : null;
        if (p?.unknown && !['vendor', 'customer'].includes(kind)) { createPayee = p.unknown; throw new ValidationError(`“${p.unknown}” isn’t a vendor or customer yet. Create it, or pick one from the list.`); }
        // A rule filled the form in and the person kept exactly what it said: the rule is recorded as the reason — the rule read
        // under the lock, exactly as it stood when the page was shown.
        const post = async (tx, payeeKey) => {
          const r = ruleId ? await getRule(tx, { ...scope, ruleId }) : null;
          if (ruleId && !sameRule(r, v.ruleAt)) throw new StaleError(staleRule);
          await stillUsable(tx, scope, { payeeKey, accountIds: lines.map(l => l.accountId).filter(Boolean) });
          const filled = lines.filter(l => l.accountId);
          // Kept means every line as the rule makes it (category and amount; one line with no amount is the whole amount).
          const act = r ? ruleAction(r, item) : null;
          const cents = l => (String(l.amount ?? '').trim() ? parseMoney(String(l.amount).trim()) : filled.length === 1 ? Math.abs(Number(item.amount_cents)) : null);
          const kept = act && act.lines.length === filled.length && act.lines.every((l, i) => Number(filled[i].accountId) === l.accountId && cents(filled[i]) === l.cents);
          const rule = kept && (payeeKey || null) === (r.payee ?? null) ? r : null;
          return addItemTx(tx, { ...scope, itemId: item.item_id, payee: payeeKey ?? '', memo: v.memo, lines, actor, separate: v.separate, rule,
            basis: rule ? 'rule' : ['history', 'ai'].includes(form.get('basis')) ? form.get('basis') : 'person', matchOther: !isPractice(h.env),
            dims: { ...(v.classId ? { classId: v.classId } : {}), ...(v.locationId ? { locationId: v.locationId } : {}) },
            expect: { rev, evidence: form.get('evidence') ?? '' } });
        };
        await createAndPost(h, { kind, name: p?.unknown, payeeKey: p?.key ?? '', post });
        return go(back, 'ok', `Added: ${item.description}.`) ?? true;
      }
      case 'transfer': {
        const r = await transferItem(pool, { ...scope, itemId: item.item_id, otherAccountId: form.get('other'), actor, matchOther: !isPractice(h.env),
          separate: form.get('separate') === '1', expect: { rev, evidence: form.get('evidence') ?? '' } });
        return go(back, r.ambiguousPair ? 'warn' : 'ok', r.matchedExisting ? `Already in the books — matched to the transfer recorded earlier: ${item.description}.`
          : `Transfer recorded: ${item.description}.${r.pairedItemId ? ' The other account’s bank line is recorded by it too.' : r.pairNote ? ` The other account’s bank line is left for review: ${r.pairNote.split(';')[0]}.` : ''}`) ?? true;
      }
      case 'attach':
        await addBankAttachment(pool, { ...scope, itemId: item.item_id, file: h.files.find(f => f.field === 'file'), actor });
        return go(here, 'ok', 'File attached.') ?? true;
      case 'note':
        await addBankNote(pool, { ...scope, itemId: item.item_id, note: form.get('note'), actor });
        return go(here, 'ok', 'Note added.') ?? true;
      case 'bill': {
        // Create a backdated bill: the vendor, the bill date and its categories; paid by this bank line.
        const accountsIn = form.getAll('bill_account'), amounts = form.getAll('bill_amount'), descs = form.getAll('bill_description');
        v = { bill: { payee: form.get('bill_vendor') ?? '', date: form.get('bill_date') ?? '', number: form.get('bill_number') ?? '', memo: form.get('bill_memo') ?? '',
          lines: accountsIn.map((a, i) => ({ accountId: a, amount: amounts[i] ?? '', description: descs[i] ?? '' })) } };
        const cats = await categoryChoices(pool, scope), shown = await shownChoices(form);
        const lines = v.bill.lines.map(l => {
          const c = atSnapshot(resolveCategory, { shown: shown.cats, current: cats, text: l.accountId, kind: 'category' });
          if (c?.error) throw new ValidationError(c.error);
          return { ...l, accountId: c ? String(c.id) : '' };
        });
        const vendorsOnly = list => list?.filter(x => String(x.key).startsWith('v:'));
        const p = atSnapshot(resolvePayee, { shown: vendorsOnly(shown.payees), current: vendorsOnly(await payeeChoices(pool, scope)), text: v.bill.payee, kind: 'payee' });
        if (!p) throw new ValidationError('Choose the vendor who sent the bill.');
        if (p.error) throw new ValidationError(p.error);
        if (p.unknown) throw new ValidationError(`“${p.unknown}” isn’t a vendor yet. Add the vendor first, or pick one from the list.`);
        await backdatedBill(pool, { ...scope, itemId: item.item_id, vendorId: Number(p.key.slice(2)), billDate: v.bill.date, docNumber: v.bill.number, lines, memo: v.bill.memo,
          actor, canApprove: Boolean(who.canApproveBills), separate: form.get('separate') === '1', expect: { rev, evidence: form.get('evidence') ?? '' } });
        return go(back, 'ok', `Bill created and paid: ${item.description}.`) ?? true;
      }
      case 'checked':
        await markChecked(pool, { ...scope, itemId: item.item_id, actor, expect: { rev } });
        return go(here, 'ok', 'Marked as checked.') ?? true;
      case 'research':
        if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
        await researchItem(pool, { ...scope, itemId: item.item_id, actor, key: settingsKey(h.env), fetchImpl: h.aiFetch });
        return go(here, 'ok', 'Researched — see “Who is this?” below.') ?? true;
      case 'exclude':
        if (!(await excludeItems(pool, { ...scope, itemIds: [item.item_id], actor, expect: { revs: new Map([[Number(item.item_id), rev]]) } }))) throw new StaleError(
          'This item changed since the page was shown. Check it again below.');
        return go(back, 'ok', `Excluded: ${item.description}.`) ?? true;
      case 'undo': {
        const r = await undoItem(pool, { ...scope, itemId: item.item_id, actor, expect: { plan: form.get('plan') } });
        // From a list row, back to that list.
        const to = /^\/banking\?[\w=&%.:-]*$/.test(form.get('back') ?? '') ? form.get('back') : here;
        return go(to, 'ok', r === 'deleted' ? 'Undone — the transaction it added was deleted, and the item is back for review.'
          : r === 'handed' ? 'Undone — the transfer stays: the other account’s bank line still records it. This item is back for review.'
          : r === 'unmatched' ? 'Undone — the match was removed; the books transaction stays.' : 'Back for review.') ?? true;
      }
    }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    if (error instanceof StaleError) return go(here, 'error', error.message) ?? true;
    if (v?.lines) {
      // Shown again: the kept choices carried over to the lists as they are now.
      const carry = await carryChoices(form);
      v = { ...v, payee: createPayee ? v.payee : carry.payee(v.payee), lines: v.lines.map(l => ({ ...l, accountId: carry.category(l.accountId) })) };
    }
    if (v?.bill || mv?.adj?.length) {
      const carry = await carryChoices(form);
      if (v?.bill) v = { ...v, bill: { ...v.bill, payee: carry.payee(v.bill.payee), lines: v.bill.lines.map(l => ({ ...l, accountId: carry.category(l.accountId) })) } };
      if (mv?.adj?.length) mv = { ...mv, adj: mv.adj.map(a => ({ ...a, account: carry.category(a.account) })) };
    }
    return show(error.message, v, 422, error instanceof DuplicateError ? error.duplicates : null, createPayee, mv);
  }
  throw new HttpError(404, 'Not found');
}

// The rule a form was filled in from is still exactly as it was shown (ruleStamp: id and when it was last changed).
const sameRule = (rule, shownAt) => Boolean(rule && shownAt && ruleStamp(rule) === shownAt);
class RuleChangedError extends StaleError {}

// Batch Assign (a category and payee typed once, for every ticked item) and Undo (each exactly as its row showed it), item by
// item, each in its own transaction under the company lock: anything that changed since, or that the books may already hold,
// is left with its reason. all: the items are every one matching (counted), so each is taken as it is now.
async function batchEach(h, { ids, action, tokens, lines = null, payee = '' }) {
  const { pool, scope, actor } = h;
  const results = [];
  const names = await itemNames(h, ids);
  for (const id of ids.map(Number)) {
    const note = (outcome, reason = null) => results.push({ itemId: id, description: names.get(id) ?? `Item ${id}`, outcome, reason });
    const token = tokens.get(id);
    if (!token) { note('skipped', 'the page didn’t show it — reload and try again'); continue; }
    try {
      await withTransaction(pool, async tx => {
        await lockEntity(tx, scope.orgId, scope.entityId);
        if (action === 'assign') {
          await stillUsable(tx, scope, { payeeKey: payee, accountIds: lines.map(l => l.accountId) });
          await addOneTx(tx, { ...scope, itemId: id, payee, lines, actor, source: 'batch', basis: 'person', matchOther: !isPractice(h.env), expect: { rev: token } });
        } else {
          await undoItemTx(tx, { ...scope, itemId: id, actor, source: 'batch', expect: { plan: token } });
        }
      });
      note(action === 'assign' ? 'assigned' : 'undone');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      note('skipped', error instanceof DuplicateError ? 'may already be in the books — review it' : error.message.replace(/\.$/, ''));
    }
  }
  return results;
}
const itemNames = async (h, ids) => new Map((await h.pool.query('SELECT item_id, description FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND item_id = ANY($3::bigint[])',
  [h.scope.orgId, h.scope.entityId, ids.map(Number).filter(Number.isSafeInteger)])).rows.map(x => [Number(x.item_id), x.description]));

// The category and payee typed once for Assign, resolved with the lists the page showed.
async function assignChoice(h, form) {
  const { pool, scope } = h;
  const shown = { cats: await snapshotChoices(pool, { ...scope, kind: 'category', hash: form.get('cats_v') }), payees: await snapshotChoices(pool, { ...scope, kind: 'payee', hash: form.get('payees_v') }) };
  const c = atSnapshot(resolveCategory, { shown: shown.cats, current: await categoryChoices(pool, scope), text: form.get('assign_category'), kind: 'category' });
  if (!c) throw new ValidationError('Type the category to assign.');
  if (c.error) throw new ValidationError(c.error);
  const p = atSnapshot(resolvePayee, { shown: shown.payees, current: await payeeChoices(pool, scope), text: form.get('assign_payee'), kind: 'payee' });
  if (p?.error) throw new ValidationError(p.error);
  if (p?.unknown) throw new ValidationError(`“${p.unknown}” isn’t a vendor or customer yet. Add it first, or pick one from the list.`);
  return { lines: [{ accountId: c.id, amount: '' }], payee: p?.key ?? '' };
}

// "All N matching", step one: the items the filters fit now, each with the token a ticked row would carry (its revision, or its
// Undo plan), recorded for the person to confirm. count: how many the page said.
async function recordSelection(h, { account, tab, list, action, count }) {
  const { pool, scope, actor, form } = h;
  const ids = await matchingItemIds(pool, { ...scope, llAccountId: account.id, tab, filters: list.filters });
  if (ids.length !== count) return { count: ids.length };
  const what = action === 'assign' ? await assignChoice(h, form) : null;
  const items = [];
  await snapshot(pool, async db => {
    for (const id of ids) {
      const i = await getBankItem(db, { ...scope, itemId: id });
      if (!i) continue;
      const plan = action === 'undo' ? await undoPlan(db, { ...scope, itemId: id }) : null;
      items.push({ item: i, token: plan ? plan.token : itemToken(i), confirm: plan ? undoConfirmText(plan) : null });
    }
  });
  const { rows: [sel] } = await pool.query(`INSERT INTO bank_batch_selection (org_id, entity_id, actor, action, ll_account_id, tab, list, items, detail)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING selection_id`, [scope.orgId, scope.entityId, actor, action, account.id, tab,
    new URLSearchParams(list.raw).toString(), JSON.stringify(items.map(x => [Number(x.item.item_id), x.token])),
    JSON.stringify(what ? { accountId: what.lines[0].accountId, payee: what.payee } : {})]);
  await pool.query(`DELETE FROM bank_batch_selection WHERE entity_id = $1 AND created_at < now() - interval '1 day'`, [scope.entityId]);
  const cats = what ? await categoryChoices(pool, scope) : [];
  return { count: items.length, selection: sel.selection_id, items, assignTo: what ? categoryName(cats, what.lines[0].accountId) : null };
}

const createdMeanwhile = (text, key) => `“${String(text).trim()}” was just added as a ${key.startsWith('v:') ? 'vendor' : 'customer'} by someone else, so nothing was `
  + 'created. Check the payee (pick it from the list, or type another name), then post again.';

// Under the company lock, just before posting: the chosen vendor or customer and categories are still active (and still this
// company's) — another person may have made one inactive while the form was being sent.
async function stillUsable(tx, { orgId, entityId }, { payeeKey, accountIds = [] }) {
  const m = /^([cv]):(\d{1,18})$/.exec(payeeKey ?? '');
  if (m) {
    const t = m[1] === 'v' ? 'vendor' : 'customer';
    const { rows: [x] } = await tx.query(`SELECT active FROM ${t} WHERE org_id = $1 AND entity_id = $2 AND ${t}_id = $3`, [orgId, entityId, Number(m[2])]);
    if (!x?.active) throw new ValidationError('That vendor or customer was just made inactive. Reload the page and choose again.');
  }
  for (const id of new Set(accountIds.map(Number))) {
    const { rows: [a] } = await tx.query('SELECT active, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3', [orgId, entityId, id]);
    if (!a?.active || ['ar', 'ap', 'undeposited'].includes(a.system_key)) throw new ValidationError('That category was just made inactive. Reload the page and choose again.');
  }
}

// Post a bank item (post(tx, payeeKey) under the company lock), creating its new vendor or customer (kind) in the same
// transaction first when asked: a posting that is refused takes the new record with it.
async function createAndPost(h, { kind, name, payeeKey, post }) {
  const { pool, scope, actor } = h;
  if (!kind) return withTransaction(pool, async tx => { await lockEntity(tx, scope.orgId, scope.entityId); return post(tx, payeeKey); });
  let out;
  if (kind === 'vendor') {
    await saveVendor(pool, { ...scope, fields: { displayName: name }, key: settingsKey(h.env), actor, afterCreate: async (tx, id) => { out = await post(tx, `v:${id}`); } });
  } else {
    await saveCustomer(pool, { ...scope, fields: { displayName: name, active: true, isNew: true }, actor, afterCreate: async (tx, id) => { out = await post(tx, `c:${id}`); } });
  }
  return out;
}

// Banking → Rules: list, new (optionally from a bank item), edit, delete, test (preview), export and import (stage BR-5).
// Saving an auto rule applies it to waiting items.
async function ruleRoutes(h, rm, { canReview }) {
  const { req, query, form, pool, page, base, go, takeFlash, scope, actor } = h;
  if (!canReview) throw new HttpError(403, 'Only people who keep the books can change rules.');
  const [, which, del] = rm;
  const rule = /^\d+$/.test(which ?? '') ? (await getRule(pool, { ...scope, ruleId: which }) ?? (() => { throw new HttpError(404, 'Rule not found'); })()) : null;
  const lists = async () => {
    const q = (sql) => pool.query(sql, [scope.orgId, scope.entityId]).then(r => r.rows);
    const accts = await q('SELECT account_id, name, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(name)');
    const usable = accts.filter(a => !['ar', 'ap', 'undeposited'].includes(a.system_key));
    const vendors = await q(`SELECT 'v:' || vendor_id AS key, display_name AS name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(display_name)`);
    const customers = await q(`SELECT 'c:' || customer_id AS key, display_name AS name FROM customer WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY lower(display_name)`);
    const classes = await q('SELECT class_id, name FROM class WHERE org_id = $1 AND entity_id = $2 ORDER BY lower(name)');
    const locations = await q('SELECT location_id, name FROM location WHERE org_id = $1 AND entity_id = $2 ORDER BY lower(name)');
    return { feeds: await bankAccounts(pool, scope), payees: [...vendors, ...customers], classes, locations, accountNames: new Map(accts.map(a => [Number(a.account_id), a.name])),
      categories: Object.entries(GROUP).map(([type, label]) => [label, usable.filter(a => a.type === type)]).filter(([, l]) => l.length) };
  };
  const showForm = async (v, error = null, status = 200, preview = null) => {
    page(ruleForm({ ...base(), flash: takeFlash(), rule, v, error, preview, practice: isPractice(h.env), ...(await lists()) }), status);
    return true;
  };
  // The form as typed (kept to show again).
  const typed = () => {
    const fields = form.getAll('cond_field'), ops = form.getAll('cond_op'), vals = form.getAll('cond_value'), vals2 = form.getAll('cond_value2');
    const sAcc = form.getAll('split_account'), sPct = form.getAll('split_percent'), sAmt = form.getAll('split_amount'), sDesc = form.getAll('split_description');
    return { name: form.get('name') ?? '', priority: form.get('priority') ?? '', money: form.get('money'), llAccounts: form.getAll('llAccounts'),
      matchAll: form.get('matchAll') !== '0', conditions: fields.map((f, i) => ({ field: f, op: ops[i], value: vals[i] ?? '', value2: vals2[i] ?? '' })),
      payee: form.get('payee') ?? '', accountId: form.get('accountId') ?? '', classId: form.get('classId') ?? '', locationId: form.get('locationId') ?? '',
      splits: sAcc.map((a, i) => ({ accountId: a, percent: sPct[i] ?? '', amount: sAmt[i] ?? '', description: sDesc[i] ?? '' })),
      memo: form.get('memo') ?? '', memoMode: form.get('memoMode'), mode: form.get('mode'), active: form.get('active') === '1' };
  };

  if (which === 'export') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const body = JSON.stringify(await exportRules(pool, scope), null, 2);
    h.send(h.res, 200, body, { ...h.extra, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="bank-rules.json"' });
    return true;
  }
  if (which === 'import') {
    if (req.method === 'GET') { page(rulesImportPage({ ...base(), flash: takeFlash() })); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    try {
      const results = await importRules(pool, { ...scope, data: form.get('data') ?? '', actor });
      page(rulesImportPage({ ...base(), flash: takeFlash(), results }));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      page(rulesImportPage({ ...base(), flash: takeFlash(), error: error.message, data: form.get('data') ?? '' }), 422);
    }
    return true;
  }
  if (!which) {
    if (req.method === 'GET') {
      const { payees, accountNames, feeds } = await lists();
      page(rulesPage({ ...base(), flash: takeFlash(), rules: await listRules(pool, scope), payeeNames: new Map(payees.map(p => [p.key, p.name])), accountNames,
        feedNames: new Map(feeds.map(f => [String(f.id), f.books_name])), practice: isPractice(h.env) }));
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
      const pct = bp => String(bp / 100);
      return showForm({ name: rule.name, priority: rule.priority, active: rule.active, money: rule.money, llAccounts: ruleAccounts(rule), matchAll: rule.match_all,
        conditions: rule.conditions, payee: rule.payee ?? '', accountId: rule.splits?.length ? '' : rule.account_id ?? '', classId: rule.class_id ?? '', locationId: rule.location_id ?? '',
        splits: (rule.splits ?? []).map(s => ({ accountId: s.accountId, percent: s.percent !== undefined && s.percent !== null ? pct(s.percent) : '',
          amount: s.cents !== undefined && s.cents !== null ? (s.cents / 100).toFixed(2) : '', description: s.description ?? '' })),
        memo: rule.memo ?? '', memoMode: rule.memo_mode, mode: rule.mode });
    }
    // New, maybe from a bank item: money direction, the account, and the payee part of its description.
    const item = query.from ? await getBankItem(pool, { ...scope, itemId: query.from }) : null;
    const key = item ? payeeKey(item.merchant_name || item.description) : '';
    const name = key.split(' ').filter(Boolean).map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    return showForm(item ? { name, money: Number(item.amount_cents) < 0 ? 'out' : 'in', llAccounts: [item.ll_account],
      conditions: key ? [{ field: 'description', op: 'contains', value: key.split(' ')[0] }] : [], mode: 'suggest' } : { money: 'out', mode: 'suggest' });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const v = typed();
  // Test: what the rule would catch now, without saving it.
  if (form.get('test') === '1') {
    try {
      const checked = await checkRule(pool, { ...scope, ruleId: rule?.rule_id ?? null, fields: v });
      return showForm(v, null, 200, await previewRule(pool, { ...scope, rule: { ...checked, rule_id: rule?.rule_id ?? null } }));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return showForm(v, error.message, 422);
    }
  }
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
