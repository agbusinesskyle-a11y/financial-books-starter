import { refuse } from './policy.js';
import { moneyText } from './input.js';

const tables={customer:['customer_id','display_name'],vendor:['vendor_id','display_name'],item:['item_id','name'],account:['account_id','name'],terms:['terms_id','name']};
export async function resolveNameTx(tx,identity,table,name,field=table) {
  const [,column]=tables[table];
  const {rows}=await tx.query(`SELECT * FROM ${table} WHERE org_id=$1 AND entity_id=$2 AND ${column}=$3`,[identity.orgId,identity.entityId,name]);
  if(rows.length!==1)refuse(422,'unknown_name','Name does not resolve uniquely in this company.',field);
  if(rows[0].active===false)refuse(422,'inactive_name','Name is inactive.',field);
  return rows[0];
}
async function partyTx(tx,identity,table,name) {
  const party=await resolveNameTx(tx,identity,table,name,`${table}_name`);
  if(party.currency)refuse(422,'unsupported_currency','Foreign currency is unsupported.');
  return party;
}
export async function resolveDocumentNamesTx(tx,identity,kind,body) {
  const customer=kind==='invoice',table=customer?'customer':'vendor';
  const party=await partyTx(tx,identity,table,body[`${table}_name`]);
  const terms=body.terms_name?await resolveNameTx(tx,identity,'terms',body.terms_name,'terms_name'):null;
  const lines=[];
  for(const [i,l] of body.lines.entries()) {
    let item=null,account;
    if(l.item_name!==undefined) {
      item=await resolveNameTx(tx,identity,'item',l.item_name,`lines.${i}.item_name`);
      if(!['product','service'].includes(item.kind))refuse(422,'unsupported_item','Only non-inventory items are supported.',`lines.${i}.item_name`);
      const id=customer?item.income_account_id:item.expense_account_id;
      account=(await tx.query('SELECT * FROM account WHERE org_id=$1 AND entity_id=$2 AND account_id=$3',[identity.orgId,identity.entityId,id])).rows[0];
      const allowed=customer?['income','other_income']:['expense','other_expense','cost_of_goods_sold'];
      if(!account?.active||!allowed.includes(account.type))refuse(422,'invalid_account','Item account is missing, inactive or incompatible.',`lines.${i}.item_name`);
    } else {
      account=await resolveNameTx(tx,identity,'account',l.account_name,`lines.${i}.account_name`);
      if(customer||['ar','ap','undeposited'].includes(account.system_key)||['bank','credit_card','accounts_receivable','accounts_payable','inventory'].includes(account.type))
        refuse(422,'invalid_account','Unsupported category account.',`lines.${i}.account_name`);
    }
    lines.push({itemId:item?.item_id??null,accountId:account.account_id,description:l.description??'',quantity:l.quantity??'1',
      rate:moneyText(l.rate_cents??l.amount_cents),amount:moneyText(l.amount_cents),amountCents:l.amount_cents});
  }
  return {partyId:party[tables[table][0]],termsId:terms?.terms_id??null,lines};
}

export async function resolvePaymentNamesTx(tx,identity,kind,body,{checkOpen=true}={}) {
  const customer=kind==='customer-payment',table=customer?'customer':'vendor',charge=customer?'invoice':'bill';
  const party=await partyTx(tx,identity,table,body[`${table}_name`]),partyId=party[tables[table][0]];
  let account=null;
  const name=body[customer?'deposit_to_account_name':'bank_account_name'];
  if(name!==null) {
    account=await resolveNameTx(tx,identity,'account',name);
    const allowed=customer?['bank']:['bank','credit_card'];
    if(!allowed.includes(account.type))refuse(422,'invalid_account','Unsupported payment account.');
  }
  const applications=[],seen=new Set();
  for(const [i,a] of body.applications.entries()) {
    const {rows}=await tx.query(`SELECT t.* FROM txn t ${a.source_ref!==undefined?'JOIN external_ref r ON r.txn_id=t.txn_id AND r.org_id=t.org_id AND r.entity_id=t.entity_id':''}
      WHERE t.org_id=$1 AND t.entity_id=$2 AND t.type=$3 AND t.${table}_id=$4 AND ${a.source_ref!==undefined?'r.source_ref=$5 AND r.source=$6':'t.doc_number=$5'}`,
    [identity.orgId,identity.entityId,charge,partyId,a.source_ref??a.doc_number,...(a.source_ref!==undefined?[identity.source]:[])]);
    const t=rows[0],field=`applications.${i}`;
    if(rows.length!==1)refuse(422,'unknown_document','Application document does not resolve uniquely.',field);
    if(t.voided_at||t.currency||(checkOpen&&t.open_cents<a.amount_cents)||seen.has(t.txn_id))refuse(422,'invalid_application','Document is voided, foreign, duplicated or has insufficient open balance.',field);
    const appliedOn=a.applied_on??body.txn_date;
    if(appliedOn<t.txn_date||appliedOn<body.txn_date)refuse(422,'invalid_application','Application precedes a document.',field);
    if(!customer&&t.approval_status!=='approved')refuse(422,'unapproved_bill','Bill requires approval.',field);
    seen.add(t.txn_id);applications.push({chargeTxnId:t.txn_id,amountCents:a.amount_cents,appliedOn});
  }
  if(!customer&&body.method==='ACH'&&!party.bank_verified)refuse(422,'unverified_vendor','Vendor bank details require verification.');
  return {partyId,accountId:account?.account_id??null,applications};
}
