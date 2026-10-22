import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { mvOrg, mvCustomer, mvTxn } from './morning-fixtures.js';
import { classifyTables, TRANSIENT_TABLES, CARRIED_TABLES } from '../lib/rebuild/tables.js';
import { saveCarryOver, applyCarryOver } from '../lib/rebuild/carry-over.js';

test('integration schema enforces company scope and classifies rebuild state', async () => {
  const db = await freshDb();
  try {
    const x = await mvOrg(db.pool, {});
    const a = x.entities['Sample company A'], b = x.entities['Sample company B'];
    const customerId = await mvCustomer(db.pool, { orgId:x.orgId, entityId:b, name:'Sample customer B' });
    const txnId = await mvTxn(db.pool, { orgId:x.orgId, entityId:b, customerId,
      type:'invoice', date:'2026-10-21', postings:[{accountId:x.accounts['Sample company B'].ar,cents:100}] });
    await db.pool.query('INSERT INTO integration_setting(org_id,entity_id) VALUES($1,$2)', [x.orgId,a]);
    const s = (await db.pool.query('SELECT * FROM integration_setting WHERE entity_id=$1',[a])).rows[0];
    assert.equal(s.accept_writes,false); assert.equal(s.write_floor,null);
    assert.match(s.instance_id,/^[0-9a-f-]{36}$/);
    await assert.rejects(db.pool.query(`INSERT INTO external_ref(org_id,entity_id,source,source_ref,txn_id,request_hash)
      VALUES($1,$2,'sample_connector','invoice:1',$3,repeat('a',64))`,[x.orgId,a,txnId]), {code:'23503'});
    await assert.rejects(db.pool.query(`INSERT INTO api_token(org_id,entity_id,name,source,token_hash,scopes,created_by)
      VALUES($1,$2,'Sample token','sample_connector',decode(repeat('ab',32),'hex'),ARRAY['admin'],'tester')`,[x.orgId,a]),{code:'23514'});
    assert.deepEqual(await classifyTables(db.pool),[]);
    for (const table of ['api_token','external_ref']) {
      assert.ok(CARRIED_TABLES.includes(table));
      assert.ok(!TRANSIENT_TABLES.includes(table));
    }
    assert.ok(CARRIED_TABLES.includes('integration_setting'));
  } finally { await db.drop(); }
});

test('carry policy disables writes and retains the destination instance while preserving token hashes', async () => {
  const from = await freshDb(), to = await freshDb();
  try {
    const a = await mvOrg(from.pool, {slug:'sample'}), b = await mvOrg(to.pool, {slug:'sample'});
    const scope = x => [x.orgId,x.entities['Sample company A']];
    await from.pool.query(`INSERT INTO integration_setting(org_id,entity_id,accept_writes,write_floor,ledger_instance)
      VALUES($1,$2,true,'2027-01-01','sample-source')`, scope(a));
    const dest = (await to.pool.query(`INSERT INTO integration_setting(org_id,entity_id,accept_writes,ledger_instance)
      VALUES($1,$2,true,'sample-destination') RETURNING instance_id`,scope(b))).rows[0].instance_id;
    await from.pool.query(`INSERT INTO api_token(org_id,entity_id,name,source,token_hash,scopes,created_by)
      VALUES($1,$2,'Sample token','sample_connector',decode(repeat('ab',32),'hex'),ARRAY['documents:write'],'tester')`,scope(a));
    const data = await saveCarryOver(from.pool,{orgSlug:'sample'});
    assert.ok(!data.discarded.some(x=>x.table==='api_token'));
    assert.equal(data.companies.find(c=>c.name==='Sample company A').apiTokens[0].tokenHash,'ab'.repeat(32));
    await applyCarryOver(to.pool,{data,phase:'books',actor:'tester',env:{},dryRun:false});
    const s=(await to.pool.query('SELECT * FROM integration_setting WHERE entity_id=$1',[b.entities['Sample company A']])).rows[0];
    assert.equal(s.accept_writes,false); assert.equal(s.write_floor,'2027-01-01');
    assert.equal(s.instance_id,dest); assert.equal(s.ledger_instance,'sample-source');
    assert.equal((await to.pool.query('SELECT token_hash FROM api_token')).rows[0].token_hash.toString('hex'),'ab'.repeat(32));
    assert.equal((await to.pool.query('SELECT count(*)::int n FROM external_ref')).rows[0].n,0);
  } finally { await from.drop(); await to.drop(); }
});
