// lib/tax/catalog/2025/k1_1065.js — Schedule K-1 (Form 1065). One instance per ownership interest. Boxes mirror Schedule K.
import { stated, info } from './shared.js';
const I = { instanceDims: ['interest'] };
const box = (n, label, o = {}) => stated(`k1_1065.box.${n}`, label, { ...I, ...o });
const item = (k, label, o = {}) => info(`k1_1065.item.${k}`, label, { ...I, ...o });
// The codes each coded box takes, as the Partner's Instructions for Schedule K-1 (Form 1065) (2025) list them ("List of Codes"). Explicit
// lists, never range strings: codes reserved for future use (box 11 G, H, T-X; box 13 Q, T, U, AF-AJ; box 15 AN, BD-BG; box 19 E;
// box 20 BA-BD) are left out, so a reserved code is refused rather than accepted as part of "A-ZZ".
const span = text => text.split(' ');
export const BOX_CODES = {
  11: span('A B C D E F I J K L M N O P Q R S ZZ'),
  13: span('A B C D E F G H I J K L M N O P R S V W X Y Z AA AB AC AD AE ZZ'),
  14: span('A B C'),
  15: span('A B C D E F G H I J K L M N O P Q R S T U V W X Y Z AA AB AC AD AE AF AG AH AI AJ AK AL AM AO AP AQ AR AS AT AU AV AW AX AY AZ BA BB BC ZZ'),
  17: span('A B C D E F'),
  18: span('A B C'),
  19: span('A B C D F G'),
  20: span('A B C D E F G H I J K L M N O P Q R S T U V W X Y Z AA AB AC AD AE AF AG AH AI AJ AK AL AM AN AO AP AQ AR AS AT AU AV AW AX AY AZ ZZ'),
};
// A generic coded box carries the codes no dedicated box line carries (box 20 codes A, B, N, Z, AG and AJ have their own lines), one instance
// per code: the code is a required instance dimension, so box 11 code A and code C are separate destinations and never one sum.
const coded = (n, label, dedicated, o = {}) => box(n, label, { ...o, type: 'code', instanceDims: ['interest', 'code'], codes: BOX_CODES[n].filter(c => !dedicated.includes(c)) });
export const LINES = [
  box(1, 'Ordinary business income (loss)', { allocBasis: 'profit' }), box(2, 'Net rental real estate income (loss)', { allocBasis: 'profit' }), box(3, 'Other net rental income (loss)', { allocBasis: 'profit' }),
  box('4a', 'Guaranteed payments for services'), box('4b', 'Guaranteed payments for capital'), box('4c', 'Total guaranteed payments'),
  box(5, 'Interest income', { allocBasis: 'profit' }), box('6a', 'Ordinary dividends', { allocBasis: 'profit' }), box('6b', 'Qualified dividends', { allocBasis: 'profit' }), box('6c', 'Dividend equivalents', { allocBasis: 'profit' }),
  box(7, 'Royalties', { allocBasis: 'profit' }), box(8, 'Net short-term capital gain (loss)', { allocBasis: 'profit' }), box('9a', 'Net long-term capital gain (loss)', { allocBasis: 'profit' }),
  box('9b', 'Collectibles (28%) gain (loss)'), box('9c', 'Unrecaptured section 1250 gain'), box(10, 'Net section 1231 gain (loss)', { allocBasis: 'profit' }),
  coded(11, 'Other income (loss) (code)', [], { allocBasis: 'profit' }), box(12, 'Section 179 deduction', { allocBasis: 'loss' }), coded(13, 'Other deductions (code)', [], { allocBasis: 'loss' }),
  box('14A', 'Self-employment earnings (loss)'), box('14B', 'Gross farming or fishing income'), box('14C', 'Gross nonfarm income'),
  coded(15, 'Credits (code)', []), item('16', 'Schedule K-3 attached', { type: 'checkbox' }), coded(17, 'Alternative minimum tax items (code)', []),
  box('18A', 'Tax-exempt interest income'), box('18B', 'Other tax-exempt income'), box('18C', 'Nondeductible expenses'),
  box('19A', 'Distributions: cash and marketable securities'), box('19B', 'Distributions: distribution subject to section 737'), box('19C', 'Distributions: other property'),
  box('19D', 'Distributions: deemed distributions of money (decreases in partner’s share of liabilities)'),
  box('19F', 'Distributions: cash or marketable securities for performing services'),
  box('19G', 'Distributions: property other than cash or marketable securities for performing services'),
  box('20A', 'Investment income'), box('20B', 'Investment expenses'), box('20N', 'Business interest expense'), box('20Z', 'Section 199A information'),
  box('20AG', 'Gross receipts for section 448(c)'), box('20AJ', 'Excess business loss limitation'), coded(20, 'Other information (code)', ['A', 'B', 'N', 'Z', 'AG', 'AJ']),
  box(21, 'Foreign taxes paid or accrued', { allocBasis: 'loss' }), item('22', 'More than one activity for at-risk purposes', { type: 'checkbox' }), item('23', 'More than one activity for passive activity purposes', { type: 'checkbox' }),
  item('E', 'Partner’s SSN or TIN'), item('F', 'Partner name and address'), item('G', 'General partner or LLC member-manager / Limited partner or other LLC member'), item('H1', 'Domestic or foreign partner', { type: 'checkbox' }),
  item('H2', 'Disregarded entity: TIN and name', { type: 'text' }), item('I1', 'What type of entity is this partner?'), item('I2', 'Retirement plan (IRA/SEP/Keogh)', { type: 'checkbox' }),
  item('J_profit_begin', 'Profit share, beginning'), item('J_profit_end', 'Profit share, ending'), item('J_loss_begin', 'Loss share, beginning'), item('J_loss_end', 'Loss share, ending'),
  item('J_capital_begin', 'Capital share, beginning'), item('J_capital_end', 'Capital share, ending'), item('J_sale_or_exchange', 'Decrease in share is due to sale or exchange of the partnership interest', { type: 'checkbox' }),
  box('K1_nonrecourse_begin', 'Share of liabilities: nonrecourse, beginning'), box('K1_nonrecourse_end', 'Share of liabilities: nonrecourse, ending'),
  box('K1_qualified_nonrecourse_begin', 'Share of liabilities: qualified nonrecourse financing, beginning'), box('K1_qualified_nonrecourse_end', 'Share of liabilities: qualified nonrecourse financing, ending'),
  box('K1_recourse_begin', 'Share of liabilities: recourse, beginning'), box('K1_recourse_end', 'Share of liabilities: recourse, ending'),
  item('K2', 'Includes liability amounts from lower-tier partnerships', { type: 'checkbox' }), item('K3', 'Any of the liabilities subject to guarantees or other payment obligations', { type: 'checkbox' }),
  box('L_begin', 'Capital account: beginning'), box('L_contributed', 'Capital contributed during the year'), box('L_net_income', 'Current year net income (loss)'),
  box('L_other', 'Other increase (decrease)'), box('L_withdrawals', 'Withdrawals and distributions', { semantic: 'reduction', operator: 'subtract', printedPolarity: 'negative' }), box('L_end', 'Capital account: ending'),
  item('M', 'Did the partner contribute property with a built-in gain (loss)?', { type: 'checkbox' }), box('N_begin', 'Partner’s share of net unrecognized section 704(c) gain or (loss): beginning'), box('N_end', 'Partner’s share of net unrecognized section 704(c) gain or (loss): ending'),
];
