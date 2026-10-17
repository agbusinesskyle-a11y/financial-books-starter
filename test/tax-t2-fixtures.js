// test/tax-t2-fixtures.js — sample companies, accounts, postings and periods for the Tax Books T2 tests. Sample names only.
// Not a test file (npm test runs test/*.test.js), so it holds no tests of its own.
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { createCompany } from '../lib/data/companies.js';
import { saveAccount } from '../lib/data/ledger.js';
import { saveJournalEntry } from '../lib/data/ledger-tools.js';
import { saveProfile, openPeriod } from '../lib/tax/periods.js';
import { saveActivity, includeBooks } from '../lib/tax/activities.js';
import { saveParty } from '../lib/tax/parties.js';

// A fresh database with the sample organization (its own sample company stays untouched by these tests).
export async function t2Db() {
  const db = await freshDb();
  const ids = await writeSample(db.pool, generateSample({ asOf: '2026-10-12' }));
  return { db, pool: db.pool, orgId: ids.orgId, sampleEntityId: ids.entityId };
}
export const company = (pool, orgId, name) => createCompany(pool, { orgId, name, timeZone: 'America/Chicago' });
// An account by name: one of createCompany's standard accounts ('Checking', 'Services', 'Wages', 'Owner’s Draw', 'Rent & Lease',
// 'Meals', 'Interest Earned', 'Other Expenses', 'Loan Payable', …), a system account ('Retained Earnings'), or a new one when a
// type is given.
export async function acct(pool, scope, name, type = null) {
  if (type) await saveAccount(pool, { ...scope, fields: { name, number: '', type, parentId: '', description: '', active: true } });
  const { rows: [a] } = await pool.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = $3', [scope.orgId, scope.entityId, name]);
  if (!a) throw new Error(`no account ${name}`);
  return Number(a.account_id);
}
// A journal entry: lines are [accountId, cents] with debits positive and credits negative. Returns the entry's txn id.
export function je(pool, scope, txnDate, lines, { memo = 'T2 test entry', txnId = null } = {}) {
  return saveJournalEntry(pool, { ...scope, txnId, actor: 'tester', txnDate, docNumber: '', memo,
    lines: lines.map(([accountId, cents]) => ({ accountId: String(accountId), debit: cents > 0 ? (cents / 100).toFixed(2) : '', credit: cents < 0 ? (-cents / 100).toFixed(2) : '', description: '' })) });
}
// The posting line number a journal entry gave one account (the attribution key is txn + line).
export async function lineOf(pool, txnId, accountId) {
  const { rows: [p] } = await pool.query('SELECT line_no FROM posting WHERE txn_id = $1 AND account_id = $2', [txnId, accountId]);
  return p.line_no;
}
// Set the profile (always with a reason, so a later change of type is allowed) and open the calendar-year period.
export async function period(pool, scope, year, returnType = 'form_1065', { taxMethod = 'cash', bookBasis = 'accrual', activityKind = null } = {}) {
  await saveProfile(pool, { ...scope, fields: { returnType, activityKind: returnType === 'disregarded' ? (activityKind ?? 'trade') : null, taxMethodDefault: taxMethod, bookBasisDefault: bookBasis, yearEndMonth: 12 },
    reason: 'test setup', actor: 'tester' });
  return Number(await openPeriod(pool, { ...scope, year, actor: 'tester' }));
}
export async function activity(pool, scope, { name, kind = 'trade', schedule = 'p1', from = '2020-01-01', to = '', disposedOn = '' }) {
  return Number(await saveActivity(pool, { ...scope, fields: { kind, name, schedule, from, to, disposedOn } }));
}
export async function include(pool, parent, returnId, activityId, childEntityId) {
  return Number(await includeBooks(pool, { ...parent, returnId, activityId, sourceEntityId: childEntityId, approvedBy: 'tester' }));
}
export async function party(pool, orgId, name, kind = 'individual') {
  await saveParty(pool, { orgId, fields: { kind, name, taxId: '' }, env: {} });
  const { rows: [p] } = await pool.query('SELECT party_id FROM tax_party WHERE org_id = $1 AND name = $2', [orgId, name]);
  return Number(p.party_id);
}
