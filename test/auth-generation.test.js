import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { setTimeout as delay } from 'node:timers/promises';
import { freshDb } from './harness.js';
import { mvOrg, mvUser } from './morning-fixtures.js';
import { makeTotp, createAuth } from '../lib/auth.js';
import { trustedActor } from '../lib/data/morning/access.js';
import { settingsKey, encryptSecret } from '../lib/secrets.js';
import { checkSignIn, sessionUser, inviteUser, findOpenInvite, pendingSecret, completeInvite, resetSignIn } from '../lib/data/users.js';

const key = settingsKey({ SETTINGS_KEY:'ab'.repeat(32) });
const now = new Date('2026-10-17T15:00:00Z');
function authTest(name, fn) {
  test(name, async t => {
    const db=await freshDb();
    try {
      const f=await mvOrg(db.pool), u=await mvUser(db.pool,{orgId:f.orgId,email:'viewer@sample.example'});
      const login = (extra={}, pool=db.pool) => checkSignIn(pool,{orgSlug:'mvtest',email:'viewer@sample.example',password:u.password,
        code:makeTotp(u.totpSecret).generate({timestamp:now.getTime()}),key,now,...extra});
      await fn({t,db:db.pool,f,u,login});
    } finally { t.after(()=>db.drop()); }
  });
}
const resetSql = (db,id) => db.query('UPDATE app_user SET password_hash=NULL,totp_enc=NULL,last_totp_counter=-1,signin_version=signin_version+1 WHERE user_id=$1',[id]);
async function setup(db, orgId, orgSlug='mvtest') {
  const {userId,token}=await inviteUser(db,{orgId,fields:{name:'the second viewer',email:'setup@sample.example',role:'standard'},actor:'the owner',key,now});
  const invite=await findOpenInvite(db,{token,orgSlug,now});
  const secret=await pendingSecret(db,{invite,key});
  return {userId,token,secret,orgSlug,password:'sample password 1',password2:'sample password 1',key,now,code:makeTotp(secret).generate({timestamp:now.getTime()})};
}
authTest('stale login: reset between verify and update issues no session',async ({db,u,login})=>{
  assert.equal(await login({hooks:{afterVerify:()=>resetSql(db,u.userId)}}),null);
  const row=(await db.query('SELECT signin_version,last_login_at FROM app_user WHERE user_id=$1',[u.userId])).rows[0];
  assert.deepEqual(row,{signin_version:1,last_login_at:null});
});
authTest('stale login: fresh setup completing before the update still fails',async ({db,u,login})=>{
  const replacement=await bcrypt.hash('fresh sample password',4);
  assert.equal(await login({hooks:{afterVerify:async()=>{
    await resetSql(db,u.userId);
    await db.query('UPDATE app_user SET password_hash=$2,totp_enc=$3,signin_version=2 WHERE user_id=$1',[u.userId,replacement,encryptSecret(key,u.totpSecret)]);
  }}}),null);
  assert.equal(await sessionUser(db,{userId:u.userId,version:0}),null);
  assert.equal((await sessionUser(db,{userId:u.userId,version:2})).userId,u.userId);
});
authTest('stale login: credential replacement with the same version number still fails',async ({db,u,login})=>{
  const replacement=await bcrypt.hash('fresh sample password',4);
  assert.equal(await login({hooks:{afterVerify:()=>db.query('UPDATE app_user SET password_hash=$2 WHERE user_id=$1',[u.userId,replacement])}}),null);
});
authTest('login before reset is invalidated by reset',async ({db,u,login})=>{
  assert.deepEqual(await login(),{userId:u.userId,version:0});
  await resetSql(db,u.userId);
  assert.equal(await sessionUser(db,{userId:u.userId,version:0}),null);
});
authTest('replay counter and active state are checked in the compare-and-set',async ({db,u,login})=>{
  assert.deepEqual(await login(),{userId:u.userId,version:0}); assert.equal(await login(),null);
  const later=new Date(now.getTime()+30000);
  assert.equal(await login({now:later,code:makeTotp(u.totpSecret).generate({timestamp:later.getTime()}),hooks:{afterVerify:()=>db.query('UPDATE app_user SET active=false WHERE user_id=$1',[u.userId])}}),null);
  assert.equal((await db.query('SELECT active FROM app_user WHERE user_id=$1',[u.userId])).rows[0].active,false);
});
authTest('slow verification holds no locks',async ({db,f,u,login})=>{
  let checked=0;
  const unlocked=async userId=>{
    const c=await db.connect();
    try {
      assert.equal((await c.query('SELECT pg_try_advisory_lock(74120065,hashint8($1)) AS ok',[f.orgId])).rows[0].ok,true);
      await c.query('BEGIN'); await c.query('SELECT 1 FROM app_user WHERE user_id=$1 FOR UPDATE NOWAIT',[userId]); await c.query('ROLLBACK'); checked++;
    } finally { await c.query('SELECT pg_advisory_unlock(74120065,hashint8($1))',[f.orgId]); c.release(); }
  };
  await login({hooks:{afterVerify:()=>unlocked(u.userId)}});
  const args=await setup(db,f.orgId);
  await completeInvite(db,{...args,hooks:{afterHash:()=>unlocked(args.userId)}});
  assert.equal(checked,2);
});
authTest('setup completion advances the generation',async ({db,f})=>{
  const args=await setup(db,f.orgId), done=await completeInvite(db,args);
  assert.equal(done.version,1); assert.equal(done.userId,args.userId);
  assert.equal(await sessionUser(db,{userId:args.userId,version:0}),null);
});
authTest('setup completion is organization-scoped',async ({db})=>{
  const other=await mvOrg(db,{slug:'mvother'}),args=await setup(db,other.orgId,'mvother');
  assert.equal(await findOpenInvite(db,{token:args.token,now}),null);
  await assert.rejects(completeInvite(db,{...args,orgSlug:'mvtest'}),/This link isn’t active any more/);
  assert.equal((await db.query('SELECT password_hash FROM app_user WHERE user_id=$1',[args.userId])).rows[0].password_hash,null);
});
authTest('stale setup page after reset fails',async ({db,f})=>{
  const args=await setup(db,f.orgId);
  const ownerSession=createAuth({env:{DEV_NO_AUTH:'1'}}).current({headers:{}}).session;
  const actorCtx=trustedActor({owner:true},f.orgId,ownerSession);
  const issued=await resetSignIn(db,{orgId:f.orgId,userId:args.userId,actor:'the owner',actorCtx,key,now});
  const token=typeof issued==='string'?issued:issued.token;
  await assert.rejects(completeInvite(db,args),/This link isn’t active any more/);
  const invite=await findOpenInvite(db,{token,orgSlug:'mvtest',now}),secret=await pendingSecret(db,{invite,key});
  const done=await completeInvite(db,{...args,token,code:makeTotp(secret).generate({timestamp:now.getTime()})});
  assert.equal(done.version,2);
});
authTest('ordinary non-viewer users get the same contract',async ({db,f})=>{
  const u=await mvUser(db,{orgId:f.orgId,email:'reports@sample.example',role:'reports'});
  const args={orgSlug:'mvtest',email:'reports@sample.example',password:u.password,code:makeTotp(u.totpSecret).generate({timestamp:now.getTime()}),key,now};
  assert.equal(await checkSignIn(db,{...args,hooks:{afterVerify:()=>resetSql(db,u.userId)}}),null);
  await db.query('UPDATE app_user SET password_hash=$2,totp_enc=$3 WHERE user_id=$1',[u.userId,await bcrypt.hash(u.password,4),encryptSecret(key,u.totpSecret)]);
  assert.equal(await checkSignIn(db,{...args,hooks:{afterVerify:async()=>{
    await resetSql(db,u.userId);
    await db.query('UPDATE app_user SET password_hash=$2,totp_enc=$3,signin_version=3 WHERE user_id=$1',[u.userId,await bcrypt.hash('fresh sample password',4),encryptSecret(key,u.totpSecret)]);
  }}}),null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM morning_viewer')).rows[0].n,0);
});

// Wrap the real driver, without substituting the server lock or its completion.
function instrument(pool, intercept, released = ()=>{}) {
  return {query:pool.query.bind(pool),async connect(){
    const c=await pool.connect();
    return {query:(q,values)=>intercept(c,q,values),release:destroy=>{released(c,destroy);c.release(destroy);}};
  }};
}
authTest('driver-aware writer wait',async ({t,db,f,u,login})=>{
  const {SECURITY_LOCK,withSecurityRead}=await import('../lib/data/morning/locks.js');
  assert.equal(SECURITY_LOCK,74120065);
  const holder=await db.connect(); let held=false;
  t.after(async()=>{if(held)await holder.query('SELECT pg_advisory_unlock_shared(74120065,hashint8($1))',[f.orgId]);holder.release();});
  await holder.query('SELECT pg_advisory_lock_shared(74120065,hashint8($1))',[f.orgId]); held=true;
  const release=delay(31000).then(async()=>{await holder.query('SELECT pg_advisory_unlock_shared(74120065,hashint8($1))',[f.orgId]);held=false;});
  const started=performance.now(); assert.deepEqual(await login(),{userId:u.userId,version:0}); await release;
  assert.ok(performance.now()-started>=30000,'driver guard must allow the real 31s wait');
  await holder.query('SELECT pg_advisory_lock_shared(74120065,hashint8($1))',[f.orgId]);held=true;
  const scaled=instrument(db,(c,q,values)=>{
    const text=typeof q==='string'?q:q.text;
    const v=(values??q.values)?.map(x=>text.includes('set_config')&&/^\d+(ms)?$/.test(String(x))&&Number.parseInt(x)>=30000?'350ms':x);
    return c.query(typeof q==='string'?{text,values:v}:{...q,values:v,query_timeout:q.query_timeout>=30000?370:q.query_timeout});
  });
  const later=new Date(now.getTime()+30000), extra={now:later,code:makeTotp(u.totpSecret).generate({timestamp:later.getTime()})};
  assert.equal(await login(extra,scaled),null);
  await holder.query('SELECT pg_advisory_unlock_shared(74120065,hashint8($1))',[f.orgId]);held=false;
  assert.deepEqual(await login(extra),{userId:u.userId,version:0});
  await withSecurityRead(db,{orgId:f.orgId},async()=>{});
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows[0].n,0);
});
authTest('client guard destroys uncertain connection',async ({t,db,f,u,login})=>{
  await import('../lib/data/morning/locks.js');
  const holder=await db.connect();t.after(()=>holder.release());
  await holder.query('SELECT pg_advisory_lock_shared(74120065,hashint8($1))',[f.orgId]);
  let brokenPid,destroyed=false,socket;
  const injected=instrument(db,async(c,q,values)=>{
    const text=typeof q==='string'?q:q.text;
    if(text.includes('pg_advisory_lock(')){
      brokenPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; socket=c.connection.stream;
      return c.query({text,values:values??q.values,query_timeout:30});
    }
    return c.query(q,values);
  },(c,destroy)=>{destroyed=destroy===true;});
  try { await assert.rejects(login({},injected),/Query read timeout/); }
  finally {await holder.query('SELECT pg_advisory_unlock_shared(74120065,hashint8($1))',[f.orgId]);}
  assert.equal(destroyed,true);assert.equal(socket.destroyed,true);
  assert.notEqual((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,brokenPid);
  for(let i=0;i<50;i++) {
    if(!(await db.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[brokenPid])).rowCount)break;
    await delay(10);
  }
  assert.equal((await db.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[brokenPid])).rowCount,0);
  const r=(await db.query('SELECT signin_version,last_login_at,last_totp_counter FROM app_user WHERE user_id=$1',[u.userId])).rows[0];
  assert.deepEqual(r,{signin_version:0,last_login_at:null,last_totp_counter:-1});
});
