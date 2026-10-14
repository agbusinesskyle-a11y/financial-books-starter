import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { listAccounts } from '../../lib/data/ledger.js';
import { getAccountingSettings } from '../../lib/data/accounting.js';
import { resolvePeriod } from '../../lib/reports/periods.js';
import { DASHBOARDS, dashboardData } from '../../lib/reports/dashboards.js';
import { cashProjection, addPlanItem, deletePlanItem, setThreshold } from '../../lib/reports/cashplan.js';
import { dashboardPage, cashFlowPage } from '../../lib/views/insights.js';

// Reports → Dashboards (/reports/dashboards) and the Cash flow planner (/reports/cash-flow).
export async function insightRoutes(h) {
  const { req, path, query, form, scope, pool, page, base, go, takeFlash, who, ctx, actor } = h;
  if (!path.startsWith('/reports/dashboards') && !path.startsWith('/reports/cash-flow')) return false;

  if (path === '/reports/dashboards' && req.method === 'GET') {
    const key = DASHBOARDS.some(([k]) => k === query.d) ? query.d : 'standard';
    const period = ['last_12_months', 'last_6_months', 'this_year', 'last_year'].includes(query.period) ? query.period : 'last_12_months';
    const [accounting, accounts] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope)]);
    const range = resolvePeriod(period, ctx.today, accounting.fiscalStartMonth);
    const to = range.to > ctx.today ? ctx.today : range.to;
    const data = await dashboardData(pool, { ...scope, accounts, basis: accounting.method === 'cash' ? 'cash' : 'accrual', from: range.from, to, key });
    page(dashboardPage({ ...base(), key, data, from: range.from, to, period }));
    return true;
  }

  const opts = { weeks: [4, 13, 26, 52].includes(Number(query.weeks)) ? Number(query.weeks) : 13, overdue: query.overdue !== '0', trend: query.trend === '1' };
  const show = async (more = {}, status = 200) => {
    const plan = await cashProjection(pool, { ...scope, today: ctx.today, accounts: await listAccounts(pool, scope), ...opts });
    page(cashFlowPage({ ...base(), flash: takeFlash(), plan, opts, canEdit: who.role !== 'reports', ...more }), status);
  };
  if (path === '/reports/cash-flow' && req.method === 'GET') { await show(); return true; }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (path === '/reports/cash-flow/items') {
    const v = { direction: form.get('direction'), name: form.get('name'), amount: form.get('amount'), date: form.get('date'), repeat: form.get('repeat'), until: form.get('until') };
    try {
      await addPlanItem(pool, { ...scope, fields: v, actor });
      go('/reports/cash-flow', 'ok', 'Added to the plan.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await show({ v, error: error.message }, 422);
    }
    return true;
  }
  if (path === '/reports/cash-flow/threshold') {
    try { await setThreshold(pool, { ...scope, text: form.get('threshold') }); go('/reports/cash-flow', 'ok', 'Threshold saved.'); } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      go('/reports/cash-flow', 'error', error.message);
    }
    return true;
  }
  const m = /^\/reports\/cash-flow\/items\/(\d{1,18})\/delete$/.exec(path);
  if (m) { await deletePlanItem(pool, { ...scope, itemId: Number(m[1]) }); go('/reports/cash-flow', 'ok', 'Removed from the plan.'); return true; }
  throw new HttpError(404, 'Not found');
}
