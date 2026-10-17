// test/tax-t2-migration.test.js — migration 065: the binding tables, their scope triggers (own and nested inclusion paths), the set rule,
// routing independent of provider authority.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, period, activity, include } from './tax-t2-fixtures.js';
import { saveProfile, openPeriod } from '../lib/tax/periods.js';
import { removeInclusion } from '../lib/tax/activities.js';

let t, pool, orgId, P, C, G, ret, cRet, wages, childWages, grandWages, act, incC, incG;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  P = { orgId, entityId: await company(pool, orgId, 'Mesa Partners') };
  C = { orgId, entityId: await company(pool, orgId, 'Mesa Child LLC') };
  G = { orgId, entityId: await company(pool, orgId, 'Mesa Grandchild LLC') };
  ret = await period(pool, P, 2025, 'form_1065');
  cRet = await period(pool, C, 2025, 'disregarded');
  await period(pool, G, 2025, 'disregarded');
  wages = await acct(pool, P, 'Wages'); childWages = await acct(pool, C, 'Wages'); grandWages = await acct(pool, G, 'Wages');
  act = await activity(pool, P, { name: 'Mesa trade' });
  const cAct = await activity(pool, C, { name: 'Mesa child trade' });
  incG = await include(pool, C, cRet, cAct, G.entityId);   // C includes G on C's own disregarded period
});
after(async () => { await t.db.drop(); });

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
// A raw binding row (the data module is Task 5); defaults fill the columns a test does not care about.
const bindSql = `INSERT INTO tax_binding (org_id, return_id, source_entity_id, inclusion_path, account_id, measurement, treatment, destination, slot_key, target_key, share_num, share_den, amount_cents, source_version, catalog_edition)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'v1',2025) RETURNING binding_id`;
const bind = (c, r) => c.query(bindSql, [orgId, r.returnId, r.sourceEntityId, r.path ?? [], r.accountId, r.measurement ?? 'activity', r.treatment ?? 'input', r.destination ?? 'f1065.p1.9',
  r.slotKey ?? null, r.targetKey ?? `${r.treatment ?? 'input'}|${r.destination ?? 'f1065.p1.9'}|a=-|o=-|k=-`, r.shareNum ?? null, r.shareDen ?? null, r.amountCents ?? null]);
// Runs fn in one transaction and reports how COMMIT ended (the set rule is a deferred constraint trigger).
async function inTx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); await c.query('COMMIT'); return 'ok'; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); return e.message; }
  finally { c.release(); }
}

test('migration 065 creates the T2 tables, org-scoped and audited, with the treatment domain and the party id state', async () => {
  const want = ['tax_binding', 'tax_binding_default', 'tax_binding_line', 'tax_binding_suggestion'];
  const { rows } = await pool.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'org_id' AND table_name = ANY($1) ORDER BY 1`, [want]);
  assert.deepEqual(rows.map(r => r.table_name), want);
  const { rows: trig } = await pool.query(`SELECT DISTINCT event_object_table AS t FROM information_schema.triggers WHERE trigger_name = 'audit' AND event_object_table = ANY($1)`, [want]);
  assert.equal(trig.length, want.length);
  assert.deepEqual(await one(`SELECT tax_treatment_has_slot('input') AS a, tax_treatment_has_slot('cogs_tieout') AS b, tax_treatment_has_slot('equity_event') AS c`), { a: true, b: false, c: false });
  assert.match(await inTx(c => c.query(`SELECT 'gift'::tax_treatment`)), /tax_treatment/);
  assert.ok(await one(`SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'tax_party' AND column_name = 'own_tax_id_state'`));
});

test('a source measurement is bound whole once, or split; shares total exactly 1; a row moved to another set leaves a valid set behind', async () => {
  const base = { returnId: ret, sourceEntityId: P.entityId, accountId: wages };
  assert.match(await inTx(async c => { await bind(c, base); await bind(c, { ...base, treatment: 'statement_row', destination: 'f1065.p1.21' }); }), /bound whole once, or split/);
  assert.equal(await inTx(async c => { for (const d of ['f1065.p1.9', 'f1065.p1.11', 'f1065.p1.13']) await bind(c, { ...base, destination: d, shareNum: 1, shareDen: 3 }); }), 'ok');
  // Moving one third to the ending-balance set leaves 2/3 behind: the set it left is checked too (Codex non-blocking 4).
  assert.match(await inTx(c => c.query(`UPDATE tax_binding SET measurement = 'end' WHERE org_id = $1 AND return_id = $2 AND destination = 'f1065.p1.13'`, [orgId, ret])), /total 2\/3, not 1|share split/);
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
  assert.match(await inTx(async c => { for (const d of ['f1065.p1.9', 'f1065.p1.11']) await bind(c, { ...base, destination: d, shareNum: 1, shareDen: 3 }); }), /total 2\/3, not 1/);
  assert.match(await inTx(async c => { await bind(c, { ...base, shareNum: 1, shareDen: 2 }); await bind(c, { ...base, destination: 'f1065.p1.11', amountCents: 500 }); }), /every row/);
});

test('bindings stay in scope: own books or included books on their exact inclusion path, never a disregarded period, never another company’s account', async () => {
  assert.match(await inTx(c => bind(c, { returnId: ret, sourceEntityId: P.entityId, accountId: childWages })), /another company than the source/);
  assert.match(await inTx(c => bind(c, { returnId: ret, sourceEntityId: C.entityId, accountId: childWages })), /only through its inclusion path/);
  assert.match(await inTx(c => bind(c, { returnId: cRet, sourceEntityId: C.entityId, accountId: childWages })), /disregarded company/);
  assert.match(await inTx(c => bind(c, { returnId: ret, sourceEntityId: P.entityId, path: [1], accountId: wages })), /own books have no inclusion path/);
  const { org_id: other } = await one(`INSERT INTO org (slug, name) VALUES ('t2_other', 'Other Sample Org') RETURNING org_id`);
  const oc = await company(pool, other, 'Other Org Sample Co');
  const foreign = await acct(pool, { orgId: other, entityId: oc }, 'Wages');
  assert.match(await inTx(c => bind(c, { returnId: ret, sourceEntityId: P.entityId, accountId: foreign })), /another company than the source|foreign key/);
});

test('nested inclusions: a grandchild’s books bind through the whole path; an edge on any binding’s path stays until the bindings go', async () => {
  incC = await include(pool, P, ret, act, C.entityId);
  const { rows } = await pool.query('SELECT source_entity_id, path, period_matches FROM tax_inclusion_sources($1, $2) ORDER BY cardinality(path)', [orgId, ret]);
  assert.deepEqual(rows.map(r => [Number(r.source_entity_id), r.path.map(Number), r.period_matches]), [[C.entityId, [incC], true], [G.entityId, [incC, incG], true]]);
  assert.match(await inTx(c => bind(c, { returnId: ret, sourceEntityId: G.entityId, path: [incG], accountId: grandWages })), /only through its inclusion path/);
  assert.equal(await inTx(c => bind(c, { returnId: ret, sourceEntityId: G.entityId, path: [incC, incG], accountId: grandWages })), 'ok');
  await assert.rejects(pool.query('DELETE FROM activity_inclusion WHERE org_id = $1 AND inclusion_id = $2', [orgId, incG]), /accounts are bound on this return/);
  await assert.rejects(pool.query('DELETE FROM activity_inclusion WHERE org_id = $1 AND inclusion_id = $2', [orgId, incC]), /accounts are bound on this return/);
  await pool.query('UPDATE activity_inclusion SET approved_by = $3 WHERE org_id = $1 AND inclusion_id = $2', [orgId, incC, 'second reviewer']);
  const other = await activity(pool, P, { name: 'Mesa second trade' });
  await assert.rejects(pool.query('UPDATE activity_inclusion SET activity_id = $3 WHERE org_id = $1 AND inclusion_id = $2', [orgId, incC, other]), /accounts are bound on this return/);
  await assert.rejects(pool.query(`UPDATE tax_return SET return_type = 'form_1120s' WHERE org_id = $1 AND return_id = $2`, [orgId, ret]), /has source bindings/);
  // A grandchild is never a second direct inclusion of the parent: one income-tax owner per period (T1).
  await assert.rejects(include(pool, P, ret, act, G.entityId), /already included|one_owner/);
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
});

test('a binding is routing, not authority: providers are assigned to bound slots, and the binding keeps its routing (one assignment per slot)', async () => {
  const assign = (slot, kind) => pool.query(`INSERT INTO tax_provider_assignment (org_id, return_id, slot_key, provider_kind, provider_schema_version, source_version) VALUES ($1,$2,$3,$4,1,'p:1@v1')`, [orgId, ret, slot, kind]);
  assert.equal(await inTx(c => bind(c, { returnId: ret, sourceEntityId: P.entityId, accountId: wages, slotKey: 'f1065.p1.9|activity' })), 'ok');
  await assign('f1065.p1.9|activity', 'cash_layer');
  await assert.rejects(assign('f1065.p1.9|activity', 'manual'), /duplicate key|unique/i, 'still exactly one authority per slot');
  assert.equal((await one('SELECT count(*)::int AS n FROM tax_binding WHERE org_id = $1 AND return_id = $2', [orgId, ret])).n, 1, 'the routing stays');
  // A treatment that names no slot never carries a slot key.
  assert.match(await inTx(c => bind(c, { returnId: ret, sourceEntityId: P.entityId, accountId: wages, measurement: 'end', treatment: 'equity_event', destination: 'distribution_cash', slotKey: 'f1065.p1.9|activity' })), /check constraint/);
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
});

test('any depth (Codex r2 B4): a seventeen-edge chain reaches its last company; nothing is cut off', async () => {
  const chain = [{ orgId, entityId: await company(pool, orgId, 'Depth 0 Partners') }];
  const rets = [await period(pool, chain[0], 2025, 'form_1065')];
  for (let i = 1; i <= 17; i += 1) {
    chain.push({ orgId, entityId: await company(pool, orgId, `Depth ${i} LLC`) });
    rets.push(await period(pool, chain[i], 2025, 'disregarded'));
  }
  for (let i = 1; i <= 17; i += 1) await include(pool, chain[i - 1], rets[i - 1], await activity(pool, chain[i - 1], { name: `Depth ${i - 1} trade` }), chain[i].entityId);
  const { rows } = await pool.query('SELECT source_entity_id, cardinality(path) AS depth FROM tax_inclusion_sources($1, $2) ORDER BY 2', [orgId, rets[0]]);
  assert.equal(rows.length, 17);
  assert.deepEqual([Number(rows[16].source_entity_id), Number(rows[16].depth)], [chain[17].entityId, 17]);
});

test('a direct child formed mid-year is included for the whole period, by definition (Codex r2 B4): its books start when it does', async () => {
  const P2 = { orgId, entityId: await company(pool, orgId, 'Formed Parent Partners') };
  const p2Ret = await period(pool, P2, 2025, 'form_1065');
  const K = { orgId, entityId: await company(pool, orgId, 'Formed April LLC') };
  await saveProfile(pool, { ...K, fields: { returnType: 'disregarded', activityKind: 'trade', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-04-01' }, reason: 'setup', actor: 'tester' });
  await openPeriod(pool, { ...K, year: 2025, initial: true, periodStart: '2025-04-01', actor: 'tester' });
  await include(pool, P2, p2Ret, await activity(pool, P2, { name: 'Formed trade' }), K.entityId);
  const { rows: [s] } = await pool.query('SELECT period_matches FROM tax_inclusion_sources($1, $2) WHERE source_entity_id = $3', [orgId, p2Ret, K.entityId]);
  assert.equal(s.period_matches, true);
});

test('a binding write and an edge removal are serialized by the graph lock (Codex r2 B5): whichever commits first, the other sees it', async () => {
  const P3 = { orgId, entityId: await company(pool, orgId, 'Race Parent Partners') };
  const p3Ret = await period(pool, P3, 2025, 'form_1065');
  const K = { orgId, entityId: await company(pool, orgId, 'Race Child LLC') };
  await period(pool, K, 2025, 'disregarded');
  const kWages = await acct(pool, K, 'Wages');
  const edge = await include(pool, P3, p3Ret, await activity(pool, P3, { name: 'Race trade' }), K.entityId);
  const pending = p => Promise.race([p.then(() => 'done', () => 'done'), new Promise(r => setTimeout(() => r('waiting'), 300))]);
  // 1. The binding first, uncommitted; the removal waits for it, then refuses.
  const a = await pool.connect();
  try {
    await a.query('BEGIN');
    await bind(a, { returnId: p3Ret, sourceEntityId: K.entityId, path: [edge], accountId: kWages });
    const removal = removeInclusion(pool, { ...P3, inclusionId: edge });
    assert.equal(await pending(removal), 'waiting', 'the removal waits on the graph lock');
    await a.query('COMMIT');
    await assert.rejects(removal, /accounts are bound on this return/);
  } finally { a.release(); }
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2', [orgId, p3Ret]);
  // 2. The removal first, uncommitted; the binding waits for it, then finds no path.
  const b = await pool.connect();
  try {
    await b.query('BEGIN');
    await b.query('SELECT pg_advisory_xact_lock(74120062, hashint8($1::bigint))', [orgId]);
    await b.query('DELETE FROM activity_inclusion WHERE org_id = $1 AND inclusion_id = $2', [orgId, edge]);
    const write = inTx(c => bind(c, { returnId: p3Ret, sourceEntityId: K.entityId, path: [edge], accountId: kWages }));
    assert.equal(await pending(write), 'waiting', 'the binding waits on the graph lock');
    await b.query('COMMIT');
    assert.match(await write, /only through its inclusion path/);
  } finally { b.release(); }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tax_binding WHERE org_id = $1 AND return_id = $2', [orgId, p3Ret])).rows[0].n, 0, 'never a binding without its edge');
});
