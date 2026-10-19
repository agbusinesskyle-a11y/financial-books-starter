import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startApp } from './app-harness.js';
import { mvOrg, mvUser, signInAs, mvCompleteSetup } from './morning-fixtures.js';
import { trustedActor, validateMorningIdentityIn } from '../lib/data/morning/access.js';
import { grantSecondViewer, removeSecondViewer, ownerResetViewer } from '../lib/data/morning/identity.js';
import { setUserActive } from '../lib/data/users.js';
import { settingsKey } from '../lib/secrets.js';
import { canAccess } from '../lib/domain/roles.js';
import { matchMorningRoute } from '../lib/domain/morning-paths.js';
import { renderMorningShell } from '../services/app/morning-routes.js';

let app,db,orgId,actorCtx,key,bank,excluded=[],viewerCount=0;
const morningTestHooks={};
before(async()=>{
  app=await startApp({env:{SETTINGS_KEY:'ab'.repeat(32)},morningTestHooks});db=app.db.pool;orgId=app.ids.orgId;key=settingsKey(app.env);
  actorCtx=trustedActor({owner:true},orgId,app.ownerSession);
  bank=(await db.query("SELECT account_id FROM account WHERE org_id=$1 AND type='bank' LIMIT 1",[orgId])).rows[0].account_id;
  for(const [i,role] of ['admin','admin','standard','reports','customers','vendors'].entries()) {
    const u=await mvUser(db,{orgId,email:`excluded${i}@sample.example`,role});
    if(i===1){await db.query('UPDATE app_user SET all_companies=false WHERE user_id=$1',[u.userId]);await db.query('INSERT INTO app_user_company (org_id,user_id,entity_id) VALUES ($1,$2,$3)',[orgId,u.userId,app.ids.entityId]);}
    excluded.push({...await signInAs(app,{...u,email:`excluded${i}@sample.example`}),userId:u.userId,role});
  }
});
after(async()=>{await app?.close();});
const getWith=(cookie,path)=>fetch(app.base+path,{redirect:'manual',headers:{cookie}});
const postWith=(cookie,path,body)=>fetch(app.base+path,{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString()});
async function readyViewer() {
  const u=await mvUser(db,{orgId,email:`ready${++viewerCount}@sample.example`,role:'reports'});
  const args={actorCtx,orgId,userId:u.userId,key,now:new Date(app.clock())};
  const issued=await grantSecondViewer(db,args),setup=await mvCompleteSetup(app,{token:issued.token});
  await db.query('UPDATE app_user SET all_companies=false WHERE user_id=$1',[u.userId]);
  const csrf=app.sessionFor(setup.cookie).csrf;
  return {...setup,...u,args,csrf,get:path=>getWith(setup.cookie,path),post:(path,body={})=>postWith(setup.cookie,path,{csrf,...body})};
}
const routes=()=>[['GET','/morning'],['GET',`/morning/accounts/${bank}`],['GET','/morning/entries'],['GET','/morning/attention'],['GET','/morning/dismissed'],['POST','/morning/dismiss'],['POST','/morning/undismiss'],['GET','/settings/morning'],['POST','/settings/morning/preferences'],['POST','/settings/morning/floors'],['POST','/settings/morning/viewer',true],['POST','/settings/morning/company-threshold',true],['POST','/settings/morning/delivery',true],['POST','/settings/morning/transport-approve',true]];
async function featureState(){const state={};for(const table of ['viewer','preference','floor','visit','snapshot_generation','dismissal','company_setting','delivery_setting','transport','message_claim'])state[table]=(await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM morning_${table} t`)).rows[0].data;return state;}

test('all 14 pairs use owner/current-viewer authority; observing GETs and delivery-off persist their exact state',async()=>{
  const w=await readyViewer(),before=await featureState();
  assert.equal((await w.get('/customers')).status,403);
  for(const [method,path,ownerOnly] of routes()) {
    const allowedStatus=method==='GET'?200:path==='/morning/dismiss'?409:path==='/settings/morning/delivery'?303:422;
    const r=await (method==='GET'?app.get(path):app.post(path));assert.equal(r.status,allowedStatus,`owner ${method} ${path}`);assert.equal(r.headers.get('cache-control'),'no-store');
    if(method==='GET')assert.match(await r.text(),/<title>Morning View/);
    const wr=await (method==='GET'?w.get(path):w.post(path));assert.equal(wr.status,ownerOnly?403:allowedStatus,`viewer ${method} ${path}`);
    for(const c of excluded)assert.equal((await (method==='GET'?c.get(path):c.post(path))).status,403,`${c.role} ${method} ${path}`);
  }
  const after=await featureState(),delivery=after.delivery_setting;
  assert.equal(delivery.length,1);assert.equal(delivery[0].org_id,orgId);
  assert.equal(delivery[0].delivery_enabled,false);assert.equal(delivery[0].settings_version,2);
  assert.equal(delivery[0].trusted_origin,null);
  assert.equal(delivery[0].trusted_origin_fingerprint,null);assert.ok(delivery[0].updated_at);
  assert.equal(after.visit.length,2);assert.equal(after.snapshot_generation.length,2);
  assert.deepEqual(after.visit.map(v=>v.viewer_key).sort(),[String(w.userId),'owner'].sort());
  for(const visit of after.visit){assert.equal(visit.visit_version,1);assert.equal(visit.comparison_generation_id,null);
    assert.ok(after.snapshot_generation.some(g=>g.generation_id===visit.latest_generation_id&&g.viewer_key===visit.viewer_key));}
  assert.deepEqual({...after,delivery_setting:before.delivery_setting,visit:before.visit,snapshot_generation:before.snapshot_generation},before);
  const other=await mvOrg(db,{slug:'mvforeign'});
  assert.equal((await app.get(`/morning/accounts/${other.accounts['Sample company A'].checking}`)).status,404);
});
test('retired sessions redirect GET and reject POST; pending/nonmember/foreign identities are distinct',async()=>{
  for(const action of ['reset','remove','deactivate']) {
    const w=await readyViewer();
    if(action==='reset')await ownerResetViewer(db,w.args);else if(action==='remove')await removeSecondViewer(db,w.args);else await setUserActive(db,{...w.args,active:false});
    const r=await w.get('/morning');assert.equal(r.status,303);assert.match(r.headers.get('location'),/^\/login/);assert.equal((await w.post('/morning/dismiss')).status,401);
  }
  assert.equal((await excluded[0].get('/morning')).status,403);
  await removeSecondViewer(db,{actorCtx,orgId});
  const pending=await mvUser(db,{orgId,email:'pending@sample.example'}),pc=await signInAs(app,{...pending,email:'pending@sample.example'});
  await db.query("INSERT INTO morning_viewer (org_id,viewer_key,user_id,enrollment_state) VALUES ($1,$2,$3,'pending_enrollment')",[orgId,String(pending.userId),pending.userId]);
  await db.query('INSERT INTO morning_preference (org_id,viewer_key,membership_epoch) VALUES ($1,$2,1)',[orgId,String(pending.userId)]);
  const id=trustedActor({userId:pending.userId,orgId},orgId,pc.session);
  await assert.rejects(validateMorningIdentityIn(db,{identity:id}),e=>e.reason==='pending');assert.equal((await pc.get('/morning')).status,403);
  const foreign=await mvUser(db,{orgId,email:'foreign@sample.example'}),fc=await signInAs(app,{...foreign,email:'foreign@sample.example'});
  const other=(await db.query("INSERT INTO org (slug,name) VALUES ('cookie_other','Sample other organization') RETURNING org_id")).rows[0].org_id;
  await db.query('UPDATE app_user SET org_id=$2 WHERE user_id=$1',[foreign.userId,other]);
  const res=await fc.get('/morning');assert.equal(res.status,303);assert.match(res.headers.get('location'),/^\/login/);assert.equal((await fc.post('/morning/dismiss')).status,401);
});
test('every POST requires CSRF and rejects submitted authorization fields',async()=>{
  for(const field of ['org_id','org','viewer','viewer_key','owner','actor','as_user','session'])assert.equal((await app.get(`/morning?${field}=owner`)).status,400,field+' query');
  for(const [method,path] of routes().filter(r=>r[0]==='POST')) {
    for(const csrf of [null,'wrong']) {const r=await app.post(path,{csrf});assert.equal(r.status,403,method+' '+path);assert.match(await r.text(),/This form expired/);}
    for(const field of ['org_id','org','viewer','viewer_key','owner','actor','as_user','session'])assert.equal((await app.post(path,{[field]:'owner'})).status,400,field+' '+path);
  }
});
test('exact paths, positive safe account IDs and methods; roles deny every Morning prefix',async()=>{
  for(const path of ['/morning/','/morning/x','/morning/accounts/0','/morning/accounts/01','/morning/accounts/1x','/morning/accounts/9007199254740992','/morning%2Faccounts/1','/morning-extra'])assert.equal((await app.get(path)).status,404,path);
  assert.equal((await app.raw('/morning',{method:'PUT'})).status,405);assert.equal((await app.get('/settings/morning/viewer')).status,405);
  for(const role of ['admin','standard','reports','customers','vendors'])for(const [method,path] of routes())assert.equal(canAccess(role,method,path),false);
  assert.equal(canAccess('admin','GET','/morning-extra'),true);assert.equal(matchMorningRoute('GET','/morning-extra'),null);
  assert.deepEqual(matchMorningRoute('GET','/morning/accounts/7'),{route:'account',ownerOnly:false,accountId:7});
});
test('search, settings, bookmarks and shell use membership; Morning preserves selected company',async()=>{
  const search=await (await app.get('/search?q=Morning')).text();assert.match(search,/href="\/morning"/);assert.match(search,/href="\/settings\/morning"/);
  const a=excluded[0];await db.query("INSERT INTO nav_bookmark (org_id,entity_id,user_key,href,label,position) VALUES ($1,$2,$3,'/morning','Morning View',1)",[orgId,app.ids.entityId,String(a.userId)]);
  await db.query("INSERT INTO nav_pref (org_id,entity_id,user_key,pinned) VALUES ($1,$2,$3,ARRAY['morning']) ON CONFLICT (org_id,entity_id,user_key) DO UPDATE SET pinned=excluded.pinned",[orgId,app.ids.entityId,String(a.userId)]);
  for(const path of ['/search?q=Morning','/home','/settings','/bookmarks','/apps','/navigation'])assert.doesNotMatch(await (await a.get(path)).text(),/href="\/(?:morning|settings\/morning)(?:["/?])/);
  assert.doesNotMatch(await (await a.get('/navigation')).text(),/name="pin" value="morning"/);
  assert.equal((await a.post('/bookmarks/add',{href:'/morning',label:'Morning View'})).status,403);
  await a.post('/navigation',{pin:'morning'});
  assert.deepEqual((await db.query('SELECT pinned FROM nav_pref WHERE user_key=$1',[String(a.userId)])).rows[0].pinned,[]);
  const w=await readyViewer(),html=await (await w.get('/morning')).text();assert.match(html,/href="\/morning"/);assert.match(html,/action="\/logout"/);assert.match(html,/Sign out/);
  const b=(await db.query("INSERT INTO entity (org_id,name) VALUES ($1,'Sample company B') RETURNING entity_id",[orgId])).rows[0].entity_id;
  assert.equal((await app.post('/company/switch',{entity_id:String(b)})).status,303);assert.equal(app.ownerSession.entityId,b);
  assert.equal((await app.get('/morning')).status,200);assert.equal(app.ownerSession.entityId,b);await app.get('/home');assert.equal(app.ownerSession.entityId,b);
});
test('shell navigation errors propagate and the service worker never caches Morning',async()=>{
  const broken={query(text,values){if(text.includes('FROM nav_bookmark'))throw new Error('sample nav failure');return db.query(text,values);}};
  await assert.rejects(renderMorningShell(broken,{identity:actorCtx,session:app.ownerSession,body:'Sample body',path:'/morning',csrf:app.csrf}),/sample nav failure/);
  const w=await readyViewer(),identity=trustedActor({userId:w.userId,orgId},orgId,app.sessionFor(w.cookie));
  const bare=await renderMorningShell(db,{identity,session:app.sessionFor(w.cookie),body:'<a class="sample" href="/customers"><strong>Sample ordinary action</strong></a>',path:'/morning',csrf:w.csrf});
  assert.doesNotMatch(bare,/href="\/customers"/);assert.match(bare,/Sample ordinary action/);
  morningTestHooks.afterRouteCheck=()=>{throw Object.assign(new Error('sample connection failure'),{code:'ECONNRESET'});};
  try {const r=await app.get('/morning');assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'1');assert.doesNotMatch(await r.text(),/sample connection failure|ECONNRESET/);}
  finally {delete morningTestHooks.afterRouteCheck;}
  assert.doesNotMatch(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),/\/morning/);
});
