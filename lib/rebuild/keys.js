// lib/rebuild/keys.js — rows by natural key (names), for state that must survive a rebuild in which every id changes.
import { ValidationError } from '../data/writes.js';
const fail = message => { throw new ValidationError(message); };

// Class names cannot contain colons (saveClass), so this is an unambiguous full
// path. Include every ancestor, never resolve a child by its leaf alone.
export function classPath(classes, id) {
  if (id == null) return null;
  const names = [], seen = new Set();
  const leaf = classes.get(id);
  while (id != null) {
    const row = classes.get(id);
    if (!row || seen.has(id) || row.org_id !== leaf?.org_id || row.entity_id !== leaf?.entity_id
      || row.name.includes(':')) fail('Saved class parent path is missing, cyclic or invalid.');
    seen.add(id); names.unshift(row.name); id = row.parent_id;
  }
  return names.join(':');
}

export async function entityByName(db, { orgId, name }) {
  const { rows } = await db.query('SELECT entity_id, name, time_zone FROM entity WHERE org_id = $1 AND lower(name) = lower($2)', [orgId, name]);
  if (rows.length !== 1) fail(rows.length ? `Two companies are named “${name}”.` : `No company “${name}”.`);
  return rows[0];
}
// type is checked, not used to search: a feed must land on the account it was mapped to, not on a namesake of another type.
export async function accountByName(db, { orgId, entityId, name, type = null }) {
  const { rows } = await db.query('SELECT account_id, name, type, active, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND name = $3', [orgId, entityId, name]);
  if (rows.length !== 1) fail(`No account “${name}” in this company.`);
  if (type && rows[0].type !== type) fail(`“${name}” is a ${rows[0].type.replace('_', ' ')} account, not ${type}.`);
  return rows[0];
}
export async function customerByName(db, { orgId, entityId, name }) {
  const { rows: [c] } = await db.query('SELECT customer_id, display_name FROM customer WHERE org_id = $1 AND entity_id = $2 AND display_name = $3', [orgId, entityId, name]);
  return c ?? fail(`No customer “${name}” in this company.`);
}
export async function vendorByName(db, { orgId, entityId, name }) {
  const { rows: [v] } = await db.query('SELECT vendor_id, display_name FROM vendor WHERE org_id = $1 AND entity_id = $2 AND display_name = $3', [orgId, entityId, name]);
  return v ?? fail(`No vendor “${name}” in this company.`);
}
// Stored rule amounts are cents / basis points; saveRule takes form text.
export const centsText = c => (Number(c) / 100).toFixed(2);
export const basisPointsText = bp => String(Number(bp) / 100);
