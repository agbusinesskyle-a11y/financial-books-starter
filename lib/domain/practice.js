// Practice mode (changeover CH-2): BOOKS_MODE=practice marks a copy of the books run alongside QuickBooks,
// which stays the official books. Nothing here acts on its own: no daily jobs (recurring, late fees, reminders, scheduled
// bill payments or report emails), no email or texts (sends are recorded; texted receipts get no reply), no online
// payments, no posting repairs at startup, and bank refreshes, automatic rules and texted receipts only suggest — every
// add or match is done by a person, item by item (a transfer doesn't match the other account's bank line by itself).
// What a person's own save does to other records is allowed, as in QuickBooks: re-costing inventory sold after a
// back-dated purchase, moving an item's postings when its accounts change, and applying a payment or credit to open
// invoices or bills when the company's Settings → Accounting "automatically apply" option is on (off unless turned on).
export const isPractice = (env = process.env) => env.BOOKS_MODE === 'practice';

// A safety switch mustn't fail open on a typo: BOOKS_MODE is unset, "live" or "practice", nothing else.
export function checkBooksMode(env = process.env) {
  const v = env.BOOKS_MODE;
  if (v === undefined || v === '' || v === 'live' || v === 'practice') return v === 'practice' ? 'practice' : 'live';
  throw new Error(`BOOKS_MODE must be "practice" or "live" (or unset), not ${JSON.stringify(v)}.`);
}

export const PRACTICE_NOTE = 'Practice copy — QuickBooks is the official books. Nothing is emailed, texted, charged or posted automatically here.';
export const practiceBanner = () => `<div class="practice-banner" role="status">${PRACTICE_NOTE}</div>`;
