import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createPool } from '../lib/db.js';
import { refuseDemoDatabase } from '../lib/data/demo.js';
import { freshDb } from '../test/harness.js';
import { runMigrations, MIGRATIONS_DIR } from '../lib/migrate.js';
import { relationshipEdges, relationshipComponents,
  installGraphFunctions, prototypeSummary, prototypePairPage, prototypeMemberPage,
  prototypeEntriesPage, prototypeBillsPage, prototypePrepareDetail, duplicateOracle, transferOracle, oracleEvidence } from './morning-probe-sql.mjs';

const require = createRequire(import.meta.url);
const ADMIN = 'postgres://postgres@127.0.0.1:5499/postgres';
const planUrl = new URL('../docs/superpowers/plans/2026-10-17-morning-view.md', import.meta.url);
const hash = text => createHash('sha256').update(text).digest('hex');

function checkAdmin(adminUrl = process.env.TEST_DATABASE_URL || ADMIN) {
  const u = new URL(adminUrl);
  if (u.hostname !== '127.0.0.1' || u.port !== '5499' || u.pathname !== '/postgres') {
    throw new Error('probe requires the local 127.0.0.1:5499 harness admin endpoint');
  }
  if (adminUrl !== (process.env.TEST_DATABASE_URL || ADMIN)) {
    throw new Error('adminUrl must match the test harness endpoint');
  }
}

async function assertDisposable(tx, env = process.env) {
  await refuseDemoDatabase(tx, env);
  const { rows: [row] } = await tx.query('SELECT current_database() AS name');
  if (!/^fb_test_[0-9a-f]{12}$/.test(row.name)) {
    throw new Error('probe refuses a database outside the harness fb_test namespace');
  }
  return row.name;
}

export function invokeProbeImplementation(implementation, implementations, options) {
  if (!['prototype', 'integrated'].includes(implementation)) throw new Error('Unknown probe implementation');
  return implementations[implementation](options);
}

export async function prepareProbe(pool, { implementation = 'prototype', env = process.env } = {}) {
  checkAdmin();
  await assertDisposable(pool, env);
  const names = (await readdir(MIGRATIONS_DIR)).filter(n => /^\d{3}_.*\.sql$/.test(n)).sort();
  if (!['066_tax_books_t3.sql', '067_morning_view.sql'].includes(names.at(-1))) {
    throw new Error('Probe expects the reviewed 001–067 migration allocation');
  }
  if (implementation === 'integrated' && names.at(-1) !== '067_morning_view.sql') throw new Error('Integrated probe requires migration 067');
  await runMigrations(pool);
  // The public starter does not carry the private implementation plan. The
  // installed migration is sufficient evidence; retain plan metadata when present.
  const plan = await readFile(planUrl, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (names.at(-1) === '067_morning_view.sql') {
    const migration = await readFile(new URL('../migrations/067_morning_view.sql', import.meta.url), 'utf8');
    const applied = await pool.query("SELECT name FROM schema_migrations WHERE name='067_morning_view.sql'");
    assert.equal(applied.rowCount, 1);
    return { migrationHash: hash(migration), candidateHash: hash(migration), planHash: plan === null ? null : hash(plan) };
  }
  if (plan === null) throw new Error('The prototype candidate requires the implementation plan; use the installed migration 067');
  const task = plan.split('### Task 1: Migration 067 and constraint tests')[1];
  const candidate = task?.match(/```sql\r?\n([\s\S]*?)\r?\n```/)?.[1];
  if (!candidate?.includes('CREATE VIEW morning_relationship_edge')) {
    throw new Error('candidate DDL not found in Task 1');
  }
  // The candidate is applied only to the harness-created disposable database.
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(candidate);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
  return { candidateHash: hash(candidate), planHash: hash(plan) };
}

export function evaluateGate(r) {
  const failures = [];
  const check = (ok, reason) => { if (!ok) failures.push(reason); };
  check(r.complete === true, 'full summary pipeline not measured');
  check(r.oraclePassed === true, 'oracle not passed');
  check(r.plansComplete === true, 'bound query plans incomplete');
  check(r.repeats >= 20, 'twenty warmed processes required');
  const c = r.correctness || {};
  check(c.passed && c.pairCount === 1_249_975_000 && c.memberCount === 50_000 &&
    c.groupCount === 1 && c.bankReview === 5_500 && c.bankPending === 1_000 &&
    c.bills === 3_000 && c.invoices === 3_000, 'incorrect full-set counts');
  check(r.hot?.p95 <= 3_000, 'summary p95 exceeds 3000 ms or is missing');
  check(r.detail?.p95 <= 2_000, 'detail p95 exceeds 2000 ms or is missing');
  check(r.detail?.maxRows <= 50 && r.detail?.maxBytes <= 65_536, 'detail page bound');
  check(r.statements?.financial <= 30, 'financial statement bound');
  const m = r.memory || {};
  check(m.smallHeap > 0 && m.largeHeap <= m.smallHeap * 1.2 &&
    m.largeHeap <= 256 * 1024 * 1024 && m.peakRSS <= 512 * 1024 * 1024, 'application memory bound');
  check(m.graphLinear === true && m.hashRecords <= 1 && m.hashStateBytes <= 32, 'graph/hash storage bound');
  check(r.payloadBytes <= 1_048_576 && r.duplicateBytes <= 1_024, 'response payload bound');
  if (r.implementation === 'integrated') check(r.renderedBytes <= 1_048_576, 'rendered response payload bound');
  return { pass: failures.length === 0, failures };
}

export async function seedProbe(pool, { historyPostings=1_000_000, scenario='dense', members=50_000, env=process.env } = {}) {
  checkAdmin(); await assertDisposable(pool, env);
  if (!Number.isSafeInteger(historyPostings) || historyPostings<2*members+100000 || historyPostings%4 || members<4) throw new Error('fixture sizes');
  if (!['dense','star','two-class-chain','partition'].includes(scenario)) throw new Error('fixture scenario');
  const tx=await pool.connect();
  const q=(text,values=[])=>tx.query({text,values,query_timeout:300_000});
  const base=200_000;
  try {
    await q('BEGIN');
    await q("INSERT INTO org(slug,name) VALUES ('mvprobe','Sample company A')");
    await q("INSERT INTO entity(org_id,name) SELECT 1,'Sample company '||g FROM generate_series(1,20) g");
    await q("INSERT INTO vendor(org_id,entity_id,display_name) SELECT 1,g,'Sample vendor '||g FROM generate_series(1,20) g");
    await q("INSERT INTO customer(org_id,entity_id,display_name) SELECT 1,g,'Sample customer '||g FROM generate_series(1,20) g");
    await q(`INSERT INTO account(org_id,entity_id,name,type)
      SELECT 1,(g-1)/20+1,'Sample account '||g,CASE WHEN g%20=0 THEN 'credit_card' ELSE 'bank' END FROM generate_series(1,400) g`);
    await q("INSERT INTO account(org_id,entity_id,name,type) SELECT 1,g,'Sample offset '||g,'equity' FROM generate_series(1,20) g");
    // Reserve low IDs for ineligible intermediates, including a node below every member.
    const chain=scenario==='two-class-chain'?100_000:1;
    await q(`INSERT INTO txn(org_id,entity_id,txn_id,type,txn_date,total_cents,open_cents,source_txn_id,created_at,updated_at)
      OVERRIDING SYSTEM VALUE SELECT 1,1,g,'journal_entry',CASE WHEN g%2=0 THEN DATE '2021-10-17' ELSE DATE '2027-10-17' END,
      0,0,CASE WHEN g>1 THEN g-1 END,'2021-01-01','2021-01-01' FROM generate_series(1,$1::int) g`,[chain]);
    await q(`INSERT INTO txn(org_id,entity_id,txn_id,type,vendor_id,account_id,txn_date,total_cents,open_cents,source_txn_id,created_at,updated_at)
      OVERRIDING SYSTEM VALUE SELECT 1,1,$1::int+g,'check',1,1,'2026-10-17',40000,0,
      CASE WHEN $3='two-class-chain' AND g<=$2/2 THEN 1
       WHEN $3='two-class-chain' AND g>$2/2+1 THEN $1+$2/2+1
       WHEN $3='star' AND g>1 THEN 1
       WHEN $3='partition' AND g=2 THEN $1+1 END,
      CASE WHEN g=1 THEN TIMESTAMPTZ '2026-10-17 14:00Z' ELSE TIMESTAMPTZ '2026-01-01' END,
      TIMESTAMPTZ '2026-01-01' FROM generate_series(1,$2::int) g`,[base,members,scenario]);
    // Refresh statistics before FK trigger queries are planned. In the four-
    // member fixture a cached sequential scan otherwise survives the import.
    await q('ANALYZE txn');
    await q(`INSERT INTO posting(org_id,entity_id,txn_id,account_id,amount_cents,txn_date,vendor_id)
      SELECT 1,1,$1::int+g,CASE WHEN a=1 THEN 1 ELSE 401 END,CASE WHEN a=1 THEN -40000 ELSE 40000 END,
      DATE '2026-10-17',1 FROM generate_series(1,$2::int) g CROSS JOIN generate_series(1,2) a`,[base,members]);
    if(scenario==='star')await q(`INSERT INTO application(org_id,credit_txn_id,charge_txn_id,amount_cents,applied_on)
      VALUES(1,$1,1,1,'2027-10-30')`,[base+2]);
    // Irrelevant history has two opposite balanced journals per account/day. It
    // changes neither balances nor window/party/relationship facts at either size.
    await q(`INSERT INTO txn(org_id,entity_id,txn_id,type,txn_date,total_cents,open_cents,created_at,updated_at)
      OVERRIDING SYSTEM VALUE SELECT 1,(g-1)%20+1,500000+g,'journal_entry','2026-10-17',100,0,
      '2026-10-17 14:00Z','2026-10-17 14:00Z' FROM generate_series(1,50000) g`);
    await q('ANALYZE txn');
    await q(`INSERT INTO posting(org_id,entity_id,txn_id,account_id,amount_cents,txn_date)
      SELECT 1,(g-1)%20+1,500000+g,((g-1)%20)*20+a,CASE WHEN a=1 THEN -100 ELSE 100 END,'2026-10-17'
      FROM generate_series(1,50000) g CROSS JOIN generate_series(1,2) a`);
    const history=(historyPostings-2*members-100000)/4;
    await q(`INSERT INTO txn(org_id,entity_id,txn_id,type,txn_date,total_cents,open_cents,created_at,updated_at)
      OVERRIDING SYSTEM VALUE SELECT 1,(g-1)%20+1,1000000+2*g+s,'journal_entry',
      DATE '2021-10-17'+((g-1)%1735)::int,100,0,'2021-01-01','2021-01-01'
      FROM generate_series(1,$1::int) g CROSS JOIN generate_series(0,1) s`,[history]);
    await q('ANALYZE txn');
    await q(`INSERT INTO posting(org_id,entity_id,txn_id,account_id,amount_cents,txn_date)
      SELECT 1,(g-1)%20+1,1000000+2*g+s,CASE WHEN a=1 THEN ((g-1)%20)*20+1 ELSE 401+(g-1)%20 END,
      CASE WHEN (a+s)%2=0 THEN 100 ELSE -100 END,DATE '2021-10-17'+((g-1)%1735)::int
      FROM generate_series(1,$1::int) g CROSS JOIN generate_series(0,1) s CROSS JOIN generate_series(1,2) a`,[history]);
    await q(`INSERT INTO txn(org_id,entity_id,txn_id,type,vendor_id,customer_id,txn_date,due_date,total_cents,open_cents,
      approval_status,created_at,updated_at) OVERRIDING SYSTEM VALUE
      SELECT 1,(g-1)%20+1,3000000+g+10000*s,CASE WHEN s=0 THEN 'bill' ELSE 'invoice' END,
      CASE WHEN s=0 THEN (g-1)%20+1 END,CASE WHEN s=1 THEN (g-1)%20+1 END,'2026-09-01',
      CASE WHEN g<=3000 THEN DATE '2026-10-16' ELSE DATE '2026-12-16' END,10000,10000,
      CASE WHEN s=0 THEN 'approved' END,'2026-01-01','2026-01-01'
      FROM generate_series(1,10000) g CROSS JOIN generate_series(0,1) s`);
    await q(`INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_by)
      SELECT 1,g,md5('entity'||g)::uuid,'Sample company '||g,'the owner' FROM generate_series(1,20) g`);
    await q(`INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,books_account_id)
      SELECT 1,g,md5('account'||g)::uuid,'Sample bank '||g,'checking',(g-1)*20+1 FROM generate_series(1,20) g`);
    await q(`INSERT INTO bank_feed_item(org_id,entity_id,ll_transaction_id,ll_account_id,revision,pending,posted_date,
      amount_cents,review_state,attention)
      SELECT 1,(g-1)%20+1,md5('item'||g)::uuid,md5('account'||((g-1)%20+1))::uuid,1,
      g BETWEEN 5501 AND 6500,'2026-10-17',CASE WHEN g%2=0 THEN 100 ELSE -100 END,
      CASE WHEN g<=5000 OR g BETWEEN 5501 AND 6500 THEN 'new' ELSE 'excluded' END,
      CASE WHEN g BETWEEN 4501 AND 5500 THEN 'changed' END FROM generate_series(1,100000) g`);
    await q("INSERT INTO morning_viewer(org_id,viewer_key,enrollment_state) VALUES (1,'owner','ready')");
    await q(`INSERT INTO morning_snapshot_generation(org_id,viewer_key,generation_id,captured_at,as_of_date)
      VALUES (1,'owner','00000000-0000-0000-0000-000000000001','2026-07-19 15:00Z','2026-07-19')`);
    await q(`INSERT INTO morning_snapshot_company(org_id,viewer_key,generation_id,observed_entity_id,entity_name,is_personal)
      SELECT 1,'owner','00000000-0000-0000-0000-000000000001',entity_id,name,false FROM entity WHERE org_id=1`);
    await q(`INSERT INTO morning_snapshot_account(org_id,viewer_key,generation_id,observed_account_id,observed_entity_id,
      account_name,account_type,active,signed_cents)
      SELECT 1,'owner','00000000-0000-0000-0000-000000000001',account_id,entity_id,name,type,active,0
      FROM account WHERE org_id=1 AND type IN ('bank','credit_card')`);
    await q('COMMIT'); await q('ANALYZE');
    const actual=(await q(`SELECT (SELECT count(*)::int FROM entity) companies,
      (SELECT count(*)::int FROM account WHERE type IN ('bank','credit_card')) accounts,
      (SELECT count(*)::int FROM posting) postings,(SELECT min(txn_date)::text FROM posting) oldest_posting,
      (SELECT count(*)::int FROM bank_feed_item) bank_items,(SELECT count(*)::int FROM txn WHERE type IN ('bill','invoice') AND open_cents>0) documents,
      (SELECT count(*)::int FROM txn WHERE txn_id BETWEEN 500001 AND 550000) imported_entries`)).rows[0];
    assert.deepEqual(actual,{companies:20,accounts:400,postings:historyPostings,oldest_posting:'2021-10-17',bank_items:100000,documents:20000,imported_entries:50000});
    return {orgId:1,memberIds:Array.from({length:members},(_,i)=>base+i+1),lowerIntermediateId:1,
      actual,parameters:{historyPostings,scenario,members,chain,companies:20,accounts:400,bankItems:100000,openDocuments:20000}};
  } catch(error) { await q('ROLLBACK'); throw error; } finally {tx.release();}
}

const probeOptions=()=>({orgId:1,N:'2026-10-17T15:00:00Z',baselineAt:'2026-07-19T15:00:00Z',deadline:performance.now()+15000});
const percentile=(values,p=.95)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];

async function measurePrototypeWorker(url, {scenario='dense',explain=false}={}) {
 const parsed=new URL(url);
 if(parsed.hostname!=='127.0.0.1'||parsed.port!=='5499'||!/^\/fb_test_[0-9a-f]{12}$/.test(parsed.pathname)) throw new Error('unsafe worker database');
 const pool=createPool({DATABASE_URL:url,ALLOW_SUPERUSER:'1'}),tx=await pool.connect();
 const memory=[],queries=[],timings=[],counts={financial:0,total:0};
 const sample=phase=>memory.push({phase,...process.memoryUsage(),maxRSS:process.resourceUsage().maxRSS});
 let current=[],activePhase='setup';
 const original=tx.query.bind(tx);
 tx.query=async(...args)=>{counts.total++;
  const text=typeof args[0]==='string'?args[0]:args[0].text;
  if(/^(SELECT|WITH|CREATE TEMP|CREATE INDEX|INSERT|UPDATE|DELETE)/.test(text.trim()))counts.financial++;
  return original(...args);};
 tx.probeExecute=async query=>{
  activePhase=query.name;
  sample(`before ${query.name}`);current.push(query);const start=performance.now();
  if(!/^CREATE OR REPLACE FUNCTION/.test(query.text.trim()))counts.financial+=query.internalQueries??0;
  try {
   const answer=await tx.query({text:query.text,values:query.values,query_timeout:20000});
   timings.push({phase:query.name,ms:performance.now()-start});sample(`after ${query.name}`);return answer;
  } catch(error) {timings.push({phase:query.name,ms:performance.now()-start,failed:true,code:error.code});sample(`failed ${query.name}`);throw error;}
 };
 let timer,result;
 try {
  await assertDisposable(tx);const setupStatements={...counts};counts.financial=0;counts.total=0;
  sample('before forced GC');global.gc?.();sample('after forced GC');timer=setInterval(()=>sample('10ms sample'),10);
  const start=performance.now();await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const model=await prototypeSummary(tx,probeOptions());
  let payloadBytes;
  {sample('summary before serialization');const encoded=JSON.stringify(model);sample('summary serialized allocation live');payloadBytes=Buffer.byteLength(encoded);}
  const storage=(await tx.probeExecute({name:'storageMetadata',dependencies:['attention'],values:[],text:`SELECT c.relname,pg_total_relation_size(c.oid)::text bytes,c.reltuples::text estimated_rows
    FROM pg_class c WHERE c.relnamespace=pg_my_temp_schema() AND c.relkind='r' ORDER BY c.relname`})).rows;
  const graphStorage=(await tx.probeExecute({name:'graphStorage',dependencies:['duplicateGroups'],values:[],text:`SELECT (SELECT count(*)::int FROM mv_dup_member) members,
    (SELECT count(*)::int FROM mv_relationship_edge) edges,(SELECT count(*)::int FROM mv_relationship_component) vertices,
    (SELECT count(*)::int FROM mv_candidate_member) candidate_members,(SELECT count(*)::int FROM mv_group) groups,
    (SELECT sum(total_bytes)::text FROM pg_backend_memory_contexts) backend_allocated_bytes`})).rows[0];
  assert.equal(model.money.vector.length,400);assert.equal(model.counts.bankReview,5500);assert.equal(model.counts.bankPending,1000);
  assert.equal(model.counts.bills,3000);assert.equal(model.counts.invoices,3000);assert.equal(model.counts.duplicates,1);
  assert.equal(model.duplicateSummary.memberCount,50000);assert.equal(model.duplicateSummary.seedCount,1);
  assert.equal(model.duplicateSummary.pairCount,scenario==='dense'?1249975000:scenario==='star'?49999:625000000);
  assert.ok(graphStorage.candidate_members<=graphStorage.members);
  assert.ok(graphStorage.vertices<=graphStorage.members+2*graphStorage.edges);
  await tx.query('COMMIT');
  const summaryMs=performance.now()-start;
  const summaryStatements={...counts};const summaryQueries=[...current];queries.push({kind:'summary',specs:summaryQueries});
  const details=[];
  const kinds=scenario==='dense'?['entries','bills','member','pairBegin','pairMiddle','pairEnd']:
    scenario==='star'?['starTail']:['twoClassBegin','twoClassMiddle','twoClassEnd'];
  for(const kind of kinds) {
   counts.financial=0;counts.total=0;current=[];const startDetail=performance.now();
   await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
   const options=probeOptions();await prototypePrepareDetail(tx,options,kind);
   let page;
   if(kind==='entries')page=await prototypeEntriesPage(tx,{after:model.entries.next,limit:50,deadline:options.deadline});
   else if(kind==='bills')page=await prototypeBillsPage(tx,{after:{due:'2026-10-16',txnId:3000050},limit:50,deadline:options.deadline});
   else if(kind==='member')page=await prototypeMemberPage(tx,{groupKey:model.duplicateSummary.itemKey,limit:50,deadline:options.deadline});
   else page=await prototypePairPage(tx,{groupKey:model.duplicateSummary.itemKey,
    after:kind==='starTail'?{lo:200001,hi:250000}:kind.endsWith('Begin')?null:kind.endsWith('Middle')?
     {lo:225000,hi:225001}:{lo:249998,hi:250000},limit:50,deadline:options.deadline});
   let bytes;
   {sample(`${kind} before serialization`);const encoded=JSON.stringify(page);sample(`${kind} serialized allocation live`);bytes=Buffer.byteLength(encoded);}
   const rowCount=(page.page??page.pairs??page.members??[]).length;
   if(kind==='starTail') {assert.deepEqual(page.pairs,[]);assert.equal(page.next,null);assert.ok(page.work.listProbes<=11);assert.ok(page.work.activeLoSearches<=1);}
   if(kind==='pairBegin')assert.deepEqual(page.pairs.map(p=>[p.lo,p.hi]),Array.from({length:50},(_,i)=>[200001,200002+i]));
   if(kind==='pairEnd')assert.deepEqual(page.pairs.map(p=>[p.lo,p.hi]),[[249999,250000]]);
   if(kind==='twoClassBegin')assert.deepEqual(page.pairs.map(p=>[p.lo,p.hi]),Array.from({length:50},(_,i)=>[200001,225001+i]));
   if(kind==='entries'||kind==='bills'||kind==='member')assert.equal(rowCount,50);
   queries.push({kind,specs:[...current]});await tx.query('COMMIT');
   details.push({kind,ms:performance.now()-startDetail,rows:rowCount,bytes,statements:{...counts},page});
  }
  result={summaryMs,summaryStatements,model,payloadBytes,duplicateBytes:Buffer.byteLength(JSON.stringify(model.duplicateSummary)),details,storage,graphStorage,
    setupStatements,diagnosticStatements:{financial:2,total:2,includedInSummary:true},timings};
  clearInterval(timer);sample('before final forced GC');global.gc?.();sample('after final forced GC');
  result.memory=memory;result.queries=queries;
  if(explain) {
   activePhase='explain setup';
   delete tx.probeExecute;
   const plans=[];
   // PostgreSQL's bundled diagnostic module exposes plans for the actual nested
   // FOR SELECT / array-sort statements. No extension or persistent object is
   // installed; logging settings and the notice listener belong to this client.
   await original("LOAD 'auto_explain'");
   await original("SET auto_explain.log_min_duration=0");
   await original("SET auto_explain.log_analyze=on");
   await original("SET auto_explain.log_buffers=on");
   await original("SET auto_explain.log_nested_statements=on");
   await original("SET auto_explain.log_format='json'");
   await original("SET auto_explain.log_level='notice'");
   await original("SET track_functions='all'");
   const nested=[];
   const notice=message=>{const start=message.message?.indexOf('{');if(start>=0){try{nested.push(JSON.parse(message.message.slice(start)));}catch{}}};
   tx.on('notice',notice);
   // Each data query is replayed with its actual preceding builders in a fresh
   // namespace. CTAS is executed only by its ANALYZE when it is the target.
   const seen=new Set();
   for(const chain of queries) for(let target=0;target<chain.specs.length;target++) {
    const query=chain.specs[target]; const key=query.name+JSON.stringify(query.values);
    if(seen.has(key))continue;seen.add(key);
    if(!/^(SELECT|WITH|CREATE TEMP)/.test(query.text.trim()))continue;
    await original('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
     await original("SET LOCAL statement_timeout='5s'");
     for(const dependency of chain.specs.slice(0,target)) {
      activePhase=`explain ${query.name}: dependency ${dependency.name}`;
      await original({text:dependency.text,values:dependency.values,query_timeout:20000});
     }
     activePhase=`explain ${query.name}`;
     const beforeFunctions=(await original("SELECT funcid,funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE schemaname LIKE 'pg_temp_%'")).rows;
     nested.length=0;
     const p=await original({text:`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,values:query.values,query_timeout:20000});
     const nestedPlans=[...nested];
     const afterFunctions=(await original("SELECT funcid,funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE schemaname LIKE 'pg_temp_%'")).rows;
     const functionTimings=afterFunctions.map(row=>{const before=beforeFunctions.find(x=>x.funcid===row.funcid);
      return {name:row.funcname,calls:Number(row.calls)-Number(before?.calls??0),elapsedMs:row.total_time-(before?.total_time??0),selfMs:row.self_time-(before?.self_time??0)};
     }).filter(row=>row.calls>0);
     // Function elapsed/self time includes its SQL; nestedPlans separately
     // records that SQL's plans and execution timings. Do not label it CPU-only.
     plans.push({...query,plan:p.rows[0]['QUERY PLAN'],nestedPlans,functionTimings});
     if((query.internalQueries??0)>nestedPlans.length)throw new Error(`missing nested EXPLAIN plans for ${query.name}: ${nestedPlans.length}/${query.internalQueries}`);
    } finally {await original('ROLLBACK');}
   }
   result.plans=plans;
   tx.off('notice',notice);
  }
  return result;
 } catch(error) {
  return {...result,error:{code:error.code,message:error.message,stack:error.stack,actual:error.actual,expected:error.expected},failedQuery:activePhase,
   statements:{...counts},memory,timings,queries:[...queries,{kind:'failed',specs:current}]};
 } finally {clearInterval(timer);await original('ROLLBACK').catch(()=>{});tx.release();await pool.end();}
}

function childProbe(url,options) {
 return new Promise((resolveChild,reject)=>{
  const child=spawn(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'--worker',JSON.stringify(options)],
   {cwd:resolve(fileURLToPath(new URL('..',import.meta.url))),env:{...process.env,MORNING_PROBE_DB:url},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  child.on('error',reject);child.on('close',code=>{
   if(code!==0)return reject(new Error(`worker exit ${code}: ${stderr}`));
   try{resolveChild(JSON.parse(stdout));}catch(error){reject(new Error(`worker JSON: ${error.message}; ${stderr}`));}
  });
 });
}

// The integrated path uses the same service, locks, renderer, shell and message
// composer as the app. Only measurements and literal fixture setup live here.
export async function measureIntegratedWorker(url, { scenario = 'dense', explain = false } = {}) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '5499' || !/^\/fb_test_[0-9a-f]{12}$/.test(parsed.pathname)) throw new Error('unsafe worker database');
  const [{ createMorningService }, { trustedActor }, { makeCursor }, views, { renderMorningShell }, { composeMessage }, { duplicateMembers }] = await Promise.all([
    import('../lib/data/morning.js'), import('../lib/data/morning/access.js'), import('../lib/data/morning/cursor.js'),
    import('../lib/views/morning.js'), import('../services/app/morning-routes.js'), import('../lib/data/morning/messages.js'), import('../lib/data/morning/graph-sql.js'),
  ]);
  const pool = createPool({ DATABASE_URL: url, ALLOW_SUPERUSER: '1' });
  const N = new Date('2026-10-17T15:00:00Z'), generationId = '00000000-0000-0000-0000-000000000001';
  const session = { id: 'sample-probe-session', version: 0, userId: null, entityId: 1, csrf: 'sample-probe-csrf' };
  const identity = trustedActor({ owner: true }, 1, session), secret = Buffer.alloc(32, 1);
  const context = { sid: session.id, vk: 'owner', epoch: 1, gen: generationId, kind: 'ctx', resource: null, after: null, iat: +N };
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url, ALLOW_SUPERUSER: '1', APP_ORG: 'mvprobe', RUN_JOBS: '0', APP_BASE_URL: 'https://books.sample.example' };
  const service = createMorningService({ env });
  const memory = [], timings = [], queries = [];
  const sample = phase => memory.push({ phase, ...process.memoryUsage(), maxRSS: process.resourceUsage().maxRSS });
  const freshCounts = () => ({ financial: 0, computation: 0, snapshot: 0, authorization: 0, shell: 0, diagnostic: 0, total: 0 });
  let counts = freshCounts(), current = [], phase = 'context', operation = 'summary', timer, result;
  const measuredPool = { connect: async () => {
    const client = await pool.connect();
    return { release: (...args) => client.release(...args), query: async (...args) => {
      const spec = typeof args[0] === 'string' ? { text: args[0], values: args[1] ?? [] } : { text: args[0].text, values: args[0].values ?? [] };
      const text = spec.text.trim(), section = /^SAVEPOINT mv_section_(\w+)/.exec(text);
      if (section) phase = section[1];
      const control = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|RESET|SET)\b/.test(text)
        || /^SELECT (set_config|pg_advisory_)/.test(text);
      const definition = /^CREATE OR REPLACE FUNCTION/.test(text);
      const data = !control && !definition && /^(SELECT|WITH|CREATE|INSERT|UPDATE|DELETE)/.test(text);
      const category = phase === 'shell' ? 'shell' : /^SELECT v\.enrollment_state/.test(text) ? 'authorization'
        : /^(SELECT|WITH|INSERT INTO).*morning_(snapshot|visit)/s.test(text) && !/^CREATE/.test(text) ? 'snapshot'
          : phase === 'diagnostic' ? 'diagnostic' : 'computation';
      const internalQueries = definition ? 0 : Number(text.includes('pg_temp.mv_bank_hash()'))
        + Number(text.includes('pg_temp.mv_hash_groups(')) + Number(text.includes('pg_temp.mv_pair_work('));
      counts.total++;
      if (data) {
        counts[category] += 1 + internalQueries;
        if (!['authorization', 'shell'].includes(category)) counts.financial += 1 + internalQueries;
      }
      if (!control) current.push({ ...spec, name: `${operation}-${current.length}-${phase}`, dependencies: current.map(s => s.name), internalQueries, category });
      sample(`before ${operation}/${phase}`); const start = performance.now();
      try { return await client.query(...args); }
      finally { timings.push({ operation, phase, ms: performance.now() - start, sqlHash: hash(text) }); sample(`after ${operation}/${phase}`); }
    } };
  } };
  const resetVisit = async () => {
    await pool.query(`INSERT INTO morning_preference(org_id,viewer_key,membership_epoch,detail_threshold_cents)
      VALUES(1,'owner',1,0) ON CONFLICT(org_id,viewer_key) DO UPDATE SET detail_threshold_cents=0,
      settings_version=morning_preference.settings_version+1`);
    await pool.query(`INSERT INTO morning_visit(org_id,viewer_key,comparison_generation_id,latest_generation_id,reuse_anchor_at,latest_shown_at)
      VALUES(1,'owner',NULL,$1,'2026-07-19T15:00Z','2026-07-19T15:00Z') ON CONFLICT(org_id,viewer_key) DO UPDATE SET
      comparison_generation_id=NULL,latest_generation_id=$1,reuse_anchor_at='2026-07-19T15:00Z',latest_shown_at='2026-07-19T15:00Z'`, [generationId]);
    await pool.query("DELETE FROM morning_snapshot_generation WHERE org_id=1 AND viewer_key='owner' AND generation_id<>$1", [generationId]);
  };
  const viewOptions = { csrf: session.csrf, viewer: identity, ctxToken: makeCursor(secret, context), links: {
    entityId: 1, can: () => true,
    url: (kind, resource = null, after = null) => {
      const params = new URLSearchParams({ c: makeCursor(secret, { ...context, kind, resource, after }) });
      if (kind === 'account') return `/morning/accounts/${resource.accountId}?${params}`;
      if (kind.startsWith('duplicate-')) { params.set('kind', 'duplicates'); params.set('group', resource.groupKey); params.set('view', kind === 'duplicate-pairs' ? 'pairs' : 'members'); return `/morning/attention?${params}`; }
      if (kind === 'attention') { params.set('rule', resource.rule); if (resource.sourceKey) params.set('source', resource.sourceKey); }
      return `/morning/${kind}?${params}`;
    },
  } };
  let storage, graphStorage, duplicateSummary, bankPending;
  const render = request => async (tx, model) => {
    assert.equal(model.complete, true, `unavailable integrated section: ${JSON.stringify(model.diagnostics)}`);
    if (!request) {
      phase = 'diagnostic';
      storage = (await tx.query(`SELECT c.relname,pg_total_relation_size(c.oid)::text bytes,c.reltuples::text estimated_rows
        FROM pg_class c WHERE c.relnamespace=pg_my_temp_schema() AND c.relkind='r' ORDER BY c.relname`)).rows;
      const members = duplicateMembers().text.split(' ON COMMIT DROP AS')[1];
      const row = (await tx.query(`WITH mv_dup_member AS MATERIALIZED (${members}), vertices AS (
        SELECT txn_id FROM mv_dup_member UNION SELECT a FROM mv_relationship_edge UNION SELECT b FROM mv_relationship_edge)
        SELECT (SELECT count(*)::int FROM mv_dup_member) members,
        (SELECT count(*)::int FROM mv_relationship_edge) edges,(SELECT count(*)::int FROM vertices) vertices,
        (SELECT count(*)::int FROM mv_candidate_member) candidate_members,(SELECT count(*)::int FROM mv_group) groups,
        (SELECT sum(total_bytes)::text FROM pg_backend_memory_contexts) backend_allocated_bytes,
        (SELECT coalesce(sum((display->>'pendingCount')::numeric),0)::int FROM mv_attention WHERE rule='bank') pending,
        (SELECT jsonb_build_object('itemKey','duplicate:'||entity_id||':'||substring(item_key FROM 11),'version',version,
          'memberCount',member_count,'pairCount',pair_count,'seedCount',seed_count,'entityId',entity_id,'partyKey',party_key,
          'family',family,'amountCents',amount_cents,'firstDate',first_date,'lastDate',last_date) FROM mv_group LIMIT 1) duplicate`)).rows[0];
      ({ pending: bankPending, duplicate: duplicateSummary, ...graphStorage } = row);
      // The graph stores exact numeric aggregates as text. Normalize only the
      // probe's scalar comparison record; measure the untouched full model too.
      for (const field of ['pairCount', 'amountCents']) {
        duplicateSummary[field] = Number(duplicateSummary[field]);
        assert.ok(Number.isSafeInteger(duplicateSummary[field]), `unsafe duplicate ${field}`);
      }
    }
    sample(`${operation} before model serialization`);
    const json = JSON.stringify(model); sample(`${operation} model allocation live`);
    const payloadBytes = Buffer.byteLength(json);
    const message = composeMessage(model, { includeAmounts: true, origin: env.APP_BASE_URL });
    sample(`${operation} message allocation live`);
    assert.match(message.emailText, /^Morning View is ready\n\n/);
    assert.match(message.smsText, /https:\/\/books\.sample\.example\/morning$/);
    phase = 'shell';
    const body = request ? views.morningDetailPage(model, viewOptions, request) : views.morningPage(model, viewOptions);
    sample(`${operation} body allocation live`);
    const html = await renderMorningShell(tx, { identity, session, body, path: '/morning', csrf: session.csrf });
    sample(`${operation} full HTML allocation live`);
    const renderedBytes = Buffer.byteLength(html);
    result ??= {};
    result.payloadBytes = Math.max(result.payloadBytes ?? 0, payloadBytes);
    result.renderedBytes = Math.max(result.renderedBytes ?? 0, renderedBytes);
    result.message = message;
    phase = 'observation';
    return html;
  };
  try {
    await assertDisposable(pool); await resetVisit();
    sample('before forced GC'); global.gc?.(); sample('after forced GC'); timer = setInterval(() => sample('10ms sample'), 10);
    const start = performance.now();
    const response = await service.observeMorning(measuredPool, { identity, now: () => N, render: render(null) });
    assert.equal(response.status, 'ok');
    const model = response.model, c = model.attention.counts;
    result = { ...result, summaryMs: performance.now() - start, summaryStatements: { ...counts }, storage, graphStorage,
      duplicateBytes: Buffer.byteLength(JSON.stringify(duplicateSummary)),
      model: { money: { vector: model.money.vector.accounts, grand: model.money.grand },
        counts: { bankReview: c.bankLines, bankPending, bills: c.bills, invoices: c.overdueInvoices, duplicates: c.duplicateGroups },
        attentionPage: model.attention.page, duplicateSummary, entries: model.entries, dismissed: model.dismissed }, details: [] };
    queries.push({ kind: 'summary', specs: current });
    assert.equal(model.money.vector.accounts.length, 400); assert.equal(c.bankLines, 5500); assert.equal(bankPending, 1000);
    assert.equal(c.bills, 3000); assert.equal(c.overdueInvoices, 3000); assert.equal(c.duplicateGroups, 1);
    assert.equal(duplicateSummary.memberCount, 50000); assert.equal(duplicateSummary.seedCount, 1);
    assert.equal(duplicateSummary.pairCount, scenario === 'dense' ? 1249975000 : scenario === 'star' ? 49999 : 625000000);
    assert.ok(result.payloadBytes <= 1048576 && result.renderedBytes <= 1048576, 'response payload bound');
    assert.ok(result.summaryStatements.financial <= 30, `financial statement bound: ${result.summaryStatements.financial} > 30`);
    const kinds = scenario === 'dense' ? ['entries', 'bills', 'member', 'pairBegin', 'pairMiddle', 'pairEnd'] : scenario === 'star' ? ['starTail'] : ['twoClassBegin', 'twoClassMiddle', 'twoClassEnd'];
    for (const kind of kinds) {
      const request = kind === 'entries' ? { kind: 'entries', resource: null, after: model.entries.next }
        : kind === 'bills' ? { kind: 'attention', resource: { rule: 'bill' }, after: model.attention.next }
          : { kind: kind === 'member' ? 'duplicate-members' : 'duplicate-pairs', resource: { groupKey: duplicateSummary.itemKey },
            after: kind === 'member' || kind.endsWith('Begin') ? null : kind === 'starTail' ? { lo: 200001, hi: 250000 }
              : kind.endsWith('Middle') ? { lo: 225000, hi: 225001 } : { lo: 249998, hi: 250000 } };
      counts = freshCounts(); current = []; phase = 'context'; operation = kind; const begin = performance.now();
      const detail = await service.readMorningDetail(measuredPool, { identity, context: { ...context, ...request }, pageRequest: request, now: () => N, render: render(request) });
      assert.equal(detail.status, 'ok'); assert.equal(detail.model.complete, true);
      const page = kind === 'entries' ? detail.model.entries : kind === 'bills' ? detail.model.attention : detail.model.detail;
      sample(`${kind} before page serialization`); const encoded = JSON.stringify(page); sample(`${kind} page allocation live`);
      const rows = (page.page ?? page.pairs ?? page.members).length, bytes = Buffer.byteLength(encoded);
      if (['entries', 'bills', 'member'].includes(kind)) assert.equal(rows, 50);
      if (kind === 'entries') assert.equal(page.totals.aboveCount, 100001);
      if (kind === 'bills') { assert.equal(page.counts.bills, 3000); assert.equal(page.totals.bill.openCents, 30000000); }
      if (kind === 'starTail') { assert.deepEqual(page.pairs, []); assert.equal(page.next, null); assert.ok(page.work.listProbes <= 11); assert.ok(page.work.activeLoSearches <= 1); }
      if (kind === 'pairBegin') assert.deepEqual(page.pairs.map(p => [p.lo, p.hi]), Array.from({ length: 50 }, (_, i) => [200001, 200002 + i]));
      if (kind === 'pairEnd') assert.deepEqual(page.pairs.map(p => [p.lo, p.hi]), [[249999, 250000]]);
      if (kind === 'twoClassBegin') assert.deepEqual(page.pairs.map(p => [p.lo, p.hi]), Array.from({ length: 50 }, (_, i) => [200001, 225001 + i]));
      result.details.push({ kind, ms: performance.now() - begin, rows, bytes, statements: { ...counts }, page }); queries.push({ kind, specs: current });
      assert.ok(rows <= 50 && bytes <= 65536, 'detail page bound');
      assert.ok(counts.financial <= 30, `financial statement bound: ${counts.financial} > 30`);
    }
    clearInterval(timer); sample('before final forced GC'); global.gc?.(); sample('after final forced GC');
    if (explain) {
      await resetVisit();
      result.plans = await explainIntegratedQueries(pool, queries);
    }
    return { ...result, memory, timings, queries };
  } catch (error) {
    return { ...result, error: { message: error.message, code: error.code, stack: error.stack, actual: error.actual, expected: error.expected },
      failedQuery: `${operation}/${phase}`, statements: { ...counts }, memory, timings, queries: [...queries, { kind: 'failed', specs: current }] };
  } finally { clearInterval(timer); await pool.end(); }
}

async function measureWorker(url, options = {}) {
  return invokeProbeImplementation(options.implementation ?? 'prototype', {
    integrated: opts => measureIntegratedWorker(url, opts), prototype: opts => measurePrototypeWorker(url, opts),
  }, options);
}

export async function explainIntegratedQueries(pool, chains) {
  const tx = await pool.connect(), plans = [], seen = new Set(), nested = [];
  const query = (text, values = []) => tx.query({ text, values, query_timeout: 20000 });
  const notice = message => {
    const start = message.message?.indexOf('{');
    if (start >= 0) try { nested.push(JSON.parse(message.message.slice(start))); } catch {}
  };
  try {
    await query("LOAD 'auto_explain'");
    for (const [key, value] of Object.entries({ log_min_duration: '0', log_analyze: 'on', log_buffers: 'on', log_nested_statements: 'on', log_format: "'json'", log_level: "'notice'" }))
      await query(`SET auto_explain.${key}=${value}`);
    await query("SET track_functions='all'"); tx.on('notice', notice);
    for (const chain of chains) for (let target = 0; target < chain.specs.length; target++) {
      const spec = chain.specs[target], key = hash(spec.text + JSON.stringify(spec.values));
      if (seen.has(key) || !/^(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE TEMP TABLE\s+\w+\s+ON COMMIT DROP AS\b)/.test(spec.text.trim())) continue;
      seen.add(key); await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        await query("SET LOCAL statement_timeout='5s'");
        for (const dependency of chain.specs.slice(0, target)) await query(dependency.text, dependency.values);
        const before = (await query("SELECT funcid,funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE schemaname LIKE 'pg_temp_%'")).rows;
        nested.length = 0;
        const result = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${spec.text}`, spec.values);
        const nestedPlans = [...nested];
        const after = (await query("SELECT funcid,funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE schemaname LIKE 'pg_temp_%'")).rows;
        const functionTimings = after.map(row => {
          const old = before.find(r => r.funcid === row.funcid);
          return { name: row.funcname, calls: Number(row.calls) - Number(old?.calls ?? 0), elapsedMs: row.total_time - (old?.total_time ?? 0), selfMs: row.self_time - (old?.self_time ?? 0) };
        }).filter(row => row.calls > 0);
        assert.ok(nestedPlans.length >= spec.internalQueries, `missing nested plans for ${spec.name}`);
        plans.push({ ...spec, plan: result.rows[0]['QUERY PLAN'], nestedPlans, functionTimings });
      } finally { await query('ROLLBACK'); }
    }
    return plans;
  } finally { tx.off('notice', notice); tx.release(); }
}

export async function runProbe({adminUrl,repeats=20,implementation='prototype',output=implementation==='integrated'?'morning-probe-integrated.log':'morning-probe-g0c.log'}={}) {
 checkAdmin(adminUrl);
 if(!['prototype','integrated'].includes(implementation))throw new Error('Unknown probe implementation');
 const result={implementation,complete:false,repeats,oraclePassed:false,plansComplete:false,pass:false,
  hardware:{os:`${platform()} ${release()}`,cpu:cpus()[0]?.model,cores:cpus().length,ram:totalmem(),node:process.version,pg:require('pg/package.json').version},
  parameters:{historyPostings:[250000,1000000],members:50000,chain:100000,statementTimeoutMs:5000,deadlineMs:15000,seed:0},runs:[],databases:[]};
 try {
  result.oracles=oracleEvidence();
  if(!result.oracles.duplicate||!result.oracles.transfer) {
   const db=await freshDb({migrate:false}),tx=await db.pool.connect();
   const database={name:new URL(db.url).pathname.slice(1),dropped:false};result.databases.push(database);
   try {await installGraphFunctions(tx);
    result.oracles.duplicate??=await duplicateOracle(tx);result.oracles.transfer??=await transferOracle(tx);
   } finally {tx.release();await db.drop();database.dropped=true;}
  }
  result.oraclePassed=result.oracles.duplicate.cases===1473738&&result.oracles.transfer.cases===1078626&&
   Object.values(result.oracles).every(o=>Object.entries(o).every(([k,v])=>k==='cases'||v===0));
  if(!result.oraclePassed)throw new Error('exhaustive oracle mismatch');
  for(const [historyPostings,scenario] of [[250000,'dense'],[1000000,'dense'],[1000000,'star'],[1000000,'two-class-chain']]) {
   const db=await freshDb({migrate:false});const database={name:new URL(db.url).pathname.slice(1),dropped:false};result.databases.push(database);
   try {
    result.hashes=await prepareProbe(db.pool,{implementation});
    result.hashes.sql=hash(await readFile(new URL('./morning-probe-sql.mjs',import.meta.url),'utf8'));
    result.hashes.prototype=hash(await readFile(fileURLToPath(import.meta.url),'utf8'));
    if(implementation==='integrated'){
     const files=['lib/data/morning.js','lib/views/morning.js','lib/views/layout.js','services/app/morning-routes.js',
      ...(await readdir(new URL('../lib/data/morning/',import.meta.url))).filter(f=>f.endsWith('.js')).map(f=>`lib/data/morning/${f}`)];
     result.hashes.integrated=Object.fromEntries(await Promise.all(files.map(async f=>[f,hash(await readFile(new URL('../'+f,import.meta.url),'utf8'))])));
    }
    result.hardware.server=(await db.pool.query('SELECT version() version')).rows[0].version;
    result.hardware.settings=(await db.pool.query("SELECT name,setting,unit FROM pg_settings WHERE name=ANY($1) ORDER BY name",[
     ['shared_buffers','work_mem','maintenance_work_mem','jit','effective_cache_size','random_page_cost','max_parallel_workers_per_gather']])).rows;
    await seedProbe(db.pool,{historyPostings,scenario});
    for(let repetition=-1;repetition<repeats;repetition++) {
     const run=await childProbe(db.url,{implementation,scenario,explain:repetition===repeats-1&&historyPostings===1000000});
     result.runs.push({historyPostings,scenario,repetition,kind:repetition===-1?'cold-process / warm-up':'warmed',...run});
     console.error(`probe ${historyPostings} ${scenario} ${repetition}: summary ${run.summaryMs?.toFixed(1)??'failed'} ms; max detail ${run.details?Math.max(...run.details.map(d=>d.ms)).toFixed(1):'unavailable'} ms`);
     await writeFile(output,JSON.stringify(result,null,2)+'\n');
     if(run.error)throw Object.assign(new Error(`${run.failedQuery}: ${run.error.message}`),{measurement:run,code:run.error.code});
    }
   } finally {await db.drop();database.dropped=true;}
  }
  const hot=result.runs.filter(r=>r.repetition>=0),small=hot.filter(r=>r.historyPostings===250000),large=hot.filter(r=>r.historyPostings===1000000&&r.scenario==='dense');
  result.cold=result.runs.filter(r=>r.repetition===-1).map(r=>({historyPostings:r.historyPostings,ms:r.summaryMs}));
  result.hot={p95:Math.max(...['dense','star','two-class-chain'].map(s=>percentile(hot.filter(r=>r.historyPostings===1000000&&r.scenario===s).map(r=>r.summaryMs))))};
  const details=hot.filter(r=>r.historyPostings===1000000).flatMap(r=>r.details);
  result.detail={p95:Math.max(...[...new Set(details.map(d=>d.kind))].map(kind=>percentile(details.filter(d=>d.kind===kind).map(d=>d.ms)))),
   maxRows:Math.max(...details.map(d=>d.rows)),maxBytes:Math.max(...details.map(d=>d.bytes))};
  result.statements={financial:Math.max(...hot.flatMap(r=>[r.summaryStatements.financial,...r.details.map(d=>d.statements.financial)])),
   total:Math.max(...hot.flatMap(r=>[r.summaryStatements.total,...r.details.map(d=>d.statements.total)]))};
  const peak=(runs,value)=>runs.reduce((v,r)=>r.memory.reduce((p,m)=>Math.max(p,value(m)),v),0);
  result.memory={smallHeap:peak(small,m=>m.heapUsed),largeHeap:peak(large,m=>m.heapUsed),
   peakRSS:peak(hot,m=>Math.max(m.rss,m.maxRSS*1024)),
   graphLinear:hot.every(r=>r.graphStorage.candidate_members<=r.graphStorage.members&&r.graphStorage.vertices<=r.graphStorage.members+2*r.graphStorage.edges),hashRecords:1,hashStateBytes:32};
  result.payloadBytes=Math.max(...hot.map(r=>r.payloadBytes));result.duplicateBytes=Math.max(...hot.map(r=>r.duplicateBytes));
  if(implementation==='integrated')result.renderedBytes=Math.max(...hot.map(r=>r.renderedBytes));
  const m=large[0].model;
  result.correctness={passed:true,historiesEqual:JSON.stringify(small[0].model)===JSON.stringify(m),...m.counts,
   groupCount:m.counts.duplicates,pairCount:m.duplicateSummary.pairCount,memberCount:m.duplicateSummary.memberCount};
  result.correctness.passed=result.correctness.historiesEqual;
  result.plans=hot.filter(r=>r.plans).flatMap(r=>r.plans.map(p=>({scenario:r.scenario,...p})));
  result.plansComplete=Boolean(result.plans?.length);
  result.complete=true;Object.assign(result,evaluateGate(result));
 } catch(error) {result.error={message:error.message,code:error.code};result.failures=[error.message];}
 finally {await writeFile(output,JSON.stringify(result,null,2)+'\n');}
 return result;
}

// Run the high-risk D2 chain in isolation before completing the remaining stages.
// This is a prerequisite diagnostic, never a substitute for a full Task 0 PASS.
export async function runRelationshipPreflight({ adminUrl, output } = {}) {
  checkAdmin(adminUrl);
  const db = await freshDb({ migrate: false });
  const evidence = { pass: false, complete: false, phase: 'relationship preflight',
    hardware: { os: `${platform()} ${release()}`, cpu: cpus()[0]?.model,
      cores: cpus().length, ram: totalmem(), node: process.version, pg: require('pg/package.json').version },
    parameters: { members: 50_000, chain: 100_000, statementTimeoutMs: 5_000,
      deadlineMs: 15_000, scenario: 'two-class-chain', seed: 0 },
    plans: [], timings: [], memory: [], statements: { financial: 0, total: 0 },
    missingMeasurements: ['full pipeline', 'exhaustive oracles', '20 warmed processes',
      'paired history memory', 'all detail pages'],
  };
  const snap = phase => evidence.memory.push({ phase, ...process.memoryUsage(),
    maxRSS: process.resourceUsage().maxRSS });
  let tx;
  try {
    evidence.database = await assertDisposable(db.pool);
    evidence.hashes = await prepareProbe(db.pool);
    evidence.hashes.sql = hash(await readFile(new URL('./morning-probe-sql.mjs', import.meta.url), 'utf8'));
    evidence.hashes.prototype = hash(await readFile(fileURLToPath(import.meta.url), 'utf8'));
    const { rows: [server] } = await db.pool.query('SELECT version() AS version');
    evidence.hardware.server = server.version;
    evidence.hardware.settings = (await db.pool.query(`SELECT name,setting,unit FROM pg_settings
      WHERE name = ANY($1::text[]) ORDER BY name`, [[
      'shared_buffers','work_mem','maintenance_work_mem','max_connections','jit',
      'effective_cache_size','random_page_cost','max_parallel_workers_per_gather',
    ]])).rows;
    tx = await db.pool.connect();
    await tx.query('BEGIN');
    await tx.query(`INSERT INTO org (slug,name) VALUES ('mvprobe','Sample company A')`);
    await tx.query(`INSERT INTO entity (org_id,name) VALUES (1,'Sample company A')`);
    await tx.query(`INSERT INTO vendor (org_id,entity_id,display_name)
      VALUES (1,1,'Sample vendor A')`);
    await tx.query(`INSERT INTO account (org_id,entity_id,name,type)
      VALUES (1,1,'Sample bank A','bank'),(1,1,'Sample offset A','equity')`);
    // Valid nonposting ineligible documents; historical and future intermediates.
    await tx.query({ text: `INSERT INTO txn
      (org_id,entity_id,txn_id,type,txn_date,total_cents,open_cents,source_txn_id)
      OVERRIDING SYSTEM VALUE SELECT 1,1,g,'journal_entry',
        CASE WHEN g % 2 = 0 THEN DATE '2021-10-17' ELSE DATE '2027-10-17' END,
        0,0,CASE WHEN g > 50001 THEN g-1 END
      FROM generate_series(50001,150000) g`, query_timeout: 120_000 });
    await tx.query({ text: `INSERT INTO txn
      (org_id,entity_id,txn_id,type,vendor_id,account_id,txn_date,total_cents,open_cents,
       source_txn_id,created_at,updated_at)
      OVERRIDING SYSTEM VALUE SELECT 1,1,g,'check',1,1,DATE '2026-10-17',40000,0,
        CASE WHEN g <= 25000 THEN 50001 ELSE 25001 END,
        CASE WHEN g = 1 THEN TIMESTAMPTZ '2026-10-17 14:00:00Z'
          ELSE TIMESTAMPTZ '2026-01-01 00:00:00Z' END,
        TIMESTAMPTZ '2026-01-01 00:00:00Z'
      FROM generate_series(1,50000) g`, query_timeout: 120_000 });
    // The second class's first member must not have a self edge.
    await tx.query('UPDATE txn SET source_txn_id = NULL WHERE txn_id = 25001');
    await tx.query({ text: `INSERT INTO posting
      (org_id,entity_id,txn_id,account_id,amount_cents,txn_date,vendor_id)
      SELECT 1,1,g,a,CASE WHEN a=1 THEN -40000 ELSE 40000 END,DATE '2026-10-17',1
      FROM generate_series(1,50000) g CROSS JOIN generate_series(1,2) a`, query_timeout: 120_000 });
    await tx.query({ text: 'COMMIT', query_timeout: 120_000 });
    await tx.query('ANALYZE');
    snap('after loading');
    global.gc?.(); snap('after forced GC');
    const samples = setInterval(() => snap('10ms sample'), 10);
    const start = performance.now();
    try {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await tx.query("SET LOCAL statement_timeout = '5s'");
      await installGraphFunctions(tx);
      const memberSpec = { name: 'members', dependencies: [], values: [1],
        text: `CREATE TEMP TABLE mv_dup_member ON COMMIT DROP AS
          SELECT txn_id FROM txn WHERE org_id=$1 AND type='check'` };
      const specs = [memberSpec, relationshipEdges({ orgId: 1 }),
        { name: 'edgeIndex', dependencies: ['relationshipEdges'], values: [],
          text: 'CREATE INDEX ON mv_relationship_edge (a,b)' },
        relationshipComponents()];
      for (const spec of specs) {
        const phaseStart = performance.now();
        snap(`before ${spec.name}`);
        evidence.statements.total++;
        if (/^(CREATE TEMP|SELECT|INSERT)/.test(spec.text)) evidence.statements.financial++;
        evidence.plans.push({ ...spec, analyzed: false });
        // Each CTAS is explained exactly once in its fresh dependency namespace.
        const explainable = spec.text.startsWith('CREATE TEMP');
        const result = await tx.query({ text: explainable
          ? `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${spec.text}` : spec.text,
        values: spec.values, query_timeout: 20_000 });
        if (explainable) Object.assign(evidence.plans.at(-1), {
          analyzed: true, plan: result.rows[0]['QUERY PLAN'],
        });
        evidence.timings.push({ phase: spec.name, ms: performance.now() - phaseStart });
        snap(`after ${spec.name}`);
        if (performance.now() - start >= 15_000) throw Object.assign(new Error('15-second deadline'), { code: '57014' });
      }
      const result = await tx.query(`SELECT count(*)::int AS reached,
        count(DISTINCT class)::int AS classes FROM mv_relationship_component`);
      evidence.statements.financial++; evidence.statements.total++;
      evidence.correctness = result.rows[0];
      evidence.criticalPassed = result.rows[0].reached === 150_000 && result.rows[0].classes === 2;
      await tx.query('ROLLBACK');
    } finally { clearInterval(samples); }
  } catch (error) {
    evidence.error = { code: error.code, message: error.message };
    evidence.failedQuery = evidence.plans.at(-1)?.name;
    await tx?.query('ROLLBACK').catch(() => {});
  } finally {
    tx?.release();
    await db.drop();
    evidence.dropped = true;
    if (output) await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.includes('--worker')) {
    const result=await measureWorker(process.env.MORNING_PROBE_DB,JSON.parse(process.argv[process.argv.indexOf('--worker')+1]));
    console.log(JSON.stringify(result));
  } else if(process.argv.includes('--relationship-preflight')) {
    const result=await runRelationshipPreflight({output:'morning-probe-union-preflight.log'});
    console.log(JSON.stringify({criticalPassed:result.criticalPassed??false,error:result.error,
      failedQuery:result.failedQuery,timings:result.timings,databaseDropped:result.dropped},null,2));
    process.exitCode=result.criticalPassed?0:1;
  } else {
    const implementation=process.argv.find(arg=>arg.startsWith('--implementation='))?.split('=')[1]??'prototype';
    const result=await runProbe({implementation});
    console.log(JSON.stringify({pass:result.pass,failures:result.failures,hot:result.hot,detail:result.detail,
      statements:result.statements,memory:result.memory,databases:result.databases},null,2));
    process.exitCode=result.pass?0:1;
  }
}
