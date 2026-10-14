import { createHash } from 'node:crypto';

// A sample bank-data database (a ledgerline-compatible schema, stage B2) for building and testing bank feeds without a
// real one. The tables are a cut-down version of the core/verify schemas; the `serve` views the puller reads have the
// exact names and columns the app expects (see BANK-FEED-CONTRACT.md).
//
// The bank items are made from the sample books' own bank and card activity (cleared a few days later, with bank-style
// descriptions), plus things only the bank knows: monthly service fees, savings interest, card purchases nobody entered,
// a pending charge, a removed charge and a corrected one.

export const SAMPLE_SCHEMA = `
DROP SCHEMA IF EXISTS serve CASCADE; DROP SCHEMA IF EXISTS verify CASCADE; DROP SCHEMA IF EXISTS core CASCADE;
CREATE SCHEMA core; CREATE SCHEMA verify; CREATE SCHEMA serve;
CREATE TABLE core.entity (org_id uuid NOT NULL, entity_id uuid PRIMARY KEY, slug text NOT NULL, display_name text NOT NULL, legal_name text,
  legal_form text, tax_classification text, parent_entity_id uuid, has_books bool NOT NULL, active bool NOT NULL);
CREATE TABLE core.dimension (org_id uuid NOT NULL, dimension_id uuid PRIMARY KEY, name text);
CREATE TABLE core.account (org_id uuid NOT NULL, account_id uuid PRIMARY KEY, display_name text, institution_name text, mask text,
  kind text CHECK (kind IN ('checking','savings','money_market','credit_card','line_of_credit','loan','mortgage','brokerage','other')),
  balance_orientation text, verification_method text, currency char(3), status text, history_state text, coverage_gap text);
CREATE TABLE core.account_entity (org_id uuid NOT NULL, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, entity_id uuid NOT NULL,
  dimension_id uuid, valid daterange NOT NULL);
CREATE TABLE core.account_reporting_scope (org_id uuid NOT NULL, account_id uuid NOT NULL, scope text NOT NULL, valid daterange NOT NULL);
CREATE TABLE core.transaction (org_id uuid NOT NULL, transaction_id uuid PRIMARY KEY, source_account_id uuid, account_id uuid NOT NULL,
  amount numeric(14,2), currency char(3), posted_date date, authorized_date date, datetime timestamptz, pending bool, description_raw text,
  original_description text, merchant_name text, merchant_entity_id text, pfc_primary text, pfc_detailed text, pfc_confidence text, pfc_version text,
  payment_channel text, check_number text, counterparties jsonb, location jsonb, payment_meta jsonb,
  status text CHECK (status IN ('active','removed','quarantined')), removed_at timestamptz, revision int NOT NULL, revision_publication_id bigint NOT NULL DEFAULT 1);
CREATE TABLE core.balance_observation (org_id uuid NOT NULL, account_id uuid NOT NULL, current numeric(14,2), available numeric(14,2), limit_amount numeric(14,2),
  observed_at timestamptz, provider_as_of timestamptz, publication_id bigint NOT NULL DEFAULT 1);
-- Stands in for ledgerline's connection, assignment and sync-acceptance tables.
CREATE TABLE core.sample_connection (org_id uuid NOT NULL, account_id uuid PRIMARY KEY, connection_id uuid, state text, last_acceptance_at timestamptz,
  last_successful_update timestamptz, capability text);
CREATE TABLE verify.statement (org_id uuid NOT NULL, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, version int NOT NULL DEFAULT 1,
  period daterange NOT NULL, opening_balance numeric(14,2), closing_balance numeric(14,2), source text);
CREATE TABLE verify.recon_run (org_id uuid NOT NULL, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, statement_id uuid NOT NULL,
  publication_id bigint NOT NULL DEFAULT 1, result text);
CREATE TABLE verify.certification (org_id uuid NOT NULL, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, period daterange NOT NULL,
  recon_run_id uuid, publication_id bigint NOT NULL DEFAULT 1, certified_at timestamptz NOT NULL DEFAULT now(), export_uri text, export_sha256 text);
CREATE TABLE verify.invalidation (org_id uuid NOT NULL, certification_id uuid NOT NULL, superseding_certification_id uuid);

CREATE VIEW serve.v_verified_intervals AS
SELECT c.org_id, c.account_id, c.period, c.id AS certification_id, c.publication_id,
  c.certified_at, c.export_uri, c.export_sha256
FROM verify.certification c
WHERE NOT EXISTS (SELECT 1 FROM verify.invalidation i
  WHERE i.org_id = c.org_id AND i.certification_id = c.id AND i.superseding_certification_id IS NULL);

CREATE VIEW serve.v_account_coverage AS
SELECT a.org_id, a.account_id, a.display_name, a.kind, a.verification_method,
  sc.connection_id, NULL::uuid AS source_account_id, sc.state AS connection_state, 'assigned'::text AS assignment_state,
  coalesce(s.scope, 'included') AS scope, a.history_state,
  CASE WHEN EXISTS (SELECT 1 FROM serve.v_verified_intervals v
    WHERE v.org_id = a.org_id AND v.account_id = a.account_id) THEN 'verified'
    WHEN EXISTS (SELECT 1 FROM verify.certification c WHERE c.org_id = a.org_id AND c.account_id = a.account_id)
    THEN 'invalidated' ELSE 'unverified' END AS verification_state,
  sc.last_acceptance_at, sc.last_successful_update, sc.capability, a.coverage_gap, a.status
FROM core.account a
LEFT JOIN core.sample_connection sc ON sc.org_id = a.org_id AND sc.account_id = a.account_id
LEFT JOIN core.account_reporting_scope s ON s.org_id = a.org_id AND s.account_id = a.account_id AND s.valid @> current_date;

CREATE VIEW serve.v_transaction_current AS
SELECT t.*, ae.entity_id, ae.dimension_id, coalesce(s.scope, 'included') AS scope
FROM core.transaction t
JOIN core.account a ON a.org_id = t.org_id AND a.account_id = t.account_id AND a.status <> 'placeholder'
LEFT JOIN core.account_entity ae ON ae.org_id = t.org_id AND ae.account_id = t.account_id AND ae.valid @> t.posted_date
LEFT JOIN core.account_reporting_scope s ON s.org_id = t.org_id AND s.account_id = t.account_id AND s.valid @> t.posted_date
WHERE t.status = 'active' AND NOT t.pending;

CREATE VIEW serve.v_transaction_pending AS
SELECT t.*, ae.entity_id, ae.dimension_id, coalesce(s.scope, 'included') AS scope
FROM core.transaction t
JOIN core.account a ON a.org_id = t.org_id AND a.account_id = t.account_id AND a.status <> 'placeholder'
LEFT JOIN core.account_entity ae ON ae.org_id = t.org_id AND ae.account_id = t.account_id AND ae.valid @> t.posted_date
LEFT JOIN core.account_reporting_scope s ON s.org_id = t.org_id AND s.account_id = t.account_id AND s.valid @> t.posted_date
WHERE t.status = 'active' AND t.pending;

CREATE VIEW serve.v_cash_position AS
SELECT c.*, a.currency, b.current, b.available, b.observed_at, b.provider_as_of,
  (b.observed_at IS NULL OR b.observed_at < now() - interval '36 hours') AS balance_stale
FROM serve.v_account_coverage c
JOIN core.account a ON a.org_id = c.org_id AND a.account_id = c.account_id
LEFT JOIN LATERAL (SELECT o.* FROM core.balance_observation o WHERE o.org_id = c.org_id AND o.account_id = c.account_id
  ORDER BY o.observed_at DESC, o.publication_id DESC LIMIT 1) b ON true
WHERE c.kind IN ('checking','savings','money_market');

CREATE VIEW serve.v_debt_position AS
SELECT c.*, a.currency, b.current AS owed_positive, b.available, b.limit_amount, b.observed_at, b.provider_as_of,
  (b.observed_at IS NULL OR b.observed_at < now() - interval '36 hours') AS balance_stale
FROM serve.v_account_coverage c
JOIN core.account a ON a.org_id = c.org_id AND a.account_id = c.account_id
LEFT JOIN LATERAL (SELECT o.* FROM core.balance_observation o WHERE o.org_id = c.org_id AND o.account_id = c.account_id
  ORDER BY o.observed_at DESC, o.publication_id DESC LIMIT 1) b ON true
WHERE c.kind IN ('credit_card','line_of_credit','loan','mortgage');
`;

// Stable ids, so rebuilding the sample keeps the same transaction ids.
export function sampleUuid(...parts) {
  const h = createHash('sha1').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const pick = (n, k) => Number.parseInt(createHash('md5').update(String(n)).digest('hex').slice(0, 6), 16) % k;
const money = cents => (cents / 100).toFixed(2);
const shout = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9 &]/g, '').slice(0, 22);
const CITIES = ['LUBBOCK TX', 'AMARILLO TX', 'CLOVIS NM', 'PLAINVIEW TX', 'MIDLAND TX'];

// The sample books' bank and card accounts, as ledgerline would have them.
const SAMPLE_ACCOUNTS = [
  { books: 'Operating Checking', name: 'Operating Checking', institution: 'First Plains Bank', mask: '4321', kind: 'checking', verified: true },
  { books: 'Savings', name: 'Business Savings', institution: 'First Plains Bank', mask: '8812', kind: 'savings' },
  { books: 'Business Card', name: 'Business Card', institution: 'Prairie Card Services', mask: '1199', kind: 'credit_card' },
  { books: null, name: 'Equipment Loan', institution: 'First Plains Bank', mask: '0042', kind: 'loan' },
];

// Build the sample feed for one company of the books: { org, entities, accounts, items, certifications }.
export async function buildSampleFeed(pool, { orgId, entityId, asOf }) {
  const org = sampleUuid('org', orgId);
  const { rows: [company] } = await pool.query('SELECT name FROM entity WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  const entity = sampleUuid('entity', orgId, entityId);
  const entities = [
    { id: entity, slug: 'sample', name: company.name, legal_form: 'llc' },
    // A second ledgerline company with no books here yet, so the link page has a choice.
    { id: sampleUuid('entity', orgId, 'second'), slug: 'second', name: 'High Plains Hay LLC', legal_form: 'llc' },
  ];
  const { rows: booksAccounts } = await pool.query(`SELECT account_id, name, type FROM account WHERE org_id = $1 AND entity_id = $2 AND type IN ('bank', 'credit_card')`,
    [orgId, entityId]);
  const accounts = SAMPLE_ACCOUNTS.map(a => ({ ...a, id: sampleUuid('account', orgId, entityId, a.name), entity,
    booksId: booksAccounts.find(b => b.name === a.books)?.account_id ?? null }));
  accounts.push({ name: 'Hay Barn Checking', institution: 'First Plains Bank', mask: '7765', kind: 'checking', id: sampleUuid('account', orgId, 'second', 'checking'),
    entity: entities[1].id, booksId: null });

  // Everything the books moved through those accounts.
  const { rows: moves } = await pool.query(`
    SELECT t.txn_id, t.type, t.doc_number, t.txn_date, p.account_id, sum(p.amount_cents)::bigint AS amount, v.display_name AS vendor, c.display_name AS customer
      FROM posting p JOIN txn t ON t.txn_id = p.txn_id
      LEFT JOIN vendor v ON v.vendor_id = t.vendor_id LEFT JOIN customer c ON c.customer_id = t.customer_id
     WHERE p.org_id = $1 AND p.entity_id = $2 AND p.account_id = ANY($3::bigint[]) AND t.system_kind IS NULL AND t.type <> 'journal_entry' AND t.txn_date <= $4
     GROUP BY t.txn_id, t.type, t.doc_number, t.txn_date, p.account_id, v.display_name, c.display_name
    HAVING sum(p.amount_cents) <> 0 ORDER BY t.txn_date, t.txn_id`, [orgId, entityId, accounts.filter(a => a.booksId).map(a => a.booksId), asOf]);
  const { rows: openings } = await pool.query(`SELECT p.account_id, sum(p.amount_cents)::bigint AS amount FROM posting p JOIN txn t ON t.txn_id = p.txn_id
    WHERE p.org_id = $1 AND p.entity_id = $2 AND t.system_kind = 'opening_balance' GROUP BY p.account_id`, [orgId, entityId]);

  const items = [];
  const add = (a, key, f) => items.push({ id: sampleUuid('txn', a.id, key), account: a.id, revision: 1, pending: false, status: 'active', ...f });
  for (const m of moves) {
    const a = accounts.find(x => Number(x.booksId) === Number(m.account_id));
    const out = m.amount < 0;
    const party = m.vendor ?? m.customer ?? '';
    let lag = 1, desc, merchant = null, check = null, channel = 'other', cat = null;
    if (m.type === 'deposit') { lag = 1; desc = `MOBILE DEPOSIT REF ${String(m.txn_id).padStart(6, '0')}`; cat = 'TRANSFER_IN'; }
    else if ((m.type === 'check' || m.type === 'bill_payment') && /^\d+$/.test(m.doc_number ?? '') && a.kind === 'checking') {
      lag = 3 + pick(m.txn_id, 6); desc = `CHECK ${m.doc_number}`; check = m.doc_number;
    } else if (m.type === 'transfer') { desc = out ? 'ONLINE TRANSFER TO SAVINGS' : 'ONLINE TRANSFER FROM CHECKING'; cat = out ? 'TRANSFER_OUT' : 'TRANSFER_IN'; }
    else if (m.type === 'cc_payment') { desc = a.kind === 'credit_card' ? 'PAYMENT THANK YOU' : 'PRAIRIE CARD SVCS PAYMENT'; cat = 'LOAN_PAYMENTS'; }
    else if (a.kind === 'credit_card') {
      lag = 1 + pick(m.txn_id, 2); merchant = party || null; channel = 'in store';
      desc = out ? `${shout(party)} #${100 + pick(m.txn_id, 800)} ${CITIES[pick(m.txn_id, CITIES.length)]}` : `${shout(party)} REFUND`;
      cat = out ? 'GENERAL_MERCHANDISE' : null;
    } else if (out) { desc = `ACH DEBIT ${shout(party)}`; merchant = party || null; channel = 'online'; }
    else { desc = `ACH CREDIT ${shout(party)}`; channel = 'online'; cat = 'TRANSFER_IN'; }
    const posted = addDays(m.txn_date, lag);
    if (posted > asOf) continue; // hasn't cleared the bank yet
    add(a, `books-${m.txn_id}`, { posted_date: posted, authorized_date: a.kind === 'credit_card' ? m.txn_date : null, amount: money(Number(m.amount)),
      description: desc, merchant, check, channel, category: cat });
  }

  // Only the bank knows these.
  const checking = accounts.find(a => a.kind === 'checking' && a.booksId), savings = accounts.find(a => a.kind === 'savings'),
    card = accounts.find(a => a.kind === 'credit_card'), loan = accounts.find(a => a.kind === 'loan');
  const first = moves[0]?.txn_date ?? addDays(asOf, -365);
  for (let d = `${first.slice(0, 7)}-28`; d <= asOf; d = addDays(`${d.slice(0, 7)}-01`, 40).slice(0, 7) + '-28') {
    add(checking, `fee-${d}`, { posted_date: d, amount: '-15.00', description: 'MONTHLY SERVICE FEE', channel: 'other', category: 'BANK_FEES' });
    add(savings, `interest-${d}`, { posted_date: d, amount: '3.41', description: 'INTEREST PAYMENT', channel: 'other', category: 'INCOME' });
    add(loan, `loan-${d}`, { posted_date: d, amount: '850.00', description: 'LOAN PAYMENT RECEIVED', channel: 'other', category: 'LOAN_PAYMENTS' });
  }
  const recent = (n) => addDays(asOf, -n);
  add(card, 'unentered-1', { posted_date: recent(9), authorized_date: recent(10), amount: '-84.17', description: 'TRACTOR SUPPLY #1234 LUBBOCK TX',
    merchant: 'Tractor Supply', channel: 'in store', category: 'GENERAL_MERCHANDISE' });
  add(card, 'unentered-2', { posted_date: recent(6), authorized_date: recent(7), amount: '-61.02', description: 'SHELL OIL 57444 PLAINVIEW TX',
    merchant: 'Shell', channel: 'in store', category: 'TRANSPORTATION' });
  add(card, 'unentered-3', { posted_date: recent(4), authorized_date: recent(4), amount: '-23.99', description: 'AMZN MKTP US*2K4LM9 AMZN.COM/BILL WA',
    merchant: 'Amazon', channel: 'online', category: 'GENERAL_MERCHANDISE' });
  add(card, 'pending-1', { pending: true, posted_date: recent(1), authorized_date: recent(1), amount: '-42.50', description: 'LOVES TRAVEL STOP 412 AMARILLO TX',
    merchant: "Love's", channel: 'in store', category: 'TRANSPORTATION' });
  add(card, 'removed-1', { status: 'removed', posted_date: recent(12), amount: '-19.99', description: 'DUPLICATE AUTH HOLD', channel: 'online' });
  add(checking, 'corrected-1', { revision: 2, posted_date: recent(5), amount: '-125.40', description: 'ACH DEBIT XCEL ENERGY', merchant: 'Xcel Energy', channel: 'online',
    category: 'RENT_AND_UTILITIES' });
  const second = accounts.find(a => a.mask === '7765');
  add(second, 'hay-1', { posted_date: recent(3), amount: '2400.00', description: 'DEPOSIT', channel: 'other' });

  // Bank balances: the books' opening balance plus everything that cleared.
  const balances = accounts.map(a => {
    const open = Number(openings.find(o => Number(o.account_id) === Number(a.booksId))?.amount ?? 0);
    const flow = items.filter(i => i.account === a.id && i.status === 'active' && !i.pending).reduce((s, i) => s + Math.round(Number(i.amount) * 100), 0);
    const signed = open + flow;
    return { account: a.id, current: a.kind === 'loan' ? money(48000_00 - flow) : money(a.kind === 'credit_card' ? -signed : signed) };
  });
  // Ledgerline has certified the checking account month by month through two months ago.
  const certifications = [];
  const lastMonth = addDays(`${asOf.slice(0, 7)}-01`, -1).slice(0, 7);
  // Each with its statement: opening and closing balance = the books' opening balance plus everything that cleared.
  const checkingOpen = Number(openings.find(o => Number(o.account_id) === Number(checking.booksId))?.amount ?? 0);
  const clearedBy = d => checkingOpen + items.filter(i => i.account === checking.id && i.status === 'active' && !i.pending && i.posted_date < d)
    .reduce((s, i) => s + Math.round(Number(i.amount) * 100), 0);
  for (let m = first.slice(0, 7); m < lastMonth; m = addDays(`${m}-01`, 32).slice(0, 7)) {
    const to = addDays(`${m}-01`, 32).slice(0, 7) + '-01';
    certifications.push({ account: checking.id, from: `${m}-01`, to, opening: money(clearedBy(`${m}-01`)), closing: money(clearedBy(to)) });
  }
  return { org, entities, accounts, items, balances, certifications, asOf };
}

// Write a feed into a ledgerline-shaped database (recreates the sample schemas).
export async function writeLedgerlineSample(ll, feed, { now = new Date() } = {}) {
  await ll.query(SAMPLE_SCHEMA);
  const { org } = feed;
  for (const e of feed.entities) {
    await ll.query(`INSERT INTO core.entity (org_id, entity_id, slug, display_name, legal_form, has_books, active) VALUES ($1, $2, $3, $4, $5, true, true)`,
      [org, e.id, e.slug, e.name, e.legal_form]);
  }
  for (const a of feed.accounts) {
    const liability = ['credit_card', 'line_of_credit', 'loan', 'mortgage'].includes(a.kind);
    await ll.query(`INSERT INTO core.account (org_id, account_id, display_name, institution_name, mask, kind, balance_orientation, verification_method, currency, status, history_state)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'USD', 'active', 'complete')`,
      [org, a.id, a.name, a.institution, a.mask, a.kind, liability ? 'liability' : 'asset', a.kind === 'credit_card' ? 'card_statement' : a.kind === 'loan' ? 'loan_principal' : 'cash_statement']);
    await ll.query(`INSERT INTO core.account_entity (org_id, account_id, entity_id, valid) VALUES ($1, $2, $3, daterange('2020-01-01', NULL))`, [org, a.id, a.entity]);
    await ll.query(`INSERT INTO core.sample_connection (org_id, account_id, connection_id, state, last_acceptance_at, last_successful_update, capability)
      VALUES ($1, $2, $3, 'healthy', $4, $4, 'transactions')`, [org, a.id, sampleUuid('conn', a.institution), new Date(now.getTime() - 3600_000)]);
  }
  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, authorized_date, pending, description_raw,
      original_description, merchant_name, pfc_primary, payment_channel, check_number, status, revision)
    SELECT $1, x.id, x.account, x.amount, 'USD', x.posted_date, x.authorized_date, x.pending, x.description, x.description, x.merchant, x.category, x.channel, x.check,
      x.status, x.revision
    FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, account uuid, amount numeric, posted_date date, authorized_date date, pending bool, description text,
      merchant text, category text, channel text, "check" text, status text, revision int)`, [org, JSON.stringify(feed.items)]);
  for (const b of feed.balances) {
    await ll.query(`INSERT INTO core.balance_observation (org_id, account_id, current, observed_at, provider_as_of) VALUES ($1, $2, $3, $4, $4)`,
      [org, b.account, b.current, new Date(now.getTime() - 3600_000)]);
  }
  for (const c of feed.certifications) {
    const { rows: [s] } = await ll.query(`INSERT INTO verify.statement (org_id, account_id, period, opening_balance, closing_balance, source)
      VALUES ($1, $2, daterange($3::date, $4::date), $5, $6, 'qbo_reconciliation') RETURNING id`, [org, c.account, c.from, c.to, c.opening, c.closing]);
    const { rows: [r] } = await ll.query(`INSERT INTO verify.recon_run (org_id, account_id, statement_id, result) VALUES ($1, $2, $3, 'pass') RETURNING id`, [org, c.account, s.id]);
    await ll.query(`INSERT INTO verify.certification (org_id, account_id, period, recon_run_id, certified_at) VALUES ($1, $2, daterange($3::date, $4::date), $5, $6)`,
      [org, c.account, c.from, c.to, r.id, now]);
  }
}
