import { startApp } from './app-harness.js';
import { mvOrg, mvCustomer, mvVendor } from './morning-fixtures.js';
import { mintToken, revokeToken } from '../lib/integration/tokens.js';
import { authenticateBearer } from '../lib/integration/auth.js';
export const SCOPES=['documents:write','bills:approve','payments:write','settlements:read'];
export const invoice=(n='1')=>({source_ref:`invoice:${n}`,doc_number:`INV-${n}`,customer_name:'Sample customer A',
  txn_date:'2026-10-21',due_date:'2026-10-28',total_cents:10000,
  lines:[{item_name:'Sample item A',description:'Sample goods',quantity:'2',rate_cents:5000,amount_cents:10000}]});
export const bill=(n='1')=>({source_ref:`bill:${n}`,doc_number:`VBILL-${n}`,vendor_name:'Sample vendor A',
  txn_date:'2026-10-21',due_date:'2026-11-20',total_cents:10000,approve:true,
  lines:[{item_name:'Sample item A',description:'Sample goods',quantity:'2',rate_cents:5000,amount_cents:10000}]});
export const receipt=(n='1',applications=[])=>({source_ref:`receipt:${n}`,customer_name:'Sample customer A',
  txn_date:'2026-10-22',amount_cents:10000,method:'Other',reference:`R-${n}`,deposit_to_account_name:null,applications});
export async function fixture({scopes=SCOPES,env={}}={}) {
  const app=await startApp({env,seed:async pool=>{
    const x=await mvOrg(pool,{slug:'sample'}), entityId=x.entities['Sample company A'];
    const S={orgId:x.orgId,entityId};
    const customerId=await mvCustomer(pool,{...S,name:'Sample customer A'});
    const vendorId=await mvVendor(pool,{...S,name:'Sample vendor A'});
    const accounts=(await pool.query(`INSERT INTO account(org_id,entity_id,name,type) VALUES
      ($1,$2,'Sample income','income'),($1,$2,'Sample expense','expense') RETURNING account_id,name`,[x.orgId,entityId])).rows;
    const income=accounts.find(a=>a.name==='Sample income').account_id;
    const expense=accounts.find(a=>a.name==='Sample expense').account_id;
    const itemId=(await pool.query(`INSERT INTO item(org_id,entity_id,name,kind,income_account_id,expense_account_id)
      VALUES($1,$2,'Sample item A','product',$3,$4) RETURNING item_id`,[x.orgId,entityId,income,expense])).rows[0].item_id;
    return {...S,customerId,vendorId,itemId,income,expense,entityB:x.entities['Sample company B'],accounts:x.accounts['Sample company A']};
  }});
  const S={orgId:app.ids.orgId,entityId:app.ids.entityId};
  await app.db.pool.query(`INSERT INTO integration_setting(org_id,entity_id,accept_writes,write_floor,ledger_instance)
    VALUES($1,$2,true,'2026-10-21','sample-practice')`,[S.orgId,S.entityId]);
  const minted=await mintToken(app.db.pool,{...S,name:'Sample connector',source:'sample_connector',scopes,actor:'tester'});
  const identity=await authenticateBearer(app.db.pool,{authorization:`Bearer ${minted.token}`});
  return {...app,S,identity,token:minted.token,tokenId:minted.tokenId,pool:app.db.pool,
    revoke:()=>revokeToken(app.db.pool,{...S,tokenId:minted.tokenId,actor:'tester'}),
    count:async table=>Number((await app.db.pool.query(`SELECT count(*) n FROM ${table}`)).rows[0].n),
    books:async()=>Promise.all(['txn','txn_line','posting','application','external_ref'].map(async table=>
      (await app.db.pool.query(`SELECT to_jsonb(x) row FROM ${table} x ORDER BY to_jsonb(x)::text`)).rows)),
    api:async(path,body,headers={})=>{
      const r=await fetch(app.base+'/api/integration/v1'+path,{method:body===undefined?'GET':'POST',
        headers:{authorization:`Bearer ${minted.token}`,'content-type':'application/json',...headers},
        body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
      return {status:r.status,headers:r.headers,body:await r.json()};
    }};
}
