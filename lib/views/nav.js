import { html, raw } from './html.js';

// The app's navigation (stage N1): the icon rail, the All apps panel, Create, Bookmarks, the gear menu and the phone
// bottom bar. Built once per page by page() in services/app/index.js for the person signed in, so menus only list what
// their role can open. Pages that aren't built yet go to /soon/<slug> and are marked "Soon".

// A destination: label, our page (or null = Soon), and an optional note shown on the Soon page.
const d = (label, href = null, slug = null) => ({ label, href, slug });

export const GROUPS = [
  { key: 'morning', label: 'Morning View', icon: 'home', items: [d('Morning View', '/morning')] },
  { key: 'accounting', label: 'Accounting', icon: 'ledger', items: [
    d('Bank transactions', '/banking'), d('Receipts', '/receipts'),
    d('Reconcile', '/reconcile'), d('Rules', '/banking/rules'), d('Tax', '/tax'), d('Chart of accounts', '/settings/accounts'),
    d('Recurring transactions', '/all-recurring'), d('Journal entry', '/journal/new'), d('Transfer', '/transfers/new'),
    d('Fixed assets', null, 'fixed-assets'),
    d('My accountant', '/settings/users/new?for=accountant'),
  ] },
  { key: 'expenses', label: 'Expenses & Bills', icon: 'expenses', items: [
    d('Overview', '/overview/expenses'), d('Expense transactions', '/expense-transactions'), d('Vendors', '/vendors'),
    d('Bills', '/bills'), d('Bill payments', '/bill-payments'), d('Pay bills', '/pay-bills'), d('Checks', '/checks'),
    d('Contractors', '/vendors?show=contractors'), d('1099s', '/vendors/1099'),
  ] },
  { key: 'sales', label: 'Sales & Get Paid', icon: 'sales', items: [
    d('Overview', '/overview/sales'), d('Sales transactions', '/sales-transactions'), d('Invoices', '/invoices'),
    d('Recurring payments', '/all-recurring'),
    d('Sales channels', null, 'sales-channels'), d('Deposits', '/deposits'), d('Products & services', '/settings/items'),
  ] },
  { key: 'customers', label: 'Customer Hub', icon: 'customers', items: [
    d('Overview', '/overview/customers'), d('Customers & leads', '/customers'), d('Estimates', '/estimates'),
  ] },
  { key: 'time', label: 'Time', icon: 'time', items: [
    d('Time entries', '/time'), d('Weekly timesheet', '/time/week'),
  ] },
  { key: 'projects', label: 'Projects', icon: 'projects', items: [
    d('Overview', '/overview/projects'), d('Projects', '/projects'),
  ] },
  { key: 'inventory', label: 'Inventory', icon: 'inventory', items: [
    d('Overview', '/overview/inventory'), d('Inventory', '/settings/items'), d('Purchase orders', '/vendors?show=po'),
    d('Item receipts', '/item-receipts'),
  ] },
  { key: 'sales-tax', label: 'Sales Tax', icon: 'tax', items: [d('Overview', null, 'sales-tax')] },
  { key: 'lending', label: 'Lending', icon: 'lending', items: [d('Loans', '/loans')] },
];

export const REPORTS_MENU = [d('Reports', '/reports'), d('Dashboards', '/reports/dashboards'), d('Management reports', '/reports/management'),
  d('Custom reports', '/reports/custom'), d('Cash flow planner', '/reports/cash-flow')];

export const CREATE = [
  ['Customers', [d('Invoice', '/txns/new?type=invoice'), d('Receive payment', '/txns/new?type=payment'), d('Estimate', '/txns/new?type=estimate'),
    d('Sales receipt', '/txns/new?type=sales_receipt'), d('Credit memo', '/txns/new?type=credit_memo'), d('Statement', '/customers'),
    d('Refund receipt', null, 'refund-receipt'), d('Add customer', '/customers/new')]],
  ['Vendors', [d('Expense', '/vtxns/new?type=expense'), d('Check', '/vtxns/new?type=check'), d('Bill', '/vtxns/new?type=bill'),
    d('Pay bills', '/pay-bills'), d('Purchase order', '/vtxns/new?type=purchase_order'), d('Vendor credit', '/vtxns/new?type=vendor_credit'),
    d('Item receipt', '/vtxns/new?type=item_receipt'), d('Credit card credit', '/vtxns/new?type=cc_credit'), d('Print checks', '/checks'),
    d('Add vendor', '/vendors/new')]],
  ['Team', [d('Single time activity', '/time'), d('Weekly timesheet', '/time/week')]],
  ['Other', [d('Bank deposit', '/deposits/new'), d('Transfer', '/transfers/new'), d('Journal entry', '/journal/new'),
    d('Pay down credit card', '/card-payments/new'), d('Budget', '/budgets/new'), d('Product or service', '/settings/items/new'),
    d('Inventory quantity adjustment', '/settings/items')]],
];

export const GEAR = [
  ['Morning View', [d('Morning View settings', '/settings/morning')]],
  ['Your company', [d('Account and settings', '/settings'), d('Manage users', '/settings/users'), d('Company', '/settings/company'), d('Companies', '/settings/companies'),
    d('Custom form styles', '/settings/form-styles'), d('Email', '/settings/email'), d('Payments', '/settings/payments')]],
  ['Lists', [d('All lists', '/settings'), d('Products and services', '/settings/items'), d('Terms', '/settings/terms'),
    d('Classes', '/settings/classes'), d('Locations', '/settings/locations'), d('Tags', '/settings/tags'), d('Price rules', '/settings/price-rules'),
    d('Attachments', '/attachments')]],
  ['Tools', [d('Import data', '/import'), d('Export data', '/export'), d('Budgeting', '/budgets'), d('Reconcile', '/reconcile'),
    d('Audit log', '/reports/r/audit_log'), d('Recurring transactions', '/all-recurring'), d('All tools', '/tools'),
    d('Spreadsheet sync', null, 'spreadsheet-sync')]],
  ['Profile', [d('Bookmarks', '/bookmarks'), d('Customize navigation', '/navigation')]],
];

export const DEFAULT_PINS = ['accounting', 'expenses', 'sales'];
export const PIN_CHOICES = GROUPS.map(g => [g.key, g.label]);

// What each Soon page will do, and what exists today that comes closest.
export const SOON = {
  'bank-transactions': ['Review downloaded bank and card transactions and match or add each one.', [['Reconcile', '/reconcile'], ['Deposits', '/deposits']]],
  receipts: ['Upload receipts and turn them into expenses.', [['Expense', '/vtxns/new?type=expense'], ['Attachments', '/attachments']]],
  'fixed-assets': ['Track equipment and buildings and record depreciation.', [['Chart of accounts', '/settings/accounts'], ['Journal entry', '/journal/new']]],
  'sales-channels': ['Bring in sales from online stores.', [['Import data', '/import']]],
  'sales-tax': ['Sales tax rates, what you owe and filing.', []],
  'refund-receipt': ['Give a customer money back.', [['Credit memo', '/txns/new?type=credit_memo']]],
  'multiple-invoices': ['Invoice several customers at once for the same items.', [['Invoice', '/txns/new?type=invoice']]],
  'spreadsheet-sync': ['Work on the books in Google Sheets or Excel (on hold).', [['Export data', '/export']]],
};
export const SOON_TITLE = {
  ...Object.fromEntries([...GROUPS.flatMap(g => g.items), ...CREATE.flatMap(([, i]) => i), ...GEAR.flatMap(([, i]) => i)].filter(i => i.slug).map(i => [i.slug, i.label])),
  'multiple-invoices': 'Multiple invoices',
};

const hrefOf = item => item.href ?? `/soon/${item.slug}`;

// Small line icons (our own drawings).
const ICONS = {
  create: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  bookmarks: '<path d="M7 4h10v16l-5-4-5 4z"/>',
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
  reports: '<path d="M5 19V5M5 19h14M9 15v-4M13 15V8M17 15v-6"/>',
  apps: '<circle cx="6" cy="6" r="1.5"/><circle cx="12" cy="6" r="1.5"/><circle cx="18" cy="6" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/><circle cx="6" cy="18" r="1.5"/><circle cx="12" cy="18" r="1.5"/><circle cx="18" cy="18" r="1.5"/>',
  customize: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  ledger: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  expenses: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 14l3 3 3-3"/>',
  sales: '<circle cx="12" cy="12" r="9"/><path d="M12 17V7M9 10l3-3 3 3"/>',
  customers: '<circle cx="12" cy="9" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/>',
  team: '<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 19c1-3 3-5 6-5s5 2 6 5M15 15c3 0 5 1.5 6 4"/>',
  time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  projects: '<rect x="4" y="6" width="16" height="13" rx="2"/><path d="M9 6V4h6v2"/>',
  inventory: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  tax: '<path d="M7 4h10v16H7z"/><path d="M10 9l4 6M10 15h.01M14 9h.01"/>',
  lending: '<path d="M4 10l8-5 8 5M6 10v8M10 10v8M14 10v8M18 10v8M4 20h16"/>',
  payroll: '<rect x="3" y="7" width="18" height="11" rx="2"/><circle cx="12" cy="12.5" r="2.5"/>',
  marketing: '<path d="M4 10v4h3l6 4V6L7 10z"/><path d="M17 9c1 1 1 5 0 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  note: '<path d="M5 4h10l4 4v12H5z"/><path d="M9 12h6M9 16h4"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  star: '<path d="M12 4l2.5 5 5.5.8-4 3.9.9 5.5L12 16.6 7.1 19.2 8 13.7 4 9.8 9.5 9z"/>',
};
export const icon = name => raw(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`);

// state: { role, can(path) → bool, path, search, title, csrf, bookmarks: [{href,label}], pins: [groupKey], panelOpen }
export function appNav(state) {
  const here = state.path + (state.search ?? '');
  // Everyone who works across the books sees the full menu, Soon pages included; customers-only and vendors-only
  // people see just the pages they can open.
  const full = !['customers', 'vendors'].includes(state.role);
  const visibleItems = items => items.filter(i => (i.href ? state.can(i.href.split('?')[0]) : full));
  // The menu entry for this page: an exact match, else the longest entry this page sits under (/customers/12 → Customers).
  const under = h => h === here || h === state.path || (!h.includes('?') && state.path.startsWith(`${h}/`));
  const currentHref = GROUPS.flatMap(g => g.items).map(i => i.href).filter(h => h && under(h)).sort((a, b) => b.length - a.length)[0] ?? null;
  const isCurrent = i => i.href !== null && i.href === currentHref;
  const link = i => html`<a href="${hrefOf(i)}" class="${[isCurrent(i) ? 'current' : '', i.href ? '' : 'soon'].filter(Boolean).join(' ')}"${isCurrent(i) ? raw(' aria-current="page"') : ''}>${i.label}${i.href ? '' : html`<span class="soon-tag">Soon</span>`}</a>`;
  const groups = GROUPS.map(g => ({ ...g, items: visibleItems(g.items) })).filter(g => g.items.length);
  const groupHere = groups.find(g => g.items.some(isCurrent))?.key;
  const pins = (state.pins ?? DEFAULT_PINS).map(k => groups.find(g => g.key === k)).filter(Boolean);
  const reports = visibleItems(REPORTS_MENU);
  const create = CREATE.map(([h, items]) => [h, visibleItems(items)]).filter(([, items]) => items.length);
  const gear = GEAR.map(([h, items]) => [h, visibleItems(items)]).filter(([, items]) => items.length);
  const canHome = state.can('/home');
  const bookmarks = (state.bookmarks ?? []).filter(b => state.can(b.href.split(/[?#]/)[0]));
  const bookmarked = bookmarks.some(b => b.href === here);
  const bookmarkForm = html`<form method="post" action="/bookmarks/${bookmarked ? 'remove' : 'add'}" class="bookmark-this">
      <input type="hidden" name="csrf" value="${state.csrf}"><input type="hidden" name="href" value="${here}"><input type="hidden" name="label" value="${state.title}">
      <button class="link">${icon('star')} ${bookmarked ? 'Remove bookmark' : 'Bookmark this page'}</button></form>`;
  const bookmarkList = html`${bookmarks.length ? html`<ul class="flat">${bookmarks.map(b => html`<li><a href="${b.href}">${b.label}</a></li>`)}</ul>`
    : html`<p class="muted small">No bookmarks yet.</p>`}
    ${state.canBookmark === false ? '' : bookmarkForm}<p class="small"><a href="/bookmarks">Manage bookmarks</a></p>`;
  const flyout = (key, label, ic, body, extra = '') => html`<details class="rail-item fly" name="rail" data-rail="${key}"${raw(extra)}>
      <summary title="${label}">${icon(ic)}<span>${label}</span></summary><div class="flyout"><h2>${label}</h2>${body}</div></details>`;
  const railLink = (href, label, ic, current) => html`<a class="rail-item${current ? ' current' : ''}" href="${href}" title="${label}">${icon(ic)}<span>${label}</span></a>`;

  const rail = html`<nav class="rail" aria-label="Main">
    ${flyout('create', 'Create', 'create', html`<div class="create-cols">${create.map(([h, items]) => html`<section><h3>${h}</h3>${items.map(link)}</section>`)}</div>`)}
    ${flyout('bookmarks', 'Bookmarks', 'bookmarks', bookmarkList)}
    ${canHome ? railLink('/home', 'Home', 'home', state.path === '/home') : ''}
    ${state.can('/morning') ? railLink('/morning', 'Morning View', 'home', state.path.startsWith('/morning')) : ''}
    ${reports.length ? railLink('/reports', 'Reports', 'reports', state.path.startsWith('/reports')) : ''}
    <a class="rail-item apps-toggle" href="/apps" title="All apps" data-panel-toggle>${icon('apps')}<span>All apps</span></a>
    ${pins.length ? html`<p class="rail-label">Pinned</p>` : ''}
    ${pins.map(g => flyout(`pin-${g.key}`, g.label.replace(/ &.*/, ''), g.icon, html`<div class="flat-links">${g.items.map(link)}</div>`))}
    <a class="rail-item rail-bottom" href="/navigation" title="Customize">${icon('customize')}<span>Customize</span></a>
  </nav>`;

  const panel = html`<aside class="apps-panel${state.panelOpen === false ? ' closed' : ''}" id="apps-panel" aria-label="All apps">
    <div class="panel-head"><h2>All apps</h2><button type="button" class="icon-btn" data-panel-toggle aria-label="Collapse menu" aria-controls="apps-panel">«</button></div>
    ${groups.map(g => html`<details class="group"${g.key === groupHere ? raw(' open') : ''}><summary>${icon(g.icon)}<span>${g.label}</span></summary>
      <div class="group-items">${g.items.map(link)}</div></details>`)}
  </aside>`;

  const top = html`<header class="topbar app-top">
    <a class="icon-btn phone-only" href="/apps" aria-label="Menu">${icon('menu')}</a>
    <a class="brand" href="${canHome ? '/home' : state.can('/customers') ? '/customers' : '/vendors'}">Financial Books</a>
    ${(state.companies ?? []).length > 1 ? html`<details class="company-switch"><summary class="company" aria-label="Switch company">${state.entityName} ▾</summary>
      <div class="flyout company-menu"><h3>Switch company</h3>${state.companies.map(c => c.entityId === Number(state.entityId)
        ? html`<p class="current-company">${c.name} <span class="muted small">(open)</span></p>`
        : html`<form method="post" action="/company/switch"><input type="hidden" name="csrf" value="${state.csrf}"><input type="hidden" name="entity_id" value="${c.entityId}"><button class="link">${c.name}</button></form>`)}
        ${state.can('/settings/companies') ? html`<a href="/settings/companies">Manage companies</a>` : ''}</div></details>`
      : html`<span class="company">${state.entityName}</span>`}
    <form class="global-search" method="get" action="/search" role="search">
      <label class="visually-hidden" for="global-q">Search</label>
      <input id="global-q" type="search" name="q" placeholder="Search customers, vendors, transactions, reports…" autocomplete="off" data-global-search
        role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="global-pop">
      <div class="search-pop hidden" id="global-pop" role="listbox" data-search-pop></div>
    </form>
    <a class="icon-btn phone-only" href="/search" aria-label="Search">${icon('search')}</a>
    <details class="gear" name="rail"><summary aria-label="Settings menu" title="Settings">${icon('gear')}</summary>
      <div class="flyout gear-menu">${gear.map(([h, items]) => html`<section><h3>${h}</h3>${items.map(link)}</section>`)}
        <form method="post" action="/logout"><input type="hidden" name="csrf" value="${state.csrf}"><button class="link">Sign out</button></form></div></details>
  </header>`;

  const bottom = html`<nav class="bottombar" aria-label="Quick">
    ${canHome ? html`<a href="/home"${state.path === '/home' ? raw(' class="current"') : ''}>${icon('home')}<span>Home</span></a>` : ''}
    <a href="/create"${state.path === '/create' ? raw(' class="current"') : ''}>${icon('create')}<span>Create</span></a>
    ${reports.length ? html`<a href="/reports"${state.path.startsWith('/reports') ? raw(' class="current"') : ''}>${icon('reports')}<span>Reports</span></a>` : ''}
    <a href="/bookmarks"${state.path === '/bookmarks' ? raw(' class="current"') : ''}>${icon('bookmarks')}<span>Bookmarks</span></a>
    <a href="/apps"${state.path === '/apps' ? raw(' class="current"') : ''}>${icon('menu')}<span>Menu</span></a>
  </nav>`;

  return { top, rail, panel, bottom, groups, reports, create, bookmarkForm, bookmarkList };
}
