import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountChart, ReferenceRefusal } from '../lib/refdiff/snapshot.js';
import { compareReferences } from '../lib/refdiff/compare.js';
import { indexRepeats } from '../lib/refdiff/fingerprint.js';

const row=(account_id,name,extra={})=>({account_id,name,parent_id:null,type:'expense',number:null,active:true,...extra});
const chart=(rows,renamed=[])=>accountChart(rows,{renamed,renamedAccounts:renamed.length});
const snapshot=(rows,posts=[],renamed=[])=>{
  const {accounts,canonical}=chart(rows,renamed);
  const transactions=indexRepeats(posts.map(([account,number='S-1'])=>({family:'Check',date:'2026-01-01',number,party:[],
    postings:[{account:canonical.get(String(account)),cents:'100'},{account:canonical.get('0'),cents:'-100'}]})));
  return {database:'sample',orgSlug:'sample',migrations:['sample'],contentHash:'sample',companies:[{company:'Sample company',
    accounts,transactions,customers:[],vendors:[],openItems:[],omissions:0,acceptedMismatches:[],importRange:{}}]};
};
const compare=(a,b)=>compareReferences(a,b).companies[0];
const bank=()=>row(0,'Sample bank',{type:'asset'});
const twins=()=>[bank(),row(1,'Sample expense'),row(2,'Sample expense (deleted)',{active:false})];
const noAccountChurn=c=>assert.equal(c.accounts.added.length+c.accounts.vanished.length+c.accounts.renamed.length,0);

test('deleted/live twins keep separate account and posting identities across reordered imports',()=>{
  const rows=twins(),a=snapshot(rows,[[1],[2]]),b=snapshot([...rows].reverse(),[[2],[1]]);
  assert.equal(new Set(a.companies[0].accounts.map(a=>a.path)).size,3);
  const c=compare(a,b);noAccountChurn(c);assert.equal(c.transactions.unchanged.length,2);
  assert.deepEqual(a.companies[0].transactions.map(t=>t.repeat),[1,1]);
  const moved=compare(snapshot(rows,[[1]]),snapshot(rows,[[2]]));
  assert.deepEqual(moved.transactions.changed.map(r=>r.field),['postings']);
});

test('same leaves under different parents survive importer aliases and regenerated ids',()=>{
  const a=[bank(),row(1,'Sample north',{type:'asset'}),row(2,'Sample south',{type:'asset'}),
    row(3,'Sample leaf',{parent_id:1}),row(4,'Sample leaf (Sample south)',{parent_id:2})];
  const b=[bank(),row(11,'Sample north',{type:'asset'}),row(12,'Sample south',{type:'asset'}),
    row(13,'Sample leaf (Sample north)',{parent_id:11}),row(14,'Sample leaf',{parent_id:12})];
  const x=snapshot(a,[[3],[4]],['Sample south:Sample leaf → Sample leaf (Sample south)']);
  const y=snapshot(b,[[14],[13]],['Sample north:Sample leaf → Sample leaf (Sample north)']);
  const c=compare(x,y);noAccountChurn(c);assert.equal(c.transactions.unchanged.length,2);
  assert.equal(new Set(x.companies[0].transactions.map(t=>t.postings.find(p=>p.cents==='100').account)).size,2);
});

test('deleted/live parent twins distinguish equal children and flattened descendants',()=>{
  const rows=[bank(),row(1,'Sample parent'),row(2,'Sample parent (deleted)',{active:false}),
    row(3,'Sample child',{parent_id:1}),row(4,'Sample child (old)',{parent_id:2}),
    row(5,'Sample child: Sample tip',{parent_id:1}),row(6,'Sample child: Sample tip 2',{parent_id:2})];
  const aliases=['Sample parent (deleted):Sample child → Sample child (old)',
    'Sample parent:Sample child:Sample tip → Sample child: Sample tip',
    'Sample parent (deleted):Sample child:Sample tip → Sample child: Sample tip 2'];
  const a=snapshot(rows,[[5],[6]],aliases),b=snapshot([...rows].reverse(),[[6],[5]],aliases);
  assert.equal(new Set(a.companies[0].accounts.map(a=>a.path)).size,7);
  const c=compare(a,b);noAccountChurn(c);assert.equal(c.transactions.unchanged.length,2);
});

for(const [kind,extra] of [['number',{number:'6301'}],['type',{type:'asset'}]]) {
  test(`same path with distinct ${kind} never merges`,()=>{
    const rows=[bank(),row(1,'Sample bucket',{number:'6300'}),row(2,'Sample bucket',{number:'6300',...extra})];
    const a=snapshot(rows,[[1],[2]]),b=snapshot([...rows].reverse(),[[2],[1]]);
    const c=compare(a,b);noAccountChurn(c);assert.equal(c.transactions.unchanged.length,2);
    assert.deepEqual(a.companies[0].transactions.map(t=>t.repeat),[1,1]);
    const single=compare(snapshot([bank(),rows[1]],[[1]]),snapshot([bank(),rows[2]],[[2]]));
    assert.equal(single.accounts.added.length,1);assert.equal(single.accounts.vanished.length,1);
    assert.equal(single.transactions.changed.length,1);
  });
}

test('unambiguous reactivation is only a status change, including parent descendants',()=>{
  const a=[bank(),row(1,'Sample parent (deleted)',{active:false}),row(2,'Sample child (deleted)',{parent_id:1,active:false})];
  const b=[bank(),row(11,'Sample parent'),row(12,'Sample child',{parent_id:11})];
  const c=compare(snapshot(a,[[2]]),snapshot(b,[[12]]));
  noAccountChurn(c);assert.equal(c.transactions.unchanged.length,1);
  assert.deepEqual(c.accounts.changed.map(r=>r.fields),[['active'],['active']]);
  assert.ok(c.accounts.changed.every(r=>!r.before.active&&r.after.active));
});

for(const survivor of [1,2]) {
  test(`twin arrival and departure preserve survivor ${survivor} without status guessing`,()=>{
    const rows=twins(),single=snapshot([rows[0],rows[survivor]],[[survivor]]),both=snapshot(rows,[[survivor]]);
    for(const [a,b,added,vanished] of [[single,both,1,0],[both,single,0,1]]) {
      const c=compare(a,b);assert.equal(c.transactions.unchanged.length,1);
      assert.equal(c.accounts.added.length,added);assert.equal(c.accounts.vanished.length,vanished);
      assert.equal(c.accounts.changed.length,0);assert.equal(c.accounts.renamed.length,0);
    }
  });
}

test('numbered inactive accounts pair across reactivation even with another same-name account',()=>{
  const a=[bank(),row(1,'Sample numbered (deleted)',{number:'6400',active:false}),row(2,'Sample numbered',{number:'6401'})];
  const b=[bank(),row(11,'Sample numbered',{number:'6400'}),row(12,'Sample numbered',{number:'6401'})];
  const c=compare(snapshot(a,[[1],[2]]),snapshot(b,[[11],[12]]));
  noAccountChurn(c);assert.equal(c.transactions.unchanged.length,2);
  assert.deepEqual(c.accounts.changed.map(r=>r.fields),[['active']]);
});

test('indistinguishable normalized tuples refuse with a kind and no account names',()=>{
  for(const rows of [[row(1,'Sample duplicate'),row(2,' Sample duplicate ')],
    [row(1,'Sample duplicate',{active:false}),row(2,'Sample duplicate (deleted)',{active:false})]]) {
    assert.throws(()=>chart(rows),e=>e instanceof ReferenceRefusal
      && /canonical account collision: indistinguishable canonical tuple/.test(e.message)
      && !e.message.includes('Sample'));
  }
});

test('ambiguous reconstructed parent paths refuse with the collision kind',()=>{
  assert.throws(()=>chart([row(0,'Sample top'),row(1,'Sample parent',{parent_id:0,number:'6500'}),
    row(2,'Sample parent',{parent_id:0,number:'6501'}),row(3,'Sample parent: Sample child',{parent_id:0})],
  ['Sample top:Sample parent:Sample child → Sample parent: Sample child']),
  /canonical account collision: ambiguous parent path/);
});
