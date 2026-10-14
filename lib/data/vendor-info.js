import { createHash, randomBytes } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity, EMAIL } from './writes.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { validRouting, validBankAccount, validTaxId, masked, formatAddress } from '../domain/vendors.js';

// "Ask vendor for info": the vendor gets a single-use link to fill in their own details. Only the link's
// SHA-256 is stored; what they send is encrypted and waits for someone to accept it field by field.

const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
export const LINK_DAYS = 14;
const hash = token => createHash('sha256').update(token).digest('hex');

// The groups the reviewer can accept one by one.
export const INFO_FIELDS = [
  ['company', 'Company name'], ['checkName', 'Name to print on checks'], ['email', 'Email'], ['phone', 'Phone'], ['address', 'Address'],
  ['taxId', 'Tax ID'], ['bank', 'Bank account'],
];

export async function createInfoRequest(pool, { orgId, entityId, vendorId, actor, now = new Date() }) {
  const token = randomBytes(32).toString('base64url');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows: [v] } = await tx.query('SELECT display_name, email FROM vendor WHERE org_id = $1 AND entity_id = $2 AND vendor_id = $3', [orgId, entityId, vendorId]);
    if (!v) fail('Vendor not found.');
    await tx.query(`UPDATE vendor_info_request SET status = 'canceled', resolved_by = $3, resolved_at = now() WHERE org_id = $1 AND vendor_id = $2 AND status = 'sent'`,
      [orgId, vendorId, actor]);
    const { rows: [r] } = await tx.query(
      `INSERT INTO vendor_info_request (org_id, entity_id, vendor_id, token_hash, sent_to, requested_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING request_id`,
      [orgId, entityId, vendorId, hash(token), v.email, actor, new Date(now.getTime() + LINK_DAYS * 86_400_000)]);
    await logActivity(tx, { orgId, vendorId, actor, kind: 'info_requested', summary: `Asked ${v.display_name} to fill in their details (link good for ${LINK_DAYS} days)` });
    return { token, requestId: r.request_id, vendor: v };
  });
}

// The open request behind a link, or null if it's unknown, used, canceled or expired.
export async function findOpenRequest(db, { token, now = new Date() }) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token ?? ''))) return null;
  const { rows: [r] } = await db.query(
    `SELECT r.*, v.display_name AS vendor_name, e.name AS entity_name FROM vendor_info_request r
       JOIN vendor v ON v.vendor_id = r.vendor_id JOIN entity e ON e.entity_id = r.entity_id
      WHERE r.token_hash = $1 AND r.status = 'sent' AND r.expires_at > $2`, [hash(token), now]);
  return r ?? null;
}

// fields from the public form. Everything is optional, but whatever is filled in must be valid.
export function cleanSubmission(f) {
  const out = {};
  const company = text(f.company, 100); if (company) out.company = company;
  const checkName = text(f.checkName, 100); if (checkName) out.checkName = checkName;
  const email = text(f.email, 200);
  if (email) { if (!EMAIL.test(email)) fail('Enter a valid email address.'); out.email = email; }
  const phone = text(f.phone, 40); if (phone) out.phone = phone;
  const address = { line1: text(f.line1, 200), line2: text(f.line2, 200), city: text(f.city, 100), state: text(f.state, 50), postal: text(f.postal, 20) };
  if (Object.values(address).some(Boolean)) {
    if (!address.line1 || !address.city || !address.state || !address.postal) fail('Fill in the street, city, state and ZIP code.');
    out.address = address;
  }
  if (String(f.taxId ?? '').trim()) out.taxId = validTaxId(f.taxId) ?? fail('Enter a 9-digit EIN (12-3456789) or SSN (123-45-6789).');
  if (String(f.bankRouting ?? '').trim() || String(f.bankAccount ?? '').trim()) {
    const routing = validRouting(f.bankRouting) ?? fail('Enter a valid 9-digit routing number.');
    const account = validBankAccount(f.bankAccount) ?? fail('Enter the account number (4 to 17 digits).');
    if (String(f.bankAccount2 ?? '').replace(/[\s-]/g, '') !== account) fail('The two account numbers don’t match.');
    out.bank = { routing, account };
  }
  if (!Object.keys(out).length) fail('Fill in at least one thing before sending.');
  return out;
}

export async function submitInfoRequest(pool, { token, fields, key, now = new Date() }) {
  if (!key) fail('This form can’t accept details right now. Please contact the business directly.');
  const clean = cleanSubmission(fields);
  return withTransaction(pool, async tx => {
    const r = await findOpenRequest(tx, { token, now });
    if (!r) fail('This link has already been used or has expired.');
    const { rowCount } = await tx.query(
      `UPDATE vendor_info_request SET status = 'submitted', submitted_at = now(), submission_enc = $2 WHERE request_id = $1 AND status = 'sent'`,
      [r.request_id, encryptSecret(key, JSON.stringify(clean))]);
    if (!rowCount) fail('This link has already been used.');
    await logActivity(tx, { orgId: r.org_id, vendorId: r.vendor_id, actor: r.vendor_name, kind: 'info_submitted',
      summary: `${r.vendor_name} sent their details for review` });
    return r;
  });
}

export async function latestRequest(db, { orgId, vendorId }) {
  const { rows: [r] } = await db.query(
    `SELECT request_id, status, created_at, expires_at, submitted_at, sent_to FROM vendor_info_request
      WHERE org_id = $1 AND vendor_id = $2 AND status IN ('sent', 'submitted') ORDER BY created_at DESC LIMIT 1`, [orgId, vendorId]);
  return r ?? null;
}

// The submitted values next to what's on file now (secrets masked both sides), for review.
export async function reviewRequest(db, { orgId, entityId, requestId, key }) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, v.* , r.status AS request_status FROM vendor_info_request r JOIN vendor v ON v.vendor_id = r.vendor_id
      WHERE r.org_id = $1 AND r.entity_id = $2 AND r.request_id = $3`, [orgId, entityId, requestId]);
  if (!r) return null;
  let sent = null;
  if (r.submission_enc && key) {
    try { sent = JSON.parse(decryptSecret(key, r.submission_enc)); } catch { sent = null; }
  }
  const now = {
    company: r.company_name, checkName: r.check_name, email: r.email, phone: r.phone, address: formatAddress(r.billing_address),
    taxId: r.tax_id_last4 ? masked(r.tax_id_last4) : null, bank: r.bank_account_last4 ? masked(r.bank_account_last4) : null,
  };
  const shown = sent && {
    ...sent, address: sent.address ? formatAddress(sent.address) : undefined,
    taxId: sent.taxId ? masked(sent.taxId.replace(/\D/g, '').slice(-4)) : undefined,
    bank: sent.bank ? `${masked(sent.bank.account.slice(-4))} (routing ${sent.bank.routing})` : undefined,
  };
  return { request: { request_id: r.request_id, status: r.request_status, submitted_at: r.submitted_at, vendor_id: r.vendor_id, display_name: r.display_name },
    now, sent: shown, raw: sent };
}

// Applies the chosen groups to the vendor (secrets re-encrypted under the same key) and closes the request.
export async function resolveRequest(pool, { orgId, entityId, requestId, accept = [], dismiss = false, key, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const review = await reviewRequest(tx, { orgId, entityId, requestId, key });
    if (!review || review.request.status !== 'submitted') fail('There’s nothing waiting to be reviewed.');
    const vendorId = review.request.vendor_id;
    if (dismiss) {
      await tx.query(`UPDATE vendor_info_request SET status = 'dismissed', resolved_by = $2, resolved_at = now(), submission_enc = submission_enc WHERE request_id = $1`, [requestId, actor]);
      await logActivity(tx, { orgId, vendorId, actor, kind: 'info_dismissed', summary: 'Details the vendor sent were dismissed without changes' });
      return [];
    }
    const s = review.raw ?? fail('The submission can’t be read (is SETTINGS_KEY set?).');
    const take = INFO_FIELDS.map(([k]) => k).filter(k => accept.includes(k) && s[k] !== undefined);
    if (!take.length) fail('Tick at least one thing to accept, or dismiss the submission.');
    const set = [], vals = [];
    const put = (col, v) => { vals.push(v); set.push(`${col} = $${vals.length + 2}`); };
    if (take.includes('company')) put('company_name', s.company);
    if (take.includes('checkName')) put('check_name', s.checkName);
    if (take.includes('email')) put('email', s.email);
    if (take.includes('phone')) put('phone', s.phone);
    if (take.includes('address')) put('billing_address', { ...s.address });
    if (take.includes('taxId')) { put('tax_id_enc', encryptSecret(key, s.taxId)); put('tax_id_last4', s.taxId.replace(/\D/g, '').slice(-4)); }
    if (take.includes('bank')) {
      put('bank_routing_enc', encryptSecret(key, s.bank.routing)); put('bank_account_enc', encryptSecret(key, s.bank.account));
      put('bank_account_last4', s.bank.account.slice(-4));
      put('bank_changed_at', new Date());
      put('bank_verified', false);
    }
    await tx.query(`UPDATE vendor SET ${set.join(', ')} WHERE org_id = $1 AND vendor_id = $2`, [orgId, vendorId, ...vals]);
    await tx.query(`UPDATE vendor_info_request SET status = 'accepted', resolved_by = $2, resolved_at = now() WHERE request_id = $1`, [requestId, actor]);
    const labels = Object.fromEntries(INFO_FIELDS);
    await logActivity(tx, { orgId, vendorId, actor, kind: 'info_accepted', summary: `Accepted the vendor’s ${take.map(k => labels[k].toLowerCase()).join(', ')}`
      + (take.includes('bank') ? ' · bank details need verifying before the next payment' : '') });
    return take;
  });
}
