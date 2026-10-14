import { HttpError } from './http.js';
import { anyTxn, transactionJournal, transactionHistory } from '../../lib/data/txn-extras.js';
import { transactionJournalPage, transactionHistoryPage } from '../../lib/views/txn-extras.js';

// Forms, stage F2: /transactions/:id/journal and /transactions/:id/history for any saved transaction of this company.
export async function txnExtrasRoutes(h) {
  const { req, path, pool, page, base, ctx, scope } = h;
  const m = /^\/transactions\/(\d{1,18})\/(journal|history)$/.exec(path);
  if (!m) return false;
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const t = await anyTxn(pool, { ...scope, txnId: m[1] });
  if (!t) throw new HttpError(404, 'Transaction not found');
  if (m[2] === 'journal') page(transactionJournalPage({ ...base(), txn: t, journal: await transactionJournal(pool, { orgId: ctx.orgId, txnId: t.txn_id }), timeZone: ctx.timeZone }));
  else page(transactionHistoryPage({ ...base(), txn: t, history: await transactionHistory(pool, { orgId: ctx.orgId, txnId: t.txn_id }), timeZone: ctx.timeZone }));
  return true;
}
