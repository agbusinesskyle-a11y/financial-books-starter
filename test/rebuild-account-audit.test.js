import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('R11 account activation audit deltas must retain the account name',async()=>{
  const d=await makeDb();
  await q(d,"INSERT INTO account(org_id,entity_id,name,type) VALUES(1,1,'Sample closed card','credit_card')");
  const c=await d.pool.connect();
  try {await c.query('BEGIN');await c.query("SET LOCAL app.actor='tester'");await c.query('UPDATE account SET active=false WHERE account_id=1');await c.query('COMMIT');}finally{c.release();}
  const data=await saved(d),a=data.companies[0].accountChanges.find(a=>a.kind==='inactivated');
  console.log('R11',JSON.stringify({audit:(await q(d,"SELECT before,after FROM audit_log WHERE action='update' AND table_name='account'")),saved:a}));
  assert.equal(a.name,'Sample closed card');assert.equal(a.type,'credit_card');
});
