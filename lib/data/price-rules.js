import { ValidationError } from './writes.js';
import { parseMoney } from '../domain/money.js';
import { isIsoDate } from '../domain/dates.js';

// Settings → Price rules: special prices for chosen customers and/or products over a date range.
// Which rule applies on an invoice: activeRules / rulePrice in writes.js.

const fail = message => { throw new ValidationError(message); };

export async function listRules(pool, { orgId, entityId }) {
  const { rows } = await pool.query(
    `SELECT r.*, r.percent_off::float8 AS percent_off,
            (SELECT array_agg(c.display_name ORDER BY c.display_name) FROM customer c WHERE c.customer_id = ANY(r.customer_ids)) AS customer_names,
            (SELECT array_agg(i.name ORDER BY i.name) FROM item i WHERE i.item_id = ANY(r.item_ids)) AS item_names
       FROM price_rule r WHERE r.org_id = $1 AND r.entity_id = $2 ORDER BY r.active DESC, lower(r.name)`, [orgId, entityId]);
  return rows;
}

export async function getRule(pool, { orgId, entityId, ruleId }) {
  const { rows } = await pool.query('SELECT *, percent_off::float8 AS percent_off FROM price_rule WHERE org_id = $1 AND entity_id = $2 AND rule_id = $3',
    [orgId, entityId, ruleId]);
  return rows[0] ?? null;
}

const ids = list => [...new Set([].concat(list ?? []).filter(v => /^\d{1,18}$/.test(String(v))).map(Number))].slice(0, 500);

// fields: name, kind ('fixed' | 'percent_off'), price, percentOff, customerIds[], itemIds[], startDate, endDate, active.
export async function saveRule(pool, { orgId, entityId, ruleId = null, fields: f }) {
  const name = String(f.name ?? '').trim().slice(0, 100);
  if (!name) fail('Give the rule a name, like “Spring promo” or “Wholesale customers”.');
  const kind = f.kind === 'fixed' ? 'fixed' : 'percent_off';
  let priceCents = null, percentOff = null;
  if (kind === 'fixed') {
    priceCents = parseMoney(String(f.price ?? '').trim());
    if (priceCents === null || priceCents < 0) fail('Enter the special price, like 18.50.');
  } else {
    const pctText = String(f.percentOff ?? '').replace('%', '').trim();
    percentOff = Number(pctText);
    if (!/^\d{1,3}(\.\d{1,4})?$/.test(pctText) || !(percentOff > 0 && percentOff <= 100)) fail('Enter the percent off, between 0 and 100 (up to 4 decimals).');
  }
  const customerIds = ids(f.customerIds), itemIds = ids(f.itemIds);
  if (kind === 'fixed' && !itemIds.length) fail('A fixed price needs at least one product or service.');
  const start = String(f.startDate ?? '').trim() || null, end = String(f.endDate ?? '').trim() || null;
  if ((start && !isIsoDate(start)) || (end && !isIsoDate(end))) fail('Enter valid dates, or leave them blank.');
  if (start && end && start > end) fail('The end date is before the start date.');
  const known = async (table, col, list) => {
    if (!list.length) return;
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1 AND entity_id = $2 AND ${col} = ANY($3::bigint[])`, [orgId, entityId, list]);
    if (rows[0].n !== list.length) fail('Choose customers and products from the lists.');
  };
  await known('customer', 'customer_id', customerIds);
  await known('item', 'item_id', itemIds);
  const values = [name, kind, priceCents, percentOff, customerIds, itemIds, start, end, f.active === true || f.active === '1'];
  if (ruleId) {
    const { rowCount } = await pool.query(
      `UPDATE price_rule SET name = $4, kind = $5, price_cents = $6, percent_off = $7, customer_ids = $8, item_ids = $9, start_date = $10, end_date = $11, active = $12
        WHERE org_id = $1 AND entity_id = $2 AND rule_id = $3`, [orgId, entityId, ruleId, ...values]);
    if (!rowCount) fail('Price rule not found.');
    return ruleId;
  }
  const { rows } = await pool.query(
    `INSERT INTO price_rule (org_id, entity_id, name, kind, price_cents, percent_off, customer_ids, item_ids, start_date, end_date, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING rule_id`, [orgId, entityId, ...values]);
  return rows[0].rule_id;
}

export async function deleteRule(pool, { orgId, entityId, ruleId }) {
  await pool.query('DELETE FROM price_rule WHERE org_id = $1 AND entity_id = $2 AND rule_id = $3', [orgId, entityId, ruleId]);
}
