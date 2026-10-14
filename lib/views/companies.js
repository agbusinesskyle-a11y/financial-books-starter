import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field } from './forms.js';

// Settings → Companies (stage B1): every company in this account, which one is open, and a form to add one.
export function companiesPage({ entityName, csrf, flash, companies, currentId, v = {}, error = null }) {
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
    </div>
    <div class="form-actions"><button class="primary">Add company</button></div>
  </form>` });
}

export const switchButton = (csrf, entityId, label) => html`<form method="post" action="/company/switch" class="inline">${csrfField(csrf)}
  <input type="hidden" name="entity_id" value="${entityId}"><button class="link">${label}</button></form>`;
