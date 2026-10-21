import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { devNull } from 'node:os';
import { open, unlink } from 'node:fs/promises';

export const quote = name => '"' + name.replaceAll('"', '""') + '"';
export async function fingerprint(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(file)) { hash.update(bytes); size += bytes.length; }
  return { sha256: hash.digest('hex'), size };
}
export async function pgRestore(args) {
  return promisify(execFile)(process.env.PG_RESTORE || (process.platform === 'win32'
    ? 'C:/tools/pgsql18/bin/pg_restore.exe' : 'pg_restore'), args, { maxBuffer: 8 * 1024 * 1024 });
}
export async function decodePayload(file) {
  try { await pgRestore(['--data-only', '--file', devNull, file]); }
  catch { throw new Error('pg_restore could not fully decode the dump data payload.'); }
}

export async function restoreDump(file, url, serverVersion, temporarySql) {
  if (serverVersion >= 170000) return pgRestore(['--exit-on-error','--single-transaction','--no-owner','--no-privileges','--dbname',url,file]);
  // PG 18 clients emit this session setting even for archives from PG 16.
  // Only remove that exact prologue statement, never suppress restore errors.
  try {
    await pgRestore(['--no-owner','--no-privileges','--file',temporarySql,file]);
    const sql = await open(temporarySql,'r+');
    try {
      const header = Buffer.alloc(4096);
      const {bytesRead} = await sql.read(header,0,header.length,0);
      const prefix = header.subarray(0,bytesRead).toString('utf8');
      const statement = 'SET transaction_timeout = 0;';
      const offset = prefix.indexOf(statement), firstObject = prefix.indexOf('-- Name:');
      if (offset >= 0 && (firstObject < 0 || offset < firstObject)) {
        await sql.write(Buffer.from('--'+ ' '.repeat(statement.length-2)),0,statement.length,offset);
      }
    } finally { await sql.close(); }
    await promisify(execFile)(process.env.PSQL || (process.platform === 'win32'
      ? 'C:/tools/pgsql18/bin/psql.exe' : 'psql'),
    ['--no-psqlrc','--set=ON_ERROR_STOP=1','--single-transaction','--quiet','--dbname',url,'--file',temporarySql],
    {maxBuffer:8*1024*1024});
  } finally { await unlink(temporarySql).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function tableCounts(db) {
  const tables = (await db.query(`SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%'
    ORDER BY schemaname, tablename`)).rows;
  const counts = {};
  for (const { schemaname: schema, tablename: table } of tables) {
    counts[`${schema}.${table}`] = Number((await db.query(`SELECT count(*) AS n FROM ${quote(schema)}.${quote(table)}`)).rows[0].n);
  }
  return counts;
}
