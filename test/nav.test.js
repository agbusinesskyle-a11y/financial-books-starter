import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { runReport } from '../lib/reports/engine.js';
import { homeData } from '../lib/data/home.js';
import { globalSearch } from '../lib/data/search.js';
import { cleanHref } from '../lib/data/nav.js';
import { appNav, GROUPS, CREATE, GEAR, REPORTS_MENU, SOON } from '../lib/views/nav.js';
import { canAccess, homeFor } from '../lib/domain/roles.js';
import { startApp } from './app-harness.js';

// Stage N1/N2: the app navigation (rail, All apps, Create, Bookmarks, gear menu, bottom bar), Home, Soon pages and search.
const TODAY = '2026-10-12';
let app, scope, ctx, pool;
before(async () => {
  app = await startApp();
  pool = app.db.pool;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  const [accounting, accounts, sys] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope), systemAccounts(pool, scope.orgId, scope.entityId)]);
  ctx = { accounting, accounts, retainedAccountId: sys.retained, sys };
});
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});
const run = (key, query = {}) => runReport(pool, { ...scope, key, query, today: TODAY, ...ctx });
const allItems = [...GROUPS.flatMap(g => g.items), ...CREATE.flatMap(([, i]) => i), ...GEAR.flatMap(([, i]) => i), ...REPORTS_MENU];

test('every signed-in page carries the navigation instead of the old top bar', async () => {
  for (const path of ['/customers', '/customers/new', '/vendors', '/settings', '/reports', '/home']) {
    const body = await (await app.get(path)).text();
    assert.match(body, /<body class="with-nav">/, path);
    assert.match(body, /<nav class="rail"/, path);
    assert.match(body, /<aside class="apps-panel/, path);
    assert.match(body, /<nav class="bottombar"/, path);
    assert.match(body, /action="\/search"/, path);
    assert.doesNotMatch(body, /class="topnav"|fb:nav/, `${path}: old header and markers are gone`);
  }
  // Pages for outsiders keep the simple header.
  const login = await (await fetch(`${app.base}/login`)).text();
  assert.doesNotMatch(login, /class="rail"/);
});

test('the full QBO menu is there, with unbuilt pages marked Soon and every Soon page explained', async () => {
  const body = await (await app.get('/customers')).text();
  for (const g of GROUPS) assert.ok(body.includes(`<span>${g.label.replace('&', '&amp;')}</span>`), g.label);
  assert.match(body, /href="\/soon\/payroll" class="soon">Payroll<span class="soon-tag">Soon<\/span>/);
  for (const i of allItems.filter(x => !x.href)) {
    assert.ok(Object.hasOwn(SOON, i.slug), `Soon text for ${i.slug}`);
    const res = await app.get(`/soon/${i.slug}`);
    assert.equal(res.status, 200, i.slug);
    assert.match(await res.text(), /Coming next/);
  }
  assert.equal((await app.get('/soon/not-a-page')).status, 404);
});

test('every built menu entry opens', async () => {
  const hrefs = [...new Set(allItems.filter(i => i.href).map(i => i.href))];
  assert.ok(hrefs.length > 50);
  for (const href of hrefs) assert.equal((await app.get(href)).status, 200, href);
});

test('the current page is highlighted and its group starts open', async () => {
  const body = await (await app.get(`/customers/${app.ids.customers?.[0] ?? 1}`)).text();
  assert.match(body, /<details class="group" open><summary>.*?<span>Customer Hub<\/span>/s);
  assert.match(body, /href="\/customers" class="current" aria-current="page">Customers &amp; leads/);
  const week = await (await app.get('/time/week')).text();
  assert.match(week, /href="\/time\/week" class="current"/);
  assert.doesNotMatch(week, /href="\/time" class="current"/, 'only the closest entry');
});

test('Home agrees with the reports', async () => {
  const home = await homeData(pool, { ...scope, today: TODAY });
  const ar = (await run('ar_aging_summary', { period: 'today', run: '1' })).rows.at(-1).values;
  const ap = (await run('ap_aging_summary', { period: 'today', run: '1' })).rows.at(-1).values;
  assert.equal(home.ar.open, ar.at(-1));
  // Overdue = open invoices and late fees past their due date (credits aren't "overdue"), as on the customer pages.
  const overdue = async types => Number((await pool.query(`SELECT coalesce(sum(open_cents), 0) AS s FROM txn WHERE org_id = $1 AND entity_id = $2
    AND type = ANY($3) AND voided_at IS NULL AND due_date < $4`, [scope.orgId, scope.entityId, types, TODAY])).rows[0].s);
  assert.equal(home.ar.overdue, await overdue(['invoice', 'late_fee']));
  assert.equal(home.ap.open, ap.at(-1));
  assert.equal(home.ap.overdue, await overdue(['bill', 'item_receipt']));
  const pl = await run('profit_and_loss', { period: 'this_month', run: '1' });
  const net = pl.rows.find(r => /^net income$/i.test(r.label));
  assert.equal(home.months.at(-1).net, net.values.at(-1));
  for (const b of home.banks) assert.equal(b.balance, ctx.accounts.find(a => a.account_id === b.id).balance_cents, b.name);
  assert.ok(home.banks.length > 0);
  const page = await (await app.get('/home')).text();
  assert.ok(page.includes(`$${(home.ar.open / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`));
  // Admins land on Home; customers-only and vendors-only people on their list.
  assert.equal((await app.get('/')).headers.get('location'), '/home');
  assert.equal(homeFor('customers'), '/customers');
  assert.equal(homeFor('vendors'), '/vendors');
  assert.equal(homeFor('reports'), '/home');
});

test('bookmarks: add from any page, list, reorder, remove; only this site’s pages', async () => {
  let res = await app.post('/bookmarks/add', { href: '/reports/r/profit_and_loss?period=this_year', label: 'P&L this year' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/reports/r/profit_and_loss?period=this_year');
  await app.post('/bookmarks/add', { href: '/vendors', label: 'Vendors' });
  let body = await (await app.get('/customers')).text();
  assert.match(body, /<a href="\/reports\/r\/profit_and_loss\?period=this_year">P&amp;L this year<\/a>.*<a href="\/vendors">Vendors<\/a>/s);
  await app.post('/bookmarks/up', { href: '/vendors' });
  body = await (await app.get('/bookmarks')).text();
  assert.ok(body.indexOf('>Vendors<') < body.indexOf('>P&amp;L this year<'), 'moved up');
  // On a bookmarked page the button says Remove.
  assert.match(await (await app.get('/vendors')).text(), /action="\/bookmarks\/remove"/);
  for (const bad of ['//evil.example/x', 'https://evil.example', '/\\evil', 'javascript:alert(1)', '/logout', '']) {
    res = await app.post('/bookmarks/add', { href: bad, label: 'x' });
    assert.equal(res.headers.get('location'), '/bookmarks', bad);
    assert.equal(cleanHref(bad), null, bad);
  }
  await app.post('/bookmarks/remove', { href: '/vendors', back: '//evil.example' });
  body = await (await app.get('/bookmarks')).text();
  assert.doesNotMatch(body, /<a href="\/vendors">Vendors<\/a>\s*<span class="row-actions"/);
  const left = (await pool.query('SELECT href FROM nav_bookmark')).rows.map(r => r.href);
  assert.deepEqual(left, ['/reports/r/profit_and_loss?period=this_year']);
});

test('pinned apps: choose up to six, unknown ones are ignored', async () => {
  let body = await (await app.get('/customers')).text();
  assert.match(body, /data-rail="pin-accounting"/, 'Accounting, Expenses, Sales pinned by default');
  const p = new URLSearchParams();
  for (const k of ['inventory', 'time', 'nope']) p.append('pin', k);
  await app.post('/navigation', p);
  body = await (await app.get('/customers')).text();
  assert.match(body, /data-rail="pin-inventory".*data-rail="pin-time"/s);
  assert.doesNotMatch(body, /data-rail="pin-accounting"|pin-nope/);
  const many = new URLSearchParams();
  for (const g of GROUPS.slice(0, 7)) many.append('pin', g.key);
  const res = await app.post('/navigation', many);
  assert.equal(res.headers.get('location'), '/navigation');
  assert.deepEqual((await pool.query('SELECT pinned FROM nav_pref')).rows[0].pinned, ['inventory', 'time'], 'unchanged after too many');
});

test('search finds customers, vendors, transactions (by number, memo, amount), reports and pages', async () => {
  const can = () => true;
  const { rows: [c] } = await pool.query('SELECT display_name FROM customer WHERE org_id = $1 ORDER BY customer_id LIMIT 1', [scope.orgId]);
  const { rows: [t] } = await pool.query(`SELECT doc_number, total_cents FROM txn WHERE org_id = $1 AND type = 'invoice' AND doc_number IS NOT NULL ORDER BY txn_id LIMIT 1`, [scope.orgId]);
  const sec = (r, title) => r.sections.find(([s]) => s === title)?.[1] ?? [];
  assert.ok(sec(await globalSearch(pool, { ...scope, q: c.display_name.slice(0, 6), can }), 'Customers').some(x => x.label === c.display_name));
  assert.ok(sec(await globalSearch(pool, { ...scope, q: t.doc_number, can }), 'Transactions').some(x => x.label.endsWith(t.doc_number)));
  const amount = (Number(t.total_cents) / 100).toFixed(2);
  assert.ok(sec(await globalSearch(pool, { ...scope, q: `$${amount}`, can, limit: 50 }), 'Transactions').some(x => x.label.endsWith(t.doc_number)), 'by amount');
  assert.ok(sec(await globalSearch(pool, { ...scope, q: 'balance sheet', can }), 'Reports').some(x => x.href === '/reports/r/balance_sheet'));
  assert.ok(sec(await globalSearch(pool, { ...scope, q: 'payroll', can }), 'Pages').some(x => x.href === '/soon/payroll'));
  assert.deepEqual((await globalSearch(pool, { ...scope, q: '%', can })).sections.filter(([s]) => s === 'Customers'), [], '% is literal');
  // Only what the person can open.
  const custOnly = p => canAccess('customers', 'GET', p);
  const r = await globalSearch(pool, { ...scope, q: 'a', can: custOnly });
  assert.ok(r.sections.every(([, rows]) => rows.every(x => custOnly(x.href.split('?')[0]))));
  assert.ok(!r.sections.some(([s]) => s === 'Vendors' || s === 'Reports'));
  // The page and the typeahead.
  const res = await app.get(`/search?q=${encodeURIComponent(t.doc_number)}`);
  assert.match(await res.text(), new RegExp(t.doc_number));
  const json = await (await app.get(`/search?format=json&q=${encodeURIComponent(t.doc_number)}`)).json();
  assert.equal(json.q, t.doc_number);
});

test('menus only show what a role can open', () => {
  const navFor = role => appNav({ role, can: p => canAccess(role, 'GET', p), path: '/customers', search: '', title: 'Customers', csrf: 'x', entityName: 'Co', bookmarks: [], pins: undefined });
  const text = n => [n.top, n.rail, n.panel, n.bottom].map(String).join('');
  const cust = text(navFor('customers'));
  assert.doesNotMatch(cust, /href="\/vendors"|href="\/settings|href="\/reports"|href="\/home"|Payroll/);
  assert.match(cust, /href="\/customers"/);
  const vend = text(navFor('vendors'));
  assert.doesNotMatch(vend, /href="\/customers"|href="\/settings/);
  assert.match(vend, /href="\/vendors"/);
  const std = text(navFor('standard'));
  assert.doesNotMatch(std, /href="\/settings\/users"|href="\/settings\/accounts"|audit_log/, 'admin-only pages hidden from standard');
  assert.match(std, /href="\/reports"/);
  const admin = text(navFor('admin'));
  assert.match(admin, /href="\/settings\/users"/);
  // Everyone can reach their own navigation pages; customers-only can't open Home.
  for (const role of ['admin', 'standard', 'customers', 'vendors', 'reports']) {
    for (const p of ['/apps', '/create', '/search', '/bookmarks', '/bookmarks/add', '/navigation', '/soon/payroll']) assert.ok(canAccess(role, 'GET', p), `${role} ${p}`);
  }
  assert.ok(!canAccess('customers', 'GET', '/home'));
  assert.ok(canAccess('reports', 'POST', '/bookmarks/add'), 'reports-only people keep bookmarks');
});
