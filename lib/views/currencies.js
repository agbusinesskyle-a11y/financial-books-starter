import { html } from './html.js';
import { csrfField, errorBanner, field, selectField, postButton } from './forms.js';
import { formatShortDate } from '../domain/dates.js';
import { CURRENCIES, HOME } from '../domain/fx.js';

export function currenciesBody({ csrf, on, currencies, rates = {}, today, error = null }) {
  if (!on) {
    return html`<h2>Multicurrency</h2>
${errorBanner(error)}
<p>Turn this on to bill customers and pay vendors in their own currency. The books stay in ${HOME}: each foreign invoice, bill and payment keeps its own
  amounts and exchange rate, and the difference when a payment comes in at another rate is posted to Exchange Gain or Loss.</p>
<p class="ledger-check warn">Once multicurrency is on it can’t be turned off.</p>
${postButton({ action: '/settings/currencies/on', csrf, label: 'Turn on multicurrency', cls: 'button primary', confirm: 'Turn on multicurrency? This can’t be undone.' })}`;
  }
  const have = new Set(currencies.map(c => c.code));
  return html`<h2>Currencies</h2>
${errorBanner(error)}
<p class="muted">Home currency: <strong>${HOME}</strong>. Rates are how many ${HOME} one unit of the currency is worth, from the date given on.
  Set a customer’s or vendor’s currency on their details before their first transaction.</p>
${currencies.length ? html`<table class="grid">
  <thead><tr><th>Currency</th><th class="num">Latest rate</th><th>Since</th><th>Used by</th><th>Add a rate</th></tr></thead>
  <tbody>${currencies.map(c => html`<tr>
    <td data-label="Currency"><strong>${c.code}</strong> ${c.name}</td>
    <td class="num" data-label="Latest rate">${c.rate ?? '—'}</td>
    <td data-label="Since">${c.rate_date ? formatShortDate(c.rate_date) : '—'}</td>
    <td data-label="Used by">${c.used_by} customer${c.used_by === 1 ? '' : 's'} / vendor${c.used_by === 1 ? '' : 's'}</td>
    <td data-label="Add a rate"><form method="post" action="/settings/currencies/${c.code}/rate" class="inline-fields rate-form">${csrfField(csrf)}
      <input type="date" name="date" value="${today}" aria-label="Date"><input name="rate" inputmode="decimal" size="9" placeholder="1.0834" aria-label="Rate" required>
      <button>Add</button></form>
      ${(rates[c.code] ?? []).length ? html`<details><summary>History</summary><ul class="plain">${rates[c.code].map(r => html`<li>${formatShortDate(r.rate_date)}: ${r.rate}</li>`)}</ul></details>` : ''}</td>
  </tr>`)}</tbody>
</table>` : html`<p class="muted">No currencies yet.</p>`}
<form method="post" action="/settings/currencies" class="editor add-row">
  ${csrfField(csrf)}
  <h2>Add a currency</h2>
  <div class="form-grid">
    ${selectField('Currency', 'code', CURRENCIES.filter(([k]) => !have.has(k)).map(([k, n]) => [k, `${k} — ${n}`]), '', { blank: 'Choose…' })}
    ${field(`Rate (${HOME} per 1)`, 'rate', '', { attrs: 'inputmode="decimal" placeholder="1.0834"', required: true })}
    ${field('As of', 'date', today, { type: 'date', required: true })}
  </div>
  <div class="form-actions"><button class="primary">Add currency</button></div>
</form>
<form method="post" action="/settings/currencies/revalue" class="editor add-row">
  ${csrfField(csrf)}
  <h2>Revalue open balances</h2>
  <p class="muted small">Values open foreign invoices, bills and credits at the rates on a date (usually month end) and posts the unrealized gain or loss.
    It reverses itself the next day, so it only affects reports as of that date.</p>
  <div class="form-grid">${field('Revalue as of', 'date', today, { type: 'date', required: true })}</div>
  <div class="form-actions"><button>Revalue</button></div>
</form>`;
}
