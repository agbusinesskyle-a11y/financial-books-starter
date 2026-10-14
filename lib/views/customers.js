import { html } from './html.js';
import { layout } from './layout.js';
import { formatCents } from '../domain/money.js';

export function customersPage({ entityName, csrf, customers, search, flash = null }) {
  const totalOpen = customers.reduce((s, c) => s + c.open_cents, 0);
  return layout({
    title: 'Customers', entityName, csrf, flash,
    body: html`<section class="card">
  <div class="card-head">
    <h1>Customers</h1>
    <a class="button primary" href="/customers/new">New customer</a>
    <form method="get" action="/customers" class="search">
      <input type="search" name="q" value="${search}" placeholder="Search by name, email, or phone" aria-label="Search customers">
      <button>Search</button>
    </form>
  </div>
  <p class="muted">${customers.length} customer${customers.length === 1 ? '' : 's'} · ${formatCents(totalOpen)} open</p>
  <table class="grid">
    <thead><tr><th>Customer</th><th>Email</th><th>Phone</th><th class="num">Open balance</th></tr></thead>
    <tbody>
    ${customers.length ? customers.map(c => html`<tr class="${c.active ? '' : 'inactive'}">
      <td><a href="/customers/${c.customer_id}">${c.display_name}</a>${c.active ? '' : html` <span class="tag">Inactive</span>`}</td>
      <td>${c.email ?? ''}</td>
      <td>${c.phone ?? ''}</td>
      <td class="num">${formatCents(c.open_cents)}</td>
    </tr>`) : html`<tr><td colspan="4" class="muted">No customers match “${search}”.</td></tr>`}
    </tbody>
  </table>
</section>`,
  });
}
