import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { listEntries, getEntry, saveEntry, deleteEntry, saveWeek, weekStart } from '../../lib/data/time.js';
import { addDays, isIsoDate } from '../../lib/domain/dates.js';
import { timePage, entryPage, entryToValues, timesheetPage } from '../../lib/views/time.js';

// Time tracking. Everyone can keep their own time; admins and standard users see everyone's. h: request helpers from index.js.
export async function timeRoutes(h) {
  const { req, path, query, form, ctx, scope, pool, page, base, go, takeFlash, who } = h;
  if (!/^\/time(\/|$)/.test(path)) return false;
  const canSeeAll = who.role === 'admin' || who.role === 'standard';
  // Active customers, open projects and services — plus whatever the entries on screen already use, so nothing is dropped.
  const lists = async (entries = []) => {
    const custs = entries.map(e => e.customer_id).filter(Boolean), projs = entries.map(e => e.project_id).filter(Boolean), its = entries.map(e => e.item_id).filter(Boolean);
    const [jobs, items] = await Promise.all([
      pool.query(`SELECT 'c:' || c.customer_id AS value, c.display_name AS label, lower(c.display_name) AS k FROM customer c
                   WHERE c.org_id = $1 AND c.entity_id = $2 AND (c.active OR c.customer_id = ANY($3::bigint[]))
                  UNION ALL
                  SELECT 'p:' || p.project_id, c.display_name || ' › ' || p.name, lower(c.display_name) || ' ' || lower(p.name) FROM project p
                    JOIN customer c ON c.customer_id = p.customer_id
                   WHERE p.org_id = $1 AND c.entity_id = $2 AND (p.status = 'in_progress' OR p.project_id = ANY($4::bigint[])) ORDER BY 3`, [ctx.orgId, ctx.entityId, custs, projs]),
      pool.query(`SELECT item_id, name FROM item WHERE org_id = $1 AND entity_id = $2 AND ((active AND kind IN ('service', 'product')) OR item_id = ANY($3::bigint[])) ORDER BY name`,
        [ctx.orgId, ctx.entityId, its])]);
    return { jobs: jobs.rows, items: items.rows };
  };
  const day = isIsoDate(query.date ?? '') ? query.date : ctx.today;
  const monday = weekStart(day);
  const everyone = canSeeAll && query.who === 'all';
  const entryValues = f => ({ date: f.get('date') ?? '', job: f.get('job') ?? '', itemId: f.get('item_id') ?? '', hours: f.get('hours') ?? '',
    billable: f.get('billable') === '1', notes: f.get('notes') ?? '' });
  const showWeek = async (v, error = null, status = 200) => {
    const entries = await listEntries(pool, { ...scope, who, from: monday, to: addDays(monday, 6), everyone });
    page(timePage({ ...base(), flash: error ? null : takeFlash(), monday, everyone, canSeeAll, v, error, entries, ...(await lists(entries)) }), status);
  };

  if (path === '/time' && req.method === 'GET') {
    await showWeek({ date: day, job: '', itemId: '', hours: '', billable: false, notes: '' });
    return true;
  }
  if (path === '/time' && req.method === 'POST') {
    const v = entryValues(form);
    try {
      await saveEntry(pool, { ...scope, who, fields: v });
      go(`/time?date=${v.date}`, 'ok', 'Time added.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await showWeek(v, error.message, 422);
    }
    return true;
  }
  if (path === '/time/week') {
    // typed: the posted rows, shown again as typed when saving fails.
    const showSheet = async (mon, error = null, status = 200, typed = null) => {
      const entries = await listEntries(pool, { ...scope, who, from: mon, to: addDays(mon, 6) });
      page(timesheetPage({ ...base(), flash: error ? null : takeFlash(), monday: mon, error, entries, typed, ...(await lists(entries)) }), status);
    };
    if (req.method === 'GET') { await showSheet(monday); return true; }
    const mon = String(form.get('monday') ?? '');
    const all = k => form.getAll(k);
    const rows = all('ts_job').map((job, i) => ({ job, itemId: all('ts_item')[i] ?? '', billable: all('ts_billable')[i] === '1',
      hours: Array.from({ length: 7 }, (_, d) => all(`ts_d${d}`)[i] ?? '') })).slice(0, 100);
    try {
      const n = await saveWeek(pool, { ...scope, who, monday: mon, rows });
      go(`/time/week?date=${mon}`, 'ok', `Timesheet saved (${n} entr${n === 1 ? 'y' : 'ies'}).`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await showSheet(isIsoDate(mon) ? weekStart(mon) : monday, error.message, 422, rows);
    }
    return true;
  }
  const m = /^\/time\/(\d{1,18})(\/delete)?$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const entry = await getEntry(pool, { ...scope, entryId: Number(m[1]) });
  const own = entry && (who.userId ? entry.user_id === who.userId : entry.user_id === null && entry.person === who.name);
  if (!entry || (!canSeeAll && !own)) throw new HttpError(404, 'Time entry not found');
  if (req.method === 'GET' && !m[2]) { page(entryPage({ ...base(), entry, v: entryToValues(entry), ...(await lists([entry])) })); return true; }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  try {
    if (m[2]) {
      await deleteEntry(pool, { ...scope, entryId: entry.entry_id, who });
      go(`/time?date=${entry.entry_date}`, 'ok', 'Time entry deleted.');
    } else {
      const v = entryValues(form);
      await saveEntry(pool, { ...scope, entryId: entry.entry_id, who, fields: v });
      go(`/time?date=${v.date}`, 'ok', 'Time entry saved.');
    }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    page(entryPage({ ...base(), entry, v: m[2] ? entryToValues(entry) : entryValues(form), error: error.message, ...(await lists([entry])) }), 422);
  }
  return true;
}
