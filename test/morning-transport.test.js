import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { freshDb } from './harness.js';
import { startApp } from './app-harness.js';
import { mvOrg,mvReadyViewers,mvUser,signInAs } from './morning-fixtures.js';
import { fakeSmtp,trustMorningTestCa } from './morning-smtp-fixture.js';
import { sendBoundedSmtp } from '../lib/mail/bounded.js';
import { transportSource,selectEmailCompany,approveTransport,buildAdapter,sendBoundedSms } from '../lib/data/morning/transport.js';
import { saveEmailSettings,recordEmailTest } from '../lib/data/settings.js';
import { saveSmsSettings,sendSms } from '../lib/sms/twilio.js';
import { settingsKey } from '../lib/secrets.js';
import { trustedActor } from '../lib/data/morning/access.js';
import { withSecurityRead,withSecurityWrite } from '../lib/data/morning/locks.js';
const env={NODE_ENV:'test',SETTINGS_KEY:'ab'.repeat(32),APP_BASE_URL:'https://books.sample.example/'};
const fields={mode:'smtp',fromName:'Sample sender',fromEmail:'books@sample.example',replyTo:'reply@sample.example',host:'smtp.sample.example',port:'587',security:'starttls',user:'sample',password:'sample-password'};
const sms={enabled:true,accountSid:`AC${'ab'.repeat(16)}`,authToken:'cd'.repeat(16),phone:'+16025550190',key:settingsKey(env),actor:'the owner'};
async function fixture(t){const database=await freshDb();t.after(()=>database.drop());const db=database.pool,f=await mvOrg(db),{owner}=await mvReadyViewers(db,{orgId:f.orgId,second:false});
  return {db,...f,owner,entityId:f.entities['Sample company A']};}
const transportTest=(name,fn)=>test(name,async t=>fn(await fixture(t),t));
const source=(c,channel='email',overrides={})=>transportSource(c.db,{orgId:c.orgId,channel,env:{...env,...overrides}});
async function setup(c,channel='email'){
  if(channel==='email'){await saveEmailSettings(c.db,{orgId:c.orgId,entityId:c.entityId,fields,env});await selectEmailCompany(c.db,{actorCtx:c.owner,entityId:c.entityId});}
  else await saveSmsSettings(c.db,{orgId:c.orgId,...sms});
  await approve(c,channel);
}
async function approve(c,channel='email',hooks={}){const s=await source(c,channel);return approveTransport(c.db,{actorCtx:c.owner,channel,revision:s.row?.source_revision??1,fingerprint:s.fingerprint,env,hooks});}
for (const channel of ['email', 'sms']) transportTest(`code-r1 B3: ${channel} origin restoration requires fresh approval`, async c => {
  await setup(c, channel);
  const initial = await source(c, channel);
  const version = async () => (await c.db.query('SELECT settings_version FROM morning_delivery_setting WHERE org_id=$1', [c.orgId])).rows[0].settings_version;
  const before = await version();
  const changed = await source(c, channel, { APP_BASE_URL: 'https://other.sample.example' });
  assert.equal(changed.approved, false);
  const restored = await source(c, channel);
  assert.equal(restored.approved, false, 'restoring configuration must not revive consent');
  assert.equal(restored.row.source_revision, initial.row.source_revision + 2);
  assert.ok(await version() > before, 'prepared delivery versions are retired');
  await approve(c, channel);
  assert.equal((await source(c, channel)).approved, true);
  assert.equal((await buildAdapter(c.db, { orgId: c.orgId, channel, env, claim: {
    transport_source_revision: initial.row.source_revision, transport_approved_revision: initial.row.approved_revision,
  } })).refused, 'changed', 'even renewed consent cannot authorize an old claim');
});
transportTest('fingerprint covers every routing field and hides secrets',async c=>{
  await setup(c);
  for(const change of [{host:'mail.sample.example'},{port:'465'},{security:'tls'},{user:'sample-other'},{password:fields.password},{fromName:'Sample other sender'},
    {fromEmail:'other@sample.example'},{replyTo:'other-reply@sample.example'},{mode:'record'}]){
    await saveEmailSettings(c.db,{orgId:c.orgId,entityId:c.entityId,fields,env});const initial=await source(c);
    await saveEmailSettings(c.db,{orgId:c.orgId,entityId:c.entityId,fields:{...fields,password:'',...change},env});assert.notEqual((await source(c)).fingerprint,initial.fingerprint,JSON.stringify(change));
  }
  assert.notEqual((await source(c,'email',{APP_BASE_URL:'https://other.sample.example'})).fingerprint,(await source(c)).fingerprint);
  await setup(c,'sms');const ciphertext=(await c.db.query('SELECT auth_token_enc FROM sms_settings WHERE org_id=$1',[c.orgId])).rows[0].auth_token_enc;
  const rendered=JSON.stringify([(await source(c)).display,(await source(c,'sms')).display]);
  for(const secret of [fields.password,sms.authToken,ciphertext])assert.ok(!rendered.includes(secret));
});
test('ordinary admin changes suspend Morning View email',async t=>{
  const app=await startApp({env});t.after(()=>app.close());const c={db:app.db.pool,orgId:app.ids.orgId,entityId:app.ids.entityId,owner:trustedActor({owner:true},app.ids.orgId,app.ownerSession)};
  await setup(c);const rev=(await source(c)).row.source_revision;
  const u=await mvUser(c.db,{orgId:c.orgId,email:'admin@sample.example',role:'admin'}),admin=await signInAs(app,{...u,email:'admin@sample.example'});
  for(const [i,fromName] of ['Sample changed sender',fields.fromName].entries()){
    assert.equal((await admin.post('/settings/email',{...fields,fromName})).status,303);
    const s=await source(c);assert.equal(s.row.source_revision,rev+i+1);assert.equal(s.row.suspended,true);
  }
  assert.equal((await admin.post('/settings/morning/transport-approve',{channel:'email'})).status,403);
  const changed=await source(c);
  const old=await app.post('/settings/morning/transport-approve',{channel:'email',revision:String(rev),fingerprint:changed.fingerprint});assert.equal(old.status,422);assert.match(await old.text(),/These settings changed since the page was shown/);
  assert.equal((await app.post('/settings/morning/transport-approve',{channel:'email',revision:String(changed.row.source_revision),fingerprint:changed.fingerprint})).status,303);
  assert.equal((await source(c)).approved,true);
  assert.equal((await app.post('/settings/morning/delivery',{action:'select-email',email_entity_id:String(c.entityId)})).status,303);
});
transportTest('owner re-approval needs the exact displayed revision',async c=>{
  await setup(c);const shown=await source(c);
  await saveEmailSettings(c.db,{orgId:c.orgId,entityId:c.entityId,fields:{...fields,fromName:'Sample changed sender'},env});
  await assert.rejects(approveTransport(c.db,{actorCtx:c.owner,channel:'email',revision:shown.row.source_revision,fingerprint:shown.fingerprint,env}),/These settings changed since the page was shown; review them again/);
  await approve(c);assert.equal((await source(c)).approved,true);
});
for(const channel of ['email','sms'])transportTest(channel==='email'?'approval cannot race a mutation':'SMS approval race/source hooks',async c=>{
  await setup(c,channel);let enter,release;const entered=new Promise(r=>enter=r),paused=new Promise(r=>release=r);
  const approval=approve(c,channel,{afterSecurity:async()=>{enter();await paused;}});await entered;
  let saved=false;const started=performance.now(),writer=(channel==='email'?saveEmailSettings(c.db,{orgId:c.orgId,entityId:c.entityId,fields:{...fields,fromName:'Sample changed sender'},env}):saveSmsSettings(c.db,{orgId:c.orgId,...sms,phone:'+16025550191'})).then(()=>saved=true);
  await delay(60);assert.equal(saved,false);release();await approval;await writer;assert.ok(performance.now()-started<35000);
  let s=await source(c,channel);assert.equal(s.approved,false);assert.equal(s.row.suspended,true);const rev=s.row.source_revision;
  if(channel==='email')await recordEmailTest(c.db,{orgId:c.orgId,entityId:c.entityId,ok:true});else await c.db.query("UPDATE sms_settings SET updated_by='the second viewer',updated_at=now() WHERE org_id=$1",[c.orgId]);
  assert.equal((await source(c,channel)).row.source_revision,rev);
  const table=channel==='email'?'email_settings':'sms_settings';await c.db.query(`DELETE FROM ${table} WHERE org_id=$1`,[c.orgId]);assert.equal((await source(c,channel)).row.source_revision,rev+1);
  if(channel==='email')await saveEmailSettings(c.db,{orgId:c.orgId,entityId:c.entityId,fields,env});else await saveSmsSettings(c.db,{orgId:c.orgId,...sms});
  s=await source(c,channel);assert.equal(s.row.source_revision,rev+2);assert.equal(s.row.suspended,true);
});
transportTest('SMS settings and origin',async c=>{
  await setup(c,'sms');const initial=await source(c,'sms');
  assert.equal((await source(c,'sms',{APP_BASE_URL:'https://other.sample.example'})).approved,false);
  const restored=await source(c,'sms');assert.equal(restored.row.source_revision,initial.row.source_revision+2);
  for(const [i,phone] of ['+16025550191',sms.phone].entries()){
    await saveSmsSettings(c.db,{orgId:c.orgId,...sms,phone});const s=await source(c,'sms');assert.equal(s.approved,false);assert.equal(s.row.source_revision,restored.row.source_revision+i+1);
  }
});
transportTest('selected company deletion',async c=>{
  const entityId=(await c.db.query("INSERT INTO entity(org_id,name) VALUES($1,'Sample disposable company') RETURNING entity_id",[c.orgId])).rows[0].entity_id;
  await selectEmailCompany(c.db,{actorCtx:c.owner,entityId});
  await c.db.query('DELETE FROM entity WHERE org_id=$1 AND entity_id=$2',[c.orgId,entityId]);const s=await source(c);
  assert.equal(s.row.email_entity_id,null);assert.equal(s.row.approved_revision,null);assert.equal(s.row.suspended,true);assert.equal(s.row.source_revision,2);
  const other=await mvOrg(c.db,{slug:'mvother'});await assert.rejects(selectEmailCompany(c.db,{actorCtx:c.owner,entityId:other.entities['Sample company A']}),/Choose a company in these books/);
});
const mail={from:'books@sample.example',to:'viewer@sample.example',subject:'Morning View is ready',text:'Morning View is ready\n\nSample message.'};
async function checkedSend(t,options,expected,{remoteBefore=false}={}){
  const server=await fakeSmtp(t,options),owned=[],closed=new Set();const original=tls.connect;
  tls.connect=(...args)=>{const s=original(...args);owned.push(s);s.on('close',()=>closed.add(s));return s;};t.after(()=>tls.connect=original);
  const start=performance.now();const result=await sendBoundedSmtp({...server,...mail,user:options.scenario==='auth-fail'?'sample':null,password:'sample-password',deadlineMs:1500,
    socketFactory:()=>{const s=new net.Socket();owned.push(s);s.on('close',()=>closed.add(s));return s;}});
  const resolved=performance.now();assert.equal(result.status,expected);assert.ok(resolved-start<1700,`elapsed ${resolved-start}`);
  assert.ok(owned.length);assert.equal(closed.size,owned.length,'all owned raw/TLS sockets closed before result');
  if(remoteBefore)assert.equal(server.closed.size,server.sockets.size,'server closed before result');
  await delay(30);assert.equal(server.closed.size,server.sockets.size,'server observes closure');assert.ok(server.lastData<=resolved,'no bytes after resolution');
  return {server,result};
}
test('bounded SMTP: accepted',async t=>{const {server}=await checkedSend(t,{},'sent');assert.equal(server.messages.length,1);});
test('bounded SMTP: refusal before DATA',async t=>{const {server}=await checkedSend(t,{scenario:'rcpt-refuse'},'failed');assert.equal(server.messages.length,0);});
test('bounded SMTP: stalled after DATA is cancelled, closed and unknown',t=>checkedSend(t,{scenario:'data-stall'},'unknown',{remoteBefore:true}));
test('bounded SMTP: stalled greeting',t=>checkedSend(t,{scenario:'greeting-stall'},'failed'));
test('bounded SMS',async()=>{
  const args={accountSid:sms.accountSid,authToken:sms.authToken,from:sms.phone,to:'+16025550100',body:'Sample message'};
  for(const [status,expected] of [[201,'sent'],[400,'failed'],[503,'failed']])assert.equal((await sendBoundedSms({...args,fetchImpl:async()=>new Response('',{status})})).status,expected);
  let signal;const start=performance.now();assert.equal((await sendBoundedSms({...args,deadlineMs:300,fetchImpl:async(_url,init)=>{
    signal=init.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}})).status,'unknown');
  assert.equal(signal.aborted,true);assert.ok(performance.now()-start<600);
  const controller=new AbortController();assert.deepEqual(await sendSms({...args,signal:controller.signal,fetchImpl:async(_url,init)=>{assert.equal(init.signal,controller.signal);return new Response('',{status:201});}}),{status:'sent'});
});
transportTest('record-only mailer never counts as sent',async c=>{
  await setup(c);await saveEmailSettings(c.db,{orgId:c.orgId,entityId:c.entityId,fields:{...fields,mode:'record'},env});const s=await source(c);
  assert.equal(s.sending,false);assert.deepEqual(await buildAdapter(c.db,{orgId:c.orgId,channel:'email',claim:{},env}),{refused:'not_sending'});
});
transportTest('test hooks are refused in production',async c=>{
  await assert.rejects(buildAdapter(c.db,{orgId:c.orgId,channel:'sms',claim:{},env:{...env,NODE_ENV:'production'},testHooks:{fetchImpl:()=>{}}}),/test hooks/i);
  await assert.rejects(approveTransport(c.db,{actorCtx:c.owner,channel:'sms',env:{...env,NODE_ENV:'production'},hooks:{afterSecurity:()=>{}}}),/test hooks/i);
});
for(const security of ['tls','starttls'])for(const [scenario,expected] of [['greeting-stall','failed'],['handshake-stall','failed'],['auth-fail','failed'],['rcpt-refuse','failed'],['data-refuse','failed'],['quit-stall','sent'],['data-lost','unknown'],['early-error','failed']])
  test(`encrypted paths and closure: ${security} ${scenario}`,async t=>{trustMorningTestCa(t);await checkedSend(t,{security,scenario},expected);});
transportTest('adapter pins validated values and never opens a socket during preparation',async(c,t)=>{
  trustMorningTestCa(t);const server=await fakeSmtp(t,{security:'starttls'});
  await saveEmailSettings(c.db,{orgId:c.orgId,entityId:c.entityId,fields:{...fields,host:server.host,port:String(server.port)},env});
  await selectEmailCompany(c.db,{actorCtx:c.owner,entityId:c.entityId});await approve(c);const s=await source(c),claim={transport_source_revision:s.row.source_revision,transport_approved_revision:s.row.approved_revision};
  let opened=0;const adapter=await buildAdapter(c.db,{orgId:c.orgId,channel:'email',claim,env,testHooks:{socketFactory:()=>{opened++;return new net.Socket();},deadlineMs:1500}});
  assert.equal(opened,0);assert.equal((await adapter.send(mail)).status,'sent');assert.equal(opened,1);
  assert.equal((await buildAdapter(c.db,{orgId:c.orgId,channel:'email',claim:{...claim,transport_source_revision:claim.transport_source_revision+1},env})).refused,'changed');
});
test('owner transport endpoints reject retired original sessions before reading settings',async t=>{
  const app=await startApp({env});t.after(()=>app.close());const db=app.db.pool,orgId=app.ids.orgId;
  const u=await mvUser(db,{orgId,email:'retired@sample.example',role:'admin'}),client=await signInAs(app,{...u,email:'retired@sample.example'});
  const actorCtx=trustedActor({userId:u.userId,orgId},orgId,client.session);
  await db.query('UPDATE app_user SET signin_version=signin_version+1 WHERE user_id=$1',[u.userId]);
  const state=async()=>(await db.query('SELECT (SELECT jsonb_agg(t) FROM morning_transport t) transports,(SELECT jsonb_agg(d) FROM morning_delivery_setting d) delivery')).rows;
  const before=await state();for(const run of [()=>selectEmailCompany(db,{actorCtx,entityId:app.ids.entityId}),()=>approveTransport(db,{actorCtx,channel:'sms',revision:1,fingerprint:'a'.repeat(64),env})])await assert.rejects(run(),e=>e.reason==='stale_session');
  for(const path of ['/settings/morning/transport-approve','/settings/morning/delivery'])assert.equal((await client.post(path)).status,401);assert.deepEqual(await state(),before);
});
for(const scenario of ['handshake-stall','data-stall'])transportTest(`lock released after closure: ${scenario}`,async(c,t)=>{
  trustMorningTestCa(t);const server=await fakeSmtp(t,{security:'tls',scenario});let entered,writer,writerAt,closedAt=0;const ready=new Promise(r=>entered=r),start=performance.now();
  const reader=withSecurityRead(c.db,{orgId:c.orgId},async()=>{
    entered();const result=await sendBoundedSmtp({...server,...mail,deadlineMs:1500,socketFactory:()=>{const s=new net.Socket();s.on('close',()=>closedAt=performance.now());return s;}});
    assert.equal(result.status,scenario==='data-stall'?'unknown':'failed');assert.ok(closedAt);assert.equal(writerAt,undefined);
  });await ready;
  writer=withSecurityWrite(c.db,{orgId:c.orgId},async()=>{writerAt=performance.now();assert.ok(closedAt&&writerAt>=closedAt);});
  await Promise.all([reader,writer]);assert.ok(performance.now()-start<35000);
});
