import { withTransaction } from '../db.js';
import { lockEntity } from '../data/writes.js';
import { getBankItem } from '../data/banking.js';
import { listRules, learnedHistory, suggestFor, saysCardPayment } from '../bankfeed/rules.js';
import { researchKey, wordingAccounts } from '../bankfeed/wording.js';
import { aiFor } from './provider.js';
import { askAbout, researchContext, researchFits } from './vendor-research.js';

// Vendor research on its own (stage S5): after a pull, money-out bank lines that nothing else recognizes — no
// rule, no history, no bank wording, nothing in the books that could already be them — are looked up by the AI provider,
// one payee at a time, so the row is filled in when a person opens it. Only ever a suggestion: a person still posts.
//
// Bounded: at most PER_RUN payees each pull and PER_DAY calls per company per day, failures included, counted in
// vendor_research_attempt (kept apart from bank lines, so unmapping a feed resets nothing). Each call is reserved under the
// company lock before the provider is asked (a 'pending' research row, one per payee at a time; one older than LEASE_MIN
// minutes is taken as abandoned); a payee asked about in the last RETRY_DAYS days isn't asked again. Before each call the
// provider settings and the line are read again (AI turned off, the line reviewed or changed: no call). The provider is
// asked outside any lock, the question bounded, a paused search sent back once at most.
export const PER_RUN = 5, PER_DAY = 25, RETRY_DAYS = 7, LOOK_BACK_DAYS = 60, LEASE_MIN = 15;
const ACTOR = 'Automatic research';

export async function autoResearch(pool, { orgId, entityId, key, fetchImpl, perRun = PER_RUN, perDay = PER_DAY }) {
  try { await aiFor(pool, { orgId, key, fetchImpl }); } catch { return { off: true, asked: 0 }; }
  const scope = { orgId, entityId };
  const { rows: lines } = await pool.query(`SELECT i.item_id FROM bank_feed_item i JOIN ledgerline_account l ON l.entity_id = i.entity_id AND l.ll_account_id = i.ll_account_id
      JOIN account a ON a.account_id = l.books_account_id
     WHERE i.org_id = $1 AND i.entity_id = $2 AND l.include AND i.review_state = 'new' AND i.bank_state = 'active' AND NOT i.pending AND i.amount_cents < 0
       AND a.type IN ('bank', 'credit_card') AND i.posted_date >= current_date - $3::int
     ORDER BY i.posted_date DESC, i.item_id DESC LIMIT 300`, [orgId, entityId, LOOK_BACK_DAYS]);
  if (!lines.length) return { asked: 0 };
  let rules = await listRules(pool, scope), history = await learnedHistory(pool, scope);
  // The last fours of every account the organization's feeds bring in (any company): a line naming one is a transfer.
  const { rows: masks } = await pool.query('SELECT DISTINCT mask FROM ledgerline_account WHERE org_id = $1 AND mask IS NOT NULL', [orgId]);
  const own = new Set(masks.map(m => String(m.mask)));
  // Whether a line (read now) is one to research, and under which payee key: nothing suggests anything for it (a weak
  // history guess at most), and nothing points it at open bills.
  const eligible = async itemId => {
    const item = await getBankItem(pool, { ...scope, itemId });
    if (!item || item.review_state !== 'new' || item.bank_state !== 'active' || item.pending || !(Number(item.amount_cents) < 0) || !['bank', 'credit_card'].includes(item.books_type)) return null;
    const k = researchKey(item);
    // A line with a texted receipt that fits it has the purchase itself to go by: never asked about. Nor a transfer between
    // the organization's own accounts or a card payment (no payee to find).
    if (!k || item.receipt_ids || looksLikeTransfer(item, own)) return null;
    const s = await suggestFor(pool, { ...scope, item, rules, history });
    return (s && !(s.confidence === 'low' && s.source === 'history')) || s?.openDocs ? null : { item, key: k };
  };
  // One line per payee nobody could suggest anything for.
  const wanted = new Map();
  for (const { item_id } of lines) {
    const e = await eligible(item_id);
    if (e && !wanted.has(e.key)) wanted.set(e.key, e.item.item_id);
  }
  let asked = 0;
  for (const [k, itemId] of wanted) {
    if (asked >= perRun) break;
    // Read again just before asking: AI still set up, the rules and history as they are now, the line still waiting and
    // still this payee.
    let ai;
    try { ai = await aiFor(pool, { orgId, key, fetchImpl }); } catch { break; }
    if (asked) { rules = await listRules(pool, scope); history = await learnedHistory(pool, scope); }
    const e = await eligible(itemId);
    if (!e || e.key !== k) continue;
    const reservation = await reserve(pool, { ...scope, item: e.item, key: k, perDay });
    if (reservation === 'limit') break;
    if (!reservation) continue;
    asked++;
    let done;
    try {
      done = await askAbout(pool, { ...scope, item: e.item, settings: ai.settings, client: ai.client, actor: ACTOR, rounds: 2 });
    } catch (error) {
      done = { callId: null, proposal: null, sources: [], error: String(error?.message ?? error).slice(0, 500) };
    }
    // The line changed while it was being asked about (a bank correction to another payee): the answer isn't kept as its.
    const after = await getBankItem(pool, { ...scope, itemId });
    if (!done.error && (!after || researchContext(after) !== researchContext(e.item))) done = { ...done, proposal: null, error: 'The bank line changed while it was researched.' };
    await pool.query(`UPDATE vendor_research SET status = $3, call_id = $4, proposal = $5, sources = $6, error = $7 WHERE org_id = $1 AND research_id = $2 AND status = 'pending'`,
      [orgId, reservation, done.error ? 'failed' : 'done', done.callId, done.proposal ? JSON.stringify(done.proposal) : null, JSON.stringify(done.sources ?? []), done.error]);
  }
  return { asked };
}

export function looksLikeTransfer(item, ownMasks = new Set()) {
  const text = `${item.description ?? ''} ${item.original_description ?? ''}`;
  if (wordingAccounts(text).some(m => ownMasks.has(m)) || saysCardPayment(text)) return true;
  return /\b(WEB TFR|ONLINE TRANSFER|TRANSFER (TO|FROM)|TFR (TO|FR)|XFER|CRD EPAY|CREDIT CRD|CARD PMT|PAYMENT TO .{0,20}CARD|AUTOPAY PAYMENT)\b/i.test(text);
}

// A reserved call: its research row id; null if this payee was asked about lately (or is being now); 'limit' when the
// company's calls for today are used up. Under the company lock.
async function reserve(pool, { orgId, entityId, item, key, perDay }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    // A reservation that never finished (a crash, a lost answer) is let go — it still counted as an attempt.
    await tx.query(`UPDATE vendor_research SET status = 'failed', error = 'The research didn’t finish.' WHERE org_id = $1 AND entity_id = $2 AND status = 'pending'
        AND created_at < now() - make_interval(mins => $3)`, [orgId, entityId, LEASE_MIN]);
    const { rows: [{ today }] } = await tx.query(`SELECT count(*)::int AS today FROM vendor_research_attempt WHERE org_id = $1 AND entity_id = $2 AND at >= date_trunc('day', now())`,
      [orgId, entityId]);
    if (today >= perDay) return 'limit';
    const { rowCount: tried } = await tx.query(`SELECT 1 FROM vendor_research_attempt WHERE org_id = $1 AND entity_id = $2 AND payee_key = $3 AND at >= now() - make_interval(days => $4) LIMIT 1`,
      [orgId, entityId, key, RETRY_DAYS]);
    // One in flight, or a finished one that still applies to this line (a line the bank changed since can be asked again).
    const { rows: have } = await tx.query(`SELECT status, item_id, payee_key, context, amount_cents FROM vendor_research WHERE org_id = $1 AND entity_id = $2 AND payee_key = $3
        AND (status = 'pending' OR (status = 'done' AND decision IS DISTINCT FROM 'rejected'))`, [orgId, entityId, key]);
    if (tried || have.some(h => h.status === 'pending' || researchFits(h, item).fits)) return null;
    await tx.query('INSERT INTO vendor_research_attempt (org_id, entity_id, payee_key) VALUES ($1, $2, $3)', [orgId, entityId, key]);
    const { rows: [r] } = await tx.query(`INSERT INTO vendor_research (org_id, entity_id, item_id, payee_key, status, created_by, auto, amount_cents, context)
      VALUES ($1, $2, $3, $4, 'pending', $5, true, $6, $7) RETURNING research_id`, [orgId, entityId, item.item_id, key, ACTOR, Number(item.amount_cents), researchContext(item)]);
    return Number(r.research_id);
  });
}
