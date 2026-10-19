import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { freshDb } from './harness.js';
import { mvOrg, mvReadyViewers, mvTxn } from './morning-fixtures.js';
import { startApp } from './app-harness.js';
import { trustedActor, ensureOwnerViewer } from '../lib/data/morning/access.js';
import { phoenixDate, phoenixMinute, nextPhoenixMidnight, formatPhoenix, centsFromDb, addCents, subCents, absCents, negCents, sumCents, UnsafeAmountError } from '../lib/data/morning/clock.js';
import { createMorningRuntime, withMorningComputation, withObservingRead, withReadSnapshot, withSecurityWrite, LockBusyError, MorningTimeoutError } from '../lib/data/morning/locks.js';

const barrier = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function dbTest(name, fn) { test(name, async t => {
  const db = await freshDb(); t.after(() => db.drop());
  const f = await mvOrg(db.pool), identities = await mvReadyViewers(db.pool, f);
  const runtime = createMorningRuntime();
  const args = { orgId: f.orgId, viewerKey: 'owner', identity: identities.owner, runtime };
  await fn({ t, pool: db.pool, f, identities, args, runtime });
}); }
test('Phoenix day ignores server and company zones', () => {
  assert.equal(phoenixDate(new Date('2026-10-18T06:30:00Z')), '2026-10-17');
  assert.equal(phoenixDate(new Date('2026-10-18T07:00:00Z')), '2026-10-18');
  assert.equal(phoenixMinute(new Date('2026-10-17T13:30:00Z')), 390);
  assert.equal(nextPhoenixMidnight(new Date('2026-10-17T13:30:00Z')).toISOString(), '2026-10-18T07:00:00.000Z');
  assert.equal(formatPhoenix(new Date('2026-10-20T14:40:00Z')), 'Tuesday 7:40 am America/Phoenix');
});
test('checked cents', () => {
  assert.equal(addCents(9007199254740990, 1), 9007199254740991);
  for (const fn of [() => addCents(9007199254740991, 1), () => centsFromDb('9007199254740992'), () => sumCents([1.5]), () => negCents(Infinity), () => centsFromDb(''), () => centsFromDb(null)]) assert.throws(fn, UnsafeAmountError);
  assert.equal(centsFromDb('-123'), -123); assert.equal(absCents(-9007199254740991), 9007199254740991);
});
test('unsafe subtraction/absolute inputs', () => {
  for (const fn of [() => subCents(9007199254740991, -1), () => absCents(-9007199254740992), () => subCents(-9007199254740991, 1), () => subCents(1.5, 0.5)]) assert.throws(fn, UnsafeAmountError);
});
dbTest('observing read takes its locks before the snapshot', async ({pool, f, args}) => {
  const holder = await pool.connect(), waiting = barrier();
  await holder.query('SELECT pg_advisory_lock(74120065,hashint8($1))', [f.orgId]);
  const read = withObservingRead(pool, {...args, waitMs: 5000, hooks: {beforeQuery: ({text}) => { if (text.includes('pg_advisory_lock_shared')) waiting.resolve(); }}}, tx => tx.query('SELECT count(*)::int AS n FROM txn'));
  await waiting.promise;
  await holder.query('BEGIN');
  await mvTxn(holder, {orgId:f.orgId, entityId:f.entities['Sample company A'], type:'journal_entry', date:'2026-10-17', postings:[{accountId:f.accounts['Sample company A'].checking,cents:100}]});
  await holder.query('COMMIT');
  await holder.query('SELECT pg_advisory_unlock(74120065,hashint8($1))', [f.orgId]); holder.release();
  assert.equal((await read).rows[0].n, 1);
});
const noLocks = async pool => assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n, 0);
for (const nextUse of ['savepoint', 'snapshot']) dbTest(`code-r1 B6: acknowledged BEGIN past deadline cleans up before ${nextUse} reuse`, async ({pool,f,args}) => {
  await assert.rejects(withSecurityWrite(pool, { orgId:f.orgId,waitMs:200,hooks:{beforeQuery:async ({text})=>{
    if(text.startsWith('BEGIN'))await delay(250);
  }} },async ()=>assert.fail('expired writer must not enter work')),LockBusyError);
  if(nextUse==='savepoint'){
    const client=await pool.connect();
    try { await assert.rejects(client.query('SAVEPOINT sample_reuse'),{code:'25P01'}); }
    finally { await client.query('ROLLBACK');client.release(); }
  }else{
    const result=await withReadSnapshot(pool,args,tx=>tx.query('SHOW transaction_isolation'));
    assert.equal(result.rows[0].transaction_isolation,'repeatable read');
  }
  await noLocks(pool);
});
dbTest('lock waits are bounded', async ({pool, f, args}) => {
  const holder = await pool.connect();
  await holder.query('SELECT pg_advisory_lock(74120065,hashint8($1))',[f.orgId]);
  const start = performance.now();
  await assert.rejects(withObservingRead(pool, {...args, waitMs:200}, () => {}), LockBusyError);
  assert.ok(performance.now()-start < 1000);
  await holder.query('SELECT pg_advisory_unlock(74120065,hashint8($1))',[f.orgId]); holder.release(); await noLocks(pool);
});
dbTest('statement timeout', async ({pool,args}) => {
  await assert.rejects(withReadSnapshot(pool, {...args, statementMs:100}, tx => tx.query('SELECT pg_sleep(1)')), e => e instanceof MorningTimeoutError && e.cause?.code === '57014');
  // A timed-out backend is retired; a replacement remains fully reusable.
  await withReadSnapshot(pool,args,tx=>tx.query('SELECT 1')); assert.equal(pool.idleCount,pool.totalCount); await noLocks(pool);
});
dbTest('computation slots', async ({pool,args,identities}) => {
  const entered = barrier(), release = barrier(), entered2 = barrier(), release2 = barrier();
  const first = withMorningComputation(pool,{...args,purpose:'page'},async()=>{entered.resolve();await release.promise;});
  await entered.promise;
  const secondArgs={...args,identity:identities.second,viewerKey:identities.second.viewerKey,purpose:'detail'};
  const second=withMorningComputation(pool,secondArgs,async()=>{entered2.resolve();await release2.promise;}); await entered2.promise;
  const other = await mvOrg(pool,{slug:'third'}), {owner}=await mvReadyViewers(pool,{...other,second:false});
  await assert.rejects(withMorningComputation(pool,{...args,orgId:other.orgId,identity:owner,purpose:'digest',waitMs:50},()=>{}),LockBusyError);
  release.resolve(); await first;
  await withMorningComputation(pool,{...args,orgId:other.orgId,identity:owner,purpose:'digest'},()=>{});
  release2.resolve(); await second;
  let active=0, maximum=0;
  await Promise.all(['page','detail','digest','dismiss'].map((purpose,i)=>withMorningComputation(pool,{...args,purpose,runtime:i%2?createMorningRuntime():args.runtime},async()=>{maximum=Math.max(maximum,++active);await delay(20);active--;})));
  assert.equal(maximum,1); await noLocks(pool);
});
dbTest('observers of one viewer serialize; different viewers do not', async ({pool,args,identities}) => {
  const run=a=>withObservingRead(pool,a,tx=>tx.query('SELECT pg_sleep(0.3)'));
  let start=performance.now();await Promise.all([run(args),run(args)]);assert.ok(performance.now()-start>=600);
  start=performance.now();await Promise.all([run(args),run({...args,identity:identities.second,viewerKey:identities.second.viewerKey})]);assert.ok(performance.now()-start<550);
});
dbTest('both locks consume one acquisition budget', async ({pool,args,f}) => {
  const holder=await pool.connect();
  await holder.query("SELECT pg_advisory_lock(74120066,hashtext($1))",[`${f.orgId}:owner`]);
  let start=performance.now();await assert.rejects(withObservingRead(pool,args,()=>{}),LockBusyError);assert.ok(performance.now()-start<2500);
  await holder.query('SELECT pg_advisory_lock(74120065,hashint8($1))',[f.orgId]);
  const reached=barrier();start=performance.now();
  const read=withObservingRead(pool,{...args,hooks:{beforeQuery:({text})=>{if(text.includes('pg_advisory_lock_shared'))reached.resolve();}}},()=>{});
  const rejected=assert.rejects(read,LockBusyError);await reached.promise;await delay(1500);
  await holder.query('SELECT pg_advisory_unlock(74120065,hashint8($1))',[f.orgId]);
  await rejected; assert.ok(performance.now()-start<2500);
  await holder.query("SELECT pg_advisory_unlock(74120066,hashtext($1))",[`${f.orgId}:owner`]);holder.release();await noLocks(pool);
  await withObservingRead(pool,args,tx=>tx.query('SELECT 1'));
  const c=await pool.connect();assert.equal((await c.query('SHOW lock_timeout')).rows[0].lock_timeout,'0');assert.equal((await c.query('SHOW statement_timeout')).rows[0].statement_timeout,'0');c.release();
});
dbTest('many short statements and CPU deadline',async({pool,args})=>{
  let clock=0,started=0;
  const runtime=createMorningRuntime({mono:()=>clock});
  await assert.rejects(withObservingRead(pool,{...args,runtime,hooks:{beforeQuery:({text})=>{if(text==='SELECT 42')started++;}}},async tx=>{
    for(let i=0;i<6;i++){await tx.query('SELECT 42');clock+=3000;}
  }),MorningTimeoutError);assert.equal(started,5);
  clock=0;let processed=0;
  await assert.rejects(withObservingRead(pool,{...args,runtime},async(tx,{budget})=>{
    for(let i=0;i<512;i++){if(i%256===0){await budget.checkpoint();}processed++;if(i===255)clock=15000;}
  }),MorningTimeoutError);assert.equal(processed,256);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM morning_snapshot_generation')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM morning_visit')).rows[0].n,0);await noLocks(pool);
});
dbTest('client timeout destroys backend and raw keys cannot authorize',async({pool,args})=>{
  let pid,destroyed=false;
  const guarded={async connect(){const c=await pool.connect();return {query:async q=>{if(q.text==='SELECT pg_sleep(1)'){pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return c.query({...q,query_timeout:20});}return c.query(q);},release:broken=>{destroyed=broken;c.release(broken);}};}};
  await assert.rejects(withObservingRead(guarded,args,tx=>tx.query('SELECT pg_sleep(1)')),MorningTimeoutError);assert.equal(destroyed,true);
  assert.notEqual((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pid);
  await assert.rejects(withObservingRead(pool,{orgId:args.orgId,viewerKey:'owner',runtime:args.runtime},()=>{}),/identity|authority|actor/i);
  await assert.rejects(withReadSnapshot(pool,{orgId:args.orgId},()=>{}),/identity|authority|actor/i);
});
dbTest('acknowledged COMMIT succeeds after deadline; expiry before COMMIT rolls back',async({pool,args})=>{
  let clock=0;
  const runtime=createMorningRuntime({mono:()=>clock});
  const guarded={async connect(){const c=await pool.connect();return {query:async q=>{
    const result=await c.query(q);if(q.text==='COMMIT')clock=15000;return result;
  },release:broken=>c.release(broken)};}};
  const generationId=randomUUID(),nextId=randomUUID();
  const save=async(tx,id)=>{
    await tx.query("INSERT INTO morning_snapshot_generation(org_id,viewer_key,generation_id,captured_at,as_of_date) VALUES($1,'owner',$2,'2026-10-17T12:00:00Z','2026-10-17')",[args.orgId,id]);
    await tx.query("INSERT INTO morning_visit(org_id,viewer_key,latest_generation_id,reuse_anchor_at,latest_shown_at) VALUES($1,'owner',$2,'2026-10-17T12:00:00Z','2026-10-17T12:00:00Z') ON CONFLICT(org_id,viewer_key) DO UPDATE SET latest_generation_id=excluded.latest_generation_id",[args.orgId,id]);
    return id;
  };
  assert.equal(await withObservingRead(guarded,{...args,runtime},tx=>save(tx,generationId)),generationId);
  assert.equal((await pool.query('SELECT latest_generation_id FROM morning_visit')).rows[0].latest_generation_id,generationId);
  await noLocks(pool);
  clock=0;
  await assert.rejects(withObservingRead(pool,{...args,runtime,hooks:{beforeCommit:()=>{clock=15000;}}},tx=>save(tx,nextId)),MorningTimeoutError);
  assert.equal((await pool.query('SELECT latest_generation_id FROM morning_visit')).rows[0].latest_generation_id,generationId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM morning_snapshot_generation')).rows[0].n,1);
  await withObservingRead(pool,args,tx=>tx.query('SELECT 1'));await noLocks(pool);
});
test('HTTP shares the supplied process computation runtime',async t=>{
  const runtime=createMorningRuntime({max:1}),app=await startApp({morningRuntime:runtime});t.after(()=>app.close());
  const orgId=app.ids.orgId;await ensureOwnerViewer(app.db.pool,orgId);
  const identity=trustedActor({owner:true},orgId,app.ownerSession),entered=barrier(),release=barrier();
  const held=withMorningComputation(app.db.pool,{identity,orgId,viewerKey:'owner',purpose:'digest',runtime},async()=>{entered.resolve();await release.promise;});
  await entered.promise;
  try {assert.equal((await app.get('/morning')).status,503);}finally{release.resolve();await held;}
  assert.equal((await app.get('/morning')).status,200);
});
dbTest('job authority rechecks eligibility and versions inside the snapshot',async({pool,args})=>{
  const { morningJobAuthority }=await import('../lib/data/morning/locks.js');
  assert.equal(typeof morningJobAuthority,'function');
  const jobAuthority=morningJobAuthority({orgId:args.orgId,viewerKey:'owner',membershipEpoch:1,settingsVersion:1});
  const job={...args,identity:undefined,jobAuthority,purpose:'digest'};
  await assert.rejects(withMorningComputation(pool,job,()=>{}),/eligible/);
  await pool.query("UPDATE morning_preference SET enabled=true,channel='email',email='viewer@sample.example',settings_version=2 WHERE org_id=$1",[args.orgId]);
  job.jobAuthority=morningJobAuthority({orgId:args.orgId,viewerKey:'owner',membershipEpoch:1,settingsVersion:2});
  await withMorningComputation(pool,job,async(tx,{authority})=>{assert.equal(authority.epoch,1);assert.equal((await tx.query('SHOW statement_timeout')).rows[0].statement_timeout,'5s');});
  await pool.query('UPDATE morning_preference SET settings_version=3 WHERE org_id=$1',[args.orgId]);
  await assert.rejects(withMorningComputation(pool,job,()=>{}),/eligible/);
  await assert.rejects(withMorningComputation(pool,{...job,jobAuthority:{...jobAuthority}},()=>{}),/authority/);
});
