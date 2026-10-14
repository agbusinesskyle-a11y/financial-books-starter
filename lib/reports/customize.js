import { formatCents } from '../domain/money.js';

// Customize (stage R4): how a report looks — its title, number format, empty cells, header and footer, table style,
// renamed section titles and one calculated column. Everything lives in the report's query string (c_* parameters),
// so a customized report can be linked, exported, saved and scheduled like any other.

const FLAGS = ['hide_company', 'hide_period', 'hide_basis', 'hide_prepared', 'fmt_div', 'fmt_nosym', 'banded'];
const CHOICES = { align: ['center', 'left'], fmt_neg: ['minus', 'paren', 'red'], fmt_dec: ['2', '0'], empty: ['zero', 'blank', 'dash'],
  grid: ['rows', 'none', 'all'], calc_type: ['money', 'percent', 'number'] };
export const SECTION_TITLES = [
  ['income', 'Income'], ['cogs', 'Cost of Goods Sold'], ['gross_profit', 'Gross Profit'], ['expenses', 'Expenses'],
  ['net_operating_income', 'Net Operating Income'], ['other_income', 'Other Income'], ['other_expenses', 'Other Expenses'],
  ['net_other_income', 'Net Other Income'], ['net_income', 'Net Income'],
];
const TEXT = { title: 100, calc_name: 40, calc_formula: 200, ...Object.fromEntries(SECTION_TITLES.map(([k]) => [`t_${k}`, 60])) };
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

// query -> { key: value } with only valid, non-default settings (so links stay short).
export function parseCustom(query) {
  const c = {};
  for (const k of FLAGS) if (query[`c_${k}`] === '1') c[k] = '1';
  for (const [k, allowed] of Object.entries(CHOICES)) if (allowed.includes(query[`c_${k}`]) && query[`c_${k}`] !== allowed[0]) c[k] = query[`c_${k}`];
  for (const [k, max] of Object.entries(TEXT)) { const v = clean(query[`c_${k}`], max); if (v) c[k] = v; }
  if (c.calc_formula && formulaError(c.calc_formula, ['C1'])) delete c.calc_formula;
  return c;
}
export const customQuery = c => Object.fromEntries(Object.entries(c ?? {}).map(([k, v]) => [`c_${k}`, v]));
// Only the look (not titles or calculations) — what "use these settings for all reports" keeps.
export const LOOK_KEYS = ['hide_company', 'hide_period', 'hide_basis', 'hide_prepared', 'fmt_div', 'fmt_nosym', 'banded', 'align', 'fmt_neg', 'fmt_dec', 'empty', 'grid'];

// Number formatting for HTML, PDF and CSV text.
export function formatter(c = {}) {
  const money = v => {
    if (v === null || v === undefined) return '';
    if (v === 0 && c.empty === 'blank') return '';
    if (v === 0 && c.empty === 'dash') return '–';
    let cents = v;
    if (c.fmt_div) cents = Math.round(v / 1000);
    let text = c.fmt_dec === '0' ? formatCents(Math.round(cents / 100) * 100).replace(/\.00$/, '') : formatCents(cents);
    if (c.fmt_nosym) text = text.replace('$', '');
    if (c.fmt_div) text += 'K';
    if (c.fmt_neg === 'paren' && v < 0) text = `(${text.replace('-', '')})`;
    return text;
  };
  const pct = p => (p === null || p === undefined || !Number.isFinite(p) ? '' : `${(p * 100).toFixed(c.fmt_dec === '0' ? 0 : 2)}%`);
  return { money, pct, red: v => c.fmt_neg === 'red' && typeof v === 'number' && v < 0 };
}

// Excel number format matching the settings.
export function excelMoneyFormat(c = {}) {
  const base = `${c.fmt_nosym ? '' : '$'}#,##0${c.fmt_dec === '0' ? '' : '.00'}${c.fmt_div ? ',"K"' : ''}`;
  const neg = c.fmt_neg === 'paren' ? `(${base})` : c.fmt_neg === 'red' ? `[Red]-${base}` : `-${base}`;
  const zero = c.empty === 'blank' ? '""' : c.empty === 'dash' ? '"–"' : base;
  return `${base};${neg};${zero}`;
}

// ---- formulas (calculated columns, custom KPIs): numbers, names, + - * / and parentheses; nothing else ----

function tokenize(text) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/()]))/y;
  let m, at = 0;
  const s = String(text);
  while (at < s.length) {
    if (/^\s*$/.test(s.slice(at))) break;
    re.lastIndex = at;
    m = re.exec(s);
    if (!m) throw new Error(`Can’t read “${s.slice(at).trim().slice(0, 12)}”.`);
    tokens.push(m[1] !== undefined ? { n: Number(m[1]) } : m[2] !== undefined ? { id: m[2] } : { op: m[3] });
    at = re.lastIndex;
  }
  return tokens;
}

// Parses to a small tree; throws a readable message on bad input.
export function parseFormula(text) {
  const t = tokenize(text);
  if (!t.length) throw new Error('Enter a formula.');
  let i = 0;
  const peek = () => t[i];
  const expr = () => { let left = term(); while (peek()?.op === '+' || peek()?.op === '-') { const op = t[i++].op; left = { op, a: left, b: term() }; } return left; };
  const term = () => { let left = unary(); while (peek()?.op === '*' || peek()?.op === '/') { const op = t[i++].op; left = { op, a: left, b: unary() }; } return left; };
  const unary = () => { if (peek()?.op === '-') { i++; return { op: 'neg', a: unary() }; } if (peek()?.op === '+') { i++; return unary(); } return atom(); };
  const atom = () => {
    const tok = t[i++];
    if (!tok) throw new Error('The formula ends too soon.');
    if ('n' in tok) return { n: tok.n };
    if ('id' in tok) return { id: tok.id };
    if (tok.op === '(') { const e = expr(); if (t[i++]?.op !== ')') throw new Error('A “(” is missing its “)”.'); return e; }
    throw new Error(`Unexpected “${tok.op}”.`);
  };
  const tree = expr();
  if (i < t.length) throw new Error(`Unexpected “${t[i].op ?? t[i].id ?? t[i].n}”.`);
  return tree;
}
const names = tree => (tree.id ? [tree.id] : [...(tree.a ? names(tree.a) : []), ...(tree.b ? names(tree.b) : [])]);

// null when fine, else the problem (unknown names included).
export function formulaError(text, allowed) {
  try {
    const unknown = names(parseFormula(text)).filter(n => !allowed.includes(n) && !(/^C\d{1,2}$/.test(n) && allowed.includes('C1')));
    return unknown.length ? `Unknown name: ${unknown[0]}.` : null;
  } catch (error) { return error.message; }
}

// Value of a formula given { name: number }; null when it divides by zero or a value is missing.
export function evalFormula(text, vars) {
  const run = n => {
    if ('n' in n) return n.n;
    if ('id' in n) return Object.hasOwn(vars, n.id) && Number.isFinite(vars[n.id]) ? vars[n.id] : null;
    const a = run(n.a);
    if (n.op === 'neg') return a === null ? null : -a;
    const b = run(n.b);
    if (a === null || b === null) return null;
    if (n.op === '+') return a + b;
    if (n.op === '-') return a - b;
    if (n.op === '*') return a * b;
    return b === 0 ? null : a / b;
  };
  try { const v = run(parseFormula(text)); return v === null || !Number.isFinite(v) ? null : v; } catch { return null; }
}

// Applies renamed section titles, the custom title and the calculated column to a finished report.
export function applyCustom(report) {
  const c = report.opts?.custom ?? {};
  if (c.title) report.title = c.title;
  const renamed = Object.fromEntries(SECTION_TITLES.filter(([k]) => c[`t_${k}`]).map(([k, label]) => [k, [label, c[`t_${k}`]]]));
  if (Object.keys(renamed).length && !report.detail) {
    for (const r of report.rows) {
      const k = r.section ?? r.key;
      if (!renamed[k]) continue;
      const [from, to] = renamed[k];
      r.label = r.label === from ? to : r.label === `Total for ${from}` ? `Total for ${to}` : r.label;
    }
  }
  if (c.calc_formula && !report.detail && report.columns?.length) {
    // C1, C2, … are the report's columns left to right, in dollars (or the percentage as a number).
    report.columns = [...report.columns, { label: c.calc_name || 'Calculated', kind: c.calc_type === 'percent' ? 'pct_calc' : c.calc_type === 'number' ? 'qty' : 'calc' }];
    for (const r of report.rows) {
      if (!r.cells) continue;
      const vars = Object.fromEntries(r.cells.map((cell, i) => [`C${i + 1}`, 'pct' in cell ? (cell.pct ?? NaN) * 100 : 'qty' in cell ? cell.qty : (cell.v ?? 0) / 100]));
      const v = evalFormula(c.calc_formula, vars);
      r.cells = [...r.cells, c.calc_type === 'percent' ? { pct: v === null ? null : v / 100 } : c.calc_type === 'number' ? { qty: v } : { v: v === null ? null : Math.round(v * 100) }];
    }
  }
  return report;
}
