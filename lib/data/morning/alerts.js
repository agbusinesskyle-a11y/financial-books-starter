import { ValidationError } from '../writes.js';
import { isIsoDate } from '../../domain/dates.js';
import { centsFromDb,UnsafeAmountError } from './clock.js';
import { putItems,pageItems,itemVersion,canonical } from './items.js';
import { ensurePostingFacts } from './posting-facts.js';

export const NEW_PAYEE_CENTS=100000,DEFAULT_LARGE_CENTS=1000000,ALERT_RULE_VERSION=1;
// The shared snapshot relation preserves the original per-account netting and
// typed-party checks; duplicates and earliest-payment history use all peers.
export const ELIGIBLE_SQL=`WITH facts AS (
 SELECT txn_id,entity_id,type,txn_date,sum(m) m,min(first_date) first_date,max(last_date) last_date,
 count(*) FILTER(WHERE m>0) positive,count(*) FILTER(WHERE m<0) negative,
 bool_and(account_type='credit_card') FILTER(WHERE m<>0) cards,
 header,party_count,line_party,home_supported,seed,kind
 FROM mv_posting_fact
 GROUP BY txn_id,entity_id,type,txn_date,header,party_count,line_party,home_supported,seed,kind
), eligible AS (
 SELECT f.*,e.name entity_name,CASE WHEN first_date=last_date THEN first_date END posting_date,
 CASE WHEN party_count=0 THEN header WHEN party_count=1 AND (header IS NULL OR header=line_party) THEN line_party END party_key,
 CASE WHEN header IS NOT NULL AND (party_count>1 OR party_count=1 AND header<>line_party) THEN 'conflict'
   WHEN party_count>1 THEN 'multiple' WHEN header IS NULL AND party_count=0 THEN 'missing' END party_issue,
 CASE WHEN NOT home_supported THEN NULL
   WHEN type IN ('expense','check','bill_payment') AND m<0 AND positive=0 THEN 'outgoing-payment'
   WHEN type IN ('payment','sales_receipt','deposit') AND m>0 AND negative=0 THEN 'incoming-receipt'
   WHEN type='cc_credit' AND m>0 AND cards THEN 'card-refund'
   WHEN type='journal_entry' AND m<0 AND positive=0 THEN 'journal-out'
   WHEN type='journal_entry' AND m>0 AND negative=0 THEN 'journal-in' END family FROM facts f JOIN entity e USING(entity_id)
)`;
const seedsState=new WeakMap();
const eligibilityState=new WeakMap();
export const forgetEligibility = tx => eligibilityState.delete(tx);
// One complete current relation serves earliest-payment history and duplicate peers.
// The public seed relation remains window-only; neither display paging nor thresholds narrow it.
export async function ensureEligibility(tx,{orgId,today,window,budget=tx,detailOnly=false}) {
  const key=JSON.stringify([orgId,today,+new Date(window.from),+new Date(window.to),detailOnly]);
  const prior=eligibilityState.get(tx);
  if(prior){if(prior.key!==key)throw new ValidationError('Invalid alert context');return prior;}
  await ensurePostingFacts(tx,{orgId,today,window,budget,includePeers:true,candidateOnly:detailOnly});
  await tx.query(`CREATE TEMP TABLE mv_fact ON COMMIT DROP AS ${ELIGIBLE_SQL} SELECT * FROM eligible`);
  const {rows:[r]}=await tx.query(`SELECT count(*) FILTER(WHERE seed)::text n,
    count(*) FILTER(WHERE seed AND NOT home_supported)::text unsupported,
    bool_or(home_supported AND abs(m)>9007199254740991) unsafe,
    bool_or(seed AND home_supported AND abs(m)>9007199254740991) seed_unsafe,
    count(*) FILTER(WHERE seed AND family IS NOT NULL AND party_issue='missing')::text AS "missingParty",
    count(*) FILTER(WHERE seed AND family IS NOT NULL AND party_issue='multiple')::text AS "multipleParty",
    count(*) FILTER(WHERE seed AND family IS NOT NULL AND party_issue='conflict')::text AS "conflictParty",
    count(*) FILTER(WHERE seed AND family IS NOT NULL AND first_date<>last_date)::text AS "multiDate" FROM mv_fact`);
  budget.check();
  const {n,unsupported,unsafe,seed_unsafe,...issues}=r;
  const state={key,unsafe,seedUnsafe:seed_unsafe,count:centsFromDb(n),coverage:{known:unsupported==='0',unsupportedCount:centsFromDb(unsupported)},
    issues:Object.fromEntries(Object.entries(issues).map(([k,v])=>[k,centsFromDb(v)]))};
  eligibilityState.set(tx,state);return state;
}
function stateOf(tx,seeds){const state=seedsState.get(seeds);if(!state||state.tx!==tx)throw new ValidationError('Invalid alert seeds');return state;}
export async function readSeeds(tx,{orgId,today,window,budget=tx}) {
  if(!Number.isSafeInteger(orgId)||orgId<1||!isIsoDate(today)||window&&(!Number.isFinite(+new Date(window.from))||!Number.isFinite(+new Date(window.to))||new Date(window.from)>new Date(window.to)))throw new ValidationError('Invalid alert context');
  if(!window){const seeds=Object.freeze({relation:null,count:0,skipped:'first_look',coverage:{known:true,unsupportedCount:0}});seedsState.set(seeds,{tx,orgId,today,window:null});return seeds;}
  const state=await ensureEligibility(tx,{orgId,today,window,budget});
  if(state.seedUnsafe)throw new UnsafeAmountError();
  // Views are session-local, so replace on backend reuse; their referenced table drops at COMMIT.
  await tx.query('CREATE OR REPLACE TEMP VIEW mv_alert_seed AS SELECT * FROM mv_fact WHERE seed');
  const seeds=Object.freeze({relation:'mv_alert_seed',count:state.count,coverage:state.coverage});
  seedsState.set(seeds,{tx,orgId,today,window,issues:state.issues});return seeds;
}
export async function alertCoverage(tx,{seeds}) {
  const state=stateOf(tx,seeds);return state.issues??{missingParty:0,multipleParty:0,conflictParty:0,multiDate:0};
}
export async function floorItems(tx,{accounts,floors,store,budget=tx}) {
  const rows=[],inactiveFloors=[];
  for(const a of accounts){budget.check();if(!floors.has(a.accountId))continue;const floorCents=centsFromDb(floors.get(a.accountId));
    if(a.type!=='bank'){inactiveFloors.push({entityId:a.entityId,accountId:a.accountId,accountName:a.name,floorCents});continue;}
    const signedCents=centsFromDb(a.signedCents);if(signedCents>=floorCents)continue;
    const display={accountId:a.accountId,accountName:a.name,signedCents,floorCents,severity:'undated'};
    rows.push({itemKey:`floor:${a.entityId}:${a.accountId}`,rule:'floor',entityId:a.entityId,version:itemVersion('floor',{type:a.type,signedCents,floorCents,below:true}),severity:5,due:null,companySort:a.entityName??String(a.entityId),display});
  }
  await putItems(tx,{store,rows,budget});store.setRuleAvailability('floor',true);return {count:rows.length,inactiveFloors};
}
const displaySql=`jsonb_build_object('txnId',txn_id,'type',type,'date',txn_date,'docDate',txn_date,'postingDate',posting_date,'mCents',m,
  'partyKey',party_key,'family',family,'kind',kind,'label',label,'note',CASE WHEN kind='historical_edit' THEN 'This concerns the current entry; the edit may not have changed money.' END,
  'thresholdCents',threshold,'earliest',earliest)`;
async function insertRule(tx,{store,rule,select,values,budget,combined=false}) {
  const ruleSql=combined?'rule':`'${rule}'`;
  const result=await putItems(tx,{store,budget,select:{text:`${select} SELECT ${ruleSql}||':'||entity_id||':'||txn_id,${ruleSql},entity_id,
    encode(sha256(convert_to(${ruleSql}||'|1|'||jsonb_build_array(party_key,type,family,txn_date,m,threshold,earliest)::text,'UTF8')),'hex'),
    5,NULL::date,entity_name,1,NULL::numeric,false,false,${displaySql},false FROM selected`,values,
    ...(combined?{summary:"SELECT rule,count(*)::text n FROM inserted GROUP BY rule"}:{})}});
  if(combined){store.setRuleAvailability('new-payee',true);store.setRuleAvailability('large',true);return Object.fromEntries(result.rows.map(r=>[r.rule,centsFromDb(r.n)]));}
  store.setRuleAvailability(rule,true);return {count:result.rowCount};
}
const combinedBuilds=new WeakMap();
const checkedThresholds=thresholds=>{for(const [entityId,cents] of thresholds)if(!Number.isSafeInteger(entityId)||entityId<1||!Number.isSafeInteger(cents)||cents<1)throw new ValidationError('Invalid large threshold');};
const thresholdValues=thresholds=>JSON.stringify([...thresholds].map(([entity_id,threshold])=>({entity_id,threshold})));
const largeSelect=`SELECT s.*,coalesce(t.threshold,${DEFAULT_LARGE_CENTS}) threshold,NULL::boolean earliest,CASE WHEN family LIKE 'journal-%' THEN 'Large journal movement' ELSE 'Large transaction' END label
    FROM mv_alert_seed s LEFT JOIN jsonb_to_recordset($1::jsonb) t(entity_id bigint,threshold bigint) USING(entity_id)
    WHERE s.family IS NOT NULL AND s.party_key IS NOT NULL AND abs(s.m)>=coalesce(t.threshold,${DEFAULT_LARGE_CENTS})`;
export async function newPayeeItems(tx,{orgId,today,seeds,store,budget=tx,thresholds=null}) {
  const state=stateOf(tx,seeds);if(state.orgId!==orgId||state.today!==today)throw new ValidationError('Invalid alert context');
  if(seeds.skipped){store.setRuleAvailability('new-payee',true);return {count:0};}
  const firstSelect=`
    SELECT s.*,${NEW_PAYEE_CENTS} threshold,true earliest,CASE WHEN s.kind='historical_edit' THEN 'New-payee rule on an edited historical entry' ELSE 'First payment to this payee' END label
    FROM mv_alert_seed s JOIN (SELECT DISTINCT ON (entity_id,party_key) entity_id,party_key,txn_id
      FROM mv_fact WHERE family='outgoing-payment' AND party_key IS NOT NULL AND posting_date=txn_date
      ORDER BY entity_id,party_key,posting_date,txn_id) h USING(entity_id,party_key,txn_id)
    WHERE s.family='outgoing-payment' AND s.party_key IS NOT NULL AND abs(s.m)>=${NEW_PAYEE_CENTS} AND s.posting_date=s.txn_date`;
  if(thresholds){
    checkedThresholds(thresholds);
    const counts=await insertRule(tx,{store,budget,combined:true,values:[thresholdValues(thresholds)],select:`WITH first_payments AS (${firstSelect}),
      large_payments AS (${largeSelect}),selected AS (SELECT f.*,'new-payee'::text rule FROM first_payments f UNION ALL SELECT l.*,'large' FROM large_payments l)`});
    combinedBuilds.set(store,{tx,seeds,key:canonical([...thresholds].sort((a,b)=>a[0]-b[0])),count:counts.large??0});
    return {count:counts['new-payee']??0};
  }
  return insertRule(tx,{store,rule:'new-payee',budget,values:[],select:`WITH selected AS (${firstSelect})`});
}
export async function largeItems(tx,{seeds,thresholds,store,budget=tx}) {
  stateOf(tx,seeds);checkedThresholds(thresholds);
  if(seeds.skipped){store.setRuleAvailability('large',true);return {count:0};}
  const built=combinedBuilds.get(store);
  if(built){if(built.tx!==tx||built.seeds!==seeds||built.key!==canonical([...thresholds].sort((a,b)=>a[0]-b[0])))throw new ValidationError('Invalid large threshold context');return {count:built.count};}
  return insertRule(tx,{store,rule:'large',budget,values:[thresholdValues(thresholds)],select:`WITH selected AS (${largeSelect})`});
}
export async function alertItemsPage(tx,{store,after=null,limit=50}) {return pageItems(tx,{store,after,limit});}
