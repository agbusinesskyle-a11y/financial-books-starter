import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { listSaved } from '../../lib/reports/saved.js';
import {
  TEMPLATES, listManagement, getManagement, createManagement, saveManagement, deleteManagement, managementPdf,
} from '../../lib/reports/management.js';
import { saveKpi, deleteKpi, BUILT_IN } from '../../lib/reports/kpis.js';
import { managementListPage, managementEditPage, kpiFormPage } from '../../lib/views/management.js';

// Reports → Management reports (/reports/management…) and custom KPIs (/reports/kpis…).
export async function mgmtRoutes(h) {
  const { req, res, path, form, scope, pool, page, base, go, takeFlash, who, ctx, send, extra, actor } = h;
  if (!path.startsWith('/reports/management') && !path.startsWith('/reports/kpis')) return false;
  const fail = async (fn, onError) => {
    try { await fn(); } catch (error) { if (!(error instanceof ValidationError)) throw error; await onError(error.message); }
    return true;
  };

  if (path === '/reports/management') {
    if (req.method === 'GET') { page(managementListPage({ ...base(), flash: takeFlash(), packages: await listManagement(pool, scope), templates: TEMPLATES })); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    return fail(async () => {
      const id = await createManagement(pool, { ...scope, template: form.get('template'), entityName: ctx.entityName, actor });
      go(`/reports/management/${id}`, 'ok', 'Management report created from the template. Choose the period and reports, then publish it.');
    }, message => go('/reports/management', 'error', message));
  }

  let m = /^\/reports\/management\/(\d{1,18})(\.pdf|\/delete)?$/.exec(path);
  if (m) {
    const mgmtId = Number(m[1]);
    const mg = await getManagement(pool, { ...scope, mgmtId });
    if (!mg) throw new HttpError(404, 'Management report not found');
    if (m[2] === '.pdf' && req.method === 'GET') {
      const pdf = await managementPdf(pool, { ...scope, mgmt: mg, today: ctx.today, timeZone: ctx.timeZone });
      send(res, 200, pdf.body, { ...extra, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${pdf.filename}"` });
      return true;
    }
    const savedReports = await listSaved(pool, { ...scope, who });
    if (req.method === 'GET' && !m[2]) { page(managementEditPage({ ...base(), flash: takeFlash(), mg, savedReports })); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (m[2] === '/delete') { await deleteManagement(pool, { ...scope, mgmtId }); go('/reports/management', 'ok', `“${mg.name}” deleted.`); return true; }
    // The section list, then the button that was pressed: add, remove, move up — or save.
    const all = k => form.getAll(k);
    let sections = all('sec_key').map((key, i) => ({ key, title: all('sec_title')[i] ?? '', query: all('sec_query')[i] ?? '', note: all('sec_note')[i] ?? '' }));
    const action = String(form.get('action') ?? 'save');
    let mm;
    if (action === 'add') {
      const pick = String(form.get('add_key') ?? '');
      const saved = /^saved:(\d+)$/.exec(pick);
      const s = saved ? savedReports.find(x => x.saved_id === Number(saved[1])) : null;
      if (s) sections.push({ key: s.report_key, title: s.name, query: s.query, note: '' });
      else if (pick) sections.push({ key: pick, title: '', query: '', note: '' });
    } else if ((mm = /^(remove|up):(\d+)$/.exec(action))) {
      const i = Number(mm[2]);
      if (mm[1] === 'remove') sections = sections.filter((_, k) => k !== i);
      else if (i > 0) [sections[i - 1], sections[i]] = [sections[i], sections[i - 1]];
    }
    const v = { name: form.get('name'), status: form.get('status'), period: form.get('period'), basis: form.get('basis'), coverTitle: form.get('cover_title'),
      coverSubtitle: form.get('cover_subtitle'), preparedBy: form.get('prepared_by'), intro: form.get('intro'), closing: form.get('closing'), sections,
      freq: form.get('freq'), day: form.get('day') ?? (form.get('freq') === 'weekly' ? form.get('day_week') : form.get('day_month')), to: form.get('to') };
    return fail(async () => {
      await saveManagement(pool, { ...scope, mgmtId, fields: v, today: ctx.today });
      go(`/reports/management/${mgmtId}`, 'ok', action === 'save' ? 'Saved.' : 'Sections updated.');
    }, async message => page(managementEditPage({ ...base(), mg: { ...mg, name: v.name, status: v.status, period: v.period, basis: v.basis, cover_title: v.coverTitle,
      cover_subtitle: v.coverSubtitle, prepared_by: v.preparedBy, intro: v.intro, closing: v.closing, sections, sched_freq: v.freq, sched_day: Number(v.day), sched_to: v.to },
    savedReports, error: message }), 422));
  }

  if (path === '/reports/kpis/new' && req.method === 'GET') { page(kpiFormPage({ ...base(), builtIn: BUILT_IN, v: {} })); return true; }
  if (path === '/reports/kpis' && req.method === 'POST') {
    const v = { name: form.get('name'), category: form.get('category'), description: form.get('description'), unit: form.get('unit'), direction: form.get('direction'),
      formula: form.get('formula') };
    return fail(async () => { await saveKpi(pool, { ...scope, fields: v, actor }); go('/reports/r/kpi_scorecard', 'ok', `KPI “${String(v.name).trim()}” added to the scorecard.`); },
      async message => page(kpiFormPage({ ...base(), builtIn: BUILT_IN, v, error: message }), 422));
  }
  m = /^\/reports\/kpis\/(\d{1,18})\/delete$/.exec(path);
  if (m && req.method === 'POST') { await deleteKpi(pool, { ...scope, kpiId: Number(m[1]) }); go('/reports/r/kpi_scorecard', 'ok', 'KPI removed.'); return true; }
  throw new HttpError(404, 'Not found');
}
