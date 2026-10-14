import { moreMenu, commonMore, importedBanner, isImported, rebuiltNote } from './txn-extras.js';
import { txnHref } from '../data/txn-extras.js';
import { formatMoney } from '../domain/fx.js';
import { html } from './html.js';
import { layout } from './layout.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { txnStatus, TYPE_LABELS } from '../domain/status.js';
import { postButton } from './forms.js';
import { applyCreditForm } from './txn-form.js';
import { txnDocuments } from './documents.js';

const CREDIT_TYPES = new Set(['payment', 'credit_memo']);

// Accept / reject / close / reopen, and turn into an invoice: all of it, a percent of each line, or chosen amounts.
function estimateActions(t, csrf) {
  const st = t.estimate_status;
  const status = (to, label, confirm = null) => postButton({ action: `/txns/${t.txn_id}/status`, csrf, label, cls: '', confirm, extra: { status: to } });
  const canInvoice = t.open_cents > 0 && st !== 'rejected' && st !== 'closed';
  return html`${st === 'pending' ? status('accepted', 'Accept') : ''}
    ${st === 'pending' ? status('rejected', 'Reject', 'Mark this estimate rejected?') : ''}
    ${st === 'accepted' && t.open_cents > 0 ? status('closed', 'Close', 'Close this estimate? Nothing more can be invoiced from it.') : ''}
    ${st === 'rejected' || (st === 'closed' && t.open_cents > 0) ? status('pending', 'Reopen') : ''}
    ${canInvoice ? html`<details class="menu"><summary class="button primary">Create invoice</summary><div class="menu-items progress-menu">
      <a href="/txns/${t.txn_id}/invoice?mode=full">Everything left (${formatCents(t.open_cents)})</a>
      <form method="get" action="/txns/${t.txn_id}/invoice" class="progress-form"><input type="hidden" name="mode" value="percent">
        <label>Percent of each line <input name="percent" inputmode="decimal" size="4" required placeholder="50"></label> <button>Go</button></form>
      <a href="/txns/${t.txn_id}/invoice?mode=lines">Choose amounts per line</a>
    </div></details>` : ''}`;
}

export function txnPage({ txn: t, entityName, csrf, today, flash = null, charges = [], applyError = null, documents = [], role = 'admin' }) {
  const force = t.reconciled && role === 'admin' ? { edit_reconciled: '1' } : {};
  const lock = t.reconciled ? ' It’s reconciled — this changes a finished reconciliation.' : '';
  const s = txnStatus(t, today);
  // A foreign-currency document shows its own currency.
  const money = c => formatMoney(c, t.currency ?? null);
  const title = `${TYPE_LABELS[t.type]} ${t.doc_number ?? t.payment_ref ?? ''}`.trim();
  const isCredit = CREDIT_TYPES.has(t.type);
  const linesTotal = t.lines.reduce((sum, l) => sum + l.amount_cents, 0);
  return layout({
    title, entityName, csrf, flash,
    body: html`<div class="crumbs"><a href="/customers/${t.customer_id}">‹ ${t.customer_name}</a></div>
<section class="card txn-view">
  <div class="card-head">
    <h1>${title}</h1>
    <span class="status ${s.tone}">${s.text}</span>
  </div>
  ${importedBanner(t)}
  <div class="txn-actions">
    ${!t.voided_at && t.type !== 'late_fee' && !isImported(t) ? html`<a class="button" href="/txns/${t.txn_id}/edit">Edit</a>` : ''}
    ${!t.voided_at && (t.type === 'invoice' || t.type === 'late_fee') && t.open_cents > 0 ? html`<a class="button" href="/txns/new?type=payment&customer=${t.customer_id}&charge=${t.txn_id}">Receive payment</a>` : ''}
    ${t.type === 'estimate' && !t.voided_at ? estimateActions(t, csrf) : ''}
    ${t.voided_at ? '' : postButton({ action: `/txns/${t.txn_id}/send`, csrf, label: 'Send', cls: '' })}
    <a class="button" href="/txns/${t.txn_id}.pdf" target="_blank" rel="noopener">Print</a>
    ${moreMenu({ csrf, items: [
      t.type === 'payment' || t.type === 'late_fee' ? null : { label: 'Copy', href: `/txns/new?copy=${t.txn_id}` },
      ['invoice', 'sales_receipt'].includes(t.type) && !t.voided_at ? { label: 'Make recurring', href: `/customers/${t.customer_id}/recurring/new?from=${t.txn_id}` } : null,
      t.type === 'invoice' && !t.voided_at && t.open_cents > 0 ? { label: 'Send reminder', post: `/txns/${t.txn_id}/reminder` } : null,
      t.type === 'invoice' && !t.voided_at && t.open_cents > 0 ? { label: 'Share invoice link', post: `/txns/${t.txn_id}/share` } : null,
      t.voided_at ? null : { label: 'Preview email', href: `/txns/${t.txn_id}/preview` },
      ['invoice', 'sales_receipt', 'estimate'].includes(t.type) ? { label: 'Print packing slip', href: `/txns/${t.txn_id}/packing-slip.pdf`, newTab: true } : null,
      ...commonMore(t),
      t.voided_at || isImported(t) ? null : { label: 'Void', post: `/txns/${t.txn_id}/void`, confirm: `Void ${title}? Its amount becomes $0.00 and any payments applied to it are released.${lock}`, extra: force },
      isImported(t) ? null : { label: 'Delete', post: `/txns/${t.txn_id}/delete`, danger: true, confirm: `Delete ${title}? This can’t be undone.${lock}`, extra: force },
    ] })}
  </div>
  <dl class="details">
    <div><dt>Customer</dt><dd><a href="/customers/${t.customer_id}">${t.customer_name}</a></dd></div>
    <div><dt>Date</dt><dd>${formatShortDate(t.txn_date)}</dd></div>
    ${t.due_date ? html`<div><dt>${t.type === 'estimate' ? 'Expires' : 'Due date'}</dt><dd>${formatShortDate(t.due_date)}</dd></div>` : ''}
    ${t.payment_method ? html`<div><dt>Payment method</dt><dd>${t.payment_method}</dd></div>` : ''}
    ${t.payment_ref ? html`<div><dt>Reference</dt><dd>${t.payment_ref}</dd></div>` : ''}
    ${t.memo ? html`<div><dt>Memo</dt><dd>${t.memo}</dd></div>` : ''}
    ${t.project_id ? html`<div><dt>Project</dt><dd><a href="/projects/${t.project_id}">${t.project_name}</a></dd></div>` : ''}
    ${t.po_number ? html`<div><dt>P.O. number</dt><dd>${t.po_number}</dd></div>` : ''}
    ${t.bill_to ? html`<div><dt>Bill to</dt><dd class="pre">${t.bill_to}</dd></div>` : ''}
    ${t.ship_to ? html`<div><dt>Ship to</dt><dd class="pre">${t.ship_to}</dd></div>` : ''}
    ${t.ship_via || t.ship_date || t.tracking_no ? html`<div><dt>Shipping</dt><dd>${[t.ship_via, t.ship_date ? formatShortDate(t.ship_date) : null, t.tracking_no ? `tracking ${t.tracking_no}` : null].filter(Boolean).join(' · ')}</dd></div>` : ''}
    ${t.email_cc || t.email_bcc ? html`<div><dt>Email copies</dt><dd>${[t.email_cc ? `Cc ${t.email_cc}` : null, t.email_bcc ? `Bcc ${t.email_bcc}` : null].filter(Boolean).join(' · ')}</dd></div>` : ''}
    ${t.type === 'estimate' && t.accepted_by ? html`<div><dt>Accepted by</dt><dd>${t.accepted_by}${t.accepted_date ? `, ${formatShortDate(t.accepted_date)}` : ''}</dd></div>` : ''}
    ${t.type === 'estimate' && t.deposit_request_percent ? html`<div><dt>Deposit request</dt><dd>${Number(t.deposit_request_percent)}%</dd></div>` : ''}
    ${t.print_later || t.send_later ? html`<div><dt>Queued</dt><dd>${[t.print_later ? 'To print' : null, t.send_later ? 'To send' : null].filter(Boolean).join(' · ')}</dd></div>` : ''}
    ${t.internal_note ? html`<div><dt>Internal note</dt><dd class="pre">${t.internal_note} <small class="muted">(not shown to the customer)</small></dd></div>` : ''}
    ${t.statement_memo ? html`<div><dt>Memo on statement</dt><dd>${t.statement_memo}</dd></div>` : ''}
  </dl>
  ${t.lines.length ? html`<table class="grid">
    <thead><tr><th>#</th><th>Product/service</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>${(() => { let section = 0; return t.lines.map(l => {
      if (l.kind === 'subtotal') { const s = section; section = 0; return html`<tr class="subtotal-line"><td>${l.line_no}</td><td colspan="4">${l.description}</td><td class="num">${money(s)}</td></tr>`; }
      if (l.kind === 'text') return html`<tr class="text-line"><td>${l.line_no}</td><td colspan="5"><em>${l.description}</em></td></tr>`;
      section += Number(t.currency && l.foreign_amount_cents !== null ? l.foreign_amount_cents : l.amount_cents);
      return html`<tr><td>${l.line_no}</td><td>${l.item_name ?? ''}</td><td>${l.description ?? ''}</td>
      <td class="num">${l.quantity}</td><td class="num">${money(t.currency && l.foreign_rate_cents !== null ? l.foreign_rate_cents : l.rate_cents)}</td><td class="num">${money(t.currency && l.foreign_amount_cents !== null ? l.foreign_amount_cents : l.amount_cents)}</td></tr>`; }); })()}</tbody>
  </table>` : ''}
  <dl class="totals">
    ${t.voided_at && linesTotal ? html`<div><dt>Original amount</dt><dd>${formatCents(linesTotal)}</dd></div>` : ''}
    <div><dt>Total</dt><dd>${money(t.currency ? t.foreign_total_cents : t.total_cents)}</dd></div>
    ${t.currency ? html`<div><dt>Exchange rate</dt><dd>${Number(t.exchange_rate)} (${formatCents(t.total_cents)} in USD)</dd></div>` : ''}
    ${t.type === 'estimate' ? html`<div><dt>Invoiced so far</dt><dd>${formatCents(t.total_cents - t.open_cents)}</dd></div><div><dt>Left to invoice</dt><dd>${money(t.currency ? t.foreign_open_cents : t.open_cents)}</dd></div>
      ${t.deposit_cents ? html`<div><dt>Deposit received</dt><dd><a href="/txns/${t.deposit_txn_id}">${formatCents(t.deposit_cents)}</a></dd></div>` : ''}`
    : t.type === 'sales_receipt' ? '' : html`<div><dt>${isCredit ? 'Unapplied' : 'Balance due'}</dt><dd>${money(t.currency ? t.foreign_open_cents : t.open_cents)}</dd></div>`}
  </dl>
  ${t.applications.length ? html`<h2>${isCredit ? 'Applied to' : 'Payments and credits'}</h2>
  <table class="grid">
    <thead><tr><th>Date</th><th>Transaction</th><th class="num">Amount applied</th></tr></thead>
    <tbody>${t.applications.map(a => html`<tr><td>${formatShortDate(a.applied_on)}</td>
      <td><a href="${txnHref(a)}">${TYPE_LABELS[a.type]} ${a.doc_number ?? a.payment_ref ?? ''}</a>${rebuiltNote(a)}</td>
      <td class="num">${money(t.currency && a.foreign_cents !== null ? a.foreign_cents : a.amount_cents)}</td></tr>`)}</tbody>
  </table>` : ''}
  ${isCredit ? applyCreditForm({ csrf, credit: t, charges, error: applyError }) : ''}
  ${txnDocuments(documents, t.customer_id)}
</section>`,
  });
}
