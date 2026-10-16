import { randomBytes } from 'node:crypto';
import { HttpError, idParam, tooMany, clientIp } from './http.js';
import { ValidationError, listTerms } from '../../lib/data/writes.js';
import { accountsOfTypes } from '../../lib/data/ledger.js';
import { getVendor, track1099 } from '../../lib/data/vendors.js';
import { canAccess } from '../../lib/domain/roles.js';
import { listTemplates, getTemplate, saveTemplate, setTemplateActive, deleteTemplate, vendorTemplateRows } from '../../lib/data/recurring.js';
import { scheduleBillPayment, cancelScheduledPayment } from '../../lib/data/payables.js';
import { createInfoRequest, findOpenRequest, submitInfoRequest, reviewRequest, resolveRequest } from '../../lib/data/vendor-info.js';
import { list1099 } from '../../lib/data/ten99.js';
import { deliver, getEntity } from '../../lib/data/messages.js';
import { settingsKey } from '../../lib/secrets.js';
import { formatAddress } from '../../lib/domain/vendors.js';
import { vendorDocValues, valuesFromVendorTxn } from './vendor-txn-routes.js';
import { getVendorTxn } from '../../lib/data/payables-read.js';
import { TYPE_LABELS } from '../../lib/domain/status.js';
import { vendorTemplateForm, askSentPage, infoReviewPage, publicInfoForm, publicMessage, ten99Page } from '../../lib/views/vendor-auto.js';

const CATEGORY_TYPES = ['expense', 'other_expense', 'cost_of_goods_sold', 'fixed_asset', 'other_asset', 'other_current_asset', 'inventory',
  'other_current_liability', 'long_term_liability', 'equity', 'income', 'other_income', 'credit_card', 'bank'];

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

// Template form values <-> request.
function templateValues(form) {
  const doc = vendorDocValues(form);
  const get = k => String(form.get(k) ?? '');
  return { ...doc, name: get('name'), txnType: get('txnType'), mode: get('mode'), unit: get('unit'), count: get('count'), startDate: get('startDate'),
    endDate: get('endDate'), termsId: get('termsId'), accountId: get('accountId'), memo: get('memo') };
}
const templateToValues = t => ({ name: t.name, txnType: t.txn_type, mode: t.mode, unit: t.interval_unit ?? 'month', count: t.interval_count ? String(t.interval_count) : '1',
  startDate: t.start_date ?? '', endDate: t.end_date ?? '', termsId: t.terms_id ? String(t.terms_id) : '', accountId: t.account_id ? String(t.account_id) : '',
  memo: t.memo ?? '', ...vendorTemplateRows(t) });

// Returns true when handled.
export async function vendorAutoRoutes(h) {
  const { req, path, query, form, ctx, scope, pool, env, page, base, go, takeFlash, actor, send, res, extra } = h;
  const key = () => settingsKey(env);
  let m;

  // ---- 1099s ----
  // Track the ticked vendors (from the "paid over the threshold but not tracked" list).
  if (path === '/vendors/1099/track' && req.method === 'POST') {
    try {
      const n = await track1099(pool, { ...scope, vendorIds: form.getAll('vendor'), actor });
      go(`/vendors/1099?year=${encodeURIComponent(form.get('year') ?? '')}`, 'ok', `${n} vendor${n === 1 ? '' : 's'} now tracked for 1099.`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      go(`/vendors/1099?year=${encodeURIComponent(form.get('year') ?? '')}`, 'error', error.message);
    }
    return true;
  }
  if ((path === '/vendors/1099' || path === '/vendors/1099.csv') && req.method === 'GET') {
    const thisYear = Number(ctx.today.slice(0, 4));
    const year = Number(query.year) >= 2000 && Number(query.year) <= thisYear ? Number(query.year) : thisYear - (Number(ctx.today.slice(5, 7)) < 4 ? 1 : 0);
    const data = await list1099(pool, { ...scope, year });
    if (path.endsWith('.csv')) {
      const lines = [['Vendor', 'Company', 'Address', 'Tax ID (last 4)', 'Box 1 nonemployee compensation', 'Needs 1099'].join(',')];
      for (const r of data.tracked) {
        lines.push([r.display_name, r.company_name, formatAddress(r.billing_address), r.tax_id_last4, (r.paid_cents / 100).toFixed(2), r.over ? 'Yes' : 'No'].map(csvCell).join(','));
      }
      send(res, 200, `${lines.join('\r\n')}\r\n`, { ...extra, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="1099-${year}.csv"` });
      return true;
    }
    page(ten99Page({ ...base(), flash: takeFlash(), data, years: Array.from({ length: 5 }, (_, i) => thisYear - i), canTrack: canAccess(h.who.role, 'POST', '/vendors/1099/track') }));
    return true;
  }

  // ---- scheduled payments ----
  m = /^\/vtxns\/(\d{1,18})\/(schedule|unschedule)$/.exec(path);
  if (m && req.method === 'POST') {
    const id = Number(m[1]), view = `/vtxns/${id}`;
    const r = await h.attempt(view, () => (m[2] === 'schedule'
      ? scheduleBillPayment(pool, { ...scope, txnId: id, payDate: String(form.get('pay_date') ?? ''), accountId: idParam(form.get('account_id')),
        method: String(form.get('method') ?? ''), today: ctx.today, actor })
      : cancelScheduledPayment(pool, { ...scope, txnId: id, actor })));
    if (r.ok) go(view, 'ok', m[2] === 'schedule' ? 'Payment scheduled.' : 'Scheduled payment canceled.');
    return true;
  }

  // ---- recurring vendor templates ----
  const lists = async () => {
    const [categoriesAll, items, jobs, payFrom, terms] = await Promise.all([
      accountsOfTypes(pool, { ...scope, types: CATEGORY_TYPES }),
      pool.query('SELECT item_id, name, purchase_cost_cents FROM item WHERE org_id = $1 AND entity_id = $2 AND active AND kind <> $3 ORDER BY lower(name)',
        [ctx.orgId, ctx.entityId, 'system']).then(r => r.rows),
      pool.query(
        `SELECT 'c:' || c.customer_id AS value, c.display_name AS label, lower(c.display_name) AS k FROM customer c WHERE c.org_id = $1 AND c.entity_id = $2 AND c.active
         UNION ALL SELECT 'p:' || p.project_id, c.display_name || ' › ' || p.name, lower(c.display_name) || ' ' || lower(p.name) FROM project p
           JOIN customer c ON c.customer_id = p.customer_id WHERE p.org_id = $1 AND c.entity_id = $2 AND p.status = 'in_progress' ORDER BY 3`,
        [ctx.orgId, ctx.entityId]).then(r => r.rows),
      accountsOfTypes(pool, { ...scope, types: ['bank', 'credit_card'] }),
      listTerms(pool, scope),
    ]);
    return { categories: categoriesAll.filter(a => !['ar', 'ap', 'undeposited'].includes(a.system_key)), items, jobs, payFrom, terms };
  };
  const saveFromForm = async (vendor, templateId) => {
    const v = templateValues(form);
    try {
      const id = await saveTemplate(pool, { ...scope, vendorId: vendor.vendor_id, templateId, today: ctx.today, actor,
        fields: { ...v, isNew: !templateId } });
      go(`/vendors/${vendor.vendor_id}?tab=recurring`, 'ok', `Recurring transaction “${v.name.trim()}” saved.`);
      return id;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      page(vendorTemplateForm({ ...base(), vendor, templateId, ...(await lists()), v, error: error.message }), 422);
      return null;
    }
  };
  m = /^\/vendors\/(\d{1,18})\/recurring(\/new)?$/.exec(path);
  if (m) {
    const vendor = await getVendor(pool, { ...scope, vendorId: Number(m[1]), today: ctx.today }) ?? (() => { throw new HttpError(404, 'Vendor not found'); })();
    if (req.method === 'GET' && m[2]) {
      let v = { name: '', txnType: 'bill', mode: 'scheduled', unit: 'month', count: '1', startDate: ctx.today,
        endDate: '', termsId: '', accountId: '', memo: '', categoryLines: vendor.default_expense_account_id
          ? [{ accountId: String(vendor.default_expense_account_id), description: '', amount: '', customerId: '', projectId: '' }] : [], itemLines: [] };
      // Make recurring from a bill, expense or check (stage F2): the template starts from it.
      const from = Number(query.from) || 0;
      if (from) {
        const { rows: [src] } = await pool.query('SELECT txn_id FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3 AND vendor_id = $4 AND type = ANY($5)',
          [scope.orgId, scope.entityId, from, vendor.vendor_id, ['bill', 'expense', 'check']]);
        if (!src) throw new HttpError(404, 'Transaction not found');
        const t = await getVendorTxn(pool, { ...scope, txnId: from });
        const c = valuesFromVendorTxn(t, { copy: true, today: ctx.today });
        v = { ...v, name: `${TYPE_LABELS[t.type]}${t.doc_number ? ` ${t.doc_number}` : ''} (${vendor.display_name})`, txnType: t.type, termsId: c.termsId ?? '', accountId: c.accountId ?? '',
          memo: c.memo ?? '', categoryLines: c.categoryLines, itemLines: c.itemLines };
      }
      page(vendorTemplateForm({ ...base(), vendor, ...(await lists()), v }));
      return true;
    }
    if (req.method === 'POST' && !m[2]) { await saveFromForm(vendor, null); return true; }
    throw new HttpError(405, 'Method not allowed');
  }
  m = /^\/vrecurring\/(\d{1,18})(\/pause|\/resume|\/delete)?$/.exec(path);
  if (m) {
    const t = await getTemplate(pool, { ...scope, templateId: Number(m[1]) });
    if (!t || !t.vendor_id) throw new HttpError(404, 'Template not found');
    const vendor = await getVendor(pool, { ...scope, vendorId: t.vendor_id, today: ctx.today });
    const back = `/vendors/${t.vendor_id}?tab=recurring`;
    if (req.method === 'GET' && !m[2]) { page(vendorTemplateForm({ ...base(), vendor, templateId: t.template_id, ...(await lists()), v: templateToValues(t) })); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (!m[2]) { await saveFromForm(vendor, t.template_id); return true; }
    if (m[2] === '/delete') { await deleteTemplate(pool, { ...scope, templateId: t.template_id, actor }); go(back, 'ok', `“${t.name}” deleted.`); return true; }
    await setTemplateActive(pool, { ...scope, templateId: t.template_id, active: m[2] === '/resume', today: ctx.today, actor });
    go(back, 'ok', `“${t.name}” ${m[2] === '/resume' ? 'resumed' : 'paused'}.`);
    return true;
  }

  // ---- ask vendor for info ----
  m = /^\/vendors\/(\d{1,18})\/(ask|info\/(\d{1,18}))$/.exec(path);
  if (m) {
    const vendor = await getVendor(pool, { ...scope, vendorId: Number(m[1]), today: ctx.today }) ?? (() => { throw new HttpError(404, 'Vendor not found'); })();
    if (m[2] === 'ask') {
      if (req.method === 'GET') { go(`/vendors/${vendor.vendor_id}`); return true; }
      if (!key()) { go(`/vendors/${vendor.vendor_id}`, 'error', 'Asking vendors for bank and tax details needs SETTINGS_KEY set on the server.'); return true; }
      const { token } = await createInfoRequest(pool, { ...scope, vendorId: vendor.vendor_id, actor });
      const origin = env.APP_BASE_URL ? env.APP_BASE_URL.replace(/\/$/, '') : `http://${req.headers.host ?? '127.0.0.1'}`;
      const link = `${origin}/vendor-info/${token}`;
      let status = null;
      if (vendor.email) {
        const ready = await h.attempt(`/vendors/${vendor.vendor_id}`, h.companyMailer);
        if (!ready.ok) return true;
        const entity = await getEntity(pool, scope);
        const body = l => `Hello ${vendor.display_name},\n\n${entity.name} pays you through their books and would like your current address, tax ID and bank details.\n\n`
          + `Fill them in here (the link works once, for 14 days):\n${l}\n\nThank you,\n${entity.name}`;
        status = await deliver(pool, ready.value, { orgId: ctx.orgId, vendorId: vendor.vendor_id, to: vendor.email, actor,
          subject: `${entity.name}: please confirm your payment details`, text: body(link), recordText: body('[one-time link, not kept]'),
          activityKind: 'info_request_sent', activitySummary: 'Request for details' });
      }
      page(askSentPage({ ...base(), vendor, link, status }));
      return true;
    }
    const requestId = Number(m[3]);
    const review = await reviewRequest(pool, { ...scope, requestId, key: key() });
    if (!review || review.request.vendor_id !== vendor.vendor_id) throw new HttpError(404, 'Request not found');
    if (req.method === 'GET') { page(infoReviewPage({ ...base(), review })); return true; }
    try {
      const dismiss = form.get('do') === 'dismiss';
      const taken = await resolveRequest(pool, { ...scope, requestId, accept: form.getAll('accept'), dismiss, key: key(), actor });
      go(`/vendors/${vendor.vendor_id}?tab=details`, 'ok', dismiss ? 'Dismissed; nothing changed.' : `Updated ${taken.length} field${taken.length === 1 ? '' : 's'} from the vendor’s details.`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      page(infoReviewPage({ ...base(), review, error: error.message }), 422);
    }
    return true;
  }
  return false;
}

// ---- the public page a vendor opens from the emailed link (no sign-in) ----

// At most 20 posts per 10 minutes per client address and 10 per link (see tooMany in http.js).
const NONCE_COOKIE = 'fb_vinfo';

export async function publicVendorInfo({ req, res, path, pool, env, send, readForm }) {
  const secure = /^https:/.test(env.APP_BASE_URL ?? '');
  const m = /^\/vendor-info\/([A-Za-z0-9_-]{1,100})$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const token = m[1];
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  const request = await findOpenRequest(pool, { token });
  if (!request) {
    send(res, 404, String(publicMessage({ title: 'This link isn’t active', message: 'It has already been used, was replaced by a newer one, or has expired. Ask the business to send a new link.' })), headers);
    return;
  }
  const cookieNonce = String(req.headers.cookie ?? '').split(/;\s*/).find(c => c.startsWith(`${NONCE_COOKIE}=`))?.slice(NONCE_COOKIE.length + 1) ?? '';
  if (req.method === 'GET') {
    const nonce = randomBytes(18).toString('base64url');
    send(res, 200, String(publicInfoForm({ request, nonce })),
      { ...headers, 'Set-Cookie': `${NONCE_COOKIE}=${nonce}; Path=/vendor-info/; HttpOnly; SameSite=Strict; Max-Age=3600${secure ? '; Secure' : ''}` });
    return;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const ip = clientIp(req, env);
  const now = Date.now();
  if (tooMany(`ip:${ip}`, 20, now) || tooMany(`link:${request.request_id}`, 10, now)) {
    throw new HttpError(429, 'Too many tries. Wait a few minutes and try again.');
  }
  const params = await readForm(req);
  const sentNonce = String(params.get('nonce') ?? '');
  if (!sentNonce || sentNonce !== cookieNonce) throw new HttpError(403, 'This form expired. Open the link again.');
  const fields = Object.fromEntries(params);
  try {
    await submitInfoRequest(pool, { token, fields, key: settingsKey(env) });
    send(res, 200, String(publicMessage({ title: 'Thank you', message: `Your details were sent to ${request.entity_name}. You can close this page.` })), headers);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const keep = { ...fields, taxId: '', bankRouting: '', bankAccount: '', bankAccount2: '' };
    send(res, 422, String(publicInfoForm({ request, nonce: sentNonce, v: keep, error: error.message })), headers);
  }
}
