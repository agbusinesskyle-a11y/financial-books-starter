import { isDeepStrictEqual } from 'node:util';
import { matchTransactions, order } from './fingerprint.js';
import { ReferenceRefusal, alignAccountCompanies } from './snapshot.js';

const limitations = [
  'Changed means a mutually unique one-field content candidate, not proven QuickBooks persistent identity.',
  'Repeat indexes count multiplicity: [X,X] to [X,Y] can remain added/vanished. Multi-field edits also remain added/vanished.',
  'Ordinary memo-only and contact-only edits are outside the transaction fingerprint.',
  'Imported applications reconstruct oldest-first settlement from aging. Changed aging allocations are observable; payment links leaving aging unchanged are not observable.',
  'Zero-amount omissions are possible voids, not proof of voiding; explicit Voided text and actual voided status are separate evidence.',
  'Account and party rename candidates require review and approval; they never suppress this run’s transaction differences.',
  'Unlisted party classification uses the recorded complete-input inference policy; it is not proof of an original QuickBooks contact-list namespace.',
  'Legacy references without lossless original party and number evidence require fresh imports from retained exports.',
  'All database accounts are included; importer-added system accounts do not establish export membership.',
  'Account identity uses original parent paths, base names, account numbers and types. Status distinguishes coexisting twins; unambiguous reactivation is a status change. Number/type changes may appear as added and vanished accounts.',
  'Accepted R5 V2 residual risk remains: comparison detects differences between inputs and does not certify either input against the retained Journal or rule out privileged history edits.',
];
const source = s => ({database:s.database,contentHash:s.contentHash,migrations:s.migrations,
  importRanges:s.companies.map(c=>({company:c.company,...c.importRange}))});
const publicAccount = a => Object.fromEntries(['name','type','number','active','parent','path'].map(k=>[k,a[k]]));
const publicParty = p => ({name:p.name,kind:p.kind});
function listDiff(a,b,kind,context) {
  const account=kind==='account', key=r=>account?r.path:r.name, clean=account?publicAccount:publicParty;
  const before=new Map(a.map(r=>[key(r),r])), after=new Map(b.map(r=>[key(r),r]));
  const removed=a.filter(r=>!after.has(key(r))), added=b.filter(r=>!before.has(key(r)));
  const changed=[];
  if (account) for (const row of a) if (after.has(key(row))) {
    const other=after.get(key(row)), fields=['name','type','number','active','parent'].filter(f=>row[f]!==other[f]);
    if (fields.length) changed.push({before:clean(row),after:clean(other),fields});
  }
  const signatures=r=> {
    const attributes=account?[r.type,r.number,r.active,r.parentIdentity]:[];
    return [
      account&&r.number?['account_number',JSON.stringify([...attributes,r.number])]:null,
      !account&&r.contactSignature?['stable_contact',r.contactSignature]:null,
      r.usageSignature?['transaction_usage',JSON.stringify([...attributes,r.usageSignature])]:null,
    ].filter(Boolean);
  };
  const indexes=new Map();
  added.forEach((r,j)=> { for (const [code,value] of signatures(r)) {
    const s=JSON.stringify([code,value]),bucket=indexes.get(s)??[]; bucket.push(j); indexes.set(s,bucket);
  } });
  const edges=new Map(), left=new Map(),right=new Map();
  removed.forEach((r,i)=> { for (const [code,value] of signatures(r)) for (const j of indexes.get(JSON.stringify([code,value]))??[]) {
    const key=JSON.stringify([i,j]);
    if (!edges.has(key)) { edges.set(key,{i,j,evidence:[]}); left.set(i,(left.get(i)??0)+1);right.set(j,(right.get(j)??0)+1); }
    edges.get(key).evidence.push(code);
  } });
  const renamed=[],ambiguousCandidates=[];
  for (const {i,j,evidence} of edges.values()) {
    const candidate={kind,...context,before:key(removed[i]),after:key(added[j]),evidence:evidence.sort(),approved:false};
    (left.get(i)===1&&right.get(j)===1?renamed:ambiguousCandidates).push(candidate);
  }
  return {added:added.map(clean),changed,vanished:removed.map(clean),renamed,ambiguousCandidates};
}
const voidState = r => r?{voidStatus:r.voidStatus??null,explicitVoidMemo:!!r.explicitVoidMemo}:null;
const flagged = r => !!(r?.voidStatus||r?.explicitVoidMemo);
function transactionDiff(a,b) {
  const d=matchTransactions(a,b), voids=[];
  for (const pair of [...d.unchanged,...d.changed]) if (flagged(pair.before)||flagged(pair.after)) {
    voids.push({...pair,statusChanged:!isDeepStrictEqual(voidState(pair.before),voidState(pair.after)),contentChanged:!!pair.field});
  }
  for (const after of d.added) if (flagged(after)) voids.push({before:null,after,statusChanged:true,contentChanged:true});
  for (const before of d.vanished) if (flagged(before)) voids.push({before,after:null,statusChanged:true,contentChanged:true});
  return {...d,voids};
}
function openDiff(a,b) {
  const groups=new Map();
  for (const [side,rows] of [['before',a],['after',b]]) for (const r of rows) {
    const key=JSON.stringify([r.side,r.party]);
    if (!groups.has(key)) groups.set(key,{side:r.side,party:r.party,before:[],after:[]});
    const {side:_,party:__,...item}=r; groups.get(key)[side].push(item);
  }
  return [...groups.values()].map(p=> {
    const total=rows=>rows.reduce((n,r)=>n+BigInt(r.cents),0n);
    const before=total(p.before),after=total(p.after);
    return {...p,beforeCents:String(before),afterCents:String(after),deltaCents:String(after-before),changed:!isDeepStrictEqual(p.before,p.after)};
  }).sort((a,b)=>order(JSON.stringify([a.side,a.party]),JSON.stringify([b.side,b.party])));
}
export function compareReferences(a,b) {
  if (a.orgSlug!==b.orgSlug) throw new ReferenceRefusal('org slugs differ');
  const names=s=>s.companies.map(c=>c.company).sort();
  if (!names(a).length || !isDeepStrictEqual(names(a),names(b))) throw new ReferenceRefusal('company sets differ');
  if (!isDeepStrictEqual([...a.migrations].sort(),[...b.migrations].sort())) throw new ReferenceRefusal('migration name sets differ');
  const companies=[...a.companies].sort((a,b)=>order(a.company,b.company)).map(original=> {
    const [before,after]=alignAccountCompanies(original,b.companies.find(c=>c.company===original.company));
    const transactions=transactionDiff(before.transactions,after.transactions);
    const openItems=openDiff(before.openItems,after.openItems);
    const context={orgSlug:a.orgSlug,company:before.company,snapshotHashes:{a:a.contentHash,b:b.contentHash}};
    const accounts=listDiff(before.accounts,after.accounts,'account',context),
      customers=listDiff(before.customers,after.customers,'customer',context),vendors=listDiff(before.vendors,after.vendors,'vendor',context);
    const counts={transactions:Object.fromEntries(['unchanged','added','changed','vanished','voids'].map(k=>[k,transactions[k].length])),
      omissions:{before:before.omissions,after:after.omissions},openItems:{changed:openItems.filter(p=>p.changed).length}};
    for (const [kind,rows] of Object.entries({accounts,customers,vendors})) counts[kind]=Object.fromEntries(['added','changed','vanished','renamed','ambiguousCandidates'].map(k=>[k,rows[k].length]));
    counts.accounts.inactivated=accounts.changed.filter(r=>r.before.active&&!r.after.active).length;
    return {company:before.company,transactions,accounts,customers,vendors,openItems,counts,
      acceptedMismatches:{before:before.acceptedMismatches,after:after.acceptedMismatches}};
  });
  const totals={transactions:Object.fromEntries(['unchanged','added','changed','vanished','voids'].map(k=>[k,companies.reduce((n,c)=>n+c.counts.transactions[k],0)])),
    omissions:{before:companies.reduce((n,c)=>n+c.counts.omissions.before,0),after:companies.reduce((n,c)=>n+c.counts.omissions.after,0)}};
  for (const kind of ['accounts','customers','vendors','openItems']) totals[kind]=Object.fromEntries(Object.keys(companies[0].counts[kind]).map(k=>[k,companies.reduce((n,c)=>n+c.counts[kind][k],0)]));
  return {version:1,orgSlug:a.orgSlug,sources:{a:source(a),b:source(b)},limitations:[...limitations],companies,totals};
}
