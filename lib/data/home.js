import { listAccounts } from './ledger.js';
import { getAccountingSettings } from './accounting.js';
import { measures } from '../reports/kpis.js';
import { openItems } from '../reports/receivables.js';
import { timeBuckets } from '../reports/periods.js';

// Home (stage N1): the business at a glance. Built from the same report code, so it agrees with the reports.
export async function homeData(db, { orgId, entityId, today }) {
  const [accounts, settings] = await Promise.all([listAccounts(db, { orgId, entityId, includeInactive: false }), getAccountingSettings(db, { orgId, entityId })]);
  const basis = settings.method === 'cash' ? 'cash' : 'accrual';
  const first = `${today.slice(0, 7)}-01`;
  const from = (() => { const [y, m] = first.split('-').map(Number); const d = new Date(Date.UTC(y, m - 6, 1)); return d.toISOString().slice(0, 10); })();
  const months = timeBuckets('months', from, today);
  const [m, ar, ap] = await Promise.all([
    measures(db, { orgId, entityId, accounts, basis, ranges: months }),
    openItems(db, { orgId, entityId, side: 'ar', asOf: today }),
    openItems(db, { orgId, entityId, side: 'ap', asOf: today }),
  ]);
  const side = items => ({
    open: items.reduce((s, i) => s + i.open, 0),
    overdue: items.filter(i => !i.credit && i.pastDue > 0).reduce((s, i) => s + i.open, 0),
    overdueCount: items.filter(i => !i.credit && i.pastDue > 0).length,
    openCount: items.filter(i => !i.credit).length,
  });
  return {
    basis,
    ar: side(ar), ap: side(ap),
    banks: accounts.filter(a => a.type === 'bank' || a.type === 'credit_card').map(a => ({ id: a.account_id, name: a.name, type: a.type, balance: Number(a.balance_cents) })),
    months: months.map((b, i) => ({ label: b.label, revenue: m[i]?.revenue ?? 0, expenses: m[i]?.total_expenses ?? 0, net: m[i]?.net_income ?? 0 })),
  };
}
