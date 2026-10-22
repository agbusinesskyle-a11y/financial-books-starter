import { isDeepStrictEqual } from 'node:util';
import { withTransaction } from '../db.js';
import { lockEntity,savePaymentTx,ValidationError } from '../data/writes.js';
import { payBillsTx } from '../data/payables.js';
import { validatePayment } from './input.js';
import { resolvePaymentNamesTx } from './names.js';
import { assertWritePolicyTx,refuse } from './policy.js';
import { canonicalHash,insertReferenceTx,success } from './identity.js';

export async function writePayment(pool,{identity,kind,body}) {
  try {
    return await withTransaction(pool,async tx=>{
      await lockEntity(tx,identity.orgId,identity.entityId);
      const setting=await assertWritePolicyTx(tx,identity,{adoptOnly:true,requiredScope:'payments:write'});
      const p=validatePayment(kind,body),hash=canonicalHash(kind,p),customer=kind==='customer-payment';
      const ref=(await tx.query('SELECT * FROM external_ref WHERE org_id=$1 AND entity_id=$2 AND source=$3 AND source_ref=$4',
        [identity.orgId,identity.entityId,identity.source,p.source_ref])).rows[0];
      if(ref&&ref.request_hash!==hash)refuse(409,'reference_conflict','Reference was already used with different content.');
      const names=await resolvePaymentNamesTx(tx,identity,kind,p,{checkOpen:!ref});
      if(ref) {
        const t=(await tx.query('SELECT * FROM txn WHERE org_id=$1 AND entity_id=$2 AND txn_id=$3',[identity.orgId,identity.entityId,ref.txn_id])).rows[0];
        const apps=(await tx.query('SELECT charge_txn_id,amount_cents,applied_on FROM application WHERE credit_txn_id=$1 ORDER BY charge_txn_id,applied_on',[t.txn_id])).rows;
        const expected=names.applications.map(a=>({charge_txn_id:a.chargeTxnId,amount_cents:a.amountCents,applied_on:a.appliedOn})).sort((a,b)=>a.charge_txn_id-b.charge_txn_id);
        if(t.voided_at||t.type!==(customer?'payment':'bill_payment')||t[customer?'customer_id':'vendor_id']!==names.partyId||t.currency||
          t.txn_date!==p.txn_date||t.total_cents!==p.amount_cents||t.account_id!==names.accountId||t.payment_method!==p.method||
          (t.payment_ref??'')!==p.reference||(!customer&&p.method==='Check'&&t.doc_number!==p.check_no)||!isDeepStrictEqual(apps,expected))
          refuse(409,'payment_conflict','Linked payment has changed.');
        return success('existing',p,t,setting);
      }
      if(p.txn_date<setting.write_floor||names.applications.some(a=>a.appliedOn<setting.write_floor))refuse(409,'date_floor','New payment precedes the integration date floor.');
      const args={orgId:identity.orgId,entityId:identity.entityId,actor:setting.actor,txnDate:p.txn_date,memo:p.memo??'',paymentRef:p.reference};
      let txnId;
      if(customer)txnId=await savePaymentTx(tx,{...args,customerId:names.partyId,amountCents:p.amount_cents,paymentMethod:p.method,
        depositToId:names.accountId,applications:names.applications,autoApply:false});
      else {
        const ids=await payBillsTx(tx,{...args,accountId:names.accountId,method:p.method,checkNo:p.check_no??'',
          payments:names.applications.map(a=>({billId:a.chargeTxnId,amountCents:a.amountCents,creditCents:0}))});
        if(ids.length!==1)refuse(422,'invalid_remittance','Remittance must produce exactly one payment.');
        [txnId]=ids;
      }
      await insertReferenceTx(tx,identity,p,txnId,hash);
      const t=(await tx.query('SELECT * FROM txn WHERE txn_id=$1',[txnId])).rows[0];
      return success('created',p,t,setting);
    });
  } catch(error) {
    if(error instanceof ValidationError)refuse(422,'invalid_accounting',error.message);
    throw error;
  }
}
