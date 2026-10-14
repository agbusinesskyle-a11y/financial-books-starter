import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, postButton } from './forms.js';
import { formatCents, centsToInput } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { formatDateTime } from './format.js';
import { TYPE_LABELS } from '../domain/status.js';
import { IMPORTS } from '../data/imports.js';
import { SUBDIVIDE, periodLabel } from '../data/budgets.js';

const crumbs = html`<div class="crumbs"><a href="/tools">‹ Tools</a></div>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- import / export ----

export function importChooser({ entityName, csrf }) {
  return layout({
    title: 'Import', entityName, csrf,
    body: html`${crumbs}<section class="card"><h1>Import</h1><ul class="link-list">
  ${Object.entries(IMPORTS).map(([key, s]) => html`<li><a href="/import/${key}"><strong>${s.label}</strong><small class="muted">Columns: ${s.headers.join(', ')}</small></a></li>`)}
  <li><a href="/vendors/import"><strong>Vendors</strong><small class="muted">On the Vendors page</small></a></li>
</ul></section>`,
  });
}

export function importPage({ entityName, csrf, kind, csv = '', preview = null, error = null }) {
  const s = IMPORTS[kind];
  const good = preview ? preview.rows.filter(r => !r.error).length : 0;
  return layout({
    title: `Import ${s.label.toLowerCase()}`, entityName, csrf, wide: Boolean(preview),
    body: html`<div class="crumbs"><a href="/import">‹ Import</a></div>
<section class="card editor">
  <h1>Import ${s.label.toLowerCase()}</h1>
  ${errorBanner(error)}
  <p class="muted">Upload a CSV file or paste it. The first row names the columns: ${s.headers.join(', ')}. Only “${s.headers[0]}” is required.
    Nothing is saved until you check the rows and press Import.</p>
  <form method="post" action="/import/${kind}" enctype="multipart/form-data" class="upload">
    ${csrfField(csrf)}
    <label class="field"><span>CSV file</span><input type="file" name="file" accept=".csv,text/csv"></label>
    <label class="field wide"><span>…or paste CSV</span><textarea name="csv" rows="${preview ? 4 : 8}">${csv}</textarea></label>
    <div class="form-actions"><button name="step" value="preview">Check the file</button>
      ${good ? html`<button class="primary" name="step" value="import">Import ${good}${good < preview.rows.length ? ', skip the rest' : ''}</button>` : ''}</div>
  </form>
  ${preview ? html`<h2>${good} of ${preview.rows.length} rows ready</h2>
  ${preview.unknownHeaders.length ? html`<p class="muted">Ignored columns: ${preview.unknownHeaders.join(', ')}</p>` : ''}
  <table class="grid">
    <thead><tr><th>Row</th>${preview.previewHeads.map(h => html`<th>${h}</th>`)}<th>Check</th></tr></thead>
    <tbody>${preview.rows.map(r => html`<tr><td data-label="Row">${r.line}</td>
      ${r.cells.map((c, i) => html`<td data-label="${preview.previewHeads[i]}">${c ?? ''}</td>`)}
      <td data-label="Check">${r.error ? html`<span class="status bad">${r.error}</span>` : html`<span class="status good">Ready</span>`}</td></tr>`)}</tbody>
  </table>` : ''}
</section>`,
  });
}

export function exportPage({ entityName, csrf, documentCount }) {
  return layout({
    title: 'Export', entityName, csrf,
    body: html`${crumbs}<section class="card"><h1>Export</h1>
  <p class="muted">Everything in the books, to keep or to take elsewhere.</p>
  <ul class="link-list">
    <li><a href="/export/books.xlsx" download><strong>All lists and transactions (Excel)</strong>
      <small class="muted">Customers, vendors, products and services, chart of accounts, every transaction with its lines, and the general ledger</small></a></li>
    <li><a href="/export/documents.zip" download><strong>All attachments (ZIP)</strong><small class="muted">${plural(documentCount, 'document')}, a folder per customer or vendor</small></a></li>
  </ul></section>`,
  });
}

// ---- all recurring / all attachments ----

const every = r => (r.mode === 'unscheduled' ? 'Unscheduled' : `Every ${r.interval_count === 1 ? '' : `${r.interval_count} `}${r.interval_unit}${r.interval_count === 1 ? '' : 's'}`);

export function allRecurringPage({ entityName, csrf, templates }) {
  return layout({
    title: 'All recurring', entityName, csrf,
    body: html`${crumbs}<section class="card"><h1>All recurring transactions</h1>
  ${templates.length ? html`<table class="grid">
    <thead><tr><th>Name</th><th>Type</th><th>For</th><th>How often</th><th>Next</th><th class="num">Amount</th><th>Status</th></tr></thead>
    <tbody>${templates.map(t => html`<tr>
      <td data-label="Name"><a href="${t.vendor_id ? `/vrecurring/${t.template_id}` : `/recurring/${t.template_id}/edit`}">${t.name}</a></td>
      <td data-label="Type">${TYPE_LABELS[t.txn_type]}</td>
      <td data-label="For">${t.vendor_id ? html`<a href="/vendors/${t.vendor_id}">${t.vendor_name}</a>` : html`<a href="/customers/${t.customer_id}">${t.customer_name}</a>`}</td>
      <td data-label="How often">${every(t)}${t.mode === 'reminder' ? ' (reminder)' : ''}</td>
      <td data-label="Next">${t.next_run_date && t.active ? formatShortDate(t.next_run_date) : '—'}</td>
      <td class="num" data-label="Amount">${formatCents(t.total_cents)}</td>
      <td data-label="Status">${t.active ? html`<span class="status good">Active</span>` : html`<span class="status muted">Paused</span>`}</td></tr>`)}</tbody>
  </table>` : html`<p class="muted">No recurring templates yet. Make one from a customer’s or vendor’s Recurring tab.</p>`}
</section>`,
  });
}

export function allAttachmentsPage({ entityName, csrf, documents, filters, timeZone }) {
  return layout({
    title: 'All attachments', entityName, csrf, wide: true,
    body: html`${crumbs}<section class="card"><div class="card-head"><h1>All attachments</h1><a class="button" href="/export/documents.zip" download>Download all (ZIP)</a></div>
  <form method="get" action="/attachments" class="filters">
    <label>Search <input name="q" value="${filters.q}" placeholder="File, note or name"></label>
    <label>Whose<select name="party">${[['', 'Everyone'], ['customers', 'Customers'], ['vendors', 'Vendors']].map(([k, l]) => html`<option value="${k}"${k === filters.party ? html` selected` : ''}>${l}</option>`)}</select></label>
    <button>Filter</button>
  </form>
  ${documents.length ? html`<table class="grid">
    <thead><tr><th>File</th><th>Customer / vendor</th><th>Transaction</th><th>Note</th><th>Added</th><th class="num">Size</th></tr></thead>
    <tbody>${documents.map(d => html`<tr>
      <td data-label="File"><a href="/documents/${d.document_id}" download>${d.filename}</a></td>
      <td data-label="Whose">${d.customer_id ? html`<a href="/customers/${d.customer_id}?tab=documents">${d.customer_name}</a>` : d.vendor_id ? html`<a href="/vendors/${d.vendor_id}?tab=documents">${d.vendor_name}</a>` : ''}</td>
      <td data-label="Transaction">${d.txn_id ? html`<a href="/txns/${d.txn_id}">${TYPE_LABELS[d.txn_type]} ${d.doc_number ?? d.payment_ref ?? ''}</a>` : ''}</td>
      <td data-label="Note">${d.note ?? ''}</td>
      <td data-label="Added">${formatDateTime(d.uploaded_at, timeZone)} · ${d.uploaded_by}</td>
      <td class="num" data-label="Size">${Math.max(1, Math.round(d.size_bytes / 1024))} KB</td></tr>`)}</tbody>
  </table>` : html`<p class="muted">Nothing found.</p>`}
</section>`,
  });
}

// ---- budgets ----

export function budgetsPage({ entityName, csrf, flash = null, budgets }) {
  return layout({
    title: 'Budgets', entityName, csrf, flash,
    body: html`${crumbs}<section class="card"><div class="card-head"><h1>Budgets</h1><a class="button primary" href="/budgets/new">New budget</a></div>
  ${budgets.length ? html`<table class="grid"><thead><tr><th>Name</th><th>Fiscal year</th><th>Split by</th><th class="num">Total</th></tr></thead>
    <tbody>${budgets.map(b => html`<tr><td data-label="Name"><a href="/budgets/${b.budget_id}">${b.name}</a></td><td data-label="Year">FY${b.fiscal_year}</td>
      <td data-label="Split by">${SUBDIVIDE.find(([k]) => k === b.subdivide)[1]}</td><td class="num" data-label="Total">${formatCents(b.total_cents)}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">No budgets yet.</p>`}
</section>`,
  });
}

export function newBudgetPage({ entityName, csrf, v, budgets, error = null }) {
  return layout({
    title: 'New budget', entityName, csrf,
    body: html`<div class="crumbs"><a href="/budgets">‹ Budgets</a></div>
<form method="post" action="/budgets" class="card editor">
  ${csrfField(csrf)}<h1>New budget</h1>
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Name', 'name', v.name, { required: true })}
    ${field('Fiscal year', 'fiscalYear', v.fiscalYear, { attrs: 'inputmode="numeric"', hint: 'The year it ends in (it starts in the month set in Settings → Accounting).' })}
    ${selectField('Split by', 'subdivide', SUBDIVIDE, v.subdivide)}
    ${selectField('Start from', 'startFrom', [['blank', 'Blank'], ['actuals', 'Last year’s actual amounts'], ...budgets.map(b => [`budget:${b.budget_id}`, `Copy “${b.name}”`])], v.startFrom)}
  </div>
  <div class="form-actions"><a href="/budgets">Cancel</a><button class="primary">Create budget</button></div>
</form>`,
  });
}

// The grid: accounts × 12 fiscal months; actual amounts beside each when asked.
export function budgetGrid({ entityName, csrf, flash = null, budget: b, accounts, amounts, actual = null, dims, dimId, error = null, typed = null }) {
  // typed: { "accountId:period": text } from a save that failed, shown again as typed.
  const cellValue = (id, p) => (typed && Object.hasOwn(typed, `${id}:${p}`) ? typed[`${id}:${p}`]
    : amounts.has(`${id}:${p}`) ? centsToInput(amounts.get(`${id}:${p}`)) : '');
  const periods = Array.from({ length: 12 }, (_, i) => i + 1);
  const total = id => periods.reduce((s, p) => s + (amounts.get(`${id}:${p}`) ?? 0), 0);
  const actualTotal = id => periods.reduce((s, p) => s + (actual?.get(`${id}:${p}`) ?? 0), 0);
  const needsDim = b.subdivide !== 'none';
  const base = `/budgets/${b.budget_id}`;
  const q = more => `?${new URLSearchParams({ ...(dimId ? { dim: String(dimId) } : {}), ...more })}`;
  return layout({
    title: b.name, entityName, csrf, flash, wide: true,
    body: html`<div class="crumbs page-actions"><a href="/budgets">‹ Budgets</a><span class="spacer"></span>
  <a class="button" href="${base}${q(actual ? {} : { actuals: '1' })}">${actual ? 'Hide actuals' : 'Show actuals'}</a>
  ${postButton({ action: `${base}/delete`, csrf, label: 'Delete', cls: 'button danger', confirm: `Delete the budget “${b.name}”?` })}</div>
<section class="card">
  <h1>${b.name} <small class="muted">FY${b.fiscal_year}</small></h1>
  ${errorBanner(error)}
  ${needsDim ? html`<form method="get" action="${base}" class="filters"><label>${SUBDIVIDE.find(([k]) => k === b.subdivide)[1]}
    <select name="dim" data-autosubmit><option value="">Choose…</option>${dims.map(d => html`<option value="${d.id}"${Number(d.id) === dimId ? html` selected` : ''}>${d.name}</option>`)}</select></label>
    ${actual ? html`<input type="hidden" name="actuals" value="1">` : ''}<noscript><button>Show</button></noscript></form>` : ''}
  ${needsDim && !dimId ? html`<p class="muted">Choose which one to budget for.</p>` : html`<form method="post" action="${base}${q(actual ? { actuals: '1' } : {})}">
    ${csrfField(csrf)}
    <div class="budget-wrap"><table class="grid budget">
      <thead><tr><th>Account</th>${periods.map(p => html`<th class="num">${periodLabel(b, p)}</th>`)}<th class="num">Total</th></tr></thead>
      <tbody>${accounts.map(a => html`<tr>
        <th scope="row" data-label="">${a.number ? `${a.number} · ` : ''}${a.name}</th>
        ${periods.map(p => html`<td class="num" data-label="${periodLabel(b, p)}"><input name="c_${a.account_id}_${p}" value="${cellValue(a.account_id, p)}"
          inputmode="decimal" size="8" aria-label="${a.name}, ${periodLabel(b, p)}">${actual ? html`<small class="muted actual">${formatCents(actual.get(`${a.account_id}:${p}`) ?? 0)}</small>` : ''}</td>`)}
        <td class="num" data-label="Total"><strong>${formatCents(total(a.account_id))}</strong>${actual ? html`<small class="muted actual">${formatCents(actualTotal(a.account_id))}</small>` : ''}</td>
      </tr>`)}</tbody>
    </table></div>
    ${actual ? html`<p class="muted small">Grey figures are actual amounts from the books.</p>` : ''}
    <div class="form-actions"><button class="primary">Save budget</button></div>
  </form>`}
</section>`,
  });
}
