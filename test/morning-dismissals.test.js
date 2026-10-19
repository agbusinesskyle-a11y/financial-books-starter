import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './harness.js';
import { mvOrg,mvReadyViewers,mvVendor,mvTxn,mvApply } from './morning-fixtures.js';
import { createMorningService } from '../lib/data/morning.js';
import { createMorningRuntime } from '../lib/data/morning/locks.js';
import { dismissItem,undismissItem,dismissedItems,RULE_VERSIONS,canonical,itemVersion,versionFacts } from '../lib/data/morning/dismissals.js';
import { ownerResetViewer,removeSecondViewer,grantSecondViewer } from '../lib/data/morning/identity.js';
import { findOpenInvite,pendingSecret,completeInvite } from '../lib/data/users.js';
import { makeTotp } from '../lib/auth.js';
import { settingsKey } from '../lib/secrets.js';
const A='Sample company A',N=new Date('2026-10-17T15:00Z'),B=new Date('2026-10-17T13:00Z');
const render=async()=>'';
async function fixture(t,{second=false,bill=true,window=false}={}){
  const db=await freshDb();t.after(()=>db.drop());const f=await mvOrg(db.pool,{companies:[A],households:[A]});
  const actors=await mvReadyViewers(db.pool,{...f,second}),entityId=f.entities[A],a=f.accounts[A];let time=N,gen=null;
  const runtime=createMorningRuntime({wall:()=>time}),service=createMorningService({runtime,env:{NODE_ENV:'test'}});
  const vendorId=await mvVendor(db.pool,{orgId:f.orgId,entityId,name:'Sample vendor A'});
  const ctx=(identity=actors.owner,kind='ctx',resource=null,after=null)=>({sid:identity.sessionId,vk:identity.viewerKey,epoch:1,gen,kind,resource,after,iat:+time});
  const add=(type='bill',cents=100,extra={})=>mvTxn(db.pool,{orgId:f.orgId,entityId,type,vendorId,date:'2026-10-01',dueDate:type==='bill'?'2026-10-24':null,
    totalCents:cents,createdAt:N,postings:[{accountId:type==='bill'?a.ap:a.checking,cents:-cents}],...extra});
  const model=async({identity=actors.owner,rule='all',after=null,instance=service}={})=>{
    const r=await instance.readMorningDetail(db.pool,{identity,context:ctx(identity,'attention',{rule},after),pageRequest:{kind:'attention',resource:{rule}},now:time,runtime,render});
    assert.equal(r.status,'ok');return r.model;
  };
  const dismiss=(row,extra={})=>dismissItem(db.pool,{identity:actors.owner,itemKey:row.itemKey,itemVersion:row.version,note:'Sample note',context:ctx(),now:time,runtime,service,...extra});
  const undismiss=(itemKey,extra={})=>undismissItem(db.pool,{identity:actors.owner,itemKey,now:time,runtime,...extra});
  const dismissed=(fold='matching',extra={})=>dismissedItems(db.pool,{identity:actors.owner,context:ctx(),fold,now:time,runtime,service,...extra});
  const state=async()=>({visits:(await db.pool.query('SELECT * FROM morning_visit ORDER BY viewer_key')).rows,
    generations:(await db.pool.query('SELECT * FROM morning_snapshot_generation ORDER BY generation_id')).rows,
    dismissals:(await db.pool.query('SELECT * FROM morning_dismissal ORDER BY viewer_key,item_key')).rows});
  const bank=async(i=1)=>{const llAccountId=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
    const booksAccount=(await db.pool.query("INSERT INTO account(org_id,entity_id,name,type) VALUES($1,$2,$3,'bank') RETURNING account_id",[f.orgId,entityId,`Sample mapped bank ${i}`])).rows[0].account_id;
    await db.pool.query(`INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_by) VALUES($1,$2,$3,'Sample feed','the owner') ON CONFLICT DO NOTHING`,[f.orgId,entityId,randomUUID()]);
    await db.pool.query(`INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,books_account_id,include) VALUES($1,$2,$3,'Sample feed','depository',$4,true)`,[f.orgId,entityId,llAccountId,booksAccount]);
    const {rows:[r]}=await db.pool.query(`INSERT INTO bank_feed_item(org_id,entity_id,ll_account_id,ll_transaction_id,revision,pending,posted_date,amount_cents,bank_state,review_state)
      VALUES($1,$2,$3,$4,1,false,'2026-10-17',100,'active','new') RETURNING item_id`,[f.orgId,entityId,llAccountId,randomUUID()]);return {llAccountId,itemId:r.item_id};};
  if(window){time=B;await service.observeMorning(db.pool,{identity:actors.owner,runtime,render});gen=(await db.pool.query('SELECT latest_generation_id FROM morning_visit')).rows[0].latest_generation_id;time=N;}
  const billId=bill?await add():null;
  return {db,f,...actors,entityId,a,vendorId,runtime,service,ctx,add,model,dismiss,undismiss,dismissed,state,bank,billId,
    setTime:n=>{time=n;},setGen:id=>{gen=id;}};
}
function dismissalTest(name,fn,options){test(name,async t=>fn(await fixture(t,options),t));}
const billRow=async c=>(await c.model({rule:'bill'})).attention.page[0];

dismissalTest('complete dismissal recomputation uses 27 financial statements',async c=>{
  const row=await billRow(c);let count=0;
  assert.equal(await c.dismiss(row,{hooks:{beforeQuery:({text})=>{
    const sql=text.trim();
    if(/^SELECT (pg_advisory_|set_config|v\.enrollment_state)/.test(sql)||/^CREATE OR REPLACE FUNCTION/.test(sql))return;
    if(/^(SELECT|WITH|CREATE TEMP|CREATE OR REPLACE TEMP VIEW|CREATE INDEX|INSERT|UPDATE|DELETE)/.test(sql))count++;
    for(const routine of ['pg_temp.mv_bank_hash()','pg_temp.mv_hash_groups(','pg_temp.mv_pair_work('])if(sql.includes(routine))count++;
  }}}),'dismissed');
  assert.equal(count,27);
},{window:true});
dismissalTest('irrelevant edits keep the dismissal',async c=>{const row=await billRow(c);assert.equal(await c.dismiss(row),'dismissed');
  await c.db.pool.query("UPDATE txn SET memo='Sample revised memo',updated_at=$2 WHERE txn_id=$1",[c.billId,N]);
  assert.equal((await c.model()).attention.counts.bills,0);assert.equal((await c.dismissed()).page[0].version,row.version);});
dismissalTest('severity change resurrects',async c=>{const row=await billRow(c);assert.equal(row.severity,2);await c.dismiss(row);c.setTime(new Date('2026-10-24T15:00Z'));
  const current=await billRow(c);assert.equal(current.severity,1);assert.notEqual(current.version,row.version);});
dismissalTest('amount, approval and threshold changes resurrect',async c=>{
  const bill=await billRow(c);await c.dismiss(bill);const payment=await c.add('bill_payment',10);
  await mvApply(c.db.pool,{orgId:c.f.orgId,creditTxnId:payment,chargeTxnId:c.billId,cents:10,on:'2026-10-17'});assert.equal((await billRow(c)).openCents,90);
  const awaiting=await c.add('bill',200,{approval:'awaiting',dueDate:'2026-10-20'});let row=(await c.model({rule:'bill'})).attention.page.find(r=>r.display.txnId===awaiting);await c.dismiss(row);
  await c.db.pool.query("UPDATE txn SET approval_status='approved' WHERE txn_id=$1",[awaiting]);assert.ok((await c.model({rule:'bill'})).attention.page.some(r=>r.display.txnId===awaiting));
  await c.add('expense',1500000);row=(await c.model({rule:'large'})).attention.page[0];await c.dismiss(row);
  await c.db.pool.query('INSERT INTO morning_company_setting(org_id,entity_id,large_threshold_cents) VALUES($1,$2,1200000)',[c.f.orgId,c.entityId]);assert.notEqual((await c.model({rule:'large'})).attention.page[0].version,row.version);
  await c.db.pool.query("INSERT INTO morning_floor(org_id,viewer_key,account_id,floor_cents) VALUES($1,'owner',$2,1000)",[c.f.orgId,c.a.savings]);row=(await c.model({rule:'floor'})).attention.page[0];await c.dismiss(row);
  await c.db.pool.query('UPDATE morning_floor SET floor_cents=2000 WHERE org_id=$1',[c.f.orgId]);assert.notEqual((await c.model({rule:'floor'})).attention.page[0].version,row.version);
},{window:true});
dismissalTest('bank replacement with identical totals resurrects',async c=>{const bank=await c.bank(),row=(await c.model({rule:'bank'})).attention.page[0];await c.dismiss(row);
  await c.db.pool.query('DELETE FROM bank_feed_item WHERE item_id=$1',[bank.itemId]);
  await c.db.pool.query(`INSERT INTO bank_feed_item(org_id,entity_id,ll_account_id,ll_transaction_id,revision,pending,posted_date,amount_cents,bank_state,review_state)
    VALUES($1,$2,$3,$4,1,false,'2026-10-17',100,'active','new')`,[c.f.orgId,c.entityId,bank.llAccountId,randomUUID()]);
  const next=(await c.model({rule:'bank'})).attention.page[0];assert.equal(next.units,row.units);assert.notEqual(next.version,row.version);});
dismissalTest('stale submitted version',async c=>{const row=await billRow(c);await c.db.pool.query('UPDATE txn SET total_cents=101,open_cents=101 WHERE txn_id=$1',[c.billId]);
  assert.equal(await c.dismiss(row),'changed');assert.equal((await c.state()).dismissals.length,0);});
dismissalTest('viewer isolation',async c=>{const row=await billRow(c);await c.dismiss(row);assert.equal((await c.model({identity:c.second})).attention.counts.bills,1);
  assert.equal(await c.undismiss(row.itemKey,{identity:c.second}),false);assert.equal((await c.state()).dismissals.length,1);},{second:true});
dismissalTest('no longer in this view',async c=>{const row=await billRow(c);await c.dismiss(row);const payment=await c.add('bill_payment',100);
  await mvApply(c.db.pool,{orgId:c.f.orgId,creditTxnId:payment,chargeTxnId:c.billId,cents:100,on:'2026-10-17'});
  const gone=await c.dismissed('stale');assert.equal(gone.staleCount,1);assert.deepEqual(Object.keys(gone.page[0]).sort(),['dismissedAt','itemKey','note']);
  assert.equal(gone.page[0].note,'Sample note');assert.equal(await c.undismiss(row.itemKey),true);assert.equal((await c.state()).dismissals.length,0);});
dismissalTest('notes bounded; escaping belongs to Task 19',async c=>{const row=await billRow(c);await assert.rejects(c.dismiss(row,{note:'x'.repeat(501)}),/500/);
  await c.dismiss(row,{note:'x'.repeat(500)});assert.equal((await c.state()).dismissals[0].note.length,500);
  await c.dismiss(row,{note:'  <b>x</b>  '});assert.equal((await c.state()).dismissals[0].note,'<b>x</b>');});
dismissalTest('tax coverage badge stays',async c=>{const m=await c.model(),row=m.attention.page.find(r=>r.display.kind==='missing_household_period');await c.dismiss(row);
  const next=await c.model();assert.equal(next.coverageKnown,false);assert.equal(next.attention.coverage.known,false);
  assert.equal(next.attention.coverage.byKind.missing_household_period,1);assert.ok(!next.attention.page.some(r=>r.itemKey===row.itemKey));});
dismissalTest('not dismissible',async c=>{for(const itemKey of ['freshness:1','transfer:1','unavailable:bills'])assert.equal(await c.dismiss({itemKey,version:'a'.repeat(64)}),'not_dismissible');});
dismissalTest('dismiss does not advance the observation',async c=>{const before=await c.state(),row=await billRow(c);await c.dismiss(row);await c.undismiss(row.itemKey);
  const after=await c.state();assert.deepEqual(after.visits,before.visits);assert.deepEqual(after.generations,before.generations);},{window:true});
dismissalTest('foreign or forged context',async c=>{const row=await billRow(c);for(const context of [c.ctx(c.second),{...c.ctx(),gen:randomUUID()},{...c.ctx(),sid:'forged-session'},{...c.ctx(),kind:'entries'}])
  await assert.rejects(c.dismiss(row,{context}),e=>e.status===409);assert.equal((await c.state()).dismissals.length,0);
  await c.service.observeMorning(c.db.pool,{identity:c.second,runtime:c.runtime,render});const id=(await c.db.pool.query('SELECT latest_generation_id FROM morning_visit WHERE viewer_key=$1',[c.second.viewerKey])).rows[0].latest_generation_id;
  await assert.rejects(c.dismiss(row,{context:{...c.ctx(),gen:id}}),e=>e.status===409);
},{second:true});
for(const rule of ['bill','bank','large'])dismissalTest(`all-set refills/current folds: ${rule}`,async c=>{
  await c.db.pool.query("SELECT setval(pg_get_serial_sequence('txn','txn_id'),100001,false)");const ids=[];
  for(let i=1;i<=120;i++)ids.push(rule==='bank'?await c.bank(i):await c.add(rule==='bill'?'bill':'expense',rule==='bill'?100:1000000,{dueDate:rule==='bill'?'2026-10-16':null}));
  const all=[];let after=null;do{const m=await c.model({rule,after});all.push(...m.attention.page);after=m.attention.next;}while(after);
  assert.equal(all.length,120);for(const i of [...Array.from({length:10},(_,i)=>i),...Array.from({length:10},(_,i)=>i+60)])await c.dismiss(all[i]);
  const key=rule==='bill'?'bills':rule==='bank'?'bankLines':'large',m=await c.model({rule});assert.equal(m.attention.counts[key],100);
  assert.deepEqual(m.attention.page.map(r=>r.itemKey),all.slice(10,60).map(r=>r.itemKey));
  assert.deepEqual((await c.model({rule,after:m.attention.next})).attention.page.map(r=>r.itemKey),all.slice(70).map(r=>r.itemKey));
  let fold=await c.dismissed();assert.equal(fold.matchingCount,20);assert.equal(fold.staleCount,0);
  if(rule==='bank')await c.db.pool.query('UPDATE bank_feed_item SET amount_cents=101 WHERE item_id=$1',[ids[60].itemId]);
  else if(rule==='bill')await c.db.pool.query('UPDATE txn SET total_cents=101,open_cents=101 WHERE txn_id=$1',[ids[60]]);
  else await c.db.pool.query('UPDATE posting SET amount_cents=CASE WHEN amount_cents<0 THEN -1000001 ELSE 1000001 END WHERE txn_id=$1',[ids[60]]);
  assert.equal((await c.model({rule})).attention.counts[key],101);fold=await c.dismissed('stale');assert.equal(fold.matchingCount,19);assert.equal(fold.staleCount,1);
  assert.deepEqual(Object.keys(fold.page[0]).sort(),['dismissedAt','itemKey','note']);
},{bill:false,window:rule==='large'});
async function renew(c,action){const key=settingsKey({SETTINGS_KEY:'ab'.repeat(32)}),args={orgId:c.f.orgId,userId:c.second.userId,actorCtx:c.owner,key,now:N};
  let issued;if(action==='reset')issued=await ownerResetViewer(c.db.pool,args);else{await removeSecondViewer(c.db.pool,args);issued=await grantSecondViewer(c.db.pool,args);}
  const invite=await findOpenInvite(c.db.pool,{token:issued.token,orgSlug:'mvtest',now:N}),secret=await pendingSecret(c.db.pool,{invite,key});
  await completeInvite(c.db.pool,{token:issued.token,orgSlug:'mvtest',key,now:N,password:'sample password 1',password2:'sample password 1',code:makeTotp(secret).generate({timestamp:+N})});}
for(const operation of ['dismiss','undismiss'])for(const action of ['reset','regrant'])dismissalTest(`stale mutation identity: ${operation} after ${action}`,async c=>{
  const row=await billRow(c);await c.dismiss(row);const ownerRows=(await c.state()).dismissals;let ran=false,financial=0,expected;
  const inspect=async()=>({...(await c.state()),preferences:(await c.db.pool.query('SELECT * FROM morning_preference ORDER BY viewer_key')).rows,
    floors:(await c.db.pool.query('SELECT * FROM morning_floor ORDER BY viewer_key,account_id')).rows});
  const hooks={beforeAcquire:async()=>{ran=true;await renew(c,action);expected=await inspect();},
    beforeQuery:({text})=>{if(/\b(posting|mv_attention|morning_snapshot_account)\b/.test(text))financial++;}};
  const args={identity:c.second,context:c.ctx(c.second),hooks};
  await assert.rejects(operation==='dismiss'?c.dismiss(row,args):c.undismiss(row.itemKey,args),e=>e.reason==='stale_session');
  assert.equal(ran,true);assert.deepEqual((await c.state()).dismissals,ownerRows);
  assert.equal(financial,0);assert.deepEqual(await inspect(),expected);
  assert.equal((await c.db.pool.query('SELECT count(*)::int n FROM morning_floor WHERE viewer_key=$1',[c.second.viewerKey])).rows[0].n,0);
},{second:true});
dismissalTest('R2-1 unavailable rule refuses mutation and retains the saved relationship',async c=>{const row=await billRow(c);await c.dismiss(row);const before=await c.state();
  const service=createMorningService({runtime:c.runtime,env:{NODE_ENV:'test'},deps:{billsAndInvoices:async()=>{throw Object.assign(new Error('Sample unavailable'),{code:'42P01'});}}});
  assert.equal(await c.dismiss(row,{service}),'unavailable');assert.deepEqual(await c.state(),before);
  const fold=await c.dismissed('stale',{service});assert.equal(fold.staleCount,null);assert.equal(fold.matchingCount,null);assert.deepEqual(fold.page,[]);
  assert.equal((await c.dismissed()).matchingCount,1);
});
test('cause helpers are re-exported from the shared contract',()=>{assert.equal(RULE_VERSIONS['new-payee'],1);assert.equal(canonical({b:2,a:1}),'{"a":1,"b":2}');
  assert.match(itemVersion('large',{}),/^[a-f0-9]{64}$/);assert.deepEqual(versionFacts({rule:'floor',signedCents:1,floorCents:2}),{type:'bank',signedCents:1,floorCents:2,below:true});});
