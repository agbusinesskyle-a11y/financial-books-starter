import { moreMenu, commonMore, importedBanner, rebuiltNote } from './txn-extras.js';
import { txnHref } from '../data/txn-extras.js';
import { saveBar } from './save-bar.js';
import { formatMoney } from '../domain/fx.js';
import { reconciledOverride } from './ledger-tools.js';
import { dimensionFields, lineClasses, lineClassSelect } from './dims.js';
import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, postButton } from './forms.js';
import { formatCents, centsToInput } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { formatQuantity } from '../domain/lines.js';
import { txnStatus, TYPE_LABELS } from '../domain/status.js';
import { PAYMENT_METHODS } from '../domain/checks.js';
import { VENDOR_TXN_FILTERS, VENDOR_DATE_FILTERS } from '../data/payables-read.js';
import { accountLabel } from './accounts.js';
import { txnDocuments } from './documents.js';
import { formatAddress } from './format.js';

// ---- vendor list / vendor page pieces ----

export const NEW_VENDOR_TXNS = [['bill', 'Bill'], ['expense', 'Expense'], ['check', 'Check'], ['vendor_credit', 'Vendor credit']];
export const EXTRA_VENDOR_TXNS = [['purchase_order', 'Purchase order'], ['item_receipt', 'Item receipt']];

const newHref = (type, vendorId) => `/vtxns/new?type=${type}${vendorId ? `&vendor=${vendorId}` : ''}`;

export function vendorTxnMenuItems(v) {
  return [...[...NEW_VENDOR_TXNS, ...EXTRA_VENDOR_TXNS].map(([type, l]) => [newHref(type, v.vendor_id), l]), [`/pay-bills?vendor=${v.vendor_id}`, 'Pay bills']];
}

export function vendorRowAction(v, csrf) {
  const primary = v.open_cents > 0 ? html`<a href="/pay-bills?vendor=${v.vendor_id}">Pay balance</a>` : html`<a href="${newHref('bill', v.vendor_id)}">Create bill</a>`;
  return html`${primary}<details class="menu row-menu"><summary aria-label="More actions for ${v.display_name}"></summary><div class="menu-items">
    <a href="/pay-bills?vendor=${v.vendor_id}">Make payment</a>
    <a href="${newHref('bill', v.vendor_id)}">Create bill</a>
    <a href="${newHref('expense', v.vendor_id)}">Create expense</a>
    <a href="${newHref('check', v.vendor_id)}">Write check</a>
    ${EXTRA_VENDOR_TXNS.map(([type, l]) => html`<a href="${newHref(type, v.vendor_id)}">Create ${l.toLowerCase()}</a>`)}
    ${postButton({ action: `/vendors/${v.vendor_id}/${v.active ? 'inactive' : 'active'}`, csrf, label: v.active ? 'Make inactive' : 'Make active' })}
    ${postButton({ action: `/vendors/${v.vendor_id}/ask`, csrf, label: 'Ask vendor for info' })}
  </div></details>`;
}

const ref = t => t.doc_number ?? '';
export const vtxnHref = t => `/vtxns/${t.txn_id}`;

// The Action cell for one vendor transaction row.
function rowActions(t, csrf) {
  if (t.voided_at) return html`<a href="${vtxnHref(t)}">View</a>`;
  if (t.type === 'bill') {
    if (t.approval_status === 'awaiting') return postButton({ action: `/vtxns/${t.txn_id}/approve`, csrf, label: 'Approve' });
    if (t.open_cents > 0 && t.approval_status === 'approved') {
      return t.scheduled_pay_date ? html`<a href="${vtxnHref(t)}">View</a>${menu(t, csrf, true)}`
        : html`<a href="${vtxnHref(t)}#schedule">Schedule payment</a>${menu(t, csrf, true)}`;
    }
  }
  if ((t.type === 'check' || (t.type === 'bill_payment' && t.payment_method === 'Check')) && !t.printed_at && t.total_cents > 0) {
    return html`<a href="/vtxns/${t.txn_id}/check.pdf" target="_blank">Print check</a>${menu(t, csrf)}`;
  }
  return html`<a href="${vtxnHref(t)}">${t.source === 'qbo_import' ? 'View' : 'View/Edit'}</a>${menu(t, csrf)}`;
}

function menu(t, csrf, payable = false) {
  return html`<details class="menu row-menu"><summary aria-label="More actions"></summary><div class="menu-items">
    <a href="${vtxnHref(t)}">${t.source === 'qbo_import' ? 'View' : 'View/Edit'}</a>
    ${payable ? html`<a href="/pay-bills?bills=${t.txn_id}">Pay now</a><a href="${vtxnHref(t)}#mark-paid">Mark as paid</a>` : ''}
    ${['bill', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt', 'cc_credit'].includes(t.type) && !t.system_kind ? html`<a href="/vtxns/new?copy=${t.txn_id}">Copy</a>` : ''}
    ${(t.type === 'bill_payment' || t.type === 'check') && t.source !== 'qbo_import' ? postButton({ action: `/vtxns/${t.txn_id}/void`, csrf, label: 'Void', confirm: 'Void this payment? The bills it paid open again.' }) : ''}
    ${t.source === 'qbo_import' ? '' : postButton({ action: `/vtxns/${t.txn_id}/delete`, csrf, label: 'Delete', confirm: `Delete ${TYPE_LABELS[t.type]} ${ref(t)}? This can’t be undone.` })}
  </div></details>`;
}

export function vendorTransactionsTab({ vendor: v, vtxns, vfilters: f, today, csrf }) {
  if (!vtxns) return '';
  const q = n => new URLSearchParams({ tab: 'transactions', type: f.type, date: f.date, ...(f.tag ? { tag: String(f.tag) } : {}), page: String(n) }).toString();
  const pages = Math.max(1, Math.ceil(vtxns.total / vtxns.pageSize));
  return html`<form method="get" action="/vendors/${v.vendor_id}" class="filters">
  <input type="hidden" name="tab" value="transactions">
  <label>Type<select name="type" data-autosubmit>${VENDOR_TXN_FILTERS.map(([k, l]) => html`<option value="${k}"${k === f.type ? html` selected` : ''}>${l}</option>`)}</select></label>
  <label>Dates<select name="date" data-autosubmit>${VENDOR_DATE_FILTERS.map(([k, l]) => html`<option value="${k}"${k === f.date ? html` selected` : ''}>${l}</option>`)}</select></label>
  ${vtxns.tags?.length ? html`<label>Tag<select name="tag" data-autosubmit><option value="">Any tag</option>${vtxns.tags.map(t => html`<option value="${t.tag_id}"${t.tag_id === f.tag ? html` selected` : ''}>${t.full_name}</option>`)}</select></label>` : ''}
  <noscript><button>Apply</button></noscript>
  <div class="toolbar"><button type="button" class="link" data-print>Print</button></div>
</form>
<form method="post" action="/vtxns/batch" id="vbatch">
  ${csrfField(csrf)}<input type="hidden" name="back" value="/vendors/${v.vendor_id}?${q(f.page)}">
  <div class="batch-bar"><span data-selected-count class="muted">Select transactions for batch actions</span>
    <button name="action" value="pay">Pay selected bills</button>
    <button name="action" value="approve">Approve</button>
    <button name="action" value="delete" data-confirm="Delete the selected transactions? This can’t be undone.">Delete</button>
  </div>
</form>
${vtxns.rows.length ? html`<table class="grid">
  <thead><tr><th class="select"><input type="checkbox" data-select-all="ids" aria-label="Select all"></th><th>Date</th><th>Type</th><th>No.</th><th>Category</th>
    <th class="num">Total</th><th>Status</th><th class="actions">Action</th></tr></thead>
  <tbody>${vtxns.rows.map(t => { const s = txnStatus(t, today); return html`<tr>
    <td class="select"><input type="checkbox" name="ids" value="${t.txn_id}" form="vbatch" aria-label="Select ${TYPE_LABELS[t.type]} ${ref(t)}"></td>
    <td>${formatShortDate(t.txn_date)}</td>
    <td>${TYPE_LABELS[t.type]}${t.system_kind === 'opening_balance' ? html` <span class="tag">Opening balance</span>` : ''}</td>
    <td><a href="${vtxnHref(t)}">${ref(t) || 'View'}</a></td>
    <td>${t.category ?? ''}</td>
    <td class="num">${formatCents(['bill_payment', 'expense', 'check'].includes(t.type) ? -t.total_cents : t.total_cents)}</td>
    <td><span class="status ${s.tone}">${s.text}</span></td>
    <td class="actions">${rowActions(t, csrf)}</td></tr>`; })}</tbody>
</table>
<div class="pager">${vtxns.total} transaction${vtxns.total === 1 ? '' : 's'}
  ${f.page > 1 ? html`<a href="/vendors/${v.vendor_id}?${q(f.page - 1)}">‹ Previous</a>` : ''}
  ${f.page < pages ? html`<a href="/vendors/${v.vendor_id}?${q(f.page + 1)}">Next ›</a>` : ''}</div>`
  : html`<p class="muted">No transactions with ${v.display_name} for these filters.</p>`}`;
}

export function vendorRecurringTab(p) {
  return p.recurringTab ? p.recurringTab(p) : html`<p class="muted">No recurring transactions for ${p.vendor.display_name}.</p>`;
}

// ---- the editor (bill, expense, check, vendor credit, credit card credit) ----

// The category and product line tables, shared by the vendor editor and recurring templates.
// dims (optional): dimensionChoices() — adds Billable and per-line Class columns when Settings → Accounting turns them on.
export function vendorLineTables({ categories, items, jobs, v, dims = null }) {
  const billable = Boolean(dims?.settings.billableOn), lineClass = lineClasses(dims);
  const extraHeads = html`${billable ? html`<th>Billable</th>` : ''}${lineClass ? html`<th>Class</th>` : ''}`;
  const extraCells = (prefix, l) => html`${billable ? html`<td data-label="Billable"><select name="${prefix}_billable" aria-label="Billable"><option value="">No</option><option value="1"${l.billable ? html` selected` : ''}>Yes</option></select></td>` : ''}
      ${lineClass ? html`<td data-label="Class">${lineClassSelect(`${prefix}_class`, dims.classes, l.classId)}</td>` : ''}`;
  const cats = [...v.categoryLines]; while (cats.length < CAT_ROWS) cats.push({ accountId: '', description: '', amount: '', customerId: '', projectId: '', po: '' });
  const its = [...v.itemLines]; while (its.length < ITEM_ROWS) its.push({ itemId: '', description: '', quantity: '', rate: '', customerId: '', projectId: '', po: '' });
  return html`<h2>Category details</h2>
  <table class="grid lines" data-rows="cat">
    <thead><tr><th>Category</th><th>Description</th><th class="num">Amount</th><th>Customer / project</th>${extraHeads}</tr></thead>
    <tbody>${cats.map(l => html`<tr>
      <td><select name="cat_account" aria-label="Category"><option value="">—</option>${categories.map(a => html`<option value="${a.account_id}"${String(a.account_id) === String(l.accountId) ? html` selected` : ''}>${accountLabel(a)}</option>`)}</select></td>
      <td><input name="cat_desc" value="${l.description}" aria-label="Description"></td>
      <td class="num"><input name="cat_amount" value="${l.amount}" inputmode="decimal" size="10" aria-label="Amount" data-vamount></td>
      <td>${jobSelect('cat_job', jobs, jobValue(l))}<input type="hidden" name="cat_po" value="${l.po ?? ''}"></td>${extraCells('cat', l)}</tr>`)}</tbody>
  </table>
  <p><button type="button" class="link" data-add-row="cat">+ Add a category line</button></p>
  <details class="item-lines"${v.itemLines.length ? html` open` : ''}><summary><h2>Item details</h2></summary>
  <table class="grid lines" data-rows="item">
    <thead><tr><th>Product / service</th><th>Description</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Amount</th><th>Customer / project</th>${extraHeads}</tr></thead>
    <tbody>${its.map(l => html`<tr>
      <td><select name="item_item" aria-label="Product or service"><option value="">—</option>${items.map(i => html`<option value="${i.item_id}" data-cost="${i.purchase_cost_cents ?? ''}"${String(i.item_id) === String(l.itemId) ? html` selected` : ''}>${i.name}</option>`)}</select></td>
      <td><input name="item_desc" value="${l.description}" aria-label="Description"></td>
      <td class="num"><input name="item_qty" value="${l.quantity}" inputmode="decimal" size="6" aria-label="Quantity" data-vqty></td>
      <td class="num"><input name="item_rate" value="${l.rate}" inputmode="decimal" size="8" aria-label="Cost" data-vrate></td>
      <td class="num" data-vline>—</td>
      <td>${jobSelect('item_job', jobs, jobValue(l))}<input type="hidden" name="item_po" value="${l.po ?? ''}"></td>${extraCells('item', l)}</tr>`)}</tbody>
  </table>
  <p><button type="button" class="link" data-add-row="item">+ Add a product line</button></p>
  </details>`;
}


const CAT_ROWS = 3, ITEM_ROWS = 2;
const jobValue = l => (l.projectId ? `p:${l.projectId}` : l.customerId ? `c:${l.customerId}` : '');

function jobSelect(name, jobs, value) {
  return html`<select name="${name}" aria-label="Customer or project"><option value="">—</option>
    ${jobs.map(j => html`<option value="${j.value}"${j.value === value ? html` selected` : ''}>${j.label}</option>`)}</select>`;
}

export function vendorDocForm({ entityName, csrf, type, txnId = null, save = {}, vendors, categories, payFrom, items, jobs, terms, v, error = null, nextCheck = '', dims = null, duplicate = false,
  override = false, fx = null, reloadOnVendor = false }) {
  const noun = TYPE_LABELS[type];
  const dateLabel = { vendor_credit: 'Credit date', bill: 'Bill date', purchase_order: 'Purchase order date', item_receipt: 'Receipt date', cc_credit: 'Credit date' }[type] ?? 'Payment date';
  const noLabel = { check: 'Check no.', bill: 'Bill no.', purchase_order: 'P.O. no.' }[type] ?? 'Ref no.';
  // Paid from (or, for a card credit, refunded to) one account; the vendor is optional.
  const paid = ['expense', 'check', 'cc_credit'].includes(type);
  const back = v.vendorId ? `/vendors/${v.vendorId}` : '/vendors';
  return layout({
    title: txnId ? `Edit ${noun.toLowerCase()}` : `New ${noun.toLowerCase()}`, entityName, csrf, wide: true,
    body: html`<div class="crumbs"><a href="${back}">‹ Back</a></div>
${!txnId && !v.uploadId && ['bill', 'expense', 'check'].includes(type) ? html`<form method="post" action="/vtxns/read" enctype="multipart/form-data" class="card upload-bill" data-upload-bill>
  ${csrfField(csrf)}<input type="hidden" name="type" value="${type}">
  <label class="field"><span>Upload a ${type === 'bill' ? 'bill' : 'receipt'} to fill this in</span>
    <input type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/gif,image/webp" required data-upload-auto></label>
  <button class="button">Read it</button> <small class="muted">PDF or photo, up to 10 MB. It’s read by your AI provider (Settings → AI) and attached when you save.</small>
</form>` : ''}
<form method="post" action="${txnId ? `/vtxns/${txnId}` : '/vtxns'}" class="card editor" data-vendor-editor${fx ? html` data-currency="${fx.code}"` : ''}${reloadOnVendor && !txnId ? html` data-reload-vendor="/vtxns/new?type=${type}"` : ''}>
  ${csrfField(csrf)}<input type="hidden" name="type" value="${type}">${v.uploadId ? html`<input type="hidden" name="upload_id" value="${v.uploadId}">` : ''}
  <div class="card-head"><h1>${txnId ? `Edit ${noun.toLowerCase()} ${v.docNumber}` : `New ${noun.toLowerCase()}`}</h1>
    <p class="big-total">${type === 'bill' ? 'Balance due' : 'Total'} <strong data-vtotal>$0.00</strong></p></div>
  ${errorBanner(error)}
  ${v.uploadId ? html`<p class="ledger-check${v.uploadNote && / couldn’t be read /.test(v.uploadNote) ? ' warn' : ''}">${v.uploadNote ?? `${v.uploadName ?? 'The uploaded file'} will be attached when you save.`}
    <a href="/vtxns/uploads/${v.uploadId}" target="_blank" rel="noopener">View the file</a></p>` : ''}
  <div class="form-grid">
    ${selectField(paid ? 'Payee (vendor)' : 'Vendor', 'vendor_id', vendors.map(x => [x.vendor_id, x.display_name]), v.vendorId,
      { blank: paid ? '— none —' : 'Choose a vendor' })}
    ${paid ? selectField({ check: 'Bank account', cc_credit: 'Credit card account' }[type] ?? 'Payment account', 'account_id', payFrom.map(a => [a.account_id, accountLabel(a)]), v.accountId) : ''}
    ${field(dateLabel, 'txn_date', v.txnDate, { type: 'date', required: true })}
    ${fx ? html`<div class="field fx-field"><span>Currency</span><strong>${fx.code}</strong><small class="muted">Amounts below are in ${fx.code}.</small></div>
      ${field(`Exchange rate (USD per 1 ${fx.code})`, 'exchange_rate', v.exchangeRate ?? '', { attrs: `inputmode="decimal" placeholder="${fx.rate ?? ''}"`,
        hint: fx.rate ? `Leave blank for the rate on the date (${fx.rate}).` : 'No rate on file for this date: enter one.' })}` : ''}
    ${type === 'purchase_order' ? field('Expected date', 'due_date', v.dueDate, { type: 'date' }) : ''}
    ${type === 'bill' ? html`
      ${selectField('Terms', 'terms_id', terms.map(t => [t.terms_id, t.name]), v.termsId, { blank: 'Vendor default' })}
      ${field('Due date', 'due_date', v.dueDate, { type: 'date', hint: 'Leave blank to use the terms' })}` : ''}
    ${type === 'expense' ? selectField('Payment method', 'payment_method', PAYMENT_METHODS.filter(m => m !== 'Check').map(m => [m, m]), v.paymentMethod, { blank: '—' }) : ''}
    ${field(noLabel, 'doc_number', v.docNumber,
      { hint: type === 'check' ? `Leave blank for the next number${nextCheck ? ` (${nextCheck})` : ''}` : type === 'purchase_order' ? 'Leave blank for the next number' : '' })}
  </div>
  ${v.fromPo ? html`<input type="hidden" name="from_po_label" value="${v.fromPo}"><p class="ledger-check warn">Receiving purchase order ${v.fromPo}. Change quantities to what actually arrived; the rest stays open on the order.</p>` : ''}
  ${dimensionFields(dims, v)}
  ${vendorLineTables({ categories, items, jobs, v, dims })}
  <label class="field wide"><span>Memo</span><input name="memo" value="${v.memo}"></label>
  ${reconciledOverride(override)}
  ${saveBar({ type, ...save, cancelHref: back, extra: duplicate ? html`<button class="button" name="allow_duplicate" value="1">Save anyway</button>` : '' })}
</form>`,
  });
}

// ---- one vendor transaction ----

export function vendorTxnPage({ entityName, csrf, flash = null, txn: t, today, payFrom = [], documents = [], schedule = '', role = 'admin' }) {
  const force = t.reconciled && role === 'admin' ? { edit_reconciled: '1' } : {};
  const lock = t.reconciled ? ' It’s reconciled — this changes a finished reconciliation.' : '';
  const s = txnStatus(t, today);
  const title = `${TYPE_LABELS[t.type]}${t.doc_number ? ` ${t.doc_number}` : ''}`;
  const isCheck = t.type === 'check' || (t.type === 'bill_payment' && t.payment_method === 'Check');
  const received = t.lines.some(l => Number(l.received_qty) > 0 || l.received_cents > 0);
  const editable = !t.voided_at && ['bill', 'expense', 'check', 'vendor_credit', 'item_receipt', 'purchase_order', 'cc_credit'].includes(t.type) && !t.system_kind
    && !(t.type === 'purchase_order' && (received || t.closed_at));
  const isPo = t.type === 'purchase_order';
  // A foreign-currency bill or credit shows its own currency.
  const vmoney = c => formatMoney(c, t.currency ?? null);
  return layout({
    title, entityName, csrf, flash,
    body: html`<div class="crumbs">${t.vendor_id ? html`<a href="/vendors/${t.vendor_id}">‹ ${t.vendor_name}</a>` : html`<a href="/vendors">‹ Vendors</a>`}</div>
<section class="card">
  <div class="card-head"><h1>${title}</h1><span class="status ${s.tone}">${s.text}</span></div>
  ${importedBanner(t)}
  ${t.approval_status === 'rejected' ? html`<p class="error-banner">Rejected: ${t.rejected_reason}</p>` : ''}
  <dl class="details">
    ${t.vendor_name ? html`<div><dt>${['expense', 'check', 'cc_credit'].includes(t.type) ? 'Payee' : 'Vendor'}</dt><dd><a href="/vendors/${t.vendor_id}">${t.vendor_name}</a></dd></div>` : ''}
    <div><dt>Date</dt><dd>${formatShortDate(t.txn_date)}</dd></div>
    ${t.due_date ? html`<div><dt>${isPo ? 'Expected' : 'Due'}</dt><dd>${formatShortDate(t.due_date)}</dd></div>` : ''}
    ${t.account_name ? html`<div><dt>${t.type === 'bill_payment' ? 'Paid from' : 'Account'}</dt><dd>${t.account_name}</dd></div>` : ''}
    ${t.payment_method ? html`<div><dt>Method</dt><dd>${t.payment_method}</dd></div>` : ''}
    <div><dt>Total</dt><dd>${vmoney(t.currency ? t.foreign_total_cents : t.total_cents)}</dd>${t.currency ? html`</div><div><dt>Exchange rate</dt><dd>${Number(t.exchange_rate)} (${formatCents(t.total_cents)} in USD)</dd>` : ''}</div>
    ${t.type === 'bill' || t.type === 'vendor_credit' ? html`<div><dt>${t.type === 'bill' ? 'Balance due' : 'Unapplied'}</dt><dd>${vmoney(t.currency ? t.foreign_open_cents : t.open_cents)}</dd></div>` : ''}
    ${isPo ? html`<div><dt>Still to receive</dt><dd>${formatCents(t.open_cents)}</dd></div>` : ''}
    ${t.approved_by ? html`<div><dt>Approved</dt><dd>${t.approved_by}</dd></div>` : ''}
    ${t.memo ? html`<div><dt>Memo</dt><dd>${t.memo}</dd></div>` : ''}
  </dl>
  ${t.lines.length ? html`<table class="grid">
    <thead><tr><th>#</th><th>Category / product</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th>${isPo ? html`<th class="num">Received</th>` : ''}<th>Customer / project</th></tr></thead>
    <tbody>${t.lines.map(l => html`<tr><td>${l.line_no}</td><td>${l.account_name ?? l.item_name ?? ''}</td><td>${l.description ?? ''}</td>
      <td class="num">${l.item_id ? formatQuantity(BigInt(Math.round(Number(l.quantity) * 10000))) : ''}</td>
      <td class="num">${l.item_id ? vmoney(t.currency && l.foreign_rate_cents !== null ? l.foreign_rate_cents : l.rate_cents) : ''}</td><td class="num">${vmoney(t.currency && l.foreign_amount_cents !== null ? l.foreign_amount_cents : l.amount_cents)}</td>
      ${isPo ? html`<td class="num">${l.item_id ? formatQuantity(BigInt(Math.round(Number(l.received_qty) * 10000))) : formatCents(l.received_cents)}</td>` : ''}
      <td>${l.project_name ? html`<a href="/projects/${l.project_id}">${l.customer_name} › ${l.project_name}</a>` : l.customer_name ?? ''}</td></tr>`)}</tbody>
  </table>` : ''}
  ${t.applications.length ? html`<h2 class="section-title">${t.type === 'bill' ? 'Payments and credits' : 'Bills paid'}</h2>
  <table class="grid"><thead><tr><th>Date</th><th>Transaction</th><th class="num">Amount</th></tr></thead>
    <tbody>${t.applications.map(a => html`<tr><td>${formatShortDate(a.applied_on)}</td>
      <td><a href="${txnHref(a)}">${TYPE_LABELS[a.type]} ${a.doc_number ?? ''}</a>${rebuiltNote(a)}</td><td class="num">${vmoney(t.currency && a.foreign_cents !== null && a.foreign_cents !== undefined ? a.foreign_cents : a.amount_cents)}</td></tr>`)}</tbody></table>` : ''}
  ${t.vendor_id ? txnDocuments(documents, `/vendors/${t.vendor_id}`) : ''}
  <div class="txn-actions section-title">
    ${editable && t.source !== 'qbo_import' ? html`<a class="button" href="/vtxns/${t.txn_id}/edit">Edit</a>` : ''}
    ${t.type === 'bill_payment' && !t.voided_at && t.source !== 'qbo_import' ? html`<a class="button" href="/vtxns/${t.txn_id}/edit">Edit date / check no.</a>` : ''}
    ${t.type === 'bill' && t.approval_status === 'awaiting' && !t.voided_at ? postButton({ action: `/vtxns/${t.txn_id}/approve`, csrf, label: 'Approve', cls: 'primary' }) : ''}
    ${t.type === 'bill' && t.approval_status === 'approved' && t.open_cents > 0 && !t.voided_at ? html`<a class="button primary" href="/pay-bills?bills=${t.txn_id}">Pay bill</a>` : ''}
    ${isCheck && !t.voided_at && t.total_cents > 0 ? html`<a class="button" href="/vtxns/${t.txn_id}/check.pdf" target="_blank">${t.printed_at ? 'Reprint check' : 'Print check'}</a>
      ${t.printed_at ? '' : postButton({ action: `/vtxns/${t.txn_id}/printed`, csrf, label: 'Mark as printed', cls: '' })}` : ''}
    ${isPo && !t.voided_at && !t.closed_at && t.open_cents > 0 ? html`<a class="button primary" href="/vtxns/new?type=bill&from_po=${t.txn_id}">Create bill</a>
      <a class="button" href="/vtxns/new?type=item_receipt&from_po=${t.txn_id}">Receive items</a>` : ''}
    ${isPo ? html`<a class="button" href="/vtxns/${t.txn_id}/po.pdf" target="_blank">Print / PDF</a>
      ${t.vendor_email && !t.voided_at ? postButton({ action: `/vtxns/${t.txn_id}/email`, csrf, label: 'Email to vendor', cls: '' }) : ''}
      ${!t.voided_at && !t.closed_at ? postButton({ action: `/vtxns/${t.txn_id}/close`, csrf, label: 'Close purchase order', cls: '', confirm: 'Close this purchase order? Nothing more will be received on it.' }) : ''}
      ${t.closed_at ? postButton({ action: `/vtxns/${t.txn_id}/reopen`, csrf, label: 'Reopen', cls: '' }) : ''}` : ''}
    ${moreMenu({ csrf, items: [
      ['bill', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt', 'cc_credit'].includes(t.type) && !t.system_kind ? { label: 'Copy', href: `/vtxns/new?copy=${t.txn_id}` } : null,
      t.type === 'bill' && !t.system_kind ? { label: 'Copy to vendor credit', href: `/vtxns/new?copy=${t.txn_id}&as=vendor_credit` } : null,
      ['bill', 'expense', 'check'].includes(t.type) && t.vendor_id && !t.voided_at && !t.system_kind ? { label: 'Make recurring', href: `/vendors/${t.vendor_id}/recurring/new?from=${t.txn_id}` } : null,
      ...commonMore(t),
      !t.voided_at && !['bill', 'purchase_order'].includes(t.type) && t.source !== 'qbo_import' ? { label: 'Void', post: `/vtxns/${t.txn_id}/void`, danger: true, confirm: `Void ${title}? It stays on record at $0.00.${lock}`, extra: force } : null,
      t.source === 'qbo_import' ? null : { label: 'Delete', post: `/vtxns/${t.txn_id}/delete`, danger: true, confirm: `Delete ${title}? This can’t be undone.${lock}`, extra: force },
    ] })}
  </div>
  ${schedule}
  ${t.type === 'item_receipt' && !t.voided_at ? html`<details class="compose" open><summary class="button primary">Turn into a bill…</summary>
    <form method="post" action="/vtxns/${t.txn_id}/convert" class="editor">${csrfField(csrf)}
      <p class="muted">When the vendor’s bill for these goods arrives, record it here. The receipt becomes the bill; nothing is counted twice.</p>
      <div class="form-grid">${field('Bill date', 'txn_date', today, { type: 'date', required: true })}${field('Bill no.', 'doc_number', t.doc_number ?? '')}</div>
      <div class="form-actions"><button class="primary">Create bill</button></div></form></details>` : ''}
  ${t.type === 'bill' && t.approval_status === 'awaiting' && !t.voided_at ? html`<details class="compose"><summary class="button">Reject…</summary>
    <form method="post" action="/vtxns/${t.txn_id}/reject" class="editor">${csrfField(csrf)}
      ${field('Reason', 'reason', '', { required: true, cls: 'wide' })}<div class="form-actions"><button class="danger">Reject bill</button></div></form></details>` : ''}
  ${t.type === 'bill' && t.approval_status === 'approved' && t.open_cents > 0 && !t.voided_at ? html`<details class="compose" id="mark-paid"><summary class="button">Mark as paid…</summary>
    <form method="post" action="/vtxns/${t.txn_id}/mark-paid" class="editor">${csrfField(csrf)}
      <p class="muted">Records a payment of ${formatCents(t.open_cents)} today, without a check.</p>
      <div class="form-grid">${selectField('Paid from', 'account_id', payFrom.map(a => [a.account_id, accountLabel(a)]), '')}</div>
      <div class="form-actions"><button class="primary">Mark as paid</button></div></form></details>` : ''}
</section>`,
  });
}

export function billPaymentEditForm({ entityName, csrf, txn: t, v, error = null }) {
  return layout({
    title: 'Edit bill payment', entityName, csrf,
    body: html`<div class="crumbs"><a href="/vtxns/${t.txn_id}">‹ Back</a></div>
<form method="post" action="/vtxns/${t.txn_id}" class="card editor">${csrfField(csrf)}
  <h1>Edit bill payment to ${t.vendor_name}</h1>
  <p class="muted">${formatCents(t.total_cents)} from ${t.account_name}. To change amounts, void this payment and pay the bills again.</p>
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Payment date', 'txn_date', v.txnDate, { type: 'date', required: true })}
    ${t.payment_method === 'Check' ? field('Check no.', 'doc_number', v.docNumber, { required: true }) : ''}
    ${field('Memo', 'memo', v.memo, { cls: 'wide' })}
  </div>
  <div class="form-actions"><a href="/vtxns/${t.txn_id}">Cancel</a><button class="primary">Save</button></div>
</form>`,
  });
}

// ---- pay bills ----

// rates: { CODE: default rate } for the foreign currencies among the bills.
export function payBillsPage({ entityName, csrf, bills, vendors, payFrom, v, filterVendor = '', error = null, nextCheck = '', rates = {} }) {
  const totalOpen = bills.filter(b => !b.currency).reduce((s, b) => s + b.open_cents, 0);
  const foreign = Object.keys(rates);
  const selected = new Set(v.selected.map(String));
  return layout({
    title: 'Pay bills', entityName, csrf, wide: true,
    body: html`<div class="page-actions"><h1>Pay bills</h1><span class="spacer"></span><a href="/checks">Checks to print</a></div>
<form method="get" action="/pay-bills" class="filters">
  <label>Vendor<select name="vendor" data-autosubmit><option value="">All vendors</option>${vendors.map(x => html`<option value="${x.vendor_id}"${String(x.vendor_id) === String(filterVendor) ? html` selected` : ''}>${x.display_name}</option>`)}</select></label>
  <noscript><button>Show</button></noscript>
</form>
<form method="post" action="/pay-bills" class="card editor" data-pay-bills>
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <div class="form-grid">
    ${selectField('Pay from', 'account_id', payFrom.map(a => [a.account_id, accountLabel(a)]), v.accountId)}
    ${field('Payment date', 'txn_date', v.txnDate, { type: 'date', required: true })}
    ${selectField('Method', 'method', PAYMENT_METHODS.map(m => [m, m]), v.method, { attrs: 'data-method' })}
    ${field('Starting check no.', 'check_no', v.checkNo, { hint: `Leave blank for the next number${nextCheck ? ` (${nextCheck})` : ''}` })}
    ${field('Memo', 'memo', v.memo)}
    ${foreign.map(code => field(`Exchange rate (USD per 1 ${code})`, `rate_${code}`, v.rates?.[code] ?? String(rates[code] ?? ''), { attrs: 'inputmode="decimal"',
      hint: `Foreign bills are paid in ${code}; the bank is charged at this rate.` }))}
  </div>
  ${bills.length ? html`<p class="muted">${bills.length} approved bill${bills.length === 1 ? '' : 's'} open, ${formatCents(totalOpen)} in ${foreign.length ? 'USD bills' : 'all'}. Bills awaiting approval aren’t listed.</p>
  <table class="grid">
    <thead><tr><th class="select"><input type="checkbox" data-select-all="bill" aria-label="Select all bills"></th><th>Vendor</th><th>Bill</th><th>Due</th>
      <th class="num">Open</th><th class="num">Credit available</th><th class="num">Credit applied</th><th class="num">Payment</th></tr></thead>
    <tbody>${bills.map(b => html`<tr class="${b.due_date < v.txnDate ? 'overdue-row' : ''}">
      <td class="select"><input type="checkbox" name="bill" value="${b.txn_id}"${selected.has(String(b.txn_id)) ? html` checked` : ''} data-open="${b.open_cents}" aria-label="Pay ${b.vendor_name} ${b.doc_number ?? ''}"></td>
      <td><a href="/vendors/${b.vendor_id}">${b.vendor_name}</a>${b.bank_verified ? '' : html`<br><span class="status bad">Confirm new bank details first</span>`}</td>
      <td><a href="/vtxns/${b.txn_id}">${b.doc_number ?? 'Bill'}</a> <span class="muted">${formatShortDate(b.txn_date)}</span></td>
      <td>${formatShortDate(b.due_date)}</td>
      <td class="num">${formatMoney(b.open_cents, b.currency)}</td>
      <td class="num">${b.vendor_credit_cents ? formatMoney(b.vendor_credit_cents, b.currency) : ''}</td>
      <td class="num">${b.vendor_credit_cents ? html`<input name="credit_${b.txn_id}" value="${v.credit[b.txn_id] ?? ''}" inputmode="decimal" size="9" aria-label="Credit for ${b.doc_number ?? 'bill'}" data-credit>` : ''}</td>
      <td class="num"><input name="pay_${b.txn_id}" value="${v.pay[b.txn_id] ?? ''}" inputmode="decimal" size="10" aria-label="Payment for ${b.doc_number ?? 'bill'}" data-pay></td>
    </tr>`)}</tbody>
  </table>
  <p class="total-line">Total payment <strong data-pay-total>$0.00</strong></p>
  <div class="form-actions"><a href="/vendors">Cancel</a><button class="primary" name="then" value="done">Save payments</button>
    <button class="primary" name="then" value="print">Save and print checks</button></div>`
  : html`<p class="muted">No approved bills are open${filterVendor ? ' for this vendor' : ''}.</p>`}
</form>`,
  });
}

export function checksPage({ entityName, csrf, flash = null, checks }) {
  return layout({
    title: 'Checks to print', entityName, csrf, flash,
    body: html`<div class="crumbs"><a href="/pay-bills">‹ Pay bills</a></div>
<h1>Checks to print</h1>
${checks.length ? html`<form method="post" action="/checks/printed" id="checks">${csrfField(csrf)}
<table class="grid"><thead><tr><th class="select"><input type="checkbox" data-select-all="ids" aria-label="Select all checks"></th><th>Check no.</th><th>Date</th><th>Payee</th><th>Account</th><th class="num">Amount</th></tr></thead>
  <tbody>${checks.map(c => html`<tr>
    <td class="select"><input type="checkbox" name="ids" value="${c.txn_id}" checked aria-label="Check ${c.doc_number}"></td>
    <td><a href="/vtxns/${c.txn_id}">${c.doc_number}</a></td><td>${formatShortDate(c.txn_date)}</td><td>${c.vendor_name ?? ''}</td><td>${c.account_name}</td>
    <td class="num">${formatCents(c.total_cents)}</td></tr>`)}</tbody></table>
<div class="form-actions"><button class="primary" formaction="/checks/print" formtarget="_blank">Print selected</button>
  <button>Mark selected as printed</button></div></form>`
  : html`<p class="muted">No checks are waiting to be printed.</p>`}`,
  });
}

export { centsToInput, formatAddress };
