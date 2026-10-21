import { validateCarryCounts } from '../lib/rebuild/carry-validation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb,q,saved,apply,invoke } from './rebuild-fixture.js';
import { applyCredit } from '../lib/data/writes.js';
import { OPEN } from './qbo-fixture.js';

test('S5 native applications on imported documents must be preserved or surfaced',async()=>{
  const openItems=[...OPEN.map(o=>({...o})),
    {side:'ar',type:'Invoice',date:'2024-02-01',num:'1001',name:'Flight School',open:10000},
    {side:'ar',type:'Payment',date:'2024-02-10',num:null,name:'Flight School',open:-10000}];
  const src=await makeDb({imported:true,openItems}),dst=await makeDb({imported:true,openItems});
  const credit=(await q(src,"SELECT * FROM txn WHERE type='payment' AND open_cents=10000"))[0];
  const charge=(await q(src,"SELECT * FROM txn WHERE doc_number='1003'"))[0];
  assert.ok(credit && charge);
  await applyCredit(src.pool,{orgId:1,entityId:1,creditTxnId:credit.txn_id,applications:[{chargeTxnId:charge.txn_id,amountCents:10000}],appliedOn:'2026-10-20',actor:'review-test'});
  assert.equal((await q(src,'SELECT count(*) n FROM application WHERE source IS NULL'))[0].n,1);
  assert.equal((await q(src,'SELECT count(*) n FROM txn WHERE source IS NULL'))[0].n,0);
  const data=await saved(src),report=await apply(dst,data);
  const missing=structuredClone(data); missing.companies[0].nativeApplications=[];
  await assert.rejects(validateCarryCounts(src.pool,missing),/nativeApplications/);
  const stateSql="SELECT type,doc_number,open_cents FROM txn WHERE doc_number='1003' OR (type='payment' AND txn_date='2024-02-10') ORDER BY type";
  const original=await q(src,stateSql),restored=await q(dst,stateSql);
  const checks=await invoke('rebuild-check',[dst.file,'2026-10-20']);
  assert.equal(checks.code,0,checks.stderr);

  assert.equal(data.companies[0].nativeApplications.length,1);
  const application=data.companies[0].nativeApplications[0];
  assert.equal(application.amountCents,10000);
  assert.equal(application.appliedOn,'2026-10-20');
  assert.equal(application.charge.docNumber,charge.doc_number);
  for(const preview of [report,await apply(dst,data,'books',true)]) {
    const decision=preview.decisions.find(d=>d.what==='native application');
    assert.ok(decision);
    assert.deepEqual(decision.openAmountEffect,{creditOpenCentsDelta:-10000,chargeOpenCentsDelta:-10000});
  }
  assert.ok(report.decisions.length || report.leftovers.some(x=>x.table==='application') || JSON.stringify(original)===JSON.stringify(restored),'native settlement vanished with no decision/leftover');
});
