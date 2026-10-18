// lib/tax/manifest.js
// The CURRENT approved allocation of one source measurement on one return (Codex t2-plan-r3 B2): its binding rows and line attributions
// as saved, and the partition built from them over a fresh measurement. It is the trusted input a packet's manifest is checked against —
// by toPacketParts (the proof rebuilds the partition from these rows) and by T1's packet boundary (lib/tax/providers.js), inside the
// caller's transaction. Reads only; never the partition's own numbers.
import { measureAccounts, measureLines } from './measure.js';
import { buildPartition, routingOf } from './partition.js';

// The saved rows and attributions in buildPartition's shape, in coverage's order (binding id; transaction, line).
export async function approvedOf(db, { orgId, returnId, sourceEntityId, accountId, measurement }) {
  const REFS = 'slot_key, interest_id::text AS interest_id, interest_version, k1_source_id::text AS k1_source_id, k1_source_version';
  const { rows } = await db.query(`SELECT binding_id, target_key, ${REFS}, share_num::text AS n, share_den::text AS d, amount_cents::text AS a, source_version FROM tax_binding
    WHERE org_id = $1 AND return_id = $2 AND source_entity_id = $3 AND account_id = $4 AND measurement = $5 ORDER BY binding_id`, [orgId, returnId, sourceEntityId, accountId, measurement]);
  const { rows: lines } = measurement !== 'activity' ? { rows: [] } : await db.query(`SELECT binding_line_id, txn_id, line_no, amount_cents::text AS a, txn_version, target_key, ${REFS} FROM tax_binding_line
    WHERE org_id = $1 AND return_id = $2 AND source_entity_id = $3 AND account_id = $4 ORDER BY txn_id, line_no`, [orgId, returnId, sourceEntityId, accountId]);
  return {
    rows: rows.map(r => ({ id: Number(r.binding_id), targetKey: r.target_key, routing: routingOf(r), shareNum: r.n, shareDen: r.d, amountCents: r.a, sourceVersion: r.source_version })),
    attributions: lines.map(l => ({ id: Number(l.binding_line_id), txnId: Number(l.txn_id), lineNo: Number(l.line_no), cents: BigInt(l.a), txnVersion: l.txn_version, targetKey: l.target_key, routing: routingOf(l) })),
  };
}
// Every account's saved rows and attributions of one source on one return at once (the engine proves each partition it publishes, T3):
// Map `${accountId}/${measurement}` → approved, in approvedOf's shape and order.
export async function approvedAllOf(db, { orgId, returnId, sourceEntityId }) {
  const REFS = 'slot_key, interest_id::text AS interest_id, interest_version, k1_source_id::text AS k1_source_id, k1_source_version';
  const { rows } = await db.query(`SELECT binding_id, account_id, measurement, target_key, ${REFS}, share_num::text AS n, share_den::text AS d, amount_cents::text AS a, source_version FROM tax_binding
    WHERE org_id = $1 AND return_id = $2 AND source_entity_id = $3 ORDER BY binding_id`, [orgId, returnId, sourceEntityId]);
  const { rows: lines } = await db.query(`SELECT binding_line_id, account_id, txn_id, line_no, amount_cents::text AS a, txn_version, target_key, ${REFS} FROM tax_binding_line
    WHERE org_id = $1 AND return_id = $2 AND source_entity_id = $3 ORDER BY txn_id, line_no`, [orgId, returnId, sourceEntityId]);
  const out = new Map();
  const at = (accountId, measurement) => { const k = `${Number(accountId)}/${measurement}`; if (!out.has(k)) out.set(k, { rows: [], attributions: [] }); return out.get(k); };
  for (const r of rows) at(r.account_id, r.measurement).rows.push({ id: Number(r.binding_id), targetKey: r.target_key, routing: routingOf(r), shareNum: r.n, shareDen: r.d, amountCents: r.a, sourceVersion: r.source_version });
  for (const l of lines) at(l.account_id, 'activity').attributions.push({ id: Number(l.binding_line_id), txnId: Number(l.txn_id), lineNo: Number(l.line_no), cents: BigInt(l.a), txnVersion: l.txn_version, targetKey: l.target_key, routing: routingOf(l) });
  return out;
}
// → { partition, measured, lines, approved }, or null when the account is not a measured account of that source on that return.
export async function currentPartition(db, { orgId, returnId, sourceEntityId, accountId, measurement }) {
  const { rows: [r] } = await db.query('SELECT period_start::text AS s, period_end::text AS e FROM tax_return WHERE org_id = $1 AND return_id = $2', [orgId, returnId]);
  if (!r) return null;
  const m = (await measureAccounts(db, { orgId, sourceEntityId, periodStart: r.s, periodEnd: r.e, returnId })).get(Number(accountId));
  if (!m || !['activity', 'begin', 'end'].includes(measurement)) return null;
  const approved = await approvedOf(db, { orgId, returnId, sourceEntityId, accountId, measurement });
  const lines = approved.attributions.length ? (await measureLines(db, { orgId, sourceEntityId, accountIds: [Number(accountId)], periodStart: r.s, periodEnd: r.e, returnId })).get(Number(accountId)) ?? [] : null;
  const measured = { cents: m[measurement], version: m.versions[measurement], lineGroups: m.lineGroups, normalization: m.normalization };
  return { partition: buildPartition({ entityId: sourceEntityId, accountId, measurement, measured, lines, ...approved }), measured, lines, approved };
}
