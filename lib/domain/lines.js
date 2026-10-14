// Quantities are decimals with up to 4 places, carried as BigInt scaled by 10^4 so amounts are exact.
const SCALE = 10_000n;
const MAX_QTY = 999_999n * SCALE;

export function parseQuantity(text) {
  const m = /^(\d{1,7})(?:\.(\d{1,4}))?$/.exec(String(text ?? '').trim().replace(/,/g, ''));
  if (!m) return null;
  const scaled = BigInt(m[1]) * SCALE + BigInt((m[2] ?? '').padEnd(4, '0'));
  return scaled > 0n && scaled <= MAX_QTY ? scaled : null;
}

// round(quantity × rate) to whole cents, half-up.
export function lineAmount(qtyScaled, rateCents) {
  const product = qtyScaled * BigInt(rateCents);
  return Number((product + SCALE / 2n) / SCALE);
}

export function formatQuantity(qtyScaled) {
  const whole = qtyScaled / SCALE, frac = qtyScaled % SCALE;
  return frac === 0n ? String(whole) : `${whole}.${String(frac).padStart(4, '0').replace(/0+$/, '')}`;
}

// The database stores quantity as numeric(14,4); this is its text form.
export const quantityToSql = qtyScaled => formatQuantity(qtyScaled);
