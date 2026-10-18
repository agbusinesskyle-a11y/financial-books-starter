// Who may open what. Checked on every request (services/app/index.js), not just hidden in menus.

export const ROLES = [
  ['admin', 'Admin', 'Everything, including Users, Company, Chart of accounts, Payments and Currencies.'],
  ['standard', 'Standard', 'Everything except Users, Company, Email, Bill approval settings, Chart of accounts, Payments and Currencies.'],
  ['customers', 'Customers only', 'Customers, their transactions, deposits, projects, statements and documents.'],
  ['vendors', 'Vendors only', 'Vendors, bills and spending, Pay bills, checks and documents.'],
  ['reports', 'Reports only', 'Can look at pages and run reports but not change anything.'],
];
export const ROLE_LABELS = Object.fromEntries(ROLES.map(([key, label]) => [key, label]));
export const isRole = role => Object.hasOwn(ROLE_LABELS, role);

// Admin only: who signs in, company identity, the chart of accounts (also via import, and an account's loan setup), money
// settings, where mail goes (the mail server carries invite links) and the bill-approval rule. Tax Books (spec §11): marking a
// return final, reopened or filed, and the shared parties (tax_party) that every company's return names — the route also asks
// for an admin who can open every company (ctx.orgAdmin). Verifying a requested initial period (zero beginnings follow from it).
const ADMIN_ONLY = /^\/(settings\/(users|company|companies|bank-feeds|ai|text-receipts|accounts|payments|currencies|email|bills)|import\/accounts|loans\/(\d+\/)?setup|reports\/r\/audit_log|tax\/(all|parties)|tax\/\d+\/(parties|periods\/\d+\/initial|\d{4}\/(final|reopen|filed)))(\/|$|\.)/;
// Tax Books: the accountant (reports role) may change tax setup, mapping and adjustments — a company flag can still say no.
const TAX_WRITES = /^\/tax\/\d+\/(profile|activities|inclusions|periods|treatments|baselines|interests|\d{4}\/(mapping|manual|adjustments|cash|cogs|revisions))(\/|$)/;
const CUSTOMER_SIDE = /^\/(customers|txns|deposits|projects|documents|statements|recurring|sales-transactions|invoices|estimates|overview\/(sales|customers|projects))(\/|\.|$)/;
const VENDOR_SIDE = /^\/(vendors|vtxns|pay-bills|checks|vrecurring|documents|expense-transactions|bills|bill-payments|item-receipts|overview\/expenses)(\/|\.|$)/;
// Open to everyone who is signed in.
const ANYONE = new Set(['/', '/logout', '/company/logo']);
// Each person's own navigation: the menu pages, search (results are limited to what they can open), bookmarks and pins.
const OWN_NAV = /^\/(apps|create|search|soon\/[a-z0-9-]+|bookmarks(\/(add|remove|up))?|navigation|company\/switch)$/;

// Reports-only people can still keep their own favorites, saved reports and default settings.
const REPORTS_WRITES = /^\/reports\/(favorite|r\/[a-z0-9_]+\/(save|default)|saved\/\d+\/(edit|delete))$/;

export function canAccess(role, method, path) {
  // Everyone keeps their own time (the data layer limits non-admins to their own entries).
  if (ANYONE.has(path) || OWN_NAV.test(path)) return isRole(role);
  if (/^\/time(\/|$)/.test(path)) return isRole(role) && (role !== 'reports' || method === 'GET');
  switch (role) {
    case 'admin': return true;
    // Tax setup is read-only for standard users (spec §11): admins edit it, and the accountant (reports) where the company allows.
    case 'standard': return !ADMIN_ONLY.test(path) && (method === 'GET' || !/^\/tax(\/|$)/.test(path));
    case 'customers': return CUSTOMER_SIDE.test(path);
    case 'vendors': return VENDOR_SIDE.test(path);
    // Reports-only people can still star their favorite reports.
    // (Bank rules are for people who keep the books: not even to look at.)
    case 'reports': return ((method === 'GET' && !/^\/banking\/rules(\/|$)/.test(path)) || REPORTS_WRITES.test(path) || TAX_WRITES.test(path)) && !ADMIN_ONLY.test(path);
    default: return false;
  }
}

// Where "/" takes someone.
export const homeFor = role => (role === 'vendors' ? '/vendors' : role === 'customers' ? '/customers' : '/home');
