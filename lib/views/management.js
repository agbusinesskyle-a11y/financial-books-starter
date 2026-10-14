import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, selectField, field, errorBanner } from './forms.js';
import { PERIODS } from '../reports/periods.js';
import { REPORTS, GROUPS, reportByKey } from '../reports/registry.js';
import { formatShortDate } from '../domain/dates.js';

const FREQ = [['none', 'Not scheduled'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const textarea = (label, name, value, rows = 4) => html`<label class="field"><span>${label}</span><textarea name="${name}" rows="${rows}">${value ?? ''}</textarea></label>`;

// Reports → Management reports: the packages, and a new one from a template.
export function managementListPage({ entityName, csrf, flash, packages, templates }) {
  return layout({
    title: 'Management reports', entityName, csrf, flash,
    body: html`<div class="crumbs"><a href="/reports">‹ Reports</a></div>
<h1>Management reports</h1>
<p class="muted">A package of reports for one period — cover page, contents, your notes and the reports you choose — as one PDF you can send on a schedule.</p>
<form method="post" action="/reports/management" class="card stack-form">${csrfField(csrf)}
  ${selectField('Start from', 'template', templates.map(([k, label]) => [k, label]), 'company_overview')}
  <button class="primary">Create</button>
</form>
${packages.length ? html`<section class="card"><table class="grid"><thead><tr><th>Name</th><th>Status</th><th>Period</th><th>Reports</th><th>Schedule</th><th></th></tr></thead><tbody>
  ${packages.map(p => html`<tr>
    <td data-label="Name"><a href="/reports/management/${p.mgmt_id}">${p.name}</a></td>
    <td data-label="Status">${p.status === 'published' ? 'Published' : 'Draft'}</td>
    <td data-label="Period">${PERIODS.find(([k]) => k === p.period)?.[1] ?? p.period}</td>
    <td data-label="Reports">${p.sections.length}</td>
    <td data-label="Schedule">${p.sched_freq === 'none' ? '—' : `${p.sched_freq}${p.sched_next ? `, next ${formatShortDate(p.sched_next)}` : ''}`}${p.last_error ? html`<br><span class="error small">Last send failed: ${p.last_error}</span>` : ''}</td>
    <td class="actions"><a href="/reports/management/${p.mgmt_id}.pdf" target="_blank" rel="noopener">PDF</a></td>
  </tr>`)}</tbody></table></section>` : ''}`,
  });
}

function reportChoices(savedReports) {
  return html`<option value="">Add a report…</option>
    ${GROUPS.map(([g, title]) => html`<optgroup label="${title}">${REPORTS.filter(r => r.group === g && !r.adminOnly).map(r => html`<option value="${r.key}">${r.title}</option>`)}</optgroup>`)}
    ${savedReports.length ? html`<optgroup label="Custom reports">${savedReports.map(s => html`<option value="${`saved:${s.saved_id}`}">${s.name}</option>`)}</optgroup>` : ''}`;
}

export function managementEditPage({ entityName, csrf, flash = null, mg, savedReports, error = null }) {
  return layout({
    title: mg.name, entityName, csrf, flash,
    body: html`<div class="crumbs page-actions"><a href="/reports/management">‹ Management reports</a><span class="spacer"></span>
  <a class="button" href="/reports/management/${mg.mgmt_id}.pdf" target="_blank" rel="noopener">View PDF</a></div>
<form method="post" action="/reports/management/${mg.mgmt_id}" class="card stack-form mgmt-form">${csrfField(csrf)}
  <button class="visually-hidden" name="action" value="save" tabindex="-1" aria-hidden="true">Save</button>
  <h1>${mg.name}</h1>
  ${errorBanner(error)}
  ${field('Name', 'name', mg.name, { required: true })}
  <div class="option-row">
    ${selectField('Status', 'status', [['draft', 'Draft'], ['published', 'Published']], mg.status)}
    ${selectField('Period', 'period', PERIODS.filter(([k]) => k !== 'custom'), mg.period)}
    ${selectField('Accounting method', 'basis', [['accrual', 'Accrual'], ['cash', 'Cash']], mg.basis)}
  </div>
  <h2>Cover page</h2>
  ${field('Title', 'cover_title', mg.cover_title ?? '')}
  ${field('Subtitle', 'cover_subtitle', mg.cover_subtitle ?? '')}
  ${field('Prepared by', 'prepared_by', mg.prepared_by ?? '')}
  ${textarea('Introduction (its own page after the contents)', 'intro', mg.intro)}
  <h2>Reports</h2>
  <ol class="mgmt-sections">${mg.sections.map((s, i) => html`<li>
    <input type="hidden" name="sec_key" value="${s.key}"><input type="hidden" name="sec_query" value="${s.query}">
    <p class="muted small">${reportByKey(s.key)?.title ?? s.key}${s.query ? ' · with its own settings' : ''}</p>
    ${field('Title in the package', 'sec_title', s.title || reportByKey(s.key)?.title || '')}
    ${textarea('Note under this report', 'sec_note', s.note, 2)}
    <p class="section-actions">${i > 0 ? html`<button class="link" name="action" value="${`up:${i}`}">Move up</button>` : ''}
      <button class="link" name="action" value="${`remove:${i}`}">Remove</button></p>
  </li>`)}</ol>
  ${mg.sections.length ? '' : html`<p class="muted">No reports yet. Add the first one below.</p>`}
  <div class="option-row"><label class="field"><span>Add a report</span><select name="add_key">${reportChoices(savedReports)}</select></label>
    <button name="action" value="add">Add</button></div>
  ${textarea('Closing notes (last page)', 'closing', mg.closing)}
  <h2>Email on a schedule</h2>
  <div class="option-row">
    ${selectField('Send', 'freq', FREQ, mg.sched_freq)}
    ${selectField('Weekly on', 'day_week', WEEKDAYS.map((d, i) => [String(i), d]), mg.sched_freq === 'weekly' ? String(mg.sched_day) : '1')}
    ${selectField('Monthly on', 'day_month', Array.from({ length: 28 }, (_, i) => [String(i + 1), `Day ${i + 1}`]), mg.sched_freq === 'monthly' ? String(mg.sched_day) : '1')}
  </div>
  ${field('To', 'to', mg.sched_to ?? '', { hint: 'Email addresses, separated by commas. Only published reports are sent.' })}
  <p><button class="primary" name="action" value="save">Save</button></p>
</form>
<form method="post" action="/reports/management/${mg.mgmt_id}/delete" class="inline" data-confirm="${`Delete “${mg.name}”?`}">${csrfField(csrf)}<button class="link danger">Delete this management report</button></form>`,
  });
}

// Create a custom KPI: a formula over the built-in measures.
export function kpiFormPage({ entityName, csrf, builtIn, v, error = null }) {
  return layout({
    title: 'Create KPI', entityName, csrf,
    body: html`<div class="crumbs"><a href="/reports/r/kpi_scorecard">‹ KPI scorecard</a></div>
<form method="post" action="/reports/kpis" class="card stack-form">${csrfField(csrf)}
  <h1>Create KPI</h1>
  ${errorBanner(error)}
  ${field('Name', 'name', v.name ?? '', { required: true })}
  ${field('Category', 'category', v.category ?? 'Custom')}
  ${field('Description', 'description', v.description ?? '')}
  <div class="option-row">
    ${selectField('Shown as', 'unit', [['money', 'Money'], ['percent', 'Percent'], ['number', 'Number']], v.unit ?? 'percent')}
    ${selectField('Good when it', 'direction', [['up', 'Goes up'], ['down', 'Goes down']], v.direction ?? 'up')}
  </div>
  ${field('Formula', 'formula', v.formula ?? '', { required: true, hint: 'Use the names below with + − × ÷ and brackets. Money is in dollars, percentages as numbers (42.5).' })}
  <details><summary>Names you can use</summary><ul class="kpi-names">${builtIn.map(([k, label, , unit]) => html`<li><code>${k}</code> ${label} <span class="muted">(${unit})</span></li>`)}</ul></details>
  <p class="muted small">Example: <code>net_income / revenue * 100</code> shown as Percent; <code>revenue - total_expenses</code> shown as Money.</p>
  <button class="primary">Add to scorecard</button>
</form>`,
  });
}

