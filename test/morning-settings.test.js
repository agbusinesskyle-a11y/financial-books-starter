import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { mvOrg,mvUser,mvReadyViewers } from './morning-fixtures.js';
import { trustedActor } from '../lib/data/morning/access.js';
import { getMorningSettings,savePreferences,saveFloor,saveCompanyThreshold,saveDeliverySettings } from '../lib/data/morning/settings.js';
import { transportSource } from '../lib/data/morning/transport.js';
import { morningSettingsPage } from '../lib/views/morning-settings.js';
import { settingsKey,encryptSecret } from '../lib/secrets.js';
import { ownerResetViewer,removeSecondViewer,grantSecondViewer,ProtectedIdentityError } from '../lib/data/morning/identity.js';
import { findOpenInvite,pendingSecret,completeInvite } from '../lib/data/users.js';
import { makeTotp } from '../lib/auth.js';
const N=new Date('2026-10-17T15:00Z');
const baseFields={enabled:'',send_time:'06:30',channel:'sms',phone:'+16025550100',email:'viewer@sample.example',include_amounts:'',detail_threshold:'500.00'};
async function fixture(t,{second=false}={}){
  const sent=[],env={NODE_ENV:'test',APP_BASE_URL:'https://books.sample.example/',SETTINGS_KEY:'ab'.repeat(32)};
  const app=await startApp({now:N,env,mailer:{kind:'smtp',from:'books@sample.example',async send(m){sent.push(m);return {status:'sent'};}}});t.after(()=>app.close());
  const db=app.db.pool,orgId=app.ids.orgId,owner=trustedActor({owner:true},orgId,app.ownerSession);
  const people=second?await mvReadyViewers(db,{orgId,slug:'sample',second:true}):{};
  const accounts=(await db.query('SELECT account_id,type,entity_id FROM account WHERE org_id=$1 ORDER BY account_id',[orgId])).rows;
  const bank=accounts.find(a=>a.type==='bank'),card=accounts.find(a=>a.type==='credit_card');
  const read=(identity=owner,pool=db)=>getMorningSettings(pool,{identity,env});
  const version=async identity=>(await read(identity)).preference.settingsVersion;
  const save=(fields={},identity=owner,pool=db)=>savePreferences(pool,{actorCtx:identity,fields:{...baseFields,...fields},now:N});
  return {app,db,orgId,owner,second:people.second,bank,card,env,sent,read,version,save};
}
const settingsTest=(name,fn,options)=>test(name,async t=>fn(await fixture(t,options),t));
async function approveFixture(c){
  await c.db.query(`INSERT INTO sms_settings(org_id,enabled,account_sid,auth_token_enc,phone,updated_by) VALUES($1,true,$2,$3,'+16025550190','the owner')`,
    [c.orgId,`AC${'ab'.repeat(16)}`,encryptSecret(settingsKey(c.env),'cd'.repeat(16))]);
  await c.db.query(`INSERT INTO email_settings(org_id,entity_id,mode,from_email,smtp_host,smtp_port,smtp_security) VALUES($1,$2,'smtp','books@sample.example','smtp.sample.example',587,'starttls')`,[c.orgId,c.bank.entity_id]);
  for(const channel of ['sms','email']){
    await c.db.query('INSERT INTO morning_transport(org_id,channel,email_entity_id) VALUES($1,$2,$3)',[c.orgId,channel,channel==='email'?c.bank.entity_id:null]);
    const source=await transportSource(c.db,{orgId:c.orgId,channel,env:c.env});
    await c.db.query(`UPDATE morning_transport SET approved_revision=source_revision,approved_fingerprint=$3,approved_at=$4,approved_by='owner',suspended=false WHERE org_id=$1 AND channel=$2`,[c.orgId,channel,source.fingerprint,N]);
  }
}
settingsTest('defaults',async c=>{
  const r=await c.app.get('/settings/morning');assert.equal(r.status,200);const body=await r.text();
  for(const text of ['Your morning message','Recent-entry detail threshold','Balance floors','Second viewer','Organization delivery','Message channels','Amounts appear in the message body and may show in phone or email notifications.'])assert.ok(body.includes(text),text);
  const m=await c.read();assert.deepEqual([m.preference.enabled,m.preference.sendTime,m.preference.channel,m.preference.includeAmounts,m.preference.detailThresholdCents],[false,'06:30','sms',false,50000]);
  assert.ok(m.owner.companies.every(e=>e.largeThresholdCents===1000000));assert.equal((await c.db.query('SELECT count(*)::int n FROM morning_company_setting')).rows[0].n,0);
});
settingsTest('every persisted change advances recipient_settings_version',async c=>{
  await approveFixture(c);await c.db.query("DELETE FROM morning_preference WHERE org_id=$1 AND viewer_key='owner'",[c.orgId]);
  await c.db.query("INSERT INTO morning_preference(org_id,viewer_key,membership_epoch,phone) VALUES($1,'owner',1,'+16025550100')",[c.orgId]);
  let fields={...baseFields},expected=1;
  for(const change of [{enabled:'1'},{send_time:'07:00'},{channel:'email'},{email:'second-contact@sample.example'},{include_amounts:'1'},{detail_threshold:'750'}]){
    fields={...fields,...change};await c.save(fields);assert.equal(await c.version(),++expected);
  }
  await c.save({...fields,include_amounts:'1'});await c.save({...fields,include_amounts:''});expected+=2;assert.equal(await c.version(),expected);
  await saveFloor(c.db,{actorCtx:c.owner,accountId:c.bank.account_id,floorText:'-500.00',now:N});assert.equal(await c.version(),++expected);
  assert.equal((await c.read()).floors[0].floorCents,-50000);
  await saveFloor(c.db,{actorCtx:c.owner,accountId:c.bank.account_id,floorText:'',now:N});assert.equal(await c.version(),++expected);
  assert.equal((await c.read()).floors.length,0);assert.equal((await c.read()).preference.phone,null);
});
settingsTest('validation',async c=>{const before=await c.version();
  for(const [fields,text] of [[{send_time:'24:00'},'Use a time like 06:30.'],[{phone:'123'},'Enter a mobile number like (602) 555-0100.'],
    [{detail_threshold:'-1'},'The detail threshold is an amount like 500.00.'],[{enabled:'1'},'Turn delivery on after the owner approves this channel.'],
    [{enabled:'1',phone:''},'Add a phone number or email first.'],[{channel:'email',email:'bad'},'Enter a valid email address.']]){
    const r=await c.app.post('/settings/morning/preferences',{...baseFields,...fields});assert.equal(r.status,422);assert.ok((await r.text()).includes(text));assert.equal(await c.version(),before);
  }
});
settingsTest('own settings only',async c=>{const before=await c.version();await c.save({send_time:'08:00'},c.second);
  assert.equal((await c.read(c.second)).preference.sendTime,'08:00');assert.equal(await c.version(),before);assert.equal((await c.read(c.second)).owner,null);
  assert.equal((await c.app.post('/settings/morning/preferences',{...baseFields,viewer_key:c.second.viewerKey})).status,400);
},{second:true});
settingsTest('floors need a bank account in these books',async c=>{
  const other=await mvOrg(c.db,{slug:'mvother'});
  for(const accountId of [c.card.account_id,other.accounts['Sample company A'].checking,99999999])
    await assert.rejects(saveFloor(c.db,{actorCtx:c.owner,accountId,floorText:'10'}),/Choose a bank account in these books/);
  await saveFloor(c.db,{actorCtx:c.owner,accountId:c.bank.account_id,floorText:'10'});assert.equal((await c.read()).floors[0].floorCents,1000);
  await c.db.query("UPDATE account SET type='other_current_asset' WHERE account_id=$1",[c.bank.account_id]);
  const m=await c.read();assert.equal(m.floors[0].active,false);assert.match(String(morningSettingsPage({...m,csrf:'sample-csrf'})),/Saved floor inactive/);
});
settingsTest('owner-only controls',async c=>{
  await assert.rejects(saveCompanyThreshold(c.db,{actorCtx:c.second,entityId:c.bank.entity_id,thresholdText:'25000'}),ProtectedIdentityError);
  await assert.rejects(saveDeliverySettings(c.db,{actorCtx:c.second,enabled:true,env:c.env}),ProtectedIdentityError);
  await assert.rejects(grantSecondViewer(c.db,{actorCtx:c.second,orgId:c.orgId,userId:c.second.userId,key:settingsKey(c.env),now:N}),ProtectedIdentityError);
  assert.equal((await c.app.post('/settings/morning/company-threshold',{entity_id:String(c.bank.entity_id),threshold:'0'})).status,422);
  assert.equal((await c.app.post('/settings/morning/company-threshold',{entity_id:String(c.bank.entity_id),threshold:'25000'})).status,303);
  assert.equal((await c.read()).owner.companies.find(e=>e.entityId===c.bank.entity_id).largeThresholdCents,2500000);
},{second:true});
settingsTest('delivery settings version',async c=>{
  for(const [enabled,version] of [[true,2],[false,3],[true,4]]){await saveDeliverySettings(c.db,{actorCtx:c.owner,enabled,env:c.env});const d=(await c.read()).owner.delivery;
    assert.equal(d.settingsVersion,version);assert.equal(d.enabled,enabled);assert.equal(d.trustedOrigin,'https://books.sample.example');}
  for(const origin of ['', 'https://books.sample.example/path','https://books.sample.example bad'])await assert.rejects(saveDeliverySettings(c.db,{actorCtx:c.owner,enabled:true,env:{...c.env,APP_BASE_URL:origin}}),/Set APP_BASE_URL first/);
  await assert.rejects(saveDeliverySettings(c.db,{actorCtx:c.owner,enabled:true,env:{NODE_ENV:'production',APP_BASE_URL:'http://books.sample.example'}}),/Set APP_BASE_URL first/);
});
settingsTest('grant via the settings form shows the link once and emails nothing',async c=>{
  const u=await mvUser(c.db,{orgId:c.orgId,email:'candidate@sample.example'}),before=c.sent.length;
  const r=await c.app.post('/settings/morning/viewer',{action:'grant',user_id:String(u.userId)});assert.equal(r.status,200);const body=await r.text();
  assert.match(body,/\/invite\//);assert.match(body,/It was not emailed\./);assert.equal(c.sent.length,before);
  assert.doesNotMatch(await (await c.app.get('/settings/morning')).text(),/\/invite\//);
  for(const user_id of ['0','1x','1.5','99999999'])assert.equal((await c.app.post('/settings/morning/viewer',{action:'grant',user_id})).status,422);
});
async function renew(c,action){const key=settingsKey(c.env),args={orgId:c.orgId,userId:c.second.userId,actorCtx:c.owner,key,now:N};
  let issued;if(action==='reset')issued=await ownerResetViewer(c.db,args);else{await removeSecondViewer(c.db,args);issued=await grantSecondViewer(c.db,args);}
  const invite=await findOpenInvite(c.db,{token:issued.token,orgSlug:'sample',now:N}),secret=await pendingSecret(c.db,{invite,key});
  await completeInvite(c.db,{token:issued.token,orgSlug:'sample',key,now:N,password:'sample password 1',password2:'sample password 1',code:makeTotp(secret).generate({timestamp:+N})});}
for(const method of ['read','preference','floor'])for(const action of ['reset','regrant'])settingsTest(`stale settings authority: ${method} after ${action}`,async c=>{
  let queries=0,expected;
  const inspect=async()=>({preferences:(await c.db.query('SELECT * FROM morning_preference ORDER BY viewer_key')).rows,floors:(await c.db.query('SELECT * FROM morning_floor')).rows});
  const pool={connect:async()=>{await renew(c,action);expected=await inspect();const client=await c.db.connect();return {release:(...a)=>client.release(...a),query(config,...args){
    const text=typeof config==='string'?config:config.text;if(/\b(account|entity|morning_floor|morning_company_setting|email_settings|sms_settings)\b/.test(text))queries++;return client.query(config,...args);}};}};
  const promise=method==='read'?c.read(c.second,pool):method==='preference'?c.save({},c.second,pool):saveFloor(pool,{actorCtx:c.second,accountId:c.bank.account_id,floorText:'10'});
  await assert.rejects(promise,e=>e.reason==='stale_session');assert.equal(queries,0);assert.deepEqual(await inspect(),expected);
},{second:true});
settingsTest('pending and foreign settings authority is refused',async c=>{
  await c.db.query("UPDATE morning_viewer SET enrollment_state='pending_enrollment' WHERE org_id=$1 AND viewer_key=$2",[c.orgId,c.second.viewerKey]);
  await assert.rejects(c.read(c.second),e=>e.reason==='pending');await assert.rejects(c.save({},c.second),e=>e.reason==='pending');
  const other=await mvOrg(c.db,{slug:'mvforeign'});await c.db.query('DELETE FROM morning_viewer WHERE org_id=$1 AND viewer_key=$2',[c.orgId,c.second.viewerKey]);
  await c.db.query('DELETE FROM user_invite WHERE org_id=$1 AND user_id=$2',[c.orgId,c.second.userId]);
  await c.db.query('UPDATE app_user SET org_id=$1 WHERE user_id=$2',[other.orgId,c.second.userId]);
  await assert.rejects(c.read(c.second),e=>e.reason==='foreign_org');
},{second:true});
settingsTest('transport read predecessor',async c=>{
  for(const channel of ['sms','email']){const r=await transportSource(c.db,{orgId:c.orgId,channel,env:c.env});assert.equal(r.approved,false);assert.ok(!r.configured||!r.sending);}
  await approveFixture(c);const r=await transportSource(c.db,{orgId:c.orgId,channel:'sms',env:c.env});assert.equal(r.approved,true);assert.equal(r.display.fingerprint.length,12);
  const secret=(await c.db.query('SELECT auth_token_enc FROM sms_settings WHERE org_id=$1',[c.orgId])).rows[0].auth_token_enc;
  assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(r).includes('cd'.repeat(16)));
  await c.db.query("UPDATE email_settings SET mode='record' WHERE org_id=$1",[c.orgId]);const email=await transportSource(c.db,{orgId:c.orgId,channel:'email',env:c.env});assert.equal(email.sending,false);assert.equal(email.approved,false);
  assert.match(await (await c.app.get('/settings/morning')).text(),/Unapproved/);
});
