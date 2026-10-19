import { EDITIONS,deadlinesFor } from '../../tax/catalog/index.js';
import { DEADLINES } from '../../tax/catalog/2025/shared.js';
import { addDays,isIsoDate } from '../../domain/dates.js';
import { itemVersion,putItems,pageItems } from './items.js';
import { ValidationError } from '../writes.js';

export const TAX_RULE_VERSION=1;
export async function loadTax(tx,{orgId}) {
  const {rows}=await tx.query(`SELECT e.entity_id AS "entityId",e.name,t.return_type AS "profileType",
    r.return_id AS "returnId",r.return_type AS "returnType",r.form_edition AS edition,
    r.period_start AS "periodStart",r.period_end AS "periodEnd",r.status FROM entity e
    LEFT JOIN tax_profile t ON t.org_id=e.org_id AND t.entity_id=e.entity_id
    LEFT JOIN tax_return r ON r.org_id=e.org_id AND r.entity_id=e.entity_id WHERE e.org_id=$1 ORDER BY e.entity_id,r.return_id`,[orgId]);
  const companies=new Map(),returns=[];
  for(const {name,profileType,...r} of rows){companies.set(r.entityId,{entityId:r.entityId,name,profileType});if(r.returnId!==null)returns.push(r);}
  return {companies:[...companies.values()],returns};
}
const coverageText={profile_missing:'Tax profile not set up.',return_period_missing:'Tax return period not set up.',
  no_personal_household:'Personal books not identified',missing_household_period:'Estimated-date reminders not set up for this year',
  disregarded_no_calendar:'No separate return calendar; see the owner’s return',unsupported_edition:'Tax form edition is not supported.',
  missing_period:'Tax return period is missing.',invalid_period:'Tax return period is invalid.',unknown_rule:'Tax deadline rule is unknown.',holiday_year_uncovered:'Tax calendar year is outside the holiday table.'};
function coverage(company,kind,period={},extra={}) {
  const facts={entityId:company?.entityId??null,entityName:company?.name??'',profileType:company?.profileType??null,returnId:period.returnId??null,
    periodStart:period.periodStart??null,periodEnd:period.periodEnd??null,returnType:period.returnType??null,edition:period.edition??null,
    neededYear:null,installment:null,...extra};
  return {...facts,rule:'tax-coverage',kind,category:kind,ruleVersion:TAX_RULE_VERSION,text:coverageText[kind],severity:'undated',
    itemKey:`tax-coverage:${facts.entityId??'org'}:${kind}:${facts.returnId??'profile'}:${facts.neededYear??'-'}:${facts.installment??'-'}`};
}
const severity=(due,today)=>due<today?'overdue':due===today?'today':due<=addDays(today,7)?'next_seven':'next_thirty';
export function* taxCalendarItems(input) { yield* calendarItems(input); }
function* calendarItems({companies,returns,today},check=()=>{}) {
  if(!isIsoDate(today))throw new ValidationError('Invalid tax calendar date');
  const through=addDays(today,30),byEntity=new Map();
  for(const period of returns){check();if(!byEntity.has(period.entityId))byEntity.set(period.entityId,[]);byEntity.get(period.entityId).push(period);}
  let households=0;
  for(const company of companies){
    check();
    const periods=byEntity.get(company.entityId)??[];
    if(!company.profileType||company.profileType==='none')yield coverage(company,'profile_missing');
    if(!periods.length)yield coverage(company,'return_period_missing');
    if(company.profileType==='household_1040'){
      households++;
      const years=new Map([[Number(today.slice(0,4)),'year'],[Number(through.slice(0,4)),'year']]);
      // This determines needed source periods only. It never emits reminders for an absent period.
      for(const year of new Set([Number(today.slice(0,4))-1,...years.keys()])) {
        let dates;
        try {dates=deadlinesFor('household_1040',2025,{periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});}
        catch {continue;}
        for(const d of dates)if(d.key.startsWith('es')&&d.due>=today&&d.due<=through)years.set(year,d.key);
      }
      for(const [neededYear,installment] of years)if(!periods.some(r=>r.returnType==='household_1040'&&isIsoDate(r.periodStart)&&isIsoDate(r.periodEnd)&&r.periodStart<r.periodEnd&&Number(r.periodStart.slice(0,4))===neededYear))
        yield coverage(company,'missing_household_period',{}, {neededYear,installment});
    }
    for(const r of periods){
      check();
      let failure;
      if(!r.periodStart||!r.periodEnd)failure='missing_period';
      else if(!isIsoDate(r.periodStart)||!isIsoDate(r.periodEnd)||r.periodStart>=r.periodEnd)failure='invalid_period';
      else if(!EDITIONS.includes(r.edition))failure='unsupported_edition';
      else if(!Object.hasOwn(DEADLINES,r.returnType))failure='unknown_rule';
      else if(r.returnType==='disregarded')failure='disregarded_no_calendar';
      if(failure){yield coverage(company,failure,r);continue;}
      let dates;
      try {dates=deadlinesFor(r.returnType,r.edition,{periodStart:r.periodStart,periodEnd:r.periodEnd});}
      catch(error){yield coverage(company,/no federal holiday table/.test(error.message)?'holiday_year_uncovered':'invalid_period',r);continue;}
      for(const d of dates){
        if(d.key==='extension'||d.due>through||d.key==='return'&&r.status==='filed')continue;
        yield {...r,...d,rule:'tax',itemKey:`tax:${r.entityId}:${r.returnId}:${d.key}`,entityName:company.name,
          passed:d.due<today,wording:d.due<today?'Catalog date passed':'Due',extension:d.key==='return'?'extension status unknown':null,
          payment:d.key.startsWith('es')?'payment status unknown':null,statusNote:r.status==='amended'?'filing status unknown':null,severity:severity(d.due,today)};
      }
    }
  }
  if(!households)yield coverage(null,'no_personal_household');
}
const built=new WeakMap(),ranks={overdue:0,today:1,next_seven:2,next_thirty:3,later:4,undated:5};
export async function taxAttention(tx,{orgId,today,store,rule='tax',after=null,limit=50,mode='page',budget=tx}) {
  if(!['tax','tax-coverage'].includes(rule)||!['page','relation','build'].includes(mode))throw new ValidationError('Invalid tax page');
  let state=built.get(store);
  if(state&&(state.tx!==tx||state.orgId!==orgId||state.today!==today))throw new ValidationError('Invalid tax context');
  if(!state){
    const facts=await loadTax(tx,{orgId,budget}),byKind={};let batch=[],unknownCount=0,count=0;
    for(const item of calendarItems({...facts,today},()=>budget.check())){
      if(item.rule==='tax-coverage'){unknownCount++;byKind[item.kind]=(byKind[item.kind]??0)+1;}else count++;
      const {itemKey,rule:kind,entityId,entityName,...display}=item;
      const cause=kind==='tax'?{periodStart:item.periodStart,periodEnd:item.periodEnd,returnType:item.returnType,edition:item.edition,due:item.due,
        extension:item.extension,payment:item.payment,status:item.status,severity:item.severity,ruleVersion:TAX_RULE_VERSION}:display;
      batch.push({itemKey,rule:kind,entityId,companySort:entityName||'Organization',version:itemVersion(kind,cause),severity:ranks[item.severity],due:item.due??null,display,coverageUnknown:kind==='tax-coverage'});
    }
    if(batch.length)await putItems(tx,{store,rows:batch,budget});
    state={tx,orgId,today,count,coverage:{known:unknownCount===0,unknownCount,byKind}};
    store.setRuleAvailability('tax',true);store.setRuleAvailability('tax-coverage',true);built.set(store,state);
  }
  return {...(mode==='relation'?{relation:'mv_attention'}:mode==='build'?{count:state.count}:await pageItems(tx,{store,rule,after,limit})),coverage:state.coverage};
}
