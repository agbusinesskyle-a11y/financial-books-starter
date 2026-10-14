import { ValidationError } from './writes.js';
import { centsToInput } from '../domain/money.js';

// Settings → Accounting, and the lists behind classes, locations and tags.

const fail = message => { throw new ValidationError(message); };
const on = v => v === true || v === '1';
const id = v => (/^\d{1,18}$/.test(String(v ?? '')) ? Number(v) : null);

const DEFAULTS = {
  fiscalStartMonth: 1, method: 'accrual', dateFormat: 'mdy', showAccountNumbers: true, classesOn: false, classMode: 'txn', locationsOn: false,
  locationLabel: 'Location', billableOn: false, billableMarkup: null, billableIncomeAccountId: null, autoApplyCustomer: false, autoApplyVendor: false,
  warnDuplicateBills: true,
};

export async function getAccountingSettings(db, { orgId, entityId }) {
  const { rows: [r] } = await db.query('SELECT *, billable_markup::float8 AS markup FROM accounting_settings WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  if (!r) return { ...DEFAULTS };
  return {
    fiscalStartMonth: r.fiscal_start_month, method: r.method, dateFormat: r.date_format, showAccountNumbers: r.show_account_numbers, classesOn: r.classes_on,
    classMode: r.class_mode, locationsOn: r.locations_on, locationLabel: r.location_label, billableOn: r.billable_on, billableMarkup: r.markup,
    billableIncomeAccountId: r.billable_income_account_id, autoApplyCustomer: r.auto_apply_customer, autoApplyVendor: r.auto_apply_vendor,
    warnDuplicateBills: r.warn_duplicate_bills,
  };
}

export async function saveAccountingSettings(pool, { orgId, entityId, fields: f }) {
  const month = Number(f.fiscalStartMonth);
  if (!(Number.isInteger(month) && month >= 1 && month <= 12)) fail('Choose the first month of the fiscal year.');
  const markupText = String(f.billableMarkup ?? '').replace('%', '').trim();
  const markup = markupText === '' ? null : Number(markupText);
  if (markup !== null && !(markup >= 0 && markup <= 1000)) fail('The markup is a percent like 10.');
  const incomeId = id(f.billableIncomeAccountId);
  if (incomeId) {
    const { rows } = await pool.query(`SELECT 1 FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND type IN ('income', 'other_income')`,
      [orgId, entityId, incomeId]);
    if (!rows.length) fail('Choose an income account for billable expenses.');
  }
  const label = String(f.locationLabel ?? '').trim().slice(0, 30) || 'Location';
  await pool.query(
    `INSERT INTO accounting_settings (org_id, entity_id, fiscal_start_month, method, date_format, show_account_numbers, classes_on, class_mode, locations_on,
       location_label, billable_on, billable_markup, billable_income_account_id, auto_apply_customer, auto_apply_vendor, warn_duplicate_bills)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (org_id, entity_id) DO UPDATE SET fiscal_start_month = $3, method = $4, date_format = $5, show_account_numbers = $6, classes_on = $7,
       class_mode = $8, locations_on = $9, location_label = $10, billable_on = $11, billable_markup = $12, billable_income_account_id = $13,
       auto_apply_customer = $14, auto_apply_vendor = $15, warn_duplicate_bills = $16`,
    [orgId, entityId, month, f.method === 'cash' ? 'cash' : 'accrual', ['dmy', 'ymd'].includes(f.dateFormat) ? f.dateFormat : 'mdy', on(f.showAccountNumbers),
      on(f.classesOn), f.classMode === 'line' ? 'line' : 'txn', on(f.locationsOn), label, on(f.billableOn), markup, incomeId, on(f.autoApplyCustomer),
      on(f.autoApplyVendor), on(f.warnDuplicateBills)]);
}

// ---- classes and locations ----

export async function listClasses(db, { orgId, entityId, activeOnly = false }) {
  const { rows } = await db.query(
    `SELECT c.class_id, c.name, c.parent_id, c.active, p.name AS parent_name,
            CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ': ' || c.name END AS full_name,
            EXISTS (SELECT 1 FROM txn t WHERE t.class_id = c.class_id) OR EXISTS (SELECT 1 FROM txn_line l WHERE l.class_id = c.class_id) AS used
       FROM class c LEFT JOIN class p ON p.class_id = c.parent_id
      WHERE c.org_id = $1 AND c.entity_id = $2 ${activeOnly ? 'AND c.active' : ''}
      ORDER BY coalesce(p.name, c.name), c.parent_id NULLS FIRST, c.name`, [orgId, entityId]);
  return rows;
}

export async function saveClass(pool, { orgId, entityId, classId = null, fields: f }) {
  const name = String(f.name ?? '').trim().slice(0, 100);
  if (!name) fail('Enter the class name.');
  if (name.includes(':')) fail('Class names can’t contain a colon.');
  const parentId = id(f.parentId);
  if (parentId) {
    const { rows: [p] } = await pool.query('SELECT parent_id FROM class WHERE org_id = $1 AND entity_id = $2 AND class_id = $3', [orgId, entityId, parentId]);
    if (!p) fail('Choose a valid parent class.');
    if (p.parent_id) fail('Sub-classes go one level deep: choose a top-level class as the parent.');
    if (parentId === classId) fail('A class can’t be its own parent.');
    if (classId && (await pool.query('SELECT 1 FROM class WHERE parent_id = $1', [classId])).rowCount) fail('This class has sub-classes, so it can’t become one.');
  }
  try {
    if (classId) {
      const { rowCount } = await pool.query('UPDATE class SET name = $4, parent_id = $5, active = $6 WHERE org_id = $1 AND entity_id = $2 AND class_id = $3',
        [orgId, entityId, classId, name, parentId, f.active !== false && f.active !== '']);
      if (!rowCount) fail('Class not found.');
    } else {
      await pool.query('INSERT INTO class (org_id, entity_id, name, parent_id) VALUES ($1,$2,$3,$4)', [orgId, entityId, name, parentId]);
    }
  } catch (error) {
    if (error.code === '23505') fail(`There’s already a class called “${name}” there.`);
    throw error;
  }
}

export async function listLocations(db, { orgId, entityId, activeOnly = false }) {
  const { rows } = await db.query(
    `SELECT l.location_id, l.name, l.active, EXISTS (SELECT 1 FROM txn t WHERE t.location_id = l.location_id) AS used
       FROM location l WHERE l.org_id = $1 AND l.entity_id = $2 ${activeOnly ? 'AND l.active' : ''} ORDER BY lower(l.name)`, [orgId, entityId]);
  return rows;
}

export async function saveLocation(pool, { orgId, entityId, locationId = null, fields: f }) {
  const name = String(f.name ?? '').trim().slice(0, 100);
  if (!name) fail('Enter the name.');
  try {
    if (locationId) {
      const { rowCount } = await pool.query('UPDATE location SET name = $4, active = $5 WHERE org_id = $1 AND entity_id = $2 AND location_id = $3',
        [orgId, entityId, locationId, name, f.active !== false && f.active !== '']);
      if (!rowCount) fail('Not found.');
    } else await pool.query('INSERT INTO location (org_id, entity_id, name) VALUES ($1,$2,$3)', [orgId, entityId, name]);
  } catch (error) {
    if (error.code === '23505') fail(`“${name}” already exists.`);
    throw error;
  }
}

// ---- tags ----

export async function listTags(db, { orgId, entityId }) {
  const { rows } = await db.query(
    `SELECT t.tag_id, t.name, t.group_id, g.name AS group_name, CASE WHEN g.name IS NULL THEN t.name ELSE g.name || ': ' || t.name END AS full_name,
            (SELECT count(*)::int FROM txn_tag x WHERE x.tag_id = t.tag_id) AS uses
       FROM tag t LEFT JOIN tag_group g ON g.group_id = t.group_id WHERE t.org_id = $1 AND t.entity_id = $2
      ORDER BY g.name NULLS FIRST, lower(t.name)`, [orgId, entityId]);
  return rows;
}

export async function listTagGroups(db, { orgId, entityId }) {
  return (await db.query('SELECT group_id, name FROM tag_group WHERE org_id = $1 AND entity_id = $2 ORDER BY lower(name)', [orgId, entityId])).rows;
}

// fields: name, and either groupId or a new group name (newGroup).
export async function saveTag(pool, { orgId, entityId, fields: f }) {
  const name = String(f.name ?? '').trim().slice(0, 60);
  if (!name) fail('Enter the tag.');
  if (name.includes(':')) fail('Tags can’t contain a colon.');
  let groupId = id(f.groupId);
  const newGroup = String(f.newGroup ?? '').trim().slice(0, 60);
  try {
    if (newGroup) {
      groupId = (await pool.query(
        `INSERT INTO tag_group (org_id, entity_id, name) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, entity_id, lower(name)) DO UPDATE SET name = tag_group.name RETURNING group_id`, [orgId, entityId, newGroup])).rows[0].group_id;
    } else if (groupId && !(await pool.query('SELECT 1 FROM tag_group WHERE org_id = $1 AND entity_id = $2 AND group_id = $3', [orgId, entityId, groupId])).rowCount) {
      fail('Choose a valid group.');
    }
    await pool.query('INSERT INTO tag (org_id, entity_id, group_id, name) VALUES ($1,$2,$3,$4)', [orgId, entityId, groupId, name]);
  } catch (error) {
    if (error.code === '23505') fail(`The tag “${name}” already exists.`);
    throw error;
  }
}

export async function deleteTag(pool, { orgId, entityId, tagId }) {
  await pool.query('DELETE FROM tag WHERE org_id = $1 AND entity_id = $2 AND tag_id = $3', [orgId, entityId, tagId]);
}

// ---- on a transaction ----

// Sets a transaction's class, location and tags (each only when given). Caller holds the transaction.
// dims: { classId?, locationId?, tagIds? } (undefined = leave alone).
export async function applyTxnDimensions(tx, { orgId, entityId, txnId, dims = {} }) {
  const check = async (table, col, value, what) => {
    if (value === null || value === undefined) return;
    const { rowCount } = await tx.query(`SELECT 1 FROM ${table} WHERE org_id = $1 AND entity_id = $2 AND ${col} = $3`, [orgId, entityId, value]);
    if (!rowCount) fail(`Choose a valid ${what}.`);
  };
  if (dims.classId !== undefined) {
    await check('class', 'class_id', dims.classId, 'class');
    await tx.query('UPDATE txn SET class_id = $3 WHERE org_id = $1 AND txn_id = $2', [orgId, txnId, dims.classId]);
  }
  if (dims.locationId !== undefined) {
    await check('location', 'location_id', dims.locationId, 'location');
    await tx.query('UPDATE txn SET location_id = $3 WHERE org_id = $1 AND txn_id = $2', [orgId, txnId, dims.locationId]);
  }
  if (dims.tagIds !== undefined) {
    const tags = [...new Set(dims.tagIds)].slice(0, 50);
    if (tags.length) {
      const { rows } = await tx.query('SELECT count(*)::int AS n FROM tag WHERE org_id = $1 AND entity_id = $2 AND tag_id = ANY($3::bigint[])', [orgId, entityId, tags]);
      if (rows[0].n !== tags.length) fail('Choose tags from the list.');
    }
    await tx.query('DELETE FROM txn_tag WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]);
    for (const tagId of tags) await tx.query('INSERT INTO txn_tag (org_id, txn_id, tag_id) VALUES ($1,$2,$3)', [orgId, txnId, tagId]);
  }
}

// Line classes must be this company's.
export async function checkLineClasses(tx, { orgId, entityId, classIds }) {
  const list = [...new Set(classIds.filter(Boolean))];
  if (!list.length) return;
  const { rows } = await tx.query('SELECT count(*)::int AS n FROM class WHERE org_id = $1 AND entity_id = $2 AND class_id = ANY($3::bigint[])', [orgId, entityId, list]);
  if (rows[0].n !== list.length) fail('Choose classes from the list.');
}

export async function txnDimensions(db, { orgId, txnId }) {
  const { rows: [t] } = await db.query('SELECT class_id, location_id FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]);
  const { rows } = await db.query('SELECT tag_id FROM txn_tag WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]);
  return { classId: t?.class_id ?? null, locationId: t?.location_id ?? null, tagIds: rows.map(r => r.tag_id) };
}

// Everything the editors need to show class / location / tag pickers.
export async function dimensionChoices(db, scope) {
  const [settings, classes, locations, tags] = await Promise.all([getAccountingSettings(db, scope), listClasses(db, { ...scope, activeOnly: true }),
    listLocations(db, { ...scope, activeOnly: true }), listTags(db, scope)]);
  return { settings, classes, locations, tags };
}

// ---- billable expenses ----

// Cost lines marked billable to this customer that no live invoice bills yet.
export async function unbilledExpenses(db, { orgId, entityId, customerId, exceptInvoiceId = null }) {
  const { rows } = await db.query(
    `SELECT l.txn_id, l.line_no, l.description, l.amount_cents, l.item_id, t.type, t.doc_number, t.txn_date, v.display_name AS vendor_name
       FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE l.org_id = $1 AND t.entity_id = $2 AND l.customer_id = $3 AND l.billable AND t.voided_at IS NULL
        AND t.type IN ('bill', 'expense', 'check')
        AND NOT EXISTS (SELECT 1 FROM txn_line b JOIN txn i ON i.txn_id = b.txn_id
                         WHERE b.billable_txn_id = l.txn_id AND b.billable_line_no = l.line_no AND i.voided_at IS NULL AND i.txn_id IS DISTINCT FROM $4)
      ORDER BY t.txn_date, l.txn_id, l.line_no`, [orgId, entityId, customerId, exceptInvoiceId]);
  return rows;
}

// Invoice editor lines for a customer's unbilled expenses, with the company's markup.
export function billableLines(expenses, settings) {
  const markup = settings.billableMarkup ?? 0;
  return expenses.map(e => ({
    itemId: '', description: `${e.vendor_name ? `${e.vendor_name}: ` : ''}${e.description ?? 'Expense'}`.slice(0, 500), quantity: '1',
    rate: centsToInput(Math.round(Number(e.amount_cents) * (100 + markup) / 100)), serviceDate: e.txn_date, estimateLine: '', billable: `${e.txn_id}:${e.line_no}`,
  }));
}
