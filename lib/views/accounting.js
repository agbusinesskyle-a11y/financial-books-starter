import { html } from './html.js';
import { csrfField, errorBanner, field, selectField, checkbox, postButton } from './forms.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const accountingToValues = s => ({ ...s, fiscalStartMonth: String(s.fiscalStartMonth), billableMarkup: s.billableMarkup === null ? '' : String(s.billableMarkup),
  billableIncomeAccountId: s.billableIncomeAccountId ? String(s.billableIncomeAccountId) : '' });
export const accountingFormValues = p => ({
  fiscalStartMonth: p.get('fiscalStartMonth') ?? '1', method: p.get('method') ?? 'accrual', dateFormat: p.get('dateFormat') ?? 'mdy',
  showAccountNumbers: p.get('showAccountNumbers') === '1', classesOn: p.get('classesOn') === '1', classMode: p.get('classMode') ?? 'txn',
  locationsOn: p.get('locationsOn') === '1', locationLabel: p.get('locationLabel') ?? '', billableOn: p.get('billableOn') === '1',
  billableMarkup: p.get('billableMarkup') ?? '', billableIncomeAccountId: p.get('billableIncomeAccountId') ?? '', autoApplyCustomer: p.get('autoApplyCustomer') === '1',
  autoApplyVendor: p.get('autoApplyVendor') === '1', warnDuplicateBills: p.get('warnDuplicateBills') === '1',
});

export function accountingSettingsBody({ csrf, v, incomeAccounts, error = null }) {
  return html`<form method="post" action="/settings/accounting" class="editor">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <h2>Accounting</h2>
  <div class="form-grid">
    ${selectField('First month of the fiscal year', 'fiscalStartMonth', MONTHS.map((m, i) => [String(i + 1), m]), v.fiscalStartMonth)}
    ${selectField('Accounting method', 'method', [['accrual', 'Accrual (income when invoiced)'], ['cash', 'Cash (income when paid)']], v.method)}
    ${selectField('Date format', 'dateFormat', [['mdy', '10/12/26 (month first)'], ['dmy', '12/10/26 (day first)'], ['ymd', '2026-10-12']], v.dateFormat)}
  </div>
  <p class="muted small">The method and fiscal year are used by reports.</p>
  ${checkbox('Show account numbers', 'showAccountNumbers', v.showAccountNumbers)}
  <h2>Classes and locations</h2>
  ${checkbox('Track classes', 'classesOn', v.classesOn)}
  <fieldset class="choice"><legend>Assign classes</legend>
    <label class="check"><input type="radio" name="classMode" value="txn"${v.classMode !== 'line' ? html` checked` : ''}> One per transaction</label>
    <label class="check"><input type="radio" name="classMode" value="line"${v.classMode === 'line' ? html` checked` : ''}> One per line</label>
  </fieldset>
  ${checkbox('Track locations', 'locationsOn', v.locationsOn)}
  <div class="form-grid">${field('Call locations', 'locationLabel', v.locationLabel, { hint: 'E.g. Location, Store, Department, Division.' })}</div>
  <p class="muted small">Manage the lists under <a href="/settings/classes">Classes</a>, <a href="/settings/locations">Locations</a> and <a href="/settings/tags">Tags</a>.</p>
  <h2>Billable expenses</h2>
  ${checkbox('Mark expense and bill lines as billable to a customer', 'billableOn', v.billableOn)}
  <div class="form-grid">
    ${field('Markup %', 'billableMarkup', v.billableMarkup, { attrs: 'inputmode="decimal" placeholder="0"' })}
    ${selectField('Income account for billed expenses', 'billableIncomeAccountId', incomeAccounts.map(a => [a.account_id, a.name]), v.billableIncomeAccountId, { blank: 'The product’s income account (or Sales)' })}
  </div>
  <h2>Automation</h2>
  ${checkbox('Apply new customer payments and credit memos to the oldest open invoices', 'autoApplyCustomer', v.autoApplyCustomer)}
  ${checkbox('Apply new vendor credits to the vendor’s oldest open bills', 'autoApplyVendor', v.autoApplyVendor)}
  <h2>Warnings</h2>
  ${checkbox('Warn when a bill number is already used for that vendor', 'warnDuplicateBills', v.warnDuplicateBills)}
  <p class="muted small">Check numbers are always unique per bank account.</p>
  <div class="form-actions"><button class="primary">Save accounting settings</button></div>
</form>`;
}

export function classesBody({ csrf, classes, on, v = { name: '', parentId: '' }, error = null }) {
  const tops = classes.filter(c => !c.parent_id && c.active);
  return html`${on ? '' : html`<p class="ledger-check warn">Classes are turned off. Turn them on in <a href="/settings/accounting">Accounting</a> to pick them on transactions.</p>`}
<h2>Classes</h2>
${classes.length ? html`<table class="grid">
  <thead><tr><th>Class</th><th>Status</th><th></th></tr></thead>
  <tbody>${classes.map(c => html`<tr>
    <td data-label="Class">${c.parent_id ? html`<span class="muted">${c.parent_name}:</span> ` : ''}${c.name}</td>
    <td data-label="Status">${c.active ? 'Active' : html`<span class="muted">Inactive</span>`}${c.used ? html` <span class="muted">· in use</span>` : ''}</td>
    <td data-label="">${postButton({ action: `/settings/classes/${c.class_id}`, csrf, label: c.active ? 'Make inactive' : 'Make active',
      extra: { name: c.name, parentId: c.parent_id ?? '', active: c.active ? '' : '1' } })}</td>
  </tr>`)}</tbody>
</table>` : html`<p class="muted">No classes yet. Classes split income and expenses by part of the business, like Retail and Wholesale.</p>`}
<form method="post" action="/settings/classes" class="editor add-row">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('New class', 'name', v.name, { required: true })}
    ${selectField('Under', 'parentId', tops.map(c => [c.class_id, c.name]), v.parentId, { blank: 'Nothing (top level)' })}
  </div>
  <div class="form-actions"><button class="primary">Add class</button></div>
</form>`;
}

export function locationsBody({ csrf, locations, on, label, v = { name: '' }, error = null }) {
  return html`${on ? '' : html`<p class="ledger-check warn">Locations are turned off. Turn them on in <a href="/settings/accounting">Accounting</a> to pick them on transactions.</p>`}
<h2>${label}s</h2>
${locations.length ? html`<table class="grid">
  <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
  <tbody>${locations.map(l => html`<tr><td data-label="Name">${l.name}</td>
    <td data-label="Status">${l.active ? 'Active' : html`<span class="muted">Inactive</span>`}${l.used ? html` <span class="muted">· in use</span>` : ''}</td>
    <td data-label="">${postButton({ action: `/settings/locations/${l.location_id}`, csrf, label: l.active ? 'Make inactive' : 'Make active', extra: { name: l.name, active: l.active ? '' : '1' } })}</td></tr>`)}</tbody>
</table>` : html`<p class="muted">None yet.</p>`}
<form method="post" action="/settings/locations" class="editor add-row">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <div class="form-grid">${field(`New ${label.toLowerCase()}`, 'name', v.name, { required: true })}</div>
  <div class="form-actions"><button class="primary">Add</button></div>
</form>`;
}

export function tagsBody({ csrf, tags, groups, v = { name: '', groupId: '', newGroup: '' }, error = null }) {
  return html`<h2>Tags</h2>
<p class="muted">Labels you can put on any transaction and filter lists by, e.g. a group “Campaign” with tags “Spring promo” and “Fair booth”.</p>
${tags.length ? html`<table class="grid">
  <thead><tr><th>Tag</th><th>Used on</th><th></th></tr></thead>
  <tbody>${tags.map(t => html`<tr><td data-label="Tag">${t.group_name ? html`<span class="muted">${t.group_name}:</span> ` : ''}${t.name}</td>
    <td data-label="Used on">${t.uses} transaction${t.uses === 1 ? '' : 's'}</td>
    <td data-label="">${postButton({ action: `/settings/tags/${t.tag_id}/delete`, csrf, label: 'Delete', confirm: `Delete the tag “${t.full_name}”? It comes off every transaction.` })}</td></tr>`)}</tbody>
</table>` : html`<p class="muted">No tags yet.</p>`}
<form method="post" action="/settings/tags" class="editor add-row">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('New tag', 'name', v.name, { required: true })}
    ${selectField('Group', 'groupId', groups.map(g => [g.group_id, g.name]), v.groupId, { blank: 'No group' })}
    ${field('…or a new group', 'newGroup', v.newGroup)}
  </div>
  <div class="form-actions"><button class="primary">Add tag</button></div>
</form>`;
}
