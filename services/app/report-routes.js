import { HttpError } from './http.js';
import { reportByKey } from '../../lib/reports/registry.js';
import { buildReport, renderReport, getEntity } from '../../lib/reports/run.js';
import { reportsListPage, reportPage, customReportsPage, savedReportForm } from '../../lib/views/reports.js';
import { EMAIL, ValidationError } from '../../lib/data/writes.js';
import {
  userKey, listSaved, getSaved, createSaved, updateSaved, updateSavedQuery, deleteSaved, defaultQuery, setDefault, cleanQuery,
} from '../../lib/reports/saved.js';

// Favorites and default settings are per person; notes are per company and report; saved reports are private or shared.

async function favoritesOf(pool, scope, who) {
  const { rows } = await pool.query('SELECT report_key FROM report_favorite WHERE org_id = $1 AND entity_id = $2 AND user_key = $3',
    [scope.orgId, scope.entityId, userKey(who)]);
  return new Set(rows.map(r => r.report_key));
}
const FORMATS = ['csv', 'xlsx', 'pdf'];

// /reports (list), /reports/custom (saved reports), /reports/saved/<id>, /reports/r/<key> (a report; .xlsx/.csv/.pdf to
// export it; /note, /email, /save, /default to act on it) and /reports/favorite.
export async function reportRoutes(h) {
  const { req, res, path, query, form, scope, pool, page, base, go, takeFlash, who, ctx, send, extra, actor, companyMailer, attempt } = h;
  if (!path.startsWith('/reports')) return false;
  const tryOr = async (fn, onError) => {
    try { await fn(); } catch (error) { if (!(error instanceof ValidationError)) throw error; await onError(error.message); }
    return true;
  };

  if (path === '/reports' && req.method === 'GET') {
    page(reportsListPage({ ...base(), flash: takeFlash(), favorites: await favoritesOf(pool, scope, who), q: String(query.q ?? '').slice(0, 100),
      saved: await listSaved(pool, { ...scope, who }) }));
    return true;
  }

  if (path === '/reports/favorite' && req.method === 'POST') {
    const key = form.get('key') ?? '';
    if (!reportByKey(key)) throw new HttpError(404, 'Report not found');
    const del = await pool.query('DELETE FROM report_favorite WHERE org_id = $1 AND entity_id = $2 AND user_key = $3 AND report_key = $4',
      [scope.orgId, scope.entityId, userKey(who), key]);
    if (!del.rowCount) {
      await pool.query('INSERT INTO report_favorite (org_id, entity_id, user_key, report_key) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [scope.orgId, scope.entityId, userKey(who), key]);
    }
    const next = form.get('next') ?? '';
    go(/^\/reports(\/r\/[a-z0-9_]+)?(\?[\w\-.=&%,+]*)?$/.test(next) ? next : '/reports');
    return true;
  }

  // ---- saved (custom) reports ----
  if (path === '/reports/custom' && req.method === 'GET') {
    page(customReportsPage({ ...base(), flash: takeFlash(), saved: await listSaved(pool, { ...scope, who }) }));
    return true;
  }
  let m = /^\/reports\/saved\/(\d{1,18})(\/edit|\/delete)?$/.exec(path);
  if (m) {
    const savedId = Number(m[1]);
    const s = await getSaved(pool, { ...scope, savedId, who });
    if (!s) throw new HttpError(404, 'Saved report not found');
    if (req.method === 'GET' && !m[2]) { go(`/reports/r/${s.report_key}?${s.query}${s.query ? '&' : ''}saved=${s.saved_id}`); return true; }
    if (req.method === 'GET' && m[2] === '/edit') { page(savedReportForm({ ...base(), saved: s, v: null })); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (m[2] === '/delete') return tryOr(async () => { await deleteSaved(pool, { ...scope, savedId, who }); go('/reports/custom', 'ok', `“${s.name}” deleted.`); },
      message => go('/reports/custom', 'error', message));
    const freqIn = form.get('freq') ?? 'none';
    const v = { name: form.get('name') ?? '', shared: form.get('shared') === '1', group: form.get('group') ?? '', freq: freqIn,
      day: form.get('day') ?? (freqIn === 'weekly' ? form.get('day_week') : form.get('day_month')) ?? '1', to: form.get('to') ?? '', format: form.get('format') ?? 'pdf' };
    return tryOr(async () => { await updateSaved(pool, { ...scope, savedId, fields: v, who, today: ctx.today }); go('/reports/custom', 'ok', `“${v.name.trim()}” saved.`); },
      async error => page(savedReportForm({ ...base(), saved: s, v, error }), 422));
  }

  m = /^\/reports\/r\/([a-z0-9_]{1,60})(?:\.(xlsx|csv|pdf)|\/(note|email|save|default))?$/.exec(path);
  if (!m) return false;
  const def = reportByKey(m[1]);
  if (!def) throw new HttpError(404, 'Report not found');
  if ((req.method === 'POST') !== Boolean(m[3])) throw new HttpError(405, 'Method not allowed');
  // POSTs carry the report's options in `q` so they come back to (or email, or save) the same view.
  const q = m[3] ? cleanQuery(form.get('q') ?? '') : null;
  const back = `/reports/r/${def.key}${q ? `?${q}` : ''}`;

  if (m[3] === 'note') {
    const text = String(form.get('note') ?? '').trim().slice(0, 2000);
    if (text) {
      await pool.query(`INSERT INTO report_note (org_id, entity_id, report_key, note, updated_by) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (org_id, entity_id, report_key) DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [scope.orgId, scope.entityId, def.key, text, actor]);
    } else await pool.query('DELETE FROM report_note WHERE org_id = $1 AND entity_id = $2 AND report_key = $3', [scope.orgId, scope.entityId, def.key]);
    go(back, 'ok', text ? 'Note saved.' : 'Note removed.');
    return true;
  }
  if (m[3] === 'save') {
    const savedId = Number(form.get('saved_id') || 0);
    return tryOr(async () => {
      if (savedId && form.get('mode') === 'update') {
        const s = await updateSavedQuery(pool, { ...scope, savedId, query: q, who });
        go(`/reports/r/${def.key}?${q}${q ? '&' : ''}saved=${savedId}`, 'ok', `“${s.name}” updated with these settings.`);
      } else {
        const id = await createSaved(pool, { ...scope, reportKey: def.key, fields: { name: form.get('name'), shared: form.get('shared') === '1', group: form.get('group'), query: q }, who });
        go(`/reports/r/${def.key}?${q}${q ? '&' : ''}saved=${id}`, 'ok', 'Saved. Find it under Reports → Custom reports.');
      }
    }, message => go(back, 'error', message));
  }
  if (m[3] === 'default') {
    const scopeKind = form.get('scope') === 'all' ? 'all' : 'this';
    await setDefault(pool, { ...scope, who, reportKey: def.key, query: q, scope: scopeKind, clear: form.get('clear') === '1' });
    go(back, 'ok', form.get('clear') === '1' ? 'Back to the standard settings.' : scopeKind === 'all' ? 'These number, header and style settings now apply to every report you open.'
      : `This report now opens with these settings.`);
    return true;
  }

  // Opened fresh (not from its own options form): start from this person's defaults, then what the link asks for.
  let opts = q !== null ? Object.fromEntries(new URLSearchParams(q)) : query;
  if (q === null && query.run !== '1') opts = { ...(await defaultQuery(pool, { ...scope, who, reportKey: def.key })), ...query };
  const savedNow = query.saved && /^\d{1,18}$/.test(query.saved) ? await getSaved(pool, { ...scope, savedId: Number(query.saved), who }) : null;
  const [{ report, accounts, note }, entity] = await Promise.all([
    buildReport(pool, { ...scope, key: def.key, query: opts, today: ctx.today, timeZone: ctx.timeZone, maxYears: h.reportYears ?? null }), getEntity(pool, scope)]);
  const generatedAt = new Date().toLocaleString('en-US', { timeZone: ctx.timeZone, dateStyle: 'medium', timeStyle: 'short' });
  const show = async (more = {}, status = 200) => page(reportPage({ ...base(), flash: takeFlash(), report, accounts, note, saved: savedNow,
    favorite: (await favoritesOf(pool, scope, who)).has(def.key), canFavorite: true, canEdit: who.role !== 'reports', generatedAt, ...more }), status);

  if (m[3] === 'email') {
    const format = FORMATS.includes(form.get('format')) ? form.get('format') : 'pdf';
    const email = { to: String(form.get('to') ?? '').trim().slice(0, 500), subject: String(form.get('subject') ?? '').trim().slice(0, 200) || report.title,
      message: String(form.get('message') ?? '').slice(0, 5000), format };
    const list = email.to.split(/[,;\s]+/).filter(Boolean);
    if (!list.length || list.length > 20 || !list.every(a => EMAIL.test(a))) return show({ email: { ...email, error: 'Enter one or more email addresses, separated by commas.' } }, 422), true;
    const ready = await attempt(back, companyMailer);
    if (!ready.ok) return true;
    const file = await renderReport(report, entity, format);
    try {
      const { status } = await ready.value.send({ to: list.join(', '), subject: email.subject, text: email.message,
        attachments: [{ filename: file.filename, content: file.body, contentType: file.type }] });
      go(back, 'ok', status === 'sent' ? `${report.title} emailed to ${list.join(', ')}.`
        : `${report.title} recorded as sent. Email isn’t set up yet (Settings → Email), so nothing actually went out.`);
    } catch (error) {
      go(back, 'error', `The email failed: ${error.message}`);
    }
    return true;
  }

  if (m[2]) {
    const file = await renderReport(report, entity, m[2]);
    send(res, 200, file.body, { ...extra, 'Content-Type': file.type, 'Content-Disposition': `${m[2] === 'pdf' ? 'inline' : 'attachment'}; filename="${file.filename}"` });
    return true;
  }
  await show();
  return true;
}
