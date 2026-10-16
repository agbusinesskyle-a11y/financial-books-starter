// lib/tax/catalog/2025/manifest.js — TY2025 filing-manifest RULES (spec §6, §9.1). Clean-room from the 2025 Forms 1065 and 1120-S and their
// instructions. Each entry is a declarative rule: what it is (kind), who fills it (source), when it applies (a condition over typed period facts
// and the return's own yes/no or count answers, see shared.js evaluate), and whether Tax Books supports it ('unsupported' entries name forms,
// statements and elections outside v1 scope, spec §2: when one applies the filing is blocked with that reason, never silently complete).
// This file holds the rules only. The completeness VALIDATOR (are the required answers given and reviewed) is T4; rendering and export are T5.
// The household list is a preparation checklist until T8 adds the household manifest; it is not a complete 1040 manifest.
import { ALWAYS, RELIEF_1065, RELIEF_1120S, COGS, OFFICER_COMP_1125E, FACT_TYPES, conditionNames, choiceConditions, evaluate, UNKNOWN, waitsOn, AMOUNT_PREFIX } from './shared.js';

export const ENTRY_KINDS = ['question', 'form', 'statement', 'election', 'signature', 'item'];
export const ANSWER_TYPES = ['yesno', 'count', 'text', 'choice', 'date', 'amount'];
// A rule applies to the return as a whole, or once per owner (Codex t1-r2 B4): each Schedule K-1 item is answered per partner or shareholder
// (ownership interest), so a condition on one owner's answer (H2: "the partner is a disregarded entity") decides that owner's requirement only.
export const SCOPES = ['return', 'owner'];

// Builders. A question carries its answer type, so a condition may read it ({ yes: key } on a yes/no answer, { gt: [key, 0] } on a count).
const rule = (kind, key, label, { source = 'person', when = ALWAYS, status = 'supported', answer = null, note = null, scope = 'return', choices = null } = {}) =>
  ({ key, label, kind, source, when, status, answer, note, scope, ...(choices ? { choices } : {}) });
const q = (key, label, answer = 'yesno', o = {}) => rule('question', key, label, { answer, ...o });
const form = (key, label, o = {}) => rule('form', key, label, { source: 'engine', ...o });
const unsupported = (key, label, when, note, o = {}) => rule('form', key, label, { source: 'engine', when, status: 'unsupported', note, ...o });
const yes = key => ({ yes: key }), no = key => ({ no: key }), fact = name => ({ fact: name }), is = (key, choice) => ({ is: [key, choice] });
// { amount: line }: the return reports an amount on that catalog line (the fact 'amount:<line>'), for attachments the line's form text calls for.
const amount = line => ({ amount: line }), anyAmount = (...lines) => lines.map(amount);
const OWNER = { scope: 'owner' };
const NOT_RELIEF_1065 = { not: RELIEF_1065 };
// Supported attachments Tax Books has no generator for: a reviewed completed attachment satisfies them (spec §13.1 T5), never a typed total.
const ATTACHED = 'reviewed completed attachment (spec §13.1 T5): Tax Books does not generate this form';

// Shared by both business returns, with each return's own line ids. Forms 4562 and 4797 and Schedule A (Form 8825) follow the lines that report
// them as well as their facts, so a typed amount with the fact still false (or never set) cannot drop the attachment.
const commonForms = L => [
  form('form.1125a', 'Form 1125-A, Cost of Goods Sold', { when: COGS }),
  form('form.8825', 'Form 8825, Rental Real Estate Income and Expenses', { when: fact('hasRental') }),
  form('form.8825_sch_a', 'Schedule A (Form 8825), Other Deductions (line 17)', { when: { all: [fact('hasRental'), { any: [fact('has8825OtherDeductions'), amount('f8825.main.17')] }] } }),
  // Form 4562 is produced by the asset register (T7); until then a reviewed completed attachment satisfies it (spec §13.1 T5), never a typed total.
  form('form.4562', 'Form 4562, Depreciation and Amortization', { when: { any: [fact('claimsDepreciationOrAmortization'), ...anyAmount(...L.depreciation)] }, note: 'reviewed completed attachment until T7' }),
  form('form.4797', 'Form 4797, Sales of Business Property', { when: { any: [fact('hasBusinessPropertyDispositions'), ...anyAmount(...L.dispositions)] } }),
  // Page 1 "Energy efficient commercial buildings deduction (attach Form 7205)" (2025 Form 1065 line 20, Form 1120-S line 19).
  form('form.7205', 'Form 7205, Energy Efficient Commercial Buildings Deduction', { when: amount(L.f7205), note: ATTACHED }),
  // The Schedule K credit lines rest on the credit's own source forms (for example Forms 8609-A, 3468, 6478), which Tax Books neither computes nor produces.
  unsupported('form.credit_forms', 'Source forms for the Schedule K credits', { any: anyAmount(...L.credits) }, 'credit computations and their forms are outside v1 scope'),
  rule('statement', 'stmt.catalog_lines', 'An attached statement for every statement-kind catalog line with an amount (one named row per source)', { source: 'engine' }),
  unsupported('form.m3', 'Schedule M-3 (filing or required)', fact('filesOrMustFileScheduleM3'), 'Schedule M-3 is outside v1 scope (spec §2)'),
  unsupported('form.k2_k3', 'Schedules K-2 and K-3 (the domestic filing exception is not met)', fact('k2k3Required'), 'K-2/K-3 beyond the exemption box are outside v1 scope (spec §2)'),
  unsupported('blocked.ownership_change', 'Ownership change inside the period', fact('ownershipChangedInPeriod'), 'ownership changes inside a period are blocked (spec §2)'),
  rule('signature', 'sign.irs_discuss', 'May the IRS discuss this return with the preparer?', { answer: 'yesno' }),
  rule('signature', 'sign.date', 'Signature date', { answer: 'date' }),
  rule('signature', 'sign.preparer', 'Paid preparer block', { when: fact('paidPreparer') }),
];
const LINES_1065 = { depreciation: ['f1065.p1.16a', 'f1065.k.12', 'f8825.main.14'], dispositions: ['f1065.p1.6', 'f1065.k.10', 'f8825.main.21'], f7205: 'f1065.p1.20',
  credits: ['a', 'b', 'c', 'd', 'e', 'f'].map(x => `f1065.k.15${x}`) };
const LINES_1120S = { depreciation: ['f1120s.p1.14', 'f1120s.k.11', 'f8825.main.14'], dispositions: ['f1120s.p1.4', 'f1120s.k.9', 'f8825.main.21'], f7205: 'f1120s.p1.19',
  credits: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(x => `f1120s.k.13${x}`) };

const F1065 = [
  // Page 1 header items.
  q('p1.item_a_activity', 'Item A: principal business activity', 'text'), q('p1.item_b_product', 'Item B: principal product or service', 'text'),
  q('p1.item_c_code', 'Item C: business code number', 'text'), q('p1.item_e_date_started', 'Item E: date business started', 'date', { source: 'engine' }),
  q('p1.item_f_total_assets', 'Item F: total assets', 'amount', { source: 'engine', when: NOT_RELIEF_1065 }),
  q('p1.item_g_return_kind', 'Item G: initial, final, name change, address change or amended return', 'choice'),
  q('p1.item_h_method', 'Item H: accounting method', 'choice', { source: 'engine' }), q('p1.item_i_k1_count', 'Item I: number of Schedules K-1', 'count', { source: 'engine' }),
  q('p1.item_j_sch_c_m3', 'Item J: Schedules C and M-3 attached', 'yesno', { source: 'engine' }),
  q('p1.item_k_aggregation', 'Item K: activities aggregated for section 465 or grouped for section 469', 'choice'),
  // Schedule B, every question the 2025 form prints (10e, 13b and 31 are reserved for future use).
  // Line 1 boxes a-f as printed on the 2025 form; f "Other" carries its own description (Codex t1-r3 N5). A foreign partnership is outside v1.
  q('schB.q1_entity_type', 'Schedule B line 1: type of entity', 'choice', { choices: [['a', 'Domestic general partnership'], ['b', 'Domestic limited partnership'],
    ['c', 'Domestic limited liability company'], ['d', 'Domestic limited liability partnership'], ['e', 'Foreign partnership'], ['f', 'Other']] }),
  q('schB.q1_other', 'Schedule B line 1f: the Other type of entity, described', 'text', { when: is('schB.q1_entity_type', 'f') }),
  unsupported('blocked.foreign_partnership', 'Foreign partnership (Schedule B line 1e)', is('schB.q1_entity_type', 'e'), 'foreign partnerships are outside v1 scope (spec §2)'),
  // Page 1 "Tax and Payment", lines 24-32a (2025 Form 1065; Codex t1-r3 N4). Each source of a balance due or payment is a yes/no question;
  // a yes is outside v1 and blocks Final with its reason. Line 30 is its own input (Codex t1-r4 N4): a payment or prepayment toward lines
  // 24-27 can exist even when no tax ends up due, so it has its own question. Lines 28-32a (total balance due, payment, amount owed,
  // overpayment) apply when any of the six is yes; with all six no the section is empty; an unanswered question leaves it unresolved.
  q('tax.q24_lookback_8697', 'Page 1 line 24: interest due under the look-back method, completed long-term contracts (Form 8697)'),
  unsupported('tax.p1_24_form_8697', 'Page 1 line 24 and Form 8697', yes('tax.q24_lookback_8697'), 'look-back interest is outside v1 scope'),
  q('tax.q25_lookback_8866', 'Page 1 line 25: interest due under the look-back method, income forecast method (Form 8866)'),
  unsupported('tax.p1_25_form_8866', 'Page 1 line 25 and Form 8866', yes('tax.q25_lookback_8866'), 'look-back interest is outside v1 scope'),
  q('tax.q26_bba_aar', 'Page 1 line 26: BBA administrative adjustment request with an imputed underpayment'),
  unsupported('tax.p1_26_imputed_underpayment', 'Page 1 line 26: BBA AAR imputed underpayment', yes('tax.q26_bba_aar'), 'BBA adjustment requests are outside v1 scope'),
  q('tax.q27_other_taxes', 'Page 1 line 27: other taxes (see instructions)'),
  unsupported('tax.p1_27_other_taxes', 'Page 1 line 27: other taxes', yes('tax.q27_other_taxes'), 'partnership-level other taxes are outside v1 scope'),
  q('tax.q29_elective_payment', 'Page 1 line 29: elective payment election amount from Form 3800'),
  unsupported('tax.p1_29_elective_payment', 'Page 1 line 29 and Form 3800 elective payment', yes('tax.q29_elective_payment'), 'credit elective payments are outside v1 scope'),
  q('tax.q30_payment', 'Page 1 line 30: the partnership made a payment or prepayment toward lines 24-27 for this year (see instructions)'),
  unsupported('tax.p1_30_payment', 'Page 1 line 30: payment', yes('tax.q30_payment'), 'partnership-level payments and refunds are outside v1 scope'),
  unsupported('tax.p1_28_32a', 'Page 1 lines 28-32a: total balance due, payment, amount owed or overpayment',
    { any: ['tax.q24_lookback_8697', 'tax.q25_lookback_8866', 'tax.q26_bba_aar', 'tax.q27_other_taxes', 'tax.q29_elective_payment', 'tax.q30_payment'].map(yes) }, 'a partnership balance due or payment is outside v1 scope'),
  q('schB.q2a_entity_owner_50', 'Schedule B line 2a: an entity, trust, tax-exempt organization or foreign government owns 50% or more'),
  q('schB.q2b_individual_owner_50', 'Schedule B line 2b: an individual or estate owns 50% or more'),
  q('schB.q3a_owns_corporation', 'Schedule B line 3a: owns 20% directly or 50% of the voting stock of a corporation'),
  rule('statement', 'schB.q3a_detail', 'Schedule B line 3a (i)-(iv): each corporation', { when: yes('schB.q3a_owns_corporation') }),
  q('schB.q3b_owns_partnership', 'Schedule B line 3b: owns 20% directly or 50% of a partnership or the beneficial interest of a trust'),
  rule('statement', 'schB.q3b_detail', 'Schedule B line 3b (i)-(v): each partnership or trust', { when: yes('schB.q3b_owns_partnership') }),
  q('schB.q4_small_partnership', 'Schedule B line 4: all four conditions (receipts, assets, K-1s timely, no Schedule M-3)', 'yesno', { source: 'engine' }),
  q('schB.q5_ptp', 'Schedule B line 5: publicly traded partnership'),
  q('schB.q6_debt_canceled', 'Schedule B line 6: debt canceled, forgiven or modified to reduce principal'),
  q('schB.q7_form_8918', 'Schedule B line 7: Form 8918 filed or required'),
  q('schB.q8_foreign_account', 'Schedule B line 8: interest in or authority over a foreign financial account'),
  q('schB.q8_country', 'Schedule B line 8: name of the foreign country', 'text', { when: yes('schB.q8_foreign_account') }),
  q('schB.q9_foreign_trust', 'Schedule B line 9: distribution from, grantor of, or transferor to a foreign trust'),
  q('schB.q10a_754', 'Schedule B line 10a: section 754 election made or in effect'),
  q('schB.q10a_754_date', 'Schedule B line 10a: effective date of the section 754 election', 'date', { when: yes('schB.q10a_754') }),
  q('schB.q10b_743b', 'Schedule B line 10b: optional basis adjustment under section 743(b) this year'),
  q('schB.q10c_734b', 'Schedule B line 10c: optional basis adjustment under section 734(b) this year'),
  q('schB.q10d_mandatory_adjustment', 'Schedule B line 10d: required adjustment for a substantial built-in loss or basis reduction'),
  q('schB.q11_like_kind', 'Schedule B line 11: property received in a like-kind exchange distributed or contributed'),
  q('schB.q12_tic_distribution', 'Schedule B line 12: tenancy-in-common or other undivided interest distributed'),
  q('schB.q13a_8858_count', 'Schedule B line 13a: number of Forms 8858 attached', 'count'),
  q('schB.q14_foreign_partners', 'Schedule B line 14: foreign partners'),
  q('schB.q14_8805_count', 'Schedule B line 14: number of Forms 8805 attached', 'count', { when: yes('schB.q14_foreign_partners') }),
  q('schB.q15_8865_count', 'Schedule B line 15: number of Forms 8865 attached', 'count'),
  q('schB.q16a_1099_required', 'Schedule B line 16a: payments requiring Form 1099'),
  q('schB.q16b_1099_filed', 'Schedule B line 16b: required Forms 1099 filed or will be filed', 'yesno', { when: yes('schB.q16a_1099_required') }),
  q('schB.q17_5471_count', 'Schedule B line 17: number of Forms 5471 attached', 'count'),
  q('schB.q18_foreign_government_partners', 'Schedule B line 18: number of partners that are foreign governments under section 892', 'count'),
  q('schB.q19_1042', 'Schedule B line 19: payments requiring Forms 1042 and 1042-S'),
  q('schB.q20_8938', 'Schedule B line 20: specified domestic entity required to file Form 8938'),
  q('schB.q21_721c', 'Schedule B line 21: section 721(c) partnership'),
  q('schB.q22_267a', 'Schedule B line 22: interest or royalty disallowed under section 267A'),
  q('schB.q22_267a_amount', 'Schedule B line 22: total disallowed deductions', 'amount', { when: yes('schB.q22_267a') }),
  q('schB.q23_163j_election', 'Schedule B line 23: section 163(j) real property or farming election in effect'),
  q('schB.q24_8990', 'Schedule B line 24: one or more Form 8990 conditions'),
  q('schB.q25_qof', 'Schedule B line 25: self-certifies as a qualified opportunity fund'),
  q('schB.q26_864c8_count', 'Schedule B line 26: number of foreign partners subject to section 864(c)(8)', 'count'),
  q('schB.q27_707_8', 'Schedule B line 27: transfers subject to the Regulations section 1.707-8 disclosure'),
  q('schB.q28_7874', 'Schedule B line 28: section 7874 acquisition by a foreign corporation'),
  q('schB.q29a_7208_foreign', 'Schedule B line 29a: Form 7208 under the applicable foreign corporation rules'),
  q('schB.q29b_7208_surrogate', 'Schedule B line 29b: Form 7208 under the covered surrogate foreign corporation rules'),
  q('schB.q30_digital_assets', 'Schedule B line 30: received, sold, exchanged or disposed of a digital asset'),
  q('schB.q32_761_elect_out', 'Schedule B line 32: election out of subchapter K under section 761'),
  q('schB.q33_elect_out_bba', 'Schedule B line 33: electing out of the centralized partnership audit regime'),
  // Designation of Partnership Representative: required unless the partnership elects out (line 33); the designated individual only when the PR is an entity.
  q('pr.name', 'Partnership representative: name, U.S. address and phone', 'text', { when: no('schB.q33_elect_out_bba') }),
  q('pr.designated_individual', 'Designated individual (the partnership representative is an entity)', 'text', { when: { all: [no('schB.q33_elect_out_bba'), fact('prIsEntity')] } }),
  // Schedules the small-partnership relief can drop, and the K line 16 K-2/K-3 answer.
  form('sched.L', 'Schedule L, Balance Sheets per Books', { when: NOT_RELIEF_1065 }), form('sched.M1', 'Schedule M-1', { when: NOT_RELIEF_1065 }),
  form('sched.M2', 'Schedule M-2', { when: NOT_RELIEF_1065 }),
  q('schK.q16_k2k3', 'Schedule K line 16: Schedule K-2 attached, or qualified for the exception', 'choice', { source: 'engine' }),
  // Schedule K-1 items, answered per partner (scope 'owner': one answer per ownership interest).
  q('k1.item_e_f', 'K-1 items E and F: partner identifying number, name and address (for a disregarded-entity partner, its owner: the beneficial owner)', 'text', { source: 'engine', ...OWNER }),
  q('k1.item_g', 'K-1 item G: general partner or LLC member-manager, or limited partner or other member', 'choice', OWNER),
  q('k1.item_h1', 'K-1 item H1: domestic or foreign partner', 'choice', OWNER),
  // H2 is a checkbox with identifying details (2025 Form 1065 instructions, items E/F and H2): for a disregarded-entity partner, items
  // E/F identify the OWNER and H2 identifies the DISREGARDED ENTITY ITSELF: its name and its TIN, or that it has no TIN, or that its
  // TIN is not available (Codex t1-r3 N3). Two different identities; neither is copied from the other.
  q('k1.item_h2_is_de', 'K-1 item H2: the partner is a disregarded entity', 'yesno', OWNER),
  q('k1.item_h2', 'K-1 item H2: name and TIN of the disregarded entity itself (not its owner, who is items E/F), or that the entity has no TIN or its TIN is not available', 'text', { when: yes('k1.item_h2_is_de'), ...OWNER }),
  q('k1.item_i1', 'K-1 item I1: type of entity', 'choice', OWNER), q('k1.item_i2', 'K-1 item I2: retirement plan', 'yesno', OWNER),
  q('k1.item_j', 'K-1 item J: beginning and ending profit, loss and capital shares', 'amount', { source: 'engine', ...OWNER }),
  q('k1.item_k', 'K-1 item K1: share of liabilities, beginning and ending', 'amount', { source: 'engine', ...OWNER }),
  q('k1.item_k2_lower_tier', 'K-1 item K2: item K includes liability amounts from lower-tier partnerships', 'yesno', OWNER),
  q('k1.item_k3_guarantees', 'K-1 item K3: any item K liability is subject to guarantees or other payment obligations by the partner', 'yesno', OWNER),
  q('k1.item_l', 'K-1 item L: capital account analysis', 'amount', { source: 'engine', when: NOT_RELIEF_1065, ...OWNER }),
  q('k1.item_m', 'K-1 item M: contributed property with a built-in gain or loss', 'yesno', OWNER),
  // Item M "Yes" attaches a statement of the contributed property, which rests on section 704(c).
  unsupported('k1.item_m_statement', 'K-1 item M statement: contributed property with a built-in gain or loss', yes('k1.item_m'), 'section 704(c) is outside v1 scope (spec §2)', OWNER),
  unsupported('k1.item_n', 'K-1 item N: share of net unrecognized section 704(c) gain or loss', fact('has704cProperty'), 'section 704(c) is outside v1 scope (spec §2)', OWNER),
  // Attachments and elections the answers above call for.
  form('form.b1_1065', 'Schedule B-1 (Form 1065), Information on Partners Owning 50% or More', { when: { any: [yes('schB.q2a_entity_owner_50'), yes('schB.q2b_individual_owner_50')] } }),
  form('form.sch_d_1065', 'Schedule D (Form 1065), Capital Gains and Losses (typed summaries)', { when: { any: [fact('hasCapitalGainsOrLosses'), ...anyAmount('f1065.k.8', 'f1065.k.9a', 'f1065.k.9b')] } }),
  // Page 1 line 5 "Net farm profit (loss) (attach Schedule F (Form 1040))": a farm attaches its Schedule F even when the net is zero.
  form('form.sch_f_1065', 'Schedule F (Form 1040), Profit or Loss From Farming (page 1 line 5)', { when: { any: [amount('f1065.p1.5'), fact('hasFarm')] }, note: ATTACHED }),
  unsupported('form.b2_1065', 'Schedule B-2 (Form 1065), Election Out of the Centralized Partnership Audit Regime', yes('schB.q33_elect_out_bba'), 'Tax Books does not produce Schedule B-2'),
  unsupported('blocked.ptp', 'Publicly traded partnership', yes('schB.q5_ptp'), 'publicly traded partnerships are outside v1 scope (spec §2)'),
  unsupported('form.8918', 'Form 8918, Material Advisor Disclosure Statement', yes('schB.q7_form_8918'), 'not produced by Tax Books'),
  unsupported('form.3520', 'Form 3520 (foreign trust transactions)', yes('schB.q9_foreign_trust'), 'not produced by Tax Books'),
  rule('election', 'election.754', 'Section 754 election statement (the year it is made)', { source: 'engine', when: fact('making754ElectionThisYear'), status: 'unsupported', note: 'sections 734(b) and 743(b) are outside v1 scope (spec §2)' }),
  unsupported('stmt.743b', 'Section 743(b) adjustment computation and allocation statement', yes('schB.q10b_743b'), 'section 743(b) is outside v1 scope (spec §2)'),
  unsupported('stmt.734b', 'Section 734(b) adjustment computation and allocation statement', yes('schB.q10c_734b'), 'section 734(b) is outside v1 scope (spec §2)'),
  unsupported('stmt.mandatory_adjustment', 'Substantial built-in loss or basis reduction adjustment statement', yes('schB.q10d_mandatory_adjustment'), 'sections 734(b) and 743(b) are outside v1 scope (spec §2)'),
  unsupported('form.8858', 'Forms 8858', { gt: ['schB.q13a_8858_count', 0] }, 'not produced by Tax Books'),
  unsupported('form.8804_8805', 'Forms 8804 and 8805 (foreign partners)', yes('schB.q14_foreign_partners'), 'not produced by Tax Books'),
  unsupported('form.8865', 'Forms 8865', { gt: ['schB.q15_8865_count', 0] }, 'not produced by Tax Books'),
  unsupported('form.5471', 'Forms 5471', { gt: ['schB.q17_5471_count', 0] }, 'not produced by Tax Books'),
  unsupported('form.1042', 'Forms 1042 and 1042-S', yes('schB.q19_1042'), 'not produced by Tax Books'),
  unsupported('form.8938', 'Form 8938', yes('schB.q20_8938'), 'not produced by Tax Books'),
  unsupported('form.8990', 'Form 8990, Limitation on Business Interest Expense', yes('schB.q24_8990'), 'not produced by Tax Books'),
  unsupported('form.8996', 'Form 8996, Qualified Opportunity Fund', yes('schB.q25_qof'), 'not produced by Tax Books'),
  unsupported('form.7208', 'Form 7208, Excise Tax on Repurchase of Corporate Stock', { any: [yes('schB.q29a_7208_foreign'), yes('schB.q29b_7208_surrogate')] }, 'not produced by Tax Books'),
  unsupported('election.761', 'Election out of subchapter K (section 761)', yes('schB.q32_761_elect_out'), 'outside v1 scope'),
  // Schedule B "Yes" answers whose required details or attachments Tax Books does not produce.
  unsupported('blocked.721c', 'Section 721(c) partnership (Form 8838-P and the gain deferral statements)', yes('schB.q21_721c'), 'section 721(c) is outside v1 scope'),
  unsupported('stmt.707_8', 'Disclosure of transfers under Regulations section 1.707-8 (Schedule B line 27)', yes('schB.q27_707_8'), 'disguised-sale disclosures are not produced by Tax Books'),
  unsupported('blocked.7874', 'Section 7874 acquisition: the percentages by vote and by value (Schedule B line 28)', yes('schB.q28_7874'), 'foreign acquisitions are outside v1 scope'),
  unsupported('blocked.special_allocations', 'Special allocations', fact('hasSpecialAllocations'), 'special allocations are outside v1 scope (spec §2)'),
  ...commonForms(LINES_1065),
  rule('signature', 'sign.partner', 'Signature of partner or limited liability company member', { answer: 'text' }),
];

const F1120S = [
  q('p1.item_a_s_election_date', 'Item A: S election effective date', 'date', { source: 'engine' }), q('p1.item_b_code', 'Item B: business activity code number', 'text'),
  q('p1.item_c_m3', 'Item C: Schedule M-3 attached', 'yesno', { source: 'engine' }), q('p1.item_e_incorporated', 'Item E: date incorporated', 'date'),
  q('p1.item_f_total_assets', 'Item F: total assets', 'amount', { source: 'engine' }),
  q('p1.item_g_electing_s', 'Item G: electing to be an S corporation beginning with this tax year'),
  q('p1.item_g_2553_filed', 'Item G: Form 2553 already filed', 'yesno', { when: yes('p1.item_g_electing_s') }),
  unsupported('form.2553', 'Form 2553, Election by a Small Business Corporation (item G: attached if not already filed)', { all: [yes('p1.item_g_electing_s'), no('p1.item_g_2553_filed')] }, 'not produced by Tax Books'),
  q('p1.item_h_return_kind', 'Item H: final return, name change, address change, amended return or S election termination', 'choice'),
  q('p1.item_i_shareholder_count', 'Item I: number of shareholders during any part of the year', 'count', { source: 'engine' }),
  q('p1.item_j_aggregation', 'Item J: activities aggregated for section 465 or grouped for section 469', 'choice'),
  // Schedule B, every question the 2025 form prints (17 is reserved for future use).
  q('schB.q1_method', 'Schedule B line 1: accounting method', 'choice', { source: 'engine' }),
  q('schB.q2_business', 'Schedule B line 2: business activity and product or service', 'text'),
  q('schB.q3_nominee_shareholder', 'Schedule B line 3: a shareholder was a disregarded entity, trust, estate or nominee'),
  q('schB.q4a_owns_corporation', 'Schedule B line 4a: owns 20% directly or 50% of the stock of a corporation'),
  rule('statement', 'schB.q4a_detail', 'Schedule B line 4a (i)-(v): each corporation', { when: yes('schB.q4a_owns_corporation') }),
  q('schB.q4b_owns_partnership', 'Schedule B line 4b: owns 20% directly or 50% of a partnership or the beneficial interest of a trust'),
  rule('statement', 'schB.q4b_detail', 'Schedule B line 4b (i)-(v): each partnership or trust', { when: yes('schB.q4b_owns_partnership') }),
  // Lines 5a and 5b: a yes/no answer and, when "Yes", the share counts (i) and (ii) the form asks for, each a typed count.
  q('schB.q5a_restricted_stock', 'Schedule B line 5a: outstanding shares of restricted stock at the end of the tax year'),
  q('schB.q5a_restricted_shares', 'Schedule B line 5a(i): total shares of restricted stock', 'count', { when: yes('schB.q5a_restricted_stock') }),
  q('schB.q5a_nonrestricted_shares', 'Schedule B line 5a(ii): total shares of non-restricted stock', 'count', { when: yes('schB.q5a_restricted_stock') }),
  q('schB.q5b_options', 'Schedule B line 5b: outstanding stock options, warrants or similar instruments at the end of the tax year'),
  q('schB.q5b_shares_outstanding', 'Schedule B line 5b(i): total shares of stock outstanding at the end of the tax year', 'count', { when: yes('schB.q5b_options') }),
  q('schB.q5b_shares_if_executed', 'Schedule B line 5b(ii): total shares of stock outstanding if all instruments were executed', 'count', { when: yes('schB.q5b_options') }),
  q('schB.q6_form_8918', 'Schedule B line 6: Form 8918 filed or required'),
  q('schB.q7_oid', 'Schedule B line 7: publicly offered debt instruments with original issue discount'),
  q('schB.q8_nubig', 'Schedule B line 8: net unrealized built-in gain reduced by net recognized built-in gain', 'amount', { when: fact('hasNetUnrealizedBuiltInGain') }),
  q('schB.q9_163j_election', 'Schedule B line 9: section 163(j) real property or farming election in effect'),
  q('schB.q10_8990', 'Schedule B line 10: one or more Form 8990 conditions'),
  q('schB.q11_small', 'Schedule B line 11: receipts and total assets both under $250,000', 'yesno', { source: 'engine' }),
  q('schB.q12_debt_canceled', 'Schedule B line 12: non-shareholder debt canceled, forgiven or modified'),
  q('schB.q12_amount', 'Schedule B line 12: amount of principal reduction', 'amount', { when: yes('schB.q12_debt_canceled') }),
  q('schB.q13_qsub_terminated', 'Schedule B line 13: qualified subchapter S subsidiary election terminated or revoked'),
  q('schB.q14a_1099_required', 'Schedule B line 14a: payments requiring Form 1099'),
  q('schB.q14b_1099_filed', 'Schedule B line 14b: required Forms 1099 filed or will be filed', 'yesno', { when: yes('schB.q14a_1099_required') }),
  q('schB.q15_qof', 'Schedule B line 15: self-certifies as a qualified opportunity fund'),
  q('schB.q16_digital_assets', 'Schedule B line 16: received, sold, exchanged or disposed of a digital asset'),
  form('sched.L', 'Schedule L, Balance Sheets per Books', { when: { not: RELIEF_1120S } }), form('sched.M1', 'Schedule M-1', { when: { not: RELIEF_1120S } }),
  form('sched.M2', 'Schedule M-2'),
  q('schK.q14_k2k3', 'Schedule K line 14: Schedule K-2 attached, or qualified for the exception', 'choice', { source: 'engine' }),
  // Line 12d prints the type of section 59(e)(2) expenditure beside its amount.
  q('schK.q12d_59e_type', 'Schedule K line 12d: type of section 59(e)(2) expenditures', 'text', { when: amount('f1120s.k.12d') }),
  // Line 23a: Tax Books computes neither the excess net passive income tax nor the LIFO recapture tax.
  unsupported('tax.p1_23a', 'Page 1 line 23a: excess net passive income or LIFO recapture tax', amount('f1120s.p1.23a'), 'these corporate-level taxes are outside v1 scope'),
  // Schedule K-1 items, answered per shareholder (scope 'owner').
  q('k1.item_e_f1', 'K-1 items E and F1: shareholder identifying number, name and address', 'text', { source: 'engine', ...OWNER }),
  q('k1.item_f2_applies', 'K-1 item F2: the shareholder is a disregarded entity, trust, estate or nominee or similar person', 'yesno', OWNER),
  q('k1.item_f2', 'K-1 item F2: TIN and name of the individual or entity responsible for reporting', 'text', { when: yes('k1.item_f2_applies'), ...OWNER }),
  q('k1.item_f3', 'K-1 item F3: type of entity', 'choice', OWNER),
  q('k1.item_g', 'K-1 item G: allocation percentage', 'amount', { source: 'engine', ...OWNER }), q('k1.item_h', 'K-1 item H: shares held, beginning and end', 'count', { source: 'engine', ...OWNER }),
  q('k1.item_i', 'K-1 item I: loans from shareholder, beginning and end', 'amount', { source: 'engine', ...OWNER }),
  form('form.b1_1120s', 'Schedule B-1 (Form 1120-S), Information on Certain Shareholders', { when: yes('schB.q3_nominee_shareholder') }),
  form('form.1125e', 'Form 1125-E, Compensation of Officers', { when: OFFICER_COMP_1125E }),
  // Line 23b "Tax from Schedule D (Form 1120-S)" (built-in gains) needs Schedule D as much as the capital lines do.
  form('form.sch_d_1120s', 'Schedule D (Form 1120-S), Capital Gains and Losses and Built-in Gains (typed summaries)',
    { when: { any: [fact('hasCapitalGainsOrLosses'), ...anyAmount('f1120s.k.7', 'f1120s.k.8a', 'f1120s.k.8b', 'f1120s.p1.23b')] } }),
  unsupported('blocked.second_class_of_stock', 'Second class of stock', fact('hasSecondClassOfStock'), 'a second class of stock is outside v1 scope (spec §2)'),
  unsupported('form.8918', 'Form 8918, Material Advisor Disclosure Statement', yes('schB.q6_form_8918'), 'not produced by Tax Books'),
  unsupported('form.8281', 'Form 8281 (original issue discount)', yes('schB.q7_oid'), 'not produced by Tax Books'),
  unsupported('form.8990', 'Form 8990, Limitation on Business Interest Expense', yes('schB.q10_8990'), 'not produced by Tax Books'),
  unsupported('form.8996', 'Form 8996, Qualified Opportunity Fund', yes('schB.q15_qof'), 'not produced by Tax Books'),
  ...commonForms(LINES_1120S),
  rule('signature', 'sign.officer', 'Signature of officer', { answer: 'text' }), rule('signature', 'sign.officer_title', 'Officer title', { answer: 'text' }),
];

// The household preparation checklist (spec §2: a workpaper until T8, whose household filing manifest replaces this list). Not complete.
const H1040 = [
  q('f1040.filing_status', 'Filing status', 'choice'), q('f1040.dependents', 'Dependents', 'text'), q('f1040.digital_assets', 'Digital assets question'),
  q('f1040.presidential_fund', 'Presidential election campaign fund', 'choice'),
  q('schC.item_f', 'Schedule C item F: accounting method', 'choice', { when: fact('hasScheduleC') }), q('schC.item_g', 'Schedule C item G: material participation', 'yesno', { when: fact('hasScheduleC') }),
  q('schC.item_i_j', 'Schedule C items I and J: Forms 1099 required and filed', 'yesno', { when: fact('hasScheduleC') }),
  rule('signature', 'sign.taxpayer', 'Taxpayer signature', { answer: 'text' }), rule('signature', 'sign.spouse', 'Spouse signature', { answer: 'text', when: fact('hasSpouse') }),
  rule('signature', 'sign.date', 'Signature date', { answer: 'date' }),
];

export const FILING_MANIFEST = { form_1065: F1065, form_1120s: F1120S, household_1040: H1040, disregarded: [] };
// What each list claims to be: business lists cover the TY2025 forms' non-dollar answers, attachments and elections as rules; the household list is partial until T8.
export const MANIFEST_COVERAGE = { form_1065: 'rules_2025', form_1120s: 'rules_2025', household_1040: 'checklist_until_T8', disregarded: 'owner_return' };


// Every amount line whose 2025 form text calls for an attachment (or prints it in its caption), and the manifest rule that requires it (Codex
// t1-r2 B4): the rule reads the line's amount ('amount:<line>'), or the named fact `via` that decides it; `entry: null` declares a line that
// attaches nothing of its own, with the reason. The catalog tests check that every non-computed amount line citing a form or schedule is here.
const tie = (line, entry, o = {}) => ({ line, entry, ...o });
export const LINE_ATTACHMENTS = {
  form_1065: [
    tie('f1065.p1.5', 'form.sch_f_1065'), tie('f1065.p1.6', 'form.4797'), tie('f1065.p1.16a', 'form.4562'),
    tie('f1065.p1.16b', null, { reason: 'the depreciation it removes is already reported on Form 1125-A or elsewhere; it attaches nothing of its own' }),
    tie('f1065.p1.20', 'form.7205'), tie('f1065.k.8', 'form.sch_d_1065'), tie('f1065.k.9a', 'form.sch_d_1065'), tie('f1065.k.9b', 'form.sch_d_1065'),
    tie('f1065.k.10', 'form.4797'), tie('f1065.k.12', 'form.4562'), ...LINES_1065.credits.map(l => tie(l, 'form.credit_forms')),
    tie('f8825.main.14', 'form.4562'), tie('f8825.main.17', 'form.8825_sch_a'), tie('f8825.main.21', 'form.4797'),
  ],
  form_1120s: [
    tie('f1120s.p1.4', 'form.4797'), tie('f1120s.p1.7', 'form.1125e', { via: 'officerCompCents' }), tie('f1120s.p1.14', 'form.4562'), tie('f1120s.p1.19', 'form.7205'),
    tie('f1120s.p1.23a', 'tax.p1_23a'), tie('f1120s.p1.23b', 'form.sch_d_1120s'), tie('f1120s.k.7', 'form.sch_d_1120s'), tie('f1120s.k.8a', 'form.sch_d_1120s'),
    tie('f1120s.k.8b', 'form.sch_d_1120s'), tie('f1120s.k.9', 'form.4797'), tie('f1120s.k.11', 'form.4562'), tie('f1120s.k.12d', 'schK.q12d_59e_type'),
    ...LINES_1120S.credits.map(l => tie(l, 'form.credit_forms')),
    tie('f8825.main.14', 'form.4562'), tie('f8825.main.17', 'form.8825_sch_a'), tie('f8825.main.21', 'form.4797'),
  ],
  household_1040: [], disregarded: [],
};

const questionKeys = entries => Object.fromEntries(entries.filter(e => e.kind === 'question' || e.answer).map(e => [e.key, e.answer]));
const ownerQuestions = entries => new Set(entries.filter(e => e.scope === 'owner' && (e.kind === 'question' || e.answer)).map(e => e.key));

// Every problem in a manifest, as text; [] when sound: unique keys, known kinds, statuses and scopes, and conditions that name only declared facts,
// this manifest's own yes/no and count questions, or lines of the return's catalog (lineIds; a misspelled fact would otherwise read as unknown
// forever and never make anything required). A return-wide rule never reads one owner's answer: it has no single value for the return.
export function validateManifest(returnType, entries, { lineIds = null } = {}) {
  const problems = [], keys = new Set();
  const answers = questionKeys(entries), perOwner = ownerQuestions(entries);
  for (const e of entries) {
    if (keys.has(e.key)) problems.push(`duplicate key ${e.key}`);
    keys.add(e.key);
    if (!ENTRY_KINDS.includes(e.kind)) problems.push(`${e.key}: unknown kind ${e.kind}`);
    if (!['supported', 'unsupported'].includes(e.status)) problems.push(`${e.key}: status must be supported or unsupported`);
    if (!SCOPES.includes(e.scope)) problems.push(`${e.key}: scope must be one of ${SCOPES.join(', ')}`);
    if (e.answer !== null && e.answer !== undefined && !ANSWER_TYPES.includes(e.answer)) problems.push(`${e.key}: unknown answer type ${e.answer}`);
    if (e.when === undefined) { problems.push(`${e.key}: no applicability condition`); continue; }
    let names;
    try { names = conditionNames(e.when); } catch (err) { problems.push(`${e.key}: ${err.message}`); continue; }
    // Each node by its operator (Codex t1-r4): a choice condition names a declared choice question, and a question is read one way only.
    const choiceNames = choiceConditions(e.when).map(([k]) => k);
    for (const n of new Set(choiceNames)) {
      if (FACT_TYPES[n] || n.startsWith(AMOUNT_PREFIX)) problems.push(`${e.key}: ${n} is not a choice question`);
      else if (!(n in answers)) problems.push(`${e.key}: unknown choice question ${n}`);
      if (names.filter(x => x === n).length > choiceNames.filter(x => x === n).length) problems.push(`${e.key}: ${n} is read both as a choice and another way`);
    }
    for (const n of names) {
      if (FACT_TYPES[n]) continue;
      if (n.startsWith(AMOUNT_PREFIX)) {
        const line = n.slice(AMOUNT_PREFIX.length);
        if (!lineIds) problems.push(`${e.key}: an amount condition is checked against the return's catalog (pass lineIds)`);
        else if (!lineIds.has(line)) problems.push(`${e.key}: ${line} is not a line of ${returnType}`);
        continue;
      }
      const byChoice = choiceConditions(e.when).filter(([k]) => k === n);
      if (byChoice.length && n in answers) {
        const decl = entries.find(x => x.key === n);
        if (answers[n] !== 'choice') problems.push(`${e.key}: ${n} is a ${answers[n]} answer, not a choice`);
        for (const [, c] of byChoice) if (!decl?.choices?.some(([k]) => k === c)) problems.push(`${e.key}: ${c} is not a declared choice of ${n}`);
        if (perOwner.has(n) && e.scope !== 'owner') problems.push(`${e.key}: ${n} is answered per owner; a return-wide rule cannot read it`);
        continue;
      }
      if (!(n in answers)) problems.push(`${e.key}: unknown fact ${n}`);
      else if (!['yesno', 'count'].includes(answers[n])) problems.push(`${e.key}: ${n} is a ${answers[n]} answer, not a yes/no or count`);
      else if (perOwner.has(n) && e.scope !== 'owner') problems.push(`${e.key}: ${n} is answered per owner; a return-wide rule cannot read it`);
    }
  }
  return problems;
}

// The manifest evaluated for a period's facts and answers: each rule with its state. 'required' (applies, supported), 'not_required', 'unresolved'
// (the condition waits on an unknown fact or an unanswered question, named in waitsOn), 'unsupported' (applies, outside v1 scope: blocks Final).
// A fact the condition reads must be typed correctly or 'unknown'; an absent business fact or line amount reads as unknown here (the manifest is
// filled in over the year), never as false or zero. Whether the required answers are actually given and reviewed is T4's completeness validator.
// Owner-scoped rules (the K-1 items) read each owner's own answers from facts.owners = { <ownership interest>: { <question key>: answer } } and
// never from the return's facts. With facts.owners each such rule carries owners: [{ owner, state, waitsOn? }] and the most pressing state across
// them (unsupported, then unresolved, then required); without it the rule is evaluated once for an owner nobody has answered for yet.
const PRESSING = ['unsupported', 'unresolved', 'required', 'not_required'];
export function evaluateManifest(returnType, entries, facts = {}) {
  const answers = questionKeys(entries), perOwner = ownerQuestions(entries);
  const choices = Object.fromEntries(entries.filter(e => Array.isArray(e.choices)).map(e => [e.key, e.choices.map(([k]) => k)]));
  const known = Object.fromEntries(Object.keys(FACT_TYPES).map(n => [n, facts[n] === undefined ? UNKNOWN : facts[n]]));
  const amounts = Object.fromEntries(entries.flatMap(e => conditionNames(e.when)).filter(n => n.startsWith(AMOUNT_PREFIX)).map(n => [n, facts[n] === undefined ? UNKNOWN : facts[n]]));
  const all = Object.fromEntries(Object.entries({ ...facts, ...known, ...amounts }).filter(([k]) => k !== 'owners' && !perOwner.has(k)));
  const owners = facts.owners;
  if (owners !== undefined && (owners === null || typeof owners !== 'object' || Array.isArray(owners) || Object.values(owners).some(a => !a || typeof a !== 'object' || Array.isArray(a)))) {
    throw new Error(`filing manifest ${returnType}: owners must map each ownership interest to its answers`);
  }
  const judge = (e, f) => {
    const v = evaluate(e.when, f, returnType, answers, choices);
    const state = v === UNKNOWN ? 'unresolved' : v === false ? 'not_required' : e.status === 'unsupported' ? 'unsupported' : 'required';
    return { state, ...(state === 'unresolved' ? { waitsOn: waitsOn(e.when, f, answers) } : {}) };
  };
  const ownerFacts = a => ({ ...all, ...Object.fromEntries(Object.entries(a).filter(([k]) => perOwner.has(k))) });
  return entries.map(e => {
    if (e.scope !== 'owner' || owners === undefined) return { ...e, ...judge(e, all) };
    const each = Object.keys(owners).sort().map(owner => ({ owner, ...judge(e, ownerFacts(owners[owner])) }));
    if (!each.length) return { ...e, state: 'unresolved', waitsOn: 'owners', owners: [] };
    const state = PRESSING.find(s => each.some(x => x.state === s));
    const waits = [...new Set(each.flatMap(x => (x.waitsOn ? x.waitsOn.split(', ') : [])))].join(', ');
    return { ...e, state, owners: each, ...(state === 'unresolved' ? { waitsOn: waits } : {}) };
  });
}
