import { randomUUID } from 'node:crypto';
import { centsFromDb } from './clock.js';
import { companyTotals } from './balances.js';

export const REUSE_MS = 60 * 60 * 1000;
const visitOf = v => ({comparisonId:v?.comparison_generation_id ?? null,latestId:v?.latest_generation_id ?? null,anchorAt:v?.reuse_anchor_at ?? null,
  latestShownAt:v?.latest_shown_at ?? null,comparisonAt:v?.comparison_at ?? null,latestAt:v?.latest_at ?? null});
const generationColumns = `g.generation_id,g.captured_at,g.as_of_date,
  coalesce((SELECT jsonb_agg(c ORDER BY c."entityId") FROM (
    SELECT observed_entity_id AS "entityId",entity_name AS name,is_personal AS "isPersonal"
    FROM morning_snapshot_company WHERE org_id=g.org_id AND viewer_key=g.viewer_key AND generation_id=g.generation_id) c),'[]') companies,
  coalesce((SELECT jsonb_agg(a ORDER BY a."accountId") FROM (
    SELECT observed_account_id AS "accountId",observed_entity_id AS "entityId",account_name AS name,
      account_type AS type,active,signed_cents::text AS "signedCents" FROM morning_snapshot_account
    WHERE org_id=g.org_id AND viewer_key=g.viewer_key AND generation_id=g.generation_id) a),'[]') accounts`;
export const computationPreferenceSql = `SELECT p.detail_threshold_cents,
  coalesce((SELECT jsonb_agg(jsonb_build_array(f.account_id,f.floor_cents::text)) FROM morning_floor f
    WHERE f.org_id=p.org_id AND f.viewer_key=p.viewer_key),'[]') floors,
  coalesce((SELECT jsonb_agg(jsonb_build_array(s.entity_id,s.large_threshold_cents::text)) FROM morning_company_setting s
    WHERE s.org_id=p.org_id),'[]') thresholds
  FROM morning_preference p WHERE p.org_id=$1 AND p.viewer_key=$2`;
async function generationOf(tx, g) {
  if (!g?.generation_id) return null;
  const {companies, accounts} = g;
  for (let i=0;i<accounts.length;i++) {
    if (i%256===0) await tx.checkpoint();
    accounts[i].signedCents=centsFromDb(accounts[i].signedCents);
  }
  return {generationId:g.generation_id,capturedAt:g.captured_at,asOfDate:g.as_of_date,companies,accounts};
}
// Select only the generation needed for this response, along with its visit and
// computation preferences. All copied account/company rows stay in this snapshot.
export async function readObservation(tx, {orgId,viewerKey,N}) {
  if (!Number.isFinite(N.getTime())) throw new Error('Clock unavailable');
  const {rows:[r]}=await tx.query(`SELECT v.*,c.captured_at comparison_at,l.captured_at latest_at,
    ${generationColumns},(SELECT row_to_json(p) FROM (${computationPreferenceSql}) p) preference
    FROM (VALUES(1)) singleton(n)
    LEFT JOIN morning_visit v ON v.org_id=$1 AND v.viewer_key=$2
    LEFT JOIN morning_snapshot_generation c ON c.org_id=v.org_id AND c.viewer_key=v.viewer_key AND c.generation_id=v.comparison_generation_id
    LEFT JOIN morning_snapshot_generation l ON l.org_id=v.org_id AND l.viewer_key=v.viewer_key AND l.generation_id=v.latest_generation_id
    LEFT JOIN morning_snapshot_generation g ON g.org_id=v.org_id AND g.viewer_key=v.viewer_key AND g.generation_id=
      CASE WHEN $3::timestamptz>=v.latest_shown_at AND $3::timestamptz>=v.reuse_anchor_at+interval '60 minutes'
        THEN v.latest_generation_id ELSE v.comparison_generation_id END`,[orgId,viewerKey,N]);
  const visit=visitOf(r);
  return {visit,decision:decideComparison(visit,N),comparison:await generationOf(tx,r),preference:r.preference};
}
export async function readVisit(tx, { orgId, viewerKey }) {
  const { rows: [v] } = await tx.query(`SELECT v.comparison_generation_id,v.latest_generation_id,v.reuse_anchor_at,v.latest_shown_at,
    c.captured_at AS comparison_at,l.captured_at AS latest_at FROM morning_visit v
    LEFT JOIN morning_snapshot_generation c ON c.org_id=v.org_id AND c.viewer_key=v.viewer_key AND c.generation_id=v.comparison_generation_id
    LEFT JOIN morning_snapshot_generation l ON l.org_id=v.org_id AND l.viewer_key=v.viewer_key AND l.generation_id=v.latest_generation_id
    WHERE v.org_id=$1 AND v.viewer_key=$2`, [orgId, viewerKey]);
  return visitOf(v);
}
export function decideComparison(visit, N) {
  if (!Number.isFinite(N.getTime())) throw new Error('Clock unavailable');
  if (visit.latestShownAt && N < visit.latestShownAt) return {mode:'clock_unavailable',comparisonId:visit.comparisonId};
  if (!visit.latestId) return {mode:'first_look',comparisonId:null};
  if (N - visit.anchorAt < REUSE_MS) return {mode:'reuse',comparisonId:visit.comparisonId};
  return {mode:'promote',comparisonId:visit.latestId};
}
export async function loadGeneration(tx, { orgId, viewerKey, generationId }) {
  const {rows:[g]}=await tx.query(`SELECT ${generationColumns} FROM morning_snapshot_generation g
    WHERE g.org_id=$1 AND g.viewer_key=$2 AND g.generation_id=$3`,[orgId,viewerKey,generationId]);
  return generationOf(tx,g);
}
export async function persistObservation(tx, { orgId, viewerKey, N, today, vector, visit, decision }) {
  tx.check();
  if (decision.mode === 'clock_unavailable') throw new Error('Clock unavailable');
  const actual = decideComparison(visit, N);
  if (actual.mode !== decision.mode || actual.comparisonId !== decision.comparisonId) throw new Error('Comparison changed');
  if (companyTotals(vector).grand.status !== 'ok') throw new Error('Incomplete balance vector');
  const generationId = randomUUID();
  const companies = [], accounts = [];
  for (let i = 0; i < vector.companies.length; i++) {
    if (i % 256 === 0) await tx.checkpoint();
    const c = vector.companies[i]; companies.push({id:c.entityId,name:c.name,personal:c.isPersonal});
  }
  for (let i = 0; i < vector.accounts.length; i++) {
    if (i % 256 === 0) await tx.checkpoint();
    const a = vector.accounts[i]; accounts.push({id:a.accountId,entity:a.entityId,name:a.name,type:a.type,active:a.active,cents:centsFromDb(a.signedCents)});
  }
  const anchor = decision.mode === 'reuse' ? visit.anchorAt : N;
  await tx.query(`WITH generation AS (
    INSERT INTO morning_snapshot_generation(org_id,viewer_key,generation_id,captured_at,as_of_date)
    VALUES($1,$2,$3,$4,$5) RETURNING org_id,viewer_key,generation_id
  ), companies AS (
    INSERT INTO morning_snapshot_company(org_id,viewer_key,generation_id,observed_entity_id,entity_name,is_personal)
    SELECT g.org_id,g.viewer_key,g.generation_id,c.id,c.name,c.personal FROM generation g
      CROSS JOIN jsonb_to_recordset($6::jsonb) AS c(id bigint,name text,personal boolean)
    RETURNING org_id,viewer_key,generation_id,observed_entity_id
  ), accounts AS (
    INSERT INTO morning_snapshot_account(org_id,viewer_key,generation_id,observed_account_id,observed_entity_id,account_name,account_type,active,signed_cents)
    SELECT $1,$2,$3,a.id,a.entity,a.name,a.type,a.active,a.cents
      FROM jsonb_to_recordset($7::jsonb) AS a(id bigint,entity bigint,name text,type text,active boolean,cents bigint)
      CROSS JOIN (SELECT count(*) FROM companies) written
    RETURNING observed_account_id
  ) INSERT INTO morning_visit(org_id,viewer_key,comparison_generation_id,latest_generation_id,reuse_anchor_at,latest_shown_at)
    SELECT $1,$2,$8,$3,$9,$4 FROM (SELECT count(*) FROM accounts) written
    ON CONFLICT(org_id,viewer_key) DO UPDATE SET comparison_generation_id=excluded.comparison_generation_id,
    latest_generation_id=excluded.latest_generation_id,reuse_anchor_at=excluded.reuse_anchor_at,latest_shown_at=excluded.latest_shown_at,
    visit_version=morning_visit.visit_version+1`, [orgId,viewerKey,generationId,N,today,JSON.stringify(companies),JSON.stringify(accounts),decision.comparisonId,anchor]);
  tx.check();
  return {generationId};
}
// The hourly caller owns SECURITY exclusive; this helper never acquires COMPUTE/OBSERVE.
export async function pruneGenerations(db, { orgId, now }) {
  const cutoff = new Date(now.getTime() - 90 * 86400000);
  const result = await db.query(`DELETE FROM morning_snapshot_generation g WHERE g.org_id=$1 AND g.captured_at<$2
    AND NOT EXISTS(SELECT 1 FROM morning_visit v WHERE v.org_id=g.org_id AND v.viewer_key=g.viewer_key
      AND (v.comparison_generation_id=g.generation_id OR v.latest_generation_id=g.generation_id))`, [orgId,cutoff]);
  return result.rowCount;
}
