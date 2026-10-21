import * as fs from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { ReferenceRefusal } from './snapshot.js';

const escape = value => String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  .replace(/[\\`*_{}[\]()#+!|]/g,'\\$&').replace(/\r\n|\r|\n/g,' ⏎ ');
const describe = value => value==null?'—':Array.isArray(value)?value.map(describe).join('; '):typeof value==='object'
  ?Object.entries(value).map(([key,v])=>`${key}: ${describe(v)}`).join(', '):String(value);
const table = (head,rows) => ['| '+head.join(' | ')+' |','| '+head.map(()=>'---').join(' | ')+' |',
  ...rows.map(row=>'| '+row.map(v=>escape(describe(v))).join(' | ')+' |'),''].join('\n');
const document = t => t ? {family:t.family,date:t.date,number:t.number,party:t.party,repeat:t.repeat,postings:t.postings,
  ...(t.voidStatus?{voidStatus:t.voidStatus}:{}),...(t.explicitVoidMemo?{explicitVoidMemo:true}:{})}:null;
export function candidateMap(diff) {
  return {version:1,approved:false,orgSlug:diff.orgSlug,sources:diff.sources,
    candidates:diff.companies.flatMap(c=>[...c.accounts.renamed,...c.customers.renamed,...c.vendors.renamed])};
}
export function renderReport(diff,{countsOnly=false}={}) {
  const out=['# Reference comparison','',`Organization: ${escape(diff.orgSlug)}`,'',
    table(['Source','Database','Content SHA-256'],Object.entries(diff.sources).map(([side,s])=>[side,s.database,s.contentHash])),
    '## Limitations','',...diff.limitations.map(s=>`- ${escape(s)}`),''];
  for (const c of diff.companies) {
    out.push(`## ${escape(c.company)}`,'',table(['Documents','Unchanged','Added','Changed','Vanished','Void evidence'],
      [['Primary documents (including separately counted omissions)',...['unchanged','added','changed','vanished','voids'].map(k=>c.counts.transactions[k])]]),
      `Omissions before: ${c.counts.omissions.before}; after: ${c.counts.omissions.after}.`,'',
      table(['List','Added','Changed','Vanished','Rename candidates','Ambiguous candidates'],['accounts','customers','vendors'].map(k=>
        [k,...['added','changed','vanished','renamed','ambiguousCandidates'].map(f=>c.counts[k][f])])));
    if (countsOnly) {
      out.push(`Accounts inactivated: ${c.counts.accounts.inactivated}. Open-item allocation groups changed: ${c.counts.openItems.changed}.`,'');
      continue;
    }
    out.push('### Transaction details','',table(['Result','Field','Before','After'],[
        ...c.transactions.added.map(t=>['Added','',null,document(t)]),
        ...c.transactions.changed.map(r=>['Changed candidate',r.field,document(r.before),document(r.after)]),
        ...c.transactions.vanished.map(t=>['Vanished','',document(t),null]),
        ...c.transactions.ambiguousCandidates.map(r=>['Ambiguous candidate',r.field,document(r.before),document(r.after)]),
      ]),'### Void evidence (including unchanged evidence)','',table(['Status changed','Content changed','Before','After'],
        c.transactions.voids.map(r=>[r.statusChanged,r.contentChanged,document(r.before),document(r.after)])));
    for (const kind of ['accounts','customers','vendors']) {
      const d=c[kind];
      out.push(`### ${kind}`,'',table(['Result','Fields / evidence','Before','After'],[
        ...d.added.map(r=>['Added','',null,r]),...d.changed.map(r=>['Changed',r.fields,r.before,r.after]),
        ...d.vanished.map(r=>['Vanished','',r,null]),
        ...d.renamed.map(r=>['Rename candidate (unapproved)',r.evidence,r.before,r.after]),
        ...d.ambiguousCandidates.map(r=>['Ambiguous rename',r.evidence,r.before,r.after]),
      ]));
    }
    out.push('### Terminal open items (signed cents) — 9999-12-31','',table(['Side','Party','Changed','Before cents','After cents','Delta cents','Before allocations','After allocations'],
      c.openItems.map(p=>[p.side,p.party,p.changed,p.beforeCents,p.afterCents,p.deltaCents,p.before,p.after])),
      '### Accepted importer mismatches','',table(['Before','After'],[[c.acceptedMismatches.before,c.acceptedMismatches.after]]));
  }
  return out.join('\n')+'\n';
}

// The exclusive lock serializes cooperating publishers; the final directory rename
// exposes only a complete report. An existing output (including an empty one) refuses.
export async function writeArtifacts(output,diff,io=fs,{countsOnly=false}={}) {
  const out=resolve(output),parent=dirname(out),prefix=`.${basename(out)}.stage-`,lock=`${out}.lock`;
  let stage,handle;
  const absent=async()=> {
    try { await io.lstat(out); } catch (e) { if(e.code==='ENOENT')return; throw e; }
    throw new ReferenceRefusal('output directory already exists');
  };
  try {
    await absent();
    try {handle=await io.open(lock,'wx',0o600);} catch (e) {
      if(e.code==='EEXIST')throw new ReferenceRefusal('output publication already in progress'); throw e;
    }
    await absent(); stage=await io.mkdtemp(join(parent,prefix));
    await io.chmod(stage,0o700);
    const data=countsOnly?{version:diff.version,orgSlug:diff.orgSlug,sources:diff.sources,limitations:diff.limitations,
      companies:diff.companies.map(({company,counts})=>({company,counts})),totals:diff.totals,detailsOmitted:true}:diff;
    const candidates=countsOnly?{version:1,approved:false,orgSlug:diff.orgSlug,sources:diff.sources,
      candidates:[],detailsOmitted:true,candidateCount:diff.companies.reduce((n,c)=>n+c.accounts.renamed.length+c.customers.renamed.length+c.vendors.renamed.length,0)}:candidateMap(diff);
    const artifacts={'diff.json':JSON.stringify(data,null,2)+'\n','report.md':renderReport(diff,{countsOnly}),
      'rename-map.candidate.json':JSON.stringify(candidates,null,2)+'\n'};
    for (const [file,content] of Object.entries(artifacts)) await io.writeFile(join(stage,file),content,{flag:'wx',mode:0o600});
    await absent(); await io.rename(stage,out); stage=null;
  } catch (e) {
    if(e instanceof ReferenceRefusal)throw e;
    throw new ReferenceRefusal('report publication failed');
  } finally {
    // Only remove the unique directory created by this invocation, inside the
    // explicitly requested output parent. Never delete the destination on failure.
    if (stage && dirname(resolve(stage))===parent && basename(stage).startsWith(prefix)) await io.rm(stage,{recursive:true,force:true});
    if (handle) {await handle.close();await io.unlink(lock);}
  }
}
