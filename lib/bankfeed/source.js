import pg from 'pg';

// Reading the bank-data database (a ledgerline-compatible schema, stage B2): a separate service pulls the banks (for
// example through Plaid), decides which company owns each account, and certifies account-months against statements.
// Financial Books only reads it, through a read-only role, and only these columns — the contract is the `serve` views
// plus core.entity / core.account / core.account_entity and three verify tables (see BANK-FEED-CONTRACT.md).
//
// Every session is opened read-only as well, so a misconfigured role still can't change ledgerline. Every read is limited
// to the ledgerline tenant (org_id) assigned to the Books organization (org.ledgerline_org_id), so one customer can never
// see another's banks even if they share a ledgerline.

export function ledgerlinePool(env = process.env) {
  if (!env.LEDGERLINE_URL) return null;
  const pool = new pg.Pool({ connectionString: env.LEDGERLINE_URL, connectionTimeoutMillis: 5000, query_timeout: 60000, max: 2,
    options: '-c default_transaction_read_only=on' });
  pool.on('error', () => {}); // Never print a DSN; callers report a plain message.
  return pool;
}

// Ledgerline amounts are numeric(14,2) text; convert exactly, never through a float.
export function toCents(value) {
  if (value === null || value === undefined) return null;
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!m) throw new Error(`not an amount: ${value}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

// Ledgerline companies that keep books.
export async function listEntities(ll, llOrgId) {
  const { rows } = await ll.query(`SELECT entity_id::text AS id, display_name AS name, legal_name, legal_form
    FROM core.entity WHERE org_id = $1::uuid AND active AND has_books ORDER BY lower(display_name)`, [llOrgId]);
  return rows;
}

// Accounts the company has ever owned, with what ledgerline knows about each now. owned_now: the company owns it today
// (only then is the bank balance its own).
export async function listAccounts(ll, llOrgId, llEntityId) {
  const { rows } = await ll.query(`
    SELECT a.account_id::text AS id, coalesce(c.display_name, a.display_name) AS display_name, a.institution_name, a.mask, a.kind,
           coalesce(a.currency, 'USD') AS currency, c.connection_state, c.verification_state, c.last_acceptance_at,
           coalesce(cp.current, dp.owed_positive)::text AS balance, coalesce(cp.observed_at, dp.observed_at) AS balance_as_of,
           coalesce(cp.balance_stale, dp.balance_stale, true) AS balance_stale,
           EXISTS (SELECT 1 FROM core.account_entity ae WHERE ae.org_id = a.org_id AND ae.account_id = a.account_id AND ae.entity_id = $2::uuid AND ae.valid @> current_date) AS owned_now
      FROM core.account a
      JOIN serve.v_account_coverage c ON c.account_id = a.account_id
      LEFT JOIN serve.v_cash_position cp ON cp.account_id = a.account_id
      LEFT JOIN serve.v_debt_position dp ON dp.account_id = a.account_id
     WHERE a.org_id = $1::uuid AND a.status <> 'placeholder'
       AND EXISTS (SELECT 1 FROM core.account_entity ae WHERE ae.org_id = a.org_id AND ae.account_id = a.account_id AND ae.entity_id = $2::uuid)
     ORDER BY lower(coalesce(c.display_name, a.display_name)), a.account_id`, [llOrgId, llEntityId]);
  return rows;
}

// The company's posted and pending bank transactions. Ownership is dated, so the views already give each transaction
// the company that owned its account on that day.
const ITEM_COLUMNS = `transaction_id::text AS id, account_id::text AS account_id, amount::text AS amount, coalesce(currency, 'USD') AS currency,
  posted_date::text AS posted_date, authorized_date::text AS authorized_date, pending, description_raw, original_description, merchant_name,
  pfc_primary, pfc_detailed, payment_channel, check_number, counterparties, revision, scope`;
export async function listItems(ll, llOrgId, llEntityId) {
  const { rows } = await ll.query(`SELECT ${ITEM_COLUMNS} FROM serve.v_transaction_current WHERE org_id = $1::uuid AND entity_id = $2::uuid
    UNION ALL SELECT ${ITEM_COLUMNS} FROM serve.v_transaction_pending WHERE org_id = $1::uuid AND entity_id = $2::uuid`, [llOrgId, llEntityId]);
  return rows;
}

// Certified account-months, as [start, end] dates.
export async function listVerifiedMonths(ll, llOrgId, accountIds) {
  if (!accountIds.length) return [];
  // With the certified statement's opening and closing balances (stage B6).
  const { rows } = await ll.query(`SELECT v.account_id::text AS account_id, lower(v.period)::text AS period_start, (upper(v.period) - 1)::text AS period_end, v.certified_at,
      s.opening_balance::text AS opening, s.closing_balance::text AS closing
    FROM serve.v_verified_intervals v LEFT JOIN verify.certification c ON c.org_id = v.org_id AND c.id = v.certification_id
      LEFT JOIN verify.recon_run r ON r.org_id = c.org_id AND r.id = c.recon_run_id LEFT JOIN verify.statement s ON s.org_id = r.org_id AND s.id = r.statement_id
    WHERE v.org_id = $1::uuid AND v.account_id = ANY($2::uuid[]) ORDER BY v.account_id, lower(v.period)`, [llOrgId, accountIds]);
  return rows;
}

// When ledgerline last accepted a sync for any of the company's accounts (a newer one means there is something to pull).
export async function lastSync(ll, llOrgId, llEntityId) {
  const { rows: [r] } = await ll.query(`SELECT max(c.last_acceptance_at) AS at FROM serve.v_account_coverage c
    WHERE c.org_id = $1::uuid AND EXISTS (SELECT 1 FROM core.account_entity ae WHERE ae.org_id = c.org_id AND ae.account_id = c.account_id AND ae.entity_id = $2::uuid)`,
    [llOrgId, llEntityId]);
  return r?.at ?? null;
}

// The ledgerline tenant this Books organization may read, or null (then nothing can be linked).
export async function tenantOf(pool, orgId) {
  const { rows: [o] } = await pool.query('SELECT ledgerline_org_id::text AS id FROM org WHERE org_id = $1', [orgId]);
  return o?.id ?? null;
}

// Whoever runs Financial Books assigns the ledgerline tenant (LEDGERLINE_ORG_ID) to the organization (APP_ORG).
export async function assignTenant(pool, { orgSlug, llOrgId }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(llOrgId ?? ''))) throw new Error('LEDGERLINE_ORG_ID must be a uuid');
  await pool.query('UPDATE org SET ledgerline_org_id = $2 WHERE slug = $1', [orgSlug, llOrgId]);
}
