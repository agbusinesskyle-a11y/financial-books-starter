import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField } from './forms.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';

// Stage F4: the Email / Payor / PDF previews of a sales transaction, and the Print later / Send later queue.

const label = t => `${TYPE_LABELS[t.type]}${t.doc_number ? ` ${t.doc_number}` : ''}`;

export function previewPage({ entityName, csrf, txn: t, view, email = null, payor = null }) {
  const tab = (k, text) => html`<a class="${view === k ? 'tab active' : 'tab'}" href="${k === 'pdf' ? `/txns/${t.txn_id}.pdf` : `/txns/${t.txn_id}/preview?view=${k}`}"${k === 'pdf' ? html` target="_blank" rel="noopener"` : ''}${view === k ? html` aria-current="page"` : ''}>${text}</a>`;
  return layout({ title: `Preview ${label(t)}`, entityName, csrf, body: html`<div class="crumbs"><a href="/txns/${t.txn_id}">‹ ${label(t)}</a></div>
  <h1>Preview</h1>
  <nav class="tabs" aria-label="Preview">${tab('email', 'Email view')}${['invoice', 'late_fee'].includes(t.type) ? tab('payor', 'Payor view') : ''}${tab('pdf', 'PDF view')}</nav>
  ${view === 'email' ? html`<section class="card email-preview">
    <dl class="details">
      <div><dt>To</dt><dd>${email.to ?? html`<span class="warn">No email address for this customer</span>`}</dd></div>
      ${email.cc ? html`<div><dt>Cc</dt><dd>${email.cc}</dd></div>` : ''}${email.bcc ? html`<div><dt>Bcc</dt><dd>${email.bcc}</dd></div>` : ''}
      <div><dt>Subject</dt><dd>${email.subject}</dd></div>
      <div><dt>Attachment</dt><dd>${label(t)}.pdf</dd></div>
    </dl>
    <pre class="email-body">${email.text}</pre>
    ${['invoice', 'late_fee'].includes(t.type) ? html`<p class="muted small">When online payments are on, a one-time “Pay online” link is added at the end.</p>` : ''}
  </section>` : html`<section class="card">${payor}</section>`}` });
}

export function payorPreview({ txn: t, entityName, settings }) {
  const due = Number(t.open_cents);
  return html`<p class="ledger-check">This is what the customer sees after clicking “Pay online”. Nothing here can be paid.</p>
  <h2>Invoice ${t.doc_number ?? ''}</h2>
  <p>From <strong>${entityName}</strong> to ${t.customer_name}${t.due_date ? html` · due ${formatShortDate(t.due_date)}` : ''}</p>
  ${!settings.enabled ? html`<p>Online payments are off (Settings → Payments), so the email has no pay link.</p>`
    : due <= 0 ? html`<p class="flash ok">Nothing is due on this invoice.</p>`
    : html`<p class="big-total">Balance due <strong>${formatCents(due)}</strong></p>
      <p>Pay by ${[settings.card ? 'card' : null, settings.ach ? 'bank transfer (ACH)' : null].filter(Boolean).join(' or ')}.</p>`}`;
}

export function queuePage({ entityName, csrf, flash, which, rows, counts }) {
  const other = which === 'send' ? 'print' : 'send';
  return layout({ title: which === 'send' ? 'Send later' : 'Print later', entityName, csrf, flash, body: html`<h1>${which === 'send' ? 'Send later' : 'Print later'}</h1>
  <nav class="tabs" aria-label="Queues"><a class="${which === 'print' ? 'tab active' : 'tab'}" href="/sales-queue?which=print">Print later (${counts.print})</a>
    <a class="${which === 'send' ? 'tab active' : 'tab'}" href="/sales-queue?which=send">Send later (${counts.send})</a></nav>
  ${rows.length ? html`<form method="post" action="/sales-queue/${which}"${which === 'print' ? html` target="_blank"` : ''}>${csrfField(csrf)}
    <div class="table-scroll"><table class="grid">
      <thead><tr><th class="select"><input type="checkbox" data-select-all="ids" aria-label="Select all" checked></th><th>Date</th><th>Transaction</th><th>Customer</th>${which === 'send' ? html`<th>Email</th>` : ''}<th class="num">Total</th></tr></thead>
      <tbody>${rows.map(r => html`<tr><td class="select"><input type="checkbox" name="ids" value="${r.txn_id}" checked aria-label="Select ${label(r)}"></td>
        <td>${formatShortDate(r.txn_date)}</td><td><a href="/txns/${r.txn_id}">${label(r)}</a></td><td>${r.customer}</td>
        ${which === 'send' ? html`<td>${r.email ?? html`<span class="warn">none</span>`}</td>` : ''}<td class="num">${formatCents(r.total_cents)}</td></tr>`)}</tbody>
    </table></div>
    <div class="form-actions"><button class="primary">${which === 'send' ? 'Send selected' : 'Print selected (one PDF)'}</button></div>
  </form>` : html`<p class="muted">Nothing waiting to ${which}. Tick “${which === 'send' ? 'Send' : 'Print'} later” on a form to add it here.</p>`}
  <p class="muted small">${which === 'print' ? 'Printing takes them off this list.' : 'Sending takes them off this list; any that fail stay.'} <a href="/sales-queue?which=${other}">${other === 'send' ? 'Send later' : 'Print later'} list</a></p>` });
}
