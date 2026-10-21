import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeDb,q,invoke,copy,saved,apply,dir,companyFile } from './rebuild-fixture.js';
import { writeExport,TXNS,OPEN,trialBalanceOf } from './qbo-fixture.js';
import { readQboExport } from '../lib/import/qbo-read.js';
import { importQboCompany } from '../lib/import/qbo-import.js';
import { saveDeposit } from '../lib/data/deposits.js';
import { saveAccount } from '../lib/data/ledger.js';
import { saveJournalEntry } from '../lib/data/ledger-tools.js';
import { validateCarryCounts } from '../lib/rebuild/carry-validation.js';
import { carryOverReport } from '../lib/rebuild/carry-over.js';
import { saveLoanSetup } from '../lib/data/loans.js';

const check = (db,args=[])=>invoke('rebuild-check',[db.file,'2026-10-20',...args]);
async function imported(db,root,txns=TXNS,tb=trialBalanceOf(txns),acceptMismatches=[]) {
  const exp=join(root,'sample-company-a','export'); await writeExport(exp,{txns,tb});
  return importQboCompany(db.pool,{orgId:1,companyName:'Sample company A',
    data:{...await readQboExport(exp),openItems:OPEN,hasAging:{ar:true,ap:true}},acceptMismatches,actor:'review-test'});
}
const resultSummary=r=>({code:r.code,stderr:r.stderr});

test('U4 a normal account-type edit must be restored or disclosed',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  const [account]=await q(src,"SELECT * FROM account WHERE name='Fuel'");
  await saveAccount(src.pool,{orgId:1,entityId:1,accountId:account.account_id,fields:{...account,type:'cost_of_goods_sold',parentId:null}});
  const data=await saved(src);await validateCarryCounts(src.pool,data);
  const report=await apply(dst,data);
  const shape="SELECT a.name,a.type,sum(p.amount_cents)::text AS cents FROM account a JOIN posting p USING(account_id) WHERE a.name='Fuel' GROUP BY a.name,a.type";
  console.log('U4',JSON.stringify({original:await q(src,shape),rebuilt:await q(dst,shape),audit:await q(src,"SELECT before,after FROM audit_log WHERE table_name='account' AND row_id=$1 ORDER BY audit_id DESC LIMIT 1",[account.account_id]),accountChanges:data.companies[0].accountChanges,decisions:report.decisions,leftovers:report.leftovers,skipped:report.skipped}));
  assert.ok(report.decisions.some(d=>d.name==='Fuel') || (await q(dst,"SELECT type FROM account WHERE name='Fuel'"))[0].type==='cost_of_goods_sold','the account classification was silently discarded');
  assert.ok(data.companies[0].accountChanges.some(d=>d.column==='type' && d.beforeValue==='expense' && d.afterValue==='cost_of_goods_sold'));
  assert.ok((await apply(dst,data,'books',true)).decisions.some(d=>d.name==='Fuel' && d.kind==='type changed'));
  assert.ok(carryOverReport(data).decisions.some(d=>d.name==='Fuel' && d.kind==='type changed'));
});

test('loan pairing audit decisions carry natural references for both companies',async()=>{
  const db=await makeDb({imported:true});
  const [other]=await q(db,"INSERT INTO entity(org_id,name) VALUES(1,'Sample company B') RETURNING entity_id");
  const payable=await saveAccount(db.pool,{orgId:1,entityId:1,fields:{name:'Sample payable',type:'long_term_liability'}});
  const receivable=await saveAccount(db.pool,{orgId:1,entityId:other.entity_id,fields:{name:'Sample receivable',type:'other_current_asset'}});
  await saveLoanSetup(db.pool,{orgId:1,entityId:1,accountId:payable,list:'show',otherAccountId:receivable,openEntityIds:[other.entity_id]});
  const data=await saved(db);
  const a=data.companies.find(c=>c.name==='Sample company A').accountChanges.find(a=>a.column==='loan_other_account_id');
  const b=data.companies.find(c=>c.name==='Sample company B').accountChanges.find(a=>a.column==='loan_other_account_id');
  assert.equal(a.kind,'loan pairing changed');
  assert.deepEqual(a.afterValue,{company:'Sample company B',account:'Sample receivable'});
  assert.deepEqual(b.afterValue,{company:'Sample company A',account:'Sample payable'});
  await validateCarryCounts(db.pool,data);
});

test('repeated account edits retain their audit sequence, and deletion is disclosed',async()=>{
  const db=await makeDb({imported:true});
  const id=await saveAccount(db.pool,{orgId:1,entityId:1,fields:{name:'Sample temporary account',type:'expense'}});
  for (const description of ['Sample A','Sample B','Sample A','Sample B']) {
    await saveAccount(db.pool,{orgId:1,entityId:1,accountId:id,fields:{name:'Sample temporary account',type:'expense',description}});
  }
  let data=await saved(db);await validateCarryCounts(db.pool,data);
  assert.deepEqual(data.companies[0].accountChanges.filter(a=>a.column==='description').map(a=>a.afterValue),['Sample A','Sample B','Sample A','Sample B']);
  await q(db,'DELETE FROM account WHERE account_id=$1',[id]);
  data=await saved(db);await validateCarryCounts(db.pool,data);
  assert.ok(data.companies[0].accountChanges.some(a=>a.kind==='deleted' && a.name==='Sample temporary account'));
});

test('every audited account property becomes a decision, including combined changes and future columns',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  assert.deepEqual((await saved(src)).companies[0].accountChanges,[],'importer account setup is not a native change');
  const accountId=await saveAccount(src.pool,{orgId:1,entityId:1,fields:{name:'Sample editable account',type:'expense'}});
  const [fuel]=await q(src,'SELECT * FROM account WHERE account_id=$1',[accountId]);
  const [repairs]=await q(src,"SELECT * FROM account WHERE name='Repairs'");
  await saveAccount(src.pool,{orgId:1,entityId:1,accountId:fuel.account_id,fields:{...fuel,name:'Sample renamed fuel',number:'6123',description:'Sample description',parentId:repairs.account_id,active:false}});
  // Jobs use actor=system too; a post-import edit must still be disclosed.
  await q(src,"SELECT set_config('app.actor','system',false)");
  await q(src,"UPDATE account SET loan_list='show' WHERE account_id=$1",[fuel.account_id]);
  await q(src,'ALTER TABLE account ADD COLUMN sample_property text');
  await q(src,"UPDATE account SET sample_property='Sample future value' WHERE account_id=$1",[fuel.account_id]);
  const data=await saved(src),changes=data.companies[0].accountChanges.filter(a=>a.kind!=='created');
  for (const col of ['name','number','description','parent_id','active','loan_list','sample_property']) {
    assert.ok(changes.some(a=>a.column===col),col);
  }
  assert.ok(changes.some(a=>a.kind==='account changed (sample_property)'));
  assert.equal(changes.find(a=>a.column==='parent_id').afterValue,'Repairs');
  await validateCarryCounts(src.pool,data);
  for (const report of [await apply(dst,data),await apply(dst,data,'books',true),carryOverReport(data)]) {
    for (const change of changes) assert.ok(report.decisions.some(d=>d.kind===change.kind && d.name===change.name),change.kind);
  }
  assert.equal((await q(dst,"SELECT name FROM account WHERE name='Fuel'")).length,1,'account edits remain manual decisions');
});
