import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,invoice,bill } from './integration-fixtures.js';
import { validateDocument } from '../lib/integration/input.js';
import { resolveDocumentNamesTx } from '../lib/integration/names.js';
import { parseLines } from '../lib/data/writes.js';
import { mvOrg, mvCustomer } from './morning-fixtures.js';
import { parseVendorLines } from '../lib/data/payables.js';
test('contracts reject imprecise money and names never create rows',async()=>{
  const f=await fixture();
  try {
    const p=invoice(), line=p.lines[0];
    const bad=[{...p,entity_id:f.ids.entityB},{...p,txn_date:'2026-02-30'},
      {...p,total_cents:10000.1},{...p,total_cents:Number.MAX_SAFE_INTEGER+1},
      {...p,lines:[{...line,quantity:'2.00001'}]},{...p,lines:[{...line,amount_cents:9999}]},
      {...p,lines:[{...line,account_name:'Sample expense'}]},{...p,unexpected:true}];
    for(const b of bad) assert.throws(()=>validateDocument('invoice',b),{status:422});
    const before=await f.count('customer');
    for(const b of [{...p,customer_name:'Sample missing'}, {...p,terms_name:'Sample missing'},
      {...p,lines:[{...line,item_name:'Sample missing'}]}])
      await assert.rejects(resolveDocumentNamesTx(f.pool,f.identity,'invoice',b),{status:422,code:'unknown_name'});
    await f.pool.query('UPDATE item SET active=false WHERE item_id=$1',[f.ids.itemId]);
    await assert.rejects(resolveDocumentNamesTx(f.pool,f.identity,'invoice',p),{status:422,code:'inactive_name'});
    assert.equal(await f.count('customer'),before);
    const items=new Map([[1,{name:'Sample discount',rate_cents:0}]]);
    const negative=[{itemId:1,quantity:'1',rate:'-1.00'}];
    assert.throws(()=>parseLines(negative,items));
    assert.equal(parseLines(negative,items,{allowSignedItemRates:true})[0].amountCents,-100);
    assert.equal(parseLines([{itemId:1,quantity:'0.5',rate:'-0.01'}],items,{allowSignedItemRates:true})[0].amountCents,-1);
  } finally {await f.close();}
});

test('document-only bill requests reject positive and negative bank and card categories before posting',async t=>{
  for(const type of ['bank','credit_card'])for(const amount of [10000,-10000])await t.test(`${type} ${amount}`,async()=>{
    const f=await fixture({scopes:['documents:write']});
    try {
      const name=type==='bank'?'Checking':'Sample card';
      if(type==='credit_card')await f.pool.query("INSERT INTO account(org_id,entity_id,name,type) VALUES($1,$2,$3,'credit_card')",[f.S.orgId,f.S.entityId,name]);
      const before=await f.books(),activity=await f.count('activity_event'),audit=await f.count('audit_log');
      const lines=[...(amount<0?[{account_name:'Sample expense',amount_cents:20000}]:[]),{account_name:name,amount_cents:amount}];
      const made=await f.api('/bills',{...bill('cash-category'),approve:false,lines});
      assert.equal(made.status,422,'Cash category bill must refuse before posting');
      assert.equal(made.body.error.code,'invalid_account');
      assert.equal(made.body.error.field,`lines.${lines.length-1}.account_name`);
      assert.deepEqual(await f.books(),before);
      assert.equal(await f.count('activity_event'),activity);
      assert.equal(await f.count('audit_log'),audit);
    } finally {await f.close();}
  });
});

test('document-only bills retain noncash asset and liability category postings',async()=>{
  const f=await fixture({scopes:['documents:write']});
  try {
    for(const type of ['other_current_asset','fixed_asset','other_asset','other_current_liability','long_term_liability']) {
      const name=`Sample ${type}`;
      const account=(await f.pool.query('INSERT INTO account(org_id,entity_id,name,type) VALUES($1,$2,$3,$4) RETURNING account_id',[f.S.orgId,f.S.entityId,name,type])).rows[0].account_id;
      for(const amount of [10000,-10000]) {
        const made=await f.api('/bills',{...bill(`${account}:${amount}`),approve:false,
          lines:[...(amount<0?[{account_name:'Sample expense',amount_cents:20000}]:[]),{account_name:name,amount_cents:amount}]});
        assert.equal(made.status,201,JSON.stringify(made.body));
        assert.equal((await f.pool.query('SELECT sum(amount_cents)::bigint n FROM posting WHERE txn_id=$1 AND account_id=$2',[made.body.txn_id,account])).rows[0].n,amount);
      }
    }
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM posting p JOIN account a USING(account_id) WHERE a.type IN ('bank','credit_card')")).rows[0].n,0);
  } finally {await f.close();}
});

test('same-name parties in other organizations and companies cannot affect name resolution',async()=>{
  const f=await fixture();
  try {
    const other=await mvOrg(f.pool,{slug:'sample_other'});
    await mvCustomer(f.pool,{orgId:other.orgId,entityId:other.entities['Sample company A'],name:'Sample customer A'});
    await mvCustomer(f.pool,{...f.S,entityId:f.ids.entityB,name:'Sample customer A'});
    assert.equal((await resolveDocumentNamesTx(f.pool,f.identity,'invoice',invoice())).partyId,f.ids.customerId);
    await f.pool.query('UPDATE customer SET active=false WHERE customer_id=$1',[f.ids.customerId]);
    await assert.rejects(resolveDocumentNamesTx(f.pool,f.identity,'invoice',invoice()),{status:422,code:'inactive_name'});
    const args={...f.S,itemLines:[{itemId:f.ids.itemId,quantity:'0.5',rate:'-0.01'}]};
    await assert.rejects(parseVendorLines(f.pool,args));
    assert.equal((await parseVendorLines(f.pool,{...args,allowSignedItemRates:true}))[0].amountCents,-1);
  } finally {await f.close();}
});
