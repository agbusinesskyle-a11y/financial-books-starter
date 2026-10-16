import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField } from './forms.js';
import { accountLabel } from './accounts.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABEL } from '../domain/ledger.js';
import { txnHref } from '../data/txn-extras.js';

// The Loans page: Lending → Loans. Every loan, line of credit and loan to others with its balance, its last payment
// and, for a loan between two of the organization's companies, the other company's balance and whether the two agree.

const money = c => formatCents(c);
const report = id => `/reports/r/transaction_detail_by_account?run=1&period=all&account=${id}`;

function otherCell(l) {
  if (!l.other) return html`<span class="muted">—</span>`;
  if (l.other.hidden) return html`<span class="muted small">Paired with a company you can’t open</span>`;
  const o = l.other;
  return html`<span class="small">${o.company} · ${accountLabel(o)}: ${money(o.balance)}</span><br>
    ${o.agrees ? html`<span class="status good">Both sides agree</span>` : html`<span class="status bad">Off by ${money(Math.abs(o.difference))}</span>`}`;
}

function lastCell(l) {
  if (!l.last) return html`<span class="muted">None yet</span>`;
  const p = l.last;
  return html`<a href="${txnHref({ type: p.type, txn_id: p.txnId })}">${formatShortDate(p.date)}</a> · ${money(p.paid || p.principal)}
    ${p.paid && p.paid !== p.principal ? html`<br><span class="muted small">${money(p.principal)} off the balance</span>` : ''}`;
}

function loanTable(rows, { canRegister, canRecord, canSetup, payable }) {
  const total = rows.reduce((s, l) => s + l.balance, 0);
  return html`<div class="table-scroll"><table class="grid">
    <thead><tr><th>Account</th><th>Kind</th><th class="num">Balance</th><th>Last payment</th><th>Other company’s books</th><th class="actions"></th></tr></thead>
    <tbody>${rows.map(l => html`<tr>
      <td data-label="Account"><strong>${accountLabel(l)}</strong>${l.active ? '' : html` <span class="tag">Inactive</span>`}</td>
      <td data-label="Kind">${l.kind}</td>
      <td class="num" data-label="Balance">${money(l.balance)}</td>
      <td data-label="Last payment">${lastCell(l)}</td>
      <td data-label="Other company">${otherCell(l)}</td>
      <td class="actions" data-label="">${[
        canRegister ? html`<a href="/settings/accounts/${l.accountId}">Register</a>` : null, html`<a href="${report(l.accountId)}">Transactions</a>`,
        payable && canRecord && l.active ? html`<a href="/loans/pay?loan=${l.accountId}">Record payment</a>` : null,
        canSetup ? html`<a href="/loans/${l.accountId}/setup">Set up</a>` : null,
      ].filter(Boolean).map((a, i) => html`${i ? ' · ' : ''}${a}`)}</td>
    </tr>`)}</tbody>
    <tfoot><tr><td colspan="2">Total</td><td class="num">${money(total)}</td><td colspan="3"></td></tr></tfoot>
  </table></div>`;
}

export function loansPage({ entityName, csrf, flash, loans, canRegister, canRecord, canSetup, unlisted = [] }) {
  const owed = loans.filter(l => l.payable), lent = loans.filter(l => !l.payable);
  return layout({
    title: 'Loans', entityName, csrf, flash, wide: true,
    body: html`<div class="page-actions"><h1>Loans</h1><span class="spacer"></span>
  ${canRecord && owed.some(l => l.active) ? html`<a class="button primary" href="/loans/pay">Record a loan payment</a>` : ''}</div>
<p class="muted">Loans and lines of credit in ${entityName}’s books, with the balance from the ledger (the same as the chart of accounts and the balance sheet). An account named for its lender rather than as a loan isn’t listed until an admin adds it (Another account, below).</p>
<section class="card"><h2>What the company owes</h2>
  ${owed.length ? loanTable(owed, { canRegister, canRecord, canSetup, payable: true }) : html`<p class="muted">No loans or lines of credit.</p>`}
  <p class="muted small">A loan payment from the bank feed: in Bank transactions, split the line between the loan (the principal) and the interest account.</p>
</section>
${lent.length ? html`<section class="card"><h2>Lent to others</h2>
  ${loanTable(lent, { canRegister, canRecord, canSetup, payable: false })}
  <p class="muted small">Money a borrower pays back is a <a href="/deposits/new">bank deposit</a> to the loan account (the interest to an income account).</p>
</section>` : ''}
${canSetup ? html`<section class="card"><h2>Another account</h2>
  <p class="muted small">The page lists every long-term liability, and other liability and asset accounts named like a loan (loan, line of credit, LOC, note payable or receivable, N/P, N/R, due to, due from, singular or plural). A loan whose account is named after the lender, or anything else the rule misses, can be added here: choose it and set it to “Always listed”. Set up an account also to take it off, or to pair it with the same loan in another company’s books.</p>
  ${unlisted.length ? html`<form method="get" action="/loans/setup" class="editor"><div class="form-grid">
    ${selectField('Account', 'account', unlisted.map(a => [a.account_id, `${accountLabel(a)} (${a.type_label})`]), '', { blank: 'Choose…' })}</div>
    <div class="form-actions"><button>Set up</button></div></form>` : ''}
</section>` : ''}`,
  });
}

// v: { loanId, bankId, vendorId, txnDate, total, principal, interest, interestAccountId, extras: [{ accountId, amount, description }], checkNo, memo }
export function loanPaymentForm({ entityName, csrf, v, loans, banks, vendors, interestAccounts, otherAccounts, error = null }) {
  const extras = [...(v.extras ?? []), { accountId: '', amount: '', description: '' }, { accountId: '', amount: '', description: '' }].slice(0, 2);
  const opts = list => list.map(a => [a.account_id, accountLabel(a)]);
  return layout({
    title: 'Record a loan payment', entityName, csrf,
    body: html`<div class="crumbs"><a href="/loans">‹ Loans</a></div>
<form method="post" action="/loans/pay" class="card editor">
  ${csrfField(csrf)}
  <h1>Record a loan payment</h1>
  ${errorBanner(error)}
  <p class="muted small">The amount that left the bank, split into principal (brings the loan down) and interest (an expense), plus any escrow or fees. It’s saved as an expense from the bank, or a check when you give a check number.</p>
  <div class="form-grid">
    ${selectField('Loan', 'loan', opts(loans), v.loanId, { blank: 'Choose…' })}
    ${selectField('Paid from (bank account)', 'bank', opts(banks), v.bankId, { blank: 'Choose…' })}
    ${selectField('Paid to (lender)', 'vendor', vendors.map(x => [x.vendor_id, x.display_name]), v.vendorId, { blank: 'No vendor' })}
    ${field('Date', 'txn_date', v.txnDate, { type: 'date', required: true })}
    ${field('Payment (what left the bank)', 'total', v.total, { required: true, attrs: 'inputmode="decimal"' })}
    ${field('Check no.', 'check_no', v.checkNo, { attrs: 'inputmode="numeric"', hint: 'Blank for an online or automatic payment.' })}
  </div>
  <h2>Split</h2>
  <div class="form-grid">
    ${field('Principal', 'principal', v.principal, { attrs: 'inputmode="decimal"' })}
    ${field('Interest', 'interest', v.interest, { attrs: 'inputmode="decimal"' })}
    ${selectField('Interest account', 'interest_account', opts(interestAccounts), v.interestAccountId, { blank: 'Choose…' })}
  </div>
  <p class="muted small">Other lines (escrow, a late fee…), if the payment has them:</p>
  ${extras.map((x, i) => html`<div class="form-grid">
    ${selectField(`Other account ${i + 1}`, 'extra_account', opts(otherAccounts), x.accountId, { blank: 'None' })}
    ${field('Amount', 'extra_amount', x.amount, { attrs: 'inputmode="decimal"' })}
    ${field('Description', 'extra_desc', x.description)}
  </div>`)}
  <label class="field wide"><span>Memo</span><input name="memo" value="${v.memo}"></label>
  <div class="form-actions"><button class="primary">Save payment</button> <a class="button" href="/loans">Cancel</a></div>
</form>`,
  });
}

// One account's loan setup: listed or not, and the same loan in another company's books.
export function loanSetupPage({ entityName, csrf, a, choices, v, error = null }) {
  const rule = a.byRule ? 'Listed (its type and name say it’s a loan)' : 'Not listed (its type and name don’t say loan)';
  return layout({
    title: `Loan setup: ${a.name}`, entityName, csrf,
    body: html`<div class="crumbs"><a href="/loans">‹ Loans</a></div>
<form method="post" action="/loans/${a.account_id}/setup" class="card editor">
  ${csrfField(csrf)}
  <h1>${accountLabel(a)}</h1>
  <p class="muted">${TYPE_LABEL[a.type]}</p>
  ${errorBanner(error)}
  <div class="form-grid">
    ${selectField('On the Loans page', 'list', [['', rule], ['show', 'Always listed'], ['hide', 'Never listed']], v.list)}
    ${selectField('The other side of this loan', 'other_account', choices.map(c => [c.account_id, `${c.company} / ${accountLabel(c)}`]), v.otherAccountId, { blank: 'None (not a loan between our companies)' })}
  </div>
  <p class="muted small">For a loan between two of your companies, choose the same loan in the other company’s books: the lender’s loan receivable for the borrower’s loan payable. The Loans page then shows both balances and whether they agree. Nothing is paired by name on its own.</p>
  <div class="form-actions"><button class="primary">Save</button> <a class="button" href="/loans">Cancel</a></div>
</form>`,
  });
}
