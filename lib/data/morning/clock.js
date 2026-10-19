import { todayIn, addDays } from '../../domain/dates.js';

export const PHOENIX = 'America/Phoenix';
export const phoenixDate = instant => todayIn(PHOENIX, instant);
export function phoenixMinute(instant) {
  const d = new Date(instant.getTime() - 7 * 3600000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
export const nextPhoenixMidnight = instant => new Date(`${addDays(phoenixDate(instant), 1)}T07:00:00Z`);
export function formatPhoenix(instant) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: PHOENIX, weekday: 'long' }).format(instant);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: PHOENIX, hour: 'numeric', minute: '2-digit', hour12: true }).format(instant).toLowerCase();
  return `${day} ${time} ${PHOENIX}`;
}
export class UnsafeAmountError extends Error {
  constructor() { super('Amount unavailable'); this.name = 'UnsafeAmountError'; }
}
const checked = n => { if (!Number.isSafeInteger(n)) throw new UnsafeAmountError(); return n; };
export function centsFromDb(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value))) throw new UnsafeAmountError();
  return checked(Number(value));
}
export const addCents = (a, b) => checked(checked(a) + checked(b));
export const subCents = (a, b) => checked(checked(a) - checked(b));
export const negCents = a => checked(-checked(a));
export const absCents = a => checked(Math.abs(checked(a)));
export const sumCents = list => list.reduce(addCents, 0);
