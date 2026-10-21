import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reference, baseTxns, baseOpen, conformanceTxns } from './refdiff-fixture.js';
import { readReference } from '../lib/refdiff/snapshot.js';
import { compareReferences } from '../lib/refdiff/compare.js';
const compare=async(a,b)=>compareReferences(await readReference(a.urlFile),await readReference(b.urlFile));
test('back-dated edit, disappearance, addition and void remain separate', async t=>{
  const a=await reference(t), txns=baseTxns();
  txns[0][0]='01/09/2026'; txns.splice(1,1);
  const v=txns.find(x=>x[2]==='103'); v[4]='Voided'; v[5]=[['Operating',0,0],['Repairs',0,0]];
  txns.push(['06/01/2026','Check','104','Sample vendor A',null,[['Operating',0,70],['Fuel',70,0]]]);
  const b=await reference(t,{txns}), d=(await compare(a,b)).companies[0].transactions;
  assert.deepEqual(d.changed.map(c=>[c.before.number,c.field]).sort(),[['101','date'],['103','postings']]);
  assert.deepEqual(d.vanished.map(r=>r.number),['102']); assert.deepEqual(d.added.map(r=>r.number),['104']);
  assert.equal(d.voids.length,1);
  assert.equal(d.changed.find(c=>c.before.number==='103').after.voidStatus,'possible_void');
});
test('re-applied payment changes open documents despite unchanged ledger and party total', async t=>{
  const a=await reference(t), open=baseOpen();
  Object.assign(open[0],{date:'2026-04-01',num:'I-1',due:'2026-05-01'});
  const b=await reference(t,{open}), d=await compare(a,b), c=d.companies[0];
  assert.equal(c.transactions.changed.length+c.transactions.added.length+c.transactions.vanished.length,0);
  const ar=c.openItems.find(p=>p.side==='ar'&&p.party==='Sample customer A');
  assert.equal(ar.beforeCents,'10000'); assert.equal(ar.afterCents,'10000'); assert.equal(ar.deltaCents,'0');
  assert.deepEqual(ar.before.map(x=>x.number),['I-2']); assert.deepEqual(ar.after.map(x=>x.number),['I-1']);
  assert.match(d.limitations.join(' '),/payment.*links.*not observable/i);
});
test('company import order and transaction row order never establish identity', async t=>{
  const a=await reference(t,{companies:['Sample company A','Sample company B']});
  const b=await reference(t,{companies:['Sample company B','Sample company A'],txns:baseTxns().reverse()});
  const d=await compare(a,b);
  assert.deepEqual(d.companies.map(c=>c.company),['Sample company A','Sample company B']);
  for(const c of d.companies) assert.equal(c.transactions.added.length+c.transactions.changed.length+c.transactions.vanished.length,0);
});
test('different org slugs or company sets refuse', async t=>{
  const a=await reference(t), b=await reference(t,{orgSlug:'sample_other'}), c=await reference(t,{companies:['Sample company B']});
  await assert.rejects(compare(a,b),/org slugs differ/); await assert.rejects(compare(a,c),/company sets differ/);
});
test('an old amount and account edit is one posting-vector candidate',async t=>{
  const a=await reference(t),txns=baseTxns(); txns[0][5]=[['Operating',0,11],['Fuel',11,0]];
  const b=await reference(t,{txns}),d=(await compare(a,b)).companies[0].transactions;
  assert.deepEqual(d.changed.map(r=>[r.before.number,r.field]),[['101','postings']]);
});
test('status-only void evidence is separate from amounts and unchanged voids remain visible',async t=>{
  const txns=baseTxns(); txns[2][5]=[['Operating',0,0],['Repairs',0,0]];
  const a=await reference(t,{txns}); txns[2][4]='Voided'; const b=await reference(t,{txns});
  const d=(await compare(a,b)).companies[0].transactions;
  assert.equal(d.changed.length,0); assert.equal(d.voids.length,1); assert.equal(d.voids[0].statusChanged,true);
  assert.equal((await compare(b,b)).companies[0].transactions.voids[0].statusChanged,false);
});
test('permuted importer content yields identical complete comparison apart from source database labels',async t=>{
  const a=await reference(t,{txns:conformanceTxns(),addLists:true}),
    b=await reference(t,{txns:conformanceTxns().reverse(),addLists:true,reverseChart:true,reverseContacts:true});
  const x=await readReference(a.urlFile),y=await readReference(b.urlFile);
  x.database=y.database='sample_reference';
  assert.equal(x.contentHash,y.contentHash); assert.deepEqual(compareReferences(x,y),compareReferences(x,x));
});
test('migration mismatches refuse before comparing documents',async t=>{
  const db=await reference(t),x=await readReference(db.urlFile);
  assert.throws(()=>compareReferences(x,{...x,migrations:[]}),/migration.*differ/);
});

test('account rename produces an unapproved candidate without hiding posting edits', async t=>{
  const a=await reference(t), b=await reference(t,{aliases:{Repairs:'Sample service expense'}});
  const c=(await compare(a,b)).companies[0];
  assert.equal(c.accounts.renamed.length,1);
  assert.deepEqual([c.accounts.renamed[0].before,c.accounts.renamed[0].after],['Repairs','Sample service expense']);
  assert.equal(c.accounts.renamed[0].approved,false);
  assert.equal(c.accounts.added.length,1); assert.equal(c.accounts.vanished.length,1);
  assert.ok(c.transactions.changed.some(r=>r.field==='postings'));
});
test('deleted suffix and plain-name inactivation describe the same status', async t=>{
  const a=await reference(t), b=await reference(t,{aliases:{Visa:'Visa (deleted)'}}), c=await reference(t,{inactive:'Visa'});
  for(const other of [b,c]) {
    const d=(await compare(a,other)).companies[0].accounts;
    assert.equal(d.added.length+d.vanished.length+d.renamed.length,0);
    assert.deepEqual(d.changed.map(r=>r.fields),[['active']]); assert.equal(d.changed[0].after.active,false);
  }
  assert.equal((await compare(b,c)).companies[0].accounts.changed.length,0);
});
test('party lists expose additions and rename candidates without contact values', async t=>{
  const a=await reference(t), b=await reference(t,{addLists:true,aliases:{'Sample vendor A':'Sample vendor renamed','Sample customer A':'Sample customer renamed'}});
  const d=(await compare(a,b)).companies[0];
  for(const kind of ['customers','vendors']) {
    assert.equal(d[kind].renamed.length,1); assert.equal(d[kind].renamed[0].approved,false);
    assert.equal(d[kind].added.length,2); assert.equal(d[kind].vanished.length,1);
  }
  assert.ok(!JSON.stringify(d).includes('@sample.example')); assert.ok(!JSON.stringify(d).includes('555-0100'));
});
test('inactivation of a used account and deleted parent/child paths do not change postings',async t=>{
  const a=await reference(t,{txns:conformanceTxns()});
  for(const options of [{inactive:'Repairs'},{aliases:{Repairs:'Repairs (deleted)'}},
    {aliases:{Planes:'Planes (deleted)','Planes:Cub':'Planes (deleted):Cub (deleted)',
      'Planes:Cub:Engine':'Planes (deleted):Cub (deleted):Engine (deleted)'}}]) {
    const b=await reference(t,{txns:conformanceTxns(),...options}),c=(await compare(a,b)).companies[0];
    assert.equal(c.transactions.changed.length+c.transactions.added.length+c.transactions.vanished.length,0);
    assert.equal(c.accounts.added.length+c.accounts.vanished.length,0);
    assert.ok(c.accounts.changed.length>0); assert.ok(c.accounts.changed.every(r=>JSON.stringify(r.fields)==='["active"]'));
  }
});
test('used repeated leaves and numbered disambiguation retain original paths across chart permutations',async t=>{
  const txns=[...conformanceTxns(),['06/07/2026','Journal Entry','Leaf-1',null,null,[['Bad Debt',2,0],['Operating',0,2]]]];
  const options={txns,aliases:{Fuel:'Engine',Repairs:'Planes:Engine',Visa:'Engine (Planes)','Bad Debt':'Sample top:Engine'},
    extraAccounts:[{name:'Sample top',fullName:'Sample top',parent:null,type:'Expenses',detail:'Other'}]};
  const a=await reference(t,options),b=await reference(t,{...options,txns:[...txns].reverse(),reverseChart:true});
  const x=await readReference(a.urlFile),y=await readReference(b.urlFile);
  assert.equal(x.contentHash,y.contentHash); assert.deepEqual(x.companies,y.companies);
  for(const p of ['Engine','Planes:Engine','Planes:Cub:Engine','Sample top:Engine']) {
    assert.ok(x.companies[0].transactions.some(t=>t.postings.some(r=>r.account===p)));
  }
  const aliases=(await a.pool.query('SELECT summary FROM import_batch')).rows[0].summary.renamed;
  assert.ok(aliases.some(s=>s.endsWith(' → Engine 2'))); assert.ok(aliases.some(s=>s.endsWith(' → Engine (Sample top)')));
  const d=(await compare(a,b)).companies[0]; assert.equal(d.accounts.changed.length+d.accounts.renamed.length+d.accounts.added.length+d.accounts.vanished.length,0);
});
test('non-unique account usage and party contact evidence remains ambiguous',async t=>{
  const txns=['Fuel','Bad Debt'].map(account=>['06/01/2026','Check','Same-1','Sample vendor A',null,[['Operating',0,3],[account,3,0]]]);
  const a=await reference(t,{txns,open:[],contacts:{vendor:[['Sample vendor C','vendor@sample.example','555-0100','S-1']]}});
  const b=await reference(t,{txns,open:[],aliases:{Fuel:'Sample expense A','Bad Debt':'Sample expense B','Sample vendor A':'Sample vendor renamed'},
    contacts:{vendor:[['Sample vendor D','vendor@sample.example','555-0100','S-1']]}});
  const c=(await compare(a,b)).companies[0];
  // A separate same-party run isolates the unchanged account usage signature.
  const same=await reference(t,{txns,open:[],aliases:{Fuel:'Sample expense A','Bad Debt':'Sample expense B'},
    contacts:{vendor:[['Sample vendor C','vendor@sample.example','555-0100','S-1']]}});
  const accounts=(await compare(a,same)).companies[0].accounts;
  assert.equal(accounts.renamed.length,0); assert.equal(accounts.ambiguousCandidates.length,4);
  assert.equal(c.vendors.renamed.length,0); assert.equal(c.vendors.ambiguousCandidates.length,4);
  assert.equal(accounts.added.length,2); assert.equal(accounts.vanished.length,2);
});
test('empty contact and usage evidence cannot suggest a spelling-based rename',async t=>{
  const a=await reference(t,{contacts:{vendor:[['Sample unused vendor',null,null,null]]}});
  const b=await reference(t,{contacts:{vendor:[['Sample unused vendor renamed',null,null,null]]}});
  const d=(await compare(a,b)).companies[0].vendors;
  assert.equal(d.renamed.length,0); assert.equal(d.added.length,1); assert.equal(d.vanished.length,1);
});
