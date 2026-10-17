// services/app/tax-mapping-routes.js
// /tax/:entity/:year/mapping (spec §8, §11): GET for everyone who may read tax; POSTs for admins and, where the company allows it, the
// accountant (reports role). Every company named — the return's own in the path, an included one in a form — must be one the person
// may open, with every company on its inclusion path; a forged one is "not found", exactly as in T1's routes.
import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { getProfile } from '../../lib/tax/periods.js';
import { partiesFor } from '../../lib/tax/parties.js';
import { listActivities } from '../../lib/tax/activities.js';
import { coverage } from '../../lib/tax/coverage.js';
import { measureLines } from '../../lib/tax/measure.js';
import { saveBindings, clearBindings, attributeLine, removeAttribution, copyForward } from '../../lib/tax/bindings.js';
import { suggestionsFor, acceptSuggestion, acceptAllSure } from '../../lib/tax/suggest.js';
import { parseWhat } from '../../lib/tax/destinations.js';
import { taxMappingPage } from '../../lib/views/tax-mapping.js';
import { reportingChain } from '../../lib/tax/reporting.js';

const ROWS = 4;
// The rows of the mapping form: what_i ("treatment:destination"), share_i, amount_i, activity_i, owner_i, k1_i, label_i; memo is shared.
function rowsFrom(form) {
  const out = [];
  for (let i = 0; i < ROWS; i += 1) {
    const what = form.get(`what_${i}`);
    if (!what) continue;
    out.push({ ...parseWhat(what), share: form.get(`share_${i}`) || null, amount: form.get(`amount_${i}`) || null, activityId: form.get(`activity_${i}`) || null,
      interestPartyId: form.get(`owner_${i}`) || null, k1IssuerPartyId: form.get(`k1_${i}`) || null, rowLabel: form.get(`label_${i}`) || null, memo: form.get('memo') || null });
  }
  return out;
}
const fromOf = v => (/^\d{1,6}$/.test(String(v ?? '')) ? Number(v) : 0);

export async function mappingRoutes(h, { company, year, action }) {
  const { req, query, form, ctx, pool, page, base, go, takeFlash, actor, who } = h;
  const orgId = ctx.orgId, scope = { orgId, entityId: company.entityId };
  const { rows: [ret] } = await pool.query('SELECT return_id, return_type, period_start::text AS s, period_end::text AS e FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_end = $3::date', [orgId, company.entityId, `${year}-12-31`]);
  if (!ret) throw new HttpError(404, 'No tax period for that year');
  // A disregarded company's books are mapped on the return that includes them, never on its own period: its Mapping link leads there
  // (when the person may open that return), or back to its tax page with the reason. Nothing is mapped here.
  if (ret.return_type === 'disregarded') {
    if (action) throw new HttpError(409, 'A disregarded company’s books are mapped on the return that includes them.');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const chain = await reportingChain(pool, { orgId, entityId: company.entityId, periodStart: ret.s, periodEnd: ret.e });
    const ids = ctx.companies.map(c => Number(c.entityId));
    if (chain.filing && chain.hops.every(hp => ids.includes(Number(hp.entityId)))) {
      go(`/tax/${chain.filing.entityId}/${chain.filing.year}/mapping`, 'ok', `${company.name}’s books are mapped here, on ${chain.filing.name}’s return.`);
    } else {
      go(`/tax/${company.entityId}/profile`, 'warn', chain.filing || chain.blocked
        ? `${company.name}’s books are mapped on the return that includes them; open that company to map them.`
        : `${company.name} is disregarded but not included in a return for ${year} yet: include its books on its owner’s return first.`);
    }
    return true;
  }
  const returnId = Number(ret.return_id);
  const profile = await getProfile(pool, scope);
  const canEdit = who.role === 'admin' || (who.role === 'reports' && profile.accountant_may_edit === true);
  const companyIds = ctx.companies.map(c => Number(c.entityId));
  const canOpen = id => companyIds.includes(Number(id));
  const here = `/tax/${company.entityId}/${year}/mapping`;
  // The owners and K-1 payers this person may name (lib/tax/parties.js partiesFor, Codex r5 R5-N4): the pickers and the posts use one set.
  const nameable = () => partiesFor(pool, { orgId, companyIds, orgAdmin: Boolean(ctx.orgAdmin) });
  const checkParties = async rows => {
    const ok = new Set((await nameable()).map(p => Number(p.party_id)));
    for (const r of rows) for (const id of [r.interestPartyId, r.k1IssuerPartyId]) if (id && !ok.has(Number(id))) throw new HttpError(404, 'Party not found');
    return rows;
  };
  const show = async ({ error = null, status = 200, sourceId = query.source, accountId = query.account, lines = query.lines === '1', from = fromOf(query.from) } = {}) => {
    const cov = await coverage(pool, { ...scope, returnId, canOpen });
    let focus = null;
    if (accountId) {
      const s = cov.sources.find(x => x.entityId === Number(sourceId) && x.allowed && x.status === 'measured') ?? (() => { throw new HttpError(404, 'Company not found'); })();
      const a = s.accounts.find(x => x.accountId === Number(accountId)) ?? (() => { throw new HttpError(404, 'Account not found'); })();
      const live = lines ? (await measureLines(pool, { orgId, sourceEntityId: s.entityId, accountIds: [a.accountId], periodStart: cov.ret.period_start, periodEnd: cov.ret.period_end })).get(a.accountId) ?? [] : null;
      focus = { source: s, account: a, lines: live, from };
    }
    const [suggestions, parties, activities] = await Promise.all([suggestionsFor(pool, { orgId, cov, companyIds }), nameable(), listActivities(pool, scope)]);
    page(taxMappingPage({ ...base(), flash: takeFlash(), company, year, cov, suggestions, focus, parties, activities, canEdit, filter: query.show === 'all' ? 'all' : 'open', error }), status);
  };
  if (!action) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    await show();
    return true;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!canEdit) throw new HttpError(403, 'This company does not let the accountant change its tax mapping.');
  // The source company of a form, checked with every company on its inclusion path (spec §11).
  const sourceId = async () => {
    const id = Number(form.get('source_entity_id'));
    if (id === company.entityId) return id;
    const { rows: [s] } = await pool.query('SELECT entities FROM tax_inclusion_sources($1, $2) WHERE source_entity_id = $3', [orgId, returnId, id]);
    if (!s || !s.entities.every(e => canOpen(e))) throw new HttpError(404, 'Company not found');
    return id;
  };
  // A person's decision carries what the page showed (Codex r2 B5): a form without it is refused, never saved as if nothing could have changed.
  const shownToken = name => form.get(name) || (() => { throw new ValidationError('Reload the page: it did not say which version of this mapping it showed.'); })();
  // go() writes the 303 and returns nothing; true tells the dispatcher this request is handled.
  const back = (src, account, message = 'Saved.', extra = '') => { go(account ? `${here}?source=${src}&account=${account}${extra}#edit` : here, 'ok', message); return true; };
  try {
    if (action === 'bind') {
      const src = await sourceId(), measurement = form.get('measurement') ?? '';
      await saveBindings(pool, { ...scope, returnId, sourceEntityId: src, accountId: form.get('account_id'), measurement, split: form.get('split') || 'whole', rows: await checkParties(rowsFrom(form)),
        makeDefault: form.get('make_default') === '1', expectVersion: shownToken(`version_${measurement}`), expectSet: shownToken(`set_${measurement}`), canOpen, actor });
      return back(src, form.get('account_id'));
    }
    if (action === 'clear') {
      const src = await sourceId();
      await clearBindings(pool, { ...scope, returnId, sourceEntityId: src, accountId: form.get('account_id'), measurement: form.get('measurement') ?? '', expectSet: shownToken('set'), canOpen });
      return back(src, form.get('account_id'), 'Cleared.');
    }
    if (action === 'line') {
      const src = await sourceId();
      await attributeLine(pool, { ...scope, returnId, sourceEntityId: src, accountId: form.get('account_id'), txnId: form.get('txn_id'), lineNo: form.get('line_no'),
        expectTxnVersion: form.get('txn_version') || null, target: (await checkParties(rowsFrom(form)))[0] ?? {}, canOpen, actor });
      return back(src, form.get('account_id'), 'Line attributed.', '&lines=1');
    }
    if (action === 'unline') {
      const src = await sourceId();
      await removeAttribution(pool, { ...scope, returnId, sourceEntityId: src, bindingLineId: form.get('binding_line_id'), canOpen });
      return back(src, form.get('account_id'), 'Attribution removed.', '&lines=1');
    }
    if (action === 'accept') {
      // The form names the decision by its key; the server recomputes it under the save locks and accepts only the same decision (B7).
      await sourceId();
      await acceptSuggestion(pool, { ...scope, returnId, companyIds, canOpen, decision: form.get('decision') ?? '', actor });
      return back(null, null, 'Suggestion accepted and saved as the company default.');
    }
    if (action === 'accept-sure') {
      const r = await acceptAllSure(pool, { ...scope, returnId, companyIds, canOpen, shown: form.getAll('sure'), actor });
      const left = r.skipped.length + r.stale;
      return back(null, null, `Accepted ${r.accepted} sure suggestion${r.accepted === 1 ? '' : 's'}.${left ? ` ${left} changed since the page was shown and were left for you.` : ''}`);
    }
    if (action === 'copy-forward') {
      // Only books the person may open, with every company on their inclusion path (spec §11) — checked inside the copy, on the paths as
      // they are under the graph lock (Codex r3 R3-N3).
      const r = await copyForward(pool, { ...scope, returnId, canOpen, actor });
      return back(null, null, `Copied ${r.copied} mapping${r.copied === 1 ? '' : 's'} from the company defaults.${r.skipped.length ? ` ${r.skipped.length} default${r.skipped.length === 1 ? '' : 's'} need a person: ${r.skipped.slice(0, 3).map(x => `${x.accountName}: ${x.reason}`).join(' ')}` : ''}`);
    }
    throw new HttpError(404, 'Not found');
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    await show({ error: error.message, status: 422, sourceId: form.get('source_entity_id'), accountId: form.get('account_id'), lines: false, from: 0 });
    return true;
  }
}
