// An id typed into a form (a select's value): empty → null; digits → number; anything else (tampered, too long) → the
// caller's error. Keeps "abc" or 25-digit values from reaching SQL as NaN or out-of-range numbers (a 500).
export function formId(value, onBad) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d{1,15}$/.test(s)) return Number(s);
  return onBad();
}
