import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { startApp } from './app-harness.js';
import { mvUser, signInAs, mvCompleteSetup } from './morning-fixtures.js';
import { makeTotp } from '../lib/auth.js';
import { settingsKey } from '../lib/secrets.js';
import { trustedActor, ensureOwnerViewer, validateMorningIdentityIn } from '../lib/data/morning/access.js';
import { grantSecondViewer, removeSecondViewer, ownerResetViewer, secondViewer } from '../lib/data/morning/identity.js';
import { resetSignIn, resendInvite, updateUser, setUserActive, completeInvite, findOpenInvite, pendingSecret, checkSignIn, sessionUser } from '../lib/data/users.js';
import { setUserCompanies } from '../lib/data/companies.js';
import { withReadSnapshot } from '../lib/data/morning/locks.js';

function identityTest(name,fn) {
  test(name,async t=>{
    const sent=[],hooks={}; let lookups=0;
    const app=await startApp({env:{SETTINGS_KEY:'ab'.repeat(32),APP_BASE_URL:'https://books.sample.example'},
      mailer:{kind:'smtp',from:'books@sample.example',async send(m){sent.push(m);return {status:'sent'};}},
      userRoutesTestHooks:{afterTargetLookup:async x=>{lookups++;await hooks.afterTargetLookup?.(x);}}});
    t.after(()=>app.close());
    const db=app.db.pool,orgId=app.ids.orgId,key=settingsKey(app.env);
    await ensureOwnerViewer(db,orgId);
    const actorCtx=trustedActor({owner:true,userId:null},orgId,app.ownerSession);
    const admin=await mvUser(db,{orgId,email:'admin@sample.example',role:'admin'});
    const adminClient=await signInAs(app,{...admin,email:'admin@sample.example'});
    const adminCtx=trustedActor(await sessionUser(db,adminClient.session),orgId,adminClient.session);
    const target=await mvUser(db,{orgId,email:'target@sample.example'});
    const targetClient=await signInAs(app,{...target,email:'target@sample.example'});
    const targetCtx=trustedActor(await sessionUser(db,targetClient.session),orgId,targetClient.session);
    const args={actorCtx,orgId,userId:target.userId,key,now:new Date(app.clock())};
    const grant=()=>grantSecondViewer(db,{...args,now:new Date(app.clock())});
    const ready=async()=>{const issued=await grant();const setup=await mvCompleteSetup(app,{token:issued.token});return {...setup,issued};};
    const row=async()=> (await db.query('SELECT * FROM app_user WHERE user_id=$1',[target.userId])).rows[0];
    await fn({t,app,db,orgId,key,actorCtx,admin,adminCtx,adminClient,target,targetClient,targetCtx,args,grant,ready,row,sent,hooks,lookups:()=>lookups});
  });
}
const tokenOf=html=>/\/invite\/([A-Za-z0-9_-]{43})/.exec(html)[1];
const rawGet=(app,cookie,path)=>fetch(app.base+path,{redirect:'manual',headers:{cookie}});
async function ordinaryInvite(db,orgId,userId,now) {
  const token=randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO user_invite (org_id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)`,[orgId,userId,createHash('sha256').update(token).digest('hex'),new Date(now+86400000)]);
  return token;
}
async function completion(app,token) {
  const key=settingsKey(app.env), now=new Date(app.clock()),invite=await findOpenInvite(app.db.pool,{token,orgSlug:'sample',now});
  const secret=await pendingSecret(app.db.pool,{invite,key});
  app.advance(30000);
  return {token,orgSlug:'sample',key,now:new Date(app.clock()),password:'sample password 1',password2:'sample password 1',code:makeTotp(secret).generate({timestamp:app.clock()})};
}
async function seedClaim(db,orgId,userId,epoch=1) {
  await db.query(`INSERT INTO morning_message_claim (org_id,viewer_key,sent_on,claim_id,state,captured_at,membership_epoch,recipient_settings_version,delivery_settings_version,transport_source_revision,transport_approved_revision,channel)
    VALUES ($1,$2,'2026-10-12',$3,'claimed',now(),$4,1,1,1,1,'sms')`,[orgId,String(userId),randomUUID(),epoch]);
}
identityTest('owner grant clears existing credentials, sessions and links',async c=>{
  const old=await ordinaryInvite(c.db,c.orgId,c.target.userId,c.app.clock()),before=await c.row(),n=c.sent.length;
  const issued=await c.grant(),after=await c.row();
  assert.equal(after.password_hash,null);assert.equal(after.totp_enc,null);assert.equal(after.signin_version,before.signin_version+1);assert.equal(after.last_totp_counter,-1);
  assert.equal((await fetch(c.app.base+'/invite/'+old)).status,404);
  const res=await c.targetClient.get('/customers');assert.equal(res.status,303);assert.match(res.headers.get('location'),/^\/login/);
  const v=await secondViewer(c.db,c.args);assert.equal(v.state,'pending_enrollment');assert.equal(v.epoch,1);assert.equal(issued.ownerCopyOnly,true);assert.equal(c.sent.length,n);
});
identityTest('ordinary-admin reset → attacker setup → owner first grant',async c=>{
  const reset=await c.adminClient.post(`/settings/users/${c.target.userId}/reset`);assert.equal(reset.status,200);
  const attacker=await mvCompleteSetup(c.app,{token:tokenOf(await reset.text()),password:'sample attacker password'});
  const oldIdentity=trustedActor(await sessionUser(c.db,{userId:attacker.userId,version:attacker.version}),c.orgId,c.app.sessionFor(attacker.cookie));
  await c.grant();assert.equal((await rawGet(c.app,attacker.cookie,'/customers')).status,303);
  assert.equal(await checkSignIn(c.db,{orgSlug:'sample',email:'target@sample.example',password:attacker.password,code:makeTotp(attacker.secret).generate({timestamp:c.app.clock()+30000}),key:c.key,now:new Date(c.app.clock()+30000)}),null);
  await assert.rejects(withReadSnapshot(c.db,{orgId:c.orgId,viewerKey:oldIdentity.viewerKey,identity:oldIdentity},tx=>validateMorningIdentityIn(tx,{identity:oldIdentity})),e=>e.reason==='stale_session');
  // A valid, independently authenticated generation can still have pending membership.
  const u=await mvUser(c.db,{orgId:c.orgId,email:'pending@sample.example'}),cl=await signInAs(c.app,{...u,email:'pending@sample.example'});
  await removeSecondViewer(c.db,c.args);
  await c.db.query(`INSERT INTO morning_viewer (org_id,viewer_key,user_id,enrollment_state) VALUES ($1,$2,$3,'pending_enrollment')`,[c.orgId,String(u.userId),u.userId]);
  await c.db.query('INSERT INTO morning_preference (org_id,viewer_key,membership_epoch) VALUES ($1,$2,1)',[c.orgId,String(u.userId)]);
  const id=trustedActor(await sessionUser(c.db,cl.session),c.orgId,cl.session);
  await assert.rejects(validateMorningIdentityIn(c.db,{identity:id}),e=>e.reason==='pending');
});
identityTest('owner removal → ordinary-admin reset → attacker setup → owner regrant',async c=>{
  await c.ready();await seedClaim(c.db,c.orgId,c.target.userId);await removeSecondViewer(c.db,c.args);
  assert.equal((await c.db.query('SELECT membership_epoch FROM morning_viewer WHERE user_id=$1',[c.target.userId])).rows[0].membership_epoch,2);
  const reset=await c.adminClient.post(`/settings/users/${c.target.userId}/reset`);assert.equal(reset.status,200);
  const attacker=await mvCompleteSetup(c.app,{token:tokenOf(await reset.text())});
  assert.equal((await c.grant()).epoch,3);assert.equal((await rawGet(c.app,attacker.cookie,'/customers')).status,303);
  assert.equal((await c.row()).password_hash,null);
  assert.equal((await c.db.query('SELECT count(*)::int AS n FROM morning_message_claim WHERE viewer_key=$1',[String(c.target.userId)])).rows[0].n,1);
});
identityTest('pending enrollment protects the identity and consumes the slot',async c=>{
  await c.grant();const before=await c.row();
  for(const suffix of ['/reset','/resend','/deactivate','']) {
    const r=await c.adminClient.post(`/settings/users/${c.target.userId}${suffix}`,{name:'the second viewer',email:'changed@sample.example',role:'standard',companyAccess:'1',allCompanies:'1'});
    assert.equal(r.status,403,suffix);assert.deepEqual(await c.row(),before);
  }
  await assert.rejects(setUserCompanies(c.db,{...c.args,actorCtx:c.adminCtx,all:false,entityIds:[c.app.ids.entityId]}),/Only the owner/);
  const u=await mvUser(c.db,{orgId:c.orgId,email:'replacement@sample.example'});
  await assert.rejects(c.db.query(`INSERT INTO morning_viewer (org_id,viewer_key,user_id,enrollment_state) VALUES ($1,$2,$3,'pending_enrollment')`,[c.orgId,String(u.userId),u.userId]),e=>e.constraint==='morning_viewer_one_second');
  const issue=await grantSecondViewer(c.db,{...c.args,userId:u.userId});assert.equal(issue.replacedUserId,c.target.userId);
  assert.equal((await c.db.query('SELECT enrollment_state FROM morning_viewer WHERE user_id=$1',[c.target.userId])).rows[0].enrollment_state,'disabled');
  const page=await (await c.adminClient.get(`/settings/users/${u.userId}`)).text();assert.match(page,/only the owner can change them/);assert.doesNotMatch(page,/action="[^\"]*\/(reset|resend|deactivate)"/);
});
identityTest('expired protected link keeps the slot',async c=>{
  await c.grant();await c.db.query(`UPDATE user_invite SET expires_at='2020-01-01' WHERE user_id=$1`,[c.target.userId]);
  assert.equal((await secondViewer(c.db,c.args)).state,'pending_enrollment');assert.equal((await c.adminClient.post(`/settings/users/${c.target.userId}/reset`)).status,403);
});
identityTest('only a current epoch-bound owner link completes setup',async c=>{
  const first=await c.grant(),stale=await completion(c.app,first.token),second=await ownerResetViewer(c.db,c.args);
  await assert.rejects(completeInvite(c.db,stale),/This link isn’t active any more/);
  await mvCompleteSetup(c.app,{token:second.token});assert.equal((await secondViewer(c.db,c.args)).state,'ready');
  const ordinary=await ordinaryInvite(c.db,c.orgId,c.target.userId,c.app.clock());
  await assert.rejects(completeInvite(c.db,await completion(c.app,ordinary)),/This link isn’t active any more/);
});
identityTest('owner reset of a ready viewer returns to pending and is owner-copy-only',async c=>{
  const ready=await c.ready(),n=c.sent.length;
  const r=await c.app.post(`/settings/users/${c.target.userId}/reset`);assert.equal(r.status,200);assert.match(await r.text(),/It was not emailed\.[\s\S]*|It was not emailed\./);
  assert.equal(c.sent.length,n);const v=await secondViewer(c.db,c.args);assert.equal(v.state,'pending_enrollment');assert.equal(v.epoch,2);
  assert.equal((await rawGet(c.app,ready.cookie,'/customers')).status,303);
});
identityTest('deactivation revokes membership; reactivation needs a fresh grant',async c=>{
  await c.ready();const key=String(c.target.userId),g=randomUUID();await seedClaim(c.db,c.orgId,c.target.userId);
  const account=(await c.db.query("SELECT account_id FROM account WHERE org_id=$1 AND type='bank' LIMIT 1",[c.orgId])).rows[0].account_id;
  await c.db.query('INSERT INTO morning_floor (org_id,viewer_key,account_id,floor_cents) VALUES ($1,$2,$3,1)',[c.orgId,key,account]);
  await c.db.query("INSERT INTO morning_dismissal (org_id,viewer_key,item_key,item_version,rule_version) VALUES ($1,$2,'bill:1',$3,1)",[c.orgId,key,'a'.repeat(64)]);
  await c.db.query("INSERT INTO morning_snapshot_generation (org_id,viewer_key,generation_id,captured_at,as_of_date) VALUES ($1,$2,$3,'2026-10-12T15:00Z','2026-10-12')",[c.orgId,key,g]);
  await c.db.query("INSERT INTO morning_visit (org_id,viewer_key,latest_generation_id,reuse_anchor_at,latest_shown_at) VALUES ($1,$2,$3,'2026-10-12T15:00Z','2026-10-12T15:00Z')",[c.orgId,key,g]);
  const version=(await c.row()).signin_version;
  assert.equal((await c.app.post(`/settings/users/${c.target.userId}/deactivate`)).status,303);
  assert.equal((await c.row()).signin_version,version+1);
  for(const table of ['preference','floor','dismissal','visit','snapshot_generation'])assert.equal((await c.db.query(`SELECT count(*)::int AS n FROM morning_${table} WHERE viewer_key=$1`,[key])).rows[0].n,0);
  assert.equal((await c.db.query('SELECT count(*)::int AS n FROM morning_message_claim WHERE viewer_key=$1',[key])).rows[0].n,1);
  assert.equal((await c.app.post(`/settings/users/${c.target.userId}/activate`)).status,303);
  assert.equal((await c.db.query('SELECT enrollment_state FROM morning_viewer WHERE user_id=$1',[c.target.userId])).rows[0].enrollment_state,'disabled');
});
identityTest('shared writes refuse untrusted actors',async c=>{
  for(const actorCtx of [undefined,{owner:true,orgId:c.orgId}])for(const fn of [resetSignIn,resendInvite,updateUser,setUserActive,setUserCompanies])
    await assert.rejects(fn(c.db,{...c.args,actorCtx,fields:{name:'the second viewer',email:'target@sample.example',role:'standard'},active:false,all:true}),/trusted actor required/);
});
identityTest('concurrent grants serialize',async c=>{
  const u=await mvUser(c.db,{orgId:c.orgId,email:'replacement@sample.example'});
  await Promise.all([c.grant(),grantSecondViewer(c.db,{...c.args,userId:u.userId})]);
  assert.deepEqual((await c.db.query('SELECT enrollment_state FROM morning_viewer WHERE user_id IS NOT NULL ORDER BY enrollment_state')).rows.map(r=>r.enrollment_state),['disabled','pending_enrollment']);
  assert.equal((await c.db.query('SELECT count(*)::int AS n FROM user_invite WHERE owner_issued AND used_at IS NULL')).rows[0].n,1);
});
identityTest('invite completion racing a grant',async c=>{
  const token=await ordinaryInvite(c.db,c.orgId,c.target.userId,c.app.clock()),args=await completion(c.app,token);
  await assert.rejects(completeInvite(c.db,{...args,hooks:{afterHash:c.grant}}),/This link isn’t active any more/);assert.equal((await c.row()).password_hash,null);
});
identityTest('reset/resend provenance race',async c=>{
  for(const suffix of ['reset','resend']) {
    await removeSecondViewer(c.db,c.args);
    let entered,release;const atLookup=new Promise(r=>entered=r),resume=new Promise(r=>release=r);
    c.hooks.afterTargetLookup=async()=>{entered();await resume;};
    const n=c.sent.length,pending=c.app.post(`/settings/users/${c.target.userId}/${suffix}`);
    await atLookup;await c.grant();
    let acquired=0;const count=()=>acquired++;c.db.on('acquire',count);
    release();const r=await pending;c.db.removeListener('acquire',count);c.hooks.afterTargetLookup=null;
    assert.equal(acquired,1,'issuance uses one checkout and no nested pool wrapper');
    assert.equal(r.status,200);assert.match(await r.text(),/It was not emailed\./);assert.equal(c.sent.length,n);
    assert.equal((await secondViewer(c.db,c.args)).state,'pending_enrollment');
  }
});
identityTest('every identity edit advances epoch',async c=>{
  const b=(await c.db.query("INSERT INTO entity (org_id,name) VALUES ($1,'Sample company B') RETURNING entity_id",[c.orgId])).rows[0].entity_id;
  const changes=[{email:'changed@sample.example'},{role:'reports'},{canApproveBills:true},{all:false,entityIds:[c.app.ids.entityId]},{all:false,entityIds:[b]}];
  for(const [i,change] of changes.entries()) {
    const u=await mvUser(c.db,{orgId:c.orgId,email:`edit${i}@sample.example`,allCompanies:i!==4});
    if(i===4)await c.db.query('INSERT INTO app_user_company (org_id,user_id,entity_id) VALUES ($1,$2,$3)',[c.orgId,u.userId,c.app.ids.entityId]);
    const args={...c.args,userId:u.userId},issue=await grantSecondViewer(c.db,args),ready=await mvCompleteSetup(c.app,{token:issue.token});
    const before=(await c.db.query('SELECT * FROM app_user WHERE user_id=$1',[u.userId])).rows[0];
    assert.equal(issue.epoch,1);assert.equal(ready.version,2);await seedClaim(c.db,c.orgId,u.userId);
    const fields={name:before.name,email:before.email,role:before.role,canApproveBills:before.can_approve_bills,...change};
    if('all' in change)await setUserCompanies(c.db,{...args,...change});else await updateUser(c.db,{...args,fields});
    const v=await secondViewer(c.db,c.args),p=(await c.db.query('SELECT * FROM morning_preference WHERE viewer_key=$1',[String(u.userId)])).rows[0];
    assert.equal(v.epoch,2);assert.equal(p.membership_epoch,2);assert.equal(p.settings_version,2);
    assert.equal((await c.db.query('SELECT signin_version FROM app_user WHERE user_id=$1',[u.userId])).rows[0].signin_version,3);
    assert.equal(await sessionUser(c.db,{userId:u.userId,version:ready.version}),null);
    const claim=(await c.db.query('SELECT membership_epoch FROM morning_message_claim WHERE viewer_key=$1',[String(u.userId)])).rows[0];assert.notEqual(claim.membership_epoch,v.epoch);
  }
  // List-only change, then combined field/access edit: one epoch transition per request.
  await c.ready();let v=await secondViewer(c.db,c.args);
  await setUserCompanies(c.db,{...c.args,all:false,entityIds:[b]});assert.equal((await secondViewer(c.db,c.args)).epoch,v.epoch+1);
  const u=await c.row();v=await secondViewer(c.db,c.args);
  await updateUser(c.db,{...c.args,fields:{name:'the renamed second viewer',email:u.email,role:u.role,canApproveBills:u.can_approve_bills}});
  await setUserCompanies(c.db,{...c.args,all:false,entityIds:[b,b]});assert.equal((await secondViewer(c.db,c.args)).epoch,v.epoch);
  const combined=await c.app.post(`/settings/users/${c.target.userId}`,{name:u.name,email:'combined@sample.example',role:'standard',companyAccess:'1',allCompanies:'1'});assert.equal(combined.status,303);
  assert.equal((await secondViewer(c.db,c.args)).epoch,v.epoch+1);
  const pending=await c.grant(),stale=await completion(c.app,pending.token);
  await updateUser(c.db,{...c.args,fields:{name:u.name,email:'pending-edit@sample.example',role:'standard'}});
  assert.equal((await secondViewer(c.db,c.args)).epoch,pending.epoch+1);assert.equal((await secondViewer(c.db,c.args)).state,'pending_enrollment');
  assert.equal((await c.db.query('SELECT count(*)::int AS n FROM user_invite WHERE user_id=$1 AND used_at IS NULL',[c.target.userId])).rows[0].n,0);
  await assert.rejects(completeInvite(c.db,stale),/This link isn’t active any more/);
  const issue=await resendInvite(c.db,c.args);assert.equal(issue.epoch,pending.epoch+2);await mvCompleteSetup(c.app,{token:issue.token});
});
identityTest('actual auth interleavings',async c=>{
  for(const action of ['reset','reset-setup','grant','remove-regrant','ordinary-reset-setup']) {
    if(action==='ordinary-reset-setup')await removeSecondViewer(c.db,c.args);
    const issue=action==='ordinary-reset-setup'?await resetSignIn(c.db,c.args):await c.grant();
    const ready=await mvCompleteSetup(c.app,{token:issue.token});const u=await c.row();c.app.advance(30000);
    const login={orgSlug:'sample',email:u.email,password:ready.password,key:c.key,now:new Date(c.app.clock()),code:makeTotp(ready.secret).generate({timestamp:c.app.clock()})};
    const hook=async()=>{
      if(action==='remove-regrant'){await removeSecondViewer(c.db,c.args);await c.grant();}
      else if(action==='grant')await c.grant();
      else {const reset=await resetSignIn(c.db,c.args);if(action.endsWith('setup'))await completeInvite(c.db,await completion(c.app,reset.token));}
    };
    assert.equal(await checkSignIn(c.db,{...login,hooks:{afterVerify:hook}}),null,action);
  }
  const ready=await c.ready();c.app.advance(30000);const u=await c.row();
  const result=await checkSignIn(c.db,{orgSlug:'sample',email:u.email,password:ready.password,key:c.key,now:new Date(c.app.clock()),code:makeTotp(ready.secret).generate({timestamp:c.app.clock()})});
  assert.ok(result);await ownerResetViewer(c.db,c.args);assert.equal(await sessionUser(c.db,result),null);
});
identityTest('replacement discovers final participants',async c=>{
  await c.grant();const u=await mvUser(c.db,{orgId:c.orgId,email:'replacement@sample.example'}),v=await mvUser(c.db,{orgId:c.orgId,email:'last@sample.example'});
  let enter,release;const entered=new Promise(r=>enter=r),resume=new Promise(r=>release=r),locked=[];
  const pausedPool={async connect(){enter();await resume;const client=await c.db.connect();return {release:x=>client.release(x),query:async(q,values)=>{const text=typeof q==='string'?q:q.text;if(text.includes('ORDER BY user_id FOR UPDATE'))locked.push([...(values??q.values)[1]]);return client.query(q,values);}};}};
  const pending=grantSecondViewer(pausedPool,{...c.args,userId:v.userId});await entered;
  await grantSecondViewer(c.db,{...c.args,userId:u.userId});release();await pending;
  assert.ok(locked.some(ids=>ids.includes(u.userId)&&ids.includes(v.userId)&&!ids.includes(c.target.userId)));
  assert.equal((await secondViewer(c.db,c.args)).userId,v.userId);
  assert.equal((await c.db.query('SELECT count(*)::int AS n FROM user_invite WHERE owner_issued AND used_at IS NULL')).rows[0].n,1);
  await c.db.query('UPDATE app_user SET signin_version=signin_version+1 WHERE user_id=$1',[c.admin.userId]);
  for(const fn of [resetSignIn,resendInvite,updateUser,setUserActive,setUserCompanies])await assert.rejects(fn(c.db,{...c.args,actorCtx:c.adminCtx,fields:{name:'the second viewer',email:'target@sample.example',role:'standard'},active:false,all:true}),e=>e.reason==='stale_session');
});
