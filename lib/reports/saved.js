import { ValidationError } from '../data/writes.js';
import { EMAIL } from '../data/writes.js';
import { addDays } from '../domain/dates.js';
import { reportByKey } from './registry.js';
import { parseCustom, customQuery, LOOK_KEYS } from './customize.js';

// Saved (custom) reports: a report key plus its options query, private to the person who saved it or shared with
// everyone, optionally in a group and on an email schedule. And each person's default settings.

const fail = message => { throw new ValidationError(message); };
export const userKey = who => String(who.userId ?? 'owner');
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
// The options part of a query string, without bookkeeping parameters.
export const cleanQuery = q => {
  const p = new URLSearchParams(String(q ?? '').slice(0, 3000));
  for (const k of ['saved', 'csrf']) p.delete(k);
  return p.toString();
};
const canSee = (r, who) => r.shared || r.owner_key === userKey(who) || who.role === 'admin';
const canEdit = (r, who) => r.owner_key === userKey(who) || who.role === 'admin';

export async function listSaved(db, { orgId, entityId, who }) {
  const { rows } = await db.query('SELECT * FROM saved_report WHERE org_id = $1 AND entity_id = $2 ORDER BY lower(coalesce(group_name, \'\')), lower(name)', [orgId, entityId]);
  return rows.filter(r => canSee(r, who)).map(r => ({ ...r, editable: canEdit(r, who) }));
}

export async function getSaved(db, { orgId, entityId, savedId, who }) {
  const { rows: [r] } = await db.query('SELECT * FROM saved_report WHERE org_id = $1 AND entity_id = $2 AND saved_id = $3', [orgId, entityId, savedId]);
  return r && canSee(r, who) ? { ...r, editable: canEdit(r, who) } : null;
}

export async function createSaved(db, { orgId, entityId, reportKey, fields: f, who }) {
  if (!reportByKey(reportKey)) fail('That report doesn’t exist.');
  const name = text(f.name, 100) || fail('Give the report a name.');
  const { rows: [r] } = await db.query(
    `INSERT INTO saved_report (org_id, entity_id, report_key, name, query, owner_key, owner_name, shared, group_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING saved_id`,
    [orgId, entityId, reportKey, name, cleanQuery(f.query), userKey(who), who.name, f.shared === true, text(f.group, 60) || null]);
  return r.saved_id;
}

// The next send date after `after`: daily, weekly on `day` (0 = Sunday), monthly on day `day` (1–28).
export function nextRun(freq, day, after) {
  if (freq === 'none') return null;
  let d = addDays(after, 1);
  for (let i = 0; i < 40; i++, d = addDays(d, 1)) {
    const date = new Date(`${d}T00:00:00Z`);
    if (freq === 'daily' || (freq === 'weekly' && date.getUTCDay() === day) || (freq === 'monthly' && date.getUTCDate() === day)) return d;
  }
  return null;
}

// fields: name, shared, group, freq, day, to (addresses), format. today: the company's date (for the first send).
export async function updateSaved(db, { orgId, entityId, savedId, fields: f, who, today }) {
  const r = await getSaved(db, { orgId, entityId, savedId, who }) ?? fail('Saved report not found.');
  if (!r.editable) fail('Only the person who saved it (or an admin) can change it.');
  const name = text(f.name, 100) || fail('Give the report a name.');
  const freq = ['none', 'daily', 'weekly', 'monthly'].includes(f.freq) ? f.freq : 'none';
  if (freq !== 'none' && who.role === 'reports') fail('Reports-only people can’t email reports. Ask an admin to schedule it.');
  const day = Number.isInteger(Number(f.day)) ? Number(f.day) : 1;
  if (freq === 'weekly' && !(day >= 0 && day <= 6)) fail('Choose a day of the week.');
  if (freq === 'monthly' && !(day >= 1 && day <= 28)) fail('Choose a day of the month from 1 to 28.');
  const to = text(f.to, 1000).split(/[,;\s]+/).filter(Boolean);
  if (freq !== 'none' && (!to.length || to.length > 20 || !to.every(a => EMAIL.test(a)))) fail('Enter who to email it to (up to 20 addresses, separated by commas).');
  const format = ['pdf', 'xlsx', 'csv'].includes(f.format) ? f.format : 'pdf';
  const changedSchedule = freq !== r.sched_freq || day !== r.sched_day;
  await db.query(
    `UPDATE saved_report SET name = $3, shared = $4, group_name = $5, sched_freq = $6, sched_day = $7, sched_to = $8, sched_format = $9,
            sched_next = $10, updated_at = now() WHERE org_id = $1 AND saved_id = $2`,
    [orgId, savedId, name, f.shared === true, text(f.group, 60) || null, freq, freq === 'daily' ? 1 : day, to.join(', ') || null, format,
      freq === 'none' ? null : changedSchedule || !r.sched_next ? nextRun(freq, day, today) : r.sched_next]);
}

export async function updateSavedQuery(db, { orgId, entityId, savedId, query, who }) {
  const r = await getSaved(db, { orgId, entityId, savedId, who }) ?? fail('Saved report not found.');
  if (!r.editable) fail('Only the person who saved it (or an admin) can change it.');
  await db.query('UPDATE saved_report SET query = $3, updated_at = now() WHERE org_id = $1 AND saved_id = $2', [orgId, savedId, cleanQuery(query)]);
  return r;
}

export async function deleteSaved(db, { orgId, entityId, savedId, who }) {
  const r = await getSaved(db, { orgId, entityId, savedId, who }) ?? fail('Saved report not found.');
  if (!r.editable) fail('Only the person who saved it (or an admin) can delete it.');
  await db.query('DELETE FROM saved_report WHERE org_id = $1 AND saved_id = $2', [orgId, savedId]);
  return r;
}

// ---- defaults ----

// The query to start from when a report is opened fresh: the look saved "for all reports", then this report's own.
export async function defaultQuery(db, { orgId, entityId, who, reportKey }) {
  const { rows } = await db.query(`SELECT report_key, query FROM report_default WHERE org_id = $1 AND entity_id = $2 AND user_key = $3 AND report_key IN ('*', $4)`,
    [orgId, entityId, userKey(who), reportKey]);
  const all = rows.find(r => r.report_key === '*'), mine = rows.find(r => r.report_key === reportKey);
  return { ...Object.fromEntries(new URLSearchParams(all?.query ?? '')), ...Object.fromEntries(new URLSearchParams(mine?.query ?? '')) };
}

// scope: 'this' (all of this report's options) or 'all' (only the look, for every report); clear removes it.
export async function setDefault(db, { orgId, entityId, who, reportKey, query, scope, clear = false }) {
  const key = scope === 'all' ? '*' : reportKey;
  if (clear) {
    await db.query('DELETE FROM report_default WHERE org_id = $1 AND entity_id = $2 AND user_key = $3 AND report_key = $4', [orgId, entityId, userKey(who), key]);
    return;
  }
  let q = cleanQuery(query);
  if (scope === 'all') {
    const look = Object.fromEntries(Object.entries(parseCustom(Object.fromEntries(new URLSearchParams(q)))).filter(([k]) => LOOK_KEYS.includes(k)));
    q = new URLSearchParams(customQuery(look)).toString();
  }
  await db.query(`INSERT INTO report_default (org_id, entity_id, user_key, report_key, query) VALUES ($1, $2, $3, $4, $5)
                  ON CONFLICT (org_id, entity_id, user_key, report_key) DO UPDATE SET query = EXCLUDED.query`, [orgId, entityId, userKey(who), key, q]);
}
