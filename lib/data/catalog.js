import { formId } from '../domain/ids.js';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from './writes.js';
import { repost } from './ledger.js';
import { writeAdjustment } from './inventory.js';
import { parseMoney } from '../domain/money.js';
import { parseQuantity, quantityToSql, lineAmount } from '../domain/lines.js';
import { isIsoDate } from '../domain/dates.js';

// Settings → Terms and Settings → Products & services.

const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
const unique = (error, message) => { if (error?.code === '23505') fail(message); throw error; };

export async function listTermsWithUse(pool, { orgId, entityId }) {
  const { rows } = await pool.query(
    `SELECT t.terms_id, t.name, t.due_days,
            (SELECT count(*) FROM customer c WHERE c.org_id = t.org_id AND c.terms_id = t.terms_id)::int AS customers,
            (SELECT count(*) FROM recurring_template r WHERE r.org_id = t.org_id AND r.terms_id = t.terms_id)::int AS templates
       FROM terms t WHERE t.org_id = $1 AND t.entity_id = $2 ORDER BY t.due_days, t.name`, [orgId, entityId]);
  return rows;
}

export async function saveTerms(pool, { orgId, entityId, termsId = null, name, dueDays }) {
  const n = text(name, 60);
  if (!n) fail('Enter a name for the terms, like “Net 30”.');
  const days = /^\d{1,3}$/.test(String(dueDays ?? '').trim()) ? Number(dueDays) : NaN;
  if (!(days >= 0 && days <= 365)) fail('Days until due must be 0 to 365.');
  try {
    if (termsId) {
      const { rowCount } = await pool.query('UPDATE terms SET name = $3, due_days = $4 WHERE org_id = $1 AND terms_id = $2 AND entity_id = $5', [orgId, termsId, n, days, entityId]);
      if (!rowCount) fail('Terms not found.');
      return termsId;
    }
    return (await pool.query('INSERT INTO terms (org_id, entity_id, name, due_days) VALUES ($1, $4, $2, $3) RETURNING terms_id', [orgId, n, days, entityId])).rows[0].terms_id;
  } catch (error) { unique(error, `Terms named “${n}” already exist.`); }
}

export async function deleteTerms(pool, { orgId, entityId, termsId }) {
  const [t] = (await listTermsWithUse(pool, { orgId, entityId })).filter(x => x.terms_id === termsId);
  if (!t) fail('Terms not found.');
  if (t.customers || t.templates) fail(`“${t.name}” is used by ${t.customers} customer${t.customers === 1 ? '' : 's'}${t.templates ? ` and ${t.templates} recurring template${t.templates === 1 ? '' : 's'}` : ''}. Change those first.`);
  await pool.query('DELETE FROM terms WHERE org_id = $1 AND terms_id = $2 AND entity_id = $3', [orgId, termsId, entityId]);
  return t.name;
}

export async function listAllItems(pool, { orgId, entityId }) {
  const { rows } = await pool.query(
    `SELECT i.item_id, i.name, i.sku, i.description, i.kind, i.rate_cents, i.active, i.qty_on_hand, i.value_cents, i.reorder_point,
            (i.kind = 'inventory' AND i.reorder_point IS NOT NULL AND i.qty_on_hand <= i.reorder_point) AS low,
            a.name AS income_account_name FROM item i
       LEFT JOIN account a ON a.account_id = i.income_account_id
      WHERE i.org_id = $1 AND i.entity_id = $2 AND i.kind <> 'system' ORDER BY i.active DESC, lower(i.name)`, [orgId, entityId]);
  return rows;
}

export async function getItem(pool, { orgId, entityId, itemId }) {
  const { rows } = await pool.query(`SELECT * FROM item WHERE org_id = $1 AND entity_id = $2 AND item_id = $3 AND kind <> 'system'`, [orgId, entityId, itemId]);
  return rows[0] ?? null;
}

const KINDS = ['product', 'service', 'inventory'];

// fields: { name, description, kind, rate, active, incomeAccountId, expenseAccountId, cost, sku, reorderPoint, assetAccountId,
// startQty, asOf } as form strings/booleans. Items are never deleted (old transactions point at them); make them inactive.
// A new inventory item with a starting quantity gets an opening-stock adjustment valued at the purchase cost.
export async function saveItem(pool, args) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, args.orgId, args.entityId);
    return saveItemTx(tx, args);
  });
}

// Caller owns the transaction and company lock.
export async function saveItemTx(tx, { orgId, entityId, itemId = null, fields: f, actor = 'operator' }) {
  const name = text(f.name, 100);
  if (!name) fail('Enter a name for the product or service.');
  const kind = KINDS.includes(f.kind) ? f.kind : 'product';
  const rateText = String(f.rate ?? '').trim();
  const rate = rateText === '' ? 0 : parseMoney(rateText);
  if (rate === null) fail('The price should be an amount like 12.50.');
  const costText = String(f.cost ?? '').trim();
  const cost = costText === '' ? null : parseMoney(costText);
  if (costText !== '' && cost === null) fail('The purchase cost should be an amount like 8.25.');
  const inventory = kind === 'inventory';
  let reorder = null, startQty = null;
  if (inventory && String(f.reorderPoint ?? '').trim()) {
    reorder = parseQuantity(String(f.reorderPoint).trim()) ?? fail('The reorder point should be a quantity like 20.');
  }
  if (inventory && String(f.startQty ?? '').trim() && String(f.startQty).trim() !== '0') {
    startQty = parseQuantity(String(f.startQty).trim()) ?? fail('The starting quantity should be a number like 40.');
    if (!isIsoDate(String(f.asOf ?? ''))) fail('Enter the date the starting quantity is as of.');
    if (cost === null) fail('Enter the purchase cost so the starting quantity can be valued.');
  }
  const sku = inventory ? text(f.sku, 60) : null;
  const checkAccount = async (id, types, message) => {
    if (id === null) return null;
    const a = await tx.query('SELECT 1 FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active AND type = ANY($4)', [orgId, entityId, id, types]);
    if (!a.rowCount) fail(message);
    return id;
  };
  const incomeAccountId = await checkAccount(formId(f.incomeAccountId, () => fail('One of the choices isn’t valid. Reload the page and try again.')), ['income', 'other_income'], 'Choose an income account.');
  const expenseAccountId = await checkAccount(formId(f.expenseAccountId, () => fail('One of the choices isn’t valid. Reload the page and try again.')), ['cost_of_goods_sold', 'expense', 'other_expense'],
    'Choose an expense or cost of goods sold account for purchases.');
  const assetAccountId = inventory ? await checkAccount(formId(f.assetAccountId, () => fail('One of the choices isn’t valid. Reload the page and try again.')), ['inventory', 'other_current_asset'],
    'Choose an inventory asset account.') : null;
  let existing = null;
  if (itemId) {
    existing = (await tx.query(`SELECT * FROM item WHERE org_id = $1 AND entity_id = $2 AND item_id = $3 AND kind <> 'system' FOR UPDATE`, [orgId, entityId, itemId])).rows[0]
      ?? fail('Product or service not found.');
    if ((existing.kind === 'inventory') !== inventory) {
      const used = await tx.query('SELECT 1 FROM txn_line WHERE org_id = $1 AND item_id = $2 LIMIT 1', [orgId, itemId]);
      if (used.rowCount) {
        fail(inventory ? 'This product is already on transactions, so it can’t start tracking quantity. Create a new inventory item instead.'
          : 'This item has inventory history, so it can’t stop being tracked. Make it inactive instead.');
      }
    }
  }
  const values = [name, text(f.description, 500), kind, rate, existing ? f.active !== false : true, incomeAccountId, expenseAccountId, cost, sku,
    reorder === null ? null : quantityToSql(reorder), assetAccountId];
  try {
    if (existing) {
      await tx.query(
        `UPDATE item SET name = $4, description = $5, kind = $6, rate_cents = $7, active = $8, income_account_id = $9, expense_account_id = $10,
                purchase_cost_cents = $11, sku = $12, reorder_point = $13, asset_account_id = $14
          WHERE org_id = $1 AND entity_id = $2 AND item_id = $3`, [orgId, entityId, itemId, ...values]);
      // A new asset or cost account changes where the stock is carried: repost the item's history.
      if (inventory && (existing.asset_account_id !== assetAccountId || existing.expense_account_id !== expenseAccountId)) {
        const { rows } = await tx.query('SELECT DISTINCT txn_id FROM txn_line WHERE org_id = $1 AND item_id = $2', [orgId, itemId]);
        for (const r of rows) await repost(tx, orgId, r.txn_id, { replay: false });
      }
    } else {
      itemId = (await tx.query(
        `INSERT INTO item (org_id, entity_id, name, description, kind, rate_cents, active, income_account_id, expense_account_id, purchase_cost_cents,
           sku, reorder_point, asset_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING item_id`, [orgId, entityId, ...values])).rows[0].item_id;
      if (startQty) {
        await writeAdjustment(tx, { orgId, entityId, itemId, txnDate: f.asOf, actor, memo: `Opening quantity for ${name}`,
          opening: { qty: startQty, valueCents: lineAmount(startQty, cost) } });
      }
    }
  } catch (error) {
    if (error?.code === '23505') fail(/sku/.test(error.constraint ?? '') ? `SKU ${sku} is already used.` : `A product or service named “${name}” already exists.`);
    throw error;
  }
  return itemId;
 }
