import { saveBar } from './save-bar.js';
import { formatMoney } from '../domain/fx.js';
import { reconciledOverride } from './ledger-tools.js';
import { dimensionFields, lineClasses, lineClassSelect } from './dims.js';
import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, checkbox } from './forms.js';
import { formatAddress } from './format.js';
import { formatCents, centsToInput } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';

const BLANK_ROWS = 3;
export const PAYMENT_METHODS = ['Check', 'Cash', 'ACH', 'Credit card', 'Wire', 'Other'];

function customerPicker(customers, value, { locked }) {
  if (locked) {
    const c = customers.find(x => String(x.customer_id) === String(value));
    return html`<div class="field"><span>Customer</span><strong>${c?.display_name ?? ''}</strong><input type="hidden" name="customer_id" value="${value}"></div>`;
  }
  return selectField('Customer', 'customer_id', customers.filter(c => c.active || String(c.customer_id) === String(value))
    .map(c => [c.customer_id, c.display_name, `data-currency="${attr(c.currency)}" data-cc="${attr(c.cc)}" data-bcc="${attr(c.bcc)}" data-bill="${attr(partyAddress(c, c.billing_address))}" data-ship="${attr(partyAddress(c, c.shipping_same_as_billing === false ? c.shipping_address : c.billing_address))}"`]), value,
    { blank: 'Choose a customer', attrs: 'required' });
}

// An attribute value written into raw option markup (selectField's extra): escaped here.
const attr = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, '&#10;');
// "Name\nStreet\nCity, ST 12345" — what Bill to / Ship to start as.
export const partyAddress = (c, address) => [c.display_name, formatAddress(address)].filter(Boolean).join('\n');

// Stage F4: QBO's other sales form fields, in one section (open when anything in it is filled in).
function salesDetails(type, x = {}) {
  const any = Object.entries(x).some(([k, v]) => v && !['billTo', 'shipTo', 'cc', 'bcc'].includes(k));
  const box = (label, name, value, { rows = 3, hint = '' } = {}) => html`<label class="field"><span>${label}</span><textarea name="${name}" rows="${rows}" data-${name.replace('_', '-')}>${value ?? ''}</textarea>${hint ? html`<small class="muted">${hint}</small>` : ''}</label>`;
  return html`<details class="card sales-details"${any ? html` open` : ''}><summary><strong>Email, addresses and shipping</strong> <small class="muted">Cc/Bcc, Bill to, Ship to, P.O. number, notes</small></summary>
    <input type="hidden" name="extras" value="1">
    <div class="form-grid">
      ${field('Cc', 'email_cc', x.cc, { type: 'text', attrs: 'data-email-cc autocomplete="off"', hint: 'Copies of the email, separated by commas' })}
      ${field('Bcc', 'email_bcc', x.bcc, { type: 'text', attrs: 'data-email-bcc autocomplete="off"' })}
      ${box('Bill to', 'bill_to', x.billTo)}
      ${box('Ship to', 'ship_to', x.shipTo)}
      ${field('Ship via', 'ship_via', x.shipVia)}
      ${field('Shipping date', 'ship_date', x.shipDate, { type: 'date' })}
      ${field('Tracking no.', 'tracking_no', x.trackingNo)}
      ${field('P.O. number', 'po_number', x.poNumber, { hint: 'The customer’s purchase order' })}
      ${type === 'estimate' ? html`${field('Accepted by', 'accepted_by', x.acceptedBy, { hint: 'Marks the estimate accepted' })}${field('Accepted date', 'accepted_date', x.acceptedDate, { type: 'date' })}
        ${field('Deposit request (%)', 'deposit_request', x.depositRequest, { attrs: 'inputmode="decimal"', hint: 'Shown on the estimate as the deposit due' })}` : ''}
      ${box('Internal customer notes (hidden)', 'internal_note', x.internalNote, { rows: 2, hint: 'Never shown to the customer' })}
      ${box('Memo on statement (hidden)', 'statement_memo', x.statementMemo, { rows: 2, hint: 'Shown on statements instead of the memo' })}
    </div>
    <p>${checkbox('Print later', 'print_later', x.printLater)} ${checkbox('Send later', 'send_later', x.sendLater)}</p>
  </details>`;
}

export function withBlankRows(lines) {
  const rows = [...lines];
  while (rows.length < Math.max(BLANK_ROWS, lines.length + 1)) rows.push({ itemId: '', description: '', quantity: '', rate: '' });
  return rows;
}

// The editable line items table (shared by the transaction editor and recurring templates).
// serviceDate: show the Service date column (Settings → Sales). classes: per-line class choices (Settings → Accounting).
// Stage F3 (QBO's line tools): each row duplicates or deletes itself; Add subtotal / Add text lines; Clear all lines; paste rows
// copied from a spreadsheet; a new blank line appears when the last one is used. Every row carries the same inputs (kept in
// step by position), with line_kind saying what it is.
export function linesTable(items, rows, { serviceDate = false, classes = null, kinds = true } = {}) {
  const hidden = l => html`<input type="hidden" name="line_est" value="${l.estimateLine ?? ''}"><input type="hidden" name="line_bill" value="${l.billable ?? ''}"><input type="hidden" name="line_time" value="${l.timeEntry ?? ''}">${kinds ? html`<input type="hidden" name="line_kind" value="${l.kind ?? 'item'}" data-kind>` : ''}`;
  const tools = i => html`<td class="line-tools" data-label=""><button type="button" class="icon-button" data-dup-line aria-label="Duplicate line ${i + 1}" title="Duplicate">⧉</button><button type="button" class="icon-button" data-del-line aria-label="Delete line ${i + 1}" title="Delete">×</button></td>`;
  const row = (l, i) => {
    const kind = l.kind ?? 'item';
    if (kind !== 'item') {
      // Subtotal and text lines: a description only (the other inputs stay, empty, so positions line up).
      return html`<tr data-line class="${kind === 'subtotal' ? 'subtotal-line' : 'text-line'}">
      <td class="line-no" data-label="Line">${i + 1}</td>
      ${serviceDate ? html`<td><input type="hidden" name="line_service" value=""></td>` : ''}
      <td><input type="hidden" name="line_item" value=""></td>
      <td colspan="3"><input name="line_desc" value="${l.description ?? (kind === 'subtotal' ? 'Subtotal' : '')}" aria-label="${kind === 'subtotal' ? 'Subtotal label' : 'Text'}, line ${i + 1}" data-desc>${hidden(l)}<input type="hidden" name="line_qty" value=""><input type="hidden" name="line_rate" value=""></td>
      <td class="num" ${kind === 'subtotal' ? html`data-subtotal-amount` : ''}></td>
      ${classes ? html`<td><input type="hidden" name="line_class" value=""></td>` : ''}
      ${kinds ? tools(i) : ''}
    </tr>`;
    }
    return html`<tr data-line>
      <td class="line-no" data-label="Line">${i + 1}</td>
      ${serviceDate ? html`<td data-label="Service date"><input type="date" name="line_service" value="${l.serviceDate ?? ''}" aria-label="Service date, line ${i + 1}"></td>` : ''}
      <td><select name="line_item" aria-label="Product or service, line ${i + 1}" data-item>
        <option value="">—</option>
        ${items.map(it => html`<option value="${it.item_id}"${String(it.item_id) === String(l.itemId) ? html` selected` : ''} data-rate="${centsToInput(it.rate_cents)}">${it.name}</option>`)}
      </select></td>
      <td><input name="line_desc" value="${l.description}" aria-label="Description, line ${i + 1}" data-desc>${hidden(l)}</td>
      <td class="num"><input name="line_qty" value="${l.quantity}" inputmode="decimal" size="6" aria-label="Quantity, line ${i + 1}" data-qty></td>
      <td class="num"><input name="line_rate" value="${l.rate}" inputmode="decimal" size="9" aria-label="Rate, line ${i + 1}" data-rate-input><small class="rule-note muted" data-rule-note></small></td>
      <td class="num" data-amount></td>
      ${classes ? html`<td data-label="Class">${lineClassSelect('line_class', classes, l.classId)}</td>` : ''}
      ${kinds ? tools(i) : ''}
    </tr>`;
  };
  return html`<table class="grid lines" data-lines>
    <thead><tr><th>#</th>${serviceDate ? html`<th>Service date</th>` : ''}<th>Product/service</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th>${classes ? html`<th>Class</th>` : ''}${kinds ? html`<th><span class="visually-hidden">Line tools</span></th>` : ''}</tr></thead>
    <tbody>${rows.map(row)}</tbody>
  </table>
  ${kinds ? html`<template data-row="item">${row({ kind: 'item', itemId: '', description: '', quantity: '', rate: '' }, 0)}</template>
  <template data-row="subtotal">${row({ kind: 'subtotal', description: 'Subtotal' }, 0)}</template>
  <template data-row="text">${row({ kind: 'text', description: '' }, 0)}</template>` : ''}
  <p class="line-actions"><button type="button" class="link" data-add-line>+ Add line</button>${kinds ? html` · <button type="button" class="link" data-add-kind="subtotal">Add subtotal</button>
    · <button type="button" class="link" data-add-kind="text">Add text</button> · <button type="button" class="link" data-clear-lines>Clear all lines</button>` : ''}</p>
  ${kinds ? html`<details class="paste-lines"><summary class="link">Paste lines from a spreadsheet</summary>
    <label class="field wide"><span>Copy rows from Excel or Google Sheets — product or service, description, quantity, rate — and paste them here.</span>
      <textarea name="paste_lines" rows="4" data-paste-lines placeholder="Timothy Hay	Small square bales	20	12.50"></textarea></label>
    <button type="button" class="button" data-paste-apply>Add these lines</button></details>` : ''}`;
}

// Invoice, sales receipt, credit memo. `v` holds raw form values (strings) so a failed post re-renders exactly what was typed.
// sales: Settings → Sales ({ serviceDate, discount, shipping, deposit, customNumbers, defaultDelivery }).
export function salesDocForm({ entityName, csrf, type, txnId = null, save = {}, customers, items, terms, projects = [], depositAccounts = [], v, error = null, sales = {}, priceRules = [],
  dims = null, unbilled = 0, override = false, fx = null, reloadOnCustomer = false }) {
  const noun = TYPE_LABELS[type];
  const extras = type !== 'credit_memo';
  const showDeposit = (type === 'invoice' || type === 'estimate') && (sales.deposit || Boolean(v.depositAmount));
  const allowExtras = extras && type !== 'estimate';
  const action = txnId ? `/txns/${txnId}` : '/txns';
  const rows = withBlankRows(v.lines);
  return layout({
    title: txnId ? `Edit ${noun}` : `New ${noun.toLowerCase()}`, entityName, csrf,
    body: html`<div class="crumbs"><a href="${v.customerId ? `/customers/${v.customerId}` : '/customers'}">‹ Back</a></div>
<form method="post" action="${action}" class="card editor" data-editor${priceRules.length ? html` data-price-rules="${JSON.stringify(priceRules)}"` : ''}${fx ? html` data-currency="${fx.code}" data-exchange-rate="${v.exchangeRate || fx.rate || ''}"` : ''}${reloadOnCustomer && !txnId ? html` data-reload-customer="/txns/new?type=${type}"` : ''}>
  ${csrfField(csrf)}
  <input type="hidden" name="type" value="${type}">
  <div class="card-head"><h1>${txnId ? `Edit ${noun.toLowerCase()} ${v.docNumber}` : `New ${noun.toLowerCase()}`}</h1>
    <p class="big-total">Total <strong data-total>$0.00</strong></p></div>
  ${errorBanner(error)}
  <div class="form-grid">
    ${customerPicker(customers, v.customerId, { locked: Boolean(txnId) || Boolean(v.estimateId) })}
    ${field(`${noun} date`, 'txn_date', v.txnDate, { type: 'date', required: true, attrs: 'data-txn-date' })}
    ${fx ? html`<div class="field fx-field"><span>Currency</span><strong>${fx.code}</strong><small class="muted">Amounts below are in ${fx.code}.</small></div>
      ${field(`Exchange rate (USD per 1 ${fx.code})`, 'exchange_rate', v.exchangeRate ?? '', { attrs: `inputmode="decimal" placeholder="${fx.rate ?? ''}"`,
        hint: fx.rate ? `Leave blank for the rate on the date (${fx.rate}).` : 'No rate on file for this date: enter one.' })}` : ''}
    ${type === 'estimate' ? field('Expiration date', 'due_date', v.dueDate, { type: 'date' }) : ''}
    ${v.estimateId ? html`<input type="hidden" name="estimate_id" value="${v.estimateId}"><div class="field"><span>From estimate</span><strong><a href="/txns/${v.estimateId}">${v.estimateNumber ?? 'Estimate'}</a></strong></div>` : ''}
    ${type === 'invoice' ? html`
      ${selectField('Terms', 'terms_id', terms.map(t => [t.terms_id, t.name, `data-days="${t.due_days}"`]), v.termsId, { blank: 'Customer default', attrs: 'data-terms' })}
      ${field('Due date', 'due_date', v.dueDate, { type: 'date', attrs: 'data-due-date', hint: 'Leave blank to use the terms' })}` : ''}
    ${type === 'sales_receipt' ? html`
      ${selectField('Payment method', 'payment_method', PAYMENT_METHODS.map(m => [m, m]), v.paymentMethod, { blank: '—' })}
      ${field('Reference no.', 'payment_ref', v.paymentRef)}
      ${selectField('Deposit to', 'deposit_to', depositAccounts.map(a => [a.account_id, a.name]), v.depositToId)}` : ''}
    ${txnId || sales.customNumbers !== false ? field(`${noun} no.`, 'doc_number', v.docNumber, { hint: txnId ? '' : 'Leave blank for the next number' }) : ''}
    ${projects.length ? selectField('Project', 'project_id', projects.map(pr => [pr.project_id, pr.name]), v.projectId, { blank: 'None' }) : ''}
  </div>
  ${dimensionFields(dims, v)}
  ${type === 'invoice' && unbilled && !rows.some(l => l.billable || l.timeEntry) ? html`<p class="ledger-check warn">This customer has ${unbilled} unbilled item${unbilled === 1 ? '' : 's'} (billable time or expenses).
    <a href="/txns/new?type=invoice&customer=${v.customerId}&billable=1">Add them to this invoice</a></p>` : ''}
  ${salesDetails(type, v.extras ?? {})}
  ${linesTable(items, rows, { serviceDate: sales.serviceDate || rows.some(l => l.serviceDate), classes: lineClasses(dims) ? dims.classes : null })}
  ${showDeposit || (allowExtras && (sales.discount || sales.shipping || v.discountValue || v.shipping)) ? html`<div class="doc-totals">
    <p><span>Subtotal</span> <strong data-subtotal>$0.00</strong></p>
    ${allowExtras && (sales.discount || v.discountValue) ? html`<div class="total-row"><label class="field"><span>Discount</span>
      <span class="inline-fields"><select name="discount_kind" data-discount-kind aria-label="Discount type">
        <option value="percent"${v.discountKind !== 'amount' ? html` selected` : ''}>Percent</option>
        <option value="amount"${v.discountKind === 'amount' ? html` selected` : ''}>Amount</option></select>
      <input name="discount_value" value="${v.discountValue ?? ''}" inputmode="decimal" size="8" aria-label="Discount" data-discount-value></span></label></div>` : ''}
    ${allowExtras && (sales.shipping || v.shipping) ? html`<div class="total-row">${field('Shipping', 'shipping', v.shipping, { attrs: 'inputmode="decimal" size="8" data-shipping' })}</div>` : ''}
    <p><span>Total</span> <strong data-total>$0.00</strong></p>
    ${showDeposit ? html`<div class="total-row">${field('Deposit received', 'deposit_amount', v.depositAmount, { attrs: 'inputmode="decimal" size="8" data-deposit',
      hint: type === 'estimate' ? 'Recorded as a payment held for this job and applied to the first invoice made from it.' : 'Recorded as a payment into Undeposited Funds and applied.' })}
      ${selectField('Deposit method', 'deposit_method', PAYMENT_METHODS.map(m => [m, m]), v.depositMethod, { blank: '—' })}</div>
      <p><span>Balance due</span> <strong data-balance-due>$0.00</strong></p>` : ''}
  </div>` : ''}
  ${field(sales.showMessageLabel ? 'Message on the form' : 'Memo', 'memo', v.memo, { cls: 'wide' })}
  ${reconciledOverride(override)}
  ${saveBar({ type, ...save, cancelHref: v.customerId ? `/customers/${v.customerId}` : '/customers' })}
</form>`,
  });
}

// Receive payment (new or edit). `charges` from listOpenCharges; `v.apply` maps charge txn_id -> typed amount.
export function paymentForm({ entityName, csrf, txnId = null, save = {}, customers, charges, v, error = null, override = false, fx = null, reloadOnCustomer = false, depositAccounts = [] }) {
  const amount = c => formatMoney(c, fx?.code ?? null);
  const action = txnId ? `/txns/${txnId}` : '/txns';
  return layout({
    title: txnId ? 'Edit payment' : 'Receive payment', entityName, csrf,
    body: html`<div class="crumbs"><a href="${v.customerId ? `/customers/${v.customerId}` : '/customers'}">‹ Back</a></div>
<form method="post" action="${action}" class="card editor" data-payment${fx ? html` data-currency="${fx.code}"` : ''}${reloadOnCustomer && !txnId ? html` data-reload-customer="/txns/new?type=payment"` : ''}>
  ${csrfField(csrf)}
  <input type="hidden" name="type" value="payment">
  <div class="card-head"><h1>${txnId ? 'Edit payment' : 'Receive payment'}</h1>
    <p class="big-total">Unapplied <strong data-unapplied>$0.00</strong></p></div>
  ${errorBanner(error)}
  <div class="form-grid">
    ${customerPicker(customers, v.customerId, { locked: Boolean(txnId) || Boolean(v.customerId && charges) })}
    ${field('Payment date', 'txn_date', v.txnDate, { type: 'date', required: true })}
    ${selectField('Payment method', 'payment_method', PAYMENT_METHODS.map(m => [m, m]), v.paymentMethod, { blank: '—' })}
    ${field('Reference no.', 'payment_ref', v.paymentRef, { hint: 'Check number, ACH trace, …' })}
    ${depositAccounts.length ? selectField('Deposit to', 'deposit_to', depositAccounts.map(a => [a.account_id, a.name]), v.depositToId || String(depositAccounts[0].account_id)) : ''}
    ${field(fx ? `Amount received (${fx.code})` : 'Amount received', 'amount', v.amount, { required: true, attrs: 'inputmode="decimal" data-amount-received' })}
    ${fx ? html`<div class="field fx-field"><span>Currency</span><strong>${fx.code}</strong><small class="muted">Amounts below are in ${fx.code}.</small></div>
      ${field(`Exchange rate (USD per 1 ${fx.code})`, 'exchange_rate', v.exchangeRate ?? '', { attrs: `inputmode="decimal" placeholder="${fx.rate ?? ''}"`,
        hint: fx.rate ? `Leave blank for the rate on the date (${fx.rate}).` : 'No rate on file for this date: enter one.' })}` : ''}
  </div>
  ${charges ? html`<h2>Outstanding transactions</h2>
  ${charges.length ? html`<table class="grid">
    <thead><tr><th>Description</th><th>Due date</th><th class="num">Original amount</th><th class="num">Open balance</th><th class="num">Payment</th></tr></thead>
    <tbody>${charges.map(c => html`<tr>
      <td><a href="/txns/${c.txn_id}">${TYPE_LABELS[c.type]} ${c.doc_number ?? ''}</a> <span class="muted">(${formatShortDate(c.txn_date)})</span></td>
      <td>${formatShortDate(c.due_date)}</td>
      <td class="num">${amount(c.total_cents)}</td>
      <td class="num">${amount(c.open_cents)}</td>
      <td class="num"><input name="apply_${c.txn_id}" value="${v.apply[c.txn_id] ?? ''}" inputmode="decimal" size="10" data-open="${centsToInput(c.open_cents)}" aria-label="Payment for ${TYPE_LABELS[c.type]} ${c.doc_number ?? ''}"></td>
    </tr>`)}</tbody>
  </table>
  <p><button type="button" class="link" data-auto-apply>Apply oldest first</button> · <button type="button" class="link" data-clear-apply>Clear</button></p>`
    : html`<p class="muted">No open invoices. The whole payment will stay unapplied as a credit.</p>`}` : html`<p class="muted">Choose a customer to see their open invoices.</p>`}
  ${field('Memo', 'memo', v.memo, { cls: 'wide' })}
  ${reconciledOverride(override)}
  ${saveBar({ type: 'payment', ...save, cancelHref: v.customerId ? `/customers/${v.customerId}` : '/customers' })}
</form>`,
  });
}

// Apply an existing payment/credit memo's open amount (shown on its transaction page).
export function applyCreditForm({ csrf, credit, charges, error = null }) {
  if (credit.voided_at || credit.open_cents <= 0) return '';
  return html`<form method="post" action="/txns/${credit.txn_id}/apply" class="apply-credit" data-payment>
  ${csrfField(csrf)}
  <h2>Apply ${formatCents(credit.open_cents)} unapplied</h2>
  <input type="hidden" value="${centsToInput(credit.open_cents)}" data-amount-received>
  ${errorBanner(error)}
  ${charges.length ? html`<table class="grid">
    <thead><tr><th>Transaction</th><th>Due date</th><th class="num">Open balance</th><th class="num">Apply</th></tr></thead>
    <tbody>${charges.map(c => html`<tr>
      <td><a href="/txns/${c.txn_id}">${TYPE_LABELS[c.type]} ${c.doc_number ?? ''}</a></td>
      <td>${formatShortDate(c.due_date)}</td>
      <td class="num">${formatCents(c.open_cents)}</td>
      <td class="num"><input name="apply_${c.txn_id}" inputmode="decimal" size="10" data-open="${centsToInput(c.open_cents)}" aria-label="Apply to ${c.doc_number ?? ''}"></td>
    </tr>`)}</tbody>
  </table>
  <p><button type="button" class="link" data-auto-apply>Apply oldest first</button> <button class="primary">Apply</button></p>`
    : html`<p class="muted">This customer has no open invoices to apply it to.</p>`}
</form>`;
}
