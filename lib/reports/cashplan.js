import { ValidationError } from '../data/writes.js';
import { addDays, daysBetween, isIsoDate } from '../domain/dates.js';
import { parseMoney } from '../domain/money.js';
import { ledgerLines } from './ledger-data.js';
import { openItems } from './receivables.js';

// Cash flow overview and planner (stage R5b): today's bank balances, what customers owe and what is owed to vendors by
// due date, the company's own planned items, optionally the usual cash that isn't tied to invoices or bills (from the
// last three months), and the projected balance week by week against a threshold.

const fail = message => { throw new ValidationError(message); };

export async function listPlanItems(db, { orgId, entityId }) {
  return (await db.query('SELECT * FROM cash_plan_item WHERE org_id = $1 AND entity_id = $2 ORDER BY start_date, item_id', [orgId, entityId])).rows;
}
export async function getThreshold(db, { orgId, entityId }) {
  return Number((await db.query('SELECT threshold_cents FROM cash_plan_setting WHERE org_id = $1 AND entity_id = $2', [orgId, entityId])).rows[0]?.threshold_cents ?? 0);
}
export async function setThreshold(db, { orgId, entityId, text }) {
  const cents = parseMoney(String(text ?? '').trim() || '0');
  if (cents === null) fail('The threshold is an amount like 5,000.00.');
  await db.query(`INSERT INTO cash_plan_setting (org_id, entity_id, threshold_cents) VALUES ($1, $2, $3)
                  ON CONFLICT (org_id, entity_id) DO UPDATE SET threshold_cents = EXCLUDED.threshold_cents`, [orgId, entityId, cents]);
}
export async function addPlanItem(db, { orgId, entityId, fields: f, actor }) {
  const name = String(f.name ?? '').trim().slice(0, 100) || fail('Say what the money is for.');
  const amount = parseMoney(String(f.amount ?? '')) ?? fail('Enter an amount like 1,200.00.');
  if (!amount) fail('Enter an amount more than zero.');
  if (!isIsoDate(f.date)) fail('Choose the date.');
  const repeat = ['none', 'weekly', 'monthly'].includes(f.repeat) ? f.repeat : 'none';
  if (f.until && (!isIsoDate(f.until) || f.until < f.date)) fail('The end date must be after the start.');
  await db.query(`INSERT INTO cash_plan_item (org_id, entity_id, direction, name, amount_cents, start_date, repeat, end_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [orgId, entityId, f.direction === 'out' ? 'out' : 'in', name, amount, f.date, repeat, repeat === 'none' ? null : f.until || null, actor]);
}
export async function deletePlanItem(db, { orgId, entityId, itemId }) {
  await db.query('DELETE FROM cash_plan_item WHERE org_id = $1 AND entity_id = $2 AND item_id = $3', [orgId, entityId, itemId]);
}

// Dates a planned item falls on between from and to.
export function occurrences(item, from, to) {
  const out = [];
  let d = item.start_date;
  let i = 0;
  // Skip ahead to just before `from` so items started years ago still reach the window.
  if (item.repeat === 'weekly' && d < from) d = addDays(d, Math.floor(daysBetween(d, from) / 7) * 7);
  if (item.repeat === 'monthly' && d < from) {
    const [y0, m0] = item.start_date.split('-').map(Number), [y1, m1] = from.split('-').map(Number);
    i = Math.max(0, (y1 - y0) * 12 + (m1 - m0) - 1);
    if (i) { const t = new Date(Date.UTC(y0, m0 - 1 + i, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      d = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(Number(item.start_date.slice(8)), last)).padStart(2, '0')}`; }
  }
  for (let n = 0; n < 400 && d <= to && (!item.end_date || d <= item.end_date); n++, i++) {
    if (d >= from) out.push(d);
    if (item.repeat === 'none') break;
    if (item.repeat === 'weekly') d = addDays(d, 7);
    else {
      const [y, m, day] = item.start_date.split('-').map(Number);
      const t = new Date(Date.UTC(y, m - 1 + i + 1, 1));
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      d = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
    }
  }
  return out;
}

// options: { weeks (4–52), overdue (count overdue invoices/bills in the first week), trend (add the usual cash) }.
export async function cashProjection(db, { orgId, entityId, today, accounts, weeks = 13, overdue = true, trend = false }) {
  const banks = accounts.filter(a => a.type === 'bank');
  const bankIds = new Set(banks.map(a => a.account_id));
  const lines = await ledgerLines(db, { orgId, entityId, to: today });
  const balances = banks.map(a => ({ account: a, balance: lines.filter(l => l.accountId === a.account_id).reduce((s, l) => s + l.amount, 0) }));
  const start = balances.reduce((s, b) => s + b.balance, 0);
  const [ar, ap, items, threshold] = await Promise.all([
    openItems(db, { orgId, entityId, side: 'ar', asOf: today }), openItems(db, { orgId, entityId, side: 'ap', asOf: today }),
    listPlanItems(db, { orgId, entityId }), getThreshold(db, { orgId, entityId })]);
  const end = addDays(today, weeks * 7 - 1);
  const buckets = Array.from({ length: weeks }, (_, i) => ({ from: addDays(today, i * 7), to: addDays(today, i * 7 + 6), moneyIn: 0, moneyOut: 0, planned: 0, usual: 0 }));
  const bucketOf = date => (date < today ? (overdue ? 0 : -1) : date > end ? -1 : Math.floor(daysBetween(today, date) / 7));
  // Charges due count when due; unapplied credits (payments not yet applied, vendor credits) are left out.
  for (const i of ar.filter(x => !x.credit)) { const k = bucketOf(i.due); if (k >= 0) buckets[k].moneyIn += i.open; }
  for (const i of ap.filter(x => !x.credit)) { const k = bucketOf(i.due); if (k >= 0) buckets[k].moneyOut += i.open; }
  for (const it of items) for (const d of occurrences(it, today, end)) buckets[bucketOf(d)].planned += it.direction === 'in' ? Number(it.amount_cents) : -Number(it.amount_cents);
  let usualMonthly = 0;
  if (trend) {
    // The usual: bank money from the last three full months that didn't come from paying invoices or bills.
    const from = addDays(today.slice(0, 8) + '01', 0);
    const threeBack = (() => { const [y, m] = from.split('-').map(Number); const t = new Date(Date.UTC(y, m - 4, 1)); return t.toISOString().slice(0, 10); })();
    const recent = lines.filter(l => bankIds.has(l.accountId) && l.date >= threeBack && l.date < from && !['payment', 'bill_payment', 'deposit', 'transfer'].includes(l.type));
    usualMonthly = Math.round(recent.reduce((s, l) => s + l.amount, 0) / 3);
    for (const b of buckets) b.usual = Math.round((usualMonthly * 7) / 30.4375);
  }
  let balance = start;
  for (const b of buckets) {
    b.start = balance;
    balance += b.moneyIn - b.moneyOut + b.planned + b.usual;
    b.end = balance;
    b.low = b.end < threshold;
  }
  return { today, start, balances, buckets, threshold, items, usualMonthly,
    overdueIn: ar.filter(x => !x.credit && x.due < today).reduce((s, x) => s + x.open, 0), overdueOut: ap.filter(x => !x.credit && x.due < today).reduce((s, x) => s + x.open, 0),
    openIn: ar.filter(x => !x.credit).reduce((s, x) => s + x.open, 0), openOut: ap.filter(x => !x.credit).reduce((s, x) => s + x.open, 0) };
}
