// lib/tax/ownership.js
// Owners and members of one company (spec §4.8; ownership_interest, migration 065 — pulled forward from T4 at the owner's request,
// 2026-10-16): who holds an interest, in what role, from when to when, with exact profit, loss and capital fractions. A fraction left
// blank is UNKNOWN: it blocks whatever depends on it and is never read as zero. History is kept like household members: an owner's
// change on a later date closes the earlier row the day before and adds a new one; a change re-saved on its own date corrects it;
// nothing is deleted. Capital accounts, basis, liabilities, allocations and K-1s are stage T4's, built on these rows.
// The database keeps the WHOLE history valid after every change (migration 065 tax_check_roster, Codex t2-plan-r5 R5-N1): no owner twice
// on one day, one single member at a time, stated shares at most 1 on every day, and every interest in a return period in a role that
// period's return takes. Its refusals come back here as ordinary validation messages.
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { isIsoDate } from '../domain/dates.js';
import { parseShare, sumFractions } from './partition.js';
import { lockTaxGraph } from './bindings.js';

const fail = message => { throw new ValidationError(message); };
export const OWNER_ROLES = [['general_partner', 'General partner / member-manager'], ['limited_partner', 'Limited partner / member'], ['shareholder', 'Shareholder'],
  ['single_member', 'Single member']];
// Which roles a company's return takes (its profile's return type).
export const ROLES_FOR = { form_1065: ['general_partner', 'limited_partner'], form_1120s: ['shareholder'], disregarded: ['single_member'], household_1040: [] };
const dayBefore = d => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
const FRACTIONS = ['profit', 'loss', 'capital'];
// A roster rule the database refused (raised as 'ownership_interest: …'), as the message a person reads.
async function guarded(work) {
  try { return await work(); } catch (error) {
    if (error?.code === 'P0001' && /^ownership_interest: /.test(error.message)) fail(error.message.replace(/^ownership_interest: /, '').replace(/^./, c => c.toUpperCase()) + '.');
    throw error;
  }
}

const COLS = `o.interest_id, o.entity_id, o.party_id, p.name AS party_name, p.kind AS party_kind, p.entity_id AS party_entity_id, o.role, o.effective_from::text AS effective_from, o.effective_to::text AS effective_to,
  o.profit_num::text AS profit_num, o.profit_den::text AS profit_den, o.loss_num::text AS loss_num, o.loss_den::text AS loss_den, o.capital_num::text AS capital_num,
  o.capital_den::text AS capital_den, o.created_by`;
// Every row of the company, history included, newest first per owner.
export async function listInterests(db, { orgId, entityId }) {
  const { rows } = await db.query(`SELECT ${COLS} FROM ownership_interest o JOIN tax_party p ON p.org_id = o.org_id AND p.party_id = o.party_id
    WHERE o.org_id = $1 AND o.entity_id = $2 ORDER BY lower(p.name), o.effective_from DESC`, [orgId, entityId]);
  return rows.map(r => ({ ...r, interest_id: Number(r.interest_id), party_id: Number(r.party_id) }));
}
export const fractionText = (num, den) => (num === null || num === undefined ? 'unknown' : `${num}/${den}`);

// One owner's interest from a date. fields: { partyId, role, from, to, profit, loss, capital } — each fraction "1/2", "25%" or blank (unknown).
export async function saveInterest(pool, { orgId, entityId, fields: f, actor }) {
  const partyId = /^\d{1,16}$/.test(String(f.partyId ?? '')) ? Number(f.partyId) : fail('Choose the owner.');
  if (!isIsoDate(f.from)) fail('Enter the date the interest starts.');
  if (f.to && (!isIsoDate(f.to) || f.to < f.from)) fail('The end date is on or after the start date, or blank.');
  const fr = {};
  for (const k of FRACTIONS) {
    const text = String(f[k] ?? '').trim();
    fr[k] = text ? parseShare(text) ?? (text === '0' ? { num: 0n, den: 1n } : fail(`The ${k} share is a fraction like 1/3 or a percentage like 25%, or blank when not known yet.`)) : null;
  }
  return guarded(() => withTransaction(pool, async tx => {
    // The graph lock first (the one order of every Tax Books write): bindings resolve their owner references against these rows.
    await lockTaxGraph(tx, orgId);
    await lockEntity(tx, orgId, entityId);
    // The role a return takes: the return type of every period the interest falls in (the period's own facts, Codex r5 R5-N1); outside any
    // period, the company's defaults for its next period. The database checks the periods again, over the whole history.
    const { rows: periods } = await tx.query(`SELECT DISTINCT return_type FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_start <= coalesce($4::date, 'infinity') AND period_end >= $3::date`,
      [orgId, entityId, f.from, f.to || null]);
    const { rows: [prof] } = await tx.query('SELECT return_type FROM tax_profile WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
    const types = periods.length ? periods.map(p => p.return_type) : [prof?.return_type ?? fail('Set the return this company files first (Return and defaults).')];
    for (const rt of types) {
      const allowed = ROLES_FOR[rt] ?? [];
      if (!allowed.includes(f.role)) fail(allowed.length ? `This company's return takes ${allowed.map(r => OWNER_ROLES.find(([k]) => k === r)[1].toLowerCase()).join(' or ')} owners${periods.length ? ' for those dates' : ''}.` : 'A household return has no owners.');
    }
    const { rows: [p] } = await tx.query('SELECT kind, entity_id FROM tax_party WHERE org_id = $1 AND party_id = $2 AND active', [orgId, partyId]);
    if (!p) fail('Choose the owner.');
    if (p.kind === 'entity_in_org' && Number(p.entity_id) === Number(entityId)) fail('A company is not its own owner.');
    const { rows: later } = await tx.query('SELECT 1 FROM ownership_interest WHERE org_id = $1 AND entity_id = $2 AND party_id = $3 AND effective_from > $4 LIMIT 1', [orgId, entityId, partyId, f.from]);
    if (later.length) fail('A later change of this owner’s interest already exists; change that one.');
    const vals = FRACTIONS.flatMap(k => (fr[k] ? [fr[k].num.toString(), fr[k].den.toString()] : [null, null]));
    const { rows: [same] } = await tx.query('SELECT interest_id FROM ownership_interest WHERE org_id = $1 AND entity_id = $2 AND party_id = $3 AND effective_from = $4', [orgId, entityId, partyId, f.from]);
    let id;
    if (same) {
      // Re-saved on its own date: a correction of that change (a binding that selected it sees a new version and is refreshed).
      await tx.query(`UPDATE ownership_interest SET role = $2, effective_to = $3, profit_num = $4, profit_den = $5, loss_num = $6, loss_den = $7, capital_num = $8, capital_den = $9
        WHERE interest_id = $1`, [same.interest_id, f.role, f.to || null, ...vals]);
      id = Number(same.interest_id);
    } else {
      // Earlier and still open on that date: closed the day before, kept as history.
      await tx.query(`UPDATE ownership_interest SET effective_to = $5 WHERE org_id = $1 AND entity_id = $2 AND party_id = $3 AND effective_from < $4 AND (effective_to IS NULL OR effective_to >= $4)`,
        [orgId, entityId, partyId, f.from, dayBefore(f.from)]);
      const { rows: [r] } = await tx.query(`INSERT INTO ownership_interest (org_id, entity_id, party_id, role, effective_from, effective_to, profit_num, profit_den, loss_num, loss_den, capital_num, capital_den, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING interest_id`, [orgId, entityId, partyId, f.role, f.from, f.to || null, ...vals, actor ?? 'system']);
      id = Number(r.interest_id);
    }
    return id;
  }));
}
// An owner's interest ends on a date (kept as history).
export async function endInterest(pool, { orgId, entityId, interestId, to }) {
  if (!isIsoDate(to)) fail('Enter the date the interest ends.');
  // Through the same roster check as a save: an end date can never stretch an interest across its successor.
  return guarded(() => withTransaction(pool, async tx => {
    await lockTaxGraph(tx, orgId);
    await lockEntity(tx, orgId, entityId);
    const { rows: [r] } = await tx.query('SELECT effective_from::text AS f FROM ownership_interest WHERE org_id = $1 AND entity_id = $2 AND interest_id = $3', [orgId, entityId, Number(interestId) || 0]);
    if (!r) fail('That interest is not this company’s.');
    if (to < r.f) fail('An interest ends on or after the day it starts.');
    await tx.query('UPDATE ownership_interest SET effective_to = $3 WHERE org_id = $1 AND interest_id = $2', [orgId, Number(interestId), to]);
  }));
}
// The roster for one period: { rows, status: 'complete' | 'incomplete', problems }. Complete when the same owners hold the company for the
// whole period, each owner once, in roles the period's return takes (returnType: the period's own), every fraction is known and each kind
// totals exactly 1. A change inside the period is T4's (allocation across it). An incomplete roster blocks every output that needs the
// fractions — T4's capital accounts, allocations and K-1s (T2 computes none); routing a known owner's book transaction does not need them.
export async function rosterFor(db, { orgId, entityId, periodStart, periodEnd, returnType = null }) {
  const { rows } = await db.query(`SELECT ${COLS} FROM ownership_interest o JOIN tax_party p ON p.org_id = o.org_id AND p.party_id = o.party_id
    WHERE o.org_id = $1 AND o.entity_id = $2 AND o.effective_from <= $4::date AND (o.effective_to IS NULL OR o.effective_to >= $3::date) ORDER BY lower(p.name)`, [orgId, entityId, periodStart, periodEnd]);
  const problems = [];
  if (!rows.length) problems.push('No owners are on file for this period.');
  if (rows.some(r => r.effective_from > periodStart || (r.effective_to && r.effective_to < periodEnd))) problems.push('The owners change during the period: allocating across a change is a later stage (T4).');
  if (new Set(rows.map(r => r.party_id)).size !== rows.length) problems.push('An owner holds two interests in this period.');
  const roles = returnType ? ROLES_FOR[returnType] ?? [] : null;
  if (roles && rows.some(r => !roles.includes(r.role))) problems.push('Some owners hold a role this period’s return does not take.');
  // The owners' own identities, checked independently of the write guards (Codex t2-r1 B5).
  if (rows.some(r => r.party_kind === 'entity_in_org' && Number(r.party_entity_id) === Number(entityId))) problems.push('The company is listed as its own owner: correct the owner’s party.');
  if (rows.some(r => r.role === 'shareholder' && !['individual', 'grantor_trust', 'trust'].includes(r.party_kind))) problems.push('A shareholder is not a person or a trust: correct the owner’s party.');
  for (const k of FRACTIONS) {
    if (rows.some(r => r[`${k}_num`] === null)) { problems.push(`Some ${k} shares are not known yet.`); continue; }
    const t = sumFractions(rows.map(r => ({ num: BigInt(r[`${k}_num`]), den: BigInt(r[`${k}_den`]) })));
    if (rows.length && t.num !== t.den) problems.push(`The ${k} shares total ${t.num}/${t.den}, not 1.`);
  }
  return { rows, status: problems.length ? 'incomplete' : 'complete', problems };
}
