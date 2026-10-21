import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accountChart } from '../lib/refdiff/snapshot.js';
import { compareReferences } from '../lib/refdiff/compare.js';
import { renderReport, writeArtifacts } from '../lib/refdiff/report.js';

function diff() {
  const {accounts}=accountChart([{account_id:1,name:'Sample private account',parent_id:null,number:null,type:'asset',active:true}],
    {renamed:[],renamedAccounts:0});
  const snapshot={database:'sample',orgSlug:'sample',migrations:['sample'],contentHash:'sample',companies:[{company:'Sample company',
    accounts:[],transactions:[],customers:[],vendors:[],openItems:[],omissions:0,acceptedMismatches:[],importRange:{}}]};
  const after=structuredClone(snapshot);after.companies[0].accounts=accounts;
  after.companies[0].acceptedMismatches=['Sample private account accepted mismatch'];
  return compareReferences(snapshot,after);
}

test('counts-only report and artifacts omit account names and detailed evidence',async t=>{
  const d=diff(),dir=await mkdtemp(join(tmpdir(),'fb-refdiff-report-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  assert.ok(renderReport(d).includes('Sample private account'));
  const report=renderReport(d,{countsOnly:true});
  assert.ok(!report.includes('Sample private account'));assert.ok(report.includes('Sample company'));
  await writeArtifacts(join(dir,'out'),d,undefined,{countsOnly:true});
  for(const file of ['report.md','diff.json','rename-map.candidate.json'])
    assert.ok(!(await readFile(join(dir,'out',file),'utf8')).includes('Sample private account'));
  const data=JSON.parse(await readFile(join(dir,'out','diff.json'),'utf8'));
  assert.equal(data.detailsOmitted,true);assert.equal(data.companies[0].counts.accounts.added,1);
  assert.equal(data.companies[0].accounts,undefined);
});

test('CLI accepts counts-only without exposing missing input paths',async()=>{
  await assert.rejects(promisify(execFile)(process.execPath,['scripts/ref-diff.mjs',
    'sample-missing-a.url','sample-missing-b.url','--out','sample-unused-output','--counts-only']),e=> {
    assert.equal(e.code,1);assert.match(e.stderr,/reference read failed/);
    assert.ok(!e.stderr.includes('sample-missing'));return true;
  });
});
