import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import { freshDb } from './harness.js';
import { writeExport, trialBalanceOf } from './qbo-fixture.js';
import { readQboExport } from '../lib/import/qbo-read.js';
import { importQboCompany } from '../lib/import/qbo-import.js';
export const baseTxns = () => [
  ['01/10/2026','Check','101','Sample vendor A',null,[['Operating',0,10],['Repairs',10,0]]],
  ['02/10/2026','Check','102','Sample vendor A',null,[['Operating',0,20],['Fuel',20,0]]],
  ['03/10/2026','Check','103','Sample vendor A',null,[['Operating',0,30],['Repairs',30,0]]],
  ['04/01/2026','Invoice','I-1','Sample customer A',null,[['Accounts Receivable',100,0],['Sales',0,100]]],
  ['04/02/2026','Invoice','I-2','Sample customer A',null,[['Accounts Receivable',100,0],['Sales',0,100]]],
  ['04/03/2026','Payment','P-1','Sample customer A',null,[['Operating',100,0],['Accounts Receivable',0,100]]],
  ['04/04/2026','Bill','B-1','Sample vendor A',null,[['Accounts Payable',0,40],['Repairs',40,0]]],
  ['04/05/2026','Bill Payment (Check)','BP-1','Sample vendor A',null,[['Accounts Payable',10,0],['Operating',0,10]]],
  ['05/01/2026','Check','D-1','Sample vendor A',null,[['Operating',0,5],['Repairs',5,0]]],
  ['05/01/2026','Check','D-1','Sample vendor A',null,[['Operating',0,5],['Repairs',5,0]]],
];
export const baseOpen = () => [
  {side:'ar',type:'Invoice',date:'2026-04-02',num:'I-2',name:'Sample customer A',due:'2026-05-02',open:10000},
  {side:'ap',type:'Bill',date:'2026-04-04',num:'B-1',name:'Sample vendor A',due:'2026-05-04',open:3000},
];
const csv=v=>'"'+String(v??'').replaceAll('"','""')+'"';
export async function reference(t, options={}) {
  const dir=await mkdtemp(join(tmpdir(),'fb-refdiff-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=await freshDb(); t.after(()=>db.drop());
  assert.match(new URL(db.url).pathname,/^\/fb_test_[a-f0-9]{12}$/);
  const {rows:[org]}=await db.pool.query('INSERT INTO org(slug,name) VALUES($1,$2) RETURNING org_id',
    [options.orgSlug??'sample','Sample organization']);
  const txns=options.txns??baseTxns(), aliases=options.aliases??{};
  const rename=v=>typeof v==='string'?aliases[v]??v:v;
  for(const [index,company] of (options.companies??['Sample company A']).entries()) {
    const folder=join(dir,`company-${index}`);
    await writeExport(folder,{txns,tb:trialBalanceOf(txns)});
    for(const file of ['Journal.xlsx','Trial_balance.xlsx']) {
      const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile(join(folder,file));
      wb.worksheets[0].eachRow(row=>row.eachCell(cell=>{cell.value=rename(cell.value);}));
      await wb.xlsx.writeFile(join(folder,file));
    }
    const accounts=JSON.parse(await readFile(join(folder,'accounts.json'),'utf8'));
    for(const a of accounts) {
      if(a.fullName==='Repairs') a.number='6100';
      a.fullName=rename(a.fullName); a.name=a.fullName.split(':').at(-1);
      a.parent=a.fullName.includes(':')?a.fullName.split(':').slice(0,-1).join(':'):null;
      if(a.name.endsWith('(deleted)')||a.name===options.inactive) a.deleted=true;
    }
    if(options.extraAccounts) accounts.push(...options.extraAccounts);
    if(options.reverseChart) accounts.reverse();
    await writeFile(join(folder,'accounts.json'),JSON.stringify(accounts));
    for(const kind of ['customer','vendor']) {
      const wb=new ExcelJS.Workbook(), ws=wb.addWorksheet('Contacts');
      const label=kind==='customer'?'Customer':'Vendor';
      ws.addRow(['Sample company A']); ws.addRow([`${label} Contact List`]);
      ws.addRow([label,'Email','Phone Numbers','Account #']);
      const contacts=[[rename(`Sample ${kind} A`),`${kind}@sample.example`,'555-0100',kind==='vendor'?'S-1':null],
        ...(options.addLists?[[`Sample ${kind} B`,`${kind}-b@sample.example`,'555-0101',null]]:[]),
        ...(options.contacts?.[kind]??[])];
      if(options.reverseContacts) contacts.reverse();
      for(const contact of contacts) ws.addRow(contact);
      await wb.xlsx.writeFile(join(folder,kind==='customer'?'Customers.xlsx':'Vendors.xlsx'));
    }
    for(const side of ['ar','ap']) {
      const rows=[['Date','Transaction type','Num',side==='ar'?'Customer':'Vendor','Due date','Open balance'],
        ...(options.open??baseOpen()).filter(o=>o.side===side).map(o=>[o.date,o.type,o.num,rename(o.name),o.due,o.open/100])];
      await writeFile(join(folder,side==='ar'?'Accounts_receivable_aging_detail.csv':'Accounts_payable_aging_detail.csv'),
        rows.map(r=>r.map(csv).join(',')).join('\n')+'\n');
    }
    await importQboCompany(db.pool,{orgId:org.org_id,companyName:company,timeZone:'America/Phoenix',
      data:await readQboExport(folder),actor:'Sample importer'});
  }
  const urlFile=join(dir,'reference.url'); await writeFile(urlFile,db.url,{mode:0o600});
  return {...db,dir,urlFile};
}
export async function invoke(args) {
  try {return {code:0,...await promisify(execFile)(process.execPath,['scripts/ref-diff.mjs',...args],
    {env:{...process.env,ALLOW_SUPERUSER:'1'},maxBuffer:8e6})};}
  catch(e) {return {code:e.code,stdout:e.stdout??'',stderr:e.stderr??''};}
}
export async function databaseContent(db) {
  const {rows}=await db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const out={};
  for(const {tablename} of rows) {
    const name='"'+tablename.replaceAll('"','""')+'"';
    out[tablename]=(await db.pool.query(`SELECT to_jsonb(t)::text AS row FROM ${name} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  out.sequences={};
  const sequences=(await db.pool.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;
  for(const {sequencename} of sequences) out.sequences[sequencename]=(await db.pool.query(`SELECT last_value::text,is_called FROM "${sequencename.replaceAll('"','""')}"`)).rows;
  return out;
}

export const conformanceTxns=()=>[...baseTxns(),
  ['06/01/2026','Check','M-1','Sample mixed party',null,[['Operating',0,3],['Repairs',3,0]]],
  ['06/02/2026','Sales Receipt','M-2','Sample mixed party',null,[['Operating',12,0],['Sales',0,12],['Cost of Goods Sold',4,0],['Inventory Asset',0,4]]],
  ['06/03/2026','Journal Entry','Deep-1',null,null,[['Planes:Cub:Engine',8,0],['Operating',0,8]]],
  ['06/04/2026','Check','1234567890123456789012345678901234567890','Sample vendor A','Sample ordinary memo '.repeat(100),[['Operating',0,6],['Fuel',6,0]]],
  ['06/05/2026','Check','1234567890123456789012345678901234567890','Sample vendor A','Sample ordinary memo '.repeat(100),[['Operating',0,7],['Fuel',7,0]]],
];
