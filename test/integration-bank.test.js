import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,invoice,bill,receipt } from './integration-fixtures.js';
import { writeDocument } from '../lib/integration/documents.js';
import { writePayment } from '../lib/integration/payments.js';
import { addItem,settleItem,matchItem,transferItem,backdatedBill,getBankItem,itemToken,evidenceToken,possibleDuplicates,undoItem } from '../lib/data/banking.js';
test('waiting and on-account integration cash cannot be added or settled twice',async()=>{
  for(const mode of ['customer-undeposited','customer-direct','bill']){
    const f=await fixture();
    try{
      const outgoing=mode==='bill',direct=mode!=='customer-undeposited';
      const d=await writeDocument(f.pool,{identity:f.identity,kind:outgoing?'bill':'invoice',body:outgoing?bill():invoice()});
      const body=outgoing?{source_ref:'billpayment:1',vendor_name:'Sample vendor A',txn_date:'2026-10-22',amount_cents:10000,
        method:'Check',check_no:'1042',reference:'1042',bank_account_name:'Checking',applications:[{source_ref:'bill:1',amount_cents:10000}]}:
        {...receipt(),deposit_to_account_name:direct?'Checking':null};
      const p=await writePayment(f.pool,{identity:f.identity,kind:outgoing?'bill-payment':'customer-payment',body});
      const account=randomUUID();
      await f.pool.query(`INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_by) VALUES($1,$2,$3,'Sample company A','tester')`,[f.S.orgId,f.S.entityId,randomUUID()]);
      await f.pool.query(`INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,books_account_id) VALUES($1,$2,$3,'Sample checking','checking',$4)`,[f.S.orgId,f.S.entityId,account,f.ids.accounts.checking]);
      const itemId=(await f.pool.query(`INSERT INTO bank_feed_item(org_id,entity_id,ll_transaction_id,ll_account_id,revision,pending,posted_date,amount_cents)
        VALUES($1,$2,$3,$4,1,false,'2026-10-22',$5) RETURNING item_id`,[f.S.orgId,f.S.entityId,randomUUID(),account,outgoing?-10000:10000])).rows[0].item_id;
      const args={...f.S,itemId,actor:'tester'}, count=await f.count('txn');
      await assert.rejects(addItem(f.pool,{...args,separate:true,lines:[{accountId:outgoing?f.ids.expense:f.ids.income,amount:'100.00'}]}),/Match the existing integration payment/);
      await assert.rejects(addItem(f.pool,{...args,separate:true,lines:[{accountId:f.ids.accounts.savings,amount:'100.00'}]}),/Match the existing integration payment/);
      await assert.rejects(settleItem(f.pool,{...args,settle:[{txnId:Number(d.txn_id),amountCents:10000}]}),/Match the existing integration payment/);
      assert.equal(await f.count('txn'),count);
      await matchItem(f.pool,{...args,txnIds:direct?[Number(p.txn_id)]:[],undepositedIds:direct?[]:[Number(p.txn_id)]});
      assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type IN ('payment','bill_payment')")).rows[0].n,1);
    }finally{await f.close();}
  }
});

async function bankLine(f,amount) {
  if(!f.sampleFeedAccount) {
    f.sampleFeedAccount=randomUUID();
    await f.pool.query(`INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_by) VALUES($1,$2,$3,'Sample company A','tester')`,[f.S.orgId,f.S.entityId,randomUUID()]);
    await f.pool.query(`INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,books_account_id) VALUES($1,$2,$3,'Sample checking','checking',$4)`,[f.S.orgId,f.S.entityId,f.sampleFeedAccount,f.ids.accounts.checking]);
  }
  return (await f.pool.query(`INSERT INTO bank_feed_item(org_id,entity_id,ll_transaction_id,ll_account_id,revision,pending,posted_date,amount_cents)
    VALUES($1,$2,$3,$4,1,false,'2026-10-22',$5) RETURNING item_id`,[f.S.orgId,f.S.entityId,randomUUID(),f.sampleFeedAccount,amount])).rows[0].item_id;
}
async function shown(f,itemId,ids=[]) {
  const item=await getBankItem(f.pool,{...f.S,itemId});
  const versions=new Map((await f.pool.query('SELECT txn_id,txn_version(txn_id) version FROM txn WHERE txn_id=ANY($1::bigint[])',[ids])).rows.map(r=>[r.txn_id,r.version]));
  return {rev:itemToken(item),evidence:evidenceToken(await possibleDuplicates(f.pool,{...f.S,item})),versions};
}
test('direct transfer and backdated bill overrides cannot duplicate linked cash, including claimed and replaced evidence',async()=>{
  const f=await fixture();
  try {
    await writeDocument(f.pool,{identity:f.identity,kind:'bill',body:bill()});
    const p=await writePayment(f.pool,{identity:f.identity,kind:'bill-payment',body:{source_ref:'ap:1',vendor_name:'Sample vendor A',txn_date:'2026-10-22',amount_cents:10000,method:'Other',reference:'Sample AP',bank_account_name:'Checking',applications:[{source_ref:'bill:1',amount_cents:10000}]}});
    const original=await bankLine(f,-10000),id=await bankLine(f,-10000);
    for(const reason of ['on_account','claimed','replaced']) {
      if(reason==='claimed')await matchItem(f.pool,{...f.S,itemId:original,txnIds:[Number(p.txn_id)],actor:'tester'});
      if(reason==='replaced')await f.pool.query("UPDATE bank_feed_item SET bank_state='removed' WHERE item_id=$1",[original]);
      const item=await getBankItem(f.pool,{...f.S,itemId:id});
      assert.ok((await possibleDuplicates(f.pool,{...f.S,item})).some(d=>d.reason===reason));
      const args={...f.S,itemId:id,actor:'tester',separate:true,expect:await shown(f,id,[Number(p.txn_id)])},before=await f.books();
      await assert.rejects(transferItem(f.pool,{...args,otherAccountId:f.ids.accounts.savings}),/Match the existing integration payment/);
      await assert.rejects(backdatedBill(f.pool,{...args,vendorId:f.ids.vendorId,billDate:'2026-10-21',canApprove:true,lines:[{accountId:f.ids.expense,amount:'100.00'}]}),/Match the existing integration payment/);
      assert.deepEqual(await f.books(),before);
    }
    // The existing review deliberately retains a removed bank line's claim until the person undoes that match.
    await undoItem(f.pool,{...f.S,itemId:original,actor:'tester'});
    await matchItem(f.pool,{...f.S,itemId:id,txnIds:[Number(p.txn_id)],actor:'tester',expect:await shown(f,id,[Number(p.txn_id)])});
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type='bill_payment'")).rows[0].n,1);
  } finally {await f.close();}
});

test('grouped integration UF receipts and fee-net deposits require matching; fee adjustments do not create receipts',async()=>{
  for(const fee of [0,200]) {
    const f=await fixture();
    try {
      const payments=[];
      for(const [n,amount] of [['1',6000],['2',4000]])payments.push(Number((await writePayment(f.pool,{identity:f.identity,kind:'customer-payment',body:{...receipt(n),amount_cents:amount}})).txn_id));
      const id=await bankLine(f,10000-fee),args={...f.S,itemId:id,actor:'tester',separate:true,expect:await shown(f,id,payments)},before=await f.books();
      await assert.rejects(addItem(f.pool,{...args,lines:[{accountId:f.ids.income,amount:((10000-fee)/100).toFixed(2)}]}),/Match the existing integration payment/);
      await assert.rejects(transferItem(f.pool,{...args,otherAccountId:f.ids.accounts.savings}),/Match the existing integration payment/);
      assert.deepEqual(await f.books(),before);
      if(fee)await settleItem(f.pool,{...args,undepositedIds:payments,adjustments:[{accountId:f.ids.expense,cents:-fee,description:'Sample fee'}]});
      else await matchItem(f.pool,{...args,undepositedIds:payments});
      assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type='payment'")).rows[0].n,2);
      assert.equal((await f.pool.query('SELECT sum(amount_cents)::bigint n FROM posting WHERE account_id=$1',[f.ids.accounts.checking])).rows[0].n,10000-fee);
      const second=await bankLine(f,10000-fee),again=await f.books();
      // The grouped deposit retains the original receipt provenance even after UF is cleared.
      const retryArgs={...f.S,itemId:second,actor:'tester',separate:true,expect:await shown(f,second,payments)};
      await assert.rejects(addItem(f.pool,{...retryArgs,lines:[{accountId:f.ids.income,amount:((10000-fee)/100).toFixed(2)}]}),/Match the existing integration payment/);
      await assert.rejects(transferItem(f.pool,{...retryArgs,otherAccountId:f.ids.accounts.savings}),/Match the existing integration payment/);
      assert.deepEqual(await f.books(),again);
    } finally {await f.close();}
  }
});

test('grouped direct integration receipts require matching before and after a fee-net bank match',async()=>{
  const f=await fixture();
  try {
    const payments=[];
    for(const [n,amount] of [['1',6000],['2',4000]])payments.push(Number((await writePayment(f.pool,{identity:f.identity,kind:'customer-payment',body:{...receipt(n),amount_cents:amount,deposit_to_account_name:'Checking'}})).txn_id));
    const id=await bankLine(f,9800),args={...f.S,itemId:id,actor:'tester',separate:true,expect:await shown(f,id,payments)},before=await f.books();
    await assert.rejects(addItem(f.pool,{...args,lines:[{accountId:f.ids.income,amount:'98.00'}]}),/Match the existing integration payment/);
    await assert.rejects(transferItem(f.pool,{...args,otherAccountId:f.ids.accounts.savings}),/Match the existing integration payment/);
    assert.deepEqual(await f.books(),before);
    await settleItem(f.pool,{...args,txnIds:payments,adjustments:[{accountId:f.ids.expense,cents:-200,description:'Sample fee'}]});
    const second=await bankLine(f,9800),after=await f.books();
    await assert.rejects(addItem(f.pool,{...f.S,itemId:second,actor:'tester',separate:true,expect:await shown(f,second),lines:[{accountId:f.ids.income,amount:'98.00'}]}),/Match the existing integration payment/);
    assert.deepEqual(await f.books(),after);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type='payment'")).rows[0].n,2);
  } finally {await f.close();}
});

test('grouped outgoing integration payments cannot be recreated through any bank creation boundary',async()=>{
  const f=await fixture();
  try {
    const payments=[];
    for(const [n,amount] of [['1',6000],['2',4000]]) {
      await writeDocument(f.pool,{identity:f.identity,kind:'bill',body:bill(n)});
      payments.push(Number((await writePayment(f.pool,{identity:f.identity,kind:'bill-payment',body:{source_ref:`ap:${n}`,vendor_name:'Sample vendor A',txn_date:'2026-10-22',amount_cents:amount,method:'Other',reference:`Sample AP ${n}`,bank_account_name:'Checking',applications:[{source_ref:`bill:${n}`,amount_cents:amount}]}})).txn_id));
    }
    const open=await writeDocument(f.pool,{identity:f.identity,kind:'bill',body:bill('3')});
    const original=await bankLine(f,-10000),second=await bankLine(f,-10000);
    for(const state of ['unmatched','claimed','removed']) {
      if(state==='claimed')await matchItem(f.pool,{...f.S,itemId:original,txnIds:payments,actor:'tester',expect:await shown(f,original,payments)});
      if(state==='removed')await f.pool.query("UPDATE bank_feed_item SET bank_state='removed' WHERE item_id=$1",[original]);
      const args={...f.S,itemId:second,actor:'tester',separate:true,expect:await shown(f,second,[...payments,Number(open.txn_id)])},before=await f.books();
      await assert.rejects(addItem(f.pool,{...args,lines:[{accountId:f.ids.expense,amount:'100.00'}]}),/Match the existing integration payment/);
      await assert.rejects(transferItem(f.pool,{...args,otherAccountId:f.ids.accounts.savings}),/Match the existing integration payment/);
      await assert.rejects(backdatedBill(f.pool,{...args,vendorId:f.ids.vendorId,billDate:'2026-10-21',canApprove:true,lines:[{accountId:f.ids.expense,amount:'100.00'}]}),/Match the existing integration payment/);
      await assert.rejects(settleItem(f.pool,{...args,settle:[{txnId:Number(open.txn_id),amountCents:10000}]}),/Match the existing integration payment/);
      assert.deepEqual(await f.books(),before);
    }
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type='bill_payment'")).rows[0].n,2);
    assert.equal((await f.pool.query('SELECT sum(amount_cents)::bigint n FROM posting WHERE account_id=$1',[f.ids.accounts.checking])).rows[0].n,-10000);
  } finally {await f.close();}
});

test('outgoing integration pools exclude payments with conflicting check numbers',async()=>{
  const f=await fixture();
  try {
    for(const [n,amount,check] of [['1',6000,'1042'],['2',4000,'1043']]) {
      await writeDocument(f.pool,{identity:f.identity,kind:'bill',body:bill(n)});
      await writePayment(f.pool,{identity:f.identity,kind:'bill-payment',body:{source_ref:`ap:${n}`,vendor_name:'Sample vendor A',txn_date:'2026-10-22',amount_cents:amount,method:'Check',check_no:check,reference:check,bank_account_name:'Checking',applications:[{source_ref:`bill:${n}`,amount_cents:amount}]}});
    }
    const id=await bankLine(f,-10000);
    await f.pool.query('UPDATE bank_feed_item SET check_number=$2 WHERE item_id=$1',[id,'1044']);
    const before=await f.count('txn');
    await addItem(f.pool,{...f.S,itemId:id,actor:'tester',separate:true,expect:await shown(f,id),lines:[{accountId:f.ids.expense,amount:'100.00'}]});
    assert.equal(await f.count('txn'),before+1);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type='bill_payment'")).rows[0].n,2);
    assert.equal((await f.pool.query('SELECT sum(amount_cents)::bigint n FROM posting WHERE account_id=$1',[f.ids.accounts.checking])).rows[0].n,-20000);
  } finally {await f.close();}
});

async function outgoingFeeFixture({checks=false}={}) {
  const f=await fixture();
  try {
    f.payments=[];
    for(const [n,amount] of [['fee-1',6000],['fee-2',4000]]) {
      assert.equal((await f.api('/bills',bill(n))).status,201);
      const p=await f.api('/bill-payments',{source_ref:`ap:${n}`,vendor_name:'Sample vendor A',txn_date:'2026-10-22',
        amount_cents:amount,method:checks?'Check':'Other',...(checks?{check_no:amount===6000?'1042':'1043'}:{}),reference:`Sample AP ${n}`,bank_account_name:'Checking',
        applications:[{source_ref:`bill:${n}`,amount_cents:amount}]});
      assert.equal(p.status,201);f.payments.push(Number(p.body.txn_id));
    }
    return f;
  } catch(error) {await f.close();throw error;}
}
const checkingBalance=async f=>(await f.pool.query('SELECT coalesce(sum(amount_cents),0)::bigint n FROM posting WHERE account_id=$1',[f.ids.accounts.checking])).rows[0].n;
async function bankState(f) {
  return [await f.books(),...await Promise.all(['activity_event','audit_log','bank_feed_item','bank_feed_link','bank_review_event'].map(async table=>
    (await f.pool.query(`SELECT to_jsonb(x) row FROM ${table} x ORDER BY to_jsonb(x)::text`)).rows))];
}

test('outgoing integration cash plus a fee refuses all four creation boundaries without changing books or activity',async t=>{
  for(const boundary of ['Add','Transfer','Backdated Bill','Settle'])await t.test(boundary,async()=>{
    const f=await outgoingFeeFixture();
    try {
      const open=await f.api('/bills',{...bill('fee-open'),total_cents:10200,lines:[{account_name:'Sample expense',amount_cents:10200}]});
      assert.equal(open.status,201);
      const id=await bankLine(f,-10200),args={...f.S,itemId:id,actor:'tester',separate:true,
        expect:await shown(f,id,[...f.payments,Number(open.body.txn_id)])};
      const before=await bankState(f);
      assert.equal(await checkingBalance(f),-10000);
      const create=()=>{
        if(boundary==='Add')return addItem(f.pool,{...args,lines:[{accountId:f.ids.expense,amount:'102.00'}]});
        if(boundary==='Transfer')return transferItem(f.pool,{...args,otherAccountId:f.ids.accounts.savings});
        if(boundary==='Backdated Bill')return backdatedBill(f.pool,{...args,vendorId:f.ids.vendorId,billDate:'2026-10-21',canApprove:true,lines:[{accountId:f.ids.expense,amount:'102.00'}]});
        return settleItem(f.pool,{...args,settle:[{txnId:Number(open.body.txn_id),amountCents:10200}]});
      };
      await assert.rejects(create,/Match the existing integration payment/);
      assert.deepEqual(await bankState(f),before);
      assert.equal(await checkingBalance(f),-10000);
    } finally {await f.close();}
  });
});

test('outgoing integration cash plus a fee matches existing payments with one genuine expense adjustment',async()=>{
  const f=await outgoingFeeFixture();
  try {
    const id=await bankLine(f,-10200);
    await settleItem(f.pool,{...f.S,itemId:id,actor:'tester',expect:await shown(f,id,f.payments),txnIds:f.payments,
      adjustments:[{accountId:f.ids.expense,cents:200,description:'Sample fee'}]});
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type='bill_payment'")).rows[0].n,2);
    assert.equal(await checkingBalance(f),-10200);
    assert.equal((await f.pool.query("SELECT sum(p.amount_cents)::bigint n FROM posting p JOIN txn t USING(txn_id) WHERE p.account_id=$1 AND t.type='journal_entry'",[f.ids.expense])).rows[0].n,200);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type='journal_entry'")).rows[0].n,1);
    const second=await bankLine(f,-10200),before=await bankState(f);
    await assert.rejects(addItem(f.pool,{...f.S,itemId:second,actor:'tester',separate:true,expect:await shown(f,second,f.payments),
      lines:[{accountId:f.ids.expense,amount:'102.00'}]}),/Match the existing integration payment/);
    assert.deepEqual(await bankState(f),before);
  } finally {await f.close();}
});

test('outgoing fee holds preserve account, direction and pool date exclusions',async()=>{
  for(const exclusion of ['account','direction','too-old','too-new']) {
    const f=await outgoingFeeFixture();
    try {
      const amount=exclusion==='direction'?10200:-10200,id=await bankLine(f,amount);
      if(exclusion==='account')await f.pool.query('UPDATE ledgerline_account SET books_account_id=$1 WHERE ll_account_id=$2',[f.ids.accounts.savings,f.sampleFeedAccount]);
      if(exclusion==='too-old'||exclusion==='too-new')await f.pool.query('UPDATE bank_feed_item SET posted_date=$2 WHERE item_id=$1',[id,exclusion==='too-old'?'2026-12-22':'2026-10-11']);
      const before=await f.count('txn');
      await addItem(f.pool,{...f.S,itemId:id,actor:'tester',separate:true,expect:await shown(f,id),
        lines:[{accountId:amount>0?f.ids.income:f.ids.expense,amount:'102.00'}]});
      assert.equal(await f.count('txn'),before+1,exclusion);
    } finally {await f.close();}
  }
});

// Round-2 review appendix: an earlier claim must not make fee-adjusted cash new again.
for(const state of ['claimed','removed'])test(`${state} integration group plus a replacement fee refuses all four creation boundaries`,async t=>{
  for(const boundary of ['Add','Transfer','Backdated Bill','Settle'])await t.test(boundary,async()=>{
    const f=await outgoingFeeFixture();
    try {
      const original=await bankLine(f,-10000);
      await matchItem(f.pool,{...f.S,itemId:original,actor:'tester',txnIds:f.payments,expect:await shown(f,original,f.payments)});
      if(state==='removed')await f.pool.query("UPDATE bank_feed_item SET bank_state='removed' WHERE item_id=$1",[original]);
      const open=await f.api('/bills',{...bill('open'),total_cents:10200,lines:[{account_name:'Sample expense',amount_cents:10200}]});
      assert.equal(open.status,201);
      const id=await bankLine(f,-10200),args={...f.S,itemId:id,actor:'tester',separate:true,
        expect:await shown(f,id,[...f.payments,Number(open.body.txn_id)])};
      const before=await bankState(f);
      assert.equal(await checkingBalance(f),-10000);
      const create=()=>{
        if(boundary==='Add')return addItem(f.pool,{...args,lines:[{accountId:f.ids.expense,amount:'102.00'}]});
        if(boundary==='Transfer')return transferItem(f.pool,{...args,otherAccountId:f.ids.accounts.savings});
        if(boundary==='Backdated Bill')return backdatedBill(f.pool,{...args,vendorId:f.ids.vendorId,billDate:'2026-10-21',canApprove:true,lines:[{accountId:f.ids.expense,amount:'102.00'}]});
        return settleItem(f.pool,{...args,settle:[{txnId:Number(open.body.txn_id),amountCents:10200}]});
      };
      await assert.rejects(create,/Match the existing integration payment/);
      assert.deepEqual(await bankState(f),before);
      assert.equal(await checkingBalance(f),-10000);
    } finally {await f.close();}
  });
});

test('removed integration group can be undone and rematched to its replacement with a genuine fee',async()=>{
  const f=await outgoingFeeFixture();
  try {
    const original=await bankLine(f,-10000);
    await matchItem(f.pool,{...f.S,itemId:original,actor:'tester',txnIds:f.payments,expect:await shown(f,original,f.payments)});
    await f.pool.query("UPDATE bank_feed_item SET bank_state='removed' WHERE item_id=$1",[original]);
    const id=await bankLine(f,-10200);
    await undoItem(f.pool,{...f.S,itemId:original,actor:'tester'});
    await settleItem(f.pool,{...f.S,itemId:id,actor:'tester',txnIds:f.payments,expect:await shown(f,id,f.payments),
      adjustments:[{accountId:f.ids.expense,cents:200,description:'Sample fee'}]});
    assert.equal(await checkingBalance(f),-10200);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type='bill_payment'")).rows[0].n,2);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM txn WHERE type='journal_entry'")).rows[0].n,1);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bank_feed_link WHERE item_id=$1',[original])).rows[0].n,0);
    assert.equal((await getBankItem(f.pool,{...f.S,itemId:id})).review_state,'matched');
  } finally {await f.close();}
});

test('claimed fee holds preserve account, direction, check and payment/claim date exclusions',async t=>{
  for(const state of ['claimed','removed']) {
    for(const exclusion of ['account','direction','check','payment-too-old','payment-too-new','claim-too-old','claim-too-new',
      ...(state==='claimed'?['distant-active']:[])])await t.test(`${state}: ${exclusion}`,async()=>{
      const f=await outgoingFeeFixture({checks:exclusion==='check'});
      try {
        const original=await bankLine(f,-10000);
        await matchItem(f.pool,{...f.S,itemId:original,actor:'tester',txnIds:f.payments,expect:await shown(f,original,f.payments)});
        if(state==='removed')await f.pool.query("UPDATE bank_feed_item SET bank_state='removed' WHERE item_id=$1",[original]);
        const amount=exclusion==='direction'?10200:-10200,id=await bankLine(f,amount);
        if(exclusion==='account')await f.pool.query('UPDATE ledgerline_account SET books_account_id=$1 WHERE ll_account_id=$2',[f.ids.accounts.savings,f.sampleFeedAccount]);
        if(exclusion==='check')await f.pool.query('UPDATE bank_feed_item SET check_number=$2 WHERE item_id=$1',[id,'1044']);
        if(exclusion.startsWith('payment-'))await f.pool.query('UPDATE txn SET txn_date=$2 WHERE txn_id=ANY($1::bigint[])',
          [f.payments,exclusion==='payment-too-old'?'2026-08-22':'2026-11-02']);
        if(exclusion.startsWith('claim-')||exclusion==='distant-active')await f.pool.query('UPDATE bank_feed_item SET posted_date=$2 WHERE item_id=$1',
          [original,exclusion==='claim-too-old'?'2026-08-22':exclusion==='claim-too-new'?'2026-11-02':'2026-10-16']);
        const before=await f.count('txn');
        await addItem(f.pool,{...f.S,itemId:id,actor:'tester',separate:true,expect:await shown(f,id),
          lines:[{accountId:amount>0?f.ids.income:f.ids.expense,amount:'102.00'}]});
        assert.equal(await f.count('txn'),before+1);
      } finally {await f.close();}
    });
  }
});
