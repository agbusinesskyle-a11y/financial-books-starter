import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { isIsoDate } from '../domain/dates.js';
import { copyForwardEdge, lockTaxGraph } from './bindings.js';

// Activities (spec §4.4): the unit a schedule is prepared for. The inclusion edge is the only way another company's books
// enter a return; the database trigger (migration 064) re-checks what this module checks.
const fail = message => { throw new ValidationError(message); };
export const ACTIVITY_KIND_LABELS = { trade: 'Trade or business', rental: 'Rental real estate', farm: 'Farm', portfolio: 'Portfolio', holding: 'Holding (the company’s own activity)' };
export const SCHEDULES = [['p1', 'Return page 1'], ['sch_c', 'Schedule C'], ['sch_e1', 'Schedule E Part I (one property)'], ['sch_f', 'Schedule F'], ['f8825', 'Form 8825 (one property)'], ['none', 'None']];

// Rental property days drive the Schedule E / vacation-home allocation (T3+), so a day count is a tax input: blank is stored as
// null (not entered), anything else must be a whole number of days from 0 to a year. Never a silent 0 or a silent null.
const MAX_DAYS_IN_YEAR = 366;
function rentalDays(value, label) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s) || Number(s) > MAX_DAYS_IN_YEAR) fail(`${label}: enter a whole number of days from 0 to ${MAX_DAYS_IN_YEAR}.`);
  return Number(s);
}

export async function listActivities(db, { orgId, entityId }) {
  const { rows } = await db.query('SELECT * FROM tax_activity WHERE org_id = $1 AND return_entity_id = $2 ORDER BY effective_from, activity_id', [orgId, entityId]);
  return rows;
}
// fields: { kind, name, schedule, property: {address, type, fairRentalDays, personalUseDays}, from, to, disposedOn }
export async function saveActivity(pool, { orgId, entityId, activityId = null, fields: f }) {
  if (!Object.hasOwn(ACTIVITY_KIND_LABELS, f.kind)) fail('Choose the kind of activity.');
  if (!SCHEDULES.some(([k]) => k === f.schedule)) fail('Choose the schedule this activity is reported on.');
  const name = String(f.name ?? '').trim().slice(0, 200) || fail('Name the activity.');
  if (!isIsoDate(f.from)) fail('Enter the date the activity started.');
  for (const [k, v] of [['to', f.to], ['disposedOn', f.disposedOn]]) if (v && !isIsoDate(v)) fail(`${k}: enter a date.`);
  // Mirrors 064's CHECK (effective_to >= effective_from) so a reversed range is a form message, not a database error; a
  // disposal before the activity started is refused on the same footing. ISO dates compare lexically.
  if (f.to && f.to < f.from) fail('The end date is before the start date.');
  if (f.disposedOn && f.disposedOn < f.from) fail('The disposal date is before the start date.');
  if (f.kind === 'rental' && f.schedule !== 'sch_e1' && f.schedule !== 'f8825') fail('A rental is reported on Schedule E Part I or Form 8825.');
  const property = f.kind === 'rental' ? { address: String(f.property?.address ?? '').trim() || null, type: String(f.property?.type ?? '').trim() || null,
    fairRentalDays: rentalDays(f.property?.fairRentalDays, 'Fair rental days'), personalUseDays: rentalDays(f.property?.personalUseDays, 'Personal use days') } : null;
  if (property && property.fairRentalDays != null && property.personalUseDays != null && property.fairRentalDays + property.personalUseDays > MAX_DAYS_IN_YEAR) {
    fail(`Fair rental days and personal use days together cannot exceed ${MAX_DAYS_IN_YEAR}.`);
  }
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    if (activityId) {
      const { rowCount } = await tx.query(`UPDATE tax_activity SET kind = $4, name = $5, schedule = $6, property = $7, effective_from = $8, effective_to = $9, disposed_on = $10
        WHERE org_id = $1 AND return_entity_id = $2 AND activity_id = $3`, [orgId, entityId, activityId, f.kind, name, f.schedule, property, f.from, f.to || null, f.disposedOn || null]);
      if (!rowCount) fail('Activity not found.');
      return activityId;
    }
    const { rows: [r] } = await tx.query(`INSERT INTO tax_activity (org_id, return_entity_id, kind, name, schedule, property, effective_from, effective_to, disposed_on)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING activity_id`, [orgId, entityId, f.kind, name, f.schedule, property, f.from, f.to || null, f.disposedOn || null]);
    return r.activity_id;
  });
}

// The inclusion edge: a disregarded company's books join an activity of this return for the return's period.
// canOpen / canEdit: what the person including the books may open and edit (copy-forward into returns above, Codex r3 R3-N2); report, when
// given, receives pendingReturns: returns above that were not updated because this person may not edit them.
export async function includeBooks(pool, { orgId, entityId, returnId, activityId, sourceEntityId, approvedBy, canOpen = () => true, canEdit = async () => true, report = null }) {
  return withTransaction(pool, async tx => {
    // The org's inclusion-graph lock (the same key tax_check_inclusion takes, migration 064; Codex t1-r1 B10), taken FIRST — before the
    // company lock, the one order every Tax Books write uses (T2, Codex t2-plan-r2 B5) — so the checks below read the graph as it stands
    // once any concurrent edge or binding write has committed.
    await lockTaxGraph(tx, orgId);
    await lockEntity(tx, orgId, entityId);
    const { rows: [r] } = await tx.query('SELECT entity_id, period_start, period_end, status FROM tax_return WHERE org_id = $1 AND return_id = $2 AND entity_id = $3', [orgId, returnId, entityId]);
    if (!r) fail('Period not found.');
    // The same gate removeInclusion applies: inclusion edges change only while the period is open.
    if (r.status !== 'open') fail(`The period is ${r.status}, not open: inclusions cannot be added.`);
    if (Number(sourceEntityId) === Number(entityId)) fail('A return cannot include its own books.');
    const { rows: [a] } = await tx.query('SELECT 1 FROM tax_activity WHERE org_id = $1 AND activity_id = $2 AND return_entity_id = $3', [orgId, activityId, entityId]);
    if (!a) fail('Activity not found on this return.');
    // Periods, not profiles (spec §0 rule 3; migration 064's trigger enforces the same): the source must have a 'disregarded'
    // return period overlapping this one, and no period in which it files its own return (a K-1 payer is never included).
    const { rows: srcPeriods } = await tx.query(`SELECT return_type, book_basis FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_start <= $4 AND period_end >= $3`,
      [orgId, sourceEntityId, r.period_start, r.period_end]);
    if (srcPeriods.some(p => p.return_type !== 'disregarded')) fail('That company files its own return for this period and sends a K-1 instead: only a disregarded company can be included.');
    const src = srcPeriods.find(p => p.return_type === 'disregarded')
      ?? fail('That company has no disregarded period on file for these dates (its profile alone is not evidence): open a disregarded period for it first; only a disregarded company can be included.');
    const { rows: dup } = await tx.query('SELECT 1 FROM activity_inclusion WHERE org_id = $1 AND source_entity_id = $2 AND period_start <= $4 AND period_end >= $3', [orgId, sourceEntityId, r.period_start, r.period_end]);
    if (dup.length) fail('That company is already included in a return for this period.');
    const { rows: [e] } = await tx.query(`INSERT INTO activity_inclusion (org_id, return_id, activity_id, source_entity_id, period_start, period_end, source_book_basis, approved_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING inclusion_id`, [orgId, returnId, activityId, sourceEntityId, r.period_start, r.period_end, src.book_basis, approvedBy]);
    // T2 (spec §4.5, §13.1 T2): the defaults of the included company and of its own included companies join this period — and every
    // open return above it in a nested chain — with the activity of their path (Codex t2-plan-r2 B4).
    const out = await copyForwardEdge(tx, { orgId, inclusionId: e.inclusion_id, canOpen, canEdit, actor: approvedBy });
    if (report) report.pendingReturns = out.pendingReturns;
    return e.inclusion_id;
  });
}
// Scoped to the company like getPeriod: a return_id of another company's return lists nothing.
export async function listInclusions(db, { orgId, entityId, returnId }) {
  const { rows } = await db.query(`SELECT i.*, e.name AS source_name, a.name AS activity_name FROM activity_inclusion i
    JOIN tax_return r ON r.org_id = i.org_id AND r.return_id = i.return_id AND r.entity_id = $3
    JOIN entity e ON e.org_id = i.org_id AND e.entity_id = i.source_entity_id
    JOIN tax_activity a ON a.org_id = i.org_id AND a.activity_id = i.activity_id WHERE i.org_id = $1 AND i.return_id = $2 ORDER BY i.inclusion_id`, [orgId, returnId, entityId]);
  return rows;
}
// Under the inclusion-graph lock (T2, Codex t2-plan-r2 B5): a binding write in flight on any path through this edge commits first, and the
// edge's trigger (migration 065) then refuses the removal while bindings depend on it.
export async function removeInclusion(pool, { orgId, entityId, inclusionId }) {
  return withTransaction(pool, async tx => {
    await lockTaxGraph(tx, orgId);
    await lockEntity(tx, orgId, entityId);
    const { rowCount } = await tx.query(`DELETE FROM activity_inclusion i USING tax_return r WHERE i.org_id = $1 AND i.inclusion_id = $2 AND r.org_id = i.org_id AND r.return_id = i.return_id AND r.entity_id = $3 AND r.status = 'open'`, [orgId, inclusionId, entityId]);
    if (!rowCount) fail('Inclusion not found, or the period is no longer open.');
  });
}

// Participation and grouping per recipient, activity and period (spec §4.4). 'unknown' is allowed and later blocks.
export async function saveTreatment(pool, { orgId, entityId, activityId, recipientPartyId, periodStart, periodEnd, participation, grouping = null, specialTreatment = null, reviewedBy = null }) {
  if (!['material', 'passive', 'unknown'].includes(participation)) fail('Choose participation: material, passive or unknown.');
  if (!isIsoDate(periodStart)) fail('Enter the period start date.');
  if (!isIsoDate(periodEnd)) fail('Enter the period end date.');
  if (periodEnd < periodStart) fail('The period end is before the start.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    // Company scope (the FK is org-wide): the activity must belong to the return entity the caller is allowed to open.
    const { rows: [a] } = await tx.query('SELECT 1 FROM tax_activity WHERE org_id = $1 AND activity_id = $2 AND return_entity_id = $3', [orgId, activityId, entityId]);
    if (!a) fail('Activity not found on this return.');
    // The treatment's dates are part of activity_treatment's unique key and the T3+ schedule lookup reads treatments by the
    // return's period_start/period_end, so a treatment saved for any other dates would be invisible there. The period must be
    // a return period of this company, exactly (the same lookup includeBooks makes).
    const { rows: [period] } = await tx.query('SELECT 1 FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_start = $3 AND period_end = $4', [orgId, entityId, periodStart, periodEnd]);
    if (!period) fail(`This company has no return period ${periodStart} to ${periodEnd}: a treatment is saved for a return period on file.`);
    await tx.query(`INSERT INTO activity_treatment (org_id, activity_id, recipient_party_id, period_start, period_end, participation, grouping, special_treatment, reviewed_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (org_id, activity_id, recipient_party_id, period_start, period_end) DO UPDATE SET participation = EXCLUDED.participation, grouping = EXCLUDED.grouping,
        special_treatment = EXCLUDED.special_treatment, reviewed_by = EXCLUDED.reviewed_by`, [orgId, activityId, recipientPartyId, periodStart, periodEnd, participation, grouping, specialTreatment, reviewedBy]);
  });
}
