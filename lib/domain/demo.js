// Public demo (DEMO_MODE=1): one link that opens straight into the made-up sample books, no sign-in, for anyone to try.
// Everybody is the same "Demo visitor" (that's the name in the audit log). The data is thrown away and rebuilt from the
// sample every night by `npm run demo-reset`, and the app refuses to run in demo mode against any database that reset
// didn't make (lib/data/demo.js), so real books can never be opened this way.
//
// What a visitor can't do, because it could store a secret, reach the outside world or change how the server is run:
// people and sign-ins, adding companies, the company's identity and logo, email server settings (and every email is
// only recorded, never sent), AI, texted receipts, bank connections, online payments, imports and file uploads; nor
// change settings every visitor shares. Daily jobs don't run; writes and expensive pages are rate limited.

export const DEMO_ACTOR = 'Demo visitor';
export const DEMO_ORG = 'sample';
export const DEMO_NOTE = 'Demo — sample data, anyone can see and change it. Resets every night.';
export const demoBanner = () => `<div class="practice-banner demo-banner" role="status">${DEMO_NOTE}</div>`;
export const DEMO_ROBOTS = 'User-agent: *\nDisallow: /\n';

export const isDemo = (env = process.env) => env.DEMO_MODE === '1';

// Settings that mean "this is somebody's real, configured server". A demo has none of them, so a demo switched on by
// mistake in a real deployment stops instead of opening those books to the world.
const NOT_IN_DEMO = [
  ['SETTINGS_KEY', 'without it nothing secret (mail passwords, AI or Twilio keys, tax IDs, bank details) can be saved'],
  ['APP_LOGIN_PASSWORD_HASH', 'a demo has no sign-in'],
  ['APP_TOTP_SECRET', 'a demo has no sign-in'],
  ['APP_OWNER_USER_ID', 'a demo has no owner account designation'],
  ['DEV_NO_AUTH', 'a demo has its own no-sign-in visitor'],
  ['LEDGERLINE_URL', 'a demo has no bank feeds'],
  ['LEDGERLINE_ORG_ID', 'a demo has no bank feeds'],
  ['PAYMENTS_TEST_MODE', 'a demo takes no online payments'],
];

// A safety switch mustn't fail open on a typo: DEMO_MODE is unset, "0" or "1", nothing else. With "1", the rest of the
// environment must look like a demo too. Returns 'demo' or 'off'; throws with every reason otherwise.
export function checkDemoMode(env = process.env) {
  const v = env.DEMO_MODE;
  if (v === undefined || v === '' || v === '0') return 'off';
  if (v !== '1') throw new Error(`DEMO_MODE must be "1" (public demo) or "0" (or unset), not ${JSON.stringify(v)}.`);
  const problems = [];
  if (env.APP_ORG && env.APP_ORG !== DEMO_ORG) problems.push(`APP_ORG is "${env.APP_ORG}": a demo only opens the "${DEMO_ORG}" books (leave APP_ORG unset)`);
  if (env.BOOKS_MODE) problems.push('BOOKS_MODE is set: a demo is not a practice copy (leave BOOKS_MODE unset)');
  for (const [name, why] of NOT_IN_DEMO) if (env[name]) problems.push(`${name} is set: ${why} (remove it)`);
  if (problems.length) throw new Error(`DEMO_MODE=1 refused:\n  - ${problems.join('\n  - ')}`);
  return 'demo';
}

// What a demo visitor may not do: [path pattern, which requests ('all' or 'write' = anything but GET), why].
const OFF = 'is turned off in this public demo';
export const DEMO_BLOCKS = [
  [/^\/settings\/morning\/(viewer|delivery|transport-approve|preferences)$/, 'write', 'Morning messages and viewer changes are off in the demo'],
  [/^\/settings\/users(\/|$)/, 'all', `Users and sign-ins: ${OFF}. Everyone here is the same Demo visitor.`],
  [/^\/settings\/companies(\/|$)/, 'all', `Adding companies ${OFF}.`],
  [/^\/settings\/company(\/|$)/, 'write', `Changing the company’s name, details and logo ${OFF}.`],
  [/^\/settings\/email(\/|$)/, 'all', `Email settings: ${OFF}. Emails are recorded on the customer’s or vendor’s page, never sent.`],
  [/^\/settings\/ai(\/|$)/, 'all', `AI help ${OFF}.`],
  [/^\/settings\/text-receipts(\/|$)/, 'all', `Texted receipts ${OFF}.`],
  [/^\/(settings\/bank-feeds|bank-feeds)(\/|$)/, 'all', `Bank connections ${OFF}.`],
  [/^\/settings\/payments(\/|$)/, 'all', `Online payments ${OFF}.`],
  [/^\/(import|vendors\/import|banking\/rules\/import)(\/|$)/, 'all', `Importing ${OFF}.`],
  // Settings every visitor shares that change how every page reads (dates, accounting method, currencies, forms, report
  // defaults), and taking back a finished reconciliation, stay as the sample has them.
  [/^\/settings\/(accounting|currencies|form-styles|sales|messages)(\/|$)/, 'write', `Changing settings every visitor shares ${OFF}.`],
  [/^\/reports\/r\/[a-z0-9_]+\/default$/, 'write', `Changing a report’s default settings for every visitor ${OFF}. Run it with your own settings instead.`],
  [/^\/reconcile\/\d{1,18}\/undo$/, 'write', `Undoing a reconciliation ${OFF}.`],
  [/^\/vendors\/\d{1,18}\/ask$/, 'write', `Asking a vendor for their details ${OFF}.`],
  [/^\/banking\/item\/\d{1,18}\/research$/, 'write', `AI research ${OFF}.`],
  [/^\/banking\/research\/\d{1,18}\/(accept|reject)$/, 'write', `AI research ${OFF}.`],
  // A file on a bank line (an upload, or a copy of a texted receipt): the demo keeps no files.
  [/^\/banking\/item\/\d{1,18}\/(attach|attachment\/\d{1,18}\/delete)$/, 'write', `File uploads ${OFF}.`],
  // Tax Books: the shared parties hold tax ids (and need SETTINGS_KEY, which a demo never has) — the directory (/tax/parties), the older
  // per-company path, and settling a company's EIN conflict (/tax/:entity/parties/:party/ein, which rewrites an EIN).
  [/^\/tax\/(\d{1,18}\/)?parties(\/|$)/, 'write', `Tax parties and tax ids ${OFF}.`],
  // The mapping page's AI proposals (not built yet; the routes answer "not found" today): closed in the demo all the same.
  [/^\/tax\/\d{1,18}\/\d{4}\/mapping\/ai(-accept|-reject)?$/, 'all', `AI help ${OFF}.`],
  [/^\/vtxns\/read$/, 'all', `Reading a bill or receipt with AI ${OFF}.`],
];
// Public (no sign-in) links that reach outside people or services.
export const DEMO_PUBLIC_BLOCKS = [
  [/^\/(pay|webhooks)\//, `Online payments ${OFF}.`],
  [/^\/twilio\//, `Texted receipts ${OFF}.`],
  [/^\/invite\//, `Invitations ${OFF}.`],
  [/^\/vendor-info\//, `Vendor information links ${OFF}.`],
];
export const DEMO_UPLOADS_OFF = `File uploads ${OFF}. Everything else on this page works.`;

// The reason a demo visitor can't make this request, or null.
export function demoBlock(method, path) {
  for (const [re, which, why] of DEMO_BLOCKS) if (re.test(path) && (which === 'all' || method !== 'GET')) return why;
  return null;
}
export function demoPublicBlock(path) {
  for (const [re, why] of DEMO_PUBLIC_BLOCKS) if (re.test(path)) return why;
  return null;
}

// Writes per visitor address, and across all visitors, in a 10-minute window (services/app/http.js tooMany).
export const DEMO_WRITES_PER_IP = 120;
export const DEMO_WRITES_ALL = 3000;
// Pages that take real work to build — reports, exports, PDFs, spreadsheets, ZIPs, search, print batches — are limited
// too: per address and overall in a 10-minute window, and only a few at once.
// Routes that act on many transactions at once (print, send, batch actions): heavy, and at most DEMO_BATCH_MAX selections
// (a bank review "all N matching" counts as N).
// Tracking vendors for 1099s takes a list of vendors too (one change and one activity event each), and so does accepting every
// sure tax-mapping suggestion the page showed (one binding set saved per suggestion), or marking the remaining typed tax items
// not applicable (one saved answer per key; the page already offers 25 at a time).
export const DEMO_BULK = /\/batch(\/confirm)?$|^\/sales-queue\/(print|send)$|^\/checks\/print(ed)?$|^\/vendors\/1099\/track$|^\/tax\/\d{1,18}\/\d{4}\/mapping\/accept-sure$|^\/tax\/\d{1,18}\/\d{4}\/manual\/rest$/;
// Every tax worksheet/workpaper page, its action POSTs (including validation rerenders), and working revisions need
// admission before dispatch: they can compute a whole return. Include every action under these sections.
export const DEMO_HEAVY = /^\/(reports|export|search|attachments|overview|home)(\/|$|\.)|\.(pdf|xlsx|csv|zip)$|\/batch(\/confirm)?$|^\/(checks\/print(ed)?|sales-queue\/(print|send))$|^\/tax\/\d{1,18}\/\d{4}(\/(manual|adjustments|cash|cogs|revisions)(\/|$)|$)/;
// A management package renders at most this many sections in the demo (each one a full report).
export const DEMO_MGMT_SECTIONS = 6;
export const DEMO_HEAVY_PER_IP = 150;
export const DEMO_HEAVY_ALL = 3000;
export const DEMO_HEAVY_AT_ONCE = 4;
// The most years a report may span, and the most items a print or send batch takes, in the demo.
export const DEMO_REPORT_YEARS = 10;
export const DEMO_BATCH_MAX = 25;
// Most visitor sessions kept in memory (the least recently used is dropped first), and one-time form ids per session.
export const DEMO_MAX_SESSIONS = 2000;
export const DEMO_FORMS_PER_SESSION = 100;
// How often the running demo re-checks its database (and notices the nightly reset, which starts every session afresh).
export const DEMO_CHECK_MS = 60_000;
