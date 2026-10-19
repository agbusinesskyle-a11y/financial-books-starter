import { randomUUID } from 'node:crypto';
import { mvOrg, mvReadyViewers, mvVendor, mvTxn, mvApply } from '../test/morning-fixtures.js';
import { createMorningService } from '../lib/data/morning.js';
import { dismissItem } from '../lib/data/morning/dismissals.js';
import { refuseDemoDatabase } from '../lib/data/demo.js';

export const MORNING_SAMPLE_NOW=new Date('2026-10-17T14:01:00Z');
export function assertHarnessDatabase(db) {
  let url;try{url=new URL(db.url);}catch{throw new Error('A loopback harness database is required');}
  if(url.hostname!=='127.0.0.1'||url.port!=='5499'||!/^\/fb_test_[a-f0-9]{12}$/.test(url.pathname))throw new Error('A loopback harness database is required');
  return url.pathname.slice(1);
}
export async function seedMorningScenario(db,{scenario,clock,env=db.env??{NODE_ENV:'test',DATABASE_URL:db.url}}) {
  const name=assertHarnessDatabase(db);
  await refuseDemoDatabase(db.pool,env);
  if(env.DATABASE_URL!==db.url||env.NODE_ENV!=='test')throw new Error('Use the exact harness database environment');
  if(!['first-look','comparison','incomplete'].includes(scenario))throw new Error('Unknown Morning scenario');
  const current=(await db.pool.query('SELECT current_database() name')).rows[0].name;
  if(current!==name)throw new Error('Connected database differs from the harness database');
  // Only this freshly created, exact harness database is reset. Stable IDs also
  // keep the running application's trusted sample-org identity valid after reset.
  await db.pool.query('TRUNCATE org RESTART IDENTITY CASCADE');
  const A='Sample company A',B='Sample household B';
  const f=await mvOrg(db.pool,{slug:'sample',companies:[A],households:[B]});
  if(f.orgId!==1)throw new Error('Unexpected sample organization identity');
  const a=f.entities[A],b=f.entities[B],bank=f.accounts[A].checking;
  await db.pool.query("INSERT INTO tax_profile(org_id,entity_id,return_type) VALUES($1,$2,'form_1065')",[f.orgId,a]);
  await db.pool.query('UPDATE entity SET name=$2 WHERE entity_id=$1',[b,('Sample household B '+'long label ').padEnd(120,'x')]);
  const bare=async name=>(await db.pool.query("INSERT INTO account(org_id,entity_id,name,type,active) VALUES($1,$2,$3,'bank',false) RETURNING account_id",[f.orgId,a,name])).rows[0].account_id;
  const inactive=await bare('Sample inactive zero'),removed=await bare('Sample removed account');
  const add=(type,cents,extra={})=>mvTxn(db.pool,{orgId:f.orgId,entityId:a,type,date:'2026-10-17',createdAt:new Date('2026-10-17T13:30:00Z'),
    postings:[{accountId:bank,cents}],...extra});
  for(const [entityId,accountId,cents] of [[a,bank,20000000],[a,f.accounts[A].card,-1000000],[b,f.accounts[B].checking,10000000]])
    await add('journal_entry',cents,{entityId,date:'2026-10-16',createdAt:new Date('2026-10-16T12:00:00Z'),postings:[{accountId,cents}]});
  const vendor=await mvVendor(db.pool,{orgId:f.orgId,entityId:a,name:'Sample bill vendor'}),bills=[];
  for(let i=0;i<3;i++)bills.push(await add('bill',-10000,{vendorId:vendor,date:'2026-10-01',dueDate:'2026-10-16',createdAt:new Date('2026-10-16T12:00:00Z'),postings:[{accountId:f.accounts[A].ap,cents:-10000}]}));
  const ll=randomUUID();
  await db.pool.query(`INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_at,linked_by)
    VALUES($1,$2,$3,'Sample company A','2026-10-10','the owner')`,[f.orgId,a,randomUUID()]);
  await db.pool.query(`INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,books_account_id,include,owned_now)
    VALUES($1,$2,$3,'Sample checking feed','depository',$4,true,false)`,[f.orgId,a,ll,bank]);
  for(let i=0;i<3;i++)await db.pool.query(`INSERT INTO bank_feed_item(org_id,entity_id,ll_account_id,ll_transaction_id,revision,pending,posted_date,amount_cents,bank_state,review_state)
    VALUES($1,$2,$3,$4,1,false,'2026-10-17',100,'active','new')`,[f.orgId,a,ll,randomUUID()]);
  await db.pool.query(`INSERT INTO bank_feed_pull(org_id,entity_id,trigger,started_at,finished_at,status,new_count)
    VALUES($1,$2,'refresh','2026-10-17T12:00Z','2026-10-17T12:01Z','ok',0)`,[f.orgId,a]);
  await db.pool.query(`INSERT INTO import_batch(org_id,entity_id,source,company_name,summary,imported_by,created_at)
    VALUES($1,$2,'qbo_import','Sample company A','{}','the owner','2026-10-01T10:00Z')`,[f.orgId,a]);
  const {owner}=await mvReadyViewers(db.pool,{...f,second:false}),service=createMorningService({env});
  clock.set(new Date('2026-10-17T13:00:00Z'));
  const context={sid:owner.sessionId,vk:'owner',epoch:1,gen:null,kind:'ctx',resource:null,after:null,iat:+clock.now()};
  const initial=await service.readMorningDetail(db.pool,{identity:owner,context,pageRequest:{kind:'attention',resource:{rule:'bill'}},now:clock.now,render:async()=>''});
  if(initial.status!=='ok')throw new Error('Sample bill read failed');
  const paid=initial.model.attention.page.find(r=>r.display.txnId===bills[2]);
  if(!paid)throw new Error('Sample paid-bill fixture missing');
  const dismissed=await dismissItem(db.pool,{identity:owner,itemKey:paid.itemKey,itemVersion:paid.version,note:'<b>sample note</b>',context,now:clock.now,service});
  if(dismissed!=='dismissed')throw new Error('Sample dismissal failed');
  if(scenario!=='first-look'){
    const observed=await service.observeMorning(db.pool,{identity:owner,now:clock.now,render:async()=>''});
    if(observed.status!=='ok'||!observed.model.complete)throw new Error('Sample baseline failed');
  }
  const credit=await add('vendor_credit',10000,{vendorId:vendor,date:'2026-10-17',postings:[{accountId:f.accounts[A].ap,cents:10000}]});
  await mvApply(db.pool,{orgId:f.orgId,creditTxnId:credit,chargeTxnId:bills[2],cents:10000,on:'2026-10-17'});
  for(let i=0;i<120;i++){
    const vendorId=await mvVendor(db.pool,{orgId:f.orgId,entityId:a,name:`Sample expense vendor ${i+1}`});
    await add('expense',-60000,{vendorId});
  }
  const duplicateVendor=await mvVendor(db.pool,{orgId:f.orgId,entityId:a,name:'Sample duplicate vendor'});
  for(let i=0;i<60;i++)await add('check',-40000,{vendorId:duplicateVendor});
  await db.pool.query('DELETE FROM account WHERE org_id=$1 AND account_id=$2',[f.orgId,removed]);
  if(scenario==='incomplete')await db.pool.query("INSERT INTO currency_settings(org_id,entity_id,home,turned_on_by) VALUES($1,$2,'EUR','the owner')",[f.orgId,a]);
  clock.set(MORNING_SAMPLE_NOW);
  return {ids:{orgId:f.orgId,companyA:a,companyB:b,checking:bank,card:f.accounts[A].card,inactive,removed,bills:bills.slice(0,2),paidBill:bills[2]},
    expected:{cashCents:scenario==='incomplete'?null:20400000,availableCents:scenario==='incomplete'?null:19400000,
      accountCents:scenario==='incomplete'?null:10400000,changeCents:scenario==='comparison'?-9600000:null,
      bankLines:3,bills:2,duplicateGroups:scenario==='comparison'?1:0,entries:scenario==='comparison'?120:0,smallerEntries:scenario==='comparison'?60:0,staleDismissals:1}};
}
