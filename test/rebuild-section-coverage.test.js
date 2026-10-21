import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, q, saved } from './rebuild-fixture.js';
import { validateCarryStructure, validateCarryCounts } from '../lib/rebuild/carry-validation.js';

test('S4 every saved section is required and counts track current source rows',async t=>{
  const db=await makeDb({imported:true});
  await q(db,"INSERT INTO item(org_id,entity_id,name,kind,rate_cents,reorder_point) VALUES(1,1,'Sample saved stock','inventory',1234,25)");
  await q(db,"UPDATE vendor SET tax_id_enc='v1:aaa:bbb:ccc',track_1099=true");
  const data=await saved(db);
  await validateCarryCounts(db.pool,data);
  for(const key of ['company','items','classes','locations','vendorExtras','customerExtras','terms','reconciliations','holds','researchAttempts','nativeTransactions','nativeApplications','loans','accountChanges']) await t.test(key,async()=>{
    const missing=structuredClone(data); delete missing.companies[0][key];
    assert.throws(()=>validateCarryStructure(missing),new RegExp(key));
    const changed=structuredClone(data);
    if(key==='company') changed.companies[0].company=null;
    else if(changed.companies[0][key].length) changed.companies[0][key]=[];
    else changed.companies[0][key].push({});
    await assert.rejects(validateCarryCounts(db.pool,changed),new RegExp(key));
  });
  for(const key of Object.keys(data.companies[0].settings)) await t.test('settings.'+key,async()=>{
    const changed=structuredClone(data); changed.companies[0].settings[key]=changed.companies[0].settings[key] ? null : {};
    await assert.rejects(validateCarryCounts(db.pool,changed),new RegExp('settings.'+key));
  });
  for(const key of ['sms','morning','formPrefs']) await t.test('org.'+key,()=>{
    const missing=structuredClone(data);delete missing.org[key];
    assert.throws(()=>validateCarryStructure(missing),new RegExp(key));
  });
  const fields=structuredClone(data);delete fields.companies[0].vendorExtras[0].taxIdEnc;
  assert.throws(()=>validateCarryStructure(fields),/vendorExtras/);
  await q(db,"INSERT INTO location(org_id,entity_id,name) VALUES(1,1,'Sample new location')");
  await assert.rejects(validateCarryCounts(db.pool,data),/locations/);
});

test('org sections and nested reconciliation coverage cannot silently lose rows',async()=>{
  const db=await makeDb({imported:true});
  const data=await saved(db);
  for(const key of ['viewers','preferences']) {
    const changed=structuredClone(data);changed.org.morning[key].push({});
    await assert.rejects(validateCarryCounts(db.pool,changed),new RegExp(key));
  }
  const changed=structuredClone(data); changed.org.formPrefs.push({});
  await assert.rejects(validateCarryCounts(db.pool,changed),/formPrefs/);
  await q(db,"INSERT INTO reconciliation(org_id,entity_id,account_id,statement_date,beginning_cents,ending_cents,completed_by) SELECT 1,1,account_id,'2026-10-20',0,0,'tester' FROM account LIMIT 1");
  await assert.rejects(validateCarryCounts(db.pool,data),/reconciliations/);
});
