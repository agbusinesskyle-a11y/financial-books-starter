import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './integration-fixtures.js';
import { authenticateBearer } from '../lib/integration/auth.js';
import { mintToken } from '../lib/integration/tokens.js';
import { assertWritePolicyTx } from '../lib/integration/policy.js';
import { withTransaction } from '../lib/db.js';
import { lockEntity } from '../lib/data/writes.js';
test('tokens are hashed, scoped, revocable and share a database rate window',async()=>{
  const f=await fixture({scopes:['settlements:read']});
  try {
    const row=(await f.pool.query('SELECT * FROM api_token WHERE token_id=$1',[f.tokenId])).rows[0];
    assert.equal(row.token_hash.length,32); assert.ok(!JSON.stringify(row).includes(f.token));
    assert.equal(f.identity.actor,`Integration: Sample connector [${f.tokenId}]`);
    const auth=extra=>authenticateBearer(f.pool,{authorization:`Bearer ${f.token}`,...extra});
    for(const authorization of ['', 'Basic x', `Bearer ${f.token}x`, `Bearer ${f.token},x`])
      await assert.rejects(auth({authorization}),{status:401,code:'invalid_token'});
    await assert.rejects(auth({scope:'payments:write'}),{status:403,code:'scope_required'});
    await assert.rejects(auth({entityId:f.ids.entityB}),{status:403,code:'company_scope'});
    const now=new Date('2026-10-22T12:00:00Z');
    await f.pool.query('UPDATE api_token SET rate_window=$2,rate_count=119 WHERE token_id=$1',[f.tokenId,now]);
    const pair=await Promise.allSettled([auth({now}),auth({now})]);
    assert.equal(pair.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(pair.find(r=>r.status==='rejected').reason.status,429);
    await f.revoke(); await assert.rejects(auth(),{status:401,code:'invalid_token'});
  } finally {await f.close();}
});

test('current scope and revocation win while a writer waits on the entity lock; rotation retains namespace',async()=>{
  const f=await fixture();
  const writer=()=>withTransaction(f.pool,async tx=>{
    await lockEntity(tx,f.S.orgId,f.S.entityId);
    return assertWritePolicyTx(tx,f.identity,{txnDate:'2026-10-22',requiredScope:'documents:write'});
  });
  try {
    const rotated=await mintToken(f.pool,{...f.S,name:'Sample rotation',source:f.identity.source,scopes:['documents:write'],actor:'tester'});
    const r=await authenticateBearer(f.pool,{authorization:`Bearer ${rotated.token}`});
    assert.equal(r.source,f.identity.source);assert.notEqual(r.tokenId,f.tokenId);
    for(const [sql,error] of [
      ["UPDATE api_token SET scopes=ARRAY['settlements:read'] WHERE token_id=$1",{status:403,code:'scope_required'}],
      ["UPDATE integration_setting SET accept_writes=false WHERE entity_id=$1",{status:403,code:'writes_disabled'}],
      ["UPDATE api_token SET revoked_at=now() WHERE token_id=$1",{status:401,code:'invalid_token'}],
    ]) {
      const blocker=await f.pool.connect();
      let pending;
      try {
        await blocker.query('BEGIN');await lockEntity(blocker,f.S.orgId,f.S.entityId);
        pending=assert.rejects(writer(),error);
        // The entity lock is held before the writer begins; commit the changed authorization first.
        await blocker.query(sql,[sql.includes('integration_setting')?f.S.entityId:f.tokenId]);
        await blocker.query('COMMIT');await pending;
      } finally {await blocker.query('ROLLBACK');blocker.release();}
      await f.pool.query("UPDATE api_token SET scopes=ARRAY['documents:write'] WHERE token_id=$1",[f.tokenId]);
      await f.pool.query('UPDATE integration_setting SET accept_writes=true WHERE entity_id=$1',[f.S.entityId]);
    }
    assert.equal(await f.count('txn'),0);
  } finally {await f.close();}
});

test('well-formed invalid bearer credentials consume the unauthenticated IP budget',async()=>{
  const f=await fixture();
  try {
    const authorization=`Bearer fbi_v1.${f.tokenId}.${'A'.repeat(43)}`;
    for(let n=0;n<30;n++) await assert.rejects(authenticateBearer(f.pool,{authorization,ip:'sample-invalid-ip'}),{status:401});
    await assert.rejects(authenticateBearer(f.pool,{authorization,ip:'sample-invalid-ip'}),{status:429});
    assert.equal((await authenticateBearer(f.pool,{authorization:`Bearer ${f.token}`,ip:'sample-valid-ip'})).tokenId,f.tokenId);
  } finally {await f.close();}
});

test('authenticated scope and company refusals consume the shared token budget',async()=>{
  const f=await fixture({scopes:['settlements:read']});
  try {
    const now=new Date('2026-10-22T13:00:00Z');
    for(let i=0;i<120;i++)await assert.rejects(authenticateBearer(f.pool,{authorization:`Bearer ${f.token}`,now,
      ...(i%2?{entityId:f.ids.entityB}:{scope:'payments:write'})}),{status:403});
    await assert.rejects(authenticateBearer(f.pool,{authorization:`Bearer ${f.token}`,scope:'payments:write',now}),{status:429});
    assert.equal((await f.pool.query('SELECT rate_count FROM api_token WHERE token_id=$1',[f.tokenId])).rows[0].rate_count,120);
  } finally {await f.close();}
});

test('invalid-token admission stops database work after thirty failures and resets next minute',async()=>{
  const f=await fixture();
  try {
    let queries=0,selects=0;
    const db={query:(sql,params)=>{queries++;if(sql.startsWith('SELECT * FROM api_token'))selects++;return f.pool.query(sql,params);}};
    const now=new Date('2026-10-22T14:00:10Z'),ip='sample-admission-ip';
    const bad=`Bearer fbi_v1.${f.tokenId}.${'A'.repeat(43)}`,good=`Bearer ${f.token}`;
    for(let i=0;i<35;i++)await assert.rejects(authenticateBearer(db,{authorization:bad,now,ip}),error=>{
      assert.equal(error.status,i<30?401:429);
      if(i>=30)assert.equal(error.retryAfter,50);
      return true;
    });
    assert.equal(selects,30,'throttled credentials must not look up a token');
    assert.equal(queries,30,'throttled credentials must do no database work');
    await assert.rejects(authenticateBearer(db,{authorization:good,now,ip}),{status:429});
    await assert.rejects(authenticateBearer(db,{authorization:'Basic sample',now,ip}),{status:429});
    assert.equal(queries,30,'exhausted IP admission precedes even valid credential lookup');
    assert.equal((await authenticateBearer(db,{authorization:good,now,ip:'sample-other-ip'})).tokenId,f.tokenId);
    const nextMinute=new Date('2026-10-22T14:01:00Z');
    for(let i=0;i<35;i++)assert.equal((await authenticateBearer(db,{authorization:good,now:nextMinute,ip})).tokenId,f.tokenId);
    assert.equal(selects,66,'successful authentication releases the unauthenticated admission slot');
  } finally {await f.close();}
});

test('concurrent invalid credentials reserve admission before any token lookup',async()=>{
  const f=await fixture();
  try {
    let selects=0,release;
    const gate=new Promise(resolve=>{release=resolve;});
    const db={query:async(sql,params)=>{
      if(sql.startsWith('SELECT * FROM api_token')){selects++;await gate;}
      return f.pool.query(sql,params);
    }};
    const now=new Date('2026-10-22T15:00:00Z'),authorization=`Bearer fbi_v1.${f.tokenId}.${'A'.repeat(43)}`;
    const requests=Promise.allSettled(Array.from({length:35},()=>authenticateBearer(db,{authorization,now,ip:'sample-concurrent-ip'})));
    const admitted=selects;release();
    const results=await requests;
    assert.equal(admitted,30,'only thirty lookups may enter before prior failures finish');
    assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===401).length,30);
    assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===429).length,5);
    await assert.rejects(authenticateBearer(db,{authorization,now,ip:'sample-concurrent-ip'}),{status:429});
    assert.equal(selects,30);
  } finally {await f.close();}
});
