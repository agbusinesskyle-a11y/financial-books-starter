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

const check = (db,args=[])=>invoke('rebuild-check',[db.file,'2026-10-20',...args]);
async function imported(db,root,txns=TXNS,tb=trialBalanceOf(txns),acceptMismatches=[]) {
  const exp=join(root,'sample-company-a','export'); await writeExport(exp,{txns,tb});
  return importQboCompany(db.pool,{orgId:1,companyName:'Sample company A',
    data:{...await readQboExport(exp),openItems:OPEN,hasAging:{ar:true,ap:true}},acceptMismatches,actor:'review-test'});
}
const resultSummary=r=>({code:r.code,stderr:r.stderr});

test('U3 deposit details made by the normal writer must survive or become a decision',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  const [old]=await q(src,"SELECT * FROM txn WHERE type='deposit'");
  const [line]=await q(src,'SELECT * FROM deposit_line WHERE deposit_txn_id=$1',[old.txn_id]);
  assert.ok(old && line);
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,'DELETE FROM txn WHERE txn_id=$1',[old.txn_id]);
  const id=await saveDeposit(src.pool,{orgId:1,entityId:1,actor:'review-test',accountId:old.account_id,txnDate:old.txn_date,memo:old.memo,
    otherLines:[{accountId:line.account_id,customerId:line.customer_id,amount:(line.amount_cents/100).toFixed(2),description:'Sample contribution: restricted to engine reserve'}]});
  const data=await saved(src),report=await apply(dst,data),preview=await apply(dst,data,'books',true);
  const sourceDetail=await q(src,'SELECT description FROM deposit_line WHERE deposit_txn_id=$1',[id]);
  const targetDetail=await q(dst,'SELECT description FROM deposit_line WHERE deposit_txn_id=$1',[old.txn_id]);
  console.log('U3',JSON.stringify({sourceDetail,targetDetail,savedHasDetail:JSON.stringify(data).includes('restricted to engine reserve'),native:data.companies[0].nativeTransactions.length,skipped:report.skipped,decisions:report.decisions,previewDecisions:preview.decisions,leftovers:report.leftovers}));
  assert.ok(report.decisions.some(d=>d.type==='deposit'),'different deposit detail silently matched as already imported');
  assert.ok(preview.decisions.some(d=>d.type==='deposit'));
  assert.equal(data.companies[0].nativeTransactions[0].depositLines[0].description,sourceDetail[0].description);
  assert.equal(data.companies[0].nativeTransactions[0].depositLines[0].account,'Owner Equity');
});

test('U6 a genuine save of different native entries with identical summary keys remains valid',async()=>{
  const db=await makeDb({imported:true});
  const accounts=Object.fromEntries((await q(db,'SELECT name,account_id FROM account')).map(a=>[a.name,a.account_id]));
  for(const name of ['Fuel','Repairs']) await saveDeposit(db.pool,{orgId:1,entityId:1,txnDate:'2024-01-31',actor:'review-test',accountId:accounts.Operating,
    otherLines:[{accountId:accounts[name],amount:'100.00',description:'Sample refund'}]});
  // Both entries have distinct lines; the new normalizer uses only header-summary fields as a uniqueness key.
  const data=await saved(db);let error=null;try{await validateCarryCounts(db.pool,data);}catch(e){error=e.message;}
  console.log('U6',JSON.stringify({nativeCount:data.companies[0].nativeTransactions.length,error}));
  assert.equal(error,null,'an unchanged save is refused for legitimate duplicate summary keys');
  const substituted=structuredClone(data);
  substituted.companies[0].nativeTransactions[1]=structuredClone(substituted.companies[0].nativeTransactions[0]);
  await assert.rejects(validateCarryCounts(db.pool,substituted),/content mismatch/);
});

test('application and tag children use natural identities and cannot disappear from a native match',async()=>{
  const db=await makeDb({imported:true});
  await q(db,"SELECT set_config('fb.import','on',false)");
  const [t]=await q(db,'SELECT t.* FROM txn t JOIN application a ON a.charge_txn_id=t.txn_id LIMIT 1');
  await q(db,"UPDATE txn SET source=NULL WHERE txn_id=$1",[t.txn_id]);
  await q(db,"INSERT INTO tag_group(org_id,entity_id,name) VALUES(1,1,'Sample group')");
  await q(db,"INSERT INTO tag(org_id,entity_id,group_id,name) SELECT 1,1,group_id,'Sample restriction' FROM tag_group");
  await q(db,'INSERT INTO txn_tag(org_id,txn_id,tag_id) SELECT 1,$1,tag_id FROM tag',[t.txn_id]);
  const data=await saved(db),native=data.companies[0].nativeTransactions[0];
  assert.ok(native.applications.length);
  assert.equal(native.applications[0].chargeTxn.docNumber,t.doc_number);
  assert.deepEqual(native.tags,[{tag:{name:'Sample restriction',group:'Sample group'}}]);
  await validateCarryCounts(db.pool,data);
  await q(db,"UPDATE txn SET source='qbo_import' WHERE txn_id=$1",[t.txn_id]);
  assert.ok((await apply(db,data)).skipped.some(d=>/present/.test(d.why)));
  for (const child of ['applications','tags']) {
    const changed=structuredClone(data);changed.companies[0].nativeTransactions[0][child]=[];
    assert.ok((await apply(db,changed)).decisions.some(d=>d.docNumber===t.doc_number),child);
    await assert.rejects(validateCarryCounts(db.pool,changed));
  }
});

test('new transaction child tables discovered in the catalog prevent an equality claim',async()=>{
  const db=await makeDb({imported:true});
  await q(db,"SELECT set_config('fb.import','on',false)");
  await q(db,"UPDATE txn SET source=NULL WHERE doc_number='JE-1'");
  await q(db,'CREATE TABLE sample_child(org_id bigint, txn_id bigint REFERENCES txn(txn_id), detail text)');
  await q(db,"INSERT INTO sample_child SELECT 1,txn_id,'Sample detail' FROM txn WHERE doc_number='JE-1'");
  const data=await saved(db),native=data.companies[0].nativeTransactions[0];
  assert.equal(native.identityRepresentable,false);
  assert.deepEqual(native.unrepresentedChildren,[{table:'sample_child',column:'txn_id',count:1}]);
  await q(db,"UPDATE txn SET source='qbo_import' WHERE doc_number='JE-1'");
  assert.ok((await apply(db,data)).decisions.some(d=>d.docNumber==='JE-1'));
});

test('printable native application reports omit document addresses and free-text children',async()=>{
  const db=await makeDb({imported:true});
  await q(db,"SELECT set_config('fb.import','on',false)");
  await q(db,"UPDATE application SET source=NULL");
  await q(db,"UPDATE txn SET bill_to='Sample private application address'");
  const data=await saved(db);
  assert.ok(JSON.stringify(data).includes('Sample private application address'));
  for (const report of [carryOverReport(data),carryOverReport(await apply(db,data)),carryOverReport(await apply(db,data,'books',true))]) {
    assert.equal(JSON.stringify(report).includes('Sample private application address'),false);
  }
});

test('U7 printable native-difference reports do not include document addresses',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  await q(src,"SELECT set_config('fb.import','on',false)");await q(src,"UPDATE txn SET source=NULL WHERE doc_number='JE-1'");
  await q(dst,"SELECT set_config('fb.import','on',false)");await q(dst,"UPDATE txn SET bill_to='Sample private document address' WHERE doc_number='JE-1'");
  const report=carryOverReport(await apply(dst,await saved(src)));
  const leaked=JSON.stringify(report).includes('Sample private document address');
  console.log('U7',JSON.stringify({addressInPrintableReport:leaked}));
  assert.equal(leaked,false);
});
