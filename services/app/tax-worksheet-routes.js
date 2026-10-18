// services/app/tax-worksheet-routes.js
// The T3 return pages (spec §8, §11): /tax/:entity/:year (worksheet), /manual, /adjustments, /cash, /cogs, and their POSTs, plus
// /revisions (take a working revision). GET for everyone who may read tax and open the company; POSTs for admins and, where the company
// allows it, the accountant (reports role) — roles.js TAX_WRITES and the check below. A forged company is "not found" (tax-routes.js
// companyOf); a forged id inside a form is refused by the data module, which scopes every row to this return.
import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { getProfile } from '../../lib/tax/periods.js';
import { listActivities } from '../../lib/tax/activities.js';
import { computeReturn, computeIn } from '../../lib/tax/engine/compute.js';
import { takeWorkingRevision, listRevisions, driftOf } from '../../lib/tax/engine/revision.js';
import { saveManualItem, clearManualItem, markRemainingNotApplicable, MAX_STATEMENT_ROWS } from '../../lib/tax/manual.js';
import { saveAdjustment, withdrawAdjustment, answerProposal, listAdjustments } from '../../lib/tax/adjustments.js';
import { saveTimingReview, clearTimingReview, accrualEventOf } from '../../lib/tax/cash.js';
import { classifyEntry, clearClassification } from '../../lib/tax/classify.js';
import { saveWorkpaper, classifyMovement, clearMovement } from '../../lib/tax/cogs.js';
import { taxWorksheetPage, taxManualPage, taxAdjustmentsPage, taxCashPage, taxCogsPage } from '../../lib/views/tax-worksheet.js';

export const WORKSHEET_PATH = /^\/tax\/(\d{1,18})\/(\d{4})(?:\/(manual|adjustments|cash|cogs|revisions)(?:\/(save|clear|rest|add|withdraw|answer|review|unclassify|classify|movement))?)?$/;
const ACTIONS = { '': [], manual: ['save', 'clear', 'rest'], adjustments: ['add', 'withdraw', 'answer'], cash: ['review', 'clear', 'classify', 'unclassify'], cogs: ['save', 'movement', 'unclassify'], revisions: [] };

// The versions of a transaction of an accrual return given by its number, as the accrual gate reads it now: the person names it, so the
// decision is checked against it as it is (saveTimingReview checks it again under the locks).
async function currentVersions(pool, { orgId, entityId, returnId, txnId }) {
  const { rows: [ret] } = await pool.query(`SELECT return_id, entity_id, tax_method, period_start::text AS period_start, period_end::text AS period_end FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND return_id = $3`,
    [orgId, entityId, returnId]);
  if (!ret || ret.tax_method !== 'accrual' || !/^\d{1,16}$/.test(String(txnId))) return { txnVersion: null, eventVersion: null };
  const e = await accrualEventOf(pool, { orgId, ret: { ...ret, return_id: Number(ret.return_id), entity_id: Number(ret.entity_id) }, txnId: Number(txnId) });
  return { txnVersion: e?.txnVersion ?? null, eventVersion: e?.eventVersion ?? null };
}

export async function worksheetRoutes(h, { company, year, section, action }) {
  const { req, query, form, ctx, pool, page, base, go, takeFlash, actor, who } = h;
  if (!ACTIONS[section ?? '']?.includes(action ?? '') && action) throw new HttpError(404, 'Not found');
  const orgId = ctx.orgId;
  const { rows: [ret] } = await pool.query('SELECT return_id FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_end = $3::date', [orgId, company.entityId, `${year}-12-31`]);
  if (!ret) throw new HttpError(404, 'No tax period for that year');
  const scope = { orgId, entityId: company.entityId, returnId: Number(ret.return_id) };
  const profile = await getProfile(pool, { orgId, entityId: company.entityId });
  const canEdit = who.role === 'admin' || (who.role === 'reports' && profile.accountant_may_edit === true);
  const companyIds = ctx.companies.map(c => Number(c.entityId));
  const canOpen = id => companyIds.includes(Number(id));
  const here = `/tax/${company.entityId}/${year}${section && section !== 'revisions' ? `/${section}` : ''}`;
  const show = async (error = null, status = 200, extra = {}) => {
    const r = await computeReturn(pool, { ...scope, canOpen });
    const args = { ...base(), flash: takeFlash(), company, year, r, canEdit, error, ...extra };
    if (!section || section === 'revisions') {
      const [revisions, drift] = await Promise.all([listRevisions(pool, scope), r && !r.refused ? driftOf(pool, { ...scope, canOpen }) : null]);
      return page(taxWorksheetPage({ ...args, line: query.line ?? null, revisions, drift }), status);
    }
    if (section === 'manual') return page(taxManualPage(args), status);
    if (section === 'adjustments') return page(taxAdjustmentsPage({ ...args, groups: await listAdjustments(pool, { orgId, returnId: scope.returnId }) }), status);
    if (section === 'cash') return page(taxCashPage(args), status);
    return page(taxCogsPage({ ...args, activities: await listActivities(pool, { orgId, entityId: company.entityId }) }), status);
  };
  if (req.method === 'GET') {
    if (action || section === 'revisions') throw new HttpError(405, 'Method not allowed');
    await show();
    return true;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!section || (section !== 'revisions' && !action)) throw new HttpError(405, 'Method not allowed');
  if (!canEdit) throw new HttpError(403, 'This company does not let the accountant change its tax workpapers.');
  const back = (message = 'Saved.') => { go(here, 'ok', message); return true; };
  // Statement rows as the form sent them: as many as it says it carries (every row the page showed, plus the blank ones). More than the
  // page can show is refused, never cut off (the save refuses more than MAX_STATEMENT_ROWS filled rows).
  const rows = (labels, amounts, n = 4) => {
    const count = Math.max(Number.parseInt(n, 10) || 0, 0);
    if (count > MAX_STATEMENT_ROWS + 2) throw new ValidationError(`A statement holds at most ${MAX_STATEMENT_ROWS} rows; the form sent ${count}.`);
    return Array.from({ length: count }, (_, i) => ({ label: form.get(`${labels}_${i}`) ?? '', amount: form.get(`${amounts}_${i}`) ?? '' }));
  };
  let draft = null;
  try {
    if (section === 'revisions') {
      const v = await takeWorkingRevision(pool, { ...scope, takenBy: actor, canOpen });
      return back(`Working revision ${v.revisionNo} taken.`);
    }
    if (section === 'manual') {
      if (action === 'save') {
        draft = { itemKey: form.get('item_key') ?? '', amount: form.get('amount') ?? '', workpaper: form.has('workpaper') ? form.get('workpaper') : undefined, rows: Array.from({ length: Math.min(Math.max(Number.parseInt(form.get('row_count') ?? '0', 10) || 0, 0), MAX_STATEMENT_ROWS + 2) }, (_, i) => ({ label: form.get(`label_${i}`) ?? '', amount: form.get(`amount_${i}`) ?? '' })) };
        // The support travels only when the form carries its field (the page always does, filled with what is stored): never cleared by omission.
        await saveManualItem(pool, { ...scope, itemKey: draft.itemKey, status: form.get('status') ?? '', amount: form.get('amount'), rows: rows('label', 'amount', form.get('row_count') ?? 4),
          workpaper: draft.workpaper, enteredBy: actor });
      }
      if (action === 'clear') await clearManualItem(pool, { ...scope, itemKey: form.get('item_key') ?? '' });
      if (action === 'rest') return back(`${await markRemainingNotApplicable(pool, { ...scope, keys: form.getAll('key'), enteredBy: actor })} items marked not applicable.`);
      return back();
    }
    if (section === 'adjustments') {
      if (action === 'add') {
        const lines = [0, 1, 2].map(i => ({ slotKey: form.get(`slot_${i}`) ?? '', amount: form.get(`amount_${i}`) ?? '', m1Class: form.get(`class_${i}`) ?? '' })).filter(l => l.slotKey.trim() || l.amount.trim());
        await saveAdjustment(pool, { ...scope, purpose: form.get('purpose') ?? '', memo: form.get('memo'), evidence: form.get('evidence'), lines, decidedBy: actor });
      }
      if (action === 'withdraw') await withdrawAdjustment(pool, { ...scope, groupId: form.get('group_id'), reason: form.get('reason'), decidedBy: actor });
      if (action === 'answer') {
        await answerProposal(pool, { ...scope, key: form.get('key') ?? '', version: form.get('version') ?? '', decision: form.get('decision') ?? '', reason: form.get('reason'), decidedBy: actor,
          compute: (tx, a) => computeIn(tx, { ...a, canOpen }) });
      }
      return back();
    }
    if (section === 'cash') {
      if (action === 'review') {
        // A selected event ("pick": txn:txnVersion:eventVersion, as the page listed it), or a candidate's own fields; on an accrual return a
        // transaction given by its number is reviewed as it is now (its versions read under the lock, the event checked to have income or
        // expense of the period).
        const [pTxn, pTxnV, pEventV] = String(form.get('pick') ?? '').split(':');
        let txnId = pTxn || form.get('txn_id'), txnVersion = pTxn ? pTxnV : form.get('txn_version'), eventVersion = pTxn ? pEventV : form.get('event_version');
        if (!pTxn && !txnVersion && txnId) ({ txnVersion, eventVersion } = await currentVersions(pool, { ...scope, txnId }));
        await saveTimingReview(pool, { ...scope, txnId, kind: form.get('kind') ?? '', decision: form.get('decision') ?? '', slotKey: form.get('slot_key') || null, amount: form.get('amount') || null,
          recognizeOn: form.get('recognize_on') || null, expectTxnVersion: txnVersion || null, expectEventVersion: eventVersion || null, reviewedBy: actor, reason: form.has('reason') ? form.get('reason') : undefined });
      }
      if (action === 'clear') await clearTimingReview(pool, { ...scope, reviewId: form.get('review_id') });
      if (action === 'classify') {
        await classifyEntry(pool, { ...scope, txnId: form.get('txn_id'), cls: form.get('class') ?? '', lines: form.getAll('line'), expectTxnVersion: form.get('txn_version') || null, reviewedBy: actor, reason: form.has('reason') ? form.get('reason') : undefined });
      }
      if (action === 'unclassify') await clearClassification(pool, { ...scope, txnId: form.get('txn_id') });
      return back();
    }
    if (section === 'cogs') {
      if (action === 'save') {
        const reviewedLines = { '1': form.get('line_1'), '2': form.get('line_2'), '3': form.get('line_3'), '4': form.get('line_4'), '7': form.get('line_7'),
          '5': rows('other_label', 'other_amount', form.get('other_count') ?? 0).map(x => ({ label: x.label, amount: x.amount })) };
        await saveWorkpaper(pool, { ...scope, activityId: form.get('activity_id'), path: form.get('path') ?? '', treatment: form.get('treatment') || null, method: form.get('method') ?? '',
          lifo: form.get('lifo') === '1', subnormalWritedown: form.get('subnormal') === '1', valuationChanged: form.get('valuation_changed') === '1',
          begin: form.get('begin') || null, end: form.get('end') || null, reviewedLines: form.get('path') === 'reviewed' ? reviewedLines : null, sourceNote: form.get('note'), reviewedBy: actor });
      }
      if (action === 'movement') {
        await classifyMovement(pool, { ...scope, accountId: form.get('account_id'), txnId: form.get('txn_id'), lineNo: form.get('line_no'), cls: form.get('class') ?? '', expectTxnVersion: form.get('txn_version') || null, reviewedBy: actor, reason: form.has('reason') ? form.get('reason') : undefined });
      }
      if (action === 'unclassify') await clearMovement(pool, { ...scope, accountId: form.get('account_id'), txnId: form.get('txn_id'), lineNo: form.get('line_no') });
      return back();
    }
    throw new HttpError(404, 'Not found');
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    await show(error.message, 422, draft ? { unsaved: draft } : {});
    return true;
  }
}
