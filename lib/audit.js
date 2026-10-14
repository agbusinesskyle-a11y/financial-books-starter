import { AsyncLocalStorage } from 'node:async_hooks';

// Who is acting, for the audit log (migrations/024_audit_log.sql). Each request runs inside withActor(); once the
// person is known the request calls setActor(name). Every connection the app takes from the pool is told that name
// (the connection setting app.actor) before it runs anything, so the audit triggers record the right person for
// every write — through a transaction or a single query alike. Outside a request (jobs, seeding) it is 'system'.
const store = new AsyncLocalStorage();
const TRACKED = Symbol('audit actor tracked');

export const withActor = fn => store.run({ actor: null }, fn);
export const setActor = name => { const s = store.getStore(); if (s) s.actor = String(name ?? '').slice(0, 200) || null; };
export const currentActor = () => store.getStore()?.actor ?? '';

export function trackActor(pool) {
  if (pool[TRACKED]) return pool;
  pool[TRACKED] = true;
  const connect = pool.connect.bind(pool);
  pool.connect = async (...args) => {
    if (args.length) return connect(...args); // callback style: not used by the app
    const client = await connect();
    try {
      await client.query("SELECT set_config('app.actor', $1, false)", [currentActor()]);
    } catch (error) {
      client.release(error);
      throw error;
    }
    return client;
  };
  pool.query = async (text, params) => {
    const client = await pool.connect();
    try { return await client.query(text, params); } finally { client.release(); }
  };
  return pool;
}

// Sign-ins (and failed attempts) go in the same log.
// A failed attempt is logged under a fixed name with the typed email as detail, so nobody can sign "as" someone else in
// the log by typing their name.
export async function logSignIn(pool, { orgId, email, ok, ip }) {
  await pool.query(`INSERT INTO audit_log (org_id, actor, action, table_name, after) VALUES ($1, $2, $3, 'session', $4)`,
    [orgId, ok ? String(email || 'owner').slice(0, 200) : '(sign-in attempt)', ok ? 'sign_in' : 'sign_in_failed', JSON.stringify({ ip: ip ?? null, email: String(email ?? '').slice(0, 200) })]);
}
