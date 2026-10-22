import { refuse } from './policy.js';
import { text } from './input.js';

const MAX_BYTES=4*1024*1024;
async function snapshot(pool,identity,fn) {
  if(!identity.scopes?.includes('settlements:read'))refuse(403,'scope_required','Required integration scope is missing.');
  const tx=await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const setting=(await tx.query('SELECT instance_id,ledger_instance FROM integration_setting WHERE org_id=$1 AND entity_id=$2',[identity.orgId,identity.entityId])).rows[0];
    if(!setting)refuse(404,'company_not_found','Integration company not found.');
    const result=await fn(tx,setting);
    if(Buffer.byteLength(JSON.stringify(result))>MAX_BYTES)refuse(413,'snapshot_too_large','Complete snapshot exceeds the response size limit.');
    await tx.query('COMMIT');return result;
  } catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}
}
const select=`SELECT r.ref_id,r.source_ref,t.txn_id,t.doc_number,t.type,t.txn_date,t.total_cents,t.open_cents,t.voided_at,
  coalesce(c.display_name,v.display_name) party_name FROM external_ref r
  JOIN txn t ON t.txn_id=r.txn_id AND t.org_id=r.org_id AND t.entity_id=r.entity_id
  LEFT JOIN customer c ON c.customer_id=t.customer_id AND c.org_id=t.org_id AND c.entity_id=t.entity_id
  LEFT JOIN vendor v ON v.vendor_id=t.vendor_id AND v.org_id=t.org_id AND v.entity_id=t.entity_id
  WHERE r.org_id=$1 AND r.entity_id=$2 AND r.source=$3 AND t.type IN ('invoice','bill')`;
async function documents(tx,identity,setting,rows) {
  if(!rows.length)return [];
  const apps=(await tx.query(`SELECT a.application_id,a.charge_txn_id,a.credit_txn_id,a.amount_cents,a.applied_on,a.source,
    t.type,t.payment_method,t.payment_ref,t.voided_at,ac.name account_name
    FROM application a JOIN txn t ON t.txn_id=a.credit_txn_id AND t.org_id=a.org_id AND t.entity_id=$2
    LEFT JOIN account ac ON ac.org_id=t.org_id AND ac.entity_id=t.entity_id AND
      (ac.account_id=t.account_id OR (t.account_id IS NULL AND t.type='payment' AND ac.system_key='undeposited'))
    WHERE a.org_id=$1 AND a.charge_txn_id=ANY($3::bigint[]) ORDER BY a.application_id`,
    [identity.orgId,identity.entityId,rows.map(r=>r.txn_id)])).rows;
  const grouped=new Map(rows.map(r=>[r.txn_id,[]]));
  for(const a of apps)grouped.get(a.charge_txn_id).push({application_id:`${setting.instance_id}:${a.application_id}`,
    credit_txn_id:String(a.credit_txn_id),type:a.type,amount_cents:a.amount_cents,applied_on:a.applied_on,
    payment_method:a.payment_method,payment_ref:a.payment_ref,account_name:a.account_name,voided_at:a.voided_at,source:a.source,
    allocation_evidence:a.source==='qbo_import'?'reconstructed':'native',cash_history_authoritative:a.source!=='qbo_import'});
  return rows.map(r=>({...r,ref_id:String(r.ref_id),txn_id:String(r.txn_id),complete:true,applications:grouped.get(r.txn_id)}));
}
export async function readSettlements(pool,{identity,afterRefId='0',limit=100}) {
  if(typeof afterRefId!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(afterRefId)||!Number.isSafeInteger(Number(afterRefId))||!Number.isInteger(limit)||limit<1||limit>100)
    refuse(422,'invalid_paging','Invalid settlement cursor or page size.');
  return snapshot(pool,identity,async(tx,setting)=>{
    const rows=(await tx.query(select+' AND r.ref_id>$4 ORDER BY r.ref_id LIMIT $5',[identity.orgId,identity.entityId,identity.source,afterRefId,limit+1])).rows;
    const complete=rows.length<=limit,page=rows.slice(0,limit);
    return {documents:await documents(tx,identity,setting,page),next_after_ref_id:complete?null:String(page.at(-1).ref_id),complete,...setting};
  });
}
export async function readDocumentSettlement(pool,{identity,sourceRef}) {
  text(sourceRef,200,'source_ref');
  return snapshot(pool,identity,async(tx,setting)=>{
    const rows=(await tx.query(select+' AND r.source_ref=$4',[identity.orgId,identity.entityId,identity.source,sourceRef])).rows;
    if(rows.length!==1)refuse(404,'document_not_found','Linked document not found.');
    return {...(await documents(tx,identity,setting,rows))[0],...setting};
  });
}
