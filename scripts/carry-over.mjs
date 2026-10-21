// Save a copy's practice-only state by natural keys, or re-apply it to rebuilt books.
// Usage: node --env-file=.env scripts/carry-over.mjs save <out.json> [--org <slug>]
//        node --env-file=.env scripts/carry-over.mjs apply <in.json> --phase books|links|feeds [--apply] [--wait-minutes N] [--actor "<name>"] [--org <slug>]
//        node --env-file=.env scripts/carry-over.mjs report <in.json> [--org <slug>]
// --org or APP_ORG is required. Apply defaults to a dry run. Keep ciphertext files outside the repo.
import { open, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createPool } from '../lib/db.js';
import { refuseDemoDatabase } from '../lib/data/demo.js';
import { saveCarryOver, applyCarryOver, carryOverReport } from '../lib/rebuild/carry-over.js';

let command, file, options, orgSlug, waitMinutes;
try {
  const parsed = parseArgs({ allowPositionals: true, options: {
    org: { type: 'string' }, phase: { type: 'string' }, apply: { type: 'boolean' },
    'wait-minutes': { type: 'string' }, actor: { type: 'string' },
  } });
  [command, file] = parsed.positionals;
  options = parsed.values;
  orgSlug = (options.org ?? process.env.APP_ORG ?? '').trim();
  waitMinutes = Number(options['wait-minutes'] ?? 20);
  if (parsed.positionals.length !== 2 || !['save', 'apply', 'report'].includes(command) || !file || !orgSlug
    || !Number.isFinite(waitMinutes) || waitMinutes < 0 || options['wait-minutes'] === ''
    || (command === 'apply' ? !['books', 'links', 'feeds'].includes(options.phase)
      : ['phase', 'apply', 'wait-minutes', 'actor'].some(k => k in options))) throw new Error('usage');
} catch {
  console.error('usage: carry-over save <out.json> | apply <in.json> --phase books|links|feeds [--apply] [--wait-minutes N] [--actor "<name>"] | report <in.json>; --org <slug> or APP_ORG is required');
  process.exit(2);
}

let pool;
try {
  pool = createPool();
  await refuseDemoDatabase(pool);
  let data;
  if (command === 'save') {
    data = await saveCarryOver(pool, { orgSlug });
    const handle = await open(file, 'w', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
    } finally { await handle.close(); }
  } else {
    const content = await readFile(file, 'utf8');
    try { data = JSON.parse(content); } catch { throw new Error('Could not parse carry-over JSON.'); }
    if (data?.orgSlug !== orgSlug) throw new Error(`carry-over is for org “${data?.orgSlug}”, not “${orgSlug}”.`);
  }
  if (command === 'apply') {
    data = await applyCarryOver(pool, { data, phase: options.phase, actor: options.actor ?? 'carry-over',
      env: process.env, dryRun: !options.apply, waitMinutes });
    if (!options.apply) console.log('Dry run — read-only plan; writer validation occurs with --apply.');
  }
  console.log(JSON.stringify(carryOverReport(data), null, 2));
} catch (error) {
  const message = error.message.replaceAll(process.env.DATABASE_URL || '\0', '<database URL>');
  console.error(`carry-over: ${message}`);
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
