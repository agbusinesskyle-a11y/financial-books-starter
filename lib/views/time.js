import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, checkbox, postButton } from './forms.js';
import { formatShortDate, addDays } from '../domain/dates.js';
import { hoursText } from '../data/time.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const total = entries => hoursText(entries.reduce((s, e) => s + e.minutes, 0));
const jobOf = e => (e.project_id ? `p:${e.project_id}` : e.customer_id ? `c:${e.customer_id}` : '');
const jobLabel = e => (e.project_name ? `${e.customer_name} › ${e.project_name}` : e.customer_name ?? '');

const jobSelect = (name, jobs, value, label = 'Customer or project') => html`<select name="${name}" aria-label="${label}"><option value="">— no customer —</option>
  ${jobs.map(j => html`<option value="${j.value}"${j.value === value ? html` selected` : ''}>${j.label}</option>`)}</select>`;
const itemSelect = (name, items, value) => html`<select name="${name}" aria-label="Service"><option value="">—</option>
  ${items.map(i => html`<option value="${i.item_id}"${String(i.item_id) === String(value ?? '') ? html` selected` : ''}>${i.name}</option>`)}</select>`;

export function timePage({ entityName, csrf, flash = null, monday, entries, jobs, items, everyone, canSeeAll, v, error = null }) {
  const week = q => `/time?${new URLSearchParams({ date: q, ...(everyone ? { who: 'all' } : {}) })}`;
  return layout({
    title: 'Time', entityName, csrf, flash,
    body: html`<div class="crumbs page-actions"><a href="/tools">‹ Tools</a><span class="spacer"></span>
  <a class="button" href="/time/week?date=${monday}">Weekly timesheet</a></div>
<section class="card">
  <div class="card-head"><h1>Time</h1>
    <span class="week-nav"><a href="${week(addDays(monday, -7))}" aria-label="Previous week">‹</a> Week of ${formatShortDate(monday)} <a href="${week(addDays(monday, 7))}" aria-label="Next week">›</a></span></div>
  ${canSeeAll ? html`<p><a href="${`/time?${new URLSearchParams({ date: monday, ...(everyone ? {} : { who: 'all' }) })}`}">${everyone ? 'Show only my time' : 'Show everyone’s time'}</a></p>` : ''}
  ${entries.length ? html`<table class="grid">
    <thead><tr><th>Date</th>${everyone ? html`<th>Person</th>` : ''}<th>Customer / project</th><th>Service</th><th class="num">Hours</th><th>Billable</th><th>Notes</th></tr></thead>
    <tbody>${entries.map(e => html`<tr>
      <td data-label="Date"><a href="/time/${e.entry_id}">${formatShortDate(e.entry_date)}</a></td>
      ${everyone ? html`<td data-label="Person">${e.person}</td>` : ''}
      <td data-label="Customer">${jobLabel(e)}</td><td data-label="Service">${e.item_name ?? ''}</td>
      <td class="num" data-label="Hours">${hoursText(e.minutes)}</td>
      <td data-label="Billable">${e.billable ? (e.billed_txn_id ? html`<a href="/txns/${e.billed_txn_id}">Billed</a>` : 'Yes') : 'No'}</td>
      <td data-label="Notes">${e.notes ?? ''}</td></tr>`)}</tbody>
    <tfoot><tr><td colspan="${everyone ? 4 : 3}">Total</td><td class="num">${total(entries)}</td><td colspan="2"></td></tr></tfoot>
  </table>` : html`<p class="muted">No time this week.</p>`}
</section>
<form method="post" action="/time" class="card editor">
  ${csrfField(csrf)}<h2>Add time</h2>
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Date', 'date', v.date, { type: 'date', required: true })}
    <label class="field"><span>Customer / project</span>${jobSelect('job', jobs, v.job)}</label>
    <label class="field"><span>Service</span>${itemSelect('item_id', items, v.itemId)}</label>
    ${field('Hours', 'hours', v.hours, { required: true, attrs: 'inputmode="decimal" placeholder="1.5 or 1:30"' })}
  </div>
  ${checkbox('Billable', 'billable', v.billable)}
  <label class="field wide"><span>Notes</span><input name="notes" value="${v.notes}"></label>
  <div class="form-actions"><button class="primary">Add time</button></div>
</form>`,
  });
}

export function entryPage({ entityName, csrf, entry: e, jobs, items, v, error = null }) {
  return layout({
    title: 'Time entry', entityName, csrf,
    body: html`<div class="crumbs"><a href="/time?date=${e.entry_date}">‹ Time</a></div>
<form method="post" action="/time/${e.entry_id}" class="card editor">
  ${csrfField(csrf)}<h1>Time entry <small class="muted">${e.person}</small></h1>
  ${errorBanner(error)}
  ${e.billed_txn_id ? html`<p class="ledger-check warn">This time is on <a href="/txns/${e.billed_txn_id}">an invoice</a>, so it can’t be changed.</p>` : ''}
  <div class="form-grid">
    ${field('Date', 'date', v.date, { type: 'date', required: true })}
    <label class="field"><span>Customer / project</span>${jobSelect('job', jobs, v.job)}</label>
    <label class="field"><span>Service</span>${itemSelect('item_id', items, v.itemId)}</label>
    ${field('Hours', 'hours', v.hours, { required: true, attrs: 'inputmode="decimal"' })}
  </div>
  ${checkbox('Billable', 'billable', v.billable)}
  <label class="field wide"><span>Notes</span><input name="notes" value="${v.notes}"></label>
  <div class="form-actions"><a href="/time?date=${e.entry_date}">Cancel</a><button class="primary">Save</button></div>
</form>
${e.billed_txn_id ? '' : postButton({ action: `/time/${e.entry_id}/delete`, csrf, label: 'Delete this entry', cls: 'link danger', confirm: 'Delete this time entry?' })}`,
  });
}

export const entryToValues = e => ({ date: e.entry_date, job: jobOf(e), itemId: e.item_id ? String(e.item_id) : '', hours: hoursText(e.minutes), billable: e.billable, notes: e.notes ?? '' });

// The weekly grid: one row per customer/project + service + billable, a cell per day.
export function timesheetPage({ entityName, csrf, flash = null, monday, entries, jobs, items, error = null, typed = null }) {
  const groups = new Map();
  for (const e of entries) {
    const key = `${jobOf(e)}|${e.item_id ?? ''}|${e.billable}`;
    if (!groups.has(key)) groups.set(key, { job: jobOf(e), itemId: e.item_id, billable: e.billable, days: Array(7).fill(0), billed: Array(7).fill(0) });
    const d = Math.round((Date.parse(`${e.entry_date}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / 86_400_000);
    // Billed time is shown but locked; only unbilled time is in the box (and replaced on save).
    groups.get(key)[e.billed_txn_id ? 'billed' : 'days'][d] += e.minutes;
  }
  // After a failed save, show exactly what was typed (billed time alongside, as before).
  const rows = typed
    ? [...typed.map(r => ({ job: r.job, itemId: r.itemId, billable: r.billable, days: r.hours, billed: Array(7).fill(0), typed: true })),
      { job: '', itemId: '', billable: false, days: Array(7).fill(''), billed: Array(7).fill(0), typed: true }]
    : [...groups.values(), ...Array.from({ length: 3 }, () => ({ job: '', itemId: '', billable: false, days: Array(7).fill(0), billed: Array(7).fill(0) }))];
  return layout({
    title: 'Weekly timesheet', entityName, csrf, flash, wide: true,
    body: html`<div class="crumbs page-actions"><a href="/time?date=${monday}">‹ Time</a><span class="spacer"></span>
  <a class="button" href="/time/week?date=${addDays(monday, -7)}">‹ Previous week</a><a class="button" href="/time/week?date=${addDays(monday, 7)}">Next week ›</a></div>
<form method="post" action="/time/week" class="card editor" data-timesheet>
  ${csrfField(csrf)}<input type="hidden" name="monday" value="${monday}">
  <h1>Week of ${formatShortDate(monday)}</h1>
  ${errorBanner(error)}
  <p class="muted small">Hours like 1.5 or 1:30. Saving replaces your unbilled time for this week; time already on an invoice stays as it is.</p>
  <div class="budget-wrap"><table class="grid timesheet">
    <thead><tr><th>Customer / project</th><th>Service</th><th>Billable</th>${DAYS.map((d, i) => html`<th class="num">${d} ${formatShortDate(addDays(monday, i)).replace(/\/\d+$/, '')}</th>`)}<th class="num">Total</th></tr></thead>
    <tbody>${rows.map(r => html`<tr>
      <td data-label="Customer">${jobSelect('ts_job', jobs, r.job)}</td>
      <td data-label="Service">${itemSelect('ts_item', items, r.itemId)}</td>
      <td data-label="Billable"><select name="ts_billable" aria-label="Billable"><option value="">No</option><option value="1"${r.billable ? html` selected` : ''}>Yes</option></select></td>
      ${r.days.map((m, d) => html`<td class="num" data-label="${DAYS[d]}"> <input name="ts_d${d}" value="${r.typed ? m : m ? hoursText(m) : ''}" inputmode="decimal" size="4" aria-label="${DAYS[d]} hours">
        ${r.billed[d] ? html`<small class="muted" title="On an invoice; can’t be changed here">+${hoursText(r.billed[d])} billed</small>` : ''}</td>`)}
      <td class="num" data-label="Total">${r.typed ? '' : hoursText(r.days.reduce((s, m) => s + m, 0) + r.billed.reduce((s, m) => s + m, 0))}</td>
    </tr>`)}</tbody>
  </table></div>
  <div class="form-actions"><button class="primary">Save timesheet</button></div>
</form>`,
  });
}
