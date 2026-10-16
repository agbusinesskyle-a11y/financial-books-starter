import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { getProfile, saveProfile, listPeriods, openPeriod, verifyInitial, taxHome } from '../../lib/tax/periods.js';
import { listParties, saveParty } from '../../lib/tax/parties.js';
import { listActivities, saveActivity, includeBooks, listInclusions } from '../../lib/tax/activities.js';
import { listBaselines } from '../../lib/tax/baselines.js';
import { taxHomePage } from '../../lib/views/tax-home.js';
import { taxProfilePage } from '../../lib/views/tax-profile.js';

// Tax Books T1 (spec §8): /tax and /tax/:entity/profile (+ parties, activities, periods, inclusions). The company in the path
// must be one the person may open; the accountant's edit right is the company flag accountant_may_edit.
export async function taxRoutes(h) {
  const { req, path, form, ctx, pool, env, page, base, go, takeFlash, actor, who } = h;
  if (!/^\/tax(\/|$)/.test(path)) return false;
  // Spec §11: every company a tax screen names, in the path or in a form, must be one the person may open (ctx.companies). The
  // dropdowns offer only those; a forged id is "not found" to this person, as it is everywhere else in the app.
  const companyOf = id => ctx.companies.find(c => c.entityId === Number(id)) ?? (() => { throw new HttpError(404, 'Company not found'); })();
  const orgId = ctx.orgId;

  if (path === '/tax') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    page(taxHomePage({ ...base(), flash: takeFlash(), companies: await taxHome(pool, { orgId, companies: ctx.companies }) }));
    return true;
  }
  // /tax/:entity/periods/:return/initial verifies a requested first year (admin only: roles.js and the check below).
  const mi = /^\/tax\/(\d{1,18})\/periods\/(\d{1,18})\/initial$/.exec(path);
  const m = mi ? [mi[0], mi[1], 'initial', mi[2]] : /^\/tax\/(\d{1,18})\/(profile|parties|activities|periods|inclusions)$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const company = companyOf(m[1]);
  const scope = { orgId, entityId: company.entityId };
  const profile = await getProfile(pool, scope);
  // Spec §11: admins edit tax setup; the accountant (reports role) only where this company allows it; everyone else reads.
  const canEdit = who.role === 'admin' || (who.role === 'reports' && profile.accountant_may_edit === true);
  // The flag itself is the company's grant to the accountant: the accountant neither sees nor saves it (the stored value stays).
  const canSetAccountantFlag = who.role === 'admin';
  // Spec §11: shared parties (tax_party) are org-wide — names and encrypted tax ids every company's return uses — so only an
  // admin who can open every company edits them (roles.js already keeps standard and reports users out of POST .../parties).
  const canEditParties = Boolean(ctx.orgAdmin);
  // Codex t1-r1 B8: a requested initial period becomes a verified first year (zero beginnings) only by an admin, with evidence.
  const canVerifyInitial = who.role === 'admin';
  const show = async (v = null, error = null, status = 200) => {
    const [parties, activities, periods, baselines] = await Promise.all([listParties(pool, { orgId }), listActivities(pool, scope), listPeriods(pool, scope), listBaselines(pool, scope)]);
    const inclusions = Object.fromEntries(await Promise.all(periods.map(async p => [p.return_id, await listInclusions(pool, { ...scope, returnId: p.return_id })])));
    const vals = v ?? { returnType: profile.return_type, activityKind: profile.activity_kind ?? '', taxMethod: profile.tax_method_default, bookBasis: profile.book_basis_default,
      stateCodes: (profile.state_codes ?? []).join(', '), businessCode: profile.business_code ?? '', dateStarted: profile.date_started ?? '', sElectionDate: profile.s_election_date ?? '', reason: '', accountantMayEdit: profile.accountant_may_edit };
    page(taxProfilePage({ ...base(), flash: takeFlash(), company, profile, parties, activities, periods, inclusions, baselines, companies: ctx.companies, canEdit, canEditParties, canSetAccountantFlag, canVerifyInitial, v: vals, error }), status);
  };
  if (m[2] === 'profile' && req.method === 'GET') { await show(); return true; }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!canEdit) throw new HttpError(403, 'This company does not let the accountant change its tax setup.');
  // go() writes the 303 and returns nothing; true tells the dispatcher this request is handled so no later route runs.
  const back = () => { go(`/tax/${company.entityId}/profile`, 'ok', 'Saved.'); return true; };
  try {
    if (m[2] === 'profile') {
      const v = { returnType: form.get('return_type') ?? '', activityKind: form.get('activity_kind') ?? '', taxMethod: form.get('tax_method') ?? '', bookBasis: form.get('book_basis') ?? '',
        stateCodes: form.get('state_codes') ?? '', businessCode: form.get('business_code') ?? '', dateStarted: form.get('date_started') ?? '', sElectionDate: form.get('s_election_date') ?? '',
        reason: form.get('reason') ?? '', accountantMayEdit: canSetAccountantFlag ? form.get('accountant_may_edit') === '1' : profile.accountant_may_edit };
      try {
        await saveProfile(pool, { ...scope, fields: { returnType: v.returnType, activityKind: v.activityKind || null, taxMethodDefault: v.taxMethod, bookBasisDefault: v.bookBasis, yearEndMonth: 12,
          stateCodes: v.stateCodes, businessCode: v.businessCode, dateStarted: v.dateStarted, sElectionDate: v.sElectionDate, accountantMayEdit: v.accountantMayEdit }, reason: v.reason, actor });
        return back();
      } catch (error) { if (!(error instanceof ValidationError)) throw error; await show(v, error.message, 422); return true; }
    }
    if (m[2] === 'parties') {
      if (!canEditParties) throw new HttpError(403, 'Only an admin who can open every company edits the shared parties.');
      // An entity_in_org party may point only at a company this person can open; other kinds carry no company.
      const partyEntityId = form.get('kind') === 'entity_in_org' && form.get('entity_id') ? companyOf(form.get('entity_id')).entityId : null;
      await saveParty(pool, { orgId, fields: { kind: form.get('kind'), name: form.get('name'), taxId: form.get('tax_id'), entityId: partyEntityId }, env });
    }
    if (m[2] === 'activities') await saveActivity(pool, { ...scope, fields: { kind: form.get('kind'), name: form.get('name'), schedule: form.get('schedule'), from: form.get('from'), to: form.get('to'), disposedOn: form.get('disposed_on') } });
    if (m[2] === 'periods') await openPeriod(pool, { ...scope, year: Number(form.get('year')), initial: form.get('initial') === '1', periodStart: form.get('period_start') || null, actor });
    if (m[2] === 'initial') {
      if (!canVerifyInitial) throw new HttpError(403, 'Only an admin verifies a first year.');
      await verifyInitial(pool, { ...scope, returnId: Number(m[3]), verifiedBy: actor, evidence: form.get('evidence') ?? '' });
    }
    if (m[2] === 'inclusions') {
      // The source company must be one this person can open (spec §11); includeBooks then checks it is disregarded for the period.
      await includeBooks(pool, { ...scope, returnId: Number(form.get('return_id')), activityId: Number(form.get('activity_id')), sourceEntityId: companyOf(form.get('source_entity_id')).entityId, approvedBy: actor });
    }
    return back();
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    await show(null, error.message, 422);
    return true;
  }
}
