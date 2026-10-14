import { addDays } from './dates.js';

// Late-fee math, no database. policy = { fee_kind, flat_cents, percent_bps, grace_days,
// repeat_every_days (null = one time), max_fees_per_invoice, effective_from }.

// Fee for one assessment. Percent is of the invoice's open amount, rounded half up to the cent.
export function feeAmount(policy, openCents) {
  if (policy.fee_kind === 'flat') return policy.flat_cents;
  return Math.floor((openCents * policy.percent_bps + 5000) / 10000);
}

// Dates a fee is due on an invoice through `through`: the first day after due date + grace, then every
// repeat_every_days. Dates before the policy took effect are skipped. At most max_fees_per_invoice in
// total, counting `alreadyCharged` (dates already assessed). Returns only new dates, oldest first.
export function feeDates(policy, dueDate, through, alreadyCharged = []) {
  const charged = new Set(alreadyCharged);
  let room = policy.max_fees_per_invoice - charged.size;
  const out = [];
  let d = addDays(dueDate, policy.grace_days + 1);
  for (let i = 0; i < 1000 && room > 0 && d <= through; i++) {
    if (d >= policy.effective_from && !charged.has(d)) { out.push(d); room--; }
    if (!policy.repeat_every_days) break;
    d = addDays(d, policy.repeat_every_days);
  }
  return out;
}

export function describePolicy(p) {
  if (!p.enabled) return 'Late fees are off for this company.';
  const amount = p.fee_kind === 'flat' ? `$${(p.flat_cents / 100).toFixed(2)}` : `${(p.percent_bps / 100).toFixed(2).replace(/\.?0+$/, '')}% of the open balance`;
  const when = p.grace_days ? `once an invoice is more than ${p.grace_days} day${p.grace_days === 1 ? '' : 's'} past due` : 'the day after an invoice’s due date';
  const repeat = p.repeat_every_days ? `, then every ${p.repeat_every_days} days while unpaid (up to ${p.max_fees_per_invoice} per invoice)` : ' (once per invoice)';
  return `${amount} charged ${when}${repeat}.`;
}
