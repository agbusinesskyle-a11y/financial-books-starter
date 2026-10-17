// lib/tax/references.js
// The per-period owner-interest and K-1 references of a binding (spec §4.8, §4.9, §13.1 T2/T4; Codex t2-plan-r1 B5). A binding keeps a
// stable party (the owner, or the K-1 payer); a RESOLVER selects the period's record. This module fixes the resolver contract:
//   interest({ db, orgId, issuerEntityId, partyId, periodStart, periodEnd })   the party's interest in the return's company, in effect for the
//                                                                              whole period (ownership_interest, migration 065 — pulled forward
//                                                                              from T4 at the owner's request)
//   k1({ db, orgId, recipientEntityId, issuerPartyId, periodStart, periodEnd }) the ONE approved, complete, active K-1 record from that payer
//                                                                              to this recipient for a payer period ending in this period (T4)
// Each returns exactly one of
//   { status: 'selected', id, version }                    the record and its version (an edited row has a new version)
//   { status: 'pending' | 'conflict' | 'ineligible', reason }   nothing is selected (not on file yet; two candidates; wrong payer or
//                                                               recipient period, an interest that changes during the period, an
//                                                               unapproved or incomplete K-1)
// Anything else is treated as pending. Only 'selected' fills interest_id / k1_source_id; every other answer is pending and blocks the
// outputs that depend on it — never zero, and never an authorization to exclude booked K-1 income.
// T2's interest resolver reads the company's owners and members (lib/tax/ownership.js): exactly one interest of that party in that company
// covering the whole period, in a role the period's return takes, held by an eligible party (Codex t2-r1 B5), is selected; its version a
// hash of EVERY saved fact of the row and of its owner's kind and company, unknown (NULL) shares included in their places (Codex r5 R5-N2: a profit/loss swap between known and unknown changes it); an interest that starts or ends inside the period is
// ineligible here (allocating across a change of interests is T4's); two covering rows are a conflict. The K-1 resolver stays pending until
// T4 files K-1 records.
async function interestResolver({ db, orgId, issuerEntityId, partyId, periodStart, periodEnd }) {
  const { rows } = await db.query(`SELECT o.interest_id, o.role, p.kind AS party_kind, p.entity_id AS party_entity_id,
      md5(json_build_array(o.entity_id, o.party_id, o.role, o.effective_from, o.effective_to, o.profit_num, o.profit_den, o.loss_num, o.loss_den, o.capital_num, o.capital_den,
        p.kind, p.entity_id)::text) AS v,
      o.effective_from <= $4::date AND (o.effective_to IS NULL OR o.effective_to >= $5::date) AS covers
    FROM ownership_interest o JOIN tax_party p ON p.org_id = o.org_id AND p.party_id = o.party_id
    WHERE o.org_id = $1 AND o.entity_id = $2 AND o.party_id = $3 AND o.effective_from <= $5::date AND (o.effective_to IS NULL OR o.effective_to >= $4::date)`,
  [orgId, issuerEntityId, partyId, periodStart, periodEnd]);
  const { rows: [ret] } = await db.query('SELECT return_type FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_start = $3::date AND period_end = $4::date',
    [orgId, issuerEntityId, periodStart, periodEnd]);
  if (!rows.length) return { status: 'pending', reason: 'This owner’s interest for this period is not on file yet: add it under Owners and members on the tax setup page.' };
  const covering = rows.filter(r => r.covers);
  if (covering.length > 1) return { status: 'conflict', reason: 'Two interests of this owner cover the same period: correct Owners and members.' };
  if (covering.length !== 1 || rows.length > 1) return { status: 'ineligible', reason: 'This owner’s interest changes during the period: allocating across a change of interests is a later stage (T4).' };
  const roles = { form_1065: ['general_partner', 'limited_partner'], form_1120s: ['shareholder'], disregarded: ['single_member'] }[ret?.return_type] ?? [];
  if (!roles.includes(covering[0].role)) return { status: 'ineligible', reason: 'This owner’s role is not one this period’s return takes: correct Owners and members.' };
  // The owner's identity, checked here too (Codex t2-r1 B5): never the company itself; a shareholder is a person or a trust.
  const own = covering[0];
  if (own.party_kind === 'entity_in_org' && Number(own.party_entity_id) === Number(issuerEntityId)) return { status: 'ineligible', reason: 'This owner’s party is the company itself: correct the owner’s party.' };
  if (own.role === 'shareholder' && !['individual', 'grantor_trust', 'trust'].includes(own.party_kind)) return { status: 'ineligible', reason: 'This shareholder is not a person or a trust: correct the owner’s party.' };
  return { status: 'selected', id: Number(covering[0].interest_id), version: `oi:${covering[0].v}` };
}
export const T2_RESOLVERS = {
  interest: interestResolver,
  k1: async () => ({ status: 'pending', reason: 'The K-1 record for this period is not on file yet (K-1 records arrive in stage T4).' }),
};
const VERSION = /^[A-Za-z0-9:._@-]{1,200}$/;
// A resolver's answer, normalized: { id, version, pending } where pending is null when selected.
export function normalizeAnswer(kind, r) {
  if (r && r.status === 'selected' && Number.isSafeInteger(Number(r.id)) && Number(r.id) > 0 && typeof r.version === 'string' && VERSION.test(r.version)) {
    return { id: Number(r.id), version: r.version, pending: null };
  }
  const why = r && ['pending', 'conflict', 'ineligible'].includes(r.status) && typeof r.reason === 'string' && r.reason.trim()
    ? r.reason.trim().slice(0, 300)
    : `The ${kind === 'interest' ? 'owner’s interest' : 'K-1 record'} for this period could not be selected (the resolver gave no usable answer).`;
  return { id: null, version: null, pending: { kind, reason: r?.status === 'conflict' ? `Conflict: ${why}` : why } };
}
// Resolve both references of one row for one period. ret: { entity_id, period_start, period_end }.
export async function resolveRefs(db, { orgId, ret, interestPartyId, k1IssuerPartyId, resolvers }) {
  const period = { periodStart: ret.period_start, periodEnd: ret.period_end };
  const out = { interestId: null, interestVersion: null, k1SourceId: null, k1SourceVersion: null, pending: [] };
  if (interestPartyId) {
    const a = normalizeAnswer('interest', await resolvers.interest({ db, orgId, issuerEntityId: ret.entity_id, partyId: interestPartyId, ...period }));
    out.interestId = a.id; out.interestVersion = a.version; if (a.pending) out.pending.push(a.pending);
  }
  if (k1IssuerPartyId) {
    const a = normalizeAnswer('k1', await resolvers.k1({ db, orgId, recipientEntityId: ret.entity_id, issuerPartyId: k1IssuerPartyId, ...period }));
    out.k1SourceId = a.id; out.k1SourceVersion = a.version; if (a.pending) out.pending.push(a.pending);
  }
  return out;
}
// Whether a stored row's references still match what the resolvers select now (coverage checks this before calling anything complete,
// and shows these reasons instead of the stored ones, so a pending reason is always the current one — Codex r2 hardening 3).
// Returns the problems, [] when every reference is selected and unchanged.
export async function referenceDrift(db, { orgId, ret, row, resolvers }) {
  if (!row.interest_party_id && !row.k1_issuer_party_id) return [];
  const now = await resolveRefs(db, { orgId, ret, interestPartyId: row.interest_party_id, k1IssuerPartyId: row.k1_issuer_party_id, resolvers });
  const problems = [];
  if (row.interest_party_id) {
    if (!now.interestId) problems.push(now.pending.find(p => p.kind === 'interest')?.reason ?? 'The owner’s interest is not selected.');
    else if (now.interestId !== (row.interest_id === null ? null : Number(row.interest_id)) || now.interestVersion !== row.interest_version) {
      problems.push('The owner’s interest selected for this period changed since this was saved: re-resolve the references.');
    }
  }
  if (row.k1_issuer_party_id) {
    if (!now.k1SourceId) problems.push(now.pending.find(p => p.kind === 'k1')?.reason ?? 'The K-1 record is not selected.');
    else if (now.k1SourceId !== (row.k1_source_id === null ? null : Number(row.k1_source_id)) || now.k1SourceVersion !== row.k1_source_version) {
      problems.push('The K-1 record selected for this period changed (corrected or superseded) since this was saved: re-resolve the references.');
    }
  }
  return problems;
}
