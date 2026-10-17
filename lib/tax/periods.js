import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { isIsoDate } from '../domain/dates.js';
import { EDITIONS, RETURN_TYPES } from './catalog/index.js';
import { copyForwardIn, lockTaxGraph } from './bindings.js';

// Tax Books periods (spec §4.2–4.3): a profile is the company's defaults for the NEXT period; a return period carries its own
// resolved facts. v1 supports calendar years; an initial period (first year) may start later in the year.
const fail = message => { throw new ValidationError(message); };
export const RETURN_TYPE_LABELS = { none: 'No return (not set up)', form_1065: 'Partnership (Form 1065)', form_1120s: 'S corporation (Form 1120-S)', disregarded: 'Disregarded (reported on its owner’s return)', household_1040: 'Household (Form 1040)' };
export const ACTIVITY_KINDS = [['trade', 'Trade or business'], ['rental', 'Rental real estate'], ['farm', 'Farm'], ['portfolio', 'Holding / portfolio']];
// fiscal_start_month 1 (January) → year end 12; 7 → 6; 2 → 1.
export const yearEndFromFiscalStart = m => ((Number(m) + 10) % 12) + 1;
const DEFAULTS = { return_type: 'none', activity_kind: null, tax_method_default: 'cash', book_basis_default: 'accrual', year_end_month: 12, state_codes: [], business_code: null, date_started: null, s_election_date: null, accountant_may_edit: true };

export async function getProfile(db, { orgId, entityId }) {
  const { rows } = await db.query('SELECT * FROM tax_profile WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  return rows[0] ?? { org_id: orgId, entity_id: entityId, ...DEFAULTS, exists: false };
}
// fields: returnType, activityKind, taxMethodDefault, bookBasisDefault, yearEndMonth, stateCodes ("NM, AZ" or array), businessCode, dateStarted,
// sElectionDate, accountantMayEdit. The field checks need no database, so the add-company form runs them before the company exists.
export function checkProfileFields(f) {
  if (!Object.hasOwn(RETURN_TYPE_LABELS, f.returnType)) fail('Choose the return this company files.');
  if (!['cash', 'accrual'].includes(f.taxMethodDefault)) fail('Choose cash or accrual for the tax method.');
  if (!['cash', 'accrual'].includes(f.bookBasisDefault)) fail('Choose the basis the books are kept on.');
  if (Number(f.yearEndMonth) !== 12) fail('Tax Books supports calendar years for now (year end December).');
  const activityKind = f.returnType === 'disregarded' ? (ACTIVITY_KINDS.some(([k]) => k === f.activityKind) ? f.activityKind : fail('Choose what kind of activity this disregarded company is.')) : null;
  const states = (Array.isArray(f.stateCodes) ? f.stateCodes : String(f.stateCodes ?? '').split(/[\s,]+/)).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (states.some(s => !/^[A-Z]{2}$/.test(s))) fail('States are two-letter codes, like AZ.');
  const code = String(f.businessCode ?? '').trim();
  if (code && !/^\d{6}$/.test(code)) fail('The business code is the 6-digit NAICS code on the return.');
  for (const [k, v] of [['dateStarted', f.dateStarted], ['sElectionDate', f.sElectionDate]]) if (v && !isIsoDate(v)) fail(`${k === 'dateStarted' ? 'Date started' : 'S election date'}: enter a date.`);
  return { activityKind, states, code };
}
// One save, wherever it is made (the Tax setup page, Settings → Company, the add-company form): a change of returnType or either method
// default needs a reason (audited through change_reason). saveProfileIn runs inside the caller's transaction (Settings → Company saves the
// company details and the tax setup together); saveProfile opens its own.
export const saveProfile = (pool, args) => withTransaction(pool, tx => saveProfileIn(tx, args));
export async function saveProfileIn(tx, { orgId, entityId, fields: f, reason = '' }) {
  const { activityKind, states, code } = checkProfileFields(f);
  await lockEntity(tx, orgId, entityId);
  const { rows: [was] } = await tx.query('SELECT return_type, tax_method_default, book_basis_default FROM tax_profile WHERE org_id = $1 AND entity_id = $2 FOR UPDATE', [orgId, entityId]);
  const changed = was && (was.return_type !== f.returnType || was.tax_method_default !== f.taxMethodDefault || was.book_basis_default !== f.bookBasisDefault);
  if (changed && !String(reason).trim()) fail('Changing the return type or method is a reviewed change: give the reason.');
  // The start date is the evidence an initial period rests on (Codex t1-r2 B8): it cannot move away from, or be cleared under, one.
  const { rows: [init] } = await tx.query(`SELECT period_start::text AS s, initial_status FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND initial_status IS NOT NULL`, [orgId, entityId]);
  if (init && f.dateStarted && f.dateStarted !== init.s) fail(`This company's initial period starts ${init.s}; its start date must be that day.`);
  if (init?.initial_status === 'verified' && !f.dateStarted) fail(`This company's verified first year starts ${init.s}; the start date cannot be cleared.`);
  await tx.query(`INSERT INTO tax_profile (org_id, entity_id, return_type, activity_kind, tax_method_default, book_basis_default, year_end_month, state_codes, business_code, date_started, s_election_date, accountant_may_edit, change_reason, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,12,$7,$8,$9,$10,$11,$12, now())
    ON CONFLICT (org_id, entity_id) DO UPDATE SET return_type = EXCLUDED.return_type, activity_kind = EXCLUDED.activity_kind, tax_method_default = EXCLUDED.tax_method_default,
      book_basis_default = EXCLUDED.book_basis_default, state_codes = EXCLUDED.state_codes, business_code = EXCLUDED.business_code, date_started = EXCLUDED.date_started,
      s_election_date = EXCLUDED.s_election_date, accountant_may_edit = EXCLUDED.accountant_may_edit, change_reason = EXCLUDED.change_reason, updated_at = now()`,
    [orgId, entityId, f.returnType, activityKind, f.taxMethodDefault, f.bookBasisDefault, states, code || null, f.dateStarted || null, f.sElectionDate || null, f.accountantMayEdit !== false, changed ? String(reason).trim().slice(0, 500) : null]);
}

// The return a business type (Settings → Company) suggests — shown, never saved unless a person chooses it.
export function suggestReturnType(businessType) {
  switch (businessType) {
    case 's_corp': return { returnType: 'form_1120s', note: 'An S corporation files Form 1120-S.' };
    case 'partnership': return { returnType: 'form_1065', note: 'A partnership files Form 1065.' };
    case 'llc': return { returnType: 'form_1065', note: 'An LLC with two or more members files Form 1065; a single-member LLC is disregarded and reported on its owner’s return.' };
    case 'sole_proprietor': return { returnType: 'disregarded', note: 'A sole proprietorship is reported on its owner’s Form 1040 (Schedule C): set it up as disregarded and include its books in the household return.' };
    case 'c_corp': return { returnType: null, note: 'A C corporation files Form 1120, which Tax Books does not prepare.' };
    case 'nonprofit': return { returnType: null, note: 'A nonprofit files Form 990, which Tax Books does not prepare.' };
    default: return null;
  }
}

// Open the period for a calendar year from the stored profile. `profile` ({ returnType, taxMethodDefault?, bookBasisDefault? }) is
// only for a company that has no profile yet: a stored profile is the defaults for the next period (§4.2) and changing it is a
// reviewed saveProfile change, so an override on top of one is refused rather than merged. Unnamed override values take DEFAULTS.
// `initial` (Codex t1-r1 B8) only REQUESTS a first year: the period may start mid-year and needs no predecessor, but its openings
// stay unknown until an admin verifies it (verifyInitial). Obvious chronology conflicts are refused here and by tax_check_initial.
export async function openPeriod(pool, { orgId, entityId, year, initial = false, periodStart = null, actor, profile = null }) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail('Choose the tax year.');
  if (profile) {
    if (!Object.hasOwn(RETURN_TYPE_LABELS, profile.returnType)) fail('Choose the return type this company files.');
    if (!['cash', 'accrual'].includes(profile.taxMethodDefault ?? DEFAULTS.tax_method_default)) fail('Choose cash or accrual for the tax method.');
    if (!['cash', 'accrual'].includes(profile.bookBasisDefault ?? DEFAULTS.book_basis_default)) fail('Choose the basis the books are kept on.');
  }
  return withTransaction(pool, async tx => {
    // The inclusion-graph lock first (lib/tax/bindings.js: one lock order for every Tax Books write that copies or binds).
    await lockTaxGraph(tx, orgId);
    await lockEntity(tx, orgId, entityId);
    const stored = await getProfile(tx, { orgId, entityId });
    if (profile && stored.exists !== false) fail('This company already has a tax profile: change it there (a reviewed change) instead of overriding it when opening a period.');
    const p = profile
      ? { ...DEFAULTS, return_type: profile.returnType, tax_method_default: profile.taxMethodDefault ?? DEFAULTS.tax_method_default, book_basis_default: profile.bookBasisDefault ?? DEFAULTS.book_basis_default }
      : stored;
    if (p.return_type === 'none' || !RETURN_TYPES.includes(p.return_type)) fail('Set the company’s return type on its tax profile first.');
    const start = initial ? (periodStart ?? `${year}-01-01`) : `${year}-01-01`;
    if (!isIsoDate(start) || start.slice(0, 4) !== String(year)) fail('An initial period starts inside its tax year.');
    // Mirrors tax_return_one_period (migration 064): one period covers any date for the company, whatever its return type.
    const { rows: dup } = await tx.query(`SELECT 1 FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND daterange(period_start, period_end, '[]') && daterange($3::date, $4::date, '[]')`, [orgId, entityId, start, `${year}-12-31`]);
    if (dup.length) fail(`A ${year} period already exists for this company.`);
    const end = `${year}-12-31`;
    if (initial) {
      const { rows: [earlier] } = await tx.query(`SELECT period_start::text AS s, period_end::text AS e FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_end < $3 ORDER BY period_end LIMIT 1`, [orgId, entityId, start]);
      if (earlier) fail(`An initial period is the company’s first, but an earlier period (${earlier.s} to ${earlier.e}) is on file.`);
      if (initialDoesNotFit(stored.date_started, start)) {
        fail(`The company started on ${stored.date_started}, but this first period starts ${start}. An initial return starts the day the company started; a first Tax Books year of a company that already existed is not an initial return: open it as an ordinary period (its openings stay unknown until a baseline is chosen).`);
      }
    }
    const { rows: [later] } = await tx.query(`SELECT period_start::text AS s FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND initial_status IS NOT NULL AND period_start > $3 LIMIT 1`, [orgId, entityId, end]);
    if (later) fail(`The company’s initial period starts ${later.s}; no period comes before it.`);
    const { rows: [r] } = await tx.query(`INSERT INTO tax_return (org_id, entity_id, period_start, period_end, return_type, form_edition, tax_method, book_basis, initial_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING return_id`, [orgId, entityId, start, end, p.return_type, year, p.tax_method_default, p.book_basis_default, initial ? 'requested' : null]);
    // T2 (spec §4.5): the company's binding defaults become this period's bindings, re-resolved for this period, in the same
    // transaction and under the same lock (a disregarded period takes none: its books are bound on the return that includes them).
    await copyForwardIn(tx, { orgId, entityId, returnId: r.return_id, actor });
    return r.return_id;
  }).catch(error => {
    // The owners and members must fit the new period's return (migration 065 tax_check_roster, Codex r5 R5-N1): said as a reason, not a crash.
    if (error?.code === 'P0001' && /^ownership_interest: /.test(error.message)) fail(error.message.replace(/^ownership_interest: t/, 'T'));
    throw error;
  });
}
// Mirrors tax_check_initial (Codex t1-r2 B8): an initial period starts on the day the company started. Any earlier inception, by
// a day or a decade, makes this year a reconstruction whose openings stay unknown. A request may wait for the start date; the
// verification may not (verifyInitial).
function initialDoesNotFit(started, start) {
  return Boolean(started) && String(started) !== String(start);
}
// An admin verifies a requested initial period with the evidence (formation documents, the IRS EIN letter): only then are its
// beginnings zero (tax_return.opening_state). The chronology is checked again under the company lock (tax_check_initial).
export async function verifyInitial(pool, { orgId, entityId, returnId, verifiedBy, evidence }) {
  const by = String(verifiedBy ?? '').trim().slice(0, 200) || fail('Say who verified the first year.');
  const why = String(evidence ?? '').trim().slice(0, 500) || fail('Describe the evidence that this is the company’s first year (formation documents, EIN letter).');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows: [r] } = await tx.query('SELECT initial_status, period_start::text AS s, period_end::text AS e FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND return_id = $3 FOR UPDATE', [orgId, entityId, returnId]);
    if (!r) fail('Period not found.');
    if (!r.initial_status) fail('That is not an initial period: only a requested first year is verified.');
    const { date_started: started } = await getProfile(tx, { orgId, entityId });
    if (!started) fail('Record the date the company started (tax setup) before verifying its first year: the first period must start that day.');
    if (initialDoesNotFit(started, r.s)) fail(`The company started on ${started}, but this first period starts ${r.s}: an initial return starts the day the company started.`);
    await tx.query(`UPDATE tax_return SET initial_status = 'verified', initial_verified_by = $4, initial_evidence = $5, initial_verified_at = now() WHERE org_id = $1 AND entity_id = $2 AND return_id = $3`,
      [orgId, entityId, returnId, by, why]);
  });
}
// The period's predecessor baseline (spec §4.3): same company, same return type, ending the day before the period starts, on the
// period's book basis and consolidation policy — or a reviewed exception { reason, by } recorded for each that differs (basisException,
// consolidationException). Migration 064's trigger re-checks all of this;
// the checks here exist so a person gets a ValidationError instead of a database error. Bridges that already reference the old
// predecessor's facts block the change (the trigger says so); remove them first.
export async function setPredecessor(pool, { orgId, entityId, returnId, baselineId, basisException = null, consolidationException = null }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows: [r] } = await tx.query('SELECT period_start, return_type, book_basis, consolidation_policy, initial_status FROM tax_return WHERE org_id = $1 AND return_id = $2 AND entity_id = $3 FOR UPDATE', [orgId, returnId, entityId]);
    if (!r) fail('Period not found.');
    if (r.initial_status) fail('An initial period has no predecessor: its openings are zero once the first year is verified.');
    const { rows: [b] } = await tx.query('SELECT entity_id, return_type, source_period_end, book_basis, consolidation_policy FROM tax_baseline WHERE org_id = $1 AND baseline_id = $2', [orgId, baselineId]);
    if (!b) fail('Baseline not found.');
    if (Number(b.entity_id) !== Number(entityId)) fail('That baseline belongs to another company.');
    if (b.return_type !== r.return_type) fail('That baseline is for another return type.');
    const { rows: [{ ok }] } = await tx.query('SELECT $1::date = $2::date - 1 AS ok', [b.source_period_end, r.period_start]);
    if (!ok) fail('The predecessor must end the day before this period starts.');
    if (b.book_basis !== r.book_basis && !(basisException?.reason && basisException?.by)) {
      fail(`That baseline is on the ${b.book_basis} basis and this period on the ${r.book_basis} basis: record the reviewed exception (reason and reviewer) or choose a compatible predecessor.`);
    }
    const exc = b.book_basis !== r.book_basis ? basisException : { reason: null, by: null };
    if (b.consolidation_policy !== r.consolidation_policy && !(consolidationException?.reason && consolidationException?.by)) {
      fail(`That baseline's consolidation policy is ${b.consolidation_policy} and this period's is ${r.consolidation_policy}: record the reviewed consolidation exception (reason and reviewer) or choose a compatible predecessor.`);
    }
    const cexc = b.consolidation_policy !== r.consolidation_policy ? consolidationException : { reason: null, by: null };
    const { rows: bridged } = await tx.query('SELECT 1 FROM opening_bridge WHERE org_id = $1 AND return_id = $2 LIMIT 1', [orgId, returnId]);
    if (bridged.length) fail('Remove the opening bridges before changing the predecessor.');
    await tx.query(`UPDATE tax_return SET predecessor_baseline_id = $3, predecessor_basis_exception_reason = $4, predecessor_basis_exception_by = $5,
        predecessor_consolidation_exception_reason = $6, predecessor_consolidation_exception_by = $7 WHERE org_id = $1 AND return_id = $2`,
      [orgId, returnId, baselineId, exc.reason, exc.by, String(cexc.reason ?? '').trim().slice(0, 500) || null, String(cexc.by ?? '').trim().slice(0, 200) || null]);
  });
}
const withComputes = r => r && { ...r, computes: EDITIONS.includes(Number(r.form_edition)) };
export async function getPeriod(db, { orgId, entityId, returnId }) {
  const { rows } = await db.query('SELECT * FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND return_id = $3', [orgId, entityId, returnId]);
  return withComputes(rows[0] ?? null);
}
export async function listPeriods(db, { orgId, entityId }) {
  const { rows } = await db.query('SELECT * FROM tax_return WHERE org_id = $1 AND entity_id = $2 ORDER BY period_end DESC', [orgId, entityId]);
  return rows.map(withComputes);
}
// Every company of the organization the person may open, with its profile and newest period — the /tax home.
export async function taxHome(db, { orgId, companies }) {
  const ids = companies.map(c => Number(c.entityId));
  const { rows: profiles } = await db.query('SELECT * FROM tax_profile WHERE org_id = $1 AND entity_id = ANY($2)', [orgId, ids]);
  const { rows: periods } = await db.query(`SELECT DISTINCT ON (entity_id) * FROM tax_return WHERE org_id = $1 AND entity_id = ANY($2) ORDER BY entity_id, period_end DESC`, [orgId, ids]);
  return companies.map(c => ({ ...c, profile: profiles.find(p => p.entity_id === Number(c.entityId)) ?? { ...DEFAULTS, exists: false }, period: withComputes(periods.find(p => p.entity_id === Number(c.entityId)) ?? null) }));
}
