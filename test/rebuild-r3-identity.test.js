import { PG_DUMP } from './pg-clients.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb,q,invoke,copy,saved,apply,dir,runFile,rehearse } from './rebuild-fixture.js';
import { validateCarryStructure, validateCarryCounts } from '../lib/rebuild/carry-validation.js';
import { saveJournalEntry } from '../lib/data/ledger-tools.js';
import { encryptSecret } from '../lib/secrets.js';
import { tableCounts } from '../lib/rebuild/dump.js';
import { writeExport, TXNS, OPEN, trialBalanceOf } from './qbo-fixture.js';
import { readQboExport } from '../lib/import/qbo-read.js';
import { importQboCompany } from '../lib/import/qbo-import.js';
import { identityColumns } from '../lib/rebuild/transaction-identity.js';

async function backup(db,data,label) {
  const carry=join(dir,label+'.json'),dump=join(dir,label+'.dump');
  await writeFile(carry,JSON.stringify(data)); await utimes(carry,new Date(0),new Date(0));
  await runFile(PG_DUMP,['-Fc','-d',db.url,'-f',dump]);
  const receipt=await rehearse(dump);
  return {carry,dump,receipt,args:['--carry-over',carry,'--dump',dump,'--rehearsed',receipt,'--apply']};
}

test('T3 normal adjusting journal writer must remain an accounting difference',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  const [t]=await q(src,"SELECT * FROM txn WHERE doc_number='JE-1'");
  const lines=await q(src,'SELECT * FROM txn_line WHERE txn_id=$1 ORDER BY line_no',[t.txn_id]);
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,'UPDATE txn SET source=NULL WHERE txn_id=$1',[t.txn_id]);
  await saveJournalEntry(src.pool,{orgId:1,entityId:1,txnId:t.txn_id,txnDate:t.txn_date,docNumber:t.doc_number,memo:t.memo,actor:'review-test',adjusting:true,
    lines:lines.map(l=>({accountId:l.account_id,debit:l.amount_cents>0?(l.amount_cents/100).toFixed(2):'',credit:l.amount_cents<0?(-l.amount_cents/100).toFixed(2):''}))});
  const data=await saved(src),report=await apply(dst,data),preview=await apply(dst,data,'books',true);
  const shape="SELECT a.name,p.amount_cents FROM posting p JOIN txn t USING(txn_id) JOIN account a ON a.account_id=p.account_id WHERE t.doc_number='JE-1' AND t.is_adjusting ORDER BY a.name";
  const original=await q(src,shape),rebuilt=await q(dst,shape);
  assert.equal(original.length,2);assert.equal(rebuilt.length,0);
  console.log('T3',JSON.stringify({original,rebuilt,savedHasAdjusting:Object.hasOwn(data.companies[0].nativeTransactions[0],'isAdjusting'),skipped:report.skipped,decisions:report.decisions,previewDecisions:preview.decisions}));
  assert.ok(report.decisions.some(d=>d.docNumber==='JE-1'),'native adjusting journal dismissed as the same nonadjusting import');
  assert.equal(data.companies[0].nativeTransactions[0].isAdjusting,true);
  assert.ok(preview.decisions.some(d=>d.docNumber==='JE-1'));
});

test('native matching refuses header and child differences even with the same posting amounts',async()=>{
  const db=await makeDb({imported:true});
  await q(db,"SELECT set_config('fb.import','on',false)");
  await q(db,"UPDATE txn SET source=NULL WHERE doc_number='JE-1'");
  const data=await saved(db);
  await q(db,"UPDATE txn SET source='qbo_import' WHERE doc_number='JE-1'");
  for (const [key,value] of Object.entries({memo:'Sample changed memo',isAdjusting:true,dueDate:'2024-12-31',
    terms:'Sample terms',paymentMethod:'Sample payment',paymentRef:'Sample ref',class:'Sample class',location:'Sample location',
    voidedAt:'2024-12-31T00:00:00.000Z',discountCents:1,foreignTotalCents:1,openCents:1,statementMemo:'Sample statement'})) {
    const changed=structuredClone(data); changed.companies[0].nativeTransactions[0][key]=value;
    const report=await apply(db,changed);
    assert.ok(report.decisions.some(d=>d.docNumber==='JE-1'),key);
  }
  for (const [collection,key,value] of [['lines','rateCents',123],['lines','description','Sample description'],
    ['lines','serviceDate','2024-12-31'],['lines','quantity','2.0000'],['postings','memo','Sample posting memo'],
    ['postings','date','2025-01-01'],['postings','lineNo',90]]) {
    const changed=structuredClone(data); changed.companies[0].nativeTransactions[0][collection][0][key]=value;
    const report=await apply(db,changed);
    assert.ok(report.decisions.some(d=>d.docNumber==='JE-1'),`${collection}.${key}`);
  }
  const reordered=structuredClone(data);
  reordered.companies[0].nativeTransactions[0].lines.reverse();
  reordered.companies[0].nativeTransactions[0].postings.reverse();
  assert.equal((await apply(db,reordered)).skipped.filter(d=>/present/.test(d.why)).length,1);
  const incomplete=structuredClone(data); delete incomplete.companies[0].nativeTransactions[0].isAdjusting;
  assert.equal((await apply(db,incomplete)).decisions.length,1);
});

test('identity explicitly classifies every migrated transaction child table and column from the catalog',async()=>{
  const db=await makeDb();
  const children=(await q(db,`SELECT DISTINCT c.relname AS name FROM pg_constraint f
    JOIN pg_class c ON c.oid=f.conrelid
    WHERE f.contype='f' AND f.confrelid='public.txn'::regclass AND f.conrelid<>f.confrelid`)).map(r=>r.name);
  const { unsupportedIdentityChildren, ignoredIdentityChildren } = await import('../lib/rebuild/transaction-identity.js');
  for (const table of children) assert.ok(identityColumns[table] || unsupportedIdentityChildren?.[table] || ignoredIdentityChildren?.[table],`${table} has no identity classification`);
  for(const table of ['txn',...children.filter(t=>identityColumns[t])]) {
    const spec=identityColumns[table];
    const columns=(await q(db,"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).map(r=>r.column_name).sort();
    const classified=[...spec.values,...Object.keys(spec.refs),...spec.ignored].sort();
    assert.deepEqual(classified,columns,table);
  }
});
