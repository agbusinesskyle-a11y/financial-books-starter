import { moreMenu, commonMore, importedBanner } from './txn-extras.js';
import { saveBar } from './save-bar.js';
import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, postButton, checkbox } from './forms.js';
import { formatCents, centsToInput, parseSignedMoney } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { canAccess } from '../domain/roles.js';
import { dimensionFields, lineClasses, lineClassSelect } from './dims.js';

// [href, label, what it's for, stage-built flag]
export const TOOLS = [
  ['/reconcile', 'Reconcile', 'Match an account to its bank or card statement'],
  ['/journal/new', 'Journal entry', 'Move amounts between accounts directly'],
  ['/transfers/new', 'Transfer', 'Move money between bank, card and asset accounts'],
  ['/card-payments/new', 'Pay down credit card', 'Pay a credit card from a bank account'],
  ['/budgets', 'Budgets', 'Plan income and expenses by month and compare with actuals'],
  ['/import', 'Import', 'Customers, products and services, chart of accounts from CSV'],
  ['/export', 'Export', 'Every list and transaction to Excel, attachments as a ZIP'],
  ['/all-recurring', 'All recurring', 'Every recurring template, customer and vendor'],
  ['/attachments', 'All attachments', 'Every document on file'],
  ['/time', 'Time', 'Hours worked, by day or as a weekly timesheet; billable time goes on invoices'],
];

export function toolsPage({ entityName, csrf, role, tools = TOOLS }) {
  const mine = tools.filter(([href]) => canAccess(role, 'GET', href.split('?')[0]));
  return layout({
    title: 'Tools', entityName, csrf,
    body: html`<h1>Tools</h1>
<section class="card"><ul class="link-list">
  ${mine.map(([href, label, about]) => html`<li><a href="${href}"><strong>${label}</strong><small class="muted">${about}</small></a></li>`)}
</ul></section>`,
  });
}

// An override box for admins when a reconciled transaction can't be changed.
export const reconciledOverride = show => (show ? html`<label class="check override"><input type="checkbox" name="edit_reconciled" value="1">
  Change it anyway — I know this changes a finished reconciliation (admin)</label>` : '');

const JE_ROWS = 4;
const label = a => (a.number ? `${a.number} · ${a.name}` : a.name);

export function journalForm({ entityName, csrf, txnId = null, save = {}, v, accounts, parties, dims, error = null, override = false }) {
  const lines = [...v.lines];
  while (lines.length < Math.max(JE_ROWS, v.lines.length + 1)) lines.push({ accountId: '', debit: '', credit: '', description: '', party: '', classId: '' });
  const withClass = lineClasses(dims);
  return layout({
    title: txnId ? `Journal entry ${v.docNumber}` : 'New journal entry', entityName, csrf, wide: true,
    body: html`<div class="crumbs"><a href="/tools">‹ Tools</a></div>
<form method="post" action="${txnId ? `/journal/${txnId}` : '/journal'}" class="card editor" data-journal>
  ${csrfField(csrf)}
  <div class="card-head"><h1>${txnId ? `Journal entry ${v.docNumber}` : 'New journal entry'}</h1>
    <p class="big-total">Difference <strong data-je-diff>$0.00</strong></p></div>
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Date', 'txn_date', v.txnDate, { type: 'date', required: true })}
    ${field('Journal no.', 'doc_number', v.docNumber, { hint: txnId ? '' : 'Leave blank for the next number' })}
    ${txnId ? '' : field('Reverse on', 'reverse_on', v.reverseOn, { type: 'date', hint: 'Optional: a reversing entry on this date (e.g. the 1st of next month).' })}
    ${checkbox('Adjusting entry (shown separately on the Adjusted Trial Balance)', 'adjusting', v.adjusting)}
  </div>
  ${dimensionFields(dims && { ...dims, settings: { ...dims.settings, classMode: withClass ? 'line' : dims.settings.classMode } }, v)}
  <table class="grid lines" data-rows="je">
    <thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th><th>Description</th><th>Customer / vendor</th>${withClass ? html`<th>Class</th>` : ''}</tr></thead>
    <tbody>${lines.map((l, i) => html`<tr>
      <td data-label="Account"><select name="je_account" aria-label="Account, line ${i + 1}"><option value="">—</option>
        ${accounts.map(a => html`<option value="${a.account_id}"${String(a.account_id) === String(l.accountId) ? html` selected` : ''}>${label(a)}</option>`)}</select></td>
      <td class="num" data-label="Debit"><input name="je_debit" value="${l.debit}" inputmode="decimal" size="9" aria-label="Debit" data-je-debit></td>
      <td class="num" data-label="Credit"><input name="je_credit" value="${l.credit}" inputmode="decimal" size="9" aria-label="Credit" data-je-credit></td>
      <td data-label="Description"><input name="je_desc" value="${l.description}" aria-label="Description"></td>
      <td data-label="Name"><select name="je_party" aria-label="Customer or vendor"><option value="">—</option>
        ${parties.map(p => html`<option value="${p.value}"${p.value === l.party ? html` selected` : ''}>${p.label}</option>`)}</select></td>
      ${withClass ? html`<td data-label="Class">${lineClassSelect('je_class', dims.classes, l.classId)}</td>` : ''}
    </tr>`)}</tbody>
    <tfoot><tr><td>Total</td><td class="num" data-je-debits>$0.00</td><td class="num" data-je-credits>$0.00</td><td colspan="3"></td></tr></tfoot>
  </table>
  <p><button type="button" class="link" data-add-row="je">+ Add a line</button></p>
  <label class="field wide"><span>Memo</span><input name="memo" value="${v.memo}"></label>
  ${reconciledOverride(override)}
  ${saveBar({ type: 'journal_entry', ...save, cancelHref: '/tools' })}
</form>`,
  });
}

export function transferForm({ entityName, csrf, type, txnId = null, save = {}, v, fromAccounts, toAccounts, dims, error = null, override = false }) {
  const card = type === 'cc_payment';
  const title = card ? 'Pay down credit card' : 'Transfer';
  const action = card ? '/card-payments' : '/transfers';
  return layout({
    title, entityName, csrf,
    body: html`<div class="crumbs"><a href="/tools">‹ Tools</a></div>
<form method="post" action="${txnId ? `${action}/${txnId}` : action}" class="card editor">
  ${csrfField(csrf)}
  <h1>${title}</h1>
  ${errorBanner(error)}
  <div class="form-grid">
    ${selectField(card ? 'Credit card' : 'Transfer funds from', card ? 'to_account' : 'from_account', (card ? toAccounts : fromAccounts).map(a => [a.account_id, label(a)]),
      card ? v.toId : v.fromId, { blank: 'Choose…' })}
    ${selectField(card ? 'Paid from (bank account)' : 'Transfer funds to', card ? 'from_account' : 'to_account', (card ? fromAccounts : toAccounts).map(a => [a.account_id, label(a)]),
      card ? v.fromId : v.toId, { blank: 'Choose…' })}
    ${field('Amount', 'amount', v.amount, { required: true, attrs: 'inputmode="decimal"' })}
    ${field('Date', 'txn_date', v.txnDate, { type: 'date', required: true })}
  </div>
  ${dimensionFields(dims && { ...dims, settings: { ...dims.settings, classMode: 'txn' } }, v)}
  <label class="field wide"><span>Memo</span><input name="memo" value="${v.memo}"></label>
  ${reconciledOverride(override)}
  ${saveBar({ type, ...save, cancelHref: '/tools' })}
</form>`,
  });
}

export function ledgerTxnPage({ entityName, csrf, flash = null, t, admin }) {
  const title = `${TYPE_LABELS[t.type]}${t.doc_number ? ` ${t.doc_number}` : ''}`;
  const editPath = t.type === 'journal_entry' ? `/journal/${t.txn_id}/edit` : t.type === 'transfer' ? `/transfers/${t.txn_id}/edit` : `/card-payments/${t.txn_id}/edit`;
  const force = t.reconciled && admin ? { edit_reconciled: '1' } : {};
  const lock = t.reconciled ? ' It’s reconciled — this changes a finished reconciliation.' : '';
  return layout({
    title, entityName, csrf, flash,
    body: html`<div class="crumbs"><a href="/tools">‹ Tools</a></div>
<section class="card">
  <div class="card-head"><h1>${title}</h1><span class="status ${t.voided_at ? 'muted' : 'good'}">${t.voided_at ? 'Voided' : t.reconciled ? 'Reconciled' : 'Posted'}</span></div>
  ${importedBanner(t)}
  <div class="txn-actions">
    ${t.voided_at || t.type === 'fx_revaluation' || t.source === 'qbo_import' ? '' : html`<a class="button" href="${editPath}">Edit</a>`}
    ${moreMenu({ csrf, items: [
      t.type === 'journal_entry' ? { label: 'Copy', href: `/journal/new?copy=${t.txn_id}` } : t.type === 'transfer' ? { label: 'Copy', href: `/transfers/new?copy=${t.txn_id}` }
        : t.type === 'cc_payment' ? { label: 'Copy', href: `/card-payments/new?copy=${t.txn_id}` } : null,
      ...commonMore(t),
      t.voided_at || t.source === 'qbo_import' ? null : { label: 'Void', post: `/ledger/${t.txn_id}/void`, confirm: `Void ${title}?${lock}`, extra: force },
      t.source === 'qbo_import' ? null : { label: 'Delete', post: `/ledger/${t.txn_id}/delete`, danger: true, confirm: `Delete ${title}? This can’t be undone.${lock}`, extra: force },
    ] })}
  </div>
  <dl class="details">
    <div><dt>Date</dt><dd>${formatShortDate(t.txn_date)}</dd></div>
    ${t.type !== 'journal_entry' ? html`<div><dt>From</dt><dd>${t.from_name}</dd></div><div><dt>To</dt><dd>${t.to_name}</dd></div>
      <div><dt>Amount</dt><dd>${formatCents(t.total_cents)}</dd></div>` : ''}
    ${t.reverses_txn_id ? html`<div><dt>Reverses</dt><dd><a href="/ledger/${t.reverses_txn_id}">${t.reverses_number}</a></dd></div>` : ''}
    ${t.reversed_by ? html`<div><dt>Reversed by</dt><dd><a href="/ledger/${t.reversed_by}">the reversing entry</a></dd></div>` : ''}
    ${t.memo ? html`<div><dt>Memo</dt><dd>${t.memo}</dd></div>` : ''}
  </dl>
  ${t.lines.length ? html`<table class="grid">
    <thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th><th>Description</th><th>Name</th></tr></thead>
    <tbody>${t.lines.map(l => html`<tr><td data-label="Account">${l.account_name}</td>
      <td class="num" data-label="Debit">${l.amount_cents > 0 ? formatCents(l.amount_cents) : ''}</td>
      <td class="num" data-label="Credit">${l.amount_cents < 0 ? formatCents(-l.amount_cents) : ''}</td>
      <td data-label="Description">${l.description ?? ''}</td>
      <td data-label="Name">${l.customer_name ?? l.vendor_name ?? ''}</td></tr>`)}</tbody>
  </table>` : ''}
</section>`,
  });
}

export const journalToValues = t => ({
  txnDate: t.txn_date, docNumber: t.doc_number ?? '', memo: t.memo ?? '', reverseOn: '', adjusting: Boolean(t.is_adjusting),
  classId: t.class_id ? String(t.class_id) : '', locationId: t.location_id ? String(t.location_id) : '', tagIds: (t.tag_ids ?? []).map(String),
  lines: t.lines.map(l => ({ accountId: String(l.account_id), debit: l.amount_cents > 0 ? centsToInput(l.amount_cents) : '', credit: l.amount_cents < 0 ? centsToInput(-l.amount_cents) : '',
    description: l.description ?? '', party: l.customer_id ? `c:${l.customer_id}` : l.vendor_id ? `v:${l.vendor_id}` : '', classId: l.class_id ? String(l.class_id) : '' })),
});

// ---- reconcile ----

export function reconcileStartPage({ entityName, csrf, flash = null, accounts, today, verified = [] }) {
  return layout({
    title: 'Reconcile', entityName, csrf, flash,
    body: html`<div class="crumbs"><a href="/tools">‹ Tools</a></div>
<section class="card">
  <h1>Reconcile an account</h1>
  <p class="muted">Pick the account and enter the numbers from its statement.</p>
  <form method="get" action="/reconcile/start" class="editor">
    <div class="form-grid">
      ${selectField('Account', 'account', accounts.map(a => [a.account_id, `${a.name}${a.last_date ? ` (reconciled through ${formatShortDate(a.last_date)})` : ''}`]), '', { blank: 'Choose…' })}
      ${field('Statement ending date', 'date', today, { type: 'date', required: true })}
      ${field('Ending balance', 'ending', '', { required: true, attrs: 'inputmode="decimal"' })}
    </div>
    <div class="form-actions"><button class="primary">Start reconciling</button></div>
  </form>
</section>
${verified.length ? html`<section class="card"><h2>Verified by ledgerline</h2>
  <p class="muted small">Ledgerline has checked these months against the bank statements. Start from one and its date and ending balance are filled in.</p>
  <ul class="link-list">${verified.map(v => html`<li><a href="/reconcile/start?account=${v.accountId}&amp;date=${v.periodEnd}&amp;ending=${(v.closing / 100).toFixed(2)}">
    <strong>${v.accountName} — statement ending ${formatShortDate(v.periodEnd)}</strong>
    <small class="${v.difference ? 'warn' : 'muted'}">Ending balance ${formatCents(v.closing)}${v.difference ? ` · books off by ${formatCents(v.difference)}` : v.waitingCount ? ` · ${v.waitingCount} bank item${v.waitingCount === 1 ? '' : 's'} still to review` : ' · books agree'}</small></a></li>`)}</ul>
</section>` : ''}
${accounts.some(a => a.last_date) ? html`<section class="card"><h2>History</h2><ul class="link-list">
  ${accounts.filter(a => a.last_date).map(a => html`<li><a href="/reconcile/${a.account_id}/history"><strong>${a.name}</strong>
    <small class="muted">Last: ${formatShortDate(a.last_date)}, ending balance ${formatCents(a.last_ending)}</small></a></li>`)}
</ul></section>` : ''}`,
  });
}

export function reconcileWorksheet({ entityName, csrf, state, statementDate, ending, checked = null, error = null, verified = null }) {
  // First time in: what the bank feed already cleared is ticked (stage B3).
  const chosen = new Set((checked ?? state.items.filter(i => i.bank_cleared).map(i => i.txn_id)).map(String));
  const { account, items, beginning } = state;
  const money = items.filter(i => i.amount > 0), out = items.filter(i => i.amount < 0);
  const card = account.type === 'credit_card';
  const row = i => html`<tr>
    <td data-label=""><input type="checkbox" name="ids" value="${i.txn_id}" data-amount="${i.amount}"${chosen.has(String(i.txn_id)) ? html` checked` : ''} aria-label="Cleared"></td>
    <td data-label="Date">${formatShortDate(i.txn_date)}</td>
    <td data-label="Type">${TYPE_LABELS[i.type]} ${i.doc_number ?? i.payment_ref ?? ''}</td>
    <td data-label="Name">${i.adjustment ? html`<strong>Change since reconciled</strong>${i.party ? ` · ${i.party}` : ''}` : i.party ?? i.memo ?? ''}</td>
    <td class="num" data-label="Amount">${formatCents(Math.abs(i.amount))}</td></tr>`;
  const table = (title, list) => html`<h2>${title}</h2>${list.length ? html`<table class="grid"><thead><tr><th></th><th>Date</th><th>Transaction</th><th>Name</th><th class="num">Amount</th></tr></thead>
    <tbody>${list.map(row)}</tbody></table>` : html`<p class="muted">None.</p>`}`;
  return layout({
    title: `Reconcile ${account.name}`, entityName, csrf, wide: true,
    body: html`<div class="crumbs"><a href="/reconcile">‹ Reconcile</a></div>
<form method="post" action="/reconcile/${account.account_id}" class="card" data-reconcile>
  ${csrfField(csrf)}
  <h1>Reconcile ${account.name}</h1>
  ${errorBanner(error)}
  ${verifiedBox(verified, ending)}
  ${state.discrepancies?.length ? html`<div class="ledger-check warn" role="alert"><strong>Reconciliation discrepancy:</strong> these reconciled transactions were changed or
    deleted after they were reconciled, so the books are ${formatCents(state.discrepancies.reduce((t, d) => t + d.difference, 0))} different from what was cleared.
    <ul>${state.discrepancies.map(d => html`<li>${formatShortDate(d.txn_date)} ${TYPE_LABELS[d.type] ?? d.type} ${d.doc ?? ''}${d.party ? ` · ${d.party}` : ''} — reconciled
      ${formatCents(d.was)} on ${formatShortDate(d.statement_date)}, now ${d.deleted ? 'deleted' : d.voided ? 'voided' : formatCents(d.now)}</li>`)}</ul>
    Each change is listed below as “Change since reconciled”; tick it if the bank statement shows it.</div>` : ''}
  <div class="form-grid">
    ${field('Statement ending date', 'statement_date', statementDate, { type: 'date', required: true })}
    ${field('Ending balance', 'ending', ending, { required: true, attrs: 'inputmode="decimal" data-ending' })}
  </div>
  <dl class="totals rec-totals" data-beginning="${beginning}">
    <div><dt>Beginning balance</dt><dd>${formatCents(beginning)}</dd></div>
    <div><dt>Cleared balance</dt><dd data-cleared>${formatCents(beginning)}</dd></div>
    <div><dt>Difference</dt><dd data-rec-diff>—</dd></div>
  </dl>
  <p><button type="button" class="link" data-tick-all>Tick all</button> · <button type="button" class="link" data-untick-all>Untick all</button></p>
  ${table(card ? 'Charges and other increases' : 'Deposits and other increases', money)}
  ${table(card ? 'Payments and credits' : 'Checks, payments and other decreases', out)}
  <div class="form-actions"><a href="/reconcile">Cancel</a><button class="primary" data-finish>Finish now</button></div>
</form>`,
  });
}

export function reconcileHistoryPage({ entityName, csrf, flash = null, state }) {
  const [last] = state.history;
  return layout({
    title: `Reconciliations · ${state.account.name}`, entityName, csrf, flash,
    body: html`<div class="crumbs"><a href="/reconcile">‹ Reconcile</a></div>
<section class="card">
  <h1>${state.account.name}: reconciliations</h1>
  ${state.history.length ? html`<table class="grid"><thead><tr><th>Statement date</th><th class="num">Beginning</th><th class="num">Ending</th><th>Finished by</th><th>Report</th></tr></thead>
    <tbody>${state.history.map(r => html`<tr><td data-label="Statement date">${formatShortDate(r.statement_date)}</td>
      <td class="num" data-label="Beginning">${formatCents(r.beginning_cents)}</td><td class="num" data-label="Ending">${formatCents(r.ending_cents)}</td>
      <td data-label="Finished by">${r.completed_by}</td><td data-label="Report"><a href="/reconcile/report/${r.rec_id}.pdf" target="_blank" rel="noopener">PDF</a></td></tr>`)}</tbody></table>`
    : html`<p class="muted">Not reconciled yet.</p>`}
  ${last ? postButton({ action: `/reconcile/${state.account.account_id}/undo`, csrf, label: `Undo the ${formatShortDate(last.statement_date)} reconciliation`, cls: 'button',
    confirm: 'Undo the last reconciliation? Its transactions become uncleared again.' }) : ''}
</section>`,
  });
}

// Ledgerline verified this statement (stage B6): its ending balance, and whether the books agree with it.
function verifiedBox(v, ending) {
  if (!v || v.closing === null) return '';
  const typed = parseSignedMoney(String(ending ?? '').trim());
  return html`<div class="${v.difference || (typed !== null && typed !== v.closing) ? 'ledger-check warn' : 'ledger-check'}" role="status">
    <strong>Ledgerline verified this statement:</strong> ending balance ${formatCents(v.closing)}.
    ${typed !== null && typed !== v.closing ? html`<br>The ending balance entered (${formatCents(typed)}) isn’t the verified one.` : ''}
    ${v.difference ? html`<br>The books are off by <strong>${formatCents(v.difference)}</strong>: the bank cleared ${formatCents(v.cleared)} in the books${v.waiting ? `, ${formatCents(v.waiting)} is waiting for review` : ''}${v.excluded ? `, ${formatCents(v.excluded)} was excluded` : ''}. Find what’s missing or different before reconciling.`
      : v.waitingCount ? html`<br>${v.waitingCount} bank item${v.waitingCount === 1 ? '' : 's'} through this date still need review in <a href="/banking">Bank transactions</a>.` : html`<br>The books agree.`}
  </div>`;
}
