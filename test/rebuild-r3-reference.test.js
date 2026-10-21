import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb,q,invoke,copy,dir } from './rebuild-fixture.js';
import { writeExport, TXNS, OPEN, trialBalanceOf } from './qbo-fixture.js';
import { readQboExport, parseTrialBalance } from '../lib/import/qbo-read.js';
import { importQboCompany } from '../lib/import/qbo-import.js';
import { childCompleteness } from '../lib/rebuild/integrity.js';

test('T4 a missing balanced pair of journal lines invalidates reference completeness',async()=>{
  const src=await makeDb({entity:false}),dst=await makeDb({entity:false});
  const txns=structuredClone(TXNS);txns.find(t=>t[2]==='JE-1')[5].push(['Fuel',100,0],['Repairs',0,100]);
  const exports=join(dir,'t4-exports'), exp=join(exports,'sample-company-a','export');await writeExport(exp,{txns,tb:trialBalanceOf(txns)});
  const data={...await readQboExport(exp),openItems:OPEN.map(o=>({...o})),hasAging:{ar:true,ap:true}};
  await importQboCompany(src.pool,{orgId:1,companyName:'Sample company A',data,actor:'tester'});
  const [t]=await q(src,"SELECT * FROM txn WHERE doc_number='JE-1'");
  const before=(await q(src,'SELECT count(*) n FROM posting WHERE txn_id=$1',[t.txn_id]))[0].n;assert.equal(before,4);
  const balancesSql="SELECT a.name,sum(p.amount_cents) AS cents FROM posting p JOIN account a ON a.account_id=p.account_id WHERE a.name IN ('Fuel','Repairs') GROUP BY a.name ORDER BY a.name";
  const balancesBefore=await q(src,balancesSql);
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,"DELETE FROM posting WHERE txn_id=$1 AND account_id IN (SELECT account_id FROM account WHERE name IN ('Fuel','Repairs'))",[t.txn_id]);
  await q(src,"DELETE FROM txn_line WHERE txn_id=$1 AND account_id IN (SELECT account_id FROM account WHERE name IN ('Fuel','Repairs'))",[t.txn_id]);
  const after=(await q(src,'SELECT count(*) n FROM posting WHERE txn_id=$1',[t.txn_id]))[0].n;assert.equal(after,2);
  const cp=await invoke('copy-books',[src.file,dst.file,'--companies',join(dir,'companies.json'),'--exports',exports,'--apply']),ck=await invoke('rebuild-check',[src.file,'2026-10-20','--companies',join(dir,'companies.json'),'--exports',exports]);
  let targetCheck=null;if(cp.code===0) targetCheck=(await invoke('rebuild-check',[dst.file,'2026-10-20'])).code;
  console.log('T4',JSON.stringify({balancesBefore,balancesAfter:await q(src,balancesSql),beforePostings:before,afterPostings:after,transactions:(await q(src,'SELECT count(*) n FROM txn'))[0].n,summary:(await q(src,'SELECT summary FROM import_batch'))[0].summary,copy:cp.code,copyError:cp.stderr,sourceCheck:ck.code,targetCheck}));
  assert.equal(cp.code,1,cp.stderr); assert.match(cp.stderr,/total_cents|debit postings/); assert.match(cp.stderr,/Trial_balance/); assert.equal((await q(dst,'SELECT count(*) n FROM entity'))[0].n,0);
  assert.equal(ck.code,1,ck.stderr); assert.match(ck.stdout,/total_cents|debit postings/); assert.match(ck.stdout,/Trial_balance/);
});

test('export parity catches damage even when the header and remaining children agree',async()=>{
  const src=await makeDb({entity:false}), dst=await makeDb({entity:false});
  const txns=structuredClone(TXNS); txns.find(t=>t[2]==='JE-1')[5].push(['Fuel',100,0],['Repairs',0,100]);
  const exports=join(dir,'t4-consistent-exports'), exp=join(exports,'sample-company-a','export');
  await writeExport(exp,{txns,tb:trialBalanceOf(txns)});
  await importQboCompany(src.pool,{orgId:1,companyName:'Sample company A',data:{...await readQboExport(exp),openItems:OPEN,hasAging:{ar:true,ap:true}},actor:'tester'});
  const args=['--companies',join(dir,'companies.json'),'--exports',exports];
  const clean=await invoke('copy-books',[src.file,dst.file,...args,'--apply']); assert.equal(clean.code,0,clean.stderr);
  for(const db of [src,dst]) {
    const [t]=await q(db,"SELECT * FROM txn WHERE doc_number='JE-1'");
    await q(db,"SELECT set_config('fb.import','on',false)");
    for(const table of ['posting','txn_line']) await q(db,`DELETE FROM ${table} WHERE txn_id=$1 AND account_id IN (SELECT account_id FROM account WHERE name IN ('Fuel','Repairs'))`,[t.txn_id]);
    await q(db,'UPDATE txn SET total_cents=total_cents-10000 WHERE txn_id=$1',[t.txn_id]);
    const before=await q(db,'SELECT * FROM posting ORDER BY posting_id');
    const checked=await invoke('rebuild-check',[db.file,'2026-10-20',...args]);
    assert.equal(checked.code,1,checked.stderr); assert.match(checked.stdout,/Trial_balance.*Fuel/);
    assert.deepEqual(await q(db,'SELECT * FROM posting ORDER BY posting_id'),before,'yardstick must not repair');
  }
  const empty=await makeDb({entity:false});
  const copied=await invoke('copy-books',[src.file,empty.file,...args,'--apply']);
  assert.equal(copied.code,1); assert.match(copied.stderr,/Trial_balance/);
  assert.equal((await q(empty,'SELECT count(*) n FROM entity'))[0].n,0);
});

test('lines must agree with postings per account even when trial balance and debit total match',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({entity:false});
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,"UPDATE txn_line SET account_id=(SELECT account_id FROM account WHERE name='Fuel') WHERE txn_id=(SELECT txn_id FROM txn WHERE doc_number='JE-1') AND amount_cents>0");
  const before=await q(src,'SELECT * FROM txn_line ORDER BY txn_id,line_no');
  const copied=await copy(src,dst),checked=await invoke('rebuild-check',[src.file,'2026-10-20']);
  assert.equal(copied.code,1); assert.match(copied.stderr,/lines.*postings.*account/);
  assert.equal(checked.code,1); assert.match(checked.stdout,/lines.*postings.*account/);
  assert.deepEqual(await q(src,'SELECT * FROM txn_line ORDER BY txn_id,line_no'),before);
  assert.equal((await q(dst,'SELECT count(*) n FROM entity'))[0].n,0);
});

test('only recorded acceptedMismatches amounts authorize exact-cent export differences',async()=>{
  const src=await makeDb({entity:false}),dst=await makeDb({entity:false});
  const exports=join(dir,'accepted-exports'),exp=join(exports,'sample-company-a','export');
  const tb=trialBalanceOf(TXNS); tb.set('Fuel',tb.get('Fuel')+1);
  await writeExport(exp,{tb});
  await importQboCompany(src.pool,{orgId:1,companyName:'Sample company A',data:{...await readQboExport(exp),openItems:OPEN,hasAging:{ar:true,ap:true}},acceptMismatches:['Fuel'],actor:'tester'});
  const args=['--companies',join(dir,'companies.json'),'--exports',exports];
  assert.equal((await invoke('rebuild-check',[src.file,'2026-10-20',...args])).code,0);
  const clean=await invoke('copy-books',[src.file,dst.file,...args,'--apply']); assert.equal(clean.code,0,clean.stderr);
  await q(src,"UPDATE import_batch SET summary=jsonb_set(summary,'{acceptedMismatches}','[]')");
  const checked=await invoke('rebuild-check',[src.file,'2026-10-20',...args]);
  assert.equal(checked.code,1); assert.match(checked.stdout,/Trial_balance.*Fuel/);
  const missing=await invoke('rebuild-check',[dst.file,'2026-10-20','--companies',join(dir,'companies.json'),'--exports',join(dir,'missing-exports')]);
  assert.equal(missing.code,1); assert.match(missing.stdout+missing.stderr,/Trial_balance/);
});

test('trial balance evidence rejects missing headers and duplicate account identities',()=>{
  assert.throws(()=>parseTrialBalance([['Sample account',1,0]]),/header/);
  assert.throws(()=>parseTrialBalance([[null,'Debit','Credit'],['Sample account',1,0],['Sample account',2,0]]),/duplicate/);
  assert.equal(parseTrialBalance([[null,'Debit','Credit'],['Sample account',0.01,0]])['Sample account'],1);
});

test('exports follow company slugs and numbered accounts; mismatch acceptance stays company scoped',async()=>{
  const src=await makeDb({entity:false}),dst=await makeDb({entity:false}),exports=join(dir,'two-company-exports');
  const companies=join(dir,'two-company-map.json');
  const entries=[{fbName:'Sample company A',slug:'sample-alpha'},{fbName:'Sample company B',slug:'sample-beta'}];
  await writeFile(companies,JSON.stringify({companies:entries}));
  for(const co of entries) {
    const tb=trialBalanceOf(TXNS),fuel=tb.get('Fuel');tb.delete('Fuel');tb.set('6000 Fuel',fuel+1);
    const exp=join(exports,co.slug,'export'); await writeExport(exp,{tb});
    const data={...await readQboExport(exp),openItems:OPEN,hasAging:{ar:true,ap:true}};
    data.accounts.find(a=>a.name==='Fuel').number='6000';
    await importQboCompany(src.pool,{orgId:1,companyName:co.fbName,data,acceptMismatches:['6000 Fuel'],actor:'tester'});
  }
  const args=['--companies',companies,'--exports',exports];
  const clean=await invoke('copy-books',[src.file,dst.file,...args,'--apply']);assert.equal(clean.code,0,clean.stderr);
  assert.equal((await invoke('rebuild-check',[dst.file,'2026-10-20',...args])).code,0);
  await q(dst,"UPDATE import_batch SET summary=jsonb_set(summary,'{acceptedMismatches}','[]') WHERE company_name='Sample company B'");
  const checked=await invoke('rebuild-check',[dst.file,'2026-10-20',...args]);
  assert.equal(checked.code,1);assert.match(checked.stdout,/Trial_balance.xlsx for Sample company B: 6000 Fuel/);
});

test('zeroing a header and deleting postings cannot hide surviving economic lines',async()=>{
  const db=await makeDb({imported:true});
  await q(db,"SELECT set_config('fb.import','on',false)");
  await q(db,"DELETE FROM posting WHERE txn_id=(SELECT txn_id FROM txn WHERE doc_number='JE-1')");
  await q(db,"UPDATE txn SET total_cents=0 WHERE doc_number='JE-1'");
  const result=await childCompleteness(db.pool);
  assert.ok(result.errors.some(e=>/JE-1.*lines/.test(e)));
});
