import { withTransaction } from '../db.js';
import { ValidationError } from './writes.js';
import { ensureSystemAccounts } from './ledger.js';
import { BUSINESS_TYPES } from './settings.js';

// Companies (stage B1): each organization keeps several sets of books. A new company starts empty with a standard chart
// of accounts and the usual payment terms (nothing from any other company or from the sample books).

const fail = message => { throw new ValidationError(message); };

// A general-purpose chart of accounts for a new company (the system accounts — A/R, A/P, Undeposited Funds, Inventory,
// Opening Balance Equity, Retained Earnings, cost of goods sold and the rest — are added by ensureSystemAccounts).
export const STANDARD_ACCOUNTS = [
  ['Checking', '1000', 'bank'], ['Savings', '1010', 'bank'], ['Prepaid Expenses', '1400', 'other_current_asset'],
  ['Furniture and Equipment', '1500', 'fixed_asset'], ['Vehicles', '1510', 'fixed_asset'], ['Accumulated Depreciation', '1590', 'fixed_asset'],
  ['Credit Card', '2100', 'credit_card'], ['Payroll Liabilities', '2200', 'other_current_liability'], ['Loan Payable', '2500', 'long_term_liability'],
  ['Owner’s Investment', '3000', 'equity'], ['Owner’s Draw', '3100', 'equity'],
  ['Services', '4100', 'income'],
  ['Advertising & Marketing', '6000', 'expense'], ['Bank Charges & Fees', '6010', 'expense'], ['Car & Truck', '6020', 'expense'],
  ['Contractors', '6030', 'expense'], ['Depreciation', '6040', 'expense'], ['Insurance', '6050', 'expense'], ['Interest Paid', '6060', 'expense'],
  ['Legal & Professional Services', '6070', 'expense'], ['Meals', '6080', 'expense'], ['Office Supplies & Software', '6090', 'expense'],
  ['Rent & Lease', '6100', 'expense'], ['Repairs & Maintenance', '6110', 'expense'], ['Supplies & Materials', '6120', 'expense'],
  ['Taxes & Licenses', '6130', 'expense'], ['Travel', '6140', 'expense'], ['Utilities', '6150', 'expense'], ['Wages', '6160', 'expense'],
  ['Interest Earned', '7000', 'other_income'], ['Other Income', '7010', 'other_income'], ['Other Expenses', '8000', 'other_expense'],
];
export const STANDARD_TERMS = [['Due on receipt', 0], ['Net 15', 15], ['Net 30', 30], ['Net 60', 60]];

export async function listCompanies(db, { orgId }) {
  const { rows } = await db.query(
    `SELECT e.entity_id, e.name, e.time_zone, e.email, e.phone,
            (SELECT count(*)::int FROM customer c WHERE c.entity_id = e.entity_id) AS customers,
            (SELECT count(*)::int FROM vendor v WHERE v.entity_id = e.entity_id) AS vendors,
            (SELECT count(*)::int FROM txn t WHERE t.entity_id = e.entity_id) AS transactions
       FROM entity e WHERE e.org_id = $1 ORDER BY lower(e.name), e.entity_id`, [orgId]);
  return rows;
}

// Creates a company with a standard chart of accounts, its system accounts and payment terms. createCompanyIn runs inside the caller's
// transaction (Tax Books T2: the add-company form creates the company and its tax setup atomically, lib/tax/company-record.js).
export const createCompany = (pool, args) => withTransaction(pool, tx => createCompanyIn(tx, args));
export async function createCompanyIn(tx, { orgId, name, timeZone, email = '', phone = '', businessType = null }) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!n) fail('Give the company a name.');
  const tz = String(timeZone ?? '').trim() || 'America/Chicago';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { fail('Choose a valid time zone.'); }
  const type = BUSINESS_TYPES.some(([k]) => k === businessType) ? businessType : null;
  const dupe = await tx.query('SELECT 1 FROM entity WHERE org_id = $1 AND lower(name) = lower($2)', [orgId, n]);
  if (dupe.rowCount) fail(`A company named “${n}” already exists.`);
  const { rows: [e] } = await tx.query('INSERT INTO entity (org_id, name, time_zone, email, phone, business_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING entity_id',
    [orgId, n, tz, String(email ?? '').trim() || null, String(phone ?? '').trim() || null, type]);
  const entityId = e.entity_id;
  for (const [an, num, type2] of STANDARD_ACCOUNTS) {
    await tx.query('INSERT INTO account (org_id, entity_id, name, number, type) VALUES ($1, $2, $3, $4, $5)', [orgId, entityId, an, num, type2]);
  }
  await ensureSystemAccounts(tx, orgId, entityId);
  for (const [tn, days] of STANDARD_TERMS) await tx.query('INSERT INTO terms (org_id, entity_id, name, due_days) VALUES ($1, $2, $3, $4)', [orgId, entityId, tn, days]);
  return entityId;
}

// Which companies a person may open: all of them, or the chosen list (admins choose in Settings → Users).
export async function setUserCompanies(pool, { orgId, userId, all, entityIds = [] }) {
  return withTransaction(pool, async tx => {
    const user = await tx.query('SELECT 1 FROM app_user WHERE org_id = $1 AND user_id = $2 FOR UPDATE', [orgId, userId]);
    if (!user.rowCount) fail('User not found.');
    const { rows: own } = await tx.query('SELECT entity_id FROM entity WHERE org_id = $1 AND entity_id = ANY($2::bigint[])', [orgId, entityIds]);
    if (!all && !own.length) fail('Choose at least one company, or let them open all companies.');
    await tx.query('UPDATE app_user SET all_companies = $3 WHERE org_id = $1 AND user_id = $2', [orgId, userId, all === true]);
    await tx.query('DELETE FROM app_user_company WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
    if (!all) for (const r of own) await tx.query('INSERT INTO app_user_company (user_id, org_id, entity_id) VALUES ($1, $2, $3)', [userId, orgId, r.entity_id]);
  });
}

// A brand-new set of books: the organization (slug = APP_ORG) with its first company, which starts empty with the
// standard chart of accounts and terms above. More companies are added later in Settings → Companies.
export async function startBooks(pool, { slug, orgName, companyName, timeZone }) {
  const s = String(slug ?? '').trim();
  if (!/^[a-z0-9_]+$/.test(s)) fail('The org short name (APP_ORG) must be lowercase letters, digits and _.');
  const { rows: [have] } = await pool.query('SELECT org_id FROM org WHERE slug = $1', [s]);
  if (have) {
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM entity WHERE org_id = $1', [have.org_id]);
    if (n) fail(`The books “${s}” already exist with ${n} compan${n === 1 ? 'y' : 'ies'}. Add more in Settings → Companies.`);
  }
  const orgId = have?.org_id ?? (await pool.query('INSERT INTO org (slug, name) VALUES ($1, $2) RETURNING org_id',
    [s, String(orgName ?? '').trim() || String(companyName ?? '').trim() || s])).rows[0].org_id;
  const entityId = await createCompany(pool, { orgId, name: companyName, timeZone });
  return { orgId: Number(orgId), entityId: Number(entityId) };
}
