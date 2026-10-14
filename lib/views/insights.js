import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, selectField, field, errorBanner } from './forms.js';
import { bars, timeChart, PALETTE } from './charts.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { DASHBOARDS } from '../reports/dashboards.js';

const value = (unit, v) => (v === null || v === undefined ? '—' : unit === 'percent' ? `${(v * 100).toFixed(1)}%` : unit === 'number' ? (Math.round(v * 100) / 100).toLocaleString('en-US') : formatCents(v));
const tiles = list => html`<div class="tiles">${list.map(t => {
  const up = t.value !== null && t.prior !== null && t.value > t.prior, down = t.value !== null && t.prior !== null && t.value < t.prior;
  return html`<div class="tile"><p class="tile-label">${t.label}</p><p class="tile-value">${value(t.unit, t.value)}</p>
    <p class="tile-prior muted">${up ? '▲' : down ? '▼' : ''} vs ${value(t.unit, t.prior)} the month before</p></div>`;
})}</div>`;

// Reports → Dashboards: a tab per dashboard, the range of months, tiles and charts.
export function dashboardPage({ entityName, csrf, key, data, from, to, period }) {
  const L = data.labels, s = data.series, b = data.bars;
  const C = PALETTE;
  const charts = {
    standard: [timeChart('Income and expenses', L, [{ name: 'Income', values: s.revenue, color: C.brand }, { name: 'Expenses', values: s.expenses, color: C.amber }]),
      timeChart('Net income', L, [{ name: 'Net income', values: s.netIncome, color: C.brand }]),
      timeChart('Cash on hand', L, [{ name: 'Cash', values: s.cash, color: C.brand }], { kind: 'line' }),
      bars('What customers owe, by age', b.arAging ?? [], { total: false }), bars('Biggest expenses', b.topExpenses ?? [])],
    profitability: [timeChart('Revenue, cost of goods and gross profit', L, [{ name: 'Revenue', values: s.revenue, color: C.brand }, { name: 'Cost of goods', values: s.cogs, color: C.amber },
      { name: 'Gross profit', values: s.grossProfit, color: C.slate }]),
      timeChart('Gross and net margin', L, [{ name: 'Gross margin', values: s.grossMargin, color: C.brand }, { name: 'Net margin', values: s.netMargin, color: C.amber }], { kind: 'line', unit: 'percent' }),
      timeChart('Net income', L, [{ name: 'Net income', values: s.netIncome, color: C.brand }]), bars('Biggest expenses', b.topExpenses ?? [])],
    cash_flow: [timeChart('Cash on hand', L, [{ name: 'Cash', values: s.cash, color: C.brand }], { kind: 'line' }),
      timeChart('Operating cash flow', L, [{ name: 'Operating cash flow', values: s.ocf, color: C.brand }]),
      timeChart('What customers owe and what you owe', L, [{ name: 'A/R', values: s.ar, color: C.brand }, { name: 'A/P', values: s.ap, color: C.amber }], { kind: 'line' })],
    balance_sheet: [timeChart('Current and quick ratio', L, [{ name: 'Current ratio', values: s.currentRatio, color: C.brand }, { name: 'Quick ratio', values: s.quickRatio, color: C.amber }], { kind: 'line', unit: 'number' }),
      timeChart('Cash, A/R and A/P', L, [{ name: 'Cash', values: s.cash, color: C.brand }, { name: 'A/R', values: s.ar, color: C.amber }, { name: 'A/P', values: s.ap, color: C.slate }], { kind: 'line' })],
    receivables: [bars('A/R by age', b.arAging ?? [], { total: false }), bars('Who owes the most', b.arTop ?? []),
      timeChart('A/R over time', L, [{ name: 'A/R', values: s.ar, color: C.brand }], { kind: 'line' }),
      timeChart('Days sales outstanding', L, [{ name: 'Days', values: s.dso, color: C.amber }], { kind: 'line', unit: 'number' })],
    payables: [bars('A/P by age', b.apAging ?? [], { total: false }), bars('Who you owe the most', b.apTop ?? []),
      timeChart('A/P over time', L, [{ name: 'A/P', values: s.ap, color: C.brand }], { kind: 'line' })],
    revenue: [timeChart('Revenue, this year and last', L, [{ name: 'This year', values: s.revenue, color: C.brand }, { name: 'Last year', values: s.revenuePy ?? [], color: C.slate }]),
      bars('Top customers', b.topCustomers ?? []), bars('Top products and services', b.topProducts ?? [])],
    sales: [timeChart('Number of invoices', L, [{ name: 'Invoices', values: s.invoices, color: C.brand }], { unit: 'number' }),
      timeChart('Value of invoices', L, [{ name: 'Value', values: s.invoiceValue, color: C.brand }]),
      timeChart('Active and new customers', L, [{ name: 'Active', values: s.activeCustomers, color: C.brand }, { name: 'New', values: s.newCustomers, color: C.amber }], { unit: 'number' })],
  }[key];
  return layout({
    title: 'Dashboards', entityName, csrf, wide: true,
    body: html`<div class="crumbs"><a href="/reports">‹ Reports</a></div>
<div class="card-head"><h1>Dashboards</h1>
  <form method="get" action="/reports/dashboards" class="inline-fields dash-range"><input type="hidden" name="d" value="${key}">
    ${selectField('Months', 'period', [['last_12_months', 'Last 12 months'], ['last_6_months', 'Last 6 months'], ['this_year', 'This year'], ['last_year', 'Last year']], period)}
    <button>Show</button></form></div>
<nav class="dash-tabs" aria-label="Dashboards">${DASHBOARDS.map(([k, label]) => html`<a href="/reports/dashboards?d=${k}&amp;period=${period}" class="${k === key ? 'on' : ''}">${label}</a>`)}</nav>
<p class="muted small">${formatShortDate(from)} – ${formatShortDate(to)} · tiles show the last month against the month before.</p>
${tiles(data.tiles)}
<div class="charts dash-charts">${charts}</div>
<p><button type="button" data-print>Print</button> <a href="/reports/r/kpi_scorecard">KPI scorecard</a> · <a href="/reports/management">Management reports</a></p>`,
  });
}

// Reports → Cash flow planner.
export function cashFlowPage({ entityName, csrf, flash, plan, opts, canEdit, v = {}, error = null }) {
  const p = plan;
  const labels = p.buckets.map(b => formatShortDate(b.from).replace(/\/\d{2}$/, ''));
  return layout({
    title: 'Cash flow planner', entityName, csrf, flash, wide: true,
    body: html`<div class="crumbs"><a href="/reports">‹ Reports</a></div>
<h1>Cash flow</h1>
<div class="tiles">
  <div class="tile"><p class="tile-label">In the bank today</p><p class="tile-value">${formatCents(p.start)}</p>
    <p class="tile-prior muted">${p.balances.map(b => `${b.account.name} ${formatCents(b.balance)}`).join(' · ')}</p></div>
  <div class="tile"><p class="tile-label">Money coming in</p><p class="tile-value">${formatCents(p.openIn)}</p><p class="tile-prior muted">${formatCents(p.overdueIn)} overdue</p></div>
  <div class="tile"><p class="tile-label">Money going out</p><p class="tile-value">${formatCents(p.openOut)}</p><p class="tile-prior muted">${formatCents(p.overdueOut)} overdue</p></div>
  <div class="tile${p.buckets.some(b => b.low) ? ' warn' : ''}"><p class="tile-label">Lowest projected balance</p>
    <p class="tile-value">${formatCents(Math.min(...p.buckets.map(b => b.end)))}</p><p class="tile-prior muted">threshold ${formatCents(p.threshold)}</p></div>
</div>
<form method="get" action="/reports/cash-flow" class="card report-options"><div class="option-row">
  ${selectField('Weeks ahead', 'weeks', [['4', '4 weeks'], ['13', '13 weeks'], ['26', '26 weeks'], ['52', '52 weeks']], String(opts.weeks))}
  ${selectField('Overdue invoices and bills', 'overdue', [['1', 'Count them in the first week'], ['0', 'Leave them out']], opts.overdue ? '1' : '0')}
  ${selectField('The usual money in and out', 'trend', [['0', 'Leave it out'], ['1', 'Add it (from the last 3 months)']], opts.trend ? '1' : '0')}
  <button class="primary">Show</button></div>
  ${opts.trend ? html`<p class="muted small">The usual: ${formatCents(p.usualMonthly)} a month from sales receipts, expenses and checks that weren’t invoices or bills.</p>` : ''}
</form>
<section class="card">
  ${timeChart('Projected bank balance', labels, [{ name: 'Balance', values: p.buckets.map(b => b.end), color: PALETTE.brand },
    { name: 'Threshold', values: p.buckets.map(() => p.threshold), color: PALETTE.red }], { kind: 'line' })}
  <div class="report-wrap"><table class="report"><thead><tr><th class="label">Week of</th><th class="num">Starts</th><th class="num">Customers pay</th>
    <th class="num">You pay</th><th class="num">Planned</th>${opts.trend ? html`<th class="num">Usual</th>` : ''}<th class="num">Ends</th></tr></thead>
  <tbody>${p.buckets.map(b => html`<tr class="${b.low ? 'low' : ''}"><td class="label">${formatShortDate(b.from)}</td><td class="num">${formatCents(b.start)}</td>
    <td class="num">${formatCents(b.moneyIn)}</td><td class="num">${formatCents(-b.moneyOut)}</td><td class="num">${formatCents(b.planned)}</td>
    ${opts.trend ? html`<td class="num">${formatCents(b.usual)}</td>` : ''}<td class="num"><strong>${formatCents(b.end)}</strong></td></tr>`)}</tbody></table></div>
</section>
<section class="card">
  <h2>Planned items</h2>
  <p class="muted small">Money you expect that isn’t an invoice or bill yet: a loan, equipment, taxes, a big order.</p>
  ${p.items.length ? html`<ul class="link-list">${p.items.map(it => html`<li class="kpi-own"><span><strong>${it.name}</strong> ${it.direction === 'in' ? 'in' : 'out'} ${formatCents(Number(it.amount_cents))}
    on ${formatShortDate(it.start_date)}${it.repeat !== 'none' ? `, then every ${it.repeat === 'weekly' ? 'week' : 'month'}${it.end_date ? ` until ${formatShortDate(it.end_date)}` : ''}` : ''}</span>
    ${canEdit ? html`<form method="post" action="/reports/cash-flow/items/${it.item_id}/delete" class="inline">${csrfField(csrf)}<button class="link">Remove</button></form>` : ''}</li>`)}</ul>` : ''}
  ${canEdit ? html`<form method="post" action="/reports/cash-flow/items" class="stack-form">${csrfField(csrf)}
    ${errorBanner(error)}
    <div class="option-row">
      ${selectField('Money', 'direction', [['in', 'Coming in'], ['out', 'Going out']], v.direction ?? 'out')}
      ${field('What for', 'name', v.name ?? '', { required: true })}
      ${field('Amount', 'amount', v.amount ?? '', { required: true })}
      ${field('Date', 'date', v.date ?? p.today, { type: 'date', required: true })}
      ${selectField('Repeats', 'repeat', [['none', 'No'], ['weekly', 'Every week'], ['monthly', 'Every month']], v.repeat ?? 'none')}
      ${field('Until', 'until', v.until ?? '', { type: 'date' })}
    </div><button class="primary">Add to the plan</button></form>
  <form method="post" action="/reports/cash-flow/threshold" class="option-row">${csrfField(csrf)}
    ${field('Warn me below', 'threshold', (p.threshold / 100).toFixed(2))}<button>Save</button></form>` : ''}
</section>`,
  });
}
