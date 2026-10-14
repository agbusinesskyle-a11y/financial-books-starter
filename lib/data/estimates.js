import { ValidationError } from './writes.js';
import { centsToInput } from '../domain/money.js';

const fail = message => { throw new ValidationError(message); };

// Invoice editor values made from an estimate (nothing is saved until the invoice is).
// mode: 'full' — everything left on each line; 'percent' — that percent of each line (capped at what's left);
// 'lines' — what's left on each line, to edit by hand. Each invoice line remembers its estimate line.
export async function invoiceFromEstimate(pool, { orgId, estimate: e, mode, percent, today }) {
  if (e.voided_at || e.estimate_status === 'rejected' || e.estimate_status === 'closed') fail('This estimate is closed, rejected or voided, so it can’t be invoiced.');
  if (Number(e.currency ? e.foreign_open_cents : e.open_cents) <= 0) fail('Everything on this estimate has been invoiced.');
  let pct = 100;
  if (mode === 'percent') {
    pct = Number(String(percent ?? '').replace('%', ''));
    if (!(pct > 0 && pct <= 100)) fail('Enter a percent between 0 and 100, like 50.');
  } else if (mode !== 'full' && mode !== 'lines') fail('Choose how much to invoice.');
  const { rows } = await pool.query(
    `SELECT l.estimate_line_no AS line_no, sum(coalesce(l.foreign_amount_cents, l.amount_cents))::bigint AS invoiced FROM txn_line l JOIN txn i ON i.txn_id = l.txn_id
      WHERE l.org_id = $1 AND l.estimate_txn_id = $2 AND i.voided_at IS NULL AND i.type = 'invoice' GROUP BY l.estimate_line_no`, [orgId, e.txn_id]);
  const invoiced = new Map(rows.map(r => [r.line_no, Number(r.invoiced)]));
  const lines = [];
  const amt = l => Number(e.currency && l.foreign_amount_cents !== null ? l.foreign_amount_cents : l.amount_cents);
  const rateOf = l => Number(e.currency && l.foreign_rate_cents !== null ? l.foreign_rate_cents : l.rate_cents);
  for (const l of e.lines) {
    // Subtotal and text lines (stage F3) come along when the whole estimate is invoiced.
    if (l.kind === 'subtotal' || l.kind === 'text') {
      if (mode === 'full') lines.push({ kind: l.kind, itemId: '', description: l.description ?? '', quantity: '', rate: '', serviceDate: '', estimateLine: '' });
      continue;
    }
    const left = amt(l) - (invoiced.get(l.line_no) ?? 0);
    if (left <= 0) continue;
    const untouched = left === amt(l);
    if (mode === 'full' && untouched) {
      lines.push({ itemId: l.item_id ? String(l.item_id) : '', description: l.description ?? '', quantity: String(l.quantity), rate: centsToInput(rateOf(l)),
        serviceDate: '', estimateLine: String(l.line_no) });
      continue;
    }
    const amount = mode === 'percent' ? Math.min(left, Math.round(amt(l) * pct / 100)) : left;
    if (amount <= 0) continue;
    const note = mode === 'percent' ? ` (${pct}% of estimate ${e.doc_number})` : untouched ? '' : ` (rest of estimate ${e.doc_number})`;
    // A product or service line keeps its price and invoices that share of the quantity (so stock and quantity
    // reports move by the right amount, as QBO); only a line with no item or no price becomes one amount.
    const rate = rateOf(l);
    const byQty = l.item_id && rate > 0;
    const qty = byQty ? (Math.floor((amount / rate) * 10000 + 1e-9) / 10000).toFixed(4).replace(/\.?0+$/, '') : '1';
    lines.push({ itemId: l.item_id ? String(l.item_id) : '', description: `${l.description ?? ''}${note}`.slice(0, 500), quantity: qty,
      rate: centsToInput(byQty ? rate : amount), serviceDate: '', estimateLine: String(l.line_no) });
  }
  if (!lines.some(l => !l.kind)) fail('Everything on this estimate has been invoiced.');
  return {
    customerId: String(e.customer_id), txnDate: today, dueDate: '', termsId: '', docNumber: '', memo: e.memo ?? '', paymentMethod: '', paymentRef: '',
    projectId: e.project_id ? String(e.project_id) : '', lines, estimateId: String(e.txn_id), estimateNumber: `Estimate ${e.doc_number}`, afterSave: 'none',
  };
}
