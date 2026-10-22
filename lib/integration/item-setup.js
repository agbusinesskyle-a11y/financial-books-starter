import { withTransaction } from '../db.js';
import { refuseDemoDatabase } from '../data/demo.js';
import { lockEntity } from '../data/writes.js';
import { saveItemTx } from '../data/catalog.js';
import { canonicalHash } from './identity.js';

const fail=message=>{throw new Error(message);};
function keys(value,allowed) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('Invalid catalog fields.');
}
function name(value,max) {
  if(typeof value!=='string'||!value||value!==value.trim()||value.length>max||/[\x00-\x1f]/.test(value))fail('Invalid exact catalog name.');
  return value;
}
function validate(catalog) {
  keys(catalog,['version','map_sha256','items']);
  if(catalog.version!==1||!(/^[a-f0-9]{64}$/.test(catalog.map_sha256))||!Array.isArray(catalog.items))fail('Invalid catalog version or map hash.');
  const seen=new Set();
  return {version:1,map_sha256:catalog.map_sha256,items:catalog.items.map(i=>{
    keys(i,['name','kind','income_account_name','expense_account_name','qbo_type']);
    name(i.name,100);name(i.income_account_name,100);name(i.expense_account_name,100);
    if(seen.has(i.name)||i.kind!=='product'||!['NonInventory','Service'].includes(i.qbo_type))fail('Catalog requires unique non-inventory products.');
    seen.add(i.name);return {...i};
  }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)};
}

export async function setupIntegrationItems(pool,{orgSlug,companyName,catalog,apply=false,approvedHash=null,actor='operator'}) {
  await refuseDemoDatabase(pool);
  const manifest=validate(catalog);name(orgSlug,100);name(companyName,200);
  if(typeof apply!=='boolean')fail('Invalid apply flag.');
  return withTransaction(pool,async tx=>{
    if(!apply)await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const {rows}=await tx.query(`SELECT o.org_id,o.slug,e.entity_id,e.name FROM org o JOIN entity e ON e.org_id=o.org_id
      WHERE o.slug=$1 AND e.name=$2`,[orgSlug,companyName]);
    if(rows.length!==1)fail('Destination company must resolve uniquely.');
    const company=rows[0],scope=[company.org_id,company.entity_id];
    if(apply)await lockEntity(tx,...scope);
    const setting=(await tx.query('SELECT instance_id,ledger_instance FROM integration_setting WHERE org_id=$1 AND entity_id=$2',scope)).rows[0];
    if(!setting)fail('Save a disabled integration policy in Settings before previewing item setup.');
    const destination={...company,...setting},resolved=[],missing=[];
    let existing=0;
    for(const item of manifest.items) {
      const resolve=async (accountName,types)=>{
        const {rows}=await tx.query('SELECT account_id,name,type,active FROM account WHERE org_id=$1 AND entity_id=$2 AND name=$3',[...scope,accountName]);
        if(rows.length!==1||!rows[0].active||!types.includes(rows[0].type))fail('Missing, inactive or incompatible account: '+accountName);
        return rows[0];
      };
      const income=await resolve(item.income_account_name,['income','other_income']);
      const expense=await resolve(item.expense_account_name,['expense','other_expense','cost_of_goods_sold']);
      resolved.push({name:item.name,income,expense});
      const matches=(await tx.query('SELECT * FROM item WHERE org_id=$1 AND entity_id=$2 AND name=$3',[...scope,item.name])).rows;
      if(matches.length) {
        const row=matches[0];
        if(matches.length!==1||!row.active||row.kind!=='product'||row.income_account_id!==income.account_id||row.expense_account_id!==expense.account_id)
          fail('existing item differs: '+item.name);
        existing++;
      } else missing.push({name:item.name,kind:'product',incomeAccountId:String(income.account_id),expenseAccountId:String(expense.account_id)});
    }
    // Creation status and generated item IDs are intentionally excluded: the same approval is retryable.
    const hash=canonicalHash('item-setup',{manifest,destination,accounts:resolved});
    if(apply&&approvedHash!==hash)fail('Exact destination approval hash required.');
    if(apply) {
      await tx.query("SELECT set_config('app.actor',$1,true)",[actor]);
      for(const fields of missing)await saveItemTx(tx,{orgId:company.org_id,entityId:company.entity_id,fields,actor});
    }
    return {hash,planned:missing.length,created:apply?missing.length:0,existing,destination,accounts:resolved};
  });
}
