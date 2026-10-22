import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './integration-fixtures.js';
import { setupIntegrationItems } from '../lib/integration/item-setup.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('catalog setup is dry by default, approved by hash, atomic and idempotent',async()=>{
  const f=await fixture();
  const catalog={version:1,map_sha256:'a'.repeat(64),items:[{name:'Sample item B',kind:'product',income_account_name:'Sample income',expense_account_name:'Sample expense',qbo_type:'NonInventory'}]};
  const args={orgSlug:'sample',companyName:'Sample company A',catalog,actor:'tester'};
  try{
    const before=await f.count('item'),dry=await setupIntegrationItems(f.pool,args);
    assert.equal(dry.planned,1);assert.equal(dry.created,0);assert.equal(await f.count('item'),before);
    await assert.rejects(setupIntegrationItems(f.pool,{...args,apply:true,approvedHash:'b'.repeat(64)}),/approval hash/);
    const applied=await setupIntegrationItems(f.pool,{...args,apply:true,approvedHash:dry.hash});assert.equal(applied.created,1);
    const again=await setupIntegrationItems(f.pool,{...args,apply:true,approvedHash:dry.hash});assert.equal(again.created,0);assert.equal(again.existing,1);
    for(const change of [{expense_account_name:'Sample missing'},{qbo_type:'Inventory'},{kind:'inventory'}]){
      const bad={...catalog,items:[{...catalog.items[0],...change}]};
      await assert.rejects(setupIntegrationItems(f.pool,{...args,catalog:bad}));
    }
    await f.pool.query('UPDATE item SET income_account_id=$1 WHERE name=$2',[f.ids.expense,'Sample item B']);
    await assert.rejects(setupIntegrationItems(f.pool,args),/existing item differs/);
    assert.equal(await f.count('item'),before+1);
  }finally{await f.close();}
});
test('approval binds the destination and accounts; preview consumes no sequence and a late error rolls back all items',async()=>{
  const f=await fixture();
  const item=name=>({name,kind:'product',income_account_name:'Sample income',expense_account_name:'Sample expense',qbo_type:'NonInventory'});
  const args={orgSlug:'sample',companyName:'Sample company A',catalog:{version:1,map_sha256:'a'.repeat(64),items:[item('Sample item B'),item('Sample item C')]},actor:'tester'};
  try {
    const seq=async()=>(await f.pool.query('SELECT last_value,is_called FROM item_item_id_seq')).rows;
    const before=await f.count('item'),sequence=await seq(),dry=await setupIntegrationItems(f.pool,args);
    assert.deepEqual(await seq(),sequence);assert.equal(dry.planned,2);
    assert.equal(dry.accounts[0].income.account_id,f.ids.income);assert.equal(dry.accounts[0].income.type,'income');
    await f.pool.query('UPDATE integration_setting SET instance_id=gen_random_uuid() WHERE org_id=$1 AND entity_id=$2',[f.ids.orgId,f.ids.entityId]);
    const other=await setupIntegrationItems(f.pool,args);assert.notEqual(other.hash,dry.hash);
    await assert.rejects(setupIntegrationItems(f.pool,{...args,apply:true,approvedHash:dry.hash}),/approval hash/);
    await f.pool.query("UPDATE account SET type='other_income' WHERE account_id=$1",[f.ids.income]);
    const changed=await setupIntegrationItems(f.pool,args);assert.notEqual(changed.hash,other.hash);
    await assert.rejects(setupIntegrationItems(f.pool,{...args,apply:true,approvedHash:other.hash}),/approval hash/);
    // Force failure only on the second insertion, after the first has succeeded inside the transaction.
    await f.pool.query(`CREATE FUNCTION sample_item_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.name='Sample item C' THEN RAISE EXCEPTION 'sample late item failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER sample_item_failure BEFORE INSERT ON item FOR EACH ROW EXECUTE FUNCTION sample_item_failure()`);
    await assert.rejects(setupIntegrationItems(f.pool,{...args,apply:true,approvedHash:changed.hash}),/sample late item failure/);
    assert.equal(await f.count('item'),before);
    await f.pool.query('DROP TRIGGER sample_item_failure ON item');
    assert.equal((await setupIntegrationItems(f.pool,{...args,apply:true,approvedHash:changed.hash})).created,2);
    assert.equal((await setupIntegrationItems(f.pool,{...args,catalog:{...args.catalog,items:[...args.catalog.items].reverse()}})).hash,changed.hash);
  } finally {await f.close();}
});
test('setup CLI previews before apply and uses exact refusal exit codes',async()=>{
  const f=await fixture(),dir=await mkdtemp(join(tmpdir(),'integration-items-')),file=join(dir,'map.json');
  const run=args=>promisify(execFile)(process.execPath,['scripts/setup-integration-items.mjs',...args],
    {env:{...process.env,DATABASE_URL:f.db.url,ALLOW_SUPERUSER:'1'},windowsHide:true});
  try{
    await writeFile(file,JSON.stringify({version:1,map_sha256:'a'.repeat(64),items:[{name:'Sample item B',kind:'product',income_account_name:'Sample income',expense_account_name:'Sample expense',qbo_type:'NonInventory'}]}));
    const args=['--org','sample','--company','Sample company A','--app-map',file],before=await f.count('item');
    const dry=await run(args);assert.match(dry.stdout,/dry-run planned=1 existing=0 hash=[a-f0-9]{64}/);
    assert.equal(await f.count('item'),before);
    const hash=/hash=([a-f0-9]{64})/.exec(dry.stdout)[1];
    assert.match((await run([...args,'--apply','--approved-hash',hash])).stdout,/created=1 existing=0/);
    assert.match((await run([...args,'--apply','--approved-hash',hash])).stdout,/created=0 existing=1/);
    await assert.rejects(run([]),e=>e.code===2);
    await assert.rejects(run([...args,'--apply','--approved-hash','b'.repeat(64)]),e=>e.code===1);
  }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
