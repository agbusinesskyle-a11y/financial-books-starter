import { importQboCompany } from '../lib/import/qbo-import.js';
import { mintToken } from '../lib/integration/tokens.js';
import { authenticateBearer } from '../lib/integration/auth.js';
import { SCOPES } from './integration-fixtures.js';

// Real account-based importer input, equivalent to readQboExport's output. Sample names only.
export async function importedFixture(f,{ambiguous=false}={}) {
  const accounts=[['Sample checking','Bank','Checking'],['Sample receivable','Accounts receivable (A/R)','Accounts Receivable (A/R)'],
    ['Sample payable','Accounts payable (A/P)','Accounts Payable (A/P)'],['Sample income','Income','Service/Fee Income'],['Sample expense','Expenses','Supplies']]
    .map(([name,type,detail])=>({name,fullName:name,parent:null,type,detail}));
  const make=(type,num,name,date,legs)=>({type,num,name,date,memo:null,lines:legs.map(([account,amount])=>({account,debit:Math.max(amount,0),credit:Math.max(-amount,0),name:null,memo:null}))});
  const txns=[
    make('Invoice','INV-paid-1','Sample customer A','2026-10-20',[['Sample receivable',10000],['Sample income',-10000]]),
    make('Invoice','INV-paid-2','Sample customer A','2026-10-21',[['Sample receivable',10000],['Sample income',-10000]]),
    make('Payment','R-1','Sample customer A','2026-10-22',[['Sample checking',10000],['Sample receivable',-10000]]),
    make('Credit Memo','CM-1','Sample customer A','2026-10-23',[['Sample receivable',-10000],['Sample income',10000]]),
    make('Bill','VBILL-paid','Sample vendor A','2026-10-20',[['Sample payable',-10000],['Sample expense',10000]]),
    ...(ambiguous?[make('Bill','VBILL-paid','Sample vendor A','2026-10-20',[['Sample payable',-10000],['Sample expense',10000]])]:[]),
    make('Bill Payment (Check)','1042','Sample vendor A','2026-10-22',[['Sample payable',ambiguous?20000:10000],['Sample checking',ambiguous?-20000:-10000]]),
    make('Invoice','INV-open','Sample customer A','2026-10-24',[['Sample receivable',10000],['Sample income',-10000]]),
  ];
  const trialBalance={};for(const t of txns)for(const l of t.lines)trialBalance[l.account]=(trialBalance[l.account]??0)+l.debit-l.credit;
  const data={accounts,txns,trialBalance,customers:[{name:'Sample customer A'},{name:'Sample customer B'}],vendors:[{name:'Sample vendor A'},{name:'Sample vendor B'}],employees:[],
    openItems:[{side:'ar',type:'Invoice',num:'INV-open',date:'2026-10-24',name:'Sample customer A',open:10000,due:'2026-11-23'}],hasAging:{ar:true,ap:true}};
  const imported=await importQboCompany(f.pool,{orgId:f.S.orgId,companyName:'Sample imported company',data,actor:'tester'});
  const S={orgId:f.S.orgId,entityId:imported.entityId};
  await f.pool.query(`INSERT INTO item(org_id,entity_id,name,kind,income_account_id,expense_account_id) VALUES($1,$2,'Sample item A','product',$3,$4)`,
    [S.orgId,S.entityId,imported.accountIds['Sample income'],imported.accountIds['Sample expense']]);
  await f.pool.query(`INSERT INTO integration_setting(org_id,entity_id,accept_writes,write_floor,ledger_instance) VALUES($1,$2,true,'2027-01-01','sample-import')`,[S.orgId,S.entityId]);
  const minted=await mintToken(f.pool,{...S,name:'Sample import token',source:'sample_connector',scopes:SCOPES,actor:'tester'});
  const identity=await authenticateBearer(f.pool,{authorization:`Bearer ${minted.token}`});
  const doc=(kind,n)=>({source_ref:`${kind}:${n}`,doc_number:kind==='bill'?'VBILL-paid':`INV-${n}`,
    [kind==='bill'?'vendor_name':'customer_name']:kind==='bill'?'Sample vendor A':'Sample customer A',
    txn_date:n==='open'?'2026-10-24':n==='paid-2'?'2026-10-21':'2026-10-20',
    due_date:n==='open'?'2026-11-23':n==='paid-2'?'2026-11-20':'2026-11-19',terms_name:'Net 30',total_cents:10000,adopt_only:true,
    ...(kind==='bill'?{approve:true}:{}),lines:[{item_name:'Sample item A',description:'Sample goods',quantity:'2',rate_cents:5000,amount_cents:10000}]});
  const snapshot=async()=>Promise.all(['txn','txn_line','posting','application'].map(async table=>(await f.pool.query(`SELECT to_jsonb(x) row FROM ${table} x ORDER BY to_jsonb(x)::text`)).rows));
  return {...S,identity,doc,snapshot,imported};
}
