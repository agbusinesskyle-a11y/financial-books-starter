import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, checkbox, postButton } from './forms.js';
import { linesTable, withBlankRows } from './txn-form.js';
import { UNITS, describeRule } from '../domain/schedule.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';

export const MODE_LABELS = { scheduled: 'Scheduled', reminder: 'Reminder', unscheduled: 'Unscheduled' };
const MODE_HELP = {
  scheduled: 'Creates the transaction automatically on each date.',
  reminder: 'Puts a reminder in the Activity Feed on each date; you create the transaction with “Use”.',
  unscheduled: 'Never runs by itself. A saved starting point you use whenever you need it.',
};

// Template row -> form values.
export function templateToValues(t, lineRows) {
  return {
    name: t.name, txnType: t.txn_type, mode: t.mode, unit: t.interval_unit ?? 'month', count: String(t.interval_count ?? 1),
    startDate: t.start_date ?? '', endDate: t.end_date ?? '', termsId: t.terms_id ? String(t.terms_id) : '', memo: t.memo ?? '',
    autoSend: t.auto_send, lines: lineRows,
  };
}

export const newTemplateValues = today => ({ name: '', txnType: 'invoice', mode: 'scheduled', unit: 'month', count: '1', startDate: today, endDate: '', termsId: '', memo: '', autoSend: false, lines: [] });

export function templateFormValues(params) {
  const items = params.getAll('line_item'), desc = params.getAll('line_desc'), qty = params.getAll('line_qty'), rate = params.getAll('line_rate');
  const n = Math.min(100, Math.max(items.length, desc.length, qty.length, rate.length));
  const lines = Array.from({ length: n }, (_, i) => ({ itemId: items[i] ?? '', description: desc[i] ?? '', quantity: qty[i] ?? '', rate: rate[i] ?? '' }))
    .filter(l => l.itemId || l.description.trim() || l.quantity.trim() || l.rate.trim());
  const get = k => params.get(k) ?? '';
  return { name: get('name'), txnType: get('txnType'), mode: get('mode'), unit: get('unit'), count: get('count'), startDate: get('startDate'),
    endDate: get('endDate'), termsId: get('termsId'), memo: get('memo'), autoSend: get('autoSend') === '1', lines };
}

export function templateForm({ entityName, csrf, customer, templateId = null, items, terms, v, error = null }) {
  const back = `/customers/${customer.customer_id}?tab=recurring`;
  const unscheduled = v.mode === 'unscheduled';
  return layout({
    title: templateId ? `Edit ${v.name}` : 'New recurring template', entityName, csrf,
    body: html`<div class="crumbs"><a href="${back}">‹ ${customer.display_name}</a></div>
<form method="post" action="${templateId ? `/recurring/${templateId}` : `/customers/${customer.customer_id}/recurring`}" class="card editor" data-editor data-recurring-form>
  ${csrfField(csrf)}
  <div class="card-head"><h1>${templateId ? 'Edit recurring template' : 'New recurring template'}</h1>
    <p class="big-total">Each time <strong data-total>$0.00</strong></p></div>
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Template name', 'name', v.name, { required: true })}
    ${selectField('Creates', 'txnType', [['invoice', 'Invoice'], ['sales_receipt', 'Sales receipt']], v.txnType)}
    ${selectField('Terms (invoices)', 'termsId', terms.map(t => [t.terms_id, t.name]), v.termsId, { blank: 'Customer default' })}
  </div>
  <fieldset class="choice"><legend>How it runs</legend>
    ${Object.entries(MODE_LABELS).map(([k, label]) => html`<label class="check"><input type="radio" name="mode" value="${k}"${v.mode === k ? html` checked` : ''} data-recurring-mode> <strong>${label}</strong> <span class="muted">— ${MODE_HELP[k]}</span></label>`)}
  </fieldset>
  <div class="form-grid schedule${unscheduled ? ' hidden' : ''}">
    ${selectField('Repeats', 'unit', UNITS, v.unit)}
    ${field('Every', 'count', v.count, { attrs: 'inputmode="numeric" size="4"', hint: 'e.g. 2 with Weekly = every other week' })}
    ${field('Start date', 'startDate', v.startDate, { type: 'date', hint: 'The first date it runs (today or later)' })}
    ${field('End date (optional)', 'endDate', v.endDate, { type: 'date' })}
  </div>
  <div class="checks schedule-send${v.mode === 'scheduled' ? '' : ' hidden'}">${checkbox('Email it to the customer automatically when it’s created', 'autoSend', v.autoSend)}</div>
  ${linesTable(items, withBlankRows(v.lines), { kinds: false })}
  ${field('Memo', 'memo', v.memo, { cls: 'wide' })}
  <div class="form-actions">
    <a href="${back}">Cancel</a>
    <button class="primary">Save template</button>
  </div>
</form>`,
  });
}

// QBO's Recurring Transactions tab: search by template name, New template, and Name / Type / Txn type / Interval /
// Previous date / Next date / Amount / Action.
export function recurringTab({ customer: c, csrf, templates, today }) {
  return html`<div class="page-actions recurring-head">
  <label class="field"><span>Search by template name</span><input type="search" data-filter-rows="#recurring-list" aria-label="Search by template name"></label>
  <span class="spacer"></span>
  <a href="/all-recurring">Manage recurring payments</a>
  <a class="button primary" href="/customers/${c.customer_id}/recurring/new">New template</a></div>
${templates.length ? html`<div class="table-scroll"><table class="grid" id="recurring-list">
  <thead><tr><th>Name</th><th>Type</th><th>Txn type</th><th>Interval</th><th>Previous date</th><th>Next date</th><th class="num">Amount</th><th class="actions">Action</th></tr></thead>
  <tbody>${templates.map(t => html`<tr class="${t.active ? '' : 'inactive'}" data-filter-text="${t.name.toLowerCase()}">
    <td><a href="/recurring/${t.template_id}/edit">${t.name}</a>${t.active ? '' : html` <span class="tag">Paused</span>`}</td>
    <td>${MODE_LABELS[t.mode]}</td>
    <td>${t.txn_type === 'invoice' ? 'Invoice' : 'Sales receipt'}</td>
    <td>${t.mode === 'unscheduled' ? '—' : html`${describeRule({ unit: t.interval_unit, count: t.interval_count, start: t.start_date })}${t.auto_send ? html`<br><span class="muted">Emailed automatically</span>` : ''}`}</td>
    <td>${t.last_run_date ? formatShortDate(t.last_run_date) : '—'}</td>
    <td>${t.next_run_date ? formatShortDate(t.next_run_date) : html`<span class="muted">${t.mode === 'unscheduled' ? '—' : t.active ? 'Ended' : 'Paused'}</span>`}${t.next_run_date && t.next_run_date < today ? html` <span class="status warn">Overdue</span>` : ''}</td>
    <td class="num">${formatCents(t.total_cents)}</td>
    <td class="actions"><a href="/txns/new?template=${t.template_id}">Use</a> · <a href="/recurring/${t.template_id}/edit">Edit</a> ·
      ${t.mode === 'unscheduled' ? '' : html`${postButton({ action: `/recurring/${t.template_id}/${t.active ? 'pause' : 'resume'}`, csrf, label: t.active ? 'Pause' : 'Resume' })} ·`}
      ${postButton({ action: `/recurring/${t.template_id}/delete`, csrf, label: 'Delete', confirm: `Delete the template “${t.name}”? Transactions it already created stay.` })}</td>
  </tr>`)}</tbody>
</table></div>` : html`<p class="muted">No recurring templates for ${c.display_name}. Create one for deliveries or services you bill on a schedule.</p>`}`;
}
