import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { withTransaction } from '../lib/db.js';
import { replayItems, adjustQuantity } from '../lib/data/inventory.js';
import { repost, ledgerCheck } from '../lib/data/ledger.js';

// Scale (before loading real 2026 data): a stocked item with thousands of sales, then a back-dated cost change.
// The inventory replay must finish quickly, and its batched reposting must write exactly what reposting one transaction
// at a time writes.
const SALES = 3000;
let app, S, item, customer;
before(async () => {
  app = await startApp();
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  ({ rows: [item] } = await app.db.pool.query(`SELECT item_id, name FROM item WHERE entity_id = $1 AND kind = 'inventory'
    AND EXISTS (SELECT 1 FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id WHERE l.item_id = item.item_id AND t.type IN ('bill', 'item_receipt')) LIMIT 1`, [S.entityId]));
  customer = Object.values(app.ids.customers)[0];
});
after(async () => { await app.close(); });

const postingsOf = async (ids) => (await app.db.pool.query(`SELECT txn_id, account_id, amount_cents, coalesce(item_id, 0) AS item_id FROM posting
  WHERE txn_id = ANY($1::bigint[]) ORDER BY txn_id, account_id, amount_cents, item_id`, [ids])).rows;

test(`${SALES} sales of one stocked item, then a back-dated cost change: fast, and the same as one at a time`, async () => {
  assert.ok(item, 'the sample has a stocked item with purchases');
  const pool = app.db.pool;
  // Plenty in stock first: 10,000 units at $5.00 at the start of the year.
  await adjustQuantity(pool, { ...S, itemId: item.item_id, txnDate: '2025-12-31', opening: { qty: 10000n * 10000n, valueCents: 5_000_000 }, actor: 'test' });
  // Thousands of small cash sales spread over 2026 (rows straight into the tables; postings come from the replay).
  const { rows: made } = await pool.query(`
    WITH s AS (
      INSERT INTO txn (org_id, entity_id, type, txn_date, total_cents, open_cents, customer_id, doc_number)
      SELECT $1, $2, 'sales_receipt', DATE '2026-01-01' + (g % 280), 1500, 0, $3, 'SCALE-' || g FROM generate_series(1, $4) g
      RETURNING txn_id)
    SELECT txn_id FROM s`, [S.orgId, S.entityId, customer, SALES]);
  const ids = made.map(r => Number(r.txn_id));
  await pool.query(`INSERT INTO txn_line (org_id, txn_id, line_no, item_id, quantity, rate_cents, amount_cents, description)
    SELECT $1, x, 1, $2, 1, 1500, 1500, 'scale test' FROM unnest($3::bigint[]) x`, [S.orgId, item.item_id, ids]);
  let t0 = Date.now();
  await withTransaction(pool, tx => replayItems(tx, S.orgId, [item.item_id]));
  const first = Date.now() - t0;
  // A back-dated change: the opening stock was worth more, so every later sale's cost changes.
  const { rows: [buy] } = await pool.query(`SELECT t.txn_id, l.line_no FROM txn t JOIN txn_line l ON l.txn_id = t.txn_id
    WHERE t.system_kind = 'opening_quantity' AND l.item_id = $1 AND t.txn_date = '2025-12-31'`, [item.item_id]);
  await pool.query('UPDATE txn_line SET amount_cents = amount_cents + 500000 WHERE txn_id = $1 AND line_no = $2', [buy.txn_id, buy.line_no]);
  await pool.query('UPDATE txn SET total_cents = total_cents + 500000 WHERE txn_id = $1', [buy.txn_id]);
  const costOf = async () => Number((await pool.query('SELECT cost_cents FROM txn_line WHERE txn_id = $1', [ids.at(-1)])).rows[0].cost_cents);
  const before = await costOf();
  t0 = Date.now();
  await withTransaction(pool, async tx => { await repost(tx, S.orgId, buy.txn_id); });
  const again = Date.now() - t0;
  const { rows: [{ n }] } = await pool.query('SELECT count(DISTINCT p.txn_id)::int AS n FROM posting p WHERE p.txn_id = ANY($1::bigint[]) AND p.item_id IS NOT NULL', [ids]);
  assert.equal(n, SALES, 'every sale has its cost of goods posted');
  assert.notEqual(await costOf(), before, 'the last sale’s cost changed');
  console.log(`replay of ${SALES} sales: first ${first} ms, back-dated change ${again} ms`);
  assert.ok(first < 30_000 && again < 30_000, `took ${first} / ${again} ms`);
  // Batched postings = one-at-a-time postings.
  const sample = ids.filter((_, i) => i % 97 === 0);
  const batched = await postingsOf(sample);
  assert.ok(batched.length >= sample.length * 3, 'sales post income, payment and cost of goods');
  await withTransaction(pool, async tx => { for (const id of sample) await repost(tx, S.orgId, id, { replay: false }); });
  assert.deepEqual(await postingsOf(sample), batched);
  const check = await ledgerCheck(pool, S);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
});
