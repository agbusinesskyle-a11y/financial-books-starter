import { html, raw } from './html.js';
import { layout } from './layout.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { txnStatus, TYPE_LABELS } from '../domain/status.js';
import { TYPE_OPTIONS, STATUS_OPTIONS, dateOptions, filtersToQuery } from '../domain/filters.js';
import { formatDateTime, initials, formatAddress, phoneHref } from './format.js';
import { csrfField, postButton, errorBanner, field, selectField } from './forms.js';
import { STATEMENT_KINDS, KIND_LABELS, KIND_HELP } from '../domain/statements.js';
import { recurringTab } from './recurring.js';
import { lateFeesTab } from './latefees.js';
import { projectsTab } from './projects.js';
import { documentsTab } from './documents.js';
import { icon } from './nav.js';

export const TABS = [
  ['transactions', 'Transaction List'],
  ['activity', 'Activity Feed'],
  ['statements', 'Statements'],
  ['recurring', 'Recurring Transactions'],
  ['projects', 'Projects'],
  ['details', 'Customer Details'],
  ['late-fees', 'Late Fees'],
  ['documents', 'Documents'],
  ['conversations', 'Conversations'],
];

export function customerPage(p) {
  const { customer: c, entityName, csrf, flash } = p;
  return layout({
    title: c.display_name, entityName, csrf, wide: true, flash,
    body: html`<div class="crumbs page-actions"><a href="/customers">‹ Customers</a>
  <button type="button" class="button side-open" data-expand-side>Show customer list</button>
  <span class="spacer"></span>
  ${editMenu(c, csrf)}
  ${newTxnMenu(c.customer_id)}
</div>
<div class="customer-layout" data-side-layout>
  ${sidePanel(p)}
  <div class="customer-main">
    ${headerCard(p)}
    ${p.unbilled?.length ? html`<p class="ledger-check warn">Unbilled expenses: ${p.unbilled.length} for ${formatCents(p.unbilled.reduce((s, e) => s + Number(e.amount_cents), 0))}.
      <a href="/txns/new?type=invoice&customer=${c.customer_id}&billable=1">Create an invoice for them</a></p>` : ''}
    ${p.unbilledHours?.length ? html`<p class="ledger-check warn">Unbilled time: ${(p.unbilledHours.reduce((s, e) => s + e.minutes, 0) / 60).toFixed(2).replace(/\.?0+$/, '')} hours.
      <a href="/txns/new?type=invoice&customer=${c.customer_id}&billable=1">Create an invoice for it</a></p>` : ''}
    <nav class="tabs" aria-label="Customer sections">
      ${TABS.map(([key, label]) => html`<a href="/customers/${c.customer_id}?tab=${key}" class="${key === p.tab ? 'tab active' : 'tab'}"${key === p.tab ? html` aria-current="page"` : ''}>${label}</a>`)}
    </nav>
    <section class="tab-panel">
      ${p.tab === 'transactions' ? transactionsTab(p)
        : p.tab === 'activity' ? activityTab(p)
        : p.tab === 'details' ? detailsTab(p)
        : p.tab === 'statements' ? statementsTab(p)
        : p.tab === 'conversations' ? conversationsTab(p)
        : p.tab === 'recurring' ? recurringTab(p)
        : p.tab === 'late-fees' ? lateFeesTab(p)
        : p.tab === 'projects' ? projectsTab(p)
        : p.tab === 'documents' ? documentsTab(p)
        : ''}
    </section>
  </div>
</div>`,
  });
}

// The customer list beside the page: + new customer, search, Recent or Name order, and a collapse button.
function sidePanel({ recent, customer, everyone = [], sideSort = 'recent', tab }) {
  const list = sideSort === 'name' ? everyone.filter(c => c.active).slice(0, 300) : recent;
  const here = `/customers/${customer.customer_id}?tab=${tab}`;
  return html`<aside class="side-panel card" id="customer-list">
  <div class="side-head">
    <a class="icon-btn" href="/customers/new" aria-label="Create a new customer" title="New customer">${icon('create')}</a>
    <button type="button" class="icon-btn" data-collapse-side aria-label="Collapse the customer list" title="Collapse">«</button>
  </div>
  <form method="get" action="/customers" class="search stacked">
    <input type="search" name="q" placeholder="Search by name or details" aria-label="Search customers">
  </form>
  <p class="side-sort"><a href="${here}&side=recent" class="${sideSort === 'recent' ? 'on' : ''}">Recent</a>
    <a href="${here}&side=name" class="${sideSort === 'name' ? 'on' : ''}">Name</a></p>
  <h2 class="side-title">${sideSort === 'name' ? 'All customers' : 'Recently viewed'}</h2>
  <ul class="recent">
    ${list.map(r => html`<li class="${r.customer_id === customer.customer_id ? 'current' : ''}">
      <a href="/customers/${r.customer_id}${sideSort === 'name' ? '?side=name' : ''}"><strong>${r.display_name}</strong><span>${formatCents(r.open_cents)}</span></a></li>`)}
  </ul>
</aside>`;
}

function headerCard({ customer: c, summary }) {
  const tel = phoneHref(c.phone || c.mobile);
  const sms = phoneHref(c.mobile || c.phone);
  return html`<section class="card customer-head">
  <div class="identity">
    <div class="avatar" aria-hidden="true">${initials(c.display_name)}</div>
    <h1>${c.display_name}</h1>
    ${c.company_name ? html`<p class="muted">${c.company_name}</p>` : ''}
    ${c.active ? '' : html`<p><span class="tag">Inactive</span></p>`}
    <div class="contact-buttons">
      ${c.email ? html`<a class="round" href="/customers/${c.customer_id}?tab=conversations#compose" title="Send email to ${c.email}" aria-label="Send email">${icon('mail')}</a>` : ''}
      ${tel ? html`<a class="round" href="tel:${tel}" title="Call ${c.phone || c.mobile}" aria-label="Call">${icon('phone')}</a>` : ''}
      ${sms ? html`<a class="round" href="sms:${sms}" title="Text ${c.mobile || c.phone}" aria-label="Send a text">${icon('chat')}</a>` : ''}
      <a class="round" href="/customers/${c.customer_id}/edit#noteLine" title="Add note" aria-label="Add note">${icon('note')}</a>
      <a class="round" href="https://meet.google.com/new" target="_blank" rel="noopener noreferrer" title="Start a video call" aria-label="Video call">${icon('video')}</a>
    </div>
  </div>
  <dl class="contact">
    <div><dt>Email</dt><dd>${c.email ?? '—'}</dd></div>
    <div><dt>Phone</dt><dd>${c.phone ?? '—'}</dd></div>
    <div><dt>Billing address</dt><dd>${formatAddress(c.billing_address) || '—'}</dd></div>
    <div><dt>Shipping address${c.shipping_same_as_billing ? ' (same as billing)' : ''}</dt>
        <dd>${formatAddress(c.shipping_same_as_billing ? c.billing_address : c.shipping_address) || '—'}</dd></div>
    <div class="wide"><dt>Notes</dt><dd>${c.note_line ?? '—'}</dd></div>
  </dl>
  <div class="summary">
    <h2>Financial summary</h2>
    <p class="label"><span class="dot open"></span>Open balance</p>
    <p class="amount" data-testid="open-balance">${formatCents(summary.openCents)}</p>
    <p class="label"><span class="dot overdue"></span>Overdue payment</p>
    <p class="amount" data-testid="overdue">${formatCents(summary.overdueCents)}</p>
  </div>
  ${partyReports('customer', c.customer_id, CUSTOMER_REPORTS)}
</section>`;
}

// Reports already filtered to this customer (links a person's role can't open are removed by the server).
const CUSTOMER_REPORTS = [
  ['open_invoices', 'Open invoices', 'today'], ['customer_balance_detail', 'Balance detail', 'today'], ['ar_aging_detail', 'A/R aging', 'today'],
  ['collections_report', 'Collections', 'today'], ['invoices_and_received_payments', 'Invoices and payments', 'this_year_to_date'],
  ['sales_by_customer_detail', 'Sales', 'this_year_to_date'], ['profit_and_loss', 'Profit and Loss', 'this_year_to_date'],
  ['estimates_by_customer', 'Estimates', 'this_year_to_date'], ['transaction_list_by_customer', 'All transactions', 'all'],
];
export function partyReports(party, id, list) {
  return html`<details class="party-reports"><summary>Reports</summary><ul>
    ${list.map(([key, label, period]) => html`<li><a href="/reports/r/${key}?period=${period}&amp;${raw(party)}=${id}">${label}</a></li>`)}
  </ul></details>`;
}

function select(name, label, options, value) {
  return html`<label>${label}<select name="${name}" data-autosubmit>${options.map(([v, text]) => html`<option value="${v}"${v === value ? html` selected` : ''}>${text}</option>`)}</select></label>`;
}

function sortLink(customerId, filters, key, label) {
  const active = filters.sort === key;
  const dir = active && filters.dir === 'desc' ? 'asc' : 'desc';
  const q = filtersToQuery(filters, { sort: key, dir, page: 1 });
  return html`<a href="/customers/${customerId}?tab=transactions${q ? `&${q}` : ''}" class="${active ? 'sorted' : ''}">${label}${active ? (filters.dir === 'desc' ? ' ▼' : ' ▲') : ''}</a>`;
}

// Journal entries and other ledger-only transactions that name this customer on a line: shown, opened on their own page.
const LEDGER_ONLY = new Set(['journal_entry', 'transfer', 'cc_payment', 'fx_revaluation']);

// QBO's Transaction List: Batch actions, Type / Status / Date (applied as soon as they change), the rows with a main action
// and a ▾ menu each, a Total row, and 100-row pages.
function transactionsTab({ customer: c, txns, today, csrf }) {
  const { rows, total, sumCents, filters, pageSize } = txns;
  const q = filtersToQuery(filters, { page: 1 });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (filters.page - 1) * pageSize + 1;
  const last = Math.min(filters.page * pageSize, total);
  const pageLink = page => `/customers/${c.customer_id}?tab=transactions&${filtersToQuery(filters, { page })}`.replace(/&$/, '');
  const batch = (action, label, confirm = null, target = null) => html`<button form="batch" name="action" value="${action}"${confirm ? html` data-confirm="${confirm}"` : ''}${target ? html` formtarget="${target}"` : ''}>${label}</button>`;
  return html`<div class="txn-toolbar">
  <details class="menu batch-menu"><summary class="button">Batch actions ▾</summary>
    <div class="menu-items">
      ${batch('send', 'Send', 'Email the selected transactions to this customer?')}
      ${batch('reminder', 'Send reminder', 'Send a payment reminder for each selected open invoice?')}
      ${batch('print', 'Print', null, '_blank')}
      ${batch('packing', 'Print packing slip', null, '_blank')}
      ${batch('convert', 'Convert to invoice')}
      ${batch('delete', 'Delete', 'Delete the selected transactions? This can’t be undone.')}
    </div></details>
  <form method="get" action="/customers/${c.customer_id}" class="filters">
  <input type="hidden" name="tab" value="transactions">
  ${select('type', 'Type', TYPE_OPTIONS, filters.type)}
  ${select('status', 'Status', STATUS_OPTIONS, filters.status)}
  ${select('date', 'Date', dateOptions(today), filters.date)}
  ${txns.tags?.length ? select('tag', 'Tag', [['', 'Any tag'], ...txns.tags.map(t => [String(t.tag_id), t.full_name])], String(filters.tag ?? '')) : ''}
  <span class="custom-dates${filters.date === 'custom' ? '' : ' hidden'}">
    <label>From <input type="date" name="from" value="${filters.from ?? ''}"></label>
    <label>To <input type="date" name="to" value="${filters.to ?? ''}"></label>
  </span>
  <input type="hidden" name="sort" value="${filters.sort}">
  <input type="hidden" name="dir" value="${filters.dir}">
  <button class="apply">Apply</button>
  </form>
  ${filters.dateProblem ? html`<p class="muted small" role="status">${filters.dateProblem}</p>` : ''}
  <span class="toolbar">
    <a href="/customers/${c.customer_id}?tab=recurring">View recurring templates</a>
    <button type="button" class="link" data-print>Print</button>
    <a href="/customers/${c.customer_id}/export.xlsx${q ? `?${q}` : ''}" download>Export to Excel</a>
  </span>
</div>
<form id="batch" method="post" action="/customers/${c.customer_id}/batch" class="batch-bar">
  ${csrfField(csrf)}
  <span class="muted" data-selected-count>Select transactions for batch actions</span>
  <span class="selected-total" data-selected-total></span>
</form>
<div class="table-scroll"><table class="grid txns">
  <thead><tr>
    <th class="select"><input type="checkbox" data-select-all aria-label="Select all on this page"></th>
    <th>${sortLink(c.customer_id, filters, 'date', 'Date')}</th>
    <th>Type</th>
    <th>${sortLink(c.customer_id, filters, 'number', 'No.')}</th>
    <th>Customer</th>
    <th>Memo</th>
    <th class="num">${sortLink(c.customer_id, filters, 'amount', 'Amount')}</th>
    <th>Status</th>
    <th class="actions">Action</th>
  </tr></thead>
  <tbody>
  ${rows.length ? rows.map(t => {
    const s = txnStatus(t, today);
    const deposit = t.type === 'deposit';
    return html`<tr>
    <td class="select">${deposit || LEDGER_ONLY.has(t.type) ? '' : html`<input type="checkbox" name="ids" value="${t.txn_id}" form="batch" data-amount="${t.total_cents}" aria-label="Select ${TYPE_LABELS[t.type]} ${t.doc_number ?? t.payment_ref ?? ''}">`}</td>
    <td>${formatShortDate(t.txn_date)}</td>
    <td>${TYPE_LABELS[t.type]}</td>
    <td>${t.doc_number ?? t.payment_ref ?? ''}</td>
    <td>${t.customer_name || (deposit ? '—' : '')}</td>
    <td class="memo">${t.memo ?? ''}</td>
    <td class="num">${formatCents(t.total_cents)}</td>
    <td><span class="status ${s.tone}">${s.text}</span>${t.sent_at ? html`<small class="sent">Sent ${formatShortDate(new Date(t.sent_at).toISOString().slice(0, 10))}</small>` : ''}</td>
    <td class="actions">${deposit ? html`<a href="/deposits/${t.txn_id}">View</a>` : LEDGER_ONLY.has(t.type) ? html`<a href="/ledger/${t.txn_id}">View</a>` : rowActions(t, c.customer_id, csrf)}</td>
  </tr>`;
  }) : html`<tr><td colspan="9" class="muted">No transactions match these filters.</td></tr>`}
  ${rows.length ? html`<tr class="total-row"><td></td><td colspan="5"><strong>Total</strong> <span class="muted small">(${total} matching; payments and credits subtract; voided, estimates, deposits and journal entries left out)</span></td>
    <td class="num"><strong>${formatCents(sumCents)}</strong></td><td></td><td></td></tr>` : ''}
  </tbody>
</table></div>
<nav class="pager" aria-label="Pages">
  ${filters.page > 1 ? html`<a href="${pageLink(1)}">First</a><a href="${pageLink(filters.page - 1)}">‹ Previous</a>` : ''}
  <span>${first}–${last} of ${total}</span>
  ${filters.page < pages ? html`<a href="${pageLink(filters.page + 1)}">Next ›</a><a href="${pageLink(pages)}">Last</a>` : ''}
</nav>`;
}

function activityTab({ activity, timeZone }) {
  if (!activity.length) return html`<p class="muted">No activity yet.</p>`;
  return html`<ol class="feed">
  ${activity.map(e => html`<li>
    <time datetime="${new Date(e.occurred_at).toISOString()}">${formatDateTime(e.occurred_at, timeZone)}</time>
    <span>${e.txn_id ? html`<a href="/txns/${e.txn_id}">${e.summary}</a>` : e.summary}</span>
    <span class="muted">${e.actor}</span>
  </li>`)}
</ol>`;
}

// QBO's Customer Details: contact info, attachments, marketing permission, additional info, relationships.
function detailsTab({ customer: c, timeZone, parentName }) {
  const row = (label, value) => html`<div><dt>${label}</dt><dd>${value === null || value === undefined || value === '' ? '—' : value}</dd></div>`;
  const person = [c.title, c.first_name, c.middle_name, c.last_name, c.suffix].filter(Boolean).join(' ');
  const others = c.other_addresses ?? [];
  const social = c.social ?? [];
  return html`<h3 class="details-head">Contact info</h3><dl class="details">
  ${row('Display name', c.display_name)}
  ${row('Name', person)}
  ${row('Company', c.company_name)}
  ${row('Email', c.email)}
  ${row('Cc', c.cc)}
  ${row('Bcc', c.bcc)}
  ${row('Phone', c.phone)}
  ${row('Mobile', c.mobile)}
  ${row('Fax', c.fax)}
  ${row('Other', c.other_phone)}
  ${row('Website', c.website ? html`<a href="${c.website}" target="_blank" rel="noopener noreferrer">${c.website.replace(/^https?:\/\//, '')}</a>` : '')}
  ${row('Name to print on checks', c.check_name)}
  ${row('Parent customer', c.parent_customer_id ? html`<a href="/customers/${c.parent_customer_id}">${parentName ?? 'Parent'}</a>` : '')}
  ${row('Attachments', html`<a href="/customers/${c.customer_id}?tab=documents">Documents tab</a>`)}
  </dl>
  <h3 class="details-head">Marketing permissions</h3><dl class="details">
  ${row('Email marketing', c.email_marketing ? 'Gave permission' : 'No permission recorded')}
  </dl>
  <h3 class="details-head">Additional info</h3><dl class="details">
  ${row('Billing address', formatAddress(c.billing_address))}
  ${row('Shipping address', c.shipping_same_as_billing ? 'Same as billing' : formatAddress(c.shipping_address))}
  ${others.length ? row('Other shipping addresses', html`${others.map(o => html`<span class="addr-line">${o.label ? html`<strong>${o.label}:</strong> ` : ''}${formatAddress(o)}</span>`)}`) : ''}
  ${row('Terms', c.terms_name)}
  ${row('Credit limit', c.credit_limit_cents === null ? '' : formatCents(Number(c.credit_limit_cents)))}
  ${row('Payment method', c.preferred_payment_method)}
  ${row('Preferred delivery method', { email: 'Email', print: 'Print later', none: 'None' }[c.preferred_delivery])}
  ${row('Customer type', c.customer_type)}
  ${row('Customer language', c.invoice_language)}
  ${row('Tax exemption details', c.tax_exempt ? `Exempt${c.tax_exempt_reason ? ` — ${c.tax_exempt_reason}` : ''}` : 'Taxable')}
  ${row('Late fees', c.late_fees_enabled ? 'On' : 'Off')}
  ${row('Status', c.active ? 'Active' : 'Inactive')}
  ${row('Customer since', formatDateTime(c.created_at, timeZone).split(',').slice(0, 2).join(','))}
  </dl>
  <h3 class="details-head">Relationships &amp; sales</h3><dl class="details">
  ${row('Source', c.source)}
  ${row('Referred by', c.referred_by)}
  ${row('Job title', c.job_title)}
  ${row('Role', c.contact_role)}
  ${row('Preferred contact method', { email: 'Email', phone: 'Phone', mobile: 'Mobile', text: 'Text message', mail: 'Mail' }[c.preferred_contact])}
  ${row('Industry', c.industry)}
  ${row('Social media', social.length ? html`${social.map(x => html`<a class="addr-line" href="${x.url}" target="_blank" rel="noopener noreferrer">${x.network || x.url.replace(/^https?:\/\//, '')}</a>`)}` : '')}
  </dl>
  <p><a class="button" href="/customers/${c.customer_id}/edit">Edit details</a></p>`;
}

// Edit, and ▾ with Make inactive / Make active and Merge contacts.
function editMenu(c, csrf) {
  return html`<span class="split-button"><a class="button" href="/customers/${c.customer_id}/edit">Edit</a>
  <details class="menu"><summary class="button" aria-label="More edit actions">▾</summary>
    <div class="menu-items">
      ${postButton({ action: `/customers/${c.customer_id}/active`, csrf, label: c.active ? 'Make inactive' : 'Make active', extra: { active: c.active ? '0' : '1' },
        confirm: c.active ? `Make ${c.display_name} inactive? They’ll be hidden from lists and forms; their history stays.` : null })}
      <a href="/customers/${c.customer_id}/merge">Merge contacts</a>
    </div></details></span>`;
}

// QBO's New transaction menu for a customer. Kinds not built yet open their Coming next page.
const NEW_MENU = id => [
  ['Invoice', `/txns/new?type=invoice&customer=${id}`], ['Multiple invoices', '/soon/multiple-invoices'],
  ['Payment', `/txns/new?type=payment&customer=${id}`], ['Recurring payment', `/customers/${id}/recurring/new`],
  ['Estimate', `/txns/new?type=estimate&customer=${id}`],
  ['Sales receipt', `/txns/new?type=sales_receipt&customer=${id}`], ['Credit memo', `/txns/new?type=credit_memo&customer=${id}`],
  ['Time activity', '/time'], ['Statement', `/customers/${id}?tab=statements#new-statement`],
];

function newTxnMenu(customerId) {
  return html`<details class="menu">
  <summary class="button primary">New transaction</summary>
  <div class="menu-items">${NEW_MENU(customerId).map(([text, href]) => html`<a href="${href}"${href.startsWith('/soon/') ? html` class="soon"` : ''}>${text}${href.startsWith('/soon/') ? html`<span class="soon-tag">Soon</span>` : ''}</a>`)}</div>
</details>`;
}

// View/Edit, the main action for where the transaction stands (QBO: open invoice → Receive payment, paid → Print,
// estimate → Create invoice), and the ▾ menu with the rest.
function rowActions(t, customerId, csrf) {
  const imported = t.source === 'qbo_import';
  const editable = !t.voided_at && t.type !== 'late_fee' && !imported;
  const charge = t.type === 'invoice' || t.type === 'late_fee';
  const open = !t.voided_at && charge && t.open_cents > 0;
  const name = `${TYPE_LABELS[t.type]} ${t.doc_number ?? t.payment_ref ?? ''}`.trim();
  const estimateOpen = t.type === 'estimate' && !t.voided_at && t.open_cents > 0 && !['rejected', 'closed'].includes(t.estimate_status);
  const main = open ? html`<a href="/txns/new?type=payment&customer=${customerId}&charge=${t.txn_id}">Receive payment</a>`
    : estimateOpen ? html`<a href="/txns/${t.txn_id}/invoice">Create invoice</a>`
    : !t.voided_at && ['invoice', 'sales_receipt', 'credit_memo', 'late_fee'].includes(t.type) ? html`<a href="/txns/${t.txn_id}.pdf" target="_blank" rel="noopener">Print</a>` : '';
  const sales = ['invoice', 'sales_receipt', 'credit_memo', 'estimate'].includes(t.type);
  const items = [
    sales ? html`<a href="/txns/new?copy=${t.txn_id}">Duplicate</a>` : '',
    !t.voided_at && t.type !== 'payment' ? postButton({ action: `/txns/${t.txn_id}/send`, csrf, label: 'Send' }) : '',
    open ? postButton({ action: `/txns/${t.txn_id}/reminder`, csrf, label: 'Send reminder' }) : '',
    open ? postButton({ action: `/txns/${t.txn_id}/share`, csrf, label: 'Share invoice link' }) : '',
    !t.voided_at && ['invoice', 'sales_receipt'].includes(t.type) ? html`<a href="/customers/${customerId}/recurring/new?from=${t.txn_id}">Make recurring</a>` : '',
    !t.voided_at && ['invoice', 'sales_receipt', 'estimate'].includes(t.type) ? html`<a href="/txns/${t.txn_id}/packing-slip.pdf" target="_blank" rel="noopener">Print packing slip</a>` : '',
    !main || open || estimateOpen ? html`<a href="/txns/${t.txn_id}.pdf" target="_blank" rel="noopener">Print</a>` : '',
    !t.voided_at && ((charge && t.open_cents === 0) || t.type === 'sales_receipt') ? html`<a href="/soon/refund-receipt">Refund</a>` : '',
    t.voided_at || imported ? '' : postButton({ action: `/txns/${t.txn_id}/void`, csrf, label: 'Void', confirm: `Void ${name}? Its amount becomes $0.00 and any payments applied to it are released.` }),
    imported ? '' : postButton({ action: `/txns/${t.txn_id}/delete`, csrf, label: 'Delete', confirm: `Delete ${name}? This can’t be undone.` }),
    html`<a href="/customers/${customerId}?tab=activity">View activity</a>`,
  ];
  return html`<a href="${editable ? `/txns/${t.txn_id}/edit` : `/txns/${t.txn_id}`}">${editable ? 'View/Edit' : 'View'}</a>${main ? html` · ${main}` : ''}
  <details class="menu row-menu"><summary aria-label="More actions for ${name}" title="More actions"></summary>
    <div class="menu-items">${items}</div>
  </details>`;
}

// Batch Delete, asked on the server so it's confirmed even without JavaScript.
export function confirmBatchDeletePage({ entityName, csrf, customer: c, txns, ids }) {
  return layout({ title: 'Delete transactions?', entityName, csrf, body: html`<div class="crumbs"><a href="/customers/${c.customer_id}">‹ ${c.display_name}</a></div>
  <form method="post" action="/customers/${c.customer_id}/batch" class="card editor">${csrfField(csrf)}
    <h1>Delete ${txns.length} transaction${txns.length === 1 ? '' : 's'}?</h1>
    <ul class="flat">${txns.map(t => html`<li>${TYPE_LABELS[t.type]} ${t.doc_number ?? t.payment_ref ?? ''}</li>`)}</ul>
    <p>This can’t be undone. Payments applied to them become credits again.</p>
    ${ids.map(id => html`<input type="hidden" name="ids" value="${id}">`)}
    <input type="hidden" name="action" value="delete"><input type="hidden" name="confirmed" value="1">
    <div class="form-actions"><a href="/customers/${c.customer_id}">Cancel</a><button class="danger">Delete</button></div>
  </form>` });
}

// Row ▾ → Share invoice link: the one-time pay link to copy.
export function shareLinkPage({ entityName, csrf, txn: t, link }) {
  return layout({ title: `Share ${TYPE_LABELS[t.type]} ${t.doc_number ?? ''}`, entityName, csrf, body: html`<div class="crumbs"><a href="/customers/${t.customer_id}">‹ Back</a></div>
  <section class="card editor"><h1>Share invoice link</h1>
    <p>Anyone with this link can see ${TYPE_LABELS[t.type].toLowerCase()} ${t.doc_number ?? ''} and pay ${formatCents(t.open_cents)} online. It works once, and making a new
      link replaces it.</p>
    <label class="field wide"><span>Link</span><input type="text" readonly value="${link}" data-select-on-focus></label>
    <p><button type="button" class="primary" data-copy="${link}">Copy link</button> <a href="/txns/${t.txn_id}">View the invoice</a></p>
  </section>` });
}

function statementsTab({ customer: c, csrf, statements, statementForm: f }) {
  const kindOptions = STATEMENT_KINDS.map(([k, label]) => [k, label, `data-help="${KIND_HELP[k]}"`]);
  return html`<form method="post" action="/customers/${c.customer_id}/statements" class="statement-form" id="new-statement" data-statement-form>
  ${csrfField(csrf)}
  <h2>Create statement</h2>
  ${errorBanner(f.error)}
  <div class="form-grid">
    ${selectField('Statement type', 'kind', kindOptions, f.kind, { attrs: 'data-statement-kind' })}
    ${field('Statement date', 'statementDate', f.statementDate, { type: 'date', required: true })}
    ${field('Start date', 'startDate', f.startDate, { type: 'date', cls: `period${f.kind === 'open_item' ? ' hidden' : ''}` })}
    ${field('End date', 'endDate', f.endDate, { type: 'date', cls: `period${f.kind === 'open_item' ? ' hidden' : ''}` })}
  </div>
  <p class="muted" data-kind-help>${KIND_HELP[f.kind]}</p>
  <div class="page-actions">
    <button name="action" value="preview" formtarget="_blank">Preview PDF</button>
    <button name="action" value="save">Save</button>
    <button name="action" value="send" class="primary" data-confirm="${c.email ? `Email this statement to ${c.email}?` : 'Save and send this statement?'}">Save and send</button>
  </div>
</form>
<h2 class="section-title">Statement history</h2>
${statements.length ? html`<table class="grid">
  <thead><tr><th>Date</th><th>No.</th><th>Customer</th><th>Start date</th><th>End date</th><th>Statement type</th><th class="num">Amount due</th><th>Sent</th><th class="actions">Action</th></tr></thead>
  <tbody>${statements.map(s => html`<tr>
    <td>${formatShortDate(s.statement_date)}</td>
    <td>${s.statement_id}</td>
    <td>${c.display_name}</td>
    <td>${s.start_date ? formatShortDate(s.start_date) : '—'}</td>
    <td>${s.end_date ? formatShortDate(s.end_date) : '—'}</td>
    <td>${KIND_LABELS[s.kind]}</td>
    <td class="num">${formatCents(s.total_due_cents)}</td>
    <td>${s.sent_at ? `Sent to ${s.sent_to}` : html`<span class="muted">Not sent</span>`}</td>
    <td class="actions"><a href="/statements/${s.statement_id}.pdf" target="_blank" rel="noopener">View PDF</a> ·
      ${postButton({ action: `/statements/${s.statement_id}/send`, csrf, label: s.sent_at ? 'Send again' : 'Send' })}</td>
  </tr>`)}</tbody>
</table>` : html`<p class="muted">No statements yet.</p>`}`;
}

const STATUS_TAGS = { sent: ['Sent', 'good'], logged: ['Recorded only', 'muted'], failed: ['Failed', 'bad'], received: ['Received', 'good'] };

function textArea(label, name, value, { rows = 6, required = false } = {}) {
  return html`<label class="field wide"><span>${label}</span><textarea name="${name}" rows="${rows}"${required ? html` required` : ''}>${value ?? ''}</textarea></label>`;
}

function conversationsTab({ customer: c, csrf, messages, mailKind, compose, reply, timeZone }) {
  const action = `/customers/${c.customer_id}/messages`;
  return html`${mailKind === 'smtp' ? '' : html`<p class="email-status off">Email isn’t set up for this company, so messages you send here are recorded only. <a href="/settings/email">Set up email</a></p>`}
<div class="compose-bar">
<details class="compose" id="compose"${compose.open ? html` open` : ''}>
  <summary class="button primary">New email</summary>
  <form method="post" action="${action}" class="editor">
    ${csrfField(csrf)}<input type="hidden" name="action" value="send">
    ${errorBanner(compose.error)}
    <div class="form-grid">
      ${field('To', 'to', compose.to, { type: 'email', required: true })}
      ${field('Subject', 'subject', compose.subject, { required: true })}
    </div>
    ${textArea('Message', 'body', compose.body, { rows: 8, required: true })}
    <div class="form-actions"><button class="primary">Send email</button></div>
  </form>
</details>
<details class="compose"${reply.open ? html` open` : ''}>
  <summary class="button">Log a reply</summary>
  <form method="post" action="${action}" class="editor">
    ${csrfField(csrf)}<input type="hidden" name="action" value="reply">
    <p class="muted">Paste a reply ${c.display_name} sent you so the whole conversation is in one place.</p>
    ${errorBanner(reply.error)}
    <div class="form-grid">
      ${field('From', 'from', reply.from, { type: 'email' })}
      ${field('Subject', 'subject', reply.subject)}
    </div>
    ${textArea('Their message', 'body', reply.body, { rows: 6, required: true })}
    <div class="form-actions"><button class="primary">Save reply</button></div>
  </form>
</details>
</div>
${messages.length ? html`<ol class="thread">${messages.map(m => {
    const [tag, tone] = STATUS_TAGS[m.status];
    const about = m.related_txn_id ? html` · <a href="/txns/${m.related_txn_id}">${TYPE_LABELS[m.txn_type]} ${m.doc_number ?? m.payment_ref ?? ''}</a>`
      : m.related_statement_id ? html` · <a href="/statements/${m.related_statement_id}.pdf" target="_blank" rel="noopener">Statement</a>` : '';
    return html`<li class="msg ${m.direction}">
    <div class="msg-head">
      <strong>${m.direction === 'out' ? `To ${m.to_addr ?? ''}` : `From ${m.from_addr ?? c.display_name}`}</strong>
      <span class="status ${tone}">${tag}</span>
      <time datetime="${new Date(m.occurred_at).toISOString()}" class="muted">${formatDateTime(m.occurred_at, timeZone)}</time>
    </div>
    <div class="msg-subject">${m.subject ?? html`<span class="muted">(no subject)</span>`}${about}</div>
    ${m.error ? html`<p class="error">${m.error}</p>` : ''}
    <div class="msg-body">${m.body}</div>
  </li>`;
  })}</ol>` : html`<p class="muted">No messages with ${c.display_name} yet.</p>`}`;
}
