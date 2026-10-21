// Content identity deliberately does not claim persistent QuickBooks document ids.
import { createHash } from 'node:crypto';

export const fields = ['family','date','number','party','postings'];
export const order = (a,b) => a < b ? -1 : a > b ? 1 : 0;
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function name(value) {
  if (typeof value !== 'string') throw new Error('invalid name/type');
  return value.normalize('NFC').trim();
}
export function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new Error('invalid date');
  return value;
}
export function cents(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new Error('invalid cents');
  return BigInt(value).toString();
}
export function normalizedNumber(row) {
  let value = row.doc_number || row.payment_ref;
  if (!value) {
    const segments = String(row.memo ?? '').split(' · ').filter(s=>s.startsWith('QuickBooks no. '));
    if (segments.length > 1) throw new Error('ambiguous number evidence');
    value = segments[0]?.slice('QuickBooks no. '.length) ?? '';
  }
  const n = name(value);
  return /^\d+$/.test(n) ? n.replace(/^0+(?=\d)/,'') : n;
}
export function canonicalTransaction(row) {
  let family = name(row.family);
  if (!family) throw new Error('invalid family/type');
  family = family.replace(/^(Bill Payment|Payment) \([^)]*\)$/,'$1');
  if (family === 'Credit Card Expense') family = 'Expense';
  if (!Array.isArray(row.party) || !Array.isArray(row.postings)) throw new Error('invalid transaction fields');
  const party = row.party.map(p=> {
    if (!['customer','vendor'].includes(p.kind) || !name(p.name)) throw new Error('invalid party');
    return {kind:p.kind,name:name(p.name)};
  }).sort((a,b)=>order(JSON.stringify(a),JSON.stringify(b)));
  const postings = row.postings.map(p=> {
    if (!name(p.account)) throw new Error('invalid account');
    return {account:name(p.account),cents:cents(p.cents)};
  }).sort((a,b)=>order(a.account,b.account)||order(BigInt(a.cents),BigInt(b.cents)));
  const result = {family,date:date(row.date),number:normalizedNumber({doc_number:row.number ?? ''}),
    party:[...new Map(party.map(p=>[JSON.stringify(p),p])).values()],postings};
  if (row.voidStatus) result.voidStatus = row.voidStatus;
  if (row.explicitVoidMemo) result.explicitVoidMemo = true;
  return result;
}
export const tuple = row => fields.map(f=>row[f]);
export function indexRepeats(rows) {
  const counts = new Map();
  return rows.map(canonicalTransaction).sort((a,b)=>order(JSON.stringify(tuple(a)),JSON.stringify(tuple(b)))
    || order(JSON.stringify(a),JSON.stringify(b))).map(row=> {
    const key = JSON.stringify(tuple(row)), repeat = (counts.get(key) ?? 0)+1;
    counts.set(key,repeat);
    return {...row,repeat,fingerprint:hash([...tuple(row),repeat])};
  });
}
export function matchTransactions(a,b) {
  const right = new Map(b.map((r,i)=>[JSON.stringify([...tuple(r),r.repeat]),i]));
  const usedA = new Set(), usedB = new Set(), unchanged = [], changed = [], ambiguousCandidates = [];
  a.forEach((r,i)=> {
    const j = right.get(JSON.stringify([...tuple(r),r.repeat]));
    if (j !== undefined) { usedA.add(i); usedB.add(j); unchanged.push({before:r,after:b[j]}); }
  });
  // Index every omission signature, then decide using the complete union of edges.
  const indexes = fields.map(()=>new Map());
  const signature = (r,f) => JSON.stringify([r.repeat,...fields.filter(k=>k!==f).map(k=>r[k])]);
  b.forEach((r,j)=> { if (!usedB.has(j)) fields.forEach((f,k)=> {
    const s=signature(r,f), bucket=indexes[k].get(s)??[]; bucket.push(j); indexes[k].set(s,bucket);
  }); });
  const edges=[], leftDegree=new Map(), rightDegree=new Map();
  a.forEach((r,i)=> { if (!usedA.has(i)) fields.forEach((f,k)=> {
    for (const j of indexes[k].get(signature(r,f))??[]) {
      if (JSON.stringify(r[f])===JSON.stringify(b[j][f])) continue;
      edges.push({i,j,field:f}); leftDegree.set(i,(leftDegree.get(i)??0)+1); rightDegree.set(j,(rightDegree.get(j)??0)+1);
    }
  }); });
  for (const {i,j,field} of edges) {
    const candidate={before:a[i],after:b[j],field};
    if (leftDegree.get(i)===1 && rightDegree.get(j)===1) { changed.push(candidate); usedA.add(i); usedB.add(j); }
    else ambiguousCandidates.push(candidate);
  }
  return {unchanged,added:b.filter((_,i)=>!usedB.has(i)),changed,vanished:a.filter((_,i)=>!usedA.has(i)),ambiguousCandidates};
}
