import { randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const token = () => randomBytes(32).toString('hex');

export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const makeTotp = (secret, label = 'operator') => new OTPAuth.TOTP({
  issuer: 'financial-books', label, algorithm: 'SHA1', digits: 6, period: 30,
  secret: OTPAuth.Secret.fromBase32(secret),
});

// Password + authenticator sign-in. Sessions live in memory (a restart logs out).
// With an email, `verifyUser({ email, password, code })` checks a Settings → Users person and returns { userId, version }
// or null. A blank email is the break-glass owner login from the environment (APP_LOGIN_PASSWORD_HASH + APP_TOTP_SECRET),
// which acts as an admin so nobody is ever locked out. A session's `userId` is null for the owner.
export function createAuth({ env = process.env, now = () => Date.now(), verifyUser = async () => null } = {}) {
  const devNoAuth = env.DEV_NO_AUTH === '1';
  if (devNoAuth && env.NODE_ENV === 'production') throw new Error('DEV_NO_AUTH is not allowed in production');
  const secure = (env.APP_BASE_URL || '').startsWith('https://');
  const sessions = new Map();
  const attempts = new Map();
  let lastTotpCounter = -1;

  const cookie = (name, value, maxAgeSec) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${maxAgeSec}`;

  function newSession(userId = null, version = 0) {
    const id = token();
    const session = { id, csrf: token(), lastSeen: now(), recent: [], userId, version };
    sessions.set(id, session);
    return session;
  }

  function sessionFor(req) {
    const id = parseCookies(req.headers.cookie).fb_session;
    const session = id && sessions.get(id);
    if (session && now() - session.lastSeen < SESSION_IDLE_MS) { session.lastSeen = now(); return session; }
    if (session) sessions.delete(id);
    return null;
  }

  return {
    devNoAuth,
    configured: Boolean(env.APP_LOGIN_PASSWORD_HASH && env.APP_TOTP_SECRET),

    // Returns { session, setCookie? }. In dev mode a session is created on demand.
    current(req) {
      const session = sessionFor(req);
      if (session) return { session };
      if (devNoAuth) { const s = newSession(); return { session: s, setCookie: cookie('fb_session', s.id, SESSION_IDLE_MS / 1000) }; }
      return { session: null };
    },

    // A per-visit token tying the login form post to the browser that loaded it.
    loginChallenge(req) {
      const existing = parseCookies(req.headers.cookie).fb_login;
      const value = existing && /^[0-9a-f]{64}$/.test(existing) ? existing : token();
      return { value, setCookie: cookie('fb_login', value, 900) };
    },

    rateLimited(ip) {
      const list = (attempts.get(ip) ?? []).filter(t => now() - t < LOGIN_WINDOW_MS);
      attempts.set(ip, list);
      return list.length >= LOGIN_MAX_ATTEMPTS;
    },

    // Returns { ok, setCookie?, error?, attempted? } — attempted: the credentials were checked (not a stale form or rate limit).
    async login(req, form, ip) {
      if (!sameToken(form.challenge, parseCookies(req.headers.cookie).fb_login)) return { ok: false, error: 'Your sign-in form expired. Try again.' };
      const email = String(form.email ?? '').trim();
      const who = `email:${email.toLowerCase() || 'owner'}`;
      if (this.rateLimited(ip)) return { ok: false, error: 'Too many attempts. Wait 15 minutes.' };
      attempts.get(ip).push(now());
      // The per-person limit counts only failed checks, and the right password and code still get in while it's
      // active — so someone else's wrong guesses can't lock a person (or the owner) out. Guessing stays capped per IP.
      const personLocked = this.rateLimited(who);
      const failed = msg => { (attempts.get(who) ?? attempts.set(who, []).get(who)).push(now());
        return personLocked ? { ok: false, attempted: true, error: 'Too many attempts. Wait 15 minutes.' } : { ok: false, attempted: true, error: msg }; };
      if (email) {
        const user = await verifyUser({ email, password: form.password, code: form.code });
        if (!user) return failed('Wrong email, password or code.');
        attempts.delete(ip);
        attempts.delete(who);
        return { ok: true, setCookie: this.signIn(user) };
      }
      if (!this.configured) return { ok: false, error: 'Owner sign-in is not configured on this server. Enter your email.' };
      const passwordOk = await bcrypt.compare(String(form.password ?? ''), env.APP_LOGIN_PASSWORD_HASH);
      const code = String(form.code ?? '').replace(/\s/g, '');
      const delta = /^\d{6}$/.test(code) ? makeTotp(env.APP_TOTP_SECRET).validate({ token: code, timestamp: now(), window: 1 }) : null;
      const counter = delta === null ? null : Math.floor(now() / 30000) + delta;
      if (!passwordOk || counter === null || counter <= lastTotpCounter) return failed('Wrong password or code.');
      lastTotpCounter = counter;
      attempts.delete(ip);
      attempts.delete(who);
      const s = newSession();
      return { ok: true, setCookie: cookie('fb_session', s.id, SESSION_IDLE_MS / 1000) };
    },

    // Starts a session for a Settings → Users person; returns the Set-Cookie value.
    signIn({ userId, version }) {
      const s = newSession(userId, version);
      return cookie('fb_session', s.id, SESSION_IDLE_MS / 1000);
    },

    // Ends a session whose person was deactivated or reset; returns the Set-Cookie value that clears it.
    end(session) {
      sessions.delete(session.id);
      return cookie('fb_session', '', 0);
    },

    logout(req) {
      const id = parseCookies(req.headers.cookie).fb_session;
      if (id) sessions.delete(id);
      return cookie('fb_session', '', 0);
    },
  };
}
