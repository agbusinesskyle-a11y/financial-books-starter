import { formId } from '../domain/ids.js';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity, EMAIL } from './writes.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { parseMoney } from '../domain/money.js';
import { validRouting, validBankAccount, validTaxId, VENDOR_CHARGE_TYPES } from '../domain/vendors.js';
import { parseCsv, headerKey } from '../domain/csv.js';
import { setPartyCurrency } from './currencies.js';
import { addDays } from '../domain/dates.js';

const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
const CHARGES = VENDOR_CHARGE_TYPES.map(t => `'${t}'`).join(', ');

// Open balance and overdue, per vendor, as of `today`: everything that sits in A/P for them — bills and item receipts
// still owed, less unused vendor credits and unapplied bill payments — so it always equals the A/P account and reports.
const AP_CHARGES = "'bill', 'item_receipt'", AP_CREDITS = "'vendor_credit', 'bill_payment'";
const BALANCES = today => `
  coalesce((SELECT sum(CASE WHEN t.type IN (${AP_CHARGES}) THEN t.open_cents ELSE -t.open_cents END) FROM txn t
             WHERE t.org_id = v.org_id AND t.vendor_id = v.vendor_id AND t.voided_at IS NULL AND t.type IN (${AP_CHARGES}, ${AP_CREDITS})), 0)::bigint AS open_cents,
  coalesce((SELECT sum(t.open_cents) FROM txn t
             WHERE t.org_id = v.org_id AND t.vendor_id = v.vendor_id AND t.voided_at IS NULL AND t.type IN (${AP_CHARGES})
               AND t.due_date < '${today}'::date), 0)::bigint AS overdue_cents`;

const SORTS = { name: 'lower(r.display_name)', company: 'lower(coalesce(r.company_name, r.display_name))', balance: 'r.open_cents' };
export const PAGE_SIZES = [50, 75, 100, 150, 300];
// Summary-bar filters: which vendors to list.
const SHOWS = {
  overdue: 'overdue_cents > 0',
  open: 'open_cents > 0',
  paid: `EXISTS (SELECT 1 FROM txn p WHERE p.org_id = r.org_id AND p.vendor_id = r.vendor_id AND p.type = 'bill_payment' AND p.voided_at IS NULL AND p.txn_date >= $TODAY30)`,
  po: `EXISTS (SELECT 1 FROM txn p WHERE p.org_id = r.org_id AND p.vendor_id = r.vendor_id AND p.type = 'purchase_order' AND p.voided_at IS NULL AND p.open_cents > 0)`,
};

export async function listVendors(db, { orgId, entityId, today, search = '', sort = 'name', dir = 'asc', includeInactive = false, show = '', page = 1, pageSize = 50 }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('today must be YYYY-MM-DD');
  const params = [orgId, entityId];
  const where = ['v.org_id = $1', 'v.entity_id = $2'];
  if (!includeInactive) where.push('v.active');
  const q = String(search).trim();
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`);
    where.push(`(v.display_name ILIKE $${params.length} OR v.company_name ILIKE $${params.length} OR v.email ILIKE $${params.length} OR v.phone ILIKE $${params.length})`);
  }
  const showSql = SHOWS[show] ? `WHERE ${SHOWS[show].replace('$TODAY30', `'${addDays(today, -30)}'::date`)}` : '';
  const order = `${SORTS[sort] ?? SORTS.name} ${dir === 'desc' ? 'DESC' : 'ASC'}, lower(r.display_name)`;
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 50;
  const { rows } = await db.query(
    `SELECT *, count(*) OVER ()::int AS total_rows FROM (
       SELECT v.org_id, v.vendor_id, v.display_name, v.company_name, v.email, v.phone, v.mobile, v.other_phone, v.billing_address, v.track_1099,
              v.bank_account_last4, v.active, (SELECT count(*)::int FROM document d WHERE d.org_id = v.org_id AND d.vendor_id = v.vendor_id) AS documents,
              ${BALANCES(today)}
         FROM vendor v WHERE ${where.join(' AND ')}) r
      ${showSql}
      ORDER BY ${order}
      LIMIT ${size} OFFSET ${(Math.max(1, Number(page) || 1) - 1) * size}`, params);
  return { rows, total: rows[0]?.total_rows ?? 0, pageSize: size };
}

// Colored totals across the top of the vendor list.
export async function vendorSummaryBar(db, { orgId, entityId, today }) {
  const { rows: [r] } = await db.query(
    `SELECT
       count(*) FILTER (WHERE type = 'purchase_order' AND open_cents > 0 AND txn_date >= $3::date - 365)::int AS po_count,
       coalesce(sum(open_cents) FILTER (WHERE type = 'purchase_order' AND open_cents > 0 AND txn_date >= $3::date - 365), 0)::bigint AS po_cents,
       count(*) FILTER (WHERE type IN (${CHARGES}) AND open_cents > 0 AND due_date < $3::date)::int AS overdue_count,
       coalesce(sum(open_cents) FILTER (WHERE type IN (${CHARGES}) AND open_cents > 0 AND due_date < $3::date), 0)::bigint AS overdue_cents,
       count(*) FILTER (WHERE type IN (${CHARGES}) AND open_cents > 0)::int AS open_count,
       coalesce(sum(open_cents) FILTER (WHERE type IN (${CHARGES}) AND open_cents > 0), 0)::bigint AS open_cents,
       count(*) FILTER (WHERE type = 'bill_payment' AND txn_date >= $3::date - 30)::int AS paid_count,
       coalesce(sum(total_cents) FILTER (WHERE type = 'bill_payment' AND txn_date >= $3::date - 30), 0)::bigint AS paid_cents
     FROM txn WHERE org_id = $1 AND entity_id = $2 AND vendor_id IS NOT NULL AND voided_at IS NULL`, [orgId, entityId, today]);
  return r;
}

export async function getVendor(db, { orgId, entityId, vendorId, today }) {
  const { rows: [v] } = await db.query(
    `SELECT v.*, tm.name AS terms_name, a.name AS default_expense_account_name, ${BALANCES(today)}
       FROM vendor v LEFT JOIN terms tm ON tm.org_id = v.org_id AND tm.terms_id = v.terms_id
       LEFT JOIN account a ON a.account_id = v.default_expense_account_id
      WHERE v.org_id = $1 AND v.entity_id = $2 AND v.vendor_id = $3`, [orgId, entityId, vendorId]);
  return v ?? null;
}

// The routing number back in clear (it's printed on every check, so it's shown in full like QBO does).
export function vendorRouting(v, key) {
  if (!v.bank_routing_enc || !key) return null;
  try { return decryptSecret(key, v.bank_routing_enc); } catch { return null; }
}

// fields: form strings/booleans (see vendorFormValues). key: SETTINGS_KEY bytes (null if not configured).
// Blank bank/tax fields keep what's saved; clearBank / clearTaxId remove it.
export async function saveVendor(pool, { orgId, entityId, vendorId = null, fields: f, key, actor, afterCreate = null }) {
  const displayName = text(f.displayName, 100);
  if (!displayName) fail('Enter a vendor display name.');
  const email = text(f.email, 200);
  if (email && !EMAIL.test(email)) fail('Enter a valid email address.');
  for (const [label, val] of [['Cc', f.cc], ['Bcc', f.bcc]]) {
    const list = String(val ?? '').split(/[,;]\s*/).map(s => s.trim()).filter(Boolean);
    if (list.some(e => !EMAIL.test(e))) fail(`${label}: enter email addresses separated by commas.`);
  }
  const website = text(f.website, 200);
  if (website && !/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(website)) fail('Enter a website like example.com.');
  let rate = null;
  if (String(f.billingRate ?? '').trim()) {
    rate = parseMoney(String(f.billingRate).trim());
    if (rate === null) fail('Billing rate should be an amount like 45.00.');
  }
  const address = { line1: text(f.line1, 200), line2: text(f.line2, 200), city: text(f.city, 100), state: text(f.state, 50), postal: text(f.postal, 20), country: text(f.country, 60) };
  const billing = Object.values(address).some(Boolean) ? address : null;

  // Secrets: validate whatever was typed; encrypt only with a key.
  const routingText = String(f.bankRouting ?? '').trim(), accountText = String(f.bankAccount ?? '').trim(), taxText = String(f.taxId ?? '').trim();
  let bank = null, tax = null;
  if (routingText || accountText) {
    const routing = validRouting(routingText) ?? fail('Enter a valid 9-digit routing number.');
    const acct = validBankAccount(accountText) ?? fail('Enter the bank account number (4 to 17 digits).');
    if (!key) fail('Saving bank details needs SETTINGS_KEY set on the server.');
    bank = { routing: encryptSecret(key, routing), account: encryptSecret(key, acct), last4: acct.slice(-4) };
  }
  if (taxText) {
    const id = validTaxId(taxText) ?? fail('Enter a 9-digit EIN (12-3456789) or SSN (123-45-6789).');
    if (!key) fail('Saving a tax ID needs SETTINGS_KEY set on the server.');
    tax = { enc: encryptSecret(key, id), last4: id.replace(/\D/g, '').slice(-4) };
  }

  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const termsId = formId(f.termsId, () => fail('One of the choices isn’t valid. Reload the page and try again.'));
    if (termsId !== null && !(await tx.query('SELECT 1 FROM terms WHERE org_id = $1 AND terms_id = $2 AND entity_id = $3', [orgId, termsId, entityId])).rowCount) fail('Choose valid terms.');
    const accountId = formId(f.defaultExpenseAccountId, () => fail('One of the choices isn’t valid. Reload the page and try again.'));
    if (accountId !== null) {
      const a = await tx.query(`SELECT 1 FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active
                                  AND type IN ('expense', 'other_expense', 'cost_of_goods_sold', 'fixed_asset', 'other_asset', 'other_current_asset', 'inventory')`,
        [orgId, entityId, accountId]);
      if (!a.rowCount) fail('Choose an expense or asset account as the default category.');
    }
    let existing = null;
    if (vendorId) {
      existing = (await tx.query('SELECT * FROM vendor WHERE org_id = $1 AND entity_id = $2 AND vendor_id = $3 FOR UPDATE', [orgId, entityId, vendorId])).rows[0]
        ?? fail('Vendor not found.');
    }
    const keepBank = !bank && !f.clearBank && existing;
    const keepTax = !tax && !f.clearTaxId && existing;
    const values = [displayName, text(f.companyName, 100), text(f.title, 20), text(f.firstName, 60), text(f.middleName, 60), text(f.lastName, 60),
      text(f.suffix, 20), email, text(f.cc, 300), text(f.bcc, 300), text(f.phone, 40), text(f.mobile, 40), text(f.fax, 40), text(f.otherPhone, 40),
      website, text(f.checkName, 100), billing, text(f.notes, 2000), termsId, text(f.accountNo, 50), accountId, rate, f.track1099 === true,
      keepTax ? existing.tax_id_enc : tax?.enc ?? null, keepTax ? existing.tax_id_last4 : tax?.last4 ?? null,
      keepBank ? existing.bank_routing_enc : bank?.routing ?? null, keepBank ? existing.bank_account_enc : bank?.account ?? null,
      keepBank ? existing.bank_account_last4 : bank?.last4 ?? null, existing ? f.active !== false : true,
      keepBank ? existing.bank_verified : true, keepBank ? existing.bank_changed_at : (bank ? new Date() : null)];
    const cols = ['display_name', 'company_name', 'title', 'first_name', 'middle_name', 'last_name', 'suffix', 'email', 'cc', 'bcc', 'phone', 'mobile', 'fax',
      'other_phone', 'website', 'check_name', 'billing_address', 'notes', 'terms_id', 'account_no', 'default_expense_account_id', 'billing_rate_cents',
      'track_1099', 'tax_id_enc', 'tax_id_last4', 'bank_routing_enc', 'bank_account_enc', 'bank_account_last4', 'active', 'bank_verified', 'bank_changed_at'];
    try {
      if (existing) {
        await tx.query(`UPDATE vendor SET ${cols.map((c, i) => `${c} = $${i + 4}`).join(', ')} WHERE org_id = $1 AND entity_id = $2 AND vendor_id = $3`,
          [orgId, entityId, vendorId, ...values]);
      } else {
        vendorId = (await tx.query(`INSERT INTO vendor (org_id, entity_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING vendor_id`,
          [orgId, entityId, ...values])).rows[0].vendor_id;
      }
    } catch (error) {
      if (error?.code === '23505') fail(`A vendor named “${displayName}” already exists.`);
      throw error;
    }
    if (f.currency !== undefined) await setPartyCurrency(tx, { orgId, entityId, table: 'vendor', id: vendorId, code: f.currency });
    const changed = [];
    if (bank) changed.push('bank details');
    if (f.clearBank && existing?.bank_account_enc) changed.push('bank details removed');
    if (tax) changed.push('tax ID');
    if (f.clearTaxId && existing?.tax_id_enc) changed.push('tax ID removed');
    if (existing && existing.active !== (f.active !== false)) changed.push(f.active !== false ? 'made active' : 'made inactive');
    await logActivity(tx, { orgId, vendorId, actor, kind: existing ? 'vendor_updated' : 'vendor_created',
      summary: existing ? `Vendor details updated${changed.length ? ` (${changed.join(', ')})` : ''}` : `Vendor ${displayName} created` });
    if (!existing && afterCreate) await afterCreate(tx, vendorId);
    return vendorId;
  });
}

export async function markBankVerified(pool, { orgId, entityId, vendorId, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rowCount } = await tx.query('UPDATE vendor SET bank_verified = true WHERE org_id = $1 AND entity_id = $2 AND vendor_id = $3 AND NOT bank_verified',
      [orgId, entityId, vendorId]);
    if (rowCount) await logActivity(tx, { orgId, vendorId, actor, kind: 'bank_verified', summary: `Bank details confirmed by ${actor}` });
  });
}

export async function setVendorsActive(pool, { orgId, entityId, vendorIds, active, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows } = await tx.query(
      'UPDATE vendor SET active = $4 WHERE org_id = $1 AND entity_id = $2 AND vendor_id = ANY($3) AND active <> $4 RETURNING vendor_id, display_name',
      [orgId, entityId, vendorIds, active]);
    for (const r of rows) await logActivity(tx, { orgId, vendorId: r.vendor_id, actor, kind: 'vendor_updated', summary: `Vendor made ${active ? 'active' : 'inactive'}` });
    return rows.length;
  });
}

// Moves everything from `fromId` onto `intoId`, then deletes `fromId`. Returns counts for the message.
export async function mergeVendors(pool, { orgId, entityId, fromId, intoId, actor }) {
  if (fromId === intoId) fail('Choose a different vendor to merge into.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const both = (await tx.query('SELECT vendor_id, display_name, currency FROM vendor WHERE org_id = $1 AND entity_id = $2 AND vendor_id = ANY($3) FOR UPDATE',
      [orgId, entityId, [fromId, intoId]])).rows;
    const from = both.find(v => v.vendor_id === fromId) ?? fail('Vendor not found.');
    const into = both.find(v => v.vendor_id === intoId) ?? fail('Choose the vendor to keep.');
    if ((from.currency ?? null) !== (into.currency ?? null)) fail('Both vendors must use the same currency to be merged.');
    const clash = await tx.query(
      `SELECT a.name FROM recurring_template a JOIN recurring_template b ON b.name = a.name AND b.vendor_id = $3
        WHERE a.org_id = $1 AND a.vendor_id = $2 LIMIT 1`, [orgId, fromId, intoId]);
    if (clash.rowCount) fail(`Both vendors have a recurring transaction named “${clash.rows[0].name}”. Rename or delete one first.`);
    const dupe = await tx.query(
      `SELECT a.doc_number FROM txn a JOIN txn b ON b.org_id = a.org_id AND b.vendor_id = $3 AND b.type = a.type AND b.doc_number = a.doc_number
        WHERE a.org_id = $1 AND a.vendor_id = $2 AND a.type = 'vendor_credit' AND a.doc_number IS NOT NULL LIMIT 1`, [orgId, fromId, intoId]);
    // Only vendor credit numbers must be unique per vendor; bills may repeat a number (as QBO), e.g. two "Opening balance" bills.
    if (dupe.rowCount) fail(`Both vendors have a vendor credit numbered ${dupe.rows[0].doc_number}. Change one of the numbers first.`);
    // An open "ask for info" link was for the other vendor's record; it stops working.
    await tx.query(`UPDATE vendor_info_request SET status = 'canceled', resolved_by = $3, resolved_at = now() WHERE org_id = $1 AND vendor_id = $2 AND status IN ('sent', 'submitted')`,
      [orgId, fromId, actor]);
    const moved = {};
    for (const [table, key] of [['txn', 'transactions'], ['document', 'documents'], ['message', 'messages'], ['activity_event', 'history']]) {
      moved[key] = (await tx.query(`UPDATE ${table} SET vendor_id = $3 WHERE org_id = $1 AND vendor_id = $2`, [orgId, fromId, intoId])).rowCount;
    }
    for (const [table] of await mergeHooks(tx)) await tx.query(`UPDATE ${table} SET vendor_id = $3 WHERE org_id = $1 AND vendor_id = $2`, [orgId, fromId, intoId]);
    await tx.query('DELETE FROM vendor WHERE org_id = $1 AND vendor_id = $2', [orgId, fromId]);
    await logActivity(tx, { orgId, vendorId: intoId, actor, kind: 'vendor_merged',
      summary: `${from.display_name} merged into ${into.display_name}: ${moved.transactions} transaction${moved.transactions === 1 ? '' : 's'}, ${moved.documents} document${moved.documents === 1 ? '' : 's'} moved` });
    return { from, into, moved };
  });
}

// Other tables that carry a vendor_id (added by later stages) are moved too.
async function mergeHooks(tx) {
  const { rows } = await tx.query(
    `SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'vendor_id'
        AND table_name NOT IN ('vendor', 'txn', 'document', 'message', 'activity_event')`);
  return rows.map(r => [r.table_name]);
}

export async function mergeCounts(db, { orgId, vendorId }) {
  const { rows: [r] } = await db.query(
    `SELECT (SELECT count(*)::int FROM txn WHERE org_id = $1 AND vendor_id = $2) AS transactions,
            (SELECT count(*)::int FROM document WHERE org_id = $1 AND vendor_id = $2) AS documents`, [orgId, vendorId]);
  return r;
}

export async function listVendorActivity(db, { orgId, vendorId, limit = 200 }) {
  const { rows } = await db.query(
    `SELECT event_id, kind, summary, actor, occurred_at, txn_id FROM activity_event WHERE org_id = $1 AND vendor_id = $2
      ORDER BY occurred_at DESC, event_id DESC LIMIT $3`, [orgId, vendorId, limit]);
  return rows;
}

export async function vendorChoices(db, { orgId, entityId, includeInactive = false }) {
  const { rows } = await db.query(
    `SELECT vendor_id, display_name, email, active FROM vendor WHERE org_id = $1 AND entity_id = $2 ${includeInactive ? '' : 'AND active'} ORDER BY lower(display_name)`,
    [orgId, entityId]);
  return rows;
}

// ---- CSV import ----

const IMPORT_COLUMNS = {
  displayName: ['name', 'vendor', 'displayname', 'vendorname', 'vendordisplayname'],
  companyName: ['company', 'companyname'],
  email: ['email', 'emailaddress'],
  phone: ['phone', 'phonenumber'],
  mobile: ['mobile', 'cell', 'mobilenumber'],
  fax: ['fax'],
  website: ['website', 'web'],
  line1: ['street', 'address', 'street1', 'streetaddress', 'streetaddress1', 'address1'],
  line2: ['street2', 'streetaddress2', 'address2'],
  city: ['city'],
  state: ['state', 'province'],
  postal: ['zip', 'zipcode', 'postal', 'postalcode'],
  country: ['country'],
  terms: ['terms'],
  accountNo: ['accountno', 'accountnumber', 'account'],
  track1099: ['1099', 'track1099', '1099tracking', 'trackpaymentsfor1099'],
  notes: ['notes', 'note'],
  checkName: ['nameoncheck', 'printoncheckas', 'checkname', 'nametoprintonchecks'],
};
export const IMPORT_HEADERS = ['Name', 'Company', 'Email', 'Phone', 'Mobile', 'Street', 'City', 'State', 'ZIP', 'Terms', 'Account no', '1099', 'Notes'];
const YES = new Set(['yes', 'y', 'true', '1', 'x']);

// Parses and checks a CSV without saving. Returns { rows: [{ line, values, error }], unknownHeaders }.
export async function previewVendorImport(db, { orgId, entityId, csv }) {
  let table;
  try { table = parseCsv(csv); } catch (error) { fail(`That file isn’t valid CSV: ${error.message}`); }
  if (table.length < 2) fail('The file needs a header row and at least one vendor.');
  if (table.length > 1001) fail('Import up to 1,000 vendors at a time.');
  const header = table[0].map(headerKey);
  const index = {};
  const unknownHeaders = [];
  header.forEach((h, i) => {
    const field = Object.keys(IMPORT_COLUMNS).find(k => IMPORT_COLUMNS[k].includes(h));
    if (field && index[field] === undefined) index[field] = i; else if (!field && h) unknownHeaders.push(table[0][i]);
  });
  if (index.displayName === undefined) fail('The file needs a “Name” column.');
  const terms = new Map((await db.query('SELECT terms_id, name FROM terms WHERE org_id = $1 AND entity_id = $2', [orgId, entityId])).rows.map(t => [t.name.toLowerCase(), t.terms_id]));
  const taken = new Set((await db.query('SELECT lower(display_name) AS n FROM vendor WHERE org_id = $1 AND entity_id = $2', [orgId, entityId])).rows.map(r => r.n));
  const seen = new Set();
  const rows = table.slice(1).map((cells, i) => {
    const get = k => (index[k] === undefined ? '' : String(cells[index[k]] ?? '').trim());
    const values = Object.fromEntries(Object.keys(IMPORT_COLUMNS).map(k => [k, get(k)]));
    let error = null;
    const name = values.displayName.toLowerCase();
    if (!values.displayName) error = 'No name.';
    else if (values.displayName.length > 100) error = 'Name is longer than 100 characters.';
    else if (taken.has(name)) error = 'A vendor with this name already exists.';
    else if (seen.has(name)) error = 'This name appears twice in the file.';
    else if (values.email && !EMAIL.test(values.email)) error = `“${values.email}” isn’t an email address.`;
    else if (values.terms && !terms.has(values.terms.toLowerCase())) error = `No terms called “${values.terms}”. Add them in Settings → Terms first.`;
    seen.add(name);
    values.termsId = values.terms ? terms.get(values.terms.toLowerCase()) ?? null : null;
    values.track1099 = YES.has(values.track1099.toLowerCase());
    return { line: i + 2, values, error };
  });
  return { rows, unknownHeaders };
}

// Saves every row without an error, in one transaction. Returns { created, skipped }.
export async function importVendors(pool, { orgId, entityId, csv, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows } = await previewVendorImport(tx, { orgId, entityId, csv });
    const good = rows.filter(r => !r.error);
    if (!good.length) fail('None of the rows can be imported. Fix the errors shown and try again.');
    for (const { values: v } of good) {
      const address = { line1: text(v.line1, 200), line2: text(v.line2, 200), city: text(v.city, 100), state: text(v.state, 50), postal: text(v.postal, 20), country: text(v.country, 60) };
      const { rows: [r] } = await tx.query(
        `INSERT INTO vendor (org_id, entity_id, display_name, company_name, email, phone, mobile, fax, website, billing_address, terms_id, account_no,
           track_1099, notes, check_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING vendor_id`,
        [orgId, entityId, v.displayName, text(v.companyName, 100), text(v.email, 200), text(v.phone, 40), text(v.mobile, 40), text(v.fax, 40),
          text(v.website, 200), Object.values(address).some(Boolean) ? address : null, v.termsId, text(v.accountNo, 50), v.track1099,
          text(v.notes, 2000), text(v.checkName, 100)]);
      await logActivity(tx, { orgId, vendorId: r.vendor_id, actor, kind: 'vendor_created', summary: `Vendor ${v.displayName} imported` });
    }
    return { created: good.length, skipped: rows.length - good.length };
  });
}

