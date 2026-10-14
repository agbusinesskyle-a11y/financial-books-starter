import { html } from './html.js';
import { csrfField, errorBanner, field, checkbox, postButton } from './forms.js';
import { formatCents, centsToInput } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';

const what = r => (r.kind === 'fixed' ? `${formatCents(r.price_cents)} each` : `${r.percent_off}% off`);
const dates = r => (r.start_date || r.end_date
  ? `${r.start_date ? formatShortDate(r.start_date) : 'Any time'} – ${r.end_date ? formatShortDate(r.end_date) : 'no end'}` : 'Always');

export function priceRulesBody({ rules }) {
  return html`<div class="card-head"><h2>Price rules</h2><a class="button primary" href="/settings/price-rules/new">New price rule</a></div>
<p class="muted">A special price — a fixed price or a percent off — for chosen customers and/or products. The invoice editor fills it in and says which rule applied.</p>
${rules.length ? html`<table class="grid">
  <thead><tr><th>Name</th><th>Price</th><th>Customers</th><th>Products and services</th><th>Dates</th><th>Status</th></tr></thead>
  <tbody>${rules.map(r => html`<tr>
    <td data-label="Name"><a href="/settings/price-rules/${r.rule_id}">${r.name}</a></td>
    <td data-label="Price">${what(r)}</td>
    <td data-label="Customers">${r.customer_names?.join(', ') || 'All customers'}</td>
    <td data-label="Products">${r.item_names?.join(', ') || 'All products and services'}</td>
    <td data-label="Dates">${dates(r)}</td>
    <td data-label="Status">${r.active ? html`<span class="status good">Active</span>` : html`<span class="status muted">Off</span>`}</td>
  </tr>`)}</tbody>
</table>` : html`<p class="muted">No price rules yet.</p>`}`;
}

export const ruleToValues = r => ({
  name: r.name, kind: r.kind, price: r.price_cents === null ? '' : centsToInput(r.price_cents), percentOff: r.percent_off === null ? '' : String(r.percent_off),
  customerIds: r.customer_ids.map(String), itemIds: r.item_ids.map(String), startDate: r.start_date ?? '', endDate: r.end_date ?? '', active: r.active,
});
export const ruleFormValues = p => ({
  name: p.get('name') ?? '', kind: p.get('kind') === 'fixed' ? 'fixed' : 'percent_off', price: p.get('price') ?? '', percentOff: p.get('percentOff') ?? '',
  customerIds: p.getAll('customerIds'), itemIds: p.getAll('itemIds'), startDate: p.get('startDate') ?? '', endDate: p.get('endDate') ?? '', active: p.get('active') === '1',
});
export const NEW_RULE = { name: '', kind: 'percent_off', price: '', percentOff: '', customerIds: [], itemIds: [], startDate: '', endDate: '', active: true };

const multi = (label, name, options, chosen, hint) => html`<label class="field wide"><span>${label}</span>
  <select name="${name}" multiple size="6">${options.map(([v, text]) => html`<option value="${v}"${chosen.includes(String(v)) ? html` selected` : ''}>${text}</option>`)}</select>
  <small class="muted">${hint}</small></label>`;

export function ruleFormBody({ csrf, ruleId = null, v, customers, items, error = null }) {
  return html`<p><a href="/settings/price-rules">‹ Price rules</a></p>
<form method="post" action="${ruleId ? `/settings/price-rules/${ruleId}` : '/settings/price-rules'}" class="editor">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <div class="form-grid">${field('Name', 'name', v.name, { required: true })}</div>
  <fieldset class="choice"><legend>Price</legend>
    <label class="check"><input type="radio" name="kind" value="percent_off"${v.kind !== 'fixed' ? html` checked` : ''}> Percent off the usual price</label>
    <label class="check"><input type="radio" name="kind" value="fixed"${v.kind === 'fixed' ? html` checked` : ''}> A fixed price</label>
  </fieldset>
  <div class="form-grid">
    ${field('Percent off', 'percentOff', v.percentOff, { attrs: 'inputmode="decimal" placeholder="10"' })}
    ${field('Fixed price', 'price', v.price, { attrs: 'inputmode="decimal" placeholder="18.50"' })}
    ${field('Starts', 'startDate', v.startDate, { type: 'date' })}
    ${field('Ends', 'endDate', v.endDate, { type: 'date' })}
  </div>
  ${multi('Customers', 'customerIds', customers.map(c => [c.customer_id, c.display_name]), v.customerIds, 'None chosen = every customer. Hold Ctrl (or tap) to choose several.')}
  ${multi('Products and services', 'itemIds', items.map(i => [i.item_id, i.name]), v.itemIds, 'None chosen = everything (percent off only).')}
  ${checkbox('Active', 'active', v.active)}
  <div class="form-actions"><button class="primary">Save price rule</button></div>
</form>
${ruleId ? postButton({ action: `/settings/price-rules/${ruleId}/delete`, csrf, label: 'Delete this rule', cls: 'link danger', confirm: 'Delete this price rule?' }) : ''}`;
}
