import { createHash } from 'node:crypto';
import { TYPE_LABEL } from '../domain/ledger.js';

// Bank review v2, stage BR-2: the payee and category pickers. Each page carries one shared list of each (an HTML
// <datalist>: type to filter, works without JavaScript and stays small with thousands of vendors); a row or form sends the
// chosen text back and it is resolved here. What's typed is only ever text — never an internal id or raw key — and it
// resolves only when exactly one record fits it now. A record answers to its name and to every form of its label the list
// can give it ("Name (vendor)", "Name (vendor #12)", "6100 Fuel", …), whatever the list looked like when the page was shown,
// so a record added or renamed since can only make the text ambiguous (refused), never quietly mean someone else.

// Expense-side accounts first for money out, income first for money in; then the rest of the chart.
const OUT_FIRST = ['expense', 'cost_of_goods_sold', 'other_expense', 'other_current_asset', 'fixed_asset', 'other_asset', 'credit_card', 'bank',
  'other_current_liability', 'long_term_liability', 'equity', 'income', 'other_income'];
const IN_FIRST = ['income', 'other_income', 'other_current_asset', 'bank', 'credit_card', 'other_current_liability', 'long_term_liability', 'equity',
  'fixed_asset', 'other_asset', 'expense', 'cost_of_goods_sold', 'other_expense'];

const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// Gives each record the first of its forms (forms(r): its name first, then longer labels, the last one unique to it) that
// no other record answers to and no record already shows; if none is free, the last form with a mark added until it is.
// Each record answers to all its forms (r.forms) and its value.
function uniqueValues(records, forms) {
  const owners = new Map();
  for (const r of records) {
    r.forms = forms(r);
    for (const f of r.forms) owners.set(norm(f), [...(owners.get(norm(f)) ?? []), r]);
  }
  const shown = new Set();
  const free = (r, f) => !shown.has(norm(f)) && (owners.get(norm(f)) ?? []).every(o => o === r);
  for (const r of records) {
    let value = r.forms.find(f => free(r, f));
    for (let n = 2; !value; n++) if (free(r, `${r.forms[r.forms.length - 1]} (${n})`)) value = `${r.forms[r.forms.length - 1]} (${n})`;
    r.value = value;
    shown.add(norm(value));
  }
  return records;
}
// The records the text could mean: those answering to it by any of their forms or their value.
const fitting = (records, text) => records.filter(r => norm(r.value) === text || r.forms.some(f => norm(f) === text));

// Accounts a bank line can be categorized to: active, not A/R, A/P or Undeposited Funds (those go through their own
// workflows). label: what the picker shows beside the value — type, number, "Sub of" the parent. value: the name, or with
// its number (or more) when another account answers to the name.
export async function categoryChoices(db, { orgId, entityId }) {
  const { rows } = await db.query(`
    SELECT a.account_id, a.name, a.number, a.type, a.system_key, p.name AS parent_name
      FROM account a LEFT JOIN account p ON p.account_id = a.parent_id
     WHERE a.org_id = $1 AND a.entity_id = $2 AND a.active AND (a.system_key IS NULL OR a.system_key NOT IN ('ar', 'ap', 'undeposited'))
     ORDER BY lower(a.name), a.account_id`, [orgId, entityId]);
  const list = rows.map(a => ({ id: Number(a.account_id), name: a.name, number: a.number ?? null, type: a.type,
    label: [TYPE_LABEL[a.type] ?? a.type, a.number ? `#${a.number}` : null, a.parent_name ? `Sub of ${a.parent_name}` : null].filter(Boolean).join(' · ') }));
  return uniqueValues(list, a => [a.name, ...(a.number ? [`${a.number} ${a.name}`] : []), `${a.name} (${a.label})`, `${a.name} (account ${a.id})`]);
}
export const orderFor = (choices, out) => {
  const order = out ? OUT_FIRST : IN_FIRST;
  return [...choices].sort((a, b) => (order.indexOf(a.type) + 1 || 99) - (order.indexOf(b.type) + 1 || 99) || a.name.localeCompare(b.name));
};

// Vendors and customers. value: the name, or "Name (vendor)" / "Name (customer)", then with its number, when another
// record answers to the name.
export async function payeeChoices(db, { orgId, entityId }) {
  const { rows } = await db.query(`
    SELECT 'v:' || vendor_id AS key, display_name AS name, 'Vendor' AS kind FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active
    UNION ALL
    SELECT 'c:' || customer_id, display_name, 'Customer' FROM customer WHERE org_id = $1 AND entity_id = $2 AND active
    ORDER BY 2, 3, 1`, [orgId, entityId]);
  return payeeValues(rows);
}
export const payeeValues = rows => uniqueValues(rows.map(r => ({ ...r })),
  r => [r.name, `${r.name} (${r.kind.toLowerCase()})`, `${r.name} (${r.kind.toLowerCase()} #${r.key.slice(2)})`]);

// A typed category: any form of exactly one account's label. null when blank; { error } when no account, or more than one,
// answers to it.
export function resolveCategory(choices, text) {
  const t = norm(text);
  if (!t) return null;
  const hit = fitting(choices, t);
  if (hit.length === 1) return { id: hit[0].id };
  return hit.length ? { error: `More than one account fits “${String(text).trim()}”. Pick it from the list.` }
    : { error: `No account called “${String(text).trim()}”. Pick one from the list, or add it in the chart of accounts.`, none: true };
}
// A typed payee: any form of exactly one vendor's or customer's label. null when blank; { key } for one record;
// { unknown: name } when nothing answers to it (the row offers to create it); { error } when more than one does — even a
// vendor and a customer with the same name: the list shows which is which.
export function resolvePayee(choices, text) {
  const t = norm(text);
  if (!t) return null;
  const hit = fitting(choices, t);
  if (hit.length === 1) return { key: hit[0].key };
  if (!hit.length) return { unknown: String(text).trim() };
  return { error: `More than one vendor or customer fits “${String(text).trim()}”. Pick one from the list (it says which is the vendor and which the customer).` };
}
// ---- what a page offered ----
// A page keeps a snapshot of each picker list it showed (pickerSnapshot → its hash, carried by the form); on submit the text is
// resolved against that list (atSnapshot), so it means the record the person saw, wherever its name has gone since. Text the
// list didn't offer is resolved against the list as it is now.

const idOf = (kind, r) => (kind === 'payee' ? r.key : r.id);
export async function pickerSnapshot(db, { orgId, entityId, kind, choices }) {
  const records = choices.map(r => [idOf(kind, r), r.value, r.forms]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 32);
  // Each use refreshes it; only lists no page has shown for 60 days are dropped (never one a page is being shown with now).
  await db.query(`INSERT INTO bank_picker_snapshot (org_id, entity_id, kind, hash, records) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (entity_id, kind, hash) DO UPDATE SET used_at = now()`, [orgId, entityId, kind, hash, JSON.stringify(records)]);
  await db.query(`DELETE FROM bank_picker_snapshot WHERE entity_id = $1 AND used_at < now() - interval '60 days'`, [entityId]);
  return hash;
}
export async function snapshotChoices(db, { orgId, entityId, kind, hash }) {
  if (!/^[0-9a-f]{32}$/.test(String(hash ?? ''))) return null;
  const { rows: [s] } = await db.query('SELECT records FROM bank_picker_snapshot WHERE org_id = $1 AND entity_id = $2 AND kind = $3 AND hash = $4', [orgId, entityId, kind, hash]);
  return s ? s.records.map(([id, value, forms]) => ({ [kind === 'payee' ? 'key' : 'id']: id, value, forms })) : null;
}
// Resolve typed text with the list the page showed (shown: snapshotChoices; null: the page's list is gone — refused). The
// record it named must still be there now (in current); text the page's list didn't have is resolved against current.
export function atSnapshot(resolve, { shown, current, text, kind }) {
  if (!String(text ?? '').trim()) return null;
  if (!shown) return { error: 'This page is out of date (its lists changed). Reload it and choose again.' };
  const then = resolve(shown, text);
  if (then?.error && !then.none) return then;
  if (then?.none) return resolve(current, text);
  if (then?.unknown === undefined && then) {
    const id = kind === 'payee' ? then.key : then.id;
    return current.some(c => (kind === 'payee' ? c.key : c.id) === id) ? then
      : { error: `“${String(text).trim()}” has been made inactive or removed since the page was shown. Reload it and choose again.` };
  }
  return resolve(current, text);
}

export const payeeName = (choices, key) => choices.find(c => c.key === key)?.value ?? '';
export const categoryName = (choices, id) => choices.find(c => c.id === Number(id))?.name ?? '';
export const categoryValue = (choices, id) => choices.find(c => c.id === Number(id))?.value ?? '';
