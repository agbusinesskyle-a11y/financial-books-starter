import { streamZip } from '../../lib/zip.js';
import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { previewImport, runImport } from '../../lib/data/imports.js';
import { exportWorkbook, documentFiles, listAllDocuments, listAllRecurring } from '../../lib/data/tools.js';
import {
  listBudgets, getBudget, createBudget, budgetAmounts, saveBudgetAmounts, deleteBudget, budgetAccounts, actuals, dimChoices,
} from '../../lib/data/budgets.js';
import { getAccountingSettings } from '../../lib/data/accounting.js';
import {
  importChooser, importPage, exportPage, allRecurringPage, allAttachmentsPage, budgetsPage, newBudgetPage, budgetGrid,
} from '../../lib/views/tools.js';

export const IMPORT_UPLOAD_PATH = /^\/import\/(customers|items|accounts)$/;

// Tools: import, export, all recurring, all attachments, budgets. h: the request helpers from index.js.
export async function toolsRoutes(h) {
  const { req, res, path, query, form, files, ctx, scope, pool, page, base, go, takeFlash, actor, send, extra } = h;
  let m;

  if (path === '/import' && req.method === 'GET') { page(importChooser(base())); return true; }
  m = IMPORT_UPLOAD_PATH.exec(path);
  if (m) {
    const kind = m[1];
    if (req.method === 'GET') { page(importPage({ ...base(), kind })); return true; }
    const upload = files.find(f => f.field === 'file' && f.data.length);
    const csv = upload ? upload.data.toString('utf8') : String(form.get('csv') ?? '');
    if (csv.length > 2_000_000) throw new HttpError(413, 'That file is too large to import.');
    try {
      if (form.get('step') === 'import') {
        const { created, skipped } = await runImport(pool, { ...scope, kind, csv, actor });
        go(kind === 'customers' ? '/customers' : kind === 'items' ? '/settings/items' : '/settings/accounts', 'ok',
          `${created} imported${skipped ? `; ${skipped} row${skipped === 1 ? '' : 's'} skipped` : ''}.`);
        return true;
      }
      if (!csv.trim()) throw new ValidationError('Choose a CSV file or paste the rows.');
      page(importPage({ ...base(), kind, csv, preview: await previewImport(pool, { ...scope, kind, csv }) }));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      page(importPage({ ...base(), kind, csv, error: error.message }), 422);
    }
    return true;
  }

  if (path === '/export' && req.method === 'GET') {
    const { rows: [d] } = await pool.query(
      `SELECT count(*)::int AS n FROM document d LEFT JOIN customer c ON c.customer_id = d.customer_id LEFT JOIN vendor v ON v.vendor_id = d.vendor_id
        WHERE d.org_id = $1 AND coalesce(c.entity_id, v.entity_id) = $2`, [ctx.orgId, ctx.entityId]);
    page(exportPage({ ...base(), documentCount: d.n }));
    return true;
  }
  if (path === '/export/books.xlsx' && req.method === 'GET') {
    send(res, 200, await exportWorkbook(pool, scope), { ...extra, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="financial-books-${ctx.today}.xlsx"` });
    return true;
  }
  if (path === '/export/documents.zip' && req.method === 'GET') {
    // Streamed: one file at a time, compressed off the main thread.
    res.writeHead(200, { ...extra, 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="attachments-${ctx.today}.zip"`, 'Cache-Control': 'no-store' });
    try {
      await streamZip(res, documentFiles(pool, scope));
    } catch (error) {
      if (!res.destroyed) res.destroy(error); // headers are gone; a cancelled download just stops
    }
    return true;
  }

  if (path === '/all-recurring' && req.method === 'GET') { page(allRecurringPage({ ...base(), templates: await listAllRecurring(pool, scope) })); return true; }
  if (path === '/attachments' && req.method === 'GET') {
    const filters = { q: String(query.q ?? '').slice(0, 100), party: ['customers', 'vendors'].includes(query.party) ? query.party : '' };
    page(allAttachmentsPage({ ...base(), filters, timeZone: ctx.timeZone, documents: await listAllDocuments(pool, { ...scope, ...filters }) }));
    return true;
  }

  // ---- budgets ----
  if (path === '/budgets' && req.method === 'GET') { page(budgetsPage({ ...base(), flash: takeFlash(), budgets: await listBudgets(pool, scope) })); return true; }
  if ((path === '/budgets/new' && req.method === 'GET') || (path === '/budgets' && req.method === 'POST')) {
    const budgets = await listBudgets(pool, scope);
    const { fiscalStartMonth } = await getAccountingSettings(pool, scope);
    const thisFy = Number(ctx.today.slice(0, 4)) + (fiscalStartMonth > 1 && Number(ctx.today.slice(5, 7)) >= fiscalStartMonth ? 1 : 0);
    if (req.method === 'GET') { page(newBudgetPage({ ...base(), budgets, v: { name: '', fiscalYear: String(thisFy + 1), subdivide: 'none', startFrom: 'actuals' } })); return true; }
    const v = { name: form.get('name') ?? '', fiscalYear: form.get('fiscalYear') ?? '', subdivide: form.get('subdivide') ?? 'none', startFrom: form.get('startFrom') ?? 'blank' };
    try {
      const id = await createBudget(pool, { ...scope, fields: v, actor });
      go(`/budgets/${id}`, 'ok', 'Budget created.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      page(newBudgetPage({ ...base(), budgets, v, error: error.message }), 422);
    }
    return true;
  }
  m = /^\/budgets\/(\d{1,18})(\/delete)?$/.exec(path);
  if (m) {
    const budget = await getBudget(pool, { ...scope, budgetId: Number(m[1]) });
    if (!budget) throw new HttpError(404, 'Budget not found');
    if (m[2]) {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      await deleteBudget(pool, { ...scope, budgetId: budget.budget_id });
      go('/budgets', 'ok', `“${budget.name}” deleted.`);
      return true;
    }
    const dimId = /^\d{1,18}$/.test(query.dim ?? '') ? Number(query.dim) : 0;
    const show = async (error = null, status = 200, typed = null) => {
      const [accounts, amounts, dims, act] = await Promise.all([budgetAccounts(pool, scope), budgetAmounts(pool, { budgetId: budget.budget_id, dimId }),
        dimChoices(pool, { ...scope, subdivide: budget.subdivide }),
        query.actuals === '1' ? actuals(pool, { ...scope, budget, dimId: dimId || null }) : null]);
      page(budgetGrid({ ...base(), flash: error ? null : takeFlash(), budget, accounts, amounts, actual: act, dims, dimId, error, typed }), status);
    };
    if (req.method === 'GET') { await show(); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const cells = {};
    for (const [k, val] of form) { const c = /^c_(\d{1,18})_(\d{1,2})$/.exec(k); if (c) cells[`${c[1]}:${c[2]}`] = val; }
    try {
      await saveBudgetAmounts(pool, { ...scope, budgetId: budget.budget_id, dimId, cells });
      go(`/budgets/${budget.budget_id}${dimId || query.actuals ? `?${new URLSearchParams({ ...(dimId ? { dim: String(dimId) } : {}), ...(query.actuals ? { actuals: '1' } : {}) })}` : ''}`, 'ok', 'Budget saved.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await show(error.message, 422, cells);
    }
    return true;
  }
  return false;
}

