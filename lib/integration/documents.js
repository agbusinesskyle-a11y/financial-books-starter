import { withTransaction } from '../db.js';
import { lockEntity,writeSalesDoc,ValidationError } from '../data/writes.js';
import { writeVendorDoc,approveBillsTx } from '../data/payables.js';
import { getSalesSettings } from '../data/sales-settings.js';
import { validateDocument } from './input.js';
import { resolveDocumentNamesTx } from './names.js';
import { assertWritePolicyTx,refuse } from './policy.js';
import { canonicalHash,adoptDocumentTx,insertReferenceTx,success } from './identity.js';

export async function writeDocument(pool,{identity,kind,body}) {
  try {
    return await withTransaction(pool,async tx=>{
      await lockEntity(tx,identity.orgId,identity.entityId);
      const requiredScope=['documents:write',...(kind==='bill'&&body?.approve===true?['bills:approve']:[])];
      const setting=await assertWritePolicyTx(tx,identity,{adoptOnly:true,requiredScope});
      const p=validateDocument(kind,body),hash=canonicalHash(kind,p);
      const ref=(await tx.query(`SELECT * FROM external_ref WHERE org_id=$1 AND entity_id=$2 AND source=$3 AND source_ref=$4`,
        [identity.orgId,identity.entityId,identity.source,p.source_ref])).rows[0];
      if(ref&&ref.request_hash!==hash)refuse(409,'reference_conflict','Reference was already used with different content.');
      const names=await resolveDocumentNamesTx(tx,identity,kind,p);
      if(ref) {
        const target=(await tx.query('SELECT * FROM txn WHERE org_id=$1 AND entity_id=$2 AND txn_id=$3',[identity.orgId,identity.entityId,ref.txn_id])).rows[0];
        await adoptDocumentTx(tx,identity,kind,p,names,target);
        return success('existing',p,target,setting);
      }
      const all=(await tx.query('SELECT * FROM txn WHERE org_id=$1 AND entity_id=$2 AND type=$3 AND doc_number=$4',[identity.orgId,identity.entityId,kind,p.doc_number])).rows;
      const candidates=all.filter(t=>t[kind==='invoice'?'customer_id':'vendor_id']===names.partyId);
      if(all.length) {
        if(candidates.length!==1)refuse(409,'document_conflict','No unique document with the requested party.');
        const target=await adoptDocumentTx(tx,identity,kind,p,names,candidates[0]);
        await insertReferenceTx(tx,identity,p,target.txn_id,hash);
        return success('adopted',p,target,setting);
      }
      if(p.adopt_only)refuse(409,'adoption_required','Adopt-only request has no existing document.');
      if(p.txn_date<setting.write_floor)refuse(409,'date_floor','New accounting writes precede the integration date floor.');
      const args={orgId:identity.orgId,entityId:identity.entityId,actor:setting.actor,type:kind,txnDate:p.txn_date,dueDate:p.due_date,
        termsId:names.termsId,docNumber:p.doc_number,memo:p.memo??'',allowSignedItemRates:true};
      let txnId;
      if(kind==='invoice') {
        if(!(await getSalesSettings(tx,args)).customNumbers)refuse(409,'custom_numbers_off','Custom document numbers must be enabled.');
        txnId=await writeSalesDoc(tx,{...args,customerId:names.partyId,lines:names.lines});
      } else {
        txnId=await writeVendorDoc(tx,{...args,vendorId:names.partyId,categoryLines:names.lines.filter(l=>!l.itemId),itemLines:names.lines.filter(l=>l.itemId)});
        if(p.approve)await approveBillsTx(tx,{...args,txnIds:[txnId]});
      }
      const target=(await tx.query('SELECT * FROM txn WHERE txn_id=$1',[txnId])).rows[0];
      await adoptDocumentTx(tx,identity,kind,p,names,target);
      await insertReferenceTx(tx,identity,p,txnId,hash);
      return success('created',p,target,setting);
    });
  } catch(error) {
    if(error instanceof ValidationError)refuse(422,'invalid_accounting',error.message);
    throw error;
  }
}
