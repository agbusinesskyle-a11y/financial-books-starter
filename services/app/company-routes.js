import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { listCompanies, createCompany } from '../../lib/data/companies.js';
import { companiesPage } from '../../lib/views/companies.js';

// Companies (stage B1): switch the open company (anyone, among the companies they may open) and Settings → Companies
// (admins: list and add).
export async function companyRoutes(h) {
  const { req, path, form, pool, page, base, go, takeFlash, ctx, session } = h;
  if (path === '/company/switch') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const id = Number(form.get('entity_id'));
    const target = ctx.companies.find(c => c.entityId === id);
    if (!target) throw new HttpError(404, 'Company not found');
    session.entityId = id;
    session.recent = [];
    return go('/home', 'ok', `Now working in ${target.name}.`) ?? true;
  }
  if (path !== '/settings/companies') return false;
  if (!ctx.orgAdmin) throw new HttpError(403, 'Only an admin who can open every company manages companies.');
  const show = async (v = {}, error = null, status = 200) => page(companiesPage({ ...base(), flash: takeFlash(), companies: await listCompanies(pool, { orgId: ctx.orgId }),
    currentId: ctx.entityId, v, error }), status);
  if (req.method === 'GET') { await show(); return true; }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const v = { name: form.get('name') ?? '', timeZone: form.get('timeZone') ?? '', email: form.get('email') ?? '', phone: form.get('phone') ?? '' };
  try {
    const id = await createCompany(pool, { orgId: ctx.orgId, ...v });
    session.entityId = id;
    session.recent = [];
    return go('/home', 'ok', `${v.name.trim()} added — you’re working in it now. Its chart of accounts is in Settings → Chart of accounts.`) ?? true;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    await show(v, error.message, 422);
    return true;
  }
}
