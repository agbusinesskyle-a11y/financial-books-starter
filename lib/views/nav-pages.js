import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner } from './forms.js';
import { formatCents } from '../domain/money.js';
import { timeChart, PALETTE } from './charts.js';
import { icon, SOON, SOON_TITLE, PIN_CHOICES } from './nav.js';

// Pages behind the navigation (stage N1/N2): Home, All apps, Create, Bookmarks, Customize, Soon, Search.

const money = c => formatCents(c);

export function homePage({ entityName, csrf, flash, data, quick }) {
  const tile = (label, value, href, note = '', tone = '') => html`<a class="${`home-tile${tone ? ` ${tone}` : ''}`}" href="${href}"><span class="tile-label">${label}</span>
    <strong>${money(value)}</strong>${note ? html`<span class="muted small">${note}</span>` : ''}</a>`;
  const last = data.months.at(-1) ?? { revenue: 0, expenses: 0, net: 0 }, prev = data.months.at(-2) ?? { revenue: 0, expenses: 0, net: 0 };
  return layout({ title: 'Home', entityName, csrf, flash, wide: true, body: html`
  <h1>Home</h1>
  <section class="home-grid">
    <div class="card home-card"><h2>Money coming in</h2>
      <div class="tiles">${tile('Customers owe you', data.ar.open, '/reports/r/ar_aging_summary', `${data.ar.openCount} open`)}
      ${tile('Overdue', data.ar.overdue, '/reports/r/collections_report', `${data.ar.overdueCount} overdue`, data.ar.overdue > 0 ? 'bad' : '')}</div>
      <p class="small"><a href="/txns/new?type=invoice">Create invoice</a> · <a href="/txns/new?type=payment">Receive payment</a> · <a href="/customers">Customers</a></p></div>
    <div class="card home-card"><h2>Money going out</h2>
      <div class="tiles">${tile('You owe vendors', data.ap.open, '/reports/r/ap_aging_summary', `${data.ap.openCount} open`)}
      ${tile('Overdue', data.ap.overdue, '/reports/r/unpaid_bills', `${data.ap.overdueCount} overdue`, data.ap.overdue > 0 ? 'bad' : '')}</div>
      <p class="small"><a href="/vtxns/new?type=bill">Enter bill</a> · <a href="/pay-bills">Pay bills</a> · <a href="/vendors">Vendors</a></p></div>
    <div class="card home-card"><h2>Profit and loss</h2>
      <div class="tiles">${tile('Net income this month', last.net, '/reports/r/profit_and_loss?period=this_month', `Income ${money(last.revenue)} · Expenses ${money(last.expenses)}`, last.net < 0 ? 'bad' : '')}
      ${tile('Last month', prev.net, '/reports/r/profit_and_loss?period=last_month', `Income ${money(prev.revenue)}`)}</div>
      <p class="muted small">${data.basis === 'cash' ? 'Cash basis' : 'Accrual basis'}</p></div>
    <div class="card home-card"><h2>Bank and card accounts</h2>
      ${data.banks.length ? html`<ul class="flat balances">${data.banks.map(b => html`<li><a href="/settings/accounts/${b.id}">${b.name}</a><span class="${`num${b.balance < 0 ? ' neg' : ''}`}">${money(b.balance)}</span></li>`)}</ul>`
        : html`<p class="muted">No bank accounts yet.</p>`}
      <p class="small"><a href="/reconcile">Reconcile</a> · <a href="/deposits/new">Bank deposit</a></p></div>
    <div class="card home-card wide-card">${timeChart('Income and expenses, last 6 months', data.months.map(m => m.label), [
      { name: 'Income', values: data.months.map(m => m.revenue), color: PALETTE.brand }, { name: 'Expenses', values: data.months.map(m => m.expenses), color: PALETTE.amber }])}</div>
    <div class="card home-card"><h2>Shortcuts</h2><div class="flat-links">${quick.map(i => html`<a href="${i.href}">${i.label}</a>`)}</div></div>
  </section>` });
}

const linkOf = i => html`<a href="${i.href ?? `/soon/${i.slug}`}" class="${i.href ? '' : 'soon'}">${i.label}${i.href ? '' : html`<span class="soon-tag">Soon</span>`}</a>`;

export function appsPage({ entityName, csrf, groups, reports }) {
  return layout({ title: 'All apps', entityName, csrf, body: html`<h1>All apps</h1>
  <div class="apps-grid">
    ${reports.length ? html`<section class="card"><h2>${icon('reports')} Reports</h2><div class="flat-links">${reports.map(linkOf)}</div></section>` : ''}
    ${groups.map(g => html`<section class="card"><h2>${icon(g.icon)} ${g.label}</h2><div class="flat-links">${g.items.map(linkOf)}</div></section>`)}
  </div>` });
}

export function createPage({ entityName, csrf, create }) {
  return layout({ title: 'Create', entityName, csrf, body: html`<h1>Create</h1>
  <div class="apps-grid">${create.map(([h, items]) => html`<section class="card"><h2>${h}</h2><div class="flat-links">${items.map(linkOf)}</div></section>`)}</div>` });
}

export function bookmarksPage({ entityName, csrf, flash, bookmarks, error = null }) {
  return layout({ title: 'Bookmarks', entityName, csrf, flash, body: html`<h1>Bookmarks</h1>${errorBanner(error)}
  <p class="muted">Open any page and choose <strong>Bookmark this page</strong> under Bookmarks to add it here.</p>
  ${bookmarks.length ? html`<ul class="card bookmark-list">${bookmarks.map((b, i) => html`<li><a href="${b.href}">${b.label}</a>
    <span class="row-actions">${i > 0 ? html`<form method="post" action="/bookmarks/up" class="inline">${csrfField(csrf)}<input type="hidden" name="href" value="${b.href}"><button class="link">Move up</button></form>` : ''}
    <form method="post" action="/bookmarks/remove" class="inline">${csrfField(csrf)}<input type="hidden" name="href" value="${b.href}"><input type="hidden" name="back" value="/bookmarks"><button class="link">Remove</button></form></span></li>`)}</ul>`
    : html`<p class="card">No bookmarks yet.</p>`}` });
}

export function navigationPage({ entityName, csrf, flash, pins, error = null, pinChoices = PIN_CHOICES }) {
  return layout({ title: 'Customize navigation', entityName, csrf, flash, body: html`<h1>Customize navigation</h1>${errorBanner(error)}
  <form method="post" action="/navigation" class="card editor">${csrfField(csrf)}
    <fieldset><legend>Pinned apps (up to 6) — shown on the left under Pinned</legend>
    ${pinChoices.map(([k, label]) => html`<label class="check"><input type="checkbox" name="pin" value="${k}"${pins.includes(k) ? ' checked' : ''}> ${label}</label>`)}</fieldset>
    <p><button class="primary">Save</button> <a href="/bookmarks">Manage bookmarks</a></p>
  </form>` });
}

export function soonPage({ entityName, csrf, slug }) {
  const [what, near] = SOON[slug];
  const title = SOON_TITLE[slug] ?? slug;
  return layout({ title, entityName, csrf, body: html`<section class="card soon-page"><span class="soon-tag">Coming next</span><h1>${title}</h1>
    <p>${what}</p><p class="muted">This part of the books isn’t built yet. It’s on the list and will be added here.</p>
    ${near.length ? html`<h2>What you can use today</h2><ul class="flat">${near.map(([label, href]) => html`<li><a href="${href}">${label}</a></li>`)}</ul>` : ''}</section>` });
}

export function searchPage({ entityName, csrf, result }) {
  return layout({ title: result.q ? `Search: ${result.q}` : 'Search', entityName, csrf, body: html`<h1>Search</h1>
  <form method="get" action="/search" class="search-page-form" role="search"><input type="search" name="q" value="${result.q}" aria-label="Search" placeholder="Name, number, memo, amount, report or page" autofocus>
    <button class="primary">Search</button></form>
  ${result.q && !result.sections.length ? html`<p class="card">Nothing matches “${result.q}”.</p>` : ''}
  ${result.sections.map(([title, rows]) => html`<section class="card search-section"><h2>${title}</h2><ul class="flat">${rows.map(r => html`<li><a href="${r.href}">${r.label}</a>${r.detail ? html` <span class="muted small">${r.detail}</span>` : ''}</li>`)}</ul></section>`)}` });
}
