import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,invoice,bill,receipt } from './integration-fixtures.js';
import { writeDocument } from '../lib/integration/documents.js';
import { writePayment } from '../lib/integration/payments.js';
import { voidVendorTxn } from '../lib/data/payables.js';
test('one cash row carries all applications and every refusal leaves books unchanged',async()=>{
  const f=await fixture();
  const doc=(kind,body)=>writeDocument(f.pool,{identity:f.identity,kind,body});
  const pay=(kind,body)=>writePayment(f.pool,{identity:f.identity,kind,body});
  try {
    const a=await doc('invoice',invoice('1')), b=await doc('invoice',invoice('2'));
    await f.pool.query("UPDATE txn SET source='qbo_import' WHERE txn_id=$1",[b.txn_id]);
    const body=receipt('one',[{source_ref:'invoice:1',amount_cents:4000},{doc_number:'INV-2',amount_cents:6000}]);
    const both=await Promise.all([pay('customer-payment',body),pay('customer-payment',body)]);
    assert.equal(both[0].txn_id,both[1].txn_id);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM application WHERE credit_txn_id=$1',[both[0].txn_id])).rows[0].n,2);
    assert.deepEqual((await f.pool.query('SELECT open_cents FROM txn WHERE txn_id=ANY($1) ORDER BY txn_id',[[a.txn_id,b.txn_id]])).rows.map(r=>r.open_cents),[6000,4000]);
    await f.pool.query(`INSERT INTO accounting_settings(org_id,entity_id,auto_apply_customer) VALUES($1,$2,true)
      ON CONFLICT(org_id,entity_id) DO UPDATE SET auto_apply_customer=true`,[f.S.orgId,f.S.entityId]);
    const onAccount=await pay('customer-payment',receipt('unapplied'));
    assert.equal(onAccount.open_cents,10000);
    const bad=[{...receipt('missing'),deposit_to_account_name:'Sample missing'},
      receipt('unknown',[{doc_number:'INV-missing',amount_cents:10000}]),
      receipt('too-much',[{source_ref:'invoice:1',amount_cents:10000}]),
      {...receipt('old'),txn_date:'2026-10-20'},
      receipt('early',[{source_ref:'invoice:1',amount_cents:1000,applied_on:'2026-10-20'}]),
      receipt('duplicate',[{source_ref:'invoice:1',amount_cents:1000},{source_ref:'invoice:1',amount_cents:1000}])];
    for(const p of bad){const count=await f.count('txn');await assert.rejects(pay('customer-payment',p));assert.equal(await f.count('txn'),count);}
    await doc('bill',bill());
    const bp={source_ref:'billpayment:1',vendor_name:'Sample vendor A',txn_date:'2026-10-22',amount_cents:10000,
      method:'Check',check_no:'1042',reference:'1042',bank_account_name:'Checking',applications:[{source_ref:'bill:1',amount_cents:10000}]};
    const paid=await pay('bill-payment',bp);
    const t=(await f.pool.query('SELECT doc_number,payment_ref,type FROM txn WHERE txn_id=$1',[paid.txn_id])).rows[0];
    assert.deepEqual(t,{doc_number:'1042',payment_ref:'1042',type:'bill_payment'});
    await assert.rejects(pay('bill-payment',{...bp,source_ref:'billpayment:bad',amount_cents:11000}),{status:422});
    await f.revoke(); await assert.rejects(pay('customer-payment',receipt('revoked')),{status:401});
  } finally {await f.close();}
});

test('customer and bill multi-application payments roll back all writes when reference insertion fails',async()=>{
  const f=await fixture();
  try {
    for(const kind of ['invoice','bill'])for(const n of ['1','2'])await writeDocument(f.pool,{identity:f.identity,kind,body:kind==='invoice'?invoice(n):bill(n)});
    const audit=async()=>(await f.pool.query('SELECT to_jsonb(x) row FROM activity_event x ORDER BY event_id')).rows;
    const before=await f.books(),events=await audit();
    await f.pool.query(`CREATE FUNCTION integration_fail_payment_ref() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sample payment insert failure'; END $$;
      CREATE TRIGGER integration_fail_payment_ref BEFORE INSERT ON external_ref FOR EACH ROW EXECUTE FUNCTION integration_fail_payment_ref()`);
    for(const [kind,p] of [
      ['customer-payment',receipt('rollback',[{source_ref:'invoice:1',amount_cents:4000},{source_ref:'invoice:2',amount_cents:6000}])],
      ['bill-payment',{source_ref:'billpayment:rollback',vendor_name:'Sample vendor A',txn_date:'2026-10-22',amount_cents:10000,method:'Other',reference:'Sample AP',bank_account_name:'Checking',applications:[{source_ref:'bill:1',amount_cents:4000},{source_ref:'bill:2',amount_cents:6000}]}],
    ]) {
      await assert.rejects(writePayment(f.pool,{identity:f.identity,kind,body:p}),/sample payment insert failure/);
      assert.deepEqual(await f.books(),before);assert.deepEqual(await audit(),events);
    }
    await f.pool.query('DROP TRIGGER integration_fail_payment_ref ON external_ref');
    const p={source_ref:'billpayment:ok',vendor_name:'Sample vendor A',txn_date:'2026-10-22',amount_cents:10000,method:'Check',check_no:'001042',reference:'001042',bank_account_name:'Checking',applications:[{source_ref:'bill:1',amount_cents:4000},{source_ref:'bill:2',amount_cents:6000}]};
    const r=await writePayment(f.pool,{identity:f.identity,kind:'bill-payment',body:p});
    assert.equal((await f.pool.query('SELECT doc_number FROM txn WHERE txn_id=$1',[r.txn_id])).rows[0].doc_number,'001042');
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM application WHERE credit_txn_id=$1',[r.txn_id])).rows[0].n,2);
    await voidVendorTxn(f.pool,{...f.S,txnId:Number(r.txn_id),actor:'tester'});
    assert.deepEqual((await f.pool.query("SELECT open_cents FROM txn WHERE type='bill' ORDER BY txn_id")).rows.map(x=>x.open_cents),[10000,10000]);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM application WHERE credit_txn_id=$1',[r.txn_id])).rows[0].n,0);
  } finally {await f.close();}
});
