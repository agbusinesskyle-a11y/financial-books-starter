import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { mvOrg,mvReadyViewers,mvVendor,mvCustomer,mvTxn,mvApply } from './morning-fixtures.js';
import { withReadSnapshot,createMorningRuntime } from '../lib/data/morning/locks.js';
import { prepareItems,foldCurrentItems } from '../lib/data/morning/items.js';
import { readHomeCurrencyScope } from '../lib/data/morning/balances.js';
import { openDocuments,openItems } from '../lib/reports/receivables.js';
import { billsAndInvoices } from '../lib/data/morning/bills.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
const A='Sample company A',B='Sample company B',today='2026-10-17';
function billTest(name,fn,{basic=false}={}){test(name,async t=>{
  const db=await freshDb();t.after(()=>db.drop());const f=await mvOrg(db.pool),{owner}=await mvReadyViewers(db.pool,{...f,second:false}),parties={};
  for(const company of [A,B])parties[company]={vendorId:await mvVendor(db.pool,{orgId:f.orgId,entityId:f.entities[company],name:'Sample vendor A'}),customerId:await mvCustomer(db.pool,{orgId:f.orgId,entityId:f.entities[company],name:'Sample customer A'})};
  const run=work=>withReadSnapshot(db.pool,{orgId:f.orgId,viewerKey:'owner',identity:owner,runtime:createMorningRuntime()},work);
  const add=(type='bill',due='2026-10-16',extra={},company=A)=>mvTxn(db.pool,{orgId:f.orgId,entityId:f.entities[company],type,date:'2026-09-30',dueDate:due,...(['invoice','late_fee','credit_memo','payment'].includes(type)?{customerId:parties[company].customerId}:{vendorId:parties[company].vendorId}),postings:[{accountId:f.accounts[company][['invoice','late_fee','credit_memo','payment'].includes(type)?'ar':'ap'],cents:100000}],totalCents:100000,...extra});
  const review=(extra={})=>run(async tx=>{const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget:tx});return billsAndInvoices(tx,{orgId:f.orgId,entityIds:Object.values(f.entities),today,store,budget:tx,...extra});});
  const docs=(extra={})=>openDocuments(db.pool,{orgId:f.orgId,entityIds:Object.values(f.entities),asOf:today,types:['bill'],...extra});
  const ids={};if(basic){for(const [key,due,approval] of [['B1','10-10'],['B2','10-17'],['B3','10-24'],['B4','10-25'],['B5','11-30','awaiting'],['B6','10-12','awaiting'],['B7','10-10','awaiting'],['B8','10-10','awaiting'],['B9','10-01']])ids[key]=await add('bill',`2026-${due}`,{approval,voided:key==='B8'});
    const payment=await add('bill_payment',null,{totalCents:200000});for(const [key,on] of [['B7','2026-10-01'],['B9','2026-10-20']])await mvApply(db.pool,{orgId:f.orgId,creditTxnId:payment,chargeTxnId:ids[key],cents:100000,on});
    await add('vendor_credit',null,{totalCents:5000});await add('item_receipt',null);ids.I1=await add('invoice','2026-10-16',{totalCents:30000});await add('invoice',today);ids.LF=await add('late_fee','2026-10-01',{totalCents:2500});await add('credit_memo',null);await add('payment',null);
  }await fn({db,f,run,add,review,docs,ids});
});}
billTest('bills as of today',async c=>{const r=(await c.review()).bills;assert.deepEqual(r.rows.map(x=>x.txnId),['B9','B1','B6','B2','B3','B5'].map(k=>c.ids[k]));assert.deepEqual([r.count,r.openCents,r.dueCount,r.awaitingCount],[6,600000,5,2]);assert.deepEqual(r.rows.map(x=>x.reasons),[['overdue'],['overdue'],['overdue','awaiting_approval'],['due_today'],['due_soon'],['awaiting_approval']]);assert.deepEqual(r.rows.map(x=>x.severity),['overdue','overdue','overdue','today','next_seven','later']);},{basic:true});
billTest('overdue invoices',async c=>{const r=(await c.review()).invoices;assert.deepEqual(r.rows.map(x=>[x.txnId,x.daysLate]),[[c.ids.LF,16],[c.ids.I1,1]]);assert.equal(r.count,2);assert.equal(r.openCents,32500);},{basic:true});
billTest('a future-dated application does not hide a bill',async c=>{assert.equal((await c.db.pool.query('SELECT open_cents FROM txn WHERE txn_id=$1',[c.ids.B9])).rows[0].open_cents,0);assert.equal((await c.review()).bills.rows.find(x=>x.txnId===c.ids.B9).open,100000);},{basic:true});
test('parity with openItems',async t=>{const db=await freshDb();t.after(()=>db.drop());const ids=await writeSample(db.pool,generateSample({asOf:'2026-10-12'}));
  const entities=(await db.pool.query('SELECT org_id,entity_id FROM entity')).rows;
  for(const e of entities)for(const side of ['ap','ar']){const types=side==='ap'?['bill']:['invoice','late_fee'];const expected=(await openItems(db.pool,{orgId:e.org_id,entityId:e.entity_id,side,asOf:'2026-10-12'})).filter(x=>!x.credit&&x.open>0&&types.includes(x.type)&&x.lineNo===undefined).map(x=>[x.txnId,x.open]).sort((a,b)=>a[0]-b[0]);let after=null,actual=[];do{const r=await openDocuments(db.pool,{orgId:e.org_id,entityIds:[e.entity_id],asOf:'2026-10-12',types,after});actual.push(...r.rows.map(x=>[x.txnId,x.open]));after=r.next;}while(after);assert.deepEqual(actual.sort((a,b)=>a[0]-b[0]),expected);}assert.ok(ids);
});
billTest('batched entities, two statements',async c=>{await c.add();await c.add('bill','2026-10-16',{},B);let statements=0;const db={query:(...args)=>{statements++;return c.db.pool.query(...args);}};const r=await openDocuments(db,{orgId:c.f.orgId,entityIds:Object.values(c.f.entities),asOf:today,types:['bill']});assert.equal(statements,2);assert.deepEqual(new Set(r.rows.map(x=>x.entityId)),new Set(Object.values(c.f.entities)));});
billTest('keyset paging',async c=>{for(let i=0;i<120;i++)await c.add();let after=null,lengths=[];do{const r=await c.docs({after});assert.equal(r.count,120);lengths.push(r.rows.length);after=r.next;}while(after);assert.deepEqual(lengths,[50,50,20]);});
billTest('full-set bill folds',async c=>{await c.db.pool.query("SELECT setval(pg_get_serial_sequence('txn','txn_id'),1001,false)");for(let i=1;i<=120;i++)await c.add('bill','2026-10-16',{approval:i%2?'awaiting':'approved',totalCents:100});let after=null,all=[];do{const r=(await c.review({after:{bills:after,invoices:null}})).bills;assert.equal(r.dueCount,120);assert.equal(r.awaitingCount,60);all.push(...r.rows);after=r.next;}while(after);
  for(const x of [...all.slice(0,10),...all.slice(60,70)])await c.db.pool.query("INSERT INTO morning_dismissal(org_id,viewer_key,item_key,item_version,rule_version) VALUES($1,'owner',$2,$3,1)",[c.f.orgId,x.itemKey,x.version]);
  await c.run(async tx=>{const store=await prepareItems(tx,{orgId:c.f.orgId,viewerKey:'owner',budget:tx});const r=(await billsAndInvoices(tx,{orgId:c.f.orgId,entityIds:Object.values(c.f.entities),today,store,budget:tx})).bills;assert.deepEqual([r.count,r.dueCount,r.awaitingCount,r.openCents],[100,100,50,10000]);assert.deepEqual(r.rows.map(x=>x.txnId),all.slice(10,60).map(x=>x.txnId));assert.equal((await foldCurrentItems(tx,{store})).stale,0);});
});
billTest('null due and type parity',async c=>{
  // Bills/invoices cannot have NULL due under migrations 001/009. Use a valid document to exercise the shared fallback.
  const ir=await c.add('item_receipt',null,{date:'2026-10-10'});assert.equal((await c.docs({types:['item_receipt']})).rows.find(x=>x.txnId===ir).due,'2026-10-10');await c.add('vendor_credit',null);
  const paid=await c.add(),overpaid=await c.add();const p=await c.add('bill_payment',null,{totalCents:300000});for(const [id,cents] of [[paid,100000],[overpaid,100001]])await mvApply(c.db.pool,{orgId:c.f.orgId,creditTxnId:p,chargeTxnId:id,cents,on:'2026-10-01'});
  await c.add('invoice','2026-10-16',{totalCents:100});await c.add('late_fee','2026-10-16',{totalCents:100});await c.add('credit_memo',null);const r=await c.review();assert.equal(r.bills.count,0);assert.equal(r.invoices.count,2);assert.equal(r.invoices.openCents,200);
});
billTest('unsupported and unknown home currency keeps counts and refuses mixed AP/AR dollars',async c=>{
  for(const company of [A,B])for(const type of ['bill','invoice'])await c.add(type,'2026-10-16',{totalCents:10000},company);
  for(const home of ['EUR','','XYZ']){await c.db.pool.query("INSERT INTO currency_settings(org_id,entity_id,turned_on_by,home) VALUES($1,$2,'the owner',$3) ON CONFLICT(org_id,entity_id) DO UPDATE SET home=excluded.home",[c.f.orgId,c.f.entities[B],home]);
    await c.run(async tx=>{const currencyScope=await readHomeCurrencyScope(tx,{orgId:c.f.orgId}),store=await prepareItems(tx,{orgId:c.f.orgId,viewerKey:'owner',budget:tx});const r=await billsAndInvoices(tx,{orgId:c.f.orgId,entityIds:Object.values(c.f.entities),today,store,currencyScope,budget:tx});for(const section of [r.bills,r.invoices]){assert.equal(section.count,2);assert.equal(section.openCents,null);assert.equal(section.rows.find(x=>x.entityId===c.f.entities[A]).open,10000);const unknown=section.rows.find(x=>x.entityId===c.f.entities[B]);assert.equal(unknown.open,null);assert.equal(unknown.coverage,'unsupported_home_currency');assert.equal(section.coverage.known,false);}});
    const direct=await c.docs();assert.equal(direct.openCents,null);assert.equal(direct.count,2);assert.equal(direct.rows.find(x=>x.entityId===c.f.entities[B]).open,null);
  }
});
billTest('document store is bound to its company scope',async c=>{
  await c.add();await c.add('bill','2026-10-16',{},B);
  await c.run(async tx=>{
    const store=await prepareItems(tx,{orgId:c.f.orgId,viewerKey:'owner',budget:tx});
    const options={orgId:c.f.orgId,today,store,budget:tx,mode:'relation'};
    await billsAndInvoices(tx,{...options,entityIds:[c.f.entities[A]]});
    await assert.rejects(billsAndInvoices(tx,{...options,entityIds:[c.f.entities[B]]}),/Invalid document context/);
  });
});
