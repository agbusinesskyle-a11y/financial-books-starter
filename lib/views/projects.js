import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, postButton } from './forms.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { txnStatus, TYPE_LABELS } from '../domain/status.js';
import { PROJECT_STATUSES, STATUS_LABELS } from '../domain/projects.js';

export const projectToValues = p => ({ name: p.name, status: p.status, startDate: p.start_date ?? '', endDate: p.end_date ?? '', description: p.description ?? '' });
export const projectFormValues = params => Object.fromEntries(['name', 'status', 'startDate', 'endDate', 'description'].map(k => [k, params.get(k) ?? '']));
const NEW_PROJECT = { name: '', status: 'in_progress', startDate: '', endDate: '', description: '' };

function projectFields(v) {
  return html`<div class="form-grid">
    ${field('Project name', 'name', v.name, { required: true })}
    ${selectField('Status', 'status', PROJECT_STATUSES, v.status)}
    ${field('Start date', 'startDate', v.startDate, { type: 'date' })}
    ${field('End date', 'endDate', v.endDate, { type: 'date' })}
    ${field('Description', 'description', v.description, { cls: 'wide' })}
  </div>`;
}

const dates = p => [p.start_date && formatShortDate(p.start_date), p.end_date && formatShortDate(p.end_date)].filter(Boolean).join(' – ');

export function projectsTab({ customer: c, csrf, projects, projectForm = null }) {
  const f = projectForm ?? { v: NEW_PROJECT, error: null };
  return html`<details class="compose"${projectForm ? html` open` : ''}>
  <summary class="button primary">New project</summary>
  <form method="post" action="/customers/${c.customer_id}/projects" class="editor">
    ${csrfField(csrf)}
    ${errorBanner(f.error)}
    ${projectFields(f.v)}
    <div class="form-actions"><button class="primary">Create project</button></div>
  </form>
</details>
${projects.length ? html`<table class="grid">
  <thead><tr><th>Project</th><th>Status</th><th>Dates</th><th class="num">Invoiced</th><th class="num">Paid</th><th class="num">Open</th></tr></thead>
  <tbody>${projects.map(p => html`<tr class="${p.status === 'in_progress' ? '' : 'inactive'}">
    <td><a href="/projects/${p.project_id}">${p.name}</a>${p.description ? html`<br><span class="muted">${p.description}</span>` : ''}</td>
    <td>${STATUS_LABELS[p.status]}</td>
    <td>${dates(p) || '—'}</td>
    <td class="num">${formatCents(p.invoiced_cents)}</td>
    <td class="num">${formatCents(p.paid_cents)}</td>
    <td class="num">${formatCents(p.open_cents)}</td>
  </tr>`)}</tbody>
</table>` : html`<p class="muted section-title">No projects for ${c.display_name}. Use projects to group a job’s invoices and see what each job has billed and collected.</p>`}`;
}

export function projectPage({ entityName, csrf, flash = null, project: p, txns, costs = { rows: [], totalCents: 0 }, today, v = projectToValues(p), error = null }) {
  return layout({
    title: p.name, entityName, csrf, flash,
    body: html`<div class="crumbs page-actions"><a href="/customers/${p.customer_id}?tab=projects">‹ ${p.customer_name}</a><span class="spacer"></span>
  <a class="button primary" href="/txns/new?type=invoice&customer=${p.customer_id}&project=${p.project_id}">New invoice for this project</a></div>
<section class="card">
  <div class="card-head"><h1>${p.name}</h1><span class="tag">${STATUS_LABELS[p.status]}</span></div>
  <dl class="details project-totals">
    <div><dt>Invoiced</dt><dd>${formatCents(p.invoiced_cents)}</dd></div>
    <div><dt>Paid</dt><dd>${formatCents(p.paid_cents)}</dd></div>
    <div><dt>Open</dt><dd>${formatCents(p.open_cents)}</dd></div>
    ${p.credit_cents ? html`<div><dt>Credits</dt><dd>${formatCents(p.credit_cents)}</dd></div>` : ''}
    <div><dt>Costs</dt><dd>${formatCents(costs.totalCents)}</dd></div>
    <div><dt>Profit</dt><dd class="${p.invoiced_cents - p.credit_cents - costs.totalCents < 0 ? 'negative' : ''}">${formatCents(p.invoiced_cents - p.credit_cents - costs.totalCents)}</dd></div>
  </dl>
  <h2>Transactions</h2>
  ${txns.length ? html`<table class="grid">
    <thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Memo</th><th class="num">Amount</th><th>Status</th></tr></thead>
    <tbody>${txns.map(t => { const s = txnStatus(t, today); return html`<tr>
      <td>${formatShortDate(t.txn_date)}</td><td>${TYPE_LABELS[t.type]}</td>
      <td><a href="/txns/${t.txn_id}">${t.doc_number ?? t.payment_ref ?? 'View'}</a></td>
      <td class="memo">${t.memo ?? ''}</td><td class="num">${formatCents(t.total_cents)}</td>
      <td><span class="status ${s.tone}">${s.text}</span></td></tr>`; })}</tbody>
  </table>` : html`<p class="muted">No transactions yet. Choose this project when you create or edit an invoice.</p>`}
  <h2 class="section-title">Costs</h2>
  ${costs.rows.length ? html`<table class="grid">
    <thead><tr><th>Date</th><th>Type</th><th>Vendor</th><th>Category</th><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>${costs.rows.map(r => html`<tr><td>${formatShortDate(r.txn_date)}</td><td><a href="/vtxns/${r.txn_id}">${TYPE_LABELS[r.type]} ${r.doc_number ?? ''}</a></td>
      <td>${r.vendor_name ?? ''}</td><td>${r.category ?? ''}</td><td class="memo">${r.description ?? ''}</td><td class="num">${formatCents(r.amount_cents)}</td></tr>`)}</tbody>
  </table>` : html`<p class="muted">No costs yet. Pick this project on a bill, expense or check line.</p>`}
  <details class="compose section-title"${error ? html` open` : ''}>
    <summary class="button">Edit project</summary>
    <form method="post" action="/projects/${p.project_id}" class="editor">
      ${csrfField(csrf)}
      ${errorBanner(error)}
      ${projectFields(v)}
      <div class="form-actions">
        <button class="primary">Save project</button>
      </div>
    </form>
  </details>
  <div class="txn-actions section-title">${postButton({ action: `/projects/${p.project_id}/delete`, csrf, label: 'Delete project', cls: 'danger', confirm: `Delete the project “${p.name}”?` })}</div>
</section>`,
  });
}
