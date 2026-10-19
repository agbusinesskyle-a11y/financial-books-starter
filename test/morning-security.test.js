import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from './app-harness.js';
import { mvOrg, mvTxn, mvVendor, mvUser, signInAs, mvCompleteSetup } from './morning-fixtures.js';
import { trustedActor } from '../lib/data/morning/access.js';
import { grantSecondViewer, ownerResetViewer, removeSecondViewer } from '../lib/data/morning/identity.js';
import { setUserActive } from '../lib/data/users.js';
import { saveEmailSettings } from '../lib/data/settings.js';
import { saveSmsSettings } from '../lib/sms/twilio.js';
import { settingsKey } from '../lib/secrets.js';
import { transportSource, approveTransport, selectEmailCompany } from '../lib/data/morning/transport.js';
import { runMorningMessages } from '../lib/data/morning/messages.js';
import { ROLES } from '../lib/domain/roles.js';

const A='Sample company A', B='Sample company B', origin='https://books.sample.example';
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'");
const link=(body,label)=>{const m=[...body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^]*?)<\/a>/g)].find(m=>m[2].includes(label));assert.ok(m,`missing ${label}`);return decode(m[1]);};
const billForm=body=>{const forms=[...body.matchAll(/<form\b[^>]*action="\/morning\/dismiss"[^>]*>([^]*?)<\/form>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map(x=>[x[1],decode(x[2])])));const f=forms.find(f=>f.item_key.startsWith('bill:'));assert.ok(f,'current bill form');return f;};
const preference={enabled:'1',send_time:'06:30',channel:'sms',phone:'+16025550100',include_amounts:'',detail_threshold:'500'};
const emailFields={mode:'smtp',fromName:'Sample sender',fromEmail:'books@sample.example',replyTo:'',host:'127.0.0.1',port:'2525',security:'starttls',user:'',password:''};
const pairs=[
  ['GET','page'],['GET','account'],['GET','entries'],['GET','attention'],['GET','dismissed'],['GET','settings'],
  ['POST','dismiss'],['POST','undismiss'],['POST','preferences'],['POST','floors'],
  ['POST','viewer',true],['POST','company-threshold',true],['POST','delivery',true],['POST','transport-approve',true],
];
const tableNames=['morning_viewer','morning_preference','morning_floor','morning_visit','morning_snapshot_generation',
  'morning_snapshot_company','morning_snapshot_account','morning_dismissal','morning_company_setting','morning_delivery_setting',
  'morning_transport','morning_message_claim','app_user','app_user_company','user_invite','sms_settings','email_settings'];
let fixtureNumber=0;
async function fixture(t,{approveSms=true}={}) {
  const sent=[],hooks={};let f;
  const app=await startApp({now:new Date(+new Date('2026-10-17T13:00Z')+fixtureNumber++*16*60000),
    env:{SETTINGS_KEY:'ab'.repeat(32),APP_BASE_URL:origin,APP_ORG:'sample',NODE_ENV:'test'},morningTestHooks:hooks,
    mailer:{kind:'smtp',from:'books@sample.example',send:async m=>{sent.push(m);return {status:'sent'};}},
    seed:async db=>{f=await mvOrg(db,{slug:'sample',companies:[A,B]});return {...f,entityId:f.entities[A]};}});
  t.after(()=>app.close());const db=app.db.pool,orgId=f.orgId,owner=trustedActor({owner:true},orgId,app.ownerSession),key=settingsKey(app.env);
  assert.equal((await app.get('/settings/morning')).status,200);
  const vendor=await mvVendor(db,{orgId,entityId:f.entities[A],name:'Sample vendor A'});
  const add=(cents,extra={})=>mvTxn(db,{orgId,entityId:f.entities[A],type:'expense',vendorId:vendor,date:'2026-10-17',createdAt:new Date(app.clock()),postings:[{accountId:f.accounts[A].checking,cents}],...extra});
  for(const [account,cents] of [[f.accounts[A].checking,100000],[f.accounts[A].card,-20000]])await add(cents,{type:'journal_entry',vendorId:null,createdAt:new Date('2026-10-16T12:00Z'),postings:[{accountId:account,cents}]});
  const bill=await add(-10000,{type:'bill',date:'2026-10-01',dueDate:'2026-10-16',postings:[{accountId:f.accounts[A].ap,cents:-10000}]});
  await saveSmsSettings(db,{orgId,enabled:true,accountSid:`AC${'ab'.repeat(16)}`,authToken:'cd'.repeat(16),phone:'+16025550190',key,actor:'the owner'});
  await saveEmailSettings(db,{orgId,entityId:f.entities[A],fields:emailFields,env:app.env});
  await selectEmailCompany(db,{actorCtx:owner,entityId:f.entities[A]});
  const approve=async channel=>{const s=await transportSource(db,{orgId,channel,env:app.env});await approveTransport(db,{actorCtx:owner,channel,revision:s.row?.source_revision??1,fingerprint:s.fingerprint,env:app.env});};
  await approve('email');if(approveSms)await approve('sms');
  const page=async(client=app,path='/morning')=>{const r=await client.get(path);assert.equal(r.status,200,await r.clone().text());return r.text();};
  const snapshot=async()=>{const state={};for(const table of tableNames)state[table]=(await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) data FROM ${table} t`)).rows[0].data;return state;};
  const user=async({role='reports',allCompanies=true,ready=false,limited=false,email='viewer@sample.example'}={})=>{
    const u=await mvUser(db,{orgId,email,role,allCompanies});
    if(limited)await db.query('INSERT INTO app_user_company(org_id,user_id,entity_id) VALUES($1,$2,$3)',[orgId,u.userId,f.entities[A]]);
    const args={actorCtx:owner,orgId,userId:u.userId,key,now:new Date(app.clock())};let client;
    if(ready){const issued=await grantSecondViewer(db,args),setup=await mvCompleteSetup(app,{token:issued.token}),session=app.sessionFor(setup.cookie);
      client={...setup,session,csrf:session.csrf,get:path=>fetch(app.base+path,{redirect:'manual',headers:{cookie:setup.cookie}}),
        post:(path,body={})=>fetch(app.base+path,{method:'POST',redirect:'manual',headers:{cookie:setup.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:session.csrf,...body})})};
    }else client=await signInAs(app,{...u,email});
    return {...u,...client,args,viewerKey:String(u.userId)};
  };
  return {app,db,f,orgId,owner,key,vendor,bill,add,approve,page,snapshot,user,sent,hooks};
}

async function requestFixture(c,pair,client=c.app) {
  const [method,kind]=pair;
  let body=await c.page(client);
  if(kind==='entries'){
    c.app.advance(61*60000);
    for(let i=0;i<120;i++)await c.add(i%2?60000:-60000,{type:'journal_entry',vendorId:null});
    body=await c.page(client);
  }
  const form=billForm(body),bank=c.f.accounts[A].checking;
  if(['dismissed','undismiss'].includes(kind))assert.equal((await client.post('/morning/dismiss',{...form,note:'sample'})).status,303);
  const source=await transportSource(c.db,{orgId:c.orgId,channel:'sms',env:c.app.env});
  const target=kind==='viewer'?await mvUser(c.db,{orgId:c.orgId,email:'target@sample.example'}):null;
  const path={page:'/morning',account:link(body,'Checking'),entries:link(body,'All entries'),attention:link(body,'All bills'),dismissed:'/morning/dismissed',settings:'/settings/morning',dismiss:'/morning/dismiss',undismiss:'/morning/undismiss'}[kind]??`/settings/morning/${kind}`;
  const fields={dismiss:{...form,note:'sample'},undismiss:{item_key:form.item_key},preferences:preference,floors:{account_id:bank,floor:'100.00'},viewer:{action:'grant',user_id:target?.userId},'company-threshold':{entity_id:c.f.entities[A],threshold:'25000.00'},delivery:{enabled:'1'},'transport-approve':{channel:'sms',revision:source.row?.source_revision??1,fingerprint:source.fingerprint}}[kind]??{};
  const delivery=(await c.db.query('SELECT settings_version FROM morning_delivery_setting WHERE org_id=$1',[c.orgId])).rows[0].settings_version;
  return {method,kind,path,fields,form,target,source,delivery};
}
async function assertAllowed(c,r,request,client) {
  const {method,kind,form,target,source,delivery}=request,viewerKey=client.viewerKey??'owner';
  assert.equal(r.status,method==='GET'||kind==='viewer'?200:303,await r.clone().text());
  assert.equal(r.headers.get('cache-control'),'no-store');
  const body=await r.text(),own=async table=>(await c.db.query(`SELECT * FROM ${table} WHERE org_id=$1 AND viewer_key=$2`,[c.orgId,viewerKey])).rows;
  if(kind==='page'){assert.match(body,/data-value="cash" data-cents="100000"/);assert.match(body,/data-value="available" data-cents="80000"/);}
  if(kind==='account'){assert.equal(new URL(request.path,origin).pathname,`/morning/accounts/${c.f.accounts[A].checking}`);assert.match(body,/<h2>Checking<\/h2>/);assert.match(body,/data-value="account-balance" data-cents="100000"/);}
  if(kind==='entries'){assert.match(body,/data-entry-count="120"/);assert.equal((body.match(/data-entry-id=/g)||[]).length,50);}
  if(kind==='attention'){assert.match(body,/data-count="bills">1</);assert.match(body,/data-total="bill" data-cents="10000"/);}
  if(kind==='dismissed')assert.match(body,/data-matching-count="1"/);
  if(kind==='settings'){assert.equal((await own('morning_preference'))[0].settings_version,1);assert.match(body,/06:30/);}
  if(kind==='dismiss'){const rows=await own('morning_dismissal');assert.equal(rows.length,1);assert.deepEqual([rows[0].item_key,rows[0].item_version,rows[0].note],[form.item_key,form.item_version,'sample']);}
  if(kind==='undismiss')assert.equal((await own('morning_dismissal')).length,0);
  if(kind==='preferences'){const [p]=await own('morning_preference');assert.deepEqual([p.enabled,p.settings_version,p.detail_threshold_cents,p.send_minute,p.channel,p.phone,p.include_amounts],[true,2,50000,390,'sms',preference.phone,false]);}
  if(kind==='floors'){const [f]=await own('morning_floor');assert.equal(f.account_id,c.f.accounts[A].checking);assert.equal(f.floor_cents,10000);assert.equal((await own('morning_preference'))[0].settings_version,2);}
  if(kind==='viewer'){assert.match(body,/Copy this link.*It was not emailed/);const [v]=(await c.db.query('SELECT * FROM morning_viewer WHERE user_id=$1',[target.userId])).rows;assert.equal(v.enrollment_state,'pending_enrollment');assert.equal(v.membership_epoch,1);assert.equal(c.sent.length,0);}
  if(kind==='company-threshold')assert.equal((await c.db.query('SELECT large_threshold_cents FROM morning_company_setting WHERE org_id=$1 AND entity_id=$2',[c.orgId,c.f.entities[A]])).rows[0].large_threshold_cents,2500000);
  if(kind==='delivery'||kind==='transport-approve'){const [d]=(await c.db.query('SELECT * FROM morning_delivery_setting WHERE org_id=$1',[c.orgId])).rows;assert.equal(d.settings_version,delivery+1);if(kind==='delivery')assert.equal(d.delivery_enabled,true);}
  if(kind==='transport-approve'){const s=await transportSource(c.db,{orgId:c.orgId,channel:'sms',env:c.app.env});assert.equal(s.row.suspended,false);assert.equal(s.row.approved_revision,source.row?.source_revision??1);assert.equal(s.row.approved_fingerprint,source.fingerprint);}
}
const actors=[{name:'owner'},...ROLES.map(([role])=>({name:`ready ${role}`,role,ready:true})),
  ...['admin','limited admin','standard','reports','customers','vendors'].map(role=>({name:`excluded ${role}`,role:role==='limited admin'?'admin':role,limited:role==='limited admin',excluded:true})),
  ...['pending','reset','remove','deactivate','disabled','foreign'].map(state=>({name:state,state,ready:['pending','reset','remove','deactivate'].includes(state)})),
  {name:'no-company ready',ready:true,noCompanies:true}];

test('role x pair matrix: valid inputs, exact successes and unchanged rows on every refusal',async t=>{
  for(const actor of actors)for(const pair of pairs)await t.test(`${actor.name}: ${pair[0]} ${pair[1]}`,async t=>{
    const c=await fixture(t,{approveSms:pair[1]!=='transport-approve'});
    const client=actor.name==='owner'?c.app:await c.user({role:actor.role??'reports',ready:actor.ready,allCompanies:!actor.limited&&!actor.noCompanies,limited:actor.limited});
    // Excluded identities cannot obtain a signed context. Supply genuine current
    // owner form data; authorization must refuse before touching that context.
    const request=await requestFixture(c,pair,actor.ready||actor.name==='owner'?client:c.app);
    if(actor.noCompanies)assert.equal((await client.get('/customers')).status,403);
    if(actor.state==='pending')await c.db.query("UPDATE morning_viewer SET enrollment_state='pending_enrollment' WHERE user_id=$1",[client.userId]);
    if(actor.state==='reset')await ownerResetViewer(c.db,client.args);
    if(actor.state==='remove')await removeSecondViewer(c.db,client.args);
    if(actor.state==='deactivate')await setUserActive(c.db,{...client.args,active:false});
    if(actor.state==='disabled'){
      await c.db.query("INSERT INTO morning_viewer(org_id,viewer_key,user_id,enrollment_state) VALUES($1,$2,$3,'disabled')",[c.orgId,client.viewerKey,client.userId]);
      Object.assign(client,await signInAs(c.app,{...client,email:'viewer@sample.example'}));
    }
    if(actor.state==='foreign'){const other=(await c.db.query("INSERT INTO org(slug,name) VALUES('foreign','Sample other organization') RETURNING org_id")).rows[0].org_id;await c.db.query('UPDATE app_user SET org_id=$2 WHERE user_id=$1',[client.userId,other]);}
    const stale=['reset','remove','deactivate','foreign'].includes(actor.state),allowed=actor.name==='owner'||actor.ready&&!actor.state&&!pair[2];
    const before=allowed?null:await c.snapshot();
    const r=await client[request.method==='GET'?'get':'post'](request.path,request.fields);
    if(allowed)await assertAllowed(c,r,request,client);
    else{assert.equal(r.status,stale?(pair[0]==='GET'?303:401):403);if(stale&&pair[0]==='GET')assert.match(r.headers.get('location'),/^\/login/);assert.deepEqual(await c.snapshot(),before);assert.equal(c.sent.length,0);}
  });
});

test('CSRF on every POST and forged authority on every pair precede mutation',async t=>{
  for(const pair of pairs)for(const variant of [...(pair[0]==='POST'?['missing csrf','wrong csrf']:[]),'org_id','viewer_key'])await t.test(`${pair[1]} ${variant}`,async t=>{
    const c=await fixture(t,{approveSms:pair[1]!=='transport-approve'}),q=await requestFixture(c,pair),before=await c.snapshot();let r;
    if(variant.includes('csrf'))r=await c.app.post(q.path,{...q.fields,csrf:variant==='missing csrf'?null:'wrong'});
    else if(pair[0]==='POST')r=await c.app.post(q.path,{...q.fields,[variant]:'owner'});
    else r=await c.app.get(q.path+(q.path.includes('?')?'&':'?')+variant+'=owner');
    assert.equal(r.status,variant.includes('csrf')?403:400);assert.deepEqual(await c.snapshot(),before);assert.equal(c.sent.length,0);
  });
});

test('foreign source IDs are refused without any affected-row changes',async t=>{
  const c=await fixture(t),other=await mvOrg(c.db,{slug:'foreign'}),u=await mvUser(c.db,{orgId:other.orgId,email:'foreign@sample.example'});
  for(const [path,fields,status] of [
    ['/settings/morning/floors',{account_id:other.accounts[A].checking,floor:'100.00'},422],
    ['/settings/morning/company-threshold',{entity_id:other.entities[A],threshold:'25000.00'},422],
    ['/settings/morning/viewer',{action:'grant',user_id:u.userId},422],
    [`/morning/accounts/${other.accounts[A].checking}`,null,404],
  ]){const before=await c.snapshot(),r=fields?await c.app.post(path,fields):await c.app.get(path);assert.equal(r.status,status);assert.deepEqual(await c.snapshot(),before);}
});

async function enableMessages(c,client,channel='sms') {
  assert.equal((await client.post('/settings/morning/preferences',{...preference,channel,email:'viewer@sample.example'})).status,303);
  assert.equal((await c.app.post('/settings/morning/delivery',{enabled:'1'})).status,303);
  let instant=new Date(c.app.clock());instant=new Date(Date.UTC(instant.getUTCFullYear(),instant.getUTCMonth(),instant.getUTCDate()+1,14));
  const calls=[],clock={wall:()=>new Date(instant),mono:()=>1000};
  return {calls,nextDay:()=>{instant=new Date(+instant+86400000);},run:hooks=>runMorningMessages({pool:c.db,env:c.app.env,clock,log:()=>{},testHooks:{fetchImpl:async(url,init)=>{calls.push({url,body:new URLSearchParams(init.body)});return new Response('',{status:201});},...hooks}})};
}
test('no Host header trust in rendered absolute links or actual message composition',async t=>{
  const c=await fixture(t),r=await c.app.raw('/morning',{headers:{host:'evil.example','x-forwarded-host':'evil.example'}});assert.equal(r.status,200);const body=await r.text();
  assert.doesNotMatch(body,/evil\.example/);for(const m of body.matchAll(/(?:href|action)="(https?:[^" ]+)"/g))assert.ok(m[1].startsWith(origin+'/'),m[1]);
  const messages=await enableMessages(c,c.app);assert.equal((await messages.run()).sent,1);assert.equal(messages.calls.length,1);assert.match(messages.calls[0].body.get('Body'),/https:\/\/books\.sample\.example\/morning$/);
  const grep=spawnSync('git',['grep','-n','headers.host','--','lib/data/morning','services/app/morning-routes.js','lib/views/morning*.js'],{encoding:'utf8'});assert.equal(grep.status,1);assert.equal(grep.stdout,'');assert.equal(grep.stderr,'');
});

test('errors are sanitized in section output',async t=>{
  const c=await fixture(t);c.hooks.loaders={billsAndInvoices:async()=>{throw Object.assign(new Error('SELECT * FROM morning_secret\nat sample (private.js:1)'),{code:'42P01'});}};
  const body=await c.page();assert.match(body,/unavailable \(ref [^)]+\)/i);assert.doesNotMatch(body,/SELECT|morning_|at \w+ \(/);
});

test('escaping everywhere: party, company, account and note on all rendered views',async t=>{
  const c=await fixture(t),bad='"><img src=x onerror=1>',escaped='&quot;&gt;&lt;img src=x onerror=1&gt;';
  await c.db.query('UPDATE entity SET name=$2 WHERE entity_id=$1',[c.f.entities[A],bad]);
  await c.db.query('UPDATE account SET name=$2 WHERE account_id=$1',[c.f.accounts[A].checking,bad]);
  await c.db.query('UPDATE vendor SET display_name=$2 WHERE vendor_id=$1',[c.vendor,bad]);
  await c.page();c.app.advance(61*60000);for(let i=0;i<3;i++)await c.add(-60000);
  const body=await c.page(),form=billForm(body),paths=[link(body,bad.replaceAll('"','&quot;').replaceAll('>','&gt;').replaceAll('<','&lt;')),link(body,'All entries'),link(body,'All bills'),link(body,'View members'),link(body,'View pairs'),'/settings/morning'];
  assert.equal((await c.app.post('/morning/dismiss',{...form,note:bad})).status,303);paths.push('/morning/dismissed');
  for(const html of [body,...await Promise.all(paths.map(path=>c.page(c.app,path)))]){assert.ok(html.includes(escaped));assert.doesNotMatch(html,/<img src=x|[\s]onerror=1[^&]/);}
});

test('dispatch racing revocation and ordinary Email configuration',async t=>{
  for(const race of ['remove before send','admin email edit','remove after attempt'])await t.test(race,async t=>{
    const c=await fixture(t),w=await c.user({ready:true}),email=race==='admin email edit',messages=await enableMessages(c,w,email?'email':'sms');
    let sockets=0,writer,finished=false;
    const hooks={socketFactory:()=>{sockets++;throw new Error('unexpected SMTP connection');}};
    if(race==='remove before send')hooks.afterPrepare=()=>removeSecondViewer(c.db,w.args);
    if(email){const admin=await c.user({role:'admin',email:'admin@sample.example'});hooks.afterPrepare=async()=>{assert.equal((await admin.post('/settings/email',{...emailFields,fromName:'Sample changed sender'})).status,303);};}
    if(race==='remove after attempt')hooks.afterAttemptCAS=async()=>{const row=(await c.db.query('SELECT attempt_started_at FROM morning_message_claim')).rows[0];assert.ok(row.attempt_started_at);writer=removeSecondViewer(c.db,w.args).then(()=>{finished=true;});await delay(40);assert.equal(finished,false,'removal waits for dispatch read lock');};
    const result=await messages.run(hooks);if(writer)await writer;
    assert.equal(sockets,0);const claim=(await c.db.query('SELECT * FROM morning_message_claim WHERE viewer_key=$1',[w.viewerKey])).rows[0];
    if(race==='remove after attempt'){assert.equal(result.sent,1);assert.equal(claim.state,'sent');assert.equal(messages.calls.length,1);assert.equal(finished,true);messages.nextDay();assert.equal((await messages.run()).sent,0);assert.equal(messages.calls.length,1);}
    else{assert.equal(result.skipped,1);assert.equal(claim.state,'skipped');assert.equal(messages.calls.length,0);}
  });
});

test('protected links never use ordinary SMTP across every owner issuance path',async t=>{
  for(const path of ['grant','morning reset','user reset','user resend'])await t.test(path,async t=>{
    const c=await fixture(t),w=await c.user({ready:path!=='grant'});let r;
    if(path==='grant'||path==='morning reset')r=await c.app.post('/settings/morning/viewer',{action:path==='grant'?'grant':'reset',user_id:w.userId});
    else r=await c.app.post(`/settings/users/${w.userId}/${path==='user reset'?'reset':'resend'}`);
    assert.equal(r.status,200);const body=await r.text();assert.match(body,/Copy this link.*It was not emailed/);assert.match(body,/https:\/\/books\.sample\.example\/invite\//);assert.equal(c.sent.length,0);
  });
});

test('service worker stays unchanged and Morning responses forbid caching',async t=>{
  const c=await fixture(t),file=await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),before=execFileSync('git',['show','main:public/sw.js'],{encoding:'utf8'});
  assert.equal(file.replaceAll('\r\n','\n'),before.replaceAll('\r\n','\n'));assert.doesNotMatch(file,/\/morning/);
  for(const path of ['/morning',`/morning/accounts/${c.f.accounts[A].checking}`,'/morning/entries','/morning/attention','/morning/dismissed','/settings/morning']){const r=await c.app.get(path);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');}
});

test('Morning cross-company visibility leaves ordinary company and role boundaries intact',async t=>{
  for(const role of ['owner','ready reports','all-company admin','limited admin','reports','standard'])await t.test(role,async t=>{
    const c=await fixture(t),marker='Sample B source marker';
    await c.db.query('UPDATE account SET name=$2 WHERE account_id=$1',[c.f.accounts[B].checking,marker]);
    const vendor=await mvVendor(c.db,{orgId:c.orgId,entityId:c.f.entities[B],name:marker});
    await c.add(500,{entityId:c.f.entities[B],type:'journal_entry',vendorId:null,postings:[{accountId:c.f.accounts[B].checking,cents:500}]});
    const bill=await c.add(-10000,{entityId:c.f.entities[B],type:'bill',vendorId:vendor,date:'2026-10-01',dueDate:'2026-10-16',postings:[{accountId:c.f.accounts[B].ap,cents:-10000}]});
    const isOwner=role==='owner',ready=role==='ready reports',admin=role.includes('admin'),limited=role==='limited admin';
    const client=isOwner?c.app:await c.user({role:admin?'admin':ready?'reports':role,ready,allCompanies:!limited&&!ready,limited:limited||ready});
    for(const path of ['/vendors','/home','/search?q=marker']){const r=await client.get(path);assert.equal(r.status,200,path);assert.doesNotMatch(await r.text(),new RegExp(marker));}
    const session=isOwner?c.app.ownerSession:client.session,beforeCompany=session.entityId;assert.equal(beforeCompany,c.f.entities[A]);
    for(const path of [`/vendors/${vendor}`,`/vtxns/${bill}`])assert.equal((await client.get(path)).status,404,path);
    const books=async()=>{const out={};for(const table of ['account','vendor','txn','posting'])out[table]=(await c.db.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) data FROM ${table} t WHERE entity_id=$1`,[c.f.entities[B]])).rows[0].data;return out;};
    const before=await books(),r=await client.post(`/vendors/${vendor}`,{displayName:'Sample attempted change'});
    assert.equal(r.status,role==='reports'||ready?403:404);assert.deepEqual(await books(),before);
    const morning=await client.get('/morning');assert.equal(morning.status,isOwner||ready?200:403);
    if(isOwner||ready)assert.match(await morning.text(),new RegExp(marker));
    assert.equal(session.entityId,beforeCompany);assert.deepEqual(await books(),before);
  });
});
