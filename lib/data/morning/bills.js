import { openDocuments } from '../../reports/receivables.js';
import { addDays,daysBetween } from '../../domain/dates.js';
import { putItems,pageItems } from './items.js';
import { readHomeCurrencyScope } from './balances.js';
import { centsFromDb } from './clock.js';
import { ValidationError } from '../writes.js';

const built=new WeakMap();
export async function billsAndInvoices(tx,{orgId,entityIds,today,store,after={bills:null,invoices:null},limit=50,mode='page',budget=tx,currencyScope=null}) {
  if(!['page','relation','build'].includes(mode))throw new ValidationError('Invalid document mode');
  if(!Array.isArray(entityIds)||!entityIds.every(id=>Number.isSafeInteger(id)&&id>0))throw new ValidationError('Invalid document context');
  const entityScope=JSON.stringify([...new Set(entityIds)].sort((a,b)=>a-b));
  let state=built.get(store);
  if(state&&(state.tx!==tx||state.orgId!==orgId||state.today!==today||state.entityScope!==entityScope))throw new ValidationError('Invalid document context');
  if(!state){
    currencyScope??=await readHomeCurrencyScope(tx,{orgId});
    const source=await openDocuments(tx,{orgId,entityIds,asOf:today,types:['bill','invoice','late_fee'],mode:'query',budget,currencyScope});
    const {rows}=await putItems(tx,{store,budget,select:{text:`${source.text}, selected AS (
      SELECT *,CASE WHEN type='bill' THEN 'bill' ELSE 'invoice' END rule,
        CASE WHEN due<$8::date THEN 0 WHEN due=$8::date THEN 1 WHEN due<=$9::date THEN 2 ELSE 4 END severity,
        due<=$9::date due_reason,approval='awaiting' awaiting_reason
      FROM filtered WHERE type='bill' AND (due<=$9::date OR approval='awaiting') OR type IN ('invoice','late_fee') AND due<$8::date
    ) SELECT rule||':'||entity_id||':'||txn_id,rule,entity_id,
      encode(sha256(convert_to(rule||'|1|'||jsonb_build_array(type,open,due,approval,severity,due_reason,awaiting_reason,home_supported)::text,'UTF8')),'hex'),
      severity,due,entity_name,1,open,type='bill' AND due_reason,type='bill' AND coalesce(awaiting_reason,false),
      jsonb_build_object('txnId',txn_id,'type',type,'date',date,'due',due,'open',open::text,'approval',approval,'partyId',party_id,'partyName',party_name,
        'docNumber',doc_number,'entityName',entity_name,'dueReason',due_reason,'awaitingReason',coalesce(awaiting_reason,false),'coverage',CASE WHEN home_supported THEN 'known' ELSE 'unsupported_home_currency' END),NOT home_supported
      FROM selected`,values:[...source.values,today,addDays(today,7)],summary:`SELECT rule,count(*)::text count,
        count(*) FILTER(WHERE coverage_unknown)::text n,
        CASE WHEN count(open_cents)=count(*) THEN sum(open_cents)::text END open,
        count(*) FILTER(WHERE due_bill)::text due,count(*) FILTER(WHERE awaiting_bill)::text awaiting FROM inserted GROUP BY rule`}});
    const summaries=Object.fromEntries(['bill','invoice'].map(rule=>{const r=rows.find(r=>r.rule===rule);return [rule,
      {count:centsFromDb(r?.count??'0'),openCents:r?(r.open===null?null:centsFromDb(r.open)):0,
        ...(rule==='bill'?{dueCount:centsFromDb(r?.due??'0'),awaitingCount:centsFromDb(r?.awaiting??'0')}:{})}];}));
    state={tx,orgId,today,entityScope,summaries,coverage:Object.fromEntries(['bill','invoice'].map(rule=>{const n=centsFromDb(rows.find(r=>r.rule===rule)?.n??'0');return [rule,{known:n===0,unsupportedCount:n}];}))};
    store.setRuleAvailability('bill',true);store.setRuleAvailability('invoice',true);built.set(store,state);
  }
  if(mode==='relation')return {relation:'mv_attention',coverage:state.coverage};
  if(mode==='build')return {bills:state.summaries.bill,invoices:state.summaries.invoice,coverage:state.coverage};
  const result={};
  for(const [key,rule,countKey] of [['bills','bill','bills'],['invoices','invoice','overdueInvoices']]){
    const p=await pageItems(tx,{store,rule,after:after[key]??null,limit});
    result[key]={count:p.counts[countKey],openCents:p.totals[rule].openCents,...(rule==='bill'?{dueCount:p.counts.dueBills,awaitingCount:p.counts.awaitingBills}:{}),coverage:state.coverage[rule],rows:p.page.map(r=>{
      budget.check();const {dueReason,awaitingReason,entityName,...d}=r.display;
      const severity=['overdue','today','next_seven','next_thirty','later','undated'][r.severity];
      return {...d,itemKey:r.itemKey,entityId:r.entityId,entityName,version:r.version,open:d.open==null?null:centsFromDb(d.open),severity,
        ...(rule==='bill'?{reasons:[...(dueReason?[d.due<today?'overdue':d.due===today?'due_today':'due_soon']:[]),...(awaitingReason?['awaiting_approval']:[])]}:{daysLate:daysBetween(d.due,today)})};
    }),next:p.next};
  }
  return result;
}
