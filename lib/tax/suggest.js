// lib/tax/suggest.js
// Mapping suggestions (spec §7), in the order and with the confidence words of lib/bankfeed/rules.js: rule (account type, system key
// and name words — the books keep no QuickBooks detail type) → history (the same account name bound as a default in a sibling company
// of the SAME organization with the same return type, among the companies this person may open) → AI (optional, lib/tax/suggest-ai.js).
// Proposals only: nothing is bound until a person accepts. "Accept all sure" takes high confidence only and never the §7 exclusions.
import { createHash } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { saveBindingsIn, lockTaxGraph, EMPTY_SET } from './bindings.js';
import { coverage } from './coverage.js';
import { checkTarget, activityFits, effectiveIn } from './destinations.js';

const fail = message => { throw new ValidationError(message); };
export const RULES_VERSION = 'tax-t2-rules-2';
const R = (id, types, words, treatment, destination, measurements, confidence, { not = null, system = null, memo = null } = {}) =>
  ({ id, types, words, not, system, treatment, destination, measurements, confidence, memo });
const BAL = ['begin', 'end'], ACT = ['activity'];
const EXP = ['expense', 'other_expense'], INC = ['income', 'other_income'];
const BS_TYPES = ['bank', 'accounts_receivable', 'other_current_asset', 'inventory', 'fixed_asset', 'other_asset', 'accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability', 'equity'];

// Balance-sheet rules (first match wins; specific before general).
const BALANCE = {
  form_1065: [
    R('bank', ['bank'], null, 'input', 'f1065.L.1', BAL, 'high'),
    // The allowance (a contra receivable) before receivables: Schedule L reports gross receivables and their allowance separately (Codex B7).
    R('allowance', ['other_current_asset', 'accounts_receivable'], /allowance|doubtful|bad debt reserve/i, 'input', 'f1065.L.2b', BAL, 'medium'),
    R('ar', ['accounts_receivable'], null, 'input', 'f1065.L.2a', BAL, 'high'),
    R('inventory', ['inventory'], null, 'input', 'f1065.L.3', BAL, 'high'),
    // Only "accumulated" names the contra account surely; "Depreciation equipment" is ambiguous (cost or contra), so it is low and never sure.
    R('accum_dep', ['fixed_asset'], /accum/i, 'input', 'f1065.L.9b', BAL, 'high'),
    R('dep_ambiguous', ['fixed_asset'], /depreciation|depr\b/i, 'input', 'f1065.L.9b', BAL, 'low'),
    R('land', ['fixed_asset'], /\bland\b/i, 'input', 'f1065.L.11', BAL, 'medium'),
    R('fixed', ['fixed_asset'], null, 'input', 'f1065.L.9a', BAL, 'high'),
    R('accum_amort', ['other_asset'], /amortiz/i, 'input', 'f1065.L.12b', BAL, 'medium'),
    R('loan_to_partner', ['other_current_asset', 'other_asset'], /partner|member|owner/i, 'input', 'f1065.L.7a', BAL, 'low'),
    R('oca', ['other_current_asset'], null, 'statement_row', 'f1065.L.6', BAL, 'medium'),
    R('oa', ['other_asset'], null, 'statement_row', 'f1065.L.13', BAL, 'medium'),
    R('ap', ['accounts_payable'], null, 'input', 'f1065.L.15', BAL, 'high'),
    R('loan_from_partner', ['other_current_liability', 'long_term_liability'], /partner|member|owner/i, 'input', 'f1065.L.19a', BAL, 'low'),
    R('card', ['credit_card'], null, 'statement_row', 'f1065.L.17', BAL, 'medium'),
    R('ocl', ['other_current_liability'], null, 'statement_row', 'f1065.L.17', BAL, 'medium'),
    R('ltl', ['long_term_liability'], null, 'input', 'f1065.L.19b', BAL, 'medium'),
    R('capital', ['equity'], null, 'input', 'f1065.L.21', BAL, 'high'),
  ],
  form_1120s: [
    R('bank', ['bank'], null, 'input', 'f1120s.L.1', BAL, 'high'),
    // The allowance (a contra receivable) before receivables: Schedule L reports gross receivables and their allowance separately (Codex B7).
    R('allowance', ['other_current_asset', 'accounts_receivable'], /allowance|doubtful|bad debt reserve/i, 'input', 'f1120s.L.2b', BAL, 'medium'),
    R('ar', ['accounts_receivable'], null, 'input', 'f1120s.L.2a', BAL, 'high'),
    R('inventory', ['inventory'], null, 'input', 'f1120s.L.3', BAL, 'high'),
    // Only "accumulated" names the contra account surely; "Depreciation equipment" is ambiguous (cost or contra), so it is low and never sure.
    R('accum_dep', ['fixed_asset'], /accum/i, 'input', 'f1120s.L.10b', BAL, 'high'),
    R('dep_ambiguous', ['fixed_asset'], /depreciation|depr\b/i, 'input', 'f1120s.L.10b', BAL, 'low'),
    R('land', ['fixed_asset'], /\bland\b/i, 'input', 'f1120s.L.12', BAL, 'medium'),
    R('fixed', ['fixed_asset'], null, 'input', 'f1120s.L.10a', BAL, 'high'),
    R('accum_amort', ['other_asset'], /amortiz/i, 'input', 'f1120s.L.13b', BAL, 'medium'),
    R('oca', ['other_current_asset'], null, 'statement_row', 'f1120s.L.6', BAL, 'medium'),
    R('oa', ['other_asset'], null, 'statement_row', 'f1120s.L.14', BAL, 'medium'),
    R('ap', ['accounts_payable'], null, 'input', 'f1120s.L.16', BAL, 'high'),
    R('card', ['credit_card'], null, 'statement_row', 'f1120s.L.18', BAL, 'medium'),
    R('ocl', ['other_current_liability'], null, 'statement_row', 'f1120s.L.18', BAL, 'medium'),
    R('ltl', ['long_term_liability'], null, 'input', 'f1120s.L.20', BAL, 'medium', { not: /shareholder|owner|officer/i }),
    R('retained', ['equity'], null, 'input', 'f1120s.L.24', BAL, 'high', { system: 'retained' }),
    R('stock', ['equity'], /capital stock|common stock|\bstock\b/i, 'input', 'f1120s.L.22', BAL, 'medium', { not: /treasury/i }),
    R('apic', ['equity'], /paid.in|apic/i, 'input', 'f1120s.L.23', BAL, 'medium'),
    R('treasury', ['equity'], /treasury/i, 'input', 'f1120s.L.26', BAL, 'low'),
    R('equity_other', ['equity'], null, 'input', 'f1120s.L.24', BAL, 'low'),
  ],
};
// Income and expense rules of a partnership or S corporation's own activity (page 1, Schedule K, Form 1125-A).
// COGS (Codex B6): only an account named for purchases is purchases; a book cost-of-goods-sold total (a perpetual system's relief of
// inventory) is the tie-out compared with line 8, never purchases. Tax inventories are entered on the workpaper.
const COGS = [
  R('cogs_purchases', ['cost_of_goods_sold'], /purchase/i, 'cogs_input', 'f1125a.main.2', ACT, 'medium'),
  R('cogs_labor', ['cost_of_goods_sold'], /labor|wage/i, 'cogs_input', 'f1125a.main.3', ACT, 'medium'),
  R('cogs_other', ['cost_of_goods_sold'], /freight|overhead|other cost/i, 'cogs_input', 'f1125a.main.5', ACT, 'medium'),
  R('cogs_book', ['cost_of_goods_sold'], null, 'cogs_tieout', 'f1125a.main.8', ACT, 'medium'),
];
const PL = {
  form_1065: [
    R('returns', ['income'], /return|allowance|refund/i, 'input', 'f1065.p1.1b', ACT, 'medium'),
    R('int_inc', INC, /interest/i, 'input', 'f1065.k.5', ACT, 'high'),
    R('div', INC, /dividend/i, 'input', 'f1065.k.6a', ACT, 'high'),
    R('royalty', INC, /royalt/i, 'input', 'f1065.k.7', ACT, 'medium'),
    R('sales', ['income'], null, 'input', 'f1065.p1.1a', ACT, 'high'),
    R('oth_inc', ['other_income'], null, 'statement_row', 'f1065.p1.7', ACT, 'medium'),
    ...COGS,
    R('taxes', EXP, /tax|licen/i, 'statement_row', 'f1065.p1.14', ACT, 'medium'),
    R('wages', ['expense'], /wage|salar|payroll/i, 'input', 'f1065.p1.9', ACT, 'high', { not: /guaranteed|partner|officer|member/i }),
    R('repairs', ['expense'], /repair|maint/i, 'input', 'f1065.p1.11', ACT, 'high'),
    R('bad_debt', ['expense'], /bad debt/i, 'input', 'f1065.p1.12', ACT, 'high'),
    R('rent', ['expense'], /\brent|lease/i, 'input', 'f1065.p1.13', ACT, 'high'),
    R('interest', EXP, /interest/i, 'input', 'f1065.p1.15', ACT, 'medium'),
    R('dep', EXP, /depreciation|amortiz/i, 'manual_feed', 'f1065.p1.16a', ACT, 'high'),
    R('retire', ['expense'], /retirement|401|pension|simple ira/i, 'input', 'f1065.p1.18', ACT, 'high'),
    R('benefits', ['expense'], /benefit|health ins/i, 'input', 'f1065.p1.19', ACT, 'medium'),
    R('charity', EXP, /charit|donat|contribution/i, 'input', 'f1065.k.13a', ACT, 'medium'),
    R('penalty', EXP, /penalt|\bfines?\b/i, 'input', 'f1065.k.18c', ACT, 'medium'),
    R('other_exp', EXP, null, 'statement_row', 'f1065.p1.21', ACT, 'medium'),
  ],
  form_1120s: [
    R('returns', ['income'], /return|allowance|refund/i, 'input', 'f1120s.p1.1b', ACT, 'medium'),
    R('int_inc', INC, /interest/i, 'input', 'f1120s.k.4', ACT, 'high'),
    R('div', INC, /dividend/i, 'input', 'f1120s.k.5a', ACT, 'high'),
    R('royalty', INC, /royalt/i, 'input', 'f1120s.k.6', ACT, 'medium'),
    R('sales', ['income'], null, 'input', 'f1120s.p1.1a', ACT, 'high'),
    R('oth_inc', ['other_income'], null, 'statement_row', 'f1120s.p1.5', ACT, 'medium'),
    ...COGS,
    R('taxes', EXP, /tax|licen/i, 'statement_row', 'f1120s.p1.12', ACT, 'medium'),
    R('wages', ['expense'], /wage|salar|payroll/i, 'input', 'f1120s.p1.8', ACT, 'high', { not: /officer|shareholder|owner/i }),
    R('repairs', ['expense'], /repair|maint/i, 'input', 'f1120s.p1.9', ACT, 'high'),
    R('bad_debt', ['expense'], /bad debt/i, 'input', 'f1120s.p1.10', ACT, 'high'),
    R('rent', ['expense'], /\brent|lease/i, 'input', 'f1120s.p1.11', ACT, 'high'),
    R('interest', EXP, /interest/i, 'input', 'f1120s.p1.13', ACT, 'medium'),
    R('dep', EXP, /depreciation|amortiz/i, 'manual_feed', 'f1120s.p1.14', ACT, 'high'),
    R('advertising', ['expense'], /advertis|marketing/i, 'input', 'f1120s.p1.16', ACT, 'high'),
    R('retire', ['expense'], /retirement|401|pension|simple ira/i, 'input', 'f1120s.p1.17', ACT, 'high'),
    R('benefits', ['expense'], /benefit|health ins/i, 'input', 'f1120s.p1.18', ACT, 'medium'),
    R('charity', EXP, /charit|donat|contribution/i, 'input', 'f1120s.k.12a', ACT, 'medium'),
    R('penalty', EXP, /penalt|\bfines?\b/i, 'input', 'f1120s.k.16c', ACT, 'medium'),
    R('other_exp', EXP, null, 'statement_row', 'f1120s.p1.20', ACT, 'medium'),
  ],
};
// Income and expense of a rental activity reported on Form 8825 (an included rental company, or the return's own rental activity).
const RENTAL_8825 = [
  R('rents', INC, /rent/i, 'input', 'f8825.main.2a', ACT, 'high'),
  R('rent_other', INC, null, 'input', 'f8825.main.2b', ACT, 'medium'),
  R('r_advert', EXP, /advertis/i, 'input', 'f8825.main.3', ACT, 'high'),
  R('r_auto', EXP, /auto|travel|\bcar\b|truck|mileage/i, 'input', 'f8825.main.4', ACT, 'medium'),
  R('r_repair', EXP, /repair/i, 'input', 'f8825.main.11', ACT, 'high'),
  R('r_clean', EXP, /clean|maint/i, 'input', 'f8825.main.5', ACT, 'medium'),
  R('r_comm', EXP, /commission/i, 'input', 'f8825.main.6', ACT, 'high'),
  R('r_ins', EXP, /insur/i, 'input', 'f8825.main.7', ACT, 'medium'),
  R('r_int', EXP, /interest/i, 'input', 'f8825.main.8', ACT, 'medium'),
  R('r_legal', EXP, /legal|professional|accounting/i, 'input', 'f8825.main.9', ACT, 'high'),
  R('r_tax', EXP, /tax/i, 'input', 'f8825.main.10', ACT, 'medium'),
  R('r_util', EXP, /utilit|electric|water|\bgas\b/i, 'input', 'f8825.main.12', ACT, 'high'),
  R('r_wages', EXP, /wage|salar/i, 'input', 'f8825.main.13', ACT, 'high'),
  R('r_dep', EXP, /depreciation/i, 'manual_feed', 'f8825.main.14', ACT, 'high'),
  R('r_other', EXP, null, 'statement_row', 'f8825.main.17', ACT, 'medium'),
];
// The household (the 1040 workpaper until T8): Schedule C, Schedule E Part I and Schedule B. Never above medium. A Form 1040 has no
// balance sheet, so a balance is "not on the return" — still a binding a person confirms (coverage counts every nonzero balance).
const HH_BALANCE = [R('hh_balance', BS_TYPES, null, 'not_tax', null, BAL, 'medium', { memo: 'A Form 1040 has no balance sheet: balances are not on the return.' })];
const SCH_C = [
  R('c_returns', ['income'], /return|allowance|refund/i, 'input', 'f1040.c.2', ACT, 'medium'),
  R('c_sales', ['income'], null, 'input', 'f1040.c.1', ACT, 'medium'),
  R('c_other_inc', ['other_income'], null, 'statement_row', 'f1040.c.6', ACT, 'medium'),
  R('c_purchases', ['cost_of_goods_sold'], /purchase/i, 'cogs_input', 'f1040.c.36', ACT, 'medium'),
  R('c_cogs_book', ['cost_of_goods_sold'], null, 'cogs_tieout', 'f1040.c.42', ACT, 'medium'),
  R('c_tax', EXP, /tax|licen/i, 'input', 'f1040.c.23', ACT, 'medium'),
  R('c_advert', EXP, /advertis|marketing/i, 'input', 'f1040.c.8', ACT, 'medium'),
  R('c_comm', EXP, /commission/i, 'input', 'f1040.c.10', ACT, 'medium'),
  R('c_contract', EXP, /contract/i, 'input', 'f1040.c.11', ACT, 'medium'),
  R('c_ins', EXP, /insur/i, 'input', 'f1040.c.15', ACT, 'medium'),
  R('c_int', EXP, /interest/i, 'input', 'f1040.c.16b', ACT, 'medium'),
  R('c_legal', EXP, /legal|professional|accounting/i, 'input', 'f1040.c.17', ACT, 'medium'),
  R('c_office', EXP, /office/i, 'input', 'f1040.c.18', ACT, 'medium'),
  R('c_rent', EXP, /\brent|lease/i, 'input', 'f1040.c.20b', ACT, 'medium'),
  R('c_repair', EXP, /repair|maint/i, 'input', 'f1040.c.21', ACT, 'medium'),
  R('c_supplies', EXP, /suppl/i, 'input', 'f1040.c.22', ACT, 'medium'),
  R('c_travel', EXP, /travel/i, 'input', 'f1040.c.24a', ACT, 'medium'),
  R('c_meals', EXP, /meal/i, 'input', 'f1040.c.24b', ACT, 'low'),
  R('c_util', EXP, /utilit/i, 'input', 'f1040.c.25', ACT, 'medium'),
  R('c_wages', EXP, /wage|salar|payroll/i, 'input', 'f1040.c.26', ACT, 'medium'),
  R('c_dep', EXP, /depreciation/i, 'manual_feed', 'f1040.c.13', ACT, 'medium'),
  R('c_other', EXP, null, 'statement_row', 'f1040.c.27b', ACT, 'medium'),
];
const SCH_E1 = [
  R('e_rent', INC, null, 'input', 'f1040.e1.3', ACT, 'medium'),
  R('e_ins', EXP, /insur/i, 'input', 'f1040.e1.9', ACT, 'medium'),
  R('e_mortgage', EXP, /mortgage/i, 'input', 'f1040.e1.12', ACT, 'medium'),
  R('e_int', EXP, /interest/i, 'input', 'f1040.e1.13', ACT, 'medium'),
  R('e_repair', EXP, /repair/i, 'input', 'f1040.e1.14', ACT, 'medium'),
  R('e_tax', EXP, /tax/i, 'input', 'f1040.e1.16', ACT, 'medium'),
  R('e_util', EXP, /utilit/i, 'input', 'f1040.e1.17', ACT, 'medium'),
  R('e_dep', EXP, /depreciation/i, 'manual_feed', 'f1040.e1.18', ACT, 'medium'),
  R('e_other', EXP, null, 'statement_row', 'f1040.e1.19', ACT, 'medium'),
];
const HH_PORTFOLIO = [
  R('b_interest', INC, /interest/i, 'statement_row', 'f1040.b.1', ACT, 'medium'),
  R('b_dividend', INC, /dividend/i, 'statement_row', 'f1040.b.5', ACT, 'medium'),
];
const HOUSEHOLD = { sch_c: [...SCH_C, ...HH_BALANCE], sch_e1: [...SCH_E1, ...HH_BALANCE], sch_f: [...HH_BALANCE], none: [...HH_PORTFOLIO, ...HH_BALANCE] };

// The rules for a return type and the schedule of the activity the books report on ('p1' for a business's own books).
export function rulesFor(returnType, schedule) {
  if (returnType === 'household_1040') return HOUSEHOLD[schedule] ?? HOUSEHOLD.none;
  return [...(schedule === 'f8825' ? RENTAL_8825 : PL[returnType]), ...BALANCE[returnType]];
}
export const ruleFor = (rules, account) => rules.find(r => r.types.includes(account.type) && (!r.system || r.system === account.systemKey)
  && (!r.words || r.words.test(account.name)) && (!r.not || !r.not.test(account.name))) ?? null;

// §7: "Accept all sure" takes high only and never meals and entertainment, travel, insurance, taxes and licenses, contributions, owner
// payments, interest, equity, inventory or anything with an owner (interest) — checked on the account, the treatment and the line.
const NEVER_WORDS = /meal|entertain|travel|insur|tax|licen|contribut|donat|charit|owner|draw|distribut|partner|member|shareholder|officer|guaranteed|interest|equity|capital|inventor|loan/i;
const NEVER_TREATMENTS = new Set(['equity_event', 'guaranteed_payment', 'k1_booked', 'cogs_input', 'cogs_tieout', 'not_tax']);
const NEVER_LINES = /^(f1065\.(p1\.1[45]|k\.(5|13[a-e]|18c)|L\.(3|7a|19a|21))|f1120s\.(p1\.(7|12|13)|k\.(4|12[a-e]|16c)|L\.(3|7|19|2[2-6]))|f8825\.main\.(4|7|8|10)|f1040\.(c\.(15|16[ab]|23|24[ab])|e1\.(6|9|1[236])|f\.(2[01]|29)|b\.[15]))$/;
// Structurally too (B7): nothing with an owner or K-1 reference (ownerScoped), whatever its words or line.
export function isSure(s) {
  return s.confidence === 'high' && !s.ownerScoped && !NEVER_TREATMENTS.has(s.treatment) && !NEVER_WORDS.test(s.accountName ?? '') && !['equity', 'inventory'].includes(s.accountType)
    && !NEVER_LINES.test(s.destination ?? '');
}
// The whole decision a person sees (B7, Codex r2 B7): the return, the account as named and typed, the measurement and its partition version,
// the target and activity, where the suggestion came from (rule or history evidence, rules version), the confidence shown and every
// alternative behind it (the history that agreed or disagreed), and the binding set it would replace. Acceptance recomputes the
// suggestions under the save locks and accepts only an identical key; anything material that changed refuses it and asks for a new look.
const alt = c => [c.source, c.basis, c.confidence, c.treatment, c.destination ?? null, c.activityId ?? null, c.evidence ?? null];
export const decisionKey = s => createHash('md5').update(JSON.stringify([s.returnId ?? null, s.sourceEntityId, s.accountId, s.accountName, s.accountType, s.measurement, s.version,
  s.treatment, s.destination ?? null, s.activityId ?? null, s.source, s.basis, RULES_VERSION, s.confidence, s.evidence ?? null, s.memo ?? null, (s.alternatives ?? []).map(alt),
  (s.agreeing ?? []).map(alt), s.setFingerprint ?? EMPTY_SET])).digest('hex');

const LEVEL = { low: 0, medium: 1, high: 2 };
const lower = (a, b) => (LEVEL[a] <= LEVEL[b] ? a : b), higher = (a, b) => (LEVEL[a] >= LEVEL[b] ? a : b);

// Sibling companies' defaults for the same account names (spec §7 history), whole bindings without owner or K-1 references only.
async function historyFor(db, { orgId, returnType, entityIds, names }) {
  const out = new Map();
  if (!entityIds.length || !names.length) return out;
  const { rows } = await db.query(`SELECT lower(btrim(a.name)) AS name, d.measurement, d.treatment, d.destination, d.memo, count(DISTINCT d.entity_id)::int AS companies
      FROM tax_binding_default d JOIN account a ON a.org_id = d.org_id AND a.account_id = d.account_id
     WHERE d.org_id = $1 AND d.return_type = $2 AND d.entity_id = ANY($3::bigint[]) AND lower(btrim(a.name)) = ANY($4::text[])
       AND d.share_num IS NULL AND d.interest_party_id IS NULL AND d.k1_issuer_party_id IS NULL
     GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 6 DESC`, [orgId, returnType, entityIds, names.map(n => n.trim().toLowerCase())]);
  for (const r of rows) { const k = `${r.name}|${r.measurement}`; if (!out.has(k)) out.set(k, []); out.get(k).push(r); }
  for (const [k, list] of out) {
    const agreeing = list.length === 1;
    out.set(k, list.map(r => ({ source: 'history', basis: `history:${r.companies}`, confidence: agreeing ? (r.companies >= 2 ? 'high' : 'medium') : 'low',
      treatment: r.treatment, destination: r.destination, memo: r.memo, evidence: { companies: r.companies } })));
  }
  return out;
}
// A candidate the system can complete on its own: catalog-checked for the account and measurement, needing no owner or K-1 payer,
// and with an activity it can know (the inclusion's, or the return's only in-effect activity on that schedule). Else null.
function viable(ctx, { s, act, activities, ret }, a, ms, c) {
  let needs;
  try { needs = checkTarget(ctx, { treatment: c.treatment, destination: c.destination, measurement: ms, accountType: a.type, memo: c.memo }); } catch { return null; }
  if (needs.interest || needs.k1) return null;
  let activityId = null;
  if (!s.own) {
    activityId = s.topActivityId;
    if (needs.activity && !activityFits(needs.line, act)) return null;
  } else if (needs.activity) {
    const fits = activities.filter(x => effectiveIn(x, ret) && activityFits(needs.line, x));
    if (fits.length !== 1) return null;
    activityId = fits[0].activity_id;
  }
  return { ...c, activityId };
}

// One suggestion per uncovered needed measurement of every account a person may open: { sourceEntityId, accountId, accountName,
// accountType, measurement, cents, version, source, basis, confidence, treatment, destination, activityId, memo, evidence, alternatives, sure }.
export async function suggestionsFor(db, { orgId, cov, companyIds = [] }) {
  const { ret, ctx } = cov;
  const activities = (await db.query('SELECT activity_id, name, schedule, effective_from, effective_to, disposed_on FROM tax_activity WHERE org_id = $1 AND return_entity_id = $2',
    [orgId, ret.entity_id])).rows.map(a => ({ ...a, activity_id: Number(a.activity_id) }));
  const out = [];
  for (const s of cov.sources) {
    if (!s.allowed) continue;
    if (!s.allowed || s.status !== 'measured') continue;
    const act = s.own ? null : activities.find(a => a.activity_id === s.topActivityId);
    const schedule = s.own ? (ctx.returnType === 'household_1040' ? 'none' : 'p1') : act?.schedule ?? 'none';
    const rules = rulesFor(ctx.returnType, schedule);
    const open = s.accounts.filter(a => a.needs.some(n => n !== 'any' && a.results[n]?.status === 'uncovered'));
    const history = await historyFor(db, { orgId, returnType: ctx.returnType, entityIds: companyIds.map(Number).filter(id => id !== s.entityId), names: open.map(a => a.name) });
    for (const a of open) for (const ms of a.needs) {
      if (ms === 'any' || a.results[ms]?.status !== 'uncovered') continue;
      const rule = ruleFor(rules, a), cands = [];
      if (rule && rule.measurements.includes(ms)) cands.push({ source: 'rule', basis: rule.id, confidence: rule.confidence, treatment: rule.treatment, destination: rule.destination, memo: rule.memo, evidence: { rule: rule.id } });
      cands.push(...(history.get(`${a.name.trim().toLowerCase()}|${ms}`) ?? []));
      const ok = cands.map(c => viable(ctx, { s, act, activities, ret }, a, ms, c)).filter(Boolean);
      if (!ok.length) continue;
      const [first, ...rest] = ok;
      const same = c => c.treatment === first.treatment && c.destination === first.destination;
      const disagree = rest.filter(c => !same(c));
      const confidence = disagree.length ? lower(first.confidence, 'medium') : rest.reduce((x, c) => higher(x, c.confidence), first.confidence);
      const item = { returnId: ret.return_id, sourceEntityId: s.entityId, accountId: a.accountId, accountName: a.name, accountType: a.type, measurement: ms, cents: a[ms],
        version: a.results[ms].base, setFingerprint: a.results[ms].setFingerprint, ...first, confidence, alternatives: disagree, agreeing: rest.filter(same), ownerScoped: false };
      item.sure = isSure(item);
      item.decision = decisionKey(item);
      out.push(item);
    }
  }
  return out;
}

// Saving one recomputed suggestion inside the caller's transaction (which holds the locks): bound whole with its source, saved as the
// company default (the page says so), recorded in tax_binding_suggestion with its decision key. saveBindingsIn re-checks the account's name
// and type, its partition version and its binding set under the same locks.
async function acceptIn(tx, { orgId, entityId, returnId, s, canOpen, actor }) {
  const { bindingIds } = await saveBindingsIn(tx, { orgId, entityId, returnId, sourceEntityId: s.sourceEntityId, accountId: s.accountId, measurement: s.measurement, split: 'whole',
    rows: [{ treatment: s.treatment, destination: s.destination, activityId: s.activityId, memo: s.memo }], makeDefault: true, source: s.source,
    sourceDetail: { basis: s.basis, rulesVersion: s.source === 'rule' ? RULES_VERSION : null, evidence: s.evidence ?? null, decision: s.decision }, confidence: s.confidence,
    expectVersion: s.version, expectSet: s.setFingerprint ?? EMPTY_SET, expectAccount: { name: s.accountName, type: s.accountType }, canOpen, actor });
  await tx.query(`INSERT INTO tax_binding_suggestion (org_id, return_id, source_entity_id, account_id, measurement, treatment, destination, activity_id, source, basis, confidence, evidence,
      source_version, decision_key, shown_cents, status, decided_by, decided_at, binding_ids)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'accepted',$16,now(),$17)`,
  [orgId, returnId, s.sourceEntityId, s.accountId, s.measurement, s.treatment, s.destination, s.activityId, s.source, s.basis, s.confidence, s.evidence ?? {}, s.version, s.decision,
    BigInt(s.cents).toString(), actor ?? 'system', bindingIds]);
  return bindingIds;
}
// The suggestions as they stand now, read inside tx after the graph lock and the return company's lock: the activities, the defaults that
// make history and every binding write take one of those locks, so they hold still until the transaction ends. Not everything does (Codex
// t2-r1 non-blocking 4): an account rename (a ledger write, which locks only its own company) may land between the history read and the
// commit and lower what a later recomputation would say. What is accepted is still exactly the decision recomputed here under these locks
// (its key must match), so the acceptance is ordered before the rename.
async function lockedSuggestions(tx, { orgId, entityId, returnId, companyIds, canOpen }) {
  await lockTaxGraph(tx, orgId);
  await lockEntity(tx, orgId, entityId);
  const cov = await coverage(tx, { orgId, entityId, returnId, canOpen });
  if (!cov) fail('Period not found.');
  return suggestionsFor(tx, { orgId, cov, companyIds });
}
const CHANGED = 'That suggestion changed since the page was shown (the account, its figures, its mapping, the history behind it or the rules). Look at it again.';
// A person accepts one suggestion, exactly as shown (Codex r2 B7): the decision key the page showed, recomputed and compared in the
// transaction that saves it.
export async function acceptSuggestion(pool, { orgId, entityId, returnId, companyIds = [], canOpen = () => true, decision, actor }) {
  return withTransaction(pool, async tx => {
    const s = (await lockedSuggestions(tx, { orgId, entityId, returnId, companyIds, canOpen })).find(x => x.decision === decision) ?? fail(CHANGED);
    return acceptIn(tx, { orgId, entityId, returnId, s, canOpen, actor });
  });
}
// The suggestion with this decision key now, or null (read only; the page uses acceptSuggestion to save).
export async function findDecision(pool, { orgId, entityId, returnId, companyIds = [], canOpen = () => true, decision }) {
  const cov = await coverage(pool, { orgId, entityId, returnId, canOpen });
  if (!cov) fail('Period not found.');
  return (await suggestionsFor(pool, { orgId, cov, companyIds })).find(s => s.decision === decision) ?? null;
}

// "Accept all sure": the sure suggestions the page listed (shown: their decision keys), recomputed once under the locks and accepted in
// one transaction, each behind its own savepoint; one whose decision changed in any material way (a renamed account, other figures,
// another mapper's save, other history, new rules) is left for the person. → { accepted, skipped: [{ accountName, measurement, reason }], stale }
export async function acceptAllSure(pool, { orgId, entityId, returnId, companyIds = [], canOpen = () => true, shown = [], actor }) {
  const want = new Set(shown);
  return withTransaction(pool, async tx => {
    const sure = (await lockedSuggestions(tx, { orgId, entityId, returnId, companyIds, canOpen })).filter(s => s.sure && want.has(s.decision));
    let accepted = 0;
    const skipped = [];
    for (const s of sure) {
      await tx.query('SAVEPOINT accept_one');
      try { await acceptIn(tx, { orgId, entityId, returnId, s, canOpen, actor }); await tx.query('RELEASE SAVEPOINT accept_one'); accepted += 1; }
      catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT accept_one');
        if (!(error instanceof ValidationError)) throw error;
        skipped.push({ accountName: s.accountName, measurement: s.measurement, reason: error.message });
      }
    }
    return { accepted, skipped, stale: [...want].filter(k => !sure.some(s => s.decision === k)).length };
  });
}
