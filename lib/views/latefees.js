import { html } from './html.js';
import { TYPE_LABELS } from '../domain/status.js';
import { csrfField, errorBanner, field, selectField, checkbox } from './forms.js';
import { describePolicy } from '../domain/latefees.js';
import { formatCents, centsToInput } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';

export function lateFeesTab({ customer: c, csrf, policy, lateFees }) {
  return html`<h2>Late fees</h2>
<p>${describePolicy(policy)} <a href="/settings/late-fees">Change in Settings</a></p>
<form method="post" action="/customers/${c.customer_id}/late-fees" class="page-actions">
  ${csrfField(csrf)}
  <span>Late fees for ${c.display_name} are <strong>${c.late_fees_enabled ? 'on' : 'off'}</strong>.</span>
  <input type="hidden" name="enabled" value="${c.late_fees_enabled ? '0' : '1'}">
  <button>${c.late_fees_enabled ? 'Turn off for this customer' : 'Turn on for this customer'}</button>
</form>
<h2 class="section-title">Late fees charged</h2>
${lateFees.length ? html`<table class="grid">
  <thead><tr><th>Date</th><th>No.</th><th>On invoice</th><th class="num">Amount</th><th>Status</th></tr></thead>
  <tbody>${lateFees.map(f => html`<tr>
    <td>${formatShortDate(f.txn_date)}</td>
    <td><a href="/txns/${f.txn_id}">${f.doc_number}</a></td>
    <td>${f.source_txn_id ? html`<a href="/txns/${f.source_txn_id}">${f.source_doc}</a>` : '—'}</td>
    <td class="num">${formatCents(f.total_cents)}</td>
    <td>${f.voided_at ? 'Voided' : f.open_cents ? `Open ${formatCents(f.open_cents)}` : 'Paid'}</td>
  </tr>`)}</tbody>
</table>` : html`<p class="muted">No late fees charged.</p>`}`;
}

export const policyToValues = p => ({
  enabled: p.enabled, feeKind: p.fee_kind, flat: centsToInput(p.flat_cents), percent: String(p.percent_bps / 100),
  graceDays: String(p.grace_days), repeat: Boolean(p.repeat_every_days), repeatDays: String(p.repeat_every_days ?? 30), maxFees: String(p.max_fees_per_invoice),
});

export const policyFormValues = params => ({
  enabled: params.get('enabled') === '1' ? '1' : '', feeKind: params.get('feeKind') ?? 'flat', flat: params.get('flat') ?? '', percent: params.get('percent') ?? '',
  graceDays: params.get('graceDays') ?? '', repeat: params.get('repeat') === '1' ? '1' : '', repeatDays: params.get('repeatDays') ?? '', maxFees: params.get('maxFees') ?? '',
});

export function lateFeeSettingsBody({ csrf, policy, v, error = null }) {
  const on = v.enabled === true || v.enabled === '1';
  const repeat = v.repeat === true || v.repeat === '1';
  return html`<form method="post" action="/settings/late-fees" class="editor">
  ${csrfField(csrf)}
  <p class="email-status ${policy.enabled ? 'ok' : 'off'}">${describePolicy(policy)}${policy.enabled ? ` Counting from ${formatShortDate(policy.effective_from)}.` : ''}</p>
  ${errorBanner(error)}
  ${checkbox('Charge late fees on overdue invoices', 'enabled', on)}
  <p class="muted">Fees are added by the daily job as separate “Late fee” transactions. They only count from the day you turn this on, so old overdue invoices aren’t all charged at once. You can turn fees off for individual customers on their Late Fees tab.</p>
  <div class="form-grid">
    ${selectField('Fee type', 'feeKind', [['flat', 'Flat amount'], ['percent', 'Percent of open balance']], v.feeKind)}
    ${field('Flat amount ($)', 'flat', v.flat, { attrs: 'inputmode="decimal"' })}
    ${field('Percent (%)', 'percent', v.percent, { attrs: 'inputmode="decimal"', hint: 'Of the invoice’s open balance' })}
    ${field('Grace period (days after due)', 'graceDays', v.graceDays, { attrs: 'inputmode="numeric"' })}
  </div>
  ${checkbox('Keep charging while the invoice stays unpaid', 'repeat', repeat)}
  <div class="form-grid">
    ${field('Every (days)', 'repeatDays', v.repeatDays, { attrs: 'inputmode="numeric"' })}
    ${field('At most (fees per invoice)', 'maxFees', v.maxFees, { attrs: 'inputmode="numeric"' })}
  </div>
  <div class="form-actions"><button class="primary">Save late fee settings</button></div>
</form>`;
}

export function termsSettingsBody({ csrf, terms, error = null }) {
  return html`<p class="muted">Payment terms set an invoice’s due date. Pick a default for each customer in their details.</p>
${errorBanner(error)}
<table class="grid">
  <thead><tr><th>Name</th><th>Days until due</th><th>Used by</th><th class="actions">Action</th></tr></thead>
  <tbody>
  ${terms.map(t => html`<tr>
    <td><input name="name" value="${t.name}" form="terms-${t.terms_id}" aria-label="Name"></td>
    <td><input name="dueDays" value="${t.due_days}" size="4" inputmode="numeric" form="terms-${t.terms_id}" aria-label="Days until due"></td>
    <td class="muted">${t.customers} customer${t.customers === 1 ? '' : 's'}${t.templates ? `, ${t.templates} template${t.templates === 1 ? '' : 's'}` : ''}</td>
    <td class="actions"><form method="post" action="/settings/terms/${t.terms_id}" id="terms-${t.terms_id}" class="inline">${csrfField(csrf)}<button class="link">Save</button></form> ·
      <form method="post" action="/settings/terms/${t.terms_id}/delete" class="inline" data-confirm="Delete “${t.name}”?">${csrfField(csrf)}<button class="link">Delete</button></form></td>
  </tr>`)}
  <tr>
    <td><input name="name" placeholder="e.g. Net 45" form="terms-new" aria-label="New terms name"></td>
    <td><input name="dueDays" size="4" inputmode="numeric" placeholder="45" form="terms-new" aria-label="New terms days"></td>
    <td></td>
    <td class="actions"><form method="post" action="/settings/terms" id="terms-new" class="inline">${csrfField(csrf)}<button class="primary">Add</button></form></td>
  </tr>
  </tbody>
</table>`;
}

const qtyText = q => { const n = Number(q); return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))); };

export function itemsSettingsBody({ items }) {
  return html`<div class="page-actions"><p class="muted">Products and services you put on invoices. Inactive ones are hidden from new invoices but stay on old ones.</p>
  <span class="spacer"></span><a class="button primary" href="/settings/items/new">New product or service</a></div>
<table class="grid">
  <thead><tr><th>Name</th><th>Type</th><th>Income account</th><th>Description</th><th class="num">Price</th><th class="num">On hand</th><th class="num">Value</th><th>Status</th></tr></thead>
  <tbody>${items.map(i => html`<tr class="${i.active ? '' : 'inactive'}">
    <td><a href="/settings/items/${i.item_id}">${i.name}</a></td>
    <td>${{ service: 'Service', inventory: 'Inventory', product: 'Non-inventory' }[i.kind]}${i.sku ? html`<br><span class="muted">SKU ${i.sku}</span>` : ''}</td>
    <td>${i.income_account_name ?? 'Sales'}</td>
    <td class="memo">${i.description ?? ''}</td>
    <td class="num">${formatCents(i.rate_cents)}</td>
    <td class="num">${i.kind === 'inventory' ? html`<span class="${Number(i.qty_on_hand) < 0 || i.low ? 'status bad' : ''}">${qtyText(i.qty_on_hand)}</span>${i.low ? html`<br><span class="status warn">Reorder</span>` : ''}` : ''}</td>
    <td class="num">${i.kind === 'inventory' ? formatCents(i.value_cents) : ''}</td>
    <td>${i.active ? 'Active' : 'Inactive'}</td>
  </tr>`)}</tbody>
</table>`;
}

export const itemToValues = i => ({ name: i.name, description: i.description ?? '', kind: i.kind, rate: centsToInput(i.rate_cents), active: i.active,
  sku: i.sku ?? '', reorderPoint: i.reorder_point !== null && i.reorder_point !== undefined ? qtyText(i.reorder_point) : '',
  assetAccountId: i.asset_account_id ? String(i.asset_account_id) : '', startQty: '', asOf: '',
  incomeAccountId: i.income_account_id ? String(i.income_account_id) : '', expenseAccountId: i.expense_account_id ? String(i.expense_account_id) : '',
  cost: i.purchase_cost_cents !== null && i.purchase_cost_cents !== undefined ? centsToInput(i.purchase_cost_cents) : '' });
export const itemFormValues = params => ({ name: params.get('name') ?? '', description: params.get('description') ?? '', kind: params.get('kind') ?? 'product',
  rate: params.get('rate') ?? '', active: params.get('active') === '1', incomeAccountId: params.get('incomeAccountId') ?? '',
  expenseAccountId: params.get('expenseAccountId') ?? '', cost: params.get('cost') ?? '', sku: params.get('sku') ?? '', reorderPoint: params.get('reorderPoint') ?? '',
  assetAccountId: params.get('assetAccountId') ?? '', startQty: params.get('startQty') ?? '', asOf: params.get('asOf') ?? '' });

export function itemFormBody({ csrf, itemId = null, incomeAccounts = [], expenseAccounts = [], assetAccounts = [], item = null, history = [], v, error = null }) {
  const label = a => (a.number ? `${a.number} · ${a.name}` : a.name);
  return html`<form method="post" action="${itemId ? `/settings/items/${itemId}` : '/settings/items'}" class="editor">
  ${csrfField(csrf)}
  <div class="crumbs"><a href="/settings/items">‹ Products and services</a></div>
  <h2>${itemId ? 'Edit product or service' : 'New product or service'}</h2>
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Name', 'name', v.name, { required: true })}
    ${selectField('Type', 'kind', [['inventory', 'Inventory (track quantity)'], ['product', 'Non-inventory product'], ['service', 'Service']], v.kind, { attrs: 'data-item-kind' })}
    ${field('Price ($)', 'rate', v.rate, { attrs: 'inputmode="decimal"', hint: 'Fills in the rate on invoices' })}
    ${selectField('Income account', 'incomeAccountId', incomeAccounts.map(a => [a.account_id, a.number ? `${a.number} · ${a.name}` : a.name]), v.incomeAccountId, { blank: 'Sales (default)' })}
    ${field('Purchase cost ($)', 'cost', v.cost ?? '', { attrs: 'inputmode="decimal"', hint: 'Fills in the cost on bills and checks' })}
    ${selectField('Expense account (when bought)', 'expenseAccountId', expenseAccounts.map(a => [a.account_id, a.number ? `${a.number} · ${a.name}` : a.name]), v.expenseAccountId ?? '', { blank: 'Cost of Goods Sold (default)' })}
    ${field('Description', 'description', v.description, { cls: 'wide' })}
  </div>
  <fieldset class="inventory-fields" data-inventory-fields><legend>Inventory</legend>
    <div class="form-grid">
      ${field('SKU', 'sku', v.sku ?? '')}
      ${field('Reorder point', 'reorderPoint', v.reorderPoint ?? '', { attrs: 'inputmode="decimal"', hint: 'Flagged on the list when stock gets this low' })}
      ${selectField('Inventory asset account', 'assetAccountId', assetAccounts.map(a => [a.account_id, label(a)]), v.assetAccountId ?? '', { blank: 'Inventory Asset (default)' })}
      ${itemId ? '' : html`${field('Starting quantity on hand', 'startQty', v.startQty ?? '', { attrs: 'inputmode="decimal"', hint: 'Valued at the purchase cost' })}
        ${field('As of', 'asOf', v.asOf ?? '', { type: 'date' })}`}
    </div>
    ${item?.kind === 'inventory' ? html`<p>On hand: <strong>${qtyText(item.qty_on_hand)}</strong> · value ${formatCents(item.value_cents)}${Number(item.qty_on_hand) > 0 ? ` · average cost ${formatCents(Math.round(item.value_cents / Number(item.qty_on_hand)))}` : ''}
      · <a href="/settings/items/${itemId}/adjust">Adjust quantity</a></p>` : ''}
  </fieldset>
  ${checkbox('Active', 'active', v.active)}
  <div class="form-actions"><a href="/settings/items">Cancel</a><button class="primary">Save</button></div>
</form>
${history.length ? html`<h2 class="section-title">Stock history</h2>
<table class="grid"><thead><tr><th>Date</th><th>Transaction</th><th>Customer / vendor</th><th class="num">Qty</th><th class="num">Cost moved</th></tr></thead>
  <tbody>${history.map(h => html`<tr class="${h.voided_at ? 'inactive' : ''}"><td>${formatShortDate(h.txn_date)}</td>
    <td><a href="${['invoice', 'sales_receipt', 'credit_memo'].includes(h.type) ? `/txns/${h.txn_id}` : `/vtxns/${h.txn_id}`}">${TYPE_LABELS[h.type]} ${h.doc_number ?? ''}</a></td>
    <td>${h.customer_name ?? h.vendor_name ?? ''}</td>
    <td class="num">${h.type === 'inventory_adjustment' ? qtyText(h.qty_change) : (['invoice', 'sales_receipt', 'vendor_credit', 'cc_credit'].includes(h.type) ? '-' : '') + qtyText(h.quantity)}</td>
    <td class="num">${h.cost_cents !== null ? formatCents(h.cost_cents) : ''}</td></tr>`)}</tbody></table>` : ''}`;
}

export function adjustQuantityBody({ csrf, item, accounts, v, error = null }) {
  return html`<form method="post" action="/settings/items/${item.item_id}/adjust" class="editor">
  ${csrfField(csrf)}
  <div class="crumbs"><a href="/settings/items/${item.item_id}">‹ ${item.name}</a></div>
  <h2>Adjust quantity: ${item.name}</h2>
  <p class="muted">On hand now: ${qtyText(item.qty_on_hand)} (${formatCents(item.value_cents)}). Count what’s on the shelf and enter it; the difference is
    recorded at the average cost.</p>
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Date', 'txn_date', v.txnDate, { type: 'date', required: true })}
    ${field('New quantity on hand', 'newQty', v.newQty, { attrs: 'inputmode="decimal"', required: true })}
    ${selectField('Adjustment account', 'accountId', accounts.map(a => [a.account_id, a.number ? `${a.number} · ${a.name}` : a.name]), v.accountId)}
    ${field('Memo', 'memo', v.memo, { cls: 'wide' })}
  </div>
  <div class="form-actions"><a href="/settings/items/${item.item_id}">Cancel</a><button class="primary">Save adjustment</button></div>
</form>`;
}
