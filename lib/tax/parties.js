import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { settingsKey, encryptSecret } from '../secrets.js';
import { isIsoDate } from '../domain/dates.js';

// Tax Books parties (spec §4.1): who a return or a K-1 is about. Tax ids are AES-GCM encrypted (lib/secrets.js) with the
// last four beside them; the encrypted value never leaves this module.
const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
export const PARTY_KINDS = [['individual', 'Person'], ['grantor_trust', 'Grantor trust (reports on a person’s return)'], ['trust', 'Trust (files its own return)'], ['entity_in_org', 'One of our companies'], ['entity_outside', 'Outside company']];
const COLUMNS = 'org_id, party_id, kind, name, entity_id, tax_id_last4, tax_id_enc IS NOT NULL AS has_tax_id, address, active, created_at';

export async function listParties(db, { orgId, includeInactive = false }) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM tax_party WHERE org_id = $1 ${includeInactive ? '' : 'AND active'} ORDER BY kind, lower(name), party_id`, [orgId]);
  return rows;
}
export async function getParty(db, { orgId, partyId }) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM tax_party WHERE org_id = $1 AND party_id = $2`, [orgId, partyId]);
  return rows[0] ?? null;
}

// fields: { kind, name, entityId, taxId (blank keeps the saved one), clearTaxId, address: {line1, city, state, postal}, active }
export async function saveParty(pool, { orgId, partyId = null, fields: f, env = process.env }) {
  if (!PARTY_KINDS.some(([k]) => k === f.kind)) fail('Choose what kind of party this is.');
  const name = text(f.name, 200) ?? fail('Enter the party’s name.');
  const entityId = f.kind === 'entity_in_org' ? (Number(f.entityId) || fail('Choose the company this party is.')) : null;
  const digits = String(f.taxId ?? '').replace(/[\s-]/g, '');
  let enc = null, last4 = null;
  if (digits) {
    if (!/^\d{9}$/.test(digits)) fail('A tax ID is 9 digits, like 12-3456789.');
    const key = settingsKey(env) ?? fail('The server has no SETTINGS_KEY, so it can’t store a tax ID safely. Add SETTINGS_KEY first.');
    enc = encryptSecret(key, digits); last4 = digits.slice(-4);
  }
  return withTransaction(pool, async tx => {
    if (entityId) {
      const { rowCount } = await tx.query('SELECT 1 FROM entity WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
      if (!rowCount) fail('Choose the company this party is.');
      const { rows: dup } = await tx.query('SELECT party_id FROM tax_party WHERE org_id = $1 AND entity_id = $2 AND party_id IS DISTINCT FROM $3', [orgId, entityId, partyId]);
      if (dup.length) fail('That company already has a party.');
    }
    const address = f.address && Object.values(f.address).some(Boolean) ? f.address : null;
    if (partyId && f.kind !== 'individual') {
      // Mirrors tax_check_party_kind (migration 064): a household member or grantor owner stays an individual.
      const { rows: used } = await tx.query(`SELECT 1 FROM tax_household_member WHERE org_id = $1 AND party_id = $2 UNION ALL SELECT 1 FROM grantor_reporting WHERE org_id = $1 AND owner_party_id = $2 LIMIT 1`, [orgId, partyId]);
      if (used.length) fail('This party is on a household return or a grantor trust’s owner list, so it stays an individual.');
    }
    if (partyId) {
      const { rowCount } = await tx.query(
        `UPDATE tax_party SET kind = $3, name = $4, entity_id = $5, address = $6, active = $7,
                tax_id_enc = CASE WHEN $8::text IS NOT NULL THEN $8 WHEN $10 THEN NULL ELSE tax_id_enc END,
                tax_id_last4 = CASE WHEN $8::text IS NOT NULL THEN $9 WHEN $10 THEN NULL ELSE tax_id_last4 END
          WHERE org_id = $1 AND party_id = $2`, [orgId, partyId, f.kind, name, entityId, address, f.active !== false, enc, last4, f.clearTaxId === '1' && !digits]);
      if (!rowCount) fail('Party not found.');
      return partyId;
    }
    const { rows: [r] } = await tx.query(
      'INSERT INTO tax_party (org_id, kind, name, entity_id, tax_id_enc, tax_id_last4, address) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING party_id',
      [orgId, f.kind, name, entityId, enc, last4, address]);
    return r.party_id;
  });
}

// Grantor reporting (spec §4.1): a trust's items reach people only through these rows. rows: [{ ownerPartyId, shareNum, shareDen, from }];
// every row of one call starts on the same date, names each owner once and together they total exactly 1. One call is one
// change: its rows stay open (effective_to NULL) until the next, later change closes them the day before its date. Nothing
// else sets effective_to, so the intervals of one trust never overlap and the owners total 1 on every date from the first change.
export async function saveGrantorReporting(pool, { orgId, trustPartyId, rows, method, reviewedBy, evidenceNote = null }) {
  if (!rows?.length) fail('Enter at least one owner.');
  if (!['optional_1', 'optional_2', 'optional_3', 'filing_1041'].includes(method)) fail('Choose the grantor trust reporting method.');
  const from = rows[0].from;
  if (!isIsoDate(from) || rows.some(r => r.from !== from)) fail('Every owner row of one change starts on the same date.');
  if (rows.some(r => r.to != null && r.to !== '')) fail('An owner change has no end date; it ends when the next change starts.');
  if (new Set(rows.map(r => String(r.ownerPartyId))).size !== rows.length) fail('Name each owner once per change; give one owner one share.');
  if (rows.some(r => String(r.ownerPartyId) === String(trustPartyId))) fail('A trust cannot be its own owner; choose the people it reports to.');
  for (const r of rows) if (!(Number.isInteger(r.shareNum) && Number.isInteger(r.shareDen) && r.shareNum > 0 && r.shareDen > 0 && r.shareNum <= r.shareDen)) fail('Shares are exact fractions like 1/3.');
  // Exact fraction sum: Σ num_i/den_i = 1  ⇔  Σ num_i·(L/den_i) = L with L = product of denominators (small lists; safe in BigInt).
  const L = rows.reduce((p, r) => p * BigInt(r.shareDen), 1n);
  const total = rows.reduce((s, r) => s + BigInt(r.shareNum) * (L / BigInt(r.shareDen)), 0n);
  if (total !== L) fail('The owners’ shares must total 1 (for example 1/2 + 1/2, or 1/3 + 1/3 + 1/3).');
  return withTransaction(pool, async tx => {
    const { rows: [t] } = await tx.query('SELECT kind FROM tax_party WHERE org_id = $1 AND party_id = $2 FOR UPDATE', [orgId, trustPartyId]);
    if (!t) fail('Trust not found.');
    if (t.kind !== 'grantor_trust') fail('That party is not a grantor trust.');
    await requireParties(tx, orgId, rows.map(r => r.ownerPartyId), 'Owner not found.', { individual: 'A grantor trust reports to people: each owner must be an individual party.' });
    const { rows: clash } = await tx.query(`SELECT 1 FROM grantor_reporting WHERE org_id = $1 AND trust_party_id = $2 AND effective_from >= $3`, [orgId, trustPartyId, from]);
    if (clash.length) fail('A later owner change already exists; change that one.');
    // Every earlier row is either already closed before `from` (by an earlier change) or open: close the open ones the day before.
    await tx.query(`UPDATE grantor_reporting SET effective_to = $3::date - 1 WHERE org_id = $1 AND trust_party_id = $2 AND (effective_to IS NULL OR effective_to >= $3)`, [orgId, trustPartyId, from]);
    for (const r of rows) {
      await tx.query(`INSERT INTO grantor_reporting (org_id, trust_party_id, owner_party_id, share_num, share_den, effective_from, method, evidence_note, reviewed_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [orgId, trustPartyId, r.ownerPartyId, r.shareNum, r.shareDen, from, method, text(evidenceNote, 2000), text(reviewedBy, 200)]);
    }
  });
}
// review_status (spec 4.1: "missing or unreviewed = unresolved"): 'reviewed' only with both a reviewer and the evidence; anything
// less is 'unreviewed', so a later stage routes nothing through an allocation nobody checked.
export async function grantorOwnersOn(db, { orgId, trustPartyId, on }) {
  const { rows } = await db.query(`SELECT owner_party_id, share_num, share_den, method, reviewed_by, evidence_note,
      CASE WHEN reviewed_by IS NOT NULL AND evidence_note IS NOT NULL THEN 'reviewed' ELSE 'unreviewed' END AS review_status FROM grantor_reporting
    WHERE org_id = $1 AND trust_party_id = $2 AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3) ORDER BY owner_party_id`, [orgId, trustPartyId, on]);
  return rows;
}

// Every id names a party of this org (the composite FK to tax_party), so a stale or foreign id is a message, not a pg error.
// With `individual` (a message), every party must also be a person (tax_check_individual in migration 064 says the same).
async function requireParties(tx, orgId, partyIds, message, { individual = null } = {}) {
  const ids = partyIds.map(id => Number(id));
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) fail(message);
  const { rows } = await tx.query('SELECT party_id, kind FROM tax_party WHERE org_id = $1 AND party_id = ANY($2::bigint[])', [orgId, ids]);
  const found = new Map(rows.map(r => [Number(r.party_id), r.kind]));
  if (ids.some(id => !found.has(id))) fail(message);
  if (individual && ids.some(id => found.get(id) !== 'individual')) fail(individual);
}

// The people on a household's joint return: exactly one taxpayer, at most one spouse, per effective date. One call is one change
// (Codex t1-r1 B9), like saveGrantorReporting: every member starts on the same date; memberships open before that date are CLOSED
// the day before (history is kept: an earlier period still finds its taxpayer and spouse), and a change re-saved on its own date
// corrects that change. A change dated before a later one is refused. Members are individual parties.
export async function saveHouseholdMembers(pool, { orgId, entityId, members }) {
  if (!members?.length) fail('Enter the people on the return.');
  if (members.some(m => !['taxpayer', 'spouse'].includes(m.role))) fail('Each person on the return is either the taxpayer or spouse.');
  if (members.filter(m => m.role === 'taxpayer').length !== 1) fail('A household has exactly one taxpayer.');
  if (members.filter(m => m.role === 'spouse').length > 1) fail('A household has at most one spouse.');
  if (new Set(members.map(m => String(m.partyId))).size !== members.length) fail('List each person once.');
  for (const m of members) if (!isIsoDate(m.from)) fail('Enter the date each person joined the return.');
  const from = members[0].from;
  if (members.some(m => m.from !== from)) fail('Everyone on one change of the return starts on the same date.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    await requireParties(tx, orgId, members.map(m => m.partyId), 'Party not found.', { individual: 'The people on a household return are individual parties, not companies or trusts.' });
    const { rows: later } = await tx.query('SELECT 1 FROM tax_household_member WHERE org_id = $1 AND entity_id = $2 AND effective_from > $3 LIMIT 1', [orgId, entityId, from]);
    if (later.length) fail('A later change of the people on this return already exists; change that one.');
    // Same date: this call corrects that change. Earlier and still open: closed the day before, kept as history.
    await tx.query('DELETE FROM tax_household_member WHERE org_id = $1 AND entity_id = $2 AND effective_from = $3', [orgId, entityId, from]);
    await tx.query('UPDATE tax_household_member SET effective_to = $3::date - 1 WHERE org_id = $1 AND entity_id = $2 AND (effective_to IS NULL OR effective_to >= $3)', [orgId, entityId, from]);
    for (const m of members) {
      await tx.query('INSERT INTO tax_household_member (org_id, entity_id, party_id, role, effective_from) VALUES ($1,$2,$3,$4,$5)', [orgId, entityId, m.partyId, m.role, m.from]);
    }
  });
}
export async function householdMembers(db, { orgId, entityId }) {
  const { rows } = await db.query(`SELECT m.party_id, m.role, m.effective_from, p.name FROM tax_household_member m JOIN tax_party p ON p.org_id = m.org_id AND p.party_id = m.party_id
    WHERE m.org_id = $1 AND m.entity_id = $2 AND m.effective_to IS NULL ORDER BY m.role`, [orgId, entityId]);
  return rows;
}
// The people on the return as of a date (a period's own members, not today's).
export async function householdMembersOn(db, { orgId, entityId, asOf }) {
  if (!isIsoDate(asOf)) fail('Give the date to read the household members on.');
  const { rows } = await db.query(`SELECT m.party_id, m.role, m.effective_from, m.effective_to, p.name FROM tax_household_member m JOIN tax_party p ON p.org_id = m.org_id AND p.party_id = m.party_id
    WHERE m.org_id = $1 AND m.entity_id = $2 AND m.effective_from <= $3 AND (m.effective_to IS NULL OR m.effective_to >= $3) ORDER BY m.role`, [orgId, entityId, asOf]);
  return rows;
}
