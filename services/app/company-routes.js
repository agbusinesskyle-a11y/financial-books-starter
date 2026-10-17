import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { listCompanies } from '../../lib/data/companies.js';
import { companiesPage } from '../../lib/views/companies.js';
import { checkProfileFields, suggestReturnType, RETURN_TYPE_LABELS } from '../../lib/tax/periods.js';
import { createCompanyWithTax } from '../../lib/tax/company-record.js';
import { profileFromForm, profileFields, NEW_TAX_VALUES } from '../../lib/views/tax-profile-fields.js';

// Companies (stage B1): switch the open company (anyone, among the companies they may open) and Settings → Companies
// (admins: list and add).
export async function companyRoutes(h) {
  const { req, path, form, pool, page, base, go, takeFlash, ctx, session, actor } = h;
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
  const show = async (v = {}, error = null, status = 200, t = NEW_TAX_VALUES) => page(companiesPage({ ...base(), flash: takeFlash(), companies: await listCompanies(pool, { orgId: ctx.orgId }),
    currentId: ctx.entityId, v, t, error }), status);
  if (req.method === 'GET') { await show(); return true; }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const v = { name: form.get('name') ?? '', timeZone: form.get('timeZone') ?? '', email: form.get('email') ?? '', phone: form.get('phone') ?? '', businessType: form.get('businessType') ?? '' };
  const t = form.has('return_type') ? profileFromForm(form) : NEW_TAX_VALUES;
  const wantsTax = !['', 'none'].includes(t.returnType);
  try {
    // The tax setup is optional and checked before the company exists, so a refusal creates nothing.
    if (wantsTax) checkProfileFields(profileFields(t, true));
    // The company and its tax setup are one transaction (Codex B9): a failed tax setup creates no company.
    const id = await createCompanyWithTax(pool, { orgId: ctx.orgId, company: { name: v.name, timeZone: v.timeZone, email: v.email, phone: v.phone, businessType: v.businessType || null },
      tax: wantsTax ? profileFields(t, true) : null, actor });
    // A suggestion is said, never saved: the company has no tax setup until a person chooses one.
    const hint = wantsTax ? null : suggestReturnType(v.businessType);
    session.entityId = id;
    session.recent = [];
    return go('/home', 'ok', `${v.name.trim()} added — you’re working in it now. Its chart of accounts is in Settings → Chart of accounts.${hint?.returnType ? ` Suggested tax return: ${RETURN_TYPE_LABELS[hint.returnType]} — set it in Settings → Company → Tax.` : ''}`) ?? true;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    await show(v, error.message, 422, t);
    return true;
  }
}
