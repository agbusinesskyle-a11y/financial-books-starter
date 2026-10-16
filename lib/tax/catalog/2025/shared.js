// lib/tax/catalog/2025/shared.js
// Shared vocabulary of the TY2025 catalogs (spec §5.1, §6). Clean-room from the public IRS forms and instructions.

export const RETURN_TYPES = ['form_1065', 'form_1120s', 'disregarded', 'household_1040'];
export const MEASUREMENTS = ['activity', 'begin', 'end'];
export const KINDS = ['input', 'computed', 'manual', 'statement'];
export const TYPES = ['amount', 'statement', 'code', 'checkbox', 'text'];
export const CLASSES = ['income', 'deduction', 'separately_stated', 'balance', 'info'];
export const ALLOC = ['profit', 'loss', 'capital', 'none'];
// Sign-fact vocabularies (spec §5.1). semantic: what the stored amount means — a contra balance (Schedule L 9b, 1125-A line 7)
// is a positive 'reduction', never a negative. printedPolarity: how the official form and the export adapters show the stored
// amount — 'positive' as is, 'negative' negated once: the official cell is printed in parentheses and the template supplies them
// (printedValue below), so the stored positive reduction is written as its digits, never as a negative inside the parentheses. Only cells
// the TY2025 PDFs print in parentheses are 'negative' (the 2025 Form 1065 Schedule L prints its contra lines plain; the 1120-S Schedule L
// parenthesizes them). A typo here fails at catalog load, not in the engine.
export const SEMANTICS = ['positive', 'reduction'];
// Slot dimensions (spec §4.7): activity (a Schedule C/E/F activity, an 8825 property, a 1125-A activity), interest (an ownership interest),
// k1_source (a K-1 received), asset (an asset register item), code (a K-1 box code).
export const DIMENSIONS = ['activity', 'interest', 'k1_source', 'asset', 'code'];
export const PRINTED_POLARITIES = ['positive', 'negative'];
// form.schedule.line(.more): the form segment may carry an underscore (k1_1065, k1_1120s) and stays lowercase.
const ID = /^[a-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+(\.[A-Za-z0-9_{}]+)*$/;

// One catalog line. Four sign facts (spec §5.1): the side the source balance normally sits on, what the stored
// amount means, how the form uses it, how it prints. Never abs(): a contra balance is a positive reduction in a
// subtractive field, not a negative copied into it. All four are checked against their vocabularies, and an option
// key the builder does not know is refused: a misspelled key would otherwise fall through to the default and turn a
// subtractive reduction into an added positive with no error anywhere.
export function line(id, label, { type = 'amount', kind = 'input', ledgerPolarity = 'credit', semantic = 'positive', operator = 'add',
  printedPolarity = 'positive', cls = 'income', allocBasis = 'none', formula = null, requires = [], taxact = null, instanceDims = [], codes = null,
  sourceDims = [], sourceRequired = false, aggregates = [], ...rest } = {}) {
  if (!ID.test(id)) throw new Error(`id must look like form.schedule.line: ${id}`);
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`${id}: unknown option(s) ${unknown.join(', ')}`);
  for (const [v, set, what] of [[type, TYPES, 'type'], [kind, KINDS, 'kind'], [cls, CLASSES, 'cls'], [allocBasis, ALLOC, 'allocBasis'],
    [ledgerPolarity, ['debit', 'credit', 'either'], 'ledgerPolarity'], [semantic, SEMANTICS, 'semantic'], [operator, ['add', 'subtract', 'none'], 'operator'],
    [printedPolarity, PRINTED_POLARITIES, 'printedPolarity']]) {
    if (!set.includes(v)) throw new Error(`${id}: ${what} ${v} is not one of ${set.join(', ')}`);
  }
  // Dimensions (spec §4.7, Codex t1-r1 B2). instanceDims are REQUIRED: they name the instance of the line (an activity's Schedule C, a property's
  // 8825 column, an interest's K-1 box, a code of a coded box) and every slot key carries them; a computed line's instanceDims are the
  // dimensions its formula PRESERVES (one result per instance). sourceDims are ALLOWED member dimensions: a collection's members differ only
  // by them (a K-1 source, an asset) and sum into the collection once; a member names at most one, and none for the line's own books or
  // manual amount unless sourceRequired (a line that exists only for K-1 amounts). aggregates are the dimensions a formula sums away (8825
  // line 20a over properties, page 1 line 22 over the per-partner guaranteed payments).
  for (const d of [...instanceDims, ...sourceDims, ...aggregates]) if (!DIMENSIONS.includes(d)) throw new Error(`${id}: unknown dimension ${d} (known: ${DIMENSIONS.join(', ')})`);
  for (const d of sourceDims) if (instanceDims.includes(d)) throw new Error(`${id}: dimension ${d} is both required and a source dimension`);
  if (sourceRequired && !sourceDims.length) throw new Error(`${id}: sourceRequired needs a source dimension`);
  if (aggregates.length && kind !== 'computed') throw new Error(`${id}: only a computed line aggregates dimensions`);
  if (kind === 'computed' && sourceDims.length) throw new Error(`${id}: a computed line has no members, so no source dimensions`);
  // A coded box (type 'code') names the codes it accepts as an explicit list, never a range string ('A-G' hides reserved codes).
  if (type === 'code' && !(Array.isArray(codes) && codes.length && codes.every(x => /^[A-Z]{1,2}$/.test(x)))) throw new Error(`${id}: a coded line lists its codes explicitly`);
  if (type !== 'code' && codes !== null) throw new Error(`${id}: only a coded line takes codes`);
  if (type === 'code' && !instanceDims.includes('code')) throw new Error(`${id}: a coded line keeps one instance per code (instanceDims include code)`);
  return { id, label, type, kind, ledgerPolarity, semantic, operator, printedPolarity, cls, allocBasis, formula, requires, taxact, instanceDims, codes, sourceDims, sourceRequired, aggregates };
}
// How a stored semantic amount prints (spec §5.1). printedCents is the value the form shows: negated once for a 'negative' line. A
// parenthesized cell's template supplies the parentheses, so the cell carries the stored digits (500 prints as "(500)", never "(-500)");
// a reversed balance there (a stored negative) cannot be written without a second negation, so it is flagged for review and its cell is
// left empty, never made positive. A plain cell prints the stored amount as it is.
export function printedValue(l, cents) {
  const v = typeof cents === 'bigint' ? cents : typeof cents === 'string' && /^-?\d+$/.test(cents) ? BigInt(cents)
    : Number.isSafeInteger(cents) ? BigInt(cents) : (() => { throw new Error(`${l.id}: printedValue takes whole cents (bigint, safe integer or digit string)`); })();
  if (l.printedPolarity === 'negative') return { printedCents: -v, cell: v >= 0n ? v.toString() : null, templateParens: true, reversed: v < 0n };
  return { printedCents: v, cell: v.toString(), templateParens: false, reversed: false };
}

// Lower-tier pass-through (spec §4.9): a K-1 received by a partnership or S corporation reports its separately stated items on the recipient's
// own Schedule K lines, as members keyed by the K-1 next to the books amount. Every Schedule K amount line that is not computed, not an info
// answer and not per owner (interest) takes k1_source as an allowed source dimension.
export const withK1Members = lines => lines.map(l => (l.kind === 'computed' || l.cls === 'info' || l.instanceDims.includes('interest') || l.sourceDims.includes('k1_source'))
  ? l : { ...l, sourceDims: [...l.sourceDims, 'k1_source'] });

// Shorthands used by every form file.
export const income = (id, label, o = {}) => line(id, label, { cls: 'income', ledgerPolarity: 'credit', allocBasis: 'profit', ...o });
export const deduction = (id, label, o = {}) => line(id, label, { cls: 'deduction', ledgerPolarity: 'debit', allocBasis: 'loss', ...o });
export const contra = (id, label, o = {}) => line(id, label, { cls: 'balance', ledgerPolarity: 'credit', semantic: 'reduction', operator: 'subtract', ...o });
export const asset = (id, label, o = {}) => line(id, label, { cls: 'balance', ledgerPolarity: 'debit', ...o });
export const liability = (id, label, o = {}) => line(id, label, { cls: 'balance', ledgerPolarity: 'credit', ...o });
export const stated = (id, label, o = {}) => line(id, label, { cls: 'separately_stated', ledgerPolarity: 'either', ...o });
export const info = (id, label, o = {}) => line(id, label, { cls: 'info', type: 'text', kind: 'input', ledgerPolarity: 'either', operator: 'none', ...o });
export const computed = (id, label, formula, o = {}) => line(id, label, { kind: 'computed', formula, ledgerPolarity: 'either', ...o });
// A "attach statement" line: the engine keeps one named row per source behind it.
export const statement = (id, label, o = {}) => line(id, label, { kind: 'statement', type: 'statement', ...o });
// Formulas are small arrays the engine evaluates in dependency order: ['sum', ...ids], ['minus', a, b], ['sumMinus', [adds], [subs]].
export const sum = (...ids) => ['sum', ...ids];
export const minus = (a, b) => ['minus', a, b];
export const sumMinus = (adds, subs) => ['sumMinus', adds, subs];

// Deadline rules (spec §10): due dates roll forward over weekends and federal holidays (holidays typed per year). Every key a
// caller may ask about is listed, so an unknown key is an error and never an empty answer: a disregarded company files nothing
// of its own (the owner's return carries its due dates), which is an intentional empty list, not a fallthrough.
export const DEADLINES = {
  form_1065: [{ key: 'return', label: 'Form 1065 due', month: 3, day: 15, afterPeriodEnd: true }, { key: 'extension', label: 'Extended 1065 due', month: 9, day: 15, afterPeriodEnd: true }],
  form_1120s: [{ key: 'return', label: 'Form 1120-S due', month: 3, day: 15, afterPeriodEnd: true }, { key: 'extension', label: 'Extended 1120-S due', month: 9, day: 15, afterPeriodEnd: true }],
  household_1040: [{ key: 'return', label: 'Form 1040 due', month: 4, day: 15, afterPeriodEnd: true }, { key: 'extension', label: 'Extended 1040 due', month: 10, day: 15, afterPeriodEnd: true },
    { key: 'es1', label: 'Estimated payment 1', month: 4, day: 15, afterPeriodEnd: false }, { key: 'es2', label: 'Estimated payment 2', month: 6, day: 15, afterPeriodEnd: false },
    { key: 'es3', label: 'Estimated payment 3', month: 9, day: 15, afterPeriodEnd: false }, { key: 'es4', label: 'Estimated payment 4', month: 1, day: 15, afterPeriodEnd: true }],
  disregarded: [],
  information_returns: [{ key: 'w2_1099nec', label: 'W-2s and 1099-NEC due', month: 1, day: 31, afterPeriodEnd: true }],
};
// The April 16 entries are DC Emancipation Day: a legal holiday in the District of Columbia, which the IRS observes for
// nationwide due dates (it moves an April 15 deadline when the 15th falls on it or on the weekend before it). Keep them.
export const FEDERAL_HOLIDAYS_2025 = ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-16', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25'];
export const FEDERAL_HOLIDAYS_2026 = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'];
export const FEDERAL_HOLIDAYS_2027 = ['2027-01-01', '2027-01-18', '2027-02-15', '2027-04-16', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24'];
export const FEDERAL_HOLIDAYS = [...FEDERAL_HOLIDAYS_2025, ...FEDERAL_HOLIDAYS_2026, ...FEDERAL_HOLIDAYS_2027];
// The years a holiday table covers, read from the table itself: every year has at least New Year's Day, so a year with no
// entry has no table.
const holidayYears = holidays => new Set(holidays.map(h => Number(h.slice(0, 4))));
// Roll a due date forward over Saturday, Sunday and listed holidays. Every day examined must fall in a year the table covers:
// a date in an uncovered year would roll over weekends only and silently skip a holiday (April 15, 2029 is a Sunday and the
// 16th is Emancipation Day; without a 2029 table the roll would stop on the 16th). Refusing is the §4.3 rule: a year this
// edition does not know computes nothing, never a fallback.
export function rollForward(iso, holidays = FEDERAL_HOLIDAYS) {
  const years = holidayYears(holidays);
  let d = new Date(`${iso}T00:00:00Z`);
  for (;;) {
    const year = d.getUTCFullYear();
    if (!years.has(year)) throw new Error(`no federal holiday table for ${year} (rolling ${iso} forward); the tables cover ${[...years].sort().join(', ')}`);
    const s = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.includes(s)) return s;
    d = new Date(d.getTime() + 86_400_000);
  }
}
// Due dates for a period (spec §10): rules in DEADLINES, rolled forward (spec: weekend/holiday roll-forward). A key DEADLINES
// does not list is an error, not an empty list (an empty list reads as "nothing due").
export function deadlineDates(returnType, { periodStart, periodEnd }, holidays = FEDERAL_HOLIDAYS) {
  const rules = DEADLINES[returnType];
  if (!rules) throw new Error(`no deadline rules for ${returnType} (known: ${Object.keys(DEADLINES).join(', ')})`);
  const endYear = Number(periodEnd.slice(0, 4)), startYear = Number(periodStart.slice(0, 4));
  return rules.map(r => {
    const year = r.afterPeriodEnd ? endYear + 1 : startYear;
    const iso = `${year}-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`;
    return { key: r.key, label: r.label, due: rollForward(iso, holidays) };
  });
}

// TY2025 household constants used by the (later) estimate; kept here so the edition folder owns its year's numbers.
export const STANDARD_DEDUCTION_2025 = { single: 15_750_00, mfj: 31_500_00, mfs: 15_750_00, hoh: 23_625_00 };
export const BRACKETS_2025_MFJ = [[0, 10], [23_850_00, 12], [96_950_00, 22], [206_700_00, 24], [394_600_00, 32], [501_050_00, 35], [751_600_00, 37]]; // [floor cents, rate %]
export const ES_SAFE_HARBOR = { currentYearPct: 90, priorYearPct: 100, priorYearHighAgiPct: 110, highAgiThreshold: { mfj: 150_000_00, single: 150_000_00, mfs: 75_000_00, hoh: 150_000_00 }, minimumOwed: 1_000_00 };

// How a refused fact reads in the error: a string in quotes, so 'false' and '' are told apart from false, 0 and a missing fact.
const shown = v => (typeof v === 'string' ? JSON.stringify(v) : String(v));

// A fact the sources cannot supply yet is said to be unknown with the literal 'unknown' (spec §0 rule 2: missing is never zero). It is a
// value, not an absence: an omitted, null or misspelled fact is still a caller error, so a forgotten fact never reads as unknown either.
export const UNKNOWN = 'unknown';

// A cents fact a threshold test reads must be present and integral: a bigint, a safe integer, or a digit string (cents are strings in JSON
// envelopes), or 'unknown'. Anything else is refused rather than coerced: null < 25000000 is true, '' coerces to 0 and undefined >= 50000000
// is false, so a missing fact would read as zero and grant the Schedule B relief or drop Form 1125-E with no error anywhere. Every fact read
// here is a gross total (receipts, total assets, officer compensation), so a negative value is a sign error upstream, never a fact.
function centsFact(facts, name, returnType) {
  const v = facts[name];
  if (v === UNKNOWN) return UNKNOWN;
  if (typeof v === 'bigint' && v >= 0n) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  const negative = (typeof v === 'bigint' && v < 0n) || (typeof v === 'number' && Number.isSafeInteger(v) && v < 0) || (typeof v === 'string' && /^-\d+$/.test(v));
  if (negative) throw new Error(`applicability ${returnType}: ${name} must be whole non-negative cents (a bigint, a safe integer or a digit string), got ${shown(v)}; a gross total is never negative`);
  throw new Error(`applicability ${returnType}: ${name} must be whole cents (a bigint, a safe integer or a digit string), got ${shown(v)}; missing is never zero`);
}

// A yes/no fact that decides whether a schedule is required must be present and a boolean, or 'unknown'. Truthiness read an absent flag as "no"
// and the string 'false' as "yes": a caller that omitted one dropped Form 1125-A, Form 8825 or a 1040 schedule with no error anywhere.
function boolFact(facts, name, returnType) {
  const v = facts[name];
  if (typeof v === 'boolean' || v === UNKNOWN) return v;
  throw new Error(`applicability ${returnType}: ${name} must be true or false, got ${shown(v)}; missing is never false`);
}

// A count answer (number of Forms 8858 attached, of foreign partners): a non-negative safe integer, or 'unknown'.
function countFact(facts, name, returnType) {
  const v = facts[name];
  if (v === UNKNOWN || (Number.isSafeInteger(v) && v >= 0)) return v;
  throw new Error(`applicability ${returnType}: ${name} must be a whole count, got ${shown(v)}; missing is never zero`);
}

// A line-amount fact ('amount:<catalog line id>', Codex t1-r2 B4): does the return report an amount on that line (any instance or member)?
// Signed whole cents (a bigint, a safe integer or a digit string; a loss is an amount too), or a boolean when only "has an amount" is known,
// or 'unknown'. Nonzero is true. Anything else is refused: '12.50' or null would otherwise read as no amount and drop the attachment.
function amountFact(facts, name, returnType) {
  const v = facts[name];
  if (v === UNKNOWN || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v !== 0;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v) !== 0n;
  throw new Error(`applicability ${returnType}: ${name} must be whole cents (a bigint, a safe integer or a digit string) or true/false, got ${shown(v)}; missing is never zero`);
}
export const AMOUNT_PREFIX = 'amount:';

// Conditions (spec §6: applicability and filing-manifest rules are declarative). Three-valued: true, false or 'unknown'; a known false decides
// an 'all' and a known true decides an 'any' even when another part is unknown, otherwise unknown propagates and the rule stays unresolved.
//   'always'                      { fact: name }  boolean fact is true      { yes: key } / { no: key }  a yes/no answer
//   { not: c }  { all: [..] }  { any: [..] }   { lt | gte | gt: [name, n] }  a cents fact or a count answer against a threshold
//   { amount: lineId }            the return reports an amount on that catalog line (the fact 'amount:<lineId>', see amountFact)
export const ALWAYS = 'always';
export const FACT_TYPES = {
  receiptsCents: 'cents', assetsEndCents: 'cents', officerCompCents: 'cents',
  k1sFiledAndFurnishedTimely: 'bool', filesOrMustFileScheduleM3: 'bool', deductsCogs: 'bool', hasRental: 'bool', has8825OtherDeductions: 'bool',
  claimsDepreciationOrAmortization: 'bool', hasBusinessPropertyDispositions: 'bool', hasCapitalGainsOrLosses: 'bool', k2k3Required: 'bool',
  paidPreparer: 'bool', prIsEntity: 'bool', making754ElectionThisYear: 'bool', has704cProperty: 'bool', hasSpecialAllocations: 'bool',
  ownershipChangedInPeriod: 'bool', hasSecondClassOfStock: 'bool', hasNetUnrealizedBuiltInGain: 'bool',
  hasScheduleC: 'bool', hasK1s: 'bool', hasFarm: 'bool', hasSpouse: 'bool',
};
const and3 = vs => (vs.includes(false) ? false : vs.includes(UNKNOWN) ? UNKNOWN : true);
const or3 = vs => (vs.includes(true) ? true : vs.includes(UNKNOWN) ? UNKNOWN : false);
const not3 = v => (v === UNKNOWN ? UNKNOWN : !v);
// answers: { key: 'yesno' | 'count' | ... } for the questions a condition may name. Facts named by a condition are read with the typed readers.
export function evaluate(cond, facts, returnType, answers = {}, choices = {}) {
  const read = name => {
    const t = FACT_TYPES[name] ?? (answers[name] === 'yesno' ? 'bool' : answers[name] === 'count' ? 'count' : null);
    if (!t) throw new Error(`condition names unknown fact ${name}`);
    if (facts[name] === undefined && answers[name]) return UNKNOWN; // an unanswered question is unknown, not an error
    return t === 'cents' ? centsFact(facts, name, returnType) : t === 'count' ? countFact(facts, name, returnType) : boolFact(facts, name, returnType);
  };
  const cmp = (op, [name, n]) => { const v = read(name); if (v === UNKNOWN) return UNKNOWN; const x = BigInt(v), y = BigInt(n); return op === 'lt' ? x < y : op === 'gte' ? x >= y : x > y; };
  if (cond === ALWAYS) return true;
  if ('all' in cond) return and3(cond.all.map(c => evaluate(c, facts, returnType, answers, choices)));
  if ('any' in cond) return or3(cond.any.map(c => evaluate(c, facts, returnType, answers, choices)));
  if ('not' in cond) return not3(evaluate(cond.not, facts, returnType, answers, choices));
  if ('fact' in cond) { const v = read(cond.fact); return v === UNKNOWN ? UNKNOWN : v === true; }
  if ('yes' in cond) { const v = read(cond.yes); return v === UNKNOWN ? UNKNOWN : v === true; }
  if ('no' in cond) { const v = read(cond.no); return v === UNKNOWN ? UNKNOWN : v === false; }
  // { is: [question, choice] }: a choice question's answer is that choice (Codex t1-r3 N5: Schedule B line 1 "Other" needs its detail).
  if ('is' in cond) {
    const [name, choice] = cond.is;
    if (answers[name] !== 'choice' || !Array.isArray(choices[name])) throw new Error(`condition ${name} is not a choice question with declared choices`);
    const v = facts[name];
    if (v === undefined || v === UNKNOWN) return UNKNOWN;
    // An answer outside the declared choices is refused, never read as "not this choice" (Codex t1-r4 N6): a misencoded answer would
    // otherwise settle every rule that depends on it as not applying.
    if (typeof v !== 'string' || !choices[name].includes(v)) throw new Error(`applicability ${returnType}: ${name} must be one of ${choices[name].join(', ')} or 'unknown', got ${JSON.stringify(v)}`);
    return v === choice;
  }
  if ('amount' in cond) {
    const name = AMOUNT_PREFIX + cond.amount;
    if (facts[name] === undefined) throw new Error(`applicability ${returnType}: ${name} is missing; missing is never zero (pass 'unknown')`);
    return amountFact(facts, name, returnType);
  }
  for (const op of ['lt', 'gte', 'gt']) if (op in cond) return cmp(op, cond[op]);
  throw new Error(`unknown condition ${JSON.stringify(cond)}`);
}
// The facts and answers a condition reads (for validation and for naming what an unresolved rule waits on).
// The { is: [question, choice] } conditions inside a condition, for validating the choice against the question's declared choices.
export function choiceConditions(cond) {
  if (cond === ALWAYS) return [];
  for (const k of ['all', 'any']) if (k in cond) return cond[k].flatMap(choiceConditions);
  if ('not' in cond) return choiceConditions(cond.not);
  return 'is' in cond ? [cond.is] : [];
}
export function conditionNames(cond) {
  if (cond === ALWAYS) return [];
  if ('all' in cond) return cond.all.flatMap(conditionNames);
  if ('any' in cond) return cond.any.flatMap(conditionNames);
  if ('not' in cond) return conditionNames(cond.not);
  for (const k of ['fact', 'yes', 'no']) if (k in cond) return [cond[k]];
  if ('is' in cond) return [cond.is[0]];
  if ('amount' in cond) return [AMOUNT_PREFIX + cond.amount];
  for (const k of ['lt', 'gte', 'gt']) if (k in cond) return [cond[k][0]];
  throw new Error(`unknown condition ${JSON.stringify(cond)}`);
}

// 2025 Form 1065, Schedule B line 4: all four conditions, or Schedules L, M-1 and M-2 (and page 1 item F, K-1 item L) are required.
export const RELIEF_1065 = { all: [{ lt: ['receiptsCents', 250_000_00] }, { lt: ['assetsEndCents', 1_000_000_00] }, { fact: 'k1sFiledAndFurnishedTimely' }, { not: { fact: 'filesOrMustFileScheduleM3' } }] };
// 2025 Form 1120-S, Schedule B line 11: both conditions, or Schedules L and M-1 are required (M-2 is always required).
export const RELIEF_1120S = { all: [{ lt: ['receiptsCents', 250_000_00] }, { lt: ['assetsEndCents', 250_000_00] }] };
// Form 1125-A is attached when the return reports a deduction for cost of goods sold (Form 1125-A, Rev. November 2024), not merely when there is inventory.
export const COGS = { fact: 'deductsCogs' };
// Form 1125-E: officer compensation deducted with total receipts of $500,000 or more (2025 Form 1120-S, line 7).
export const OFFICER_COMP_1125E = { all: [{ gt: ['officerCompCents', 0] }, { gte: ['receiptsCents', 500_000_00] }] };

// Applicability (spec §6): which schedules a return of this type needs, from a few facts about the period. The facts are required (no default:
// an absent facts object is a missing fact, not "no relief") and the return type must be known. Every fact is read by type, so an omitted or
// misspelled fact is an error; a fact the caller marks 'unknown' leaves the schedules it decides in `unresolved` (with the facts it waits on),
// never optional and never silently required.
export function applicabilityRules(returnType, facts) {
  if (!RETURN_TYPES.includes(returnType)) throw new Error(`unknown return type ${returnType}`);
  if (facts === null || typeof facts !== 'object') throw new Error(`applicability ${returnType}: facts are required; missing is never zero`);
  const req = new Set(), opt = new Set(), unresolved = [];
  // Every fact a return type reads is read up front, so a missing one throws even when an earlier condition already decided the rule.
  const need = names => names.forEach(n => (FACT_TYPES[n] === 'cents' ? centsFact : boolFact)(facts, n, returnType));
  const rule = (cond, schedules, { whenFalse = null } = {}) => {
    const v = evaluate(cond, facts, returnType);
    for (const s of schedules) {
      if (v === true) req.add(s);
      else if (v === UNKNOWN) unresolved.push({ schedule: s, reason: `waits on ${waitsOn(cond, facts)}` });
      else if (whenFalse) whenFalse.add(s);
    }
  };
  if (returnType === 'form_1065') {
    need(['receiptsCents', 'assetsEndCents', 'k1sFiledAndFurnishedTimely', 'filesOrMustFileScheduleM3', 'deductsCogs', 'hasRental']);
    for (const s of ['p1', 'schB', 'schK', 'k1', 'analysis']) req.add(s);
    rule({ not: RELIEF_1065 }, ['schL', 'm1', 'm2'], { whenFalse: opt });
    rule(COGS, ['f1125a']);
    rule({ fact: 'hasRental' }, ['f8825']);
  } else if (returnType === 'form_1120s') {
    need(['receiptsCents', 'assetsEndCents', 'officerCompCents', 'deductsCogs', 'hasRental']);
    for (const s of ['p1', 'schB', 'schK', 'k1', 'm2']) req.add(s);
    rule({ not: RELIEF_1120S }, ['schL', 'm1'], { whenFalse: opt });
    rule(COGS, ['f1125a']);
    rule({ fact: 'hasRental' }, ['f8825']);
    rule(OFFICER_COMP_1125E, ['f1125e']);
  } else if (returnType === 'household_1040') {
    need(['hasScheduleC', 'hasRental', 'hasK1s', 'hasFarm']);
    req.add('f1040');
    rule({ fact: 'hasScheduleC' }, ['schC']);
    rule({ fact: 'hasRental' }, ['schE1']);
    rule({ fact: 'hasK1s' }, ['schE2']);
    rule({ fact: 'hasFarm' }, ['schF']);
  } else if (returnType === 'disregarded') {
    req.add('owner_return');
  } else {
    throw new Error(`no applicability rules for ${returnType}`); // a type added to RETURN_TYPES without rules stops here
  }
  return { required: [...req], optional: [...opt], unresolved };
}
// The facts a condition is still waiting on, by name.
export function waitsOn(cond, facts, answers = {}) {
  return [...new Set(conditionNames(cond).filter(n => facts[n] === UNKNOWN || (facts[n] === undefined && answers[n])))].join(', ');
}
