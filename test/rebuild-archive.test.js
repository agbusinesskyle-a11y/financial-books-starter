import { PG_DUMP } from './pg-clients.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la, rehearse } from './rebuild-fixture.js';

test('archive must contain the target database and all its tables; PG_RESTORE override is honored', async t => {
  const db = await makeDb({imported:true}), other = await makeDb();
  const carry = join(dir,'archive-carry.json'); await writeFile(carry,JSON.stringify(await saved(db)));
  await utimes(carry,new Date(0),new Date(0));
  for (const kind of ['wrong-database','partial','override','valid']) await t.test(kind,async()=>{
    const dump=join(dir,kind+'.dump');
    await runFile(PG_DUMP,['-Fc','-d',kind==='wrong-database'?other.url:db.url,'-f',dump,...(kind==='partial'?['-t','public.org']:[])]);
    const args=['--carry-over',carry,'--dump',dump,...(kind==='valid'?['--rehearsed',await rehearse(dump)]:[])];
    if(kind==='override') {
      await assert.rejects(runFile(process.execPath,['scripts/clear-books.mjs',...args],{env:{...process.env,DATABASE_URL:db.url,PG_RESTORE:join(dir,'missing-pg-restore.exe')}}),e=>e.code===1 && /pg_restore/.test(e.stderr));
    } else {
      const result=await invoke('clear-books',args,db);
      assert.equal(result.code,kind==='valid'?0:1,result.stderr);
      if(kind==='partial') assert.match(result.stderr,/tables/);
      if(kind==='wrong-database') assert.match(result.stderr,/database/);
    }
    assert.equal((await q(db,'SELECT count(*) n FROM entity'))[0].n,1);
  });
});

test('R4 clear must reject a truncated five-byte dump even with valid carry-over',async()=>{
  const d=await makeDb({imported:true}); const f=join(dir,'r4-carry.json'),dump=join(dir,'r4-invalid.dump');
  await writeFile(f,JSON.stringify(await saved(d))); await writeFile(dump,'PGDMP');
  await utimes(f,new Date(Date.now()-10000),new Date(Date.now()-10000));
  const result=await invoke('clear-books',['--carry-over',f,'--dump',dump,'--apply'],d);
  console.log('R4',JSON.stringify({code:result.code,tail:result.stdout?.split('\n').slice(-3),entities:(await q(d,'SELECT count(*) n FROM entity'))[0].n}));
  assert.notEqual(result.code,0);
});
