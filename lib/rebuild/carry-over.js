// Save practice state in one snapshot. References use natural keys; secrets stay
// encrypted or hashed. Public API token IDs are part of issued bearer credentials.
import { CARRIED_TABLES, TRANSIENT_TABLES, classifyTables } from './tables.js';
import { COUNTED_TABLES } from './carry-schema.js';
import { transactionKey, comparableTransaction, identityTables, transactionChildren } from './transaction-identity.js';
import { partyExtras, restorePartyExtras, standardTerms } from './party-extras.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { centsText, basisPointsText, entityByName, accountByName, customerByName, vendorByName, classPath } from './keys.js';
import { saveCompany, saveEmailSettings } from '../data/settings.js';
import { saveAccount } from '../data/ledger.js';
import { saveLoanSetup } from '../data/loans.js';
import { saveSalesSettings, saveMessageSettings, saveFormStyle } from '../data/sales-settings.js';
import { saveAccountingSettings, saveClass, saveLocation } from '../data/accounting.js';
import { saveBillSettings } from '../data/payables.js';
import { savePaymentsSettings } from '../data/online-payments.js';
import { savePolicy } from '../data/latefees.js';
import { turnOnMulticurrency } from '../data/currencies.js';
import { saveItem } from '../data/catalog.js';
import { setUserCompanies } from '../data/companies.js';
import { ensureOwnerViewer, trustedActor } from '../data/morning/access.js';
import { SECURITY_LOCK } from '../data/morning/locks.js';
import { saveSender } from '../sms/twilio.js';
import { finishReconciliation } from '../data/ledger-tools.js';
import { settingsKey } from '../secrets.js';
import { isDeepStrictEqual } from 'node:util';
import { saveMappings } from '../data/bankfeeds.js';
import { saveRule, checkRule } from '../bankfeed/rules.js';
import { setTimeout as delay } from 'node:timers/promises';

const fail = message => { throw new ValidationError(message); };
const camel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const plain = (row, omit = []) => row == null ? null : Object.fromEntries(Object.entries(row)
  .filter(([k]) => !['org_id', 'entity_id', ...omit].includes(k)).map(([k, v]) => [camel(k), v]));
const settingTables = { email: 'email_settings', sales: 'sales_settings', accounting: 'accounting_settings', bills: 'bill_settings',
  payments: 'payments_settings', lateFees: 'late_fee_policy', currency: 'currency_settings', formStyle: 'form_style', integration: 'integration_setting' };
const taxTables = ['tax_profile', 'tax_party', 'tax_return', 'tax_baseline', 'baseline_fact', 'ownership_interest', 'tax_binding', 'tax_adjustment'];
const accountChangeKind = (column, value) => {
  const kinds={name:'renamed',type:'type changed',number:'number changed',parent_id:'parent changed',
    description:'description changed',loan_list:'loan visibility changed',loan_other_account_id:'loan pairing changed',
    active:value?'reactivated':'inactivated'};
  return Object.hasOwn(kinds,column)?kinds[column]:`account changed (${column})`;
};

export async function saveCarryOver(pool, { orgSlug }) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const saved = await readCarrySnapshot(tx, { orgSlug });
    await tx.query('COMMIT');
    return saved;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { tx.release(); }
}

// The destructive validator calls this with its existing locked transaction.
// No checkout, transaction boundary, or writer is permitted here.
export async function readCarrySnapshot(tx, { orgSlug }) {
    const { rows: [org] } = await tx.query('SELECT * FROM org WHERE slug = $1', [orgSlug]);
    if (!org) fail(`No org “${orgSlug}”.`);
    const { rows: [meta] } = await tx.query('SELECT current_database() AS database, (SELECT count(*)::int FROM schema_migrations) AS migrations');
    const { rows: columns } = await tx.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'org_id'");
    const scoped = new Set(columns.map(c => c.table_name));
    const rows = { transactionChildren: await transactionChildren(tx) };
    // Every carried table is read in this snapshot, even when v1 can only report its count.
    for (const table of new Set([...CARRIED_TABLES, ...identityTables, ...rows.transactionChildren.map(c=>c.table_name), 'entity', 'app_user'])) {
      const scope = scoped.has(table);
      const parent = table === 'budget_line' ? ['budget', 'budget_id'] : ['reconciliation', 'rec_id'];
      rows[table] = (await tx.query(scope ? `SELECT * FROM "${table}" WHERE org_id = $1`
        : `SELECT c.* FROM "${table}" c JOIN "${parent[0]}" p USING ("${parent[1]}") WHERE p.org_id = $1`, [org.org_id])).rows;
    }
    const byId = (table, id) => new Map(rows[table].map(r => [r[id], r]));
    const accounts = byId('account', 'account_id'), companies = byId('entity', 'entity_id');
    const customers = byId('customer', 'customer_id'), vendors = byId('vendor', 'vendor_id');
    const terms = byId('terms', 'terms_id'), users = byId('app_user', 'user_id');
    const userKey = key => {
      if (key === 'owner') return 'owner';
      const email = users.get(Number(String(key).replace(/^u:/, '')))?.email;
      if (!email) fail('Saved preference has no resolvable user email.');
      return `email:${email.toLowerCase()}`;
    };
    const classes = byId('class', 'class_id'), locations = byId('location', 'location_id');
    const txns = byId('txn', 'txn_id'), feedItems = byId('bank_feed_item', 'item_id');
    const accountName = id => id == null ? null : accounts.get(id)?.name ?? fail('Saved account reference is missing.');
    const companyName = id => companies.get(id)?.name ?? fail('Saved company reference is missing.');
    const partyRefs = { accountName, termsName: id => id == null ? null : terms.get(id)?.name ?? fail('Saved terms reference is missing.'),
      customerName: id => id == null ? null : customers.get(id)?.display_name ?? fail('Saved customer reference is missing.') };
    const txnKey = t => transactionKey(t, rows);
    const payee = (customerId, vendorId) => customerId ? { kind: 'customer', name: customers.get(customerId)?.display_name }
      : vendorId ? { kind: 'vendor', name: vendors.get(vendorId)?.display_name } : null;
    const { rows: changes } = await tx.query(`SELECT a.* FROM audit_log a WHERE a.org_id = $1 AND a.table_name = 'account'
      AND a.at > coalesce((SELECT max(b.created_at) FROM import_batch b
        WHERE b.org_id = a.org_id AND b.entity_id = a.entity_id), '-infinity'::timestamptz) ORDER BY a.at, a.audit_id`, [org.org_id]);
    // A deleted account still has a full DELETE snapshot for resolving its earlier
    // deltas and natural references. Never discard that history for lack of a row.
    const auditedAccounts=new Map(accounts);
    for (const a of [...changes].reverse()) if (!auditedAccounts.has(a.row_id)) {
      const row=a.after?.name && a.after?.type?a.after:a.before;
      if (row?.name && row?.type) auditedAccounts.set(a.row_id,row);
    }
    const auditedAccountName=id=>id==null?null:auditedAccounts.get(id)?.name ?? fail('Audited account reference is missing.');
    const handled = new Set([...Object.values(settingTables), 'ledgerline_link', 'ledgerline_account', 'bank_rule',
      'vendor_research_attempt', 'bank_item_hold', 'reconciliation', 'reconciled_item', 'class', 'location', 'item',
      'app_user_company', 'ai_settings', 'sms_settings', 'sms_sender', 'sms_sender_company', 'morning_viewer',
      'morning_preference', 'morning_delivery_setting', 'form_save_pref', 'api_token', 'external_ref']);
    const saved = { version: 1, savedAt: new Date().toISOString(), orgSlug: org.slug, database: meta.database,
      schemaMigrations: meta.migrations, counts: Object.fromEntries(COUNTED_TABLES.map(t => [t, rows[t].length])), companies: [], org: {}, tax: {
        note: 're-run the tax setup scripts; see docs/runbooks/practice-rebuild.md',
        counts: Object.fromEntries(taxTables.map(t => [t, rows[t].length])),
      }, leftovers: [], unclassified: await classifyTables(tx) };
    for (const e of rows.entity.sort((a, b) => a.entity_id - b.entity_id)) {
      const own = table => rows[table].filter(r => r.entity_id === e.entity_id);
      const link = own('ledgerline_link')[0];
      const native = own('txn').filter(t => t.source === null);
      const settings = Object.fromEntries(Object.entries(settingTables).map(([key, table]) => {
        const r = own(table)[0];
        const out = table === 'integration_setting' && r
          ? { acceptWrites: false, writeFloor: r.write_floor, ledgerInstance: r.ledger_instance }
          : plain(r, ['default_terms_id', 'billable_income_account_id']);
        if (r && table === 'sales_settings') out.defaultTerms = terms.get(r.default_terms_id)?.name ?? null;
        if (r && table === 'accounting_settings') out.billableIncomeAccount = accountName(r.billable_income_account_id);
        return [key, out];
      }));
      saved.companies.push({ name: e.name, timeZone: e.time_zone,
        // A hash cannot recover or re-issue the original secret. Carry it verbatim
        // with the public ID embedded in fbi_v1.<id>.<secret>, never the bearer.
        apiTokens: own('api_token').map(t => ({ ...plain(t, ['token_hash']), tokenHash:t.token_hash.toString('hex') })),
        externalRefs: own('external_ref').map(r => ({ ...plain(r, ['ref_id','txn_id']),
          transaction:txnKey(txns.get(r.txn_id) ?? fail('Saved integration transaction is missing.')) })),
        vendorExtras: own('vendor').map(v => partyExtras('vendor',v,partyRefs)),
        customerExtras: own('customer').map(c => partyExtras('customer',c,partyRefs)),
        terms: own('terms').filter(t => standardTerms.get(t.name) !== t.due_days).map(t => ({ name:t.name, dueDays:t.due_days })),
        counts: Object.fromEntries(COUNTED_TABLES.filter(t => t !== 'ai_settings').map(t => [t, own(t).length])),
        importedTransactions: own('txn').filter(t => t.source === 'qbo_import').length, nativeTransactionCount: native.length,
        company: { email: e.email, phone: e.phone, address: e.address, legalName: e.legal_name, einEnc: e.ein_enc, einLast4: e.ein_last4,
          businessType: e.business_type, website: e.website, customerEmail: e.customer_email, customerAddress: e.customer_address,
          logoType: e.logo_type, logoBase64: e.logo?.toString('base64') ?? null },
        accountChanges: changes.filter(a => a.entity_id === e.entity_id).flatMap(a => {
          // UPDATE audit records contain only changed fields. The row supplies the identity
          // and unchanged properties. Import setup shares its batch's transaction timestamp;
          // subsequent changes count even when a job recorded actor=system.
          const current = auditedAccounts.get(a.row_id);
          const before = a.before && { ...current, ...a.before }, after = a.after && { ...current, ...a.after };
          const state=after ?? before;
          if (!state?.name || !state.type) fail('Cannot identify an audited account change; current account row is missing.');
          const naturalValue=(column,value)=>{
            if (value==null) return null;
            if (column==='parent_id') return auditedAccountName(value);
            if (column==='loan_other_account_id') {
              const other=auditedAccounts.get(value);
              if (!other) fail('Audited loan account reference is missing.');
              return {company:companyName(other.entity_id),account:other.name};
            }
            return value;
          };
          const entry={name:state.name,number:state.number,type:state.type,active:state.active,
            description:state.description,parent:auditedAccountName(state.parent_id),
            before:{name:before?.name ?? null}};
          if (!a.before) return [{...entry,kind:accounts.has(a.row_id)?'created':'created then deleted'}];
          if (!a.after) return [{...entry,kind:'deleted'}];
          // Do not choose only the first recognized field: a rename may accompany
          // a reporting change. Every delta, including future columns, is disclosed.
          return [...new Set([...Object.keys(a.before),...Object.keys(a.after)])].sort()
            .filter(column=>!isDeepStrictEqual(a.before[column],a.after[column]))
            .map(column=>({...entry,kind:accountChangeKind(column,a.after[column]),column,
              beforeValue:naturalValue(column,a.before[column]),afterValue:naturalValue(column,a.after[column])}));
        }),
        loans: own('account').filter(a => a.loan_list || a.loan_other_account_id).map(a => {
          const other = accounts.get(a.loan_other_account_id);
          return { account: a.name, list: a.loan_list, other: other ? { company: companyName(other.entity_id), account: other.name } : null };
        }),
        nativeApplications: rows.application.filter(a => a.source === null && txns.get(a.credit_txn_id)?.entity_id === e.entity_id).map(a => {
          const credit = txns.get(a.credit_txn_id), charge = txns.get(a.charge_txn_id);
          if (!credit || !charge || charge.entity_id !== e.entity_id) fail('Native application transactions do not resolve within one company.');
          return { credit: txnKey(credit), charge: txnKey(charge), amountCents: a.amount_cents, appliedOn: a.applied_on,
            creditOpenCents: credit.open_cents, chargeOpenCents: charge.open_cents };
        }),
        nativeTransactions: native.map(t => ({ ...txnKey(t),
          feedItems: rows.bank_feed_link.filter(l => l.txn_id === t.txn_id).map(l => feedItems.get(l.item_id)?.ll_transaction_id).filter(Boolean) })),
        feed: link ? { llEntityId: link.ll_entity_id, llEntityName: link.ll_entity_name, linkedBy: link.linked_by,
          accounts: own('ledgerline_account').map(a => ({ llAccountId: a.ll_account_id, mask: a.mask, displayName: a.display_name,
            kind: a.kind, include: a.include, start: a.start_date, mappedBy: a.mapped_by,
            books: a.books_account_id ? { account: accountName(a.books_account_id), type: accounts.get(a.books_account_id).type } : null })) } : null,
        // Array position preserves rule_id precedence within each priority tie.
        rules: own('bank_rule').sort((a, b) => a.priority - b.priority || a.rule_id - b.rule_id).map(r => {
          const [kind, id] = r.payee?.split(':') ?? [];
          return { name: r.name, priority: r.priority, active: r.active, money: r.money, conditions: r.conditions,
            payee: payee(kind === 'c' ? Number(id) : null, kind === 'v' ? Number(id) : null), account: accountName(r.account_id),
            class: classPath(classes, r.class_id), location: locations.get(r.location_id)?.name ?? null,
            memo: r.memo, mode: r.mode, matchAll: r.match_all, llAccountIds: r.ll_account_ids ?? (r.ll_account_id ? [r.ll_account_id] : []),
            splits: (r.splits ?? []).map(s => ({ account: accountName(s.accountId), percentBp: s.percent ?? null, cents: s.cents ?? null, description: s.description })),
            memoMode: r.memo_mode, createdBy: r.created_by };
        }),
        researchAttempts: own('vendor_research_attempt').map(a => ({ payeeKey: a.payee_key, at: a.at })),
        holds: own('bank_item_hold').map(h => ({ llTransactionId: h.ll_transaction_id, reason: h.reason, warn: h.warn, actor: h.actor, at: h.at })),
        reconciliations: own('reconciliation').map(r => ({ account: accountName(r.account_id), statementDate: r.statement_date,
          endingCents: r.ending_cents, txns: rows.reconciled_item.filter(i => i.rec_id === r.rec_id).map(i => {
            const t = txns.get(i.txn_id);
            // A deleted transaction has only the reconciliation snapshot; do not invent its total.
            return t ? txnKey(t) : { type: i.txn_type, date: i.txn_date, docNumber: i.doc, totalCents: null };
          }), finishedBy: r.completed_by, finishedAt: r.completed_at })), settings,
        classes: own('class').map(c => ({ name: c.name, parent: classPath(classes, c.parent_id), active: c.active })),
        locations: own('location').map(l => ({ name: l.name, active: l.active })),
        items: own('item').map(i => ({ name: i.name, kind: i.kind, description: i.description, rate: centsText(i.rate_cents), active: i.active,
          incomeAccount: accountName(i.income_account_id), expenseAccount: accountName(i.expense_account_id), assetAccount: accountName(i.asset_account_id),
          cost: i.purchase_cost_cents == null ? null : centsText(i.purchase_cost_cents), sku: i.sku, reorderPoint: i.reorder_point })),
        userAccess: own('app_user_company').map(u => ({ email: users.get(u.user_id)?.email, allCompanies: users.get(u.user_id)?.all_companies })),
      });
    }
    const sms = rows.sms_settings[0];
    saved.org = { ledgerlineOrgId: org.ledgerline_org_id,
      ai: plain(rows.ai_settings[0], ['updated_at']),
      sms: sms || rows.sms_sender.length ? { ...plain(sms), senders: rows.sms_sender.map(s => ({ name: s.name, phone: s.phone,
        allCompanies: s.all_companies, active: s.active, createdBy: s.created_by,
        companies: rows.sms_sender_company.filter(c => c.sender_id === s.sender_id).map(c => companyName(c.entity_id)) })) } : null,
      morning: {
        viewers: rows.morning_viewer.map(v => ({ viewerKey: userKey(v.viewer_key), email: users.get(v.user_id)?.email ?? null, enrollmentState: v.enrollment_state })),
        preferences: rows.morning_preference.map(p => ({ ...plain(p, ['membership_epoch', 'settings_version', 'updated_at']), viewerKey: userKey(p.viewer_key) })),
        delivery: plain(rows.morning_delivery_setting[0], ['settings_version', 'updated_at']),
      }, formPrefs: rows.form_save_pref.map(p => ({ userKey: userKey(p.user_key), formType: p.form_type, choice: p.choice })) };
    for (const table of CARRIED_TABLES) {
      if (!handled.has(table) && rows[table].length) saved.leftovers.push({ table, rows: rows[table].length, why: 'not re-applied by carry-over v1' });
    }
    saved.discarded = [];
    for (const table of TRANSIENT_TABLES) {
      const n = Number((await tx.query(`SELECT count(*) AS n FROM "${table}" WHERE org_id=$1`,[org.org_id])).rows[0].n);
      if (n) saved.discarded.push({table,rows:n,why:'deliberate discard; original history remains only in the backup'});
    }
    const manualResearch = Number((await tx.query(`SELECT count(*) AS n FROM vendor_research
      WHERE org_id=$1 AND (NOT auto OR decision IS NOT NULL OR decided_by IS NOT NULL OR decided_at IS NOT NULL)`,[org.org_id])).rows[0].n);
    if (manualResearch) saved.leftovers.push({table:'vendor_research',rows:manualResearch,why:'manual or decided research; review/export before clear, not restored by carry-over'});
    return JSON.parse(JSON.stringify(saved));
}

// Printable comparison evidence deliberately excludes free text, addresses and
// full document children. Those remain in the protected carry artifact.
function transactionReport(t) {
  if (!t) return t;
  return { type:t.type, date:t.date, docNumber:t.docNumber, totalCents:t.totalCents, party:t.party,
    postings:(t.postings ?? []).map(p=>({account:p.account,cents:p.cents,date:p.date})) };
}
function applicationDecision(company, a) {
  return { company, what: 'native application', credit: transactionReport(a.credit), charge: transactionReport(a.charge),
    amountCents: a.amountCents, appliedOn: a.appliedOn,
    savedOpenCents: { credit: a.creditOpenCents, charge: a.chargeOpenCents },
    openAmountEffect: { creditOpenCentsDelta: -a.amountCents, chargeOpenCentsDelta: -a.amountCents },
    why: 'Native settlement requires manual re-application after the rebuild; omission leaves both documents more open by this amount.',
    hint: 'Check both documents and existing applications, then re-apply by hand and verify their open amounts.' };
}

// Existing pool writers own their transactions. Give each checkout a savepoint on the outer
// transaction, so their COMMIT cannot escape a dry run or commit half of a carry-over.
function transactionPool(tx) {
  let serial = 0;
  return { query: (...args) => tx.query(...args), connect: async () => {
    const name = `carry_writer_${++serial}`;
    let started = false;
    return { release() {}, query: async (query, values) => {
      const sql = typeof query === 'string' ? query : query.text;
      if (/^BEGIN\b/i.test(sql)) { started = true; return tx.query(`SAVEPOINT ${name}`); }
      if (/^COMMIT\s*$/i.test(sql) && started) { started = false; return tx.query(`RELEASE SAVEPOINT ${name}`); }
      if (/^ROLLBACK\s*$/i.test(sql) && started) {
        await tx.query(`ROLLBACK TO SAVEPOINT ${name}`); started = false;
        return tx.query(`RELEASE SAVEPOINT ${name}`);
      }
      return tx.query(query, values);
    } };
  } };
}

const one = async (db, sql, values) => (await db.query(sql, values)).rows[0];
async function matchTransaction(db, scope, saved, used, importedOnly = false) {
  const { rows } = await db.query(`SELECT t.* FROM txn t
    WHERE t.org_id=$1 AND t.entity_id=$2 AND t.type=$3 AND t.txn_date=$4 AND t.total_cents=$5
      AND t.doc_number IS NOT DISTINCT FROM $6 ${importedOnly ? "AND t.source='qbo_import'" : ''}`,
  [scope.orgId, scope.entityId, saved.type, saved.date, saved.totalCents, saved.docNumber ?? null]);
  if (!rows.length) return { why: 'no matching transaction' };
  if (rows.length !== 1) return { why: 'ambiguous transaction candidates' };
  const candidate = rows[0];
  const dimensions = { transactionChildren: await transactionChildren(db) };
  for (const table of new Set([...identityTables,...dimensions.transactionChildren.map(c=>c.table_name)])) dimensions[table] = (await db.query(
    `SELECT * FROM "${table.replaceAll('"','""')}" WHERE org_id=$1`, [scope.orgId])).rows;
  const current = transactionKey(candidate, dimensions);
  if (saved.identityRepresentable !== true || current.identityRepresentable !== true
    || !isDeepStrictEqual(comparableTransaction(saved), comparableTransaction(current))) {
    return { why: 'different party/postings or transaction header/lines (incomplete or unequal identity)', candidate: current };
  }
  if (used.has(candidate.txn_id)) return { why: 'transaction already matched to another saved transaction' };
  used.add(candidate.txn_id);
  return { txnId: candidate.txn_id };
}

async function externalReferenceTarget(db, scope, ref) {
  const match = await matchTransaction(db, scope, ref.transaction, new Set());
  if (!match.txnId) fail(`External reference: ${match.why}.`);
  const { rows } = await db.query(`SELECT * FROM external_ref WHERE org_id=$1 AND entity_id=$2 AND source=$3
    AND (source_ref=$4 OR txn_id=$5)`, [scope.orgId,scope.entityId,ref.source,ref.sourceRef,match.txnId]);
  if (rows.length && (rows.length !== 1 || rows[0].source_ref !== ref.sourceRef || rows[0].txn_id !== match.txnId
      || rows[0].request_hash !== ref.requestHash)) fail('External reference conflicts with an existing integration link.');
  return { txnId:match.txnId, exists:rows.length === 1 };
}

function missingIntegrationCompany(report, co) {
  for (const [key,table] of [['apiTokens','api_token'],['externalRefs','external_ref']]) {
    if (co[key]?.length) report.leftovers.push({ company:co.name, table, rows:co[key].length, why:'company not in the rebuilt copy' });
  }
}

async function restoreApiTokens(db, companies, scopes, attemptFor) {
  const groups = companies.filter(co => co.apiTokens?.length && scopes.has(co.name));
  if (!groups.length) return;
  // All entity locks precede the table lock. Restore credentials last, so no
  // later entity lock can deadlock with a concurrent mint waiting on this table.
  for (const co of [...groups].sort((a,b) => scopes.get(a.name).entityId - scopes.get(b.name).entityId)) {
    const scope = scopes.get(co.name);
    await lockEntity(db, scope.orgId, scope.entityId);
  }
  // Explicit credential IDs require a sequence advance. Block inserts while
  // reading its high-water mark; never rewind or consume values in a preview.
  await db.query('LOCK TABLE api_token IN SHARE ROW EXCLUSIVE MODE');
  for (const co of groups) {
    const scope = scopes.get(co.name);
    for (const token of co.apiTokens) await attemptFor(co.name)('api token', async () => {
      if (!Number.isSafeInteger(token.tokenId) || token.tokenId < 1 || !/^[a-f0-9]{64}$/.test(token.tokenHash)
          || !Array.isArray(token.scopes)) fail('Invalid saved API token metadata.');
      const hash = Buffer.from(token.tokenHash, 'hex');
      const current = await one(db, 'SELECT * FROM api_token WHERE token_id=$1 FOR UPDATE', [token.tokenId]);
      if (current) {
        if (current.org_id !== scope.orgId || current.entity_id !== scope.entityId || !current.token_hash.equals(hash)
            || current.source !== token.source || current.name !== token.name || current.created_by !== token.createdBy
            || !isDeepStrictEqual([...current.scopes].sort(), [...token.scopes].sort())) {
          fail('API token ID conflicts with existing credentials or metadata.');
        }
        // Never reactivate a revoked token, widen scopes or reset current rate
        // counters on a retry. A saved revocation may only restrict access.
        if (token.revokedAt && !current.revoked_at) await db.query('UPDATE api_token SET revoked_at=$2 WHERE token_id=$1',
          [token.tokenId,token.revokedAt]);
        return;
      }
      await db.query(`INSERT INTO api_token(token_id,org_id,entity_id,name,source,token_hash,scopes,created_by,
        created_at,last_used_at,revoked_at,rate_window,rate_count) OVERRIDING SYSTEM VALUE
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [token.tokenId,scope.orgId,scope.entityId,token.name,token.source,hash,token.scopes,token.createdBy,
        token.createdAt,token.lastUsedAt,token.revokedAt,token.rateWindow,token.rateCount]);
    }, { table:'api_token', name:token.name });
  }
  await db.query(`SELECT setval(pg_get_serial_sequence('api_token','token_id'),
    greatest((SELECT last_value FROM api_token_token_id_seq),(SELECT coalesce(max(token_id),1) FROM api_token)),true)`);
}
const accountId = async (db, scope, name) => name == null ? null : (await accountByName(db, { ...scope, name })).account_id;
async function namedId(db, scope, table, name, parentId) {
  if (name == null) return null;
  const id = `${table}_id`;
  const extra = parentId === undefined ? '' : ' AND parent_id IS NOT DISTINCT FROM $4';
  const { rows } = await db.query(`SELECT ${id} FROM "${table}" WHERE org_id = $1 AND entity_id = $2 AND name = $3${extra}`,
    [scope.orgId, scope.entityId, name, ...(parentId === undefined ? [] : [parentId])]);
  if (rows.length !== 1) fail(`No unique ${table} “${name}” in this company.`);
  return rows[0][id];
}

async function classIdByPath(db, scope, path) {
  if (path == null) return null;
  let parentId = null;
  for (const name of path.split(':')) parentId = await namedId(db, scope, 'class', name, parentId);
  return parentId;
}

// This helper is only called with hard-coded table/column lists for the plan's raw ciphertext/settings writes.
async function orgUpsert(db, orgId, table, columns, saved) {
  if (!saved) return;
  const values = columns.map(c => saved[camel(c)] ?? null);
  const current = await one(db, `SELECT * FROM ${table} WHERE org_id = $1`, [orgId]);
  if (current && columns.every((c, i) => isDeepStrictEqual(current[c], values[i]))) return;
  const params = values.map((v, i) => columns[i] === 'models' ? JSON.stringify(v) : v);
  await db.query(`INSERT INTO ${table} (org_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
    ON CONFLICT (org_id) DO UPDATE SET ${columns.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`, [orgId, ...params]);
}

async function restoreSettings(db, scope, s, env, actor, today, attempt) {
  for (const [kind, saved] of Object.entries(s ?? {})) {
    if (!saved) continue;
    await attempt(kind, async () => {
      if (kind === 'email') {
        await saveEmailSettings(db, { ...scope, env, fields: { ...saved, host: saved.smtpHost, port: saved.smtpPort,
          security: saved.smtpSecurity, user: saved.smtpUser, password: '' } });
        await db.query('UPDATE email_settings SET smtp_password_enc = $3 WHERE org_id = $1 AND entity_id = $2',
          [scope.orgId, scope.entityId, saved.smtpPasswordEnc]);
      } else if (kind === 'sales') {
        await saveSalesSettings(db, { ...scope, fields: { ...saved, defaultTermsId: await namedId(db, scope, 'terms', saved.defaultTerms) } });
        const fields = { ...saved, rule_days: (saved.reminderRules ?? []).map(r => String(r.days)) };
        for (const [type, template] of Object.entries(saved.templates ?? {})) for (const [key, value] of Object.entries(template)) fields[`tpl_${type}_${key}`] = value;
        await saveMessageSettings(db, { ...scope, fields, today, current: saved });
      } else if (kind === 'accounting') {
        await saveAccountingSettings(db, { ...scope, fields: { ...saved, billableIncomeAccountId: await accountId(db, scope, saved.billableIncomeAccount) } });
      } else if (kind === 'bills') await saveBillSettings(db, { ...scope, ...saved });
      else if (kind === 'payments') await savePaymentsSettings(db, { ...scope, fields: saved, env, hasKey: !!settingsKey(env) });
      else if (kind === 'lateFees') await savePolicy(db, { ...scope, today: saved.effectiveFrom ?? today, fields: {
        enabled: saved.enabled ? '1' : '', feeKind: saved.feeKind, flat: centsText(saved.flatCents), percent: basisPointsText(saved.percentBps),
        graceDays: String(saved.graceDays), repeat: saved.repeatEveryDays ? '1' : '', repeatDays: String(saved.repeatEveryDays ?? ''), maxFees: String(saved.maxFeesPerInvoice) } });
      else if (kind === 'currency') await turnOnMulticurrency(db, { ...scope, actor: saved.turnedOnBy ?? actor });
      else if (kind === 'formStyle') await saveFormStyle(db, { ...scope, fields: saved });
      else if (kind === 'integration') {
        await lockEntity(db, scope.orgId, scope.entityId);
        await db.query(`INSERT INTO integration_setting(org_id,entity_id,accept_writes,write_floor,ledger_instance,updated_by)
          VALUES($1,$2,false,$3,$4,$5) ON CONFLICT(org_id,entity_id) DO UPDATE SET
          accept_writes=false,write_floor=EXCLUDED.write_floor,ledger_instance=EXCLUDED.ledger_instance,
          updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [scope.orgId,scope.entityId,saved.writeFloor,saved.ledgerInstance,actor]);
      }
      else fail(`Unknown settings section “${kind}”.`);
    });
  }
}

async function waitForAccounts(pool, data, waitMinutes) {
  const deadline = Date.now() + waitMinutes * 60_000;
  for (;;) {
    const missing = [];
    for (const co of data.companies.filter(c => c.feed)) {
      const r = await one(pool, `SELECT e.entity_id, EXISTS (SELECT 1 FROM ledgerline_account a WHERE a.org_id=e.org_id AND a.entity_id=e.entity_id) AS ready
        FROM entity e JOIN org o USING(org_id) WHERE o.slug=$1 AND lower(e.name)=lower($2)`, [data.orgSlug, co.name]);
      if (r && !r.ready) missing.push(co.name);
    }
    if (!missing.length) return;
    if (Date.now() >= deadline) fail(`${missing.join(', ')}: no feed accounts yet.`);
    await delay(Math.min(10_000, deadline - Date.now()));
  }
}

async function restoreLinks(db, scope, co, actor, attempt) {
  if (!co.feed) return;
  await attempt('link', async () => {
    const current = await one(db, 'SELECT ll_entity_id FROM ledgerline_link WHERE org_id=$1 AND entity_id=$2', [scope.orgId, scope.entityId]);
    if (current) {
      if (current.ll_entity_id !== co.feed.llEntityId) fail('This company is linked to a different feed company.');
      return;
    }
    // No ledgerline client is needed. NULL last_pull_at makes the app's scheduler pull at once.
    await db.query(`INSERT INTO ledgerline_link (org_id,entity_id,ll_entity_id,ll_entity_name,linked_by,linked_at,last_pull_at)
      VALUES ($1,$2,$3,$4,$5,now(),NULL)`, [scope.orgId, scope.entityId, co.feed.llEntityId, co.feed.llEntityName, co.feed.linkedBy ?? actor]);
  });
}

async function restoreFeeds(db, scope, co, actor, attempt) {
  if (!co.feed) return;
  for (const a of co.feed.accounts) await attempt('mapping', async () => {
    const resolved = a.include && a.books ? await accountByName(db, { ...scope, name: a.books.account, type: a.books.type }) : null;
    await saveMappings(db, { ...scope, actor: a.mappedBy ?? actor,
      choices: [{ id: a.llAccountId, choice: !a.include ? 'skip' : resolved ? String(resolved.account_id) : '', start: a.start ?? '' }] });
  }, { mask: a.mask, name: a.books?.account ?? a.displayName });
  for (const h of co.holds ?? []) await attempt('hold', () => db.query(`INSERT INTO bank_item_hold (org_id,entity_id,ll_transaction_id,reason,warn,actor,at)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (entity_id,ll_transaction_id) DO UPDATE SET reason=$4,warn=$5,actor=$6,at=$7`,
  [scope.orgId, scope.entityId, h.llTransactionId, h.reason, h.warn, h.actor ?? actor, h.at]));
}

async function ruleFields(db, scope, r) {
  let payee = '';
  if (r.payee) {
    const kind = r.payee.kind;
    if (!['vendor', 'customer'].includes(kind)) fail('Unknown rule payee kind.');
    const row = await (kind === 'vendor' ? vendorByName : customerByName)(db, { ...scope, name: r.payee.name });
    payee = `${kind === 'vendor' ? 'v' : 'c'}:${row[`${kind}_id`]}`;
  }
  const splits = [];
  for (const s of r.splits ?? []) splits.push({ accountId: await accountId(db, scope, s.account), description: s.description,
    ...(s.percentBp == null ? { amount: centsText(s.cents) } : { percent: basisPointsText(s.percentBp) }) });
  const conditions = r.conditions.map(c => c.field !== 'amount' ? c : { ...c, value: centsText(c.value),
    ...(c.value2 === undefined ? {} : { value2: centsText(c.value2) }) });
  return { ...r, conditions, payee, splits, accountId: await accountId(db, scope, r.account),
    classId: await classIdByPath(db, scope, r.class), locationId: await namedId(db, scope, 'location', r.location), llAccounts: r.llAccountIds };
}

// One ordered set across this pass: no rule writes until every company's rules
// resolve. Normal rule writers take these entity locks too. Their transactions
// are savepoints on the caller's transaction, so none can commit a partial set.
async function restoreRules(db, companies, scopes, actor, report) {
  const groups = companies.filter(co => co.rules?.length).map(co => ({ co, scope: scopes.get(co.name), entries: [] }));
  const readOrder = scope => db.query('SELECT rule_id,name,priority FROM bank_rule WHERE org_id=$1 AND entity_id=$2 ORDER BY priority,rule_id',
    [scope.orgId, scope.entityId]).then(r => r.rows);
  const orderKey = rows => rows.map(r => [r.priority, r.name]);
  for (const {scope} of groups.filter(g => g.scope).sort((a,b) => a.scope.entityId-b.scope.entityId)) {
    await lockEntity(db, scope.orgId, scope.entityId);
  }
  let unresolved = false;
  for (const group of groups) {
    const {co,scope,entries} = group;
    group.current = scope ? await readOrder(scope) : [];
    for (const r of co.rules) {
      const entry = { company: co.name, what: 'rule', name: r.name };
      entries.push({r, detail:entry});
      try {
        if (!scope) fail('company not in the rebuilt copy');
        const existing = group.current.find(x => x.name.toLowerCase() === r.name.toLowerCase());
        const fields = await ruleFields(db, scope, r);
        const args = { ...scope, ruleId: existing?.rule_id, actor: r.createdBy ?? actor, fields };
        // Includes active category/split, payee, class, location and every feed UUID.
        await checkRule(db, args);
        Object.assign(entries.at(-1), {args});
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        unresolved = true;
        entry.why = error.message;
      }
    }
  }
  const entries = groups.flatMap(g => g.entries);
  const skipSet = why => report.skipped.push(...entries.map(e => ({...e.detail, why:e.detail.why ?? why})));
  if (unresolved) { skipSet('Ordered rule set deferred: resolve every skipped rule before retrying feeds.'); return; }
  if (!entries.length) return;
  const decision = (company, why) => {
    report.decisions.push({company, what:'rule set', why,
      hint:'Reconcile the existing rules with the saved precedence before retrying; no rules were restored in this pass.'});
    skipSet('Ordered rule set refused; resolve the precedence decision before retrying.');
  };
  for (const {co,current,entries} of groups) {
    const names = new Set(co.rules.map(r => r.name.toLowerCase()));
    // New IDs sort after existing IDs within a priority tie. A missing earlier
    // tied rule cannot be appended safely to a later existing rule.
    const projected = entries.map(({r,args}, index) => ({...r, id:args.ruleId ?? Infinity, index}))
      .sort((a,b) => a.priority-b.priority || a.id-b.id || a.index-b.index);
    if (names.size !== co.rules.length || current.some(r => !names.has(r.name.toLowerCase()))
      || !isDeepStrictEqual(orderKey(projected), orderKey(co.rules))) {
      decision(co.name, 'Existing rule set would change saved priority/rule_id precedence.'); return;
    }
  }
  await db.query('SAVEPOINT carry_rules');
  let company;
  try {
    for (const group of groups) {
      company = group.co.name;
      for (const {args} of group.entries) await saveRule(db, args);
      // Verify actual database order, including priority changes and ID allocation.
      if (!isDeepStrictEqual(orderKey(await readOrder(group.scope)), orderKey(group.co.rules))) {
        fail('Restored priority/rule_id precedence differs from the saved order.');
      }
    }
    await db.query('RELEASE SAVEPOINT carry_rules');
    report.applied.push(...entries.map(e => e.detail));
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT carry_rules');
    await db.query('RELEASE SAVEPOINT carry_rules');
    if (!(error instanceof ValidationError)) throw error;
    decision(company, error.message);
  }
}

// A preview is deliberately a read-only plan. Running writers then rolling back still
// consumes sequence values; their detailed validation belongs to the actual apply.
async function previewCarryOver(pool, data, phase) {
  const tx = await pool.connect();
  const report = { applied: [], skipped: [], decisions: [], planned: [], leftovers: [...data.leftovers ?? []],
    dryRun: true, validation: 'read-only plan; writer validation occurs during apply' };
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const org = await one(tx,'SELECT * FROM org WHERE slug=$1',[data.orgSlug]);
    if (!org) fail(`No org “${data.orgSlug}”.`);
    if (phase !== 'books') {
      if (!org.ledgerline_org_id) fail('Links require org.ledgerline_org_id to be configured.');
      if (data.companies.some(c=>c.feed) && data.org?.ledgerlineOrgId !== org.ledgerline_org_id) fail('Saved ledgerline tenant does not match org.ledgerline_org_id.');
    }
    for (const co of data.companies) {
      let entity;
      try { entity = await entityByName(tx,{orgId:org.org_id,name:co.name}); }
      catch (error) { if (!(error instanceof ValidationError)) throw error; report.skipped.push({what:co.name,why:'company not in the rebuilt copy'});
        if (phase === 'books') {
          report.decisions.push(...(co.nativeApplications ?? []).map(a => applicationDecision(co.name, a)));
          missingIntegrationCompany(report, co);
        }
        continue; }
      const scope = {orgId:org.org_id,entityId:entity.entity_id};
      const plan = (what, name) => report.planned.push({company:co.name,what,...(name ? {name} : {})});
      if (phase !== 'books') {
        if (co.feed) {
          const existing = await one(tx,'SELECT ll_entity_id FROM ledgerline_link WHERE org_id=$1 AND entity_id=$2',[scope.orgId,scope.entityId]);
          if (existing && existing.ll_entity_id !== co.feed.llEntityId) report.skipped.push({company:co.name,what:'link',why:'This company is linked to a different feed company.'});
          else plan('link');
          if (phase === 'feeds') {
            for (const a of co.feed.accounts) plan('mapping',a.displayName);
          }
        }
        if (phase === 'feeds') for (const rule of co.rules ?? []) plan('rule',rule.name);
        continue;
      }
      if (co.company) plan('company');
      for (const token of co.apiTokens ?? []) plan('api token',token.name);
      for (const ref of co.externalRefs ?? []) {
        try { await externalReferenceTarget(tx,scope,ref); plan('external reference',ref.sourceRef); }
        catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          const detail = { company:co.name, table:'external_ref', source:ref.source, sourceRef:ref.sourceRef, why:error.message };
          report.skipped.push({ ...detail, what:'external reference' });
          report.leftovers.push({ ...detail, rows:1 });
        }
      }
      for (const a of co.accountChanges ?? []) {
        if (a.kind === 'created' && !(co.nativeTransactions ?? []).some(t=>t.postings.some(p=>p.account===a.name))) plan('account',a.name);
        else report.decisions.push({company:co.name,kind:a.kind,name:a.name,before:a.before?.name ?? null,...(a.column?{column:a.column}:{})});
      }
      report.decisions.push(...(co.nativeApplications ?? []).map(a => applicationDecision(co.name, a)));
      const used = new Set();
      for (const t of co.nativeTransactions ?? []) {
        const match = await matchTransaction(tx,scope,t,used,true);
        if (match.txnId) report.skipped.push({company:co.name,what:'native transaction',docNumber:t.docNumber,why:'present in the QuickBooks import'});
        else report.decisions.push({company:co.name,type:t.type,date:t.date,docNumber:t.docNumber,totalCents:t.totalCents,why:match.why});
      }
      for (const [key,what] of [['loans','loan'],['terms','terms'],['vendorExtras','vendor extras'],['customerExtras','customer extras'],
        ['classes','class'],['locations','location'],['items','item'],['reconciliations','reconciliation'],['userAccess','user access'],['researchAttempts','research attempt']]) {
        for (const entry of co[key] ?? []) plan(what,entry.name ?? entry.account);
      }
      for (const [kind,value] of Object.entries(co.settings ?? {})) if (value) plan(kind);
    }
    if (phase === 'books') for (const [key,value] of Object.entries(data.org ?? {})) {
      if (key !== 'ledgerlineOrgId' && value != null) report.planned.push({what:key});
    }
    await tx.query('ROLLBACK');
    return report;
  } finally { await tx.query('ROLLBACK').catch(()=>{}); tx.release(); }
}

export async function applyCarryOver(pool, { data, phase, actor = 'carry-over', env = process.env, dryRun = true, waitMinutes = 20 }) {
  if (data?.version !== 1 || typeof data.orgSlug !== 'string' || !Array.isArray(data.companies)) fail('Not a version 1 carry-over file.');
  if (!['books', 'links', 'feeds'].includes(phase)) fail(`Unknown carry-over phase “${phase}”.`);
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0) fail('wait-minutes must be a non-negative number.');
  if (dryRun) return previewCarryOver(pool, data, phase);
  let links;
  if (phase === 'feeds') {
    // The pull needs committed links. Never hold a transaction while waiting for another process.
    links = await applyCarryOver(pool, { data, phase: 'links', actor, env, dryRun });
    await waitForAccounts(pool, data, waitMinutes);
  }
  const tx = await pool.connect();
  const report = links ?? { applied: [], skipped: [], decisions: [], leftovers: [...data.leftovers ?? []] };
  try {
    await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const org = await one(tx, 'SELECT * FROM org WHERE slug = $1', [data.orgSlug]);
    if (!org) fail(`No org “${data.orgSlug}”.`);
    if (phase === 'links') {
      if (!org.ledgerline_org_id) fail('Links require org.ledgerline_org_id to be configured.');
      if (data.companies.some(c => c.feed) && data.org?.ledgerlineOrgId !== org.ledgerline_org_id) {
        fail('Saved ledgerline tenant does not match org.ledgerline_org_id.');
      }
    }
    const orgId = org.org_id;
    await tx.query('SELECT pg_advisory_xact_lock($1, hashint8($2))', [SECURITY_LOCK, orgId]);
    await tx.query("SELECT set_config('app.actor', $1, true)", [actor]);
    const db = transactionPool(tx);
    const attemptFor = company => async (what, fn, detail = {}) => {
      await tx.query('SAVEPOINT carry_entry');
      try {
        await fn();
        await tx.query('RELEASE SAVEPOINT carry_entry');
        report.applied.push({ ...(company ? { company } : {}), what, ...detail });
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT carry_entry');
        await tx.query('RELEASE SAVEPOINT carry_entry');
        if (!(error instanceof ValidationError)) throw error;
        report.skipped.push({ ...(company ? { company } : {}), what, ...detail, why: error.message });
        if (detail.table) report.leftovers.push({ ...(company ? { company } : {}), ...detail, rows: 1, why: error.message });
      }
    };
    const companyScopes = new Map();
    const accesses = new Map();
    for (const co of data.companies) {
      let entity;
      try { entity = await entityByName(db, { orgId, name: co.name }); }
      catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        report.skipped.push({ what: co.name, why: 'company not in the rebuilt copy' });
        if (phase === 'books') {
          report.decisions.push(...(co.nativeApplications ?? []).map(a => applicationDecision(co.name, a)));
          missingIntegrationCompany(report, co);
        }
        for (const [key, table] of [['vendorExtras','vendor'],['customerExtras','customer'],['terms','terms']]) {
          if (co[key]?.length) report.leftovers.push({ company: co.name, table, rows: co[key].length, why: 'company not in the rebuilt copy' });
        }
        continue;
      }
      const scope = { orgId, entityId: entity.entity_id };
      companyScopes.set(co.name, scope);
      const attempt = attemptFor(co.name);
      if (phase === 'links') { await restoreLinks(db, scope, co, actor, attempt); continue; }
      if (phase === 'feeds') { await restoreFeeds(db, scope, co, actor, attempt); continue; }
      if (co.company) await attempt('company', async () => {
        const c = co.company;
        await saveCompany(db, { ...scope, env, fields: { ...c, name: co.name, ...c.address,
          ...Object.fromEntries(Object.entries(c.customerAddress ?? {}).map(([k, v]) => [`c_${k}`, v])) } });
        await db.query('UPDATE entity SET ein_enc = $3, ein_last4 = $4, logo = $5, logo_type = $6 WHERE org_id = $1 AND entity_id = $2',
          [orgId, scope.entityId, c.einEnc, c.einLast4, c.logoBase64 == null ? null : Buffer.from(c.logoBase64, 'base64'), c.logoType]);
      });
      for (const a of co.accountChanges ?? []) {
        const exists = await one(db, 'SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = $3', [orgId, scope.entityId, a.name]);
        const posted = (co.nativeTransactions ?? []).some(t => t.postings.some(p => p.account === a.name));
        if (a.kind === 'created' && !posted && exists) {
          report.applied.push({ company: co.name, what: 'account', name: a.name });
        } else if (a.kind === 'created' && !posted) await attempt('account', () => saveAccount(db, { ...scope,
          fields: { ...a, parentId: null } }).then(async id => {
          if (a.parent) await saveAccount(db, { ...scope, accountId: id, fields: { ...a, parentId: await accountId(db, scope, a.parent) } });
        }), { name: a.name });
        else report.decisions.push({ company: co.name, kind: a.kind, name: a.name, before: a.before?.name ?? null,...(a.column?{column:a.column}:{}),
          hint: 'reconcile this account change with QuickBooks; the next export carries it over' });
      }
      for (const loan of co.loans ?? []) await attempt('loan', async () => {
        const id = await accountId(db, scope, loan.account);
        let otherAccountId = null, openEntityIds = [];
        if (loan.other) {
          const other = await entityByName(db, { orgId, name: loan.other.company });
          otherAccountId = await accountId(db, { orgId, entityId: other.entity_id }, loan.other.account);
          openEntityIds = [other.entity_id];
        }
        await saveLoanSetup(db, { ...scope, accountId: id, list: loan.list, otherAccountId, openEntityIds });
      });
      report.decisions.push(...(co.nativeApplications ?? []).map(a => applicationDecision(co.name, a)));
      const matchedNative = new Set();
      for (const t of co.nativeTransactions ?? []) {
        const match = await matchTransaction(db, scope, t, matchedNative, true);
        if (match.txnId) report.skipped.push({ company: co.name, what: 'native transaction', docNumber: t.docNumber, why: 'present in the QuickBooks import' });
        else report.decisions.push({ company: co.name, type: t.type, date: t.date, docNumber: t.docNumber, totalCents: t.totalCents,
          why: match.why, ...(match.candidate ? { saved: transactionReport(t), candidate: transactionReport(match.candidate) } : {}),
          hint: 're-enter in Financial Books as an approved difference, or enter it in QuickBooks' });
      }
      await restorePartyExtras(db, scope, co, actor, attempt);
      await restoreSettings(db, scope, co.settings, env, actor, data.savedAt.slice(0, 10), attempt);
      const depth = c => c.parent == null ? 0 : c.parent.split(':').length;
      for (const c of [...co.classes ?? []].sort((a, b) => depth(a) - depth(b))) await attempt('class', async () => {
        const parentId = await classIdByPath(db, scope, c.parent);
        let r = await one(db, 'SELECT class_id FROM class WHERE org_id = $1 AND entity_id = $2 AND name = $3 AND parent_id IS NOT DISTINCT FROM $4', [orgId, scope.entityId, c.name, parentId]);
        if (!r) { await saveClass(db, { ...scope, fields: { ...c, parentId } }); r = { class_id: await namedId(db, scope, 'class', c.name, parentId) }; }
        await saveClass(db, { ...scope, classId: r.class_id, fields: { ...c, parentId } });
      });
      for (const l of co.locations ?? []) await attempt('location', async () => {
        let r = await one(db, 'SELECT location_id FROM location WHERE org_id = $1 AND entity_id = $2 AND name = $3', [orgId, scope.entityId, l.name]);
        if (!r) { await saveLocation(db, { ...scope, fields: l }); r = { location_id: await namedId(db, scope, 'location', l.name) }; }
        await saveLocation(db, { ...scope, locationId: r.location_id, fields: l });
      });
      for (const i of co.items ?? []) await attempt('item', async () => {
        const r = await one(db, 'SELECT * FROM item WHERE org_id = $1 AND entity_id = $2 AND name = $3', [orgId, scope.entityId, i.name]);
        if (i.kind === 'system') { if (r?.kind !== 'system') fail(`Built-in item “${i.name}” must be created by the app.`); return; }
        const fields = { ...i, incomeAccountId: await accountId(db, scope, i.incomeAccount), expenseAccountId: await accountId(db, scope, i.expenseAccount),
          assetAccountId: await accountId(db, scope, i.assetAccount), reorderPoint: Object.hasOwn(i, 'reorderPoint') ? i.reorderPoint : r?.reorder_point ?? null };
        const id = await saveItem(db, { ...scope, itemId: r?.item_id, fields, actor });
        if (!r && i.active === false) await saveItem(db, { ...scope, itemId: id, fields, actor });
      });
      for (const u of co.userAccess ?? []) {
        const access = accesses.get(u.email) ?? { all: u.allCompanies, entityIds: [] };
        access.entityIds.push(scope.entityId); accesses.set(u.email, access);
      }
      for (const ref of co.externalRefs ?? []) await attempt('external reference', async () => {
        await lockEntity(db, scope.orgId, scope.entityId);
        const target = await externalReferenceTarget(db,scope,ref);
        if (!target.exists) await db.query(`INSERT INTO external_ref(org_id,entity_id,source,source_ref,txn_id,request_hash,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [scope.orgId,scope.entityId,ref.source,ref.sourceRef,target.txnId,ref.requestHash,ref.createdAt]);
      }, { table:'external_ref', source:ref.source, sourceRef:ref.sourceRef });
      for (const r of [...co.reconciliations ?? []].sort((a, b) => a.statementDate.localeCompare(b.statementDate))) await attempt('reconciliation', async () => {
        const id = await accountId(db, scope, r.account);
        const existing = await one(db, 'SELECT ending_cents FROM reconciliation WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND statement_date = $4', [orgId, scope.entityId, id, r.statementDate]);
        if (existing) { if (existing.ending_cents !== r.endingCents) fail('The existing reconciliation has a different ending balance.'); return; }
        const txnIds = [], matched = new Set();
        for (const t of r.txns) {
          const match = await matchTransaction(db, scope, t, matched);
          if (!match.txnId) fail(`Reconciliation transaction: ${match.why}.`);
          txnIds.push(match.txnId);
        }
        await finishReconciliation(db, { ...scope, accountId: id, statementDate: r.statementDate, endingText: centsText(r.endingCents), txnIds, actor: r.finishedBy ?? actor });
      });
    }
    if (phase !== 'books') {
      if (phase === 'feeds') await restoreRules(db, data.companies, companyScopes, actor, report);
      await tx.query(dryRun ? 'ROLLBACK' : 'COMMIT');
      return report;
    }
    const attempt = attemptFor(null);
    // Local CLI authority comes from the database connection; user ids still resolve by email.
    const actorCtx = trustedActor({ owner: true }, orgId, { id: 'carry-over', version: 1 });
    for (const [email, access] of accesses) await attempt('user access', async () => {
      const user = await one(db, 'SELECT user_id FROM app_user WHERE org_id = $1 AND lower(email) = lower($2)', [orgId, email]);
      if (!user) fail(`No user “${email}”.`);
      await setUserCompanies(db, { orgId, userId: user.user_id, ...access, actorCtx });
    });
    if (data.org?.ai) await attempt('ai settings', () => orgUpsert(db, orgId, 'ai_settings', ['provider', 'api_key_enc', 'models', 'web_search', 'updated_by'], data.org.ai));
    if (data.org?.sms) {
      await attempt('sms settings', () => orgUpsert(db, orgId, 'sms_settings', ['enabled', 'account_sid', 'auth_token_enc', 'phone', 'updated_by'], data.org.sms));
      for (const sender of data.org.sms.senders ?? []) await attempt('sms sender', async () => {
        const entityIds = [];
        for (const name of sender.companies) entityIds.push((await entityByName(db, { orgId, name })).entity_id);
        const old = await one(db, 'SELECT sender_id FROM sms_sender WHERE org_id = $1 AND phone = $2', [orgId, sender.phone]);
        await saveSender(db, { orgId, ...sender, senderId: old?.sender_id, entityIds, actor: sender.createdBy ?? actor });
      });
    }
    if (data.org?.morning?.viewers?.length || data.org?.morning?.preferences?.length || data.org?.morning?.delivery) {
      await ensureOwnerViewer(db, orgId);
      for (const p of data.org.morning.preferences ?? []) await attempt('morning preferences', async () => {
        const viewer = data.org.morning.viewers.find(v => v.viewerKey === p.viewerKey);
        let key = p.viewerKey;
        if (key !== 'owner') {
          const user = await one(db, 'SELECT user_id FROM app_user WHERE org_id = $1 AND lower(email) = lower($2)', [orgId, viewer?.email]);
          if (!user) fail('Morning viewer needs to re-enrol.');
          key = String(user.user_id);
        }
        const current = await one(db, 'SELECT * FROM morning_preference WHERE org_id=$1 AND viewer_key=$2', [orgId, key]);
        if (!current) fail('Morning viewer needs to re-enrol.');
        const cols = ['enabled', 'channel', 'send_minute', 'phone', 'email', 'include_amounts', 'detail_threshold_cents'];
        if (cols.every(c => isDeepStrictEqual(current[c], p[camel(c)]))) return;
        await db.query(`UPDATE morning_preference SET enabled=$3, channel=$4, send_minute=$5, phone=$6, email=$7,
          include_amounts=$8, detail_threshold_cents=$9, settings_version=settings_version+1 WHERE org_id=$1 AND viewer_key=$2`,
        [orgId, key, p.enabled, p.channel, p.sendMinute, p.phone, p.email, p.includeAmounts, p.detailThresholdCents]);
      });
      if (data.org.morning.delivery) await attempt('morning delivery', async () => {
        const d = data.org.morning.delivery;
        const current = await one(db, 'SELECT * FROM morning_delivery_setting WHERE org_id=$1', [orgId]);
        if (current && ['delivery_enabled', 'trusted_origin', 'trusted_origin_fingerprint', 'observed_origin_fingerprint']
          .every(c => isDeepStrictEqual(current[c], d[camel(c)]))) return;
        await db.query(`INSERT INTO morning_delivery_setting (org_id,delivery_enabled,trusted_origin,trusted_origin_fingerprint,observed_origin_fingerprint)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id) DO UPDATE SET delivery_enabled=$2,trusted_origin=$3,trusted_origin_fingerprint=$4,
          observed_origin_fingerprint=$5,settings_version=morning_delivery_setting.settings_version+1`,
        [orgId, d.deliveryEnabled, d.trustedOrigin, d.trustedOriginFingerprint, d.observedOriginFingerprint]);
      });
    }
    for (const p of data.org?.formPrefs ?? []) await attempt('form preference', async () => {
      let key = p.userKey;
      if (key !== 'owner') {
        const email = key?.startsWith('email:') ? key.slice(6) : null;
        const user = email && await one(db,'SELECT user_id FROM app_user WHERE org_id=$1 AND lower(email)=lower($2)',[orgId,email]);
        if (!user) fail('Form preference has no matching user email in the rebuilt copy.');
        key = `u:${user.user_id}`;
      }
      await db.query(`INSERT INTO form_save_pref (org_id,user_key,form_type,choice)
        VALUES ($1,$2,$3,$4) ON CONFLICT (org_id,user_key,form_type) DO UPDATE SET choice=$4`, [orgId,key,p.formType,p.choice]);
    }, { table: 'form_save_pref' });
    for (const co of data.companies) {
      const scope = companyScopes.get(co.name);
      if (!scope) continue;
      for (const a of co.researchAttempts ?? []) await attemptFor(co.name)('research attempt', () => db.query(`INSERT INTO vendor_research_attempt (org_id,entity_id,payee_key,at)
        SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM vendor_research_attempt WHERE org_id=$1 AND entity_id=$2 AND payee_key=$3 AND at=$4)`,
      [orgId, scope.entityId, a.payeeKey, a.at]));
    }
    await restoreApiTokens(db, data.companies, companyScopes, attemptFor);
    await tx.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return report;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {}); throw error;
  } finally { tx.release(); }
}

// A printable summary never includes saved settings, ciphertext, phone numbers or addresses.
export function carryOverReport(data) {
  if (Array.isArray(data.applied)) return { counts: { applied: data.applied.length, skipped: data.skipped.length, decisions: data.decisions.length,
    ...(data.planned ? { planned: data.planned.length } : {}) }, ...data };
  if (data?.version !== 1 || !Array.isArray(data.companies)) fail('Not a version 1 carry-over file.');
  return { version: data.version, savedAt: data.savedAt, orgSlug: data.orgSlug, schemaMigrations: data.schemaMigrations,
    counts: { companies: data.companies.length, nativeTransactions: data.companies.reduce((n, c) => n + c.nativeTransactionCount, 0),
      nativeApplications: data.companies.reduce((n,c) => n + (c.nativeApplications?.length ?? 0), 0),
      links: data.companies.filter(c => c.feed).length, rules: data.companies.reduce((n, c) => n + c.rules.length, 0) },
    decisions: data.companies.flatMap(c => [
      ...(c.nativeApplications ?? []).map(a => applicationDecision(c.name, a)),
      ...c.accountChanges.map(a => ({ company: c.name, kind: a.kind, name: a.name, before: a.before?.name ?? null,...(a.column?{column:a.column}:{}),
        hint: 'reconcile this account change with QuickBooks; the next export carries it over' })),
      ...c.nativeTransactions.map(t => ({ company: c.name, type: t.type, date: t.date, docNumber: t.docNumber, totalCents: t.totalCents,
        hint: 'compare with the QuickBooks import in the books phase' })),
    ]), leftovers: data.leftovers, unclassified: data.unclassified, discarded: data.discarded ?? [] };
}
