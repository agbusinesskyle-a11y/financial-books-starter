import { autoResearch } from '../ai/auto-research.js';
import { withTransaction } from '../db.js';
import { isPractice } from '../domain/practice.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { listAccounts, listItems, listVerifiedMonths, lastSync, toCents, tenantOf } from './source.js';
import { applyAutoRules } from './rules.js';
import { matchWaitingReceipts } from '../sms/receipts.js';

// The puller (stage B2): copies a linked company's bank transactions from ledgerline into bank_feed_item.
// - Keyed by ledgerline's transaction_id: a pending item and its posted version are the same row; a correction is a new
//   revision of the same row.
// - Only accounts mapped to a books account, from each account's start date.
// - Ledgerline's views show active transactions only, so a removal shows up as an item that is no longer there. An item
//   still waiting for review is hidden; one the books already used is kept and flagged "removed by the bank" for review.
// - A bank change to an item the books already used flags it "changed by the bank".
// - Guard: if an account suddenly returns nothing, or most of its items vanish at once, nothing is removed and the pull
//   says why (that looks like a connection problem, not the bank removing items).

const SCHEDULE_EVERY_MS = 6 * 60 * 60 * 1000; // pull at least this often even when ledgerline reports no new sync
const plain = error => String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[ledgerline]').slice(0, 300);

const itemRow = (r, orgId, entityId) => ({
  org_id: orgId, entity_id: entityId, ll_transaction_id: r.id, ll_account_id: r.account_id, revision: Number(r.revision), pending: r.pending === true,
  posted_date: r.posted_date, authorized_date: r.authorized_date, amount_cents: toCents(r.amount), currency: r.currency,
  description: (r.description_raw ?? r.original_description ?? r.merchant_name ?? '').slice(0, 500), original_description: r.original_description,
  merchant_name: r.merchant_name, category: r.pfc_primary, category_detail: r.pfc_detailed, payment_channel: r.payment_channel,
  check_number: r.check_number, counterparties: r.counterparties ?? null, scope: r.scope ?? 'included',
});
const ITEM_FIELDS = `ll_transaction_id uuid, ll_account_id uuid, revision int, pending boolean, posted_date date, authorized_date date,
  amount_cents bigint, currency text, description text, original_description text, merchant_name text, category text, category_detail text,
  payment_channel text, check_number text, counterparties jsonb, scope text`;

const PULL_LOCK = 815_215_002;
const HOME_CURRENCY = 'USD'; // the books are kept in US dollars; other-currency feeds aren't brought in yet

// research: after a good pull, vendor research on its own for lines nothing recognizes (stage S5) — 'background' (the
// pull doesn't wait for the AI provider), 'wait', or 'off' (the default, for callers that don't ask for it).
export async function pullCompany(pool, ll, { orgId, entityId, trigger = 'refresh', key = null, smsFetch, env = process.env, research = 'off', aiFetch, log = () => {} }) {
  if (!ll) throw new ValidationError('Ledgerline isn’t connected (LEDGERLINE_URL is not set).');
  const llOrg = await tenantOf(pool, orgId);
  if (!llOrg) throw new ValidationError('This organization isn’t assigned a ledgerline account yet (LEDGERLINE_ORG_ID).');
  const { rows: [link] } = await pool.query('SELECT * FROM ledgerline_link WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  if (!link) throw new ValidationError('Link this company to a ledgerline company first.');
  // One pull per company at a time, held from before ledgerline is read until the books are written, so an older read
  // can never overwrite a newer one.
  const lock = await pool.connect();
  let result;
  try {
    const { rows: [{ ok }] } = await lock.query('SELECT pg_try_advisory_lock($1, $2::int) AS ok', [PULL_LOCK, Number(entityId)]);
    if (!ok) return { status: 'failed', error: 'Another pull for this company is running; try again in a minute.' };
    try {
      const { rows: [run] } = await pool.query('INSERT INTO bank_feed_pull (org_id, entity_id, trigger) VALUES ($1, $2, $3) RETURNING pull_id', [orgId, entityId, trigger]);
      try {
        const [accounts, items, syncAt] = await Promise.all([listAccounts(ll, llOrg, link.ll_entity_id), listItems(ll, llOrg, link.ll_entity_id),
          lastSync(ll, llOrg, link.ll_entity_id)]);
        const verified = await listVerifiedMonths(ll, llOrg, accounts.map(a => a.id));
        result = await withTransaction(pool, async tx => {
          // The same company lock reviews take: a review and a pull never interleave.
          await lockEntity(tx, orgId, entityId);
          const still = await tx.query('SELECT 1 FROM ledgerline_link WHERE org_id = $1 AND entity_id = $2 AND ll_entity_id = $3', [orgId, entityId, link.ll_entity_id]);
          if (!still.rowCount) return { status: 'failed', error: 'The ledgerline link changed during the pull; try again.' };
          await saveAccounts(tx, { orgId, entityId, accounts, verified });
          const counts = await saveItems(tx, { orgId, entityId, items });
          await tx.query('UPDATE ledgerline_link SET last_pull_at = now(), last_seen_sync_at = coalesce($3, last_seen_sync_at) WHERE org_id = $1 AND entity_id = $2',
            [orgId, entityId, syncAt]);
          return { status: 'ok', ...counts };
        });
      } catch (error) {
        result = { status: 'failed', error: error instanceof ValidationError ? error.message : `Couldn’t read ledgerline: ${plain(error)}` };
      }
      await pool.query(`UPDATE bank_feed_pull SET finished_at = now(), status = $2, new_count = $3, updated_count = $4, removed_count = $5, warning = $6, error = $7
        WHERE pull_id = $1`, [run.pull_id, result.status, result.new ?? 0, result.updated ?? 0, result.removed ?? 0, result.warning ?? null, result.error ?? null]);
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1, $2::int)', [PULL_LOCK, Number(entityId)]);
    }
  } finally {
    lock.release();
  }
  // Auto rules add what they fit (stage B4) — except in a practice copy, where rules only suggest and a person adds.
  if (result.status === 'ok' && isPractice(env)) result.practice = true;
  else if (result.status === 'ok') {
    result.autoAdded = await applyAutoRules(pool, { orgId, entityId });
    // Texted receipts waiting for their charge (stage B8).
    result.receipts = await matchWaitingReceipts(pool, { orgId, entityId, key, fetchImpl: smsFetch });
  }
  // Practice copies too: research only writes a proposal a person accepts.
  if (result.status === 'ok' && research !== 'off') {
    const run = autoResearch(pool, { orgId, entityId, key, fetchImpl: aiFetch });
    if (research === 'wait') result.research = await run;
    else run.catch(error => log(`vendor research: company ${entityId}: ${plain(error)}`));
  }
  return result;
}

async function saveAccounts(tx, { orgId, entityId, accounts, verified }) {
  for (const a of accounts) {
    // The bank balance is the company's own only while it owns the account.
    await tx.query(`INSERT INTO ledgerline_account (org_id, entity_id, ll_account_id, display_name, institution_name, mask, kind, currency, connection_state,
        verification_state, bank_balance_cents, balance_as_of, balance_stale, owned_now, seen_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
      ON CONFLICT (entity_id, ll_account_id) DO UPDATE SET display_name = EXCLUDED.display_name, institution_name = EXCLUDED.institution_name, mask = EXCLUDED.mask,
        kind = EXCLUDED.kind, currency = EXCLUDED.currency, connection_state = EXCLUDED.connection_state, verification_state = EXCLUDED.verification_state,
        bank_balance_cents = EXCLUDED.bank_balance_cents, balance_as_of = EXCLUDED.balance_as_of, balance_stale = EXCLUDED.balance_stale,
        owned_now = EXCLUDED.owned_now, seen_at = now()`,
      [orgId, entityId, a.id, a.display_name ?? 'Account', a.institution_name, a.mask, a.kind, a.currency, a.connection_state, a.verification_state,
        a.owned_now === false ? null : toCents(a.balance), a.owned_now === false ? null : a.balance_as_of, a.balance_stale !== false, a.owned_now !== false]);
  }
  const ids = accounts.map(a => a.id);
  await tx.query('DELETE FROM ledgerline_verified_month WHERE org_id = $1 AND entity_id = $2 AND ll_account_id = ANY($3::uuid[])', [orgId, entityId, ids]);
  for (const v of verified) {
    await tx.query(`INSERT INTO ledgerline_verified_month (org_id, entity_id, ll_account_id, period_start, period_end, certified_at, opening_cents, closing_cents)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (entity_id, ll_account_id, period_start) DO UPDATE SET period_end = EXCLUDED.period_end, certified_at = EXCLUDED.certified_at,
        opening_cents = EXCLUDED.opening_cents, closing_cents = EXCLUDED.closing_cents`,
      [orgId, entityId, v.account_id, v.period_start, v.period_end, v.certified_at, toCents(v.opening), toCents(v.closing)]);
  }
}

async function saveItems(tx, { orgId, entityId, items }) {
  // Mapped accounts of this company, each from its start date.
  const { rows: mapped } = await tx.query(`SELECT ll_account_id::text AS id, display_name, start_date, currency FROM ledgerline_account
    WHERE org_id = $1 AND entity_id = $2 AND include AND books_account_id IS NOT NULL AND currency = $3`, [orgId, entityId, HOME_CURRENCY]);
  const startOf = new Map(mapped.map(a => [a.id, a.start_date]));
  // A later start date: unreviewed items from before it go (items the books already used stay).
  for (const a of mapped.filter(m => m.start_date)) {
    await tx.query(`DELETE FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND ll_account_id = $3 AND review_state = 'new' AND posted_date < $4`,
      [orgId, entityId, a.id, a.start_date]);
  }
  const { rows: existing } = await tx.query(`SELECT ll_transaction_id::text AS id, ll_account_id::text AS account_id, revision, pending, bank_state, review_state,
      attention, amount_cents, posted_date FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2`, [orgId, entityId]);
  const have = new Map(existing.map(r => [r.id, r]));
  // From each account's start date — and, whatever the date, every item the books already used, so later bank changes to
  // it are still caught. Only home-currency amounts.
  const otherCurrency = items.filter(r => startOf.has(r.account_id) && r.currency !== HOME_CURRENCY).length;
  const inWindow = (accountId, date, id) => !startOf.get(accountId) || date >= startOf.get(accountId) || (have.get(id)?.review_state ?? 'new') !== 'new';
  const wanted = items.filter(r => startOf.has(r.account_id) && r.currency === HOME_CURRENCY && inWindow(r.account_id, r.posted_date, r.id))
    .map(r => itemRow(r, orgId, entityId));

  const fresh = [], changed = [];
  for (const w of wanted) {
    const e = have.get(w.ll_transaction_id);
    if (!e) { fresh.push(w); continue; }
    if (e.revision === w.revision && e.pending === w.pending && e.bank_state === 'active') continue;
    if (w.revision < e.revision) continue; // never go back to an older version
    // The books already used this item and the bank now says something different about the money or the date.
    const moved = e.amount_cents !== w.amount_cents || e.posted_date !== w.posted_date;
    w.attention = e.review_state !== 'new' && moved ? 'changed' : (e.attention === 'removed' ? null : e.attention);
    changed.push(w);
  }
  if (fresh.length) {
    await tx.query(`INSERT INTO bank_feed_item (org_id, entity_id, ll_transaction_id, ll_account_id, revision, pending, posted_date, authorized_date, amount_cents,
        currency, description, original_description, merchant_name, category, category_detail, payment_channel, check_number, counterparties, scope)
      SELECT $1, $2, x.* FROM jsonb_to_recordset($3::jsonb) AS x(${ITEM_FIELDS})
      ON CONFLICT (org_id, entity_id, ll_transaction_id) DO NOTHING`, [orgId, entityId, JSON.stringify(fresh)]);
    // A bank line pulled in again (after a start-date change dropped it) that a person had undone, or whose books
    // transaction they deleted, stays held from automatic rules, as it was.
    // A books deletion nobody checked yet comes back with its warning.
    await tx.query(`UPDATE bank_feed_item b SET auto_hold = true, attention = CASE WHEN h.warn THEN 'books' ELSE b.attention END FROM bank_item_hold h
      WHERE b.org_id = $1 AND b.entity_id = $2 AND b.ll_transaction_id = ANY($3::uuid[]) AND h.entity_id = b.entity_id AND h.ll_transaction_id = b.ll_transaction_id`,
      [orgId, entityId, fresh.map(f => f.ll_transaction_id)]);
  }
  if (changed.length) {
    await tx.query(`UPDATE bank_feed_item b SET revision = x.revision, pending = x.pending, posted_date = x.posted_date, authorized_date = x.authorized_date,
        amount_cents = x.amount_cents, currency = x.currency, description = x.description, original_description = x.original_description,
        merchant_name = x.merchant_name, category = x.category, category_detail = x.category_detail, payment_channel = x.payment_channel,
        check_number = x.check_number, counterparties = x.counterparties, scope = x.scope, bank_state = 'active', attention = x.attention,
        review_version = b.review_version + 1, updated_at = now()
      FROM jsonb_to_recordset($3::jsonb) AS x(${ITEM_FIELDS}, attention text)
      WHERE b.org_id = $1 AND b.entity_id = $2 AND b.ll_transaction_id = x.ll_transaction_id`, [orgId, entityId, JSON.stringify(changed)]);
    // A line coming back (after the bank removed it) gets back the warning nobody answered while it was gone.
    await tx.query(`UPDATE bank_feed_item SET attention = coalesce(attention, parked_attention), parked_attention = NULL
      WHERE org_id = $1 AND entity_id = $2 AND ll_transaction_id = ANY($3::uuid[]) AND bank_state = 'active' AND parked_attention IS NOT NULL`,
      [orgId, entityId, changed.map(c => c.ll_transaction_id)]);
    // A line coming back (after the bank removed it) keeps an unanswered books warning: its books transaction edited since
    // it was reviewed or checked, or a books deletion nobody has checked. (An amount difference someone already checked
    // stays answered; one nobody answered was parked above.)
    await tx.query(`UPDATE bank_feed_item b SET attention = 'books' FROM ledgerline_account l
      WHERE b.org_id = $1 AND b.entity_id = $2 AND b.ll_transaction_id = ANY($3::uuid[]) AND b.attention IS NULL
        AND l.entity_id = b.entity_id AND l.ll_account_id = b.ll_account_id AND (
          (b.review_state IN ('added', 'matched')
             AND EXISTS (SELECT 1 FROM bank_feed_link k WHERE k.item_id = b.item_id AND k.txn_version IS NOT NULL AND k.txn_version IS DISTINCT FROM txn_version(k.txn_id)))
          OR (b.review_state = 'new' AND EXISTS (SELECT 1 FROM bank_item_hold h WHERE h.entity_id = b.entity_id AND h.ll_transaction_id = b.ll_transaction_id AND h.warn)))`,
      [orgId, entityId, changed.map(c => c.ll_transaction_id)]);
  }

  // Removals, account by account, with the guard.
  const seen = new Set(wanted.map(w => w.ll_transaction_id));
  const warnings = [];
  const gone = [];
  for (const a of mapped) {
    const start = a.start_date;
    const active = existing.filter(e => e.account_id === a.id && e.bank_state === 'active' && (!start || e.posted_date >= start || e.review_state !== 'new'));
    const missing = active.filter(e => !seen.has(e.id));
    if (!missing.length) continue;
    const returned = wanted.filter(w => w.ll_account_id === a.id).length;
    if (returned === 0 || (missing.length > 20 && missing.length > active.length / 2)) {
      warnings.push(`${a.display_name}: ${missing.length} of ${active.length} items no longer came back from ledgerline — nothing was removed. Check the connection in ledgerline.`);
      continue;
    }
    gone.push(...missing.map(e => e.id));
  }
  if (gone.length) {
    await tx.query(`UPDATE bank_feed_item SET bank_state = 'removed', attention = CASE WHEN review_state = 'new' THEN NULL ELSE 'removed' END,
        parked_attention = CASE WHEN attention IN ('changed', 'books') THEN attention ELSE parked_attention END,
        review_version = review_version + 1, updated_at = now()
      WHERE org_id = $1 AND entity_id = $2 AND ll_transaction_id = ANY($3::uuid[])`, [orgId, entityId, gone]);
  }
  if (otherCurrency) warnings.push(`${otherCurrency} item${otherCurrency === 1 ? '' : 's'} in another currency weren’t brought in (the books are in ${HOME_CURRENCY}).`);
  return { new: fresh.length, updated: changed.length, removed: gone.length, warning: warnings.join(' ') || null };
}

// After each ledgerline sync (checked every 15 minutes by the app), and at least every 6 hours: pull every linked company.
export async function runBankPulls({ pool, ll, now = () => new Date(), log = () => {}, key = null, env = process.env }) {
  if (!ll) return { pulled: 0 };
  const { rows: links } = await pool.query(`SELECT l.org_id, l.entity_id, l.ll_entity_id, l.last_pull_at, l.last_seen_sync_at, o.ledgerline_org_id::text AS ll_org
    FROM ledgerline_link l JOIN org o ON o.org_id = l.org_id WHERE o.ledgerline_org_id IS NOT NULL ORDER BY l.org_id, l.entity_id`);
  let pulled = 0;
  for (const l of links) {
    try {
      const syncAt = await lastSync(ll, l.ll_org, l.ll_entity_id);
      const due = !l.last_pull_at || (syncAt && (!l.last_seen_sync_at || new Date(syncAt) > new Date(l.last_seen_sync_at)))
        || now() - new Date(l.last_pull_at) >= SCHEDULE_EVERY_MS;
      if (!due) continue;
      const r = await pullCompany(pool, ll, { orgId: l.org_id, entityId: l.entity_id, trigger: 'schedule', key, env, research: 'background', log });
      pulled++;
      if (r.status !== 'ok') log(`bank pull: company ${l.entity_id}: ${r.error}`);
    } catch (error) {
      log(`bank pull: company ${l.entity_id}: ${plain(error)}`);
    }
  }
  return { pulled };
}
