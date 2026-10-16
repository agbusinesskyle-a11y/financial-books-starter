import { html } from './html.js';
import { layout } from './layout.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { txnStatus, TYPE_LABELS } from '../domain/status.js';
import { dateOptions } from '../domain/filters.js';
import { linkOf } from './accounts.js';
import { timeChart, bars, PALETTE } from './charts.js';
import { LISTS, statusLabel, PAGE_SIZE } from '../data/lists.js';

// Company-wide list pages and Overview pages (stage N3).

const select = (name, label, options, value) => html`<label class="field-inline"><span>${label}</span>
  <select name="${name}" data-autosubmit>${options.map(([v, l]) => html`<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`)}</select></label>`;

// The main action for a row, by what it is and where it stands (QBO shows one next to View/Edit).
function primaryAction(t) {
  if (t.voided_at) return null;
  if (['invoice', 'late_fee'].includes(t.type) && t.open_cents > 0) return ['Receive payment', `/txns/new?type=payment&customer=${t.customer_id}`];
  if (['invoice', 'sales_receipt', 'credit_memo', 'estimate'].includes(t.type)) return ['Print', `/txns/${t.txn_id}.pdf`];
  if (t.type === 'bill' && t.open_cents > 0 && t.approval_status !== 'awaiting' && t.approval_status !== 'rejected') return ['Schedule payment', `/pay-bills?vendor=${t.vendor_id}`];
  if ((t.type === 'check' || (t.type === 'bill_payment' && t.payment_method === 'Check')) && !t.printed_at) return ['Print check', '/checks'];
  if (t.type === 'item_receipt') return ['Enter bill', `/vtxns/new?type=bill&vendor=${t.vendor_id}`];
  return null;
}

export function listPage({ entityName, csrf, slug, filters: f, result, parties, today }) {
  const def = LISTS[slug];
  const isCustomer = def.side === 'customer';
  const qs = over => {
    const p = new URLSearchParams();
    const v = { ...f, ...over };
    if (v.type !== 'all') p.set('type', v.type);
    if (v.status !== 'all') p.set('status', v.status);
    if (v.date !== 'all') p.set('date', v.date);
    if (v.date === 'custom' && v.from && v.to) { p.set('from', v.from); p.set('to', v.to); }
    if (v.party) p.set('party', String(v.party));
    if (v.q) p.set('q', v.q);
    if (v.sort !== 'date') p.set('sort', v.sort);
    if (v.dir !== 'desc') p.set('dir', v.dir);
    if (v.page > 1) p.set('page', String(v.page));
    const s = p.toString();
    return `/${slug}${s ? `?${s}` : ''}`;
  };
  const sortLink = (key, label) => {
    const active = f.sort === key;
    const dir = active && f.dir === 'desc' ? 'asc' : 'desc';
    return html`<a href="${qs({ sort: key, dir, page: 1 })}">${label}${active ? (f.dir === 'desc' ? ' ▼' : ' ▲') : ''}</a>`;
  };
  const first = result.count ? (f.page - 1) * PAGE_SIZE + 1 : 0;
  const last = Math.min(f.page * PAGE_SIZE, result.count);
  const showDue = def.types.some(t => ['invoice', 'bill', 'estimate', 'late_fee'].includes(t));
  const showOpen = def.types.some(t => ['invoice', 'bill', 'late_fee', 'payment', 'vendor_credit', 'credit_memo'].includes(t));
  const newLinks = {
    'sales-transactions': [['Invoice', '/txns/new?type=invoice'], ['Receive payment', '/txns/new?type=payment'], ['Sales receipt', '/txns/new?type=sales_receipt'], ['Estimate', '/txns/new?type=estimate'], ['Credit memo', '/txns/new?type=credit_memo']],
    invoices: [['Create invoice', '/txns/new?type=invoice']], estimates: [['Create estimate', '/txns/new?type=estimate']],
    'expense-transactions': [['Expense', '/vtxns/new?type=expense'], ['Check', '/vtxns/new?type=check'], ['Bill', '/vtxns/new?type=bill'], ['Pay bills', '/pay-bills'], ['Purchase order', '/vtxns/new?type=purchase_order'], ['Credit card credit', '/vtxns/new?type=cc_credit']],
    bills: [['Create bill', '/vtxns/new?type=bill'], ['Pay bills', '/pay-bills']], 'bill-payments': [['Pay bills', '/pay-bills']], 'item-receipts': [['Receive items', '/vtxns/new?type=item_receipt']],
  }[slug];
  const cols = 7 + (showDue ? 1 : 0) + (showOpen ? 1 : 0);
  return layout({ title: def.title, entityName, csrf, wide: true, body: html`
  <div class="page-actions"><h1>${def.title}</h1><span class="spacer"></span>${newLinks.map(([l, h], i) => html`<a class="${i === 0 ? 'button primary' : 'button'}" href="${h}">${l}</a>`)}</div>
  <section class="list-summary">
    <div><span class="muted small">${result.count === 1 ? '1 transaction' : `${result.count.toLocaleString('en-US')} transactions`}</span><strong>${formatCents(result.total)}</strong></div>
    ${showOpen ? html`<div><span class="muted small">Open balance</span><strong>${formatCents(result.open)}</strong></div>` : ''}
  </section>
  <form method="get" action="/${slug}" class="filters list-filters">
    ${def.typeOptions ? select('type', 'Type', def.typeOptions, f.type) : ''}
    ${select('status', 'Status', def.statuses.map(s => [s, statusLabel(s)]), f.status)}
    ${select('date', 'Date', dateOptions(today), f.date)}
    <span class="custom-dates${f.date === 'custom' ? '' : ' hidden'}">
      <label>From <input type="date" name="from" value="${f.from ?? ''}"></label>
      <label>To <input type="date" name="to" value="${f.to ?? ''}"></label>
    </span>
    ${select('party', isCustomer ? 'Customer' : 'Vendor', [['', isCustomer ? 'All customers' : 'All vendors'], ...parties.map(p => [String(p.id), p.name])], f.party ? String(f.party) : '')}
    <label class="field-inline"><span>Find</span><input type="search" name="q" value="${f.q}" placeholder="No., memo or name"></label>
    <input type="hidden" name="sort" value="${f.sort}"><input type="hidden" name="dir" value="${f.dir}">
    <button class="apply">Apply</button>
  </form>
  ${f.dateProblem ? html`<p class="muted small" role="status">${f.dateProblem}</p>` : ''}
  <div class="table-scroll"><table class="grid txns">
    <thead><tr>
      <th>${sortLink('date', 'Date')}</th><th>Type</th><th>${sortLink('number', 'No.')}</th>
      <th>${sortLink('party', isCustomer ? 'Customer' : 'Vendor')}</th><th>Memo</th>
      ${showDue ? html`<th>${sortLink('due', 'Due date')}</th>` : ''}
      <th class="num">${sortLink('amount', 'Amount')}</th>${showOpen ? html`<th class="num">Open balance</th>` : ''}
      <th>Status</th><th class="actions">Action</th>
    </tr></thead>
    <tbody>${result.rows.length ? result.rows.map(t => {
      const s = txnStatus(t, today);
      const act = primaryAction(t);
      const party = t.customer_id ? html`<a href="/customers/${t.customer_id}">${t.party_name}</a>` : t.vendor_id ? html`<a href="/vendors/${t.vendor_id}">${t.party_name}</a>` : '';
      return html`<tr>
        <td>${formatShortDate(t.txn_date)}</td><td>${TYPE_LABELS[t.type] ?? t.type}</td><td>${t.doc_number ?? t.payment_ref ?? ''}</td>
        <td>${party}</td><td class="memo">${t.memo ?? ''}</td>
        ${showDue ? html`<td>${t.due_date ? formatShortDate(t.due_date) : ''}</td>` : ''}
        <td class="num">${formatCents(t.total_cents)}</td>
        ${showOpen ? html`<td class="num">${['estimate', 'purchase_order'].includes(t.type) || t.voided_at ? '' : formatCents(t.open_cents)}</td>` : ''}
        <td><span class="status ${s.tone}">${s.text}</span></td>
        <td class="actions"><a href="${linkOf(t)}">View/Edit</a>${act ? html` · <a href="${act[1]}">${act[0]}</a>` : ''}</td>
      </tr>`;
    }) : html`<tr><td colspan="${cols}" class="muted">Nothing matches these filters.</td></tr>`}
    ${result.rows.length ? html`<tr class="total-row"><td colspan="${showDue ? 6 : 5}"><strong>Total</strong> <span class="muted small">(all ${result.count} matching; payments and credits subtract; voided, estimates, orders and deposits left out)</span></td>
      <td class="num"><strong>${formatCents(result.total)}</strong></td>${showOpen ? html`<td class="num"><strong>${formatCents(result.open)}</strong></td>` : ''}<td></td><td></td></tr>` : ''}
    </tbody>
  </table></div>
  <nav class="pager" aria-label="Pages">
    ${f.page > 1 ? html`<a href="${qs({ page: 1 })}">First</a><a href="${qs({ page: f.page - 1 })}">‹ Previous</a>` : ''}
    <span>${first}–${last} of ${result.count}</span>
    ${f.page < result.pages ? html`<a href="${qs({ page: f.page + 1 })}">Next ›</a><a href="${qs({ page: result.pages })}">Last</a>` : ''}
  </nav>` });
}

export function projectsListPage({ entityName, csrf, projects, status }) {
  const tot = k => projects.reduce((s, p) => s + p[k], 0);
  const STATUS = { in_progress: 'In progress', completed: 'Completed', canceled: 'Canceled' };
  return layout({ title: 'Projects', entityName, csrf, wide: true, body: html`
  <div class="page-actions"><h1>Projects</h1><span class="spacer"></span><a class="button primary" href="/customers">New project (from a customer)</a></div>
  <form method="get" action="/projects" class="filters">${select('status', 'Status', [['all', 'All'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['canceled', 'Canceled']], status)}
    <button class="apply">Apply</button></form>
  <div class="table-scroll"><table class="grid">
    <thead><tr><th>Project</th><th>Customer</th><th>Status</th><th>Start</th><th>End</th><th class="num">Income</th><th class="num">Costs</th><th class="num">Profit</th><th class="num">Still owed</th></tr></thead>
    <tbody>${projects.length ? projects.map(p => html`<tr><td><a href="/projects/${p.project_id}">${p.name}</a></td><td><a href="/customers/${p.customer_id}">${p.customer_name}</a></td>
      <td>${STATUS[p.status] ?? p.status}</td><td>${p.start_date ? formatShortDate(p.start_date) : ''}</td><td>${p.end_date ? formatShortDate(p.end_date) : ''}</td>
      <td class="num">${formatCents(p.income_cents)}</td><td class="num">${formatCents(p.cost_cents)}</td><td class="${`num${p.profit_cents < 0 ? ' neg' : ''}`}">${formatCents(p.profit_cents)}</td>
      <td class="num">${formatCents(p.open_cents)}</td></tr>`) : html`<tr><td colspan="9" class="muted">No projects yet. Projects are started from a customer’s Projects tab.</td></tr>`}
    ${projects.length ? html`<tr class="total-row"><td colspan="5"><strong>Total</strong></td><td class="num"><strong>${formatCents(tot('income_cents'))}</strong></td>
      <td class="num"><strong>${formatCents(tot('cost_cents'))}</strong></td><td class="num"><strong>${formatCents(tot('profit_cents'))}</strong></td><td class="num"><strong>${formatCents(tot('open_cents'))}</strong></td></tr>` : ''}</tbody>
  </table></div>` });
}

const tile = (label, value, href, note = '', tone = '') => html`<a class="${`home-tile${tone ? ` ${tone}` : ''}`}" href="${href}"><span class="tile-label">${label}</span>
  <strong>${typeof value === 'number' ? formatCents(value) : value}</strong>${note ? html`<span class="muted small">${note}</span>` : ''}</a>`;
const count = n => ({ toString: () => n.toLocaleString('en-US') });
const plain = n => n.toLocaleString('en-US');

export function overviewPage({ entityName, csrf, kind, data }) {
  const body = {
    sales: () => html`<h1>Sales overview</h1><section class="home-grid">
      <div class="card home-card"><h2>Unpaid</h2><div class="tiles">
        ${tile('Overdue', data.ar.overdue, '/invoices?status=overdue', `${data.ar.overdueCount} invoices`, data.ar.overdue > 0 ? 'bad' : '')}
        ${tile('Not due yet', data.ar.notDue, '/invoices?status=not_due', `${data.ar.notDueCount} invoices`)}</div>
        <p class="small"><a href="/invoices?status=unpaid">All unpaid invoices</a>${data.ar.credits ? html` · <span class="muted">${formatCents(-data.ar.credits)} in unapplied credits</span>` : ''}</p></div>
      <div class="card home-card"><h2>Paid</h2><div class="tiles">
        ${tile('Paid last 30 days', data.paid30, '/sales-transactions?type=payment&date=last_30')}
        ${tile('Not deposited', data.undeposited, '/deposits/new', 'In Undeposited Funds')}</div>
        <p class="small"><a href="/deposits">Deposits</a> · <a href="/txns/new?type=payment">Receive payment</a></p></div>
      <div class="card home-card wide-card">${timeChart('Income, last 12 months', data.months.map(m => m.label), [{ name: 'Income', values: data.months.map(m => m.value), color: PALETTE.brand }])}</div>
      <div class="card home-card"><h2>Who owes the most</h2>${partyList(data.ar.top, 'customers')}</div>
      <div class="card home-card"><h2>Go to</h2><div class="flat-links"><a href="/sales-transactions">Sales transactions</a><a href="/invoices">Invoices</a>
        <a href="/estimates">Estimates</a><a href="/sales-queue?which=print">Print later</a><a href="/sales-queue?which=send">Send later</a><a href="/customers">Customers</a><a href="/settings/items">Products &amp; services</a><a href="/reports/dashboards?d=revenue">Revenue dashboard</a></div></div>
    </section>`,
    expenses: () => html`<h1>Expenses overview</h1><section class="home-grid">
      <div class="card home-card"><h2>Bills to pay</h2><div class="tiles">
        ${tile('Overdue', data.ap.overdue, '/bills?status=overdue', `${data.ap.overdueCount} bills`, data.ap.overdue > 0 ? 'bad' : '')}
        ${tile('Not due yet', data.ap.notDue, '/bills?status=not_due', `${data.ap.notDueCount} bills`)}</div>
        <p class="small"><a href="/pay-bills">Pay bills</a> · <a href="/vtxns/new?type=bill">Create bill</a></p></div>
      <div class="card home-card"><h2>Last 30 days</h2><div class="tiles">
        ${tile('Spent', data.spent30, '/reports/r/profit_and_loss?period=last_30_days', 'Expenses and cost of goods')}
        ${tile('Paid out', data.paid30, '/expense-transactions?date=last_30', 'Bill payments, checks, expenses')}</div></div>
      <div class="card home-card">${data.categories.length ? bars('Spending by category, last 30 days', data.categories.slice(0, 8).map(c => ({ label: c.name, value: c.value })))
        : html`<h2>Spending by category</h2><p class="muted">Nothing spent in the last 30 days.</p>`}</div>
      <div class="card home-card wide-card">${timeChart('Expenses, last 12 months', data.months.map(m => m.label), [{ name: 'Expenses', values: data.months.map(m => m.value), color: PALETTE.amber }])}</div>
      <div class="card home-card"><h2>Who you owe the most</h2>${partyList(data.ap.top, 'vendors')}</div>
    </section>`,
    customers: () => html`<h1>Customer Hub overview</h1><section class="home-grid">
      <div class="card home-card"><h2>Customers</h2><div class="tiles">
        ${tile('Active', count(data.active), '/customers')}${tile('New this month', count(data.new_this_month), '/customers')}</div>
        <p class="small muted">${plain(data.inactive)} inactive</p></div>
      <div class="card home-card"><h2>Owed to you</h2><div class="tiles">
        ${tile('Open', data.ar.open, '/reports/r/ar_aging_summary')}${tile('Overdue', data.ar.overdue, '/reports/r/collections_report', `${data.ar.overdueCount} invoices`, data.ar.overdue > 0 ? 'bad' : '')}</div></div>
      <div class="card home-card"><h2>Top customers this year</h2>${partyList(data.topSales, 'customers', 'No sales yet this year.')}</div>
      <div class="card home-card"><h2>Who owes the most</h2>${partyList(data.ar.top, 'customers')}</div>
      <div class="card home-card"><h2>Go to</h2><div class="flat-links"><a href="/customers">Customers &amp; leads</a><a href="/estimates">Estimates</a>
        <a href="/customers/new">Add customer</a><a href="/reports/dashboards?d=receivables">Receivables dashboard</a></div></div>
    </section>`,
    projects: () => html`<h1>Projects overview</h1><section class="home-grid">
      <div class="card home-card"><h2>Projects</h2><div class="tiles">
        ${tile('In progress', count(data.inProgress), '/projects?status=in_progress')}${tile('Completed', count(data.completed), '/projects?status=completed')}</div>
        <p class="small muted">${plain(data.count)} in all${data.canceled ? `, ${data.canceled} canceled` : ''}</p></div>
      <div class="card home-card"><h2>All projects</h2><div class="tiles">
        ${tile('Income', data.income, '/projects')}${tile('Profit', data.income - data.cost, '/projects', `Costs ${formatCents(data.cost)}`, data.income - data.cost < 0 ? 'bad' : '')}</div></div>
      <div class="card home-card"><h2>Most profitable</h2>${data.top.length ? html`<ul class="flat balances">${data.top.map(p => html`<li><a href="/projects/${p.project_id}">${p.name}</a><span class="num">${formatCents(p.profit_cents)}</span></li>`)}</ul>`
        : html`<p class="muted">No projects yet.</p>`}<p class="small"><a href="/projects">All projects</a> · <a href="/reports/r/project_profitability_summary">Project profitability report</a></p></div>
    </section>`,
    inventory: () => html`<h1>Inventory overview</h1><section class="home-grid">
      <div class="card home-card"><h2>Stock</h2><div class="tiles">
        ${tile('Inventory value', data.value, '/reports/r/inventory_valuation_summary')}${tile('Items tracked', count(data.count), '/settings/items')}</div></div>
      <div class="card home-card"><h2>Low stock</h2>${stockList(data.low, 'Nothing is at or below its reorder point.')}</div>
      <div class="card home-card"><h2>Out of stock</h2>${stockList(data.out, 'Nothing is out of stock.')}</div>
      <div class="card home-card"><h2>Highest value</h2>${data.top.length ? html`<ul class="flat balances">${data.top.map(i => html`<li><a href="/settings/items/${i.item_id}">${i.name}</a><span class="num">${formatCents(Number(i.value_cents))}</span></li>`)}</ul>` : html`<p class="muted">No inventory items.</p>`}
        <p class="small"><a href="/vendors?show=po">Purchase orders</a> · <a href="/vtxns/new?type=purchase_order">Create purchase order</a></p></div>
    </section>`,
  }[kind];
  const title = { sales: 'Sales overview', expenses: 'Expenses overview', customers: 'Customer Hub overview', projects: 'Projects overview', inventory: 'Inventory overview' }[kind];
  return layout({ title, entityName, csrf, wide: true, body: body() });
}

function partyList(rows, kind, empty = 'Nobody owes anything.') {
  return rows.length ? html`<ul class="flat balances">${rows.map(r => html`<li><a href="/${kind}/${r.id}">${r.name}</a><span class="num">${formatCents(r.value ?? r.open)}</span></li>`)}</ul>`
    : html`<p class="muted">${empty}</p>`;
}
function stockList(items, empty) {
  return items.length ? html`<ul class="flat balances">${items.slice(0, 8).map(i => html`<li><a href="/settings/items/${i.item_id}">${i.name}</a><span class="num">${Number(i.qty_on_hand).toLocaleString('en-US')} on hand</span></li>`)}</ul>`
    : html`<p class="muted">${empty}</p>`;
}
