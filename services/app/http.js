// Shared by the app's route modules.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const idParam = value => (/^\d{1,18}$/.test(String(value ?? '')) ? Number(value) : null);

// Counts tries per key in a 10-minute window; true once `max` is passed. Used by the public (no sign-in) pages.
const attempts = new Map(); // key -> { n, until }
export function tooMany(key, max, now = Date.now()) {
  if (attempts.size > 5000) for (const [k, a] of attempts) if (a.until <= now) attempts.delete(k);
  const a = attempts.get(key);
  const next = a && a.until > now ? { n: a.n + 1, until: a.until } : { n: 1, until: now + 600_000 };
  attempts.set(key, next);
  return next.n > max;
}

// The client's address. Behind one reverse proxy set TRUST_PROXY=1: the right-most X-Forwarded-For entry is the address
// that proxy saw (entries further left are whatever the client sent, so they can't be trusted).
export function clientIp(req, env = process.env) {
  const forwarded = env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean).pop() ?? '' : '';
  return forwarded || req.socket.remoteAddress || 'unknown';
}
