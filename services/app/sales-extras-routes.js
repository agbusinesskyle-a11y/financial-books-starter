import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { getTransaction } from '../../lib/data/transactions.js';
import { previewTransactionEmail, salesQueue, clearQueued, sendTransaction, transactionsPdf } from '../../lib/data/messages.js';
import { getPaymentsSettings } from '../../lib/data/online-payments.js';
import { previewPage, payorPreview, queuePage } from '../../lib/views/sales-extras.js';

// Stage F4: /txns/:id/preview?view=email|payor and the Print later / Send later queue at /sales-queue.
export async function salesExtrasRoutes(h) {
  const { req, res, path, query, form, pool, page, base, go, takeFlash, ctx, scope, actor, send, extra, companyMailer, attempt, appOrigin } = h;
  const pv = /^\/txns\/(\d{1,18})\/preview$/.exec(path);
  if (pv) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const t = await getTransaction(pool, { orgId: ctx.orgId, id: Number(pv[1]) });
    if (!t || t.entity_id !== ctx.entityId || !['invoice', 'late_fee', 'sales_receipt', 'credit_memo', 'estimate', 'payment'].includes(t.type)) throw new HttpError(404, 'Transaction not found');
    const view = query.view === 'payor' && ['invoice', 'late_fee'].includes(t.type) ? 'payor' : 'email';
    if (view === 'payor') {
      page(previewPage({ ...base(), txn: t, view, payor: payorPreview({ txn: t, entityName: ctx.entityName, settings: await getPaymentsSettings(pool, scope) }) }));
    } else {
      page(previewPage({ ...base(), txn: t, view, email: await previewTransactionEmail(pool, { ...scope, txnId: t.txn_id }) }));
    }
    return true;
  }
  const q = /^\/sales-queue(?:\/(print|send))?$/.exec(path);
  if (!q) return false;
  if (!q[1]) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const which = query.which === 'send' ? 'send' : 'print';
    const [print, sendRows] = await Promise.all([salesQueue(pool, { ...scope, which: 'print' }), salesQueue(pool, { ...scope, which: 'send' })]);
    page(queuePage({ ...base(), flash: takeFlash(), which, rows: which === 'send' ? sendRows : print, counts: { print: print.length, send: sendRows.length } }));
    return true;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const queued = new Set((await salesQueue(pool, { ...scope, which: q[1] })).map(r => Number(r.txn_id)));
  // Each queued transaction once, and at most a batch's worth (h.batchMax) per request.
  const ids = [...new Set(form.getAll('ids').map(Number).filter(id => queued.has(id)))].slice(0, h.batchMax ?? 200);
  if (!ids.length) return go(`/sales-queue?which=${q[1]}`, 'error', 'Select at least one.') ?? true;
  if (q[1] === 'print') {
    const pdf = await transactionsPdf(pool, { ...scope, txnIds: ids });
    await clearQueued(pool, { ...scope, which: 'print', txnIds: ids });
    send(res, 200, pdf, { ...extra, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="print-later-${ctx.today}.pdf"` });
    return true;
  }
  const ready = await attempt('/sales-queue?which=send', companyMailer);
  if (!ready.ok) return true;
  const done = [], problems = [];
  for (const id of ids) {
    try {
      const status = await sendTransaction(pool, ready.value, { ...scope, txnId: id, actor, origin: appOrigin() });
      if (status === 'failed') problems.push(`#${id} couldn’t be sent`); else done.push(id);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      problems.push(error.message);
    }
  }
  if (done.length) await clearQueued(pool, { ...scope, which: 'send', txnIds: done });
  return go('/sales-queue?which=send', problems.length ? 'error' : 'ok', `${done.length} sent.${problems.length ? ` ${problems.join(' ')}` : ''}`) ?? true;
}
