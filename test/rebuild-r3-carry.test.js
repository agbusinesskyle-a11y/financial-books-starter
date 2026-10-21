import { PG_DUMP } from './pg-clients.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb,q,invoke,copy,saved,apply,dir,runFile,rehearse } from './rebuild-fixture.js';
import { validateCarryStructure, validateCarryCounts } from '../lib/rebuild/carry-validation.js';
import { saveJournalEntry } from '../lib/data/ledger-tools.js';
import { encryptSecret } from '../lib/secrets.js';
import { tableCounts } from '../lib/rebuild/dump.js';
import { writeExport, TXNS, OPEN, trialBalanceOf } from './qbo-fixture.js';
import { readQboExport } from '../lib/import/qbo-read.js';
import { importQboCompany } from '../lib/import/qbo-import.js';

async function backup(db,data,label) {
  const carry=join(dir,label+'.json'),dump=join(dir,label+'.dump');
  await writeFile(carry,JSON.stringify(data)); await utimes(carry,new Date(0),new Date(0));
  await runFile(PG_DUMP,['-Fc','-d',db.url,'-f',dump]);
  const receipt=await rehearse(dump);
  return {carry,dump,receipt,args:['--carry-over',carry,'--dump',dump,'--rehearsed',receipt,'--apply']};
}

test('T1 duplicate saved item replaces a different item without changing section coverage',async()=>{
  const db=await makeDb({imported:true}),ref=await makeDb({imported:true});
  await q(db,"INSERT INTO item(org_id,entity_id,name,kind,rate_cents,reorder_point) VALUES (1,1,'Sample stock A','inventory',1200,25),(1,1,'Sample stock B','inventory',3400,75)");
  const data=await saved(db),original=data.companies[0].items.map(i=>i.name);
  assert.equal(original.length,2);
  data.companies[0].items[1]=structuredClone(data.companies[0].items[0]);
  let validated=true; try {validateCarryStructure(data);await validateCarryCounts(db.pool,data);} catch {validated=false;}
  const files=await backup(db,data,'t1');
  const clear=await invoke('clear-books',files.args,db);
  let rebuilt=null,report=null;
  if(clear.code===0) {
    const copied=await copy(ref,db);assert.equal(copied.code,0,copied.stderr);
    report=await apply(db,data);rebuilt=await q(db,'SELECT name,reorder_point FROM item ORDER BY name');
  }
  console.log('T1',JSON.stringify({validated,clear:clear.code,stderr:clear.stderr,original,rebuilt,skipped:report?.skipped,decisions:report?.decisions,leftovers:report?.leftovers}));
  assert.notEqual(clear.code,0,'clear accepted a duplicated row in place of the other saved item');
  assert.equal(validated,false);
  assert.match(clear.stderr,/items\[1\].*duplicate natural identity/);
  assert.equal((await q(db,'SELECT count(*) n FROM item'))[0].n,2);
});

test('T2 changed ciphertext after backup must invalidate the current snapshot proof',async()=>{
  const db=await makeDb({imported:true});
  const oldCipher=encryptSecret(Buffer.alloc(32,9),'synthetic-old-tax-id'),newCipher=encryptSecret(Buffer.alloc(32,9),'synthetic-new-tax-id');
  await q(db,"UPDATE vendor SET tax_id_enc=$1 WHERE vendor_id=(SELECT min(vendor_id) FROM vendor)",[oldCipher]);
  const data=await saved(db),files=await backup(db,data,'t2');
  const before=await tableCounts(db.pool);
  await q(db,"UPDATE vendor SET tax_id_enc=$1 WHERE vendor_id=(SELECT min(vendor_id) FROM vendor)",[newCipher]);
  assert.notEqual(oldCipher,newCipher);assert.ok(!JSON.stringify(data).includes(newCipher));
  const after=await tableCounts(db.pool);assert.deepEqual(before,after);
  let validated=true;try{await validateCarryCounts(db.pool,data);}catch{validated=false;}
  const clear=await invoke('clear-books',files.args,db);
  console.log('T2',JSON.stringify({sameAllTableCounts:true,validated,clear:clear.code,stderr:clear.stderr,vendorsAfter:(await q(db,'SELECT count(*) n FROM vendor'))[0].n}));
  assert.notEqual(clear.code,0,'clear accepted backup and carry that both predate an unsaved secret change');
  assert.equal(validated,false);
  assert.match(clear.stderr,/vendorExtras\[\d+\].taxIdEnc content mismatch/);
  assert.ok(!clear.stderr.includes(oldCipher) && !clear.stderr.includes(newCipher));
  assert.equal((await q(db,'SELECT tax_id_enc FROM vendor WHERE tax_id_enc=$1',[newCipher])).length,1);
});

test('carry content comparison ignores collection order and savedAt, but refuses substituted values and extra fields',async()=>{
  const db=await makeDb({imported:true});
  await q(db,"INSERT INTO item(org_id,entity_id,name,kind,reorder_point) VALUES (1,1,'Sample stock A','inventory',25),(1,1,'Sample stock B','inventory',75)");
  const data=await saved(db);
  data.savedAt='2000-01-01T00:00:00.000Z';
  data.companies[0].items.reverse(); data.companies[0].vendorExtras.reverse();
  await validateCarryCounts(db.pool,data);
  const changed=structuredClone(data); changed.companies[0].items[0].reorderPoint='76.0000';
  await assert.rejects(validateCarryCounts(db.pool,changed),/items\[\d+\].reorderPoint content mismatch/);
  const extra=structuredClone(data); extra.companies[0].items[0].unexpected=true;
  await assert.rejects(validateCarryCounts(db.pool,extra),/items\[\d+\].unexpected/);
});

test('dump mtime must follow savedAt even when the carry file mtime was backdated',async()=>{
  const db=await makeDb({imported:true}), data=await saved(db), files=await backup(db,data,'mtime');
  await utimes(files.dump,new Date(0),new Date(Date.parse(data.savedAt)-1000));
  const clear=await invoke('clear-books',files.args,db);
  assert.equal(clear.code,1); assert.match(clear.stderr,/mtime.*savedAt/);
  assert.equal((await q(db,'SELECT count(*) n FROM entity'))[0].n,1);
});

test('malformed collection identities refuse with their path',async()=>{
  const db=await makeDb({imported:true}),data=await saved(db);
  data.companies[0].holds.push(null);
  await assert.rejects(validateCarryCounts(db.pool,data),/companies\[0\].holds\[0\]/);
});
