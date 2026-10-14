import { displaySettings } from './display.js';
// Calendar dates are 'YYYY-MM-DD' strings. Arithmetic runs in UTC so DST never shifts a day.
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value) {
  const m = typeof value === 'string' && ISO.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toUtc(iso) {
  if (!isIsoDate(iso)) throw new TypeError(`not an ISO date: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

const fromUtc = ms => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso, days) => fromUtc(toUtc(iso) + days * 86_400_000);
export const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / 86_400_000);

// The calendar date "now" falls on in the given IANA time zone.
export function todayIn(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

// The company's date format (Settings → Accounting): 'mdy' 10/12/26, 'dmy' 12/10/26, 'ymd' 2026-10-12.
// Set for the request or job being handled (lib/domain/display.js), so companies never share it.
export const setDateFormat = f => { displaySettings().dateFormat = ['dmy', 'ymd'].includes(f) ? f : 'mdy'; };

export function formatShortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dateFormat = displaySettings().dateFormat ?? 'mdy';
  if (dateFormat === 'ymd') return iso.slice(0, 10);
  if (dateFormat === 'dmy') return `${d}/${m}/${String(y).slice(2)}`;
  return `${m}/${d}/${String(y).slice(2)}`;
}

export function formatLongDate(iso) {
  return new Date(toUtc(iso)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

export function monthRange(iso) {
  const [y, m] = iso.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from, to: addDays(next, -1) };
}
