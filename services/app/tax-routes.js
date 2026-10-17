import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { getProfile, saveProfile, listPeriods, openPeriod, verifyInitial, taxHome } from '../../lib/tax/periods.js';
import { listParties, partiesFor, saveParty, resolveOwnTaxIdConflict } from '../../lib/tax/parties.js';
import { listActivities, saveActivity, includeBooks, listInclusions } from '../../lib/tax/activities.js';
import { listBaselines } from '../../lib/tax/baselines.js';
import { taxHomePage } from '../../lib/views/tax-home.js';
import { taxProfilePage } from '../../lib/views/tax-profile.js';
import { taxPartiesPage } from '../../lib/views/tax-parties.js';
import { listInterests, saveInterest, endInterest, rosterFor } from '../../lib/tax/ownership.js';
import { inclusionSources } from '../../lib/tax/bindings.js';
import { reportingChain } from '../../lib/tax/reporting.js';
import { mappingRoutes } from './tax-mapping-routes.js';
import { isDemo, DEMO_BATCH_MAX } from '../../lib/domain/demo.js';

// Tax Books T1 (spec §8): /tax and /tax/:entity/profile (+ parties, activities, periods, inclusions). The company in the path
// must be one the person may open; the accountant's edit right is the company flag accountant_may_edit.
// T2 (the owner's scoping, 2026-10-16): the Tax section is PER COMPANY — /tax opens the company the person is working in; every company's
// return at once is /tax/all and the party directory is /tax/parties, both for org admins only (roles.js ADMIN_ONLY and ctx.orgAdmin);
// a company's owners and members are edited on its own page (/tax/:entity/interests).
export async function taxRoutes(h) {
  const { req, form, ctx, pool, env, page, base, go, takeFlash, actor, who } = h;
  if (!/^\/tax(\/|$)/.test(h.path)) return false;
  // Spec §11: every company a tax screen names, in the path or in a form, must be one the person may open (ctx.companies). The
  // dropdowns offer only those; a forged id is "not found" to this person, as it is everywhere else in the app.
  const companyOf = id => ctx.companies.find(c => c.entityId === Number(id)) ?? (() => { throw new HttpError(404, 'Company not found'); })();
  const orgId = ctx.orgId;

  // /tax is the tax page of the company the person is working in (the menu's Tax entry): the same page as /tax/:entity/profile.
  let path = h.path;
  if (path === '/tax') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const here = ctx.companies.find(c => Number(c.entityId) === Number(ctx.entityId)) ?? ctx.companies[0] ?? (() => { throw new HttpError(404, 'Company not found'); })();
    path = `/tax/${here.entityId}/profile`;
  }
  if (path === '/tax/all' || path === '/tax/parties') {
    if (!ctx.orgAdmin) throw new HttpError(403, 'Only an admin who can open every company sees every return and the party directory.');
    if (path === '/tax/all') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      page(taxHomePage({ ...base(), flash: takeFlash(), companies: await taxHome(pool, { orgId, companies: ctx.companies }) }));
      return true;
    }
    const showParties = async (error = null, status = 200) => page(taxPartiesPage({ ...base(), flash: takeFlash(), parties: await listParties(pool, { orgId }), companies: ctx.companies, error }), status);
    if (req.method === 'GET') { await showParties(); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    try {
      const partyEntityId = form.get('kind') === 'entity_in_org' && form.get('entity_id') ? companyOf(form.get('entity_id')).entityId : null;
      await saveParty(pool, { orgId, fields: { kind: form.get('kind'), name: form.get('name'), taxId: form.get('tax_id'), entityId: partyEntityId }, env });
      go('/tax/parties', 'ok', 'Saved.');
      return true;
    } catch (error) { if (!(error instanceof ValidationError)) throw error; await showParties(error.message, 422); return true; }
  }
  // T2 (spec §8): one period's mapping page, /tax/:entity/:year/mapping, and its POSTs (the AI actions arrive with Task 14).
  const mm = /^\/tax\/(\d{1,18})\/(\d{4})\/mapping(?:\/(bind|clear|line|unline|accept|accept-sure|copy-forward|ai|ai-accept|ai-reject))?$/.exec(path);
  if (mm) return mappingRoutes(h, { company: companyOf(mm[1]), year: Number(mm[2]), action: mm[3] ?? null });
  // /tax/:entity/periods/:return/initial verifies a requested first year (admin only: roles.js and the check below).
  const mi = /^\/tax\/(\d{1,18})\/periods\/(\d{1,18})\/initial$/.exec(path);
  // T2 (Codex t2-plan-r2 B9): /tax/:entity/parties/:party/ein settles an EIN conflict of one of our companies (org admins: roles.js ADMIN_ONLY
  // and the check below).
  const me = /^\/tax\/(\d{1,18})\/parties\/(\d{1,18})\/ein$/.exec(path);
  // /tax/:entity/interests/:id/end ends an owner's interest (kept as history).
  const mx = /^\/tax\/(\d{1,18})\/interests\/(\d{1,18})\/end$/.exec(path);
  const m = mi ? [mi[0], mi[1], 'initial', mi[2]] : me ? [me[0], me[1], 'ein', me[2]] : mx ? [mx[0], mx[1], 'interest-end', mx[2]]
    : /^\/tax\/(\d{1,18})\/(profile|parties|activities|periods|inclusions|interests)$/.exec(path);
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
  const nameable = () => partiesFor(pool, { orgId, companyIds: ctx.companies.map(c => Number(c.entityId)), orgAdmin: Boolean(ctx.orgAdmin) });
  const show = async (v = null, error = null, status = 200) => {
    const [parties, activities, periods, baselines, interests] = await Promise.all([listParties(pool, { orgId }), listActivities(pool, scope), listPeriods(pool, scope), listBaselines(pool, scope),
      listInterests(pool, scope)]);
    const inclusions = Object.fromEntries(await Promise.all(periods.map(async p => [p.return_id, await listInclusions(pool, { ...scope, returnId: p.return_id })])));
    const mayOpen = id => ctx.companies.some(c => Number(c.entityId) === Number(id));
    // Only this company's own tax party is shown here; the directory is /tax/parties (org admins).
    const ownParty = parties.find(p => p.kind === 'entity_in_org' && Number(p.entity_id) === company.entityId) ?? null;
    // The period the page is about: the company's latest period (periods are newest first).
    const shown = periods[0] ?? null;
    // Where a disregarded company is reported, for that period (Codex r5 R5-N5, r6 R6-N3): its inclusion chain up to the filing return,
    // reported only where coverage would combine it (lib/tax/reporting.js uses coverage's own rule). A hop is a link only when every
    // company from this one up to it may be opened — the included-books list's every-company-on-path rule, upward. A chain that breaks, or
    // that the filing return cannot combine yet, reports nothing — said so, with the latest earlier year reported shown as history.
    let reporting = null;
    if (shown && shown.return_type === 'disregarded') {
      const reach = hs => hs.map((h2, k) => ({ ...h2, allowed: hs.slice(0, k + 1).every(x => mayOpen(x.entityId)) }));
      const chain = await reportingChain(pool, { orgId, entityId: company.entityId, periodStart: shown.period_start, periodEnd: shown.period_end });
      const hops = reach(chain.hops);
      let earlier = null;
      if (!chain.filing && !chain.partial) {
        const { rows: [old] } = await pool.query(`SELECT r.period_start::text AS s, r.period_end::text AS e FROM tax_return r WHERE r.org_id = $1 AND r.entity_id = $2 AND r.period_end < $3::date
          AND EXISTS (SELECT 1 FROM activity_inclusion i WHERE i.org_id = r.org_id AND i.source_entity_id = r.entity_id AND i.period_start <= r.period_end AND i.period_end >= r.period_start)
          ORDER BY r.period_end DESC LIMIT 1`, [orgId, company.entityId, shown.period_start]);
        if (old) {
          const past = await reportingChain(pool, { orgId, entityId: company.entityId, periodStart: old.s, periodEnd: old.e });
          if (past.filing) earlier = reach(past.hops).at(-1);
        }
      }
      reporting = { period: shown, hops, filing: chain.filing ? hops.at(-1) : null, blocked: chain.blocked, partial: chain.partial ? { ...chain.partial, on: hops.at(-1) } : null, earlier };
    }
    // The books the latest return includes, any depth — a disregarded company's own period too (it may include its own disregarded
    // companies); a company is a link only when every company on its path may be opened.
    const included = shown ? (await inclusionSources(pool, { orgId, returnId: shown.return_id })).map(s => ({ entityId: s.entityId, name: s.name, depth: s.path.length, allowed: s.entities.every(mayOpen) })) : [];
    const rosters = Object.fromEntries(await Promise.all(periods.filter(p => p.status === 'open').map(async p => [p.return_id, await rosterFor(pool, { ...scope, periodStart: p.period_start, periodEnd: p.period_end, returnType: p.return_type })])));
    // Owners are picked only from the parties this person may name (Codex r5 R5-N4); the company is not its own owner.
    const partyOptions = (await nameable()).filter(p => !(p.kind === 'entity_in_org' && Number(p.entity_id) === company.entityId)).map(p => [p.party_id, p.name]);
    const vals = v ?? { returnType: profile.return_type, activityKind: profile.activity_kind ?? '', taxMethod: profile.tax_method_default, bookBasis: profile.book_basis_default,
      stateCodes: (profile.state_codes ?? []).join(', '), businessCode: profile.business_code ?? '', dateStarted: profile.date_started ?? '', sElectionDate: profile.s_election_date ?? '', reason: '', accountantMayEdit: profile.accountant_may_edit };
    page(taxProfilePage({ ...base(), flash: takeFlash(), company, profile, ownParty, reporting, included, interests, rosters, partyOptions, activities, periods, inclusions, baselines,
      companies: ctx.companies, canEdit, canEditParties, canSetAccountantFlag, canVerifyInitial, v: vals, error }), status);
  };
  if (m[2] === 'profile' && req.method === 'GET') { await show(); return true; }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!canEdit) throw new HttpError(403, 'This company does not let the accountant change its tax setup.');
  // go() writes the 303 and returns nothing; true tells the dispatcher this request is handled so no later route runs.
  const back = () => { go(`/tax/${company.entityId}/profile`, 'ok', 'Saved.'); return true; };
  // The public demo copies at most a batch's worth of company defaults per request (opening a period, including books); null elsewhere.
  const maxSets = isDemo(env) ? DEMO_BATCH_MAX : null;
  const leftNote = r => (r.left ? ` This demo copies at most ${DEMO_BATCH_MAX} company defaults at a time: ${r.left} more ${r.left === 1 ? 'is' : 'are'} left unmapped — copy them from the period’s mapping page (Copy the company defaults), as often as needed.` : '');
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
      // The directory lives on /tax/parties now; this older path saves there too.
      go('/tax/parties', 'ok', 'Saved.');
      return true;
    }
    if (m[2] === 'interests') {
      if (!(await nameable()).some(p => Number(p.party_id) === Number(form.get('party_id')))) throw new HttpError(404, 'Party not found');
      await saveInterest(pool, { ...scope, fields: { partyId: form.get('party_id'), role: form.get('role'), from: form.get('from'), to: form.get('to') || null, profit: form.get('profit'),
        loss: form.get('loss'), capital: form.get('capital') }, actor });
    }
    if (m[2] === 'interest-end') await endInterest(pool, { ...scope, interestId: m[3], to: form.get('to') });
    if (m[2] === 'ein') {
      if (!canEditParties) throw new HttpError(403, 'Only an admin who can open every company settles an EIN conflict.');
      await resolveOwnTaxIdConflict(pool, { ...scope, partyId: Number(m[3]), evidenceId: form.get('evidence_id'), keep: form.get('keep'), actor });
    }
    if (m[2] === 'activities') await saveActivity(pool, { ...scope, fields: { kind: form.get('kind'), name: form.get('name'), schedule: form.get('schedule'), from: form.get('from'), to: form.get('to'), disposedOn: form.get('disposed_on') } });
    if (m[2] === 'periods') {
      const report = {};
      await openPeriod(pool, { ...scope, year: Number(form.get('year')), initial: form.get('initial') === '1', periodStart: form.get('period_start') || null, actor, maxSets, report });
      if (report.left) { go(`/tax/${company.entityId}/profile`, 'ok', `Saved.${leftNote(report)}`); return true; }
    }
    if (m[2] === 'initial') {
      if (!canVerifyInitial) throw new HttpError(403, 'Only an admin verifies a first year.');
      await verifyInitial(pool, { ...scope, returnId: Number(m[3]), verifiedBy: actor, evidence: form.get('evidence') ?? '' });
    }
    if (m[2] === 'inclusions') {
      // The source company must be one this person can open (spec §11); includeBooks then checks it is disregarded for the period.
      // Copy-forward into returns above runs only where this person may open and edit (Codex r3 R3-N2); others are reported, not written.
      const mayOpen = id => ctx.companies.some(c => Number(c.entityId) === Number(id));
      const mayEdit = async id => mayOpen(id) && (who.role === 'admin' || (who.role === 'reports' && (await getProfile(pool, { orgId, entityId: id })).accountant_may_edit === true));
      const report = {};
      await includeBooks(pool, { ...scope, returnId: Number(form.get('return_id')), activityId: Number(form.get('activity_id')), sourceEntityId: companyOf(form.get('source_entity_id')).entityId, approvedBy: actor,
        canOpen: mayOpen, canEdit: mayEdit, report, maxSets });
      const n = report.pendingReturns?.length ?? 0;
      if (n) { go(`/tax/${company.entityId}/profile`, 'ok', `Saved. ${n} return${n === 1 ? '' : 's'} above this company ${n === 1 ? 'was' : 'were'} not updated because you may not edit ${n === 1 ? 'it' : 'them'}: someone who may copies the company defaults there from its mapping page.${leftNote(report)}`); return true; }
      if (report.left) { go(`/tax/${company.entityId}/profile`, 'ok', `Saved.${leftNote(report)}`); return true; }
    }
    return back();
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    await show(null, error.message, 422);
    return true;
  }
}
