import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedNumber, canonicalTransaction, indexRepeats, matchTransactions } from '../lib/refdiff/fingerprint.js';
const row = (changes = {}) => ({ family:'Check',date:'2026-01-10',number:'101',
  party:[{kind:'vendor',name:'Sample vendor A'}],
  postings:[{account:'Operating',cents:'-1000'},{account:'Repairs',cents:'1000'}],...changes });
test('numbers recover the importer memo and retain exact long digits', () => {
  assert.equal(normalizedNumber({doc_number:'000101'}),'101');
  assert.equal(normalizedNumber({memo:'Sample memo · QuickBooks no. 000101 · Also on it: words'}),'101');
  assert.equal(normalizedNumber({payment_ref:'0000009007199254740993'}),'9007199254740993');
  assert.equal(normalizedNumber({doc_number:' INV-01 '}),'INV-01');
  assert.throws(()=>normalizedNumber({memo:'QuickBooks no. A · QuickBooks no. B'}),/ambiguous number/);
});
test('vectors sort without netting duplicate or opposite lines', () => {
  const a=canonicalTransaction(row({family:'Bill Payment (Check)',postings:[
    {account:'Repairs',cents:'9007199254740993'},{account:'Operating',cents:'-9007199254740993'},
    {account:'Repairs',cents:'-2'},{account:'Repairs',cents:'2'}]}));
  assert.equal(a.family,'Bill Payment'); assert.equal(a.postings.length,4);
  assert.equal(a.postings[0].cents,'-9007199254740993');
  assert.deepEqual(a,canonicalTransaction({...a,postings:[...a.postings].reverse()}));
});
test('repeats preserve multiplicity independent of row order', () => {
  const a=indexRepeats([row(),row(),row({number:'102'})]);
  assert.deepEqual(a.filter(t=>t.number==='101').map(t=>t.repeat),[1,2]);
  assert.deepEqual(a,indexRepeats([row({number:'102'}),row(),row()]));
  const d=matchTransactions(a,indexRepeats([row(),row({number:'102'})]));
  assert.equal(d.unchanged.length,2); assert.equal(d.vanished.length,1);
  assert.equal(d.vanished[0].repeat,2);
});
test('all five unique one-field changes are detected', () => {
  for(const [field,value] of Object.entries({family:'Expense',date:'2025-12-31',number:'102',
    party:[{kind:'vendor',name:'Sample vendor B'}],
    postings:[{account:'Operating',cents:'-1001'},{account:'Repairs',cents:'1001'}]})) {
    const d=matchTransactions(indexRepeats([row()]),indexRepeats([row({[field]:value})]));
    assert.deepEqual(d.changed.map(c=>c.field),[field]);
    assert.equal(d.added.length+d.vanished.length,0);
  }
});
test('ambiguous and two-field changes stay added and vanished', () => {
  const a=indexRepeats([row()]);
  const d=matchTransactions(a,indexRepeats([row({date:'2026-01-11'}),row({number:'102'})]));
  assert.equal(d.changed.length,0); assert.equal(d.vanished.length,1); assert.equal(d.added.length,2);
  assert.ok(d.ambiguousCandidates.length>0);
  const two=matchTransactions(a,indexRepeats([row({date:'2026-01-11',number:'103'})]));
  assert.equal(two.changed.length,0); assert.equal(two.added.length,1); assert.equal(two.vanished.length,1);
});
test('repeat counters do not assert identity for an edited duplicate', () => {
  const d=matchTransactions(indexRepeats([row(),row()]),indexRepeats([row(),row({number:'102'})]));
  assert.equal(d.unchanged.length,1); assert.equal(d.changed.length,0);
  assert.equal(d.vanished[0].repeat,2); assert.equal(d.added[0].repeat,1);
});
test('canonical validation rejects malformed cents, dates and types', () => {
  for (const changes of [{date:'2026-02-30'},{family:42},{postings:[{account:'Operating',cents:1.5}]}]) {
    assert.throws(()=>canonicalTransaction(row(changes)));
  }
});
