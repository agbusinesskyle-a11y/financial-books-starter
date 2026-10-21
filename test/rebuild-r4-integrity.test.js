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
import { exportEvidence, readExportEvidence } from '../lib/rebuild/export-evidence.js';
import { childCompleteness } from '../lib/rebuild/integrity.js';
import { exportsFolder } from './rebuild-fixture.js';
import { unlink } from 'node:fs/promises';

const check = (db,args=[])=>invoke('rebuild-check',[db.file,'2026-10-20',...args]);
async function imported(db,root,txns=TXNS,tb=trialBalanceOf(txns),acceptMismatches=[]) {
  const exp=join(root,'sample-company-a','export'); await writeExport(exp,{txns,tb});
  return importQboCompany(db.pool,{orgId:1,companyName:'Sample company A',
    data:{...await readQboExport(exp),openItems:OPEN,hasAging:{ar:true,ap:true}},acceptMismatches,actor:'review-test'});
}
const resultSummary=r=>({code:r.code,stderr:r.stderr});

test('U1 posting dates inconsistent with their transaction must fail both gates',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({entity:false});
  assert.equal((await check(src)).code,0);
  const [t]=await q(src,"SELECT txn_id,txn_date FROM txn WHERE doc_number='JE-1'");
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,"UPDATE posting SET txn_date='2024-01-31' WHERE txn_id=$1",[t.txn_id]);
  const mismatch=await q(src,'SELECT t.doc_number,t.txn_date AS header_date,p.txn_date AS posting_date,p.amount_cents FROM posting p JOIN txn t USING(txn_id) WHERE p.txn_date<>t.txn_date');
  const copied=await copy(src,dst),source=await check(src),target=copied.code===0?await check(dst):null;
  console.log('U1',JSON.stringify({mismatch,copy:resultSummary(copied),source:resultSummary(source),target:target&&resultSummary(target)}));
  assert.notEqual(copied.code,0,'copy certified postings in the wrong accounting period');
  assert.notEqual(source.code,0,'yardstick certified postings in the wrong accounting period');
  assert.match(copied.stderr,/posting date differs.*transaction date/);
  assert.deepEqual(await q(src,'SELECT t.doc_number,t.txn_date AS header_date,p.txn_date AS posting_date,p.amount_cents FROM posting p JOIN txn t USING(txn_id) WHERE p.txn_date<>t.txn_date'),mismatch);
  assert.equal((await q(dst,'SELECT count(*) n FROM entity'))[0].n,0);
});

test('U5 offsetting lost journal pairs must not be certified by an unchanged closing balance',async()=>{
  const src=await makeDb({entity:false}),dst=await makeDb({entity:false}),root=join(dir,'u5-exports');
  const txns=structuredClone(TXNS),a=txns.find(t=>t[2]==='JE-1'),b=txns.find(t=>t[2]==='JE-2');
  a[0]='01/31/2024';a[5].push(['Fuel',100,0],['Repairs',0,100]);b[5].push(['Repairs',100,0],['Fuel',0,100]);
  await imported(src,root,txns);const args=['--companies',companyFile,'--exports',root];
  assert.equal((await check(src,args)).code,0);
  const month="SELECT a.name,sum(p.amount_cents)::text AS cents FROM posting p JOIN account a USING(account_id) WHERE a.name IN ('Fuel','Repairs') AND p.txn_date<='2024-01-31' GROUP BY a.name ORDER BY a.name";
  const before=await q(src,month),batchBefore=await q(src,'SELECT summary FROM import_batch');
  await q(src,"SELECT set_config('fb.import','on',false)");
  for(const doc of ['JE-1','JE-2']) {
    const [t]=await q(src,'SELECT txn_id FROM txn WHERE doc_number=$1',[doc]);
    for(const table of ['posting','txn_line']) await q(src,`DELETE FROM ${table} WHERE txn_id=$1 AND account_id IN (SELECT account_id FROM account WHERE name IN ('Fuel','Repairs'))`,[t.txn_id]);
    await q(src,'UPDATE txn SET total_cents=total_cents-10000 WHERE txn_id=$1',[t.txn_id]);
  }
  assert.deepEqual(await q(src,'SELECT summary FROM import_batch'),batchBefore);
  const damaged=await q(src,month);
  const copied=await invoke('copy-books',[src.file,dst.file,...args,'--apply']),source=await check(src,args),target=copied.code===0?await check(dst,args):null;
  console.log('U5',JSON.stringify({januaryBefore:before,januaryAfter:await q(src,month),copy:resultSummary(copied),source:resultSummary(source),target:target&&resultSummary(target)}));
  assert.notEqual(copied.code,0,'copy certified missing children that cancel in the closing trial balance');
  assert.notEqual(source.code,0);
  assert.match(copied.stderr,/Journal.xlsx.*2024-01.*Fuel.*debit/);
  assert.deepEqual((await childCompleteness(src.pool)).errors,[],'remaining lines correctly agree; retained Journal must catch the loss');
  assert.deepEqual(await q(src,month),damaged,'checks must not repair history');
  assert.equal((await q(dst,'SELECT count(*) n FROM entity'))[0].n,0);
});

test('posting dates must equal header dates even within the same month',async()=>{
  const db=await makeDb({imported:true});
  await q(db,"SELECT set_config('fb.import','on',false)");
  await q(db,"UPDATE posting SET txn_date='2024-12-01' WHERE txn_id=(SELECT txn_id FROM txn WHERE doc_number='JE-1')");
  const evidence=await readExportEvidence(exportsFolder,[{fbName:'Sample company A',slug:'sample-company-a'}]);
  assert.deepEqual((await exportEvidence(db.pool,evidence)).errors,[],'monthly totals are unchanged');
  const checked=await childCompleteness(db.pool);
  assert.ok(checked.errors.some(e=>/posting date differs/.test(e)));
  assert.ok(checked.errors.some(e=>/per account and date/.test(e)));
});

test('Journal evidence accounts for zero-amount omissions, companions and type remaps, independent of batch counts',async()=>{
  const db=await makeDb({imported:true});
  const evidence=await readExportEvidence(exportsFolder,[{fbName:'Sample company A',slug:'sample-company-a'}]);
  const before=await exportEvidence(db.pool,evidence),journal=before.companies[0].journal;
  assert.deepEqual(before.errors,[]);
  assert.equal(journal.omitted,1);
  assert.equal(journal.companions,1);
  assert.equal(journal.transactions,TXNS.length-1);
  assert.equal(journal.primaryTransactions,journal.transactions);
  assert.equal(journal.importedTransactions,journal.transactions+journal.companions);
  assert.ok((await q(db,"SELECT 1 FROM txn WHERE source_type='Deposit' AND type='journal_entry'")).length);
  await q(db,"SELECT set_config('fb.import','on',false)");
  await q(db,"DELETE FROM txn WHERE doc_number='JE-1'");
  await q(db,"UPDATE import_batch SET summary=jsonb_set(summary,'{transactions}',to_jsonb((SELECT count(*) FROM txn)))");
  const after=await exportEvidence(db.pool,evidence);
  assert.ok(after.errors.some(e=>/Journal.xlsx.*transaction count/.test(e)));
});

test('retained Journal is mandatory even when the trial balance still exists',async()=>{
  const db=await makeDb({entity:false}),root=join(dir,'missing-journal');
  await imported(db,root);
  await unlink(join(root,'sample-company-a','export','Journal.xlsx'));
  const result=await check(db,['--exports',root]);
  assert.equal(result.code,1);
  assert.match(result.stderr,/Journal.xlsx.*missing or invalid/);
});

test('gross monthly debit and credit evidence detects pairs that cancel within one month',async()=>{
  const db=await makeDb({entity:false}),root=join(dir,'same-month-pairs');
  const txns=structuredClone(TXNS);
  txns.find(t=>t[2]==='JE-1')[5].push(['Fuel',100,0],['Repairs',0,100]);
  txns.find(t=>t[2]==='JE-2')[5].push(['Repairs',100,0],['Fuel',0,100]);
  await imported(db,root,txns);
  const evidence=await readExportEvidence(root,[{fbName:'Sample company A',slug:'sample-company-a'}]);
  assert.deepEqual((await exportEvidence(db.pool,evidence)).errors,[]);
  await q(db,"SELECT set_config('fb.import','on',false)");
  for(const table of ['posting','txn_line']) await q(db,`DELETE FROM ${table} WHERE txn_id IN (SELECT txn_id FROM txn WHERE doc_number IN ('JE-1','JE-2')) AND account_id IN (SELECT account_id FROM account WHERE name IN ('Fuel','Repairs'))`);
  await q(db,"UPDATE txn SET total_cents=total_cents-10000 WHERE doc_number IN ('JE-1','JE-2')");
  const result=await exportEvidence(db.pool,evidence);
  assert.deepEqual(result.companies[0].differences,[],'closing balances still agree');
  assert.ok(result.errors.some(e=>/2024-12 Fuel debit/.test(e)));
  assert.ok(result.errors.some(e=>/2024-12 Fuel credit/.test(e)));
});
