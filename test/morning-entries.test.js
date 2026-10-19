import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { mvOrg, mvTxn, mvVendor, mvReadyViewers } from './morning-fixtures.js';
import { withTransaction } from '../lib/db.js';
import { withReadSnapshot, withObservingRead, createMorningRuntime } from '../lib/data/morning/locks.js';
import { readBalanceVector, companyTotals, compareVectors, readHomeCurrencyScope } from '../lib/data/morning/balances.js';
import { readVisit, decideComparison, persistObservation } from '../lib/data/morning/observe.js';
import { ValidationError } from '../lib/data/writes.js';
import { readWindowEntries, transferSuggestions, TRANSFER_DEGREES_SQL, TRANSFER_RELATIONS_SQL, ENTRY_TEXT, entryResidual } from '../lib/data/morning/entries.js';
import { transferOracle } from '../scripts/morning-probe-sql.mjs';
import { ensurePostingFacts } from '../lib/data/morning/posting-facts.js';

const A='Sample company A',B='Sample company B',H='Sample household A',from=new Date('2026-10-17T12:00:00Z'),to=new Date('2026-10-17T15:00:00Z'),today='2026-10-17';
async function inspectDegrees(tx,base,select) {
  await ensurePostingFacts(tx,{orgId:base.orgId,today:base.today,window:{from:base.from,to:base.to},budget:tx});
  return tx.query(TRANSFER_RELATIONS_SQL+' '+select);
}
function entryTest(name,fn,{seed=false}={}){test(name,async t=>{
  const db=await freshDb();t.after(()=>db.drop());const f=await mvOrg(db.pool,{households:[H]}),{owner}=await mvReadyViewers(db.pool,{...f,second:false});
  const args={orgId:f.orgId,viewerKey:'owner',identity:owner,runtime:createMorningRuntime()},base={orgId:f.orgId,from,to,today,thresholdCents:50000};
  const run=(work,extra={})=>withReadSnapshot(db.pool,{...args,...extra},work);
  const add=async(company,cents,date=today,extra={},tx=db.pool)=>{
    // mvTxn verifies its document immediately; defer again before the next balanced document.
    if(tx!==db.pool)await tx.query('SET CONSTRAINTS ALL DEFERRED');
    return mvTxn(tx,{orgId:f.orgId,entityId:f.entities[company],type:'journal_entry',date,createdAt:new Date('2026-10-17T13:00:00Z'),postings:[{accountId:f.accounts[company].checking,cents}],...extra});
  };
  const entries=(extra={})=>run(tx=>readWindowEntries(tx,{...base,...extra,budget:tx}));
  const transfers=(extra={})=>run(tx=>transferSuggestions(tx,{...base,...extra,budget:tx}));
  const ids=[];
  if(seed){const vendorId=await mvVendor(db.pool,{orgId:f.orgId,entityId:f.entities[A],name:'Sample vendor A'});
    ids.push(await add(A,-60000,today,{type:'expense',vendorId}));
    ids.push(await add(A,-15000,'2026-10-01',{type:'expense',vendorId,createdAt:new Date('2026-10-01T13:00:00Z'),updatedAt:new Date('2026-10-17T14:00:00Z')}));
    ids.push(await add(A,-90000,'2026-10-18',{type:'expense',vendorId,createdAt:new Date('2026-10-17T13:30:00Z')}));
    ids.push(await add(A,-90000,today,{type:'expense',vendorId,createdAt:new Date('2026-10-17T13:10:00Z'),voided:true}));
    ids.push(await add(A,2000,today,{type:'deposit',createdAt:new Date('2026-10-17T13:20:00Z')}));
    ids.push(await add(A,-4000,today,{type:'expense',vendorId,createdAt:new Date('2026-10-17T13:40:00Z'),postings:[{accountId:f.accounts[A].card,cents:-4000}]}));
    ids.push(await add(A,-90000,today,{type:'expense',vendorId,createdAt:new Date('2026-10-17T11:59:00Z')}));
  }
  await fn({pool:db.pool,f,args,base,run,add,entries,transfers,ids});
});}
entryTest('window selection and kinds',async c=>{const r=await c.entries();assert.deepEqual(r.page.map(p=>p.txnId),[c.ids[0]]);assert.equal(r.page[0].kind,'added');assert.equal(r.page[0].netCents,-60000);assert.equal(r.totals.aboveCount,1);const all=await c.entries({thresholdCents:0});assert.equal(all.page.find(r=>r.txnId===c.ids[1]).kind,'historical_edit');assert.equal(all.page.find(r=>r.txnId===c.ids[5]).cardOwedEffectCents,4000);assert.equal(all.page.find(r=>r.txnId===c.ids[5]).availableEffectCents,-4000);},{seed:true});
entryTest('smaller entries summary',async c=>{const t=(await c.entries()).totals;assert.deepEqual([t.smallCount,t.smallPositiveCents,t.smallNegativeCents,t.smallNetCents],[3,2000,-19000,-17000]);},{seed:true});
entryTest('money in/out labels',async c=>{const t=(await c.entries()).totals;assert.deepEqual([t.bankInCents,t.bankOutCents,t.cardChargesCents,t.cardCreditsCents],[2000,-75000,4000,0]);},{seed:true});
entryTest('raising the threshold moves rows to the summary',async c=>{const r=await c.entries({thresholdCents:100000});assert.equal(r.page.length,0);assert.equal(r.totals.smallCount,4);},{seed:true});
entryTest('keyset pages',async c=>{
  const vendorId=await mvVendor(c.pool,{orgId:c.f.orgId,entityId:c.f.entities[A],name:'Sample vendor A'});
  await withTransaction(c.pool,async tx=>{for(let i=0;i<120;i++)await c.add(A,-60000,`2026-10-${String(i%17+1).padStart(2,'0')}`,{type:'expense',vendorId},tx);});
  let after=null;const ids=[],lengths=[];do{const r=await c.entries({after});assert.equal(r.totals.aboveCount,120);ids.push(...r.page.map(p=>p.txnId));lengths.push(r.page.length);after=r.next;}while(after);assert.deepEqual(lengths,[50,50,20]);assert.equal(new Set(ids).size,120);
  for(const extra of [{limit:0},{limit:51},{after:{date:today}},{thresholdCents:-1}])await assert.rejects(c.entries(extra),ValidationError);
});
entryTest('transfer suggestion keeps both entries',async c=>{const out=await c.add(A,-25000,'2026-10-16'),incoming=await c.add(B,25000);const r=await c.transfers();assert.equal(r.count,1);assert.equal(r.page[0].out.txnId,out);assert.equal(r.page[0].in.txnId,incoming);const t=(await c.entries()).totals;assert.equal(t.bankOutCents,-25000);assert.equal(t.bankInCents,25000);});
entryTest('ambiguous endpoint yields nothing',async c=>{await c.add(A,-7000);await c.add(B,7000);await c.add(H,7000);assert.equal((await c.transfers()).count,0);});
entryTest('exclusions',async c=>{
  await c.add(A,-100);await c.add(A,100);await c.add(A,-200,'2026-10-01');await c.add(B,200,'2026-10-05');await c.add(A,-300,today,{postings:[{accountId:c.f.accounts[A].card,cents:-300}]});await c.add(B,300);await c.add(A,400);await c.add(B,400);
  await c.run(async tx=>{assert.equal((await transferSuggestions(tx,{...c.base,budget:tx})).count,0);assert.equal((await inspectDegrees(tx,c.base,"SELECT count(*)::int AS n FROM mv_transfer_degree WHERE account_type='credit_card'")).rows[0].n,0);});
});
entryTest('degree on the full graph',async c=>{
  const a=await c.add(A,-500,'2026-10-01'),b=await c.add(B,500,'2026-10-01'),third=await c.add(H,-500,'2026-10-02'),b2=await c.add(B,500,'2026-10-04');
  await c.run(async tx=>{assert.equal((await transferSuggestions(tx,{...c.base,budget:tx})).count,0);const rows=(await inspectDegrees(tx,c.base,'SELECT txn_id,degree::int FROM mv_transfer_degree ORDER BY txn_id')).rows;assert.deepEqual(rows,[{txn_id:a,degree:2},{txn_id:b,degree:2},{txn_id:third,degree:2},{txn_id:b2,degree:2}]);});
});
entryTest('pagination does not change suggestions',async c=>{
  for(let i=1;i<=55;i++){await c.add(A,-100*i);await c.add(B,100*i);}
  const collect=async(limit,thresholdCents)=>c.run(async tx=>{
    await readWindowEntries(tx,{...c.base,limit,thresholdCents,budget:tx});let after=null;const pairs=[];do{const r=await transferSuggestions(tx,{...c.base,after,limit,budget:tx});assert.equal(r.count,55);pairs.push(...r.page);after=r.next;}while(after);return pairs;
  });assert.deepEqual(await collect(1,0),await collect(50,9000000));
});
entryTest('(B,N] exact endpoints',async c=>{
  const ids=[];for(const instant of [from,new Date(+from+1),to,new Date(+to+1)])ids.push(await c.add(A,-100,today,{createdAt:instant}));
  const r=await c.entries({thresholdCents:0});assert.deepEqual(r.page.map(p=>p.txnId),[ids[1],ids[2]]);assert.equal(r.totals.aboveCount,2);assert.equal(r.totals.windowNetAvailableCents,-200);
});
entryTest('account page filter first',async c=>{
  await withTransaction(c.pool,async tx=>{for(let i=0;i<120;i++)await c.add(A,-60000,today,{},tx);for(let i=0;i<80;i++)await c.add(B,70000,today,{},tx);});
  let after=null;const lengths=[];do{const r=await c.entries({accountId:c.f.accounts[A].checking,after});assert.equal(r.totals.aboveCount,120);assert.equal(r.totals.windowNetAvailableCents,-7200000);assert.ok(r.page.every(r=>r.entityName===A));lengths.push(r.page.length);after=r.next;}while(after);assert.deepEqual(lengths,[50,50,20]);
  const foreign=await mvOrg(c.pool,{slug:'foreign'});let financial=0;
  await assert.rejects(c.run(tx=>readWindowEntries(tx,{...c.base,accountId:foreign.accounts[A].checking,budget:tx}),{hooks:{beforeQuery:({text})=>{if(text.includes('sum(p.amount_cents)'))financial++;}}}),e=>e.status===404);assert.equal(financial,0);
  const accountId=(await c.pool.query("INSERT INTO account(org_id,entity_id,name,type) VALUES($1,$2,'Sample removed account','bank') RETURNING account_id",[c.f.orgId,c.f.entities[A]])).rows[0].account_id;
  const snapshot=await withObservingRead(c.pool,{...c.args,runtime:createMorningRuntime({wall:()=>to})},async(tx,{N})=>{const visit=await readVisit(tx,c.args);return persistObservation(tx,{...c.args,N,today,visit,decision:decideComparison(visit,N),vector:{companies:[{entityId:c.f.entities[A],name:A,isPersonal:false}],accounts:[{accountId,entityId:c.f.entities[A],name:'Sample removed account',type:'bank',active:true,signedCents:0}]}});});
  await c.pool.query('DELETE FROM account WHERE account_id=$1',[accountId]);
  const r=await c.entries({accountId,context:{identity:c.args.identity,generationId:snapshot.generationId}});assert.equal(r.totals.aboveCount,0);assert.equal(r.page.length,0);
  await assert.rejects(c.entries({accountId,context:{identity:{...c.args.identity},generationId:snapshot.generationId}}));
});
entryTest('limitations',async c=>{
  const old=new Date(+from-1);await c.add(A,900,today,{createdAt:old});const removed=await c.add(A,100,today,{createdAt:old});
  const balance=date=>c.run(tx=>readBalanceVector(tx,{orgId:c.f.orgId,today:date,budget:tx}));let before=await balance(today);
  await withTransaction(c.pool,async tx=>{await tx.query('DELETE FROM posting WHERE txn_id=$1',[removed]);await tx.query('DELETE FROM txn WHERE txn_id=$1',[removed]);});
  let after=await balance(today),window=await c.entries();assert.equal(companyTotals(after).grand.availableCents,900);assert.equal(window.totals.windowNetAvailableCents,0);assert.equal(entryResidual({windowNetAvailableCents:0,observedAvailableChangeCents:-100}),true);
  const future=await c.add(A,100,'2026-10-18',{createdAt:old});before=await balance(today);after=await balance('2026-10-18');window=await c.entries({today:'2026-10-18'});assert.equal(companyTotals(after).grand.availableCents-companyTotals(before).grand.availableCents,100);assert.equal(window.totals.windowNetAvailableCents,0);assert.equal(entryResidual({windowNetAvailableCents:0,observedAvailableChangeCents:100}),true);
  // A transaction timestamp precedes B even though its commit is after the comparison.
  before=await balance(today);await c.add(A,100,today,{createdAt:old});after=await balance(today);assert.equal(companyTotals(after).grand.availableCents-companyTotals(before).grand.availableCents,100);assert.equal((await c.entries()).totals.windowNetAvailableCents,0);
  const movedBefore={companies:[{entityId:1,name:A},{entityId:2,name:B}],accounts:[{accountId:1,entityId:1,name:'Sample account',type:'bank',active:true,signedCents:100}]},movedAfter={...movedBefore,accounts:[{...movedBefore.accounts[0],entityId:2}]};
  const moved=compareVectors(movedBefore,movedAfter,new Map([[1,movedAfter.accounts[0]]]));assert.deepEqual(moved.companies.map(c=>c.availableDeltaCents),[-100,100]);for(const row of moved.companies)assert.equal(entryResidual({windowNetAvailableCents:0,observedAvailableChangeCents:row.availableDeltaCents}),true);
  assert.equal(ENTRY_TEXT.heading,'Recently added or edited entries — current amounts');assert.equal(ENTRY_TEXT.limitation,'This list shows entries added or edited since the comparison look, at their current amounts. It is not a complete change log.');assert.equal(ENTRY_TEXT.residual,'Balance change also includes edits, removals or other adjustments not explained by this list.');assert.equal(ENTRY_TEXT.transfer,'Possible intercompany transfer (unconfirmed)');assert.ok(future);
});
entryTest('transfer boundaries',async c=>{
  const out=await c.add(A,-100,'2026-10-01'),incoming=await c.add(B,100,'2026-10-04');assert.equal((await c.transfers()).count,1);
  await withTransaction(c.pool,async tx=>{await tx.query("UPDATE txn SET txn_date='2026-10-05' WHERE txn_id=$1",[incoming]);await tx.query("UPDATE posting SET txn_date='2026-10-05' WHERE txn_id=$1",[incoming]);});assert.equal((await c.transfers()).count,0);
  await c.add(A,-200,today,{postings:[{accountId:c.f.accounts[A].checking,cents:-100,date:'2026-10-15'},{accountId:c.f.accounts[A].checking,cents:-100,date:'2026-10-16'}]});assert.equal((await c.transfers()).skippedMultiDate,1);
  await withTransaction(c.pool,async tx=>{await tx.query('DELETE FROM posting');await tx.query('DELETE FROM txn');});
  await c.add(A,-100);await c.add(B,100);await c.add(H,-100);
  await c.run(async tx=>{assert.equal((await transferSuggestions(tx,{...c.base,budget:tx})).count,0);assert.deepEqual((await inspectDegrees(tx,c.base,'SELECT degree::int FROM mv_transfer_degree ORDER BY txn_id')).rows.map(r=>r.degree),[1,2,1]);});
  await withTransaction(c.pool,async tx=>{await tx.query('DELETE FROM posting');await tx.query('DELETE FROM txn');for(let i=0;i<1000;i++){await c.add(A,-100,today,{},tx);await c.add(B,100,today,{},tx);}});
  await c.run(async tx=>{const r=await transferSuggestions(tx,{...c.base,budget:tx});assert.equal(r.count,0);assert.deepEqual((await inspectDegrees(tx,c.base,'SELECT count(*)::int AS n,min(degree)::int AS min,max(degree)::int AS max FROM mv_transfer_degree')).rows[0],{n:2000,min:1000,max:1000});});assert.ok(out);
});
entryTest('unsupported home cannot infer equal-cent transfers; window dollars are unavailable',async c=>{
  await c.add(A,-10000);await c.add(B,10000);
  for(const home of ['EUR','','XYZ']){await c.pool.query("INSERT INTO currency_settings(org_id,entity_id,turned_on_by,home) VALUES($1,$2,'the owner',$3) ON CONFLICT(org_id,entity_id) DO UPDATE SET home=excluded.home",[c.f.orgId,c.f.entities[B],home]);
    const transfers=await c.transfers();assert.equal(transfers.count,0);assert.equal(transfers.coverage.unavailable[0].entityId,c.f.entities[B]);const r=await c.entries({thresholdCents:0});assert.equal(r.totals.windowNetAvailableCents,null);assert.equal(r.page.find(p=>p.entityId===c.f.entities[A]).netCents,-10000);assert.equal(r.page.find(p=>p.entityId===c.f.entities[B]).netCents,null);}
});
entryTest('shared posting facts retain changed non-money rows and historical typed-party peers',async c=>{
  const vendorId=await mvVendor(c.pool,{orgId:c.f.orgId,entityId:c.f.entities[A],name:'Sample vendor history'});
  const old=new Date('2021-01-01T12:00:00Z');
  const changed=await c.add(A,-100);
  const noMoney=await c.add(A,100,today,{postings:[{accountId:c.f.accounts[A].offset,cents:100}]});
  const header=await c.add(A,-100,'2021-01-01',{type:'expense',vendorId,createdAt:old});
  const line=await c.add(A,-100,'2021-01-01',{createdAt:old,postings:[{accountId:c.f.accounts[A].checking,cents:-100,vendorId}]});
  await c.add(A,-100,'2021-01-01',{createdAt:old});
  await c.add(A,-100,'2026-10-18',{type:'expense',vendorId});
  await c.add(A,-100,today,{type:'expense',vendorId,voided:true});
  for(const includePeers of [false,true])await c.run(async tx=>{
    await ensurePostingFacts(tx,{orgId:c.f.orgId,today,window:{from,to},includePeers,budget:tx});
    const {rows}=await tx.query('SELECT txn_id,seed,account_id,m::text FROM mv_posting_fact ORDER BY txn_id');
    assert.deepEqual(rows.map(r=>r.txn_id),[changed,noMoney,...(includePeers?[header,line]:[])]);
    assert.deepEqual(rows.find(r=>r.txn_id===noMoney),{txn_id:noMoney,seed:true,account_id:null,m:'0'});
    assert.ok(rows.filter(r=>[header,line].includes(r.txn_id)).every(r=>!r.seed&&r.m==='-100'));
  });
});
entryTest('posting facts refuse transaction and account company mismatches',async c=>{
  const wrongAccount=await c.add(A,-100),wrongTransaction=await c.add(A,-200),valid=await c.add(A,-300);
  await c.pool.query('UPDATE posting SET account_id=$1 WHERE txn_id=$2',[c.f.accounts[B].checking,wrongAccount]);
  await c.pool.query('UPDATE posting SET entity_id=$1,account_id=$2 WHERE txn_id=$3',[c.f.entities[B],c.f.accounts[B].checking,wrongTransaction]);
  const r=await c.entries({thresholdCents:0});
  assert.deepEqual(r.page.map(p=>p.txnId),[valid]);assert.equal(r.totals.windowNetAvailableCents,-300);
});
entryTest('transfer exhaustive oracle uses production degree SQL',async c=>{
  await c.run(async tx=>{
    const input=`SELECT x.*,true AS home_supported FROM jsonb_to_recordset($1::jsonb) AS x(txn_id bigint,account_id bigint,entity_id bigint,account_type text,m numeric,first_date date,last_date date,type text,txn_date date,created_at timestamptz,updated_at timestamptz,customer_id bigint,vendor_id bigint,seed bool,kind text)`;
    await tx.query(`CREATE TEMP TABLE mv_transfer_net ON COMMIT DROP AS ${input}`,['[]']);
    const result=await transferOracle({query:async q=>{
      await tx.query('TRUNCATE mv_transfer_net');await tx.query(`INSERT INTO mv_transfer_net ${input}`,q.values);await tx.query('ANALYZE mv_transfer_net');
      // The oracle's partner projection used a quadratic LEFT JOIN. Map this bounded
      // batch's computed ordinals to IDs; the production degree SQL is unchanged.
      const {rows}=await tx.query(TRANSFER_DEGREES_SQL+' SELECT txn_id,degree::int,ordinal,partner::text FROM degree ORDER BY txn_id');
      const ids=new Map(rows.map(r=>[r.ordinal,r.txn_id]));
      return {rows:rows.map(r=>({txn_id:r.txn_id,degree:r.degree,partner:r.degree===1?ids.get(Number(r.partner)):null}))};
    }});
    console.log('Task 8 transfer oracle:',JSON.stringify(result));
    assert.ok(result.cases>100000);assert.equal(result.degreeMismatches,0);assert.equal(result.partnerMismatches,0);assert.equal(result.suggestionMismatches,0);
  },{deadlineMs:600000});
});
