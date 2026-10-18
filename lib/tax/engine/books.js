// lib/tax/engine/books.js
// Book balances for the return (spec §5.2, §13.1 T3), exact BigInt from lib/tax/measure.js through coverage — not lib/reports/statements.js,
// whose balanceSheet() and trialBalance() add Numbers; test/tax-books-engine.test.js checks that, within the safe range, both agree.
//   net income per books   minus the period's income and expense activity of the return's books (debits positive), confirmed closings
//                          removed (lib/tax/measure.js), so a closing entry never zeroes it;
//   retained earnings      the books close each year's income into retained earnings (statements.js closeYears): its ENDING measurement
//                          on the return takes the period's net income too, split as its ending balance is routed;
//   openings               the beginning column ties to the predecessor (spec §4.3): a verified initial period to zero; a period with a
//                          predecessor baseline to its Schedule L end facts ACCOUNT BY ACCOUNT — a line one account opens on ties on its
//                          own; a line two or more accounts open on needs the approved opening bridge of its fact (lib/tax/baselines.js),
//                          which allocates the filed amount to each account (a matching total is never an account-level review). Where an
//                          approved bridge allocates an account an amount other than its books beginning, the reviewed opening replaces the
//                          books beginning in both columns (a workpaper entry, never a ledger write or a plug), provided the books beginning
//                          is still the one the difference was reviewed against (books_cents); an allocation to an account the return does
//                          not map at that line, or one reviewed against another books beginning, leaves the line unresolved. A period
//                          without either keeps its openings unknown — the beginning column is shown from the books and flagged, never
//                          called reviewed. Incomplete imported history therefore reconciles to reviewed openings instead of rolling
//                          activity the books do not have (lib/tax/engine/compute.js applies and checks all of this).
import { withTransaction } from '../../db.js';
import { ValidationError } from '../../data/writes.js';
import { openTaxReturn, idOf, personOf } from '../open-return.js';
import { measureAccounts } from '../measure.js';
import { cashBasisMeasure } from './cashbasis.js';

const fail = message => { throw new ValidationError(message); };

// Net income per books of the measured sources: minus their income and expense activity.
export function bookNetIncome(cov) {
  let cents = 0n;
  for (const s of cov.sources) for (const a of s.accounts ?? []) if (a.pl) cents -= a.activity;
  return cents;
}
// The opening facts and approved bridges of a return. → { state, baselineId, facts: Map fieldId → { factIds, cents | null, state, rows? },
// byId: Map factId → { fieldId, rowKey, cents | null, state }, accounts: Map accountId → { rows: [approved bridge rows] }, bridges: [every
// bridge row] }. Each fact keeps its identity (byId): a bridge row names its fact, and the fact's line gives its polarity — a row fact of a
// liability line is a credit like its line. A Schedule L line filed as named statement rows (row facts, no total) opens at the sum of its
// rows — unknown when any row is unknown; a line with its own total takes the total.
export async function openingsOf(db, { orgId, ret }) {
  const { rows: [r] } = await db.query('SELECT opening_state, predecessor_baseline_id FROM tax_return WHERE org_id = $1 AND return_id = $2', [orgId, ret.return_id]);
  const out = { state: r.opening_state, baselineId: r.predecessor_baseline_id === null ? null : Number(r.predecessor_baseline_id), facts: new Map(), byId: new Map(), accounts: new Map(), bridges: [] };
  if (r.opening_state !== 'baseline') return out;
  const { rows: facts } = await db.query(`SELECT fact_id, field_id, row_key, amount_cents::text AS cents, state, review_status FROM baseline_fact f
     WHERE f.org_id = $1 AND f.baseline_id = $2 AND f.fact_kind = 'schedule_l_end' AND f.measurement = 'end' AND f.party_key IS NULL AND f.interest_key IS NULL AND f.activity_key IS NULL
     ORDER BY f.field_id, f.row_key NULLS FIRST`, [orgId, out.baselineId]);
  for (const f of facts) {
    const cents = f.cents === null ? null : BigInt(f.cents), id = Number(f.fact_id);
    out.byId.set(id, { factId: id, fieldId: f.field_id, rowKey: f.row_key, cents, state: f.state, review: f.review_status });
    if (f.row_key === null) { out.facts.set(f.field_id, { factIds: [id], cents, state: f.state, review: f.review_status }); continue; }
    const cur = out.facts.get(f.field_id);
    if (cur && cur.rows === undefined) continue; // the line's own total speaks
    const sum = cur ?? { factIds: [], cents: 0n, state: 'known', review: f.review_status, rows: 0 };
    sum.rows += 1;
    sum.factIds.push(id);
    if (f.state !== 'known' || sum.state !== 'known') { sum.state = f.state === 'known' ? sum.state : f.state; sum.cents = null; } else sum.cents += cents;
    out.facts.set(f.field_id, sum);
  }
  const { rows: bridges } = await db.query(`SELECT b.bridge_id, b.fact_id, b.account_id, b.allocated_cents::text AS allocated, b.books_cents::text AS books, b.explanation, b.approved_by
     FROM opening_bridge b WHERE b.org_id = $1 AND b.return_id = $2 ORDER BY b.fact_id, b.account_id`, [orgId, ret.return_id]);
  out.bridges = bridges.map(b => ({ ...b, bridge_id: Number(b.bridge_id), fact_id: Number(b.fact_id), account_id: Number(b.account_id), allocated: BigInt(b.allocated), books: b.books === null ? null : BigInt(b.books) }));
  for (const b of out.bridges.filter(x => x.approved_by)) {
    const e = out.accounts.get(b.account_id) ?? { rows: [] };
    e.rows.push(b);
    out.accounts.set(b.account_id, e);
  }
  return out;
}
// Record the books beginning of each account of one approved bridge, as the difference was reviewed against it (opening_bridge.books_cents):
// the reviewed opening then replaces the books beginning in the engine, until the books beginning changes. The books beginning is the
// period's own book basis: as posted on accrual books, the books' cash basis on cash-basis books.
export async function confirmOpeningBooks(pool, { orgId, entityId, returnId, factId, reviewedBy }) {
  personOf(reviewedBy);
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const { rows } = await tx.query('SELECT bridge_id, account_id, approved_by FROM opening_bridge WHERE org_id = $1 AND return_id = $2 AND fact_id = $3', [orgId, ret.return_id, idOf(factId, 'The fact')]);
    if (!rows.length) fail('That fact has no opening bridge on this period.');
    if (rows.some(r => !r.approved_by)) fail('Approve the bridge first; then record the books amounts it was reviewed against.');
    const m = ret.book_basis === 'cash' ? await cashBasisMeasure(tx, { orgId, ret })
      : await measureAccounts(tx, { orgId, sourceEntityId: ret.entity_id, periodStart: ret.period_start, periodEnd: ret.period_end, returnId: ret.return_id });
    for (const r of rows) await tx.query('UPDATE opening_bridge SET books_cents = $3 WHERE org_id = $1 AND bridge_id = $2', [orgId, r.bridge_id, (m.get(Number(r.account_id))?.begin ?? 0n).toString()]);
  });
}
