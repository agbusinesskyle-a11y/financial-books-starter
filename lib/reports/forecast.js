import { addDays } from '../domain/dates.js';
import { normalSign } from '../domain/ledger.js';
import { timeBuckets } from './periods.js';
import { profitAndLoss, sumByAccount, PL_TYPES } from './statements.js';

// Forecast (stage R5b): the Profit and Loss for the coming months from the last 12 complete months — each account's
// average, its trend (a straight line through the 12 months), or the same month last year — adjusted by a percentage
// for income and for expenses. The figures go through the same P&L builder as the actuals.

export const FORECAST_EXTRA = ['fc_months', 'fc_method', 'fc_income', 'fc_expense'];
const monthStart = (y, m) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);

export function forecastChoices(extra) {
  const months = ['3', '6', '12', '24'].includes(extra.fc_months) ? Number(extra.fc_months) : 12;
  const method = ['average', 'trend', 'last_year'].includes(extra.fc_method) ? extra.fc_method : 'average';
  const pct = v => (/^-?\d{1,3}$/.test(String(v ?? '')) && Number(v) >= -100 && Number(v) <= 500 ? Number(v) : 0);
  return { months, method, income: pct(extra.fc_income), expense: pct(extra.fc_expense) };
}

// Linear fit through (0, y0) … (n−1, yn−1), read at x.
const lineAt = (ys, x) => {
  const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return my + (den ? num / den : 0) * (x - mx);
};

export function forecastLines({ accounts, lines, today, choices }) {
  const [y, m] = today.split('-').map(Number);
  const histFrom = monthStart(y, m - 13), histTo = addDays(monthStart(y, m - 1), -1);
  const fcFrom = monthStart(y, m), fcTo = addDays(monthStart(y, m - 1 + choices.months + 1), -1);
  const history = timeBuckets('months', histFrom, histTo);
  const future = timeBuckets('months', fcFrom, fcTo);
  const { sums } = sumByAccount(lines, history);
  const out = [];
  for (const a of accounts.filter(x => PL_TYPES.includes(x.type))) {
    const ys = (sums.get(a.account_id) ?? Array(12).fill(0)).map(v => v * normalSign(a.type));
    if (!ys.some(Boolean)) continue;
    const income = ['income', 'other_income'].includes(a.type);
    const factor = 1 + (income ? choices.income : choices.expense) / 100;
    future.forEach((b, k) => {
      const base = choices.method === 'average' ? ys.reduce((s, v) => s + v, 0) / ys.length
        // The current month sits between the history and the forecast, so forecast month k is history month 13 + k.
        : choices.method === 'trend' ? lineAt(ys, ys.length + 1 + k) : ys[(k + 1) % 12];
      const cents = Math.round(base * factor);
      if (cents) out.push({ accountId: a.account_id, date: b.from, amount: cents * normalSign(a.type), txnId: 0, customerId: null, vendorId: null, classId: null,
        locationId: null, itemId: null, projectId: null });
    });
  }
  return { lines: out, future, history: { from: histFrom, to: histTo } };
}

export function forecastReport({ accounts, lines, today, choices, numbers }) {
  const { lines: fc, future, history } = forecastLines({ accounts, lines, today, choices });
  const columns = [...future, { key: 'total', label: 'Total', from: future[0].from, to: future.at(-1).to }];
  const res = profitAndLoss({ accounts, lines: fc, columns, show: 'non_zero', numbers });
  return { columns, res, history, future };
}
