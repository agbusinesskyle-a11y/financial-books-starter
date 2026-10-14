// Vendor rules that don't touch the database.

export const VENDOR_CHARGE_TYPES = ['bill'];
export const VENDOR_CREDIT_TYPES = ['vendor_credit'];

const digits = s => String(s ?? '').replace(/[\s-]/g, '');

// ABA routing numbers: 9 digits with a 3-7-1 weighted checksum.
export function validRouting(text) {
  const d = digits(text);
  if (!/^\d{9}$/.test(d)) return null;
  const n = [...d].map(Number);
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0 ? d : null;
}

// Bank account numbers: 4 to 17 digits.
export const validBankAccount = text => (/^\d{4,17}$/.test(digits(text)) ? digits(text) : null);

// EIN (12-3456789) or SSN (123-45-6789): 9 digits, kept in the format typed (normalized).
export function validTaxId(text) {
  const raw = String(text ?? '').trim();
  const d = raw.replace(/\D/g, '');
  if (d.length !== 9 || /^0{9}$/.test(d)) return null;
  return /^\d{3}-\d{2}-\d{4}$/.test(raw) ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : `${d.slice(0, 2)}-${d.slice(2)}`;
}

export const masked = last4 => (last4 ? `•••${last4}` : '');

export function formatAddress(a) {
  if (!a) return '';
  return [a.line1, a.line2, [a.city, [a.state, a.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
}
