// Only SELECTs and transaction-local read settings. Never call a repair or writer.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { importEvidence } from '../rebuild/import-evidence.js';
import { CARRIED_TABLES, classifyTables } from '../rebuild/tables.js';
import { openItems } from '../reports/receivables.js';
import { canonicalTransaction, indexRepeats, normalizedNumber, name, date, cents, order, hash } from './fingerprint.js';

export class ReferenceRefusal extends Error {}
const refuse = message => { throw new ReferenceRefusal(message); };
const sorted = rows => rows.sort((a,b)=>order(JSON.stringify(a),JSON.stringify(b)));
const quote = s => '"'+s.replaceAll('"','""')+'"';
const id = v => String(v);
const required = {
  org:['org_id','slug'], entity:['org_id','entity_id','name'],
  account:['account_id','org_id','entity_id','name','type','number','active','parent_id'],
  customer:['customer_id','org_id','entity_id','display_name','email','phone'],
  vendor:['vendor_id','org_id','entity_id','display_name','email','phone','account_no'],
  txn:['txn_id','org_id','entity_id','type','source','source_type','txn_date','doc_number','payment_ref','memo','voided_at','companion_of_txn_id'],
  posting:['txn_id','account_id','org_id','entity_id','amount_cents','txn_date'],
  import_batch:['org_id','entity_id','source','company_name','summary'], application:['source'],
};

export function referenceUrl(text) {
  let u;
  try { u=new URL(text); } catch { refuse('invalid database URL file'); }
  if (!['postgres:','postgresql:'].includes(u.protocol) || !u.hostname || !u.pathname.slice(1) || u.hash) refuse('unsupported database URL');
  for (const [key,value] of u.searchParams) {
    if (key.toLowerCase()==='options') refuse('database URL options overrides refused');
    if (key!=='sslmode' || !['disable','require','verify-ca','verify-full','prefer'].includes(value)) refuse('database URL query overrides refused');
  }
  return u.toString();
}

export function accountChart(rows,summary) {
  if (!Array.isArray(summary.renamed) || summary.renamedAccounts!==summary.renamed.length) refuse('malformed rename evidence');
  const aliases=new Map(), originals=new Set(), byId=new Map(rows.map(r=>[id(r.account_id),r]));
  for (const entry of summary.renamed) {
    if (typeof entry!=='string') refuse('malformed rename evidence');
    const parts=entry.split(' → ');
    if (parts.length!==2 || parts.some(s=>!s.trim()) || aliases.has(parts[1]) || originals.has(parts[0])
      || rows.filter(r=>r.name===parts[1]).length!==1) refuse('malformed or ambiguous rename evidence');
    aliases.set(parts[1],parts[0]); originals.add(parts[0]);
  }
  for (const key of aliases.keys()) {
    const visited=new Set(); let next=key;
    while (aliases.has(next)) {
      if (visited.has(next)) refuse('rename evidence cycle');
      visited.add(next); next=aliases.get(next);
    }
  }
  const paths=new Map(), active=new Set();
  function path(r) {
    const key=id(r.account_id);
    if (paths.has(key)) return paths.get(key);
    if (active.has(key)) refuse('account parent cycle');
    active.add(key);
    let parent=null;
    if (r.parent_id!==null) { parent=byId.get(id(r.parent_id)); if (!parent) refuse('invalid account parent'); path(parent); }
    const p=aliases.get(r.name)??(parent?`${path(parent)}:${r.name}`:r.name);
    if (p.split(':').some(s=>!s.trim())) refuse('malformed account path');
    if (aliases.has(r.name) && parent && p.split(':')[0]!==path(parent).split(':')[0]) refuse('inconsistent rename evidence parent');
    active.delete(key); paths.set(key,p); return p;
  }
  const rawParts=new Map(rows.map(r=>[id(r.account_id),path(r).split(':').map(name)]));
  const byPath=new Map();
  for (const r of rows) {
    const key=JSON.stringify(rawParts.get(id(r.account_id))), bucket=byPath.get(key)??[];
    bucket.push(r); byPath.set(key,bucket);
  }
  // Flattened importer rows need the original intermediate parents as well as
  // the actual database parent. Never use row order to choose between parents.
  const lineages=new Map();
  function lineage(r) {
    const key=id(r.account_id);
    if (lineages.has(key)) return lineages.get(key);
    const parts=rawParts.get(key), result=[];
    for (let i=0;i<parts.length;i++) {
      let component=r;
      if (i<parts.length-1) {
        const prefix=JSON.stringify(parts.slice(0,i+1));
        const candidates=byPath.get(prefix)??[];
        const actual=r.parent_id===null?null:byId.get(id(r.parent_id));
        component=actual&&JSON.stringify(rawParts.get(id(actual.account_id)))===prefix?actual:null;
        if (!component && candidates.length>1) refuse('canonical account collision: ambiguous parent path');
        component??=candidates[0];
      }
      const base=parts[i].replace(/\s*\(deleted\)$/,'').trim();
      if (!base) refuse('canonical account collision: empty base name');
      result.push([base,name(component?.number??''),component?.type??'',
        (component?.active??true)&&!/\s*\(deleted\)$/.test(parts[i])]);
    }
    lineages.set(key,result); return result;
  }
  const raw=rows.map(r=> {
    const parts=lineage(r);
    return {name:parts.at(-1)[0],type:r.type,number:name(r.number??''),active:parts.every(p=>p[3]),
      parent:parts.slice(0,-1).map(p=>p[0]).join(':')||null,lineage:parts};
  });
  const [accounts]=resolveAccountIdentities(raw);
  const canonical=new Map(rows.map((r,i)=>[id(r.account_id),accounts[i].path]));
  return {accounts:sorted(accounts),canonical};
}

const baseIdentity = parts => JSON.stringify(parts.map(p=>p.slice(0,3)));
// Compute a common policy for both references. Status participates only where
// one source contains otherwise identical accounts; a lone reactivation pairs.
export function resolveAccountIdentities(...charts) {
  const statusPrefixes=new Set();
  for (const accounts of charts) {
    const groups=new Map();
    for (const a of accounts) {
      const key=baseIdentity(a.lineage), bucket=groups.get(key)??[];
      bucket.push(a); groups.set(key,bucket);
    }
    for (const group of groups.values()) if (group.length>1) {
      for (let i=0;i<group[0].lineage.length;i++) {
        if (new Set(group.map(a=>a.lineage[i][3])).size>1)
          statusPrefixes.add(baseIdentity(group[0].lineage.slice(0,i+1)));
      }
    }
  }
  const identityParts=a=>a.lineage.map((p,i)=>[...p.slice(0,3),
    statusPrefixes.has(baseIdentity(a.lineage.slice(0,i+1)))?p[3]:null]);
  const display=parts=>parts.map(p=>p[0]+(p[3]===false?' (deleted)':'')).join(':');
  const identities=new Map(), labels=new Map();
  const result=charts.map(accounts=> {
    const seen=new Set();
    return accounts.map(a=> {
      const parts=identityParts(a), identity=JSON.stringify(parts);
      if (seen.has(identity)) refuse('canonical account collision: indistinguishable canonical tuple');
      seen.add(identity); identities.set(identity,parts);
      const label=display(parts), bucket=labels.get(label)??new Set();
      bucket.add(identity); labels.set(label,bucket);
      return {...a,identity,parentIdentity:JSON.stringify(parts.slice(0,-1))};
    });
  });
  const paths=new Map(), used=new Set();
  for (const [identity,parts] of identities) {
    const label=display(parts);
    const path=labels.get(label).size===1?label:`${label} [identity ${JSON.stringify(parts.map(p=>p.slice(1,3)))}]`;
    if (used.has(path)) refuse('canonical account collision: ambiguous identity label');
    used.add(path); paths.set(identity,path);
  }
  return result.map(accounts=>accounts.map(a=>({...a,path:paths.get(a.identity),
    parent:a.lineage.length===1?null:paths.get(a.parentIdentity)??display(JSON.parse(a.parentIdentity))})));
}

export function alignAccountCompanies(...companies) {
  const charts=resolveAccountIdentities(...companies.map(c=>c.accounts));
  return companies.map((c,i)=> {
    const remap=new Map(c.accounts.map((a,j)=>[a.path,charts[i][j].path]));
    const transactions=indexRepeats(c.transactions.map(t=>({...t,postings:t.postings.map(p=> {
      if (!remap.has(p.account)) refuse('invalid canonical posting account');
      return {...p,account:remap.get(p.account)};
    })})));
    const result={...c,accounts:sorted(charts[i]),transactions,
      customers:c.customers.map(p=>({...p})),vendors:c.vendors.map(p=>({...p}))};
    usageEvidence(result); return result;
  });
}
function parties(rows,kind) {
  const seen=new Set();
  return sorted(rows.map(r=> {
    const display=name(r.display_name);
    if (!display || seen.has(display)) refuse('canonical party collision'); seen.add(display);
    const contact=[r.email??'',r.phone??'',r.account_no??''].map(s=>name(s));
    return {name:display,kind,contactSignature:contact.some(Boolean)?hash(contact):null};
  }));
}
function identityEvidence(summary,transactions,customers,vendors) {
  const e=summary.referenceIdentity;
  if (!e || e.version!==1 || e.partyPolicy!=='complete-input-customer-use-v1') {
    refuse('insufficient original party and number evidence; fresh import from retained exports required');
  }
  if (!Array.isArray(e.transactions)) refuse('malformed original identity evidence');
  const expected=new Set(transactions.filter(t=>t.companion_of_txn_id===null).map(t=>id(t.txn_id))), out=new Map();
  const validParty=p=>p && ['customer','vendor'].includes(p.kind) && typeof p.name==='string'
    && (p.kind==='customer'?customers:vendors).some(r=>r.name===name(p.name));
  const checkParty=p=> { if (!Array.isArray(p) || !p.every(validParty)) refuse('invalid original party evidence'); };
  for (const r of e.transactions) {
    if (!expected.has(id(r.txnId)) || out.has(id(r.txnId)) || !(r.number===null||typeof r.number==='string')) refuse('malformed original number evidence');
    checkParty(r.party); out.set(id(r.txnId),r);
  }
  if (out.size!==expected.size) refuse('incomplete original identity evidence');
  return {out,checkParty};
}

function usageEvidence(c) {
  const accountUse=new Map(), partyUse=new Map();
  for (const t of c.transactions) {
    for (const account of new Set(t.postings.map(p=>p.account))) {
      const vector=t.postings.map(p=>({...p,account:p.account===account?'':p.account}));
      const sig=hash([t.family,t.date,t.number,t.party,sorted(vector)]);
      const list=accountUse.get(account)??[]; list.push(sig); accountUse.set(account,list);
    }
    for (const party of t.party) {
      const key=JSON.stringify(party), list=partyUse.get(key)??[];
      list.push(hash([t.family,t.date,t.number,t.party.filter(p=>JSON.stringify(p)!==key),t.postings])); partyUse.set(key,list);
    }
  }
  for (const a of c.accounts) a.usageSignature=accountUse.has(a.path)?hash(accountUse.get(a.path).sort()):null;
  for (const p of [...c.customers,...c.vendors]) {
    const use=partyUse.get(JSON.stringify({kind:p.kind,name:p.name})); p.usageSignature=use?hash(use.sort()):null;
  }
}

export async function readReference(urlFile) {
  let client, phase='URL file';
  try {
    const connectionString=referenceUrl((await readFile(urlFile,'utf8')).trim());
    phase='connection';
    client=new pg.Client({connectionString,connectionTimeoutMillis:5000,application_name:'financial-books-ref-diff',
      types:{getTypeParser:(oid,format)=>[20,1082,1114,1184].includes(oid)?v=>v:pg.types.getTypeParser(oid,format)}});
    client.on('error',()=>{});
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if ((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only!=='on') refuse('read-only transaction required');
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query('SET LOCAL search_path=public,pg_catalog');
    phase='schema';
    if ((await classifyTables(client)).length) refuse('unclassified source tables');
    const cols=(await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'")).rows;
    for (const [table,names] of Object.entries(required)) if (names.some(n=>!cols.some(c=>c.table_name===table&&c.column_name===n))) refuse('missing expected columns');
    const migrations=(await client.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r=>r.name);
    if (!migrations.length) refuse('missing migration evidence');
    const orgs=(await client.query('SELECT org_id,slug FROM org')).rows;
    if (orgs.length!==1) refuse('exactly one org required');
    const org=orgs[0], entities=(await client.query('SELECT org_id,entity_id,name FROM entity ORDER BY name')).rows;
    if (!entities.length || entities.some(e=>id(e.org_id)!==id(org.org_id)||!e.name.trim()) || new Set(entities.map(e=>e.name)).size!==entities.length) refuse('nonempty unique company set required');
    phase='source purity';
    for (const table of ['txn','application']) if ((await client.query(`SELECT 1 FROM ${table} WHERE source IS DISTINCT FROM 'qbo_import' LIMIT 1`)).rowCount) refuse('non-import source rows');
    if ((await importEvidence(client)).errors.length) refuse('import_batch evidence inconsistent or missing');
    for (const table of CARRIED_TABLES) if ((await client.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`)).rowCount) refuse('carried source state');
    const batches=(await client.query('SELECT org_id,entity_id,source,company_name,summary FROM import_batch')).rows;
    if (batches.length!==entities.length || batches.some(b=>b.source!=='qbo_import'||id(b.org_id)!==id(org.org_id))) refuse('import_batch source evidence invalid');
    const companies=[];
    for (const entity of entities) {
      phase='snapshot content';
      const batch=batches.find(b=>id(b.entity_id)===id(entity.entity_id));
      if (!batch || batch.company_name!==entity.name) refuse('import_batch company evidence invalid');
      const s=batch.summary;
      const rows=async table=>(await client.query(`SELECT * FROM ${quote(table)} WHERE org_id=$1 AND entity_id=$2`,[org.org_id,entity.entity_id])).rows;
      const {accounts,canonical}=accountChart(await rows('account'),s);
      const customers=parties(await rows('customer'),'customer'),vendors=parties(await rows('vendor'),'vendor');
      const txns=await rows('txn'), posts=await rows('posting'), byId=new Map(txns.map(r=>[id(r.txn_id),r]));
      const {out:evidence,checkParty}=identityEvidence(s,txns,customers,vendors);
      const grouped=new Map();
      for (const t of txns) if (t.companion_of_txn_id!==null) {
        const p=byId.get(id(t.companion_of_txn_id));
        if (!p || p.companion_of_txn_id!==null || !['invoice','sales_receipt','credit_memo'].includes(p.type)
          || !['Invoice','Sales Receipt','Credit Memo'].includes(p.source_type) || t.type!=='journal_entry'
          || t.source_type!=='Journal Entry' || t.txn_date!==p.txn_date || !!t.voided_at!==!!p.voided_at) refuse('invalid COGS companion relationship');
      }
      for (const p of posts) {
        const t=byId.get(id(p.txn_id)), account=canonical.get(id(p.account_id));
        if (!t || !account || p.txn_date!==t.txn_date) refuse('invalid posting relationship');
        const key=id(t.companion_of_txn_id??t.txn_id), vector=grouped.get(key)??[];
        vector.push({account,cents:cents(String(p.amount_cents))}); grouped.set(key,vector);
      }
      const raw=[];
      for (const t of txns) if (t.companion_of_txn_id===null) {
        const e=evidence.get(id(t.txn_id)), postings=grouped.get(id(t.txn_id))??[];
        if (!t.voided_at && !postings.length) refuse('primary document missing postings');
        if (postings.reduce((n,p)=>n+BigInt(p.cents),0n)!==0n) refuse('unbalanced primary document');
        raw.push({family:t.source_type,date:t.txn_date,number:e.number??'',party:e.party,postings,
          ...(t.voided_at?{voidStatus:'voided'}:{}),...(/\bvoided\b/i.test(t.memo??'')?{explicitVoidMemo:true}:{})});
      }
      if (!Array.isArray(s.omittedTransactions) || !Number.isSafeInteger(s.omitted) || s.omitted!==s.omittedTransactions.length) refuse('malformed omission evidence');
      for (const o of s.omittedTransactions) {
        if (!o || typeof o.type!=='string'||!o.type || !(o.num===null||typeof o.num==='string')
          || !(o.name===null||typeof o.name==='string') || !(o.memo===null||typeof o.memo==='string')
          || !Number.isSafeInteger(o.row) || typeof o.reason!=='string' || !o.reason.startsWith('no amounts')
          || !Array.isArray(o.lines) || !o.lines.length || o.lines.some(n=>typeof n!=='string'||!n)) refuse('malformed omission evidence');
        checkParty(o.party);
        raw.push({family:o.type,date:o.date,number:o.num??'',party:o.party,postings:[],voidStatus:'possible_void',
          ...(/\bvoided\b/i.test(o.memo??'')?{explicitVoidMemo:true}:{})});
      }
      const transactions=indexRepeats(raw), open=[];
      for (const side of ['ar','ap']) for (const o of await openItems(client,{orgId:org.org_id,entityId:entity.entity_id,side,asOf:'9999-12-31'})) {
        if (!Number.isSafeInteger(o.open)||!Number.isSafeInteger(o.total)||!Number.isSafeInteger(o.txnId)) refuse('unsafe open-item integer');
        const t=byId.get(id(o.txnId)), e=evidence.get(id(o.txnId));
        if (!t||!e) refuse('open-item original identity missing');
        open.push({side,party:name(o.partyName),family:canonicalTransaction({family:t.source_type,date:o.date,number:'',party:[],postings:[]}).family,
          date:date(o.date),number:normalizedNumber({doc_number:e.number??''}),due:date(o.due),cents:String(o.open)});
      }
      const repeats=new Map();
      const openRows=sorted(open).map(r=> { const key=JSON.stringify(r),repeat=(repeats.get(key)??0)+1; repeats.set(key,repeat);return {...r,repeat}; });
      if (!Array.isArray(s.acceptedMismatches)||s.acceptedMismatches.some(x=>typeof x!=='string')) refuse('invalid accepted mismatch evidence');
      const c={company:entity.name,transactions,accounts,customers,vendors,openItems:openRows,
        importRange:{from:s.from,to:s.to},acceptedMismatches:[...s.acceptedMismatches].sort(),omissions:s.omitted};
      usageEvidence(c); companies.push(c);
    }
    companies.sort((a,b)=>order(a.company,b.company));
    const database=(await client.query('SELECT current_database() AS name')).rows[0].name.replace(/[^a-zA-Z0-9_.-]/g,'_');
    return {database,migrations,orgSlug:org.slug,companies,contentHash:hash([org.slug,migrations,companies])};
  } catch (error) {
    if (error instanceof ReferenceRefusal) throw error;
    // Neither a driver error nor a file error may echo credentials, rows, or paths.
    throw new ReferenceRefusal(`reference read failed (${phase})`);
  } finally {
    if (client) { await client.query('ROLLBACK').catch(()=>{}); await client.end().catch(()=>{}); }
  }
}
