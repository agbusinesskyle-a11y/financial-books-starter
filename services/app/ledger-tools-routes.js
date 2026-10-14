import { IMPORTED_LOCKED } from '../../lib/views/txn-extras.js';
import { safeBack } from '../../lib/domain/save-choices.js';
import { verifiedMonths } from '../../lib/data/banking.js';
import { HttpError } from './http.js';
import { dimsFromForm, dimsForSave } from './dims.js';
import { ValidationError } from '../../lib/data/writes.js';
import { accountsOfTypes } from '../../lib/data/ledger.js';
import { dimensionChoices } from '../../lib/data/accounting.js';
import { getEntity } from '../../lib/data/messages.js';
import {
  getLedgerTxn, saveJournalEntry, saveTransfer, voidLedgerTxn, deleteLedgerTxn, reconcileAccounts, reconcileState, finishReconciliation,
  undoLastReconciliation, getReconciliation, TRANSFER_TYPES,
} from '../../lib/data/ledger-tools.js';
import { renderReconciliationPdf } from '../../lib/pdf/reconciliation.js';
import { centsToInput } from '../../lib/domain/money.js';
import { isIsoDate } from '../../lib/domain/dates.js';
import {
  toolsPage, journalForm, journalToValues, transferForm, ledgerTxnPage, reconcileStartPage, reconcileWorksheet, reconcileHistoryPage,
} from '../../lib/views/ledger-tools.js';

const JE_ACCOUNT_TYPES = ['bank', 'other_current_asset', 'fixed_asset', 'other_asset', 'credit_card', 'other_current_liability', 'long_term_liability', 'equity',
  'income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense'];

// Tools: journal entries, transfers, credit card payments, reconcile. h: the request helpers from index.js.
export async function ledgerToolsRoutes(h) {
  const { req, res, path, query, form, ctx, scope, pool, page, base, go, takeFlash, actor, who, send, extra } = h;
  const admin = who.role === 'admin';
  const override = () => admin && form?.get('edit_reconciled') === '1';
  let m;

  if (path === '/tools' && req.method === 'GET') { page(toolsPage({ ...base() })); return true; }

  // Where a saved journal entry, transfer or card payment goes (stage F1): close → back where it came from (else the
  // transaction); new → a blank one; save → stays open on it.
  const NEW_PATH = { journal_entry: '/journal/new', transfer: '/transfers/new', cc_payment: '/card-payments/new' };
  const EDIT_PATH = { journal_entry: id => `/journal/${id}/edit`, transfer: id => `/transfers/${id}/edit`, cc_payment: id => `/card-payments/${id}/edit` };
  const ledgerAfterSave = (id, type, choice, saved) => {
    if (choice === 'new') return go(NEW_PATH[type], 'ok', saved);
    if (choice === 'save') return go(EDIT_PATH[type](id), 'ok', saved);
    return go(safeBack(form.get('back')) ?? `/ledger/${id}`, 'ok', saved);
  };

  // ---- journal entries ----
  m = /^\/journal(?:\/(new|\d{1,18}))?(\/edit)?$/.exec(path);
  if (m) {
    const txnId = m[1] && m[1] !== 'new' ? Number(m[1]) : null;
    if (txnId && (await pool.query("SELECT 1 FROM txn WHERE org_id = $1 AND txn_id = $2 AND source = 'qbo_import'", [ctx.orgId, txnId])).rowCount) {
      go(`/ledger/${txnId}`, 'error', IMPORTED_LOCKED);
      return true;
    }
    const lists = async () => {
      const [accounts, customers, vendors, dims] = await Promise.all([
        pool.query(`SELECT account_id, name, number FROM account WHERE org_id = $1 AND entity_id = $2 AND active AND type = ANY($3)
                     AND system_key IS DISTINCT FROM 'undeposited' AND system_key IS DISTINCT FROM 'inventory' ORDER BY number NULLS LAST, name`, [ctx.orgId, ctx.entityId, JE_ACCOUNT_TYPES]),
        pool.query('SELECT customer_id, display_name FROM customer WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY display_name', [ctx.orgId, ctx.entityId]),
        pool.query('SELECT vendor_id, display_name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY display_name', [ctx.orgId, ctx.entityId]),
        dimensionChoices(pool, scope)]);
      return { accounts: accounts.rows, dims, parties: [...customers.rows.map(c => ({ value: `c:${c.customer_id}`, label: `${c.display_name} (customer)` })),
        ...vendors.rows.map(v => ({ value: `v:${v.vendor_id}`, label: `${v.display_name} (vendor)` }))] };
    };
    const show = async (v, error = null, status = 200, more = {}) => page(journalForm({ ...base(), txnId, save: await h.saveOpts('journal_entry'), v, error, ...(await lists()), ...more }), status);
    if (req.method === 'GET') {
      if (m[1] === 'new' && !m[2]) {
        // Copy (stage F2): a new entry with the same lines, dated today.
        const src = query.copy ? await getLedgerTxn(pool, { ...scope, txnId: Number(query.copy) || 0 }) : null;
        if (src && src.type === 'journal_entry') { await show({ ...journalToValues(src), txnDate: ctx.today, docNumber: '', reverseOn: '' }); return true; }
        await show({ txnDate: ctx.today, docNumber: '', memo: '', reverseOn: '', adjusting: false, lines: [] }); return true;
      }
      if (txnId && m[2]) {
        const t = await getLedgerTxn(pool, { ...scope, txnId });
        if (!t || t.type !== 'journal_entry') throw new HttpError(404, 'Journal entry not found');
        await show(journalToValues(t));
        return true;
      }
      throw new HttpError(404, 'Not found');
    }
    if (m[1] === 'new' || m[2]) throw new HttpError(404, 'Not found');
    const all = k => form.getAll(k);
    const v = { txnDate: form.get('txn_date') ?? '', docNumber: form.get('doc_number') ?? '', memo: form.get('memo') ?? '', reverseOn: form.get('reverse_on') ?? '', adjusting: form.get('adjusting') === '1',
      lines: all('je_account').map((accountId, i) => ({ accountId, debit: all('je_debit')[i] ?? '', credit: all('je_credit')[i] ?? '', description: all('je_desc')[i] ?? '',
        party: all('je_party')[i] ?? '', classId: all('je_class')[i] ?? '' })).slice(0, 200), ...dimsFromForm(form) };
    try {
      const id = await saveJournalEntry(pool, { ...scope, txnId, actor, txnDate: v.txnDate, docNumber: v.docNumber, memo: v.memo, lines: v.lines, reverseOn: v.reverseOn,
        dims: dimsForSave(v), override: override(), adjusting: v.adjusting });
      ledgerAfterSave(id, 'journal_entry', await h.saveChoice('journal_entry'), 'Journal entry saved.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await show({ ...v, lines: v.lines.filter(l => l.accountId || l.debit || l.credit || l.description) }, error.message, 422, { override: Boolean(error.reconciled && admin) });
    }
    return true;
  }

  // ---- transfers and credit card payments ----
  m = /^\/(transfers|card-payments)(?:\/(new|\d{1,18}))?(\/edit)?$/.exec(path);
  if (m) {
    const type = m[1] === 'transfers' ? 'transfer' : 'cc_payment';
    const txnId = m[2] && m[2] !== 'new' ? Number(m[2]) : null;
    if (txnId && (await pool.query("SELECT 1 FROM txn WHERE org_id = $1 AND txn_id = $2 AND source = 'qbo_import'", [ctx.orgId, txnId])).rowCount) {
      go(`/ledger/${txnId}`, 'error', IMPORTED_LOCKED);
      return true;
    }
    const lists = async () => {
      const usable = (await accountsOfTypes(pool, { ...scope, types: TRANSFER_TYPES })).filter(a => a.system_key !== 'undeposited' && a.system_key !== 'inventory');
      return type === 'cc_payment'
        ? { fromAccounts: usable.filter(a => a.type === 'bank'), toAccounts: usable.filter(a => a.type === 'credit_card') }
        : { fromAccounts: usable, toAccounts: usable };
    };
    const show = async (v, error = null, status = 200, more = {}) =>
      page(transferForm({ ...base(), type, txnId, save: await h.saveOpts(type), v, error, dims: await dimensionChoices(pool, scope), ...(await lists()), ...more }), status);
    if (req.method === 'GET') {
      if (m[2] === 'new' && !m[3]) {
        const src = query.copy ? await getLedgerTxn(pool, { ...scope, txnId: Number(query.copy) || 0 }) : null;
        if (src && src.type === type) {
          await show({ fromId: String(src.account_id), toId: String(src.to_account_id), amount: centsToInput(src.total_cents), txnDate: ctx.today, memo: src.memo ?? '' });
          return true;
        }
        await show({ fromId: '', toId: '', amount: '', txnDate: ctx.today, memo: '' }); return true;
      }
      if (txnId && m[3]) {
        const t = await getLedgerTxn(pool, { ...scope, txnId });
        if (!t || t.type !== type) throw new HttpError(404, 'Not found');
        await show({ fromId: String(t.account_id), toId: String(t.to_account_id), amount: centsToInput(t.total_cents), txnDate: t.txn_date, memo: t.memo ?? '',
          classId: t.class_id ? String(t.class_id) : '', locationId: t.location_id ? String(t.location_id) : '', tagIds: t.tag_ids.map(String) });
        return true;
      }
      throw new HttpError(404, 'Not found');
    }
    if (m[2] === 'new' || m[3]) throw new HttpError(404, 'Not found');
    const v = { fromId: form.get('from_account') ?? '', toId: form.get('to_account') ?? '', amount: form.get('amount') ?? '', txnDate: form.get('txn_date') ?? '',
      memo: form.get('memo') ?? '', ...dimsFromForm(form) };
    try {
      const id = await saveTransfer(pool, { ...scope, type, txnId, fromId: Number(v.fromId), toId: Number(v.toId), amountText: v.amount, txnDate: v.txnDate, memo: v.memo,
        dims: dimsForSave(v), override: override() });
      ledgerAfterSave(id, type, await h.saveChoice(type), `${type === 'transfer' ? 'Transfer' : 'Credit card payment'} saved.`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await show(v, error.message, 422, { override: Boolean(error.reconciled && admin) });
    }
    return true;
  }

  // ---- one ledger transaction ----
  m = /^\/ledger\/(\d{1,18})(\/void|\/delete)?$/.exec(path);
  if (m) {
    const t = await getLedgerTxn(pool, { ...scope, txnId: Number(m[1]) });
    if (!t) throw new HttpError(404, 'Not found');
    if (t.source === 'qbo_import' && m[2]) { go(`/ledger/${t.txn_id}`, 'error', IMPORTED_LOCKED); return true; }
    if (req.method === 'GET' && !m[2]) { page(ledgerTxnPage({ ...base(), flash: takeFlash(), t, admin })); return true; }
    if (req.method !== 'POST' || !m[2]) throw new HttpError(405, 'Method not allowed');
    try {
      if (m[2] === '/void') { await voidLedgerTxn(pool, { ...scope, txnId: t.txn_id, override: override() }); go(`/ledger/${t.txn_id}`, 'ok', 'Voided.'); }
      else { await deleteLedgerTxn(pool, { ...scope, txnId: t.txn_id, override: override() }); go('/tools', 'ok', 'Deleted.'); }
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      go(`/ledger/${t.txn_id}`, 'error', error.message);
    }
    return true;
  }

  // ---- reconcile ----
  if (path === '/reconcile' && req.method === 'GET') {
    const accounts = await reconcileAccounts(pool, scope);
    // Statements ledgerline has verified since each account was last reconciled (stage B6).
    const verified = [];
    for (const a of accounts) {
      for (const v of (await verifiedMonths(pool, { ...scope, accountId: a.account_id })).filter(x => x.closing !== null && (!a.last_date || x.periodEnd > a.last_date))) {
        verified.push({ ...v, accountId: a.account_id, accountName: a.name });
      }
    }
    verified.sort((x, y) => x.accountName.localeCompare(y.accountName) || x.periodEnd.localeCompare(y.periodEnd));
    page(reconcileStartPage({ ...base(), flash: takeFlash(), accounts, today: ctx.today, verified }));
    return true;
  }
  if (path === '/reconcile/start' && req.method === 'GET') {
    const accountId = /^\d{1,18}$/.test(query.account ?? '') ? Number(query.account) : 0;
    const state = await reconcileState(pool, { ...scope, accountId, through: isIsoDate(query.date ?? '') ? query.date : ctx.today });
    if (!state) { go('/reconcile', 'error', 'Choose an account to reconcile.'); return true; }
    const statementDate = query.date ?? ctx.today;
    const verified = (await verifiedMonths(pool, { ...scope, accountId })).find(v => v.periodEnd === statementDate) ?? null;
    page(reconcileWorksheet({ ...base(), state, statementDate, ending: String(query.ending ?? '').slice(0, 20), verified }));
    return true;
  }
  m = /^\/reconcile\/(\d{1,18})(\/history|\/undo)?$/.exec(path);
  if (m) {
    const accountId = Number(m[1]);
    if (m[2] === '/history' && req.method === 'GET') {
      const state = await reconcileState(pool, { ...scope, accountId });
      if (!state) throw new HttpError(404, 'Not found');
      page(reconcileHistoryPage({ ...base(), flash: takeFlash(), state }));
      return true;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (m[2] === '/undo') {
      // Undoing unlocks reconciled transactions, so only an admin may (same as "change it anyway").
      if (!admin) throw new HttpError(403, 'Only an admin can undo a reconciliation.');
      try {
        const date = await undoLastReconciliation(pool, { ...scope, accountId });
        go(`/reconcile/${accountId}/history`, 'ok', `The ${date} reconciliation was undone.`);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        go(`/reconcile/${accountId}/history`, 'error', error.message);
      }
      return true;
    }
    const ids = form.getAll('ids').filter(x => /^\d{1,18}$/.test(x)).map(Number).slice(0, 5000);
    const statementDate = form.get('statement_date') ?? '', ending = form.get('ending') ?? '';
    try {
      const recId = await finishReconciliation(pool, { ...scope, accountId, statementDate, endingText: ending, txnIds: ids, actor });
      go(`/reconcile/${accountId}/history`, 'ok', `Reconciled. The report (no. ${recId}) is in the list below.`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      const state = await reconcileState(pool, { ...scope, accountId, through: isIsoDate(statementDate) ? statementDate : ctx.today });
      if (!state) throw new HttpError(404, 'Not found');
      const verified = (await verifiedMonths(pool, { ...scope, accountId })).find(v => v.periodEnd === statementDate) ?? null;
      page(reconcileWorksheet({ ...base(), state, statementDate, ending, checked: ids, error: error.message, verified }), 422);
    }
    return true;
  }
  m = /^\/reconcile\/report\/(\d{1,18})\.pdf$/.exec(path);
  if (m && req.method === 'GET') {
    const rec = await getReconciliation(pool, { ...scope, recId: Number(m[1]) });
    if (!rec) throw new HttpError(404, 'Not found');
    send(res, 200, await renderReconciliationPdf({ entity: await getEntity(pool, scope), rec }),
      { ...extra, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="reconciliation-${rec.statement_date}.pdf"` });
    return true;
  }
  return false;
}
