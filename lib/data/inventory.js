import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from './writes.js';
import { repost, repostMany, systemAccounts } from './ledger.js';
import { replay, MOVE_FOR_TYPE, MOVE_ORDER } from '../domain/inventory.js';
import { isIsoDate } from '../domain/dates.js';

const fail = message => { throw new ValidationError(message); };
const SCALE = 10_000n;
const MOVE_TYPES = Object.keys(MOVE_FOR_TYPE);

// numeric(14,4) text ("-12.5000") -> BigInt scaled by 10^4.
export function scaled(text) {
  const m = /^(-)?(\d+)(?:\.(\d{1,4}))?/.exec(String(text ?? '0').trim());
  if (!m) return 0n;
  const v = BigInt(m[2]) * SCALE + BigInt((m[3] ?? '').padEnd(4, '0'));
  return m[1] ? -v : v;
}
export const scaledToSql = q => {
  const neg = q < 0n, a = neg ? -q : q;
  return `${neg ? '-' : ''}${a / SCALE}.${String(a % SCALE).padStart(4, '0')}`;
};

// Asset and cost-of-goods accounts for the inventory items among `itemIds`.
export async function inventoryAccounts(db, { orgId, entityId, itemIds }) {
  if (!itemIds.length) return new Map();
  const sys = await systemAccounts(db, orgId, entityId);
  const { rows } = await db.query(
    `SELECT item_id, asset_account_id, expense_account_id FROM item WHERE org_id = $1 AND item_id = ANY($2) AND kind = 'inventory'`, [orgId, itemIds]);
  return new Map(rows.map(r => [r.item_id, { asset: r.asset_account_id ?? sys.inventory, cogs: r.expense_account_id ?? sys.cogs }]));
}

// Inventory items a transaction touches now (its lines) or touched when last posted (its postings).
export async function itemsTouching(tx, orgId, txnId) {
  const { rows } = await tx.query(
    `SELECT DISTINCT i.item_id FROM item i
      WHERE i.org_id = $1 AND i.kind = 'inventory'
        AND (EXISTS (SELECT 1 FROM txn_line l WHERE l.txn_id = $2 AND l.item_id = i.item_id)
          OR EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = $2 AND p.item_id = i.item_id))`, [orgId, txnId]);
  return rows.map(r => r.item_id);
}

// Recomputes each item's average cost through its whole history: line costs, on-hand quantity and value.
// Transactions whose cost changed are reposted (except `skip`, which the caller is posting itself).
export async function replayItems(tx, orgId, itemIds, { skip = null } = {}) {
  const changedTxns = new Set();
  for (const itemId of itemIds) {
    const { rows } = await tx.query(
      `SELECT l.txn_id, l.line_no, l.quantity, l.qty_change, l.amount_cents, l.cost_cents, t.type, t.txn_date, t.system_kind
         FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id
        WHERE l.org_id = $1 AND l.item_id = $2 AND t.voided_at IS NULL AND t.type = ANY($3)`, [orgId, itemId, MOVE_TYPES]);
    const moves = rows.map(r => {
      const kind = MOVE_FOR_TYPE[r.type];
      return { key: `${r.txn_id}:${r.line_no}`, kind, row: r, txnDate: r.txn_date, txnId: r.txn_id, lineNo: r.line_no,
        qty: kind === 'adjust' ? scaled(r.qty_change) : scaled(r.quantity),
        amountCents: kind === 'adjust' ? (r.system_kind === 'opening_quantity' ? Number(r.amount_cents) : null) : Number(r.amount_cents) };
    }).sort((a, b) => (a.txnDate < b.txnDate ? -1 : a.txnDate > b.txnDate ? 1 : MOVE_ORDER[a.kind] - MOVE_ORDER[b.kind] || a.txnId - b.txnId || a.lineNo - b.lineNo));
    const { costs, qty, value } = replay(moves);
    const changed = moves.filter(m => Number(m.row.cost_cents ?? NaN) !== costs.get(m.key));
    if (changed.length) {
      // One statement for every changed cost, then the adjustments' totals.
      await tx.query(`UPDATE txn_line l SET cost_cents = x.cost FROM jsonb_to_recordset($1::jsonb) AS x(txn_id bigint, line_no int, cost bigint)
        WHERE l.txn_id = x.txn_id AND l.line_no = x.line_no`, [JSON.stringify(changed.map(m => ({ txn_id: m.txnId, line_no: m.lineNo, cost: costs.get(m.key) })))]);
      const adjusts = [...new Set(changed.filter(m => m.kind === 'adjust').map(m => m.txnId))];
      if (adjusts.length) {
        await tx.query(`UPDATE txn t SET total_cents = (SELECT coalesce(sum(abs(cost_cents)), 0) FROM txn_line WHERE txn_id = t.txn_id) WHERE t.txn_id = ANY($1::bigint[])`, [adjusts]);
      }
      for (const m of changed) changedTxns.add(m.txnId);
    }
    await tx.query('UPDATE item SET qty_on_hand = $2, value_cents = $3 WHERE item_id = $1', [itemId, scaledToSql(qty), value]);
  }
  await repostMany(tx, orgId, [...changedTxns].filter(id => id !== skip));
}

// Run a delete (or anything that removes lines) and then bring its items' costs up to date.
export async function withInventoryReplay(tx, orgId, txnId, fn) {
  const items = await itemsTouching(tx, orgId, txnId);
  const result = await fn();
  if (items.length) await replayItems(tx, orgId, items);
  return result;
}

// ---- quantity adjustments ----

// One item: set the new quantity on hand (or the change), as of a date, against an account (Inventory Shrinkage by default).
// opening: { qty, valueCents } instead creates the item's opening stock at that value against Opening Balance Equity.
export async function adjustQuantity(pool, { orgId, entityId, itemId, txnDate, newQty = null, change = null, accountId = null, memo = '', actor, opening = null }) {
  if (!isIsoDate(txnDate)) fail('Enter the date of the adjustment.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    return writeAdjustment(tx, { orgId, entityId, itemId, txnDate, newQty, change, accountId, memo, actor, opening });
  });
}

export async function writeAdjustment(tx, { orgId, entityId, itemId, txnDate, newQty = null, change = null, accountId = null, memo = '', actor, opening = null }) {
  const item = (await tx.query(`SELECT * FROM item WHERE org_id = $1 AND entity_id = $2 AND item_id = $3 AND kind = 'inventory'`, [orgId, entityId, itemId])).rows[0]
    ?? fail('Only inventory items can be adjusted.');
  const sys = await systemAccounts(tx, orgId, entityId);
  let delta;
  if (opening) delta = opening.qty;
  else if (newQty !== null) {
    // Quantity on hand as of the adjustment date (later transactions don't count).
    const { rows: [r] } = await tx.query(
      `SELECT coalesce(sum(CASE WHEN t.type IN ('invoice', 'sales_receipt', 'vendor_credit', 'cc_credit') THEN -l.quantity
                                WHEN t.type = 'inventory_adjustment' THEN l.qty_change ELSE l.quantity END), 0)::text AS q
         FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id
        WHERE l.org_id = $1 AND l.item_id = $2 AND t.voided_at IS NULL AND t.type = ANY($3) AND t.txn_date <= $4`, [orgId, itemId, MOVE_TYPES, txnDate]);
    delta = newQty - scaled(r.q);
  } else delta = change;
  if (delta === null || delta === undefined || delta === 0n) fail('The quantity didn’t change.');
  const account = opening ? sys.opening_equity : (accountId ?? sys.shrinkage);
  const a = (await tx.query('SELECT 1 FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active', [orgId, entityId, account])).rowCount;
  if (!a) fail('Choose the account to record the adjustment against.');
  const { rows: [t] } = await tx.query(
    `INSERT INTO txn (org_id, entity_id, type, txn_date, memo, total_cents, open_cents, account_id, system_kind)
     VALUES ($1,$2,'inventory_adjustment',$3,$4,$5,0,$6,$7) RETURNING txn_id`,
    [orgId, entityId, txnDate, String(memo ?? '').trim().slice(0, 500) || null, opening ? Math.abs(opening.valueCents) : 0, account, opening ? 'opening_quantity' : null]);
  await tx.query(
    `INSERT INTO txn_line (org_id, txn_id, line_no, item_id, description, quantity, rate_cents, amount_cents, qty_change)
     VALUES ($1,$2,1,$3,$4,$5,0,$6,$7)`,
    [orgId, t.txn_id, itemId, opening ? 'Opening quantity' : 'Quantity adjustment', scaledToSql(delta < 0n ? -delta : delta), opening ? opening.valueCents : 0, scaledToSql(delta)]);
  await repost(tx, orgId, t.txn_id);
  const { rows: [after] } = await tx.query('SELECT qty_on_hand, value_cents FROM item WHERE item_id = $1', [itemId]);
  const { rows: [moved] } = await tx.query('SELECT cost_cents FROM txn_line WHERE txn_id = $1', [t.txn_id]);
  return { txnId: t.txn_id, delta, costCents: Number(moved.cost_cents ?? 0), qtyOnHand: after.qty_on_hand, valueCents: after.value_cents, item };
}

// What's on hand: per item quantity, value, average cost, low-stock flag.
export async function inventorySummary(db, { orgId, entityId }) {
  const { rows } = await db.query(
    `SELECT item_id, name, sku, qty_on_hand, value_cents, reorder_point, active,
            (reorder_point IS NOT NULL AND qty_on_hand <= reorder_point) AS low
       FROM item WHERE org_id = $1 AND entity_id = $2 AND kind = 'inventory' ORDER BY lower(name)`, [orgId, entityId]);
  return rows;
}

export async function itemHistory(db, { orgId, itemId, limit = 200 }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.doc_number, t.txn_date, t.voided_at, l.quantity, l.qty_change, l.amount_cents, l.cost_cents,
            c.display_name AS customer_name, v.display_name AS vendor_name
       FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE l.org_id = $1 AND l.item_id = $2 AND t.type = ANY($3)
      ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT $4`, [orgId, itemId, MOVE_TYPES, limit]);
  return rows;
}

