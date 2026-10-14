import { HttpError } from './http.js';
import { LISTS, listFilters, listCompanyTxns, partyChoices } from '../../lib/data/lists.js';
import { salesOverview, expensesOverview, customersOverview, projectsOverview, inventoryOverview, listAllProjects } from '../../lib/data/overviews.js';
import { listPage, projectsListPage, overviewPage } from '../../lib/views/lists.js';

// Company-wide lists and Overview pages (stage N3): /sales-transactions, /invoices, /estimates, /expense-transactions,
// /bills, /bill-payments, /item-receipts, /projects and /overview/{sales,expenses,customers,projects,inventory}.
const OVERVIEWS = { sales: salesOverview, expenses: expensesOverview, customers: customersOverview, projects: projectsOverview, inventory: inventoryOverview };

export async function listRoutes(h) {
  const { req, path, query, scope, pool, page, base, ctx } = h;
  const slug = path.slice(1);
  const ov = /^\/overview\/([a-z]+)$/.exec(path);
  if (!Object.hasOwn(LISTS, slug) && path !== '/projects' && !(ov && Object.hasOwn(OVERVIEWS, ov[1]))) return false;
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');

  if (ov) {
    page(overviewPage({ ...base(), kind: ov[1], data: await OVERVIEWS[ov[1]](pool, { ...scope, today: ctx.today }) }));
    return true;
  }
  if (path === '/projects') {
    const status = ['in_progress', 'completed', 'canceled'].includes(query.status) ? query.status : 'all';
    page(projectsListPage({ ...base(), projects: await listAllProjects(pool, { ...scope, status }), status }));
    return true;
  }
  const filters = listFilters(slug, query, ctx.today);
  const [result, parties] = await Promise.all([
    listCompanyTxns(pool, { ...scope, slug, filters, today: ctx.today }),
    partyChoices(pool, { ...scope, side: LISTS[slug].side }),
  ]);
  page(listPage({ ...base(), slug, filters, result, parties, today: ctx.today }));
  return true;
}
