import { readFile } from 'node:fs/promises';
import { createPool } from '../lib/db.js';
import { refuseDemoDatabase } from '../lib/data/demo.js';
import { setupIntegrationItems } from '../lib/integration/item-setup.js';

const args=process.argv.slice(2),options={};let usage=false;
for(let i=0;i<args.length;i++) {
  const key=args[i];
  if(!['--org','--company','--app-map','--approved-hash','--apply'].includes(key)||Object.hasOwn(options,key)){usage=true;break;}
  if(key==='--apply')options[key]=true;
  else if(!args[i+1]||args[i+1].startsWith('--')){usage=true;break;}
  else options[key]=args[++i];
}
if(usage||!options['--org']||!options['--company']||!options['--app-map']||
  (Boolean(options['--apply'])!==Boolean(options['--approved-hash']))) {
  console.error('Usage: setup-integration-items.mjs --org SLUG --company NAME --app-map FILE [--apply --approved-hash HASH]');
  process.exitCode=2;
} else {
  let pool;
  try {
    pool=createPool();
    await refuseDemoDatabase(pool);
    const catalog=JSON.parse(await readFile(options['--app-map'],'utf8'));
    const result=await setupIntegrationItems(pool,{orgSlug:options['--org'],companyName:options['--company'],catalog,
      apply:!!options['--apply'],approvedHash:options['--approved-hash'],actor:'Integration item setup'});
    console.log(options['--apply']?`created=${result.created} existing=${result.existing}`:
      `dry-run planned=${result.planned} existing=${result.existing} hash=${result.hash}`);
    console.log(JSON.stringify({destination:result.destination,accounts:result.accounts}));
  } catch {
    // Driver/file errors may contain connection strings or private catalog details.
    console.error('Item setup refused. Public demo mode and demo databases are unsupported. Check the manifest, destination, account mappings and approval hash. DATABASE_URL is required.');
    process.exitCode=1;
  } finally {if(pool)await pool.end();}
}
