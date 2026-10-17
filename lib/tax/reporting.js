// lib/tax/reporting.js
// Where a disregarded company's books are reported, for ONE period (Codex t2-plan-r5 R5-N5, r6 R6-N3): the inclusion chain followed upward
// from the company's period — the return that includes it, and if that return is itself a disregarded company's, the return that includes
// THAT company for its period, and so on — to the filing return (a partnership's, an S corporation's or a household's). Whether the books
// are actually REPORTED there is decided by the same canonical rule coverage uses: the filing return's effective inclusion graph
// (migration 065 tax_inclusion_sources) must list the company with period_matches — so this page and coverage can never disagree (a
// part-year edge anywhere on the path blocks). The graph answers for the filing return's OWN dates, so the filing period must also cover
// the requested period (Codex r7 R7-N2): a full-year company included in a short-year return is reported only for the days that return
// covers — partly reported, the rest not included in any return and blocked. Reads only.
//   → { hops: [{ entityId, name, returnType, year }], filing: hop | null, blocked, partial }  (blocked: the chain reaches a filing return
//      that cannot combine these books — or not all of the period — yet; partial: { covered: { start, end }, uncovered: [{ start, end }] }
//      when the filing return, the last hop, covers only part of the period; filing null and blocked false: not included in a filing
//      return for that period)
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export async function reportingChain(db, { orgId, entityId, periodStart, periodEnd }) {
  const hops = [], seen = new Set([Number(entityId)]);
  const from = String(periodStart), to = String(periodEnd);
  let cur = Number(entityId), ps = from, pe = to;
  for (let depth = 0; depth < 64; depth += 1) {
    const { rows: [e] } = await db.query(`SELECT r.return_id, r.entity_id, r.return_type, r.period_start::text AS rs, r.period_end::text AS re, n.name
        FROM activity_inclusion i JOIN tax_return r ON r.org_id = i.org_id AND r.return_id = i.return_id JOIN entity n ON n.org_id = r.org_id AND n.entity_id = r.entity_id
       WHERE i.org_id = $1 AND i.source_entity_id = $2 AND i.period_start <= $4::date AND i.period_end >= $3::date ORDER BY i.period_end DESC LIMIT 1`, [orgId, cur, ps, pe]);
    if (!e) return { hops, filing: null, blocked: false, partial: null };
    const hop = { entityId: Number(e.entity_id), name: e.name, returnType: e.return_type, year: Number(e.re.slice(0, 4)) };
    hops.push(hop);
    if (e.return_type !== 'disregarded') {
      const { rows: [g] } = await db.query('SELECT period_matches FROM tax_inclusion_sources($1, $2) WHERE source_entity_id = $3', [orgId, e.return_id, Number(entityId)]);
      if (!g?.period_matches) return { hops, filing: null, blocked: true, partial: null };
      if (e.rs <= from && e.re >= to) return { hops, filing: hop, blocked: false, partial: null };
      // The filing return covers only part of the requested period: coverage measures these books for its dates only.
      const covered = { start: e.rs > from ? e.rs : from, end: e.re < to ? e.re : to };
      if (covered.start > covered.end) return { hops, filing: null, blocked: false, partial: null };
      const uncovered = [...(from < covered.start ? [{ start: from, end: addDays(covered.start, -1) }] : []), ...(covered.end < to ? [{ start: addDays(covered.end, 1), end: to }] : [])];
      return { hops, filing: null, blocked: true, partial: { covered, uncovered } };
    }
    if (seen.has(hop.entityId)) return { hops, filing: null, blocked: false, partial: null };
    seen.add(hop.entityId);
    cur = hop.entityId; ps = e.rs; pe = e.re;
  }
  return { hops, filing: null, blocked: false, partial: null };
}
