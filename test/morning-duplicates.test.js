import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { mvOrg,mvReadyViewers,mvVendor,mvCustomer,mvTxn,mvApply } from './morning-fixtures.js';
import { withReadSnapshot,createMorningRuntime } from '../lib/data/morning/locks.js';
import { prepareItems } from '../lib/data/morning/items.js';
import { buildDuplicateItems,duplicateGroups,duplicateMembersPage,duplicatePairsPage } from '../lib/data/morning/duplicates.js';
import * as graph from '../lib/data/morning/graph-sql.js';
import * as accepted from '../scripts/morning-probe-sql.mjs';
const A='Sample company A',today='2026-10-17',window={from:new Date('2026-10-17T12:00Z'),to:new Date('2026-10-17T15:00Z')};
test('relationship components preserve dense and sparse endpoint lookup and refusals',async t=>{
  const db=await freshDb({migrate:false});t.after(()=>db.drop());const tx=await db.pool.connect();
  try{
    await tx.query(graph.componentFunction.text);
    for(const vertices of [[1,2,3,4,5,6],[1,2,3,10000000000,10000000001,10000000002]]){
      const a=[vertices[0],vertices[2],vertices[4]],b=[vertices[2],vertices[4],vertices[5]];
      const labels=(await tx.query('SELECT pg_temp.mv_components($1,$2,$3) labels',[vertices,a,b])).rows[0].labels.map(Number);
      assert.deepEqual(labels,[vertices[0],vertices[1],vertices[0],vertices[3],vertices[0],vertices[0]]);
    }
    for(const missing of [0,3,10000000000,null])await assert.rejects(tx.query('SELECT pg_temp.mv_components($1,$2,$3)',[[1,2,4],[1],[missing]]),/edge endpoint outside vertices/);
    await assert.rejects(tx.query('SELECT pg_temp.mv_components($1,$2,$3)',[[2,1],[],[]]),/strictly increasing/);
  }finally{tx.release();}
});
function dupTest(name,fn){test(name,async t=>{const db=await freshDb();t.after(()=>db.drop());const f=await mvOrg(db.pool,{companies:[A]}),{owner}=await mvReadyViewers(db.pool,{...f,second:false}),entityId=f.entities[A],a=f.accounts[A];const vendorId=await mvVendor(db.pool,{orgId:f.orgId,entityId,name:'Sample vendor D'});
  const base={orgId:f.orgId,today,window},run=(work,hooks={},pool=db.pool)=>withReadSnapshot(pool,{orgId:f.orgId,viewerKey:'owner',identity:owner,runtime:createMorningRuntime(),hooks},work);
  const add=(date=today,seed=true,extra={})=>mvTxn(db.pool,{orgId:f.orgId,entityId,type:'check',vendorId,date,createdAt:new Date(seed?'2026-10-17T13:00Z':`${date}T10:00Z`),postings:[{accountId:a.checking,cents:-40000}],...extra});
  const bill=()=>add('2026-10-01',false,{type:'bill',postings:[{accountId:a.ap,cents:-100000}]});
  const apply=(creditTxnId,chargeTxnId,on='2026-10-12',extra={})=>mvApply(db.pool,{orgId:f.orgId,creditTxnId,chargeTxnId,on,cents:1,...extra});
  const build=async(tx,extra={})=>{const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget:tx});const result=await buildDuplicateItems(tx,{...base,store,budget:tx,...extra});return {store,result};};
  const groups=()=>run(async tx=>{const {store}=await build(tx);return (await duplicateGroups(tx,{store})).page;});
  const linked=async()=>{const x=await bill(),y=await bill(),p=await add('2026-10-10',false),q=await add('2026-10-12'),r=await add('2026-10-14',false);await apply(p,x,'2026-10-10');await apply(q,x);await apply(q,y,'2026-10-30');await apply(r,y,'2026-10-14');return {x,y,p,q,r};};
  const bulk=async(n,scenario='dense')=>{const tx=await db.pool.connect(),chain=scenario==='two-class'?100000:1,b=200000;try{await tx.query('BEGIN');const q=(text,values)=>tx.query({text,values,query_timeout:300000});
    await q(`INSERT INTO txn(org_id,entity_id,txn_id,type,txn_date,total_cents,open_cents,source_txn_id,created_at,updated_at) OVERRIDING SYSTEM VALUE
      SELECT $1,$2,g,'journal_entry',CASE WHEN g%2=0 THEN DATE '2021-10-17' ELSE DATE '2027-10-17' END,0,0,CASE WHEN g>1 THEN g-1 END,'2021-01-01','2021-01-01' FROM generate_series(1,$3::int) g`,[f.orgId,entityId,chain]);
    await q(`INSERT INTO txn(org_id,entity_id,txn_id,type,vendor_id,account_id,txn_date,total_cents,open_cents,source_txn_id,created_at,updated_at) OVERRIDING SYSTEM VALUE
      SELECT $1,$2,$3::int+g,'check',$4,$5,'2026-10-17',40000,0,CASE WHEN $7='star' AND g>1 THEN 1 WHEN $7='two-class' AND g<=$6/2 THEN 1 WHEN $7='two-class' AND g>$6/2+1 THEN $3+$6/2+1 END,
      CASE WHEN $7='dense' OR g=1 THEN TIMESTAMPTZ '2026-10-17T13:00Z' ELSE TIMESTAMPTZ '2026-01-01' END,'2026-01-01' FROM generate_series(1,$6::int) g`,[f.orgId,entityId,b,vendorId,a.checking,n,scenario]);
    await q('ANALYZE txn');await q(`INSERT INTO posting(org_id,entity_id,txn_id,line_no,account_id,amount_cents,txn_date,vendor_id)
      SELECT $1,$2,$3::int+g,l,CASE WHEN l=1 THEN $4::bigint ELSE $5::bigint END,CASE WHEN l=1 THEN -40000 ELSE 40000 END,'2026-10-17',$6
      FROM generate_series(1,$7::int) g CROSS JOIN generate_series(1,2) l`,[f.orgId,entityId,b,a.checking,a.offset,vendorId,n]);await q('COMMIT');
    return {first:b+1,last:b+n,mid:b+n/2};
  }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}};
  await fn({db,f,a,entityId,vendorId,base,run,add,bill,apply,build,groups,linked,bulk});});}
dupTest('A–X–B–Y–C produces no group',async c=>{await c.linked();assert.deepEqual(await c.groups(),[]);});
dupTest('bidirectional endpoint inventory retains higher-ID ineligible intermediates',async c=>{
  const p=await c.add(),q=await c.add(),intermediate=await c.bill(),unrelated=await c.add();
  await c.db.pool.query('UPDATE txn SET source_txn_id=$1 WHERE txn_id=ANY($2::bigint[])',[intermediate,[p,q]]);
  await c.run(async tx=>{
    const {store}=await c.build(tx),[g]=(await duplicateGroups(tx,{store})).page;
    assert.deepEqual([g.memberCount,g.pairCount],[3,2]);
    const page=await duplicatePairsPage(tx,{...c.base,groupKey:g.itemKey,budget:tx});
    assert.deepEqual(page.pairs.map(r=>[r.lo,r.hi]),[[p,unrelated],[q,unrelated]]);
  });
});
dupTest('A–C excluded; an unrelated peer still qualifies',async c=>{const r=await c.linked(),d=await c.add('2026-10-13',false);await c.run(async tx=>{const {store}=await c.build(tx),g=(await duplicateGroups(tx,{store})).page;assert.equal(g.length,1);assert.deepEqual([g[0].memberCount,g[0].pairCount,g[0].seedCount],[4,3,1]);const p=await duplicatePairsPage(tx,{...c.base,groupKey:g[0].itemKey,budget:tx});assert.deepEqual(p.pairs.map(x=>[x.lo,x.hi]),[r.p,r.q,r.r].map(x=>[Math.min(x,d),Math.max(x,d)]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]));});});

dupTest('detail candidates preserve full groups, line parties and unrestricted relationship closure',async c=>{
  await c.linked();
  await c.add('2026-10-13',false,{vendorId:null,postings:[{accountId:c.a.checking,cents:-40000,vendorId:c.vendorId}]});
  await c.add(today,true,{vendorId:null}); await c.add(today,true,{vendorId:null});
  const other=await mvVendor(c.db.pool,{orgId:c.f.orgId,entityId:c.entityId,name:'Sample vendor conflict'});
  await c.add(today,true,{postings:[{accountId:c.a.checking,cents:-40000,vendorId:other}]});
  await c.add(today,true,{type:'journal_entry',vendorId:null,postings:[{accountId:c.a.checking,cents:-40000},{accountId:c.a.card,cents:40000}]});
  const full=await c.groups();assert.equal(full.length,1);assert.equal(full[0].pairCount,3);
  const results=[];
  for(const detailOnly of [false,true])results.push(await c.run(async tx=>{
    const {store,result}=await c.build(tx,{detailOnly});
    assert.deepEqual((await duplicateGroups(tx,{store})).page,full);
    if(detailOnly)assert.deepEqual(result.coverage,{known:false,scope:'duplicate_candidates'});
    const options={...c.base,groupKey:full[0].itemKey,budget:tx,detailOnly};
    return {members:await duplicateMembersPage(tx,options),pairs:await duplicatePairsPage(tx,options)};
  }));
  assert.deepEqual(results[1],results[0]);
});
dupTest('every relationship kind closes',async c=>{for(const kind of ['via','lines','source_txn_id','deposit_line','po_txn_id','billable_txn_id','estimate_txn_id','deposit_for_txn_id','reverses_txn_id','companion_of_txn_id']){
  const vendorId=await mvVendor(c.db.pool,{orgId:c.f.orgId,entityId:c.entityId,name:`Sample vendor ${kind}`});const p=await c.add(today,true,{vendorId}),q=await c.add(today,false,{vendorId});
  const type=kind==='po_txn_id'?'purchase_order':kind==='deposit_line'?'deposit':kind==='estimate_txn_id'?'estimate':'bill';
  const customerId=type==='estimate'?await mvCustomer(c.db.pool,{orgId:c.f.orgId,entityId:c.entityId,name:'Sample customer A'}):null;
  const i=type==='estimate'?(await c.db.pool.query(`INSERT INTO txn(org_id,entity_id,type,txn_date,customer_id,total_cents,open_cents,estimate_status,created_at,updated_at)
    VALUES($1,$2,'estimate','2026-10-01',$3,0,0,'pending','2026-10-01','2026-10-01') RETURNING txn_id`,[c.f.orgId,c.entityId,customerId])).rows[0].txn_id
    :await c.add('2026-10-01',false,{type,vendorId:type==='deposit'?null:vendorId,postings:type==='purchase_order'?[]:[{accountId:c.a.offset,cents:1}]});
  if(kind==='via'){await c.apply(p,i,today,{viaTxnId:q});}
  else if(kind==='lines'){await c.apply(p,i,today,{creditLineNo:1,chargeLineNo:1});await c.apply(q,i,today,{creditLineNo:1,chargeLineNo:1});}
  else if(kind==='deposit_line'){await c.db.pool.query('INSERT INTO deposit_line(org_id,deposit_txn_id,line_no,amount_cents,source_txn_id) VALUES($1,$2,1,1,$3)',[c.f.orgId,i,p]);await c.apply(q,i);}
  else if(['po_txn_id','billable_txn_id','estimate_txn_id'].includes(kind)){await c.db.pool.query(`INSERT INTO txn_line(org_id,txn_id,line_no,account_id,amount_cents,${kind}) VALUES($1,$2,1,$3,1,$4),($1,$5,1,$3,1,$4)`,[c.f.orgId,p,c.a.offset,i,q]);}
  else if(kind==='deposit_for_txn_id')await c.db.pool.query('UPDATE txn SET deposit_for_txn_id=CASE WHEN txn_id=$1 THEN $2::bigint ELSE $3::bigint END WHERE txn_id=ANY($4::bigint[])',[p,i,q,[p,i]]);
  else await c.db.pool.query(`UPDATE txn SET ${kind}=$1 WHERE txn_id=ANY($2::bigint[])`,[i,[p,q]]);
}assert.deepEqual(await c.groups(),[]);});
dupTest('five posting days inclusive',async c=>{await c.add();const peer=await c.add('2026-10-12',false);assert.equal((await c.groups()).length,1);const tx=await c.db.pool.connect();try{await tx.query('BEGIN');await tx.query("UPDATE txn SET txn_date='2026-10-11' WHERE txn_id=$1",[peer]);await tx.query("UPDATE posting SET txn_date='2026-10-11' WHERE txn_id=$1",[peer]);await tx.query('COMMIT');}finally{tx.release();}assert.deepEqual(await c.groups(),[]);});
dupTest('families and parties',async c=>{await c.add(today,true,{type:'cc_credit',postings:[{accountId:c.a.card,cents:40000}]});await c.add(today,true,{postings:[{accountId:c.a.card,cents:-40000}]});await c.add(today,true,{vendorId:null});await c.add(today,true,{vendorId:null});const customerId=await mvCustomer(c.db.pool,{orgId:c.f.orgId,entityId:c.entityId,name:'Sample party E'}),vendorId=await mvVendor(c.db.pool,{orgId:c.f.orgId,entityId:c.entityId,name:'Sample party E'});await c.add(today,true,{type:'journal_entry',vendorId:null,postings:[{accountId:c.a.checking,cents:-40000,customerId}]});await c.add(today,true,{type:'journal_entry',vendorId:null,postings:[{accountId:c.a.checking,cents:-40000,vendorId}]});assert.deepEqual(await c.groups(),[]);});
dupTest('isolated and seedless',async c=>{await c.add();const vendorId=await mvVendor(c.db.pool,{orgId:c.f.orgId,entityId:c.entityId,name:'Sample vendor old'});await c.add('2026-10-10',false,{vendorId});await c.add('2026-10-11',false,{vendorId});assert.deepEqual(await c.groups(),[]);});
dupTest('a chained set does not assert all-pairs closeness',async c=>{await c.add('2026-10-03',false);await c.add('2026-10-08',false);await c.add('2026-10-13');const [g]=await c.groups();assert.deepEqual([g.memberCount,g.pairCount,g.firstDate,g.lastDate],[3,2,'2026-10-03','2026-10-13']);});
dupTest('dense group, exact counts, bounded pages',async c=>{const ids=await c.bulk(300);await c.run(async tx=>{const {store}=await c.build(tx);const [g]=(await duplicateGroups(tx,{store})).page;assert.deepEqual([g.memberCount,g.pairCount],[300,44850]);assert.ok(Object.values(g).every(x=>x===null||['string','number','boolean'].includes(typeof x)));const opts={...c.base,groupKey:g.itemKey,budget:tx};let p=await duplicatePairsPage(tx,opts);assert.deepEqual(p.pairs.map(x=>[x.lo,x.hi]),Array.from({length:50},(_,i)=>[ids.first,ids.first+i+1]));assert.deepEqual(p.next,{lo:ids.first,hi:ids.first+50});p=await duplicatePairsPage(tx,{...opts,after:p.next});assert.deepEqual([p.pairs[0].lo,p.pairs[0].hi],[ids.first,ids.first+51]);const m=await duplicateMembersPage(tx,opts);assert.deepEqual(m.members.map(x=>x.txnId),Array.from({length:50},(_,i)=>ids.first+i));});});
dupTest('version: stable for irrelevant intermediates, changes with the partition',async c=>{const linked=await c.linked(),d=await c.add('2026-10-13',false),[before]=await c.groups();await c.bill();assert.equal((await c.groups())[0].version,before.version);await c.apply(d,linked.x);assert.deepEqual(await c.groups(),[]);});
dupTest('paging and display thresholds do not change groups',async c=>{await c.bulk(300);const before=await c.groups();for(const limit of [5,50])await c.run(async tx=>{const {store}=await c.build(tx);assert.deepEqual((await duplicateGroups(tx,{store})).page,before);assert.equal((await duplicateMembersPage(tx,{...c.base,groupKey:before[0].itemKey,limit,budget:tx})).members.length,limit);});await c.db.pool.query("UPDATE morning_preference SET detail_threshold_cents=9000000,settings_version=settings_version+1 WHERE org_id=$1",[c.f.orgId]);assert.deepEqual(await c.groups(),before);});
let smallCount;
for(const size of [300,50000])dupTest(`bounded statements (${size})`,async c=>{await c.bulk(size);let count=0,roundTrips=0;
  const measuredPool={connect:async()=>{const client=await c.db.pool.connect();return {query(...args){roundTrips++;return client.query(...args);},release:(...args)=>client.release(...args)};}};
  await c.run(async tx=>{const {store}=await c.build(tx),[g]=(await duplicateGroups(tx,{store})).page;await duplicateMembersPage(tx,{...c.base,groupKey:g.itemKey,budget:tx});await duplicatePairsPage(tx,{...c.base,groupKey:g.itemKey,budget:tx});},{beforeQuery:({text})=>{if(/^(SELECT|WITH|CREATE TEMP|CREATE INDEX|INSERT|UPDATE|DELETE)/i.test(text.trim())&&!/^SELECT (pg_advisory_|set_config)/i.test(text.trim()))count++;}},measuredPool);count+=2; // ordered hash input + pair index's ordered SELECT (accepted internal statement accounting)
  assert.ok(count<=30,`financial statements ${count}`);if(size===300)smallCount={count,roundTrips};else assert.deepEqual({count,roundTrips},smallCount);console.log(`duplicate build, folds, members, pairs: ${count} financial statements, ${roundTrips} total round trips at ${size} members`);
});
dupTest('a gone group',async c=>{await c.add();await c.run(async tx=>{await c.build(tx);assert.deepEqual(await duplicateMembersPage(tx,{...c.base,groupKey:`duplicate:${c.entityId}:${'0'.repeat(64)}`,budget:tx}),{gone:true});await assert.rejects(duplicateMembersPage(tx,{...c.base,orgId:c.f.orgId+1,groupKey:'sample',budget:tx}),e=>e.status===409);await assert.rejects(duplicatePairsPage(tx,{...c.base,window:{...window,from:new Date('2026-10-16')},groupKey:'sample',budget:tx}),e=>e.status===409);for(const limit of [0,51])await assert.rejects(duplicatePairsPage(tx,{...c.base,groupKey:'sample',limit,budget:tx}));});});
dupTest('excluded tail',async c=>{const ids=await c.bulk(50000,'star');await c.run(async tx=>{const {store}=await c.build(tx);const [g]=(await duplicateGroups(tx,{store})).page;assert.deepEqual([g.memberCount,g.pairCount],[50000,49999]);const opts={...c.base,groupKey:g.itemKey,budget:tx};const tail=await duplicatePairsPage(tx,{...opts,after:{lo:ids.first,hi:ids.last}});assert.deepEqual(tail.pairs,[]);assert.equal(tail.next,null);assert.ok(tail.work.listProbes<=11);assert.ok(tail.work.activeLoSearches<=1);const mid=await duplicatePairsPage(tx,{...opts,after:{lo:ids.first,hi:ids.mid}});assert.deepEqual(mid.pairs.map(p=>[p.lo,p.hi]),Array.from({length:50},(_,i)=>[ids.first,ids.mid+i+1]));console.log('excluded-tail work',tail.work);});});
dupTest('partition stability while group survives',async c=>{const lower=await c.bill(),ids=[];for(let i=0;i<4;i++)ids.push(await c.add());await c.db.pool.query('UPDATE txn SET source_txn_id=$1 WHERE txn_id=$2',[ids[0],ids[1]]);const [before]=await c.groups();assert.equal(before.pairCount,5);await c.db.pool.query('UPDATE txn SET source_txn_id=$1 WHERE txn_id=$2',[ids[0],ids[2]]);const [merged]=await c.groups();assert.equal(merged.pairCount,3);assert.equal(merged.itemKey,before.itemKey);assert.notEqual(merged.version,before.version);await c.db.pool.query('UPDATE txn SET source_txn_id=$1 WHERE txn_id=$2',[lower,ids[0]]);assert.equal((await c.groups())[0].version,merged.version);});
test('oracle: accepted graph definitions and exhaustive small cases',async t=>{const db=await freshDb();t.after(()=>db.drop());const tx=await db.pool.connect();try{await tx.query('BEGIN');await tx.query("SET LOCAL statement_timeout='5s'");for(const name of ['componentFunction','candidateFunction','upperFunction','pairFunction','pairPageFunction','hashFunction'])assert.equal(graph[name].text,accepted[name].text);await graph.installGraphFunctions(tx);const r=await accepted.duplicateOracle(tx);assert.deepEqual(r,{cases:1473738,componentMismatches:0,countMismatches:0,pageMismatches:0,seedMismatches:0});await tx.query('COMMIT');}finally{await tx.query('ROLLBACK');tx.release();}});
dupTest('long ineligible chain, two classes and first look',async c=>{const ids=await c.bulk(50000,'two-class');await c.db.pool.query("UPDATE morning_preference SET detail_threshold_cents=9000000,settings_version=settings_version+1 WHERE org_id=$1",[c.f.orgId]);await c.run(async tx=>{const {store,result}=await c.build(tx);assert.equal(result.groupCount,1);const [g]=(await duplicateGroups(tx,{store})).page;assert.deepEqual([g.memberCount,g.pairCount,g.seedCount],[50000,625000000,1]);const p=await duplicatePairsPage(tx,{...c.base,groupKey:g.itemKey,budget:tx});assert.deepEqual(p.pairs.map(x=>[x.lo,x.hi]),Array.from({length:50},(_,i)=>[ids.first,ids.mid+1+i]));assert.equal(p.pairs.length,50);});await c.run(async tx=>{const {store,result}=await c.build(tx,{window:null});assert.equal(result.groupCount,0);assert.equal(result.skipped,'first_look');assert.equal((await duplicateGroups(tx,{store})).page.length,0);});});
dupTest('same backend reuse replaces temporary functions and rebuilds facts',async c=>{await c.add();await c.add();const client=await c.db.pool.connect();try{let backend;for(let i=0;i<2;i++){await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;backend??=pid;assert.equal(pid,backend);const tx={query:(...args)=>client.query(...args),check(){},async checkpoint(){}};const {store}=await c.build(tx);assert.equal((await duplicateGroups(tx,{store})).page[0].pairCount,1);await client.query('COMMIT');}}finally{await client.query('ROLLBACK');client.release();}});
dupTest('unsupported home and document/posting disagreement cannot create duplicate matches',async c=>{await c.add(today,true,{docDate:'2026-10-16'});await c.add(today,false,{docDate:'2026-10-16'});assert.deepEqual(await c.groups(),[]);await c.add();await c.add();for(const home of ['EUR','','XYZ']){await c.db.pool.query("INSERT INTO currency_settings(org_id,entity_id,turned_on_by,home) VALUES($1,$2,'the owner',$3) ON CONFLICT(org_id,entity_id) DO UPDATE SET home=excluded.home",[c.f.orgId,c.entityId,home]);assert.deepEqual(await c.groups(),[]);}});
