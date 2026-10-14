import { withTransaction } from '../db.js';
import { ensureSystemAccounts, repost } from './ledger.js';
import { writeAdjustment } from './inventory.js';
import { writeVendorDoc } from './payables.js';

// Removes an org and everything under it (dependency order).
export async function deleteOrg(client, slug) {
  const { rows } = await client.query('SELECT org_id FROM org WHERE slug = $1', [slug]);
  if (!rows.length) return;
  const id = rows[0].org_id;
  await client.query('UPDATE account SET parent_id = NULL WHERE org_id = $1', [id]);
  for (const table of ['email_settings', 'bill_settings', 'vendor_info_request', 'message', 'statement', 'document', 'activity_event', 'late_fee_charge', 'late_fee_policy', 'recurring_run', 'recurring_template_line',
    'application', 'deposit_line', 'posting', 'txn_line', 'txn', 'recurring_template', 'project', 'customer', 'vendor', 'item', 'account', 'terms', 'entity', 'org']) {
    await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [id]);
  }
}

// Writes a generateSample() result, replacing any existing org with the same slug.
// Returns the database ids keyed by the generator's keys.
// addCompany: add the sample as another company in the existing org (used to prove companies stay apart).
export async function writeSample(pool, sample, { addCompany = false } = {}) {
  return withTransaction(pool, async tx => {
    const one = async (sql, params) => (await tx.query(sql, params)).rows[0];
    let orgId;
    if (addCompany) orgId = (await one('SELECT org_id FROM org WHERE slug = $1', [sample.org.slug])).org_id;
    else {
      await deleteOrg(tx, sample.org.slug);
      orgId = (await one('INSERT INTO org (slug, name) VALUES ($1, $2) RETURNING org_id', [sample.org.slug, sample.org.name])).org_id;
    }
    const e = sample.entity;
    const { entity_id: entityId } = await one(
      'INSERT INTO entity (org_id, name, time_zone, email, phone, address) VALUES ($1, $2, $3, $4, $5, $6) RETURNING entity_id',
      [orgId, e.name, e.time_zone, e.email, e.phone, e.address]);
    const terms = {}, items = {}, customers = {}, txns = {};
    const accounts = { ...(await ensureSystemAccounts(tx, orgId, entityId)) };
    for (const a of sample.accounts ?? []) {
      accounts[a.key] = (await one('INSERT INTO account (org_id, entity_id, name, number, type) VALUES ($1,$2,$3,$4,$5) RETURNING account_id',
        [orgId, entityId, a.name, a.number, a.type])).account_id;
    }
    for (const t of sample.terms) {
      terms[t.key] = (await one('INSERT INTO terms (org_id, entity_id, name, due_days) VALUES ($1, $4, $2, $3) RETURNING terms_id', [orgId, t.name, t.due_days, entityId])).terms_id;
    }
    for (const i of sample.items) {
      items[i.key] = (await one(
        'INSERT INTO item (org_id, entity_id, name, kind, rate_cents, income_account_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING item_id',
        [orgId, entityId, i.name, i.kind, i.rate_cents, i.income ? accounts[i.income] : null])).item_id;
    }
    for (const c of sample.customers) {
      customers[c.key] = (await one(
        `INSERT INTO customer (org_id, entity_id, display_name, company_name, email, phone, mobile, billing_address, shipping_address,
           shipping_same_as_billing, note_line, terms_id, tax_exempt, tax_exempt_reason, preferred_payment_method, preferred_delivery,
           late_fees_enabled, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING customer_id`,
        [orgId, entityId, c.display_name, c.company_name, c.email, c.phone, c.mobile, c.billing_address, c.shipping_address,
          c.shipping_same_as_billing, c.note_line, terms[c.terms], c.tax_exempt, c.tax_exempt_reason, c.preferred_payment_method,
          c.preferred_delivery, c.late_fees_enabled, c.active])).customer_id;
    }
    for (const t of sample.txns) {
      txns[t.key] = (await one(
        `INSERT INTO txn (org_id, entity_id, customer_id, type, doc_number, txn_date, due_date, memo, payment_method, payment_ref,
           total_cents, open_cents, voided_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING txn_id`,
        [orgId, entityId, customers[t.customer], t.type, t.doc_number, t.txn_date, t.due_date, t.memo, t.payment_method, t.payment_ref,
          t.total_cents, t.open_cents, t.voided ? `${t.txn_date}T17:00:00Z` : null, `${t.txn_date}T15:00:00Z`])).txn_id;
    }
    for (const l of sample.lines) {
      await tx.query(
        `INSERT INTO txn_line (org_id, txn_id, line_no, item_id, description, quantity, rate_cents, amount_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orgId, txns[l.txn], l.line_no, items[l.item], l.description, l.quantity, l.rate_cents, l.amount_cents]);
    }
    for (const a of sample.applications) {
      await tx.query(
        'INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1,$2,$3,$4,$5)',
        [orgId, txns[a.credit], txns[a.charge], a.amount_cents, a.applied_on]);
    }
    for (const key of Object.keys(txns)) await repost(tx, orgId, txns[key]);
    const vendors = {};
    for (const v of sample.vendors ?? []) {
      vendors[v.key] = (await one(
        `INSERT INTO vendor (org_id, entity_id, display_name, company_name, email, phone, billing_address, terms_id, account_no,
           default_expense_account_id, track_1099, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING vendor_id`,
        [orgId, entityId, v.display_name, v.company_name, v.email, v.phone, v.billing_address, v.terms ? terms[v.terms] : null, v.account_no,
          v.expense ? accounts[v.expense] : null, v.track_1099, v.notes])).vendor_id;
      await tx.query(`INSERT INTO activity_event (org_id, vendor_id, kind, summary, occurred_at) VALUES ($1,$2,'vendor_created',$3,$4)`,
        [orgId, vendors[v.key], `Vendor ${v.display_name} created`, `${sample.startDate ?? '2025-10-01'}T14:00:00Z`]);
    }
    const byKey = new Map(sample.txns.map(t => [t.key, t]));
    for (const d of sample.deposits ?? []) {
      const sources = d.sources.map(k => byKey.get(k));
      const total = sources.reduce((s, t) => s + t.total_cents, 0);
      const { txn_id: depId } = await one(
        `INSERT INTO txn (org_id, entity_id, type, txn_date, total_cents, open_cents, account_id, created_at)
         VALUES ($1,$2,'deposit',$3,$4,0,$5,$6) RETURNING txn_id`, [orgId, entityId, d.txn_date, total, accounts[d.account], `${d.txn_date}T15:00:00Z`]);
      for (const [i, t] of sources.entries()) {
        await tx.query(
          `INSERT INTO deposit_line (org_id, deposit_txn_id, line_no, source_txn_id, customer_id, amount_cents) VALUES ($1,$2,$3,$4,$5,$6)`,
          [orgId, depId, i + 1, txns[t.key], customers[t.customer], t.total_cents]);
      }
      await repost(tx, orgId, depId);
      txns[d.key] = depId;
    }
    for (const d of sample.vendorDocs ?? []) {
      const { txn_id: id } = await one(
        `INSERT INTO txn (org_id, entity_id, vendor_id, type, doc_number, txn_date, due_date, memo, payment_method, total_cents, open_cents, account_id,
           approval_status, approved_by, approved_at, printed_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING txn_id`,
        [orgId, entityId, vendors[d.vendor], d.type, d.doc_number, d.txn_date, d.due_date, d.memo, d.method, d.total_cents, d.open_cents,
          d.account ? accounts[d.account] : null, d.approval, d.approval === 'approved' ? 'operator' : null,
          d.approval === 'approved' ? `${d.txn_date}T18:00:00Z` : null, d.printed ? `${d.txn_date}T19:00:00Z` : null, `${d.txn_date}T16:00:00Z`]);
      for (const [i, l] of d.lines.entries()) {
        await tx.query(`INSERT INTO txn_line (org_id, txn_id, line_no, account_id, description, quantity, rate_cents, amount_cents) VALUES ($1,$2,$3,$4,$5,1,$6,$6)`,
          [orgId, id, i + 1, accounts[l.account], l.description, l.amount_cents]);
      }
      await repost(tx, orgId, id);
      txns[d.key] = id;
    }
    for (const p of sample.billPayments ?? []) {
      const { txn_id: id } = await one(
        `INSERT INTO txn (org_id, entity_id, vendor_id, type, doc_number, txn_date, payment_method, total_cents, open_cents, account_id, printed_at, created_at)
         VALUES ($1,$2,$3,'bill_payment',$4,$5,$6,$7,0,$8,$9,$10) RETURNING txn_id`,
        [orgId, entityId, vendors[p.vendor], p.doc_number, p.txn_date, p.method, p.total_cents, accounts[p.account],
          p.printed ? `${p.txn_date}T19:00:00Z` : null, `${p.txn_date}T17:00:00Z`]);
      for (const a of p.applies) {
        await tx.query('INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1,$2,$3,$4,$5)',
          [orgId, id, txns[a.bill], a.amount_cents, p.txn_date]);
      }
      await repost(tx, orgId, id);
      txns[p.key] = id;
    }
    const inv = sample.inventory;
    if (inv) {
      for (const i of inv.items) {
        items[i.key] = (await one(
          `INSERT INTO item (org_id, entity_id, name, kind, rate_cents, purchase_cost_cents, sku, reorder_point, income_account_id)
           VALUES ($1,$2,$3,'inventory',$4,$5,$6,$7,$8) RETURNING item_id`,
          [orgId, entityId, i.name, i.rate_cents, i.cost_cents, i.sku, i.reorder, accounts[i.income]])).item_id;
        await writeAdjustment(tx, { orgId, entityId, itemId: items[i.key], txnDate: i.as_of, actor: 'system', memo: `Opening quantity for ${i.name}`,
          opening: { qty: BigInt(i.start_qty) * 10_000n, valueCents: i.start_qty * i.cost_cents } });
      }
      const doc = (type, d) => writeVendorDoc(tx, { orgId, entityId, actor: 'system', type, vendorId: vendors[d.vendor], txnDate: d.txn_date, dueDate: d.expected ?? null,
        docNumber: d.doc_number ?? '', itemLines: d.lines.map(l => ({ itemId: String(items[l.item]), quantity: l.qty, rate: l.rate, description: '' })), categoryLines: [] });
      txns['purchase-order'] = await doc('purchase_order', inv.purchaseOrder);
      txns['item-receipt'] = await doc('item_receipt', inv.itemReceipt);
    }
    for (const ev of sample.activity) {
      await tx.query(
        'INSERT INTO activity_event (org_id, customer_id, txn_id, kind, summary, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [orgId, customers[ev.customer], ev.txn ? txns[ev.txn] : null, ev.kind, ev.summary, ev.occurred_at]);
    }
    return { orgId, entityId, terms, items, customers, txns, accounts, vendors };
  });
}
