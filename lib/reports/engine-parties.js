import { fitBuckets } from './periods.js';
import { openItems, agingBuckets, agingSummary, agingDetail, openByParty, balanceSummary, bucketOf, SIDES } from './receivables.js';
import {
  salesSummary, salesDetail, incomeByCustomer, invoiceList, invoicesAndPayments, statementList, unbilledCharges, unbilledTimeReport,
  depositDetail, estimates, groupByParty, SALES_DOCS, purchaseLines, PURCHASE_DOCS, purchaseSigned,
} from './sales.js';
import {
  projectProfitability, workInProgress, openPurchaseOrders, inventoryValuation, inventoryStatus, timeActivities, recurringList, reconciliationList,
  billApprovalStatus, invalidTransactions,
} from './operations.js';
import { billPaymentList, billsAndPayments, ten99, checkDetail, contactList, productList, simpleList, groupByTag } from './payables.js';
import { transactionList } from './lists.js';
import { txnInfo } from './detail.js';
import { ledgerLines } from './ledger-data.js';

// Customer and vendor reports (stage R2). Returns the report's { columns, rows, … } or null for kinds it doesn't own.
// Summary reports return rows with `values` and ready-made `cells`; table reports return detail: true.

const TIME = new Set(['days', 'weeks', 'months', 'quarters', 'years']);
const ids = list => list.filter(x => x !== null);
const valueCells = rows => { for (const r of rows) if (r.values && !r.cells) r.cells = r.values.map(v => ({ v })); return rows; };

export async function runPartyReport(db, { def, opts, orgId, entityId, accounts, accountsById, lines, names, numbers }) {
  const side = def.side ?? 'ar';
  const partyFilter = ids(opts.filters[SIDES[side].party] ?? []);
  const customers = ids(opts.filters.customer);
  const vendors = ids(opts.filters.vendor);
  // Purchases and expenses reuse the sales summary/detail with purchase lines (amounts flipped to show positive).
  const EXP = ['cost_of_goods_sold', 'expense', 'other_expense'];
  const select = def.purchases ? purchaseLines : def.expenses
    ? (ls, acc) => ls.filter(l => EXP.includes(acc.get(l.accountId)?.type)).map(l => ({ ...l, amount: -l.amount })) : undefined;
  const party = def.purchases || def.expenses ? 'vendor' : 'customer';
  const to = opts.to, from = opts.from;
  const buckets = agingBuckets(opts.aging);
  const items = () => openItems(db, { orgId, entityId, side, asOf: to, partyIds: partyFilter });
  const table = res => ({ detail: true, ...res });

  switch (def.kind) {
    case 'aging': {
      const res = agingSummary(await items(), { buckets });
      return { columns: res.columns.map((label, i) => ({ label, kind: 'value', i })), rows: valueCells(res.rows), totals: { total: res.total },
        drill: (row, d) => (row.partyId && d ? { report: def.drillTo, [SIDES[side].party]: [row.partyId], from: null, to,
          extra: d.i < buckets.length ? { aging_bucket: String(d.i) } : {} } : null) };
    }
    case 'aging_detail': {
      // One aging period only (when opened from a bucket on the summary), or all of them.
      const only = /^\d{1,2}$/.test(opts.extra.aging_bucket ?? '') && Number(opts.extra.aging_bucket) < buckets.length ? Number(opts.extra.aging_bucket) : null;
      const all = await items();
      const res = agingDetail(only === null ? all : all.filter(i => bucketOf(buckets, i.pastDue) === only), { buckets, side });
      return table({ ...res, extraFields: [{ name: 'aging_bucket', label: 'Showing', options: [['', 'Every aging period'], ...buckets.map((b, i) => [String(i), b.label])],
        value: only === null ? '' : String(only) }] });
    }
    case 'open_items': return table(openByParty(await items(), { side, running: def.running }));
    case 'collections': {
      const { rows } = await db.query('SELECT customer_id AS id, phone, email FROM customer WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
      return table(openByParty(await items(), { side, overdueOnly: true, contacts: new Map(rows.map(r => [Number(r.id), r])) }));
    }
    case 'balance_summary': {
      const res = balanceSummary(await items());
      return { columns: [{ label: 'Total', kind: 'value', i: 0 }], rows: valueCells(res.rows), totals: { total: res.total },
        drill: (row, d) => (row.partyId && d ? { report: def.drillTo, [SIDES[side].party]: [row.partyId], from: null, to } : null) };
    }
    case 'sales': {
      const fit = TIME.has(opts.columnsBy) && from ? fitBuckets(opts.columnsBy, from, to, 120, opts.fiscalStartMonth) : null;
      if (fit?.changed) opts.notices.push(`That is too many ${opts.columnsBy} for columns, so the report shows ${fit.unit} instead.`);
      const columns = fit
        ? [...fit.buckets, { key: 'total', label: 'Total', from, to, total: true }]
        : [{ key: 'total', label: 'Total', from, to, total: true }];
      let quantities = null, cogsByItem = null;
      if (def.groupBy === 'item' && columns.length === 1 && !select) {
        // Quantities come from the documents (accrual); COGS from the inventory lines of the same sales documents.
        const { rows } = await db.query(
          `SELECT l.item_id, sum(CASE WHEN t.type = 'credit_memo' THEN -l.quantity ELSE l.quantity END) AS qty
             FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id
            WHERE l.org_id = $1 AND t.entity_id = $2 AND t.type = ANY($3::text[]) AND t.voided_at IS NULL AND l.item_id IS NOT NULL
              AND ($4::date IS NULL OR t.txn_date >= $4::date) AND t.txn_date <= $5::date GROUP BY l.item_id`, [orgId, entityId, SALES_DOCS, from, to]);
        quantities = new Map(rows.map(r => [Number(r.item_id), Number(r.qty)]));
        cogsByItem = new Map();
        for (const l of lines) {
          if (!l.itemId || !SALES_DOCS.includes(l.type) || accountsById.get(l.accountId)?.type !== 'cost_of_goods_sold' || (from && l.date < from) || l.date > to) continue;
          cogsByItem.set(l.itemId, (cogsByItem.get(l.itemId) ?? 0) + l.amount);
        }
      }
      const res = salesSummary({ lines, accountsById, columns, groupBy: def.groupBy, names, quantities, cogsByItem, select });
      const display = res.product
        ? [['Qty', 'qty'], ['Amount', 'value'], ['% of Sales', 'pct_sales'], ['Avg. Price', 'value'], ['COGS', 'value'], ['Gross Margin', 'value'], ['Gross Margin %', 'pct_margin']]
          .map(([label, kind], i) => ({ label, kind, i }))
        : columns.map((c, i) => ({ label: c.label, kind: 'value', i, base: c }));
      const filterKey = { customer: 'customer', vendor: 'vendor', item: 'item', class: 'class', location: 'location' }[def.groupBy];
      return { columns: display, rows: valueCells(res.rows), totals: { total: res.total },
        drill: (row, d) => (row.groupId !== undefined && d.kind === 'value' && (!res.product || d.i === 1)
          ? { report: def.drillTo, [filterKey]: [row.groupId], from: res.product ? from : columns[d.i].from, to: res.product ? to : columns[d.i].to } : null) };
    }
    case 'sales_detail': {
      const info = await txnInfo(db, { orgId, txnIds: [...new Set(lines.map(l => l.txnId))], accountsById, numbers });
      return table(salesDetail({ lines, accountsById, from, to, groupBy: def.groupBy, names, info, select, party }));
    }
    case 'income_by_customer': {
      const res = incomeByCustomer({ lines, accountsById, from, to, names });
      return { columns: ['Income', 'Expenses', 'Net Income'].map((label, i) => ({ label, kind: 'value', i })), rows: valueCells(res.rows), totals: { total: res.total },
        drill: (row, d) => (row.groupId !== undefined && d.i === 2 ? { report: 'profit_and_loss', customer: [row.groupId], from, to } : null) };
    }
    case 'invoice_list': return table(await invoiceList(db, { orgId, entityId, from, to, customers }));
    case 'invoices_payments': return table(await invoicesAndPayments(db, { orgId, entityId, from, to, customers }));
    case 'statement_list': return table(await statementList(db, { orgId, entityId, from, to, customers }));
    case 'unbilled_charges': return table(await unbilledCharges(db, { orgId, entityId, to, customers }));
    case 'unbilled_time': return table(await unbilledTimeReport(db, { orgId, entityId, to, customers }));
    case 'deposit_detail': return table(await depositDetail(db, { orgId, entityId, from, to, accountsById, customers }));
    case 'estimates': return table(await estimates(db, { orgId, entityId, from, to, customers, progress: def.progress }));
    case 'txnlist_by': {
      const list = await transactionList(db, { orgId, entityId, accounts, from, to, filters: opts.filters, numbers });
      return table(groupByParty(list, { party: def.party, names }));
    }
    case 'txnlist_by_tag': {
      const list = await transactionList(db, { orgId, entityId, accounts, from, to, filters: opts.filters, numbers });
      const { rows: tagRows } = await db.query(
        `SELECT x.txn_id, x.tag_id, g.name AS group_name FROM txn_tag x JOIN tag t ON t.tag_id = x.tag_id LEFT JOIN tag_group g ON g.group_id = t.group_id WHERE x.org_id = $1`, [orgId]);
      const tagsByTxn = new Map(), groups = new Map();
      for (const r of tagRows) {
        if (!tagsByTxn.has(Number(r.txn_id))) tagsByTxn.set(Number(r.txn_id), new Set());
        tagsByTxn.get(Number(r.txn_id)).add(Number(r.tag_id));
        if (r.group_name) groups.set(Number(r.tag_id), r.group_name);
      }
      return table(groupByTag(list, { tagsByTxn, tags: names.tags, groups }));
    }
    case 'purchase_list': {
      const list = await transactionList(db, { orgId, entityId, accounts, from, to, filters: opts.filters, numbers });
      const rows = list.rows.filter(r => [...PURCHASE_DOCS, 'purchase_order'].includes(r.txnType)).map(purchaseSigned);
      if (rows.length) rows.push({ kind: 'total', label: 'Total', grand: true, cells: { amount: rows.reduce((s, r) => s + r.cells.amount, 0) } });
      return table({ ...list, rows });
    }
    case 'bill_payments': return table(await billPaymentList(db, { orgId, entityId, from, to, vendors, accountsById }));
    case 'bills_payments': return table(await billsAndPayments(db, { orgId, entityId, from, to, vendors }));
    case 'ten99': return table(await ten99(db, { orgId, entityId, from, to, vendors, detail: def.detail, accountsById }));
    case 'check_detail': return table(await checkDetail(db, { orgId, entityId, from, to, vendors, accountsById, numbers }));
    case 'contacts': return table(await contactList(db, { orgId, entityId, party: def.party, phones: def.phones, show: opts.show }));
    case 'products': return table(await productList(db, { orgId, entityId, accountsById, show: opts.show }));
    case 'simple_list': return table(await simpleList(db, { orgId, entityId, kind: def.list }));
    case 'project_profit': {
      const res = await projectProfitability(db, { orgId, entityId, lines, accountsById, from, to, customers });
      return { columns: res.columns.map((label, i) => ({ label, kind: 'value', i })), rows: valueCells(res.rows), totals: { total: res.total },
        drill: (row, d) => (row.projectId && d.i === 3 ? { report: 'profit_and_loss', project: [row.projectId], from, to } : null) };
    }
    case 'wip': return table(await workInProgress(db, { orgId, entityId, to, customers }));
    case 'open_po': return table(await openPurchaseOrders(db, { orgId, entityId, to, vendors, mode: def.mode }));
    // Stock is valued from the full books whatever the basis (on cash basis unpaid bills would leave stock out).
    case 'inv_valuation': case 'inv_valuation_detail': case 'inv_status': {
      const stock = await ledgerLines(db, { orgId, entityId, to, basis: 'accrual' });
      const res = def.kind === 'inv_status'
        ? await inventoryStatus(db, { orgId, entityId, to, lines: stock, accountsById, worksheet: def.worksheet, show: opts.show })
        : await inventoryValuation(db, { orgId, entityId, from, to, lines: stock, accountsById, items: ids(opts.filters.item), detail: def.kind === 'inv_valuation_detail' });
      return { ...table(res), basisLabel: 'Inventory at cost (accrual)' };
    }
    case 'time': return table(await timeActivities(db, { orgId, entityId, from, to, customers, by: def.by, recent: def.recent }));
    case 'recurring_list': return table(await recurringList(db, { orgId, entityId, show: opts.show }));
    case 'reconciliations': return table(await reconciliationList(db, { orgId, entityId, from, to, accountsById }));
    case 'bill_approval': return table(await billApprovalStatus(db, { orgId, entityId, from, to, vendors }));
    case 'invalid_txns': return table(await invalidTransactions(db, { orgId, entityId, from, to }));
    default: return null;
  }
}

export const PARTY_KINDS = new Set(['aging', 'aging_detail', 'open_items', 'collections', 'balance_summary', 'sales', 'sales_detail', 'income_by_customer',
  'invoice_list', 'invoices_payments', 'statement_list', 'unbilled_charges', 'unbilled_time', 'deposit_detail', 'estimates', 'txnlist_by',
  'txnlist_by_tag', 'purchase_list', 'bill_payments', 'bills_payments', 'ten99', 'check_detail', 'contacts', 'products', 'simple_list',
  'project_profit', 'wip', 'open_po', 'inv_valuation', 'inv_valuation_detail', 'inv_status', 'time', 'recurring_list', 'reconciliations', 'bill_approval', 'invalid_txns']);
// Reports shown "As of" a date (they ignore the From date).
export const ASOF_KINDS = new Set(['asof', 'tb', 'accounts', 'aging', 'aging_detail', 'open_items', 'collections', 'balance_summary', 'unbilled_charges', 'unbilled_time',
  'contacts', 'products', 'simple_list', 'wip', 'open_po', 'inv_valuation', 'inv_status', 'recurring_list']);
