import { html } from './html.js';
import { partyReports } from './customer-page.js';
import { layout } from './layout.js';
import { formatCents, centsToInput } from '../domain/money.js';
import { formatDateTime, initials, formatAddress, phoneHref } from './format.js';
import { csrfField, errorBanner, field, selectField, checkbox, postButton } from './forms.js';
import { masked } from '../domain/vendors.js';
import { documentsTab } from './documents.js';
import { accountLabel } from './accounts.js';
import { vendorTxnMenuItems, vendorRowAction, vendorTransactionsTab, vendorRecurringTab } from './vendor-txns.js';

// Reports already filtered to this vendor.
const VENDOR_REPORTS = [
  ['unpaid_bills', 'Unpaid bills', 'today'], ['vendor_balance_detail', 'Balance detail', 'today'], ['ap_aging_detail', 'A/P aging', 'today'],
  ['bills_and_applied_payments', 'Bills and payments', 'this_year_to_date'], ['purchases_by_vendor_detail', 'Purchases', 'this_year_to_date'],
  ['expenses_by_vendor_detail', 'Expenses', 'this_year_to_date'], ['contractor_1099_detail', '1099 payments', 'this_year'],
  ['transaction_list_by_vendor', 'All transactions', 'all'],
];

export const VENDOR_TABS = [
  ['transactions', 'Transaction List'],
  ['details', 'Vendor Details'],
  ['recurring', 'Recurring'],
  ['documents', 'Documents'],
  ['activity', 'Activity'],
];

// Optional list columns: [key, label]. The name column always shows.
export const VENDOR_COLUMNS = [['company', 'Company'], ['address', 'Address'], ['phone', 'Phone'], ['email', 'Email'], ['t1099', '1099 tracking'],
  ['documents', 'Attachments'], ['bank', 'Bank info']];

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function summaryBar(bar) {
  const tile = (show, cls, amount, label) => html`<a class="${`bar-tile ${cls}`}" href="/vendors?show=${show}"><strong>${formatCents(amount)}</strong><span>${label}</span></a>`;
  return html`<div class="vendor-bar" aria-label="Vendor totals">
  <div class="bar-group"><span class="bar-title">Unbilled last 365 days</span>
    ${tile('po', 'po', bar.po_cents, `${plural(bar.po_count, 'open purchase order')}`)}</div>
  <div class="bar-group two"><span class="bar-title">Unpaid</span>
    ${tile('overdue', 'overdue', bar.overdue_cents, `${bar.overdue_count} overdue`)}
    ${tile('open', 'open', bar.open_cents, plural(bar.open_count, 'open bill'))}</div>
  <div class="bar-group"><span class="bar-title">Paid</span>
    ${tile('paid', 'paid', bar.paid_cents, `${bar.paid_count} paid last 30 days`)}</div>
</div>`;
}

const SHOW_LABELS = { overdue: 'with overdue bills', open: 'with open bills', paid: 'paid in the last 30 days', po: 'with open purchase orders' };

function sortHead(f, key, label, cls = '') {
  const active = f.sort === key;
  const dir = active && f.dir === 'asc' ? 'desc' : 'asc';
  const q = new URLSearchParams({ ...(f.search ? { q: f.search } : {}), ...(f.show ? { show: f.show } : {}), ...(f.inactive ? { inactive: '1' } : {}), sort: key, dir });
  return html`<a href="/vendors?${q.toString()}" class="${active ? 'sorted' : ''}${cls}">${label}${active ? (f.dir === 'desc' ? ' ▼' : ' ▲') : ''}</a>`;
}

export function vendorsPage({ entityName, csrf, flash = null, bar, list, filters: f }) {
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const pageLink = n => {
    const q = new URLSearchParams({ ...(f.search ? { q: f.search } : {}), ...(f.show ? { show: f.show } : {}), ...(f.inactive ? { inactive: '1' } : {}),
      sort: f.sort, dir: f.dir, size: String(list.pageSize), page: String(n) });
    return `/vendors?${q.toString()}`;
  };
  return layout({
    title: 'Vendors', entityName, csrf, flash, wide: true,
    body: html`<div class="page-actions"><h1>Vendors</h1><span class="spacer"></span>
  <details class="menu"><summary class="button">More ▾</summary><div class="menu-items">
    <a href="/vendors/import">Import vendors</a>
    <a href="/vendors/1099">1099 summary</a>
    <a href="/pay-bills">Pay bills</a>
    <a href="/checks">Checks to print</a>
  </div></details>
  <a class="button primary" href="/vendors/new">New vendor</a>
</div>
${summaryBar(bar)}
<section class="card">
  <form method="get" action="/vendors" class="filters">
    <label>Search<input type="search" name="q" value="${f.search}" placeholder="Name, company, email or phone"></label>
    ${f.show ? html`<input type="hidden" name="show" value="${f.show}">` : ''}
    <label class="check"><input type="checkbox" name="inactive" value="1"${f.inactive ? html` checked` : ''} data-autosubmit-check> Include inactive</label>
    <button>Search</button>
    <div class="toolbar">
      <details class="menu column-picker"><summary class="button" aria-label="Choose columns">Columns ▾</summary><div class="menu-items">
        ${VENDOR_COLUMNS.map(([k, l]) => html`<label class="check"><input type="checkbox" data-col-toggle="${k}" checked> ${l}</label>`)}
        <label class="field"><span>Rows per page</span><select name="size" data-autosubmit>${[50, 75, 100, 150, 300].map(n => html`<option value="${n}"${n === list.pageSize ? html` selected` : ''}>${n}</option>`)}</select></label>
      </div></details>
      <button type="button" class="link" data-print>Print</button>
      <a href="/vendors.csv?${new URLSearchParams({ ...(f.search ? { q: f.search } : {}), ...(f.show ? { show: f.show } : {}), ...(f.inactive ? { inactive: '1' } : {}) }).toString()}">Export</a>
    </div>
  </form>
  ${f.show ? html`<p class="muted">Showing vendors ${SHOW_LABELS[f.show]}. <a href="/vendors">Show all</a></p>` : ''}
  <form method="post" action="/vendors/batch" id="vendor-batch">
    ${csrfField(csrf)}
    <div class="batch-bar"><span data-selected-count class="muted">Select vendors for batch actions</span>
      <button name="action" value="email">Email</button>
      <button name="action" value="inactive" data-confirm="Make the selected vendors inactive?">Make inactive</button>
    </div>
  </form>
  <div class="table-scroll"><table class="grid" data-columns="vendors">
    <thead><tr>
      <th class="select"><input type="checkbox" data-select-all="ids" aria-label="Select all vendors"></th>
      <th>${sortHead(f, 'name', 'Vendor')}</th>
      <th data-col="company">${sortHead(f, 'company', 'Company')}</th>
      <th data-col="address">Address</th>
      <th data-col="phone">Phone</th>
      <th data-col="email">Email</th>
      <th data-col="t1099">1099</th>
      <th data-col="documents" class="num">Attachments</th>
      <th class="num">${sortHead(f, 'balance', 'Open balance')}</th>
      <th data-col="bank">Bank info</th>
      <th class="actions">Action</th>
    </tr></thead>
    <tbody>
    ${list.rows.length ? list.rows.map(v => html`<tr class="${v.active ? '' : 'inactive'}">
      <td class="select"><input type="checkbox" name="ids" value="${v.vendor_id}" form="vendor-batch" aria-label="Select ${v.display_name}"></td>
      <td><a href="/vendors/${v.vendor_id}"><strong>${v.display_name}</strong></a>${v.active ? '' : html` <span class="tag">Inactive</span>`}</td>
      <td data-col="company">${v.company_name ?? ''}</td>
      <td data-col="address">${formatAddress(v.billing_address)}</td>
      <td data-col="phone">${v.phone ? html`<a href="tel:${phoneHref(v.phone)}">${v.phone}</a>` : ''}</td>
      <td data-col="email">${v.email ? html`<a href="mailto:${v.email}">${v.email}</a>` : ''}</td>
      <td data-col="t1099">${v.track_1099 ? 'Tracking' : ''}</td>
      <td data-col="documents" class="num">${v.documents || ''}</td>
      <td class="num">${formatCents(v.open_cents)}${v.overdue_cents ? html`<br><span class="status bad">${formatCents(v.overdue_cents)} overdue</span>` : ''}</td>
      <td data-col="bank">${v.bank_account_last4 ? masked(v.bank_account_last4) : html`<span class="muted">Missing</span>`}</td>
      <td class="actions">${vendorRowAction(v, csrf)}</td>
    </tr>`) : html`<tr><td colspan="11" class="muted">${f.search ? `No vendors match “${f.search}”.` : 'No vendors yet. Add one, or import a list.'}</td></tr>`}
    </tbody>
  </table></div>
  <div class="pager">${list.total} vendor${list.total === 1 ? '' : 's'}
    ${f.page > 1 ? html`<a href="${pageLink(f.page - 1)}">‹ Previous</a>` : ''}
    ${pages > 1 ? html`<span>Page ${f.page} of ${pages}</span>` : ''}
    ${f.page < pages ? html`<a href="${pageLink(f.page + 1)}">Next ›</a>` : ''}</div>
</section>`,
  });
}

// ---- one vendor ----

export function vendorPage(p) {
  const { vendor: v, entityName, csrf, flash, tab } = p;
  const tel = phoneHref(v.phone || v.mobile);
  return layout({
    title: v.display_name, entityName, csrf, flash, wide: true,
    body: html`<div class="crumbs page-actions"><a href="/vendors">‹ Vendors</a>
  <span class="spacer"></span>
  <a class="button" href="/vendors/${v.vendor_id}/edit">Edit</a>
  <details class="menu"><summary class="button" aria-label="More vendor actions">▾</summary><div class="menu-items">
    ${postButton({ action: `/vendors/${v.vendor_id}/${v.active ? 'inactive' : 'active'}`, csrf, label: v.active ? 'Make inactive' : 'Make active' })}
    <a href="/vendors/${v.vendor_id}/merge">Merge into another vendor</a>
    ${postButton({ action: `/vendors/${v.vendor_id}/ask`, csrf, label: 'Ask vendor for info' })}
  </div></details>
  ${vendorTxnMenuItems(v).length ? html`<details class="menu"><summary class="button primary">New transaction ▾</summary><div class="menu-items">
    ${vendorTxnMenuItems(v).map(([href, label]) => html`<a href="${href}">${label}</a>`)}
  </div></details>` : ''}
</div>
<section class="card customer-head vendor-head">
  <div class="identity">
    <div class="avatar" aria-hidden="true">${initials(v.display_name)}</div>
    <h1>${v.display_name}</h1>
    ${v.company_name && v.company_name !== v.display_name ? html`<p class="muted">${v.company_name}</p>` : ''}
    ${v.active ? '' : html`<p><span class="tag">Inactive</span></p>`}
    <div class="contact-buttons">
      ${v.email ? html`<a class="round" href="mailto:${v.email}" title="Email ${v.email}" aria-label="Email">✉</a>` : ''}
      ${tel ? html`<a class="round" href="tel:${tel}" title="Call ${v.phone || v.mobile}" aria-label="Call">☎</a>` : ''}
    </div>
  </div>
  <dl class="contact">
    <div><dt>Company</dt><dd>${v.company_name ?? '—'}</dd></div>
    <div><dt>Billing address</dt><dd>${formatAddress(v.billing_address) || '—'}</dd></div>
    <div><dt>Bank info</dt><dd>${v.bank_account_last4 ? html`Account ${masked(v.bank_account_last4)}${p.routing ? html`<br>Routing ${p.routing}` : ''}` : html`<span class="muted">Not on file</span>`}</dd></div>
    <div><dt>Terms</dt><dd>${v.terms_name ?? '—'}</dd></div>
    <div class="wide"><dt>Notes</dt><dd>${v.notes ?? '—'}</dd></div>
  </dl>
  <div class="summary">
    <h2>Summary</h2>
    <p class="label"><span class="dot open"></span>Open balance</p>
    <p class="amount" data-testid="open-balance">${formatCents(v.open_cents)}</p>
    <p class="label"><span class="dot overdue"></span>Overdue</p>
    <p class="amount" data-testid="overdue">${formatCents(v.overdue_cents)}</p>
  </div>
  ${partyReports('vendor', v.vendor_id, VENDOR_REPORTS)}
</section>
${v.bank_account_last4 && !v.bank_verified ? html`<p class="ledger-check bad">Bank details for ${v.display_name} were changed through a vendor link.
  Call them at a number you already have on file to confirm the account ending ${v.bank_account_last4} before paying.
  ${postButton({ action: `/vendors/${v.vendor_id}/bank-verified`, csrf, label: 'I’ve confirmed them', cls: '' })}</p>` : ''}
${p.pendingRequest ?? ''}
<nav class="tabs" aria-label="Vendor sections">
  ${VENDOR_TABS.map(([key, label]) => html`<a href="/vendors/${v.vendor_id}?tab=${key}" class="${key === tab ? 'tab active' : 'tab'}"${key === tab ? html` aria-current="page"` : ''}>${label}</a>`)}
</nav>
<section class="tab-panel">
  ${tab === 'transactions' ? vendorTransactionsTab(p)
    : tab === 'details' ? detailsTab(p)
    : tab === 'recurring' ? vendorRecurringTab(p)
    : tab === 'documents' ? documentsTab({ ...p, customer: null })
    : tab === 'activity' ? activityTab(p)
    : ''}
</section>`,
  });
}

function detailsTab({ vendor: v, routing }) {
  const row = (label, value) => html`<div><dt>${label}</dt><dd>${value || '—'}</dd></div>`;
  const name = [v.title, v.first_name, v.middle_name, v.last_name, v.suffix].filter(Boolean).join(' ');
  return html`<div class="page-actions"><h2>Contact info</h2><span class="spacer"></span><a class="button" href="/vendors/${v.vendor_id}/edit">Edit</a></div>
<dl class="details">
  ${row('Vendor', v.display_name)}${row('Contact name', name)}${row('Email', v.email)}${row('Cc', v.cc)}${row('Bcc', v.bcc)}
  ${row('Phone', v.phone)}${row('Mobile', v.mobile)}${row('Fax', v.fax)}${row('Other', v.other_phone)}
  ${row('Website', v.website)}${row('Name to print on checks', v.check_name ?? v.display_name)}
</dl>
<h2 class="section-title">Additional info</h2>
<dl class="details">
  ${row('Billing address', formatAddress(v.billing_address))}${row('Terms', v.terms_name)}${row('Account no.', v.account_no)}
  ${row('Default expense category', v.default_expense_account_name)}${row('Billing rate (/hr)', v.billing_rate_cents !== null ? formatCents(v.billing_rate_cents) : '')}
  ${row('Track payments for 1099', v.track_1099 ? 'Yes' : 'No')}${row('Tax ID', v.tax_id_last4 ? masked(v.tax_id_last4) : '')}
  ${row('Bank account', v.bank_account_last4 ? masked(v.bank_account_last4) : '')}${row('Routing number', routing ?? '')}
  ${row('Notes', v.notes)}
</dl>`;
}

function activityTab({ activity, timeZone }) {
  if (!activity.length) return html`<p class="muted">No activity yet.</p>`;
  return html`<ul class="feed">${activity.map(a => html`<li><time>${formatDateTime(a.occurred_at, timeZone)}</time>
    <span>${a.txn_id ? html`<a href="/txns/${a.txn_id}">${a.summary}</a>` : a.summary}</span><span class="muted">${a.actor}</span></li>`)}</ul>`;
}

// ---- vendor form ----

export const NEW_VENDOR_VALUES = {
  displayName: '', companyName: '', title: '', firstName: '', middleName: '', lastName: '', suffix: '', email: '', cc: '', bcc: '', phone: '', mobile: '',
  fax: '', otherPhone: '', website: '', checkName: '', line1: '', line2: '', city: '', state: '', postal: '', country: '', notes: '', termsId: '',
  accountNo: '', defaultExpenseAccountId: '', billingRate: '', track1099: false, bankRouting: '', bankAccount: '', taxId: '', clearBank: false,
  clearTaxId: false, active: true,
};
const KEYS = Object.keys(NEW_VENDOR_VALUES);
const BOOLS = new Set(['track1099', 'clearBank', 'clearTaxId', 'active']);

export function vendorToValues(v) {
  const a = v.billing_address ?? {};
  return {
    ...NEW_VENDOR_VALUES, currency: v.currency ?? '', displayName: v.display_name, companyName: v.company_name ?? '', title: v.title ?? '', firstName: v.first_name ?? '',
    middleName: v.middle_name ?? '', lastName: v.last_name ?? '', suffix: v.suffix ?? '', email: v.email ?? '', cc: v.cc ?? '', bcc: v.bcc ?? '',
    phone: v.phone ?? '', mobile: v.mobile ?? '', fax: v.fax ?? '', otherPhone: v.other_phone ?? '', website: v.website ?? '', checkName: v.check_name ?? '',
    line1: a.line1 ?? '', line2: a.line2 ?? '', city: a.city ?? '', state: a.state ?? '', postal: a.postal ?? '', country: a.country ?? '', notes: v.notes ?? '',
    termsId: v.terms_id ? String(v.terms_id) : '', accountNo: v.account_no ?? '',
    defaultExpenseAccountId: v.default_expense_account_id ? String(v.default_expense_account_id) : '',
    billingRate: v.billing_rate_cents !== null ? centsToInput(v.billing_rate_cents) : '', track1099: v.track_1099, active: v.active,
  };
}

export const vendorFormValues = params => ({ ...Object.fromEntries(KEYS.map(k => [k, BOOLS.has(k) ? params.get(k) === '1' : (params.get(k) ?? '')])),
  ...(params.has('currency') ? { currency: params.get('currency') ?? '' } : {}) });

export function vendorForm({ entityName, csrf, vendor = null, v, terms, expenseAccounts, hasKey, error = null, cur = null }) {
  const action = vendor ? `/vendors/${vendor.vendor_id}` : '/vendors';
  const back = vendor ? `/vendors/${vendor.vendor_id}` : '/vendors';
  return layout({
    title: vendor ? `Edit ${vendor.display_name}` : 'New vendor', entityName, csrf,
    body: html`<div class="crumbs"><a href="${back}">‹ Back</a></div>
<form method="post" action="${action}" class="card editor" autocomplete="off">
  ${csrfField(csrf)}
  <h1>${vendor ? `Edit ${vendor.display_name}` : 'New vendor'}</h1>
  ${errorBanner(error)}
  <h2>Name and contact</h2>
  <div class="form-grid">
    ${field('Vendor display name', 'displayName', v.displayName, { required: true })}
    ${field('Company name', 'companyName', v.companyName)}
    ${field('Title', 'title', v.title)}
    ${field('First name', 'firstName', v.firstName)}
    ${field('Middle name', 'middleName', v.middleName)}
    ${field('Last name', 'lastName', v.lastName)}
    ${field('Suffix', 'suffix', v.suffix)}
    ${field('Email', 'email', v.email, { type: 'email' })}
    ${field('Cc', 'cc', v.cc, { hint: 'Separate addresses with commas' })}
    ${field('Bcc', 'bcc', v.bcc)}
    ${field('Phone', 'phone', v.phone, { type: 'tel' })}
    ${field('Mobile', 'mobile', v.mobile, { type: 'tel' })}
    ${field('Fax', 'fax', v.fax, { type: 'tel' })}
    ${field('Other', 'otherPhone', v.otherPhone, { type: 'tel' })}
    ${field('Website', 'website', v.website)}
    ${field('Name to print on checks', 'checkName', v.checkName, { hint: 'Leave blank to use the display name' })}
  </div>
  <fieldset class="address"><legend>Address</legend>
    ${field('Street address 1', 'line1', v.line1, { cls: 'wide' })}
    ${field('Street address 2', 'line2', v.line2, { cls: 'wide' })}
    ${field('City', 'city', v.city)}
    ${field('State', 'state', v.state)}
    ${field('ZIP code', 'postal', v.postal)}
    ${field('Country', 'country', v.country)}
  </fieldset>
  <label class="field wide"><span>Notes</span><textarea name="notes" rows="3" maxlength="2000">${v.notes}</textarea></label>

  <h2>Bank details (for paying this vendor)</h2>
  ${hasKey ? '' : html`<p class="error-banner">Bank details and tax IDs can’t be saved until SETTINGS_KEY is set on the server.</p>`}
  <p class="muted">${vendor?.bank_account_last4 ? html`On file: account ${masked(vendor.bank_account_last4)}. Leave blank to keep it.` : 'Stored encrypted; only the last four digits are shown.'}</p>
  <div class="form-grid">
    ${field('Routing number', 'bankRouting', v.bankRouting, { attrs: 'inputmode="numeric" autocomplete="off"' })}
    ${field('Bank account number', 'bankAccount', v.bankAccount, { attrs: 'inputmode="numeric" autocomplete="off"' })}
  </div>
  ${vendor?.bank_account_last4 ? checkbox('Remove the saved bank details', 'clearBank', v.clearBank) : ''}

  <h2>Taxes and payments</h2>
  <div class="form-grid">
    ${field('Business ID no. / Social Security no.', 'taxId', v.taxId, { attrs: 'autocomplete="off"', hint: vendor?.tax_id_last4 ? `On file: ${masked(vendor.tax_id_last4)}. Leave blank to keep it.` : 'Needed for 1099s' })}
    ${selectField('Terms', 'termsId', terms.map(t => [t.terms_id, t.name]), v.termsId, { blank: '—' })}
    ${cur?.currencies.length ? (cur.locked
      ? html`<div class="field"><span>Currency</span><strong>${v.currency || 'USD (home)'}</strong><small class="muted">Fixed: there are transactions in it.</small></div>`
      : selectField('Currency', 'currency', cur.currencies.map(c => [c.code, `${c.code} — ${c.name}`]), v.currency, { blank: 'USD (home currency)' })) : ''}
    ${field('Account no.', 'accountNo', v.accountNo, { hint: 'Your account number with this vendor' })}
    ${selectField('Default expense category', 'defaultExpenseAccountId', expenseAccounts.map(a => [a.account_id, accountLabel(a)]), v.defaultExpenseAccountId, { blank: '—' })}
    ${field('Billing rate (/hr)', 'billingRate', v.billingRate, { attrs: 'inputmode="decimal"' })}
    ${vendor ? '' : html`${field('Opening balance', 'openingBalance', v.openingBalance ?? '', { attrs: 'inputmode="decimal"', hint: 'What you already owe this vendor' })}
      ${field('As of', 'openingAsOf', v.openingAsOf ?? '', { type: 'date' })}`}
  </div>
  <div class="checks">
    ${checkbox('Track payments for 1099', 'track1099', v.track1099)}
    ${vendor?.tax_id_last4 ? checkbox('Remove the saved tax ID', 'clearTaxId', v.clearTaxId) : ''}
    ${vendor ? checkbox('Active', 'active', v.active) : ''}
  </div>
  <div class="form-actions"><a href="${back}">Cancel</a><button class="primary">Save vendor</button></div>
</form>`,
  });
}

// ---- merge, import, batch email ----

export function mergePage({ entityName, csrf, vendor, choices, counts, error = null }) {
  return layout({
    title: `Merge ${vendor.display_name}`, entityName, csrf,
    body: html`<div class="crumbs"><a href="/vendors/${vendor.vendor_id}">‹ ${vendor.display_name}</a></div>
<form method="post" action="/vendors/${vendor.vendor_id}/merge" class="card editor">
  ${csrfField(csrf)}
  <h1>Merge ${vendor.display_name}</h1>
  ${errorBanner(error)}
  <p>Everything on <strong>${vendor.display_name}</strong> — ${plural(counts.transactions, 'transaction')}, ${plural(counts.documents, 'document')}, and its history —
    moves to the vendor you pick. Then <strong>${vendor.display_name}</strong> is deleted. This can’t be undone.</p>
  <div class="form-grid">
    ${selectField('Keep this vendor', 'into', choices.filter(c => c.vendor_id !== vendor.vendor_id).map(c => [c.vendor_id, c.display_name + (c.active ? '' : ' (inactive)')]), '', { blank: 'Choose…' })}
  </div>
  <div class="form-actions"><a href="/vendors/${vendor.vendor_id}">Cancel</a>
    <button class="danger" data-confirm="Merge ${vendor.display_name} and delete it? This can’t be undone.">Merge vendors</button></div>
</form>`,
  });
}

export function importPage({ entityName, csrf, headers, csv = '', preview = null, error = null }) {
  const good = preview ? preview.rows.filter(r => !r.error).length : 0;
  return layout({
    title: 'Import vendors', entityName, csrf, wide: Boolean(preview),
    body: html`<div class="crumbs"><a href="/vendors">‹ Vendors</a></div>
<section class="card editor">
  <h1>Import vendors</h1>
  ${errorBanner(error)}
  <p class="muted">Upload a CSV file or paste it below. The first row names the columns. Recognized columns: ${headers.join(', ')}
    (plus Street 2, Country, Fax, Website, Name on check). Only “Name” is required. Bank details and tax IDs aren’t imported; add those on each vendor.</p>
  <form method="post" action="/vendors/import" enctype="multipart/form-data" class="upload">
    ${csrfField(csrf)}
    <div class="form-grid">
      <label class="field"><span>CSV file</span><input type="file" name="file" accept=".csv,text/csv"></label>
    </div>
    <label class="field wide"><span>…or paste CSV</span><textarea name="csv" rows="${preview ? 4 : 8}">${csv}</textarea></label>
    <div class="form-actions"><button name="step" value="preview">Check the file</button></div>
  </form>
  ${preview ? html`<h2 class="section-title">${good} of ${preview.rows.length} rows ready to import</h2>
  ${preview.unknownHeaders.length ? html`<p class="muted">Ignored columns: ${preview.unknownHeaders.join(', ')}</p>` : ''}
  <table class="grid">
    <thead><tr><th>Row</th><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th>City</th><th>Terms</th><th>1099</th><th>Problem</th></tr></thead>
    <tbody>${preview.rows.map(r => html`<tr class="${r.error ? 'inactive' : ''}">
      <td>${r.line}</td><td>${r.values.displayName}</td><td>${r.values.companyName}</td><td>${r.values.email}</td><td>${r.values.phone}</td>
      <td>${r.values.city}</td><td>${r.values.terms}</td><td>${r.values.track1099 ? 'Yes' : ''}</td>
      <td>${r.error ? html`<span class="status bad">${r.error}</span>` : html`<span class="status good">Ready</span>`}</td></tr>`)}</tbody>
  </table>
  ${good ? html`<form method="post" action="/vendors/import" class="form-actions">
    ${csrfField(csrf)}<input type="hidden" name="csv" value="${csv}">
    <a href="/vendors">Cancel</a><button class="primary" name="step" value="import">Import ${plural(good, 'vendor')}${good < preview.rows.length ? ', skip the rest' : ''}</button>
  </form>` : ''}` : ''}
</section>`,
  });
}

export function batchEmailPage({ entityName, csrf, vendors, v = { subject: '', body: '' }, error = null }) {
  const reachable = vendors.filter(x => x.email);
  return layout({
    title: 'Email vendors', entityName, csrf,
    body: html`<div class="crumbs"><a href="/vendors">‹ Vendors</a></div>
<form method="post" action="/vendors/email" class="card editor">
  ${csrfField(csrf)}
  <h1>Email ${plural(reachable.length, 'vendor')}</h1>
  ${errorBanner(error)}
  ${vendors.map(x => html`<input type="hidden" name="ids" value="${x.vendor_id}">`)}
  <p>${reachable.map(x => x.display_name).join(', ') || 'None of the selected vendors has an email address.'}</p>
  ${vendors.length > reachable.length ? html`<p class="muted">No email address, skipped: ${vendors.filter(x => !x.email).map(x => x.display_name).join(', ')}</p>` : ''}
  ${field('Subject', 'subject', v.subject, { required: true, cls: 'wide' })}
  <label class="field wide"><span>Message</span><textarea name="body" rows="8" required>${v.body}</textarea></label>
  <div class="form-actions"><a href="/vendors">Cancel</a><button class="primary"${reachable.length ? '' : html` disabled data-keep-disabled`}>Send</button></div>
</form>`,
  });
}
