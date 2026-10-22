import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,copyFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './harness.js';
import { runMigrations } from '../lib/migrate.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
test('upgrade preserves every pre-integration financial row',async()=>{
  const db=await freshDb({migrate:false}),dir=await mkdtemp(join(tmpdir(),'integration-upgrade-'));
  try{
    for(const name of await readdir('migrations')) if(/^\d{3}_.*\.sql$/.test(name)&&Number(name.slice(0,3))<68) await copyFile(join('migrations',name),join(dir,name));
    await runMigrations(db.pool,dir);
    await writeSample(db.pool,generateSample({asOf:'2026-10-20'}));
    const snap=async()=>Promise.all(['txn','txn_line','posting','application'].map(async t=>(await db.pool.query(`SELECT to_jsonb(x) row FROM ${t} x ORDER BY to_jsonb(x)::text`)).rows));
    const before=await snap();await runMigrations(db.pool);assert.deepEqual(await snap(),before);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM api_token')).rows[0].n,0);
  }finally{await db.drop();await rm(dir,{recursive:true,force:true});}
});
