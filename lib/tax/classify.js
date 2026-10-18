// lib/tax/classify.js
// Book entry classification (spec §4.12, §5.2, §13.1 T3): journal entries of the period that move income or expense into equity — dated on
// the period's last or first day (a year-end closing, a January 1 closing of the year before) or numbered as a preparer's entry — are
// CANDIDATES (proposed by shape, never applied by themselves) until a person decides:
//   closing     the listed lines — income and expense lines with the equity lines that close them, balanced on their own — are removed from
//               every Tax Books measurement of the period, both legs together (lib/tax/measure.js closingExclusions), so retained earnings
//               is not counted twice against the period's net income; the entry's other lines (a genuine correction inside a mixed
//               journal) stay;
//   correction  the entry is a genuine correction and stays as posted;
//   normal      the entry stays as posted.
// An undecided or stale candidate (its transaction changed after the decision) blocks every account it touches: the engine computes no
// number from them (unknown, never zero). tax_only and opening are spec classes this stage refuses. Reads take one snapshot; the write
// takes the graph lock and the company lock (lib/tax/open-return.js) and checks the transaction as the person saw it.
import { withTransaction } from '../db.js';
import { ValidationError } from '../data/writes.js';
import { PL_TYPES } from '../reports/statements.js';
import { openTaxReturn, idOf, personOf } from './open-return.js';

const fail = message => { throw new ValidationError(message); };
export const CLASSES = [['closing', 'Closing entry: remove the listed lines'], ['correction', 'Genuine correction: keep as posted'], ['normal', 'Ordinary entry: keep as posted']];
const isPl = type => PL_TYPES.includes(type);
// A preparer's entry number (adjusting, closing, reversing entries "AJE-1", "CJE 2", "RJE3"; "CPA 3"; "ADJ-12"), never a word that only
// starts like one ("Ajen supplies"). \b is the regex word boundary (two characters in the source, never a control character).
export const PREPARER_NUMBER = /^\s*(a|c|r)je(\b|\d)|^\s*(cpa|adj|clos)/i;

// The candidates of one return's own books, with any decision recorded for them. → [{ txnId, date, docNumber, memo, txnVersion, lines:
// [{ lineNo, accountId, accountName, type, cents }], proposed: [lineNo], balanced, decision: row | null, state: 'open' | 'decided' | 'stale' }]
// An entry with a decision stays a candidate whatever it has become (renumbered, redated, its lines changed, deleted): a decision is never
// dropped because its entry no longer has a candidate's shape — it is stale, and blocks what the entry touches, until made again or cleared.
export async function closingCandidates(db, { orgId, ret }) {
  const { rows: decided } = await db.query(`SELECT classification_id, txn_id, class, lines, accounts, account_domains, txn_version, reviewed_by, reason FROM book_entry_classification
     WHERE org_id = $1 AND return_id = $2 AND source_entity_id = $3`, [orgId, ret.return_id, ret.entity_id]);
  const decidedIds = decided.map(d => Number(d.txn_id));
  const { rows } = await db.query(`SELECT t.txn_id, t.type AS txn_type, t.txn_date::text AS date, t.doc_number, t.memo, txn_version(t.txn_id) AS v, p.line_no, p.account_id, a.name, a.type, p.amount_cents::text AS cents
      FROM txn t JOIN posting p ON p.org_id = t.org_id AND p.txn_id = t.txn_id JOIN account a ON a.org_id = p.org_id AND a.account_id = p.account_id
     WHERE t.org_id = $1 AND t.entity_id = $2 AND (t.txn_id = ANY($6::bigint[]) OR (t.type = 'journal_entry' AND t.txn_date BETWEEN $3::date AND $4::date
       AND EXISTS (SELECT 1 FROM posting q JOIN account x ON x.org_id = q.org_id AND x.account_id = q.account_id WHERE q.org_id = t.org_id AND q.txn_id = t.txn_id AND x.type = ANY($5::text[]))
       AND EXISTS (SELECT 1 FROM posting q JOIN account x ON x.org_id = q.org_id AND x.account_id = q.account_id WHERE q.org_id = t.org_id AND q.txn_id = t.txn_id AND x.type = 'equity')))
     ORDER BY t.txn_date, t.txn_id, p.line_no`, [orgId, ret.entity_id, ret.period_start, ret.period_end, PL_TYPES, decidedIds]);
  const byTxn = new Map();
  for (const r of rows.filter(x => decidedIds.includes(Number(x.txn_id)) || x.date === ret.period_start || x.date === ret.period_end || PREPARER_NUMBER.test(x.doc_number ?? ''))) {
    const id = Number(r.txn_id);
    // eligible: a journal entry of this period — the only kind a person may classify now; a decided entry outside that is listed, never re-decided.
    if (!byTxn.has(id)) byTxn.set(id, { txnId: id, date: r.date, docNumber: r.doc_number, memo: r.memo, txnVersion: r.v, lines: [],
      eligible: r.txn_type === 'journal_entry' && r.date >= ret.period_start && r.date <= ret.period_end });
    byTxn.get(id).lines.push({ lineNo: r.line_no === null ? null : Number(r.line_no), accountId: Number(r.account_id), accountName: r.name, type: r.type, cents: BigInt(r.cents) });
  }
  // A decided entry that has no postings any more (deleted): still listed, stale.
  for (const d of decided) if (!byTxn.has(Number(d.txn_id))) byTxn.set(Number(d.txn_id), { txnId: Number(d.txn_id), date: null, docNumber: null, memo: null, txnVersion: null, lines: [], eligible: false });
  return [...byTxn.values()].map(c => {
    const proposed = c.lines.filter(l => l.lineNo !== null && (isPl(l.type) || l.type === 'equity'));
    const d = decided.find(x => Number(x.txn_id) === c.txnId) ?? null;
    return { ...c, proposed: proposed.map(l => l.lineNo), balanced: proposed.reduce((t, l) => t + l.cents, 0n) === 0n,
      decision: d, state: !d ? 'open' : d.txn_version === c.txnVersion && c.eligible ? 'decided' : 'stale' };
  });
}
// The accounts an undecided or stale candidate blocks (Map accountId → reason).
export function blockedByCandidates(candidates) {
  const out = new Map();
  for (const c of candidates) if (c.state !== 'decided') {
    const why = c.state === 'stale' ? `Journal entry ${c.docNumber || c.txnId} changed after it was classified: classify it again.`
      : `Journal entry ${c.docNumber || c.txnId} (${c.date}) may be a closing entry: classify it on the cash and closings page.`;
    for (const l of c.lines) if (isPl(l.type) || l.type === 'equity') out.set(l.accountId, why);
    // What a stale decision decided, even after its lines changed or went: the accounts recorded with it.
    for (const id of c.decision?.accounts ?? []) out.set(Number(id), why);
  }
  return out;
}
// The domains each blocked account is held in (Map accountId → ['income' | 'balance']): an undecided entry's lines as they are (income for an
// income or expense line, balance for equity), and a saved decision's accounts as SAVED with it (account_domains) — never the account as it
// is now; a saved account with no saved domain is held in both.
export function blockedDomains(candidates) {
  const out = new Map(), add = (id, d) => { const s = out.get(id) ?? new Set(); s.add(d); out.set(id, s); };
  for (const c of candidates) if (c.state !== 'decided') {
    for (const l of c.lines) if (isPl(l.type) || l.type === 'equity') add(l.accountId, isPl(l.type) ? 'income' : 'balance');
    const ds = c.decision?.account_domains ?? [];
    (c.decision?.accounts ?? []).forEach((id, i) => { if (ds[i]) add(Number(id), ds[i]); else { add(Number(id), 'income'); add(Number(id), 'balance'); } });
  }
  return new Map([...out].map(([id, s]) => [id, [...s]]));
}

// Record a person's decision on one candidate. lines: the closing subset (line numbers) for a closing.
// reason: undefined keeps the stored explanation (a form that does not carry the field); '' clears it; text replaces it.
export async function classifyEntry(pool, { orgId, entityId, returnId, txnId, cls, lines = [], expectTxnVersion, reviewedBy, reason }) {
  if (cls === 'tax_only' || cls === 'opening') fail('Tax-only and opening entries are not classified in this stage: record a tax-only change as an adjustment, and an opening through the opening bridge.');
  if (!CLASSES.some(([c]) => c === cls)) fail('Choose closing, correction or ordinary entry.');
  const who = personOf(reviewedBy);
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const c = (await closingCandidates(tx, { orgId, ret })).find(x => x.txnId === idOf(txnId, 'The entry'))
      ?? fail('That entry is not a journal entry of this period that moves income or expense into equity.');
    if (!c.eligible) fail('That entry is no longer a journal entry of this period: its old decision can only be cleared.');
    if (!expectTxnVersion || expectTxnVersion !== c.txnVersion) fail('This entry changed since the page was shown. Look at it again before classifying it.');
    let chosen = null;
    if (cls === 'closing') {
      const want = [...new Set((lines ?? []).map(Number))].sort((a, b) => a - b);
      const picked = want.map(n => c.lines.find(l => l.lineNo === n) ?? fail(`Line ${n} is not a line of this entry.`));
      if (picked.length < 2) fail('A closing subset has at least two lines: the income or expense it closes and the equity it closes into.');
      const bad = picked.find(l => !isPl(l.type) && l.type !== 'equity');
      if (bad) fail(`Line ${bad.lineNo} (${bad.accountName}) is not an income, expense or equity line: a closing removes only those; the rest of the entry stays.`);
      if (!picked.some(l => isPl(l.type)) || !picked.some(l => l.type === 'equity')) fail('A closing subset closes income or expense INTO equity: choose lines of both kinds.');
      const net = picked.reduce((t, l) => t + l.cents, 0n);
      if (net !== 0n) fail(`The chosen lines do not balance (they net to ${net} cents): a closing removes both legs together, so its lines must balance on their own.`);
      chosen = want;
    }
    const note = reason === undefined ? c.decision?.reason ?? null : String(reason ?? '').trim().slice(0, 500) || null;
    await tx.query('DELETE FROM book_entry_classification WHERE org_id = $1 AND return_id = $2 AND txn_id = $3', [orgId, ret.return_id, c.txnId]);
    const touched = [...new Set(c.lines.filter(l => isPl(l.type) || l.type === 'equity').map(l => l.accountId))];
    // Each account's domain as the entry reaches it now, saved with the decision: income for an income or expense line, balance for equity.
    const domains = touched.map(id => (c.lines.some(l => l.accountId === id && isPl(l.type)) ? 'income' : 'balance'));
    await tx.query(`INSERT INTO book_entry_classification (org_id, return_id, source_entity_id, txn_id, class, lines, accounts, account_domains, txn_version, reviewed_by, reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [orgId, ret.return_id, ret.entity_id, c.txnId, cls, chosen, touched, domains, c.txnVersion, who, note]);
  });
}
export async function clearClassification(pool, { orgId, entityId, returnId, txnId }) {
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const { rowCount } = await tx.query('DELETE FROM book_entry_classification WHERE org_id = $1 AND return_id = $2 AND txn_id = $3', [orgId, ret.return_id, idOf(txnId, 'The entry')]);
    if (!rowCount) fail('That entry has no classification to clear.');
  });
}
