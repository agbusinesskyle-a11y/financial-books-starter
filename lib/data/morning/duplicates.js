import { ensureEligibility } from './alerts.js';
import { putItems,pageItems } from './items.js';
import { centsFromDb,UnsafeAmountError } from './clock.js';
import { isIsoDate } from '../../domain/dates.js';
import { ValidationError } from '../writes.js';
import { installGraphFunctions,execute,relationshipEdges,combinedCandidateMembers,duplicateGroups as groupRelation } from './graph-sql.js';

const computations=new WeakMap();
const positive=n=>Number.isSafeInteger(n)&&n>0;
const conflict=()=>Object.assign(new ValidationError('Duplicate context changed'),{status:409});
function context({orgId,today,window}) {
  if(!positive(orgId)||!isIsoDate(today)||window&&(!Number.isFinite(+new Date(window.from))||!Number.isFinite(+new Date(window.to))||new Date(window.from)>new Date(window.to)))throw new ValidationError('Invalid duplicate context');
  return JSON.stringify([orgId,today,window?[+new Date(window.from),+new Date(window.to)]:null]);
}
async function facts(tx,{orgId,today,window,budget=tx,detailOnly=false}) {
  const key=context({orgId,today,window})+JSON.stringify(detailOnly),prior=computations.get(tx);
  if(prior){if(prior.key!==key)throw conflict();return prior;}
  if(!window){const state={key,skipped:'first_look',groupCount:0,coverage:{known:true,unsupportedCount:0}};computations.set(tx,state);return state;}
  await installGraphFunctions(tx);
  const eligible=await ensureEligibility(tx,{orgId,today,window,budget,detailOnly});
  if(eligible.unsafe)throw new UnsafeAmountError();
  await execute(tx,relationshipEdges({orgId}));
  await tx.query('CREATE INDEX mv_relationship_edge_ab ON mv_relationship_edge(a,b)');
  await execute(tx,combinedCandidateMembers());
  await execute(tx,groupRelation());
  budget.check?.();
  const state={key,coverage:detailOnly?{known:false,scope:'duplicate_candidates'}:{...eligible.coverage,...eligible.issues}};computations.set(tx,state);return state;
}
const groupKeySql="'duplicate:'||g.entity_id||':'||substring(g.item_key FROM 11)";
export async function buildDuplicateItems(tx,{orgId,today,window,store,budget=tx,detailOnly=false}) {
  const state=await facts(tx,{orgId,today,window,budget,detailOnly});
  if(state.store&&state.store!==store)throw conflict();
  if(!state.store&&!state.skipped){const result=await putItems(tx,{store,budget,select:{text:`SELECT ${groupKeySql},'duplicate',g.entity_id,g.version,5,NULL::date,e.name,
    1,NULL::numeric,false,false,jsonb_build_object('partyKey',g.party_key,'family',g.family,'amountCents',g.amount_cents,
      'memberCount',g.member_count,'pairCount',g.pair_count,'seedCount',g.seed_count,'firstDate',g.first_date,'lastDate',g.last_date),false
    FROM mv_group g JOIN entity e ON e.org_id=$1 AND e.entity_id=g.entity_id`,values:[orgId]}});state.groupCount=result.rowCount;}
  state.store=store;store.setRuleAvailability('duplicate',true);
  return {groupCount:state.groupCount,coverage:state.coverage,...(state.skipped?{skipped:state.skipped}:{})};
}
export async function duplicateGroups(tx,{store,after=null,limit=50}) {
  const result=await pageItems(tx,{store,rule:'duplicate',after,limit});
  return {...result,page:result.page.map(r=>({itemKey:r.itemKey,entityId:r.entityId,partyKey:r.display.partyKey,family:r.display.family,
    amountCents:centsFromDb(r.display.amountCents),memberCount:centsFromDb(r.display.memberCount),pairCount:centsFromDb(r.display.pairCount),seedCount:centsFromDb(r.display.seedCount),
    firstDate:r.display.firstDate,lastDate:r.display.lastDate,version:r.version}))};
}
function pageInput({groupKey,limit,after},pairs) {
  if(!Number.isInteger(limit)||limit<1||limit>50||typeof groupKey!=='string'||!groupKey.length||groupKey.length>512||after&&(pairs
    ? !positive(after.lo)||!positive(after.hi)||after.lo>=after.hi||Object.keys(after).sort().join(',')!=='hi,lo'
    : !isIsoDate(after.date)||!positive(after.txnId)||Object.keys(after).sort().join(',')!=='date,txnId'))throw new ValidationError('Invalid duplicate page');
}
export async function duplicateMembersPage(tx,{orgId,today,window,groupKey,after=null,limit=50,budget=tx,detailOnly=false}) {
  const state=await facts(tx,{orgId,today,window,budget,detailOnly});pageInput({groupKey,after,limit},false);if(state.skipped)return {gone:true};
  const {rows:[r]}=await tx.query(`SELECT g.member_count,g.pair_count,coalesce((SELECT jsonb_agg(p) FROM (
    SELECT m.txn_id "txnId",m.txn_date date,m.m::text "mCents",m.type,m.kind,m.partition_label "partitionLabel" FROM mv_candidate_member m
    WHERE m.component=g.component AND ($2::date IS NULL OR (m.txn_date,m.txn_id)>($2,$3)) ORDER BY m.txn_date,m.txn_id LIMIT $4) p),'[]') members
    FROM mv_group g WHERE ${groupKeySql}=$1`,[groupKey,after?.date??null,after?.txnId??null,limit+1]);
  if(!r)return {gone:true};const members=r.members.slice(0,limit).map(m=>({...m,mCents:centsFromDb(m.mCents)})),last=members.at(-1);
  return {memberCount:centsFromDb(r.member_count),pairCount:centsFromDb(r.pair_count),members,next:r.members.length>limit?{date:last.date,txnId:last.txnId}:null};
}
export async function duplicatePairsPage(tx,{orgId,today,window,groupKey,after=null,limit=50,budget=tx,detailOnly=false}) {
  const state=await facts(tx,{orgId,today,window,budget,detailOnly});pageInput({groupKey,after,limit},true);if(state.skipped)return {gone:true};
  const {rows:[r]}=await tx.query(`SELECT g.member_count,g.pair_count,pg_temp.mv_pair_work(array_agg(m.txn_id ORDER BY m.day,m.txn_id),
    array_agg(m.day ORDER BY m.day,m.txn_id),array_agg(m.class ORDER BY m.day,m.txn_id),$2,$3,$4) page
    FROM mv_group g JOIN mv_candidate_member m USING(component) WHERE ${groupKeySql}=$1 GROUP BY g.member_count,g.pair_count`,[groupKey,after?.lo??null,after?.hi??null,limit]);
  return r?{memberCount:centsFromDb(r.member_count),pairCount:centsFromDb(r.pair_count),...r.page}:{gone:true};
}
