import { html, raw } from './html.js';
import { layout } from './layout.js';
import { csrfField, selectField, checkbox, field, errorBanner } from './forms.js';
import { linkOf } from './accounts.js';
import { bars } from './charts.js';
import { PERIODS } from '../reports/periods.js';
import { GROUPS, REPORTS, ALIASES, reportByKey } from '../reports/registry.js';
import { COLUMNS_BY, COMPARE, PERCENTS, optionsQuery, drillHref, hasColumns } from '../reports/engine.js';
import { SECTION_TITLES } from '../reports/customize.js';
import { cellText, detailText, fmtOf } from '../reports/output.js';
import { formatShortDate } from '../domain/dates.js';
import { ACCOUNT_TYPES } from '../domain/ledger.js';

const star = ({ key, on, csrf, back }) => html`<form method="post" action="/reports/favorite" class="inline fav">${csrfField(csrf)}
  <input type="hidden" name="key" value="${key}"><input type="hidden" name="next" value="${back}">
  <button class="link star${on ? ' on' : ''}" title="${on ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${on ? 'true' : 'false'}">${on ? '★' : '☆'}<span class="visually-hidden">${on ? 'Favorite' : 'Add to favorites'}</span></button></form>`;

// Reports: favorites first, then custom reports, then each group; ?q= narrows by title or description.
export function reportsListPage({ entityName, csrf, flash, favorites, q = '', canFavorite = true, saved = [] }) {
  const needle = q.trim().toLowerCase();
  const matches = r => !needle || `${r.title} ${r.about} ${ALIASES[r.key] ?? ''}`.toLowerCase().includes(needle);
  const back = needle ? `/reports?q=${encodeURIComponent(q)}` : '/reports';
  const item = r => html`<li class="report-item">${canFavorite ? star({ key: r.key, on: favorites.has(r.key), csrf, back }) : ''}
    <a href="/reports/r/${r.key}"><strong>${r.title}</strong><small class="muted">${r.about}</small></a></li>`;
  const favs = REPORTS.filter(r => favorites.has(r.key) && matches(r));
  const mine = saved.filter(s => !needle || `${s.name} ${s.group_name ?? ''}`.toLowerCase().includes(needle));
  const groups = GROUPS.map(([g, title]) => [title, REPORTS.filter(r => r.group === g && matches(r))]).filter(([, rs]) => rs.length);
  return layout({
    title: 'Reports', entityName, csrf, flash,
    body: html`<div class="card-head"><h1>Reports</h1>
  <form method="get" action="/reports" class="search" role="search"><input type="search" name="q" value="${q}" placeholder="Find a report by name" aria-label="Find a report"><button>Find</button></form></div>
<p class="report-tools"><a class="button" href="/reports/custom">Custom reports${saved.length ? ` (${saved.length})` : ''}</a>
  <a class="button" href="/reports/management">Management reports</a> <a class="button" href="/reports/r/kpi_scorecard">KPI scorecard</a>
  <a class="button" href="/reports/dashboards">Dashboards</a> <a class="button" href="/reports/cash-flow">Cash flow planner</a></p>
${favs.length ? html`<section class="card report-group"><h2>Favorites</h2><ul class="link-list reports">${favs.map(item)}</ul></section>` : ''}
${mine.length ? html`<section class="card report-group"><h2>Custom reports</h2><ul class="link-list reports">${mine.map(s => html`<li class="report-item">
  <a href="/reports/saved/${s.saved_id}"><strong>${s.name}</strong><small class="muted">${reportByKey(s.report_key)?.title ?? s.report_key}${s.group_name ? ` · ${s.group_name}` : ''}${s.shared ? ' · Shared' : ''}</small></a></li>`)}</ul></section>` : ''}
${groups.map(([title, rs]) => html`<section class="card report-group"><h2>${title}</h2><ul class="link-list reports">${rs.map(item)}</ul></section>`)}
${!favs.length && !groups.length && !mine.length ? html`<section class="card"><p>No report matches “${q}”.</p><p><a href="/reports">Show all reports</a></p></section>` : ''}`,
  });
}

const FREQ = [['none', 'Not scheduled'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const scheduleText = s => (s.sched_freq === 'none' ? '' : `${s.sched_freq === 'daily' ? 'Daily' : s.sched_freq === 'weekly' ? `Weekly on ${WEEKDAYS[s.sched_day]}` : `Monthly on day ${s.sched_day}`}`
  + ` to ${s.sched_to}${s.sched_next ? ` · next ${formatShortDate(s.sched_next)}` : ''}`);

// Reports → Custom reports: every saved report this person can see, by group, with its schedule.
export function customReportsPage({ entityName, csrf, flash, saved }) {
  const groups = [...new Set(saved.map(s => s.group_name ?? ''))];
  return layout({
    title: 'Custom reports', entityName, csrf, flash,
    body: html`<div class="crumbs"><a href="/reports">‹ Reports</a></div>
<div class="card-head"><h1>Custom reports</h1><a class="button" href="/reports/r/report_builder">Create new report</a></div>
${saved.length ? groups.map(g => html`<section class="card report-group"><h2>${g || 'Not in a group'}</h2>
  <table class="grid"><thead><tr><th>Name</th><th>Report</th><th>Created by</th><th>Access</th><th>Email schedule</th><th></th></tr></thead><tbody>
  ${saved.filter(s => (s.group_name ?? '') === g).map(s => html`<tr>
    <td data-label="Name"><a href="/reports/saved/${s.saved_id}">${s.name}</a></td>
    <td data-label="Report">${reportByKey(s.report_key)?.title ?? s.report_key}</td>
    <td data-label="Created by">${s.owner_name}</td>
    <td data-label="Access">${s.shared ? 'Shared' : 'Private'}</td>
    <td data-label="Email schedule">${scheduleText(s) || html`<span class="muted">—</span>`}${s.last_error ? html`<br><span class="error small">Last send failed: ${s.last_error}</span>` : ''}</td>
    <td class="actions">${s.editable ? html`<a href="/reports/saved/${s.saved_id}/edit">Edit</a>
      <form method="post" action="/reports/saved/${s.saved_id}/delete" class="inline" data-confirm="${`Delete “${s.name}”?`}">${csrfField(csrf)}<button class="link">Delete</button></form>` : ''}</td>
  </tr>`)}</tbody></table></section>`)
    : html`<section class="card"><p>No custom reports yet. Open any report, change its options, and use <strong>Save as</strong> to keep it here.</p></section>`}`,
  });
}

// Edit a saved report: name, sharing, group and its email schedule.
export function savedReportForm({ entityName, csrf, saved: s, v, error = null }) {
  const val = v ?? { name: s.name, shared: s.shared, group: s.group_name ?? '', freq: s.sched_freq, day: String(s.sched_day), to: s.sched_to ?? '', format: s.sched_format };
  return layout({
    title: `Edit ${s.name}`, entityName, csrf,
    body: html`<div class="crumbs"><a href="/reports/custom">‹ Custom reports</a></div>
<form method="post" action="/reports/saved/${s.saved_id}/edit" class="card stack-form">${csrfField(csrf)}
  <h1>${s.name}</h1>
  ${errorBanner(error)}
  ${field('Name', 'name', val.name, { required: true })}
  ${field('Group', 'group', val.group, { hint: 'Optional: reports with the same group are listed together.' })}
  ${checkbox('Share with everyone in the company', 'shared', val.shared)}
  <h2>Email on a schedule</h2>
  ${selectField('Send', 'freq', FREQ, val.freq)}
  <div class="option-row">${selectField('Weekly on', 'day_week', WEEKDAYS.map((d, i) => [String(i), d]), val.freq === 'weekly' ? val.day : '1')}
  ${selectField('Monthly on', 'day_month', Array.from({ length: 28 }, (_, i) => [String(i + 1), `Day ${i + 1}`]), val.freq === 'monthly' ? val.day : '1')}</div>
  ${field('To', 'to', val.to, { hint: 'Email addresses, separated by commas.' })}
  ${selectField('Attach as', 'format', [['pdf', 'PDF'], ['xlsx', 'Excel'], ['csv', 'CSV']], val.format)}
  <p class="muted small">Dates like “Last month” are worked out on the day it is sent.</p>
  <button class="primary">Save</button>
</form>`,
  });
}

const DEPTH = d => `d${Math.min(6, d ?? 0)}`;
const filterChoices = (map, any = 'Any') => [['', any], ...[...map].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([id, name]) => [String(id), name]), ['none', 'Not specified']];

function customizePanel(report) {
  const c = report.opts.custom ?? {};
  const pl = ['period'].includes(report.def.kind) || ['budget_overview', 'budget_vs_actuals'].includes(report.def.kind);
  const text = (label, name, value, hint = '') => field(label, `c_${name}`, value ?? '', { hint });
  const open = Object.keys(c).length ? raw(' open') : '';
  return html`<details class="more-options customize"${open}><summary>Customize</summary>
    <fieldset><legend>General</legend><div class="option-row">
      ${text('Report title', 'title', c.title)}
      ${selectField('Negative numbers', 'c_fmt_neg', [['minus', '-100'], ['paren', '(100)'], ['red', 'Red -100']], c.fmt_neg ?? 'minus')}
      ${selectField('Decimals', 'c_fmt_dec', [['2', '1,234.56'], ['0', '1,235']], c.fmt_dec ?? '2')}
      ${selectField('Show zero as', 'c_empty', [['zero', '0.00'], ['blank', 'Blank'], ['dash', 'Dash']], c.empty ?? 'zero')}
    </div><div class="option-row checks">${checkbox('Divide by 1000', 'c_fmt_div', c.fmt_div)} ${checkbox('No dollar sign', 'c_fmt_nosym', c.fmt_nosym)}</div></fieldset>
    ${report.detail ? '' : html`<fieldset><legend>Calculated column</legend><div class="option-row">
      ${text('Column name', 'calc_name', c.calc_name)}
      ${text('Formula', 'calc_formula', c.calc_formula, 'C1, C2… are the columns left to right, e.g. C1 - C2 or C1 / C2 * 100')}
      ${selectField('Show as', 'c_calc_type', [['money', 'Money'], ['percent', 'Percent'], ['number', 'Number']], c.calc_type ?? 'money')}
    </div></fieldset>`}
    ${pl ? html`<fieldset><legend>Section titles</legend><div class="option-row">
      ${SECTION_TITLES.map(([k, label]) => text(label, `t_${k}`, c[`t_${k}`]))}</div></fieldset>` : ''}
    <fieldset><legend>Header, footer and table</legend><div class="option-row checks">
      ${checkbox('Hide company name', 'c_hide_company', c.hide_company)} ${checkbox('Hide report period', 'c_hide_period', c.hide_period)}
      ${checkbox('Hide basis', 'c_hide_basis', c.hide_basis)} ${checkbox('Hide date prepared', 'c_hide_prepared', c.hide_prepared)}
      ${checkbox('Banded rows', 'c_banded', c.banded)}</div>
      <div class="option-row">${selectField('Header alignment', 'c_align', [['center', 'Center'], ['left', 'Left']], c.align ?? 'center')}
      ${selectField('Lines', 'c_grid', [['rows', 'Under totals'], ['none', 'None'], ['all', 'Every row']], c.grid ?? 'rows')}</div></fieldset>
  </details>`;
}

function optionsForm(report, { accounts }) {
  const { def, opts, names } = report;
  const fixed = !hasColumns(def);
  const single = f => (opts.filters[f].length === 1 ? (opts.filters[f][0] === null ? 'none' : String(opts.filters[f][0])) : '');
  const multi = f => opts.filters[f].length > 1;
  const accountNames = opts.filters.account.map(id => accounts.find(a => a.account_id === id)?.name).filter(Boolean);
  return html`<form method="get" action="/reports/r/${def.key}" class="card report-options" data-report-options>
  <input type="hidden" name="run" value="1">
  <input type="hidden" name="shown_from" value="${opts.from ?? ''}"><input type="hidden" name="shown_to" value="${opts.to}">
  ${(report.hiddenFields ?? []).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
  <div class="option-row">
    ${selectField('Report period', 'period', PERIODS, opts.period, { attrs: 'data-period' })}
    <label class="field"><span>From</span><input type="date" name="from" value="${opts.from ?? ''}" data-period-date></label>
    <label class="field"><span>To</span><input type="date" name="to" value="${opts.to}" data-period-date></label>
    ${selectField('Accounting method', 'basis', [['accrual', 'Accrual'], ['cash', 'Cash']], opts.basis)}
    ${fixed ? (def.timeColumns ? selectField('Display columns by', 'columns', COLUMNS_BY.filter(([k]) => ['total', 'days', 'weeks', 'months', 'quarters', 'years'].includes(k)), opts.columnsBy) : '')
      : selectField('Display columns by', 'columns', COLUMNS_BY, opts.columnsBy)}
    ${opts.aging ? html`${field('Days per aging period', 'aging_days', String(opts.aging.days), { type: 'number', attrs: 'min="1" max="365"' })}
      ${field('Number of periods', 'aging_periods', String(opts.aging.periods), { type: 'number', attrs: 'min="1" max="12"' })}` : ''}
    ${(report.extraFields ?? []).map(f => selectField(f.label, f.name, f.options, f.value))}
    ${selectField('Show rows', 'show', [['active', 'Active'], ['all', 'All'], ['non_zero', 'Non-zero']], opts.show)}
  </div>
  ${report.extraChecks ? html`<fieldset class="builder-columns"><legend>${report.extraChecks.label}</legend><div class="option-row checks">
    ${report.extraChecks.options.map(([name, label]) => html`<label class="check"><input type="checkbox" name="${name}" value="1"${report.extraChecks.checked.has(name) ? raw(' checked') : ''}> ${label}</label>`)}
  </div></fieldset>` : ''}
  ${fixed ? '' : html`<details class="more-options"${opts.compare.length || opts.percents.length ? raw(' open') : ''}><summary>Compare and percentages</summary>
    <div class="option-row checks">
      ${COMPARE.filter(([k]) => def.kind !== 'asof' || k === 'pp' || k === 'py').map(([k, label]) => checkbox(label, `cmp_${k}`, opts.compare.includes(k)))}
      ${checkbox('$ change', 'chg', opts.change)} ${checkbox('% change', 'pchg', opts.pctChange)}
    </div>
    <div class="option-row checks">${PERCENTS.filter(([k]) => def.kind !== 'asof' || k === 'row' || k === 'col').map(([k, label]) => checkbox(label, `pct_${k}`, opts.percents.includes(k)))}</div>
  </details>`}
  <details class="more-options"${['customer', 'vendor', 'project', 'item', 'class', 'location', 'tag'].some(f => opts.filters[f].length) || opts.accountTypes.length ? raw(' open') : ''}><summary>Filters</summary>
    <div class="option-row">
      ${[['customer', 'Customer', names.customers], ['vendor', 'Vendor', names.vendors], ['project', 'Project', names.projects], ['item', 'Product/Service', names.items], ['class', 'Class', names.classes],
        ['location', 'Location', names.locations], ['tag', 'Tag', names.tags]].filter(([, , map]) => map.size).map(([f, label, map]) => (multi(f)
        ? html`<input type="hidden" name="${f}" value="${opts.filters[f].map(v => v ?? 'none').join(',')}"><p class="field">${label}: ${opts.filters[f].length} selected</p>`
        : selectField(label, f, filterChoices(map), single(f))))}
      ${selectField('Account type', 'account_type', [['', 'Any'], ...ACCOUNT_TYPES.map(([k, l]) => [k, l])], opts.accountTypes.length === 1 ? opts.accountTypes[0] : '')}
    </div>
  </details>
  ${customizePanel(report)}
  ${accountNames.length ? html`<input type="hidden" name="account" value="${opts.filters.account.join(',')}">
    <p class="muted small">Accounts: ${accountNames.join(', ')} · <a href="/reports/r/${def.key}?${optionsQuery({ ...opts, filters: { ...opts.filters, account: [] } })}">All accounts</a></p>` : ''}
  <div class="option-row"><button class="primary">Run report</button></div>
</form>`;
}

function summaryTable(report) {
  const fmt = fmtOf(report);
  return html`<table class="${`report${tableStyle(report)}`}">
  <thead><tr><th class="label"></th>${report.columns.map(c => html`<th class="num">${c.label}</th>`)}</tr></thead>
  <tbody>${report.rows.map(r => html`<tr class="${`${r.kind}${r.grand ? ' grand' : ''}${r.parent ? ' parent' : ''}${r.tone ? ` ${r.tone}` : ''}`}">
    <td class="${`label ${DEPTH(r.depth)}`}">${r.href ? html`<a href="${r.href}">${r.label}</a>` : r.label}</td>
    ${r.cells ? r.cells.map((c, i) => {
      const q = report.drill?.(r, report.columns[i]);
      const text = cellText(c, fmt);
      return html`<td class="${`num${fmt.red(c.v) ? ' neg' : ''}`}">${q && c.v ? html`<a href="${drillHref(report, q)}">${text}</a>` : text}</td>`;
    }) : report.columns.map(() => html`<td></td>`)}
  </tr>`)}</tbody>
</table>`;
}

const tableStyle = report => { const c = report.opts.custom ?? {}; return `${c.banded ? ' banded' : ''}${c.grid ? ` grid-${c.grid}` : ''}`; };

function detailTable(report) {
  const cols = report.columns;
  const fmt = fmtOf(report);
  const firstMoney = Math.max(1, cols.findIndex(c => c.money) < 0 ? cols.length : cols.findIndex(c => c.money));
  return html`<table class="${`report detail${tableStyle(report)}`}">
  <thead><tr>${cols.map(c => html`<th class="${c.money ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
  <tbody>${report.rows.map(r => {
    if (r.kind === 'section') {
      return html`<tr class="section"><td colspan="${cols.length}" class="label">${r.accountId ? html`<a href="/settings/accounts/${r.accountId}">${r.label}</a>` : r.label}</td></tr>`;
    }
    if (r.kind === 'total') {
      return html`<tr class="${`total${r.grand ? ' grand' : ''}`}"><td colspan="${firstMoney}" class="label">${r.label ?? ''}</td>
        ${cols.slice(firstMoney).map(c => html`<td class="${`num${fmt.red(r.cells[c.key]) ? ' neg' : ''}`}">${c.money ? detailText(c, r.cells, fmt) : ''}</td>`)}</tr>`;
    }
    return html`<tr class="${`line${r.sub ? ' sub' : ''}`}">${cols.map(c => {
      const t = detailText(c, r.cells, fmt);
      if (c.key === 'type' && r.txnId && t) return html`<td><a href="${linkOf({ type: r.txnType, txn_id: r.txnId })}">${t}</a></td>`;
      if (c.key === (r.linkKey ?? cols[0].key) && r.href && t) return html`<td><a href="${r.href}">${t}</a></td>`;
      if (c.key === 'num' && r.txnId && t && !cols.some(x => x.key === 'type')) return html`<td><a href="${linkOf({ type: r.txnType, txn_id: r.txnId })}">${t}</a></td>`;
      if (c.key === 'account' && r.accountId) return html`<td><a href="/settings/accounts/${r.accountId}">${t}</a></td>`;
      return html`<td class="${c.money ? `num${fmt.red(r.cells[c.key]) ? ' neg' : ''}` : c.key === 'memo' || c.key === 'description' ? 'memo' : ''}">${t}</td>`;
    })}</tr>`;
  })}</tbody>
</table>`;
}

function saveForms(report, { csrf, q, saved }) {
  const { def } = report;
  return html`<details class="more-options"><summary class="button">Save as</summary>
    <form method="post" action="/reports/r/${def.key}/save" class="card stack-form">${csrfField(csrf)}<input type="hidden" name="q" value="${q}">
      <button class="visually-hidden" name="mode" value="new" tabindex="-1" aria-hidden="true">Save</button>
      ${saved?.editable ? html`<input type="hidden" name="saved_id" value="${saved.saved_id}">
        <p>This is the custom report <strong>${saved.name}</strong>. <button class="link" name="mode" value="update">Update it with these settings</button>, or save a new one:</p>` : ''}
      ${field('Name', 'name', saved ? `${saved.name} (copy)` : report.title)}
      ${field('Group', 'group', saved?.group_name ?? '', { hint: 'Optional' })}
      ${checkbox('Share with everyone in the company', 'shared', false)}
      <button class="primary" name="mode" value="new">Save</button>
    </form></details>
  <details class="more-options"><summary class="button">Make default</summary>
    <form method="post" action="/reports/r/${def.key}/default" class="card stack-form">${csrfField(csrf)}<input type="hidden" name="q" value="${q}">
      <label class="check"><input type="radio" name="scope" value="this" checked> Open ${report.def.title} with these settings</label>
      <label class="check"><input type="radio" name="scope" value="all"> Use this number format, header and style for every report</label>
      <p><button class="primary">Make default</button> <button class="link" name="clear" value="1">Go back to the standard settings</button></p>
    </form></details>`;
}

export function reportPage({ entityName, csrf, flash, report, accounts, favorite, canFavorite, generatedAt, note = null, canEdit = false, email = null, saved = null }) {
  const { def, opts } = report;
  const q = optionsQuery(opts);
  const c = opts.custom ?? {};
  const empty = !report.rows.length;
  const foot = [c.hide_basis ? '' : report.basisLabel, c.hide_prepared ? '' : generatedAt].filter(Boolean).join(' · ');
  return layout({
    title: report.title, entityName, csrf, flash, wide: true,
    body: html`<div class="crumbs page-actions"><a href="/reports">‹ Reports</a>${saved ? html` <span class="muted">· Custom report: ${saved.name}</span>` : ''}<span class="spacer"></span>
  ${canFavorite ? star({ key: def.key, on: favorite, csrf, back: `/reports/r/${def.key}?${q}` }) : ''}</div>
${optionsForm(report, { accounts })}
<div class="report-actions">
  <a class="button" href="/reports/r/${def.key}.xlsx?${q}">Excel</a>
  <a class="button" href="/reports/r/${def.key}.csv?${q}">CSV</a>
  <a class="button" href="/reports/r/${def.key}.pdf?${q}" target="_blank" rel="noopener">PDF</a>
  <button type="button" data-print>Print</button>
  ${canEdit ? (report.links ?? []).map(l => html`<a class="button" href="${l.href}">${l.label}</a>`) : ''}
</div>
<div class="report-extras">
  ${saveForms(report, { csrf, q, saved })}
  ${canEdit ? html`
  <details class="more-options"${email?.error ? raw(' open') : ''}><summary class="button">Email</summary>
    <form method="post" action="/reports/r/${def.key}/email" class="card stack-form">${csrfField(csrf)}<input type="hidden" name="q" value="${q}">
      ${email?.error ? html`<p class="error-banner" role="alert">${email.error}</p>` : ''}
      ${field('To', 'to', email?.to ?? '', { type: 'email', required: true, attrs: 'multiple' })}
      ${field('Subject', 'subject', email?.subject ?? `${report.title} — ${entityName}`)}
      <label class="field"><span>Message</span><textarea name="message" rows="3">${email?.message ?? `Attached is the ${report.title} (${report.subtitle}).`}</textarea></label>
      ${selectField('Attach as', 'format', [['pdf', 'PDF'], ['xlsx', 'Excel'], ['csv', 'CSV']], email?.format ?? 'pdf')}
      <button class="primary">Send</button>
    </form></details>
  <details class="more-options"><summary class="button">${note ? 'Edit note' : 'Add note'}</summary>
    <form method="post" action="/reports/r/${def.key}/note" class="card stack-form">${csrfField(csrf)}<input type="hidden" name="q" value="${q}">
      <label class="field"><span>Note (shown under the title, and in exports)</span><textarea name="note" rows="3" maxlength="2000">${note?.note ?? ''}</textarea></label>
      <button class="primary">Save note</button>${note ? html` <span class="muted small">Last changed by ${note.updated_by ?? 'someone'}. Save it empty to remove it.</span>` : ''}
    </form></details>` : ''}
</div>
<section class="card report-sheet">
  <header class="${`report-head${c.align === 'left' ? ' left' : ''}`}">${c.hide_company ? '' : html`<p class="company">${entityName}</p>`}<h1>${report.title}</h1>${c.hide_period ? '' : html`<p class="muted">${report.subtitle}</p>`}</header>
  ${note ? html`<p class="report-note">${note.note}</p>` : ''}
  ${report.charts ? html`<div class="charts">${bars('Income', report.charts.income)}${bars('Expenses', report.charts.expenses)}</div>` : ''}
  ${(opts.notices ?? []).map(n => html`<p class="flash warn" role="status">${n}</p>`)}
  ${report.truncated ? html`<p class="flash warn">This report stops at 5,000 lines (exports too). Narrow the dates, accounts or filters to see the rest.</p>` : ''}
  ${empty ? html`<p class="muted">${report.emptyText ?? 'Nothing to show for these dates and filters.'}</p>`
    : html`<div class="report-wrap">${report.detail ? detailTable(report) : summaryTable(report)}</div>`}
  ${foot ? html`<footer class="report-foot muted small">${foot}</footer>` : ''}
</section>
${canEdit && report.customKpis?.length ? html`<section class="card"><h2>Your KPIs</h2><ul class="link-list">${report.customKpis.map(k => html`<li class="kpi-own">
  <span><strong>${k.name}</strong> <code>${k.formula}</code></span>
  <form method="post" action="/reports/kpis/${k.kpi_id}/delete" class="inline" data-confirm="${`Remove the KPI “${k.name}”?`}">${csrfField(csrf)}<button class="link">Remove</button></form></li>`)}</ul></section>` : ''}`,
  });
}
