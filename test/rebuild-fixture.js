import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, utimes, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ADMIN_URL, freshDb } from './harness.js';
import { saveCarryOver, applyCarryOver } from '../lib/rebuild/carry-over.js';
import { saveRule } from '../lib/bankfeed/rules.js';
import { readQboExport } from '../lib/import/qbo-read.js';
import { importQboCompany } from '../lib/import/qbo-import.js';
import { writeExport, OPEN } from './qbo-fixture.js';

const admin = new URL(ADMIN_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(admin.hostname), 'rebuild tests require a loopback database');
assert.equal(admin.pathname, '/postgres');
const dir = await mkdtemp(join(tmpdir(), 'fb-rebuild-regression-'));
const runFile = promisify(execFile);
let serial = 0, exportData;
const databases = [];
const q = async (db, sql, args=[]) => (await db.pool.query(sql,args)).rows;
async function makeDb({entity=true, imported=false, openItems=null}={}) {
  const db = await freshDb(); databases.push(db);
  const u = new URL(db.url);
  assert.equal(u.hostname, admin.hostname); assert.equal(u.port, admin.port); assert.match(u.pathname, /^\/fb_test_[a-f0-9]+$/);
  await q(db,"INSERT INTO org(slug,name) VALUES ('sample','Sample')");
  if (imported) await importQboCompany(db.pool, {orgId:1, companyName:'Sample company A', data:{...structuredClone(exportData),...(openItems?{openItems}:{})}, actor:'tester'});
  else if(entity) await q(db,"INSERT INTO entity(org_id,name) VALUES (1,'Sample company A')");
  db.file = join(dir, `db-${++serial}.url`); await writeFile(db.file, db.url);
  return db;
}
async function invoke(script,args=[],db=null) {
  args=[...args];
  if (['copy-books','rebuild-check'].includes(script) && !args.includes('--exports')) args.push('--exports',exportsFolder);
  if (script==='rebuild-check' && !args.includes('--companies')) args.push('--companies',companyFile);
  try { const r=await runFile(process.execPath,[`scripts/${script}.mjs`,...args], {env:{...process.env, ...(db?{DATABASE_URL:db.url}:{}),ALLOW_SUPERUSER:'1'},maxBuffer:4e6}); return {...r,code:0}; }
  catch(e) {return {code:e.code,stdout:e.stdout,stderr:e.stderr};}
}
const companyFile = join(dir, 'companies.json');
const exportsFolder = join(dir,'exports');
const copy = (a,b)=>invoke('copy-books',[a.file,b.file,'--companies',companyFile,'--apply']);
async function rehearse(dump) {
  const admin = join(dir, 'rehearsal-admin.url');
  await writeFile(admin, ADMIN_URL);
  const result = await invoke('dump-rehearse', [dump, admin]);
  assert.equal(result.code, 0, result.stderr);
  return dump + '.receipt.json';
}
const saved = db=>saveCarryOver(db.pool,{orgSlug:'sample'});
const apply = (db,data,phase='books',dryRun=false)=>applyCarryOver(db.pool,{data,phase,dryRun,waitMinutes:0,env:{},actor:'review-test'});
const ll='00000000-0000-4000-8000-000000000011';
const la='00000000-0000-4000-8000-000000000021';
async function feed(db){
  await q(db,`INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_by) VALUES(1,1,$1,'Sample feed','tester')`,[ll]);
  await q(db,`INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,currency) VALUES(1,1,$1,'Sample account','checking','USD')`,[la]);
}
before(async()=>{
  await writeFile(companyFile, JSON.stringify(['Sample company A']));
  await mkdir(dir,{recursive:true}); await writeExport(join(exportsFolder,'sample-company-a','export'));
  exportData={...await readQboExport(join(exportsFolder,'sample-company-a','export')),openItems:OPEN.map(o=>({...o})),hasAging:{ar:true,ap:true}};
});
after(async()=>{for(const d of databases.reverse()) await d.drop(); await rm(dir,{recursive:true,force:true});});


export { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la, rehearse, companyFile, exportsFolder };
