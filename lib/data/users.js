import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { withTransaction } from '../db.js';
import { ValidationError, EMAIL } from './writes.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { makeTotp } from '../auth.js';
import { isRole, ROLE_LABELS } from '../domain/roles.js';

// People who sign in (Settings → Users). The break-glass owner login from the environment is not a row here.

const fail = message => { throw new ValidationError(message); };
const hash = token => createHash('sha256').update(token).digest('hex');
const INVITE_DAYS = 7;
const BCRYPT_ROUNDS = 11;
export const MIN_PASSWORD = 12;
// Compared against when the email matches nobody, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not a real password', BCRYPT_ROUNDS);

const STATUS_SQL = `CASE WHEN NOT u.active THEN 'inactive' WHEN u.password_hash IS NOT NULL THEN 'active'
  WHEN EXISTS (SELECT 1 FROM user_invite i WHERE i.user_id = u.user_id AND i.used_at IS NULL AND i.expires_at > $2) THEN 'invited'
  ELSE 'invite_expired' END`;

export async function listUsers(pool, { orgId, now = new Date() }) {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.name, u.email, u.role, u.can_approve_bills, u.active, u.created_at, u.last_login_at, u.invited_by, ${STATUS_SQL} AS status
       FROM app_user u WHERE u.org_id = $1 ORDER BY u.active DESC, lower(u.name)`, [orgId, now]);
  return rows;
}

export async function getUser(db, { orgId, userId, now = new Date() }) {
  const { rows } = await db.query(
    `SELECT u.*, ${STATUS_SQL} AS status,
       (SELECT max(i.expires_at) FROM user_invite i WHERE i.user_id = u.user_id AND i.used_at IS NULL) AS invite_expires_at
       FROM app_user u WHERE u.org_id = $1 AND u.user_id = $3`, [orgId, now, userId]);
  return rows[0] ?? null;
}

function userFields(f) {
  const name = String(f.name ?? '').trim().slice(0, 100);
  const email = String(f.email ?? '').trim().slice(0, 200);
  if (!name) fail('Enter the person’s name.');
  if (!EMAIL.test(email)) fail('Enter a valid email address. It’s what they sign in with.');
  if (!isRole(f.role)) fail('Choose a role.');
  return { name, email, role: f.role, canApproveBills: f.canApproveBills === true || f.canApproveBills === '1' };
}

const duplicateEmail = error => error.code === '23505' && /app_user_email/.test(error.constraint ?? '');

// Admins that can actually sign in, other than `exceptUserId`.
async function otherAdmins(tx, orgId, exceptUserId) {
  await tx.query('SELECT user_id FROM app_user WHERE org_id = $1 FOR UPDATE', [orgId]);
  const { rows } = await tx.query(
    `SELECT count(*)::int AS n FROM app_user WHERE org_id = $1 AND user_id <> $2 AND active AND role = 'admin' AND password_hash IS NOT NULL`,
    [orgId, exceptUserId]);
  return rows[0].n;
}
const lastAdminMessage = name => `${name} is the last active admin. Make someone else an admin first.`;

// Creates the person (not yet able to sign in) and their first invite link. Returns { userId, token }.
export async function inviteUser(pool, { orgId, fields, actor, key, now = new Date() }) {
  if (!key) fail('The server has no SETTINGS_KEY, so authenticators can’t be stored safely. Add SETTINGS_KEY first.');
  const f = userFields(fields);
  try {
    return await withTransaction(pool, async tx => {
      const { rows: [u] } = await tx.query(
        `INSERT INTO app_user (org_id, name, email, role, can_approve_bills, invited_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING user_id`,
        [orgId, f.name, f.email, f.role, f.canApproveBills, actor]);
      return { userId: u.user_id, token: await newInvite(tx, { orgId, userId: u.user_id, actor, now }) };
    });
  } catch (error) {
    if (duplicateEmail(error)) fail(`Someone already signs in as ${f.email}.`);
    throw error;
  }
}

async function newInvite(tx, { orgId, userId, actor, now }) {
  const token = randomBytes(32).toString('base64url');
  await tx.query('DELETE FROM user_invite WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL', [orgId, userId]);
  await tx.query('INSERT INTO user_invite (org_id, user_id, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4,$5)',
    [orgId, userId, hash(token), new Date(now.getTime() + INVITE_DAYS * 86_400_000), actor]);
  return token;
}

// A fresh link for someone who hasn't finished setting up (the old link stops working).
export async function resendInvite(pool, { orgId, userId, actor, key, now = new Date() }) {
  if (!key) fail('The server has no SETTINGS_KEY, so authenticators can’t be stored safely. Add SETTINGS_KEY first.');
  return withTransaction(pool, async tx => {
    const u = await getUser(tx, { orgId, userId, now }) ?? fail('User not found.');
    if (!u.active) fail(`${u.name} is inactive. Make them active first.`);
    if (u.password_hash) fail(`${u.name} has already set up their sign-in. Use “Reset sign-in” to send a new link.`);
    return newInvite(tx, { orgId, userId, actor, now });
  });
}

// Their password and authenticator stop working at once (sessions end too); a new link lets them set new ones.
export async function resetSignIn(pool, { orgId, userId, actor, key, now = new Date() }) {
  if (!key) fail('The server has no SETTINGS_KEY, so authenticators can’t be stored safely. Add SETTINGS_KEY first.');
  return withTransaction(pool, async tx => {
    const u = await getUser(tx, { orgId, userId, now }) ?? fail('User not found.');
    if (!u.active) fail(`${u.name} is inactive. Make them active first.`);
    await tx.query(
      `UPDATE app_user SET password_hash = NULL, totp_enc = NULL, last_totp_counter = -1, signin_version = signin_version + 1
        WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    return newInvite(tx, { orgId, userId, actor, now });
  });
}

export async function updateUser(pool, { orgId, userId, fields, selfId = null }) {
  const f = userFields(fields);
  try {
    await withTransaction(pool, async tx => {
      const u = await getUser(tx, { orgId, userId }) ?? fail('User not found.');
      if (u.role === 'admin' && f.role !== 'admin') {
        if (userId === selfId) fail('You can’t take admin away from yourself. Ask another admin.');
        if (u.active && (await otherAdmins(tx, orgId, userId)) === 0) fail(lastAdminMessage(u.name));
      }
      await tx.query('UPDATE app_user SET name = $3, email = $4, role = $5, can_approve_bills = $6 WHERE org_id = $1 AND user_id = $2',
        [orgId, userId, f.name, f.email, f.role, f.canApproveBills]);
    });
  } catch (error) {
    if (duplicateEmail(error)) fail(`Someone already signs in as ${f.email}.`);
    throw error;
  }
}

export async function setUserActive(pool, { orgId, userId, active, selfId = null }) {
  return withTransaction(pool, async tx => {
    const u = await getUser(tx, { orgId, userId }) ?? fail('User not found.');
    if (!active) {
      if (userId === selfId) fail('You can’t make yourself inactive.');
      if (u.role === 'admin' && (await otherAdmins(tx, orgId, userId)) === 0) fail(lastAdminMessage(u.name));
      await tx.query('DELETE FROM user_invite WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL', [orgId, userId]);
    }
    // Making someone inactive ends their sessions for good (reactivating doesn't bring old sessions back).
    await tx.query(`UPDATE app_user SET active = $3, signin_version = signin_version + CASE WHEN $3 THEN 0 ELSE 1 END WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId, active]);
    return u.name;
  });
}

// ---- the invite link (public page, no sign-in) ----

// orgSlug: the organization this app serves — an invitation from another organization sharing the database doesn't open here.
export async function findOpenInvite(db, { token, now = new Date(), orgSlug = null }) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token ?? ''))) return null;
  const { rows: [r] } = await db.query(
    `SELECT i.*, u.name, u.email, u.role, u.active,
       (SELECT e.name FROM entity e WHERE e.org_id = u.org_id ORDER BY e.entity_id LIMIT 1) AS entity_name
       FROM user_invite i JOIN app_user u ON u.user_id = i.user_id
      WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > $2 AND u.active
        AND ($3::text IS NULL OR u.org_id = (SELECT org_id FROM org WHERE slug = $3))`, [hash(token), now, orgSlug]);
  return r ?? null;
}

// The authenticator secret this link will set up (created on first view, then the same on every reload).
export async function pendingSecret(pool, { invite, key }) {
  if (invite.totp_pending_enc) return decryptSecret(key, invite.totp_pending_enc);
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const { rows } = await pool.query(
    `UPDATE user_invite SET totp_pending_enc = $2 WHERE invite_id = $1 AND totp_pending_enc IS NULL RETURNING invite_id`,
    [invite.invite_id, encryptSecret(key, secret)]);
  if (rows.length) return secret;
  const again = await pool.query('SELECT totp_pending_enc FROM user_invite WHERE invite_id = $1', [invite.invite_id]);
  return decryptSecret(key, again.rows[0].totp_pending_enc);
}

export const otpauthUri = (secret, email) =>
  new OTPAuth.TOTP({ issuer: 'Financial Books', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).toString();

// The TOTP time step a code belongs to, or null if it's wrong.
function codeCounter(secret, code, nowMs) {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const delta = makeTotp(secret).validate({ token: clean, timestamp: nowMs, window: 1 });
  return delta === null ? null : Math.floor(nowMs / 30000) + delta;
}

// Sets the password and authenticator from an invite link. Returns { userId, version, name }.
export async function completeInvite(pool, { token, password, password2, code, key, now = new Date() }) {
  const pw = String(password ?? '');
  if (pw.length < MIN_PASSWORD) fail(`Use at least ${MIN_PASSWORD} characters for the password.`);
  if (pw.length > 200) fail('That password is too long (200 characters at most).');
  if (pw !== String(password2 ?? '')) fail('The two passwords don’t match.');
  const passwordHash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
  return withTransaction(pool, async tx => {
    if (/^[A-Za-z0-9_-]{43}$/.test(String(token ?? ''))) await tx.query('SELECT 1 FROM user_invite WHERE token_hash = $1 FOR UPDATE', [hash(token)]);
    const invite = await findOpenInvite(tx, { token, now }) ?? fail('This link isn’t active any more.');
    if (!invite.totp_pending_enc) fail('Reload the page to get your authenticator code.');
    const secretEnc = invite.totp_pending_enc;
    const counter = codeCounter(decryptSecret(key, secretEnc), code, now.getTime());
    if (counter === null) fail('That authenticator code isn’t right. Check the app shows “Financial Books” and try the newest code.');
    const { rows: [u] } = await tx.query(
      `UPDATE app_user SET password_hash = $3, totp_enc = $4, last_totp_counter = $5, last_login_at = $6
        WHERE org_id = $1 AND user_id = $2 RETURNING user_id, name, signin_version`,
      [invite.org_id, invite.user_id, passwordHash, secretEnc, counter, now]);
    await tx.query('UPDATE user_invite SET used_at = $2 WHERE invite_id = $1', [invite.invite_id, now]);
    return { userId: u.user_id, version: u.signin_version, name: u.name };
  });
}

// ---- signing in ----

// Checks an email + password + authenticator code. Returns { userId, version } or null. A code works once.
export async function checkSignIn(pool, { orgSlug, email, password, code, key, now = new Date() }) {
  const { rows: [u] } = await pool.query(
    `SELECT u.user_id, u.password_hash, u.totp_enc FROM app_user u JOIN org o ON o.org_id = u.org_id
      WHERE o.slug = $1 AND lower(u.email) = lower($2) AND u.active AND u.password_hash IS NOT NULL`, [orgSlug, String(email ?? '').trim()]);
  const passwordOk = await bcrypt.compare(String(password ?? ''), u?.password_hash ?? DUMMY_HASH);
  if (!u || !passwordOk || !key) return null;
  let secret;
  try { secret = decryptSecret(key, u.totp_enc); } catch { return null; }
  const counter = codeCounter(secret, code, now.getTime());
  if (counter === null) return null;
  const { rows } = await pool.query(
    `UPDATE app_user SET last_totp_counter = $2, last_login_at = $3 WHERE user_id = $1 AND last_totp_counter < $2 AND active
     RETURNING signin_version`, [u.user_id, counter, now]);
  return rows.length ? { userId: u.user_id, version: rows[0].signin_version } : null;
}

// The signed-in person for a session, or null once they're deactivated or their sign-in was reset.
export async function sessionUser(pool, { userId, version }) {
  const { rows: [u] } = await pool.query(
    `SELECT u.user_id, u.org_id, u.name, u.email, u.role, u.can_approve_bills, u.signin_version, u.all_companies,
            coalesce((SELECT array_agg(c.entity_id) FROM app_user_company c WHERE c.user_id = u.user_id), '{}') AS company_ids
       FROM app_user u WHERE u.user_id = $1 AND u.active AND u.password_hash IS NOT NULL`,
    [userId]);
  if (!u || u.signin_version !== version) return null;
  return { userId: u.user_id, orgId: u.org_id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABELS[u.role], canApproveBills: u.can_approve_bills,
    allCompanies: u.all_companies, companyIds: u.company_ids.map(Number) };
}
