import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { settingsKey, encryptSecret, decryptSecret } from '../secrets.js';
import { isIsoDate } from '../domain/dates.js';

// Tax Books parties (spec §4.1): who a return or a K-1 is about. Tax ids are AES-GCM encrypted (lib/secrets.js) with the
// last four beside them; the encrypted value never leaves this module.
const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
export const PARTY_KINDS = [['individual', 'Person'], ['grantor_trust', 'Grantor trust (reports on a person’s return)'], ['trust', 'Trust (files its own return)'], ['entity_in_org', 'One of our companies'], ['entity_outside', 'Outside company']];
// One of our own companies (entity_in_org) keeps its EIN once, on entity (Settings → Company). A T1 party may still hold an id of its
// own; reconcileOwnCompanyTaxIds (below) settles each such party once (Codex t2-plan-r1 B9), never erasing a value:
//   own_tax_id_state 'company'   the company's EIN is the authority (moved there if the company had none, or the two matched);
//   own_tax_id_state 'conflict'  the two differ: no id is shown or used until an admin chooses (resolveOwnTaxIdConflict, on the Tax setup
//                                page); both ciphertexts are kept in tax_party_tax_id_evidence with the decision (Codex r2 B9);
//   own_tax_id_state NULL        not reconciled yet: the party's own legacy id is shown (else the company's), flagged for review.
// The party's own ciphertext stays on the party as evidence: an ordinary edit can neither clear it nor move the party to another company
// or kind while a conflict is open.
// The masked reader (COLUMNS) and the full reader (partyTaxId) follow the same rule, so they never disagree. Other kinds keep their own id.
const COLUMNS = `p.org_id, p.party_id, p.kind, p.name, p.entity_id, p.own_tax_id_state,
  CASE WHEN p.kind <> 'entity_in_org' THEN p.tax_id_last4 WHEN p.own_tax_id_state = 'company' THEN e.ein_last4 WHEN p.own_tax_id_state = 'conflict' THEN NULL
       ELSE coalesce(p.tax_id_last4, e.ein_last4) END AS tax_id_last4,
  CASE WHEN p.kind <> 'entity_in_org' THEN p.tax_id_enc IS NOT NULL WHEN p.own_tax_id_state = 'company' THEN e.ein_enc IS NOT NULL WHEN p.own_tax_id_state = 'conflict' THEN false
       ELSE (p.tax_id_enc IS NOT NULL OR e.ein_enc IS NOT NULL) END AS has_tax_id,
  (p.kind = 'entity_in_org' AND (p.own_tax_id_state = 'conflict' OR (p.own_tax_id_state IS NULL AND p.tax_id_enc IS NOT NULL))) AS tax_id_needs_review,
  (SELECT json_build_object('evidenceId', v.evidence_id, 'partyLast4', v.party_tax_id_last4, 'companyLast4', v.company_ein_last4) FROM tax_party_tax_id_evidence v
    WHERE v.org_id = p.org_id AND v.party_id = p.party_id AND v.decision IS NULL) AS tax_id_conflict,
  p.address, p.active, p.created_at`;
const FROM = 'tax_party p LEFT JOIN entity e ON e.org_id = p.org_id AND e.entity_id = p.entity_id';

export async function listParties(db, { orgId, includeInactive = false }) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.org_id = $1 ${includeInactive ? '' : 'AND p.active'} ORDER BY p.kind, lower(p.name), p.party_id`, [orgId]);
  return rows;
}
export async function getParty(db, { orgId, partyId }) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.org_id = $1 AND p.party_id = $2`, [orgId, partyId]);
  return rows[0] ?? null;
}
// The full tax id of a party, decrypted from the same authority the masked reader shows (exports and filings use this, never the columns).
export async function partyTaxId(db, { orgId, partyId, env = process.env }) {
  const { rows: [p] } = await db.query(`SELECT p.kind, p.own_tax_id_state, p.tax_id_enc, e.ein_enc FROM ${FROM} WHERE p.org_id = $1 AND p.party_id = $2`, [orgId, partyId]);
  if (!p) fail('Party not found.');
  if (p.kind === 'entity_in_org' && p.own_tax_id_state === 'conflict') fail('This company’s EIN on its party and in Settings → Company differ: an admin chooses one first.');
  const enc = p.kind !== 'entity_in_org' ? p.tax_id_enc : p.own_tax_id_state === 'company' ? p.ein_enc : (p.tax_id_enc ?? p.ein_enc);
  if (!enc) return null;
  const key = settingsKey(env) ?? fail('The server has no SETTINGS_KEY, so it can’t read a tax ID.');
  return decryptSecret(key, enc);
}

// fields: { kind, name, entityId, taxId (blank keeps the saved one), clearTaxId, address: {line1, city, state, postal}, active }
export async function saveParty(pool, args) {
  try { return await savePartyIn(pool, args); } catch (error) {
    // A party rule the database refused (migration 065, raised as 'tax_party: …') comes back as a message, not a pg error.
    if (error?.code === 'P0001' && /^tax_party: /.test(error.message)) fail(error.message.replace(/^tax_party: /, '').replace(/^./, c => c.toUpperCase()) + '.');
    throw error;
  }
}
async function savePartyIn(pool, { orgId, partyId = null, fields: f, env = process.env }) {
  if (!PARTY_KINDS.some(([k]) => k === f.kind)) fail('Choose what kind of party this is.');
  const name = text(f.name, 200) ?? fail('Enter the party’s name.');
  const entityId = f.kind === 'entity_in_org' ? (Number(f.entityId) || fail('Choose the company this party is.')) : null;
  const digits = String(f.taxId ?? '').replace(/[\s-]/g, '');
  if (f.kind === 'entity_in_org' && digits) fail('One of our companies keeps its EIN once, in Settings → Company; this party shows its last four digits from there.');
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
      const { rows: [was] } = await tx.query('SELECT kind, entity_id, tax_id_enc, own_tax_id_state FROM tax_party WHERE org_id = $1 AND party_id = $2 FOR UPDATE', [orgId, partyId]);
      if (!was) fail('Party not found.');
      const ownBefore = was.kind === 'entity_in_org', sameCompany = ownBefore && f.kind === 'entity_in_org' && Number(was.entity_id) === entityId;
      const clear = f.clearTaxId === '1' && !digits;
      // Codex r2 B9: one of our companies' party keeps its own legacy id as evidence; a conflict is settled before the party changes company.
      if (ownBefore && was.tax_id_enc && clear) fail('This company’s own earlier tax id is kept as evidence; its EIN is in Settings → Company.');
      if (was.own_tax_id_state === 'conflict' && !sameCompany) fail('This party’s EIN differs from Settings → Company: settle that on the Tax setup page before changing its kind or company.');
      // Codex t2-r1 B5: the facts an owner's interest depends on, checked under the party-row lock taken above (an interest write reads the
      // party FOR SHARE, so the two serialize): never the company it owns, a shareholder stays a person or a trust, a current owner stays
      // active. Migration 065 (tax_check_party_owner_facts) refuses the same for writes that do not come through here.
      const { rows: owns } = await tx.query('SELECT entity_id, role, effective_to FROM ownership_interest WHERE org_id = $1 AND party_id = $2', [orgId, partyId]);
      if (f.kind === 'entity_in_org' && owns.some(o => Number(o.entity_id) === entityId)) fail('This party is an owner of that company, and a company is not its own owner.');
      if (!['individual', 'grantor_trust', 'trust'].includes(f.kind) && owns.some(o => o.role === 'shareholder')) fail('This party holds shares, so it stays a person or a trust.');
      if (f.active === false && owns.some(o => o.effective_to === null)) fail('This party is a current owner (an interest with no end date): end the interest before deactivating the party.');
      const keptEnc = clear ? null : enc ?? was.tax_id_enc;
      // The state: any other kind has none; a party that becomes (or moves to another of) our companies starts over — settled at once with
      // no id of its own, else waiting for reconcileOwnCompanyTaxIds; the same company keeps its state.
      const state = f.kind !== 'entity_in_org' ? null : sameCompany ? (was.own_tax_id_state ?? (keptEnc ? null : 'company')) : (keptEnc ? null : 'company');
      await tx.query(
        `UPDATE tax_party SET kind = $3, name = $4, entity_id = $5, address = $6, active = $7,
                tax_id_enc = CASE WHEN $8::text IS NOT NULL THEN $8 WHEN $10 THEN NULL ELSE tax_id_enc END,
                tax_id_last4 = CASE WHEN $8::text IS NOT NULL THEN $9 WHEN $10 THEN NULL ELSE tax_id_last4 END,
                own_tax_id_state = $11
          WHERE org_id = $1 AND party_id = $2`, [orgId, partyId, f.kind, name, entityId, address, f.active !== false, enc, last4, clear, state]);
      return partyId;
    }
    const { rows: [r] } = await tx.query(
      'INSERT INTO tax_party (org_id, kind, name, entity_id, tax_id_enc, tax_id_last4, address, own_tax_id_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING party_id',
      [orgId, f.kind, name, entityId, enc, last4, address, f.kind === 'entity_in_org' ? 'company' : null]);
    return r.party_id;
  });
}

// The one-time transition (B9), idempotent: every entity_in_org party not reconciled yet is settled. No party id → 'company'. A party id and
// no company EIN → the party's encrypted id is copied onto the company (the same ciphertext; the party keeps it as evidence) → 'company'.
// Both → decrypted and compared: equal → 'company'; different → 'conflict' (nothing chosen silently). Returns the counts. Needs SETTINGS_KEY
// only when two ids have to be compared.
export const reconcileOwnCompanyTaxIds = (pool, args) => withTransaction(pool, tx => reconcileOwnCompanyTaxIdsIn(tx, args));
// Inside the caller's transaction. Each party is read with its company row locked (FOR UPDATE OF p, e), the lock saveCompany takes
// before an EIN edit (Codex r4 R4-N3).
export async function reconcileOwnCompanyTaxIdsIn(tx, { orgId, env = process.env }) {
  const { rows } = await tx.query(`SELECT p.party_id, p.entity_id, p.tax_id_enc, p.tax_id_last4, e.ein_enc FROM tax_party p JOIN entity e ON e.org_id = p.org_id AND e.entity_id = p.entity_id
    WHERE p.org_id = $1 AND p.kind = 'entity_in_org' AND p.own_tax_id_state IS NULL ORDER BY p.entity_id FOR UPDATE OF p, e`, [orgId]);
  const out = { companyOnly: 0, moved: 0, matched: 0, conflicts: 0 };
  for (const r of rows) {
    let state = 'company';
    if (!r.tax_id_enc) out.companyOnly += 1;
    else if (!r.ein_enc) {
      await tx.query('UPDATE entity SET ein_enc = $3, ein_last4 = $4 WHERE org_id = $1 AND entity_id = $2', [orgId, r.entity_id, r.tax_id_enc, r.tax_id_last4]);
      out.moved += 1;
    } else {
      const key = settingsKey(env) ?? fail('The server has no SETTINGS_KEY, so the two saved EINs can’t be compared.');
      if (decryptSecret(key, r.tax_id_enc) === decryptSecret(key, r.ein_enc)) out.matched += 1;
      else {
        // Both candidates as they stand, kept before anything is chosen (the audit trail drops *_enc columns).
        const { rows: [c] } = await tx.query('SELECT ein_last4 FROM entity WHERE org_id = $1 AND entity_id = $2', [orgId, r.entity_id]);
        await tx.query(`INSERT INTO tax_party_tax_id_evidence (org_id, party_id, entity_id, party_tax_id_enc, party_tax_id_last4, company_ein_enc, company_ein_last4)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [orgId, r.party_id, r.entity_id, r.tax_id_enc, r.tax_id_last4, r.ein_enc, c.ein_last4]);
        state = 'conflict'; out.conflicts += 1;
      }
    }
    await tx.query('UPDATE tax_party SET own_tax_id_state = $3 WHERE org_id = $1 AND party_id = $2', [orgId, r.party_id, state]);
  }
  return out;
}
// An org admin settles a conflict, on the Tax setup page of the company (Codex r2 B9): keep the company's EIN, or put the party's onto the
// company. The form names the evidence row it showed; if either candidate changed since (the party's id or the company's EIN), nothing is
// decided. The decision, who made it and when are recorded on the evidence row; both ciphertexts stay there.
export async function resolveOwnTaxIdConflict(pool, { orgId, entityId, partyId, evidenceId, keep, actor }) {
  if (!['company', 'party'].includes(keep)) fail('Choose which EIN to keep.');
  return withTransaction(pool, async tx => {
    const { rows: [p] } = await tx.query(`SELECT p.entity_id, p.tax_id_enc, p.tax_id_last4, e.ein_enc FROM tax_party p JOIN entity e ON e.org_id = p.org_id AND e.entity_id = p.entity_id
      WHERE p.org_id = $1 AND p.party_id = $2 AND p.entity_id = $3 AND p.kind = 'entity_in_org' AND p.own_tax_id_state = 'conflict' FOR UPDATE OF p, e`, [orgId, partyId, entityId]);
    if (!p) fail('That party has no EIN conflict to settle for this company.');
    const { rows: [v] } = await tx.query(`SELECT evidence_id, party_tax_id_enc, company_ein_enc FROM tax_party_tax_id_evidence WHERE org_id = $1 AND party_id = $2 AND evidence_id = $3 AND decision IS NULL FOR UPDATE`,
      [orgId, partyId, Number(evidenceId) || 0]);
    if (!v || v.party_tax_id_enc !== p.tax_id_enc || v.company_ein_enc !== p.ein_enc) fail('One of the two EINs changed since the page was shown. Look at them again.');
    if (keep === 'party') await tx.query('UPDATE entity SET ein_enc = $3, ein_last4 = $4 WHERE org_id = $1 AND entity_id = $2', [orgId, p.entity_id, p.tax_id_enc, p.tax_id_last4]);
    await tx.query(`UPDATE tax_party_tax_id_evidence SET decision = $3, decided_by = $4, decided_at = now() WHERE org_id = $1 AND evidence_id = $2`, [orgId, v.evidence_id, keep, actor ?? 'system']);
    await tx.query(`UPDATE tax_party SET own_tax_id_state = 'company' WHERE org_id = $1 AND party_id = $2`, [orgId, partyId]);
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

// The parties a person may NAME on a company's pages (Codex t2-plan-r5 R5-N4): an org admin (who can open every company) any party of the
// directory; anyone else only parties already linked to a company they may open — those companies' own tax parties, their owners and
// members, and the owners and K-1 payers their mappings already name. Pickers show this set and posts are checked against it, so a company
// page is never a way around the admin-only directory; a party not linked yet is added (or first linked) by an org admin.
export async function partiesFor(db, { orgId, companyIds = [], orgAdmin = false }) {
  if (orgAdmin) return listParties(db, { orgId });
  const ids = companyIds.map(Number);
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.org_id = $1 AND p.active AND (
      (p.kind = 'entity_in_org' AND p.entity_id = ANY($2::bigint[]))
      OR EXISTS (SELECT 1 FROM ownership_interest o WHERE o.org_id = p.org_id AND o.party_id = p.party_id AND o.entity_id = ANY($2::bigint[]))
      OR EXISTS (SELECT 1 FROM tax_binding_default d WHERE d.org_id = p.org_id AND d.entity_id = ANY($2::bigint[]) AND p.party_id IN (d.interest_party_id, d.k1_issuer_party_id))
      OR EXISTS (SELECT 1 FROM tax_binding b JOIN tax_return r ON r.org_id = b.org_id AND r.return_id = b.return_id
                  WHERE b.org_id = p.org_id AND r.entity_id = ANY($2::bigint[]) AND p.party_id IN (b.interest_party_id, b.k1_issuer_party_id))
      OR EXISTS (SELECT 1 FROM tax_binding_line b JOIN tax_return r ON r.org_id = b.org_id AND r.return_id = b.return_id
                  WHERE b.org_id = p.org_id AND r.entity_id = ANY($2::bigint[]) AND p.party_id IN (b.interest_party_id, b.k1_issuer_party_id)))
    ORDER BY p.kind, lower(p.name), p.party_id`, [orgId, ids]);
  return rows;
}
