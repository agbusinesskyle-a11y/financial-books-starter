import { PG_DUMP } from './pg-clients.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la, rehearse } from './rebuild-fixture.js';

import { saveRule } from '../lib/bankfeed/rules.js';
test('C1 real FK and posting-imbalance refusals roll back all copied tables',async()=>{
  for (const kind of ['fk','balance']) {
    const src=await makeDb({imported:true}),dst=await makeDb({entity:false});
    if(kind==='fk') {
      const c=await src.pool.connect();
      // Keep account balances and child totals intact so the FK gate is exercised independently.
      try {await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");await c.query('UPDATE posting SET project_id=999999 WHERE posting_id=(SELECT min(posting_id) FROM posting)');await c.query('COMMIT');}finally{c.release();}
    } else { await q(src,'ALTER TABLE posting DISABLE TRIGGER ALL'); await q(src,'UPDATE posting SET amount_cents=amount_cents+1 WHERE posting_id=(SELECT min(posting_id) FROM posting)'); }
    const r=await copy(src,dst); console.log('C1',kind,r.code,r.stderr.trim());
    assert.equal(r.code,1); assert.match(r.stderr,kind==='fk'?/foreign key/:/unbalanced transactions/);
    assert.equal((await q(dst,'SELECT count(*) n FROM entity'))[0].n,0);
  }
});

test('C2 schema mismatch and incompatible feed account type are refused',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({entity:false});
  await q(dst,"DELETE FROM schema_migrations WHERE name=(SELECT max(name) FROM schema_migrations)");
  const result=await copy(src,dst); assert.equal(result.code,1);assert.match(result.stderr,/schema_migrations name sets differ/);
  const d=await makeDb();await feed(d);
  await q(d,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'");
  await q(d,"INSERT INTO account(org_id,entity_id,name,type) VALUES(1,1,'Sample account','credit_card')");
  const data=await saved(d);data.companies[0].feed.accounts[0].books={account:'Sample account',type:'bank'};
  const report=await apply(d,data,'feeds');assert.equal(report.skipped.filter(x=>x.what==='mapping').length,1);
  assert.equal((await q(d,'SELECT books_account_id FROM ledgerline_account'))[0].books_account_id,null);
});

test('C3 rule cents, range, basis points, UUID list and feed rerun preserve business values',async()=>{
  const src=await makeDb(),dst=await makeDb();
  for(const d of [src,dst]) {
    await feed(d);await q(d,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'");
    await q(d,"INSERT INTO account(org_id,entity_id,name,type) VALUES(1,1,'Sample expense A','expense'),(1,1,'Sample expense B','expense')");
  }
  await saveRule(src.pool,{orgId:1,entityId:1,actor:'tester',fields:{name:'Sample split',money:'out',conditions:[{field:'amount',op:'between',value:'12.34',value2:'50.01'}],accountId:1,priority:'0',active:false,matchAll:false,llAccounts:[la],memoMode:'append',mode:'suggest',splits:[{accountId:1,amount:'1.23'},{accountId:1,percent:'12.5'},{accountId:2,percent:'87.5'}]}});
  const data=await saved(src);await apply(dst,data,'feeds');
  const sql='SELECT name,priority,active,money,conditions,ll_account_ids,splits,memo_mode,match_all FROM bank_rule';
  assert.deepEqual(await q(dst,sql),await q(src,sql));
  const first=await q(dst,sql);await apply(dst,data,'feeds');assert.deepEqual(await q(dst,sql),first);
});


test('C4 clear refuses wrong names, stale or wrong-format dumps and unclassified tables; preserves kept contents on success',async()=>{
  const d=await makeDb({imported:true});
  await q(d,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'");
  await q(d,"INSERT INTO app_user(org_id,name,email,role) VALUES(1,'Sample owner','owner@example.com','admin')");
  await q(d,"INSERT INTO user_invite(org_id,user_id,token_hash,expires_at) VALUES(1,1,'sample-hash',now()+interval '1 day')");
  const f=join(dir,'c4-carry.json'),dump=join(dir,'c4-real.dump');const data=await saved(d);
  await writeFile(f,JSON.stringify(data));await runFile(PG_DUMP,['-Fc','-d',d.url,'-f',dump]);
  const args=['--carry-over',f,'--dump',dump,'--rehearsed',await rehearse(dump),'--apply'];
  const wrong=structuredClone(data);wrong.companies[0].name='Sample company B';await writeFile(f,JSON.stringify(wrong));
  let r=await invoke('clear-books',args,d);assert.equal(r.code,1);assert.match(r.stderr,/company names do not match/);
  await writeFile(f,JSON.stringify(data));await utimes(dump,new Date(0),new Date(0));
  r=await invoke('clear-books',args,d);assert.equal(r.code,1);assert.match(r.stderr,/newer/);
  await utimes(f,new Date(Date.now()-10000),new Date(Date.now()-10000));await utimes(dump,new Date(),new Date());
  const bad=join(dir,'c4-bad.dump');await writeFile(bad,'plain SQL');r=await invoke('clear-books',['--carry-over',f,'--dump',bad,'--apply'],d);assert.equal(r.code,1);assert.match(r.stderr,/PGDMP/);
  await q(d,'CREATE TABLE review_unknown(n integer)');r=await invoke('clear-books',args,d);assert.equal(r.code,1);assert.match(r.stderr,/unclassified/);await q(d,'DROP TABLE review_unknown');
  const kept=['org','schema_migrations','app_user','user_invite','audit_log'],before={};
  for(const name of kept)before[name]=await q(d,`SELECT * FROM ${name} ORDER BY 1`);
  r=await invoke('clear-books',args,d);assert.equal(r.code,0,r.stderr);
  for(const name of kept)assert.deepEqual(await q(d,`SELECT * FROM ${name} ORDER BY 1`),before[name]);
  const {IMPORTER_TABLES,CARRIED_TABLES,TRANSIENT_TABLES}=await import('../lib/rebuild/tables.js');
  for(const name of [...IMPORTER_TABLES,...CARRIED_TABLES,...TRANSIENT_TABLES])assert.equal((await q(d,`SELECT count(*) n FROM ${name}`))[0].n,0,name);
  assert.deepEqual((await q(d,'SELECT last_value,is_called FROM entity_entity_id_seq'))[0],{last_value:1,is_called:false});
});

test('C5 ciphertext survives unchanged; reports contain neither plaintext nor ciphertext',async()=>{
  const {encryptSecret}=await import('../lib/secrets.js');
  const {carryOverReport}=await import('../lib/rebuild/carry-over.js');
  const src=await makeDb(),dst=await makeDb();
  const secret='synthetic-secret-not-real',enc=encryptSecret(Buffer.alloc(32,7),secret);
  await q(src,'UPDATE entity SET ein_enc=$1,ein_last4=$2',[enc,'1234']);
  await q(src,"INSERT INTO ai_settings(org_id,provider,api_key_enc) VALUES(1,'openrouter',$1)",[enc]);
  await q(src,"INSERT INTO email_settings(org_id,entity_id,mode,from_email,smtp_host,smtp_port,smtp_password_enc) VALUES(1,1,'smtp','sample@example.com','smtp.example.com',587,$1)",[enc]);
  const data=await saved(src);assert.ok(!JSON.stringify(data).includes(secret));assert.ok(JSON.stringify(data).includes(enc));
  assert.ok(!JSON.stringify(carryOverReport(data)).includes(enc));assert.ok(!JSON.stringify(carryOverReport(data)).includes(secret));
  const report=await apply(dst,data);assert.equal(report.skipped.length,0);
  assert.equal((await q(dst,'SELECT ein_enc FROM entity'))[0].ein_enc,enc);
  assert.equal((await q(dst,'SELECT api_key_enc FROM ai_settings'))[0].api_key_enc,enc);
  assert.equal((await q(dst,'SELECT smtp_password_enc FROM email_settings'))[0].smtp_password_enc,enc);
});
