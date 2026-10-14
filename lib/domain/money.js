// Money is integer cents everywhere; this is the only place cents become display text.
// Like parseMoney but allows a leading minus sign (budgets, statement balances).
export function parseSignedMoney(text) {
  const s = String(text ?? '').trim();
  if (s.startsWith('-')) { const c = parseMoney(s.slice(1)); return c === null ? null : -c; }
  return parseMoney(s);
}

export function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new TypeError(`cents must be a safe integer: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

const MAX_CENTS = 99_999_999_99; // $999,999,999.99

// User-typed amount -> non-negative cents, or null when it is not a plain amount.
export function parseMoney(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!s || !m || (m[1] === '' && !m[2])) return null;
  const cents = Number(m[1] || 0) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null;
}

// Cents -> plain input text ("1234.50") for prefilling form fields.
export const centsToInput = cents => (cents / 100).toFixed(2);
