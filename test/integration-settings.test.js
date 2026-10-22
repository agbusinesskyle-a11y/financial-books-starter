import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './integration-fixtures.js';
import { canAccess } from '../lib/domain/roles.js';
import { mvUser,signInAs } from './morning-fixtures.js';
test('Settings is admin-only, CSRF-protected, and reveals a token once',async()=>{
  const f=await fixture();
  try{
    for(const role of ['standard','customers','vendors','reports']){
      assert.equal(canAccess(role,'GET','/settings/integrations'),false);
      assert.equal(canAccess(role,'POST','/settings/integrations/tokens'),false);
    }
    assert.equal((await f.post('/settings/integrations/tokens',{csrf:null,name:'Sample new',source:'sample_new',scope:'settlements:read'})).status,403);
    const r=await f.post('/settings/integrations/tokens',{name:'Sample new',source:'sample_new',scope:'settlements:read'});
    assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);
    const token=(await r.text()).match(/fbi_v1\.\d+\.[A-Za-z0-9_-]+/)[0];
    assert.ok(!(await (await f.get('/settings/integrations')).text()).includes(token));
    assert.equal((await f.post('/settings/integrations/policy',{accept_writes:'1',write_floor:'',ledger_instance:'sample-practice'})).status,422);
    const other=await f.post(`/settings/integrations/tokens/999999/revoke`);assert.equal(other.status,404);
  }finally{await f.close();}
});

test('real non-admin sessions refuse token controls and restricted admins cannot select another company',async()=>{
  const f=await fixture({env:{SETTINGS_KEY:'ab'.repeat(32)}});
  try {
    for(const role of ['standard','customers','vendors','reports']) {
      const email=`${role}@sample.example`,u=await mvUser(f.pool,{orgId:f.S.orgId,email,role});
      const s=await signInAs(f,{email,...u});
      assert.equal((await s.get('/settings/integrations')).status,403);
      assert.equal((await s.post('/settings/integrations/tokens',{name:'Sample denied',source:'sample_denied',scope:'settlements:read'})).status,403);
    }
    const email='restricted@sample.example',u=await mvUser(f.pool,{orgId:f.S.orgId,email,role:'admin',allCompanies:false});
    await f.pool.query('INSERT INTO app_user_company(user_id,org_id,entity_id) VALUES($1,$2,$3)',[u.userId,f.S.orgId,f.ids.entityB]);
    const s=await signInAs(f,{email,...u}),before=await f.count('api_token');
    const page=await s.get('/settings/integrations');assert.equal(page.status,200);assert.ok(!(await page.text()).includes('Sample connector'));
    assert.equal((await s.post('/settings/integrations/tokens',{entity_id:f.S.entityId,name:'Sample denied',source:'sample_denied',scope:'settlements:read'})).status,422);
    assert.equal((await s.post(`/settings/integrations/tokens/${f.tokenId}/revoke`)).status,404);
    assert.equal(await f.count('api_token'),before);
    assert.equal((await s.post('/settings/integrations/tokens',{name:'Sample scoped',source:'sample_scoped',scope:'settlements:read'})).status,200);
    assert.equal((await f.pool.query("SELECT entity_id FROM api_token WHERE source='sample_scoped'")).rows[0].entity_id,f.ids.entityB);
    assert.equal((await f.post('/settings/integrations/tokens',{name:'Sample <script>bad</script>',source:'sample_escape',scope:'settlements:read'})).status,200);
    const escaped=await (await f.get('/settings/integrations')).text();assert.ok(!escaped.includes('<script>bad</script>'));assert.ok(escaped.includes('&lt;script&gt;'));
    assert.equal((await f.post(`/settings/integrations/tokens/${f.tokenId}/revoke`)).status,303);
    const audit=(await f.pool.query("SELECT row_id,after FROM audit_log WHERE table_name='api_token' AND action='update' ORDER BY audit_id DESC LIMIT 1")).rows[0];
    assert.equal(audit.row_id,f.tokenId);assert.ok(!JSON.stringify(audit).includes(f.token));assert.equal(audit.after.token_hash,undefined);
    assert.equal((await f.api('/companies')).status,401);
  } finally {await f.close();}
});
