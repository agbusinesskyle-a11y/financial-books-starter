// The bank's own wording (stage S1). Most transactions in the books — imported from QuickBooks or added from a bank
// line here — keep the bank's text as their memo ("QUILLBACK MU ISA PAYMNT PPD ID: 9000123456"). A new bank line worded
// like earlier ones is very likely the same kind of thing: the same payee and the same category.
//
// Replay on the real books (2026-10-15, 6,671 lines, each predicted only from earlier transactions): "high" for 47% of
// lines with payee and category right 96.8% of the time; "medium" for another 12%.

// Bank boilerplate that says nothing about who was paid.
const STOP = new Set(('ORIG CO NAME ENTRY DESCR SEC PPD CCD WEB ID TEL ACH POS DEBIT CARD CHECKCARD PURCHASE RECURRING ONLINE '
  + 'INC LLC COM WWW THE OF AND TO FROM PAID IND DESC DATE').split(' '));

// The words of a bank text: upper case, before the import's " · Paid to …" tail, without boilerplate, masked digits (XX),
// 1–3 digit numbers (dates, amounts) or one-off reference codes (letters and digits mixed, 6 or more: 5943K7DE2). Longer
// plain numbers stay: an account's last four ("*6150" vs "*8250") or an ACH company id is the best evidence there is (a
// one-off number, such as a date, appears only once and so never counts — see wordingNeighbours).
export function wordingTokens(text) {
  const s = String(text ?? '').split(' · ')[0].toUpperCase();
  return [...new Set(s.split(/[^A-Z0-9]+/).filter(w => w.length >= 2 && !STOP.has(w) && !/X{2,}/.test(w) && !/^\d{1,3}$/.test(w)
    && !(/\d/.test(w) && /[A-Z]/.test(w) && w.length >= 6)))];
}

// The other account a bank text names by its last four ("WEB TFR TO *8150", "card ending in 5850", "CHK ...1350"): two
// texts naming different ones are about different accounts, however alike the rest.
export function wordingAccounts(text) {
  return [...new Set([...String(text ?? '').matchAll(/(?:\*\s?|ending in\s+|\.\.\.)(\d{4})\b/gi)].map(m => m[1]))];
}

// Two texts say the same thing: most of the shorter one's words are in the other, and one of the shared words is a real
// word or id (4+ characters). Used without a corpus (the duplicate check).
export function sameWording(a, b) {
  const x = wordingTokens(a), y = new Set(wordingTokens(b));
  if (!x.length || !y.size) return false;
  const shared = x.filter(w => y.has(w));
  return shared.some(w => w.length >= 4) && shared.length / Math.min(x.length, y.size) >= 0.6;
}

const CLOSE = 0.75, RECENT = 5;

// A vendor's or customer's name is in a bank line's text (stage S4): every real word of the name (3+ characters, not
// payment wording or a plain number) is among the line's words — "Q&Z Farm & Home" in "Q&Z FARM HOME PAYMENTS …", but not
// "Q&Z Farm & Home - Denton". A name with no such word is never found.
export function namedIn(name, item) {
  const words = new Set([...wordingTokens(item.description), ...wordingTokens(item.merchant_name)]);
  const mine = nameWords(name);
  return mine.length > 0 && mine.every(x => words.has(x));
}
const nameWords = name => wordingTokens(name).filter(x => x.length >= 3 && !GENERIC.has(x) && !/^\d+$/.test(x));
// Who a bank line is from, for sharing vendor research between its lines (stage S5): the real words of the feed's merchant
// name, else of the bank text — no boilerplate, payment wording or numbers. "ORIG CO NAME:QUILLBACK MU CO ENTRY…" is
// "QUILLBACK MU ISA", never "ORIG CO NAME" (which every ACH line would share).
// A merchant name keeps its numbers ("Studio 54" isn't "Studio 88"). A bank text that comes down to one word only by
// dropping its numbers doesn't say which business it is: that line's research is its own (keyed by the line), never shared.
export function researchKey(item) {
  // Every word and number of a text, apart from boilerplate and payment wording (masked digits too).
  const raw = t => String(t ?? '').split(' · ')[0].toUpperCase().split(/[^A-Z0-9]+/).filter(x => x && !STOP.has(x) && !GENERIC.has(x) && !/X{2,}/.test(x));
  const m = raw(item.merchant_name);
  if (m.length) return m.join(' ').slice(0, 100);
  // The bank text: dates out first (10/07, 10/07/26); short numbers stay (a name's "54" — "STUDIO 54 NEW YORK" isn't
  // "STUDIO 88 NEW YORK"); longer ones (store numbers, ids, references) go.
  const all = raw(String(item.description ?? '').replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' '));
  const words = all.filter(x => x.length >= 2 && /[A-Z]/.test(x) && !/\d/.test(x) || /^\d{1,3}$/.test(x));
  if (words.filter(x => /[A-Z]/.test(x)).length === 1 && all.some(x => /^\d{4,}$/.test(x) || (/\d/.test(x) && /[A-Z]/.test(x))) && item.ll_transaction_id) return `line:${item.ll_transaction_id}`;
  return words.join(' ').slice(0, 100);
}

// The parties ({ key, name }) a bank line names, the most specific only: "KESTREL MILL DENTON" names "Kestrel Mill - Denton",
// not also "Kestrel Mill" (whose words are all in the other's).
export function namedParties(parties, item) {
  const named = parties.filter(p => namedIn(p.name, item)).map(p => ({ ...p, words: new Set(nameWords(p.name)) }));
  return named.filter(p => !named.some(q => q !== p && q.words.size > p.words.size && [...p.words].every(x => q.words.has(x))))
    .map(({ words, ...p }) => p);
}
// Payment processors and transfer wording: shared, they say how something was paid, not who was paid ("SP" is any
// Shopify store, "SQ" any Square seller). Two texts sharing only these aren't alike.
const GENERIC = new Set('SP SQ TST DD PAYPAL ZELLE VENMO TFR FR PMT PYMT PYMENT PAYMNT SENT TRANSFER FUNDS VIA EDI'.split(' '));

// The company's bank and card transactions of the last 24 months that went wholly to one ordinary account: an expense or
// check debiting one account, or a deposit or card credit crediting one, nothing on a system account (A/R, A/P, stock, Undeposited
// Funds). Each with its words, party key (v:/c:) and category. The index answers "which earlier ones share this word".
export async function wordingHistory(db, { orgId, entityId }) {
  const { rows } = await db.query(`
    WITH t AS (SELECT t.txn_id, t.txn_date, t.type, t.account_id, t.memo, txn_party_key(t.txn_id) AS party FROM txn t JOIN account a ON a.account_id = t.account_id
                WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type IN ('expense', 'check', 'deposit', 'cc_payment', 'transfer', 'cc_credit') AND t.voided_at IS NULL
                  AND a.type IN ('bank', 'credit_card') AND t.memo IS NOT NULL AND t.txn_date >= current_date - interval '24 months')
    SELECT t.txn_id, t.txn_date::text AS txn_date, t.memo, t.party, min(p.account_id) AS category,
           (SELECT sum(q.amount_cents) FROM posting q WHERE q.txn_id = t.txn_id AND q.account_id = t.account_id)::bigint AS cents
      FROM t JOIN posting p ON p.txn_id = t.txn_id AND p.account_id <> t.account_id JOIN account a ON a.account_id = p.account_id
     GROUP BY t.txn_id, t.txn_date, t.memo, t.party, t.account_id
    HAVING count(DISTINCT p.account_id) = 1 AND bool_and(a.system_key IS NULL)
       AND (bool_and(p.amount_cents > 0) OR bool_and(p.amount_cents < 0))`, [orgId, entityId]);
  return buildWording(rows);
}

// rows: { txn_id, txn_date 'YYYY-MM-DD', memo, party, category, cents (on the bank side) }.
export function buildWording(rows) {
  const docs = [], df = new Map(), index = new Map();
  for (const r of rows) {
    const cents = Number(r.cents);
    // The category is on the other side of the money: debited for money out, credited for money in.
    const doc = { txnId: Number(r.txn_id), date: r.txn_date, out: cents < 0, party: r.party ?? null, accountId: Number(r.category), words: wordingTokens(r.memo),
      accounts: wordingAccounts(r.memo) };
    if (!cents || !doc.words.length) continue;
    docs.push(doc);
    for (const w of doc.words) { df.set(w, (df.get(w) ?? 0) + 1); (index.get(w) ?? index.set(w, []).get(w)).push(doc); }
  }
  return { docs, df, index, n: docs.length };
}

// The earlier transactions worded like this bank line (same direction), most alike first, with their score: the weight of
// the shared words over the larger side's weight (rare words weigh more). `before`: only transactions dated before it.
// Scored on the bank's text, and again with the feed's tidied merchant name added ("Quillback Mutual Life" for
// "QUILLBACK MU"); the better of the two counts — the merchant name only ever adds support.
export function wordingNeighbours(w, item, { before = null } = {}) {
  if (!w?.n) return [];
  const bank = wordingTokens(item.description);
  const withMerchant = [...new Set([...bank, ...wordingTokens(item.merchant_name)])];
  const best = new Map();
  for (const words of withMerchant.length > bank.length ? [bank, withMerchant] : [bank]) {
    for (const n of scored(w, words, Number(item.amount_cents) < 0, before)) if (!(best.get(n.doc)?.score >= n.score)) best.set(n.doc, n);
  }
  // Both name the other account, and not the same one: a different counterparty.
  const mine = wordingAccounts(item.description);
  if (mine.length) for (const d of best.keys()) if (d.accounts.length && !d.accounts.some(a => mine.includes(a))) best.delete(d);
  return [...best.values()].sort((x, y) => y.score - x.score || (y.doc.date > x.doc.date ? 1 : y.doc.date < x.doc.date ? -1 : 0) || y.doc.txnId - x.doc.txnId);
}
function scored(w, words, out, before) {
  const idf = x => Math.log((w.n + 1) / (w.df.get(x) ?? 0.5));
  const known = words.filter(x => w.df.has(x));
  if (!known.length) return [];
  // A word of this line's that the books have never seen (a store's name) counts against every earlier one, as a word
  // seen once would; a number never seen (a date, a reference) doesn't, nor payment wording, which differs between banks
  // and feeds (PYMENT, PAYMNT) and says nothing about the payee.
  const unseen = words.filter(x => !w.df.has(x) && /^[A-Z]{3,}$/.test(x) && !GENERIC.has(x)).length * Math.log((w.n + 1) / 1);
  const mine = known.reduce((t, x) => t + idf(x), 0) + unseen;
  const specific = new Set(known.filter(x => !GENERIC.has(x)));
  const shared = new Map();
  for (const x of known) for (const d of w.index.get(x)) if (d.out === out && (!before || d.date < before)) shared.set(d, (shared.get(d) ?? 0) + idf(x));
  // An earlier transaction's words that no other transaction has (a date, a confirmation number) say nothing about what
  // kind of thing it was: they don't count against it.
  const theirs = d => d.words.reduce((t, x) => t + ((w.df.get(x) ?? 0) > 1 ? idf(x) : 0), 0);
  return [...shared].filter(([d]) => d.words.some(x => specific.has(x))).map(([d, t]) => ({ doc: d, score: t / Math.max(mine, theirs(d)) }));
}

// What the closest earlier ones say. The five most recent close ones decide (the books change their minds; the latest
// is what counts). The category: high — three or more, all the same; medium — two or more, two thirds the same. The payee,
// from those with that category: named by at least two and contradicted by none, else none is suggested (high also needs
// that: a payee, or none of them named). Otherwise nothing. `usable(accountId, payee)`: still active records.
// Only ever a prefill for a person to post: never taken by batch Accept (planOf).
export function wordingSuggestion(w, item, { usable = () => true } = {}) {
  const close = wordingNeighbours(w, item).filter(n => n.score >= CLOSE)
    .sort((a, b) => (b.doc.date > a.doc.date ? 1 : b.doc.date < a.doc.date ? -1 : 0) || b.doc.txnId - a.doc.txnId);
  const recent = close.slice(0, RECENT).map(n => n.doc);
  if (recent.length < 2) return null;
  const top = (list, key) => {
    const c = new Map();
    for (const d of list) c.set(key(d), (c.get(key(d)) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] ?? [null, 0];
  };
  const [accountId, count] = top(recent, d => d.accountId);
  const named = recent.filter(d => d.accountId === accountId && d.party);
  const [party, pcount] = named.length ? top(named, d => d.party) : [null, 0];
  const payee = pcount >= 2 && pcount === named.length ? party : null;
  const confidence = recent.length >= 3 && count === recent.length && (payee || !named.length) ? 'high'
    : count >= 2 && count / recent.length >= 2 / 3 ? 'medium' : null;
  if (!confidence || !usable(accountId, payee)) return null;
  return { confidence, accountId, payee, count, of: recent.length, last: recent[0].date, total: close.length };
}
