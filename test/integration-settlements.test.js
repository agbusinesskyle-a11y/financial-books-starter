import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,invoice,receipt } from './integration-fixtures.js';
import { writeDocument } from '../lib/integration/documents.js';
import { writePayment } from '../lib/integration/payments.js';
import { readSettlements,readDocumentSettlement } from '../lib/integration/settlements.js';
import { voidTxn } from '../lib/data/writes.js';
import { importedFixture } from './integration-import-fixtures.js';
import { authenticateBearer } from '../lib/integration/auth.js';
test('snapshots retain partial applications, expose removal and isolate sources',async()=>{
  const f=await fixture();
  try {
    await writeDocument(f.pool,{identity:f.identity,kind:'invoice',body:invoice()});
    const p=await writePayment(f.pool,{identity:f.identity,kind:'customer-payment',body:{...receipt('1',[{source_ref:'invoice:1',amount_cents:4000}]),amount_cents:4000}});
    const read=()=>readDocumentSettlement(f.pool,{identity:f.identity,sourceRef:'invoice:1'});
    const s=await read();
    assert.equal(s.complete,true);assert.equal(s.open_cents,6000);assert.equal(s.applications.length,1);
    assert.match(s.applications[0].application_id,/^[0-9a-f-]{36}:\d+$/);
    assert.equal(s.applications[0].amount_cents,4000);assert.equal(s.applications[0].type,'payment');
    await voidTxn(f.pool,{...f.S,txnId:Number(p.txn_id),actor:'tester'});
    const gone=await read();assert.equal(gone.open_cents,10000);assert.deepEqual(gone.applications,[]);
    await assert.rejects(readDocumentSettlement(f.pool,{identity:{...f.identity,source:'other_connector'},sourceRef:'invoice:1'}),{status:404});
    const page=await readSettlements(f.pool,{identity:f.identity,limit:1});
    assert.equal(page.documents.length,1);assert.equal(page.documents[0].source_ref,'invoice:1');
    await assert.rejects(readSettlements(f.pool,{identity:f.identity,afterRefId:'-1'}),{status:422});
    await assert.rejects(readSettlements(f.pool,{identity:f.identity,limit:101}),{status:422});
  } finally {await f.close();}
});

test('import reconstruction is marked nonauthoritative and later native applications are distinct',async()=>{
  const f=await fixture();
  try {
    const i=await importedFixture(f);
    for(const n of ['paid-1','paid-2','open'])await writeDocument(f.pool,{identity:i.identity,kind:'invoice',body:i.doc('invoice',n)});
    const before=await i.snapshot();
    const page=await readSettlements(f.pool,{identity:i.identity});
    const cash=Object.fromEntries(page.documents.filter(d=>d.source_ref!=='invoice:open').map(d=>[d.source_ref,d.applications.filter(a=>a.type==='payment').reduce((n,a)=>n+a.amount_cents,0)]));
    // The source remittance evidence assigns cash to paid-2; oldest-first reconstruction assigns it to paid-1.
    assert.notDeepEqual(cash,{'invoice:paid-1':0,'invoice:paid-2':10000});
    for(const d of page.documents.filter(d=>d.applications.length))for(const a of d.applications) {
      assert.equal(a.source,'qbo_import');assert.equal(a.allocation_evidence,'reconstructed');assert.equal(a.cash_history_authoritative,false);
    }
    assert.ok(page.documents.some(d=>d.applications.some(a=>a.type==='credit_memo')));
    assert.deepEqual(await i.snapshot(),before,'read never corrects reconstructed allocations');
    const p={...receipt('native',[{source_ref:'invoice:open',amount_cents:4000}]),txn_date:'2027-01-02',amount_cents:4000};
    const one=await writePayment(f.pool,{identity:i.identity,kind:'customer-payment',body:p});
    assert.equal((await writePayment(f.pool,{identity:i.identity,kind:'customer-payment',body:p})).txn_id,one.txn_id);
    const open=await readDocumentSettlement(f.pool,{identity:i.identity,sourceRef:'invoice:open'});
    assert.equal(open.applications.length,1);assert.equal(open.applications[0].allocation_evidence,'native');assert.equal(open.applications[0].cash_history_authoritative,true);
    assert.equal(open.open_cents,6000);
  } finally {await f.close();}
});

test('a complete 1000-document sweep including paid documents fits one rate window without financial writes',async()=>{
  const f=await fixture();
  try {
    await f.pool.query(`WITH docs AS (
      INSERT INTO txn(org_id,entity_id,customer_id,type,doc_number,txn_date,due_date,total_cents,open_cents)
      SELECT $1,$2,$3,'invoice','INV-page-'||g,'2026-10-21','2026-10-28',100,CASE WHEN g%2=0 THEN 0 ELSE 100 END
      FROM generate_series(1,1000) g RETURNING txn_id,doc_number)
      INSERT INTO external_ref(org_id,entity_id,source,source_ref,txn_id,request_hash)
      SELECT $1,$2,'sample_connector',doc_number,txn_id,repeat('a',64) FROM docs`,[f.S.orgId,f.S.entityId,f.ids.customerId]);
    const before=await f.books(),seen=new Set(),now=new Date('2026-10-22T12:00:00Z');
    let cursor='0',calls=0,paid=0,complete=false;
    do {
      const identity=await authenticateBearer(f.pool,{authorization:`Bearer ${f.token}`,scope:'settlements:read',now});
      const page=await readSettlements(f.pool,{identity,afterRefId:cursor});calls++;
      for(const d of page.documents){assert.ok(!seen.has(d.source_ref));seen.add(d.source_ref);if(d.open_cents===0)paid++;assert.equal(d.complete,true);}
      complete=page.complete;cursor=page.next_after_ref_id;
    } while(!complete);
    assert.equal(seen.size,1000);assert.equal(paid,500);assert.equal(calls,10);assert.equal(cursor,null);
    assert.ok(calls<120);assert.deepEqual(await f.books(),before);
    assert.equal((await f.pool.query('SELECT rate_count FROM api_token WHERE token_id=$1',[f.tokenId])).rows[0].rate_count,10);
  } finally {await f.close();}
});
