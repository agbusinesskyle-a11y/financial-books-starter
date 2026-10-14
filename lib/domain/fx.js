// Foreign-currency arithmetic. Rates are home currency per 1 unit of the foreign currency.

export const HOME = 'USD';

// Currencies offered in Settings → Currencies: [code, name].
export const CURRENCIES = [
  ['CAD', 'Canadian dollar'], ['MXN', 'Mexican peso'], ['EUR', 'Euro'], ['GBP', 'British pound'], ['AUD', 'Australian dollar'],
  ['NZD', 'New Zealand dollar'], ['JPY', 'Japanese yen'], ['CNY', 'Chinese yuan'], ['CHF', 'Swiss franc'], ['BRL', 'Brazilian real'],
  ['INR', 'Indian rupee'], ['ZAR', 'South African rand'], ['SEK', 'Swedish krona'], ['NOK', 'Norwegian krone'], ['DKK', 'Danish krone'],
];
export const currencyName = code => CURRENCIES.find(([c]) => c === code)?.[1] ?? code;

export const toHome = (foreignCents, rate) => Math.round(Number(foreignCents) * Number(rate));

// Home amounts for foreign line amounts at one rate, adjusted (largest remainder) so they add up exactly to the
// rounded home total — the ledger needs the lines to equal the total to the cent.
export function allocate(foreignAmounts, rate) {
  const total = toHome(foreignAmounts.reduce((s, a) => s + a, 0), rate);
  const exact = foreignAmounts.map(a => a * Number(rate));
  const out = exact.map(x => Math.round(x));
  let diff = total - out.reduce((s, a) => s + a, 0);
  const order = exact.map((x, i) => [x - Math.round(x), i]).sort((a, b) => (diff > 0 ? b[0] - a[0] : a[0] - b[0]));
  for (let k = 0; diff !== 0 && k < order.length * 2; k++) {
    const i = order[k % order.length][1];
    out[i] += Math.sign(diff);
    diff -= Math.sign(diff);
  }
  return { lines: out, total };
}

// The home amount a part of a foreign document takes, worked out from running totals so the parts add up exactly to the
// document's home amount (paying EUR 0.33 three times can't round past what's open). before = foreign already applied.
export function homeShare({ foreignTotal, foreignOpen, homeOpen, part, rate }) {
  if (part >= Number(foreignOpen)) return Number(homeOpen);
  const before = Number(foreignTotal) - Number(foreignOpen);
  return Math.min(Number(homeOpen), toHome(before + part, rate) - toHome(before, rate));
}

// "EUR 1,234.50" (or "$1,234.50" at home).
export function formatMoney(cents, code = null) {
  const n = (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!code || code === HOME) return `${Number(cents) < 0 ? '-' : ''}$${n.replace('-', '')}`;
  return `${code} ${n}`;
}

// A typed rate like "1.0834" -> Number, or null.
export function parseRate(text) {
  const s = String(text ?? '').trim();
  if (!/^\d{1,8}(\.\d{1,8})?$/.test(s)) return null;
  const r = Number(s);
  return r > 0 ? r : null;
}
