// Compare two frozen importer-built references. URL contents never reach diagnostics.
// Usage: node scripts/ref-diff.mjs <before url file> <after url file> --out <new directory> [--counts-only]
import { parseArgs } from 'node:util';
import { readReference, ReferenceRefusal } from '../lib/refdiff/snapshot.js';
import { compareReferences } from '../lib/refdiff/compare.js';
import { writeArtifacts } from '../lib/refdiff/report.js';

let args;
try {
  args=parseArgs({allowPositionals:true,options:{out:{type:'string'},'counts-only':{type:'boolean'}}});
  if (args.positionals.length!==2 || !args.values.out || process.argv.slice(2).filter(x=>x==='--out'||x.startsWith('--out=')).length!==1
    || args.positionals.some(s=>!s||/^[a-z][a-z0-9+.-]*:\/\//i.test(s))) throw new Error('usage');
} catch {
  console.error('usage: ref-diff <before url file> <after url file> --out <new directory> [--counts-only]');
  process.exit(2);
}
try {
  const results=await Promise.allSettled(args.positionals.map(readReference));
  const failures=results.flatMap((r,i)=>r.status==='rejected'
    ?[`source ${i?'b':'a'}: ${r.reason instanceof ReferenceRefusal?r.reason.message:'read failed'}`]:[]);
  if (failures.length) throw new ReferenceRefusal(failures.join('; '));
  const [a,b]=results.map(r=>r.value);
  const diff=compareReferences(a,b);
  await writeArtifacts(args.values.out,diff,undefined,{countsOnly:args.values['counts-only']});
  console.log(`reference diff complete: ${diff.companies.length} companies`);
} catch (e) {
  console.error(`ref-diff: ${e instanceof ReferenceRefusal?e.message:'operation failed'}`);
  process.exitCode=1;
}
