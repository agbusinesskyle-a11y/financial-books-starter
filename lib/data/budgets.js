import { withTransaction } from '../db.js';
import { ValidationError } from './writes.js';
import { getAccountingSettings } from './accounting.js';
import { parseSignedMoney } from '../domain/money.js';
import { normalSign } from '../domain/ledger.js';

// Budgets: per fiscal year, an amount for each income and expense account in each fiscal month, optionally split by
// class, location or customer. Amounts are kept in the account's normal sign (income and expenses both positive).

const fail = message => { throw new ValidationError(message); };
export const BUDGET_TYPES = ['income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense'];
export const SUBDIVIDE = [['none', 'Nothing'], ['class', 'Class'], ['location', 'Location'], ['customer', 'Customer']];
const DIM_COLUMN = { class: 'class_id', location: 'location_id', customer: 'customer_id' };

const pad = n => String(n).padStart(2, '0');
// The calendar month (YYYY-MM-01) of fiscal period 1..12.
export function periodStart(fiscalYear, startMonth, period) {
  const m0 = startMonth - 1 + period - 1;
  // A fiscal year is named for the calendar year it ends in (FY2027 starting July = Jul 2026 – Jun 2027) unless it starts in January.
  const firstYear = startMonth === 1 ? fiscalYear : fiscalYear - 1;
  return `${firstYear + Math.floor(m0 / 12)}-${pad((m0 % 12) + 1)}-01`;
}
export const periodLabel = (b, period) => new Date(`${periodStart(b.fiscal_year, b.start_month, period)}T00:00:00Z`)
  .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: '2-digit' });

export async function listBudgets(db, { orgId, entityId }) {
  return (await db.query(
    `SELECT b.*, coalesce((SELECT sum(amount_cents) FROM budget_line l WHERE l.budget_id = b.budget_id), 0)::bigint AS total_cents
       FROM budget b WHERE b.org_id = $1 AND b.entity_id = $2 ORDER BY b.fiscal_year DESC, lower(b.name)`, [orgId, entityId])).rows;
}

export async function getBudget(db, { orgId, entityId, budgetId }) {
  const { rows: [b] } = await db.query('SELECT * FROM budget WHERE org_id = $1 AND entity_id = $2 AND budget_id = $3', [orgId, entityId, budgetId]);
  return b ?? null;
}

// The values each split can take (for the "Show" picker on a subdivided budget).
export async function dimChoices(db, { orgId, entityId, subdivide }) {
  const sql = {
    class: `SELECT c.class_id AS id, CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ': ' || c.name END AS name FROM class c LEFT JOIN class p ON p.class_id = c.parent_id
             WHERE c.org_id = $1 AND c.entity_id = $2 AND c.active ORDER BY 2`,
    location: 'SELECT location_id AS id, name FROM location WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY name',
    customer: 'SELECT customer_id AS id, display_name AS name FROM customer WHERE org_id = $1 AND entity_id = $2 AND active ORDER BY display_name',
  }[subdivide];
  return sql ? (await db.query(sql, [orgId, entityId])).rows : [];
}

// Actual amounts by account and fiscal period (normal sign) for a budget's year, for one split value (dimId) or all.
export async function actuals(db, { orgId, entityId, budget: b, dimId = null }) {
  const from = periodStart(b.fiscal_year, b.start_month, 1), to = periodStart(b.fiscal_year + 1, b.start_month, 1);
  const col = DIM_COLUMN[b.subdivide];
  const { rows } = await db.query(
    `SELECT p.account_id, a.type, date_trunc('month', p.txn_date)::date AS month, sum(p.amount_cents)::bigint AS cents
       FROM posting p JOIN account a ON a.account_id = p.account_id
      WHERE p.org_id = $1 AND p.entity_id = $2 AND p.txn_date >= $3 AND p.txn_date < $4 AND a.type = ANY($5)
        ${col && dimId ? `AND p.${col} = $6` : ''}
      GROUP BY p.account_id, a.type, month`, [orgId, entityId, from, to, BUDGET_TYPES, ...(col && dimId ? [dimId] : [])]);
  const out = new Map();
  for (const r of rows) {
    const period = Array.from({ length: 12 }, (_, i) => i + 1).find(p => periodStart(b.fiscal_year, b.start_month, p) === String(r.month).slice(0, 10));
    if (!period) continue;
    out.set(`${r.account_id}:${period}`, Number(r.cents) * normalSign(r.type));
  }
  return out;
}

// fields: name, fiscalYear, subdivide, startFrom ('blank' | 'actuals' | 'budget:<id>'). Returns the budget id.
export async function createBudget(pool, { orgId, entityId, fields: f, actor }) {
  const name = String(f.name ?? '').trim().slice(0, 100);
  if (!name) fail('Give the budget a name, like “FY2027 plan”.');
  const year = Number(f.fiscalYear);
  if (!(Number.isInteger(year) && year >= 2000 && year <= 2100)) fail('Enter the fiscal year, like 2027.');
  const subdivide = SUBDIVIDE.some(([k]) => k === f.subdivide) ? f.subdivide : 'none';
  const { fiscalStartMonth } = await getAccountingSettings(pool, { orgId, entityId });
  return withTransaction(pool, async tx => {
    let budget;
    try {
      ({ rows: [budget] } = await tx.query(
        'INSERT INTO budget (org_id, entity_id, name, fiscal_year, start_month, subdivide, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [orgId, entityId, name, year, fiscalStartMonth, subdivide, actor]));
    } catch (error) {
      if (error.code === '23505') fail(`There’s already a budget called “${name}”.`);
      throw error;
    }
    const from = String(f.startFrom ?? 'blank');
    if (from === 'actuals') {
      // Last year's actuals, month for month (all splits together when not subdivided; per split value when subdivided).
      const last = { ...budget, fiscal_year: year - 1 };
      const col = DIM_COLUMN[subdivide];
      const dims = col ? (await dimChoices(tx, { orgId, entityId, subdivide })).map(d => d.id) : [0];
      for (const dim of dims) {
        for (const [key, cents] of await actuals(tx, { orgId, entityId, budget: { ...last, subdivide }, dimId: col ? dim : null })) {
          if (!cents) continue;
          const [accountId, period] = key.split(':').map(Number);
          await tx.query('INSERT INTO budget_line (budget_id, account_id, dim_id, period, amount_cents) VALUES ($1,$2,$3,$4,$5)', [budget.budget_id, accountId, dim, period, cents]);
        }
      }
    } else if (/^budget:\d{1,18}$/.test(from)) {
      const src = await getBudget(tx, { orgId, entityId, budgetId: Number(from.slice(7)) }) ?? fail('Choose a budget to copy.');
      if (src.subdivide !== subdivide) fail(`“${src.name}” is split differently. Copy a budget split the same way, or start from actuals.`);
      await tx.query(
        `INSERT INTO budget_line (budget_id, account_id, dim_id, period, amount_cents)
         SELECT $1, account_id, dim_id, period, amount_cents FROM budget_line WHERE budget_id = $2`, [budget.budget_id, src.budget_id]);
    }
    return budget.budget_id;
  });
}

// One slice (dimId) of a budget: Map "accountId:period" -> cents.
export async function budgetAmounts(db, { budgetId, dimId = 0 }) {
  const { rows } = await db.query('SELECT account_id, period, amount_cents FROM budget_line WHERE budget_id = $1 AND dim_id = $2', [budgetId, dimId]);
  return new Map(rows.map(r => [`${r.account_id}:${r.period}`, Number(r.amount_cents)]));
}

// cells: { "accountId:period": "text" } for one slice. Blank or 0 removes the amount.
export async function saveBudgetAmounts(pool, { orgId, entityId, budgetId, dimId = 0, cells }) {
  return withTransaction(pool, async tx => {
    const b = await getBudget(tx, { orgId, entityId, budgetId }) ?? fail('Budget not found.');
    if (b.subdivide !== 'none' && !dimId) fail('Choose which one to budget for first.');
    // The split value must be one of this company's classes, locations or customers.
    if (b.subdivide !== 'none' && !(await dimChoices(tx, { orgId, entityId, subdivide: b.subdivide })).some(d => Number(d.id) === Number(dimId))) fail('Choose which one to budget for first.');
    const accounts = new Set((await tx.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND type = ANY($3)', [orgId, entityId, BUDGET_TYPES])).rows
      .map(r => r.account_id));
    for (const [key, raw] of Object.entries(cells)) {
      const m = /^(\d{1,18}):(\d{1,2})$/.exec(key);
      if (!m || !accounts.has(Number(m[1])) || Number(m[2]) < 1 || Number(m[2]) > 12) continue;
      const textValue = String(raw ?? '').trim();
      const cents = textValue ? parseSignedMoney(textValue) : 0;
      if (cents === null) fail(`“${textValue}” isn’t an amount.`);
      if (cents) {
        await tx.query(`INSERT INTO budget_line (budget_id, account_id, dim_id, period, amount_cents) VALUES ($1,$2,$3,$4,$5)
                        ON CONFLICT (budget_id, account_id, dim_id, period) DO UPDATE SET amount_cents = EXCLUDED.amount_cents`,
          [budgetId, Number(m[1]), dimId, Number(m[2]), cents]);
      } else {
        await tx.query('DELETE FROM budget_line WHERE budget_id = $1 AND account_id = $2 AND dim_id = $3 AND period = $4', [budgetId, Number(m[1]), dimId, Number(m[2])]);
      }
    }
  });
}

export async function deleteBudget(pool, { orgId, entityId, budgetId }) {
  await pool.query('DELETE FROM budget WHERE org_id = $1 AND entity_id = $2 AND budget_id = $3', [orgId, entityId, budgetId]);
}

export async function budgetAccounts(db, { orgId, entityId }) {
  return (await db.query(`SELECT account_id, name, number, type FROM account WHERE org_id = $1 AND entity_id = $2 AND active AND type = ANY($3)
                          ORDER BY array_position($3::text[], type), number NULLS LAST, name`, [orgId, entityId, BUDGET_TYPES])).rows;
}
