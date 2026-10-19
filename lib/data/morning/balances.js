import { centsFromDb, addCents, subCents, negCents, UnsafeAmountError } from './clock.js';

export const SUPPORTED_TYPES = ['bank', 'credit_card'];
const scopes = new WeakMap();
const companySql = `SELECT e.entity_id,e.name,coalesce(t.return_type='household_1040',false) AS personal,
  CASE WHEN c.entity_id IS NULL THEN 'USD' ELSE c.home END AS home
  FROM entity e LEFT JOIN tax_profile t ON t.org_id=e.org_id AND t.entity_id=e.entity_id
  LEFT JOIN currency_settings c ON c.org_id=e.org_id AND c.entity_id=e.entity_id
  WHERE e.org_id=$1 ORDER BY personal,lower(e.name) COLLATE "C",e.entity_id`;
function rememberScope(tx, orgId, rows) {
  const scope = Object.freeze({ orgId, supportedEntityIds:Object.freeze(rows.filter(r => r.home === 'USD').map(r => r.entity_id)),
    unavailable:Object.freeze(rows.filter(r => r.home !== 'USD').map(r => Object.freeze({entityId:r.entity_id,home:r.home,reason:'unsupported_home_currency'}))) });
  scopes.set(tx, scope);
  return scope;
}
// This scope is cached only on the one snapshot facade, never across computations.
export async function readHomeCurrencyScope(tx, { orgId }) {
  const prior = scopes.get(tx);
  if (prior?.orgId === orgId) return prior;
  return rememberScope(tx, orgId, (await tx.query(companySql, [orgId])).rows);
}
export const homeCents = (scope, entityId, amount) => scope.supportedEntityIds.includes(entityId) ? centsFromDb(amount) : null;
export function sumHomeCents(scope, rows) {
  let sum = 0;
  for (const row of rows) { const n = homeCents(scope, row.entityId, row.cents); if (n === null) return null; sum = addCents(sum, n); }
  return sum;
}
export async function readBalanceVector(tx, { orgId, today, budget = tx, combined = false }) {
  const balanceSql=`SELECT a.account_id,a.entity_id,a.name,a.type,a.active,a.parent_id,
    coalesce(sum(p.amount_cents) FILTER(WHERE p.txn_date<=$2),0)::text AS signed,
    coalesce(sum(p.amount_cents) FILTER(WHERE p.txn_date=$2),0)::text AS today
    FROM account a LEFT JOIN posting p ON p.org_id=a.org_id AND p.entity_id=a.entity_id AND p.account_id=a.account_id
    WHERE a.org_id=$1 AND a.type IN ('bank','credit_card') GROUP BY a.account_id ORDER BY a.account_id`;
  let rows,companyRows;
  if(combined){
    const result=await tx.query(`WITH companies AS (${companySql}), balances AS (${balanceSql})
    SELECT c.entity_id company_id,c.name company_name,c.personal,c.home,b.* FROM companies c LEFT JOIN balances b USING(entity_id)
    ORDER BY c.personal,lower(c.name) COLLATE "C",c.entity_id,b.account_id`, [orgId, today]);
  const companyMap=new Map();rows=[];
  for(const {company_id,company_name,personal,home,...r} of result.rows){
    companyMap.set(company_id,{entity_id:company_id,name:company_name,personal,home});if(r.account_id!==null)rows.push(r);
  }
  rows.sort((a,b)=>a.account_id-b.account_id);
  companyRows=[...companyMap.values()];
  }else{
    rows=(await tx.query(balanceSql,[orgId,today])).rows;
    companyRows=(await tx.query(companySql,[orgId])).rows;
  }
  const currencyScope = rememberScope(tx, orgId, companyRows);
  const companies = companyRows.map(r => ({entityId:r.entity_id,name:r.name,isPersonal:r.personal}));
  const failed = new Map(currencyScope.unavailable.map(r => [r.entityId,r.reason]));
  const accounts = [];
  for (let i = 0; i < rows.length; i++) {
    if (i % 256 === 0) await budget.checkpoint();
    const r = rows[i];
    let signedCents = null, todayCents = null;
    if (!failed.has(r.entity_id)) {
      try { signedCents = centsFromDb(r.signed); todayCents = centsFromDb(r.today); }
      catch (error) { if (!(error instanceof UnsafeAmountError)) throw error; failed.set(r.entity_id, 'overflow'); }
    }
    accounts.push({accountId:r.account_id,entityId:r.entity_id,name:r.name,type:r.type,active:r.active,parentId:r.parent_id,signedCents,todayCents,hidden:!r.active && signedCents === 0});
  }
  const entityIds = companies.filter(c => c.isPersonal).map(c => c.entityId);
  return { companies, accounts, personal:{count:entityIds.length,entityIds}, failures:[...failed].map(([entityId,reason]) => ({entityId,reason})), currencyScope };
}
const zero = () => ({cashCents:0,cardsOwedCents:0,availableCents:0,postedTodayCashCents:0,postedTodayAvailableCents:0});
const unavailable = () => Object.fromEntries(Object.keys(zero()).map(k => [k,null]));
function totals(accounts) {
  const result = zero();
  for (const a of accounts) {
    const signed = centsFromDb(a.signedCents), today = centsFromDb(a.todayCents ?? 0);
    result.availableCents = addCents(result.availableCents, signed);
    result.postedTodayAvailableCents = addCents(result.postedTodayAvailableCents, today);
    if (a.type === 'bank') {
      result.cashCents = addCents(result.cashCents, signed);
      result.postedTodayCashCents = addCents(result.postedTodayCashCents, today);
    } else if (a.type === 'credit_card') result.cardsOwedCents = addCents(result.cardsOwedCents, negCents(signed));
    else throw new UnsafeAmountError();
  }
  return result;
}
export function companyTotals(vector) {
  const failed = new Set((vector.failures ?? []).map(f => f.entityId));
  const byCompany = new Map(vector.companies.map(c => [c.entityId,[]]));
  for (const a of vector.accounts) byCompany.get(a.entityId)?.push(a);
  const companies = vector.companies.map(c => {
    const accounts = byCompany.get(c.entityId);
    try {
      if (failed.has(c.entityId)) throw new UnsafeAmountError();
      return {...c,status:'ok',...totals(accounts),accounts};
    } catch (error) {
      if (!(error instanceof UnsafeAmountError)) throw error;
      return {...c,status:'unavailable',...unavailable(),accounts};
    }
  });
  let grand;
  try {
    grand = {status:'ok',...zero()};
    for (const c of companies) {
      if (c.status !== 'ok') throw new UnsafeAmountError();
      for (const k of Object.keys(zero())) grand[k] = addCents(grand[k], c[k]);
    }
  } catch (error) { if (!(error instanceof UnsafeAmountError)) throw error; grand = {status:'incomplete',...unavailable()}; }
  return { companies, grand };
}
export async function readCurrentMetadata(tx, { orgId, accountIds }) {
  const { rows } = await tx.query('SELECT account_id,entity_id,name,type,active FROM account WHERE org_id=$1 AND account_id=ANY($2::bigint[])', [orgId,accountIds]);
  return new Map(rows.map(r => [r.account_id,{entityId:r.entity_id,name:r.name,type:r.type,active:r.active}]));
}
export function compareVectors(baseline, current, metadata) {
  const beforeAccounts = new Map(baseline.accounts.map(a => [a.accountId,a])), afterAccounts = new Map(current.accounts.map(a => [a.accountId,a]));
  const beforeTotals = companyTotals(baseline), afterTotals = companyTotals(current);
  const beforeCompanies = new Map(beforeTotals.companies.map(c => [c.entityId,c]));
  const afterCompanies = new Map(afterTotals.companies.map(c => [c.entityId,c]));
  const unavailableCompanies = new Set([...beforeCompanies.values(),...afterCompanies.values()].filter(c => c.status !== 'ok').map(c => c.entityId));
  const scopedCompanies = new Set(), rows = [];
  const side = (a, companies) => a ? {...a,entityName:companies.get(a.entityId)?.name ?? null} : null;
  let incomplete = beforeTotals.grand.status !== 'ok' || afterTotals.grand.status !== 'ok';
  for (const accountId of [...new Set([...beforeAccounts.keys(),...afterAccounts.keys()])].sort((a,b) => a-b)) {
    const b = beforeAccounts.get(accountId), a = afterAccounts.get(accountId);
    const changed = !b || !a || b.entityId !== a.entityId || b.type !== a.type;
    let reason = b && a && b.entityId !== a.entityId ? 'company_changed' : b && a && b.type !== a.type ? 'reclassified' : null;
    if (b && !a) reason = metadata === null ? 'unavailable' : metadata.has(accountId) ? 'reclassified' : 'no_longer_present';
    let cashDeltaCents, availableDeltaCents;
    try {
      if (reason === 'unavailable' || b && (!beforeCompanies.has(b.entityId) || unavailableCompanies.has(b.entityId))
        || a && (!afterCompanies.has(a.entityId) || unavailableCompanies.has(a.entityId))) throw new UnsafeAmountError();
      cashDeltaCents = subCents(a?.type === 'bank' ? a.signedCents : 0, b?.type === 'bank' ? b.signedCents : 0);
      availableDeltaCents = subCents(a ? a.signedCents : 0, b ? b.signedCents : 0);
    } catch (error) {
      if (!(error instanceof UnsafeAmountError)) throw error;
      cashDeltaCents = availableDeltaCents = null; reason = 'unavailable'; incomplete = true;
      if (b) unavailableCompanies.add(b.entityId); if (a) unavailableCompanies.add(a.entityId);
    }
    if (changed) { if (b) scopedCompanies.add(b.entityId); if (a) scopedCompanies.add(a.entityId); }
    if (changed || cashDeltaCents !== 0 || availableDeltaCents !== 0) rows.push({accountId,change:!b?'entered_scope':!a?'left_scope':'changed',reason,
      before:side(b,beforeCompanies),after:side(a,afterCompanies),cashDeltaCents,availableDeltaCents,hidden:false});
  }
  const summary = c => c ? {name:c.name,isPersonal:c.isPersonal,cashCents:c.cashCents,cardsOwedCents:c.cardsOwedCents,availableCents:c.availableCents} : null;
  const companies = [...new Set([...beforeCompanies.keys(),...afterCompanies.keys()])].map(entityId => {
    const b = beforeCompanies.get(entityId), a = afterCompanies.get(entityId);
    const scopeChanged = !b || !a || scopedCompanies.has(entityId);
    let cashDeltaCents = null, availableDeltaCents = null;
    try {
      if (unavailableCompanies.has(entityId)) throw new UnsafeAmountError();
      cashDeltaCents = subCents(a?.cashCents ?? 0, b?.cashCents ?? 0);
      availableDeltaCents = subCents(a?.availableCents ?? 0, b?.availableCents ?? 0);
    } catch (error) { if (!(error instanceof UnsafeAmountError)) throw error; incomplete = true; }
    return {entityId,before:summary(b),after:summary(a),cashDeltaCents,availableDeltaCents,scopeChanged};
  });
  let cashChangeCents = 0, availableChangeCents = 0;
  try {
    if (incomplete) throw new UnsafeAmountError();
    for (const c of companies) { cashChangeCents = addCents(cashChangeCents,c.cashDeltaCents); availableChangeCents = addCents(availableChangeCents,c.availableDeltaCents); }
  } catch (error) { if (!(error instanceof UnsafeAmountError)) throw error; cashChangeCents = availableChangeCents = null; incomplete = true; }
  return {incomplete,cashChangeCents,availableChangeCents,scopeChanged:companies.some(c => c.scopeChanged),companies,rows};
}
