import { formatCents } from './money.js';
import { daysBetween } from './dates.js';

const CHARGES = new Set(['invoice', 'late_fee']);
const CREDITS = new Set(['payment', 'credit_memo']);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Status text + tone for one Transaction List row, as of `today` (YYYY-MM-DD).
export function txnStatus(txn, today) {
  if (txn.voided_at) return { text: 'Voided', tone: 'muted' };
  if (CHARGES.has(txn.type)) {
    if (txn.open_cents === 0) return { text: 'Paid', tone: 'good' };
    const partial = txn.open_cents < txn.total_cents;
    const days = daysBetween(today, txn.due_date);
    if (days < 0) {
      const text = `Overdue ${plural(-days, 'day')}`;
      return { text: partial ? `${text} · ${formatCents(txn.open_cents)} due` : text, tone: 'bad' };
    }
    if (partial) return { text: `Partially paid, ${formatCents(txn.open_cents)} due`, tone: 'warn' };
    if (days === 0) return { text: 'Due today', tone: 'warn' };
    if (days === 1) return { text: 'Due tomorrow', tone: 'neutral' };
    return { text: `Due in ${plural(days, 'day')}`, tone: 'neutral' };
  }
  if (txn.type === 'bill') {
    if (txn.approval_status === 'awaiting') return { text: 'Awaiting approval', tone: 'warn' };
    if (txn.approval_status === 'rejected') return { text: 'Rejected', tone: 'bad' };
    if (txn.open_cents === 0) return { text: 'Paid', tone: 'good' };
    if (txn.scheduled_pay_date) return { text: `Payment scheduled ${txn.scheduled_pay_date.slice(5).replace('-', '/')}`, tone: 'neutral' };
    const partial = txn.open_cents < txn.total_cents;
    const days = daysBetween(today, txn.due_date);
    if (days < 0) return { text: `Overdue ${plural(-days, 'day')}${partial ? ` · ${formatCents(txn.open_cents)} due` : ''}`, tone: 'bad' };
    if (partial) return { text: `Partially paid, ${formatCents(txn.open_cents)} due`, tone: 'warn' };
    if (days === 0) return { text: 'Due today', tone: 'warn' };
    return { text: `Due in ${plural(days, 'day')}`, tone: 'neutral' };
  }
  if (txn.type === 'purchase_order') {
    if (txn.closed_at || txn.open_cents === 0) return { text: 'Closed', tone: 'good' };
    if (txn.open_cents < txn.total_cents) return { text: `Partially received, ${formatCents(txn.open_cents)} to come`, tone: 'warn' };
    return { text: 'Open', tone: 'neutral' };
  }
  if (txn.type === 'estimate') {
    const invoiced = txn.open_cents < txn.total_cents;
    if (txn.estimate_status === 'closed') return { text: invoiced ? 'Closed (invoiced)' : 'Closed', tone: 'good' };
    if (txn.estimate_status === 'rejected') return { text: 'Rejected', tone: 'muted' };
    if (invoiced) return { text: `Partially invoiced, ${formatCents(txn.open_cents)} left`, tone: 'warn' };
    if (txn.estimate_status === 'accepted') return { text: 'Accepted', tone: 'good' };
    if (txn.due_date && daysBetween(today, txn.due_date) < 0) return { text: 'Expired', tone: 'bad' };
    return { text: 'Pending', tone: 'neutral' };
  }
  if (txn.type === 'item_receipt') return { text: 'Not billed yet', tone: 'warn' };
  if (txn.type === 'inventory_adjustment') return { text: 'Adjusted', tone: 'neutral' };
  if (txn.type === 'vendor_credit') {
    return txn.open_cents === 0 ? { text: 'Applied', tone: 'good' } : { text: `Unapplied ${formatCents(txn.open_cents)}`, tone: 'warn' };
  }
  if (txn.type === 'bill_payment' || txn.type === 'check') {
    if (txn.payment_method === 'Check' || txn.type === 'check') return txn.printed_at ? { text: 'Printed', tone: 'good' } : { text: 'To print', tone: 'warn' };
    return { text: 'Paid', tone: 'good' };
  }
  if (txn.type === 'expense' || txn.type === 'deposit') return { text: 'Paid', tone: 'good' };
  if (['journal_entry', 'transfer', 'cc_payment', 'fx_revaluation'].includes(txn.type)) return { text: 'Posted', tone: 'good' };
  if (CREDITS.has(txn.type)) {
    return txn.open_cents === 0
      ? { text: 'Closed', tone: 'good' }
      : { text: `Unapplied ${formatCents(txn.open_cents)}`, tone: 'warn' };
  }
  return { text: 'Paid', tone: 'good' }; // sales receipt
}

export const TYPE_LABELS = {
  invoice: 'Invoice',
  payment: 'Payment',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  late_fee: 'Late Fee',
  deposit: 'Deposit',
  bill: 'Bill',
  bill_payment: 'Bill Payment',
  expense: 'Expense',
  check: 'Check',
  vendor_credit: 'Vendor Credit',
  purchase_order: 'Purchase Order',
  item_receipt: 'Item Receipt',
  inventory_adjustment: 'Inventory Adjustment',
  estimate: 'Estimate',
  journal_entry: 'Journal Entry',
  transfer: 'Transfer',
  cc_payment: 'Credit Card Payment',
  fx_revaluation: 'Currency Revaluation',
};
