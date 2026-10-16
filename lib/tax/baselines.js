import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { isIsoDate } from '../domain/dates.js';
import { catalogFor, EDITIONS, RETURN_TYPES, MEASUREMENTS } from './catalog/index.js';
import { centsFromJson } from './providers.js';

// Baselines (spec §4.3, rule 0.5): what a filed return (or a final revision) says, with identity, provenance and a versioned
// payload of opening facts. History is evidence: nothing here becomes a live number without approval and promotion (T4).
const fail = message => { throw new ValidationError(message); };
const FACT_KINDS = ['schedule_l_end', 'tax_capital', 'outside_basis', 'stock_basis', 'debt_basis', 'liability', 'aaa', 'oaa', 'pti', 'ae_p', 'suspended_loss', 'carryforward', 'asset', 'k1_item', 'form_line'];
const KEYS = ['partyKey', 'interestKey', 'activityKey', 'loanKey', 'assetKey', 'rowKey'];
// A filed figure with no supported catalog field (a 1040 total before T8, a return's item F) keeps an explicit stable identity in
// the historical namespace: hist.<form>.<name>. It is stored and shown, never bound to a slot or computed with (Codex t1-r1 B11).
export const HISTORICAL_ID = /^hist\.[a-z0-9]+\.[a-z0-9_]+$/;
const factLabel = f => `${f.factKind}${f.fieldId ? ' ' + f.fieldId : ''}`;
// The subject of a typed fact (Codex t1-r1 B7): each inner list is "at least one of these keys". A per-interest balance names its
// interest, a shareholder loan its loan, a suspended loss its interest and activity, an asset itself. Entity-level kinds (Schedule
// L, AAA/OAA/PTI/E&P, form lines, carryforwards) name no subject. An anonymous typed fact is refused even when nothing collides.
const SUBJECT_KEYS = {
  tax_capital: [['interestKey']], outside_basis: [['interestKey']], stock_basis: [['interestKey']],
  debt_basis: [['interestKey'], ['loanKey']], liability: [['interestKey', 'loanKey']],
  suspended_loss: [['interestKey'], ['activityKey']], asset: [['assetKey']], k1_item: [['interestKey', 'partyKey']],
};
export const CONSOLIDATION_POLICIES = ['inclusion_edges', 'none'];

// Cents in a payload are strings of integer cents (spec §4.3). A bad amount is a message naming the field, never a 500.
function centsOf(value, label) {
  try { return centsFromJson(value); } catch { return fail(`${label}: amountCents must be a string of integer cents.`); }
}

// The payload's return type is what the return was FILED as. The company's tax_profile is not consulted: it holds defaults for
// the next period (§4.2) and says nothing about an earlier year (§0 rule 3: periods, not profiles, decide). Agreement between a
// baseline and the period it precedes is enforced where it matters, in setPredecessor and the tax_check_predecessor trigger.
function checkPayload(p) {
  if (!RETURN_TYPES.includes(p.returnType)) fail('The payload needs the return type it was filed as.');
  // Mirrors tax_baseline's CHECK (form_edition BETWEEN 2000 AND 2100): a missing or non-numeric edition is NaN, which no
  // comparison below would catch, and the INSERT would fail instead of this message.
  if (!Number.isInteger(Number(p.formEdition)) || Number(p.formEdition) < 2000 || Number(p.formEdition) > 2100) fail('formEdition must be a year between 2000 and 2100.');
  if (!EDITIONS.includes(Number(p.formEdition)) && p.kind === 'imported_filed' && Number(p.formEdition) > 2025) fail('No catalog for that form edition.');
  if (!['imported_filed', 'final_revision', 'corrected'].includes(p.kind)) fail('kind must be imported_filed, final_revision or corrected.');
  if (p.kind === 'corrected' && !p.supersedesBaselineId) fail('A corrected baseline names the baseline it supersedes.');
  if (!['cash', 'accrual'].includes(p.bookBasis)) fail('The payload needs the book basis of the filed balance sheet.');
  if (!CONSOLIDATION_POLICIES.includes(p.consolidationPolicy)) fail('The payload needs its consolidationPolicy: inclusion_edges (the filed balance sheet includes child books) or none (it stands alone). There is no default.');
  if (!isIsoDate(p.sourcePeriodStart) || !isIsoDate(p.sourcePeriodEnd)) fail('The payload needs the source period dates.');
  if (!String(p.importKey ?? '').trim()) fail('The payload needs an importKey (the natural key of this import).');
  if (!Number.isInteger(p.payloadVersion) || p.payloadVersion < 1) fail('payloadVersion is a positive integer.');
  if (!Array.isArray(p.facts) || !p.facts.length) fail('The payload has no facts.');
  const catalog = EDITIONS.includes(Number(p.formEdition)) ? catalogFor(p.returnType, Number(p.formEdition)) : null;
  const seen = new Set();
  for (const f of p.facts) {
    if (!FACT_KINDS.includes(f.factKind)) fail(`Unknown fact kind ${f.factKind}.`);
    for (const anyOf of SUBJECT_KEYS[f.factKind] ?? []) {
      if (!anyOf.some(k => String(f[k] ?? '').trim())) fail(`${factLabel(f)}: a ${f.factKind} fact names its subject with ${anyOf.join(' or ')}.`);
    }
    // One fact per identity per payload (the baseline_fact_identity index): the usual slip is two per-interest facts that both
    // forgot their interestKey. Caught here so the message names the fact instead of a unique-index error.
    const identity = factIdentity(f);
    if (seen.has(identity)) fail(`${factLabel(f)}: two facts share the same identity (fact kind, field, measurement and keys); give each its own key.`);
    seen.add(identity);
    // Measurement is part of the fact identity (migration 064): the importer says which one a fact is; there is no default.
    if (!MEASUREMENTS.includes(f.measurement)) fail(`${factLabel(f)}: measurement must be ${MEASUREMENTS.join(', ')} (there is no default).`);
    if (!isIsoDate(f.effectiveOn)) fail(`${f.factKind}: effectiveOn must be a date.`);
    if (!['known', 'unknown', 'not_applicable'].includes(f.state)) fail(`${f.factKind}: state must be known, unknown or not_applicable.`);
    if (f.state === 'known' && (f.amountCents === null || f.amountCents === undefined)) fail(`${factLabel(f)}: a known fact needs an amount.`);
    if (f.state !== 'known' && f.amountCents !== null && f.amountCents !== undefined) fail(`${f.factKind}: an ${f.state} fact carries no amount.`);
    // A corrected payload supersedes a filed import and keeps its full content, historical figures included (Codex t1-r2 N1);
    // a final revision of our own return is computed from the catalog and never carries one.
    if (f.fieldId && HISTORICAL_ID.test(f.fieldId) && !['imported_filed', 'corrected'].includes(p.kind)) fail(`${factLabel(f)}: historical ids are for filed returns (imported or corrected) only.`);
    if (f.fieldId && catalog && !catalog.byId.has(f.fieldId) && !HISTORICAL_ID.test(f.fieldId)) fail(`Unknown catalog id ${f.fieldId} for ${p.returnType} ${p.formEdition}.`);
    if (f.amountCents !== null && f.amountCents !== undefined) centsOf(f.amountCents, factLabel(f));
    if (!['raw', 'verified', 'approved'].includes(f.reviewStatus ?? 'raw')) fail(`${f.factKind}: reviewStatus must be raw, verified or approved.`);
  }
}

// The content of a payload, normalized so two imports can be compared: the baseline's identity columns plus the fact set.
// Provenance and review status are commentary on the same content, not content, so they are left out.
// A fact's identity is what the baseline_fact_identity index keys on: kind, field, measurement and the six keys (a missing key
// counts as the same identity as an empty one, as the index's coalesce() does). Its content adds the date, state and amount.
const factIdentity = f => JSON.stringify([f.factKind, f.fieldId ?? null, f.measurement, ...KEYS.map(k => f[k] || null)]);
const factContent = f => JSON.stringify([f.factKind, f.fieldId ?? null, f.measurement, f.effectiveOn, ...KEYS.map(k => f[k] ?? null), f.state,
  f.state === 'known' ? String(centsFromJson(f.amountCents)) : null]);
function payloadContent(p) {
  return JSON.stringify({ header: [p.kind, p.returnType, Number(p.formEdition), p.bookBasis, p.consolidationPolicy, p.sourcePeriodStart, p.sourcePeriodEnd, p.supersedesBaselineId == null ? null : Number(p.supersedesBaselineId)],
    facts: p.facts.map(factContent).sort() });
}
async function storedContent(tx, orgId, baselineId) {
  const { rows: [b] } = await tx.query(`SELECT kind, return_type, form_edition, book_basis, consolidation_policy, source_period_start::text AS s, source_period_end::text AS e, supersedes_baseline_id
    FROM tax_baseline WHERE org_id = $1 AND baseline_id = $2`, [orgId, baselineId]);
  const { rows } = await tx.query(`SELECT fact_kind, field_id, measurement, effective_on::text AS effective_on, party_key, interest_key, activity_key, loan_key, asset_key, row_key, state, amount_cents::text AS amount_cents
    FROM baseline_fact WHERE org_id = $1 AND baseline_id = $2`, [orgId, baselineId]);
  return JSON.stringify({ header: [b.kind, b.return_type, Number(b.form_edition), b.book_basis, b.consolidation_policy, b.s, b.e, b.supersedes_baseline_id == null ? null : Number(b.supersedes_baseline_id)],
    facts: rows.map(r => JSON.stringify([r.fact_kind, r.field_id, r.measurement, r.effective_on, r.party_key, r.interest_key, r.activity_key, r.loan_key, r.asset_key, r.row_key, r.state, r.amount_cents])).sort() });
}

// Import one payload. Idempotent by (entity, importKey, payloadVersion): the same payload again returns the existing baseline
// and creates nothing new (§4.3). Different content under an identity that is already used is refused, never silently
// discarded: a changed payload is a new payloadVersion (a corrected baseline), as migration 064 says.
export async function importBaseline(pool, { orgId, entityId, payload: p, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    checkPayload(p);
    const importKey = String(p.importKey).trim();
    const { rows: [have] } = await tx.query('SELECT baseline_id FROM tax_baseline WHERE org_id = $1 AND entity_id = $2 AND import_key = $3 AND payload_version = $4', [orgId, entityId, importKey, p.payloadVersion]);
    if (have) {
      if (await storedContent(tx, orgId, have.baseline_id) !== payloadContent(p)) {
        fail(`payloadVersion ${p.payloadVersion} of importKey ${importKey} already exists with different content; use a new payloadVersion.`);
      }
      return { baselineId: have.baseline_id, created: false };
    }
    if (p.supersedesBaselineId) {
      const { rows: [sup] } = await tx.query('SELECT entity_id FROM tax_baseline WHERE org_id = $1 AND baseline_id = $2', [orgId, p.supersedesBaselineId]);
      if (!sup || Number(sup.entity_id) !== Number(entityId)) fail('The superseded baseline is not this company’s.');
    }
    const { rows: [b] } = await tx.query(`INSERT INTO tax_baseline (org_id, entity_id, source_period_start, source_period_end, return_type, form_edition, book_basis, consolidation_policy, kind, supersedes_baseline_id,
        source_document_hash, source_document_pages, extraction_status, payload_version, import_key, reviewed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING baseline_id`,
      [orgId, entityId, p.sourcePeriodStart, p.sourcePeriodEnd, p.returnType, Number(p.formEdition), p.bookBasis, p.consolidationPolicy, p.kind, p.supersedesBaselineId ?? null,
        p.sourceDocument?.hash ?? null, p.sourceDocument?.pages ?? null, p.extractionStatus ?? 'raw', p.payloadVersion, importKey, p.reviewedBy ?? null]);
    for (const f of p.facts) {
      await tx.query(`INSERT INTO baseline_fact (org_id, baseline_id, payload_version, fact_kind, field_id, measurement, effective_on, party_key, interest_key, activity_key, loan_key, asset_key, row_key, amount_cents, state, provenance, review_status, approved_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [orgId, b.baseline_id, p.payloadVersion, f.factKind, f.fieldId ?? null, f.measurement, f.effectiveOn, ...KEYS.map(k => f[k] ?? null),
          f.state === 'known' ? String(centsFromJson(f.amountCents)) : null, f.state, f.provenance ?? {}, f.reviewStatus ?? 'raw', f.reviewStatus === 'approved' ? (f.approvedBy ?? actor) : null]);
    }
    return { baselineId: b.baseline_id, created: true };
  });
}
export async function listBaselines(db, { orgId, entityId }) {
  const { rows } = await db.query(`SELECT b.*, (SELECT count(*)::int FROM baseline_fact f WHERE f.baseline_id = b.baseline_id) AS fact_count
    FROM tax_baseline b WHERE b.org_id = $1 AND b.entity_id = $2 ORDER BY b.source_period_end DESC, b.payload_version DESC, b.baseline_id DESC`, [orgId, entityId]);
  return rows;
}
export async function baselineFacts(db, { orgId, entityId, baselineId }) {
  const { rows } = await db.query(`SELECT f.* FROM baseline_fact f JOIN tax_baseline b ON b.org_id = f.org_id AND b.baseline_id = f.baseline_id
    WHERE f.org_id = $1 AND b.entity_id = $2 AND f.baseline_id = $3 ORDER BY f.fact_kind, f.field_id, f.interest_key, f.fact_id`, [orgId, entityId, baselineId]);
  return rows;
}

// Which facts are account openings (mirrors tax_check_bridge, migration 064): a Schedule L balance of the period's predecessor,
// measured at the predecessor's END and effective on its last day, with a known amount. An approved allocation also needs the
// fact's own review (verified or approved): the transcription is checked first, then its allocation.
const REVIEWED = ['verified', 'approved'];
async function openingFact(tx, { orgId, entityId, returnId, factId }) {
  const { rows: [r] } = await tx.query('SELECT predecessor_baseline_id FROM tax_return WHERE org_id = $1 AND return_id = $2 AND entity_id = $3', [orgId, returnId, entityId]);
  if (!r) fail('Period not found.');
  if (!r.predecessor_baseline_id) fail('Set the period’s predecessor baseline first; an initial period has no openings to bridge.');
  const { rows: [f] } = await tx.query(`SELECT f.amount_cents, f.state, f.baseline_id, f.fact_kind, f.field_id, f.measurement, f.effective_on::text AS effective_on, f.review_status,
      b.source_period_end::text AS source_period_end
    FROM baseline_fact f JOIN tax_baseline b ON b.org_id = f.org_id AND b.baseline_id = f.baseline_id WHERE f.org_id = $1 AND f.fact_id = $2 AND b.entity_id = $3`, [orgId, factId, entityId]);
  if (!f) fail('Baseline fact not found.');
  if (Number(f.baseline_id) !== Number(r.predecessor_baseline_id)) fail('Only facts of the period’s predecessor baseline can be bridged.');
  if (f.fact_kind !== 'schedule_l_end') fail(`Only a Schedule L balance is an account opening; this fact is ${f.fact_kind}.`);
  if (f.measurement !== 'end') fail(`An opening is the predecessor’s end-of-period balance; this fact is its ${f.measurement} measurement.`);
  if (f.effective_on !== f.source_period_end) fail(`An opening is the balance on the predecessor’s last day (${f.source_period_end}); this fact is effective ${f.effective_on}.`);
  if (f.state !== 'known') fail('Only a known fact can be bridged; this one is ' + f.state + '.');
  return f;
}
const needsReview = f => fail(`Approve the allocation after the fact itself is verified; this fact is ${f.review_status}. Save the allocation as a draft (no approver) until then.`);

// Allocate one baseline fact (a filed aggregate) across this company's accounts; the rows must total the fact. With approvedBy the
// allocation is approved (and the fact must be verified); without it the rows are a draft, kept but not usable until approveBridge.
export async function bridgeOpening(pool, { orgId, entityId, returnId, factId, rows, approvedBy = null }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const f = await openingFact(tx, { orgId, entityId, returnId, factId });
    if (approvedBy && !REVIEWED.includes(f.review_status)) needsReview(f);
    // One row per account per fact (opening_bridge UNIQUE (org_id, return_id, fact_id, account_id)): say which account repeats.
    const accounts = new Set();
    for (const x of rows) {
      if (accounts.has(String(x.accountId))) fail(`account ${x.accountId} appears twice; give each account one allocation.`);
      accounts.add(String(x.accountId));
    }
    const allocated = rows.map(x => centsOf(x.allocatedCents, `allocatedCents for account ${x.accountId}`));
    const total = allocated.reduce((s, c) => s + c, 0n);
    if (total !== BigInt(f.amount_cents)) fail(`The allocations must total the filed amount (${f.amount_cents} cents); they total ${total}.`);
    for (const x of rows) {
      const { rows: [a] } = await tx.query('SELECT entity_id FROM account WHERE org_id = $1 AND account_id = $2', [orgId, x.accountId]);
      if (!a) fail('Account not found.');
      if (Number(a.entity_id) !== Number(entityId)) fail('That account belongs to another company.');
    }
    await tx.query('DELETE FROM opening_bridge WHERE org_id = $1 AND return_id = $2 AND fact_id = $3', [orgId, returnId, factId]);
    for (const [i, x] of rows.entries()) {
      await tx.query('INSERT INTO opening_bridge (org_id, return_id, fact_id, account_id, allocated_cents, explanation, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [orgId, returnId, factId, x.accountId, String(allocated[i]), String(x.explanation ?? '').slice(0, 500) || null, approvedBy || null]);
    }
  });
}
// Approve a draft allocation of one fact: a separate act from the fact's review, allowed only once that review is done.
export async function approveBridge(pool, { orgId, entityId, returnId, factId, approvedBy }) {
  if (!String(approvedBy ?? '').trim()) fail('Say who approved the allocation.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const f = await openingFact(tx, { orgId, entityId, returnId, factId });
    if (!REVIEWED.includes(f.review_status)) needsReview(f);
    const { rowCount } = await tx.query('UPDATE opening_bridge SET approved_by = $4 WHERE org_id = $1 AND return_id = $2 AND fact_id = $3 AND approved_by IS NULL', [orgId, returnId, factId, String(approvedBy).trim()]);
    if (!rowCount) fail('No draft allocation of that fact to approve.');
  });
}
// Scoped to the company through the period (§11): a return_id of another company in the same org lists nothing.
export async function listBridge(db, { orgId, entityId, returnId }) {
  const { rows } = await db.query(`SELECT ob.* FROM opening_bridge ob JOIN tax_return r ON r.org_id = ob.org_id AND r.return_id = ob.return_id
    WHERE ob.org_id = $1 AND r.entity_id = $2 AND ob.return_id = $3 ORDER BY ob.fact_id, ob.account_id`, [orgId, entityId, returnId]);
  return rows;
}
