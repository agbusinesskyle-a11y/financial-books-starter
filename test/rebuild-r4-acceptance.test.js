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

const check = (db,args=[])=>invoke('rebuild-check',[db.file,'2026-10-20',...args]);
async function imported(db,root,txns=TXNS,tb=trialBalanceOf(txns),acceptMismatches=[]) {
  const exp=join(root,'sample-company-a','export'); await writeExport(exp,{txns,tb});
  return importQboCompany(db.pool,{orgId:1,companyName:'Sample company A',
    data:{...await readQboExport(exp),openItems:OPEN,hasAging:{ar:true,ap:true}},acceptMismatches,actor:'review-test'});
}
const resultSummary=r=>({code:r.code,stderr:r.stderr});

test('U2 a recorded one-cent acceptance must not waive a new hundred-dollar difference',async()=>{
  const src=await makeDb({entity:false}),dst=await makeDb({entity:false}),root=join(dir,'u2-exports');
  const tb=trialBalanceOf(TXNS);tb.set('Fuel',tb.get('Fuel')+1);tb.set('Repairs',tb.get('Repairs')-1);
  await imported(src,root,TXNS,tb,['Fuel','Repairs']);
  const args=['--companies',companyFile,'--exports',root];
  assert.equal((await check(src,args)).code,0);
  const accepted=(await q(src,'SELECT summary FROM import_batch'))[0].summary.acceptedMismatches;
  const [t]=await q(src,"SELECT * FROM txn WHERE doc_number='JE-1'");
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,'BEGIN');
  try {
    await q(src,"INSERT INTO txn_line(org_id,txn_id,line_no,account_id,quantity,rate_cents,amount_cents) SELECT 1,$1,CASE name WHEN 'Fuel' THEN 3 ELSE 4 END,account_id,1,CASE name WHEN 'Fuel' THEN 10000 ELSE -10000 END,CASE name WHEN 'Fuel' THEN 10000 ELSE -10000 END FROM account WHERE name IN ('Fuel','Repairs')",[t.txn_id]);
    await q(src,"INSERT INTO posting(org_id,entity_id,txn_id,line_no,account_id,amount_cents,txn_date,memo) SELECT 1,1,$1,CASE name WHEN 'Fuel' THEN 3 ELSE 4 END,account_id,CASE name WHEN 'Fuel' THEN 10000 ELSE -10000 END,$2,$3 FROM account WHERE name IN ('Fuel','Repairs')",[t.txn_id,t.txn_date,t.memo]);
    await q(src,'UPDATE txn SET total_cents=total_cents+10000 WHERE txn_id=$1',[t.txn_id]);
    await q(src,'COMMIT');
  } catch(e) {await q(src,'ROLLBACK');throw e;}
  const copied=await invoke('copy-books',[src.file,dst.file,...args,'--apply']),source=await check(src,args),target=copied.code===0?await check(dst,args):null;
  const parsed=JSON.parse(source.stdout.split('\nSample company A balanced:')[0]);
  console.log('U2',JSON.stringify({accepted,differences:parsed.exportEvidence.companies[0].differences,copy:resultSummary(copied),source:resultSummary(source),target:target&&resultSummary(target)}));
  assert.notEqual(copied.code,0,'copy treated the accepted account names as unlimited waivers');
  assert.notEqual(source.code,0);
  assert.ok(parsed.exportEvidence.companies[0].differences.every(d=>!d.accepted),'new drift must not be labeled accepted even when Journal validation independently refuses it');
  assert.ok(parsed.exportEvidence.errors.some(e=>/Trial_balance.xlsx.*balance differs/.test(e)));
});

test('accepted differences bind exact signed cents and retained account values, not just names or prefixes',async()=>{
  const db=await makeDb({entity:false}),root=join(dir,'accepted-cents');
  const tb=trialBalanceOf(TXNS);tb.set('Fuel',tb.get('Fuel')+1);tb.set('Repairs',tb.get('Repairs')-1);
  await imported(db,root,TXNS,tb,['Fuel','Repairs']);
  const evidence=await readExportEvidence(root,[{fbName:'Sample company A',slug:'sample-company-a'}]);
  const original=(await q(db,'SELECT summary FROM import_batch'))[0].summary.acceptedMismatches;
  const pristine=await exportEvidence(db.pool,evidence);
  assert.deepEqual(pristine.errors,[]);
  assert.ok(pristine.companies[0].differences.every(d=>d.accepted));
  const fuelOriginal=original.find(s=>s.startsWith('Fuel:'));
  for (const recorded of ['Fuel', 'Fuel: QuickBooks 430.56, here 530.55', 'Fuel: QuickBooks 430.55, here 430.56',
    'Fuel: QuickBooks 430.560, here 430.55', 'Fuel: not on QuickBooks', 'Fuel: QuickBooks 0.00, here -0.01']) {
    await q(db,"UPDATE import_batch SET summary=jsonb_set(summary,'{acceptedMismatches}',$1::jsonb)",[JSON.stringify(original.map(s=>s===fuelOriginal?recorded:s))]);
    const result=await exportEvidence(db.pool,evidence);
    assert.equal(result.companies[0].differences.find(d=>d.account==='Fuel').accepted,false,recorded);
    assert.ok(result.errors.some(e=>/Trial_balance.*Fuel/.test(e)));
  }
  await q(db,"UPDATE import_batch SET summary=jsonb_set(summary,'{acceptedMismatches}',$1::jsonb)",[JSON.stringify(original)]);
  const changed=structuredClone(evidence);changed[0].trialBalance.Fuel+=10000;
  assert.equal((await exportEvidence(db.pool,changed)).companies[0].differences.find(d=>d.account==='Fuel').accepted,false);
  const nowEqual=structuredClone(evidence);nowEqual[0].trialBalance.Fuel-=1;
  assert.ok((await exportEvidence(db.pool,nowEqual)).errors.some(e=>/Trial_balance.*Fuel/.test(e)),'changing the export to erase an approved difference still changes its evidence');
});

test('negative and absent-export balances retain only their exact recorded differences',async()=>{
  const db=await makeDb({entity:false}),root=join(dir,'negative-accepted-cents');
  const tb=trialBalanceOf(TXNS);tb.set('Owner Equity',tb.get('Owner Equity')-1);tb.delete('Bad Debt');
  await imported(db,root,TXNS,tb,['Owner Equity','Bad Debt']);
  const evidence=await readExportEvidence(root,[{fbName:'Sample company A',slug:'sample-company-a'}]);
  const result=await exportEvidence(db.pool,evidence);
  assert.deepEqual(result.errors,[]);
  assert.ok(result.companies[0].differences.every(d=>d.accepted));
  const badDebt=result.companies[0].differences.find(d=>d.account==='Bad Debt');
  assert.equal(badDebt.expectedCents,'0');assert.equal(badDebt.actualCents,'45000');
  await q(db,"UPDATE import_batch SET summary=jsonb_set(summary,'{acceptedMismatches}',(summary->'acceptedMismatches') || (summary->'acceptedMismatches'))");
  assert.ok((await exportEvidence(db.pool,evidence)).companies[0].differences.every(d=>!d.accepted),'ambiguous duplicate approvals refuse');
});
