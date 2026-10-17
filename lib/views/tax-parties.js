// lib/views/tax-parties.js
// /tax/parties: the organization's party directory (spec §4.1) — every person, trust and company a return can name: owners and members,
// K-1 payers, household members. Org admins only (an admin who can open every company); a company's tax page shows only its own owners
// and its own tax party (the owner's scoping, 2026-10-16).
import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField } from './forms.js';
import { PARTY_KINDS } from '../tax/parties.js';

export function taxPartiesPage({ entityName, csrf, flash, parties, companies, error = null }) {
  return layout({ title: 'Party directory', entityName, csrf, flash, wide: true, body: html`<div class="crumbs"><a href="/tax/all">‹ All returns</a></div>
<h1>Party directory</h1>
${errorBanner(error)}
<p class="muted">Shared by every company. Owners and members are added to a company on its tax page, from these parties.</p>
<section class="card"><h2>Parties</h2>
  <div class="table-scroll"><table class="grid"><thead><tr><th>Name</th><th>Kind</th><th>Tax ID</th></tr></thead>
  <tbody>${parties.map(p => html`<tr><td data-label="Name">${p.name}</td><td data-label="Kind">${PARTY_KINDS.find(([k]) => k === p.kind)?.[1] ?? p.kind}</td>
    <td data-label="Tax ID">${p.has_tax_id ? `•••• ${p.tax_id_last4}` : html`<span class="muted">none</span>`}${p.tax_id_needs_review ? html` <span class="status warn">${p.own_tax_id_state === 'conflict' ? 'EIN differs from Settings → Company: settle it on that company’s tax page' : 'EIN to reconcile'}</span>` : ''}</td></tr>`)}</tbody></table></div>
  <form method="post" action="/tax/parties" class="editor">${csrfField(csrf)}<div class="form-grid">
    ${selectField('Kind', 'kind', PARTY_KINDS, 'individual')} ${field('Name', 'name', '', { required: true })} ${field('Tax ID (SSN or EIN, stored encrypted)', 'tax_id', '')}
    ${selectField('Company (for one of our companies)', 'entity_id', companies.map(c => [c.entityId, c.name]), '', { blank: '—' })}</div>
    <div class="form-actions"><button>Add party</button></div></form>
</section>` });
}
