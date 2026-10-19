import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './harness.js';
import { withTransaction } from '../lib/db.js';
import { mvOrg, mvUser, mvTxn, mvVendor, mvCustomer, mvApply } from './morning-fixtures.js';

const hash = 'a'.repeat(64);
const tables = ['viewer','preference','company_setting','floor','snapshot_generation','snapshot_company','snapshot_account','visit','dismissal','delivery_setting','transport','message_claim'];
const owned = ['preference','floor','snapshot_generation','snapshot_company','snapshot_account','visit','dismissal','message_claim'];
function schemaTest(name, fn, options = {}) {
  test(name, async t => {
    const db = await freshDb();
    t.after(() => db.drop());
    const f = await mvOrg(db.pool, options);
    await fn(db.pool, f);
  });
}
const rejects = (promise, name) => assert.rejects(promise, e => (e.constraint ?? e.message).includes(name));
const owner = (db, o) => db.query(`INSERT INTO morning_viewer (org_id,viewer_key,enrollment_state) VALUES ($1,'owner','ready')`, [o]);
const viewer = (db, o, u, state = 'ready') => db.query(`INSERT INTO morning_viewer (org_id,viewer_key,user_id,enrollment_state) VALUES ($1,$2,$3,$4)`, [o, String(u), u, state]);
async function generation(db, f, { key = 'owner', at = '2026-10-17T15:00:00Z', accountId = f.accounts['Sample company A']?.checking, entityId = f.entities['Sample company A'] } = {}) {
  const id = randomUUID();
  await db.query(`INSERT INTO morning_snapshot_generation (org_id,viewer_key,generation_id,captured_at,as_of_date) VALUES ($1,$2,$3,$4,'2026-10-17')`, [f.orgId,key,id,at]);
  if (entityId) await db.query(`INSERT INTO morning_snapshot_company (org_id,viewer_key,generation_id,observed_entity_id,entity_name,is_personal) VALUES ($1,$2,$3,$4,'Sample company A',false)`, [f.orgId,key,id,entityId]);
  if (accountId) await db.query(`INSERT INTO morning_snapshot_account (org_id,viewer_key,generation_id,observed_entity_id,observed_account_id,account_name,account_type,active,signed_cents)
    VALUES ($1,$2,$3,$4,$5,'Sample checking','bank',true,100)`, [f.orgId,key,id,entityId,accountId]);
  return id;
}
const visit = (db, o, key, c, l, anchor = '2026-10-17T15:00:00Z', shown = '2026-10-17T15:00:00Z') => db.query(`INSERT INTO morning_visit
  (org_id,viewer_key,comparison_generation_id,latest_generation_id,reuse_anchor_at,latest_shown_at) VALUES ($1,$2,$3,$4,$5,$6)`, [o,key,c,l,anchor,shown]);
const claim = (db, o, key = 'owner', state = 'claimed') => db.query(`INSERT INTO morning_message_claim
  (org_id,viewer_key,sent_on,claim_id,state,captured_at,membership_epoch,recipient_settings_version,delivery_settings_version,transport_source_revision,transport_approved_revision,channel)
  VALUES ($1,$2,'2026-10-17',$3,$4,now(),1,1,1,1,1,'sms')`, [o,key,randomUUID(),state]);
const bareAccount = async (db, f) => (await db.query(`INSERT INTO account (org_id,entity_id,name,type) VALUES ($1,$2,'Sample disposable bank','bank') RETURNING account_id`, [f.orgId,f.entities['Sample company A']])).rows[0].account_id;

schemaTest('viewer: owner key iff null user and owner is always ready', async (db, f) => {
  await rejects(db.query(`INSERT INTO morning_viewer (org_id,viewer_key,enrollment_state) VALUES ($1,'owner','pending_enrollment')`, [f.orgId]), 'morning_viewer_owner_ready');
  await rejects(db.query(`INSERT INTO morning_viewer (org_id,viewer_key,enrollment_state) VALUES ($1,'7','ready')`, [f.orgId]), 'morning_viewer_owner_key');
  const { userId } = await mvUser(db, { orgId:f.orgId, email:'viewer@sample.example' });
  await rejects(db.query(`INSERT INTO morning_viewer (org_id,viewer_key,user_id,enrollment_state) VALUES ($1,$2,$3,'ready')`, [f.orgId,String(userId+1),userId]), 'morning_viewer_user_key');
});
schemaTest('viewer: at most one reserved-or-ready second viewer', async (db, f) => {
  const u1 = await mvUser(db,{orgId:f.orgId,email:'one@sample.example'}), u2 = await mvUser(db,{orgId:f.orgId,email:'two@sample.example'});
  await viewer(db,f.orgId,u1.userId,'pending_enrollment');
  await rejects(viewer(db,f.orgId,u2.userId),'morning_viewer_one_second');
  await db.query(`UPDATE morning_viewer SET enrollment_state='disabled' WHERE org_id=$1`,[f.orgId]);
  await viewer(db,f.orgId,u2.userId);
});
schemaTest('viewer: owner row survives feature deletes, cascades with the org', async (db,f) => {
  await owner(db,f.orgId);
  const l = await generation(db,f);
  await visit(db,f.orgId,'owner',null,l);
  await rejects(db.query(`DELETE FROM morning_viewer WHERE org_id=$1 AND viewer_key='owner'`,[f.orgId]),'owner viewer row cannot be deleted');
  await db.query('DELETE FROM org WHERE org_id=$1',[f.orgId]);
  for (const table of tables) assert.equal((await db.query(`SELECT count(*)::int AS n FROM morning_${table}`)).rows[0].n,0,table);
},{companies:[]});
schemaTest('viewer: epoch cannot go back', async (db,f) => {
  await owner(db,f.orgId);
  await db.query('UPDATE morning_viewer SET membership_epoch=3 WHERE org_id=$1',[f.orgId]);
  await rejects(db.query('UPDATE morning_viewer SET membership_epoch=2 WHERE org_id=$1',[f.orgId]),'membership_epoch cannot go back');
});
schemaTest('preference: destinations and ranges', async (db,f) => {
  await owner(db,f.orgId);
  const insert = (columns,values) => db.query(`INSERT INTO morning_preference (org_id,viewer_key,membership_epoch,${columns}) VALUES ($1,'owner',1,${values})`,[f.orgId]);
  await rejects(insert('enabled','true'),'morning_preference_enabled_destination');
  await rejects(insert('email',"'viewer@sample.example'"),'morning_preference_one_destination');
  await rejects(insert('send_minute','1440'),'morning_preference_send_minute_check');
  await rejects(insert('detail_threshold_cents','-1'),'morning_preference_detail_threshold_cents_check');
  await insert('enabled','false');
  await rejects(db.query('UPDATE morning_preference SET enabled=false WHERE org_id=$1',[f.orgId]),'settings_version must advance');
});
schemaTest('snapshots: immutable and identity-checked', async (db,f) => {
  await owner(db,f.orgId); const g = await generation(db,f);
  for (const [table,column,value] of [['account','signed_cents','1'],['company','entity_name',"'Sample changed'"],['generation','complete','true']])
    await rejects(db.query(`UPDATE morning_snapshot_${table} SET ${column}=${value} WHERE org_id=$1`,[f.orgId]),'immutable');
  await rejects(db.query(`INSERT INTO morning_snapshot_account (org_id,viewer_key,generation_id,observed_entity_id,observed_account_id,account_name,account_type,active,signed_cents)
    VALUES ($1,'owner',$2,$3,$4,'Sample bank','bank',true,0)`,[f.orgId,g,f.entities['Sample company A'],f.accounts['Sample company B'].checking]),'is not in company');
});
schemaTest('snapshots: survive live account deletion', async (db,f) => {
  await owner(db,f.orgId); const a = await bareAccount(db,f); await generation(db,f,{accountId:a});
  await db.query('DELETE FROM account WHERE account_id=$1',[a]);
  assert.equal((await db.query('SELECT account_name FROM morning_snapshot_account WHERE observed_account_id=$1',[a])).rows[0].account_name,'Sample checking');
});
for (const table of ['company','account']) for (const operation of ['INSERT','DELETE'])
  schemaTest(`code-r1 N2: published ${table} sets reject ${operation} and permit parent pruning`, async (db,f) => {
    await owner(db,f.orgId);const g=await generation(db,f);
    await visit(db,f.orgId,'owner',null,g);
    const mutate=()=>operation==='DELETE'
      ? db.query(`DELETE FROM morning_snapshot_${table} WHERE generation_id=$1`,[g])
      : table==='company'
        ? db.query(`INSERT INTO morning_snapshot_company(org_id,viewer_key,generation_id,observed_entity_id,entity_name,is_personal)
            VALUES($1,'owner',$2,$3,'Sample company B',false)`,[f.orgId,g,f.entities['Sample company B']])
        : db.query(`INSERT INTO morning_snapshot_account(org_id,viewer_key,generation_id,observed_entity_id,observed_account_id,account_name,account_type,active,signed_cents)
            VALUES($1,'owner',$2,$3,$4,'Sample savings','bank',true,0)`,[f.orgId,g,f.entities['Sample company A'],f.accounts['Sample company A'].savings]);
    await rejects(mutate(),'sealed');
    const next=await generation(db,f,{at:'2026-10-17T16:00:00Z'});
    await db.query(`UPDATE morning_visit SET latest_generation_id=$2,latest_shown_at='2026-10-17T16:00:00Z',visit_version=visit_version+1 WHERE org_id=$1`,[f.orgId,next]);
    await rejects(mutate(),'sealed');
    await db.query('DELETE FROM morning_snapshot_generation WHERE generation_id=$1',[g]);
    assert.equal((await db.query('SELECT count(*)::int n FROM morning_snapshot_account WHERE generation_id=$1',[g])).rows[0].n,0);
  });
schemaTest('code-r1 N2: deferred visit references seal a generation inserted later in the transaction', async (db,f) => {
  await owner(db,f.orgId);const g=randomUUID();
  await withTransaction(db,async tx=>{
    await visit(tx,f.orgId,'owner',null,g);
    await tx.query(`INSERT INTO morning_snapshot_generation(org_id,viewer_key,generation_id,captured_at,as_of_date)
      VALUES($1,'owner',$2,'2026-10-17T15:00:00Z','2026-10-17')`,[f.orgId,g]);
    await tx.query(`INSERT INTO morning_snapshot_company(org_id,viewer_key,generation_id,observed_entity_id,entity_name,is_personal)
      VALUES($1,'owner',$2,$3,'Sample company A',false)`,[f.orgId,g,f.entities['Sample company A']]);
  });
  await rejects(db.query('DELETE FROM morning_snapshot_company WHERE generation_id=$1',[g]),'sealed');
});
schemaTest('visit: nullability and deferred time checks', async (db,f) => {
  await owner(db,f.orgId);
  const c = await generation(db,f,{at:'2026-10-17T14:00:00Z'}), l = await generation(db,f);
  await rejects(visit(db,f.orgId,'owner',null,l,null),'morning_visit_latest_parts');
  await rejects(visit(db,f.orgId,'owner',c,null,null,null),'morning_visit_comparison_needs_latest');
  await rejects(visit(db,f.orgId,'owner',l,l),'morning_visit_comparison_differs');
  await rejects(withTransaction(db,tx => visit(tx,f.orgId,'owner',c,l,'2026-10-17T14:30:00Z','2026-10-17T16:00:00Z')),'must equal L.captured_at');
  await rejects(withTransaction(db,tx => visit(tx,f.orgId,'owner',c,l,'2026-10-17T13:00:00Z')),'comparison must be older');
});
schemaTest('visit: referenced generations cannot be pruned', async (db,f) => {
  await owner(db,f.orgId); const l=await generation(db,f), unused=await generation(db,f);
  await visit(db,f.orgId,'owner',null,l);
  await rejects(withTransaction(db,tx => tx.query('DELETE FROM morning_snapshot_generation WHERE generation_id=$1',[l])),'morning_visit_latest_fk');
  await db.query('DELETE FROM morning_snapshot_generation WHERE generation_id=$1',[unused]);
  for (const table of ['company','account']) assert.equal((await db.query(`SELECT count(*)::int AS n FROM morning_snapshot_${table} WHERE generation_id=$1`,[unused])).rows[0].n,0);
});
schemaTest('user delete cascades viewer data in one transaction', async (db,f) => {
  const {userId}=await mvUser(db,{orgId:f.orgId,email:'viewer@sample.example'}), key=String(userId);
  await viewer(db,f.orgId,userId);
  await db.query('INSERT INTO morning_preference (org_id,viewer_key,membership_epoch) VALUES ($1,$2,1)',[f.orgId,key]);
  await db.query('INSERT INTO morning_floor (org_id,viewer_key,account_id,floor_cents) VALUES ($1,$2,$3,1)',[f.orgId,key,f.accounts['Sample company A'].checking]);
  await db.query('INSERT INTO morning_dismissal (org_id,viewer_key,item_key,item_version,rule_version) VALUES ($1,$2,\'bill:1\',$3,1)',[f.orgId,key,hash]);
  const c=await generation(db,f,{key,at:'2026-10-17T14:00:00Z'}), l=await generation(db,f,{key});
  await visit(db,f.orgId,key,c,l); await claim(db,f.orgId,key);
  await withTransaction(db,tx=>tx.query('DELETE FROM app_user WHERE user_id=$1',[userId]));
  for (const table of ['viewer',...owned]) assert.equal((await db.query(`SELECT count(*)::int AS n FROM morning_${table} WHERE viewer_key=$1`,[key])).rows[0].n,0,table);
});
schemaTest('floors: same-org account only, cascade on account delete', async (db,f) => {
  await owner(db,f.orgId); const other=await mvOrg(db,{slug:'mvother'}), a=await bareAccount(db,f);
  await rejects(db.query(`INSERT INTO morning_floor (org_id,viewer_key,account_id,floor_cents) VALUES ($1,'owner',$2,0)`,[f.orgId,other.accounts['Sample company A'].checking]),'morning_floor_org_id_account_id_fkey');
  await db.query(`INSERT INTO morning_floor (org_id,viewer_key,account_id,floor_cents) VALUES ($1,'owner',$2,0)`,[f.orgId,a]);
  await db.query('DELETE FROM account WHERE account_id=$1',[a]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM morning_floor')).rows[0].n,0);
});
schemaTest('transport: approval shape and live-is-exact', async (db,f) => {
  const insert = (extra,values) => db.query(`INSERT INTO morning_transport (org_id,channel,${extra}) VALUES ($1,'sms',${values})`,[f.orgId]);
  await rejects(insert('suspended','false'),'morning_transport_live_is_exact');
  await rejects(insert('approved_revision,approved_fingerprint,approved_at,approved_by',`0,'${hash}',now(),'owner'`),'morning_transport_approved_revision_check');
  await rejects(insert('approved_revision','1'),'morning_transport_approval_parts');
  await rejects(insert('email_entity_id',String(f.entities['Sample company A'])),'morning_transport_sms_no_entity');
  const approved = `2,'${hash}',now(),'owner'`;
  await rejects(insert('approved_revision,approved_fingerprint,approved_at,approved_by',approved),'morning_transport_approval_not_ahead');
  await rejects(insert('source_revision,approved_revision,approved_fingerprint,approved_at,approved_by,suspended',`2,1,'${hash}',now(),'owner',false`),'morning_transport_live_is_exact');
});
async function approve(db,f,channel,entityId = null) {
  await db.query(`INSERT INTO morning_transport (org_id,channel,email_entity_id,approved_revision,approved_fingerprint,approved_at,approved_by,suspended)
    VALUES ($1,$2,$3,1,$4,now(),'owner',false)`,[f.orgId,channel,entityId,hash]);
}
const transport = async (db,o,c) => (await db.query('SELECT * FROM morning_transport WHERE org_id=$1 AND channel=$2',[o,c])).rows[0];
schemaTest('transport: email/sms source hooks latch suspension', async (db,f) => {
  const e=f.entities['Sample company A'];
  await db.query('INSERT INTO email_settings (org_id,entity_id) VALUES ($1,$2)',[f.orgId,e]);
  await db.query('INSERT INTO sms_settings (org_id) VALUES ($1)',[f.orgId]);
  await approve(db,f,'email',e); await approve(db,f,'sms');
  for (const [channel,table,column,value,diagnostic] of [['email','email_settings','from_name',"'Sample sender'",'last_test_at=now()'],['sms','sms_settings','phone',"'+15555550101'","updated_by='the owner'"]]) {
    await db.query(`UPDATE ${table} SET ${column}=${value} WHERE org_id=$1`,[f.orgId]);
    assert.equal((await transport(db,f.orgId,channel)).source_revision,2);
    assert.equal((await transport(db,f.orgId,channel)).suspended,true);
    await db.query(`UPDATE ${table} SET ${column}=NULL WHERE org_id=$1`,[f.orgId]);
    await db.query(`UPDATE ${table} SET ${diagnostic} WHERE org_id=$1`,[f.orgId]);
    assert.equal((await transport(db,f.orgId,channel)).source_revision,3);
    await db.query(`DELETE FROM ${table} WHERE org_id=$1`,[f.orgId]);
    assert.equal((await transport(db,f.orgId,channel)).source_revision,4);
    assert.equal((await transport(db,f.orgId,channel)).suspended,true);
  }
});
schemaTest('transport: selected company deletion clears approval', async (db,f) => {
  const e=(await db.query(`INSERT INTO entity (org_id,name) VALUES ($1,'Sample disposable company') RETURNING entity_id`,[f.orgId])).rows[0].entity_id;
  await db.query('INSERT INTO email_settings (org_id,entity_id) VALUES ($1,$2)',[f.orgId,e]);
  await db.query('DELETE FROM email_settings WHERE entity_id=$1',[e]);
  await approve(db,f,'email',e);
  await db.query('DELETE FROM entity WHERE entity_id=$1',[e]);
  const row=await transport(db,f.orgId,'email');
  assert.deepEqual([row.email_entity_id,row.approved_revision,row.suspended,row.source_revision],[null,null,true,2]);
});
schemaTest('claims: one per viewer and day, captured versions immutable', async (db,f) => {
  await owner(db,f.orgId); await claim(db,f.orgId);
  await rejects(claim(db,f.orgId),'morning_message_claim_pkey');
  await rejects(db.query('UPDATE morning_message_claim SET recipient_settings_version=2'),'captured versions are immutable');
  await rejects(db.query(`UPDATE morning_message_claim SET state='sent',completed_at=now()`),'morning_claim_sent_attempted');
  await db.query(`UPDATE morning_message_claim SET attempt_started_at='2026-10-17T15:00:00Z'`);
  await rejects(db.query(`UPDATE morning_message_claim SET attempt_started_at='2026-10-17T15:00:01Z'`),'write-once');
  await db.query(`UPDATE morning_message_claim SET state='failed',completed_at=now()`);
  await rejects(db.query(`UPDATE morning_message_claim SET state='claimed',completed_at=NULL`),'stays finished');
});
schemaTest('user_invite provenance', async (db,f) => {
  const {userId}=await mvUser(db,{orgId:f.orgId,email:'viewer@sample.example'});
  await rejects(db.query(`INSERT INTO user_invite (org_id,user_id,token_hash,expires_at,owner_issued) VALUES ($1,$2,$3,now(),true)`,[f.orgId,userId,hash]),'user_invite_morning_provenance');
  const {rows:[r]}=await db.query(`INSERT INTO user_invite (org_id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()) RETURNING owner_issued,morning_membership_epoch`,[f.orgId,userId,hash]);
  assert.deepEqual(r,{owner_issued:false,morning_membership_epoch:null});
});
schemaTest('relationship edges are symmetric and same-org', async (db,f) => {
  const entityId=f.entities['Sample company A'], customerId=await mvCustomer(db,{orgId:f.orgId,entityId,name:'Sample customer A'});
  const args={orgId:f.orgId,entityId,customerId,date:'2026-10-17',postings:[{accountId:f.accounts['Sample company A'].checking,cents:100}]};
  const a=await mvTxn(db,{...args,type:'payment'}), x=await mvTxn(db,{...args,type:'invoice'}), v=await mvTxn(db,{...args,type:'payment'});
  await mvApply(db,{orgId:f.orgId,creditTxnId:a,chargeTxnId:x,viaTxnId:v,cents:100,on:'2026-10-17'});
  const {rows}=await db.query('SELECT org_id,a,b FROM morning_relationship_edge ORDER BY a,b');
  assert.deepEqual(rows.map(r=>[r.org_id,r.a,r.b]),[[a,x],[a,v],[x,a],[x,v],[v,a],[v,x]].sort((p,q)=>p[0]-q[0]||p[1]-q[1]).map(p=>[f.orgId,...p]));
});
schemaTest('explicit FK inventory', async (db,f) => {
  const {rows}=await db.query(`SELECT c.conrelid::regclass::text AS child,c.confrelid::regclass::text AS parent,c.confdeltype,pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.contype='f' AND c.conrelid::regclass::text LIKE 'morning_%'`);
  for (const table of tables) assert.ok(rows.some(r=>r.child===`morning_${table}`&&r.parent==='org'&&r.confdeltype==='c'),table);
  for (const table of owned) assert.ok(rows.some(r=>r.child===`morning_${table}`&&r.parent==='morning_viewer'&&r.confdeltype==='c'&&r.def.includes('(org_id, viewer_key)')),table);
  assert.equal(rows.filter(r=>['morning_snapshot_company','morning_snapshot_account'].includes(r.child)&&['entity','account'].includes(r.parent)).length,0);
  await owner(db,f.orgId); const g=await generation(db,f);
  const {userId}=await mvUser(db,{orgId:f.orgId,email:'viewer@sample.example'}); await viewer(db,f.orgId,userId);
  await rejects(db.query(`INSERT INTO morning_snapshot_account (org_id,viewer_key,generation_id,observed_entity_id,observed_account_id,account_name,account_type,active,signed_cents)
    VALUES ($1,$2,$3,$4,$5,'Sample bank','bank',true,0)`,[f.orgId,String(userId),g,f.entities['Sample company A'],f.accounts['Sample company A'].checking]),'morning_snapshot_account_org_id_viewer_key_generation_id_o_fkey');
});
schemaTest('source INSERT invalidates approval', async (db,f) => {
  const e=f.entities['Sample company A'];
  await db.query('INSERT INTO email_settings (org_id,entity_id) VALUES ($1,$2)',[f.orgId,e]); await db.query('INSERT INTO sms_settings (org_id) VALUES ($1)',[f.orgId]);
  await approve(db,f,'email',e); await approve(db,f,'sms');
  for (const [channel,table] of [['email','email_settings'],['sms','sms_settings']]) {
    await db.query(`DELETE FROM ${table} WHERE org_id=$1`,[f.orgId]);
    if(channel==='email') await db.query('INSERT INTO email_settings (org_id,entity_id) VALUES ($1,$2)',[f.orgId,e]);
    else await db.query('INSERT INTO sms_settings (org_id) VALUES ($1)',[f.orgId]);
    await db.query(`UPDATE ${table} SET updated_at=now() WHERE org_id=$1`,[f.orgId]);
    const row=await transport(db,f.orgId,channel); assert.deepEqual([row.source_revision,row.suspended],[3,true]);
  }
});
schemaTest('fixture constraints', async (db,f) => {
  const entityId=f.entities['Sample company A'], a=f.accounts['Sample company A'];
  const vendorId=await mvVendor(db,{orgId:f.orgId,entityId,name:'Sample vendor A'});
  const customerId=await mvCustomer(db,{orgId:f.orgId,entityId,name:'Sample customer A'});
  const args={orgId:f.orgId,entityId,date:'2026-10-17',vendorId,postings:[{accountId:a.checking,cents:-100}]};
  for(const type of ['expense','check','bill_payment','cc_credit','bill']) {
    const id=await mvTxn(db,{...args,type}); const r=(await db.query('SELECT * FROM txn WHERE txn_id=$1',[id])).rows[0];
    if(type!=='bill') assert.ok(r.account_id); assert.equal(r.approval_status,type==='bill'?'approved':null);
  }
  const voidId=await mvTxn(db,{...args,type:'expense',voided:true});
  assert.deepEqual((await db.query('SELECT total_cents,open_cents FROM txn WHERE txn_id=$1',[voidId])).rows[0],{total_cents:0,open_cents:0});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM posting WHERE txn_id=$1',[voidId])).rows[0].n,0);
  const id=await mvTxn(db,{...args,type:'journal_entry',vendorId:null,postings:[{accountId:a.checking,cents:100},{accountId:a.savings,cents:-100}]});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM posting WHERE txn_id=$1',[id])).rows[0].n,2);
  await assert.rejects(mvTxn(db,{...args,type:'expense',postings:[{accountId:a.checking,cents:0}]}),/nonzero/);
  for(const type of ['invoice','late_fee']) {
    const tid=await mvTxn(db,{...args,vendorId:null,customerId,type,docDate:'2026-10-16'});
    const r=(await db.query('SELECT txn_date,due_date FROM txn WHERE txn_id=$1',[tid])).rows[0];
    assert.deepEqual(r,{txn_date:'2026-10-16',due_date:'2026-10-16'});
    assert.equal((await db.query('SELECT txn_date FROM posting WHERE txn_id=$1 LIMIT 1',[tid])).rows[0].txn_date,'2026-10-17');
  }
});
