// test/tax-t3-migration.test.js — migration 066 on its own (raw SQL, no module): the T3 tables exist; a revision is working-only and never
// changed or deleted; every row sits on an open Form 1065 or 1120-S period and names only that company's transactions, accounts and
// activities; malformed rows are refused; the FKs T1 and T2 left for revisions are in place.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, activity } from './tax-t2-fixtures.js';

let t, pool, orgId, C, ret, txn, other;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  C = { orgId, entityId: await company(pool, orgId, 'Oak Partners') };
  ret = await period(pool, C, 2025, 'form_1065', { taxMethod: 'accrual' });
  txn = await je(pool, C, '2025-02-01', [[await acct(pool, C, 'Checking'), 100], [await acct(pool, C, 'Services'), -100]]);
  other = { orgId, entityId: await company(pool, orgId, 'Oak Other Co') };
  other.ret = await period(pool, other, 2025, 'form_1065');
  other.txn = await je(pool, other, '2025-02-01', [[await acct(pool, other, 'Checking'), 100], [await acct(pool, other, 'Services'), -100]]);
  other.act = await activity(pool, other, { name: 'Oak other trade' });
  other.account = await acct(pool, other, 'Checking');
});
after(async () => { await t.db.drop(); });
const q = (sql, args) => pool.query(sql, args);
const revision = (kind = 'working', extra = '') => q(`INSERT INTO tax_return_revision (org_id, return_id, revision_no, kind, taken_by, catalog_hash, engine_version, inputs, results, source_detail, dependency_manifest${extra ? ', filed_by' : ''})
  VALUES ($1,$2,$3,$4,'tester',$5,'tax-t3-1','{}','{}','{}','{}'${extra ? ", 'someone'" : ''}) RETURNING revision_id`, [orgId, ret, Math.floor(Math.random() * 1e6) + 1, kind, 'a'.repeat(32)]);

test('the T3 tables and the revision references T1 and T2 left', async () => {
  const { rows } = await q(`SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1) ORDER BY table_name`, [['tax_return_revision', 'book_entry_classification', 'cash_timing_review', 'tax_manual_item',
    'tax_adjustment_group', 'tax_adjustment', 'tax_cogs_workpaper', 'tax_cogs_movement']]);
  assert.equal(rows.length, 8);
  const { rows: fks } = await q(`SELECT conname FROM pg_constraint WHERE conname IN ('tax_baseline_source_revision', 'tax_binding_copied_from_revision') ORDER BY conname`);
  assert.deepEqual(fks.map(f => f.conname), ['tax_baseline_source_revision', 'tax_binding_copied_from_revision']);
});

test('a revision is a working revision, never filed, never changed or deleted', async () => {
  const { rows: [v] } = await revision();
  await assert.rejects(revision('final'), /finalization arrives with stage T4/);
  await assert.rejects(revision('working', 'filed'), /a working revision is not filed/);
  await assert.rejects(q('UPDATE tax_return_revision SET taken_by = $2 WHERE revision_id = $1', [v.revision_id, 'x']), /never changed or deleted/);
  await assert.rejects(q('DELETE FROM tax_return_revision WHERE revision_id = $1', [v.revision_id]), /never changed or deleted/);
});

test('scope: another company’s transaction, account or activity is refused; a disregarded or closed period takes no T3 rows', async () => {
  await assert.rejects(q(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, txn_version, event_version, reviewed_by) VALUES ($1,$2,$3,$4,'related_party_accrual','exclude','v','e','t')`,
    [orgId, ret, C.entityId, other.txn]), /another company/);
  await assert.rejects(q(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, txn_version, event_version, reviewed_by) VALUES ($1,$2,$3,$4,'related_party_accrual','exclude','v','e','t')`,
    [orgId, ret, other.entityId, other.txn]), /own books only/);
  await assert.rejects(q(`INSERT INTO book_entry_classification (org_id, return_id, source_entity_id, txn_id, class, txn_version, reviewed_by) VALUES ($1,$2,$3,$4,'normal','v','t')`,
    [orgId, ret, C.entityId, other.txn]), /another company/);
  await assert.rejects(q(`INSERT INTO tax_cogs_workpaper (org_id, return_id, activity_id, path, treatment, method, lifo, subnormal_writedown, valuation_changed, reviewed_by) VALUES ($1,$2,$3,'reconstruct','inventory_as_booked','cost',false,false,false,'t')`, [orgId, ret, other.act]), /another company/);
  await assert.rejects(q(`INSERT INTO tax_cogs_movement (org_id, return_id, account_id, txn_id, line_no, class, txn_version, reviewed_by) VALUES ($1,$2,$3,$4,1,'purchase','v','t')`, [orgId, ret, other.account, txn]), /another company/);
  const D = { orgId, entityId: await company(pool, orgId, 'Oak Child LLC') };
  const dRet = await period(pool, D, 2025, 'disregarded');
  await assert.rejects(q(`INSERT INTO tax_manual_item (org_id, return_id, item_key, status, entered_by) VALUES ($1,$2,'answer:k1_inflows','not_applicable','t')`, [orgId, dRet]), /Form 1065 and Form 1120-S returns only/);
  await q(`UPDATE tax_return SET status = 'review' WHERE return_id = $1`, [ret]);
  await assert.rejects(q(`INSERT INTO tax_manual_item (org_id, return_id, item_key, status, entered_by) VALUES ($1,$2,'f1065.p1.5|activity','not_applicable','t')`, [orgId, ret]), /not open/);
  await q(`UPDATE tax_return SET status = 'open' WHERE return_id = $1`, [ret]);
});

test('row shapes: a closing names at least two lines, an entered item exactly one value, a refused or withdrawn adjustment its reason, a person’s adjustment its support', async () => {
  await assert.rejects(q(`INSERT INTO book_entry_classification (org_id, return_id, source_entity_id, txn_id, class, lines, txn_version, reviewed_by) VALUES ($1,$2,$3,$4,'closing',ARRAY[1],'v','t')`, [orgId, ret, C.entityId, txn]), /check constraint/);
  await assert.rejects(q(`INSERT INTO book_entry_classification (org_id, return_id, source_entity_id, txn_id, class, lines, txn_version, reviewed_by) VALUES ($1,$2,$3,$4,'normal',ARRAY[1,2],'v','t')`, [orgId, ret, C.entityId, txn]), /check constraint/);
  await assert.rejects(q(`INSERT INTO tax_manual_item (org_id, return_id, item_key, status, amount_cents, entered_by) VALUES ($1,$2,'f1065.p1.6|activity','not_applicable',5,'t')`, [orgId, ret]), /check constraint/);
  await assert.rejects(q(`INSERT INTO tax_manual_item (org_id, return_id, item_key, status, entered_by) VALUES ($1,$2,'f1065.p1.6|activity','entered','t')`, [orgId, ret]), /check constraint/);
  await assert.rejects(q(`INSERT INTO tax_adjustment_group (org_id, return_id, purpose, source, memo, status, decided_by) VALUES ($1,$2,'other','person','m','accepted','t')`, [orgId, ret]), /check constraint/);
  await assert.rejects(q(`INSERT INTO tax_adjustment_group (org_id, return_id, purpose, source, source_ref, source_version, memo, status, decided_by) VALUES ($1,$2,'meals_50','proposal','k','v','m','rejected','t')`, [orgId, ret]), /check constraint/);
  await assert.rejects(q(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, slot_key, txn_version, event_version, reviewed_by) VALUES ($1,$2,$3,$4,'unrestricted_advance','include','f1065.p1.1a|activity','v','e','t')`,
    [orgId, ret, C.entityId, txn]), /check constraint/);
  await assert.rejects(q(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, txn_version, event_version, reviewed_by) VALUES ($1,$2,$3,$4,'receipt_date','include','v','e','t')`, [orgId, ret, C.entityId, txn]), /check constraint/);
  // A review records the event it decided (applications are not part of the transaction version); inventory purchases are not a review
  // kind (the COGS workpaper states its treatment instead).
  await assert.rejects(q(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, txn_version, reviewed_by) VALUES ($1,$2,$3,$4,'imported_accrual_je','exclude','v','t')`, [orgId, ret, C.entityId, txn]), /event_version/);
  await assert.rejects(q(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, txn_version, event_version, reviewed_by) VALUES ($1,$2,$3,$4,'inventory_purchase','exclude','v','e','t')`, [orgId, ret, C.entityId, txn]), /check constraint/);
  // The COGS workpaper: reconstructed only as inventory counted as booked, at a plain valuation; reviewed lines name their source.
  const act = await activity(pool, C, { name: 'Oak trade' });
  const wp = (path, treatment, method, flags, lines, note) => q(`INSERT INTO tax_cogs_workpaper (org_id, return_id, activity_id, path, treatment, method, lifo, subnormal_writedown, valuation_changed, reviewed_lines, source_note, reviewed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'t')`, [orgId, ret, act, path, treatment, method, ...flags, lines, note]);
  await assert.rejects(wp('reconstruct', 'materials_and_supplies', 'cost', [false, false, false], null, null), /check constraint/);
  await assert.rejects(wp('reconstruct', 'inventory_as_booked', 'cost', [true, false, false], null, null), /check constraint/);
  await assert.rejects(wp('reconstruct', 'inventory_as_booked', 'other', [false, false, false], null, 'x'), /check constraint/);
  await assert.rejects(wp('reviewed', 'materials_and_supplies', 'cost', [false, false, false], '{}', ' '), /check constraint/);
  await wp('reviewed', 'materials_and_supplies', 'cost', [true, false, false], '{}', 'Year-end count sheet');
  const { rows: [g] } = await q(`INSERT INTO tax_adjustment_group (org_id, return_id, purpose, source, memo, evidence, status, decided_by) VALUES ($1,$2,'other','person','m','workpaper','accepted','t') RETURNING group_id`, [orgId, ret]);
  await assert.rejects(q(`INSERT INTO tax_adjustment (org_id, group_id, return_id, slot_key, mode, amount_cents, m1_class) VALUES ($1,$2,$3,'f1065.p1.9|activity','replace',5,'other')`, [orgId, g.group_id, ret]), /check constraint/);
  await assert.rejects(q(`INSERT INTO tax_adjustment (org_id, group_id, return_id, slot_key, amount_cents, m1_class) VALUES ($1,$2,$3,'f1065.p1.9|activity',5,'other')`, [orgId, g.group_id, other.ret]), /another return/);
});
