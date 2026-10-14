import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from './writes.js';
import { listEntities, tenantOf } from '../bankfeed/source.js';

// Bank connections (stage B2): link a company to its ledgerline company, then map each of its bank, card and loan accounts
// to a books account once. The puller (lib/bankfeed/pull.js) brings in the mapped accounts' transactions.

const fail = message => { throw new ValidationError(message); };

// Which kind of books account each ledgerline account kind belongs in.
export const BOOKS_TYPE_FOR = {
  checking: 'bank', savings: 'bank', money_market: 'bank', brokerage: 'other_current_asset', other: 'bank',
  credit_card: 'credit_card', line_of_credit: 'other_current_liability', loan: 'long_term_liability', mortgage: 'long_term_liability',
};
export const KIND_LABEL = {
  checking: 'Checking', savings: 'Savings', money_market: 'Money market', brokerage: 'Brokerage', other: 'Other',
  credit_card: 'Credit card', line_of_credit: 'Line of credit', loan: 'Loan', mortgage: 'Mortgage',
};

export async function getLink(db, { orgId, entityId }) {
  const { rows: [l] } = await db.query('SELECT * FROM ledgerline_link WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  return l ?? null;
}

// Ledgerline companies this company could link to: not already linked to another company of this organization.
export async function linkChoices(pool, ll, { orgId, entityId }) {
  const llOrg = await tenantOf(pool, orgId);
  if (!llOrg) fail('This organization isn’t assigned a ledgerline account yet. Whoever runs Financial Books sets LEDGERLINE_ORG_ID.');
  const entities = await listEntities(ll, llOrg);
  const { rows } = await pool.query('SELECT ll_entity_id::text AS id, entity_id FROM ledgerline_link WHERE org_id = $1', [orgId]);
  const taken = new Map(rows.map(r => [r.id, Number(r.entity_id)]));
  return entities.filter(e => !taken.has(e.id) || taken.get(e.id) === Number(entityId));
}

export async function linkCompany(pool, ll, { orgId, entityId, llEntityId, actor }) {
  const choice = (await linkChoices(pool, ll, { orgId, entityId })).find(e => e.id === String(llEntityId ?? ''));
  if (!choice) fail('Choose a ledgerline company that isn’t linked to another company.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const current = await getLink(tx, { orgId, entityId });
    if (current && current.ll_entity_id !== choice.id) {
      const used = await tx.query(`SELECT 1 FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND review_state <> 'new' LIMIT 1`, [orgId, entityId]);
      if (used.rowCount) fail('This company has already added or matched bank items; it can’t be linked to a different ledgerline company.');
      await tx.query('DELETE FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
      await tx.query('DELETE FROM ledgerline_link WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
    }
    await tx.query(`INSERT INTO ledgerline_link (org_id, entity_id, ll_entity_id, ll_entity_name, linked_by) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (entity_id) DO UPDATE SET ll_entity_name = EXCLUDED.ll_entity_name`, [orgId, entityId, choice.id, choice.name, actor]);
    return choice;
  });
}

export async function unlinkCompany(pool, { orgId, entityId }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const used = await tx.query(`SELECT 1 FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2 AND review_state <> 'new' LIMIT 1`, [orgId, entityId]);
    if (used.rowCount) fail('Bank items from ledgerline are already in the books, so the link stays. Turn off single accounts instead.');
    await tx.query('DELETE FROM bank_feed_item WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
    await tx.query('DELETE FROM bank_feed_pull WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
    await tx.query('DELETE FROM ledgerline_link WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  });
}

// The company's ledgerline accounts with their mapping, item counts and verified months.
export async function listFeedAccounts(db, { orgId, entityId }) {
  const { rows } = await db.query(`
    SELECT a.ll_account_id::text AS id, a.display_name, a.institution_name, a.mask, a.kind, a.currency, a.connection_state, a.verification_state,
           a.bank_balance_cents, a.balance_as_of, a.balance_stale, a.books_account_id, a.include, a.start_date, a.mapped_by, a.mapped_at,
           ba.name AS books_account_name, ba.type AS books_account_type,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.entity_id = a.entity_id AND i.ll_account_id = a.ll_account_id AND i.bank_state = 'active') AS items,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.entity_id = a.entity_id AND i.ll_account_id = a.ll_account_id AND i.bank_state = 'active' AND i.review_state = 'new' AND NOT i.pending) AS to_review,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.entity_id = a.entity_id AND i.ll_account_id = a.ll_account_id AND i.bank_state = 'active' AND i.pending) AS pending,
           (SELECT count(*)::int FROM bank_feed_item i WHERE i.entity_id = a.entity_id AND i.ll_account_id = a.ll_account_id AND i.attention IS NOT NULL) AS attention,
           (SELECT max(v.period_end) FROM ledgerline_verified_month v WHERE v.entity_id = a.entity_id AND v.ll_account_id = a.ll_account_id) AS verified_through,
           (SELECT count(*)::int FROM ledgerline_verified_month v WHERE v.entity_id = a.entity_id AND v.ll_account_id = a.ll_account_id) AS verified_months
      FROM ledgerline_account a LEFT JOIN account ba ON ba.account_id = a.books_account_id
     WHERE a.org_id = $1 AND a.entity_id = $2
     ORDER BY CASE WHEN a.kind IN ('checking','savings','money_market') THEN 0 WHEN a.kind = 'credit_card' THEN 1 ELSE 2 END, lower(a.display_name)`, [orgId, entityId]);
  return rows;
}

export async function recentPulls(db, { orgId, entityId, limit = 8 }) {
  const { rows } = await db.query(`SELECT pull_id, trigger, started_at, finished_at, status, new_count, updated_count, removed_count, warning, error
    FROM bank_feed_pull WHERE org_id = $1 AND entity_id = $2 ORDER BY started_at DESC, pull_id DESC LIMIT $3`, [orgId, entityId, limit]);
  return rows;
}

// Books accounts a ledgerline account can go to (the right kind, not already taking another feed), best guess first.
const words = s => new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1));
export async function mappingChoices(db, { orgId, entityId, feedAccounts }) {
  const { rows: books } = await db.query(`SELECT account_id, name, number, type, description FROM account
    WHERE org_id = $1 AND entity_id = $2 AND active AND system_key IS NULL AND type IN ('bank','credit_card','other_current_asset','other_current_liability','long_term_liability')
    ORDER BY type, lower(name)`, [orgId, entityId]);
  const takenBy = new Map(feedAccounts.filter(a => a.books_account_id).map(a => [Number(a.books_account_id), a.id]));
  const out = new Map();
  for (const a of feedAccounts) {
    const type = BOOKS_TYPE_FOR[a.kind] ?? 'bank';
    const mine = words(`${a.display_name} ${a.institution_name ?? ''}`);
    const scored = books.filter(b => b.type === type && (!takenBy.has(Number(b.account_id)) || takenBy.get(Number(b.account_id)) === a.id)).map(b => {
      const text = `${b.name} ${b.number ?? ''} ${b.description ?? ''}`;
      let score = [...words(text)].filter(w => mine.has(w)).length;
      if (a.mask && text.includes(a.mask)) score += 5;
      return { ...b, score };
    }).sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
    out.set(a.id, { type, accounts: scored, suggested: scored[0]?.score > 0 ? Number(scored[0].account_id) : null });
  }
  return out;
}

// Save the mapping for every account on the form: a books account, a new one, or "don't bring in". Once items from an
// account are in the books, its books account can't change.
export async function saveMappings(pool, { orgId, entityId, choices, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows: feed } = await tx.query('SELECT * FROM ledgerline_account WHERE org_id = $1 AND entity_id = $2 FOR UPDATE', [orgId, entityId]);
    const byId = new Map(feed.map(a => [a.ll_account_id, a]));
    let changed = 0;
    for (const c of choices) {
      const a = byId.get(c.id);
      if (!a) fail('That account isn’t one of this company’s ledgerline accounts.');
      if (c.start && !/^\d{4}-\d{2}-\d{2}$/.test(c.start)) fail(`Enter the start date for ${a.display_name} as a date.`);
      let booksId = null, include = true;
      if (c.choice && c.choice !== 'skip' && (a.currency ?? 'USD') !== 'USD') {
        fail(`${a.display_name} is in ${a.currency}. The books are kept in US dollars, so its feed can’t be brought in yet — choose “Don’t bring in”.`);
      }
      if (c.choice === 'skip') include = false;
      else if (c.choice === 'new') {
        const type = BOOKS_TYPE_FOR[a.kind] ?? 'bank';
        let name = a.mask ? `${a.display_name} (${a.mask})` : a.display_name;
        const clash = await tx.query('SELECT 1 FROM account WHERE org_id = $1 AND entity_id = $2 AND lower(name) = lower($3)', [orgId, entityId, name]);
        if (clash.rowCount) name = `${name} – bank feed`;
        const { rows: [n] } = await tx.query('INSERT INTO account (org_id, entity_id, name, type, description) VALUES ($1, $2, $3, $4, $5) RETURNING account_id',
          [orgId, entityId, name.slice(0, 100), type, `Bank feed from ${a.institution_name ?? 'ledgerline'}`]);
        booksId = Number(n.account_id);
      } else if (c.choice) {
        const { rows: [b] } = await tx.query(`SELECT account_id, type FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active AND system_key IS NULL`,
          [orgId, entityId, Number(c.choice) || 0]);
        if (!b) fail(`Choose a books account for ${a.display_name}.`);
        if (b.type !== (BOOKS_TYPE_FOR[a.kind] ?? 'bank')) fail(`${a.display_name} is a ${KIND_LABEL[a.kind] ?? a.kind} account; choose a matching books account.`);
        booksId = Number(b.account_id);
      } else continue; // left blank: not mapped yet
      const before = a.books_account_id === null ? null : Number(a.books_account_id);
      if (before !== booksId) {
        const used = await tx.query(`SELECT 1 FROM bank_feed_item WHERE entity_id = $2 AND ll_account_id = $1 AND review_state <> 'new' LIMIT 1`, [a.ll_account_id, entityId]);
        if (used.rowCount) fail(`Items from ${a.display_name} are already in the books, so it stays with its books account.`);
        // Items brought in for the old mapping but never reviewed go; the next pull brings them in for the new one.
        await tx.query('DELETE FROM bank_feed_item WHERE entity_id = $2 AND ll_account_id = $1', [a.ll_account_id, entityId]);
      }
      if (booksId) {
        const other = await tx.query('SELECT display_name FROM ledgerline_account WHERE books_account_id = $1 AND ll_account_id <> $2', [booksId, a.ll_account_id]);
        if (other.rowCount) fail(`That books account already takes the feed from ${other.rows[0].display_name}.`);
      }
      await tx.query(`UPDATE ledgerline_account SET books_account_id = $2, include = $3, start_date = $4, mapped_by = $5, mapped_at = now()
        WHERE entity_id = $6 AND ll_account_id = $1`, [a.ll_account_id, booksId, include, c.start || null, actor, entityId]);
      changed++;
    }
    return changed;
  });
}

