// R-B1/R-B2: fresh importer output, including shapes not covered by prelisted parties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reference, conformanceTxns } from './refdiff-fixture.js';

test('unlisted mixed-use party inference and native shapes are order independent',async t=>{
  const a=await reference(t,{txns:conformanceTxns(),addLists:true});
  const b=await reference(t,{txns:conformanceTxns().reverse(),addLists:true,reverseContacts:true,reverseChart:true});
  const content=async db=>({
    customers:(await db.pool.query('SELECT display_name FROM customer ORDER BY display_name')).rows,
    vendors:(await db.pool.query('SELECT display_name FROM vendor ORDER BY display_name')).rows,
    shapes:(await db.pool.query('SELECT txn_date::text,type,source_type FROM txn ORDER BY 1,2,3')).rows,
  });
  assert.deepEqual(await content(a),await content(b));
  assert.ok((await content(a)).customers.some(r=>r.display_name==='Sample mixed party'));
});
test('original numbers survive header collisions and long memos without loss',async t=>{
  const db=await reference(t,{txns:conformanceTxns()});
  const s=(await db.pool.query('SELECT summary FROM import_batch')).rows[0].summary;
  assert.equal(s.referenceIdentity?.version,1);
  const rows=s.referenceIdentity.transactions.filter(r=>r.number==='1234567890123456789012345678901234567890');
  assert.equal(rows.length,2); assert.ok(rows.every(r=>r.party.some(p=>p.kind==='vendor')));
});
