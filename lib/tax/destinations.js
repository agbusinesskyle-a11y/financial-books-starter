// lib/tax/destinations.js
// Where a book measurement may go (spec §4.5 treatment kinds, §4.7 slots, §4.8, §4.10, §6): the destination picker by section, the
// rules each treatment follows, the canonical target and slot keys of a binding, and the catalog a period binds against. Pure.
import { ValidationError } from '../data/writes.js';
import { catalogFor, EDITIONS } from './catalog/index.js';
import { slotKey } from './providers.js';
import { PL_TYPES } from '../reports/statements.js';

const fail = message => { throw new ValidationError(message); };
export const TREATMENTS = ['input', 'statement_row', 'equity_event', 'guaranteed_payment', 'cogs_input', 'cogs_tieout', 'not_tax', 'k1_booked', 'manual_feed'];
export const TREATMENT_LABELS = { input: 'Form line', statement_row: 'Statement row', equity_event: 'Owner equity event', guaranteed_payment: 'Guaranteed payment',
  cogs_input: 'Cost of goods sold workpaper input', cogs_tieout: 'Book cost of goods sold (compared, not the tax amount)', not_tax: 'Not on the return',
  k1_booked: 'K-1 income booked here (the K-1 replaces it)', manual_feed: 'Shown beside a typed item (not the tax amount)' };
// §4.8 capital_event kinds.
export const EQUITY_EVENTS = [['contribution_cash', 'Contribution: cash'], ['contribution_property', 'Contribution: property'], ['distribution_cash', 'Distribution: cash'],
  ['distribution_property', 'Distribution: property'], ['transfer_in', 'Transfer in'], ['transfer_out', 'Transfer out'], ['other_increase', 'Other increase'], ['other_decrease', 'Other decrease']];
export const GP_KINDS = [['services', 'Guaranteed payment: services'], ['capital', 'Guaranteed payment: capital'], ['health_insurance', 'Guaranteed payment: health insurance']];
// The treatments that name a catalog slot (mirrors tax_treatment_has_slot() in migration 065). Which provider is authoritative for the
// slot is lib/tax/authority.js's question, never the treatment's (Codex t2-plan-r1 B1).
export const SLOT_TREATMENTS = ['input', 'statement_row', 'cogs_input', 'manual_feed'];
export const MEASUREMENTS = ['activity', 'begin', 'end'];
export const MEASUREMENT_LABELS = { activity: 'Activity in the period', begin: 'Beginning balance', end: 'Ending balance' };
export const BINDABLE_RETURN_TYPES = ['form_1065', 'form_1120s', 'household_1040'];
// The sections the books bind to, per return type (spec §8 "destination by section"). Anything outside them is computed or comes from
// another record: K-1 boxes (T4 allocation), M-1/M-2 (engine), Schedule E Part II and Schedule D K-1 lines (K-1 records), workpapers.
export const SECTIONS = {
  form_1065: [['f1065.p1', 'Page 1: income and deductions'], ['f1065.k', 'Schedule K: separately stated items'], ['f1065.L', 'Schedule L: balance sheet'],
    ['f1125a.main', 'Form 1125-A: cost of goods sold'], ['f8825.main', 'Form 8825: rental real estate']],
  form_1120s: [['f1120s.p1', 'Page 1: income and deductions'], ['f1120s.k', 'Schedule K: separately stated items'], ['f1120s.L', 'Schedule L: balance sheet'],
    ['f1125a.main', 'Form 1125-A: cost of goods sold'], ['f8825.main', 'Form 8825: rental real estate']],
  household_1040: [['f1040.c', 'Schedule C'], ['f1040.e1', 'Schedule E Part I (rental)'], ['f1040.f', 'Schedule F'], ['f1040.b', 'Schedule B']],
};
export const sectionOf = id => id.split('.').slice(0, 2).join('.');
// Owner-specific lines come from T4's own records, never from a books input (spec §4.8: guaranteed payments, capital events and
// shareholder loans are each counted once through the formula graph).
export const DERIVED_LINES = {
  'f1065.p1.10': 'the partners’ guaranteed payments (bind the expense as a guaranteed payment)',
  'f1065.k.4a': 'the partners’ guaranteed payments (bind the expense as a guaranteed payment)',
  'f1065.k.4b': 'the partners’ guaranteed payments (bind the expense as a guaranteed payment)',
  'f1065.k.19a': 'the owners’ capital events (bind the account’s activity as an owner equity event)',
  'f1065.k.19b': 'the owners’ capital events (bind the account’s activity as an owner equity event)',
  'f1120s.k.16d': 'the owners’ capital events (bind the account’s activity as an owner equity event)',
  'f1120s.k.16e': 'the shareholder loan rows (stage T4); bind the loan account’s balances to Schedule L line 19',
};
// COGS (spec §4.10, Codex t2-plan-r1 B6). The COGS workpaper owns these lines; the books reach them in three roles only:
//   cogs_input   genuine purchases, labor, section 263A and other costs (1125-A lines 2-5; Schedule C lines 36-39; Schedule F line 46);
//   cogs_tieout  the book cost of goods sold, compared with the computed COGS line (1125-A line 8, Schedule C line 42) — book COGS is a
//                tie-out, never purchases;
//   never        opening and closing inventory (1125-A lines 1 and 7, Schedule C 35 and 41, Schedule F 45 and 48): tax inventory is
//                established on the workpaper (T3), never routed from an account's activity or balance.
export const COGS_INPUT_IDS = new Set(['f1125a.main.2', 'f1125a.main.3', 'f1125a.main.4', 'f1125a.main.5', 'f1040.c.36', 'f1040.c.37', 'f1040.c.38', 'f1040.c.39', 'f1040.f.46']);
export const INVENTORY_IDS = new Set(['f1125a.main.1', 'f1125a.main.7', 'f1040.c.35', 'f1040.c.41', 'f1040.f.45', 'f1040.f.48']);
export const TIEOUT_IDS = new Set(['f1125a.main.8', 'f1040.c.42']);
export const isCogsLine = id => id.startsWith('f1125a.main.') || COGS_INPUT_IDS.has(id) || INVENTORY_IDS.has(id) || TIEOUT_IDS.has(id);
// Classified components of another line (B6): qualified dividends within ordinary dividends, the investment-income part of other income.
// They are one source's related classification facts, entered on the workpaper (T3), never split off as consuming inputs: a $100
// dividend account with $60 qualified is $100 on line 6a AND $60 on 6b, which no partition of $100 can say.
export const SUBSET_LINES = { 'f1065.k.6b': 'f1065.k.6a', 'f1065.k.11_inv': 'f1065.k.11', 'f1120s.k.5b': 'f1120s.k.5a', 'f1120s.k.10_inv': 'f1120s.k.10' };
// The schedules an activity may be reported on, for a per-activity line (spec §4.4 tax_activity.schedule). Form 1125-A feeds page 1.
const ACTIVITY_SCHEDULES = { 'f1125a.main': ['p1'], 'f8825.main': ['f8825'], 'f1040.c': ['sch_c'], 'f1040.e1': ['sch_e1'], 'f1040.f': ['sch_f'] };
export const isPl = type => PL_TYPES.includes(type);
export const measurementsFor = account => (isPl(account.type) ? ['activity'] : ['begin', 'end', 'activity']);
export const lineMeasurements = line => (line.cls === 'balance' ? ['begin', 'end'] : ['activity']);
// Dates are 'YYYY-MM-DD' strings (lib/db.js), so they compare as text. An activity disposed of during the period is still in it.
export const effectiveIn = (a, ret) => String(a.effective_from) <= ret.period_end && (!a.effective_to || String(a.effective_to) >= ret.period_start)
  && (!a.disposed_on || String(a.disposed_on) >= ret.period_start);
export function activityFits(line, a) {
  const allowed = ACTIVITY_SCHEDULES[sectionOf(line.id)];
  return !allowed || allowed.includes(a.schedule);
}

// The catalog a period's bindings are checked against. A period whose edition has no catalog yet may still be bound (spec §4.3): its
// destinations are checked against the newest earlier edition and every binding records that edition, to be re-checked when the
// period's own catalog ships. It still computes nothing (T3 refuses an edition without its catalog; nothing falls back).
export function catalogContext(ret) {
  const returnType = ret.return_type, formEdition = Number(ret.form_edition);
  if (returnType === 'disregarded') fail('A disregarded company’s books are mapped on the return that includes them (its owner’s), not on its own period.');
  if (!BINDABLE_RETURN_TYPES.includes(returnType)) fail(`A ${returnType} period takes no bindings.`);
  const earlier = EDITIONS.filter(e => e <= formEdition);
  if (!earlier.length) fail(`No catalog edition at or before ${formEdition}: this period cannot be bound yet.`);
  const edition = Math.max(...earlier);
  return { returnType, edition, formEdition, provisional: edition !== formEdition };
}

function bindableLine(ctx, id) {
  const line = catalogFor(ctx.returnType, ctx.edition).byId.get(id) ?? fail(`${id} is not a line of this return.`);
  if (!SECTIONS[ctx.returnType].some(([s]) => s === sectionOf(id))) fail(`${line.label} (${id}) is not bound from the books: it is computed or comes from another record.`);
  if (line.kind === 'computed') fail(`${line.label} is computed from other lines; bind its parts.`);
  if (line.cls === 'info' || !['amount', 'statement'].includes(line.type)) fail(`${line.label} is an answer, not an amount.`);
  if (line.sourceRequired) fail(`${line.label} takes only amounts from K-1s received.`);
  if (line.instanceDims.some(d => !['activity', 'interest'].includes(d))) fail(`${line.label} is kept per ${line.instanceDims.join(' and ')}, which a books binding cannot supply.`);
  return line;
}

// Checks one target against the period's catalog and the account (spec §4.5). t: { treatment, destination, measurement, accountType,
// interestPartyId, k1IssuerPartyId, memo }. Returns { line (or null), activity, interest, k1 }: which dimensions the caller resolves.
// Throws a ValidationError with the reason.
export function checkTarget(ctx, t) {
  if (!TREATMENTS.includes(t.treatment)) fail('Choose where this amount goes.');
  if (!MEASUREMENTS.includes(t.measurement)) fail('Choose the measurement: activity, beginning or ending balance.');
  if (isPl(t.accountType) && t.measurement !== 'activity') fail('An income or expense account is measured by its activity in the period: its balance starts at zero every year.');
  const needs = { line: null, activity: false, interest: false, k1: false };
  switch (t.treatment) {
    case 'input': case 'statement_row': case 'cogs_input': case 'manual_feed': {
      const line = bindableLine(ctx, t.destination ?? '');
      if (DERIVED_LINES[line.id]) fail(`${line.label} comes from ${DERIVED_LINES[line.id]}.`);
      if (SUBSET_LINES[line.id]) fail(`${line.label} is a classified part of another line: bind the account to ${shortId(SUBSET_LINES[line.id])}; the classification is entered on the workpaper.`);
      if (INVENTORY_IDS.has(line.id)) fail(`${line.label}: tax inventory is established on the cost of goods sold workpaper, never routed from an account.`);
      const cogs = COGS_INPUT_IDS.has(line.id);
      if (cogs && t.treatment !== 'cogs_input') fail(`${line.label} is filled by the cost of goods sold workpaper: bind the account as a COGS workpaper input.`);
      if (!cogs && t.treatment === 'cogs_input') fail('A COGS workpaper input is a purchase, labor, section 263A or other cost line of Form 1125-A or Schedule C/F.');
      if (cogs && t.measurement !== 'activity') fail('A COGS workpaper input is the period’s activity: tax inventory is entered on the workpaper, never taken from the book balance.');
      if (t.treatment === 'manual_feed' && line.kind !== 'manual') fail(`${line.label} is not a typed item: bind it as a form line or statement row.`);
      if (t.treatment !== 'manual_feed' && line.kind === 'manual') fail(`${line.label} is a typed (manual) item: the books can only be shown beside it (choose “shown beside a typed item”).`);
      if (t.treatment === 'statement_row' && line.kind !== 'statement') fail(`${line.label} is a single amount: bind it as a form line.`);
      if (t.treatment === 'input' && line.kind !== 'input') fail(`${line.label} is an attached statement: bind the account as a statement row.`);
      if (!cogs && !isPl(t.accountType) && t.measurement === 'activity') fail('A balance-sheet account’s activity reaches the return only as an owner equity event, a COGS workpaper input, K-1 income or “not on the return”: bind its balances to the balance sheet.');
      if (!cogs && !lineMeasurements(line).includes(t.measurement)) fail(`${line.label} takes the ${lineMeasurements(line).map(m => MEASUREMENT_LABELS[m].toLowerCase()).join(' or ')}, not the ${MEASUREMENT_LABELS[t.measurement].toLowerCase()}.`);
      needs.line = line;
      needs.activity = line.instanceDims.includes('activity');
      needs.interest = line.instanceDims.includes('interest');
      if (needs.interest && !t.interestPartyId) fail(`${line.label} is kept per owner: choose the owner.`);
      break;
    }
    case 'cogs_tieout': {
      const line = catalogFor(ctx.returnType, ctx.edition).byId.get(t.destination ?? '');
      if (!line || !TIEOUT_IDS.has(line.id)) fail('Book cost of goods sold is compared with Form 1125-A line 8 or Schedule C line 42.');
      if (!isPl(t.accountType) || t.measurement !== 'activity') fail('Book cost of goods sold is an expense account’s activity.');
      needs.line = line;
      needs.activity = line.instanceDims.includes('activity');
      break;
    }
    case 'equity_event':
      if (!['form_1065', 'form_1120s'].includes(ctx.returnType)) fail('Owner equity events belong to a partnership or S corporation return.');
      if (!EQUITY_EVENTS.some(([k]) => k === t.destination)) fail('Choose the kind of equity event.');
      if (isPl(t.accountType)) fail('An equity event comes from a balance-sheet account (capital, draws, contributions), not from income or expense.');
      if (t.measurement !== 'activity') fail('An equity event is the period’s activity on the account.');
      if (!t.interestPartyId) fail('Choose the owner this equity event belongs to.');
      needs.interest = true;
      break;
    case 'guaranteed_payment':
      if (ctx.returnType !== 'form_1065') fail('Guaranteed payments are a partnership item.');
      if (!GP_KINDS.some(([k]) => k === t.destination)) fail('Choose services, capital or health insurance.');
      if (!isPl(t.accountType)) fail('A guaranteed payment is an expense account’s activity.');
      if (!t.interestPartyId) fail('Choose the partner the guaranteed payment is paid to.');
      needs.interest = true;
      break;
    case 'k1_booked':
      if (t.destination) fail('K-1 income booked here has no form line: the K-1 itself supplies the amounts.');
      if (t.measurement !== 'activity') fail('K-1 income booked here is the period’s activity on the account.');
      if (!t.k1IssuerPartyId) fail('Choose the partnership or S corporation whose K-1 this account records.');
      needs.k1 = true;
      break;
    case 'not_tax':
      if (t.destination) fail('“Not on the return” takes no destination.');
      if (String(t.memo ?? '').trim().length < 3) fail('Say why this amount is not on the return: a memo is required.');
      break;
  }
  return needs;
}

// The identity of one target within a source measurement's set (unique per return, account and measurement).
export const targetKey = t => [t.treatment, t.destination ?? '-', `a=${t.activityId ?? '-'}`, `o=${t.interestPartyId ?? '-'}`, `k=${t.k1IssuerPartyId ?? '-'}`].join('|');

// The slot a binding feeds (spec §4.7), when its treatment feeds one and every dimension the line requires is resolved; else null.
export function slotFor(ctx, { treatment, line, measurement, activityId = null, interestId = null }) {
  if (!SLOT_TREATMENTS.includes(treatment) || !line) return null;
  const dims = {};
  if (line.instanceDims.includes('activity')) { if (!activityId) return null; dims.activity = `act:${activityId}`; }
  if (line.instanceDims.includes('interest')) { if (!interestId) return null; dims.interest = `i:${interestId}`; }
  return slotKey({ fieldId: line.id, dims, measurement, returnType: ctx.returnType, edition: ctx.edition });
}

// A line id as people read it on the form: "p1.9", "L.1", "K.13a", "1125-A line 2", "8825 line 2a", "C.1".
export const shortId = id => id.replace(/^f1125a\.main\./, '1125-A line ').replace(/^f8825\.main\./, '8825 line ').replace(/^f(1065|1120s|1040)\./, '').replace(/^k\./, 'K.').replace(/^([cbf]|e1)\./, (m, g) => `${g.toUpperCase()}.`);
const naturalTreatment = l => (COGS_INPUT_IDS.has(l.id) ? 'cogs_input' : isCogsLine(l.id) ? null : l.kind === 'manual' ? 'manual_feed' : l.kind === 'statement' ? 'statement_row' : l.kind === 'input' ? 'input' : null);
// The picker (spec §8): one option per line the account can take, grouped by section, each with its own treatment, then the owner and
// other choices. value = "treatment:destination". Labels are kept to 70 characters so a select fits a phone.
export function pickerOptions(ctx, accountType) {
  const pl = isPl(accountType), lines = catalogFor(ctx.returnType, ctx.edition).lines, groups = [];
  for (const [section, label] of SECTIONS[ctx.returnType]) {
    const options = [];
    for (const l of lines) {
      if (sectionOf(l.id) !== section || DERIVED_LINES[l.id] || SUBSET_LINES[l.id]) continue;
      if (TIEOUT_IDS.has(l.id) && pl) { options.push({ value: `cogs_tieout:${l.id}`, label: `${shortId(l.id)} book COGS, compared with ${l.label}`.slice(0, 70), measurements: ['activity'] }); continue; }
      const treatment = naturalTreatment(l);
      if (!treatment) continue;
      try { bindableLine(ctx, l.id); } catch { continue; }
      if (treatment === 'cogs_input' ? !(pl || accountType === 'inventory') : pl === (l.cls === 'balance')) continue;
      options.push({ value: `${treatment}:${l.id}`, label: `${shortId(l.id)} ${l.label}`.slice(0, 70), measurements: treatment === 'cogs_input' ? ['activity'] : lineMeasurements(l) });
    }
    if (options.length) groups.push({ label, options });
  }
  const owner = [];
  if (!pl && ['form_1065', 'form_1120s'].includes(ctx.returnType)) owner.push(...EQUITY_EVENTS.map(([k, l]) => ({ value: `equity_event:${k}`, label: l, measurements: ['activity'] })));
  if (pl && ctx.returnType === 'form_1065') owner.push(...GP_KINDS.map(([k, l]) => ({ value: `guaranteed_payment:${k}`, label: l, measurements: ['activity'] })));
  if (owner.length) groups.push({ label: 'Owners', options: owner });
  groups.push({ label: 'Other', options: [{ value: 'k1_booked:', label: TREATMENT_LABELS.k1_booked, measurements: ['activity'] },
    { value: 'not_tax:', label: TREATMENT_LABELS.not_tax, measurements: measurementsFor({ type: accountType }) }] });
  return groups;
}
export function parseWhat(value) {
  const m = /^([a-z0-9_]+):(.*)$/.exec(String(value ?? ''));
  if (!m || !TREATMENTS.includes(m[1])) fail('Choose where this amount goes.');
  return { treatment: m[1], destination: m[2] || null };
}
// A binding's or suggestion's target as text: "p1.9 Salaries and wages (other than to partners)", "Distribution: cash", …
export function describeTarget(ctx, { treatment, destination }) {
  if ((SLOT_TREATMENTS.includes(treatment) || treatment === 'cogs_tieout') && destination) {
    const l = catalogFor(ctx.returnType, ctx.edition).byId.get(destination);
    const text = l ? `${shortId(destination)} ${l.label}` : destination;
    return treatment === 'cogs_tieout' ? `${text} (book COGS, compared)` : text;
  }
  if (treatment === 'equity_event') return EQUITY_EVENTS.find(([k]) => k === destination)?.[1] ?? destination;
  if (treatment === 'guaranteed_payment') return GP_KINDS.find(([k]) => k === destination)?.[1] ?? destination;
  return TREATMENT_LABELS[treatment];
}
