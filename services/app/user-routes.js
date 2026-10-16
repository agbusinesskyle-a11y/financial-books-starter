import { listCompanies, setUserCompanies } from '../../lib/data/companies.js';
import { randomBytes } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { HttpError, tooMany, clientIp } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import {
  listUsers, getUser, inviteUser, resendInvite, resetSignIn, updateUser, setUserActive, findOpenInvite, pendingSecret, otpauthUri, completeInvite,
} from '../../lib/data/users.js';
import { getCompany, saveCompany, saveLogo, removeLogo, getLogo } from '../../lib/data/settings.js';
import { settingsKey } from '../../lib/secrets.js';
import { companySettingsPage, companyToValues, companyFormValues } from '../../lib/views/settings.js';
import { usersPage, usersBody, userFormBody, userToValues, userFormValues, NEW_USER_VALUES, inviteSentBody, inviteSetupPage } from '../../lib/views/users.js';
import { publicMessage } from '../../lib/views/vendor-auto.js';

export const COMPANY_UPLOAD_PATH = /^\/settings\/company\/logo$/;

// Settings → Users and Settings → Company, and the company logo. h: the request helpers from index.js.
export async function userRoutes(h) {
  const { req, path, query, form, files, ctx, scope, pool, env, page, base, go, takeFlash, actor, who, send, res, extra, companyMailer, owner } = h;
  const key = () => settingsKey(env);
  const selfId = who.userId;

  if (path === '/company/logo' && req.method === 'GET') {
    const logo = await getLogo(pool, scope);
    if (!logo) throw new HttpError(404, 'No logo');
    send(res, 200, logo.data, { ...extra, 'Content-Type': logo.type, 'Cache-Control': 'private, max-age=60' });
    return true;
  }

  // ---- company ----
  if (path === '/settings/company' || path.startsWith('/settings/company/')) {
    const company = await getCompany(pool, scope);
    const show = (more = {}, status = 200) =>
      page(companySettingsPage({ ...base(), company, hasKey: Boolean(key()), v: more.v ?? companyToValues(company), ...more }), status);
    if (path === '/settings/company' && req.method === 'GET') { show({ flash: takeFlash() }); return true; }
    if (path === '/settings/company' && req.method === 'POST') {
      const v = companyFormValues(form);
      try {
        await saveCompany(pool, { ...scope, fields: v, env });
        go('/settings/company', 'ok', 'Company details saved.');
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        show({ v: { ...v, ein: '' }, error: error.message }, 422);
      }
      return true;
    }
    if (path === '/settings/company/logo' && req.method === 'POST') {
      try {
        await saveLogo(pool, { ...scope, file: files.find(f => f.field === 'logo') });
        go('/settings/company', 'ok', 'Logo saved.');
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        show({ logoError: error.message }, 422);
      }
      return true;
    }
    if (path === '/settings/company/logo/delete' && req.method === 'POST') {
      await removeLogo(pool, scope);
      go('/settings/company', 'ok', 'Logo removed.');
      return true;
    }
    throw new HttpError(404, 'Not found');
  }

  // ---- users ----
  if (!path.startsWith('/settings/users')) return false;
  if (!ctx.orgAdmin) throw new HttpError(403, 'Only an admin who can open every company manages users.');
  const shell = (body, status = 200, flash = null) => page(usersPage({ ...base(), flash, body }), status);
  const origin = env.APP_BASE_URL ? env.APP_BASE_URL.replace(/\/$/, '') : `http://${req.headers.host ?? '127.0.0.1'}`;

  // Emails the link through the company's Settings → Email; the page also shows it once to copy.
  async function sendLink(user, token, why) {
    const link = `${origin}/invite/${token}`;
    let mailer = null, status = 'failed';
    try { mailer = await companyMailer(); } catch (error) { if (!(error instanceof ValidationError)) throw error; }
    if (mailer) {
      try {
        status = (await mailer.send({ to: user.email, subject: `${why} — ${ctx.entityName} on Financial Books`,
          text: [`Hi ${user.name},`, '', `${actor} ${why === 'You’re invited' ? 'invited you to' : 'reset your sign-in for'} ${ctx.entityName}’s books.`,
            'Open this link to set your password and connect an authenticator app (it works once and expires in 7 days):', '', link, '',
            'If you weren’t expecting this, ignore this email.'].join('\n') })).status;
      } catch { status = 'failed'; }
    }
    shell(inviteSentBody({ user, link, status }));
  }

  if (path === '/settings/users' && req.method === 'GET') {
    shell(usersBody({ users: await listUsers(pool, { orgId: ctx.orgId }), owner, timeZone: ctx.timeZone }), 200, takeFlash());
    return true;
  }
  if (path === '/settings/users/new' && req.method === 'GET') {
    shell(userFormBody({ csrf: base().csrf, v: NEW_USER_VALUES, timeZone: ctx.timeZone, selfId, companies: await listCompanies(pool, { orgId: ctx.orgId }),
      forAccountant: query.for === 'accountant' }));
    return true;
  }
  if (path === '/settings/users' && req.method === 'POST') {
    const v = userFormValues(form);
    try {
      if (!v.allCompanies && !v.companyIds.length) throw new ValidationError('Choose at least one company, or let them open all companies.');
      const { userId, token } = await inviteUser(pool, { orgId: ctx.orgId, fields: v, actor, key: key() });
      await setUserCompanies(pool, { orgId: ctx.orgId, userId, all: v.allCompanies, entityIds: v.companyIds });
      await sendLink(await getUser(pool, { orgId: ctx.orgId, userId }), token, 'You’re invited');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      shell(userFormBody({ csrf: base().csrf, v, error: error.message, timeZone: ctx.timeZone, selfId, companies: await listCompanies(pool, { orgId: ctx.orgId }) }), 422);
    }
    return true;
  }
  const m = /^\/settings\/users\/(\d{1,18})(\/resend|\/reset|\/deactivate|\/activate)?$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const userId = Number(m[1]);
  const user = await getUser(pool, { orgId: ctx.orgId, userId }) ?? (() => { throw new HttpError(404, 'User not found'); })();
  const back = `/settings/users/${userId}`;
  const showUser = async (v, error = null, status = 200) =>
    shell(userFormBody({ csrf: base().csrf, user: await getUser(pool, { orgId: ctx.orgId, userId }), v, error, timeZone: ctx.timeZone, selfId,
      companies: await listCompanies(pool, { orgId: ctx.orgId }) }), status, error ? null : takeFlash());
  const companyIdsOf = async id => (await pool.query('SELECT entity_id FROM app_user_company WHERE user_id = $1', [id])).rows.map(r => Number(r.entity_id));
  if (req.method === 'GET' && !m[2]) { await showUser({ ...userToValues(user), companyIds: await companyIdsOf(userId) }); return true; }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  try {
    switch (m[2]) {
      case undefined:
        {
          const v = userFormValues(form);
          if (!v.allCompanies && !v.companyIds.length) throw new ValidationError('Choose at least one company, or let them open all companies.');
          await updateUser(pool, { orgId: ctx.orgId, userId, fields: v, selfId });
          await setUserCompanies(pool, { orgId: ctx.orgId, userId, all: v.allCompanies, entityIds: v.companyIds });
        }
        go(back, 'ok', 'Saved.');
        return true;
      case '/resend':
        await sendLink(user, await resendInvite(pool, { orgId: ctx.orgId, userId, actor, key: key() }), 'You’re invited');
        return true;
      case '/reset':
        await sendLink(user, await resetSignIn(pool, { orgId: ctx.orgId, userId, actor, key: key() }), 'Set up your sign-in again');
        return true;
      case '/deactivate':
      case '/activate': {
        const active = m[2] === '/activate';
        await setUserActive(pool, { orgId: ctx.orgId, userId, active, selfId });
        go(back, 'ok', `${user.name} is now ${active ? 'active' : 'inactive'}.`);
        return true;
      }
      default: throw new HttpError(404, 'Not found');
    }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    if (m[2]) { go(back, 'error', error.message); return true; }
    await showUser(userFormValues(form), error.message, 422);
    return true;
  }
}

// ---- the public page an invited person opens (no sign-in) ----

const NONCE_COOKIE = 'fb_invite';

export async function publicInvite({ req, res, path, pool, env, send, readForm, auth, now, orgSlug }) {
  const secure = /^https:/.test(env.APP_BASE_URL ?? '');
  const m = /^\/invite\/([A-Za-z0-9_-]{1,100})$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const token = m[1];
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  const key = settingsKey(env);
  const invite = await findOpenInvite(pool, { token, now: now(), orgSlug });
  if (!invite || !key) {
    send(res, 404, String(publicMessage({ title: 'This link isn’t active', message: 'It has already been used, was replaced by a newer one, or has expired. Ask an admin to send you a new link.' })), headers);
    return;
  }
  const cookieNonce = String(req.headers.cookie ?? '').split(/;\s*/).find(c => c.startsWith(`${NONCE_COOKIE}=`))?.slice(NONCE_COOKIE.length + 1) ?? '';
  const secret = await pendingSecret(pool, { invite, key });
  const qr = qrcode(0, 'M');
  qr.addData(otpauthUri(secret, invite.email));
  qr.make();
  const render = (nonce, error = null, status = 200, more = {}) =>
    send(res, status, String(inviteSetupPage({ invite, nonce, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), secret, error })), { ...headers, ...more });
  if (req.method === 'GET') {
    const nonce = randomBytes(18).toString('base64url');
    render(nonce, null, 200, { 'Set-Cookie': `${NONCE_COOKIE}=${nonce}; Path=/invite/; HttpOnly; SameSite=Strict; Max-Age=3600${secure ? '; Secure' : ''}` });
    return;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const t = now().getTime();
  if (tooMany(`invite-ip:${clientIp(req, env)}`, 20, t) || tooMany(`invite:${invite.invite_id}`, 10, t)) {
    throw new HttpError(429, 'Too many tries. Wait a few minutes and try again.');
  }
  const params = await readForm(req);
  const sentNonce = String(params.get('nonce') ?? '');
  if (!sentNonce || sentNonce !== cookieNonce) throw new HttpError(403, 'This form expired. Open the link again.');
  try {
    const user = await completeInvite(pool, { token, password: params.get('password'), password2: params.get('password2'), code: params.get('code'), key, now: now() });
    send(res, 303, '', { ...headers, Location: '/', 'Set-Cookie': [auth.signIn(user), `${NONCE_COOKIE}=; Path=/invite/; Max-Age=0`] });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    render(sentNonce, error.message, 422);
  }
}

