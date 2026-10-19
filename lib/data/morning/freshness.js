import { ValidationError } from '../writes.js';
import { centsFromDb } from './clock.js';

const sources=`WITH mappings AS (SELECT entity_id,count(*)+count(*) FILTER(WHERE NOT owned_now) limitations
  FROM ledgerline_account WHERE org_id=$1 GROUP BY entity_id), sources AS (
 SELECT e.entity_id,e.name,'feed'::text source,'feed:'||e.entity_id||':'||to_char(l.linked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') source_key,
   coalesce(p.at,l.last_pull_at) at,l.last_seen_sync_at sync_at,
   CASE WHEN p.at IS NOT NULL THEN 'Last successful feed pull completed' WHEN l.last_pull_at IS NOT NULL THEN 'Feed pull recorded by link' ELSE 'Source time unknown' END label,
   'company_link'::text scope,coalesce(m.limitations,0) limitations
 FROM entity e JOIN ledgerline_link l ON l.org_id=e.org_id AND l.entity_id=e.entity_id
 LEFT JOIN LATERAL (SELECT max(finished_at) at FROM bank_feed_pull p WHERE p.org_id=l.org_id AND p.entity_id=l.entity_id
   AND p.status='ok' AND p.started_at>=l.linked_at) p ON true LEFT JOIN mappings m ON m.entity_id=e.entity_id WHERE e.org_id=$1
 UNION ALL SELECT e.entity_id,e.name,'import','import:'||e.entity_id||':'||b.source,max(b.created_at),NULL::timestamptz,
   'Historical import recorded','company_source',coalesce(m.limitations,0)
 FROM entity e JOIN import_batch b ON b.org_id=e.org_id AND b.entity_id=e.entity_id LEFT JOIN mappings m ON m.entity_id=e.entity_id
 WHERE e.org_id=$1 GROUP BY e.entity_id,e.name,b.source,m.limitations
 UNION ALL SELECT e.entity_id,e.name,'none','none:'||e.entity_id,NULL::timestamptz,NULL::timestamptz,'No import source','not_applicable',0
 FROM entity e WHERE e.org_id=$1 AND NOT EXISTS(SELECT 1 FROM ledgerline_link l WHERE l.org_id=e.org_id AND l.entity_id=e.entity_id)
 AND NOT EXISTS(SELECT 1 FROM import_batch b WHERE b.org_id=e.org_id AND b.entity_id=e.entity_id)
)`;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const pageLimit=n=>{if(!Number.isInteger(n)||n<1||n>50)throw new ValidationError('Invalid freshness page');};
const iso=v=>v==null?null:new Date(v).toISOString();
export async function sourceFreshness(tx,{orgId,now,after=null,limit=50,budget=tx}) {
  pageLimit(limit);
  if(!positive(orgId)||!Number.isFinite(+new Date(now))||after&&(!positive(after.entityId)||!['feed','import','none'].includes(after.source)||typeof after.sourceKey!=='string'))throw new ValidationError('Invalid freshness context');
  const {rows:[totals]}=await tx.query(`${sources}, page AS (SELECT * FROM sources
    WHERE ($3::bigint IS NULL OR (entity_id,source COLLATE "C",source_key COLLATE "C")>($3,$4,$5))
    ORDER BY entity_id,source COLLATE "C",source_key COLLATE "C" LIMIT $6)
    SELECT count(*)::text count,count(*) FILTER(WHERE source='feed' AND at IS NULL)::text unknown,
    count(*) FILTER(WHERE source='feed' AND at<$2::timestamptz-interval '48 hours')::text stale,
    coalesce((SELECT jsonb_agg(page) FROM page),'[]') page FROM sources`,[orgId,now,after?.entityId??null,after?.source??null,after?.sourceKey??null,limit+1]);
  const rows=totals.page;
  const page=rows.slice(0,limit).map(r=>{budget.check();const ageMs=r.at==null?null:+new Date(now)-+new Date(r.at);return {sourceKey:r.source_key,entityId:r.entity_id,entityName:r.name,
    source:r.source,label:r.label,at:iso(r.at),ageMs,stale:r.source==='feed'&&ageMs!==null&&ageMs>172800000,scope:r.scope,syncAt:iso(r.sync_at),limitationCount:centsFromDb(r.limitations)};});
  const last=page.at(-1);return {count:centsFromDb(totals.count),unknownCount:centsFromDb(totals.unknown),staleCount:centsFromDb(totals.stale),page,
    next:rows.length>limit?{entityId:last.entityId,source:last.source,sourceKey:last.sourceKey}:null};
}
export async function freshnessLimitations(tx,{orgId,sourceKey,after=null,limit=50,budget=tx}) {
  pageLimit(limit);
  if(typeof sourceKey!=='string'||sourceKey.length>512||after&&(!positive(after.entityId)||!/^[-0-9a-f]{36}$/i.test(after.llAccountId)||!['no_account_success_evidence','historical_mapping'].includes(after.kind)))throw new ValidationError('Invalid source context');
  const {rows:[source]}=await tx.query(`${sources} SELECT entity_id,limitations FROM sources WHERE source_key=$2`,[orgId,sourceKey]);
  if(!source)throw Object.assign(new ValidationError('Source not found'),{status:404});
  const {rows}=await tx.query(`WITH limitations AS (
    SELECT l.entity_id,l.ll_account_id,l.books_account_id,l.owned_now,k.kind FROM ledgerline_account l
    CROSS JOIN LATERAL (SELECT 'no_account_success_evidence'::text kind UNION ALL SELECT 'historical_mapping' WHERE NOT l.owned_now) k
    WHERE l.org_id=$1 AND l.entity_id=$2
  ) SELECT * FROM limitations WHERE ($3::bigint IS NULL OR (entity_id,ll_account_id,kind COLLATE "C")>($3,$4::uuid,$5))
    ORDER BY entity_id,ll_account_id,kind COLLATE "C" LIMIT $6`,[orgId,source.entity_id,after?.entityId??null,after?.llAccountId??null,after?.kind??null,limit+1]);
  const page=rows.slice(0,limit).map(r=>{budget.check();return {entityId:r.entity_id,llAccountId:r.ll_account_id,booksAccountId:r.books_account_id,ownedNow:r.owned_now,kind:r.kind,
    text:r.kind==='historical_mapping'?'Historical mapping; not currently owned here.':'Company/link-wide time; individual account refresh is unknown.'};});
  const last=page.at(-1);return {count:centsFromDb(source.limitations),page,next:rows.length>limit?{entityId:last.entityId,llAccountId:last.llAccountId,kind:last.kind}:null};
}
