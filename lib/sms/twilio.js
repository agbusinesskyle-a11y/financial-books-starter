import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError } from '../data/writes.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { withSecurityWrite } from '../data/morning/locks.js';

// Twilio for text-a-receipt (stage B8): each organization connects its own Twilio account and number. Incoming texts
// arrive at POST /twilio/sms and are trusted only with a valid X-Twilio-Signature (HMAC-SHA1 of the full URL plus the
// form fields sorted by name, keyed by the account's auth token). Replies go back as TwiML; follow-ups (a receipt that
// matched later) use Twilio's Messages API.

const fail = message => { throw new ValidationError(message); };
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

// "(202) 555-0109" / "202-555-0109" / "+1 202 555 0109" → "+12025550109" (US numbers without a country code).
export function normalPhone(text) {
  const t = String(text ?? '').trim();
  const digits = t.replace(/\D/g, '');
  if (t.startsWith('+')) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function twilioSignature(authToken, url, params) {
  const data = url + [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + v).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}
export function validSignature(authToken, url, params, header) {
  const want = Buffer.from(twilioSignature(authToken, url, params)), got = Buffer.from(String(header ?? ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

const xml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
export const twiml = text => `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${xml(text)}</Message>` : ''}</Response>`;

// ---- settings ----

export async function getSmsSettings(db, { orgId }) {
  const { rows: [s] } = await db.query('SELECT * FROM sms_settings WHERE org_id = $1', [orgId]);
  return { enabled: s?.enabled ?? false, accountSid: s?.account_sid ?? '', phone: s?.phone ?? '', hasToken: Boolean(s?.auth_token_enc), tokenEnc: s?.auth_token_enc ?? null,
    updatedBy: s?.updated_by ?? null, updatedAt: s?.updated_at ?? null };
}

export async function saveSmsSettings(pool, { orgId, enabled, accountSid, authToken = '', phone, key, actor }) {
  const sid = String(accountSid ?? '').trim();
  if (sid && !/^AC[0-9a-f]{32}$/.test(sid)) fail('The Account SID starts with AC followed by 32 letters and numbers.');
  const number = String(phone ?? '').trim() ? normalPhone(phone) : null;
  if (String(phone ?? '').trim() && !number) fail('Enter the Twilio number like +1 202 555 0100.');
  const token = String(authToken ?? '').trim();
  if (token && !/^[0-9a-f]{32}$/.test(token)) fail('The auth token is 32 letters and numbers.');
  if (token && !key) fail('Saving the auth token needs SETTINGS_KEY set on the server.');
  return withSecurityWrite(pool, { orgId }, async tx => {
    const current = await getSmsSettings(tx, { orgId });
    const enc = token ? encryptSecret(key, token) : current.tokenEnc;
    if (enabled && (!sid || !number || !enc)) fail('To turn text receipts on, enter the Account SID, auth token and Twilio number.');
    if (number) {
      const taken = await tx.query('SELECT 1 FROM sms_settings WHERE phone = $1 AND org_id <> $2', [number, orgId]);
      if (taken.rowCount) fail('That Twilio number is already connected to another account.');
    }
    await tx.query(`INSERT INTO sms_settings (org_id, enabled, account_sid, auth_token_enc, phone, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, account_sid = EXCLUDED.account_sid, auth_token_enc = EXCLUDED.auth_token_enc,
        phone = EXCLUDED.phone, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, Boolean(enabled), sid || null, enc, number, actor]);
  });
}

// The organization a text was sent to (by the Twilio number it arrived on), with its auth token for the signature check.
export async function settingsForNumber(db, { to, key }) {
  const number = normalPhone(to);
  if (!number) return null;
  const { rows: [s] } = await db.query('SELECT * FROM sms_settings WHERE phone = $1 AND enabled', [number]);
  if (!s || !s.auth_token_enc || !key) return null;
  return { orgId: Number(s.org_id), accountSid: s.account_sid, phone: s.phone, authToken: decryptSecret(key, s.auth_token_enc) };
}

// ---- approved senders and nicknames ----

export async function listSenders(db, { orgId }) {
  const { rows } = await db.query(`SELECT s.*, coalesce((SELECT array_agg(c.entity_id ORDER BY c.entity_id) FROM sms_sender_company c WHERE c.sender_id = s.sender_id), '{}') AS company_ids
    FROM sms_sender s WHERE s.org_id = $1 ORDER BY lower(s.name), s.sender_id`, [orgId]);
  return rows.map(r => ({ ...r, company_ids: r.company_ids.map(Number) }));
}

export async function saveSender(pool, { orgId, senderId = null, name, phone, allCompanies = true, entityIds = [], active = true, actor }) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!n) fail('Enter the person’s name.');
  const number = normalPhone(phone) ?? fail('Enter their mobile number like (202) 555-0109.');
  return withTransaction(pool, async tx => {
    const { rows: own } = await tx.query('SELECT entity_id FROM entity WHERE org_id = $1 AND entity_id = ANY($2::bigint[])', [orgId, entityIds.map(Number)]);
    if (!allCompanies && !own.length) fail('Choose at least one company they can text receipts for.');
    const dupe = await tx.query('SELECT 1 FROM sms_sender WHERE org_id = $1 AND phone = $2 AND sender_id <> coalesce($3, 0)', [orgId, number, senderId]);
    if (dupe.rowCount) fail('That number is already approved.');
    let id = senderId;
    if (id) {
      const { rowCount } = await tx.query('UPDATE sms_sender SET name = $3, phone = $4, all_companies = $5, active = $6 WHERE org_id = $1 AND sender_id = $2',
        [orgId, id, n, number, Boolean(allCompanies), Boolean(active)]);
      if (!rowCount) fail('Sender not found.');
    } else {
      id = (await tx.query('INSERT INTO sms_sender (org_id, phone, name, all_companies, active, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING sender_id',
        [orgId, number, n, Boolean(allCompanies), Boolean(active), actor])).rows[0].sender_id;
    }
    await tx.query('DELETE FROM sms_sender_company WHERE org_id = $1 AND sender_id = $2', [orgId, id]);
    if (!allCompanies) for (const r of own) await tx.query('INSERT INTO sms_sender_company (org_id, sender_id, entity_id) VALUES ($1, $2, $3)', [orgId, id, r.entity_id]);
    return Number(id);
  });
}

export async function deleteSender(pool, { orgId, senderId }) {
  const { rowCount } = await pool.query('DELETE FROM sms_sender WHERE org_id = $1 AND sender_id = $2', [orgId, Number(senderId) || 0]);
  if (!rowCount) fail('Sender not found.');
}

// The companies a sender may text for: [{ entityId, name, nicknames }].
export async function senderCompanies(db, { orgId, sender }) {
  const { rows } = await db.query(`SELECT e.entity_id, e.name, coalesce((SELECT array_agg(n.nickname ORDER BY n.nickname) FROM company_nickname n WHERE n.entity_id = e.entity_id), '{}') AS nicknames
    FROM entity e WHERE e.org_id = $1 AND ($2 OR e.entity_id IN (SELECT entity_id FROM sms_sender_company WHERE sender_id = $3)) ORDER BY lower(e.name)`,
  [orgId, sender.all_companies, sender.sender_id]);
  return rows.map(r => ({ entityId: Number(r.entity_id), name: r.name, nicknames: r.nicknames }));
}

// Comma-separated nicknames per company.
export async function saveNicknames(pool, { orgId, byEntity }) {
  return withTransaction(pool, async tx => {
    const seen = new Map();
    for (const [entityId, text] of Object.entries(byEntity)) {
      const list = [...new Set(String(text ?? '').split(',').map(s => s.replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean))];
      for (const n of list) {
        if (seen.has(n.toLowerCase()) && seen.get(n.toLowerCase()) !== entityId) fail(`“${n}” is used for two companies.`);
        seen.set(n.toLowerCase(), entityId);
      }
      const own = await tx.query('SELECT 1 FROM entity WHERE org_id = $1 AND entity_id = $2', [orgId, Number(entityId)]);
      if (!own.rowCount) fail('Company not found.');
      await tx.query('DELETE FROM company_nickname WHERE org_id = $1 AND entity_id = $2', [orgId, Number(entityId)]);
      for (const n of list) await tx.query('INSERT INTO company_nickname (org_id, entity_id, nickname) VALUES ($1, $2, $3)', [orgId, Number(entityId), n]);
    }
  });
}

// Which company a text names: a nickname or company name in the message (small typos allowed), among the sender's.
export function companyFromText(text, companies) {
  const words = ` ${String(text ?? '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const hits = new Set();
  for (const c of companies) {
    for (const label of [c.name, ...c.nicknames]) {
      const l = String(label).toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!l) continue;
      if (words.includes(` ${l} `)) { hits.add(c.entityId); continue; }
      // One typo in a name of five letters or more ("Sample Fead").
      if (l.length >= 5) {
        const n = l.split(' ').length;
        const toks = words.trim().split(' ');
        for (let i = 0; i + n <= toks.length; i++) if (close(toks.slice(i, i + n).join(' '), l)) hits.add(c.entityId);
      }
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}
function close(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] <= 1;
}

// ---- Twilio's servers ----

// The photo attached to a text (Twilio's media URLs need the account's credentials).
export async function fetchMedia({ url, accountSid, authToken, fetchImpl = globalThis.fetch }) {
  if (!/^https:\/\/api\.twilio\.com\//.test(String(url))) fail('The picture didn’t come from Twilio.');
  const res = await fetchImpl(url, { headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` }, redirect: 'follow',
    signal: AbortSignal.timeout(30_000) });
  if (!res.ok) fail('The picture couldn’t be downloaded from Twilio.');
  const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!MEDIA_TYPES.has(type)) fail('Send a photo (JPEG or PNG) or a PDF of the receipt.');
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length || data.length > MAX_MEDIA_BYTES) fail('The picture is too large (10 MB at most).');
  return { contentType: type, data };
}

export async function sendSms({ accountSid, authToken, from, to, body, fetchImpl = globalThis.fetch, signal }) {
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: String(body).slice(0, 1500) }).toString(), signal: signal ?? AbortSignal.timeout(30_000) });
  try { await res.body?.cancel(); } catch {}
  if (!res.ok) { const error=new Error(`Twilio didn’t send the text (HTTP ${res.status}).`);error.httpStatus=res.status;throw error; }
  return { status: 'sent' };
}
