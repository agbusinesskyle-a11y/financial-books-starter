import { setImmediate as yieldNow } from 'node:timers/promises';
import { isTrustedActor, validateMorningIdentityIn } from './access.js';

export const SECURITY_LOCK = 74120065;
export const OBSERVE_LOCK = 74120066;
export const COMPUTE_LOCK = 74120067;
export const SECURITY_WRITE_WAIT_MS = 35000;
export const MORNING_LOCK_WAIT_MS = 2000;
export const MORNING_STATEMENT_MS = 5000;
export const MORNING_DEADLINE_MS = 15000;

export class LockBusyError extends Error {
  constructor() { super('Morning View is busy. Try again.'); this.name = 'LockBusyError'; }
}
export class MorningTimeoutError extends Error {
  constructor(cause) { super('Morning View is unavailable. Try again.', { cause }); this.name = 'MorningTimeoutError'; }
}

const uncertain = e => /Query read timeout|connection|socket|terminat/i.test(e?.message ?? '') || /^08|^ECONN|^EPIPE/.test(e?.code ?? '') || e?.code === '57P01';
const positive = n => Math.max(1, Math.floor(n));

async function checkout(pool, ms) {
  let expired = false, timer;
  const pending = pool.connect().then(client => { if (expired) { client.release(); return null; } return client; });
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new LockBusyError()); }, positive(ms));
    })]);
  } finally { clearTimeout(timer); }
}

export async function lockUsersAscending(tx, orgId, userIds) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Set();
  if (!ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid user identity');
  const { rows } = await tx.query('SELECT user_id FROM app_user WHERE org_id=$1 AND user_id=ANY($2::bigint[]) ORDER BY user_id FOR UPDATE', [orgId, ids]);
  return new Set(rows.map(r => r.user_id));
}

// Session locks precede BEGIN. A positive driver guard always outlasts the server budget.
// The facade bounds each statement and accounts for time spent between statements too.
async function security(pool, { orgId, userIds = [], waitMs, statementMs = MORNING_STATEMENT_MS,
  deadlineMs = MORNING_DEADLINE_MS, queryBudgetMs, hooks = {} }, fn, mode) {
  if (!Number.isSafeInteger(orgId) || orgId <= 0) throw new Error('Invalid organization identity');
  const acquisitionEnd = performance.now() + waitMs;
  const overallEnd = performance.now() + deadlineMs;
  const client = await checkout(pool, waitMs);
  let acquiring = true, locked = false, transaction = false, broken = false, workEnd = Infinity;
  const remaining = () => {
    const ms = (acquiring ? acquisitionEnd : workEnd) - performance.now();
    if (ms <= 0) throw acquiring ? new LockBusyError() : new MorningTimeoutError();
    return positive(ms);
  };
  const raw = async (text, values, serverMs = statementMs, useHooks = true) => {
    try {
      if (useHooks) await hooks.beforeQuery?.({ text, values });
      return await client.query({ text, values, query_timeout: positive(serverMs) + 2000 });
    } catch (e) { if (uncertain(e)) broken = true; throw e; }
  };
  const limits = ms => raw("SELECT set_config('lock_timeout',$1,false),set_config('statement_timeout',$1,false)", [`${positive(ms)}ms`], ms);
  const tx = { query: async (text, values) => {
    const rollback = /^ROLLBACK\b/i.test(text);
    // A dispatch has a short preflight followed by a separately bounded provider
    // call. Its SQL statements share the remaining preflight budget. Rollback
    // must still be possible after a deadline or an aborted transaction.
    const budget = !acquiring && !rollback && queryBudgetMs ? queryBudgetMs() : statementMs;
    if (!Number.isFinite(budget) || budget <= 0) throw new MorningTimeoutError();
    const ms = acquiring ? remaining() : Math.min(statementMs, budget, remaining());
    if (!rollback) await limits(ms);
    const result = await raw(text, values, ms);
    // Record server acknowledgement before a post-query deadline can throw.
    if (/^BEGIN\b/i.test(text)) transaction = true;
    if (/^(COMMIT|ROLLBACK)\s*$/i.test(text)) transaction = false;
    remaining();
    return result;
  } };
  try {
    await limits(remaining());
    await raw(`SELECT pg_advisory_lock${mode === 'write' ? '' : '_shared'}($1,hashint8($2))`, [SECURITY_LOCK, orgId], remaining());
    locked = true;
    await hooks.afterLock?.({ name: 'SECURITY', client: tx });
    if (mode !== 'read') {
      await tx.query(mode === 'write' ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ');
      transaction = true;
    }
    if (mode === 'write') {
      const discovered = await hooks.discoverUserIds?.(tx) ?? [];
      await lockUsersAscending(tx, orgId, [...userIds, ...discovered]);
    }
    acquiring = false;
    workEnd = mode === 'write' ? performance.now() + MORNING_STATEMENT_MS : mode === 'snapshot' ? overallEnd : Infinity;
    const result = await fn(tx);
    remaining();
    if (transaction) {
      await hooks.beforeCommit?.({ tx });
      await tx.query('COMMIT');
      transaction = false;
    }
    return result;
  } catch (e) {
    if (broken) e.morningConnectionFailure = true;
    if (e.code === '55P03' || (e.code === '57014' && acquiring)) throw new LockBusyError();
    if (e.code === '57014') throw new MorningTimeoutError();
    throw e;
  } finally {
    if (!broken) {
      try {
        // Cleanup is awaited through ReadyForQuery, and has its own small server/driver guard.
        if (transaction) await raw('ROLLBACK', undefined, MORNING_STATEMENT_MS, false);
        await raw("SELECT set_config('statement_timeout','5000ms',false)", undefined, MORNING_STATEMENT_MS, false);
        if (locked) await raw(`SELECT pg_advisory_unlock${mode === 'write' ? '' : '_shared'}($1,hashint8($2))`, [SECURITY_LOCK, orgId], MORNING_STATEMENT_MS, false);
        await raw('RESET lock_timeout', undefined, MORNING_STATEMENT_MS, false);
        await raw('RESET statement_timeout', undefined, MORNING_STATEMENT_MS, false);
      } catch { broken = true; }
    }
    client.release(broken);
  }
}

export const withSecurityWrite = (pool, { waitMs = SECURITY_WRITE_WAIT_MS, ...options }, fn) => security(pool, { ...options, waitMs }, fn, 'write');
export const withSecurityRead = (pool, { waitMs = MORNING_LOCK_WAIT_MS, ...options }, fn) => security(pool, { ...options, waitMs }, fn, 'read');
export const withReadSnapshot = (pool, options, fn) => withMorningComputation(pool, { ...options, purpose: options.purpose ?? 'detail' }, fn);

function semaphore(max) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) { clearTimeout(next.timer); active++; next.resolve(release); }
  };
  return async ms => {
    if (ms <= 0) throw new LockBusyError();
    if (active < max) { active++; return release; }
    return new Promise((resolve, reject) => {
      const entry = { resolve, timer: setTimeout(() => {
        queue.splice(queue.indexOf(entry), 1); reject(new LockBusyError());
      }, positive(ms)) };
      queue.push(entry);
    });
  };
}
const runtimes = new WeakMap();
const jobAuthorities = new WeakSet();
// Internal job selection captures versions; request fields cannot supply this capability.
export function morningJobAuthority({ orgId, viewerKey, membershipEpoch, settingsVersion }) {
  if (![orgId, membershipEpoch, settingsVersion].every(n => Number.isSafeInteger(n) && n > 0)
    || !/^(owner|[1-9][0-9]*)$/.test(viewerKey)) throw new Error('Invalid job authority');
  const authority = Object.freeze({ orgId, viewerKey, membershipEpoch, settingsVersion });
  jobAuthorities.add(authority);
  return authority;
}
async function validateJobIn(tx, authority) {
  const { rows: [r] } = await tx.query(`SELECT v.membership_epoch FROM morning_viewer v
    JOIN morning_preference p USING(org_id,viewer_key) LEFT JOIN app_user u ON u.org_id=v.org_id AND u.user_id=v.user_id
    WHERE v.org_id=$1 AND v.viewer_key=$2 AND v.enrollment_state='ready' AND p.enabled
      AND v.membership_epoch=$3 AND p.membership_epoch=$3 AND p.settings_version=$4
      AND (v.viewer_key='owner' OR (u.active AND u.password_hash IS NOT NULL AND u.totp_enc IS NOT NULL))`,
  [authority.orgId, authority.viewerKey, authority.membershipEpoch, authority.settingsVersion]);
  if (!r) throw new Error('Morning job is no longer eligible');
  return { viewerKey:authority.viewerKey, epoch:r.membership_epoch, isOwner:authority.viewerKey === 'owner' };
}
export function createMorningRuntime({ mono = () => performance.now(), wall = () => new Date(), max = 2 } = {}) {
  if (!Number.isInteger(max) || max < 1 || max > 2) throw new Error('Invalid computation limit');
  const runtime = Object.freeze({ mono, wall });
  runtimes.set(runtime, { slots: semaphore(max), viewers: new Map() });
  return runtime;
}
export const processMorningRuntime = createMorningRuntime();
export const withObservingRead = (pool, options, fn) => withMorningComputation(pool, { ...options, purpose: 'page' }, fn);

export async function withMorningComputation(pool, { identity, jobAuthority, orgId, viewerKey, purpose,
  runtime = processMorningRuntime, waitMs = MORNING_LOCK_WAIT_MS, statementMs = MORNING_STATEMENT_MS,
  deadlineMs = MORNING_DEADLINE_MS, hooks = {} }, fn) {
  const actor = identity ?? jobAuthority;
  if (identity && jobAuthority || !(identity ? isTrustedActor(identity) : jobAuthorities.has(jobAuthority))
    || actor.orgId !== orgId || actor.viewerKey !== viewerKey || jobAuthority && purpose !== 'digest') throw new Error('Trusted Morning identity or job authority required');
  if (!['page', 'detail', 'digest', 'dismiss', 'undismiss'].includes(purpose)) throw new Error('Invalid computation purpose');
  const state = runtimes.get(runtime);
  if (!state) throw new Error('Morning runtime required');
  if (![waitMs, statementMs, deadlineMs].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid time budget');
  if (process.env.NODE_ENV === 'production' && (Object.keys(hooks).length || waitMs > 2000 || statementMs > 5000 || deadlineMs > 15000)) throw new Error('Test overrides are not allowed in production');
  const start = runtime.mono(), acquireEnd = start + waitMs, end = start + deadlineMs;
  const remainingMs = () => end - runtime.mono();
  const check = () => { if (remainingMs() <= 0) throw new MorningTimeoutError(); };
  const acquisition = () => { check(); const n = acquireEnd - runtime.mono(); if (n <= 0) throw new LockBusyError(); return n; };
  const key = `${orgId}:${viewerKey}`;
  let gate = state.viewers.get(key);
  if (!gate) { gate = { acquire: semaphore(1), users: 0 }; state.viewers.set(key, gate); }
  gate.users++;
  let releaseViewer, releaseSlot, client, transaction = false, broken = false, acquiring = true;
  const held = [];
  const raw = async (text, values, ms, invokeHook = true) => {
    if (invokeHook) { await hooks.beforeQuery?.({ text, values }); check(); }
    try { return await client.query({ text, values, query_timeout: positive(ms) + 2000 }); }
    catch (error) { if (uncertain(error)) broken = true; throw error; }
  };
  const limits = async (ms, lockMs = ms) => raw("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)", [`${positive(ms)}ms`, `${positive(lockMs)}ms`], ms, false);
  const query = async (text, values, checkAfter = true) => {
    check(); const ms = Math.min(statementMs, Math.floor(remainingMs()));
    if (ms <= 0) throw new MorningTimeoutError();
    // An aborted subtransaction accepts only rollback; SET would mask its recovery.
    if (!/^ROLLBACK\b/i.test(text)) await limits(ms, Math.min(waitMs, ms));
    const result = await raw(text, values, ms);
    if (checkAfter) check();
    return result;
  };
  const budget = { remainingMs, check, checkpoint: async () => { check(); await yieldNow(); check(); }, query: (text, values) => query(text, values) };
  const tx = Object.freeze(budget);
  const lock = async (name, namespace, value, hash, shared = false) => {
    const ms = Math.min(statementMs, acquisition());
    await limits(ms, acquisition());
    await raw(`SELECT pg_advisory_lock${shared ? '_shared' : ''}($1,${hash}($2))`, [namespace, value], ms);
    held.push({ namespace, value, hash, shared });
    await hooks.afterLock?.({ name, client: tx }); acquisition();
  };
  try {
    await hooks.beforeAcquire?.({ purpose, viewerKey });
    releaseViewer = await gate.acquire(acquisition());
    releaseSlot = await state.slots(acquisition());
    client = await checkout(pool, acquisition());
    await lock('COMPUTE', COMPUTE_LOCK, key, 'hashtext');
    await lock('SECURITY', SECURITY_LOCK, orgId, 'hashint8', true);
    if (purpose === 'page') await lock('OBSERVE', OBSERVE_LOCK, key, 'hashtext');
    acquiring = false;
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); transaction = true;
    const N = runtime.wall();
    const authority = identity ? await validateMorningIdentityIn(tx, { identity }) : await validateJobIn(tx, jobAuthority);
    const result = await fn(tx, { N, budget, authority });
    check(); await hooks.beforeCommit?.({ tx }); check();
    // Enforce the budget before/at COMMIT; an acknowledged commit is durable success.
    await query('COMMIT', undefined, false); transaction = false;
    return result;
  } catch (error) {
    if (error instanceof MorningTimeoutError || error.code === '57014' && !acquiring || broken) {
      broken = true;
      throw error instanceof MorningTimeoutError ? error : new MorningTimeoutError(error);
    }
    if (error.code === '55P03' || error.code === '57014' && acquiring) throw new LockBusyError();
    throw error;
  } finally {
    if (client) {
      if (!broken) {
        try {
          if (transaction) await raw('ROLLBACK', undefined, 5000, false);
          await limits(5000);
          for (const l of held.reverse()) await raw(`SELECT pg_advisory_unlock${l.shared ? '_shared' : ''}($1,${l.hash}($2))`, [l.namespace, l.value], 5000, false);
          await raw('RESET statement_timeout', undefined, 5000, false);
          await raw('RESET lock_timeout', undefined, 5000, false);
        } catch { broken = true; }
      }
      client.release(broken);
    }
    releaseSlot?.(); releaseViewer?.();
    if (--gate.users === 0) state.viewers.delete(key);
  }
}
