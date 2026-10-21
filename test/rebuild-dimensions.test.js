import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, q, saved, apply } from './rebuild-fixture.js';
import { saveJournalEntry } from '../lib/data/ledger-tools.js';

test('S6 journal matching must include posting dimensions and line parties',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  const t=(await q(src,"SELECT * FROM txn WHERE doc_number='JE-1'"))[0];
  const lines=await q(src,'SELECT * FROM txn_line WHERE txn_id=$1 ORDER BY line_no',[t.txn_id]);
  assert.equal(lines.length,2);
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,'UPDATE txn SET source=NULL WHERE txn_id=$1',[t.txn_id]);
  const cls=(await q(src,"INSERT INTO class(org_id,entity_id,name) VALUES(1,1,'Sample department') RETURNING class_id"))[0].class_id;
  const customer=(await q(src,"SELECT customer_id FROM customer WHERE display_name='Buyer Ranch'"))[0].customer_id;
  await saveJournalEntry(src.pool,{orgId:1,entityId:1,txnId:t.txn_id,txnDate:t.txn_date,docNumber:t.doc_number,memo:t.memo,actor:'review-test',
    lines:lines.map(l=>({accountId:l.account_id,debit:l.amount_cents>0?(l.amount_cents/100).toFixed(2):'',credit:l.amount_cents<0?(-l.amount_cents/100).toFixed(2):'',classId:cls,party:`c:${customer}`}))});
  const data=await saved(src),report=await apply(dst,data);
  const shape="SELECT a.name AS account,p.amount_cents,c.display_name AS customer,k.name AS class FROM posting p JOIN account a USING(account_id) LEFT JOIN customer c ON c.customer_id=p.customer_id LEFT JOIN class k ON k.class_id=p.class_id JOIN txn t USING(txn_id) WHERE t.doc_number='JE-1' ORDER BY p.line_no";
  assert.notDeepEqual(await q(src,shape),await q(dst,shape));
  assert.ok(report.decisions.some(x=>x.docNumber===t.doc_number),'different line parties/classes incorrectly skipped as present');
});

test('unknown or omitted posting dimensions cannot prove a transaction present',async()=>{
  const db=await makeDb({imported:true});
  await q(db,"SELECT set_config('fb.import','on',false)");
  await q(db,"UPDATE txn SET source=NULL WHERE doc_number='JE-1'");
  const data=await saved(db), native=data.companies[0].nativeTransactions[0];
  await q(db,"UPDATE txn SET source='qbo_import' WHERE doc_number='JE-1'");
  for (const key of ['customer','vendor','class','location']) {
    const changed=structuredClone(data); delete changed.companies[0].nativeTransactions[0].postings[0][key];
    const report=await apply(db,changed);
    assert.ok(report.decisions.some(x=>x.docNumber===native.docNumber),key);
    assert.equal(report.skipped.filter(x=>x.what==='native transaction').length,0);
  }
  const report=await apply(db,data);
  assert.equal(report.skipped.filter(x=>x.what==='native transaction').length,1);
});
