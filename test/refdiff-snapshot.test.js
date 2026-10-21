import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reference, baseTxns, conformanceTxns, databaseContent } from './refdiff-fixture.js';
import { readReference } from '../lib/refdiff/snapshot.js';
test('snapshot uses names, recovers duplicate numbers and changes no tables', async t=>{
  const db=await reference(t), before=await databaseContent(db), s=await readReference(db.urlFile);
  assert.equal(s.orgSlug,'sample'); const c=s.companies[0];
  assert.equal(c.company,'Sample company A'); assert.equal(c.transactions.length,10);
  assert.deepEqual(c.transactions.filter(r=>r.number==='D-1').map(r=>r.repeat),[1,2]);
  assert.ok(c.accounts.some(a=>a.name==='Engine'&&a.parent==='Planes:Cub'));
  assert.deepEqual(await databaseContent(db),before);
});
test('zero-amount omitted rows remain observable possible voids', async t=>{
  const txns=baseTxns(); txns[2][4]='Voided'; txns[2][5]=[['Operating',0,0],['Repairs',0,0]];
  const db=await reference(t,{txns}), c=(await readReference(db.urlFile)).companies[0];
  const v=c.transactions.find(r=>r.number==='103');
  assert.equal(v.voidStatus,'possible_void'); assert.equal(v.explicitVoidMemo,true);
  assert.deepEqual(v.postings,[]); assert.equal(c.transactions.length,10);
});
test('missing import batch evidence refuses', async t=>{
  const db=await reference(t); await db.pool.query('DELETE FROM import_batch');
  await assert.rejects(readReference(db.urlFile),/import_batch/);
});
test('COGS, unlisted parties, deep used accounts and number collisions have stable snapshots',async t=>{
  const a=await reference(t,{txns:conformanceTxns(),addLists:true,companies:['Sample company A','Sample company B']});
  const b=await reference(t,{txns:conformanceTxns().reverse(),addLists:true,reverseContacts:true,reverseChart:true,companies:['Sample company B','Sample company A']});
  const x=await readReference(a.urlFile), y=await readReference(b.urlFile);
  assert.equal(x.contentHash,y.contentHash); assert.deepEqual(x.companies,y.companies);
  const c=x.companies[0]; assert.equal(c.transactions.length,15);
  assert.equal(c.transactions.find(r=>r.number==='M-2').postings.length,4);
  assert.ok(c.transactions.find(r=>r.number==='Deep-1').postings.some(p=>p.account==='Planes:Cub:Engine'));
  assert.equal(c.transactions.filter(r=>r.number==='1234567890123456789012345678901234567890').length,2);
});
test('legacy references with unprovable party and number evidence refuse explicitly',async t=>{
  const db=await reference(t);
  await db.pool.query("UPDATE import_batch SET summary=summary-'referenceIdentity'");
  await assert.rejects(readReference(db.urlFile),/insufficient.*party.*number.*fresh import/i);
});
test('omission count corruption refuses and zero alone is only a possible void',async t=>{
  const txns=baseTxns(); txns[2][5]=[['Operating',0,0],['Repairs',0,0]];
  const db=await reference(t,{txns}), c=(await readReference(db.urlFile)).companies[0];
  const v=c.transactions.find(r=>r.number==='103'); assert.equal(v.voidStatus,'possible_void'); assert.ok(!v.explicitVoidMemo);
  await db.pool.query("UPDATE import_batch SET summary=jsonb_set(summary,'{omitted}','0')");
  await assert.rejects(readReference(db.urlFile),/omission evidence/);
});
test('malformed and cross-company COGS companions refuse',async t=>{
  const db=await reference(t,{txns:conformanceTxns(),companies:['Sample company A','Sample company B']});
  const change=async sql=> { const c=await db.pool.connect(); try { await c.query('BEGIN'); await c.query("SET LOCAL fb.import='on'"); await c.query(sql); await c.query('COMMIT'); } finally {c.release();} };
  await change("UPDATE txn SET companion_of_txn_id=(SELECT min(txn_id) FROM txn WHERE type='check') WHERE companion_of_txn_id IS NOT NULL");
  await assert.rejects(readReference(db.urlFile),/companion/);
  await change("UPDATE txn SET companion_of_txn_id=(SELECT min(txn_id) FROM txn WHERE type='sales_receipt') WHERE companion_of_txn_id IS NOT NULL");
  await assert.rejects(readReference(db.urlFile),/companion/);
});
test('deleted system spelling alongside an added system account keeps both accounts distinct',async t=>{
  const db=await reference(t,{aliases:{'Undeposited Funds':'Undeposited Funds (deleted)'}});
  const before=await databaseContent(db),c=(await readReference(db.urlFile)).companies[0];
  const twins=c.accounts.filter(a=>a.name==='Undeposited Funds');
  assert.equal(twins.length,2);assert.equal(new Set(twins.map(a=>a.path)).size,2);
  assert.deepEqual(twins.map(a=>a.active).sort(),[false,true]);
  assert.deepEqual(await databaseContent(db),before);
});
test('empty companies with consistent batches are permitted',async t=>{
  const db=await reference(t,{txns:[],open:[]});
  assert.equal((await readReference(db.urlFile)).companies[0].transactions.length,0);
});
test('a journal with multiple line parties never guesses a single party',async t=>{
  const txns=[...baseTxns(),['06/09/2026','Journal Entry','Multi-1',null,null,
    [['Fuel',4,0,'Sample vendor A'],['Operating',0,4,'Sample second vendor']]]];
  const db=await reference(t,{txns}), c=(await readReference(db.urlFile)).companies[0];
  assert.deepEqual(c.transactions.find(r=>r.number==='Multi-1').party,
    [{kind:'vendor',name:'Sample second vendor'},{kind:'vendor',name:'Sample vendor A'}]);
});
test('open items use the same lossless original long number policy',async t=>{
  const txns=baseTxns(), number='1234567890123456789012345678901234567890';
  txns[3][2]=number; txns[4][2]=number; txns[4][4]='Sample ordinary memo '.repeat(100);
  const open=[{side:'ar',type:'Invoice',date:'2026-04-02',num:number,name:'Sample customer A',due:'2026-05-02',open:10000},
    {side:'ap',type:'Bill',date:'2026-04-04',num:'B-1',name:'Sample vendor A',due:'2026-05-04',open:3000}];
  const a=await reference(t,{txns,open}),b=await reference(t,{txns:[...txns].reverse(),open});
  const x=await readReference(a.urlFile),y=await readReference(b.urlFile);
  assert.equal(x.contentHash,y.contentHash); assert.equal(x.companies[0].openItems.find(r=>r.side==='ar').number,number);
});
