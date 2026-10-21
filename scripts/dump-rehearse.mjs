// Restore only into a newly generated local throwaway database; write a receipt
// beside the archive only after full decoding, restore, counts and successful drop.
import pg from 'pg';
import { refuseDemoDatabase } from '../lib/data/demo.js';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fingerprint, pgRestore, decodePayload, restoreDump, tableCounts, quote } from '../lib/rebuild/dump.js';

const [dump, adminFile, ...extra] = process.argv.slice(2);
if (!dump || !adminFile || extra.length) {
  console.error('usage: dump-rehearse <dump> <local admin url file>');
  process.exit(2);
}
let admin, restored, created = false;
const name = `fb_test_${randomBytes(12).toString('hex')}`;
try {
  const url = new URL((await readFile(adminFile,'utf8')).trim());
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    || url.pathname !== '/postgres' || url.search) throw new Error('rehearsal requires a local admin URL for the postgres maintenance database without query overrides');
  admin = new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000});
  await admin.connect();
  await refuseDemoDatabase(admin);
  const before = await fingerprint(dump);
  let toc;
  try { ({stdout:toc} = await pgRestore(['-l',dump])); }
  catch { throw new Error('pg_restore could not read the dump archive.'); }
  const database = toc.match(/^;\s+dbname:\s+(.+)$/m)?.[1].trim();
  if (!database) throw new Error('dump archive has no database identity');
  await decodePayload(dump);
  await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`);
  created = true;
  url.pathname = `/${name}`;
  const serverVersion = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
  try { await restoreDump(dump,url.toString(),serverVersion,`${dump}.${name}.sql`); }
  catch { throw new Error('pg_restore failed the throwaway restore rehearsal.'); }
  restored = new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000});
  await restored.connect();
  await refuseDemoDatabase(restored);
  const counts = await tableCounts(restored);
  await restored.end(); restored = null;
  await admin.query(`DROP DATABASE ${quote(name)}`); created = false;
  if (!isDeepStrictEqual(before,await fingerprint(dump))) throw new Error('dump bytes changed during rehearsal');
  const receipt = {version:1,tool:'dump-rehearse',...before,database,rehearsalDatabase:name,
    rehearsedAt:new Date().toISOString(),tableCounts:counts};
  await writeFile(dump+'.receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log(`rehearsed; receipt: ${dump}.receipt.json`);
} catch (error) {
  console.error(`dump-rehearse: ${error.code ? `operation failed (${error.code})` : error.message}`);
  process.exitCode = 1;
} finally {
  if (restored) await restored.end();
  if (admin) {
    try { if (created) await admin.query(`DROP DATABASE ${quote(name)} WITH (FORCE)`); }
    catch { console.error(`dump-rehearse: could not drop throwaway ${name}`); process.exitCode = 1; }
    await admin.end();
  }
}
