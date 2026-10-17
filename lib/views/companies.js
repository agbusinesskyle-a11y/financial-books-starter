import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField } from './forms.js';
import { BUSINESS_TYPES } from '../data/settings.js';
import { RETURN_TYPE_LABELS, suggestReturnType } from '../tax/periods.js';
import { taxProfileFields, NEW_TAX_VALUES } from './tax-profile-fields.js';

// Settings → Companies (stage B1): every company in this account, which one is open, and a form to add one — with its business type and,
// optionally, its tax setup (Tax Books T2: one company record). The return each business type suggests is listed; nothing is chosen for you.
export function companiesPage({ entityName, csrf, flash, companies, currentId, v = {}, t = NEW_TAX_VALUES, error = null }) {
  const guide = BUSINESS_TYPES.map(([k, label]) => [label, suggestReturnType(k)]).filter(([, s]) => s);
  return layout({ title: 'Companies', entityName, csrf, flash, body: html`<div class="crumbs"><a href="/settings">‹ Settings</a></div>
  <h1>Companies</h1>
  <p class="muted">Each company has its own books — customers, vendors, accounts and reports. Switch between them from the company name at the top.</p>
  <div class="table-scroll"><table class="grid">
    <thead><tr><th>Company</th><th>Time zone</th><th class="num">Customers</th><th class="num">Vendors</th><th class="num">Transactions</th><th class="actions"></th></tr></thead>
    <tbody>${companies.map(c => html`<tr><td><strong>${c.name}</strong>${Number(c.entity_id) === Number(currentId) ? html` <span class="tag">Open now</span>` : ''}</td>
      <td>${c.time_zone}</td><td class="num">${c.customers}</td><td class="num">${c.vendors}</td><td class="num">${c.transactions}</td>
      <td class="actions">${Number(c.entity_id) === Number(currentId) ? '' : switchButton(csrf, c.entity_id, 'Open')}</td></tr>`)}</tbody>
  </table></div>
  <form method="post" action="/settings/companies" class="card editor">${csrfField(csrf)}
    <h2>Add a company</h2>${errorBanner(error)}
    <p class="muted small">It starts with a standard chart of accounts and payment terms; nothing is copied from another company.</p>
    <div class="form-grid">
      ${field('Company name', 'name', v.name, { required: true })}
      ${field('Time zone', 'timeZone', v.timeZone ?? 'America/Chicago', { hint: 'For example America/Chicago, America/Denver, America/Phoenix' })}
      ${field('Email', 'email', v.email, { type: 'email' })}
      ${field('Phone', 'phone', v.phone, { type: 'tel' })}
      ${selectField('Business type', 'businessType', BUSINESS_TYPES, v.businessType, { blank: 'Choose…' })}
    </div>
    <h3>Tax setup (optional)</h3>
    <p class="muted small">Set it now, or later in Settings → Company → Tax. The return each business type suggests:</p>
    <ul class="muted small">${guide.map(([label, s]) => html`<li>${label}: ${s.returnType ? RETURN_TYPE_LABELS[s.returnType] : 'none that Tax Books prepares'}. ${s.note}</li>`)}</ul>
    ${taxProfileFields(t, { withReason: false })}
    <div class="form-actions"><button class="primary">Add company</button></div>
  </form>` });
}

export const switchButton = (csrf, entityId, label) => html`<form method="post" action="/company/switch" class="inline">${csrfField(csrf)}
  <input type="hidden" name="entity_id" value="${entityId}"><button class="link">${label}</button></form>`;
