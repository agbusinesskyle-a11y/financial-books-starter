import { addDays, isIsoDate } from './dates.js';

// Recurring schedules anchored on a start date. rule = { unit: 'day'|'week'|'month'|'year', count, start, end? }.
// Occurrence k (k = 0, 1, ...) is start + k*count units; month/year steps keep the start's day of month,
// clamped to the last day of shorter months (Jan 31 → Feb 28 → Mar 31).

export const UNITS = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly']];
const NOUN = { day: 'day', week: 'week', month: 'month', year: 'year' };

function addMonthsClamped(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const year = Math.floor(total / 12), month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function occurrence(rule, k) {
  const n = k * rule.count;
  switch (rule.unit) {
    case 'day': return addDays(rule.start, n);
    case 'week': return addDays(rule.start, n * 7);
    case 'month': return addMonthsClamped(rule.start, n);
    case 'year': return addMonthsClamped(rule.start, n * 12);
    default: throw new TypeError(`unknown unit ${rule.unit}`);
  }
}

// First occurrence on or after `date`, or null if the schedule has ended by then.
export function nextOnOrAfter(rule, date) {
  // Jump close with an estimate, then step; occurrences only grow with k.
  const perStep = { day: 1, week: 7, month: 28, year: 365 }[rule.unit] * rule.count;
  let k = Math.max(0, Math.floor((Date.parse(date) - Date.parse(rule.start)) / 86_400_000 / perStep) - 2);
  while (k > 0 && occurrence(rule, k) >= date) k--;
  for (let guard = 0; guard < 100_000; guard++, k++) {
    const d = occurrence(rule, k);
    if (rule.end && d > rule.end) return null;
    if (d >= date) return d;
  }
  throw new Error('schedule did not converge');
}

export function validateRule({ unit, count, start, end }) {
  if (!NOUN[unit]) return 'Choose how often it repeats.';
  if (!Number.isInteger(count) || count < 1 || count > 365) return 'Repeat every 1 to 365 periods.';
  if (!isIsoDate(start)) return 'Enter the start date.';
  if (end && !isIsoDate(end)) return 'Enter a valid end date, or leave it blank.';
  if (end && end < start) return 'The end date must be after the start date.';
  return null;
}

export function describeRule({ unit, count, start }) {
  const every = count === 1 ? `Every ${NOUN[unit]}` : `Every ${count} ${NOUN[unit]}s`;
  if (unit === 'month' || unit === 'year') {
    const day = Number(start.slice(8));
    const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
    return `${every} on the ${day}${suffix}${day > 28 ? ' (or the month’s last day)' : ''}`;
  }
  if (unit === 'week') return `${every} on ${new Date(`${start}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}`;
  return every;
}
