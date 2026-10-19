import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { freshDb } from './harness.js';
import { mvOrg, mvReadyViewers } from './morning-fixtures.js';
import { withObservingRead, withReadSnapshot, withSecurityWrite, createMorningRuntime } from '../lib/data/morning/locks.js';
import { phoenixDate } from '../lib/data/morning/clock.js';
import { readVisit, decideComparison, loadGeneration, persistObservation, pruneGenerations } from '../lib/data/morning/observe.js';
import { makeCursor } from '../lib/data/morning/cursor.js';
import { morningRoutes } from '../services/app/morning-routes.js';

const N0=new Date('2026-10-17T13:00:00Z'),at=ms=>new Date(N0.getTime()+ms),hour=3600000,day=86400000;
const barrier=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function observeTest(name,fn){test(name,async t=>{
  const db=await freshDb();t.after(()=>db.drop());const f=await mvOrg(db.pool),{owner}=await mvReadyViewers(db.pool,{...f,second:false});
  const args={orgId:f.orgId,viewerKey:'owner',identity:owner};
  const vector={companies:Object.entries(f.entities).map(([name,entityId])=>({entityId,name,isPersonal:false})),accounts:[{accountId:f.accounts['Sample company A'].checking,entityId:f.entities['Sample company A'],name:'Checking',type:'bank',active:true,signedCents:1000}]};
  const inspect=async()=>({visits:(await db.pool.query('SELECT * FROM morning_visit ORDER BY viewer_key')).rows,generations:(await db.pool.query('SELECT * FROM morning_snapshot_generation ORDER BY captured_at')).rows});
  const read=fn2=>withReadSnapshot(db.pool,{...args,runtime:createMorningRuntime()},fn2);
  const observe=(N,{complete=true,renderThrows=false,value=vector,hooks={},loaded}={})=>withObservingRead(db.pool,{...args,runtime:createMorningRuntime({wall:()=>N}),hooks},async(tx,{N:captured,budget})=>{
    const visit=await readVisit(tx,args),decision=decideComparison(visit,captured);
    const baseline=decision.comparisonId?await loadGeneration(tx,{...args,generationId:decision.comparisonId}):null;
    if(loaded)await loaded(tx);
    if(renderThrows)throw new Error('Sample render failure');const html='<p>Sample rendered response</p>';budget.check();
    const saved=complete&&decision.mode!=='clock_unavailable'?await persistObservation(tx,{...args,N:captured,today:phoenixDate(captured),vector:value,visit,decision}):null;
    return {decision,baseline,saved,html};
  });
  await fn({pool:db.pool,f,args,vector,observe,inspect,read});
});}
observeTest('first look',async c=>{const r=await c.observe(N0),v=await c.read(tx=>readVisit(tx,c.args));assert.equal(r.decision.mode,'first_look');assert.equal(v.comparisonId,null);assert.equal(v.latestId,r.saved.generationId);assert.deepEqual(v.anchorAt,N0);assert.deepEqual(v.latestShownAt,N0);assert.deepEqual(v.latestAt,N0);});
observeTest('observation state and persistence each use one statement',async c=>{
  const {readObservation}=await import('../lib/data/morning/observe.js');
  assert.equal(typeof readObservation,'function');
  for(const N of [N0,at(hour-1),at(hour),at(hour+1)]){
    await c.read(async raw=>{
      let statements=0;
      const tx={...raw,query:(...args)=>{statements++;return raw.query(...args);}};
      const state=await readObservation(tx,{...c.args,N});
      assert.equal(statements,1);
      const expected=await readVisit(raw,c.args);
      assert.deepEqual(state.visit,expected);
      assert.deepEqual(state.decision,decideComparison(expected,N));
      assert.deepEqual(state.comparison,state.decision.comparisonId?await loadGeneration(raw,{...c.args,generationId:state.decision.comparisonId}):null);
      assert.equal(state.preference.detail_threshold_cents,50000);
      statements=0;
      const saved=await persistObservation(tx,{...c.args,N,today:phoenixDate(N),vector:c.vector,...state});
      assert.equal(statements,1);
      statements=0;
      const generation=await loadGeneration(tx,{...c.args,generationId:saved.generationId});
      assert.equal(statements,1);
      assert.deepEqual(generation.accounts,c.vector.accounts);
    });
  }
});
observeTest('reloads inside the hour keep comparison and anchor',async c=>{await c.observe(N0);const r=await c.observe(at(hour-1000)),v=await c.read(tx=>readVisit(tx,c.args));assert.equal(r.decision.mode,'reuse');assert.equal(v.comparisonId,null);assert.equal(v.latestId,r.saved.generationId);assert.deepEqual(v.anchorAt,N0);});
observeTest('exactly sixty minutes promotes',async c=>{await c.observe(N0);const g2=await c.observe(at(hour-1000)),g3=await c.observe(at(hour)),v=await c.read(tx=>readVisit(tx,c.args));assert.equal(g3.decision.mode,'promote');assert.equal(v.comparisonId,g2.saved.generationId);assert.equal(v.latestId,g3.saved.generationId);assert.deepEqual(v.anchorAt,at(hour));});
observeTest('non-sliding',async c=>{await c.observe(N0);const g2=await c.observe(at(hour-1000));await c.observe(at(hour));const g4=await c.observe(at(90*60000)),v=await c.read(tx=>readVisit(tx,c.args));assert.equal(g4.decision.mode,'reuse');assert.equal(v.comparisonId,g2.saved.generationId);assert.equal(v.latestId,g4.saved.generationId);assert.deepEqual(v.anchorAt,at(hour));});
observeTest('incomplete observation advances nothing',async c=>{await c.observe(N0);const before=await c.inspect();await c.observe(at(hour),{complete:false});assert.deepEqual(await c.inspect(),before);});
observeTest('clock regression',async c=>{await c.observe(N0);const before=await c.inspect(),r=await c.observe(at(-1));assert.equal(r.decision.mode,'clock_unavailable');assert.deepEqual(await c.inspect(),before);await assert.rejects(c.read(async tx=>persistObservation(tx,{...c.args,N:at(-1),today:'2026-10-17',vector:c.vector,visit:await readVisit(tx,c.args),decision:r.decision})),/clock/i);});
observeTest('simultaneous first visits serialize',async c=>{
  const entered=barrier(),release=barrier();const first=c.observe(N0,{loaded:async()=>{entered.resolve();await release.promise;}});await entered.promise;const second=c.observe(at(1000));release.resolve();const [g1,g2]=await Promise.all([first,second]);
  assert.notEqual(g1.saved.generationId,g2.saved.generationId);const state=await c.inspect();assert.equal(state.generations.length,2);assert.equal(state.visits[0].comparison_generation_id,null);assert.deepEqual(state.visits[0].reuse_anchor_at,N0);assert.equal(state.visits[0].latest_generation_id,g2.saved.generationId);
});
observeTest('render failure rolls back',async c=>{await c.observe(N0);const before=await c.inspect();await assert.rejects(c.observe(at(hour),{renderThrows:true}),/render failure/);assert.deepEqual(await c.inspect(),before);});
observeTest('the exact vector is persisted',async c=>{
  await c.pool.query("DELETE FROM account WHERE org_id=$1 AND entity_id=$2 AND type IN ('bank','credit_card')",[c.f.orgId,c.f.entities['Sample company B']]);
  const old=(await c.pool.query("INSERT INTO account(org_id,entity_id,name,type,active) VALUES($1,$2,'Sample inactive bank','bank',false) RETURNING account_id",[c.f.orgId,c.f.entities['Sample company A']])).rows[0].account_id;
  const vector={...c.vector,accounts:[...c.vector.accounts,{accountId:old,entityId:c.f.entities['Sample company A'],name:'Sample inactive bank',type:'bank',active:false,signedCents:0}]};
  const result=await c.observe(N0,{value:vector});const saved=await c.read(tx=>loadGeneration(tx,{...c.args,generationId:result.saved.generationId}));assert.deepEqual(saved.accounts,vector.accounts);assert.deepEqual(saved.companies,vector.companies);assert.equal(saved.accounts[0].signedCents,1000); // live postings are zero
  assert.equal(await c.read(tx=>loadGeneration(tx,{...c.args,generationId:randomUUID()})),null);
  assert.equal(await c.read(tx=>loadGeneration(tx,{...c.args,viewerKey:'999999',generationId:result.saved.generationId})),null);
});
observeTest('pruning keeps C and L',async c=>{
  for(let i=0;i<4;i++)await c.observe(at(-100*day+i*hour));const before=await c.inspect(),v=before.visits[0];
  const count=await withSecurityWrite(c.pool,{orgId:c.f.orgId},tx=>pruneGenerations(tx,{orgId:c.f.orgId,now:N0}));assert.equal(count,2);
  assert.deepEqual(new Set((await c.inspect()).generations.map(g=>g.generation_id)),new Set([v.comparison_generation_id,v.latest_generation_id]));
});
observeTest('a viewer returning after 90 days compares to the retained L',async c=>{const r=await c.observe(at(-120*day));await withSecurityWrite(c.pool,{orgId:c.f.orgId},tx=>pruneGenerations(tx,{orgId:c.f.orgId,now:N0}));const v=await c.read(tx=>readVisit(tx,c.args));assert.deepEqual(decideComparison(v,N0),{mode:'promote',comparisonId:r.saved.generationId});});
observeTest('commit failure',async c=>{
  await c.observe(N0);const before=await c.inspect();
  await assert.rejects(c.observe(at(hour),{hooks:{beforeCommit:({tx})=>tx.query("UPDATE morning_visit SET comparison_generation_id=$2 WHERE org_id=$1 AND viewer_key='owner'",[c.f.orgId,randomUUID()])}}),e=>e.code==='23503');
  assert.deepEqual(await c.inspect(),before);const next=await c.observe(at(hour));assert.equal(next.decision.comparisonId,before.visits[0].latest_generation_id);assert.equal((await c.inspect()).visits[0].visit_version,2);
});
observeTest('unavailable recovery',async c=>{
  const value=n=>({...c.vector,accounts:c.vector.accounts.map(a=>({...a,signedCents:n}))});await c.observe(N0);const g2=await c.observe(at(hour),{value:value(1500)}),before=await c.inspect();
  const failed=await c.observe(at(2*hour),{complete:false,value:value(1700),loaded:async tx=>{await tx.query('SAVEPOINT required_loader');await assert.rejects(tx.query('SELECT 1/0'));await tx.query('ROLLBACK TO SAVEPOINT required_loader');}});
  assert.equal(failed.decision.comparisonId,g2.saved.generationId);assert.deepEqual(await c.inspect(),before);
  const recovered=await c.observe(at(2*hour+1000),{value:value(2000)});assert.equal(recovered.decision.comparisonId,g2.saved.generationId);assert.equal(recovered.baseline.accounts[0].signedCents,1500);const v=await c.inspect();assert.equal(v.visits[0].visit_version,3);assert.equal((await c.read(tx=>loadGeneration(tx,{...c.args,generationId:v.visits[0].latest_generation_id}))).accounts[0].signedCents,2000);
});
observeTest('120-day pointers remain and a cursor to a pruned generation gets 409',async c=>{
  const generations=[];for(let i=0;i<4;i++)generations.push((await c.observe(at(-120*day+i*hour))).saved.generationId);
  await withSecurityWrite(c.pool,{orgId:c.f.orgId},tx=>pruneGenerations(tx,{orgId:c.f.orgId,now:N0}));
  assert.equal((await c.inspect()).generations.length,2);const secret=randomBytes(32),identity=c.args.identity;
  const token=makeCursor(secret,{sid:identity.sessionId,vk:'owner',epoch:1,gen:generations[0],kind:'entries',resource:null,iat:N0.getTime()});
  await assert.rejects(morningRoutes({req:{method:'GET'},path:'/morning/entries',query:{c:token},pool:c.pool,identity,route:{route:'entries'},cursorSecret:secret,now:()=>N0,runtime:createMorningRuntime()}),e=>e.status===409);
});
