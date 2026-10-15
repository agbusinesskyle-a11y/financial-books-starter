import { safeBack } from '../../lib/domain/save-choices.js';
import { IMPORTED_LOCKED } from '../../lib/views/txn-extras.js';
import { settingsKey } from '../../lib/secrets.js';
import { readUpload, attachUpload, getUpload, UPLOAD_TYPES } from '../../lib/ai/read-bill.js';
import { HttpError, idParam } from './http.js';
import { dimsFromForm, dimsForSave } from './dims.js';
import { dimensionChoices, listTags } from '../../lib/data/accounting.js';
import { rateOn, multicurrencyOn } from '../../lib/data/currencies.js';
import { ValidationError, listTerms } from '../../lib/data/writes.js';
import { accountsOfTypes } from '../../lib/data/ledger.js';
import {
  saveVendorDoc, DuplicateWarning, approveBills, rejectBill, payBills, markBillPaid, voidVendorTxn, deleteVendorTxn, markChecksPrinted, updateBillPayment,
  nextCheckNumber, DOC_TYPES, closePurchaseOrder, reopenPurchaseOrder, convertReceiptToBill,
  submitBillForApproval } from '../../lib/data/payables.js';
import { listVendorTxns, getVendorTxn, listOpenBills, listChecksToPrint, parseVendorTxnFilters } from '../../lib/data/payables-read.js';
import { vendorChoices } from '../../lib/data/vendors.js';
import { listTxnDocuments } from '../../lib/data/documents.js';
import { getEntity, deliver } from '../../lib/data/messages.js';
import { getSalesSettings, renderEmail } from '../../lib/data/sales-settings.js';
import { renderPurchaseOrderPdf } from '../../lib/pdf/purchase-order.js';
import { renderChecksPdf } from '../../lib/pdf/check.js';
import { parseMoney, centsToInput, formatCents } from '../../lib/domain/money.js';
import { formatShortDate } from '../../lib/domain/dates.js';
import { PAYMENT_METHODS } from '../../lib/domain/checks.js';
import { VENDOR_TYPES } from '../../lib/domain/ledger.js';
import { vendorDocForm, vendorTxnPage, payBillsPage, checksPage, billPaymentEditForm } from '../../lib/views/vendor-txns.js';
import { scheduleBox } from '../../lib/views/vendor-auto.js';
import { getTemplate, vendorTemplateRows } from '../../lib/data/recurring.js';

// Account types a purchase line can be categorized to (everything but the subledger control accounts, filtered in data).
const CATEGORY_TYPES = ['expense', 'other_expense', 'cost_of_goods_sold', 'fixed_asset', 'other_asset', 'other_current_asset', 'inventory',
  'other_current_liability', 'long_term_liability', 'equity', 'income', 'other_income', 'credit_card', 'bank'];
const BATCH_MAX = 200;

// Approving or rejecting a bill needs "Can approve bills" (Settings → Users); the owner sign-in always can.
function mayApprove(who) {
  if (!who?.canApproveBills) throw new HttpError(403, 'You can’t approve or reject bills. An admin can turn on “Can approve bills” for you in Settings → Users.');
}

// Extra props for the vendor page's Transaction List tab.
export async function vendorTxnData(h, v, tab) {
  if (tab !== 'transactions') return {};
  const vfilters = parseVendorTxnFilters(h.query, h.ctx.today);
  return { vfilters, vtxns: { ...(await listVendorTxns(h.pool, { orgId: h.ctx.orgId, vendorId: v.vendor_id, filters: vfilters })), tags: await listTags(h.pool, h.scope) } };
}

const splitJob = value => {
  const m = /^([cp]):(\d{1,18})$/.exec(String(value ?? ''));
  return m ? (m[1] === 'p' ? { customerId: '', projectId: m[2] } : { customerId: m[2], projectId: '' }) : { customerId: '', projectId: '' };
};

export function vendorDocValues(form) {
  const all = k => form.getAll(k);
  const cats = all('cat_account').map((accountId, i) => ({ accountId, description: all('cat_desc')[i] ?? '', amount: all('cat_amount')[i] ?? '', ...splitJob(all('cat_job')[i]),
    po: all('cat_po')[i] ?? '', billable: all('cat_billable')[i] === '1', classId: all('cat_class')[i] ?? '' }))
    .filter(l => l.accountId || l.description.trim() || l.amount.trim()).slice(0, 200);
  const items = all('item_item').map((itemId, i) => ({ itemId, description: all('item_desc')[i] ?? '', quantity: all('item_qty')[i] ?? '', rate: all('item_rate')[i] ?? '',
    ...splitJob(all('item_job')[i]), po: all('item_po')[i] ?? '', billable: all('item_billable')[i] === '1', classId: all('item_class')[i] ?? '' })).filter(l => l.itemId || l.description.trim() || l.quantity.trim() || l.rate.trim()).slice(0, 200);
  const get = k => String(form.get(k) ?? '');
  return { vendorId: get('vendor_id'), txnDate: get('txn_date'), dueDate: get('due_date'), termsId: get('terms_id'), docNumber: get('doc_number'), memo: get('memo'),
    accountId: get('account_id'), paymentMethod: get('payment_method'), categoryLines: cats, itemLines: items, fromPo: get('from_po_label'),
    ...dimsFromForm(form), allowDuplicate: get('allow_duplicate') === '1', exchangeRate: get('exchange_rate'), uploadId: get('upload_id') };
}

export function valuesFromVendorTxn(t, { copy = false, today } = {}) {
  return {
    vendorId: t.vendor_id ? String(t.vendor_id) : '', txnDate: copy ? today : t.txn_date, dueDate: copy ? '' : (t.due_date ?? ''), termsId: '',
    docNumber: copy ? '' : (t.doc_number ?? ''), memo: t.memo ?? '', accountId: t.account_id ? String(t.account_id) : '', paymentMethod: t.payment_method ?? '',
    exchangeRate: !copy && t.currency ? String(Number(t.exchange_rate)) : '',
    categoryLines: t.lines.filter(l => !l.item_id).map(l => ({ accountId: l.account_id ? String(l.account_id) : '', description: l.description ?? '',
      amount: centsToInput(t.currency && l.foreign_amount_cents !== null ? l.foreign_amount_cents : l.amount_cents), customerId: l.customer_id ? String(l.customer_id) : '', projectId: l.project_id ? String(l.project_id) : '',
      po: !copy && l.po_txn_id ? `${l.po_txn_id}:${l.po_line_no}` : '', billable: Boolean(l.billable), classId: l.class_id ? String(l.class_id) : '' })),
    itemLines: t.lines.filter(l => l.item_id).map(l => ({ itemId: String(l.item_id), description: l.description ?? '', quantity: String(Number(l.quantity)),
      rate: centsToInput(t.currency && l.foreign_rate_cents !== null ? l.foreign_rate_cents : l.rate_cents), customerId: l.customer_id ? String(l.customer_id) : '', projectId: l.project_id ? String(l.project_id) : '',
      po: !copy && l.po_txn_id ? `${l.po_txn_id}:${l.po_line_no}` : '', billable: Boolean(l.billable), classId: l.class_id ? String(l.class_id) : '' })),
    classId: t.class_id ? String(t.class_id) : '', locationId: t.location_id ? String(t.location_id) : '', tagIds: (t.tag_ids ?? []).map(String),
  };
}

// What's still to come on a purchase order, as editor lines that point back at it.
export function valuesFromPurchaseOrder(po, today) {
  const remainingQty = l => Math.max(0, Number(l.quantity) - Number(l.received_qty));
  return {
    vendorId: String(po.vendor_id), txnDate: today, dueDate: '', termsId: '', docNumber: '', memo: po.memo ?? '', accountId: '', paymentMethod: '',
    fromPo: po.doc_number ?? '',
    categoryLines: po.lines.filter(l => !l.item_id && l.amount_cents - l.received_cents > 0).map(l => ({ accountId: String(l.account_id), description: l.description ?? '',
      amount: centsToInput(l.amount_cents - l.received_cents), customerId: l.customer_id ? String(l.customer_id) : '', projectId: l.project_id ? String(l.project_id) : '',
      po: `${po.txn_id}:${l.line_no}` })),
    itemLines: po.lines.filter(l => l.item_id && remainingQty(l) > 0).map(l => ({ itemId: String(l.item_id), description: l.description ?? '',
      quantity: String(remainingQty(l)), rate: centsToInput(l.rate_cents), customerId: l.customer_id ? String(l.customer_id) : '',
      projectId: l.project_id ? String(l.project_id) : '', po: `${po.txn_id}:${l.line_no}` })),
  };
}

// Returns true when the request was handled.
export async function vendorTxnRoutes(h) {
  const { req, path, query, form, ctx, scope, pool, page, base, go, takeFlash, actor, send, res, extra } = h;
  let m;
  const orgId = ctx.orgId;

  // Old links to /txns/:id for vendor-side transactions land on the vendor view.
  m = /^\/txns\/(\d{1,18})$/.exec(path);
  if (m && req.method === 'GET') {
    const { rows: [t] } = await pool.query('SELECT type FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3', [orgId, ctx.entityId, Number(m[1])]);
    if (t && VENDOR_TYPES.includes(t.type)) { go(`/vtxns/${m[1]}`); return true; }
    return false;
  }

  const lists = async type => {
    const [vendors, categoriesAll, payFrom, items, terms, jobs] = await Promise.all([
      vendorChoices(pool, scope),
      accountsOfTypes(pool, { ...scope, types: CATEGORY_TYPES }),
      accountsOfTypes(pool, { ...scope, types: type === 'check' ? ['bank'] : ['bank', 'credit_card'] }),
      pool.query('SELECT item_id, name, purchase_cost_cents FROM item WHERE org_id = $1 AND entity_id = $2 AND active AND kind <> $3 ORDER BY lower(name)',
        [orgId, ctx.entityId, 'system']).then(r => r.rows),
      listTerms(pool, scope),
      pool.query(
        `SELECT 'c:' || c.customer_id AS value, c.display_name AS label, lower(c.display_name) AS k FROM customer c WHERE c.org_id = $1 AND c.entity_id = $2 AND c.active
         UNION ALL
         SELECT 'p:' || p.project_id, c.display_name || ' › ' || p.name, lower(c.display_name) || ' ' || lower(p.name) FROM project p
           JOIN customer c ON c.customer_id = p.customer_id WHERE p.org_id = $1 AND c.entity_id = $2 AND p.status = 'in_progress'
         ORDER BY 3`, [orgId, ctx.entityId]).then(r => r.rows),
    ]);
    const categories = categoriesAll.filter(a => !['ar', 'ap', 'undeposited'].includes(a.system_key));
    return { vendors, categories, payFrom, items, terms, jobs };
  };
  const renderDoc = async ({ type, txnId = null, v, error = null, status = 200, duplicate = false, override = false }) => {
    const l = await lists(type);
    if ((type === 'expense' || type === 'check') && !v.accountId && l.payFrom[0]) v = { ...v, accountId: String(l.payFrom[0].account_id) };
    const nextCheck = type === 'check' && v.accountId ? await nextCheckNumber(pool, { ...scope, accountId: Number(v.accountId) }) : '';
    // A vendor in another currency: bills and vendor credits are typed in it.
    const mc = await multicurrencyOn(pool, scope);
    const code = mc && (type === 'bill' || type === 'vendor_credit') && idParam(v.vendorId)
      ? (await pool.query('SELECT currency FROM vendor WHERE vendor_id = $1', [idParam(v.vendorId)])).rows[0]?.currency : null;
    const fx = code ? { code, rate: await rateOn(pool, { ...scope, code, date: v.txnDate || ctx.today }) } : null;
    page(vendorDocForm({ ...base(), type, txnId, save: await h.saveOpts(type), ...l, v, error, nextCheck, dims: await dimensionChoices(pool, scope), duplicate, override, fx,
      reloadOnVendor: mc && (type === 'bill' || type === 'vendor_credit') }), status);
  };
  const loadVt = async id => (await getVendorTxn(pool, { ...scope, txnId: id })) ?? (() => { throw new HttpError(404, 'Transaction not found'); })();
  const saveDoc = async (type, txnId = null) => {
    const v = vendorDocValues(form);
    try {
      return await saveVendorDoc(pool, { ...scope, actor, type, txnId, vendorId: idParam(v.vendorId), txnDate: v.txnDate, dueDate: v.dueDate || null,
        termsId: idParam(v.termsId), docNumber: v.docNumber, memo: v.memo, accountId: idParam(v.accountId), paymentMethod: v.paymentMethod,
        categoryLines: v.categoryLines, itemLines: v.itemLines, dims: dimsForSave(v), allowDuplicate: v.allowDuplicate,
        editReconciled: h.who.role === 'admin' && form.get('edit_reconciled') === '1', exchangeRate: v.exchangeRate });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await renderDoc({ type, txnId, v, error: error.message, status: 422, duplicate: error instanceof DuplicateWarning, override: Boolean(error.reconciled && h.who.role === 'admin') });
      return null;
    }
  };

  // Where a saved vendor form goes (stage F1): close → back where it was opened from (else the transaction); new → a blank form of
  // the same type; save → stays open on it; submit → the bill waits for approval; schedule → the bill's schedule-payment
  // section; print → Print checks; send → the purchase order is emailed, then close.
  const NOUN = { bill: 'Bill', expense: 'Expense', check: 'Check', vendor_credit: 'Vendor credit', purchase_order: 'Purchase order', item_receipt: 'Item receipt' };
  async function afterVendorSave(id, type, choice) {
    const t = await loadVt(id);
    // Close goes back to the page the form was opened from; with none known, to the saved transaction (as before).
    const closeTo = safeBack(form.get('back')) ?? `/vtxns/${id}`;
    const saved = `${NOUN[type]}${t.doc_number ? ` ${t.doc_number}` : ''} saved.`;
    if (choice === 'new') return go(`/vtxns/new?type=${type}`, 'ok', saved);
    if (choice === 'save') return go(`/vtxns/${id}/edit`, 'ok', saved);
    if (choice === 'schedule') return go(`/vtxns/${id}#schedule`, 'ok', `${saved} Choose when to pay it.`);
    if (choice === 'print') return go('/checks', 'ok', `${saved} Print it below.`);
    if (choice === 'submit') {
      await submitBillForApproval(pool, { ...scope, txnId: id, actor });
      return go(closeTo, 'ok', `${saved} It’s waiting for approval.`);
    }
    if (choice === 'send') {
      const status = await emailPurchaseOrder(t);
      if (status === null) return go(`/vtxns/${id}`, 'error', `${saved} ${t.vendor_name} has no email address, so it wasn’t sent.`);
      if (status === undefined) return;
      return go(closeTo, status === 'failed' ? 'error' : 'ok', `${saved} ${{ sent: 'Emailed to the vendor.', logged: 'Recorded as sent (email isn’t set up yet).', failed: 'It couldn’t be emailed.' }[status]}`);
    }
    return go(closeTo, 'ok', saved);
  }
  // Email a purchase order: 'sent' / 'logged' / 'failed'; null with no vendor email; undefined if the mailer isn't ready (already answered).
  async function emailPurchaseOrder(t) {
    if (!t.vendor_email) return null;
    const ready = await h.attempt(`/vtxns/${t.txn_id}`, h.companyMailer);
    if (!ready.ok) return undefined;
    const [entity, settings] = await Promise.all([getEntity(pool, scope), getSalesSettings(pool, scope)]);
    const pdf = await renderPurchaseOrderPdf({ entity, po: t });
    const { subject, text } = renderEmail(settings, 'purchase_order', { customer: t.vendor_name, vendor: t.vendor_name, company: entity.name, number: t.doc_number,
      amount: formatCents(t.total_cents), balance: formatCents(t.total_cents), due_date: t.due_date ? formatShortDate(t.due_date) : '' }, entity.style.footer);
    return deliver(pool, ready.value, { orgId, vendorId: t.vendor_id, to: t.vendor_email, relatedTxnId: t.txn_id, actor, subject, text,
      attachments: [{ filename: `${t.doc_number}.pdf`, content: pdf, contentType: 'application/pdf' }],
      activityKind: 'po_sent', activitySummary: `Purchase order ${t.doc_number}` });
  }

  // ---- new / create ----
  if (path === '/vtxns/new' && req.method === 'GET') {
    if (query.template) {
      const t = await getTemplate(pool, { ...scope, templateId: idParam(query.template) ?? 0 });
      if (!t || !t.vendor_id) throw new HttpError(404, 'Template not found');
      await renderDoc({ type: t.txn_type, v: { vendorId: String(t.vendor_id), txnDate: ctx.today, dueDate: '', termsId: t.terms_id ? String(t.terms_id) : '', docNumber: '',
        memo: t.memo ?? '', accountId: t.account_id ? String(t.account_id) : '', paymentMethod: '', ...vendorTemplateRows(t) } });
      return true;
    }
    if (query.from_po) {
      const po = await loadVt(idParam(query.from_po) ?? 0);
      if (po.type !== 'purchase_order' || po.voided_at || po.closed_at) throw new HttpError(400, 'Only an open purchase order can be received.');
      const type = query.type === 'item_receipt' ? 'item_receipt' : 'bill';
      await renderDoc({ type, v: valuesFromPurchaseOrder(po, ctx.today) });
      return true;
    }
    if (query.copy) {
      const src = await loadVt(idParam(query.copy) ?? 0);
      if (!DOC_TYPES.includes(src.type)) throw new HttpError(400, 'Only bills, expenses, checks and vendor credits can be copied.');
      // Copy to vendor credit (stage F2): a bill's lines become a credit from the same vendor.
      const as = query.as === 'vendor_credit' && src.type === 'bill' ? 'vendor_credit' : src.type;
      await renderDoc({ type: as, v: { ...valuesFromVendorTxn(src, { copy: true, today: ctx.today }), ...(as !== src.type ? { termsId: '', dueDate: '' } : {}) } });
      return true;
    }
    const type = DOC_TYPES.includes(query.type) ? query.type : 'bill';
    const vendorId = idParam(query.vendor);
    let categoryLines = [];
    if (vendorId) {
      const { rows: [v] } = await pool.query('SELECT default_expense_account_id FROM vendor WHERE org_id = $1 AND entity_id = $2 AND vendor_id = $3', [orgId, ctx.entityId, vendorId]);
      if (!v) throw new HttpError(404, 'Vendor not found');
      if (v.default_expense_account_id) categoryLines = [{ accountId: String(v.default_expense_account_id), description: '', amount: '', customerId: '', projectId: '' }];
    }
    await renderDoc({ type, v: { vendorId: vendorId ? String(vendorId) : '', txnDate: ctx.today, dueDate: '', termsId: '', docNumber: '', memo: '', accountId: '',
      paymentMethod: '', categoryLines, itemLines: [] } });
    return true;
  }
  if (path === '/vtxns' && req.method === 'POST') {
    const type = DOC_TYPES.includes(form.get('type')) ? form.get('type') : null;
    if (!type) throw new HttpError(400, 'Unknown transaction type');
    const id = await saveDoc(type);
    // Stage F6: a file uploaded on the form is attached to what was saved.
    if (id && idParam(form.get('upload_id'))) await attachUpload(pool, { ...scope, uploadId: idParam(form.get('upload_id')), txnId: id, actor });
    if (id) await afterVendorSave(id, type, await h.saveChoice(type));
    return true;
  }
  // Stage F6: upload a bill or receipt on a new bill / expense / check — read it, and show the form filled in from it.
  if (path === '/vtxns/read' && req.method === 'POST') {
    const type = UPLOAD_TYPES.includes(form.get('type')) ? form.get('type') : 'bill';
    let r;
    try {
      r = await readUpload(pool, { ...scope, type, file: h.files.find(f => f.field === 'file'), actor, key: settingsKey(h.env), aiFetch: h.aiFetch });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await renderDoc({ type, v: { vendorId: '', txnDate: ctx.today, dueDate: '', termsId: '', docNumber: '', memo: '', accountId: '', paymentMethod: '', categoryLines: [], itemLines: [] },
        error: error.message, status: 422 });
      return true;
    }
    const v = { vendorId: '', txnDate: ctx.today, dueDate: '', termsId: '', docNumber: '', memo: '', accountId: '', paymentMethod: '', categoryLines: [], itemLines: [],
      ...r.v, uploadId: String(r.uploadId), uploadName: r.filename,
      uploadNote: r.error ? `${r.filename} couldn’t be read (${r.error.replace(/\.$/, '')}). Fill in the form; the file will be attached when you save.`
        : `Filled in from ${r.filename}${r.reading.confidence === 'high' ? '' : ` (${r.reading.confidence} confidence)`}${r.v.vendorId ? '' : r.reading.vendor ? ` — “${r.reading.vendor}” isn’t one of your vendors yet` : ''}. Check everything before saving; the file will be attached.` };
    await renderDoc({ type, v });
    return true;
  }
  const up = /^\/vtxns\/uploads\/(\d{1,18})$/.exec(path);
  if (up && req.method === 'GET') {
    const u = await getUpload(pool, { ...scope, uploadId: Number(up[1]) });
    if (!u) throw new HttpError(404, 'File not found');
    h.send(h.res, 200, u.content, { ...h.extra, 'Content-Type': u.content_type, 'Content-Disposition': `inline; filename="${u.filename.replace(/"/g, '')}"`, 'X-Content-Type-Options': 'nosniff' });
    return true;
  }

  // ---- batch from the vendor's Transaction List ----
  if (path === '/vtxns/batch' && req.method === 'POST') {
    const ids = [...new Set(form.getAll('ids').map(idParam).filter(Boolean))].slice(0, BATCH_MAX);
    const back = /^\/vendors\/\d{1,18}\?[\w=&%-]*$/.test(form.get('back') ?? '') ? form.get('back') : '/vendors';
    if (!ids.length) { go(back, 'error', 'Select at least one transaction.'); return true; }
    const action = form.get('action');
    if (action === 'pay') { go(`/pay-bills?bills=${ids.join(',')}`); return true; }
    if (action === 'approve') {
      mayApprove(h.who);
      const n = await approveBills(pool, { ...scope, txnIds: ids, actor });
      go(back, 'ok', `${n} bill${n === 1 ? '' : 's'} approved.`);
      return true;
    }
    if (action === 'delete') {
      let done = 0;
      const problems = [];
      for (const id of ids) {
        try { await deleteVendorTxn(pool, { ...scope, txnId: id, actor }); done += 1; } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          problems.push(error.message);
        }
      }
      go(back, problems.length ? 'error' : 'ok', `${done} deleted.${problems.length ? ` ${problems.join(' ')}` : ''}`);
      return true;
    }
    throw new HttpError(400, 'Unknown batch action');
  }

  // ---- pay bills ----
  if (path === '/pay-bills') {
    const show = async (v, error = null, status = 200) => {
      const filterVendor = idParam(query.vendor ?? form?.get('vendor'));
      const [bills, vendors, payFrom] = await Promise.all([listOpenBills(pool, { ...scope, vendorId: filterVendor }), vendorChoices(pool, scope),
        accountsOfTypes(pool, { ...scope, types: ['bank', 'credit_card'] })]);
      if (!v.accountId && payFrom[0]) v = { ...v, accountId: String(payFrom[0].account_id) };
      const nextCheck = v.accountId ? await nextCheckNumber(pool, { ...scope, accountId: Number(v.accountId) }) : '';
      const codes = [...new Set(bills.map(b => b.currency).filter(Boolean))];
      const rates = Object.fromEntries(await Promise.all(codes.map(async c => [c, await rateOn(pool, { ...scope, code: c, date: v.txnDate || ctx.today })])));
      page(payBillsPage({ ...base(), bills, vendors, payFrom, v, filterVendor: filterVendor ?? '', error, nextCheck, rates }), status);
    };
    if (req.method === 'GET') {
      const pre = String(query.bills ?? '').split(',').map(idParam).filter(Boolean);
      const bills = await listOpenBills(pool, { ...scope, vendorId: idParam(query.vendor) });
      const selected = pre.length ? pre : query.vendor ? bills.map(b => b.txn_id) : [];
      const pay = Object.fromEntries(bills.filter(b => selected.includes(b.txn_id)).map(b => [b.txn_id, centsToInput(b.open_cents)]));
      await show({ accountId: '', txnDate: ctx.today, method: 'Check', checkNo: '', memo: '', selected, pay, credit: {} });
      return true;
    }
    const v = { accountId: String(form.get('account_id') ?? ''), txnDate: String(form.get('txn_date') ?? ''), method: String(form.get('method') ?? ''),
      checkNo: String(form.get('check_no') ?? ''), memo: String(form.get('memo') ?? ''), selected: [...new Set(form.getAll('bill').map(idParam).filter(Boolean))].slice(0, 500), pay: {}, credit: {},
      rates: {} };
    for (const [k, val] of form) {
      if (/^rate_[A-Z]{3}$/.test(k)) v.rates[k.slice(5)] = val.trim();
      if (/^pay_\d{1,18}$/.test(k)) v.pay[k.slice(4)] = val.trim();
      if (/^credit_\d{1,18}$/.test(k)) v.credit[k.slice(7)] = val.trim();
    }
    try {
      if (!PAYMENT_METHODS.includes(v.method)) throw new ValidationError('Choose how the bills were paid.');
      const open = new Map((await listOpenBills(pool, scope)).map(b => [b.txn_id, b]));
      const payments = v.selected.map(id => {
        const b = open.get(id) ?? (() => { throw new ValidationError('One of the selected bills is no longer open. Reload and try again.'); })();
        const credit = v.credit[id] ? parseMoney(v.credit[id]) : 0;
        if (credit === null) throw new ValidationError(`“${v.credit[id]}” isn’t an amount.`);
        const amount = v.pay[id] ? parseMoney(v.pay[id]) : b.open_cents - credit;
        if (amount === null) throw new ValidationError(`“${v.pay[id]}” isn’t an amount.`);
        return { billId: id, amountCents: amount, creditCents: credit };
      });
      const created = await payBills(pool, { ...scope, actor, accountId: idParam(v.accountId), txnDate: v.txnDate, method: v.method, checkNo: v.checkNo,
        memo: v.memo, payments, rates: v.rates });
      const msg = `${created.length} bill payment${created.length === 1 ? '' : 's'} saved.`;
      if (form.get('then') === 'print' && v.method === 'Check') go('/checks', 'ok', `${msg} Print the checks below.`);
      else go(created.length === 1 ? `/vtxns/${created[0]}` : '/vendors', 'ok', msg);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await show(v, error.message, 422);
    }
    return true;
  }

  // ---- checks ----
  if (path === '/checks' && req.method === 'GET') {
    page(checksPage({ ...base(), flash: takeFlash(), checks: await listChecksToPrint(pool, scope) }));
    return true;
  }
  if ((path === '/checks/print' || path === '/checks/printed') && req.method === 'POST') {
    const ids = [...new Set(form.getAll('ids').map(idParam).filter(Boolean))].slice(0, BATCH_MAX);
    if (!ids.length) { go('/checks', 'error', 'Select at least one check.'); return true; }
    if (path === '/checks/printed') {
      const n = await markChecksPrinted(pool, { ...scope, txnIds: ids, actor });
      go('/checks', 'ok', `${n} check${n === 1 ? '' : 's'} marked as printed.`);
      return true;
    }
    await sendChecks(ids);
    return true;
  }

  // ---- one vendor transaction ----
  m = /^\/vtxns\/(\d{1,18})(\/edit|\/void|\/delete|\/approve|\/reject|\/mark-paid|\/printed|\/check\.pdf|\/po\.pdf|\/email|\/close|\/reopen|\/convert)?$/.exec(path);
  if (!m) return false;
  const t = await loadVt(Number(m[1]));
  const action = m[2] ?? '';
  // Imported QuickBooks history: viewed, printed, scheduled and paid, never changed.
  if (t.source === 'qbo_import' && (['/edit', '/void', '/delete', '/approve', '/reject', '/convert', '/close', '/reopen'].includes(action) || (action === '' && req.method === 'POST'))) {
    go(`/vtxns/${t.txn_id}`, 'error', IMPORTED_LOCKED);
    return true;
  }
  if (req.method === 'GET' && action === '') {
    const [payFrom, documents] = await Promise.all([accountsOfTypes(pool, { ...scope, types: ['bank', 'credit_card'] }),
      listTxnDocuments(pool, { orgId, txnId: t.txn_id })]);
    page(vendorTxnPage({ ...base(), flash: takeFlash(), txn: t, today: ctx.today, payFrom, documents,
      schedule: scheduleBox({ txn: t, csrf: base().csrf, payFrom, today: ctx.today }) }));
    return true;
  }
  if (req.method === 'GET' && action === '/edit') {
    if (t.voided_at) throw new HttpError(400, 'A voided transaction can’t be edited.');
    if (t.type === 'bill_payment') {
      page(billPaymentEditForm({ ...base(), txn: t, v: { txnDate: t.txn_date, docNumber: t.doc_number ?? '', memo: t.memo ?? '' } }));
      return true;
    }
    if (!DOC_TYPES.includes(t.type) || t.system_kind) throw new HttpError(400, 'This transaction can’t be edited here.');
    if (t.type === 'purchase_order' && (t.closed_at || t.lines.some(l => Number(l.received_qty) > 0 || l.received_cents > 0))) {
      go(`/vtxns/${t.txn_id}`, 'error', 'Part of this purchase order has been received, so it can’t be changed.');
      return true;
    }
    await renderDoc({ type: t.type, txnId: t.txn_id, v: valuesFromVendorTxn(t) });
    return true;
  }
  if (req.method === 'GET' && action === '/check.pdf') {
    await sendChecks([t.txn_id]);
    return true;
  }
  if (req.method === 'GET' && action === '/po.pdf') {
    if (t.type !== 'purchase_order') throw new HttpError(404, 'Not a purchase order');
    const pdf = await renderPurchaseOrderPdf({ entity: await getEntity(pool, scope), po: t });
    send(res, 200, pdf, { ...extra, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${t.doc_number ?? 'purchase-order'}.pdf"` });
    return true;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const view = `/vtxns/${t.txn_id}`;
  const attempt = h.attempt;
  switch (action) {
    case '': {
      if (t.type === 'bill_payment') {
        const v = { txnDate: String(form.get('txn_date') ?? ''), docNumber: String(form.get('doc_number') ?? ''), memo: String(form.get('memo') ?? '') };
        try {
          await updateBillPayment(pool, { ...scope, txnId: t.txn_id, ...v, actor, override: h.who.role === 'admin' && form.get('edit_reconciled') === '1' });
          go(view, 'ok', 'Bill payment saved.');
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          page(billPaymentEditForm({ ...base(), txn: t, v, error: error.message }), 422);
        }
        return true;
      }
      if (!DOC_TYPES.includes(t.type)) throw new HttpError(400, 'This transaction can’t be edited here.');
      if (await saveDoc(t.type, t.txn_id)) await afterVendorSave(t.txn_id, t.type, await h.saveChoice(t.type));
      return true;
    }
    case '/void':
      if ((await attempt(view, () => voidVendorTxn(pool, { ...scope, txnId: t.txn_id, actor, override: h.who.role === 'admin' && form.get('edit_reconciled') === '1' }))).ok) go(view, 'ok', 'Voided.');
      return true;
    case '/delete': {
      const r = await attempt(view, () => deleteVendorTxn(pool, { ...scope, txnId: t.txn_id, actor, override: h.who.role === 'admin' && form.get('edit_reconciled') === '1' }));
      if (r.ok) go(t.vendor_id ? `/vendors/${t.vendor_id}` : '/vendors', 'ok', 'Deleted.');
      return true;
    }
    case '/approve':
      mayApprove(h.who);
      await approveBills(pool, { ...scope, txnIds: [t.txn_id], actor });
      go(form.get('back') && /^\/vendors\/\d{1,18}/.test(form.get('back')) ? form.get('back') : view, 'ok', 'Bill approved.');
      return true;
    case '/reject':
      mayApprove(h.who);
      if ((await attempt(view, () => rejectBill(pool, { ...scope, txnId: t.txn_id, reason: form.get('reason'), actor }))).ok) go(view, 'ok', 'Bill rejected.');
      return true;
    case '/mark-paid': {
      const r = await attempt(view, () => markBillPaid(pool, { ...scope, txnId: t.txn_id, accountId: idParam(form.get('account_id')), txnDate: ctx.today, actor }));
      if (r.ok) go(view, 'ok', 'Bill marked as paid.');
      return true;
    }
    case '/close':
      if ((await attempt(view, () => closePurchaseOrder(pool, { ...scope, txnId: t.txn_id, actor }))).ok) go(view, 'ok', 'Purchase order closed.');
      return true;
    case '/reopen':
      if ((await attempt(view, () => reopenPurchaseOrder(pool, { ...scope, txnId: t.txn_id, actor }))).ok) go(view, 'ok', 'Purchase order reopened.');
      return true;
    case '/convert': {
      const r = await attempt(view, () => convertReceiptToBill(pool, { ...scope, txnId: t.txn_id, billDate: String(form.get('txn_date') ?? ''),
        docNumber: form.get('doc_number'), actor }));
      if (r.ok) go(view, 'ok', 'The item receipt is now a bill.');
      return true;
    }
    case '/email': {
      if (t.type !== 'purchase_order') throw new HttpError(400, 'Only purchase orders are emailed from here.');
      const status = await emailPurchaseOrder(t);
      if (status === null) { go(view, 'error', `${t.vendor_name} has no email address.`); return true; }
      if (status === undefined) return true;
      go(view, status === 'failed' ? 'error' : 'ok', { sent: 'Purchase order emailed.', logged: 'Purchase order recorded as sent. Email isn’t set up yet (Settings → Email).',
        failed: 'The purchase order could not be sent.' }[status]);
      return true;
    }
    case '/printed':
      await markChecksPrinted(pool, { ...scope, txnIds: [t.txn_id], actor });
      go(view, 'ok', 'Marked as printed.');
      return true;
    default:
      throw new HttpError(405, 'Method not allowed');
  }

  async function sendChecks(ids) {
    const checks = [];
    for (const id of ids) {
      const c = await loadVt(id);
      if (!(c.type === 'check' || (c.type === 'bill_payment' && c.payment_method === 'Check'))) throw new HttpError(400, 'Only checks can be printed.');
      checks.push(c);
    }
    const pdf = await renderChecksPdf({ entity: await getEntity(pool, scope), checks });
    send(res, 200, pdf, { ...extra, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="checks-${ctx.today}.pdf"` });
  }
}

