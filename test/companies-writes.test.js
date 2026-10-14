import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { ledgerCheck } from '../lib/data/ledger.js';
import { startApp } from './app-harness.js';

// Stage B1, every remaining write path: working in company A, each form is posted with company B's ids (its
// customers, vendors, items, accounts, classes, locations, tags, projects, documents, templates, budgets, rules...).
// Each attempt must not be a server error, must leave every record of company B exactly as it was, and must not leave
// anything in company A pointing at company B. Each attempt is its own subtest so a leak is reported by name.
const TODAY = '2026-10-12';
const sent = [];
const mailer = { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } };
let app, pool, A, B, b;
const a = {}, z = {}; // a: company A ids used by the attacks; z: company B ids

const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
const loc = res => res.headers.get('location') ?? '';
const idIn = (res, re, label) => { const m = re.exec(loc(res)); assert.ok(m, `${label}: no id in redirect “${loc(res)}” (status ${res.status})`); return Number(m[1]); };
const errorOf = html => (/class="[^"]*error[^"]*"[^>]*>([\s\S]{0,300}?)</.exec(html) ?? [])[1] ?? html.slice(0, 300);
async function ok303(res, label) {
  if (res.status !== 303) assert.fail(`${label}: expected 303, got ${res.status}: ${errorOf(await res.text())}`);
  return res;
}
const switchTo = async scope => ok303(await app.post('/company/switch', { entity_id: String(scope.entityId) }), 'switch company');

// ---- form builders (field names from services/app/*.js) ----
function sales(type, customerId, lines, more = {}) {
  const p = new URLSearchParams({ type, customer_id: String(customerId), txn_date: TODAY, after_save: 'none', ...more });
  for (const l of lines) {
    p.append('line_item', l.item ? String(l.item) : ''); p.append('line_desc', l.desc ?? 'x'); p.append('line_qty', l.qty ?? '1'); p.append('line_rate', l.rate ?? '5.00');
    p.append('line_service', ''); p.append('line_est', l.est ?? ''); p.append('line_bill', l.bill ?? ''); p.append('line_class', l.cls ? String(l.cls) : '');
    p.append('line_time', l.time ? String(l.time) : '');
  }
  return p;
}
const pay = (customerId, amount, apply = {}, more = {}) => new URLSearchParams({ type: 'payment', customer_id: String(customerId), txn_date: TODAY, amount,
  payment_method: 'Check', ...Object.fromEntries(Object.entries(apply).map(([id, x]) => [`apply_${id}`, x])), ...more });
function vdoc({ type = 'bill', vendor, cats = [], items = [], extra = [], ...rest }) {
  const p = new URLSearchParams({ type, vendor_id: vendor ? String(vendor) : '', txn_date: TODAY, ...rest });
  for (const c of cats) {
    p.append('cat_account', String(c.account)); p.append('cat_desc', c.desc ?? ''); p.append('cat_amount', c.amount ?? '5.00'); p.append('cat_job', c.job ?? '');
    p.append('cat_po', c.po ?? ''); p.append('cat_billable', c.billable ? '1' : ''); p.append('cat_class', c.cls ? String(c.cls) : '');
  }
  for (const i of items) {
    p.append('item_item', String(i.item)); p.append('item_desc', i.desc ?? ''); p.append('item_qty', i.qty ?? '1'); p.append('item_rate', i.rate ?? '5.00');
    p.append('item_job', i.job ?? ''); p.append('item_po', i.po ?? ''); p.append('item_billable', i.billable ? '1' : ''); p.append('item_class', i.cls ? String(i.cls) : '');
  }
  for (const [k, v] of extra) p.append(k, v);
  return p;
}
function je(lines, more = {}, extra = []) {
  const p = new URLSearchParams({ txn_date: TODAY, memo: 'Cross-company attempt', ...more });
  for (const l of lines) {
    p.append('je_account', String(l.account)); p.append('je_debit', l.debit ?? ''); p.append('je_credit', l.credit ?? '');
    p.append('je_desc', ''); p.append('je_party', l.party ?? ''); p.append('je_class', l.cls ? String(l.cls) : '');
  }
  for (const [k, v] of extra) p.append(k, v);
  return p;
}
const params = (obj, extra = []) => { const p = new URLSearchParams(obj); for (const [k, v] of extra) p.append(k, v); return p; };
const upload = async (path, fields) => {
  const fd = new FormData();
  fd.set('csrf', app.csrf);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set('file', new Blob([Buffer.from('%PDF-1.4 cross company')]), 'cross.pdf');
  return app.raw(path, { method: 'POST', body: fd });
};
const ACCOUNTING = { fiscalStartMonth: '1', method: 'accrual', dateFormat: 'mdy', showAccountNumbers: '1', classesOn: '1', classMode: 'line', locationsOn: '1',
  locationLabel: 'Location', billableOn: '1', billableMarkup: '', autoApplyCustomer: '', autoApplyVendor: '', warnDuplicateBills: '' };
const reconcileBoxes = html => [...html.matchAll(/name="ids" value="(\d+)" data-amount="(-?\d+)"/g)].map(m => ({ id: Number(m[1]), amount: Number(m[2]) }));
const beginningOf = html => Number(/data-beginning="(-?\d+)"/.exec(html)?.[1] ?? 0);
const money = cents => (cents / 100).toFixed(2);

// ---- company B's whole footprint: every row that belongs to B, hashed per table ----
const B_ROWS = {
  txn: 'SELECT t::text FROM txn t WHERE t.entity_id = $1',
  txn_line: 'SELECT l::text FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id WHERE t.entity_id = $1',
  txn_tag: 'SELECT g::text FROM txn_tag g JOIN txn t ON t.txn_id = g.txn_id WHERE t.entity_id = $1',
  posting: 'SELECT p::text FROM posting p WHERE p.entity_id = $1 OR p.txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)',
  application: `SELECT a::text FROM application a WHERE a.credit_txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)
                 OR a.charge_txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1) OR a.via_txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)`,
  deposit_line: `SELECT d::text FROM deposit_line d WHERE d.deposit_txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)
                  OR d.source_txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)`,
  customer: 'SELECT c::text FROM customer c WHERE c.entity_id = $1',
  vendor: 'SELECT v::text FROM vendor v WHERE v.entity_id = $1',
  item: 'SELECT i::text FROM item i WHERE i.entity_id = $1',
  account: 'SELECT a::text FROM account a WHERE a.entity_id = $1',
  terms: 'SELECT t::text FROM terms t WHERE t.entity_id = $1',
  class: 'SELECT c::text FROM class c WHERE c.entity_id = $1',
  location: 'SELECT l::text FROM location l WHERE l.entity_id = $1',
  tag: 'SELECT t::text FROM tag t WHERE t.entity_id = $1',
  tag_group: 'SELECT g::text FROM tag_group g WHERE g.entity_id = $1',
  project: 'SELECT p::text FROM project p JOIN customer c ON c.customer_id = p.customer_id WHERE c.entity_id = $1',
  budget: 'SELECT b::text FROM budget b WHERE b.entity_id = $1',
  budget_line: 'SELECT l::text FROM budget_line l JOIN budget b ON b.budget_id = l.budget_id WHERE b.entity_id = $1',
  price_rule: 'SELECT r::text FROM price_rule r WHERE r.entity_id = $1',
  recurring_template: 'SELECT r::text FROM recurring_template r WHERE r.entity_id = $1',
  recurring_template_line: 'SELECT l::text FROM recurring_template_line l JOIN recurring_template r ON r.template_id = l.template_id WHERE r.entity_id = $1',
  statement: 'SELECT s::text FROM statement s WHERE s.entity_id = $1 OR s.customer_id IN (SELECT customer_id FROM customer WHERE entity_id = $1)',
  document: `SELECT d::text FROM document d WHERE d.customer_id IN (SELECT customer_id FROM customer WHERE entity_id = $1)
              OR d.vendor_id IN (SELECT vendor_id FROM vendor WHERE entity_id = $1) OR d.txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)`,
  time_entry: 'SELECT e::text FROM time_entry e WHERE e.entity_id = $1',
  reconciliation: 'SELECT r::text FROM reconciliation r WHERE r.entity_id = $1 OR r.account_id IN (SELECT account_id FROM account WHERE entity_id = $1)',
  reconciled_item: `SELECT i::text FROM reconciled_item i WHERE i.rec_id IN (SELECT rec_id FROM reconciliation WHERE entity_id = $1)
                     OR i.txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1) OR i.account_id IN (SELECT account_id FROM account WHERE entity_id = $1)`,
  message: `SELECT m::text FROM message m WHERE m.customer_id IN (SELECT customer_id FROM customer WHERE entity_id = $1)
             OR m.vendor_id IN (SELECT vendor_id FROM vendor WHERE entity_id = $1) OR m.related_txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)`,
  activity_event: `SELECT e::text FROM activity_event e WHERE e.customer_id IN (SELECT customer_id FROM customer WHERE entity_id = $1)
                    OR e.vendor_id IN (SELECT vendor_id FROM vendor WHERE entity_id = $1) OR e.txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)`,
  invoice_reminder: 'SELECT r::text FROM invoice_reminder r WHERE r.txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)',
  invoice_pay_link: 'SELECT l::text FROM invoice_pay_link l WHERE l.txn_id IN (SELECT txn_id FROM txn WHERE entity_id = $1)',
  vendor_info_request: 'SELECT r::text FROM vendor_info_request r WHERE r.entity_id = $1 OR r.vendor_id IN (SELECT vendor_id FROM vendor WHERE entity_id = $1)',
  settings: `SELECT x FROM (SELECT s::text FROM accounting_settings s WHERE s.entity_id = $1 UNION ALL SELECT s::text FROM sales_settings s WHERE s.entity_id = $1
              UNION ALL SELECT s::text FROM bill_settings s WHERE s.entity_id = $1) q(x)`,
};
async function footprintB() {
  const out = {};
  for (const [k, sql] of Object.entries(B_ROWS)) {
    out[k] = (await one(`SELECT count(*)::int || ':' || md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h FROM (${sql}) q(x)`, [B.entityId])).h;
  }
  return out;
}

// ---- every reference between two records that would cross from one company into another ----
const ent = { // entity of a txn / customer / vendor / account / item / class / location / tag / project
  txn: x => `(SELECT entity_id FROM txn WHERE txn_id = ${x})`, customer: x => `(SELECT entity_id FROM customer WHERE customer_id = ${x})`,
  vendor: x => `(SELECT entity_id FROM vendor WHERE vendor_id = ${x})`, account: x => `(SELECT entity_id FROM account WHERE account_id = ${x})`,
  item: x => `(SELECT entity_id FROM item WHERE item_id = ${x})`, class: x => `(SELECT entity_id FROM class WHERE class_id = ${x})`,
  location: x => `(SELECT entity_id FROM location WHERE location_id = ${x})`, tag: x => `(SELECT entity_id FROM tag WHERE tag_id = ${x})`,
  terms: x => `(SELECT entity_id FROM terms WHERE terms_id = ${x})`, template: x => `(SELECT entity_id FROM recurring_template WHERE template_id = ${x})`,
  project: x => `(SELECT pc.entity_id FROM project pj JOIN customer pc ON pc.customer_id = pj.customer_id WHERE pj.project_id = ${x})`,
  reconciliation: x => `(SELECT entity_id FROM reconciliation WHERE rec_id = ${x})`, budget: x => `(SELECT entity_id FROM budget WHERE budget_id = ${x})`,
  taggroup: x => `(SELECT entity_id FROM tag_group WHERE group_id = ${x})`,
};
// [name, table alias + from, left entity expr, right entity expr, where the reference is set]
const CROSS = [
  ['txn→customer', 'txn t', 't.entity_id', ent.customer('t.customer_id'), 't.customer_id'],
  ['txn→vendor', 'txn t', 't.entity_id', ent.vendor('t.vendor_id'), 't.vendor_id'],
  ['txn→account', 'txn t', 't.entity_id', ent.account('t.account_id'), 't.account_id'],
  ['txn→to_account', 'txn t', 't.entity_id', ent.account('t.to_account_id'), 't.to_account_id'],
  ['txn→scheduled_account', 'txn t', 't.entity_id', ent.account('t.scheduled_account_id'), 't.scheduled_account_id'],
  ['txn→terms', 'txn t', 't.entity_id', ent.terms('t.terms_id'), 't.terms_id'],
  ['txn→project', 'txn t', 't.entity_id', ent.project('t.project_id'), 't.project_id'],
  ['txn→class', 'txn t', 't.entity_id', ent.class('t.class_id'), 't.class_id'],
  ['txn→location', 'txn t', 't.entity_id', ent.location('t.location_id'), 't.location_id'],
  ['txn→source_txn', 'txn t', 't.entity_id', ent.txn('t.source_txn_id'), 't.source_txn_id'],
  ['txn→deposit_for_txn', 'txn t', 't.entity_id', ent.txn('t.deposit_for_txn_id'), 't.deposit_for_txn_id'],
  ['txn→reverses_txn', 'txn t', 't.entity_id', ent.txn('t.reverses_txn_id'), 't.reverses_txn_id'],
  ['txn→recurring_template', 'txn t', 't.entity_id', ent.template('t.recurring_template_id'), 't.recurring_template_id'],
  ['txn_tag→tag', 'txn_tag g', ent.txn('g.txn_id'), ent.tag('g.tag_id'), 'g.tag_id'],
  ['txn_line→item', 'txn_line l', ent.txn('l.txn_id'), ent.item('l.item_id'), 'l.item_id'],
  ['txn_line→account', 'txn_line l', ent.txn('l.txn_id'), ent.account('l.account_id'), 'l.account_id'],
  ['txn_line→class', 'txn_line l', ent.txn('l.txn_id'), ent.class('l.class_id'), 'l.class_id'],
  ['txn_line→project', 'txn_line l', ent.txn('l.txn_id'), ent.project('l.project_id'), 'l.project_id'],
  ['txn_line→customer', 'txn_line l', ent.txn('l.txn_id'), ent.customer('l.customer_id'), 'l.customer_id'],
  ['txn_line→vendor', 'txn_line l', ent.txn('l.txn_id'), ent.vendor('l.vendor_id'), 'l.vendor_id'],
  ['txn_line→po', 'txn_line l', ent.txn('l.txn_id'), ent.txn('l.po_txn_id'), 'l.po_txn_id'],
  ['txn_line→estimate', 'txn_line l', ent.txn('l.txn_id'), ent.txn('l.estimate_txn_id'), 'l.estimate_txn_id'],
  ['txn_line→billable_txn', 'txn_line l', ent.txn('l.txn_id'), ent.txn('l.billable_txn_id'), 'l.billable_txn_id'],
  ['txn_line→time_entry', 'txn_line l', ent.txn('l.txn_id'), '(SELECT entity_id FROM time_entry WHERE entry_id = l.time_entry_id)', 'l.time_entry_id'],
  ['posting→txn', 'posting p', 'p.entity_id', ent.txn('p.txn_id'), 'p.txn_id'],
  ['posting→account', 'posting p', 'p.entity_id', ent.account('p.account_id'), 'p.account_id'],
  ['posting→customer', 'posting p', 'p.entity_id', ent.customer('p.customer_id'), 'p.customer_id'],
  ['posting→vendor', 'posting p', 'p.entity_id', ent.vendor('p.vendor_id'), 'p.vendor_id'],
  ['posting→class', 'posting p', 'p.entity_id', ent.class('p.class_id'), 'p.class_id'],
  ['posting→location', 'posting p', 'p.entity_id', ent.location('p.location_id'), 'p.location_id'],
  ['posting→item', 'posting p', 'p.entity_id', ent.item('p.item_id'), 'p.item_id'],
  ['posting→project', 'posting p', 'p.entity_id', ent.project('p.project_id'), 'p.project_id'],
  ['application credit→charge', 'application x', ent.txn('x.credit_txn_id'), ent.txn('x.charge_txn_id'), 'x.charge_txn_id'],
  ['application credit→via', 'application x', ent.txn('x.credit_txn_id'), ent.txn('x.via_txn_id'), 'x.via_txn_id'],
  ['deposit_line→source_txn', 'deposit_line d', ent.txn('d.deposit_txn_id'), ent.txn('d.source_txn_id'), 'd.source_txn_id'],
  ['deposit_line→account', 'deposit_line d', ent.txn('d.deposit_txn_id'), ent.account('d.account_id'), 'd.account_id'],
  ['deposit_line→customer', 'deposit_line d', ent.txn('d.deposit_txn_id'), ent.customer('d.customer_id'), 'd.customer_id'],
  ['time_entry→customer', 'time_entry e', 'e.entity_id', ent.customer('e.customer_id'), 'e.customer_id'],
  ['time_entry→project', 'time_entry e', 'e.entity_id', ent.project('e.project_id'), 'e.project_id'],
  ['time_entry→item', 'time_entry e', 'e.entity_id', ent.item('e.item_id'), 'e.item_id'],
  ['budget_line→account', 'budget_line l', ent.budget('l.budget_id'), ent.account('l.account_id'), 'l.account_id'],
  ['budget_line→class split', 'budget_line l JOIN budget bb ON bb.budget_id = l.budget_id AND bb.subdivide = \'class\'', 'bb.entity_id', ent.class('l.dim_id'), 'nullif(l.dim_id, 0)'],
  ['budget_line→location split', 'budget_line l JOIN budget bb ON bb.budget_id = l.budget_id AND bb.subdivide = \'location\'', 'bb.entity_id', ent.location('l.dim_id'), 'nullif(l.dim_id, 0)'],
  ['budget_line→customer split', 'budget_line l JOIN budget bb ON bb.budget_id = l.budget_id AND bb.subdivide = \'customer\'', 'bb.entity_id', ent.customer('l.dim_id'), 'nullif(l.dim_id, 0)'],
  ['price_rule→customer', 'price_rule r CROSS JOIN LATERAL unnest(r.customer_ids) AS u(id)', 'r.entity_id', ent.customer('u.id'), 'u.id'],
  ['price_rule→item', 'price_rule r CROSS JOIN LATERAL unnest(r.item_ids) AS u(id)', 'r.entity_id', ent.item('u.id'), 'u.id'],
  ['recurring_template→customer', 'recurring_template r', 'r.entity_id', ent.customer('r.customer_id'), 'r.customer_id'],
  ['recurring_template→vendor', 'recurring_template r', 'r.entity_id', ent.vendor('r.vendor_id'), 'r.vendor_id'],
  ['recurring_template→account', 'recurring_template r', 'r.entity_id', ent.account('r.account_id'), 'r.account_id'],
  ['recurring_template→terms', 'recurring_template r', 'r.entity_id', ent.terms('r.terms_id'), 'r.terms_id'],
  ['recurring_template_line→item', 'recurring_template_line l', ent.template('l.template_id'), ent.item('l.item_id'), 'l.item_id'],
  ['recurring_template_line→account', 'recurring_template_line l', ent.template('l.template_id'), ent.account('l.account_id'), 'l.account_id'],
  ['recurring_template_line→customer', 'recurring_template_line l', ent.template('l.template_id'), ent.customer('l.customer_id'), 'l.customer_id'],
  ['recurring_template_line→project', 'recurring_template_line l', ent.template('l.template_id'), ent.project('l.project_id'), 'l.project_id'],
  ['statement→customer', 'statement s', 's.entity_id', ent.customer('s.customer_id'), 's.customer_id'],
  ['document customer→txn', 'document d', ent.customer('d.customer_id'), ent.txn('d.txn_id'), 'CASE WHEN d.customer_id IS NOT NULL THEN d.txn_id END'],
  ['document vendor→txn', 'document d', ent.vendor('d.vendor_id'), ent.txn('d.txn_id'), 'CASE WHEN d.vendor_id IS NOT NULL THEN d.txn_id END'],
  ['project→customer of its txns', 'txn t JOIN project p ON p.project_id = t.project_id', 't.entity_id', ent.customer('p.customer_id'), 'p.customer_id'],
  ['customer→parent', 'customer c', 'c.entity_id', ent.customer('c.parent_customer_id'), 'c.parent_customer_id'],
  ['customer→terms', 'customer c', 'c.entity_id', ent.terms('c.terms_id'), 'c.terms_id'],
  ['vendor→terms', 'vendor v', 'v.entity_id', ent.terms('v.terms_id'), 'v.terms_id'],
  ['vendor→default_expense_account', 'vendor v', 'v.entity_id', ent.account('v.default_expense_account_id'), 'v.default_expense_account_id'],
  ['item→income_account', 'item i', 'i.entity_id', ent.account('i.income_account_id'), 'i.income_account_id'],
  ['item→expense_account', 'item i', 'i.entity_id', ent.account('i.expense_account_id'), 'i.expense_account_id'],
  ['item→asset_account', 'item i', 'i.entity_id', ent.account('i.asset_account_id'), 'i.asset_account_id'],
  ['account→parent', 'account x', 'x.entity_id', ent.account('x.parent_id'), 'x.parent_id'],
  ['class→parent', 'class c', 'c.entity_id', ent.class('c.parent_id'), 'c.parent_id'],
  ['tag→group', 'tag g', 'g.entity_id', ent.taggroup('g.group_id'), 'g.group_id'],
  ['accounting_settings→billable_income_account', 'accounting_settings s', 's.entity_id', ent.account('s.billable_income_account_id'), 's.billable_income_account_id'],
  ['sales_settings→default_terms', 'sales_settings s', 's.entity_id', ent.terms('s.default_terms_id'), 's.default_terms_id'],
  ['reconciliation→account', 'reconciliation r', 'r.entity_id', ent.account('r.account_id'), 'r.account_id'],
  ['reconciled_item→txn', 'reconciled_item i', ent.reconciliation('i.rec_id'), ent.txn('i.txn_id'), 'i.txn_id'],
  ['reconciled_item→account', 'reconciled_item i', ent.reconciliation('i.rec_id'), ent.account('i.account_id'), 'i.account_id'],
  ['message customer→txn', 'message m', ent.customer('m.customer_id'), ent.txn('m.related_txn_id'), 'CASE WHEN m.customer_id IS NOT NULL THEN m.related_txn_id END'],
  ['message vendor→txn', 'message m', ent.vendor('m.vendor_id'), ent.txn('m.related_txn_id'), 'CASE WHEN m.vendor_id IS NOT NULL THEN m.related_txn_id END'],
  ['activity customer→txn', 'activity_event e', ent.customer('e.customer_id'), ent.txn('e.txn_id'), 'CASE WHEN e.customer_id IS NOT NULL THEN e.txn_id END'],
  ['activity vendor→txn', 'activity_event e', ent.vendor('e.vendor_id'), ent.txn('e.txn_id'), 'CASE WHEN e.vendor_id IS NOT NULL THEN e.txn_id END'],
  ['vendor_info_request→vendor', 'vendor_info_request r', 'r.entity_id', ent.vendor('r.vendor_id'), 'r.vendor_id'],
  ['late_fee_charge source→fee', 'late_fee_charge f', ent.txn('f.source_txn_id'), ent.txn('f.fee_txn_id'), 'f.fee_txn_id'],
];
async function crossRefs() {
  const sql = CROSS.map(([name, from, left, right, ref], i) =>
    `(SELECT count(*)::int FROM ${from} WHERE ${ref} IS NOT NULL AND ${left} IS DISTINCT FROM ${right}) AS c${i}`).join(',\n');
  let row;
  try { row = await one(`SELECT ${sql}`); } catch (error) {
    for (const [name, from, left, right, ref] of CROSS) {
      try { await one(`SELECT count(*)::int FROM ${from} WHERE ${ref} IS NOT NULL AND ${left} IS DISTINCT FROM ${right}`); } catch (e) { throw new Error(`${name}: ${e.message}`); }
    }
    throw error;
  }
  return Object.fromEntries(CROSS.map(([name], i) => [name, row[`c${i}`]]).filter(([, n]) => n > 0));
}

before(async () => {
  app = await startApp({ mailer, env: { SETTINGS_KEY: 'ef'.repeat(32) } });
  pool = app.db.pool;
  A = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  const s = generateSample({ asOf: TODAY, seed: 7 });
  const zz = x => `Zeta ${x}`;
  s.entity = { ...s.entity, name: 'Second Ranch Supply' };
  for (const c of s.customers) { c.display_name = zz(c.display_name); c.company_name = c.company_name && zz(c.company_name); c.email = c.email && `zeta.${c.email}`; }
  for (const v of s.vendors) { v.display_name = zz(v.display_name); v.company_name = v.company_name && zz(v.company_name); v.email = v.email && `zeta.${v.email}`; }
  for (const i of s.items) i.name = zz(i.name);
  for (const x of s.accounts) x.name = zz(x.name);
  for (const i of s.inventory?.items ?? []) i.name = zz(i.name);
  for (const t of s.txns) t.memo = t.memo && zz(t.memo);
  b = await writeSample(pool, s, { addCompany: true });
  B = { orgId: b.orgId, entityId: b.entityId };
  assert.equal(B.orgId, A.orgId);
  assert.notEqual(B.entityId, A.entityId);

  // ---- company A: classes, locations and billable expenses on; its own records the attacks pair with B's ----
  const acctA = app.ids.accounts;
  await ok303(await app.post('/settings/accounting', { ...ACCOUNTING, billableIncomeAccountId: String(acctA.delivery_income) }), 'A accounting');
  await ok303(await app.post('/settings/classes', { name: 'A Retail' }), 'A class');
  await ok303(await app.post('/settings/locations', { name: 'A Yard' }), 'A location');
  Object.assign(a, {
    cust: app.ids.customers.hilltop, cust2: app.ids.customers.redriver, vendor: app.ids.vendors.mill, item: app.ids.items.hay, checking: acctA.checking,
    savings: acctA.savings, card: acctA.card, office: acctA.office, income: acctA.feed_sales, cogs: acctA.feed_purchases,
    class: (await one(`SELECT class_id FROM class WHERE entity_id = $1 AND name = 'A Retail'`, [A.entityId])).class_id,
  });
  a.invItem = (await one(`SELECT item_id FROM item WHERE entity_id = $1 AND kind = 'inventory' ORDER BY item_id LIMIT 1`, [A.entityId])).item_id;
  a.inv = (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'invoice' AND open_cents > 0 AND voided_at IS NULL AND customer_id = $2 ORDER BY txn_id LIMIT 1`,
    [A.entityId, a.cust]))?.txn_id;
  assert.ok(a.inv, 'A has an open invoice');
  a.bill = (await one(`SELECT txn_id, vendor_id FROM txn WHERE entity_id = $1 AND type = 'bill' AND open_cents > 0 AND voided_at IS NULL ORDER BY txn_id LIMIT 1`, [A.entityId]));
  await ok303(await app.post('/txns', sales('credit_memo', a.cust, [{ rate: '20.00' }])), 'A credit memo');
  a.cm = (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'credit_memo' AND open_cents > 0 ORDER BY txn_id DESC LIMIT 1`, [A.entityId])).txn_id;
  await ok303(await app.post('/txns', pay(a.cust, '15.00')), 'A unapplied payment');
  a.pay = (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'payment' AND customer_id = $2 ORDER BY txn_id DESC LIMIT 1`, [A.entityId, a.cust])).txn_id;
  a.budgetClass = idIn(await ok303(await app.post('/budgets', { name: 'A by class', fiscalYear: '2027', subdivide: 'class', startFrom: 'blank' }), 'A budget'), /\/budgets\/(\d+)/, 'A budget');
  a.budgetCust = idIn(await ok303(await app.post('/budgets', { name: 'A by customer', fiscalYear: '2027', subdivide: 'customer', startFrom: 'blank' }), 'A budget 2'), /\/budgets\/(\d+)/, 'A budget 2');
  a.budgetLoc = idIn(await ok303(await app.post('/budgets', { name: 'A by location', fiscalYear: '2027', subdivide: 'location', startFrom: 'blank' }), 'A budget 3'), /\/budgets\/(\d+)/, 'A budget 3');
  a.budget = idIn(await ok303(await app.post('/budgets', { name: 'A plain', fiscalYear: '2027', subdivide: 'none', startFrom: 'blank' }), 'A budget 4'), /\/budgets\/(\d+)/, 'A budget 4');
  a.project = idIn(await ok303(await app.post(`/customers/${a.cust}/projects`, { name: 'A barn', status: 'in_progress', startDate: TODAY, endDate: '', description: '' }), 'A project'),
    /\/projects\/(\d+)/, 'A project');

  // ---- company B: the same kinds of records, made through the app while working in B ----
  await switchTo(B);
  const acctB = b.accounts;
  Object.assign(z, {
    cust: b.customers.hilltop, cust2: b.customers.redriver, vendor: b.vendors.mill, item: b.items.hay, checking: acctB.checking, savings: acctB.savings,
    card: acctB.card, expense: acctB.office, income: acctB.feed_sales, terms: b.terms.net30, unusedTerms: b.terms.due,
  });
  z.invItem = (await one(`SELECT item_id FROM item WHERE entity_id = $1 AND kind = 'inventory' ORDER BY item_id LIMIT 1`, [B.entityId])).item_id;
  z.inventoryAcct = (await one(`SELECT account_id FROM account WHERE entity_id = $1 AND type = 'inventory' ORDER BY account_id LIMIT 1`, [B.entityId])).account_id;
  await ok303(await app.post('/settings/accounting', { ...ACCOUNTING, billableIncomeAccountId: String(acctB.delivery_income) }), 'B accounting');
  await ok303(await app.post('/settings/classes', { name: 'Zeta Class' }), 'B class');
  await ok303(await app.post('/settings/locations', { name: 'Zeta Yard' }), 'B location');
  await ok303(await app.post('/settings/tags', { name: 'Zeta Promo', newGroup: 'Zeta Campaign' }), 'B tag');
  z.class = (await one(`SELECT class_id FROM class WHERE name = 'Zeta Class'`)).class_id;
  z.location = (await one(`SELECT location_id FROM location WHERE name = 'Zeta Yard'`)).location_id;
  z.tag = (await one(`SELECT tag_id, group_id FROM tag WHERE name = 'Zeta Promo'`)).tag_id;
  z.tagGroup = (await one(`SELECT group_id FROM tag WHERE name = 'Zeta Promo'`)).group_id;
  z.project = idIn(await ok303(await app.post(`/customers/${z.cust}/projects`, { name: 'Zeta barn', status: 'in_progress', startDate: TODAY, endDate: '', description: '' }), 'B project'),
    /\/projects\/(\d+)/, 'B project');
  const newestB = async (type, more = '') => (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = $2 ${more} ORDER BY txn_id DESC LIMIT 1`, [B.entityId, type])).txn_id;
  await ok303(await app.post('/txns', sales('estimate', z.cust, [{ item: z.item, rate: '40.00' }, { desc: 'Zeta labor', rate: '10.00' }], { project_id: String(z.project) })), 'B estimate');
  z.est = await newestB('estimate');
  await ok303(await app.post('/txns', sales('credit_memo', z.cust, [{ desc: 'Zeta credit', rate: '25.00' }])), 'B credit memo');
  z.cm = await newestB('credit_memo');
  await ok303(await app.post('/txns', pay(z.cust, '12.00')), 'B unapplied payment');
  z.pay = await newestB('payment');
  await ok303(await app.post('/txns', sales('invoice', z.cust, [{ desc: 'Zeta open invoice', rate: '80.00' }], { project_id: String(z.project) })), 'B invoice');
  z.inv = await newestB('invoice');
  z.bill = (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'bill' AND open_cents > 0 AND voided_at IS NULL ORDER BY txn_id LIMIT 1`, [B.entityId])).txn_id;
  z.bill2 = (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'bill' AND open_cents > 0 AND voided_at IS NULL ORDER BY txn_id LIMIT 1 OFFSET 1`, [B.entityId])).txn_id;
  z.vc = await newestB('vendor_credit', 'AND open_cents > 0');
  z.po = await newestB('purchase_order');
  z.ir = await newestB('item_receipt');
  z.check = await newestB('check');
  z.deposit = await newestB('deposit');
  z.expenseTxn = await newestB('expense');
  await ok303(await app.post('/vtxns', vdoc({ vendor: z.vendor, doc_number: 'Z-BILLABLE', cats: [{ account: z.expense, amount: '30.00', job: `c:${z.cust}`, billable: true }] })), 'B billable bill');
  z.billable = await newestB('bill');
  const billPage = await (await app.get('/settings/bills')).text();
  const nextCheck = /name="nextCheckNumber"[^>]*value="(\d+)"/.exec(billPage)?.[1] ?? /value="(\d+)"[^>]*name="nextCheckNumber"/.exec(billPage)?.[1] ?? '5000';
  await ok303(await app.post('/settings/bills', { requireApproval: '1', nextCheckNumber: nextCheck }), 'B approval on');
  await ok303(await app.post('/vtxns', vdoc({ vendor: z.vendor, doc_number: 'Z-PENDING', cats: [{ account: z.expense, amount: '44.00' }] })), 'B pending bill');
  z.pending = await newestB('bill');
  await ok303(await app.post('/journal', je([{ account: z.expense, debit: '9' }, { account: z.checking, credit: '9' }])), 'B journal entry');
  z.je = await newestB('journal_entry');
  await ok303(await app.post('/transfers', { from_account: String(z.checking), to_account: String(z.savings), amount: '7.00', txn_date: TODAY, memo: '' }), 'B transfer');
  z.transfer = await newestB('transfer');
  const tpl = params({ name: 'Zeta monthly', txnType: 'invoice', mode: 'scheduled', unit: 'month', count: '1', startDate: TODAY, endDate: '', termsId: '', memo: '' },
    [['line_item', String(z.item)], ['line_desc', 'Zeta hay'], ['line_qty', '1'], ['line_rate', '10']]);
  await ok303(await app.post(`/customers/${z.cust}/recurring`, tpl), 'B template');
  z.template = (await one(`SELECT template_id FROM recurring_template WHERE entity_id = $1 AND customer_id IS NOT NULL`, [B.entityId])).template_id;
  await ok303(await app.post(`/vendors/${z.vendor}/recurring`, vdoc({ vendor: z.vendor, cats: [{ account: z.expense, amount: '11.00' }],
    name: 'Zeta rent', txnType: 'bill', mode: 'scheduled', unit: 'month', count: '1', startDate: TODAY, endDate: '', termsId: '', accountId: '', memo: '' })), 'B vendor template');
  z.vtemplate = (await one(`SELECT template_id FROM recurring_template WHERE entity_id = $1 AND vendor_id IS NOT NULL`, [B.entityId])).template_id;
  await ok303(await app.post(`/customers/${z.cust}/statements`, { kind: 'open_item', statementDate: TODAY, startDate: '2022-01-01', endDate: TODAY, action: 'save' }), 'B statement');
  z.statement = (await one(`SELECT statement_id FROM statement WHERE customer_id = $1`, [z.cust])).statement_id;
  await ok303(await upload(`/customers/${z.cust}/documents`, { txn_id: String(z.inv), note: 'Zeta doc' }), 'B customer document');
  z.doc = (await one(`SELECT document_id FROM document WHERE customer_id = $1`, [z.cust])).document_id;
  await ok303(await upload(`/vendors/${z.vendor}/documents`, { txn_id: String(z.billable), note: 'Zeta W-9' }), 'B vendor document');
  z.vdoc = (await one(`SELECT document_id FROM document WHERE vendor_id = $1`, [z.vendor])).document_id;
  await ok303(await app.post('/time', { date: TODAY, job: `p:${z.project}`, item_id: String(z.item), hours: '2', billable: '1', notes: 'Zeta fencing' }), 'B time');
  z.time = (await one(`SELECT entry_id FROM time_entry WHERE entity_id = $1`, [B.entityId])).entry_id;
  z.budget = idIn(await ok303(await app.post('/budgets', { name: 'Zeta plan', fiscalYear: '2027', subdivide: 'none', startFrom: 'blank' }), 'B budget'), /\/budgets\/(\d+)/, 'B budget');
  await ok303(await app.post(`/budgets/${z.budget}`, { [`c_${z.expense}_1`]: '100.00' }), 'B budget amounts');
  await ok303(await app.post('/settings/price-rules', params({ name: 'Zeta wholesale', kind: 'percent_off', percentOff: '10', startDate: '2026-01-01', endDate: '2026-12-31', active: '1' },
    [['customerIds', String(z.cust)], ['itemIds', String(z.item)]])), 'B price rule');
  z.rule = (await one(`SELECT rule_id FROM price_rule WHERE entity_id = $1`, [B.entityId])).rule_id;
  // A finished reconciliation of B's savings account (so there is one to undo), clearing everything through today.
  const recStart = await (await app.get(`/reconcile/start?account=${z.savings}&date=${TODAY}`)).text();
  const boxes = reconcileBoxes(recStart);
  await ok303(await app.post(`/reconcile/${z.savings}`, params({ statement_date: TODAY, ending: money(beginningOf(recStart) + boxes.reduce((x, y) => x + y.amount, 0)) },
    boxes.map(x => ['ids', String(x.id)]))), 'B reconciliation');
  z.recAcct = z.savings;
  // B's checking account: what is waiting to clear there (the attacks try to clear it from A).
  const bCheckStart = await (await app.get(`/reconcile/start?account=${z.checking}&date=${TODAY}`)).text();
  z.checkingBoxes = reconcileBoxes(bCheckStart).slice(0, 5);
  z.checkingBeginning = beginningOf(bCheckStart);
  await switchTo(A);
  const aCheckStart = await (await app.get(`/reconcile/start?account=${a.checking}&date=${TODAY}`)).text();
  a.checkingBeginning = beginningOf(aCheckStart);
  for (const [k, v] of Object.entries({ ...z })) if (!['checkingBoxes', 'checkingBeginning'].includes(k)) assert.ok(v, `company B ${k} was set up`);
  assert.ok(z.checkingBoxes.length > 0, 'B has checking transactions waiting to clear');
});

after(async () => {
  for (const scope of [A, B]) {
    const c = await ledgerCheck(pool, scope);
    assert.ok(c.balanced && c.arMatches && c.apMatches && c.inventoryMatches, JSON.stringify(c));
  }
  await app.close();
});

// Each attack: [what, path, body (URLSearchParams | object | () => Promise<Response>)].
function attacks() {
  const P = (path, body = {}) => () => app.post(path, body);
  const zBoxes = z.checkingBoxes, zSum = zBoxes.reduce((x, y) => x + y.amount, 0);
  const recBody = (ending, ids) => params({ statement_date: TODAY, ending: money(ending) }, ids.map(id => ['ids', String(id)]));
  return [
    // ---- sales forms: lines and header fields pointing at B ----
    ['invoice line with B’s class', P('/txns', sales('invoice', a.cust, [{ cls: z.class }]))],
    ['invoice with B’s class (whole transaction)', P('/txns', sales('invoice', a.cust, [{}], { class_id: String(z.class) }))],
    ['invoice with B’s location', P('/txns', sales('invoice', a.cust, [{}], { location_id: String(z.location) }))],
    ['invoice with B’s tag', P('/txns', sales('invoice', a.cust, [{}], { tags_shown: '1', tag_ids: String(z.tag) }))],
    ['invoice for B’s project', P('/txns', sales('invoice', a.cust, [{}], { project_id: String(z.project) }))],
    ['invoice from B’s estimate', P('/txns', sales('invoice', a.cust, [{ desc: 'Zeta labor', est: '2', rate: '10.00' }], { estimate_id: String(z.est) }))],
    ['invoice billing B’s billable expense', P('/txns', sales('invoice', a.cust, [{ desc: 'Billable', rate: '30.00', bill: `${z.billable}:1` }]))],
    ['invoice billing B’s time', P('/txns', sales('invoice', a.cust, [{ desc: 'Time', qty: '2', rate: '5.00', time: z.time }]))],
    ['invoice billing B’s billable expense for B’s customer', P('/txns', sales('invoice', z.cust, [{ desc: 'Billable', rate: '30.00', bill: `${z.billable}:1` }]))],
    ['sales receipt deposited to B’s bank', P('/txns', sales('sales_receipt', a.cust, [{}], { payment_method: 'Cash', deposit_to: String(z.checking) }))],
    ['sales receipt with B’s item, class and project', P('/txns', sales('sales_receipt', a.cust, [{ item: z.item, cls: z.class }], { payment_method: 'Cash', project_id: String(z.project) }))],
    ['sales receipt for B’s project', P('/txns', sales('sales_receipt', a.cust, [{}], { payment_method: 'Cash', project_id: String(z.project) }))],
    ['sales receipt line with B’s class', P('/txns', sales('sales_receipt', a.cust, [{ cls: z.class }], { payment_method: 'Cash' }))],
    ['sales receipt with B’s tag', P('/txns', sales('sales_receipt', a.cust, [{}], { payment_method: 'Cash', tags_shown: '1', tag_ids: String(z.tag) }))],
    ['credit memo line with B’s class', P('/txns', sales('credit_memo', a.cust, [{ cls: z.class }]))],
    ['credit memo with B’s location', P('/txns', sales('credit_memo', a.cust, [{}], { location_id: String(z.location) }))],
    ['estimate for B’s project', P('/txns', sales('estimate', a.cust, [{}], { project_id: String(z.project) }))],
    ['estimate line with B’s class', P('/txns', sales('estimate', a.cust, [{ cls: z.class }]))],
    ['A’s invoice edited onto B’s project', P(`/txns/${a.inv}`, sales('invoice', a.cust, [{}], { project_id: String(z.project) }))],
    ['A’s invoice edited with B’s terms', P(`/txns/${a.inv}`, sales('invoice', a.cust, [{}], { terms_id: String(z.terms) }))],
    ['sales receipt with B’s location and tag', P('/txns', sales('sales_receipt', a.cust, [{}], { payment_method: 'Cash', location_id: String(z.location), tags_shown: '1', tag_ids: String(z.tag) }))],
    ['credit memo with B’s item and class', P('/txns', sales('credit_memo', a.cust, [{ item: z.item, cls: z.class }]))],
    ['credit memo for B’s project and location', P('/txns', sales('credit_memo', a.cust, [{}], { project_id: String(z.project), location_id: String(z.location) }))],
    ['credit memo for B’s customer', P('/txns', sales('credit_memo', z.cust, [{}]))],
    ['estimate with B’s item, class, project, tag', P('/txns', sales('estimate', a.cust, [{ item: z.item, cls: z.class }], { project_id: String(z.project), tags_shown: '1', tag_ids: String(z.tag) }))],
    ['estimate for B’s customer', P('/txns', sales('estimate', z.cust, [{}]))],
    ['sales receipt for B’s customer', P('/txns', sales('sales_receipt', z.cust, [{}], { payment_method: 'Cash' }))],
    ['A’s invoice edited onto B’s customer', P(`/txns/${a.inv}`, sales('invoice', z.cust, [{}]))],
    ['A’s invoice edited with B’s item, class, project', P(`/txns/${a.inv}`, sales('invoice', a.cust, [{ item: z.item, cls: z.class }], { project_id: String(z.project) }))],
    // ---- payments and credits ----
    ['payment for B’s customer', P('/txns', pay(z.cust, '3.00'))],
    ['payment for B’s customer applied to B’s invoice', P('/txns', pay(z.cust, '3.00', { [z.inv]: '3.00' }))],
    ['A’s payment edited to apply to B’s invoice', P(`/txns/${a.pay}`, pay(a.cust, '15.00', { [z.inv]: '5.00' }))],
    ['A’s payment edited onto B’s customer', P(`/txns/${a.pay}`, pay(z.cust, '15.00'))],
    ['A’s unapplied payment applied to B’s invoice', P(`/txns/${a.pay}/apply`, { [`apply_${z.inv}`]: '5.00' })],
    ['A’s credit memo applied to B’s invoice', P(`/txns/${a.cm}/apply`, { [`apply_${z.inv}`]: '5.00' })],
    ['B’s credit memo applied to A’s invoice', P(`/txns/${z.cm}/apply`, { [`apply_${a.inv}`]: '5.00' })],
    // ---- bank deposits ----
    ['deposit of B’s undeposited payment into A’s bank', P('/deposits', params({ account_id: String(a.checking), txn_date: TODAY, memo: '' }, [['source', String(z.pay)]]))],
    ['deposit of A’s payment into B’s bank', P('/deposits', params({ account_id: String(z.checking), txn_date: TODAY, memo: '' }, [['source', String(a.pay)]]))],
    ['deposit with a line to B’s income account', P('/deposits', params({ account_id: String(a.checking), txn_date: TODAY, memo: '' },
      [['other_account', String(z.income)], ['other_customer', ''], ['other_desc', 'x'], ['other_amount', '4.00']]))],
    ['deposit with a line for B’s customer', P('/deposits', params({ account_id: String(a.checking), txn_date: TODAY, memo: '' },
      [['other_account', String(a.income)], ['other_customer', String(z.cust)], ['other_desc', 'x'], ['other_amount', '4.00']]))],
    ['B’s deposit deleted', P(`/deposits/${z.deposit}/delete`)],
    // ---- paying bills ----
    ['pay B’s bill from A’s bank', P('/pay-bills', params({ account_id: String(a.checking), txn_date: TODAY, method: 'ACH', check_no: '', memo: '', [`pay_${z.bill}`]: '1.00' }, [['bill', String(z.bill)]]))],
    ['pay A’s bill from B’s bank', P('/pay-bills', params({ account_id: String(z.checking), txn_date: TODAY, method: 'ACH', check_no: '', memo: '', [`pay_${a.bill.txn_id}`]: '1.00' },
      [['bill', String(a.bill.txn_id)]]))],
    ['vendor credit applied to B’s bill', P('/pay-bills', params({ account_id: String(a.checking), txn_date: TODAY, method: 'ACH', check_no: '', memo: '', [`pay_${z.bill}`]: '0',
      [`credit_${z.bill}`]: '1.00' }, [['bill', String(z.bill)]]))],
    ['B’s bill marked paid', P(`/vtxns/${z.bill}/mark-paid`, { account_id: String(a.checking) })],
    ['A’s bill marked paid from B’s bank', P(`/vtxns/${a.bill.txn_id}/mark-paid`, { account_id: String(z.checking) })],
    ['B’s bill scheduled for payment', P(`/vtxns/${z.bill}/schedule`, { pay_date: TODAY, account_id: String(a.checking), method: 'ACH' })],
    ['A’s bill scheduled from B’s bank', P(`/vtxns/${a.bill.txn_id}/schedule`, { pay_date: '2026-10-20', account_id: String(z.checking), method: 'ACH' })],
    ['B’s scheduled payment canceled', P(`/vtxns/${z.bill}/unschedule`)],
    // ---- vendor documents with B's things ----
    ['bill with B’s item', P('/vtxns', vdoc({ vendor: a.vendor, items: [{ item: z.item }] }))],
    ['bill billable to B’s customer', P('/vtxns', vdoc({ vendor: a.vendor, cats: [{ account: a.office, job: `c:${z.cust}`, billable: true }] }))],
    ['bill for B’s project', P('/vtxns', vdoc({ vendor: a.vendor, cats: [{ account: a.office, job: `p:${z.project}` }] }))],
    ['bill item line for B’s project', P('/vtxns', vdoc({ vendor: a.vendor, items: [{ item: a.item, job: `p:${z.project}`, billable: true }] }))],
    ['bill line with B’s class', P('/vtxns', vdoc({ vendor: a.vendor, cats: [{ account: a.office, cls: z.class }] }))],
    ['bill with B’s class, location, tag', P('/vtxns', vdoc({ vendor: a.vendor, cats: [{ account: a.office }], class_id: String(z.class), location_id: String(z.location),
      tags_shown: '1', tag_ids: String(z.tag) }))],
    ['bill with B’s location', P('/vtxns', vdoc({ vendor: a.vendor, cats: [{ account: a.office }], location_id: String(z.location) }))],
    ['bill with B’s tag', P('/vtxns', vdoc({ vendor: a.vendor, cats: [{ account: a.office }], tags_shown: '1', tag_ids: String(z.tag) }))],
    ['bill item line with B’s class', P('/vtxns', vdoc({ vendor: a.vendor, items: [{ item: a.item, cls: z.class }] }))],
    ['bill with B’s terms', P('/vtxns', vdoc({ vendor: a.vendor, cats: [{ account: a.office }], terms_id: String(z.terms) }))],
    ['bill receiving B’s purchase order', P('/vtxns', vdoc({ vendor: a.vendor, items: [{ item: a.item, po: `${z.po}:1` }] }))],
    ['bill receiving B’s purchase order (category line)', P('/vtxns', vdoc({ vendor: a.vendor, cats: [{ account: a.office, po: `${z.po}:1` }] }))],
    ['item receipt against B’s purchase order', P('/vtxns', vdoc({ type: 'item_receipt', vendor: a.vendor, items: [{ item: a.item, po: `${z.po}:1` }] }))],
    ['expense with B’s item and class', P('/vtxns', vdoc({ type: 'expense', vendor: a.vendor, account_id: String(a.checking), payment_method: 'Debit card', items: [{ item: z.item, cls: z.class }] }))],
    ['expense billable to B’s customer', P('/vtxns', vdoc({ type: 'expense', vendor: a.vendor, account_id: String(a.checking), payment_method: 'Debit card',
      cats: [{ account: a.office, job: `c:${z.cust}`, billable: true }] }))],
    ['check from B’s bank', P('/vtxns', vdoc({ type: 'check', vendor: a.vendor, account_id: String(z.checking), payment_method: 'Check', cats: [{ account: a.office }] }))],
    ['check for B’s vendor', P('/vtxns', vdoc({ type: 'check', vendor: z.vendor, account_id: String(a.checking), payment_method: 'Check', cats: [{ account: a.office }] }))],
    ['check with B’s item and project', P('/vtxns', vdoc({ type: 'check', vendor: a.vendor, account_id: String(a.checking), payment_method: 'Check',
      items: [{ item: z.item, job: `p:${z.project}` }] }))],
    ['vendor credit with B’s item', P('/vtxns', vdoc({ type: 'vendor_credit', vendor: a.vendor, items: [{ item: z.item }] }))],
    ['vendor credit for B’s vendor', P('/vtxns', vdoc({ type: 'vendor_credit', vendor: z.vendor, cats: [{ account: a.office }] }))],
    ['purchase order with B’s item for B’s customer', P('/vtxns', vdoc({ type: 'purchase_order', vendor: a.vendor, items: [{ item: z.item, job: `c:${z.cust}` }] }))],
    ['purchase order for B’s vendor', P('/vtxns', vdoc({ type: 'purchase_order', vendor: z.vendor, items: [{ item: a.item }] }))],
    ['A’s bill edited onto B’s vendor', P(`/vtxns/${a.bill.txn_id}`, vdoc({ vendor: z.vendor, cats: [{ account: a.office }] }))],
    ['A’s bill edited with B’s account', P(`/vtxns/${a.bill.txn_id}`, vdoc({ vendor: a.bill.vendor_id, cats: [{ account: z.expense }] }))],
    ['A’s bill edited with B’s item', P(`/vtxns/${a.bill.txn_id}`, vdoc({ vendor: a.bill.vendor_id, items: [{ item: z.item }] }))],
    ['A’s bill edited with B’s project', P(`/vtxns/${a.bill.txn_id}`, vdoc({ vendor: a.bill.vendor_id, cats: [{ account: a.office, job: `p:${z.project}` }] }))],
    ['A’s bill edited with B’s class', P(`/vtxns/${a.bill.txn_id}`, vdoc({ vendor: a.bill.vendor_id, cats: [{ account: a.office, cls: z.class }] }))],
    ['A’s bill edited billable to B’s customer', P(`/vtxns/${a.bill.txn_id}`, vdoc({ vendor: a.bill.vendor_id, cats: [{ account: a.office, job: `c:${z.cust}`, billable: true }] }))],
    // ---- B's vendor transactions acted on ----
    ['B’s purchase order closed', P(`/vtxns/${z.po}/close`)],
    ['B’s purchase order reopened', P(`/vtxns/${z.po}/reopen`)],
    ['B’s purchase order emailed', P(`/vtxns/${z.po}/email`)],
    ['B’s item receipt converted to a bill', P(`/vtxns/${z.ir}/convert`, { txn_date: TODAY, doc_number: 'HIJACK' })],
    ['B’s bill approved', P(`/vtxns/${z.pending}/approve`)],
    ['B’s bill rejected', P(`/vtxns/${z.pending}/reject`, { reason: 'Hijack' })],
    ['B’s bill edited', P(`/vtxns/${z.bill}`, vdoc({ vendor: a.vendor, cats: [{ account: a.office }] }))],
    ['B’s bill voided', P(`/vtxns/${z.bill}/void`)],
    ['B’s bill deleted', P(`/vtxns/${z.bill2}/delete`)],
    ['B’s purchase order voided', P(`/vtxns/${z.po}/void`)],
    ['B’s purchase order deleted', P(`/vtxns/${z.po}/delete`)],
    ['B’s item receipt deleted', P(`/vtxns/${z.ir}/delete`)],
    ['B’s check marked printed', P(`/vtxns/${z.check}/printed`)],
    ['B’s check marked printed from the checks list', P('/checks/printed', { ids: String(z.check) })],
    ['B’s expense voided', P(`/vtxns/${z.expenseTxn}/void`)],
    ['batch approve B’s bill', P('/vtxns/batch', params({ action: 'approve', back: `/vendors/${a.vendor}?tab=transactions` }, [['ids', String(z.pending)]]))],
    ['batch delete B’s bills', P('/vtxns/batch', params({ action: 'delete', back: `/vendors/${a.vendor}?tab=transactions` }, [['ids', String(z.bill2)], ['ids', String(z.vc)]]))],
    // ---- B's vendors ----
    ['B’s vendor edited', P(`/vendors/${z.vendor}`, { displayName: 'Hijacked vendor' })],
    ['B’s vendor made inactive', P(`/vendors/${z.vendor}/inactive`)],
    ['B’s vendor bank details confirmed', P(`/vendors/${z.vendor}/bank-verified`)],
    ['batch inactive B’s vendor', P('/vendors/batch', params({ action: 'inactive' }, [['ids', String(z.vendor)]]))],
    ['batch email B’s vendor', P('/vendors/email', params({ subject: 'Hijack', body: 'Hello' }, [['ids', String(z.vendor)]]))],
    ['A vendor merged into B’s vendor', P(`/vendors/${a.vendor}/merge`, { into: String(z.vendor) })],
    ['B’s vendor merged into A’s vendor', P(`/vendors/${z.vendor}/merge`, { into: String(a.vendor) })],
    ['B’s vendor asked for info', P(`/vendors/${z.vendor}/ask`)],
    ['A vendor given B’s terms', P(`/vendors/${a.vendor}`, { displayName: 'Mill (attempt)', termsId: String(z.terms) })],
    ['A vendor given B’s default expense account', P(`/vendors/${a.vendor}`, { displayName: 'Mill (attempt)', defaultExpenseAccountId: String(z.expense) })],
    ['new vendor with B’s terms', P('/vendors', { displayName: 'Cross Vendor', termsId: String(z.terms) })],
    ['new vendor with B’s default expense account', P('/vendors', { displayName: 'Cross Vendor 2', defaultExpenseAccountId: String(z.expense) })],
    ['recurring bill on B’s vendor', P(`/vendors/${z.vendor}/recurring`, vdoc({ vendor: z.vendor, cats: [{ account: a.office }], name: 'Hijack', txnType: 'bill', mode: 'scheduled',
      unit: 'month', count: '1', startDate: TODAY, endDate: '', termsId: '', accountId: '', memo: '' }))],
    ...[['B’s terms', { cats: [{ account: a.office }], termsId: String(z.terms) }], ['B’s account', { cats: [{ account: z.expense }] }],
      ['B’s item', { items: [{ item: z.item }] }], ['B’s customer', { cats: [{ account: a.office, job: `c:${z.cust}` }] }],
      ['B’s project', { items: [{ item: a.item, job: `p:${z.project}` }] }]].map(([label, x]) => [`recurring bill with ${label}`,
      P(`/vendors/${a.vendor}/recurring`, vdoc({ vendor: a.vendor, name: `Cross bill ${label}`, txnType: 'bill', mode: 'scheduled', unit: 'month', count: '1',
        startDate: TODAY, endDate: '', termsId: '', accountId: '', memo: '', ...x }))]),
    ['recurring expense paid from B’s bank', P(`/vendors/${a.vendor}/recurring`, vdoc({ vendor: a.vendor, cats: [{ account: a.office }], name: 'Cross expense', txnType: 'expense',
      mode: 'scheduled', unit: 'month', count: '1', startDate: TODAY, endDate: '', termsId: '', accountId: String(z.checking), memo: '' }))],
    ['B’s recurring bill edited', P(`/vrecurring/${z.vtemplate}`, vdoc({ vendor: a.vendor, cats: [{ account: a.office }], name: 'Hijack', txnType: 'bill', mode: 'scheduled',
      unit: 'month', count: '1', startDate: TODAY, endDate: '', termsId: '', accountId: '', memo: '' }))],
    ['B’s recurring bill paused', P(`/vrecurring/${z.vtemplate}/pause`)],
    ['B’s recurring bill deleted', P(`/vrecurring/${z.vtemplate}/delete`)],
    // ---- B's customer transactions acted on ----
    ['B’s invoice edited', P(`/txns/${z.inv}`, sales('invoice', a.cust, [{}]))],
    ['B’s invoice voided', P(`/txns/${z.inv}/void`)],
    ['B’s invoice deleted', P(`/txns/${z.inv}/delete`)],
    ['B’s invoice sent', P(`/txns/${z.inv}/send`)],
    ['B’s invoice reminder', P(`/txns/${z.inv}/reminder`)],
    ['B’s invoice shared', P(`/txns/${z.inv}/share`)],
    ['B’s estimate status changed', P(`/txns/${z.est}/status`, { status: 'accepted' })],
    ['B’s payment edited', P(`/txns/${z.pay}`, pay(a.cust, '1.00'))],
    ['B’s credit memo voided', P(`/txns/${z.cm}/void`)],
    ['batch delete of B’s invoice from A’s customer', P(`/customers/${a.cust}/batch`, params({ action: 'delete', confirmed: '1' }, [['ids', String(z.inv)]]))],
    ['batch send of B’s invoice from A’s customer', P(`/customers/${a.cust}/batch`, params({ action: 'send' }, [['ids', String(z.inv)]]))],
    ['batch reminder of B’s invoice from A’s customer', P(`/customers/${a.cust}/batch`, params({ action: 'reminder' }, [['ids', String(z.inv)]]))],
    ['batch on B’s customer page', P(`/customers/${z.cust}/batch`, params({ action: 'delete', confirmed: '1' }, [['ids', String(z.inv)]]))],
    // ---- B's customers ----
    ['B’s customer late fees turned off', P(`/customers/${z.cust}/late-fees`, { enabled: '0' })],
    ['email to B’s customer', P(`/customers/${z.cust}/messages`, { to: 'x@example.com', subject: 'Hijack', body: 'Hello' })],
    ['reply logged on B’s customer', P(`/customers/${z.cust}/messages`, { action: 'reply', from: 'x@example.com', subject: 'Hijack', body: 'Hello' })],
    ['sub-customer of B’s customer', P('/customers', { displayName: 'Cross Sub', firstName: '', creditLimit: '', isSub: '1', parentCustomerId: String(z.cust),
      shippingSameAsBilling: '1', active: '1' })],
    ['A customer moved under B’s customer', P(`/customers/${a.cust2}`, { displayName: 'Red River (attempt)', firstName: '', creditLimit: '', isSub: '1',
      parentCustomerId: String(z.cust), shippingSameAsBilling: '1', active: '1' })],
    ['A customer given B’s terms', P(`/customers/${a.cust2}`, { displayName: 'Red River (attempt 2)', termsId: String(z.terms), shippingSameAsBilling: '1', active: '1' })],
    ['B’s customer merged into A’s customer', P(`/customers/${z.cust2}/merge`, { into: String(a.cust) })],
    // ---- time ----
    ['time for B’s customer', P('/time', { date: TODAY, job: `c:${z.cust}`, item_id: '', hours: '1', billable: '1', notes: 'Cross' })],
    ['time for B’s project', P('/time', { date: TODAY, job: `p:${z.project}`, item_id: '', hours: '1', billable: '1', notes: 'Cross' })],
    ['time with B’s service item', P('/time', { date: TODAY, job: `c:${a.cust}`, item_id: String(z.item), hours: '1', billable: '1', notes: 'Cross' })],
    ['B’s time entry edited', P(`/time/${z.time}`, { date: TODAY, job: `c:${a.cust}`, item_id: '', hours: '3', billable: '', notes: 'Hijack' })],
    ['B’s time entry deleted', P(`/time/${z.time}/delete`)],
    ['timesheet with B’s customer, project and item', P('/time/week', params({ monday: '2026-10-12' }, [['ts_job', `c:${z.cust}`], ['ts_item', String(z.item)], ['ts_billable', '1'],
      ['ts_d0', '1'], ['ts_d1', ''], ['ts_d2', ''], ['ts_d3', ''], ['ts_d4', ''], ['ts_d5', ''], ['ts_d6', ''],
      ['ts_job', `p:${z.project}`], ['ts_item', ''], ['ts_billable', ''], ['ts_d0', '2'], ['ts_d1', ''], ['ts_d2', ''], ['ts_d3', ''], ['ts_d4', ''], ['ts_d5', ''], ['ts_d6', '']]))],
    // ---- budgets ----
    ['A’s budget with amounts for B’s accounts', P(`/budgets/${a.budget}`, { [`c_${z.expense}_1`]: '50.00', [`c_${z.income}_2`]: '60.00' })],
    ['A’s class budget split by B’s class', P(`/budgets/${a.budgetClass}?dim=${z.class}`, { [`c_${a.office}_1`]: '50.00' })],
    ['A’s location budget split by B’s location', P(`/budgets/${a.budgetLoc}?dim=${z.location}`, { [`c_${a.office}_1`]: '50.00' })],
    ['A’s customer budget split by B’s customer', P(`/budgets/${a.budgetCust}?dim=${z.cust}`, { [`c_${a.office}_1`]: '50.00' })],
    ['B’s budget amounts saved', P(`/budgets/${z.budget}`, { [`c_${a.office}_1`]: '70.00', [`c_${z.expense}_1`]: '1.00' })],
    ['B’s budget deleted', P(`/budgets/${z.budget}/delete`)],
    // ---- price rules ----
    ['price rule for B’s customer and item', P('/settings/price-rules', params({ name: 'Cross rule', kind: 'percent_off', percentOff: '10', startDate: '', endDate: '', active: '1' },
      [['customerIds', String(z.cust)], ['itemIds', String(z.item)]]))],
    ['price rule mixing A’s and B’s', P('/settings/price-rules', params({ name: 'Mixed rule', kind: 'percent_off', percentOff: '10', startDate: '', endDate: '', active: '1' },
      [['customerIds', String(a.cust)], ['customerIds', String(z.cust)], ['itemIds', String(a.item)], ['itemIds', String(z.item)]]))],
    ['B’s price rule edited', P(`/settings/price-rules/${z.rule}`, params({ name: 'Hijack', kind: 'percent_off', percentOff: '50', startDate: '', endDate: '', active: '1' }))],
    ['B’s price rule deleted', P(`/settings/price-rules/${z.rule}/delete`)],
    // ---- recurring sales templates ----
    ['recurring invoice with B’s item and terms', P(`/customers/${a.cust}/recurring`, params({ name: 'Cross template', txnType: 'invoice', mode: 'scheduled', unit: 'month', count: '1',
      startDate: TODAY, endDate: '', termsId: String(z.terms), memo: '' }, [['line_item', String(z.item)], ['line_desc', 'x'], ['line_qty', '1'], ['line_rate', '5']]))],
    ['recurring invoice on B’s customer', P(`/customers/${z.cust}/recurring`, params({ name: 'Hijack template', txnType: 'invoice', mode: 'scheduled', unit: 'month', count: '1',
      startDate: TODAY, endDate: '', termsId: '', memo: '' }, [['line_item', ''], ['line_desc', 'x'], ['line_qty', '1'], ['line_rate', '5']]))],
    ['B’s recurring template edited', P(`/recurring/${z.template}`, params({ name: 'Hijack', txnType: 'invoice', mode: 'scheduled', unit: 'month', count: '1',
      startDate: TODAY, endDate: '', termsId: '', memo: '' }, [['line_item', String(a.item)], ['line_desc', 'x'], ['line_qty', '1'], ['line_rate', '5']]))],
    ['B’s recurring template paused', P(`/recurring/${z.template}/pause`)],
    ['B’s recurring template resumed', P(`/recurring/${z.template}/resume`)],
    ['B’s recurring template deleted', P(`/recurring/${z.template}/delete`)],
    // ---- statements ----
    ['statement for B’s customer', P(`/customers/${z.cust}/statements`, { kind: 'open_item', statementDate: TODAY, startDate: '2022-01-01', endDate: TODAY, action: 'send' })],
    ['B’s statement sent', P(`/statements/${z.statement}/send`)],
    // ---- documents ----
    ['document on A’s customer attached to B’s invoice', () => upload(`/customers/${a.cust}/documents`, { txn_id: String(z.inv), note: '' })],
    ['document uploaded to B’s customer', () => upload(`/customers/${z.cust}/documents`, { txn_id: '', note: '' })],
    ['document on A’s vendor attached to B’s bill', () => upload(`/vendors/${a.vendor}/documents`, { txn_id: String(z.bill), note: '' })],
    ['document uploaded to B’s vendor', () => upload(`/vendors/${z.vendor}/documents`, { txn_id: '', note: '' })],
    ['B’s customer document deleted', P(`/documents/${z.doc}/delete`)],
    ['B’s vendor document deleted', P(`/documents/${z.vdoc}/delete`)],
    // ---- projects ----
    ['project on B’s customer', P(`/customers/${z.cust}/projects`, { name: 'Hijack project', status: 'in_progress', startDate: TODAY, endDate: '', description: '' })],
    ['project on A’s customer named like B’s', P(`/customers/${a.cust}/projects`, { name: 'Zeta barn', status: 'in_progress', startDate: TODAY, endDate: '', description: '' })],
    ['B’s project edited', P(`/projects/${z.project}`, { name: 'Hijacked', status: 'completed', startDate: TODAY, endDate: '', description: '' })],
    ['B’s project deleted', P(`/projects/${z.project}/delete`)],
    // ---- journal entries, transfers, card payments ----
    ['journal entry naming B’s vendor', P('/journal', je([{ account: a.office, debit: '5', party: `v:${z.vendor}` }, { account: a.checking, credit: '5' }]))],
    ['journal entry naming B’s customer', P('/journal', je([{ account: a.office, debit: '5' }, { account: a.income, credit: '5', party: `c:${z.cust}` }]))],
    ['journal entry line with B’s class', P('/journal', je([{ account: a.office, debit: '5', cls: z.class }, { account: a.checking, credit: '5' }]))],
    ['journal entry with B’s location', P('/journal', je([{ account: a.office, debit: '5' }, { account: a.checking, credit: '5' }], { location_id: String(z.location) }))],
    ['journal entry with B’s tag', P('/journal', je([{ account: a.office, debit: '5' }, { account: a.checking, credit: '5' }], { tags_shown: '1' }, [['tag_ids', String(z.tag)]]))],
    ['journal entry mixing A’s and B’s accounts', P('/journal', je([{ account: a.office, debit: '5' }, { account: z.checking, credit: '5' }]))],
    ['B’s journal entry edited', P(`/journal/${z.je}`, je([{ account: a.office, debit: '5' }, { account: a.checking, credit: '5' }]))],
    ['transfer into B’s bank', P('/transfers', { txn_date: TODAY, from_account: String(a.checking), to_account: String(z.savings), amount: '5.00', memo: '' })],
    ['transfer with B’s class', P('/transfers', { txn_date: TODAY, from_account: String(a.checking), to_account: String(a.savings), amount: '5.00', memo: '', class_id: String(z.class) })],
    ['transfer with B’s location', P('/transfers', { txn_date: TODAY, from_account: String(a.checking), to_account: String(a.savings), amount: '5.00', memo: '', location_id: String(z.location) })],
    ['transfer with B’s tag', P('/transfers', { txn_date: TODAY, from_account: String(a.checking), to_account: String(a.savings), amount: '5.00', memo: '', tags_shown: '1', tag_ids: String(z.tag) })],
    ['transfer out of B’s bank', P('/transfers', { txn_date: TODAY, from_account: String(z.checking), to_account: String(a.savings), amount: '5.00', memo: '' })],
    ['B’s transfer edited', P(`/transfers/${z.transfer}`, { txn_date: TODAY, from_account: String(a.checking), to_account: String(a.savings), amount: '5.00', memo: '' })],
    ['card payment to B’s card', P('/card-payments', { txn_date: TODAY, from_account: String(a.checking), to_account: String(z.card), amount: '5.00', memo: '' })],
    ['card payment from B’s bank', P('/card-payments', { txn_date: TODAY, from_account: String(z.checking), to_account: String(a.card), amount: '5.00', memo: '' })],
    ['B’s journal entry voided', P(`/ledger/${z.je}/void`)],
    ['B’s transfer deleted', P(`/ledger/${z.transfer}/delete`)],
    // ---- reconcile ----
    ['A’s reconciliation clearing B’s transactions', P(`/reconcile/${a.checking}`, recBody(a.checkingBeginning + zSum, zBoxes.map(x => x.id)))],
    ['reconciling B’s bank', P(`/reconcile/${z.checking}`, recBody(z.checkingBeginning + zSum, zBoxes.map(x => x.id)))],
    ['B’s reconciliation undone', P(`/reconcile/${z.recAcct}/undo`)],
    // ---- settings and lists ----
    ['B’s terms renamed', P(`/settings/terms/${z.terms}`, { name: 'Hijacked terms', dueDays: '9' })],
    ['B’s terms deleted', P(`/settings/terms/${z.unusedTerms}/delete`)],
    ['new item with B’s income account', P('/settings/items', { name: 'Cross service', kind: 'service', rate: '1', active: '1', incomeAccountId: String(z.income) })],
    ['new item with B’s expense account', P('/settings/items', { name: 'Cross service 2', kind: 'service', rate: '1', active: '1', incomeAccountId: String(a.income),
      expenseAccountId: String(z.expense), cost: '1' })],
    ['new inventory item with B’s asset account', P('/settings/items', { name: 'Cross stock', kind: 'inventory', rate: '1', active: '1', incomeAccountId: String(a.income),
      expenseAccountId: String(a.cogs), assetAccountId: String(z.inventoryAcct), cost: '1', startQty: '1', asOf: TODAY })],
    ['A’s item given B’s income account', P(`/settings/items/${a.item}`, { name: 'Hay (attempt)', kind: 'service', rate: '1', active: '1', incomeAccountId: String(z.income) })],
    ['A’s item given B’s expense account', P(`/settings/items/${a.item}`, { name: 'Hay (attempt 2)', kind: 'service', rate: '1', active: '1', incomeAccountId: String(a.income),
      expenseAccountId: String(z.expense) })],
    ['B’s inventory quantity adjusted', P(`/settings/items/${z.invItem}/adjust`, { txn_date: TODAY, newQty: '1', accountId: '', memo: 'Hijack' })],
    ['A’s inventory adjusted to B’s account', P(`/settings/items/${a.invItem}/adjust`, { txn_date: TODAY, newQty: '3', accountId: String(z.expense), memo: 'Cross' })],
    ['B’s account deleted', P(`/settings/accounts/${z.expense}/delete`)],
    ['B’s account edited', P(`/settings/accounts/${z.expense}/edit`, { name: 'Hijacked account', type: 'expense', active: '1' })],
    ['new account under B’s parent', P('/settings/accounts', { name: 'Cross sub-account', type: 'expense', parentId: String(z.expense), active: '1' })],
    ['B’s class renamed', P(`/settings/classes/${z.class}`, { name: 'Hijacked class', active: '1' })],
    ['new class under B’s class', P('/settings/classes', { name: 'Cross class', parentId: String(z.class) })],
    ['B’s location renamed', P(`/settings/locations/${z.location}`, { name: 'Hijacked location', active: '1' })],
    ['B’s tag deleted', P(`/settings/tags/${z.tag}/delete`)],
    ['new tag in B’s tag group', P('/settings/tags', { name: 'Cross tag', groupId: String(z.tagGroup) })],
    ['sales settings with B’s default terms', P('/settings/sales', { defaultTermsId: String(z.terms), defaultDelivery: 'none', customNumbers: '1', statementKind: 'balance_forward' })],
    ['accounting settings with B’s billable income account', P('/settings/accounting', { ...ACCOUNTING, billableIncomeAccountId: String(z.income) })],
  ];
}

test('the starting books have no cross-company references', async () => {
  assert.deepEqual(await crossRefs(), {});
});

test('every write path, aimed at company B from company A, leaves B untouched and A clean', async t => {
  for (const [what, run] of attacks()) {
    await t.test(what, async () => {
      const before = await footprintB();
      const crossBefore = await crossRefs();
      const res = await run();
      if (res.body) await res.arrayBuffer();
      const afterB = await footprintB();
      const changed = Object.keys(before).filter(k => before[k] !== afterB[k]);
      // Only what this attempt added (a leak from an earlier attempt is reported there, and in the broad check at the end).
      const crossAfter = await crossRefs();
      const cross = Object.fromEntries(Object.entries(crossAfter).filter(([k, n]) => n > (crossBefore[k] ?? 0)));
      assert.notEqual(res.status, 500, `${what}: server error`);
      assert.deepEqual(changed, [], `${what} (HTTP ${res.status} → ${loc(res)}) changed company B’s ${changed.join(', ')}`);
      assert.deepEqual(cross, {}, `${what} (HTTP ${res.status}) left company A referencing company B`);
    });
  }
});

test('broad check: no record anywhere points across companies', async () => {
  const cross = await crossRefs();
  assert.deepEqual(cross, {}, `cross-company references: ${JSON.stringify(cross)}`);
  // Mail went only to company A's people (B's addresses all start "zeta.").
  assert.deepEqual(sent.filter(m => /zeta\./.test(String(m.to))).map(m => m.subject), [], 'nothing was emailed to company B’s customers or vendors');
});
