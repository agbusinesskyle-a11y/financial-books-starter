import { moreMenu, commonMore, importedBanner } from './txn-extras.js';
import { saveBar } from './save-bar.js';
import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, postButton } from './forms.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { accountLabel } from './accounts.js';

const OTHER_ROWS = 3;
const sourceRef = s => s.doc_number ?? s.payment_ref ?? '';

export function depositsPage({ entityName, csrf, flash = null, deposits, waiting }) {
  const waitingTotal = waiting.reduce((s, w) => s + w.total_cents, 0);
  return layout({
    title: 'Deposits', entityName, csrf, flash,
    body: html`<div class="page-actions"><h1>Deposits</h1><span class="spacer"></span><a class="button primary" href="/deposits/new">Make deposit</a></div>
<p class="${waiting.length ? 'ledger-check warn' : 'ledger-check good'}">${waiting.length
  ? html`${waiting.length} payment${waiting.length === 1 ? '' : 's'} totaling ${formatCents(waitingTotal)} ${waiting.length === 1 ? 'is' : 'are'} waiting in Undeposited Funds.`
  : 'Nothing is waiting in Undeposited Funds.'}</p>
${deposits.length ? html`<table class="grid">
  <thead><tr><th>Date</th><th>Bank account</th><th>Items</th><th>Memo</th><th class="num">Amount</th></tr></thead>
  <tbody>${deposits.map(d => html`<tr>
    <td><a href="${d.type === 'deposit' ? `/deposits/${d.txn_id}` : `/txns/${d.txn_id}`}">${formatShortDate(d.txn_date)}</a></td>
    <td>${d.account_name}</td><td>${d.type === 'deposit' ? d.line_count : `${TYPE_LABELS[d.type]} straight to the bank`}</td><td class="memo">${d.memo ?? ''}</td>
    <td class="num">${formatCents(d.total_cents)}</td></tr>`)}</tbody>
</table>` : html`<p class="muted">No deposits yet.</p>`}`,
  });
}

export const depositFormValues = params => ({
  accountId: params.get('account_id') ?? '', txnDate: params.get('txn_date') ?? '', memo: params.get('memo') ?? '',
  selected: params.getAll('source').map(String),
  other: params.getAll('other_account').map((accountId, i) => ({ accountId, customerId: params.getAll('other_customer')[i] ?? '',
    description: params.getAll('other_desc')[i] ?? '', amount: params.getAll('other_amount')[i] ?? '' })),
  cashBack: { accountId: params.get('cash_back_account') ?? '', memo: params.get('cash_back_memo') ?? '', amount: params.get('cash_back_amount') ?? '' },
});

export function depositForm({ entityName, csrf, save = {}, waiting, banks, otherAccounts, customers, v, error = null }) {
  const selected = new Set(v.selected);
  const other = [...v.other];
  while (other.length < OTHER_ROWS) other.push({ accountId: '', customerId: '', description: '', amount: '' });
  return layout({
    title: 'Make deposit', entityName, csrf,
    body: html`<div class="crumbs"><a href="/deposits">‹ Deposits</a></div>
<h1>Make deposit</h1>
<form method="post" action="/deposits" class="editor" data-deposit-form>
  ${csrfField(csrf)}
  ${errorBanner(error)}
  ${banks.length ? '' : html`<p class="error-banner">Add a bank account in <a href="/settings/accounts/new">Settings → Chart of accounts</a> first.</p>`}
  <div class="form-grid">
    ${selectField('Deposit to', 'account_id', banks.map(b => [b.account_id, accountLabel(b)]), v.accountId)}
    ${field('Date', 'txn_date', v.txnDate, { type: 'date', required: true })}
    ${field('Memo', 'memo', v.memo, { cls: 'wide' })}
  </div>
  <h2>Payments waiting in Undeposited Funds</h2>
  ${waiting.length ? html`<table class="grid">
    <thead><tr><th><input type="checkbox" data-select-all="source" aria-label="Select all"></th><th>Date</th><th>Customer</th><th>Type</th><th>Ref no.</th><th>Method</th><th class="num">Amount</th></tr></thead>
    <tbody>${waiting.map(w => html`<tr>
      <td><input type="checkbox" name="source" value="${w.txn_id}" data-amount="${w.total_cents}"${selected.has(String(w.txn_id)) ? html` checked` : ''} aria-label="Include ${w.customer_name} ${formatCents(w.total_cents)}"></td>
      <td>${formatShortDate(w.txn_date)}</td>
      <td><a href="/customers/${w.customer_id}">${w.customer_name}</a></td>
      <td><a href="/txns/${w.txn_id}">${TYPE_LABELS[w.type]}</a></td>
      <td>${sourceRef(w)}</td><td>${w.payment_method ?? ''}</td>
      <td class="num">${formatCents(w.total_cents)}</td></tr>`)}</tbody>
  </table>` : html`<p class="muted">Nothing is waiting to be deposited.</p>`}
  <h2>Other funds</h2>
  <p class="muted">Money that didn’t come from a customer payment, like interest or a refund. Leave blank if none.</p>
  <table class="grid lines">
    <thead><tr><th>Received from (customer)</th><th>From account</th><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>${other.map(o => html`<tr>
      <td><select name="other_customer" aria-label="Customer"><option value="">—</option>${customers.map(c => html`<option value="${c.customer_id}"${String(c.customer_id) === String(o.customerId) ? html` selected` : ''}>${c.display_name}</option>`)}</select></td>
      <td><select name="other_account" aria-label="From account"><option value="">—</option>${otherAccounts.map(a => html`<option value="${a.account_id}"${String(a.account_id) === String(o.accountId) ? html` selected` : ''}>${accountLabel(a)}</option>`)}</select></td>
      <td><input name="other_desc" value="${o.description}" aria-label="Description"></td>
      <td class="num"><input name="other_amount" value="${o.amount}" inputmode="decimal" size="10" aria-label="Amount" data-other-amount></td>
    </tr>`)}</tbody>
  </table>
  <h2>Cash back</h2>
  <p class="muted">Part of this deposit kept as cash instead of going into the bank. Leave blank if none.</p>
  <div class="form-grid">
    ${selectField('Cash back goes to', 'cash_back_account', otherAccounts.map(a => [a.account_id, accountLabel(a)]), v.cashBack?.accountId ?? '', { blank: '—' })}
    ${field('Cash back memo', 'cash_back_memo', v.cashBack?.memo ?? '')}
    ${field('Cash back amount', 'cash_back_amount', v.cashBack?.amount ?? '', { attrs: 'inputmode="decimal" data-cash-back' })}
  </div>
  <p class="total-line">Deposit total <strong data-deposit-total>—</strong></p>
  ${saveBar({ type: 'deposit', ...save, cancelHref: '/deposits' })}
</form>`,
  });
}

export function depositPage({ entityName, csrf, flash = null, deposit: d, reconciled = false, role = 'admin' }) {
  return layout({
    title: `Deposit ${d.txn_date}`, entityName, csrf, flash,
    body: html`<div class="crumbs"><a href="/deposits">‹ Deposits</a></div>
<section class="card">
  <div class="card-head"><h1>Deposit to ${d.account_name}</h1><span class="tag">${formatShortDate(d.txn_date)}</span></div>
  <dl class="details project-totals"><div><dt>Total</dt><dd>${formatCents(d.total_cents)}</dd></div>${d.memo ? html`<div><dt>Memo</dt><dd>${d.memo}</dd></div>` : ''}
    ${Number(d.cash_back_cents) ? html`<div><dt>Cash back</dt><dd>${formatCents(d.cash_back_cents)} to ${d.cash_back_account_name}${d.cash_back_memo ? ` · ${d.cash_back_memo}` : ''}</dd></div>` : ''}</dl>
  <table class="grid">
    <thead><tr><th>Received from</th><th>What</th><th>Ref no.</th><th class="num">Amount</th></tr></thead>
    <tbody>${d.lines.map(l => html`<tr>
      <td>${l.customer_id ? html`<a href="/customers/${l.customer_id}">${l.customer_name}</a>` : '—'}</td>
      <td>${l.source_txn_id ? html`<a href="/txns/${l.source_txn_id}">${TYPE_LABELS[l.source_type]} · ${formatShortDate(l.source_date)}</a>` : html`${l.account_name}${l.description ? ` · ${l.description}` : ''}`}</td>
      <td>${l.source_txn_id ? (l.doc_number ?? l.payment_ref ?? '') : ''}</td>
      <td class="num">${formatCents(l.amount_cents)}</td></tr>`)}</tbody>
  </table>
  ${importedBanner(d)}
  <div class="txn-actions section-title"><a class="button" href="/deposits/${d.txn_id}/slip.pdf" target="_blank" rel="noopener">Print deposit slip and summary</a>
    <a class="button" href="/deposits/${d.txn_id}/slip.pdf?summary=1" target="_blank" rel="noopener">Print summary only</a>
    ${moreMenu({ csrf, items: [...commonMore(d), d.source === 'qbo_import' ? null : { label: 'Delete deposit', post: `/deposits/${d.txn_id}/delete`, danger: true,
    extra: reconciled && role === 'admin' ? { edit_reconciled: '1' } : {},
    confirm: `Delete this deposit? Its payments go back to Undeposited Funds.${reconciled ? ' It’s reconciled — this changes a finished reconciliation.' : ''}` }] })}</div>
</section>`,
  });
}
