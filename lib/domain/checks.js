// Check printing helpers.

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];

function under1000(n) {
  const out = [];
  if (n >= 100) { out.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '')); } else if (n) out.push(ONES[n]);
  return out.join(' ');
}

// 123456 -> "One thousand two hundred thirty-four and 56/100"
export function amountInWords(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('amount must be whole cents, not negative');
  let dollars = Math.floor(cents / 100);
  const parts = [];
  for (const [size, name] of SCALES) {
    if (dollars >= size) { parts.push(`${under1000(Math.floor(dollars / size))} ${name}`); dollars %= size; }
  }
  if (dollars) parts.push(under1000(dollars));
  const words = parts.join(' ') || 'zero';
  return `${words[0].toUpperCase()}${words.slice(1)} and ${String(cents % 100).padStart(2, '0')}/100`;
}

// The written line on a check is padded with asterisks so nothing can be added after it.
export const checkWords = (cents, width = 70) => `${amountInWords(cents)} `.padEnd(width, '*');

export const PAYMENT_METHODS = ['Check', 'ACH', 'Credit card', 'Debit card', 'Cash', 'Other'];
