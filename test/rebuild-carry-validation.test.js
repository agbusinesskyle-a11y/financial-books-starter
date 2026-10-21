import { PG_DUMP } from './pg-clients.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('clear validates required sections, metadata, and table counts before destruction', async t => {
  const db = await makeDb({imported:true});
  const data = await saved(db), file = join(dir,'validation.json'), dump = join(dir,'validation.dump');
  await runFile(PG_DUMP,['-Fc','-d',db.url,'-f',dump]);
  const variants = [
    ...['savedAt','database','schemaMigrations','orgSlug','version'].map(key=>[key,d=>{delete d[key];}]),
    ['savedAt',d=>{d.savedAt='yesterday';}],
    ['ledgerline_link',d=>{delete d.companies[0].feed;}],
    ['bank_rule',d=>{delete d.companies[0].rules;}],
    ['settings',d=>{delete d.companies[0].settings;}],
    ...['ledgerline_link','ledgerline_account','bank_rule','ai_settings','app_user_company'].map(table=>[table,d=>{d.counts ??= {};d.counts[table]=123;}]),
  ];
  for (const [name, mutate] of variants) await t.test(name,async()=>{
    const changed=structuredClone(data);mutate(changed);
    await writeFile(file,JSON.stringify(changed));
    await utimes(file,new Date(0),new Date(0));
    const result=await invoke('clear-books',['--carry-over',file,'--dump',dump],db);
    assert.equal(result.code,1);
    assert.match(result.stderr,new RegExp(name));
    assert.equal((await q(db,'SELECT count(*) n FROM entity'))[0].n,1);
  });
});

test('R5 clear must reject a name-only object with no saved state',async()=>{
  const d=await makeDb({imported:true}); const f=join(dir,'r5-empty-carry.json'),dump=join(dir,'r5-invalid.dump');
  await writeFile(f,JSON.stringify({version:1,orgSlug:'sample',companies:[{name:'Sample company A'}]}));
  await runFile(PG_DUMP,['-Fc','-d',d.url,'-f',dump]); await utimes(f,new Date(Date.now()-10000),new Date(Date.now()-10000));
  const result=await invoke('clear-books',['--carry-over',f,'--dump',dump,'--apply'],d);
  console.log('R5',JSON.stringify({code:result.code,entities:(await q(d,'SELECT count(*) n FROM entity'))[0].n}));
  assert.notEqual(result.code,0);
});
