import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { canAccess } from '../../lib/domain/roles.js';
import { centsToInput } from '../../lib/domain/money.js';
import { listAccounts } from '../../lib/data/ledger.js';
import { listLoans, paymentDefaults, saveLoanPayment, saveLoanSetup, getLoanSetup, otherSideChoices, unlistedLoanAccounts, isPayable,
  isLoanAccount } from '../../lib/data/loans.js';
import { loansPage, loanPaymentForm, loanSetupPage } from '../../lib/views/loans.js';

// Lending → Loans: /loans (the list), /loans/pay (record a loan payment), /loans/:id/setup (admins: list it or not,
// and the other side of a loan between two companies). h: the request helpers from index.js.
export async function loanRoutes(h) {
  const { req, path, query, form, ctx, scope, pool, page, base, go, takeFlash, actor, who } = h;
  if (!/^\/loans(\/|$)/.test(path)) return false;
  const openIds = ctx.companies.map(c => c.entityId);
  let m;

  if (path === '/loans') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const loans = await listLoans(pool, { ...scope, companies: ctx.companies });
    const canSetup = canAccess(who.role, 'POST', '/loans/0/setup');
    page(loansPage({ ...base(), flash: takeFlash(), loans, canRegister: canAccess(who.role, 'GET', '/settings/accounts/0'), canRecord: canAccess(who.role, 'POST', '/loans/pay'),
      canSetup, unlisted: canSetup ? await unlistedLoanAccounts(pool, { ...scope, shownIds: loans.map(l => l.accountId) }) : [] }));
    return true;
  }

  if (path === '/loans/pay') {
    const lists = async () => {
      const accounts = (await listAccounts(pool, { ...scope, includeInactive: false })).filter(a => !['ar', 'ap', 'undeposited'].includes(a.system_key));
      const { rows: vendors } = await pool.query('SELECT vendor_id, display_name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY display_name', [ctx.orgId, ctx.entityId]);
      return { loans: accounts.filter(a => isPayable(a) && isLoanAccount(a)), banks: accounts.filter(a => a.type === 'bank'), vendors,
        interestAccounts: accounts.filter(a => ['expense', 'other_expense'].includes(a.type)),
        otherAccounts: accounts.filter(a => !['bank', 'accounts_receivable', 'accounts_payable', 'credit_card'].includes(a.type)) };
    };
    const show = async (v, error = null, status = 200) => page(loanPaymentForm({ ...base(), v, error, ...(await lists()) }), status);
    if (req.method === 'GET') {
      const loanId = /^\d{1,18}$/.test(query.loan ?? '') ? Number(query.loan) : null;
      // From a loan's row: its last payment's bank, lender, interest account and amount (else the interest expense account).
      const d = await paymentDefaults(pool, { ...scope, loanId: loanId ?? 0 });
      const s = x => (x ? String(x) : '');
      await show({ loanId: s(loanId), bankId: s(d.bankId), vendorId: s(d.vendorId), txnDate: ctx.today, total: d.total ? centsToInput(d.total) : '', principal: '', interest: '',
        interestAccountId: s(d.interestAccountId), extras: [], checkNo: '', memo: '' });
      return true;
    }
    const all = k => form.getAll(k);
    const v = { loanId: form.get('loan') ?? '', bankId: form.get('bank') ?? '', vendorId: form.get('vendor') ?? '', txnDate: form.get('txn_date') ?? '',
      total: form.get('total') ?? '', principal: form.get('principal') ?? '', interest: form.get('interest') ?? '', interestAccountId: form.get('interest_account') ?? '',
      extras: all('extra_account').map((accountId, i) => ({ accountId, amount: all('extra_amount')[i] ?? '', description: all('extra_desc')[i] ?? '' })).slice(0, 2),
      checkNo: form.get('check_no') ?? '', memo: form.get('memo') ?? '' };
    try {
      await saveLoanPayment(pool, { ...scope, actor, v });
      go('/loans', 'ok', 'Loan payment saved.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await show(v, error.message, 422);
    }
    return true;
  }

  // Choosing an account to set up from the list's "Another account".
  if (path === '/loans/setup' && req.method === 'GET') {
    if (!/^\d{1,18}$/.test(query.account ?? '')) { go('/loans', 'error', 'Choose an account to set up.'); return true; }
    go(`/loans/${query.account}/setup`);
    return true;
  }

  m = /^\/loans\/(\d{1,18})\/setup$/.exec(path);
  if (m) {
    const a = await getLoanSetup(pool, { ...scope, accountId: Number(m[1]) });
    if (!a) throw new HttpError(404, 'Account not found');
    const show = async (v, error = null, status = 200) => page(loanSetupPage({ ...base(), a, v, error,
      choices: await otherSideChoices(pool, { ...scope, accountType: a.type, openEntityIds: openIds }) }), status);
    if (req.method === 'GET') { await show({ list: a.loan_list ?? '', otherAccountId: a.other_account_id ? String(a.other_account_id) : '' }); return true; }
    const v = { list: form.get('list') ?? '', otherAccountId: form.get('other_account') ?? '' };
    try {
      await saveLoanSetup(pool, { ...scope, accountId: a.account_id, list: v.list, otherAccountId: /^\d{1,18}$/.test(v.otherAccountId) ? Number(v.otherAccountId) : null, openEntityIds: openIds });
      go('/loans', 'ok', `“${a.name}” saved.`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await show(v, error.message, 422);
    }
    return true;
  }
  throw new HttpError(404, 'Not found');
}
