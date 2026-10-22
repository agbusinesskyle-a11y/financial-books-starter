import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { systemAccounts } from '../data/ledger.js';
import { refuse } from './policy.js';

const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const canonicalHash=(kind,body)=>createHash('sha256').update(JSON.stringify(canonical({kind,body}))).digest('hex');
export function grossVector(legs) {
  const map=new Map();
  for(const [id,cents] of legs) {
    const key=String(id),row=map.get(key)??[0n,0n];
    row[cents<0?1:0]+=BigInt(Math.abs(cents));map.set(key,row);
  }
  return [...map].sort(([a],[b])=>a.localeCompare(b)).map(([id,values])=>[id,...values.map(String)]);
}
export async function adoptDocumentTx(tx,identity,kind,body,names,target) {
  const fail=()=>refuse(409,'document_conflict','Existing document identity does not agree.');
  const party=kind==='invoice'?'customer_id':'vendor_id';
  // Imported paid documents have no exported terms. The importer uses transaction date as the fallback due date.
  // A distinct aging-backed due date is authoritative and must agree; no imported row is edited.
  const fallbackDue=target.source==='qbo_import'&&target.due_date===target.txn_date;
  if(target.voided_at||target.type!==kind||target.doc_number!==body.doc_number||target[party]!==names.partyId||
    target.txn_date!==body.txn_date||(!fallbackDue&&target.due_date!==body.due_date)||target.currency!==null||target.total_cents!==body.total_cents)fail();
  const sys=await systemAccounts(tx,identity.orgId,identity.entityId);
  const expected=grossVector([[kind==='invoice'?sys.ar:sys.ap,kind==='invoice'?body.total_cents:-body.total_cents],
    ...names.lines.map(l=>[l.accountId,(kind==='invoice'?-1:1)*l.amountCents])]);
  const rows=(await tx.query(`SELECT p.account_id,p.amount_cents FROM posting p JOIN txn t ON t.txn_id=p.txn_id
    WHERE t.org_id=$1 AND t.entity_id=$2 AND (t.txn_id=$3 OR t.companion_of_txn_id=$3)`,[identity.orgId,identity.entityId,target.txn_id])).rows;
  if(!isDeepStrictEqual(grossVector(rows.map(r=>[r.account_id,r.amount_cents])),expected))fail();
  if(kind==='bill'&&body.approve&&target.approval_status!=='approved')fail();
  return target;
}
export const success=(status,body,t,setting)=>({status,txn_id:String(t.txn_id),source_ref:body.source_ref,doc_number:t.doc_number,
  total_cents:t.total_cents,open_cents:t.open_cents,instance_id:setting.instance_id,ledger_instance:setting.ledger_instance});
export async function insertReferenceTx(tx,identity,body,txnId,hash) {
  const taken=await tx.query('SELECT 1 FROM external_ref WHERE org_id=$1 AND entity_id=$2 AND source=$3 AND txn_id=$4',[identity.orgId,identity.entityId,identity.source,txnId]);
  if(taken.rowCount)refuse(409,'reference_conflict','Document is already linked to a different reference.');
  await tx.query(`INSERT INTO external_ref(org_id,entity_id,source,source_ref,txn_id,request_hash) VALUES($1,$2,$3,$4,$5,$6)`,
    [identity.orgId,identity.entityId,identity.source,body.source_ref,txnId,hash]);
}
