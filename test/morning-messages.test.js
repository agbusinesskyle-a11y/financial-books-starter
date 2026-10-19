import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { freshDb } from './harness.js';
import { mvOrg,mvReadyViewers,mvTxn } from './morning-fixtures.js';
import { fakeSmtp,trustMorningTestCa } from './morning-smtp-fixture.js';
import { composeMessage,deliveryEligibility,runMorningMessages,recoverClaims,finishClaim } from '../lib/data/morning/messages.js';
import { transportSource,approveTransport,selectEmailCompany } from '../lib/data/morning/transport.js';
import { savePreferences,saveFloor,saveDeliverySettings } from '../lib/data/morning/settings.js';
import { saveSmsSettings } from '../lib/sms/twilio.js';
import { saveEmailSettings } from '../lib/data/settings.js';
import { removeSecondViewer,grantSecondViewer,ownerResetViewer } from '../lib/data/morning/identity.js';
import { updateUser,setUserActive,findOpenInvite,pendingSecret,completeInvite } from '../lib/data/users.js';
import { setUserCompanies } from '../lib/data/companies.js';
import { settingsKey } from '../lib/secrets.js';
import { makeTotp } from '../lib/auth.js';
import { withSecurityRead,withSecurityWrite,createMorningRuntime } from '../lib/data/morning/locks.js';
import { observeMorning } from '../lib/data/morning.js';
import { runDailyJobs } from '../services/jobs/index.js';
const N=new Date('2026-10-17T13:35:00Z'),origin='https://books.sample.example',day=86400000;
const zero={bankLines:0,bills:0,overdueInvoices:0,taxReminders:0,floors:0,newPayees:0,large:0,duplicateGroups:0,taxCoverage:0};
const model=()=>({firstLook:false,comparison:{capturedAt:new Date(+N-day)},complete:true,coverageKnown:true,
  attention:{counts:{...zero},unavailable:[],coverage:{known:true,unknownCount:0}},money:{status:'complete',grand:{cashCents:100000,availableCents:80000},changes:{cashChangeCents:10000,availableChangeCents:-5000,scopeChanged:false}}});
const compose=(m,includeAmounts=false)=>composeMessage(m,{origin,includeAmounts});
test('exact wire composition',()=>{
  const m=model();m.attention.counts={...zero,bankLines:3,bills:2,duplicateGroups:1};
  const smsText=`Morning View: 3 bank lines need review, 2 bills need attention, 1 possible duplicate group. Open Morning View: ${origin}/morning`;
  assert.deepEqual(compose(m),{subject:'Morning View is ready',emailText:`Morning View is ready\n\n${smsText}`,smsText});
});
test('exact state bodies',()=>{
  let m=model();m.firstLook=true;m.comparison=null;
  assert.equal(compose(m,true).smsText,`Morning View: Transaction alerts start after your first look. Cash $1,000.00; available after cards $800.00. Open Morning View: ${origin}/morning`);
  m=model();const known='Morning View: Nothing needs attention in the covered sections. Cash $1,000.00; available after cards $800.00. Cash up $100.00; available after cards down $50.00 since your last look.';
  assert.equal(compose(m,true).smsText,`${known} Open Morning View: ${origin}/morning`);
  m.money.changes.scopeChanged=true;assert.equal(compose(m,true).smsText,`${known} Changes include accounts entering or leaving the supported set; they are not cash movements. Open Morning View: ${origin}/morning`);
  m=model();m.complete=false;m.coverageKnown=false;m.money.status='incomplete';m.attention.unavailable=['money'];
  assert.equal(compose(m,true).smsText,`Morning View: Coverage is incomplete; review Morning View. Some sections are unavailable. Open Morning View: ${origin}/morning`);
  m=model();m.coverageKnown=false;m.attention.coverage={known:false,unknownCount:1};
  assert.equal(compose(m).smsText,`Morning View: Coverage is incomplete; review Morning View. Tax calendar coverage is unknown. Open Morning View: ${origin}/morning`);
  m=model();m.money.changes.availableChangeCents=null;assert.match(compose(m,true).smsText,/Observation changes are unavailable\./);assert.doesNotMatch(compose(m,true).smsText,/Cash up/);
  m=model();m.attention.counts.bills=null;assert.doesNotMatch(compose(m).smsText,/Nothing needs attention/);assert.match(compose(m).smsText,/Some sections are unavailable/);
});
test('all units have deterministic order and source text never enters a message',()=>{
  const m=model();m.attention.counts=Object.fromEntries(Object.keys(zero).map(k=>[k,1]));m.attention.counts.taxCoverage=0;
  m.attention.page=[{display:{partyName:'Sample vendor A',note:'Sample private note',memo:'Sample memo'}}];
  assert.equal(compose(m).smsText,`Morning View: 1 bank line needs review, 1 bill needs attention, 1 overdue invoice, 1 tax reminder, 1 balance below its floor, 1 new payee, 1 large transaction, 1 possible duplicate group. Open Morning View: ${origin}/morning`);
});
async function fixture(t){
  const database=await freshDb();t.after(()=>database.drop());const db=database.pool,f=await mvOrg(db,{slug:'sample',companies:['Sample company A','Sample company B']}),people=await mvReadyViewers(db,{orgId:f.orgId,slug:'sample'});
  const env={NODE_ENV:'test',APP_ORG:'sample',APP_BASE_URL:origin,SETTINGS_KEY:'ab'.repeat(32)},calls=[];
  const c={db,...f,...people,env,calls,now:new Date(N),elapsed:1000,entityId:f.entities['Sample company A'],bank:f.accounts['Sample company A'].checking};
  c.clock={wall:()=>new Date(c.now),mono:()=>c.elapsed};c.runtimeCaptures=0;c.runtime=createMorningRuntime({wall:()=>{c.runtimeCaptures++;return c.clock.wall();}});
  c.phone=identity=>identity.viewerKey==='owner'?'+16025550100':'+16025550101';
  c.fields=identity=>({enabled:'1',send_time:'06:30',channel:'sms',phone:c.phone(identity),email:'viewer@sample.example',include_amounts:'',detail_threshold:'500'});
  c.save=async(identity=c.second,fields={})=>{
    const {rows:[p]}=await db.query('SELECT * FROM morning_preference WHERE org_id=$1 AND viewer_key=$2',[c.orgId,identity.viewerKey]);
    return savePreferences(db,{actorCtx:identity,fields:{...c.fields(identity),enabled:p.enabled?'1':'',channel:p.channel,
      phone:p.phone??c.phone(identity),email:p.email??'viewer@sample.example',include_amounts:p.include_amounts?'1':'',
      send_time:`${String(Math.floor(p.send_minute/60)).padStart(2,'0')}:${String(p.send_minute%60).padStart(2,'0')}`,detail_threshold:String(p.detail_threshold_cents/100),...fields},now:c.now});
  };
  c.claims=async()=>(await db.query("SELECT * FROM morning_message_claim WHERE org_id=$1 ORDER BY sent_on,viewer_key='owner' DESC",[c.orgId])).rows;
  c.claim=async key=>(await c.claims()).find(r=>r.viewer_key===key);
  c.fetch=async(url,init)=>{calls.push({url,body:new URLSearchParams(init.body),at:new Date(c.now)});return new Response('',{status:201});};
  c.run=(hooks={},extra={})=>runMorningMessages({pool:db,env,clock:c.clock,runtime:c.runtime,log:()=>{},testHooks:{fetchImpl:c.fetch,...hooks},...extra});
  c.only=async(identity=c.owner)=>{await c.save(identity===c.owner?c.second:c.owner,{enabled:''});};
  c.approve=async(channel='sms')=>{const s=await transportSource(db,{orgId:c.orgId,channel,env});await approveTransport(db,{actorCtx:c.owner,channel,revision:s.row?.source_revision??1,fingerprint:s.fingerprint,env});};
  await saveSmsSettings(db,{orgId:c.orgId,enabled:true,accountSid:`AC${'ab'.repeat(16)}`,authToken:'cd'.repeat(16),phone:'+16025550190',key:settingsKey(env),actor:'the owner'});
  await c.approve();await saveDeliverySettings(db,{actorCtx:c.owner,enabled:true,env});await c.save(c.owner,{enabled:'1'});await c.save(c.second,{enabled:'1'});
  await mvTxn(db,{orgId:c.orgId,entityId:c.entityId,type:'journal_entry',date:'2026-10-15',createdAt:new Date('2026-10-15T12:00Z'),postings:[{accountId:c.bank,cents:100000}]});
  const feed=randomUUID();await db.query("INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_by) VALUES($1,$2,$3,'Sample company A','the owner')",[c.orgId,c.entityId,randomUUID()]);
  await db.query("INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,books_account_id,include) VALUES($1,$2,$3,'Sample checking feed','depository',$4,true)",[c.orgId,c.entityId,feed,c.bank]);
  for(let i=0;i<3;i++)await db.query("INSERT INTO bank_feed_item(org_id,entity_id,ll_account_id,ll_transaction_id,revision,pending,posted_date,amount_cents,bank_state,review_state) VALUES($1,$2,$3,$4,1,false,'2026-10-17',100,'active','new')",[c.orgId,c.entityId,feed,randomUUID()]);
  c.email=async(t,options={})=>{
    trustMorningTestCa(t);const smtp=await fakeSmtp(t,{security:'starttls',...options});
    await saveEmailSettings(db,{orgId:c.orgId,entityId:c.entityId,fields:{mode:'smtp',fromName:'Sample sender',fromEmail:'books@sample.example',host:smtp.host,port:String(smtp.port),security:'starttls'},env});
    await selectEmailCompany(db,{actorCtx:c.owner,entityId:c.entityId});await c.approve('email');return smtp;
  };
  return c;
}
const messageTest=(name,fn)=>test(name,async t=>fn(await fixture(t),t));
for (const channel of ['sms', 'email']) messageTest(`code-r1 B3: prepared ${channel} claim stays retired after origin restore`, async (c, t) => {
  await c.only();
  const smtp = channel === 'email' ? await c.email(t) : null;
  if (smtp) await c.save(c.owner, { channel: 'email' });
  const result = await c.run({ afterPrepare: async () => {
    await transportSource(c.db, { orgId: c.orgId, channel, env: { ...c.env, APP_BASE_URL: 'https://other.sample.example' } });
    await transportSource(c.db, { orgId: c.orgId, channel, env: c.env });
  } });
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(c.calls.length, 0);
  if (smtp) assert.equal(smtp.messages.length, 0);
  assert.equal((await c.claim('owner')).attempt_started_at, null);
});
const afterTarget=(c,fn)=>async({claimId})=>{if((await c.claims()).some(r=>r.claim_id===claimId&&r.viewer_key===c.second.viewerKey))await fn();};
messageTest('counts-only by default; generic subject',async(c,t)=>{
  assert.deepEqual(await c.run(),{claimed:2,sent:2,failed:0,unknown:0,skipped:0});
  assert.deepEqual(c.calls.map(r=>r.body.get('To')),[c.phone(c.owner),c.phone(c.second)]);
  for(const call of c.calls){const body=call.body.get('Body');assert.match(body,/^Morning View: \d+ bank lines? need review/);assert.ok(body.endsWith(`Open Morning View: ${origin}/morning`));assert.doesNotMatch(body,/\$/);}
  c.now=new Date(+N+day);const smtp=await c.email(t);await c.only();await c.save(c.owner,{channel:'email'});await c.run({deadlineMs:1500});
  assert.equal(smtp.messages.length,1);const wire=smtp.messages[0];assert.match(wire,/Subject: Morning View is ready\r\n/);
  assert.match(wire,/\r\n\r\nMorning View is ready\r\n\r\nMorning View:/);assert.doesNotMatch(wire,/\$|Sample company|Sample vendor|Sample private note|Content-Disposition: attachment/);
});
messageTest('amounts only with consent',async c=>{
  await c.save(c.second,{include_amounts:'1'});await c.run();assert.doesNotMatch(c.calls[0].body.get('Body'),/\$/);assert.match(c.calls[1].body.get('Body'),/Cash \$1,000\.00/);
  const names=(await c.db.query('SELECT name FROM entity WHERE org_id=$1 UNION SELECT name FROM account WHERE org_id=$1 UNION SELECT name FROM app_user WHERE org_id=$1',[c.orgId])).rows.map(r=>r.name);
  for(const call of c.calls)for(const name of names)assert.ok(!call.body.get('Body').includes(name),name);
});
messageTest('before the chosen minute nothing is claimed',async c=>{c.now=new Date('2026-10-17T13:29Z');assert.equal((await c.run()).claimed,0);assert.equal((await c.claims()).length,0);assert.equal(c.calls.length,0);});
async function regrant(c){
  const args={actorCtx:c.owner,orgId:c.orgId,userId:c.second.userId,key:settingsKey(c.env),now:c.now};await removeSecondViewer(c.db,args);const issued=await grantSecondViewer(c.db,args);
  const invite=await findOpenInvite(c.db,{token:issued.token,orgSlug:'sample',now:c.now}),secret=await pendingSecret(c.db,{invite,key:args.key});
  await completeInvite(c.db,{token:issued.token,orgSlug:'sample',key:args.key,now:c.now,password:'sample password 1',password2:'sample password 1',code:makeTotp(secret).generate({timestamp:+c.now})});
  await c.db.query("UPDATE morning_preference SET enabled=true,phone=$3,settings_version=settings_version+1 WHERE org_id=$1 AND viewer_key=$2",[c.orgId,c.second.viewerKey,c.phone(c.second)]);
}
messageTest('at most one attempt per viewer and day',async(c,t)=>{
  await c.run();await c.run();await c.save(c.second,{send_time:'06:00'});await c.run();const smtp=await c.email(t);await c.save(c.second,{channel:'email'});await c.run();await regrant(c);await c.run();
  assert.equal(c.calls.length,2);assert.equal(smtp.messages.length,0);assert.equal((await c.claims()).length,2);assert.ok((await c.claims()).every(r=>r.sent_on==='2026-10-17'));
});
const changes={
  'amounts off':c=>c.save(c.second,{include_amounts:''}),
  enabled:c=>c.save(c.second,{enabled:''}),time:c=>c.save(c.second,{send_time:'06:31'}),threshold:c=>c.save(c.second,{detail_threshold:'750'}),
  destination:c=>c.save(c.second,{phone:'+16025550102'}),channel:c=>c.save(c.second,{channel:'email'}),
  'floor save':c=>saveFloor(c.db,{actorCtx:c.second,accountId:c.bank,floorText:'100'}),
  'floor delete':c=>saveFloor(c.db,{actorCtx:c.second,accountId:c.bank,floorText:''}),
  'amounts change and restore':async c=>{await c.save(c.second,{include_amounts:''});await c.save(c.second,{include_amounts:'1'});},
  'delivery off and on':async c=>{for(const enabled of [false,true])await saveDeliverySettings(c.db,{actorCtx:c.owner,enabled,env:c.env});},
  'same-source reapproval':c=>c.approve(),origin:c=>{c.env.APP_BASE_URL='https://other.sample.example';},
  'transport selection':c=>selectEmailCompany(c.db,{actorCtx:c.owner,entityId:c.entities['Sample company B']}),
  'SMS change and restore':async c=>{for(const phone of ['+16025550191','+16025550190'])await saveSmsSettings(c.db,{orgId:c.orgId,enabled:true,accountSid:`AC${'ab'.repeat(16)}`,phone,key:settingsKey(c.env),actor:'the owner'});},
  remove:c=>removeSecondViewer(c.db,{actorCtx:c.owner,orgId:c.orgId}),reset:c=>ownerResetViewer(c.db,{actorCtx:c.owner,orgId:c.orgId,userId:c.second.userId,key:settingsKey(c.env),now:c.now}),
  regrant,deactivate:c=>setUserActive(c.db,{actorCtx:c.owner,orgId:c.orgId,userId:c.second.userId,active:false}),
  'identity email':c=>updateUser(c.db,{actorCtx:c.owner,orgId:c.orgId,userId:c.second.userId,fields:{name:'the second viewer',email:'changed@sample.example',role:'standard'}}),
  'identity role':c=>updateUser(c.db,{actorCtx:c.owner,orgId:c.orgId,userId:c.second.userId,fields:{name:'the second viewer',email:'viewer@sample.example',role:'reports'}}),
  'identity approval':c=>updateUser(c.db,{actorCtx:c.owner,orgId:c.orgId,userId:c.second.userId,fields:{name:'the second viewer',email:'viewer@sample.example',role:'standard',canApproveBills:'1'}}),
  'identity companies':c=>setUserCompanies(c.db,{actorCtx:c.owner,orgId:c.orgId,userId:c.second.userId,all:false,entityIds:[c.entityId]}),
};
for(const [name,change] of Object.entries(changes))messageTest(`all settings cancel after preparation: ${name}`,async(c,t)=>{
  await c.save(c.second,{include_amounts:'1'});if(name==='floor delete')await saveFloor(c.db,{actorCtx:c.second,accountId:c.bank,floorText:'100'});
  if(name==='channel')await c.email(t);
  await c.run({afterPrepare:afterTarget(c,()=>change(c,t))});assert.equal(c.calls.length,1);assert.equal((await c.claim(c.second.viewerKey)).state,'skipped');
});
messageTest('concurrent workers',async c=>{await Promise.all([c.run(),c.run()]);assert.equal((await c.claims()).length,2);assert.equal(c.calls.length,2);});
for(const phase of ['afterClaim','afterAttemptCAS','afterProvider'])messageTest(`crash windows: ${phase}`,async c=>{
  await c.only();await assert.rejects(c.run({crashAt:phase}),/crash/i);let row=await c.claim('owner');assert.equal(row.state,'claimed');assert.equal(Boolean(row.attempt_started_at),phase!=='afterClaim');
  c.now=new Date(+N+16*60000);await c.run();row=await c.claim('owner');assert.equal(row.state,phase==='afterClaim'?'skipped':'unknown');assert.equal(c.calls.length,phase==='afterProvider'?1:0);
});
for(const status of ['failed','unknown'])messageTest(`provider outcomes: ${status}`,async c=>{
  await c.only();const fetchImpl=status==='failed'?async()=>new Response('',{status:400}):async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  await c.run({fetchImpl,deadlineMs:300});assert.equal((await c.claim('owner')).state,status);assert.equal((await c.run()).claimed,0);assert.equal(c.calls.length,0);
});
for(const phase of ['afterPrepare','afterAdapterPrepared','afterAttemptCAS','beforeProvider'])messageTest(`midnight and elapsed expiry: ${phase}`,async c=>{
  await c.only();c.now=new Date('2026-10-18T06:59:50Z');
  await c.run({[phase]:()=>{c.elapsed=11000;c.now=new Date('2026-10-18T07:00:00Z');}});
  assert.equal(c.calls.length,0);const row=await c.claim('owner');assert.equal(row.state,'skipped');assert.equal(row.outcome,'expired');assert.equal(row.sent_on,'2026-10-17');
  c.now=new Date('2026-10-18T13:35Z');c.elapsed=12000;await c.run();assert.equal(c.calls.length,1);assert.equal((await c.claims()).length,2);
});
messageTest('wall rollback cannot extend the elapsed deadline; a response may cross midnight',async c=>{
  await c.only();c.now=new Date('2026-10-18T06:59:50Z');await c.run({beforeProvider:()=>{c.elapsed=11000;c.now=new Date('2026-10-18T05:59:50Z');}});
  assert.equal(c.calls.length,0);assert.equal((await c.claim('owner')).outcome,'expired');
  c.now=new Date('2026-10-19T06:59:50Z');c.elapsed=1000;
  await c.run({beforeProvider:()=>{c.elapsed=10999;},fetchImpl:async(...args)=>{c.elapsed=11001;c.now=new Date('2026-10-19T07:00Z');return c.fetch(...args);}});
  assert.equal(c.calls.length,1);assert.deepEqual((await c.claims()).map(r=>[r.sent_on,r.state]),[['2026-10-17','skipped'],['2026-10-18','sent']]);
});
messageTest('no backfill',async c=>{await c.run();assert.deepEqual([...new Set((await c.claims()).map(r=>r.sent_on))],['2026-10-17']);});
messageTest('practice copy sends nothing',async c=>{
  assert.deepEqual(await runDailyJobs({pool:c.db,env:{...c.env,BOOKS_MODE:'practice'},now:c.clock.wall,morningTestHooks:{fetchImpl:c.fetch}}),{practice:true});
  await c.run({}, {env:{...c.env,BOOKS_MODE:'practice'}});assert.equal((await c.claims()).length,0);assert.equal(c.calls.length,0);
});
messageTest('foreign org isolation',async c=>{
  const f=await mvOrg(c.db,{slug:'mvother'}),{owner}=await mvReadyViewers(c.db,{orgId:f.orgId,second:false});
  await saveSmsSettings(c.db,{orgId:f.orgId,enabled:true,accountSid:`AC${'ef'.repeat(16)}`,authToken:'aa'.repeat(16),phone:'+16025550199',key:settingsKey(c.env),actor:'the owner'});
  const s=await transportSource(c.db,{orgId:f.orgId,channel:'sms',env:c.env});await approveTransport(c.db,{actorCtx:owner,channel:'sms',revision:1,fingerprint:s.fingerprint,env:c.env});
  await saveDeliverySettings(c.db,{actorCtx:owner,enabled:true,env:c.env});await savePreferences(c.db,{actorCtx:owner,fields:{...c.fields(c.owner),phone:'+16025550103'}});
  await c.run();assert.equal((await c.db.query('SELECT count(*)::int n FROM morning_message_claim WHERE org_id=$1',[f.orgId])).rows[0].n,0);assert.equal(c.calls.length,2);
});
async function observe(c,identity,time){return observeMorning(c.db,{identity,now:time,runtime:c.runtime,render:async()=>'<p>Sample observation</p>'});}
messageTest('jobs never mutate observations and use L, not C',async c=>{
  await observe(c,c.second,new Date('2026-10-15T15:00Z'));
  await mvTxn(c.db,{orgId:c.orgId,entityId:c.entityId,type:'journal_entry',date:'2026-10-16',createdAt:new Date('2026-10-16T14:00Z'),postings:[{accountId:c.bank,cents:20000}]});
  await observe(c,c.second,new Date('2026-10-16T15:00Z'));await c.save(c.second,{include_amounts:'1'});
  const state=async()=>({visits:(await c.db.query('SELECT * FROM morning_visit')).rows,generations:(await c.db.query('SELECT * FROM morning_snapshot_generation ORDER BY captured_at')).rows});
  const before=await state(),visit=before.visits[0];await c.run();assert.deepEqual(await state(),before);
  const claim=await c.claim(c.second.viewerKey);assert.equal(claim.baseline_generation_id,visit.latest_generation_id);assert.notEqual(claim.baseline_generation_id,visit.comparison_generation_id);
  assert.deepEqual(claim.baseline_captured_at,new Date('2026-10-16T15:00Z'));assert.match(c.calls[1].body.get('Body'),/Cash unchanged \$0\.00; available after cards unchanged \$0\.00 since your last look\./);
});
messageTest('record-only or unapproved transport',async(c,t)=>{
  await c.only();await c.email(t);await c.save(c.owner,{channel:'email'});
  await saveEmailSettings(c.db,{orgId:c.orgId,entityId:c.entityId,fields:{mode:'record'},env:c.env});await c.run();assert.equal((await c.claims()).length,0);assert.equal(c.calls.length,0);
  assert.deepEqual(await withSecurityRead(c.db,{orgId:c.orgId},tx=>deliveryEligibility(tx,{orgId:c.orgId,viewerKey:'owner',env:c.env})),{ok:false,reason:'transport_unapproved'});
});
messageTest('capture is after acquisition and its selection snapshot binds versions',async c=>{
  await c.only();let writer,finished=false,captured;
  await c.run({afterSelectionRead:async({N:at,versions})=>{
    captured={at,versions};writer=c.save(c.owner,{include_amounts:'1'}).then(()=>finished=true);await delay(40);assert.equal(finished,false);
  },afterClaim:async()=>{await writer;}});
  assert.deepEqual(captured.at,N);assert.equal(captured.versions.recipient,(await c.claim('owner')).recipient_settings_version);assert.equal(c.calls.length,0);assert.equal((await c.claim('owner')).state,'skipped');
});
messageTest('stale worker resumes after recovery without dispatch',async c=>{
  await c.only();let enter,release;const entered=new Promise(r=>enter=r),paused=new Promise(r=>release=r);
  const running=c.run({afterClaim:async()=>{enter();await paused;}});await entered;
  await withSecurityWrite(c.db,{orgId:c.orgId},tx=>recoverClaims(tx,{orgId:c.orgId,N:new Date(+N+16*60000)}));release();await running;
  assert.equal(c.calls.length,0);assert.equal((await c.claim('owner')).state,'skipped');
});
messageTest('terminal CAS never overwrites a terminal state',async c=>{
  await c.only();await c.run();const original=await c.claim('owner');
  for(const state of ['sent','failed','skipped','unknown']){
    if(state!=='sent')await c.db.query(`INSERT INTO morning_message_claim(org_id,viewer_key,sent_on,claim_id,state,captured_at,claimed_at,completed_at,membership_epoch,recipient_settings_version,delivery_settings_version,transport_source_revision,transport_approved_revision,channel)
      VALUES($1,'owner',$2::date,$3,$4,$2::date::timestamptz,$2::date::timestamptz,$2::date::timestamptz,1,1,1,1,1,'sms')`,[c.orgId,`2026-10-${state==='failed'?'14':state==='skipped'?'15':'16'}`,randomUUID(),state]);
    const row=(await c.claims()).find(r=>r.state===state);assert.deepEqual(await finishClaim(c.db,{orgId:c.orgId,claimId:row.claim_id,state:'failed',N}),{updated:false,state});
  }
  assert.equal((await c.db.query('SELECT * FROM morning_message_claim WHERE claim_id=$1',[original.claim_id])).rows[0].state,'sent');
});
messageTest('SMTP company deletion cancels a prepared body; no app_user email fallback',async(c,t)=>{
  await c.email(t);await c.save(c.second,{channel:'email'});
  // A disposable selected SMTP company has no ledger data, so its deletion is a valid source change.
  const e=(await c.db.query("INSERT INTO entity(org_id,name) VALUES($1,'Sample disposable company') RETURNING entity_id",[c.orgId])).rows[0].entity_id;
  const source=(await c.db.query('SELECT * FROM email_settings WHERE org_id=$1 AND entity_id=$2',[c.orgId,c.entityId])).rows[0];
  await saveEmailSettings(c.db,{orgId:c.orgId,entityId:e,fields:{mode:'smtp',fromEmail:source.from_email,host:source.smtp_host,port:String(source.smtp_port),security:'starttls'},env:c.env});
  await selectEmailCompany(c.db,{actorCtx:c.owner,entityId:e});await c.approve('email');
  await c.run({afterPrepare:afterTarget(c,()=>withSecurityWrite(c.db,{orgId:c.orgId},async tx=>{
    await tx.query('DELETE FROM email_settings WHERE org_id=$1 AND entity_id=$2',[c.orgId,e]);await tx.query('DELETE FROM entity WHERE org_id=$1 AND entity_id=$2',[c.orgId,e]);
  }))});
  assert.equal((await c.claim(c.second.viewerKey)).state,'skipped');assert.equal(c.calls.length,1);
  await c.db.query('DELETE FROM morning_preference WHERE org_id=$1 AND viewer_key=$2',[c.orgId,c.second.viewerKey]);
  assert.deepEqual(await deliveryEligibility(c.db,{orgId:c.orgId,viewerKey:c.second.viewerKey,env:c.env}),{ok:false,reason:'prefs_off'});
});
messageTest('retention cadence',async c=>{
  for(let i=0;i<4;i++)await observe(c,c.owner,new Date(+N-(120*day)+i*3600000));
  const old=await c.db.query('SELECT * FROM morning_visit WHERE org_id=$1',[c.orgId]),pointers=old.rows[0];
  await c.db.query('DELETE FROM morning_snapshot_generation WHERE org_id=$1 AND generation_id NOT IN ($2,$3)',[c.orgId,pointers.comparison_generation_id,pointers.latest_generation_id]);
  for(let i=0;i<2;i++)await c.db.query("INSERT INTO morning_snapshot_generation(org_id,viewer_key,generation_id,captured_at,as_of_date) VALUES($1,'owner',$2,$3,$4)",[c.orgId,randomUUID(),new Date(+N-100*day),new Date(+N-100*day).toISOString().slice(0,10)]);
  const foreign=await mvOrg(c.db,{slug:'mvforeign'});await mvReadyViewers(c.db,{orgId:foreign.orgId,second:false});
  const insertClaim=async orgId=>c.db.query(`INSERT INTO morning_message_claim(org_id,viewer_key,sent_on,claim_id,state,captured_at,claimed_at,completed_at,membership_epoch,recipient_settings_version,delivery_settings_version,transport_source_revision,transport_approved_revision,channel,outcome)
    VALUES($1,'owner',$2::date,$3,'failed',$2::date::timestamptz,$2::date::timestamptz,$2::date::timestamptz,1,1,1,1,1,'sms','Sample diagnostic')`,[orgId,'2026-07-18',randomUUID()]);
  await insertClaim(c.orgId);await insertClaim(foreign.orgId);await c.run();
  const gens=(await c.db.query('SELECT generation_id FROM morning_snapshot_generation WHERE org_id=$1',[c.orgId])).rows.map(r=>r.generation_id);
  assert.deepEqual(new Set(gens),new Set([pointers.comparison_generation_id,pointers.latest_generation_id]));
  const retained=(await c.claims()).find(r=>r.sent_on==='2026-07-18');assert.equal(retained.outcome,null);assert.ok(retained.outcome_redacted_at);assert.equal(retained.state,'failed');
  assert.equal((await c.db.query('SELECT outcome FROM morning_message_claim WHERE org_id=$1',[foreign.orgId])).rows[0].outcome,'Sample diagnostic');
});
messageTest('hourly job wiring uses configured org and the supplied shared runtime',async c=>{
  const summary=await runDailyJobs({pool:c.db,env:c.env,now:c.clock.wall,morningRuntime:c.runtime,morningTestHooks:{fetchImpl:c.fetch},log:()=>{}});
  assert.equal(summary.morning.sent,2);assert.equal(c.calls.length,2);assert.ok(c.runtimeCaptures>=2,'digest must use the supplied process runtime');
  await assert.rejects(runMorningMessages({pool:c.db,env:{...c.env,NODE_ENV:'production'},testHooks:{fetchImpl:c.fetch}}),/test hooks/i);
});
