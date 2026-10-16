// lib/tax/catalog/2025/k1_1120s.js — Schedule K-1 (Form 1120-S). One instance per shareholder interest. No item L capital analysis (spec r1 #8).
// Part II items are the ones the TY2025 form prints (checked against the IRS PDF): E identifying number, F1 name and address, F2 the individual or
// entity responsible for reporting a disregarded entity, trust, estate or nominee shareholder, F3 type of entity, G allocation percentage, H shares, I loans.
// G and H are text (a percentage, a share count); I prints "$" on both of its lines and is an amount box (spec §4.7 value schema), see below.
// Box 16 codes A-F and box 17 codes A, B, V, AC and AJ follow the Shareholder's Instructions for Schedule K-1 (Form 1120-S), 2025.
import { stated, info } from './shared.js';
const I = { instanceDims: ['interest'] };
const box = (n, label, o = {}) => stated(`k1_1120s.box.${n}`, label, { ...I, ...o });
const item = (k, label, o = {}) => info(`k1_1120s.item.${k}`, label, { ...I, ...o });
// The codes each coded box takes, as the Shareholder's Instructions for Schedule K-1 (Form 1120-S) (2025) list them ("List of Codes"), with the
// codes reserved for future use left out (box 10 H, L, P-R, T-X; box 12 K, N, P-V, AD-AJ; box 13 AN, BD-BG; box 17 S-T, W-Z, AD-AI, AK-AM, AO,
// AQ-AR, AX-AZ, BB-BD). Explicit lists, never range strings.
const span = text => text.split(' ');
export const BOX_CODES = {
  10: span('A B C D E F G I J K M N O S ZZ'),
  12: span('A B C D E F G H I J L M O W X Y Z AA AB AC ZZ'),
  13: span('A B C D E F G H I J K L M N O P Q R S T U V W X Y Z AA AB AC AD AE AF AG AH AI AJ AK AL AM AO AP AQ AR AS AT AU AV AW AX AY AZ BA BB BC ZZ'),
  15: span('A B C D E F'),
  16: span('A B C D E F'),
  17: span('A B C D E F G H I J K L M N O P Q R U V AA AB AC AJ AN AP AS AT AU AV AW BA ZZ'),
};
// A generic coded box carries the codes no dedicated box line carries (box 17 codes A, B, V, AC and AJ have their own lines), one instance per
// code: the code is a required instance dimension, so two codes are two destinations, never one sum.
const coded = (n, label, dedicated, o = {}) => box(n, label, { ...o, type: 'code', instanceDims: ['interest', 'code'], codes: BOX_CODES[n].filter(c => !dedicated.includes(c)) });
export const LINES = [
  box(1, 'Ordinary business income (loss)'), box(2, 'Net rental real estate income (loss)'), box(3, 'Other net rental income (loss)'), box(4, 'Interest income'),
  box('5a', 'Ordinary dividends'), box('5b', 'Qualified dividends'), box(6, 'Royalties'), box(7, 'Net short-term capital gain (loss)'), box('8a', 'Net long-term capital gain (loss)'),
  box('8b', 'Collectibles (28%) gain (loss)'), box('8c', 'Unrecaptured section 1250 gain'), box(9, 'Net section 1231 gain (loss)'), coded(10, 'Other income (loss) (code)', []),
  box(11, 'Section 179 deduction'), coded(12, 'Other deductions (code)', []), coded(13, 'Credits (code)', []), item('14', 'Schedule K-3 attached', { type: 'checkbox' }),
  coded(15, 'Alternative minimum tax items (code)', []),
  box('16A', 'Tax-exempt interest income'), box('16B', 'Other tax-exempt income'), box('16C', 'Nondeductible expenses'), box('16D', 'Distributions'), box('16E', 'Repayment of loans from shareholders'), box('16F', 'Foreign taxes paid or accrued'),
  box('17A', 'Investment income'), box('17B', 'Investment expenses'), box('17V', 'Section 199A information'), box('17AC', 'Gross receipts for section 448(c)'), box('17AJ', 'Excess business loss limitation'), coded(17, 'Other information (code)', ['A', 'B', 'V', 'AC', 'AJ']),
  item('18', 'More than one activity for at-risk purposes', { type: 'checkbox' }), item('19', 'More than one activity for passive activity purposes', { type: 'checkbox' }),
  item('E', 'Shareholder’s identifying number'), item('F1', 'Shareholder’s name, address, city, state, and ZIP code'),
  item('F2', 'Disregarded entity, trust, estate, or nominee shareholder: TIN and name of the individual or entity responsible for reporting'), item('F3', 'What type of entity is this shareholder?'),
  item('G', 'Current year allocation percentage'), item('H_begin', 'Shares held at beginning of tax year'), item('H_end', 'Shares held at end of tax year'),
  // Item I is a dollar amount per interest: T4 fills it from the shareholder_loan rows (Schedule L line 19 per shareholder) and Form 7203 debt
  // basis reads it, so it is an amount box like the K-1 (1065) item K1 and item L boxes, never a text item that carries no amount.
  box('I_begin', 'Loans from shareholder at beginning of tax year'), box('I_end', 'Loans from shareholder at end of tax year'),
];
