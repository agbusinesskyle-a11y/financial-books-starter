import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,invoice,bill } from './integration-fixtures.js';
import { writeDocument } from '../lib/integration/documents.js';
import { mintToken } from '../lib/integration/tokens.js';
import { authenticateBearer } from '../lib/integration/auth.js';
import { importedFixture } from './integration-import-fixtures.js';
import { lockEntity, voidTxn } from '../lib/data/writes.js';
test('concurrent retries, imported adoption, conflicts and approval are atomic',async()=>{
  const f=await fixture();
  const put=(kind,body)=>writeDocument(f.pool,{identity:f.identity,kind,body});
  try {
    const results=await Promise.all([put('invoice',invoice()),put('invoice',invoice())]);
    assert.equal(new Set(results.map(r=>r.txn_id)).size,1);
    assert.deepEqual(results.map(r=>r.status).sort(),['created','existing']);
    const id=results[0].txn_id;
    await assert.rejects(put('invoice',{...invoice(),memo:'changed'}),{status:409,code:'reference_conflict'});
    await f.pool.query('DELETE FROM external_ref WHERE txn_id=$1',[id]);
    await f.pool.query("UPDATE txn SET source='qbo_import' WHERE txn_id=$1",[id]);
    const before=(await f.pool.query('SELECT * FROM txn WHERE txn_id=$1',[id])).rows[0];
    await f.pool.query("UPDATE integration_setting SET write_floor='2027-01-01' WHERE entity_id=$1",[f.S.entityId]);
    const adopted=await put('invoice',invoice());
    assert.equal(adopted.status,'adopted'); assert.equal(adopted.txn_id,id);
    assert.deepEqual((await f.pool.query('SELECT * FROM txn WHERE txn_id=$1',[id])).rows[0],before);
    await f.pool.query("UPDATE integration_setting SET write_floor='2026-10-21' WHERE entity_id=$1",[f.S.entityId]);
    await assert.rejects(put('invoice',{...invoice('2'),doc_number:'INV-1',total_cents:9000,
      lines:[{...invoice().lines[0],rate_cents:4500,amount_cents:9000}]}),{status:409,code:'document_conflict'});
    await assert.rejects(put('invoice',{...invoice('old'),txn_date:'2026-10-20'}),{status:409,code:'date_floor'});
    const b=await put('bill',bill());
    assert.equal((await f.pool.query('SELECT approval_status FROM txn WHERE txn_id=$1',[b.txn_id])).rows[0].approval_status,'approved');
    for(const [kind,body] of [['invoice',invoice('discount')],['bill',bill('discount')]]){
      const discounted=await put(kind,{...body,total_cents:9900,lines:[...body.lines,
        {item_name:'Sample item A',description:'Sample discount',quantity:'1',rate_cents:-100,amount_cents:-100}]});
      assert.equal((await f.pool.query('SELECT total_cents FROM txn WHERE txn_id=$1',[discounted.txn_id])).rows[0].total_cents,9900);
    }
    const limited=await mintToken(f.pool,{...f.S,name:'Sample limited',source:'sample_connector',scopes:['documents:write'],actor:'tester'});
    const noApprove=await authenticateBearer(f.pool,{authorization:`Bearer ${limited.token}`});
    const count=await f.count('txn');
    await assert.rejects(writeDocument(f.pool,{identity:noApprove,kind:'bill',body:bill('denied')}),{status:403});
    assert.equal(await f.count('txn'),count);
    await f.pool.query(`CREATE FUNCTION integration_fail_ref() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sample insert failure'; END $$;
      CREATE TRIGGER integration_fail_ref BEFORE INSERT ON external_ref FOR EACH ROW EXECUTE FUNCTION integration_fail_ref()`);
    await assert.rejects(put('invoice',invoice('rollback')),/sample insert failure/);
    assert.equal(await f.count('txn'),count);
  } finally {await f.close();}
});

test('genuine paid imports adopt fallback due dates; aging dates and accounting identity remain exact',async()=>{
  const f=await fixture();
  try {
    const i=await importedFixture(f),before=await i.snapshot();
    const put=(kind,body)=>writeDocument(f.pool,{identity:i.identity,kind,body});
    const header=(await f.pool.query("SELECT due_date,txn_date,open_cents FROM txn WHERE entity_id=$1 AND doc_number='INV-paid-1'",[i.entityId])).rows[0];
    assert.equal(header.due_date,header.txn_date);assert.equal(header.open_cents,0);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM txn_line l JOIN txn t ON t.txn_id=l.txn_id WHERE t.entity_id=$1 AND l.item_id IS NOT NULL',[i.entityId])).rows[0].n,0);
    for(const [kind,n] of [['invoice','paid-1'],['invoice','paid-2'],['bill','paid'],['invoice','open']]) {
      const p=i.doc(kind,n);
      for(const b of [
        {...p,[kind==='bill'?'vendor_name':'customer_name']:kind==='bill'?'Sample vendor B':'Sample customer B'},
        {...p,total_cents:9000,lines:[{...p.lines[0],rate_cents:4500,amount_cents:9000}]},
      ])await assert.rejects(put(kind,b),{status:409,code:'document_conflict'});
      if(n==='open')await assert.rejects(put(kind,{...p,due_date:'2026-11-24'}),{status:409,code:'document_conflict'});
      const col=kind==='invoice'?'income_account_id':'expense_account_id',wrong=kind==='invoice'?'other_income':'other_expense';
      const acct=(await f.pool.query('INSERT INTO account(org_id,entity_id,name,type) VALUES($1,$2,$3,$4) RETURNING account_id',[i.orgId,i.entityId,`Sample alternate ${kind} ${n}`,wrong])).rows[0].account_id;
      const original=(await f.pool.query(`SELECT ${col} id FROM item WHERE entity_id=$1 AND name='Sample item A'`,[i.entityId])).rows[0].id;
      await f.pool.query(`UPDATE item SET ${col}=$2 WHERE entity_id=$1`,[i.entityId,acct]);
      await assert.rejects(put(kind,p),{status:409,code:'document_conflict'});
      await f.pool.query(`UPDATE item SET ${col}=$2 WHERE entity_id=$1`,[i.entityId,original]);
      assert.equal((await put(kind,p)).status,'adopted');
    }
    assert.deepEqual(await i.snapshot(),before,'all imported headers, lines, postings, applications and provenance are untouched');
  } finally {await f.close();}
});

test('adopt-only is a transactional precondition even when the server floor is lower or changes',async()=>{
  const f=await fixture();
  try {
    await f.pool.query("UPDATE integration_setting SET write_floor='2026-01-01' WHERE entity_id=$1",[f.S.entityId]);
    for(const [kind,p] of [['invoice',invoice()],['bill',bill()]]) {
      const blocker=await f.pool.connect(),before=await f.books();
      try {
        await blocker.query('BEGIN');await lockEntity(blocker,f.S.orgId,f.S.entityId);
        const pending=assert.rejects(writeDocument(f.pool,{identity:f.identity,kind,body:{...p,adopt_only:true}}),{status:409,code:'adoption_required'});
        await blocker.query("UPDATE integration_setting SET write_floor='2025-01-01' WHERE entity_id=$1",[f.S.entityId]);
        await blocker.query('COMMIT');await pending;
      } finally {await blocker.query('ROLLBACK');blocker.release();}
      assert.deepEqual(await f.books(),before);
    }
    const i=await importedFixture(f);
    await f.pool.query("UPDATE integration_setting SET write_floor='2025-01-01' WHERE entity_id=$1",[i.entityId]);
    assert.equal((await writeDocument(f.pool,{identity:i.identity,kind:'invoice',body:i.doc('invoice','paid-1')})).status,'adopted');
  } finally {await f.close();}
});

test('ambiguous imported bills and voided native candidates refuse; signed postings retain both gross directions',async()=>{
  const f=await fixture();
  try {
    const i=await importedFixture(f,{ambiguous:true});
    await assert.rejects(writeDocument(f.pool,{identity:i.identity,kind:'bill',body:i.doc('bill','paid')}),{status:409,code:'document_conflict'});
    for(const [kind,p] of [['invoice',invoice('signed')],['bill',bill('signed')]]) {
      const r=await writeDocument(f.pool,{identity:f.identity,kind,body:{...p,total_cents:9900,lines:[...p.lines,{item_name:'Sample item A',description:'Sample discount',quantity:'1',rate_cents:-100,amount_cents:-100}]}});
      const amounts=(await f.pool.query('SELECT amount_cents FROM posting WHERE txn_id=$1 AND account_id=$2 ORDER BY amount_cents',[r.txn_id,kind==='invoice'?f.ids.income:f.ids.expense])).rows.map(x=>x.amount_cents);
      assert.deepEqual(amounts,kind==='invoice'?[-10000,100]:[-100,10000]);
      if(kind==='invoice') {
        await f.pool.query('DELETE FROM external_ref WHERE txn_id=$1',[r.txn_id]);
        await voidTxn(f.pool,{...f.S,txnId:Number(r.txn_id),actor:'tester'});
        await assert.rejects(writeDocument(f.pool,{identity:f.identity,kind,body:p}),{status:409,code:'document_conflict'});
      }
    }
  } finally {await f.close();}
});
