import { TYPE_LABELS } from '../domain/status.js';
import { STATUS_LABELS } from '../domain/projects.js';
import { accountLabel } from './statements.js';

// Stage R3a reports: projects, purchase orders, inventory, time, recurring templates, reconciliations, bill approvals
// and the invalid-transactions check. Table reports return { columns, rows }; summaries return rows with values.

const range = `($3::date IS NULL OR t.txn_date >= $3::date) AND t.txn_date <= $4::date`;
const docLine = (t, cells, more = {}) => ({ kind: 'line', txnId: Number(t.txn_id), txnType: t.type, cells, ...more });
const qtyText = q => Number(q).toLocaleString('en-US', { maximumFractionDigits: 4 });
const want = (list, id) => !list.length || list.includes(id === null || id === undefined ? null : Number(id));
const INCOME = ['income', 'other_income'], COGS = ['cost_of_goods_sold'], EXPENSE = ['expense', 'other_expense'];

// Project Profitability Summary: income, cost of goods sold, expenses and net income for each project, from the
// ledger lines tagged with the project (so cash basis works too).
export async function projectProfitability(db, { orgId, entityId, lines, accountsById, from, to, customers }) {
  const { rows: projects } = await db.query(
    `SELECT p.project_id, p.name, p.status, c.display_name, p.customer_id FROM project p JOIN customer c ON c.customer_id = p.customer_id
      WHERE p.org_id = $1 AND c.entity_id = $2 ORDER BY lower(c.display_name), lower(p.name)`, [orgId, entityId]);
  const by = new Map();
  for (const l of lines) {
    if (!l.projectId || (from && l.date < from) || l.date > to) continue;
    const type = accountsById.get(l.accountId)?.type;
    const k = INCOME.includes(type) ? 0 : COGS.includes(type) ? 1 : EXPENSE.includes(type) ? 2 : -1;
    if (k < 0) continue;
    if (!by.has(l.projectId)) by.set(l.projectId, [0, 0, 0]);
    by.get(l.projectId)[k] += k === 0 ? -l.amount : l.amount;
  }
  const rows = projects.filter(p => want(customers, p.customer_id)).map(p => {
    const [inc, cogs, exp] = by.get(Number(p.project_id)) ?? [0, 0, 0];
    return { kind: 'account', depth: 0, label: `${p.display_name}: ${p.name}`, projectId: Number(p.project_id), href: `/projects/${p.project_id}`,
      values: [inc, cogs, exp, inc - cogs - exp] };
  }).filter(r => r.values.some(Boolean));
  const total = rows.reduce((t, r) => t.map((x, i) => x + r.values[i]), [0, 0, 0, 0]);
  rows.push({ kind: 'computed', label: 'Total', depth: 0, values: total, grand: true });
  return { rows, total, columns: ['Income', 'Cost of goods sold', 'Expenses', 'Net income'] };
}

// Work in progress by project: what each open project has been estimated, invoiced and cost, and what is waiting to be
// billed (billable expenses and time not yet on an invoice).
export async function workInProgress(db, { orgId, entityId, to, customers }) {
  const { rows } = await db.query(
    `SELECT p.project_id, p.name, p.status, p.customer_id, c.display_name,
            coalesce((SELECT sum(t.total_cents) FROM txn t WHERE t.project_id = p.project_id AND t.type = 'estimate' AND t.voided_at IS NULL AND t.txn_date <= $3::date), 0)::bigint AS estimated,
            coalesce((SELECT sum(CASE WHEN t.type = 'credit_memo' THEN -t.total_cents ELSE t.total_cents END) FROM txn t WHERE t.project_id = p.project_id
                       AND t.type IN ('invoice', 'sales_receipt', 'late_fee', 'credit_memo') AND t.voided_at IS NULL AND t.txn_date <= $3::date), 0)::bigint AS invoiced,
            coalesce((SELECT sum(CASE WHEN t.type IN ('vendor_credit', 'cc_credit') THEN -l.amount_cents ELSE l.amount_cents END) FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id
                       WHERE l.project_id = p.project_id AND t.type IN ('bill', 'expense', 'check', 'vendor_credit', 'cc_credit') AND t.voided_at IS NULL AND t.txn_date <= $3::date), 0)::bigint AS costs,
            coalesce((SELECT sum(l.amount_cents) FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id
                       WHERE l.project_id = p.project_id AND l.billable AND t.type IN ('bill', 'expense', 'check') AND t.voided_at IS NULL AND t.txn_date <= $3::date
                         AND NOT EXISTS (SELECT 1 FROM txn_line b JOIN txn i ON i.txn_id = b.txn_id WHERE b.billable_txn_id = l.txn_id AND b.billable_line_no = l.line_no AND i.voided_at IS NULL)), 0)::bigint AS unbilled
       FROM project p JOIN customer c ON c.customer_id = p.customer_id
      WHERE p.org_id = $1 AND c.entity_id = $2 ORDER BY lower(c.display_name), lower(p.name)`, [orgId, entityId, to]);
  const list = rows.filter(r => want(customers, r.customer_id));
  const out = list.map(r => ({ kind: 'line', href: `/projects/${r.project_id}`, cells: { project: `${r.display_name}: ${r.name}`, status: STATUS_LABELS[r.status] ?? r.status,
    estimated: Number(r.estimated), invoiced: Number(r.invoiced), left: Math.max(0, Number(r.estimated) - Number(r.invoiced)), costs: Number(r.costs),
    unbilled: Number(r.unbilled), margin: Number(r.invoiced) - Number(r.costs) } }));
  if (out.length) {
    const sum = k => out.reduce((s, r) => s + r.cells[k], 0);
    out.push({ kind: 'total', label: 'Total', grand: true, cells: Object.fromEntries(['estimated', 'invoiced', 'left', 'costs', 'unbilled', 'margin'].map(k => [k, sum(k)])) });
  }
  return { rows: out, columns: [{ key: 'project', label: 'Project' }, { key: 'status', label: 'Status' }, { key: 'estimated', label: 'Estimated', money: true },
    { key: 'invoiced', label: 'Invoiced', money: true }, { key: 'left', label: 'Left to invoice', money: true }, { key: 'costs', label: 'Costs', money: true },
    { key: 'unbilled', label: 'Unbilled costs', money: true }, { key: 'margin', label: 'Invoiced less costs', money: true }] };
}

// Open purchase orders: List (one row per PO), Detail (each line with what is still to come) and by Project.
export async function openPurchaseOrders(db, { orgId, entityId, to, vendors, mode = 'list' }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, t.doc_number, t.memo, t.vendor_id, v.display_name, t.total_cents::bigint AS total,
            l.line_no, l.description, l.quantity, coalesce(l.received_qty, 0) AS received_qty, l.rate_cents::bigint AS rate, l.amount_cents::bigint AS amount,
            coalesce(l.received_cents, 0)::bigint AS received_cents, i.name AS item, l.project_id, p.name AS project, pc.display_name AS project_customer
       FROM txn t JOIN vendor v ON v.vendor_id = t.vendor_id JOIN txn_line l ON l.txn_id = t.txn_id LEFT JOIN item i ON i.item_id = l.item_id
       LEFT JOIN project p ON p.project_id = coalesce(l.project_id, t.project_id) LEFT JOIN customer pc ON pc.customer_id = p.customer_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'purchase_order' AND t.voided_at IS NULL AND t.closed_at IS NULL AND t.txn_date <= $3::date
      ORDER BY t.txn_date, t.txn_id, l.line_no`, [orgId, entityId, to]);
  const open = rows.filter(r => Number(r.amount) - Number(r.received_cents) > 0 && want(vendors, r.vendor_id));
  const left = r => Number(r.amount) - Number(r.received_cents);
  if (mode === 'detail' || mode === 'project') {
    const key = mode === 'project' ? r => (r.project ? `${r.project_customer}: ${r.project}` : 'No project') : r => `${r.display_name}`;
    const out = [];
    let grand = 0;
    for (const g of [...new Set(open.map(key))].sort((a, b) => (a === 'No project') - (b === 'No project') || a.localeCompare(b))) {
      out.push({ kind: 'section', label: g });
      let sum = 0;
      for (const r of open.filter(x => key(x) === g)) {
        out.push(docLine(r, { date: r.date, num: r.doc_number ?? '', name: r.display_name, item: r.item ?? r.description ?? '', ordered: qtyText(r.quantity),
          received: qtyText(r.received_qty), backordered: qtyText(Number(r.quantity) - Number(r.received_qty)), rate: Number(r.rate), amount: Number(r.amount), open: left(r) }));
        sum += left(r);
      }
      out.push({ kind: 'total', label: `Total for ${g}`, cells: { open: sum } });
      grand += sum;
    }
    if (out.length) out.push({ kind: 'total', label: 'Total', grand: true, cells: { open: grand } });
    return { rows: out, columns: [{ key: 'date', label: 'Date' }, { key: 'num', label: 'No.' }, { key: 'name', label: 'Vendor' }, { key: 'item', label: 'Product/Service' },
      { key: 'ordered', label: 'Qty ordered' }, { key: 'received', label: 'Received' }, { key: 'backordered', label: 'Backordered' },
      { key: 'rate', label: 'Rate', money: true }, { key: 'amount', label: 'Amount', money: true }, { key: 'open', label: 'Open balance', money: true }] };
  }
  const out = [];
  for (const id of [...new Set(open.map(r => Number(r.txn_id)))]) {
    const mine = open.filter(r => Number(r.txn_id) === id);
    const t = mine[0];
    out.push(docLine(t, { date: t.date, num: t.doc_number ?? '', name: t.display_name, memo: t.memo ?? '', amount: Number(t.total), open: mine.reduce((s, r) => s + left(r), 0) }));
  }
  if (out.length) out.push({ kind: 'total', label: 'Total', grand: true, cells: { amount: out.reduce((s, r) => s + r.cells.amount, 0), open: out.reduce((s, r) => s + r.cells.open, 0) } });
  return { rows: out, columns: [{ key: 'date', label: 'Date' }, { key: 'num', label: 'No.' }, { key: 'name', label: 'Vendor' }, { key: 'memo', label: 'Memo/Description' },
    { key: 'amount', label: 'Amount', money: true }, { key: 'open', label: 'Open balance', money: true }] };
}

// Inventory movements up to a date: quantity changes (purchases and customer returns in, sales and vendor returns out,
// adjustments by their own change) and the inventory-asset ledger lines for each item.
const MOVE_SQL = `SELECT l.item_id, t.txn_id, t.type, t.txn_date::text AS date, coalesce(t.doc_number, t.payment_ref) AS num, coalesce(c.display_name, v.display_name) AS name,
         (CASE WHEN t.type IN ('invoice', 'sales_receipt', 'vendor_credit', 'cc_credit') THEN -l.quantity WHEN t.type = 'inventory_adjustment' THEN l.qty_change ELSE l.quantity END)::float AS qty
    FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id JOIN item i ON i.item_id = l.item_id AND i.kind = 'inventory'
    LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
   WHERE l.org_id = $1 AND i.entity_id = $2 AND t.voided_at IS NULL AND t.txn_date <= $3::date
     AND t.type IN ('bill', 'item_receipt', 'check', 'expense', 'vendor_credit', 'cc_credit', 'invoice', 'sales_receipt', 'credit_memo', 'inventory_adjustment')
   ORDER BY t.txn_date, t.txn_id, l.line_no`;

async function inventoryData(db, { orgId, entityId, to, lines, accountsById }) {
  const [{ rows: items }, { rows: moves }] = await Promise.all([
    db.query(`SELECT item_id, name, sku, description, asset_account_id, reorder_point, active,
                     coalesce((SELECT sum(l.quantity - coalesce(l.received_qty, 0)) FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id
                                WHERE l.item_id = item.item_id AND t.type = 'purchase_order' AND t.voided_at IS NULL AND t.closed_at IS NULL), 0)::float AS on_po
                FROM item WHERE org_id = $1 AND entity_id = $2 AND kind = 'inventory' ORDER BY lower(name)`, [orgId, entityId]),
    db.query(MOVE_SQL, [orgId, entityId, to]),
  ]);
  // Inventory accounts, plus any other account an item keeps its stock in (an item may use an "Other current asset").
  const inventoryAccounts = new Set([...[...accountsById.values()].filter(a => a.type === 'inventory').map(a => a.account_id),
    ...items.map(i => i.asset_account_id).filter(Boolean).map(Number)]);
  const value = new Map(); // `${item}:${txn}` -> cents, and item -> total
  for (const l of lines) {
    if (!l.itemId || !inventoryAccounts.has(l.accountId) || l.date > to) continue;
    value.set(`${l.itemId}:${l.txnId}`, (value.get(`${l.itemId}:${l.txnId}`) ?? 0) + l.amount);
    value.set(l.itemId, (value.get(l.itemId) ?? 0) + l.amount);
  }
  return { items, moves, value };
}

// Inventory Valuation Summary (quantity, value and average cost per item on a date) and Detail (each movement in the
// period with running quantity and value, from the beginning balance).
export async function inventoryValuation(db, { orgId, entityId, from, to, lines, accountsById, detail = false, items: only = [] }) {
  const { items, moves, value } = await inventoryData(db, { orgId, entityId, to, lines, accountsById });
  const list = items.filter(i => want(only, i.item_id));
  if (!detail) {
    const rows = list.map(i => {
      const qty = moves.filter(m => Number(m.item_id) === Number(i.item_id)).reduce((s, m) => s + m.qty, 0);
      const v = value.get(Number(i.item_id)) ?? 0;
      return { kind: 'line', href: `/settings/items/${i.item_id}`, itemId: Number(i.item_id), cells: { name: i.name, sku: i.sku ?? '', qty: qtyText(qty), qtyValue: qty,
        value: v, avg: qty ? Math.round(v / qty) : null } };
    }).filter(r => r.cells.qtyValue || r.cells.value);
    if (rows.length) rows.push({ kind: 'total', label: 'Total', grand: true, cells: { value: rows.reduce((s, r) => s + r.cells.value, 0) } });
    return { rows, columns: [{ key: 'name', label: 'Product/Service' }, { key: 'sku', label: 'SKU' }, { key: 'qty', label: 'Qty on hand' },
      { key: 'avg', label: 'Avg. cost', money: true, noTotal: true }, { key: 'value', label: 'Asset value', money: true }] };
  }
  const out = [];
  let grand = 0;
  for (const i of list) {
    const mine = moves.filter(m => Number(m.item_id) === Number(i.item_id));
    const seen = new Set();
    let qty = 0, val = 0;
    for (const m of mine.filter(x => from && x.date < from)) { qty += m.qty; if (!seen.has(m.txn_id)) { val += value.get(`${i.item_id}:${m.txn_id}`) ?? 0; seen.add(m.txn_id); } }
    const inPeriod = mine.filter(x => !from || x.date >= from);
    if (!inPeriod.length && !qty) continue;
    out.push({ kind: 'section', label: i.name });
    out.push({ kind: 'line', cells: { date: '', type: 'Beginning balance', num: '', name: '', qty: '', cost: null, onhand: qtyText(qty), value: val } });
    for (const m of inPeriod) {
      const cost = seen.has(m.txn_id) ? 0 : value.get(`${i.item_id}:${m.txn_id}`) ?? 0;
      seen.add(m.txn_id);
      qty += m.qty; val += cost;
      out.push(docLine(m, { date: m.date, type: TYPE_LABELS[m.type], num: m.num ?? '', name: m.name ?? '', qty: qtyText(m.qty), cost, onhand: qtyText(qty), value: val }));
    }
    out.push({ kind: 'total', label: `Total for ${i.name}`, cells: { value: val } });
    grand += val;
  }
  if (out.length) out.push({ kind: 'total', label: 'Total', grand: true, cells: { value: grand } });
  return { rows: out, columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' }, { key: 'name', label: 'Name' },
    { key: 'qty', label: 'Qty' }, { key: 'onhand', label: 'Qty on hand' }, { key: 'cost', label: 'Cost', money: true, noTotal: true }, { key: 'value', label: 'Asset value', money: true }] };
}

// Inventory Status (on hand, on purchase orders, reorder point, whether to reorder) and the Physical Inventory Worksheet
// (on hand with a blank column to write the count in).
export async function inventoryStatus(db, { orgId, entityId, to, lines, accountsById, worksheet = false, show = 'active' }) {
  const { items, moves } = await inventoryData(db, { orgId, entityId, to, lines, accountsById });
  const rows = items.filter(i => show === 'all' || i.active).map(i => {
    const qty = moves.filter(m => Number(m.item_id) === Number(i.item_id)).reduce((s, m) => s + m.qty, 0);
    const reorder = i.reorder_point === null ? null : Number(i.reorder_point);
    return { kind: 'line', href: `/settings/items/${i.item_id}`, cells: { name: i.name, sku: i.sku ?? '', description: i.description ?? '', qty: qtyText(qty),
      on_po: qtyText(i.on_po), reorder: reorder === null ? '' : qtyText(reorder), low: reorder !== null && qty + Number(i.on_po) <= reorder ? 'Reorder' : '',
      count: '' } };
  });
  return { rows, columns: worksheet
    ? [{ key: 'name', label: 'Product/Service' }, { key: 'sku', label: 'SKU' }, { key: 'description', label: 'Description' }, { key: 'qty', label: 'Qty on hand' },
      { key: 'count', label: 'Physical count' }]
    : [{ key: 'name', label: 'Product/Service' }, { key: 'sku', label: 'SKU' }, { key: 'qty', label: 'Qty on hand' }, { key: 'on_po', label: 'Qty on PO' },
      { key: 'reorder', label: 'Reorder point' }, { key: 'low', label: 'Status' }] };
}

// Time: Time Activities by Customer / by Employee, Timesheet Detail by Employee (a subtotal per day), and Recent Time
// Activities (entered in the period, whatever the work date).
export async function timeActivities(db, { orgId, entityId, from, to, customers, by = 'customer', recent = false }) {
  const dateCol = recent ? 'e.created_at::date' : 'e.entry_date';
  const { rows } = await db.query(
    `SELECT e.entry_id, e.entry_date::text AS date, e.created_at, e.person, e.minutes, e.billable, e.notes, e.customer_id, c.display_name AS customer,
            i.name AS item, coalesce(i.rate_cents, 0)::bigint AS rate, p.name AS project
       FROM time_entry e LEFT JOIN customer c ON c.customer_id = e.customer_id LEFT JOIN item i ON i.item_id = e.item_id LEFT JOIN project p ON p.project_id = e.project_id
      WHERE e.org_id = $1 AND e.entity_id = $2 AND ($3::date IS NULL OR ${dateCol} >= $3::date) AND ${dateCol} <= $4::date
      ORDER BY ${recent ? 'e.created_at DESC' : 'e.entry_date, e.entry_id'}`, [orgId, entityId, from, to]);
  const list = rows.filter(r => want(customers, r.customer_id));
  const line = r => ({ kind: 'line', href: '/time', minutes: r.minutes, cells: { date: r.date, person: r.person, customer: r.customer ? `${r.customer}${r.project ? `: ${r.project}` : ''}` : '',
    item: r.item ?? '', memo: r.notes ?? '', billable: r.billable ? 'Yes' : 'No', hours: (r.minutes / 60).toFixed(2),
    rate: r.billable ? Number(r.rate) : null, amount: r.billable ? Math.round((Number(r.rate) * r.minutes) / 60) : 0,
    entered: recent ? new Date(r.created_at).toISOString().slice(0, 10) : '' } });
  const columns = [{ key: 'date', label: 'Date' }, ...(recent ? [{ key: 'entered', label: 'Entered' }] : []),
    by === 'customer' && !recent ? { key: 'person', label: 'Employee' } : { key: 'customer', label: 'Customer' }, ...(recent ? [{ key: 'person', label: 'Employee' }] : []),
    { key: 'item', label: 'Product/Service' }, { key: 'memo', label: 'Notes' }, { key: 'billable', label: 'Billable' }, { key: 'hours', label: 'Hours' },
    { key: 'rate', label: 'Rate', money: true, noTotal: true }, { key: 'amount', label: 'Amount', money: true }];
  const hours = ls => (ls.reduce((s, l) => s + l.minutes, 0) / 60).toFixed(2);
  const out = [];
  if (recent) {
    out.push(...list.map(line));
  } else {
    const keyOf = by === 'customer' ? r => r.customer ?? 'No customer' : r => r.person;
    for (const g of [...new Set(list.map(keyOf))].sort((a, b) => a.localeCompare(b))) {
      out.push({ kind: 'section', label: g });
      const mine = list.filter(r => keyOf(r) === g).map(line);
      if (by === 'timesheet') {
        for (const d of [...new Set(mine.map(l => l.cells.date))]) {
          const day = mine.filter(l => l.cells.date === d);
          out.push(...day, { kind: 'total', label: `Total for ${d}`, cells: { hours: hours(day), amount: day.reduce((s, l) => s + l.cells.amount, 0) } });
        }
      } else out.push(...mine);
      out.push({ kind: 'total', label: `Total for ${g}`, cells: { hours: hours(mine), amount: mine.reduce((s, l) => s + l.cells.amount, 0) } });
    }
  }
  const all = list.map(line);
  if (all.length) out.push({ kind: 'total', label: 'Total', grand: true, cells: { hours: hours(all), amount: all.reduce((s, l) => s + l.cells.amount, 0) } });
  return { rows: out, columns, totalMinutes: all.reduce((s, l) => s + l.minutes, 0) };
}

// Recurring Template List: every customer and vendor template with its schedule and amount.
export async function recurringList(db, { orgId, entityId, show = 'active' }) {
  const { rows } = await db.query(
    `SELECT r.template_id, r.name, r.txn_type, r.mode, r.interval_unit, r.interval_count, r.next_run_date::text AS next, r.end_date::text AS end_date, r.active,
            r.customer_id, r.vendor_id, coalesce(c.display_name, v.display_name) AS party,
            coalesce((SELECT sum(amount_cents) FROM recurring_template_line l WHERE l.template_id = r.template_id), 0)::bigint AS amount
       FROM recurring_template r LEFT JOIN customer c ON c.customer_id = r.customer_id LEFT JOIN vendor v ON v.vendor_id = r.vendor_id
      WHERE r.org_id = $1 AND r.entity_id = $2 ${show === 'all' ? '' : 'AND r.active'} ORDER BY lower(r.name)`, [orgId, entityId]);
  const every = r => `Every ${r.interval_count > 1 ? `${r.interval_count} ` : ''}${r.interval_unit}${r.interval_count > 1 ? 's' : ''}`;
  const out = rows.map(r => ({ kind: 'line', href: r.vendor_id ? `/vrecurring/${r.template_id}` : `/recurring/${r.template_id}/edit`, cells: {
    name: r.name, type: TYPE_LABELS[r.txn_type] ?? r.txn_type, party: r.party ?? '', mode: r.mode === 'scheduled' ? 'Scheduled' : r.mode === 'reminder' ? 'Reminder' : (r.mode ?? ''),
    every: every(r), next: r.active ? (r.next ?? '') : 'Paused', end: r.end_date ?? '', amount: Number(r.amount) } }));
  return { rows: out, columns: [{ key: 'name', label: 'Template' }, { key: 'type', label: 'Transaction type' }, { key: 'party', label: 'Customer/Vendor' },
    { key: 'mode', label: 'Type' }, { key: 'every', label: 'Interval' }, { key: 'next', label: 'Next date' }, { key: 'end', label: 'Ends' }, { key: 'amount', label: 'Amount', money: true }] };
}

// Reconciliation Reports: each finished reconciliation, linking to its PDF report.
export async function reconciliationList(db, { orgId, entityId, from, to, accountsById }) {
  const { rows } = await db.query(
    `SELECT r.rec_id, r.account_id, r.statement_date::text AS date, r.beginning_cents::bigint AS beginning, r.ending_cents::bigint AS ending,
            r.completed_at, r.completed_by, (SELECT count(*) FROM reconciled_item i WHERE i.rec_id = r.rec_id)::int AS items
       FROM reconciliation r WHERE r.org_id = $1 AND r.entity_id = $2 AND ($3::date IS NULL OR r.statement_date >= $3::date) AND r.statement_date <= $4::date
      ORDER BY r.account_id, r.statement_date DESC`, [orgId, entityId, from, to]);
  return { rows: rows.map(r => ({ kind: 'line', href: `/reconcile/report/${r.rec_id}.pdf`, cells: { date: r.date,
    account: accountsById.get(Number(r.account_id)) ? accountLabel(accountsById.get(Number(r.account_id))) : '', items: String(r.items),
    finished: r.completed_at ? `${new Date(r.completed_at).toISOString().slice(0, 10)}${r.completed_by ? ` by ${r.completed_by}` : ''}` : '',
    beginning: Number(r.beginning), ending: Number(r.ending) } })),
  columns: [{ key: 'date', label: 'Statement date' }, { key: 'account', label: 'Account' }, { key: 'items', label: 'Cleared' }, { key: 'finished', label: 'Finished' },
    { key: 'beginning', label: 'Beginning balance', money: true, noTotal: true }, { key: 'ending', label: 'Ending balance', money: true, noTotal: true }] };
}

// Bill Approval Status: bills in the period with where each stands in approval.
export async function billApprovalStatus(db, { orgId, entityId, from, to, vendors }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, t.doc_number, t.due_date::text AS due, t.approval_status, t.approved_by, t.approved_at, t.rejected_reason,
            t.total_cents::bigint AS total, t.vendor_id, v.display_name
       FROM txn t JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'bill' AND t.voided_at IS NULL AND ${range}
      ORDER BY (t.approval_status = 'awaiting') DESC, t.txn_date, t.txn_id`, [orgId, entityId, from, to]);
  const STATUS = { awaiting: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected' };
  const out = rows.filter(r => want(vendors, r.vendor_id)).map(r => docLine(r, { date: r.date, num: r.doc_number ?? '', name: r.display_name, due: r.due ?? '',
    status: STATUS[r.approval_status] ?? '', by: r.approved_by ? `${r.approved_by}${r.approved_at ? `, ${new Date(r.approved_at).toISOString().slice(0, 10)}` : ''}` : r.rejected_reason ?? '',
    amount: Number(r.total) }));
  if (out.length) out.push({ kind: 'total', label: 'Total', grand: true, cells: { amount: out.reduce((s, r) => s + r.cells.amount, 0) } });
  return { rows: out, columns: [{ key: 'date', label: 'Date' }, { key: 'num', label: 'No.' }, { key: 'name', label: 'Vendor' }, { key: 'due', label: 'Due date' },
    { key: 'status', label: 'Approval' }, { key: 'by', label: 'Approved by / reason' }, { key: 'amount', label: 'Amount', money: true }] };
}

// Invalid Journal Transactions: anything whose ledger lines don't balance, that posts to an inactive account, or whose
// A/R or A/P lines have no customer or vendor. A healthy company shows none.
export async function invalidTransactions(db, { orgId, entityId, from, to }) {
  const { rows } = await db.query(
    `WITH p AS (
       SELECT t.txn_id, t.type, t.txn_date::text AS date, coalesce(t.doc_number, t.payment_ref) AS num, sum(p.amount_cents)::bigint AS net,
              bool_or(NOT a.active) AS inactive,
              bool_or((a.system_key = 'ar' AND p.customer_id IS NULL) OR (a.system_key = 'ap' AND coalesce(p.vendor_id, t.vendor_id) IS NULL)) AS orphan
         FROM txn t JOIN posting p ON p.txn_id = t.txn_id JOIN account a ON a.account_id = p.account_id
        WHERE t.org_id = $1 AND t.entity_id = $2 AND ${range} GROUP BY t.txn_id)
     SELECT * FROM p WHERE net <> 0 OR inactive OR orphan ORDER BY date, txn_id`, [orgId, entityId, from, to]);
  return { rows: rows.map(r => docLine(r, { date: r.date, type: TYPE_LABELS[r.type], num: r.num ?? '',
    problem: [Number(r.net) !== 0 ? `Out of balance by ${Number(r.net)} cents` : '', r.inactive ? 'Uses an inactive account' : '',
      r.orphan ? 'A/R or A/P line without a customer or vendor' : ''].filter(Boolean).join('; ') })),
  columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' }, { key: 'problem', label: 'Problem' }] };
}
