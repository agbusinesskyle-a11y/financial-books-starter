import { putItems, pageItems } from './items.js';
import { centsFromDb, UnsafeAmountError } from './clock.js';
import { ValidationError } from '../writes.js';

const built = new WeakMap();
// One ordered server scan; only the current record and a 32-byte digest are retained.
const hashSql = `CREATE OR REPLACE FUNCTION pg_temp.mv_bank_hash()
RETURNS TABLE(entity_id bigint,ll_account_id uuid,currency text,version text) LANGUAGE plpgsql AS $$
DECLARE r record; previous text; h bytea; record_text text;
BEGIN
 FOR r IN SELECT b.* FROM mv_bank b WHERE actionable OR warning OR pending_only ORDER BY b.entity_id,b.ll_account_id,b.currency,b.item_id LOOP
  IF previous IS DISTINCT FROM r.entity_id::text||':'||r.ll_account_id::text||r.currency THEN
   IF previous IS NOT NULL THEN version:=encode(h,'hex'); RETURN NEXT; END IF;
   previous:=r.entity_id::text||':'||r.ll_account_id::text||r.currency; entity_id:=r.entity_id; ll_account_id:=r.ll_account_id; currency:=r.currency;
   h:=sha256(convert_to('bank|1|'||json_build_array(r.books_account_id,r.include,r.currency)::text,'UTF8'));
  END IF;
  record_text:=json_build_array(r.item_id,r.ll_transaction_id,r.revision,r.review_version,r.bank_state,r.review_state,
   r.pending,r.attention,r.parked_attention,r.amount_cents,r.currency)::text;
  h:=sha256(h||convert_to(record_text,'UTF8'));
 END LOOP;
 IF previous IS NOT NULL THEN version:=encode(h,'hex'); RETURN NEXT; END IF;
END $$`;
export async function bankReview(tx, { orgId, store, after=null, limit=50, mode='page', budget=tx }) {
  if (!['page','relation','build'].includes(mode)) throw new ValidationError('Invalid bank mode');
  let state=built.get(store);
  if (state && (state.tx!==tx || state.orgId!==orgId)) throw new ValidationError('Invalid bank context');
  if (!state) {
    await tx.query(`CREATE TEMP TABLE mv_bank ON COMMIT DROP AS SELECT i.*,l.books_account_id,l.include,e.name entity_name,a.name account_name,
      i.bank_state='active' AND i.review_state='new' AND NOT i.pending actionable, i.attention IS NOT NULL warning,
      i.bank_state='active' AND i.review_state='new' AND i.pending AND i.attention IS NULL pending_only
      FROM ledgerline_account l JOIN account a ON a.org_id=l.org_id AND a.entity_id=l.entity_id AND a.account_id=l.books_account_id
      JOIN entity e ON e.org_id=l.org_id AND e.entity_id=l.entity_id
      JOIN bank_feed_item i ON i.org_id=l.org_id AND i.entity_id=l.entity_id AND i.ll_account_id=l.ll_account_id
      WHERE l.org_id=$1 AND l.include
        -- Keep the complete attention union and all unsupported-currency coverage.
        -- Other USD history affects neither the aggregates nor their cause hashes.
        AND (i.currency<>'USD' OR i.attention IS NOT NULL OR (i.bank_state='active' AND i.review_state='new'))`,[orgId]);
    await tx.query(hashSql);
    const {rows:[summary]}=await putItems(tx,{store,budget,select:{text:`WITH aggregate AS (
      SELECT entity_id,ll_account_id,currency,min(entity_name) entity_name,min(account_name) account_name,
        count(*) FILTER(WHERE actionable OR warning) needs, count(*) FILTER(WHERE actionable AND NOT warning) new_only,
        count(*) FILTER(WHERE warning) warnings,
        count(*) FILTER(WHERE warning AND pending) pending_warnings,
        count(*) FILTER(WHERE warning AND (attention='changed' OR parked_attention='changed')) changed,
        count(*) FILTER(WHERE warning AND attention='removed') removed,
        count(*) FILTER(WHERE warning AND (attention='books' OR parked_attention='books')) books,
        count(*) FILTER(WHERE warning AND parked_attention IS NOT NULL) parked,
        count(*) FILTER(WHERE pending_only) pending_count,coalesce(sum(amount_cents) FILTER(WHERE pending_only),0) pending_cents,
        coalesce(sum(amount_cents) FILTER(WHERE (actionable OR warning) AND amount_cents>0),0) inflow,
        coalesce(sum(-amount_cents::numeric) FILTER(WHERE (actionable OR warning) AND amount_cents<0),0) outflow,
        coalesce(sum(amount_cents) FILTER(WHERE actionable OR warning),0) net
      FROM mv_bank WHERE actionable OR warning OR pending_only GROUP BY entity_id,ll_account_id,currency
    ) SELECT 'bank:'||a.entity_id||':'||a.ll_account_id||CASE WHEN a.currency='USD' THEN '' ELSE ':'||a.currency END,
      'bank',a.entity_id,h.version,5,NULL::date,a.entity_name,a.needs,NULL::numeric,false,false,
      jsonb_build_object('entityName',a.entity_name,'llAccountId',a.ll_account_id,'accountName',a.account_name,
        'needsReviewCount',a.needs,'newOnlyCount',a.new_only,'warningCount',a.warnings,'changed',a.changed,'removed',a.removed,
        'books',a.books,'parked',a.parked,'pendingCount',a.pending_count,'pendingWarningCount',a.pending_warnings,'pendingCents',a.pending_cents::text,
        'inflowCents',a.inflow::text,'outflowCents',a.outflow::text,'netCents',a.net::text,'currency',a.currency),a.currency<>'USD'
      FROM aggregate a JOIN pg_temp.mv_bank_hash() h USING(entity_id,ll_account_id,currency)`,values:[orgId],summary:`SELECT
    -- Check every aggregate before availability, including rows beyond the page.
      bool_or(
      abs((display->>'pendingCents')::numeric)>9007199254740991 OR
      abs((display->>'inflowCents')::numeric)>9007199254740991 OR
      abs((display->>'outflowCents')::numeric)>9007199254740991 OR
      abs((display->>'netCents')::numeric)>9007199254740991) unsafe,
      count(*)::text count,coalesce(sum(units),0)::text lines,
      (WITH mappings AS (
      SELECT l.entity_id,l.ll_account_id,CASE WHEN NOT l.include THEN 'excluded' ELSE 'unmapped' END kind,count(i.item_id) items
      FROM ledgerline_account l LEFT JOIN account a ON a.org_id=l.org_id AND a.entity_id=l.entity_id AND a.account_id=l.books_account_id
      LEFT JOIN bank_feed_item i ON i.org_id=l.org_id AND i.entity_id=l.entity_id AND i.ll_account_id=l.ll_account_id
      WHERE l.org_id=$1 AND (NOT l.include OR a.account_id IS NULL) GROUP BY l.entity_id,l.ll_account_id,l.include
    ), coverage AS (SELECT entity_id,kind,count(*)::text accounts,sum(items)::text items FROM mappings GROUP BY entity_id,kind
      UNION ALL SELECT entity_id,'unsupported_currency',count(DISTINCT ll_account_id)::text,count(*)::text FROM mv_bank
      WHERE currency<>'USD' GROUP BY entity_id ORDER BY entity_id,kind) SELECT coalesce(jsonb_agg(coverage),'[]') FROM coverage) coverage,
      (SELECT coalesce(jsonb_agg(t),'[]') FROM (SELECT display->>'currency' currency,
        sum((display->>'inflowCents')::numeric)::text "inflowCents",sum((display->>'outflowCents')::numeric)::text "outflowCents",
        sum((display->>'netCents')::numeric)::text "netCents",sum((display->>'pendingCents')::numeric)::text "pendingCents"
        FROM inserted GROUP BY display->>'currency') t) totals FROM inserted`}});
    if(summary.unsafe)throw new UnsafeAmountError();
    state={tx,orgId,count:centsFromDb(summary.count),fullTotals:summary.totals.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k==='currency'?v:centsFromDb(v)]))),
      coverage:summary.coverage.map(r=>({entityId:r.entity_id,kind:r.kind,accounts:centsFromDb(r.accounts),items:centsFromDb(r.items)}))};
    store.setRuleAvailability('bank',true);built.set(store,state);
  }
  if (mode==='relation') return {relation:'mv_attention',coverage:state.coverage};
  if (mode==='build') return {count:state.count,fullTotals:state.fullTotals,coverage:state.coverage};
  const result=await pageItems(tx,{store,rule:'bank',after,limit});
  return {...result,coverage:state.coverage,page:result.page.map(r=>{
    const d=r.display;budget.check();
    return {itemKey:r.itemKey,entityId:r.entityId,entityName:d.entityName,llAccountId:d.llAccountId,accountName:d.accountName,
      needsReviewCount:centsFromDb(d.needsReviewCount),newOnlyCount:centsFromDb(d.newOnlyCount),warningCount:centsFromDb(d.warningCount),
      causes:{changed:centsFromDb(d.changed),removed:centsFromDb(d.removed),books:centsFromDb(d.books),parked:centsFromDb(d.parked)},
      pendingCount:centsFromDb(d.pendingCount),pendingWarningCount:centsFromDb(d.pendingWarningCount),pendingCents:centsFromDb(d.pendingCents),inflowCents:centsFromDb(d.inflowCents),
      outflowCents:centsFromDb(d.outflowCents),netCents:centsFromDb(d.netCents),currency:d.currency,version:r.version};
  })};
}
