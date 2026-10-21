import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { reference, invoke, databaseContent } from './refdiff-fixture.js';
import { readReference } from '../lib/refdiff/snapshot.js';
import { compareReferences } from '../lib/refdiff/compare.js';
test('CLI writes company reports while preserving both databases', async t=>{
  const a=await reference(t,{companies:['Sample company A','Sample company B']});
  const b=await reference(t,{companies:['Sample company B','Sample company A']});
  const before=[await databaseContent(a),await databaseContent(b)],out=join(a.dir,'out');
  const r=await invoke([a.urlFile,b.urlFile,'--out',out]); assert.equal(r.code,0,r.stderr);
  const d=JSON.parse(await readFile(join(out,'diff.json'),'utf8'));
  const md=await readFile(join(out,'report.md'),'utf8');
  const map=JSON.parse(await readFile(join(out,'rename-map.candidate.json'),'utf8'));
  assert.equal(d.version,1); assert.equal(d.companies.length,2);
  assert.equal(map.approved,false); assert.deepEqual(map.candidates,[]);
  for(const company of ['Sample company A','Sample company B']) {
    assert.ok(md.includes(company));
    assert.deepEqual(d.companies.find(c=>c.company===company).counts.transactions,
      {unchanged:10,added:0,changed:0,vanished:0,voids:0});
  }
  assert.match(md,/Added.*Changed.*Vanished/);
  assert.deepEqual([await databaseContent(a),await databaseContent(b)],before);
  const all=r.stdout+r.stderr+md+JSON.stringify(d)+JSON.stringify(map);
  assert.ok(!all.includes(a.url)); assert.ok(!all.includes(b.url)); assert.ok(!/postgres(?:ql)?:\/\//i.test(all));
  const again=await invoke([a.urlFile,b.urlFile,'--out',out]);
  assert.equal(again.code,1); assert.match(again.stderr,/output directory already exists/);
});
test('identity mismatch publishes no output; bad URLs never echo credentials', async t=>{
  const a=await reference(t),b=await reference(t,{orgSlug:'sample_other'}),out=join(a.dir,'refused');
  const r=await invoke([a.urlFile,b.urlFile,'--out',out]);
  assert.equal(r.code,1); assert.match(r.stderr,/org slugs differ/);
  assert.ok(!(await readdir(a.dir)).includes('refused'));
  const bad=join(a.dir,'bad.url'); await writeFile(bad,'postgres://sample-user:sample-secret@127.0.0.1:1/sample-db');
  const failed=await invoke([a.urlFile,bad,'--out',out]); assert.equal(failed.code,1);
  assert.ok(!/sample-secret|sample-user|postgres:\/\//.test(failed.stdout+failed.stderr));
  const usage=await invoke(['postgres://sample-user:sample-secret@127.0.0.1:1/sample-db',b.urlFile,'--out',out]);
  assert.equal(usage.code,2); assert.ok(!usage.stderr.includes('sample-secret'));
});
test('native contamination, malformed aliases and URL options refuse', async t=>{
  const a=await reference(t),b=await reference(t);
  await b.pool.query("INSERT INTO txn(org_id,entity_id,type,txn_date,total_cents,open_cents) SELECT org_id,entity_id,'journal_entry','2026-06-01',0,0 FROM entity");
  const native=await invoke([a.urlFile,b.urlFile,'--out',join(a.dir,'native')]);
  assert.equal(native.code,1); assert.match(native.stderr,/non-import/);
  await a.pool.query("UPDATE import_batch SET summary=jsonb_set(summary,'{renamed}','[\"bad rename evidence\"]'::jsonb)");
  const malformed=await invoke([a.urlFile,a.urlFile,'--out',join(a.dir,'malformed')]);
  assert.equal(malformed.code,1); assert.match(malformed.stderr,/rename evidence/);
  const override=join(a.dir,'override.url'),u=new URL(b.url);
  u.searchParams.set('options','-c default_transaction_read_only=off'); await writeFile(override,u.toString());
  const refused=await invoke([override,b.urlFile,'--out',join(a.dir,'override')]);
  assert.equal(refused.code,1); assert.match(refused.stderr,/options/);
});
test('encoded options, query redirects, unsupported schemes and apply all refuse safely',async t=>{
  const db=await reference(t),file=join(db.dir,'unsafe.url');
  for(const suffix of ['?%6fptions=-c%20default_transaction_read_only%3Doff','?OPTIONS=anything','?host=sample-secret','?options%00=anything']) {
    await writeFile(file,db.url+suffix);
    const r=await invoke([file,db.urlFile,'--out',join(db.dir,'refused')]);
    assert.equal(r.code,1); assert.ok(!/sample-secret|postgres:\/\//.test(r.stdout+r.stderr));
  }
  await writeFile(file,'https://sample-user:sample-secret@sample.invalid/db');
  const r=await invoke([file,db.urlFile,'--out',join(db.dir,'refused')]); assert.equal(r.code,1);
  assert.ok(!r.stderr.includes('sample-secret'));
  assert.equal((await invoke([db.urlFile,db.urlFile,'--out',join(db.dir,'refused'),'--apply'])).code,2);
});
test('failed snapshot rolls back, closes its connection and leaves tables and sequences unchanged',async t=>{
  const db=await reference(t); await db.pool.query("UPDATE import_batch SET summary=summary-'referenceIdentity'");
  const before=await databaseContent(db);
  await assert.rejects(readReference(db.urlFile),/insufficient/);
  assert.deepEqual(await databaseContent(db),before);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='financial-books-ref-diff'")).rows[0].n,0);
});
test('rename cycles and malformed original identity evidence refuse',async t=>{
  const db=await reference(t);
  const original=(await db.pool.query('SELECT summary FROM import_batch')).rows[0].summary;
  await db.pool.query('UPDATE import_batch SET summary=$1',[{...original,renamed:['Fuel → Repairs','Repairs → Fuel'],renamedAccounts:2}]);
  await assert.rejects(readReference(db.urlFile),/rename.*cycle/);
  original.referenceIdentity.transactions[0].number={invalid:true};
  await db.pool.query('UPDATE import_batch SET summary=$1',[original]);
  await assert.rejects(readReference(db.urlFile),/number evidence/);
});
test('reports escape Markdown/HTML and candidate artifacts contain evidence without contacts',async t=>{
  const company='Sample <b>|company</b>\nsecond line';
  const a=await reference(t,{companies:[company]}),b=await reference(t,{companies:[company],aliases:{Repairs:'Sample service expense','Sample vendor A':'Sample vendor renamed'}});
  const out=join(a.dir,'out'),r=await invoke([a.urlFile,b.urlFile,'--out',out]); assert.equal(r.code,0,r.stderr);
  const md=await readFile(join(out,'report.md'),'utf8'),raw=await readFile(join(out,'rename-map.candidate.json'),'utf8'),map=JSON.parse(raw);
  assert.ok(!md.includes('<b>')); assert.ok(md.includes('&lt;b&gt;')); assert.ok(md.includes('\\|'));
  assert.ok(!md.includes('company</b>\n')); assert.match(md,/Before.*After/);
  assert.equal(map.approved,false); assert.ok(map.candidates.length>=2);
  for(const c of map.candidates) {assert.equal(c.approved,false);assert.match(c.snapshotHashes.a,/^[a-f0-9]{64}$/);assert.equal(c.company,company);}
  assert.ok(!/555-0100|@sample.example|contactSignature|usageSignature/.test(raw+md));
});
test('partial publication failure removes only its staging files and permits a retry',async t=>{
  const {writeArtifacts}=await import('../lib/refdiff/report.js');
  const db=await reference(t),s=await readReference(db.urlFile),d=compareReferences(s,s),out=join(db.dir,'out');
  await writeFile(join(db.dir,'keep.txt'),'Sample retained evidence');
  const before=(await readdir(db.dir)).sort(); let calls=0;
  await assert.rejects(writeArtifacts(out,d,{...fs,writeFile:async(...args)=> {if(++calls===2)throw new Error('Sample failure');return fs.writeFile(...args);}}),/publication failed/);
  assert.deepEqual((await readdir(db.dir)).sort(),before);
  await writeArtifacts(out,d); assert.equal((await readdir(out)).length,3);
});
test('concurrent publishers cannot overwrite each other',async t=>{
  const {writeArtifacts}=await import('../lib/refdiff/report.js');
  const db=await reference(t),s=await readReference(db.urlFile),d=compareReferences(s,s),out=join(db.dir,'out');
  const results=await Promise.allSettled([writeArtifacts(out,d),writeArtifacts(out,d)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await readdir(out)).length,3);
});
test('both sources are attempted and closed when either lacks identity evidence',async t=>{
  const a=await reference(t),b=await reference(t);
  await a.pool.query("UPDATE import_batch SET summary=summary-'referenceIdentity'");
  await b.pool.query("UPDATE import_batch SET summary=summary-'referenceIdentity'");
  const r=await invoke([a.urlFile,b.urlFile,'--out',join(a.dir,'refused')]);
  assert.equal(r.code,1); assert.match(r.stderr,/source a: insufficient/); assert.match(r.stderr,/source b: insufficient/);
  for(const db of [a,b]) assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='financial-books-ref-diff'")).rows[0].n,0);
});
