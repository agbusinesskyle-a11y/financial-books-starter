import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { mvOrg, mvTxn, mvReadyViewers } from './morning-fixtures.js';
import { withReadSnapshot, createMorningRuntime } from '../lib/data/morning/locks.js';
import { phoenixDate } from '../lib/data/morning/clock.js';
import { readBalanceVector, companyTotals, readCurrentMetadata, compareVectors, readHomeCurrencyScope, homeCents, sumHomeCents } from '../lib/data/morning/balances.js';

const A='Sample company A', B='Sample company B', H='Sample household A', today='2026-10-17';
function balanceTest(name,fn){test(name,async t=>{
  const db=await freshDb();t.after(()=>db.drop());const f=await mvOrg(db.pool,{households:[H]}),{owner}=await mvReadyViewers(db.pool,{...f,second:false});
  const addAccount=async(entityId,name,type='bank',extra={})=>(await db.pool.query('INSERT INTO account(org_id,entity_id,name,type,parent_id,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING account_id',[f.orgId,entityId,name,type,extra.parentId??null,extra.active??true])).rows[0].account_id;
  const post=(entityId,accountId,cents,date='2026-10-16')=>mvTxn(db.pool,{orgId:f.orgId,entityId,type:'journal_entry',date,postings:[{accountId,cents}]});
  const a=f.accounts[A],b=f.accounts[B],h=f.accounts[H];
  a.petty=await addAccount(f.entities[A],'Petty','bank',{parentId:a.checking});a.card2=await addAccount(f.entities[A],'Card 2','credit_card');a.old=await addAccount(f.entities[A],'Old checking','bank',{active:false});
  for(const [company,account,cents]of[[A,a.checking,98700],[A,a.petty,1000],[A,a.savings,-5000],[A,a.card,-29800],[A,a.card2,2000],[B,b.checking,250000],[H,h.checking,40000],[H,h.card,-10000]])await post(f.entities[company],account,cents);
  await post(f.entities[A],a.checking,1300,today);await post(f.entities[A],a.card,-200,today);await post(f.entities[B],b.checking,999999,'2026-10-18');
  const run=fn2=>withReadSnapshot(db.pool,{orgId:f.orgId,viewerKey:'owner',identity:owner,runtime:createMorningRuntime()},fn2);
  const vector=(date=today)=>run(tx=>readBalanceVector(tx,{orgId:f.orgId,today:date,budget:tx}));
  await fn({pool:db.pool,f,a,b,h,addAccount,post,run,vector});
});}
balanceTest('supported balances, signs and totals',async({vector})=>{
  const v=companyTotals(await vector());assert.deepEqual(v.companies.map(c=>[c.cashCents,c.cardsOwedCents,c.availableCents]),[[96000,28000,68000],[250000,0,250000],[40000,10000,30000]]);
  assert.deepEqual([v.grand.cashCents,v.grand.cardsOwedCents,v.grand.availableCents],[386000,38000,348000]);
  assert.equal(v.grand.postedTodayCashCents,1300);assert.equal(v.grand.postedTodayAvailableCents,1100);
});
balanceTest('hierarchy counted once',async({vector,a})=>{const v=await vector();assert.equal(v.accounts.find(r=>r.accountId===a.petty).signedCents,1000);assert.equal(v.accounts.find(r=>r.accountId===a.checking).signedCents,100000);assert.equal(companyTotals(v).companies[0].cashCents,96000);});
balanceTest('code-r1 B5: balance postings must match the account company', async ({pool,f,a,b,post,run}) => {
  const txn = await post(f.entities[B], b.checking, 10000, today);
  await pool.query('UPDATE posting SET account_id=$1 WHERE txn_id=$2 AND amount_cents=10000', [a.checking,txn]);
  for (const combined of [false,true]) {
    const vector = await run(tx => readBalanceVector(tx,{orgId:f.orgId,today,budget:tx,combined}));
    const account = vector.accounts.find(row => row.accountId === a.checking);
    assert.equal(account.signedCents,100000, 'foreign-company posting does not enter the balance');
    assert.equal(account.todayCents,1300, 'posted-today uses the same company scope');
    assert.equal(companyTotals(vector).companies.find(row => row.entityId === f.entities[A]).cashCents,96000);
  }
});
balanceTest('inactive zero accounts are in the vector',async({vector,a})=>{const r=(await vector()).accounts.find(r=>r.accountId===a.old);assert.equal(r.signedCents,0);assert.equal(r.active,false);assert.equal(r.hidden,true);});
balanceTest('Personal last; none and several',async({pool,vector,f})=>{
  assert.deepEqual((await vector()).companies.map(c=>c.name),[A,B,H]);await pool.query('DELETE FROM tax_profile WHERE org_id=$1',[f.orgId]);let v=await vector();assert.equal(v.personal.count,0);assert.equal(v.companies.length,3);
  await pool.query("INSERT INTO tax_profile(org_id,entity_id,return_type) VALUES($1,$2,'household_1040'),($1,$3,'household_1040')",[f.orgId,f.entities[A],f.entities[H]]);v=await vector();assert.equal(v.personal.count,2);assert.equal(v.companies[0].name,B);assert.ok(v.companies.slice(1).every(c=>c.isPersonal));
});
balanceTest('converted foreign entries use home cents',async({pool,f,b,post,vector})=>{
  const id=await post(f.entities[B],b.checking,10000);await pool.query("UPDATE txn SET currency='EUR',exchange_rate=1.11111111,foreign_total_cents=9000 WHERE txn_id=$1",[id]);assert.equal(companyTotals(await vector()).companies[1].cashCents,260000);
});
balanceTest('unsafe totals are unavailable, not rounded',async({f,b,post,addAccount,vector})=>{
  await post(f.entities[B],b.checking,-250000);await post(f.entities[B],b.checking,9007199254740000);const bank=await addAccount(f.entities[B],'Sample additional bank');await post(f.entities[B],bank,9007199254740000);
  const totals=companyTotals(await vector());assert.equal(totals.companies[1].status,'unavailable');assert.equal(totals.grand.status,'incomplete');for(const [k,v]of Object.entries(totals.grand))if(k.endsWith('Cents'))assert.equal(v,null);assert.equal(totals.companies[0].status,'ok');assert.equal(totals.companies[2].status,'ok');
});
balanceTest('Phoenix midnight',async({pool,f,vector})=>{
  await pool.query("UPDATE entity SET time_zone='America/New_York' WHERE entity_id=$1",[f.entities[A]]);assert.equal(companyTotals(await vector(phoenixDate(new Date('2026-10-18T06:30:00Z')))).companies[1].cashCents,250000);
});
const company=(entityId,name=A)=>({entityId,name,isPersonal:false});
const account=(accountId,type,signedCents,entityId=1,active=true)=>({accountId,entityId,name:'Sample account',type,active,signedCents});
const vec=(accounts,companies=[company(1)])=>({accounts,companies});
const baseline=vec([account(1,'bank',1000),account(2,'credit_card',-500),account(3,'bank',700),account(4,'bank',200)]);
const current=vec([account(1,'bank',1500),account(2,'credit_card',-800),account(5,'bank',300)]);
const metadata=new Map([...current.accounts.map(a=>[a.accountId,a]),[4,{...account(4,'other_current_asset',200)}]]);
test('union comparison',()=>{
  const c=compareVectors(baseline,current,metadata);assert.equal(c.cashChangeCents,-100);assert.equal(c.availableChangeCents,-400);assert.equal(c.scopeChanged,true);
  assert.deepEqual(c.rows.map(r=>[r.accountId,r.change,r.reason,r.cashDeltaCents,r.availableDeltaCents]),[[1,'changed',null,500,500],[2,'changed',null,0,-300],[3,'left_scope','no_longer_present',-700,-700],[4,'left_scope','reclassified',-200,-200],[5,'entered_scope',null,300,300]]);
});
test('failed metadata lookup is unavailable',()=>{const c=compareVectors(baseline,current,null);assert.equal(c.rows.find(r=>r.accountId===3).reason,'unavailable');assert.equal(c.cashChangeCents,null);});
balanceTest('bounded statements',async({pool,run,f})=>{
  const count=()=>run(async tx=>{let n=0;const wrapped={...tx,query:(...args)=>{n++;return tx.query(...args);}};await readBalanceVector(wrapped,{orgId:f.orgId,today,budget:wrapped});return n;});assert.equal(await count(),2);
  await pool.query("INSERT INTO entity(org_id,name,time_zone) SELECT $1,'Sample extra company '||n,'America/Phoenix' FROM generate_series(1,27)n",[f.orgId]);assert.equal(await count(),2);
});
test('company allocation',()=>{
  const before=vec([account(1,'bank',1000),account(2,'credit_card',-500),account(3,'bank',700,2)],[company(1),company(2,B)]),after=vec([account(1,'bank',1500),account(2,'credit_card',-800)]);
  const c=compareVectors(before,after,new Map(after.accounts.map(a=>[a.accountId,a])));assert.equal(c.cashChangeCents,-200);assert.equal(c.availableChangeCents,-500);assert.equal(c.scopeChanged,true);
  assert.deepEqual(c.companies.map(c=>[c.before?.cashCents,c.before?.availableCents,c.after?.cashCents??null,c.after?.availableCents??null,c.cashDeltaCents,c.availableDeltaCents]),[[1000,500,1500,700,500,200],[700,700,null,null,-700,-700]]);assert.equal(c.companies[1].before.name,B);
  const moved=compareVectors(vec([account(1,'bank',1000)]),vec([account(1,'bank',1200,2)],[company(2,B)]),new Map([[1,account(1,'bank',1200,2)]]));assert.deepEqual(moved.companies.map(c=>[c.cashDeltaCents,c.availableDeltaCents]),[[-1000,-1000],[1200,1200]]);assert.equal(moved.cashChangeCents,200);assert.equal(moved.rows[0].reason,'company_changed');assert.equal(moved.rows[0].before.entityId,1);assert.equal(moved.rows[0].after.entityId,2);
});
balanceTest('home currency',async({pool,f,vector})=>{
  for(const home of ['USD','EUR','','XYZ']){
    await pool.query("INSERT INTO currency_settings(org_id,entity_id,turned_on_by,home) VALUES($1,$2,'the owner',$3) ON CONFLICT(org_id,entity_id) DO UPDATE SET home=excluded.home",[f.orgId,f.entities[B],home]);const v=await vector(),totals=companyTotals(v);
    assert.equal(totals.companies[1].status,home==='USD'?'ok':'unavailable');if(home!=='USD'){assert.deepEqual(v.failures,[{entityId:f.entities[B],reason:'unsupported_home_currency'}]);assert.equal(totals.grand.cashCents,null);assert.equal(totals.companies[0].status,'ok');}
  }
});
test('inactive zero display facts',()=>{
  const a=account(1,'bank',0,1,false);assert.equal(compareVectors(vec([a]),vec([a]),new Map([[1,a]])).rows.length,0);
  let r=compareVectors(vec([account(1,'bank',100)]),vec([a]),new Map([[1,a]])).rows[0];assert.equal(r.hidden,false);assert.equal(r.availableDeltaCents,-100);
  r=compareVectors(vec([]),vec([a]),new Map([[1,a]])).rows[0];assert.equal(r.hidden,false);assert.equal(r.change,'entered_scope');
});
balanceTest('same-snapshot currency scope refuses mixed monetary aggregates (R2-2 foundation)',async({pool,f,run})=>{
  for(const home of ['EUR','','XYZ']){
    await pool.query("INSERT INTO currency_settings(org_id,entity_id,turned_on_by,home) VALUES($1,$2,'the owner',$3) ON CONFLICT(org_id,entity_id) DO UPDATE SET home=excluded.home",[f.orgId,f.entities[B],home]);
    await run(async tx=>{const vector=await readBalanceVector(tx,{orgId:f.orgId,today,budget:tx}),scope=await readHomeCurrencyScope(tx,{orgId:f.orgId});assert.equal(scope,vector.currencyScope);assert.equal(homeCents(scope,f.entities[A],10000),10000);assert.equal(homeCents(scope,f.entities[B],10000),null);assert.equal(homeCents(scope,999999,10000),null);assert.equal(sumHomeCents(scope,[{entityId:f.entities[A],cents:10000},{entityId:f.entities[B],cents:10000}]),null);assert.equal(scope.unavailable[0].reason,'unsupported_home_currency');});
  }
});
balanceTest('metadata lookup is batched and organization scoped',async({pool,f,run,a})=>{
  const other=await mvOrg(pool,{slug:'foreign'});await run(async tx=>{const m=await readCurrentMetadata(tx,{orgId:f.orgId,accountIds:[a.old,other.accounts[A].checking],budget:tx});assert.equal(m.size,1);assert.equal(m.get(a.old).active,false);});
});
test('unsafe comparison subtraction is unavailable',()=>{const a=account(1,'bank',9007199254740991),b=account(1,'bank',-1);const c=compareVectors(vec([a]),vec([b]),new Map([[1,b]]));assert.equal(c.cashChangeCents,null);assert.equal(c.rows[0].availableDeltaCents,null);});
test('unsafe grand totals cannot produce a known zero change',()=>{const v=vec([account(1,'bank',9007199254740991),account(2,'bank',1,2)],[company(1),company(2,B)]);const c=compareVectors(v,v,new Map(v.accounts.map(a=>[a.accountId,a])));assert.equal(c.cashChangeCents,null);assert.equal(c.availableChangeCents,null);});
