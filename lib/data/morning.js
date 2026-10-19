import { randomBytes } from 'node:crypto';
import { MorningAccessError } from './morning/access.js';
import { withMorningComputation, processMorningRuntime, LockBusyError, MorningTimeoutError } from './morning/locks.js';
import { PHOENIX, phoenixDate, UnsafeAmountError, centsFromDb } from './morning/clock.js';
import { readBalanceVector, companyTotals, compareVectors, readCurrentMetadata, readHomeCurrencyScope } from './morning/balances.js';
import { readWindowEntries, transferSuggestions, entryResidual } from './morning/entries.js';
import { bankReview } from './morning/bank.js';
import { billsAndInvoices } from './morning/bills.js';
import { taxAttention } from './morning/tax.js';
import { floorItems, readSeeds, newPayeeItems, largeItems, alertCoverage, forgetEligibility } from './morning/alerts.js';
import { buildDuplicateItems, duplicateMembersPage, duplicatePairsPage } from './morning/duplicates.js';
import { sourceFreshness, freshnessLimitations } from './morning/freshness.js';
import { prepareItems, pageItems } from './morning/items.js';
import { readObservation, computationPreferenceSql, loadGeneration, persistObservation } from './morning/observe.js';
import { makeCursor, readCursor } from './morning/cursor.js';
import { ValidationError } from './writes.js';
import { ensurePostingFacts, postingFactsState, restorePostingFacts } from './morning/posting-facts.js';

export const MORNING_SECTIONS = ['money','entries','transfers','bank','bills','tax','floors','alerts','duplicates','dismissals','freshness'];
const defaults = { readBalanceVector, readCurrentMetadata, readWindowEntries, transferSuggestions, bankReview, billsAndInvoices,
  taxAttention, floorItems, readSeeds, newPayeeItems, largeItems, alertCoverage, buildDuplicateItems,
  duplicateMembersPage, duplicatePairsPage, sourceFreshness, freshnessLimitations };
const sectionRules = { bank: ['bank'], bills: ['bill','invoice'], tax: ['tax','tax-coverage'], floors: ['floor'],
  alerts: ['new-payee','large'], duplicates: ['duplicate'] };
const emptyEntries = () => ({ totals: { aboveCount: 0, smallCount: 0, smallPositiveCents: 0, smallNegativeCents: 0,
  smallNetCents: 0, windowNetAvailableCents: 0, bankInCents: 0, bankOutCents: 0, cardChargesCents: 0, cardCreditsCents: 0 },
  page: [], next: null, skipped: 'first_look', coverage: { known: true } });
const incompleteMoney = () => ({ status: 'incomplete', grand: { status: 'incomplete', cashCents: null, cardsOwedCents: null,
  availableCents: null, postedTodayCashCents: null, postedTodayAvailableCents: null }, companies: [], personal: null, changes: null, vector: null });
const recoverable = error => error instanceof UnsafeAmountError || typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
  && !/^(08|53|57|58)/.test(error.code) && !error.morningConnectionFailure;
const internalContextKey = randomBytes(32);
const modelStores = new WeakMap();

function requiredSections(purpose, request) {
  if (purpose !== 'detail' || !request.kind) return new Set(MORNING_SECTIONS);
  if (['account', 'entries'].includes(request.kind)) return new Set(['money', 'entries', 'transfers']);
  if (request.kind === 'transfers') return new Set(['money', 'transfers']);
  if (request.kind.startsWith('duplicate-')) return new Set(['duplicates']);
  if (['freshness', 'limitations'].includes(request.resource?.rule)) return new Set(['freshness']);
  if (request.resource?.rule === 'alerts') return new Set(['money', 'floors', 'alerts', 'dismissals']);
  const selected = Object.entries(sectionRules).filter(([, rules]) =>
    request.kind === 'dismissed' || request.resource?.rule === 'all' || rules.includes(request.resource?.rule)).map(([name]) => name);
  if (selected.includes('floors')) selected.unshift('money');
  return new Set([...selected, 'dismissals']);
}

// Routes verify the external signature. Recheck all payload fields and ownership
// after acquiring locks; the retained context never supplies financial authority.
function checkedContext(context, identity, authority, request, N) {
  try {
    const token = makeCursor(internalContextKey, context);
    const expectedKind = request?.kind ?? context.kind, expectedResource = request?.resource ?? context.resource;
    const result = readCursor(internalContextKey, token, { sid: identity.sessionId, vk: identity.viewerKey, epoch: authority.epoch,
      expectedKind, expectedResource, now: N });
    return result.expired ? null : result;
  } catch { return null; }
}
async function preferencesIn(tx, { orgId, viewerKey }) {
  const { rows: [row] } = await tx.query(computationPreferenceSql, [orgId, viewerKey]);
  return preferencesOf(row);
}
function preferencesOf(row) {
  if (!row) throw new MorningAccessError('not_viewer');
  return { detailThresholdCents: centsFromDb(row.detail_threshold_cents),
    floors: new Map(row.floors.map(([id, n]) => [id, centsFromDb(n)])), thresholds: new Map(row.thresholds.map(([id, n]) => [id, centsFromDb(n)])) };
}

// Mutation consumers reuse the same context validation, preferences and full store.
// The store never enters a rendered/serialized model or a browser cursor.
export async function recomputeMorningItemStore(tx,{identity,authority,context,N,service}) {
  const ctx=checkedContext(context,identity,authority,{kind:'ctx',resource:null},N);
  const expired=()=>Object.assign(new ValidationError('Reload Morning View and try again.'),{status:409});
  if(!ctx)throw expired();
  const owned={orgId:identity.orgId,viewerKey:identity.viewerKey};
  const comparison=ctx.gen?await loadGeneration(tx,{...owned,generationId:ctx.gen}):null;
  if(ctx.gen&&!comparison)throw expired();
  const prefs=await preferencesIn(tx,owned);
  const model=await service.computeMorning(tx,{...owned,N,comparison,prefs,purpose:'dismiss',budget:tx});
  const store=modelStores.get(model);
  if(!store)throw new Error('Morning item store unavailable');
  return {model,store};
}

export function createMorningService({ runtime = processMorningRuntime, env = process.env, deps = {}, hooks = {} } = {}) {
  const production = env.NODE_ENV === 'production';
  const guard = extra => { if (production && Object.keys(extra).length) throw new Error('Test overrides are not allowed in production'); };
  guard(deps); guard(hooks);
  for (const [key, fn] of Object.entries(deps)) if (!Object.hasOwn(defaults, key) || typeof fn !== 'function') throw new Error('Unknown Morning loader');
  const loaders = { ...defaults, ...deps };

  async function computeMorning(tx, { orgId, viewerKey, N, comparison, prefs, purpose, budget, pageRequest = {} }) {
    if (budget !== tx || typeof tx.check !== 'function' || typeof tx.checkpoint !== 'function') throw new Error('Budgeted transaction required');
    tx.check();
    const today = phoenixDate(N), window = comparison ? { from: comparison.capturedAt, to: N } : null;
    const required = requiredSections(purpose, pageRequest);
    const store = await prepareItems(tx, { orgId, viewerKey, budget });
    const unavailable = [], diagnostics = {};
    const section = async (name, load) => {
      if (!required.has(name)) return null;
      const savepoint = `mv_section_${name}`;
      const postingState = postingFactsState(tx);
      await tx.query(`SAVEPOINT ${savepoint}`);
      let result;
      try {
        result = await load(); budget.check();
      } catch (error) {
        if (error instanceof MorningTimeoutError || !recoverable(error)) throw error;
        await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        restorePostingFacts(tx, postingState);
        if(name==='alerts')forgetEligibility(tx);
        for (const rule of sectionRules[name] ?? []) store.setRuleAvailability(rule, false);
        unavailable.push(name); diagnostics[name] = randomBytes(4).toString('hex'); result = null;
      }
      await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
      await hooks.afterSection?.(name, tx); budget.check();
      return result;
    };
    const money = await section('money', async () => {
      const vector = await loaders.readBalanceVector(tx, { orgId, today, budget, combined:true }), totals = companyTotals(vector);
      let changes = null;
      if (comparison) {
        const current = new Map(vector.accounts.map(a => [a.accountId, a]));
        const absent = comparison.accounts.filter(a => !current.has(a.accountId)).map(a => a.accountId);
        const metadata = absent.length ? await loaders.readCurrentMetadata(tx, { orgId, accountIds: absent, budget }) : current;
        changes = compareVectors(comparison, vector, metadata);
      }
      return { status: totals.grand.status === 'ok' && !changes?.incomplete ? 'complete' : 'incomplete', ...totals, personal: vector.personal, changes, vector };
    }) ?? incompleteMoney();
    if (!required.has('money') && (pageRequest.kind === 'attention' || pageRequest.kind === 'dismissed')) {
      // Detail labels need company names, not a scan of every historical balance.
      money.companies = (await tx.query('SELECT entity_id AS "entityId",name FROM entity WHERE org_id=$1 ORDER BY entity_id', [orgId])).rows;
    }
    const entries = await section('entries', async () => {
      if (!window) return emptyEntries();
      if (purpose === 'detail') await ensurePostingFacts(tx, { orgId, today, window, budget,
        includePeers: required.has('alerts') || required.has('duplicates') });
      const r = await loaders.readWindowEntries(tx, { orgId, ...window, today, budget,
        thresholdCents: prefs.detailThresholdCents, accountId: pageRequest.kind === 'account' ? pageRequest.resource.accountId : null,
        after: ['account','entries'].includes(pageRequest.kind) ? pageRequest.after ?? null : null,
        context: pageRequest.context });
      return { ...r, residual: entryResidual({ windowNetAvailableCents: r.totals.windowNetAvailableCents,
        observedAvailableChangeCents: money.changes?.availableChangeCents ?? null }) };
    });
    const transfers = await section('transfers', async () => {
      if (!window) return { count: 0, skippedMultiDate: 0, page: [], next: null, skipped: 'first_look', coverage: { known: true } };
      if (pageRequest.kind === 'transfers') await ensurePostingFacts(tx, { orgId, today, window, budget, includePeers: false });
      return loaders.transferSuggestions(tx, { orgId, ...window, today, budget,
        after: pageRequest.kind === 'transfers' ? pageRequest.after ?? null : null });
    });
    const bank = await section('bank', () => loaders.bankReview(tx, { orgId, store, mode: 'build', budget }));
    const bills = await section('bills', async () => {
      const currencyScope = money.vector?.currencyScope ?? await readHomeCurrencyScope(tx, { orgId });
      const entityIds = [...currencyScope.supportedEntityIds, ...currencyScope.unavailable.map(r => r.entityId)];
      return loaders.billsAndInvoices(tx, { orgId, entityIds, today, store, mode: 'build', currencyScope, budget });
    });
    const tax = await section('tax', () => loaders.taxAttention(tx, { orgId, today, store, mode: 'build', budget }));
    const floors = await section('floors', async () => {
      if (!money.vector) throw new UnsafeAmountError();
      const companies = new Map(money.vector.companies.map(c => [c.entityId, c.name]));
      return loaders.floorItems(tx, { accounts: money.vector.accounts.map(a => ({ ...a, entityName: companies.get(a.entityId) })),
        floors: prefs.floors, store, budget });
    });
    const alerts = await section('alerts', async () => {
      const seeds = await loaders.readSeeds(tx, { orgId, today, window, budget });
      const newPayees = await loaders.newPayeeItems(tx, { orgId, today, seeds, store, budget, thresholds:prefs.thresholds });
      const large = await loaders.largeItems(tx, { seeds, thresholds: prefs.thresholds, store, budget });
      const eligibility = await loaders.alertCoverage(tx, { seeds });
      return { newPayees, large, coverage: { ...seeds.coverage, ...eligibility,
        known: seeds.coverage.known && Object.values(eligibility).every(n => n === 0) } };
    });
    const duplicates = await section('duplicates', () => loaders.buildDuplicateItems(tx, { orgId, today, window, store, budget,
      detailOnly: purpose === 'detail' && ['duplicate-members','duplicate-pairs'].includes(pageRequest.kind) }));
    const freshness = await section('freshness', () => loaders.sourceFreshness(tx, { orgId, now: N, budget,
      after: pageRequest.kind === 'attention' && pageRequest.resource?.rule === 'freshness' ? pageRequest.after ?? null : null }));
    const folded = await section('dismissals', async () => {
      // Aggregate the entire relation before choosing any filtered page.
      const options = pageRequest.kind === 'dismissed' ? {fold:pageRequest.resource.fold,after:pageRequest.after??null}
        : pageRequest.kind === 'attention' && !['freshness','limitations'].includes(pageRequest.resource?.rule)
          ? {rule:pageRequest.resource?.rule??'all',after:pageRequest.after??null} : {};
      const selected = await pageItems(tx, { store, ...options, summary:true });
      return { active:selected, selected, fold:selected.fold, coverage:selected.coverage };
    });
    const countNames = ['bankLines','bankAccounts','bills','dueBills','awaitingBills','overdueInvoices','taxReminders','taxCoverage','floors','newPayees','large','duplicateGroups'];
    const attention = { page: pageRequest.kind === 'dismissed' ? [] : folded?.selected.page ?? [],
      next: pageRequest.kind === 'dismissed' ? null : folded?.selected.next ?? null,
      counts: folded?.active.counts ?? Object.fromEntries(countNames.map(k => [k, null])),
      totals: {...folded?.active.totals,bank:{...folded?.active.totals.bank,fullTotals:folded?.active.fullTotals??null}},
      coverage: { known: tax?.coverage.known ?? false, unknownCount: tax?.coverage.unknownCount ?? null,
        byKind: tax?.coverage.byKind ?? {}, page: pageRequest.resource?.rule==='tax-coverage'
          ? folded?.selected.page ?? [] : folded?.coverage.page ?? [],
        next: pageRequest.resource?.rule==='tax-coverage' ? folded?.selected.next ?? null : folded?.coverage.next ?? null }, unavailable };
    const dismissed = { matchingCount: folded?.fold.matching ?? null, staleCount: folded?.fold.stale ?? null,
      unavailableCount: folded?.fold.unavailable ?? null, complete: folded?.fold.complete ?? false,
      page: pageRequest.kind === 'dismissed' ? folded?.selected.page ?? [] : [],
      next: pageRequest.kind === 'dismissed' ? folded?.selected.next ?? null : null };
    let detail = null;
    if (pageRequest.kind === 'duplicate-members' || pageRequest.kind === 'duplicate-pairs') {
      detail = await section('duplicates', () => loaders[pageRequest.kind === 'duplicate-members' ? 'duplicateMembersPage' : 'duplicatePairsPage'](tx,
        { orgId, today, window, groupKey: pageRequest.resource.groupKey, after: pageRequest.after ?? null, budget, detailOnly: purpose === 'detail' }));
    } else if (pageRequest.kind === 'attention' && pageRequest.resource?.rule === 'limitations') {
      detail = await section('freshness', () => loaders.freshnessLimitations(tx, { orgId, sourceKey: pageRequest.resource.sourceKey,
        after: pageRequest.after ?? null, budget }));
    }
    const complete = (!required.has('money') || money.status === 'complete') && unavailable.length === 0;
    const coverageKnown = complete && folded?.coverage.known === true && tax?.coverage.known === true
      && bank?.coverage.length === 0 && Object.values(bills?.coverage ?? {}).every(c => c.known)
      && alerts?.coverage.known === true && duplicates?.coverage.known === true
      && ['missingParty','multipleParty','conflictParty','multiDate'].every(k => !duplicates?.coverage[k])
      && (freshness?.unknownCount ?? 0) === 0;
    budget.check();
    const model={ capturedAt: N, today, zone: PHOENIX, firstLook: comparison === null, comparison, money, entries, transfers, freshness,
      attention, dismissed, complete, coverageKnown, diagnostics, bank, bills, tax, floors, alerts, duplicates, detail };
    modelStores.set(model,store);return model;
  }

  async function operation(pool, options, observing) {
    const { identity, now, render, hooks: operationHooks = {}, runtime: selectedRuntime = runtime } = options;
    guard(operationHooks);
    try {
      return await withMorningComputation(pool, { identity, orgId: identity.orgId, viewerKey: identity.viewerKey,
        purpose: observing ? 'page' : 'detail', runtime: selectedRuntime, hooks: operationHooks }, async (tx, captured) => {
        const N = now === undefined ? captured.N : typeof now === 'function' ? now() : now;
        const owned = { orgId: identity.orgId, viewerKey: identity.viewerKey };
        let decision, visit, comparison, preference, historicalAccount, pageRequest = options.pageRequest ?? {};
        if (observing) {
          ({visit,decision,comparison,preference}=await readObservation(tx,{...owned,N}));
          if (decision.comparisonId && !comparison) return { status: 'expired' };
        } else {
          let ctx = checkedContext(options.context, identity, captured.authority,
            options.context?.kind==='ctx'?{kind:'ctx',resource:null}:options.pageRequest, N);
          if (!ctx) return { status: 'expired' };
          if(ctx.kind==='ctx'){
            ctx=checkedContext({...ctx,kind:pageRequest.kind,resource:pageRequest.resource,after:pageRequest.after??null},identity,captured.authority,pageRequest,N);
            if(!ctx)return {status:'expired'};
          }
          comparison = ctx.gen ? await loadGeneration(tx, { ...owned, generationId: ctx.gen }) : null;
          if (ctx.gen && !comparison) return { status: 'expired' };
          pageRequest = { ...pageRequest, kind: ctx.kind, resource: ctx.resource, after: ctx.after,
            context: { identity, generationId: ctx.gen } };
          if (ctx.kind === 'account') {
            const current = await tx.query("SELECT 1 FROM account WHERE org_id=$1 AND account_id=$2 AND type IN ('bank','credit_card')", [owned.orgId, ctx.resource.accountId]);
            if (!current.rowCount) {
              historicalAccount = comparison?.accounts.find(a => a.accountId === ctx.resource.accountId);
              if (!historicalAccount) {
                const {rows:[row]}=await tx.query(`SELECT a.observed_account_id AS "accountId",a.observed_entity_id AS "entityId",
                  a.account_name AS name,a.account_type AS type,a.signed_cents::text AS "signedCents"
                  FROM morning_visit v JOIN morning_snapshot_account a ON a.org_id=v.org_id AND a.viewer_key=v.viewer_key
                    AND a.generation_id IN (v.comparison_generation_id,v.latest_generation_id)
                  WHERE v.org_id=$1 AND v.viewer_key=$2 AND a.observed_account_id=$3
                  ORDER BY (a.generation_id=v.latest_generation_id) DESC LIMIT 1`,[owned.orgId,owned.viewerKey,ctx.resource.accountId]);
                historicalAccount=row;
              }
              if(!historicalAccount)return { status: 'not_found' };
            }
          }
          decision = { mode: 'detail', comparisonId: ctx.gen };
        }
        const prefs = observing ? preferencesOf(preference) : await preferencesIn(tx, owned);
        const model = await computeMorning(tx, { ...owned, N, comparison, prefs, purpose: observing ? 'page' : 'detail', budget: tx, pageRequest });
        if(pageRequest.kind==='account'){
          const id=pageRequest.resource.accountId,current=model.money.vector?.accounts.find(a=>a.accountId===id),before=comparison?.accounts.find(a=>a.accountId===id);
          model.accountDetail={accountId:id,name:current?.name??before?.name??historicalAccount?.name,current:current??null,comparison:before??null};
        }
        if (decision.mode === 'clock_unavailable') { model.complete = false; model.clockUnavailable = true; }
        const html = await render(tx, model, decision); tx.check();
        if (observing && model.complete) await persistObservation(tx, { ...owned, N, today: model.today, vector: model.money.vector, visit, decision });
        return { status: 'ok', html, model, decision };
      });
    } catch (error) {
      if (error instanceof MorningAccessError) return { status: 'denied', reason: error.reason };
      if (error instanceof LockBusyError) return { status: 'busy' };
      throw error;
    }
  }
  return { computeMorning, observeMorning: (pool, options) => operation(pool, options, true),
    readMorningDetail: (pool, options) => operation(pool, options, false) };
}
const service = createMorningService();
export const computeMorning = (tx, options) => service.computeMorning(tx, options);
export const observeMorning = (pool, options) => service.observeMorning(pool, options);
export const readMorningDetail = (pool, options) => service.readMorningDetail(pool, options);
