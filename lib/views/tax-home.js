import { html } from './html.js';
import { layout } from './layout.js';
import { RETURN_TYPE_LABELS } from '../tax/periods.js';

// /tax/all (spec §8; T2: org admins only — the Tax section is otherwise per company): every company's return with its tax setup. The
// computed parts are not yet available.
export function taxHomePage({ entityName, csrf, flash, companies }) {
  return layout({ title: 'All returns', entityName, csrf, flash, wide: true, body: html`<h1>All returns</h1>
<p class="small"><a href="/tax/parties">Party directory</a></p>
<p class="muted">Each company's return, prepared continuously from its books. Numbers, mapping, worksheets and the waiting-on list arrive in the next stages; this page sets up who files what.</p>
<div class="table-scroll"><table class="grid">
  <thead><tr><th>Company</th><th>Return</th><th>Period</th><th>Status</th><th>Estimate to date</th><th>Next deadline</th><th class="actions"></th></tr></thead>
  <tbody>${companies.map(c => html`<tr>
    <td data-label="Company"><strong>${c.name}</strong></td>
    <td data-label="Return">${c.profile.exists === false ? html`<span class="muted">Not set up</span>` : RETURN_TYPE_LABELS[c.profile.return_type]}</td>
    <td data-label="Period">${c.period ? `${c.period.period_start} – ${c.period.period_end}` : html`<span class="muted">No period yet</span>`}</td>
    <td data-label="Status">${c.period ? c.period.status : html`<span class="muted">—</span>`}</td>
    <td data-label="Estimate" class="muted">Not yet available</td>
    <td data-label="Deadline" class="muted">Not yet available</td>
    <td class="actions" data-label=""><a href="/tax/${c.entityId}/profile">Tax setup</a></td>
  </tr>`)}</tbody>
</table></div>` });
}
