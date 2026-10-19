import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './harness.js';
import { mvOrg, mvReadyViewers } from './morning-fixtures.js';
import { withReadSnapshot, createMorningRuntime } from '../lib/data/morning/locks.js';
import { prepareItems, pageItems, foldCurrentItems } from '../lib/data/morning/items.js';
import { bankReview } from '../lib/data/morning/bank.js';
import { sourceFreshness, freshnessLimitations } from '../lib/data/morning/freshness.js';

const A='Sample company A',B='Sample company B',C='Sample company C',D='Sample company D',now=new Date('2026-10-17T15:00:00Z');
function bankTest(name,fn,{basic=true}={}) { test(name,async t=>{
  const db=await freshDb();t.after(()=>db.drop());const f=await mvOrg(db.pool,{companies:[A,B,C,D]}),{owner}=await mvReadyViewers(db.pool,{...f,second:false});
  const run=work=>withReadSnapshot(db.pool,{orgId:f.orgId,viewerKey:'owner',identity:owner,runtime:createMorningRuntime()},work);
  const link=async company=>db.pool.query("INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_at,linked_by) VALUES($1,$2,$3,$4,'2026-10-10','the owner')",[f.orgId,f.entities[company],randomUUID(),company]);
  const map=async(company,{id=randomUUID(),account=f.accounts[company].checking,include=true,owned=true}={})=>{
    await db.pool.query("INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,books_account_id,include,owned_now) VALUES($1,$2,$3,'Sample checking feed','depository',$4,$5,$6)",[f.orgId,f.entities[company],id,account,include,owned]);return id;
  };
  const item=async(company,id,cents,extra={})=>(await db.pool.query(`INSERT INTO bank_feed_item(org_id,entity_id,ll_account_id,ll_transaction_id,revision,pending,posted_date,amount_cents,bank_state,review_state,attention,parked_attention,currency)
    VALUES($1,$2,$3,$4,1,$5,'2026-10-17',$6,$7,$8,$9,$10,$11) RETURNING item_id`,[f.orgId,f.entities[company],id,randomUUID(),extra.pending??false,cents,extra.bank??'active',extra.review??'new',extra.attention??null,extra.parked??null,extra.currency??'USD'])).rows[0].item_id;
  const pull=(company,started='2026-10-17T09:00Z',finished='2026-10-17T10:00Z')=>db.pool.query("INSERT INTO bank_feed_pull(org_id,entity_id,trigger,started_at,finished_at,status,new_count) VALUES($1,$2,'refresh',$3,$4,'ok',0)",[f.orgId,f.entities[company],started,finished]);
  const batch=company=>db.pool.query("INSERT INTO import_batch(org_id,entity_id,source,company_name,summary,imported_by,created_at) VALUES($1,$2,'qbo_import',$3,'{}','the owner','2026-10-01T10:00Z')",[f.orgId,f.entities[company],company]);
  const review=(extra={})=>run(async tx=>{const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget:tx});return bankReview(tx,{orgId:f.orgId,store,budget:tx,...extra});});
  const fresh=(extra={})=>run(tx=>sourceFreshness(tx,{orgId:f.orgId,now,budget:tx,...extra}));
  const ids={};await link(A);await link(B);
  if(basic){ids.a=await map(A,{owned:false});ids.b=await map(B,{id:ids.a});
    ids.n1=await item(A,ids.a,-1200);ids.n2=await item(A,ids.a,5000,{attention:'books'});ids.n3=await item(A,ids.a,-800,{pending:true});
    await item(A,ids.a,-300,{review:'added',attention:'changed'});await item(A,ids.a,100,{review:'added',bank:'removed',attention:'removed'});await item(A,ids.a,-50,{review:'excluded'});
    ids.unmapped=await map(A,{account:null});await item(A,ids.unmapped,1);await item(B,ids.b,1);await item(B,ids.b,1);
  }
  await fn({db,f,run,link,map,item,pull,batch,review,fresh,ids});
});}
const rowA=(r,f)=>r.page.find(x=>x.entityId===f.entities[A]&&x.currency==='USD');
bankTest('code-r1 N1: pending warnings keep a separate caveat without double-counting', async c => {
  const feed=await c.map(A);
  await c.item(A,feed,-1200,{pending:true,attention:'changed'});
  const row=rowA(await c.review(),c.f);
  assert.equal(row.needsReviewCount,1);assert.equal(row.warningCount,1);assert.equal(row.newOnlyCount,0);
  assert.equal(row.pendingCount,0);assert.equal(row.pendingCents,0);
  assert.equal(row.pendingWarningCount,1);assert.equal(row.netCents,-1200);
},{basic:false});
bankTest('all bank amounts are checked before availability, including off-page and relation mode',async c=>{
  for(let i=1;i<=51;i++){const account=(await c.db.pool.query("INSERT INTO account(org_id,entity_id,name,type) VALUES($1,$2,$3,'bank') RETURNING account_id",[c.f.orgId,c.f.entities[A],`Sample account ${i}`])).rows[0].account_id;const id=`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`;await c.map(A,{id,account});await c.item(A,id,i===51?Number.MAX_SAFE_INTEGER:1);if(i===51)await c.item(A,id,1);}
  for(const mode of ['page','relation'])await c.run(async tx=>{const store=await prepareItems(tx,{orgId:c.f.orgId,viewerKey:'owner',budget:tx});await tx.query('SAVEPOINT bank_load');await assert.rejects(bankReview(tx,{orgId:c.f.orgId,store,budget:tx,mode}),{name:'UnsafeAmountError'});await tx.query('ROLLBACK TO SAVEPOINT bank_load');assert.equal(store.ruleAvailable('bank'),false);});
  await c.item(A,'00000000-0000-0000-0000-000000000001',Number.MAX_SAFE_INTEGER);
  await c.run(async tx=>{const store=await prepareItems(tx,{orgId:c.f.orgId,viewerKey:'owner',budget:tx});await assert.rejects(bankReview(tx,{orgId:c.f.orgId,store,budget:tx}),{name:'UnsafeAmountError'});assert.equal(store.ruleAvailable('bank'),false);});
},{basic:false});
bankTest('distinct union count',async c=>{const r=rowA(await c.review(),c.f);assert.equal(r.needsReviewCount,4);assert.equal(r.newOnlyCount,1);assert.equal(r.warningCount,3);assert.deepEqual(r.causes,{changed:1,removed:1,books:1,parked:0});});
bankTest('gross and net',async c=>{const r=rowA(await c.review(),c.f);assert.equal(r.inflowCents,5100);assert.equal(r.outflowCents,1500);assert.equal(r.netCents,3600);});
bankTest('inactive USD history leaves attention unchanged and foreign history retains coverage',async c=>{
  const before=await c.review();
  await c.item(A,c.ids.a,900000,{review:'excluded'});
  await c.item(A,c.ids.a,-700000,{review:'added',bank:'removed'});
  await c.item(A,c.ids.a,500000,{review:'new',bank:'removed',pending:true});
  assert.deepEqual(await c.review(),before);
  await c.item(A,c.ids.a,900000,{review:'excluded',currency:'EUR'});
  await c.item(A,c.ids.a,-700000,{review:'added',bank:'removed',currency:'EUR'});
  const after=await c.review();
  assert.deepEqual(after.page,before.page);
  assert.deepEqual(after.counts,before.counts);
  assert.deepEqual(after.coverage.filter(x=>x.kind==='unsupported_currency'),[
    {entityId:c.f.entities[A],kind:'unsupported_currency',accounts:1,items:2}]);
});
bankTest('pending kept apart',async c=>{let r=rowA(await c.review(),c.f);assert.equal(r.pendingCount,1);assert.equal(r.pendingCents,-800);await c.db.pool.query("UPDATE bank_feed_item SET attention='changed' WHERE item_id=$1",[c.ids.n3]);r=rowA(await c.review(),c.f);assert.equal(r.warningCount,4);assert.equal(r.pendingCount,0);});
bankTest('full mapping identity',async c=>{const r=await c.review();assert.equal(rowA(r,c.f).needsReviewCount,4);assert.equal(r.page.find(x=>x.entityId===c.f.entities[B]).needsReviewCount,2);});
bankTest('coverage for unmapped accounts',async c=>{assert.deepEqual((await c.review()).coverage.filter(x=>x.entityId===c.f.entities[A]),[{entityId:c.f.entities[A],kind:'unmapped',accounts:1,items:1}]);});
bankTest('no raw bank/books disagreement rule',async c=>{assert.deepEqual(Object.keys(rowA(await c.review(),c.f)).sort(),'itemKey entityId entityName llAccountId accountName needsReviewCount newOnlyCount warningCount causes pendingCount pendingWarningCount pendingCents inflowCents outflowCents netCents currency version'.split(' ').sort());});
bankTest('freshness: empty successful pull counts',async c=>{await c.pull(A);let r=(await c.fresh()).page.find(x=>x.entityId===c.f.entities[A]);assert.equal(r.label,'Last successful feed pull completed');assert.equal(r.stale,false);assert.equal(r.at,'2026-10-17T10:00:00.000Z');r=(await c.fresh({now:new Date('2026-10-19T10:00:01Z')})).page.find(x=>x.entityId===c.f.entities[A]);assert.equal(r.stale,true);});
bankTest('freshness: a pull before the current link does not count',async c=>{await c.pull(A,'2026-10-09T09:00Z','2026-10-09T10:00Z');assert.equal((await c.fresh()).page.find(x=>x.entityId===c.f.entities[A]).label,'Source time unknown');});
bankTest('freshness: import and none',async c=>{await c.batch(C);const r=await c.fresh();assert.equal(r.page.find(x=>x.entityId===c.f.entities[C]).label,'Historical import recorded');assert.equal(r.page.find(x=>x.entityId===c.f.entities[D]).label,'No import source');});
bankTest('freshness ignores item timestamps',async c=>{await c.db.pool.query('UPDATE bank_feed_item SET updated_at=$1',[now]);assert.equal((await c.fresh()).page.find(x=>x.entityId===c.f.entities[A]).label,'Source time unknown');});
bankTest('simultaneous sources and mapping limitations',async c=>{
  await c.pull(A);await c.batch(A);let r=(await c.fresh()).page.filter(x=>x.entityId===c.f.entities[A]);assert.equal(r.length,2);assert.equal(r[1].ageMs,1400400000);assert.equal(r[1].stale,false);
  const sourceKey=r[0].sourceKey;const limits=await c.run(tx=>freshnessLimitations(tx,{orgId:c.f.orgId,sourceKey,budget:tx}));assert.equal(limits.count,3);assert.equal(limits.page.filter(x=>x.kind==='no_account_success_evidence').length,2);assert.equal(limits.page.filter(x=>x.kind==='historical_mapping').length,1);
  assert.ok(limits.page.every(x=>['Company/link-wide time; individual account refresh is unknown.','Historical mapping; not currently owned here.'].includes(x.text)));
  await c.pull(A,'2026-10-17T13:00Z','2026-10-17T14:00Z');r=(await c.fresh()).page.filter(x=>x.entityId===c.f.entities[A]);assert.equal(r[1].at,'2026-10-01T10:00:00.000Z');
  const foreign=await mvOrg(c.db.pool,{slug:'foreign'});await assert.rejects(c.run(tx=>freshnessLimitations(tx,{orgId:foreign.orgId,sourceKey,budget:tx})),e=>e.status===404);
});
bankTest('excluded, parked/books and currencies',async c=>{
  const excluded=await c.map(A,{account:null,include:false});await c.item(A,excluded,1);await c.item(A,excluded,1);await c.db.pool.query("UPDATE bank_feed_item SET parked_attention='changed' WHERE item_id=$1",[c.ids.n2]);await c.item(A,c.ids.a,-100,{currency:'EUR'});
  const r=await c.review(),a=rowA(r,c.f);assert.equal(a.needsReviewCount,4);assert.deepEqual(a.causes,{changed:2,removed:1,books:1,parked:1});assert.equal(a.netCents,3600);assert.equal(r.page.find(x=>x.currency==='EUR').netCents,-100);
  assert.ok(r.coverage.some(x=>x.kind==='excluded'&&x.items===2));assert.ok(r.coverage.some(x=>x.kind==='unsupported_currency'&&x.items===1));
  for(const x of r.page)await c.db.pool.query("INSERT INTO morning_dismissal(org_id,viewer_key,item_key,item_version,rule_version) VALUES($1,'owner',$2,$3,1)",[c.f.orgId,x.itemKey,x.version]);
  const dismissed=await c.review();assert.equal(dismissed.page.length,0);assert.deepEqual(dismissed.coverage,r.coverage);assert.equal((await c.fresh()).count,4);
});
bankTest('120 aggregates',async c=>{
  for(let i=1;i<=120;i++){const account=(await c.db.pool.query("INSERT INTO account(org_id,entity_id,name,type) VALUES($1,$2,$3,'bank') RETURNING account_id",[c.f.orgId,c.f.entities[A],`Sample account ${i}`])).rows[0].account_id;const id=`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`;await c.map(A,{id,account});await c.item(A,id,100);}
  const all=[];let after=null;do{const p=await c.review({after});all.push(...p.page);after=p.next;}while(after);assert.equal(all.length,120);
  for(const x of [...all.slice(0,10),...all.slice(60,70)])await c.db.pool.query("INSERT INTO morning_dismissal(org_id,viewer_key,item_key,item_version,rule_version) VALUES($1,'owner',$2,$3,1)",[c.f.orgId,x.itemKey,x.version]);
  await c.run(async tx=>{const store=await prepareItems(tx,{orgId:c.f.orgId,viewerKey:'owner',budget:tx});const p=await bankReview(tx,{orgId:c.f.orgId,store,budget:tx});assert.equal(p.counts.bankAccounts,100);assert.equal(p.counts.bankLines,100);assert.deepEqual(p.page.map(x=>x.itemKey),all.slice(10,60).map(x=>x.itemKey));const p2=await pageItems(tx,{store,rule:'bank',after:p.next});assert.deepEqual(p2.page.map(x=>x.itemKey),all.slice(70).map(x=>x.itemKey));assert.equal((await foldCurrentItems(tx,{store})).stale,0);});
  await c.db.pool.query('UPDATE bank_feed_item SET ll_transaction_id=$2 WHERE item_id=(SELECT min(item_id) FROM bank_feed_item WHERE org_id=$1)',[c.f.orgId,randomUUID()]);const changed=await c.review();assert.equal(changed.counts.bankAccounts,101);assert.notEqual(changed.page[0].version,all[0].version);
},{basic:false});
