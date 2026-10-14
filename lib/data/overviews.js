import { listAccounts } from './ledger.js';
import { getAccountingSettings } from './accounting.js';
import { inventorySummary } from './inventory.js';
import { measures } from '../reports/kpis.js';
import { openItems } from '../reports/receivables.js';
import { timeBuckets } from '../reports/periods.js';
import { ledgerLines } from '../reports/ledger-data.js';
import { addDays } from '../domain/dates.js';

// The Overview pages and the all-projects list (stage N3). Money figures come from the same code as the reports.

// The first day of the month n months before today's month (11 → a 12-month window ending this month).
const monthsBack = (today, n) => { const [y, m] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 10); };

async function base(db, { orgId, entityId }) {
  const [accounts, settings] = await Promise.all([listAccounts(db, { orgId, entityId, includeInactive: true }), getAccountingSettings(db, { orgId, entityId })]);
  return { accounts, basis: settings.method === 'cash' ? 'cash' : 'accrual' };
}

const openSide = async (db, { orgId, entityId, side, today }) => {
  const items = await openItems(db, { orgId, entityId, side, asOf: today });
  const charges = items.filter(i => !i.credit);
  const overdue = charges.filter(i => i.pastDue > 0);
  const top = new Map();
  for (const i of items) top.set(i.partyId, { id: i.partyId, name: i.partyName, open: (top.get(i.partyId)?.open ?? 0) + i.open });
  return {
    open: items.reduce((s, i) => s + i.open, 0),
    overdue: overdue.reduce((s, i) => s + i.open, 0), overdueCount: overdue.length,
    notDue: charges.filter(i => i.pastDue === 0).reduce((s, i) => s + i.open, 0), notDueCount: charges.length - overdue.length,
    credits: items.filter(i => i.credit).reduce((s, i) => s + i.open, 0),
    top: [...top.values()].filter(p => p.open > 0).sort((a, b) => b.open - a.open).slice(0, 5),
  };
};

const sumWhere = async (db, sql, params) => Number((await db.query(sql, params)).rows[0].s ?? 0);

export async function salesOverview(db, { orgId, entityId, today }) {
  const { accounts, basis } = await base(db, { orgId, entityId });
  const months = timeBuckets('months', monthsBack(today, 11), today);
  const [m, ar, paid30, undeposited] = await Promise.all([
    measures(db, { orgId, entityId, accounts, basis, ranges: months }),
    openSide(db, { orgId, entityId, side: 'ar', today }),
    sumWhere(db, `SELECT sum(total_cents) AS s FROM txn WHERE org_id = $1 AND entity_id = $2 AND voided_at IS NULL AND type IN ('payment', 'sales_receipt')
      AND txn_date BETWEEN $3 AND $4`, [orgId, entityId, addDays(today, -29), today]),
    sumWhere(db, `SELECT sum(p.amount_cents) AS s FROM posting p JOIN account a ON a.account_id = p.account_id
      WHERE a.org_id = $1 AND a.entity_id = $2 AND a.system_key = 'undeposited'`, [orgId, entityId]),
  ]);
  return { ar, paid30, undeposited, months: months.map((b, i) => ({ label: b.label, value: m[i]?.revenue ?? 0 })) };
}

export async function expensesOverview(db, { orgId, entityId, today }) {
  const { accounts, basis } = await base(db, { orgId, entityId });
  const months = timeBuckets('months', monthsBack(today, 11), today);
  const from = addDays(today, -29);
  const [m, ap, paid30, lines] = await Promise.all([
    measures(db, { orgId, entityId, accounts, basis, ranges: months }),
    openSide(db, { orgId, entityId, side: 'ap', today }),
    sumWhere(db, `SELECT sum(total_cents) AS s FROM txn WHERE org_id = $1 AND entity_id = $2 AND voided_at IS NULL AND type IN ('bill_payment', 'expense', 'check')
      AND txn_date BETWEEN $3 AND $4`, [orgId, entityId, from, today]),
    ledgerLines(db, { orgId, entityId, from, to: today, basis }),
  ]);
  // Spending by category, last 30 days: expense and cost-of-goods accounts.
  const byId = new Map(accounts.map(a => [a.account_id, a]));
  const cats = new Map();
  for (const l of lines) {
    const a = byId.get(l.accountId);
    if (!a || !['expense', 'other_expense', 'cost_of_goods_sold'].includes(a.type) || l.date < from || l.date > today) continue;
    cats.set(a.account_id, { id: a.account_id, name: a.name, value: (cats.get(a.account_id)?.value ?? 0) + l.amount });
  }
  const categories = [...cats.values()].filter(c => c.value !== 0).sort((a, b) => b.value - a.value);
  return { ap, paid30, categories, spent30: categories.reduce((s, c) => s + c.value, 0),
    months: months.map((b, i) => ({ label: b.label, value: m[i]?.total_expenses ?? 0 })) };
}

export async function customersOverview(db, { orgId, entityId, today }) {
  const yearStart = `${today.slice(0, 4)}-01-01`, monthStart = `${today.slice(0, 7)}-01`;
  const [counts, top, ar] = await Promise.all([
    db.query(`SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive,
        count(*) FILTER (WHERE created_at >= $3::date)::int AS new_this_month FROM customer WHERE org_id = $1 AND entity_id = $2`, [orgId, entityId, monthStart]),
    db.query(`SELECT c.customer_id AS id, c.display_name AS name, sum(t.total_cents)::bigint AS value
       FROM txn t JOIN customer c ON c.customer_id = t.customer_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.voided_at IS NULL AND t.type IN ('invoice', 'sales_receipt') AND t.txn_date BETWEEN $3 AND $4
      GROUP BY c.customer_id ORDER BY 3 DESC LIMIT 5`, [orgId, entityId, yearStart, today]),
    openSide(db, { orgId, entityId, side: 'ar', today }),
  ]);
  return { ...counts.rows[0], topSales: top.rows.map(r => ({ ...r, value: Number(r.value) })), ar };
}

export async function listAllProjects(db, { orgId, entityId, status = 'all' }) {
  const { rows } = await db.query(
    `SELECT p.project_id, p.name, p.status, p.start_date::text AS start_date, p.end_date::text AS end_date, c.customer_id, c.display_name AS customer_name,
            coalesce((SELECT sum(t.total_cents) FROM txn t WHERE t.project_id = p.project_id AND t.voided_at IS NULL AND t.type IN ('invoice', 'sales_receipt', 'late_fee')), 0)::bigint AS income_cents,
            coalesce((SELECT sum(t.total_cents) FROM txn t WHERE t.project_id = p.project_id AND t.voided_at IS NULL AND t.type = 'credit_memo'), 0)::bigint AS credit_cents,
            coalesce((SELECT sum(t.open_cents) FROM txn t WHERE t.project_id = p.project_id AND t.voided_at IS NULL AND t.type IN ('invoice', 'late_fee')), 0)::bigint AS open_cents,
            -- Costs as on the Project Profitability report: everything posted to cost of goods sold and expense accounts for the
            -- project (purchases charged to it, and the cost of stock sold on it).
            coalesce((SELECT sum(ps.amount_cents) FROM posting ps JOIN account a ON a.account_id = ps.account_id
               WHERE ps.project_id = p.project_id AND a.type IN ('cost_of_goods_sold', 'expense', 'other_expense')), 0)::bigint AS cost_cents
       FROM project p JOIN customer c ON c.org_id = p.org_id AND c.customer_id = p.customer_id
      WHERE p.org_id = $1 AND c.entity_id = $2 AND ($3 = 'all' OR p.status = $3)
      ORDER BY (p.status = 'in_progress') DESC, lower(p.name)`, [orgId, entityId, ['in_progress', 'completed', 'canceled'].includes(status) ? status : 'all']);
  return rows.map(r => {
    const income = Number(r.income_cents) - Number(r.credit_cents), cost = Number(r.cost_cents);
    return { ...r, income_cents: income, cost_cents: cost, open_cents: Number(r.open_cents), profit_cents: income - cost };
  });
}

export async function projectsOverview(db, { orgId, entityId }) {
  const all = await listAllProjects(db, { orgId, entityId });
  const by = s => all.filter(p => p.status === s).length;
  return { count: all.length, inProgress: by('in_progress'), completed: by('completed'), canceled: by('canceled'),
    income: all.reduce((s, p) => s + p.income_cents, 0), cost: all.reduce((s, p) => s + p.cost_cents, 0),
    top: [...all].sort((a, b) => b.profit_cents - a.profit_cents).slice(0, 5) };
}

export async function inventoryOverview(db, { orgId, entityId }) {
  const items = (await inventorySummary(db, { orgId, entityId })).filter(i => i.active);
  return { count: items.length, value: items.reduce((s, i) => s + Number(i.value_cents), 0),
    low: items.filter(i => i.low && Number(i.qty_on_hand) > 0), out: items.filter(i => Number(i.qty_on_hand) <= 0),
    top: [...items].sort((a, b) => Number(b.value_cents) - Number(a.value_cents)).slice(0, 5) };
}
