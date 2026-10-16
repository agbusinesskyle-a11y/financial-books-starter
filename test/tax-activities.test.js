// test/tax-activities.test.js — Codex t1-r1 B10: two transactions adding inclusion edges at the same time cannot commit a cycle.
// Each case uses two connections of one fresh database: the first transaction inserts its edge and holds; the second inserts the
// closing edge (it must wait for the first, not race it); the first commits; the second must then see the first's edge and fail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';

let db, pool, orgSeq = 0;
before(async () => { db = await freshDb(); pool = db.pool; });
after(async () => { await db.drop(); });

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
// An organization of disregarded sample companies, each with its 2025 disregarded period and one activity (tiered single-member
// companies may include one another, so any edge between them is otherwise valid).
async function org(names) {
  const n = ++orgSeq;
  const { org_id: orgId } = await one('INSERT INTO org (slug, name) VALUES ($1, $2) RETURNING org_id', [`tax_activities_${n}`, `Sample Organization ${n}`]);
  const out = { orgId };
  for (const name of names) {
    const { entity_id: entityId } = await one('INSERT INTO entity (org_id, name) VALUES ($1, $2) RETURNING entity_id', [orgId, `${name} Sample Co`]);
    const { return_id: returnId } = await one(`INSERT INTO tax_return (org_id, entity_id, period_start, period_end, return_type, form_edition, tax_method, book_basis)
      VALUES ($1, $2, '2025-01-01', '2025-12-31', 'disregarded', 2025, 'cash', 'accrual') RETURNING return_id`, [orgId, entityId]);
    const { activity_id: activityId } = await one(`INSERT INTO tax_activity (org_id, return_entity_id, kind, name, schedule, effective_from) VALUES ($1, $2, 'holding', 'Own activity', 'p1', '2025-01-01') RETURNING activity_id`, [orgId, entityId]);
    out[name] = { entityId, returnId, activityId };
  }
  return out;
}
// "parent includes child": the edge sits on the parent's return and names the child's books.
const edgeSql = `INSERT INTO activity_inclusion (org_id, return_id, activity_id, source_entity_id, period_start, period_end, source_book_basis, approved_by)
  VALUES ($1, $2, $3, $4, '2025-01-01', '2025-12-31', 'accrual', 'reviewer')`;
const edgeArgs = (o, parent, child) => [o.orgId, o[parent].returnId, o[parent].activityId, o[child].entityId];

// Runs `first` and `second` in two open transactions, in that order, with `second` started while `first` is still open, then
// commits `first` and reports how `second` ended. `second` either waits (the serialized case) or finishes at once (a race).
async function concurrently(first, second) {
  const c1 = await pool.connect(); const c2 = await pool.connect();
  try {
    await c1.query('BEGIN'); await c2.query('BEGIN');
    await first(c1);
    const pid2 = (await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let settled = false;
    const pending = second(c2).then(() => ({ ok: true }), error => ({ ok: false, error })).finally(() => { settled = true; });
    // Until the second statement either finished or is waiting on a lock held by the first transaction.
    for (let i = 0; i < 200 && !settled; i++) {
      const { rows: [w] } = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid2]);
      if (w?.wait_event_type === 'Lock') break;
      await new Promise(r => setTimeout(r, 10));
    }
    await c1.query('COMMIT');
    const result = await pending;
    if (result.ok) await c2.query('COMMIT'); else await c2.query('ROLLBACK');
    return result;
  } finally { c1.release(); c2.release(); }
}
const edges = async orgId => (await pool.query('SELECT count(*)::int AS n FROM activity_inclusion WHERE org_id = $1', [orgId])).rows[0].n;

test('two concurrent edges A includes B and B includes A: one transaction fails with the cycle error', async () => {
  const o = await org(['Alder', 'Birch']);
  const result = await concurrently(c => c.query(edgeSql, edgeArgs(o, 'Alder', 'Birch')), c => c.query(edgeSql, edgeArgs(o, 'Birch', 'Alder')));
  assert.equal(result.ok, false, 'the second edge must not commit');
  assert.match(result.error.message, /cycle/);
  assert.equal(await edges(o.orgId), 1, 'only the first edge exists');
});

test('the four-node case under the parents’ company locks: A→B and C→D exist, then B→C and D→A concurrently — one fails', async () => {
  const o = await org(['Alder', 'Birch', 'Cedar', 'Dogwood']);
  await pool.query(edgeSql, edgeArgs(o, 'Alder', 'Birch'));
  await pool.query(edgeSql, edgeArgs(o, 'Cedar', 'Dogwood'));
  // The same parent locks includeBooks takes (lockEntity: the parent's entity row FOR UPDATE), which do not conflict here.
  const lockParent = (c, name) => c.query('SELECT 1 FROM entity WHERE org_id = $1 AND entity_id = $2 FOR UPDATE', [o.orgId, o[name].entityId]);
  const result = await concurrently(async c => { await lockParent(c, 'Birch'); await c.query(edgeSql, edgeArgs(o, 'Birch', 'Cedar')); },
    async c => { await lockParent(c, 'Dogwood'); await c.query(edgeSql, edgeArgs(o, 'Dogwood', 'Alder')); });
  assert.equal(result.ok, false, 'A→B→C→D→A must not commit');
  assert.match(result.error.message, /cycle/);
  assert.equal(await edges(o.orgId), 3);
});

test('edges that do not form a cycle still commit concurrently, and a REPEATABLE READ snapshot cannot change the graph', async () => {
  const o = await org(['Alder', 'Birch', 'Cedar', 'Dogwood']);
  const result = await concurrently(c => c.query(edgeSql, edgeArgs(o, 'Alder', 'Birch')), c => c.query(edgeSql, edgeArgs(o, 'Cedar', 'Dogwood')));
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(await edges(o.orgId), 2);
  // A REPEATABLE READ transaction keeps the snapshot of its first statement, so the serialized re-check could not see an edge
  // committed meanwhile: the trigger refuses graph changes there.
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(c.query(edgeSql, edgeArgs(o, 'Birch', 'Cedar')), /READ COMMITTED/);
    await c.query('ROLLBACK');
  } finally { c.release(); }
});
