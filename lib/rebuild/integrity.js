import { postingsFor } from '../domain/ledger.js';
import { isDeepStrictEqual } from 'node:util';

// Read-only counterpart of ensureLedger's missing-postings predicate. Never repair at a gate.
export async function missingPostings(db) {
  const { rows: [row] } = await db.query(`SELECT count(*)::int AS n FROM txn t
    WHERE t.voided_at IS NULL AND t.total_cents > 0 AND t.type NOT IN ('purchase_order', 'estimate')
      AND NOT EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.txn_id)`);
  return row.n;
}

// Use the pure posting rules to include implicit control accounts, deposit lines,
// item accounts and signed journal lines. No ensureLedger/repost/writer is called.
export async function childCompleteness(db) {
  const errors=[];
  const txns=(await db.query('SELECT * FROM txn ORDER BY txn_id')).rows;
  const group=rows=>{
    const out=new Map();
    for(const row of rows) { const id=String(row.txn_id ?? row.deposit_txn_id); if(!out.has(id))out.set(id,[]); out.get(id).push(row); }
    return out;
  };
  const lines=group((await db.query('SELECT * FROM txn_line')).rows);
  const deposits=group((await db.query('SELECT * FROM deposit_line')).rows);
  const postings=group((await db.query('SELECT * FROM posting')).rows);
  const accounts=(await db.query('SELECT * FROM account')).rows;
  const items=new Map((await db.query('SELECT * FROM item')).rows.map(i=>[String(i.item_id),i]));
  const vector=rows=>{
    const sums=new Map();
    for(const p of rows) {
      const cents=BigInt(p.amountCents ?? p.amount_cents),key=`${p.accountId ?? p.account_id}:${p.txn_date}:${cents<0n?'credit':'debit'}`;
      sums.set(key,(sums.get(key)??0n)+cents);
    }
    return [...sums].filter(([,n])=>n!==0n).map(([k,n])=>[k,n.toString()]).sort(([a],[b])=>a.localeCompare(b));
  };
  for(const t of txns) {
    const actual=postings.get(String(t.txn_id))??[];
    const label=`transaction ${t.doc_number ?? t.txn_id}`;
    // writePostings (called by repost/repostMany) always uses the header date.
    if (actual.some(p=>String(p.txn_date)!==String(t.txn_date))) errors.push(`${label}: posting date differs from transaction date`);
    const debit=actual.reduce((s,p)=>s+(BigInt(p.amount_cents)>0n?BigInt(p.amount_cents):0n),0n);
    const postingRequired=!t.voided_at && !['estimate','purchase_order'].includes(t.type);
    if (postingRequired && debit!==BigInt(t.total_cents)) errors.push(`${label}: total_cents does not equal sum of debit postings`);
    const txnLines=lines.get(String(t.txn_id))??[], depositLines=deposits.get(String(t.txn_id))??[];
    if (postingRequired && BigInt(t.total_cents)===0n
      && [...txnLines,...depositLines].some(l=>BigInt(l.amount_cents)!==0n || BigInt(l.cost_cents??0)!==0n)) {
      errors.push(`${label}: zero total has economic lines without matching postings`);
    }
    const sys=Object.fromEntries(accounts.filter(a=>a.org_id===t.org_id && a.entity_id===t.entity_id && a.system_key).map(a=>[a.system_key,a.account_id]));
    try {
      const expected=postingsFor({txn:t,lines:txnLines,depositLines,sys,
        incomeAccount:id=>items.get(String(id))?.income_account_id,
        expenseAccount:id=>items.get(String(id))?.expense_account_id,
        inventory:id=>{const i=items.get(String(id));return i?.kind==='inventory'?{asset:i.asset_account_id??sys.inventory,cogs:i.expense_account_id??sys.cogs}:null;}});
      if(!isDeepStrictEqual(vector(expected.map(p=>({...p,txn_date:t.txn_date}))),vector(actual))) errors.push(`${label}: lines and postings disagree per account and date`);
    } catch { errors.push(`${label}: lines and postings cannot agree per account with the header`); }
  }
  return {transactions:txns.length,errors};
}
