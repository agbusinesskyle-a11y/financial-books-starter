import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,invoice,bill } from './integration-fixtures.js';
test('API is bearer-only JSON in practice, bounded, and audited',async()=>{
  const f=await fixture({env:{BOOKS_MODE:'practice'}});
  try {
    assert.equal((await f.api('/companies')).body.companies.length,1);
    const made=await f.api('/invoices',invoice());assert.equal(made.status,201);
    const audit=await f.pool.query("SELECT actor FROM audit_log WHERE table_name='txn' ORDER BY audit_id DESC LIMIT 1");
    assert.equal(audit.rows[0].actor,f.identity.actor);
    assert.equal((await f.api('/invoices',invoice())).status,200);
    assert.equal((await f.api('/invoices',invoice('form'),{'content-type':'application/x-www-form-urlencoded'})).status,415);
    const cookieOnly=await f.get('/api/integration/v1/companies');assert.equal(cookieOnly.status,401);
    assert.match(cookieOnly.headers.get('content-type'),/application\/json/);
    assert.equal(cookieOnly.headers.get('location'),null);
    for(const [body,status] of [['{',400],['x'.repeat(131073),413]]){
      const r=await fetch(f.base+'/api/integration/v1/invoices',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body});
      assert.equal(r.status,status);assert.ok((await r.json()).error.code);
    }
    const wrong=await fetch(f.base+'/api/integration/v1/invoices',{method:'DELETE',headers:{authorization:`Bearer ${f.token}`}});
    assert.equal(wrong.status,405);
    assert.equal((await f.api('/missing')).status,404);
    await f.pool.query('UPDATE integration_setting SET accept_writes=false WHERE entity_id=$1',[f.S.entityId]);
    assert.equal((await f.api('/invoices',invoice('off'))).status,403);
    assert.equal((await f.api('/settlements')).status,200);
  } finally {await f.close();}
});

test('bearer credentials cannot bypass browser CSRF or encoded/lookalike prefix handling',async()=>{
  const f=await fixture();
  try {
    const r=await f.raw('/customers',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/x-www-form-urlencoded'},body:'display_name=Sample'});
    assert.equal(r.status,403);
    for(const path of ['/api/integration/v10/companies','/api/integration%2fv1/companies','/api/integration/v1x/companies']) {
      const res=await fetch(f.base+path,{headers:{authorization:`Bearer ${f.token}`},redirect:'manual'});
      assert.equal(res.status,303);assert.match(res.headers.get('location'),/^\/login/);
    }
    assert.equal((await f.api('/%69nvoices',invoice())).status,404);
    const p={...invoice(),source_ref:'sample:invoice/1'};
    assert.equal((await f.api('/invoices',p)).status,201);
    assert.equal((await f.api('/documents/'+encodeURIComponent(p.source_ref)+'/settlement')).status,200);
    assert.equal((await f.api('/documents/'+encodeURIComponent(encodeURIComponent(p.source_ref))+'/settlement')).status,404);
    assert.equal((await f.api('/documents/%zz/settlement')).status,400);
    const invalidUtf8=await fetch(f.base+'/api/integration/v1/invoices',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'},body:Buffer.from([0xc3,0x28])});
    assert.equal(invalidUtf8.status,400);
    await f.pool.query("UPDATE integration_setting SET write_floor='2025-01-01' WHERE entity_id=$1",[f.S.entityId]);
    const before=await f.books();
    for(const [path,body] of [['/invoices',invoice('old')],['/bills',bill('old')]])assert.equal((await f.api(path,{...body,adopt_only:true})).status,409);
    assert.deepEqual(await f.books(),before);
    const noToken=await fetch(f.base+'/api/integration/v1/companies?token='+encodeURIComponent(f.token),{redirect:'manual'});
    assert.equal(noToken.status,401);assert.equal(noToken.headers.get('set-cookie'),null);
  } finally {await f.close();}
});
