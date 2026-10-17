import { ValidationError, EMAIL, lockEntity } from './writes.js';
import { withTransaction } from '../db.js';
import { isPractice } from '../domain/practice.js';
import { isDemo } from '../domain/demo.js';
import { settingsKey, encryptSecret, decryptSecret } from '../secrets.js';
import { createLogMailer, createSmtpMailer } from '../mail/index.js';

const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;

// ---- Company (the entity: name and contact details printed on PDFs and emails) ----

export const BUSINESS_TYPES = [
  ['sole_proprietor', 'Sole proprietor'], ['partnership', 'Partnership'], ['llc', 'LLC'], ['s_corp', 'S corporation'],
  ['c_corp', 'C corporation'], ['nonprofit', 'Nonprofit'], ['other', 'Other'],
];

export async function getCompany(pool, { orgId, entityId }) {
  const { rows } = await pool.query(
    `SELECT entity_id, name, email, phone, address, time_zone, legal_name, ein_last4, ein_enc IS NOT NULL AS has_ein, business_type, website,
            customer_email, customer_address, logo_type, logo IS NOT NULL AS has_logo
       FROM entity WHERE org_id = $1 AND entity_id = $2`, [orgId, entityId]);
  return rows[0] ?? null;
}

// What customers see on PDFs and emails: the customer-facing email and address, falling back to the company ones.
export async function customerFacing(pool, { orgId, entityId }) {
  const c = await getCompany(pool, { orgId, entityId });
  return c && { name: c.name, legalName: c.legal_name, email: c.customer_email ?? c.email, phone: c.phone,
    address: c.customer_address ?? c.address, website: c.website, hasLogo: c.has_logo };
}

const addressOf = (f, prefix = '') => {
  const a = { line1: text(f[`${prefix}line1`], 200), city: text(f[`${prefix}city`], 100), state: text(f[`${prefix}state`], 50), postal: text(f[`${prefix}postal`], 20) };
  return Object.values(a).some(Boolean) ? a : null;
};

// fields: name, email, phone, line1..postal, legalName, ein (blank keeps the saved one), clearEin, businessType, website,
// customerEmail, c_line1..c_postal (customer-facing address).
// Inside the caller's transaction when given its client (Settings → Company saves the company and its tax setup together), else in its own.
export async function saveCompany(db, args) {
  return typeof db.release === 'function' ? saveCompanyIn(db, args) : withTransaction(db, tx => saveCompanyIn(tx, args));
}
async function saveCompanyIn(pool, { orgId, entityId, fields: f, env = process.env }) {
  const name = text(f.name, 100);
  if (!name) fail('Enter the company name.');
  const email = text(f.email, 200);
  if (email && !EMAIL.test(email)) fail('Enter a valid company email address.');
  const customerEmail = text(f.customerEmail, 200);
  if (customerEmail && !EMAIL.test(customerEmail)) fail('Enter a valid customer-facing email address, or leave it blank.');
  let website = text(f.website, 200);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  if (website && !/^https?:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/\S*)?$/.test(website)) fail('The website should look like www.example.com.');
  const businessType = BUSINESS_TYPES.some(([k]) => k === f.businessType) ? f.businessType : null;
  const einText = String(f.ein ?? '').replace(/[\s-]/g, '');
  let einEnc, einLast4;
  if (einText) {
    if (!/^\d{9}$/.test(einText)) fail('The EIN or SSN is 9 digits, like 12-3456789.');
    const key = settingsKey(env);
    if (!key) fail('The server has no SETTINGS_KEY, so it can’t store a tax ID safely. Add SETTINGS_KEY first.');
    einEnc = encryptSecret(key, einText);
    einLast4 = einText.slice(-4);
  }
  const clearEin = f.clearEin === '1' && !einText;
  // Tax Books T2 (Codex t2-plan-r3 R3-N4, r4 R4-N3): while this company's party has an open EIN conflict, its candidates stay as recorded —
  // an admin settles the conflict on the Tax setup page first (an edit, even of the same digits, would re-encrypt and strand the evidence).
  // The company row is locked BEFORE the party is looked at, the same lock reconcileOwnCompanyTaxIds and resolveOwnTaxIdConflict take
  // (FOR UPDATE of the entity row), held to commit: an edit that wins is the candidate reconciliation then records; a reconciliation that
  // wins makes the edit refuse.
  if (einText || clearEin) {
    // Only READ COMMITTED rereads the party after waiting for the lock (Codex t2-r1 non-blocking 1): a caller's REPEATABLE READ or
    // SERIALIZABLE snapshot could miss a conflict a reconciliation committed meanwhile and strand its evidence.
    const { rows: [iso] } = await pool.query(`SELECT current_setting('transaction_isolation') AS level`);
    if (iso.level !== 'read committed') fail('Change the EIN in a READ COMMITTED transaction: a snapshot transaction cannot see a reconciliation committed while it waited.');
    await lockEntity(pool, orgId, entityId);
    const { rowCount: open } = await pool.query(`SELECT 1 FROM tax_party WHERE org_id = $1 AND entity_id = $2 AND own_tax_id_state = 'conflict'`, [orgId, entityId]);
    if (open) fail('This company’s EIN differs from the one on its tax party: settle that on the Tax setup page (Parties) before changing the EIN here.');
  }
  const { rowCount } = await pool.query(
    `UPDATE entity SET name = $3, email = $4, phone = $5, address = $6, legal_name = $7, business_type = $8, website = $9,
            customer_email = $10, customer_address = $11,
            ein_enc = CASE WHEN $12::text IS NOT NULL THEN $12 WHEN $14 THEN NULL ELSE ein_enc END,
            ein_last4 = CASE WHEN $12::text IS NOT NULL THEN $13 WHEN $14 THEN NULL ELSE ein_last4 END
      WHERE org_id = $1 AND entity_id = $2`,
    [orgId, entityId, name, email, text(f.phone, 40), addressOf(f), text(f.legalName, 200), businessType, website,
      customerEmail, addressOf(f, 'c_'), einEnc ?? null, einLast4 ?? null, clearEin]);
  if (!rowCount) fail('Company not found.');
}

export const MAX_LOGO_BYTES = 1024 * 1024;

// PNG or JPEG up to 1 MB, checked by its first bytes (not the file name).
export async function saveLogo(pool, { orgId, entityId, file }) {
  if (!file || !file.data?.length) fail('Choose a PNG or JPEG file.');
  if (file.data.length > MAX_LOGO_BYTES) fail('The logo is over 1 MB. Use a smaller image.');
  const d = file.data;
  const type = d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47 ? 'image/png'
    : d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff ? 'image/jpeg' : null;
  if (!type) fail('The logo must be a PNG or JPEG image.');
  await pool.query('UPDATE entity SET logo = $3, logo_type = $4 WHERE org_id = $1 AND entity_id = $2', [orgId, entityId, d, type]);
}

export async function removeLogo(pool, { orgId, entityId }) {
  await pool.query('UPDATE entity SET logo = NULL, logo_type = NULL WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
}

export async function getLogo(pool, { orgId, entityId }) {
  const { rows } = await pool.query('SELECT logo, logo_type FROM entity WHERE org_id = $1 AND entity_id = $2 AND logo IS NOT NULL', [orgId, entityId]);
  return rows[0] ? { data: rows[0].logo, type: rows[0].logo_type } : null;
}

// ---- Email ----

const SECURITY = ['starttls', 'tls'];

// Settings as the form shows them. The password itself never leaves this module; `hasPassword` says whether one is saved.
export async function getEmailSettings(pool, { orgId, entityId }) {
  const { rows } = await pool.query('SELECT * FROM email_settings WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  const r = rows[0];
  if (!r) return { mode: 'record', fromName: null, fromEmail: null, replyTo: null, host: null, port: 587, security: 'starttls', user: null, hasPassword: false, lastTest: null };
  return {
    mode: r.mode, fromName: r.from_name, fromEmail: r.from_email, replyTo: r.reply_to, host: r.smtp_host, port: r.smtp_port ?? 587,
    security: r.smtp_security, user: r.smtp_user, hasPassword: Boolean(r.smtp_password_enc),
    lastTest: r.last_test_at ? { at: r.last_test_at, ok: r.last_test_ok, error: r.last_test_error } : null,
  };
}

// fields: { mode, fromName, fromEmail, replyTo, host, port, security, user, password } (strings).
// A blank password keeps the saved one. Saving clears the last test result.
export async function saveEmailSettings(pool, { orgId, entityId, fields: f, env = process.env }) {
  const mode = f.mode === 'smtp' ? 'smtp' : 'record';
  const fromName = text(f.fromName, 100);
  const fromEmail = text(f.fromEmail, 200);
  const replyTo = text(f.replyTo, 200);
  if (fromEmail && !EMAIL.test(fromEmail)) fail('Enter a valid “send from” email address.');
  if (replyTo && !EMAIL.test(replyTo)) fail('Enter a valid reply-to address, or leave it blank.');
  const host = text(f.host, 200);
  if (host && !/^[A-Za-z0-9.-]+$/.test(host)) fail('The mail server should look like smtp.gmail.com.');
  const portText = text(f.port, 5);
  const port = portText === null ? null : Number(portText);
  if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) fail('The port is a number like 587 or 465.');
  const security = SECURITY.includes(f.security) ? f.security : 'starttls';
  const user = text(f.user, 200);
  const password = String(f.password ?? '');
  if (mode === 'smtp') {
    if (!fromEmail) fail('Enter the address to send from.');
    if (!host) fail('Enter your mail server, like smtp.gmail.com.');
    if (port === null) fail('Enter the mail server port, usually 587.');
  }
  let passwordEnc;
  if (password) {
    const key = settingsKey(env);
    if (!key) fail('The server has no SETTINGS_KEY, so it can’t store a password safely. Add SETTINGS_KEY to the server environment first.');
    passwordEnc = encryptSecret(key, password);
  }
  await pool.query(
    `INSERT INTO email_settings (org_id, entity_id, mode, from_name, from_email, reply_to, smtp_host, smtp_port, smtp_security, smtp_user, smtp_password_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (org_id, entity_id) DO UPDATE SET mode = $3, from_name = $4, from_email = $5, reply_to = $6, smtp_host = $7, smtp_port = $8,
       smtp_security = $9, smtp_user = $10,
       -- A new server or login never gets the old password: it has to be typed again.
       smtp_password_enc = CASE WHEN $11::text IS NOT NULL THEN $11
                                WHEN email_settings.smtp_host IS NOT DISTINCT FROM $7 AND email_settings.smtp_user IS NOT DISTINCT FROM $10 THEN email_settings.smtp_password_enc
                                ELSE NULL END,
       last_test_at = NULL, last_test_ok = NULL, last_test_error = NULL, updated_at = now()`,
    [orgId, entityId, mode, fromName, fromEmail, replyTo, host, port, security, user, passwordEnc ?? null]);
}

export async function recordEmailTest(pool, { orgId, entityId, ok, error = null }) {
  await pool.query(
    'UPDATE email_settings SET last_test_at = now(), last_test_ok = $3, last_test_error = $4 WHERE org_id = $1 AND entity_id = $2',
    [orgId, entityId, ok, error ? String(error).slice(0, 500) : null]);
}

// The mailer this company's sends go through: SMTP when set up, otherwise record-only.
export async function mailerFor(pool, { orgId, entityId, env = process.env, makeTransport }) {
  const { rows } = await pool.query('SELECT * FROM email_settings WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  const r = rows[0];
  // A practice copy never emails a customer or vendor: QuickBooks is still sending the real ones. Nor does the public demo.
  if (!r || r.mode !== 'smtp' || isPractice(env) || isDemo(env)) return createLogMailer({ fromName: r?.from_name, fromEmail: r?.from_email, env });
  let password;
  if (r.smtp_password_enc) {
    const key = settingsKey(env);
    if (!key) throw new ValidationError('Email can’t be sent: the server’s SETTINGS_KEY is missing, so the saved mail password can’t be read.');
    try { password = decryptSecret(key, r.smtp_password_enc); } catch {
      throw new ValidationError('Email can’t be sent: the saved mail password can’t be read with this SETTINGS_KEY. Re-enter it in Settings → Email.');
    }
  }
  return createSmtpMailer({ fromName: r.from_name, fromEmail: r.from_email, replyTo: r.reply_to, host: r.smtp_host, port: r.smtp_port,
    security: r.smtp_security, user: r.smtp_user, password }, makeTransport ? { makeTransport } : {});
}
