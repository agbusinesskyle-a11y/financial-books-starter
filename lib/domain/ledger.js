// Chart-of-accounts vocabulary and the posting rules: transaction -> balanced debits (+) and credits (−).

export const ACCOUNT_TYPES = [
  ['bank', 'Bank', 'asset'],
  ['accounts_receivable', 'Accounts receivable (A/R)', 'asset'],
  ['other_current_asset', 'Other current asset', 'asset'],
  ['inventory', 'Inventory', 'asset'],
  ['fixed_asset', 'Fixed asset', 'asset'],
  ['other_asset', 'Other asset', 'asset'],
  ['accounts_payable', 'Accounts payable (A/P)', 'liability'],
  ['credit_card', 'Credit card', 'liability'],
  ['other_current_liability', 'Other current liability', 'liability'],
  ['long_term_liability', 'Long-term liability', 'liability'],
  ['equity', 'Equity', 'equity'],
  ['income', 'Income', 'income'],
  ['other_income', 'Other income', 'income'],
  ['cost_of_goods_sold', 'Cost of goods sold', 'expense'],
  ['expense', 'Expense', 'expense'],
  ['other_expense', 'Other expense', 'expense'],
];
export const TYPE_LABEL = Object.fromEntries(ACCOUNT_TYPES.map(([k, l]) => [k, l]));
export const TYPE_GROUP = Object.fromEntries(ACCOUNT_TYPES.map(([k, , g]) => [k, g]));
export const GROUPS = [['asset', 'Assets'], ['liability', 'Liabilities'], ['equity', 'Equity'], ['income', 'Income'], ['expense', 'Expenses']];

// Debit-normal groups show balances as stored; credit-normal groups flip the sign so a normal balance is positive.
export const normalSign = type => (TYPE_GROUP[type] === 'asset' || TYPE_GROUP[type] === 'expense' ? 1 : -1);

// Only the system's own A/R and A/P accounts may carry those types (subledgers depend on it).
export const RESERVED_TYPES = new Set(['accounts_receivable', 'accounts_payable']);

// Created for every company. Renamable; never deleted, retyped or made inactive.
export const SYSTEM_ACCOUNTS = [
  { key: 'ar', name: 'Accounts Receivable (A/R)', number: '1200', type: 'accounts_receivable' },
  { key: 'undeposited', name: 'Undeposited Funds', number: '1250', type: 'other_current_asset' },
  { key: 'inventory', name: 'Inventory Asset', number: '1300', type: 'inventory' },
  { key: 'ap', name: 'Accounts Payable (A/P)', number: '2000', type: 'accounts_payable' },
  { key: 'retained', name: 'Retained Earnings', number: '3800', type: 'equity' },
  { key: 'opening_equity', name: 'Opening Balance Equity', number: '3900', type: 'equity' },
  { key: 'sales', name: 'Sales', number: '4000', type: 'income' },
  { key: 'late_fee_income', name: 'Late Fee Income', number: '4900', type: 'income' },
  { key: 'shipping_income', name: 'Shipping Income', number: '4800', type: 'income' },
  { key: 'discounts', name: 'Discounts Given', number: '4950', type: 'income' },
  { key: 'convenience_fees', name: 'Convenience Fee Income', number: '4960', type: 'other_income' },
  { key: 'merchant_fees', name: 'Merchant Fees', number: '6950', type: 'expense' },
  { key: 'fx_gain_loss', name: 'Exchange Gain or Loss', number: '8500', type: 'other_expense' },
  { key: 'fx_unrealized', name: 'Unrealized Gain or Loss', number: '8510', type: 'other_expense' },
  { key: 'cogs', name: 'Cost of Goods Sold', number: '5000', type: 'cost_of_goods_sold' },
  { key: 'shrinkage', name: 'Inventory Shrinkage', number: '5900', type: 'cost_of_goods_sold' },
];

export class PostingError extends Error {}

export const VENDOR_TYPES = ['bill', 'bill_payment', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt', 'inventory_adjustment'];

// t: the txn row. lines: its txn_line rows. incomeAccount(itemId) / expenseAccount(itemId) -> account id for a
// sales line / a purchase line. sys: system account ids by key. depositLines: deposit_line rows (deposits only).
// Returns [{ lineNo, accountId, amountCents, customerId, vendorId, projectId, itemId }] summing to zero.
// inventory(itemId) -> { asset, cogs } account ids for an inventory item, else null; inventory lines carry cost_cents.
export function postingsFor({ txn: t, lines = [], depositLines = [], sys, incomeAccount = () => null, expenseAccount = () => null, inventory = () => null }) {
  if (t.voided_at || Number(t.total_cents) === 0 || t.type === 'purchase_order' || t.type === 'estimate') return [];
  const total = Number(t.total_cents);
  // A foreign-currency transaction: what it's worth at its own rate. For payments and credits, total_cents is what it took
  // off A/R or A/P (at the rates of the invoices and bills it paid); the difference is a realized exchange gain or loss.
  const base = t.currency && !t.voided_at ? Math.round(Number(t.foreign_total_cents) * Number(t.exchange_rate)) : total;
  // Class and location ride along on every posting (a line's own class wins) for reports.
  const party = { customerId: t.customer_id ?? null, vendorId: t.vendor_id ?? null, projectId: t.project_id ?? null,
    classId: t.class_id ?? null, locationId: t.location_id ?? null };
  const lineClass = l => (l.class_id ? { classId: l.class_id } : {});
  const out = [];
  const add = (accountId, amountCents, extra = {}) => {
    if (!accountId) throw new PostingError(`No account to post ${t.type} ${t.txn_id} to.`);
    if (amountCents !== 0) out.push({ lineNo: null, itemId: null, ...party, accountId, amountCents, ...extra });
  };
  // Income side of a sales document: one posting per line, signed by `sign` (−1 credit, +1 debit), plus any
  // discount (Discounts given, the opposite way) and shipping (Shipping income, the same way as the lines).
  const discount = Number(t.discount_cents ?? 0), shipping = Number(t.shipping_cents ?? 0);
  const incomeLines = sign => {
    if (discount) add(sys.discounts, -sign * discount);
    if (shipping) add(sys.shipping_income, sign * shipping);
    let sum = 0;
    for (const l of lines) {
      if (l.kind && l.kind !== 'item') continue; // subtotal and text lines (stage F3) post nothing
      const amount = Number(l.amount_cents);
      sum += amount;
      // A line can name its own income account (billable expenses re-billed to a customer).
      add(l.account_id ?? incomeAccount(l.item_id) ?? sys.sales, sign * amount, { lineNo: l.line_no, itemId: l.item_id ?? null, ...lineClass(l) });
      // Stock leaving (sale) or coming back (credit memo) at average cost: cost_cents is − out / + in.
      const inv = l.item_id ? inventory(l.item_id) : null;
      const cost = Number(l.cost_cents ?? 0);
      if (inv && cost) {
        add(inv.asset, cost, { lineNo: l.line_no, itemId: l.item_id, ...lineClass(l) });
        add(inv.cogs, -cost, { lineNo: l.line_no, itemId: l.item_id, ...lineClass(l) });
      }
    }
    if (sum - discount + shipping !== base) throw new PostingError(`Lines of ${t.type} ${t.txn_id} add to ${sum}, not the total ${base}.`);
  };
  // Cost side of a purchase document: category lines post to their account, product lines to the product's
  // expense account (Cost of Goods Sold if none). Lines keep their own customer / project for job costing.
  const costLines = sign => {
    let sum = 0;
    for (const l of lines) {
      const amount = Number(l.amount_cents);
      sum += amount;
      const inv = l.item_id ? inventory(l.item_id) : null;
      const tags = { lineNo: l.line_no, itemId: l.item_id ?? null, customerId: l.customer_id ?? null, projectId: l.project_id ?? null, ...lineClass(l) };
      if (inv && !l.account_id && l.cost_cents !== null && l.cost_cents !== undefined && Number(l.cost_cents) !== sign * amount) {
        // Stock value moves at its replayed cost; any difference from what was paid is cost of goods sold.
        add(inv.asset, Number(l.cost_cents), tags);
        add(inv.cogs, sign * amount - Number(l.cost_cents), tags);
      } else {
        add(l.account_id ?? inv?.asset ?? expenseAccount(l.item_id) ?? sys.cogs, sign * amount, tags);
      }
    }
    if (sum !== base) throw new PostingError(`Lines of ${t.type} ${t.txn_id} add to ${sum}, not the total ${base}.`);
  };
  const fx = amount => { if (amount) add(sys.fx_gain_loss, amount); };

  switch (t.type) {
    case 'invoice':
      add(sys.ar, total);
      incomeLines(-1);
      break;
    case 'late_fee':
      add(sys.ar, total);
      add(sys.late_fee_income, -total);
      break;
    case 'sales_receipt':
      add(t.account_id ?? sys.undeposited, total);
      incomeLines(-1);
      break;
    case 'credit_memo':
      incomeLines(1);
      add(sys.ar, -total);
      fx(total - base);
      break;
    case 'payment': {
      // Online payments: the processor keeps its fee; a fee the customer paid on top is income.
      const fee = Number(t.fee_cents ?? 0), surcharge = Number(t.surcharge_cents ?? 0);
      // Deposit to (QuickBooks' Receive payment): Undeposited Funds unless a bank account was chosen.
      add(t.account_id ?? sys.undeposited, base - fee + surcharge);
      if (fee) add(sys.merchant_fees, fee);
      if (surcharge) add(sys.convenience_fees, -surcharge);
      add(sys.ar, -total);
      fx(total - base);
      break;
    }
    case 'fx_revaluation':
    case 'journal_entry': {
      // Lines are signed: + debit, − credit. They must balance; the total is the debits.
      let debits = 0, net = 0;
      for (const l of lines) {
        const amount = Number(l.amount_cents);
        net += amount;
        if (amount > 0) debits += amount;
        add(l.account_id, amount, { lineNo: l.line_no, customerId: l.customer_id ?? null, vendorId: l.vendor_id ?? null, projectId: null, ...lineClass(l) });
      }
      if (net !== 0 || debits !== total) throw new PostingError(`Journal entry ${t.txn_id} doesn’t balance.`);
      break;
    }
    case 'transfer':
    case 'cc_payment':
      add(t.to_account_id, total);
      add(t.account_id, -total);
      break;
    case 'deposit': {
      add(t.account_id, total, { customerId: null, projectId: null });
      // Cash back (stage F5): kept out of the bank, into its own account.
      const cashBack = Number(t.cash_back_cents ?? 0);
      if (cashBack) add(t.cash_back_account_id, cashBack, { customerId: null, projectId: null });
      let sum = 0;
      for (const d of depositLines) {
        const amount = Number(d.amount_cents);
        sum += amount;
        add(d.source_txn_id ? sys.undeposited : d.account_id, -amount, { lineNo: d.line_no, customerId: d.customer_id ?? null, projectId: null });
      }
      if (sum !== total + cashBack) throw new PostingError(`Deposit ${t.txn_id} lines add to ${sum}, not the total ${total}${cashBack ? ` plus ${cashBack} cash back` : ''}.`);
      break;
    }
    case 'bill':
    case 'item_receipt':
      costLines(1);
      add(sys.ap, -total);
      break;
    case 'vendor_credit':
      add(sys.ap, total);
      costLines(-1);
      fx(base - total);
      break;
    case 'expense':
    case 'check':
      costLines(1);
      add(t.account_id, -total);
      break;
    case 'bill_payment':
      add(sys.ap, total);
      add(t.account_id, -base);
      fx(base - total);
      break;
    case 'inventory_adjustment':
      for (const l of lines) {
        const inv = inventory(l.item_id);
        const cost = Number(l.cost_cents ?? 0);
        if (!inv) throw new PostingError(`Adjustment ${t.txn_id} line ${l.line_no} isn’t an inventory item.`);
        if (cost) {
          add(inv.asset, cost, { lineNo: l.line_no, itemId: l.item_id });
          add(t.account_id, -cost, { lineNo: l.line_no, itemId: l.item_id });
        }
      }
      break;
    default:
      throw new PostingError(`No posting rule for ${t.type}.`);
  }
  const net = out.reduce((s, p) => s + p.amountCents, 0);
  if (net !== 0) throw new PostingError(`${t.type} ${t.txn_id} is out of balance by ${net}.`);
  return out;
}
