import { ValidationError } from '../writes.js';
import { isIsoDate } from '../../domain/dates.js';
import { centsFromDb, negCents } from './clock.js';
import { readHomeCurrencyScope, homeCents } from './balances.js';
import { validateMorningIdentityIn } from './access.js';
import { ensurePostingFacts } from './posting-facts.js';

export const ENTRY_TEXT = Object.freeze({
  heading:'Recently added or edited entries — current amounts',
  limitation:'This list shows entries added or edited since the comparison look, at their current amounts. It is not a complete change log.',
  residual:'Balance change also includes edits, removals or other adjustments not explained by this list.',
  transfer:'Possible intercompany transfer (unconfirmed)',
});
export const entryResidual = ({windowNetAvailableCents,observedAvailableChangeCents}) => windowNetAvailableCents == null || observedAvailableChangeCents == null
  ? null : centsFromDb(windowNetAvailableCents) !== centsFromDb(observedAvailableChangeCents);
const positiveId = n => Number.isSafeInteger(n) && n > 0;
const exactKeys = (o, keys) => o && typeof o === 'object' && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
function validate({ orgId, from, to, today, limit }) {
  if (!positiveId(orgId) || !from || !to || !Number.isFinite(+new Date(from)) || !Number.isFinite(+new Date(to)) || new Date(from)>new Date(to)
    || !isIsoDate(today) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new ValidationError('Invalid entry window or page');
}
async function validateAccount(tx, { orgId, accountId, context }) {
  if (!positiveId(accountId)) throw new ValidationError('Invalid account');
  if ((await tx.query("SELECT 1 FROM account WHERE org_id=$1 AND account_id=$2 AND type IN ('bank','credit_card')", [orgId,accountId])).rowCount) return;
  if (context?.identity?.orgId === orgId) {
    await validateMorningIdentityIn(tx, {identity:context.identity});
    if ((await tx.query(`SELECT 1 FROM morning_snapshot_account a WHERE org_id=$1 AND viewer_key=$2 AND observed_account_id=$4
      AND (generation_id=$3 OR EXISTS(SELECT 1 FROM morning_visit v WHERE v.org_id=a.org_id AND v.viewer_key=a.viewer_key
        AND a.generation_id IN(v.comparison_generation_id,v.latest_generation_id)))`,
      [orgId,context.identity.viewerKey,context.generationId,accountId])).rowCount) return;
  }
  throw Object.assign(new ValidationError('Account not found'), {status:404});
}
// All postings are netted before display thresholds; only the optional account scope is narrowed.
const windowSql = `WITH current AS MATERIALIZED (
  SELECT txn_id,entity_id,account_id,account_type,type,txn_date,m,kind,home_supported
  FROM mv_posting_fact WHERE seed AND m<>0 AND ($1::bigint IS NULL OR account_id=$1)
)`;
export async function readWindowEntries(tx, { orgId, from, to, today, thresholdCents, accountId = null, limit = 50, after = null, budget = tx, context = null }) {
  validate({orgId,from,to,today,limit});
  if (!Number.isSafeInteger(thresholdCents) || thresholdCents < 0) throw new ValidationError('Invalid detail threshold');
  if (after && (!exactKeys(after,['date','entityId','txnId','accountId']) || !isIsoDate(after.date) || ![after.entityId,after.txnId,after.accountId].every(positiveId)
    || accountId !== null && accountId !== after.accountId)) throw new ValidationError('Invalid entry cursor');
  if (accountId !== null) await validateAccount(tx, {orgId,accountId,context});
  const scope = await readHomeCurrencyScope(tx, {orgId});
  await ensurePostingFacts(tx, {orgId,today,window:{from,to},budget});
  const values = [accountId,thresholdCents];
  const { rows: [totalsRow] } = await tx.query(`${windowSql}, bounded AS (SELECT *,m::text AS amount FROM current
    WHERE (NOT home_supported OR abs(m)>=$2) AND ($3::date IS NULL OR txn_date<$3
      OR (txn_date=$3 AND (entity_id,txn_id,account_id)>($4,$5,$6)))
    ORDER BY txn_date DESC,entity_id,txn_id,account_id LIMIT $7), page AS (
    SELECT b.*,a.name account_name,e.name entity_name FROM bounded b JOIN account a USING(account_id)
    JOIN entity e ON e.entity_id=b.entity_id ORDER BY b.txn_date DESC,b.entity_id,b.txn_id,b.account_id) SELECT
    count(*) FILTER(WHERE abs(m)>=$2)::text AS "aboveCount",count(*) FILTER(WHERE abs(m)<$2)::text AS "smallCount",
    coalesce(sum(m) FILTER(WHERE abs(m)<$2 AND m>0),0)::text AS "smallPositiveCents",
    coalesce(sum(m) FILTER(WHERE abs(m)<$2 AND m<0),0)::text AS "smallNegativeCents",
    coalesce(sum(m) FILTER(WHERE abs(m)<$2),0)::text AS "smallNetCents",coalesce(sum(m),0)::text AS "windowNetAvailableCents",
    coalesce(sum(m) FILTER(WHERE account_type='bank' AND m>0),0)::text AS "bankInCents",
    coalesce(sum(m) FILTER(WHERE account_type='bank' AND m<0),0)::text AS "bankOutCents",
    coalesce(sum(-m) FILTER(WHERE account_type='credit_card' AND m<0),0)::text AS "cardChargesCents",
    coalesce(sum(m) FILTER(WHERE account_type='credit_card' AND m>0),0)::text AS "cardCreditsCents",
    count(*) FILTER(WHERE NOT home_supported)::text AS unsupported,
    coalesce((SELECT jsonb_agg(page) FROM page),'[]') page FROM current`,
    [...values,after?.date ?? null,after?.entityId ?? null,after?.txnId ?? null,after?.accountId ?? null,limit+1]);
  const { unsupported, page:rows, ...amounts } = totalsRow;
  const incomplete = centsFromDb(unsupported) > 0;
  // Threshold classification also depends on USD: unknown-home rows are shown as unavailable.
  const totals = Object.fromEntries(Object.entries(amounts).map(([key,value]) => [key,incomplete ? null : centsFromDb(value)]));
  const page = [];
  for (const r of rows.slice(0,limit)) {
    budget.check();
    const netCents = homeCents(scope,r.entity_id,r.amount);
    page.push({entityId:r.entity_id,entityName:r.entity_name,txnId:r.txn_id,type:r.type,date:r.txn_date,accountId:r.account_id,
      accountName:r.account_name,accountType:r.account_type,netCents,kind:r.kind,
      cardOwedEffectCents:r.account_type === 'credit_card' && netCents !== null ? negCents(netCents) : null,availableEffectCents:netCents,
      coverage:netCents === null ? 'unsupported_home_currency' : 'known'});
  }
  const last = page.at(-1);
  return {totals,page,next:rows.length>limit ? {date:last.date,entityId:last.entityId,txnId:last.txnId,accountId:last.accountId} : null,
    coverage:{known:!incomplete,unavailable:scope.unavailable,unsupportedEntries:centsFromDb(unsupported)}};
}

// Accepted bucket arithmetic: seven probes per distinct company/amount/sign/day, never per pair.
// Exported so the independent exhaustive oracle can exercise this exact SQL.
// Treat the correlated eligibility facts as one predicate: multiplying their
// default temp-table selectivities estimated one leg for 100,001 actual legs.
// Materialize bucket degrees so that plan choice cannot repeat that aggregate.
export const TRANSFER_DEGREES_SQL = `WITH leg AS (
 SELECT txn_id,account_id,entity_id,account_type,m,first_date,
 row_number() OVER(ORDER BY entity_id,txn_id,account_id) ordinal FROM mv_transfer_net
 WHERE CASE WHEN seed AND home_supported AND account_type='bank' AND first_date=last_date THEN true ELSE false END
), daily AS (
 SELECT abs(m) amount,sign(m) direction,first_date date,count(*) n,sum(ordinal) ids FROM leg GROUP BY 1,2,3
), entity_day AS (
 SELECT entity_id,abs(m) amount,sign(m) direction,first_date date,count(*) n,sum(ordinal) ids FROM leg GROUP BY 1,2,3,4
), bucket_degree AS MATERIALIZED (
 SELECT l.entity_id,l.amount,l.direction,l.date,
 sum(coalesce(d.n,0)-coalesce(e.n,0)) degree,sum(coalesce(d.ids,0)-coalesce(e.ids,0)) partner
 FROM entity_day l CROSS JOIN generate_series(-3,3) offset_day
 LEFT JOIN daily d ON d.amount=l.amount AND d.direction=-l.direction AND d.date=l.date+offset_day
 LEFT JOIN entity_day e ON e.amount=d.amount AND e.direction=d.direction AND e.date=d.date AND e.entity_id=l.entity_id
 GROUP BY l.entity_id,l.amount,l.direction,l.date
), degree AS (
 SELECT l.*,d.degree,d.partner FROM leg l JOIN bucket_degree d
 ON d.entity_id=l.entity_id AND d.amount=abs(l.m) AND d.direction=sign(l.m) AND d.date=l.first_date
)`;
export const TRANSFER_RELATIONS_SQL = `WITH mv_transfer_net AS MATERIALIZED (
  SELECT txn_id,entity_id,account_id,account_type,m,first_date,last_date,seed,home_supported FROM mv_posting_fact WHERE seed AND m<>0),
  mv_transfer_degree AS MATERIALIZED (${TRANSFER_DEGREES_SQL} SELECT * FROM degree)`;
const pairsSql = `WITH pairs AS (
 SELECT least(l.txn_id,r.txn_id) lo,greatest(l.txn_id,r.txn_id) hi,
 l.entity_id out_entity,l.txn_id out_txn,l.account_id out_account,r.entity_id in_entity,r.txn_id in_txn,r.account_id in_account
 FROM mv_transfer_degree l JOIN mv_transfer_degree r ON r.ordinal=l.partner AND r.partner=l.ordinal
 WHERE l.degree=1 AND r.degree=1 AND l.m<0
)`;
const validLeg = leg => exactKeys(leg,['entityId','txnId','accountId']) && [leg.entityId,leg.txnId,leg.accountId].every(positiveId);
export async function transferSuggestions(tx, { orgId, from, to, today, after = null, limit = 50, budget = tx }) {
  validate({orgId,from,to,today,limit});
  if (after && (!exactKeys(after,['lo','hi','out','in']) || !positiveId(after.lo) || !positiveId(after.hi) || !validLeg(after.out) || !validLeg(after.in)
    || after.lo !== Math.min(after.out.txnId,after.in.txnId) || after.hi !== Math.max(after.out.txnId,after.in.txnId))) throw new ValidationError('Invalid transfer cursor');
  const scope = await readHomeCurrencyScope(tx, {orgId});
  await ensurePostingFacts(tx, {orgId,today,window:{from,to},budget});
  const a = after;
  const { rows: [counts] } = await tx.query(`${TRANSFER_RELATIONS_SQL},
    ${pairsSql.slice(5)}, page AS (SELECT * FROM pairs WHERE ($1::bigint IS NULL OR
    (lo,hi,out_entity,out_txn,out_account,in_entity,in_txn,in_account)>($1,$2,$3,$4,$5,$6,$7,$8))
    ORDER BY lo,hi,out_entity,out_txn,out_account,in_entity,in_txn,in_account LIMIT $9)
    SELECT (SELECT count(*)::text FROM pairs) AS n,
    (SELECT count(*)::text FROM mv_transfer_net WHERE home_supported AND account_type='bank' AND first_date<>last_date) AS skipped,
    coalesce((SELECT jsonb_agg(page) FROM page),'[]') page`,
  [a?.lo??null,a?.hi??null,a?.out.entityId??null,a?.out.txnId??null,a?.out.accountId??null,a?.in.entityId??null,a?.in.txnId??null,a?.in.accountId??null,limit+1]);
  budget.check();
  const rows=counts.page;
  const page = rows.slice(0,limit).map(r => ({out:{entityId:r.out_entity,txnId:r.out_txn,accountId:r.out_account},in:{entityId:r.in_entity,txnId:r.in_txn,accountId:r.in_account}}));
  const last = rows[Math.min(limit,rows.length)-1];
  return {count:centsFromDb(counts.n),skippedMultiDate:centsFromDb(counts.skipped),page,
    next:rows.length>limit ? {lo:last.lo,hi:last.hi,...page.at(-1)} : null,coverage:{known:scope.unavailable.length===0,unavailable:scope.unavailable}};
}
