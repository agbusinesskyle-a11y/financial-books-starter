import test from 'node:test';
// The volume gate and its oracles build million-row fixtures and run for over an hour: opt-in only (MORNING_PROBE=1),
// never part of npm test. Task 0 and Task 21 run it explicitly.
const probe = process.env.MORNING_PROBE === '1' ? test : (name, ...rest) => test.skip(name, ...rest);
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { freshDb } from './harness.js';
import {
  runProbe, evaluateGate, prepareProbe, seedProbe,
} from '../scripts/morning-probe.mjs';
import {
  prototypeSummary, prototypePairPage, prototypeMemberPage,
  prototypeEntriesPage, prototypeBillsPage, prototypePrepareDetail,
  installGraphFunctions, duplicateOracle, transferOracle,
} from '../scripts/morning-probe-sql.mjs';

const N = '2026-10-17T15:00:00Z';
const admin=new URL(process.env.TEST_DATABASE_URL||'postgres://postgres@127.0.0.1:5499/postgres');
assert.equal(admin.hostname,'127.0.0.1');assert.equal(admin.port,'5499');assert.equal(admin.pathname,'/postgres');
const baselineAt = '2026-07-19T15:00:00Z';
const options = orgId => ({ orgId, N, baselineAt, deadline: performance.now() + 15_000 });

async function fixture(t, scenario, members = 300) {
  const db = await freshDb({ migrate: false });
  t.after(() => db.drop());
  await prepareProbe(db.pool);
  const seed = await seedProbe(db.pool, { historyPostings: 250_000, scenario, members });
  const tx = await db.pool.connect();
  // Drop hooks run in registration order: release this connection first.
  const originalDrop=db.drop;
  db.drop=async()=>{tx.release();await originalDrop();};
  return { db, tx, ...seed };
}

async function summary(tx, orgId, extra = {}) {
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try { return await prototypeSummary(tx, { ...options(orgId), ...extra }); }
  finally { await tx.query('ROLLBACK'); }
}

probe('gate rejects each exact incorrect count, page, statement and latency input', () => {
  const valid = {
    correctness: { passed: true, pairCount: 1_249_975_000, memberCount: 50_000,
      groupCount: 1, bankReview: 5_500, bankPending: 1_000, bills: 3_000, invoices: 3_000 },
    complete: true, repeats: 20, oraclePassed: true, plansComplete: true,
    hot: { p95: 3_000 }, detail: { p95: 2_000, maxRows: 50, maxBytes: 65_536 },
    statements: { financial: 30, total: 42 },
    memory: { smallHeap: 100_000_000, largeHeap: 120_000_000, peakRSS: 400_000_000,
      graphLinear: true, hashRecords: 1, hashStateBytes: 32 },
    payloadBytes: 1_048_576, duplicateBytes: 1_024,
  };
  assert.equal(evaluateGate(valid).pass, true);
  for (const [section, key, value] of [
    ['correctness', 'pairCount', 1_249_974_999],
    ['detail', 'maxRows', 51],
    ['statements', 'financial', 31],
    ['hot', 'p95', 3_001],
  ]) {
    const bad = structuredClone(valid);
    bad[section][key] = value;
    assert.equal(evaluateGate(bad).pass, false, `${section}.${key}`);
  }
  for (const key of ['complete', 'oraclePassed', 'plansComplete']) {
    assert.equal(evaluateGate({ ...valid, [key]: false }).pass, false, key);
  }
  assert.equal(evaluateGate({}).pass, false, 'missing measurements cannot pass');
  assert.equal(evaluateGate({ ...valid, implementation: 'integrated', renderedBytes: 1_048_577 }).pass, false,
    'integrated rendered response must also fit one MiB');
  assert.equal(evaluateGate({ ...valid, implementation: 'integrated' }).pass, false, 'missing rendered measurement cannot pass');
});

probe('integrated adapter invokes the integrated export exactly once and never the prototype', async () => {
  const { invokeProbeImplementation } = await import('../scripts/morning-probe.mjs');
  let integratedCalls = 0, prototypeCalls = 0;
  const input = { kind: 'summary' };
  const result = await invokeProbeImplementation('integrated', {
    integrated: async value => { integratedCalls++; assert.equal(value, input); return 'integrated result'; },
    prototype: async () => { prototypeCalls++; throw new Error('Prototype must never run'); },
  }, input);
  assert.equal(result, 'integrated result');
  assert.equal(integratedCalls, 1);
  assert.equal(prototypeCalls, 0);
  assert.throws(() => invokeProbeImplementation('unknown', {}, input), /Unknown probe implementation/);
});

probe('integrated preparation applies the released migration chain in the exact harness database', async t => {
  const db = await freshDb({ migrate: false });
  t.after(() => db.drop());
  const result = await prepareProbe(db.pool, { implementation: 'integrated' });
  assert.match(result.migrationHash, /^[a-f0-9]{64}$/);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM schema_migrations WHERE name='067_morning_view.sql'")).rows[0].n, 1);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM pg_indexes WHERE indexname='txn_morning_created'")).rows[0].n, 1);
});

probe('integrated EXPLAIN replays empty temp-table DDL as a prerequisite', async t => {
  const { explainIntegratedQueries } = await import('../scripts/morning-probe.mjs');
  const db = await freshDb({ migrate: false }); t.after(() => db.drop());
  const plans = await explainIntegratedQueries(db.pool, [{ kind: 'summary', specs: [
    { name: 'items', text: 'CREATE TEMP TABLE mv_attention (n integer) ON COMMIT DROP', values: [], internalQueries: 0 },
    { name: 'insert', text: 'INSERT INTO mv_attention SELECT $1::integer', values: [7], internalQueries: 0 },
    { name: 'read', text: 'SELECT sum(n) FROM mv_attention', values: [], internalQueries: 0 },
  ] }]);
  assert.deepEqual(plans.map(p => p.name), ['insert', 'read']);
  assert.ok(plans.every(p => p.plan[0]['Execution Time'] >= 0));
});

probe('integrated fixture supports two warmed workers on the same dense database', async t => {
  const db = await freshDb({ migrate: false });
  t.after(() => db.drop());
  await prepareProbe(db.pool, { implementation: 'integrated' });
  await seedProbe(db.pool, { historyPostings: 1_000_000, scenario: 'dense', members: 50_000 });
  const execute = promisify(execFile);
  // One cold-process warm-up followed by two independent warmed processes.
  // This opt-in setup regression does not replace the twenty-run volume gate.
  for (let repetition = -1; repetition < 2; repetition++) {
    const { stdout } = await execute(process.execPath, ['--expose-gc',
      fileURLToPath(new URL('../scripts/morning-probe.mjs', import.meta.url)), '--worker',
      JSON.stringify({ implementation: 'integrated', scenario: 'dense' })], {
      env: { ...process.env, MORNING_PROBE_DB: db.url }, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.error, undefined, `worker ${repetition}: ${JSON.stringify(result.error)}`);
    assert.equal(result.model.duplicateSummary.pairCount, 1_249_975_000);
    assert.equal(result.details.length, 6);
  }
});

probe('duplicate exhaustive oracle: 1..6 members, nondecreasing days 0..7, classes 0..2', async t => {
  const db = await freshDb({ migrate: false });
  t.after(() => db.drop());
  const tx = await db.pool.connect();
  const originalDrop=db.drop;
  db.drop=async()=>{tx.release();await originalDrop();};
  await installGraphFunctions(tx);
  const result = await duplicateOracle(tx);
  assert.equal(result.cases, 1_473_738);
  assert.equal(result.componentMismatches, 0);
  assert.equal(result.countMismatches, 0);
  assert.equal(result.pageMismatches, 0);
  assert.equal(result.seedMismatches, 0);
});

probe('transfer exhaustive oracle: 1..5 legs, days 0..4, signs and three entities', async t => {
  const db = await freshDb({ migrate: false });
  t.after(() => db.drop());
  const tx = await db.pool.connect();
  const originalDrop=db.drop;
  db.drop=async()=>{tx.release();await originalDrop();};
  const result = await transferOracle(tx);
  assert.equal(result.cases, 1_078_626);
  assert.equal(result.degreeMismatches, 0);
  assert.equal(result.partnerMismatches, 0);
  assert.equal(result.suggestionMismatches, 0);
});

probe('pair active-lo maxima preserve ID order across days and interleaved classes', async t => {
  const db = await freshDb({ migrate: false });
  t.after(() => db.drop());
  const tx = await db.pool.connect();
  try {
    await installGraphFunctions(tx);
    const ids = [9, 2, 5, 11, 3, 7, 8], days = [0, 1, 1, 1, 2, 7, 7];
    for (const classes of [[1, 1, 2, 1, 2, 1, 2], [1, 2, 2, 2, 2, 2, 2], [1, 1, 1, 1, 1, 1, 1]]) {
      const edges = [];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        if (Math.abs(days[i] - days[j]) <= 5 && classes[i] !== classes[j]) edges.push([Math.min(ids[i], ids[j]), Math.max(ids[i], ids[j])]);
      }
      edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (const after of [null, [1, 99], ...edges, [12, 99]]) for (const limit of [1, 50]) {
        const expected = edges.filter(([lo, hi]) => !after || lo > after[0] || (lo === after[0] && hi > after[1]));
        const { rows: [{ page }] } = await tx.query('SELECT pg_temp.mv_pair_work($1,$2,$3,$4,$5,$6) page',
          [ids, days, classes, after?.[0] ?? null, after?.[1] ?? null, limit]);
        assert.deepEqual(page.pairs.map(p => [p.lo, p.hi]), expected.slice(0, limit));
        assert.deepEqual(page.next, expected.length > limit ? { lo: expected[limit - 1][0], hi: expected[limit - 1][1] } : null);
      }
    }
  } finally { tx.release(); }
});

probe('complete summary counts and dense beginning, middle, end and member pages', async t => {
  const { tx, orgId, memberIds: m } = await fixture(t, 'dense', 50_000);
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const model = await prototypeSummary(tx, options(orgId));
    assert.equal(model.money.vector.length, 400);
    assert.equal(model.counts.bankReview, 5_500);
    assert.equal(model.counts.bankPending, 1_000);
    assert.equal(model.counts.bills, 3_000);
    assert.equal(model.counts.invoices, 3_000);
    assert.equal(model.counts.duplicates, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(model)) <= 1_048_576);
    const group = model.duplicateSummary;
    assert.equal(group.memberCount, 50_000);
    assert.equal(group.pairCount, 1_249_975_000);
    assert.equal(group.seedCount, 1);
    assert.ok(Object.values(group).every(v => v === null || typeof v !== 'object'));
    assert.ok(Buffer.byteLength(JSON.stringify(group)) <= 1_024);
    const get = after => prototypePairPage(tx, {
      groupKey: group.itemKey, after, limit: 50, deadline: performance.now() + 15_000,
    });
    const first = await get(null);
    assert.deepEqual(first.pairs.map(p => [p.lo, p.hi]),
      Array.from({ length: 50 }, (_, i) => [m[0], m[i + 1]]));
    assert.deepEqual(first.next, { lo: m[0], hi: m[50] });
    const middle = await get({ lo: m[24_999], hi: m[25_000] });
    assert.equal(middle.pairs.length, 50);
    assert.deepEqual([middle.pairs[0].lo, middle.pairs[0].hi], [m[24_999], m[25_001]]);
    const last = await get({ lo: m[49_997], hi: m[49_999] });
    assert.deepEqual(last.pairs.map(p => [p.lo, p.hi]), [[m[49_998], m[49_999]]]);
    assert.equal(last.next, null);
    for (const page of [first, middle, last]) {
      assert.ok(page.pairs.length <= 50);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65_536);
    }
    const members = await prototypeMemberPage(tx, {
      groupKey: group.itemKey, after: null, limit: 50, deadline: performance.now() + 15_000,
    });
    assert.deepEqual(members.members.map(row => row.txnId), m.slice(0, 50));
    assert.equal(members.memberCount,50_000);assert.equal(members.pairCount,1_249_975_000);
    const entries=await prototypeEntriesPage(tx,{after:model.entries.next,limit:50,deadline:performance.now()+15_000});
    assert.equal(entries.page.length,50);assert.equal(entries.count,100_001);
    const bills=await prototypeBillsPage(tx,{after:{due:'2026-10-16',txnId:3_000_050},limit:50,deadline:performance.now()+15_000});
    assert.equal(bills.page.length,50);assert.equal(bills.count,3_000);assert.equal(bills.total,30_000_000);
  } finally { await tx.query('ROLLBACK'); }
  for(const kind of ['entries','bills','member']) {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {await prototypePrepareDetail(tx,options(orgId),kind);}
    finally {await tx.query('ROLLBACK');}
  }
});

probe('star exhausted tail uses at most eleven date probes and one active-lo search', async t => {
  const { tx, orgId, memberIds: m } = await fixture(t, 'star', 50_000);
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const model = await prototypeSummary(tx, options(orgId));
    assert.equal(model.duplicateSummary.memberCount, 50_000);
    assert.equal(model.duplicateSummary.pairCount, 49_999);
    const page = await prototypePairPage(tx, {
      groupKey: model.duplicateSummary.itemKey, after: { lo: m[0], hi: m[49_999] },
      limit: 50, deadline: performance.now() + 15_000,
    });
    assert.deepEqual(page.pairs, []);
    assert.equal(page.next, null);
    assert.ok(page.work.listProbes <= 11);
    assert.ok(page.work.activeLoSearches <= 1);
  } finally { await tx.query('ROLLBACK'); }
});

probe('two classes retain 625000000 pairs through a 100000-node ineligible chain', async t => {
  const { tx, orgId, memberIds: m } = await fixture(t, 'two-class-chain', 50_000);
  const model = await summary(tx, orgId);
  assert.equal(model.counts.duplicates, 1);
  assert.equal(model.duplicateSummary.memberCount, 50_000);
  assert.equal(model.duplicateSummary.pairCount, 625_000_000);
  await tx.query('UPDATE txn SET source_txn_id = $1 WHERE txn_id = $2', [m[0], m[25_000]]);
  assert.equal((await summary(tx, orgId)).counts.duplicates, 0);
});

probe('restricted partition version changes only when member connectivity changes', async t => {
  const { tx, orgId, memberIds: m, lowerIntermediateId } = await fixture(t, 'partition', 4);
  const before = (await summary(tx, orgId)).duplicateSummary;
  assert.equal(before.pairCount, 5);
  await tx.query('UPDATE txn SET source_txn_id = $1 WHERE txn_id = $2', [m[0], m[2]]);
  const changed = (await summary(tx, orgId)).duplicateSummary;
  assert.equal(changed.pairCount, 3);
  assert.equal(changed.itemKey, before.itemKey);
  assert.notEqual(changed.version, before.version);
  await tx.query('UPDATE txn SET source_txn_id = $1 WHERE txn_id = $2', [lowerIntermediateId, m[0]]);
  const intermediate = (await summary(tx, orgId)).duplicateSummary;
  assert.equal(intermediate.version, changed.version);
});

probe('same backend reuse and display limit/threshold leave full facts invariant', async t => {
  const { tx, orgId } = await fixture(t, 'dense');
  const a = await summary(tx, orgId, { limit: 1, thresholdCents: 0 });
  const b = await summary(tx, orgId, { limit: 50, thresholdCents: 9_000_000 });
  assert.deepEqual(b.duplicateSummary, a.duplicateSummary);
  assert.deepEqual(b.counts, a.counts);
  // A bank item is ordered after the first fifty overdue documents. Matching
  // dismissal must still remove its full counts, including pending, everywhere.
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  let bank;
  try {
    await prototypeSummary(tx, options(orgId));
    bank=(await tx.query("SELECT * FROM mv_attention WHERE rule='bank' ORDER BY item_key LIMIT 1")).rows[0];
  } finally {await tx.query('ROLLBACK');}
  await tx.query(`INSERT INTO morning_dismissal(org_id,viewer_key,item_key,item_version,rule_version)
    VALUES($1,'owner',$2,$3,1)`,[orgId,bank.item_key,bank.version]);
  const folded=await summary(tx,orgId,{limit:1});
  assert.equal(folded.counts.bankReview,a.counts.bankReview-bank.facts.needsReviewCount);
  assert.equal(folded.counts.bankPending,a.counts.bankPending-bank.facts.pendingCount);
  assert.equal(folded.counts.active,a.counts.active-1);
  assert.equal(folded.counts.dismissed,1);
  await tx.query("DELETE FROM morning_dismissal WHERE org_id=$1",[orgId]);
  // Non-USD bank facts stay in a separate row and never enter the USD amount.
  await tx.query("UPDATE bank_feed_item SET currency='EUR' WHERE item_id=1");
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await prototypeSummary(tx,options(orgId));
    const rows=(await tx.query("SELECT facts FROM mv_attention WHERE rule='bank' AND entity_id=1 ORDER BY facts->>'currency'")).rows;
    assert.equal(rows.length,2);assert.equal(rows[0].facts.currency,'EUR');
    assert.equal(rows[0].facts.outflowCents,'100');assert.equal(rows[1].facts.currency,'USD');
    assert.equal(rows[1].facts.outflowCents,'27400');
  } finally {await tx.query('ROLLBACK');}
});

probe('volume gate measures paired histories in isolated processes without changing current facts', async () => {
  const result = await runProbe({ repeats: 20, implementation: 'integrated' });
  assert.equal(result.pass, true, JSON.stringify(result.failures));
  assert.equal(result.correctness.historiesEqual, true);
  assert.ok(result.memory.largeHeap <= 1.2 * result.memory.smallHeap);
  assert.ok(result.memory.largeHeap <= 256 * 1024 * 1024);
  assert.ok(result.memory.peakRSS <= 512 * 1024 * 1024);
  assert.ok(result.hot.p95 <= 3_000);
  assert.ok(result.detail.p95 <= 2_000);
  assert.ok(result.statements.financial <= 30);
  assert.ok(result.payloadBytes <= 1_048_576);
  assert.ok(result.renderedBytes <= 1_048_576);
});
