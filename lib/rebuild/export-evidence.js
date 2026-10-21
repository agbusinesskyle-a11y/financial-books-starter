import { join } from 'node:path';
import { readTrialBalance, readJournal } from '../import/qbo-read.js';

// Read once before copy, then check the same retained evidence on both snapshots.
export async function readExportEvidence(folder, companies) {
  return Promise.all(companies.map(async c => {
    let trialBalance;
    try { trialBalance=await readTrialBalance(join(folder,c.slug,'export')); }
    catch { throw new Error(`Trial_balance.xlsx for ${c.fbName}: missing or invalid export evidence`); }
    try { return {...c, trialBalance, journal:await readJournal(join(folder,c.slug,'export'))}; }
    catch { throw new Error(`Journal.xlsx for ${c.fbName}: missing or invalid export evidence`); }
  }));
}

export async function exportEvidence(db, exports) {
  const errors = [], companies = [];
  for (const evidence of exports) {
    const entities = (await db.query('SELECT org_id,entity_id FROM entity WHERE name=$1',[evidence.fbName])).rows;
    if (entities.length !== 1) { errors.push(`Trial_balance.xlsx for ${evidence.fbName}: company does not resolve uniquely`); continue; }
    const e=entities[0];
    const batches=(await db.query('SELECT summary FROM import_batch WHERE org_id=$1 AND entity_id=$2',[e.org_id,e.entity_id])).rows;
    if (batches.length !== 1) { errors.push(`Trial_balance.xlsx for ${evidence.fbName}: requires one import_batch`); continue; }
    const summary=batches[0].summary;
    const acceptedDeltas=recordedDeltas(summary.acceptedMismatches);
    const accounts=(await db.query(`SELECT a.account_id,a.name,a.number,a.parent_id,
      coalesce(sum(p.amount_cents),0)::text AS cents FROM account a LEFT JOIN posting p ON p.account_id=a.account_id
      WHERE a.org_id=$1 AND a.entity_id=$2 GROUP BY a.account_id ORDER BY a.name`,[e.org_id,e.entity_id])).rows;
    // The importer flattens deeper subaccounts and disambiguates repeated leaf
    // names. Its retained rename evidence preserves the original QBO full path.
    const renamed=new Map();
    for(const entry of summary.renamed ?? []) {
      const at=entry.lastIndexOf(' → ');
      if (at<0 || renamed.has(entry.slice(at+3))) throw new Error('Trial_balance.xlsx: ambiguous importer account rename evidence');
      renamed.set(entry.slice(at+3),entry.slice(0,at));
    }
    const fullName=(a,seen=new Set())=>{
      if (seen.has(a.account_id)) throw new Error('Trial_balance.xlsx: cyclic account parent identity');
      seen.add(a.account_id);
      if (renamed.has(a.name)) return renamed.get(a.name);
      if (a.parent_id == null) return a.name;
      const parent=accounts.find(p=>p.account_id===a.parent_id);
      if (!parent) throw new Error('Trial_balance.xlsx: missing account parent identity');
      return `${fullName(parent,seen)}:${a.name}`;
    };
    const aliases=new Map();
    for(const a of accounts) {
      a.exportName=fullName(a);
      for(const name of [a.exportName,...(a.number?[`${a.number} ${a.exportName}`]:[])]) {
        if (aliases.has(name)) throw new Error('Trial_balance.xlsx: duplicate account natural identity');
        aliases.set(name,a);
      }
    }
    const seen=new Set(), differences=[];
    const compare=(name,expected,actual)=>{
      if (BigInt(expected) === BigInt(actual) && !acceptedDeltas.has(name)) return;
      // Bind the account in this company's batch to its retained export value
      // and the exact approved Y-X delta. An account name is never a waiver.
      const approved=acceptedDeltas.get(name);
      const accepted=!!approved && approved.expected===BigInt(expected)
        && BigInt(actual)-BigInt(expected)===approved.delta;
      differences.push({account:name,expectedCents:String(expected),actualCents:String(actual),accepted});
      if (!accepted) errors.push(`Trial_balance.xlsx for ${evidence.fbName}: ${name} balance differs (${expected} vs ${actual} cents)`);
    };
    for(const [name,cents] of Object.entries(evidence.trialBalance)) {
      const a=aliases.get(name);
      if (a && seen.has(a.account_id)) throw new Error('Trial_balance.xlsx: multiple export names resolve to one account');
      if (a) seen.add(a.account_id);
      compare(name,cents,a?.cents ?? '0');
    }
    for(const a of accounts) if (!seen.has(a.account_id)) compare(a.exportName,'0',a.cents);
    const journal=await journalEvidence(db,e,evidence,aliases);
    errors.push(...journal.errors);
    companies.push({company:evidence.fbName,accounts:accounts.length,differences,journal});
  }
  return {companies,errors};
}

function recordedDeltas(records) {
  const out=new Map();
  const cents=text=>{
    const negative=text.startsWith('-'), unsigned=negative?text.slice(1):text;
    const [whole,fraction]=unsigned.split('.');
    return (BigInt(whole)*100n+BigInt(fraction))*(negative?-1n:1n);
  };
  for (const record of Array.isArray(records)?records:[]) {
    if (typeof record!=='string') continue;
    // These are the two exact formats emitted by qbo-import.trialBalanceCheck.
    const match=/^(.+): QuickBooks (-?\d+\.\d{2}), here (-?\d+\.\d{2})(?: \(no such account\))?$/.exec(record);
    const absent=/^(.+): not on QuickBooks’ Trial Balance, here (-?\d+\.\d{2})$/.exec(record);
    if (!match && !absent) continue;
    const name=(match??absent)[1], expected=match?cents(match[2]):0n, actual=cents(match?match[3]:absent[2]);
    // Multiple approvals for one account are ambiguous, even if one matches.
    out.set(name,out.has(name)?null:{expected,delta:actual-expected});
  }
  return out;
}

// qbo-import omits only transactions with no debit/credit lines. Each other
// Journal transaction yields one primary transaction regardless of its native
// type or journal fallback. COGS companions add rows, not Journal transactions;
// include their postings in the same month's account debit/credit totals.
// Signed line amounts match the importer's debit-credit transformation. Neither
// accepted trial-balance differences nor batch counts waive Journal history.
async function journalEvidence(db, entity, evidence, aliases) {
  const errors=[], prefix=`Journal.xlsx for ${evidence.fbName}`;
  if (!Array.isArray(evidence.journal)) return {errors:[`${prefix}: missing retained Journal evidence`]};
  const meaningful=evidence.journal.filter(t=>t.lines.some(l=>l.debit || l.credit));
  const txns=(await db.query(`SELECT txn_id,companion_of_txn_id,txn_date,type FROM txn
    WHERE org_id=$1 AND entity_id=$2 AND source='qbo_import'`,[entity.org_id,entity.entity_id])).rows;
  const primary=txns.filter(t=>t.companion_of_txn_id==null);
  if (primary.length!==meaningful.length) errors.push(`${prefix}: transaction count after zero-amount omissions differs (${meaningful.length} vs ${primary.length})`);
  for (const t of txns.filter(t=>t.companion_of_txn_id!=null)) {
    const parent=primary.find(p=>p.txn_id===t.companion_of_txn_id);
    if (!parent || parent.txn_date!==t.txn_date || t.type!=='journal_entry'
      || !['invoice','credit_memo','sales_receipt'].includes(parent.type)) errors.push(`${prefix}: invalid COGS companion relationship`);
  }
  const expected=new Map(), actual=new Map();
  const add=(map,month,account,cents)=>{
    const n=BigInt(cents); if (!n) return;
    const key=JSON.stringify([month,String(account),n<0n?'credit':'debit']);
    map.set(key,(map.get(key)??0n)+(n<0n?-n:n));
  };
  for (const t of meaningful) for (const l of t.lines) {
    if (!l.debit && !l.credit) continue;
    const a=aliases.get(l.account);
    if (!a) { errors.push(`${prefix}: account does not resolve: ${l.account}`); continue; }
    add(expected,t.date.slice(0,7),a.account_id,BigInt(l.debit)-BigInt(l.credit));
  }
  const postings=(await db.query(`SELECT p.account_id,p.txn_date::text,p.amount_cents::text FROM posting p
    JOIN txn t ON t.txn_id=p.txn_id WHERE t.org_id=$1 AND t.entity_id=$2 AND t.source='qbo_import'`,[entity.org_id,entity.entity_id])).rows;
  for (const p of postings) add(actual,p.txn_date.slice(0,7),p.account_id,p.amount_cents);
  for (const key of new Set([...expected.keys(),...actual.keys()])) {
    const want=expected.get(key)??0n,have=actual.get(key)??0n;
    if (want===have) continue;
    const [month,account,side]=JSON.parse(key);
    const name=[...aliases.values()].find(a=>String(a.account_id)===account)?.exportName ?? account;
    errors.push(`${prefix}: ${month} ${name} ${side} differs (${want} vs ${have} cents)`);
  }
  return {transactions:meaningful.length,omitted:evidence.journal.length-meaningful.length,
    importedTransactions:txns.length,primaryTransactions:primary.length,companions:txns.length-primary.length,
    monthlyAccountSides:expected.size,errors};
}
