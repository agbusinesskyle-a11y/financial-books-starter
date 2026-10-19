import { createHash } from 'node:crypto';
import { ValidationError } from '../writes.js';
import { centsFromDb } from './clock.js';

export const RULE_VERSIONS = Object.freeze({ bank: 1, bill: 1, invoice: 1, tax: 1, 'tax-coverage': 1, floor: 1, 'new-payee': 1, duplicate: 1, large: 1 });
const rules = Object.keys(RULE_VERSIONS);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function itemVersion(rule, facts) {
  if (!rules.includes(rule)) throw new ValidationError('Unknown rule');
  return createHash('sha256').update(`${rule}|${RULE_VERSIONS[rule]}|${canonical(facts)}`).digest('hex');
}
const pick = (item, keys) => Object.fromEntries(keys.split(' ').map(k => [k, item[k]]));
export function versionFacts(item) {
  switch (item.rule) {
    case 'bank': case 'duplicate': return item.version;
    case 'bill': return { ...pick(item, 'open due approval severity'), reasons: [...item.reasons].sort() };
    case 'invoice': return pick(item, 'type open due severity');
    case 'tax': return { ...pick(item, 'periodStart periodEnd returnType edition due extension payment status severity'), catalogRule: item.catalogRule ?? 1 };
    case 'tax-coverage': return pick(item, 'kind year edition returnId profile periodStart periodEnd returnType category');
    case 'floor': return { type: 'bank', ...pick(item, 'signedCents floorCents'), below: true };
    case 'new-payee': return { ...pick(item, 'partyKey type family date mCents'), threshold: 100000, earliest: true };
    case 'large': return pick(item, 'partyKey type family date mCents thresholdCents');
    default: throw new ValidationError('Unknown rule');
  }
}
const stores = new WeakMap();
function context(tx, store) {
  const state = stores.get(store);
  if (!state || state.tx !== tx) throw new ValidationError('Invalid item store');
  return state;
}
export async function prepareItems(tx, { orgId, viewerKey, budget = tx, availableRules = [], unavailableRules = [] }) {
  if (typeof budget.check !== 'function' || budget !== tx) throw new ValidationError('Budgeted transaction required');
  const available = new Set(availableRules);
  for (const rule of [...availableRules, ...unavailableRules]) if (!rules.includes(rule)) throw new ValidationError('Unknown rule');
  for (const rule of unavailableRules) available.delete(rule);
  await tx.query(`CREATE TEMP TABLE mv_attention (
    item_key text PRIMARY KEY, rule text NOT NULL, entity_id bigint,
    version text NOT NULL, severity smallint NOT NULL, due date,
    company_sort text NOT NULL, units bigint NOT NULL DEFAULT 1,
    open_cents numeric, due_bill boolean NOT NULL DEFAULT false, awaiting_bill boolean NOT NULL DEFAULT false,
    display jsonb NOT NULL, coverage_unknown boolean NOT NULL DEFAULT false
  ) ON COMMIT DROP`);
  const store = Object.freeze({
    ruleAvailable: rule => available.has(rule),
    setRuleAvailability(rule, isAvailable) {
      if (!rules.includes(rule) || typeof isAvailable !== 'boolean') throw new ValidationError('Invalid rule availability');
      if (isAvailable) available.add(rule); else available.delete(rule);
    },
  });
  stores.set(store, { tx, orgId, viewerKey, available });
  return store;
}
const columns = 'item_key,rule,entity_id,version,severity,due,company_sort,units,open_cents,due_bill,awaiting_bill,display,coverage_unknown';
export async function putItems(tx, { store, rows, select, budget = tx }) {
  context(tx, store);
  if ((rows == null) === (select == null)) throw new ValidationError('Supply rows or a source query');
  if (select) {
    if (typeof select.text !== 'string' || !/^\s*(SELECT|WITH)\b/i.test(select.text)) throw new ValidationError('Invalid source query');
    const insert = `INSERT INTO mv_attention (${columns}) ${select.text}`;
    return tx.query(select.summary ? `WITH inserted AS (${insert} RETURNING *) ${select.summary}` : insert, select.values);
  }
  const records=[];
  for (let i = 0; i < rows.length; i += 256) {
    await budget.checkpoint();
    const batch = rows.slice(i, i + 256).map(r => {
      if (!rules.includes(r.rule) || typeof r.itemKey !== 'string' || !r.itemKey.length || r.itemKey.length > 512 || !/^[a-f0-9]{64}$/.test(r.version)
        || !Number.isInteger(r.severity) || r.severity < 0 || r.severity > 5 || !r.display || Object.values(r.display).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v))
        || JSON.stringify(r.display).length > 8192) throw new ValidationError('Invalid item');
      return { item_key:r.itemKey, rule:r.rule, entity_id:r.entityId, version:r.version, severity:r.severity, due:r.due,
        company_sort:r.companySort, units:r.units ?? 1, open_cents:r.openCents ?? null, due_bill:r.dueBill ?? false,
        awaiting_bill:r.awaitingBill ?? false, display:r.display, coverage_unknown:r.coverageUnknown ?? false };
    });
    records.push(...batch);
  }
  if(records.length)await tx.query(`INSERT INTO mv_attention (${columns}) SELECT ${columns} FROM jsonb_to_recordset($1::jsonb) AS x(
      item_key text,rule text,entity_id bigint,version text,severity smallint,due date,company_sort text,units bigint,
      open_cents numeric,due_bill boolean,awaiting_bill boolean,display jsonb,coverage_unknown boolean)`, [JSON.stringify(records)]);
}
const joined = `SELECT a.*, d.note, d.dismissed_at, d.item_key IS NOT NULL AS dismissed FROM mv_attention a
 LEFT JOIN morning_dismissal d ON d.org_id=$1 AND d.viewer_key=$2 AND d.item_key=a.item_key AND d.item_version=a.version`;
const scalar = r => ({ itemKey:r.item_key, rule:r.rule, entityId:r.entity_id, version:r.version, severity:r.severity, due:r.due,
  companySort:r.company_sort, units:r.units, openCents:r.open_cents == null ? null : centsFromDb(r.open_cents), dueBill:r.due_bill,
  awaitingBill:r.awaiting_bill, display:r.display, coverageUnknown:r.coverage_unknown });
export async function findCurrentItem(tx, { store, itemKey }) {
  const { available } = context(tx, store);
  const { rows: [r] } = await tx.query('SELECT * FROM mv_attention WHERE item_key=$1 AND rule=ANY($2::text[])', [itemKey, [...available]]);
  return r ? scalar(r) : null;
}
export async function foldCurrentItems(tx, { store }) {
  const { orgId, viewerKey, available } = context(tx, store);
  const { rows: [r] } = await tx.query(`SELECT
    count(*) FILTER(WHERE split_part(d.item_key,':',1)=ANY($3::text[]) AND a.item_key IS NOT NULL)::text AS matching,
    count(*) FILTER(WHERE split_part(d.item_key,':',1)=ANY($3::text[]) AND a.item_key IS NULL)::text AS stale,
    count(*) FILTER(WHERE NOT(split_part(d.item_key,':',1)=ANY($3::text[])))::text AS unavailable
    FROM morning_dismissal d LEFT JOIN mv_attention a ON a.item_key=d.item_key AND a.version=d.item_version
    WHERE d.org_id=$1 AND d.viewer_key=$2`, [orgId, viewerKey, [...available]]);
  const unavailable = centsFromDb(r.unavailable);
  return { matching:unavailable ? null : centsFromDb(r.matching), stale:unavailable ? null : centsFromDb(r.stale), unavailable, complete:unavailable === 0 };
}
const countRules = { bankLines:'bank',bankAccounts:'bank',bills:'bill',dueBills:'bill',awaitingBills:'bill',overdueInvoices:'invoice',taxReminders:'tax',taxCoverage:'tax-coverage',floors:'floor',newPayees:'new-payee',large:'large',duplicateGroups:'duplicate' };
export async function pageItems(tx, { store, rule = 'all', fold = 'active', after = null, limit = 50, summary = false }) {
  const { orgId, viewerKey, available } = context(tx, store);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !['all','alerts'].includes(rule) && !rules.includes(rule) || !['active','matching','stale'].includes(fold)) throw new ValidationError('Invalid item page');
  if (after && (typeof after.itemKey !== 'string' || after.itemKey.length > 512 || (fold === 'stale'
    ? !Number.isFinite(new Date(after.dismissedAt).getTime())
    : !Number.isInteger(after.severity) || after.severity < 0 || after.severity > 5 || !(after.due === null || /^\d{4}-\d{2}-\d{2}$/.test(after.due)) || typeof after.companySort !== 'string'))) throw new ValidationError('Invalid item cursor');
  const complete = rule === 'all' ? rules.every(r => available.has(r)) : rule === 'alerts' ? ['floor','new-payee','large'].every(r => available.has(r)) : available.has(rule);
  const values = [orgId, viewerKey, [...available], rule];
  const filter = `rule=ANY($3::text[]) AND ($4='all' OR rule=$4 OR ($4='alerts' AND rule IN ('floor','new-payee','large'))) AND dismissed=${fold === 'matching' ? 'true' : 'false'}`;
  const counts = Object.fromEntries(Object.entries(countRules).map(([key,r]) => [key, (summary || fold !== 'stale') && available.has(r) ? 0 : null]));
  const totals = Object.fromEntries(rules.map(r => [r,{openCents:(summary || fold !== 'stale') && available.has(r) ? 0 : null}]));
  let result, aggregates;
  const aggregateSql = `SELECT rule,count(*)::text AS n,sum(units)::text AS units,
    count(*) FILTER(WHERE due_bill)::text AS due, count(*) FILTER(WHERE awaiting_bill)::text AS awaiting,
    CASE WHEN count(open_cents)=count(*) THEN sum(open_cents)::text END AS open FROM current
    WHERE ${summary ? "rule=ANY($3::text[]) AND NOT dismissed" : filter} GROUP BY rule`;
  const summarySql = `,
    (SELECT jsonb_build_object('matching',count(*) FILTER(WHERE split_part(d.item_key,':',1)=ANY($3::text[]) AND a.item_key IS NOT NULL)::text,
      'stale',count(*) FILTER(WHERE split_part(d.item_key,':',1)=ANY($3::text[]) AND a.item_key IS NULL)::text,
      'unavailable',count(*) FILTER(WHERE NOT(split_part(d.item_key,':',1)=ANY($3::text[])))::text)
     FROM morning_dismissal d LEFT JOIN mv_attention a ON a.item_key=d.item_key AND a.version=d.item_version
     WHERE d.org_id=$1 AND d.viewer_key=$2) AS dismissal,
    (SELECT coalesce(jsonb_object_agg(rule,n),'{}') FROM (SELECT rule,count(*)::text n FROM mv_attention WHERE coverage_unknown GROUP BY rule) c) AS coverage,
    (SELECT coalesce(jsonb_agg(c),'[]') FROM (SELECT * FROM current WHERE rule='tax-coverage' AND rule=ANY($3::text[]) AND NOT dismissed
      ORDER BY severity,due NULLS LAST,company_sort COLLATE "C",item_key COLLATE "C" LIMIT 51) c) coverage_page`;
  const bankTotalsSql = `,(SELECT coalesce(jsonb_agg(b),'[]') FROM (SELECT display->>'currency' currency,
    sum((display->>'inflowCents')::numeric)::text "inflowCents",sum((display->>'outflowCents')::numeric)::text "outflowCents",
    sum((display->>'netCents')::numeric)::text "netCents",sum((display->>'pendingCents')::numeric)::text "pendingCents"
    FROM current WHERE rule='bank' AND ${summary?"rule=ANY($3::text[]) AND NOT dismissed":filter}
    GROUP BY display->>'currency') b) bank_totals`;
  if (fold === 'stale') {
    const staleFilter = `d.org_id=$1 AND d.viewer_key=$2 AND split_part(d.item_key,':',1)=ANY($3::text[])
      AND ($4='all' OR split_part(d.item_key,':',1)=$4 OR ($4='alerts' AND split_part(d.item_key,':',1) IN ('floor','new-payee','large')))
      AND NOT EXISTS(SELECT 1 FROM mv_attention a WHERE a.item_key=d.item_key AND a.version=d.item_version)`;
    const { rows: [r] } = await tx.query(`WITH current AS (${joined}), stale AS MATERIALIZED (
      SELECT d.* FROM morning_dismissal d WHERE ${staleFilter}), page AS (SELECT d.item_key,d.note,
      to_char(d.dismissed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS dismissed_at
      FROM stale d WHERE ($5::timestamptz IS NULL OR d.dismissed_at<$5 OR (d.dismissed_at=$5 AND d.item_key COLLATE "C">$6))
      ORDER BY d.dismissed_at DESC,d.item_key COLLATE "C" LIMIT $7)
      SELECT (SELECT count(*)::text FROM stale) n,coalesce((SELECT jsonb_agg(page) FROM page),'[]') page,
      ${summary ? `coalesce((SELECT jsonb_agg(a) FROM (${aggregateSql}) a),'[]')` : "'[]'::jsonb"} aggregates
      ${summary ? summarySql+bankTotalsSql : ''}`, [...values, after?.dismissedAt ?? null, after?.itemKey ?? null, limit+1]);
    counts.stale = complete ? centsFromDb(r.n) : null;
    result = { rows:r.page, summary:r }; aggregates=r.aggregates;
  } else {
    const { rows: [r] } = await tx.query(`WITH current AS MATERIALIZED (${joined}), page AS (SELECT * FROM current WHERE ${filter}
      AND ($5::int IS NULL OR (severity,coalesce(due,'infinity'::date),company_sort COLLATE "C",item_key COLLATE "C")>
        ($5,coalesce($6::date,'infinity'::date),$7::text COLLATE "C",$8::text COLLATE "C"))
      ORDER BY severity,due NULLS LAST,company_sort COLLATE "C",item_key COLLATE "C" LIMIT $9)
      SELECT coalesce((SELECT jsonb_agg(to_jsonb(page)||jsonb_build_object('open_cents',open_cents::text)) FROM page),'[]') page,
      coalesce((SELECT jsonb_agg(a) FROM (${aggregateSql}) a),'[]') aggregates ${bankTotalsSql} ${summary ? summarySql : ''}`,
    [...values,after?.severity ?? null,after?.due ?? null,after?.companySort ?? null,after?.itemKey ?? null,limit+1]);
    result = { rows:r.page, summary:r }; aggregates=r.aggregates;
  }
  for (const r of aggregates) {
    for (const [key, ruleName] of Object.entries(countRules)) if (r.rule === ruleName) counts[key] = centsFromDb(r[key === 'bankLines' ? 'units' : key === 'dueBills' ? 'due' : key === 'awaitingBills' ? 'awaiting' : 'n']);
    totals[r.rule].openCents = r.open == null ? null : centsFromDb(r.open);
  }
  const more = result.rows.length > limit;
  const page = result.rows.slice(0, limit).map(r => fold === 'stale' ? {itemKey:r.item_key,note:r.note,dismissedAt:r.dismissed_at} : {...scalar(r),...(fold==='matching'?{note:r.note,dismissedAt:r.dismissed_at}:{})});
  const last = page.at(-1);
  const next = !more ? null : fold === 'stale' ? {dismissedAt:last.dismissedAt,itemKey:last.itemKey} : {severity:last.severity,due:last.due,companySort:last.companySort,itemKey:last.itemKey};
  const extra = {};
  if (summary) {
    const r=result.summary, unavailable=centsFromDb(r.dismissal.unavailable);
    extra.fold={matching:unavailable?null:centsFromDb(r.dismissal.matching),stale:unavailable?null:centsFromDb(r.dismissal.stale),unavailable,complete:unavailable===0};
    const byKind=Object.fromEntries(Object.entries(r.coverage).map(([k,v])=>[k,centsFromDb(v)]));
    const unknownCount=Object.values(byKind).reduce((s,n)=>centsFromDb(s+n),0);
    extra.coverage={known:unknownCount===0&&rules.every(r=>available.has(r)),unknownCount,byKind};
    extra.coverage.page=r.coverage_page.slice(0,50).map(scalar);
    const lastCoverage=extra.coverage.page.at(-1);
    extra.coverage.next=r.coverage_page.length>50?{severity:lastCoverage.severity,due:lastCoverage.due,companySort:lastCoverage.companySort,itemKey:lastCoverage.itemKey}:null;
  }
  const fullTotals=fold==='stale'&&!summary||!available.has('bank')?null:(result.summary.bank_totals??[])
    .map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k==='currency'||v===null?v:centsFromDb(v)])));
  return { counts, totals, page, next, complete, fullTotals, ...extra };
}
export async function readCoverage(tx, { store }) {
  const { available } = context(tx, store);
  const { rows } = await tx.query('SELECT rule,count(*)::text AS n FROM mv_attention WHERE coverage_unknown GROUP BY rule');
  const byKind = Object.fromEntries(rows.map(r => [r.rule,centsFromDb(r.n)]));
  const unknownCount = Object.values(byKind).reduce((s,n) => centsFromDb(s+n),0);
  return { known:unknownCount === 0 && rules.every(r => available.has(r)), byKind, unknownCount };
}
