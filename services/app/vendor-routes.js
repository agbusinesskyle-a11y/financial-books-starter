import { HttpError, idParam } from './http.js';
import { ValidationError, listTerms } from '../../lib/data/writes.js';
import {
  listVendors, vendorSummaryBar, getVendor, vendorRouting, saveVendor, setVendorsActive, mergeVendors, mergeCounts, listVendorActivity,
  vendorChoices, previewVendorImport, importVendors, IMPORT_HEADERS, markBankVerified,
} from '../../lib/data/vendors.js';
import { listDocuments, addDocument } from '../../lib/data/documents.js';
import { accountsOfTypes } from '../../lib/data/ledger.js';
import { deliver } from '../../lib/data/messages.js';
import { settingsKey } from '../../lib/secrets.js';
import { formatAddress } from '../../lib/domain/vendors.js';
import {
  vendorsPage, vendorPage, vendorForm, vendorToValues, vendorFormValues, NEW_VENDOR_VALUES, mergePage, importPage, batchEmailPage, VENDOR_TABS,
} from '../../lib/views/vendors.js';
import { vendorTxnData, vendorTxnRoutes } from './vendor-txn-routes.js';
import { partyCurrencyChoices } from '../../lib/data/currencies.js';
import { vendorAutoRoutes } from './vendor-auto-routes.js';
import { listTemplates } from '../../lib/data/recurring.js';
import { latestRequest } from '../../lib/data/vendor-info.js';
import { vendorRecurringList, pendingRequestBanner } from '../../lib/views/vendor-auto.js';
import { writeVendorDoc } from '../../lib/data/payables.js';
import { systemAccounts } from '../../lib/data/ledger.js';
import { parseMoney } from '../../lib/domain/money.js';
import { isIsoDate } from '../../lib/domain/dates.js';

export const VENDOR_UPLOAD_PATH = /^\/vendors\/(\d{1,18}\/documents|import)$/;
const EXPENSE_TYPES = ['expense', 'other_expense', 'cost_of_goods_sold', 'fixed_asset', 'other_asset', 'other_current_asset', 'inventory'];
const BATCH_MAX = 200;

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

// h: the request helpers from the app (see index.js). Returns true when the request was handled.
export async function vendorRoutes(h) {
  const { req, path, query, form, files, ctx, scope, pool, env, page, base, go, takeFlash, actor, send, res, extra } = h;
  if (await vendorTxnRoutes(h)) return true;
  if (await vendorAutoRoutes(h)) return true;
  let m;
  const key = () => settingsKey(env);
  const filtersFrom = q => ({
    search: String(q.q ?? '').slice(0, 100), show: ['overdue', 'open', 'paid', 'po', 'contractors'].includes(q.show) ? q.show : '',
    sort: ['name', 'company', 'balance'].includes(q.sort) ? q.sort : 'name', dir: q.dir === 'desc' ? 'desc' : 'asc',
    inactive: q.inactive === '1', page: Math.min(100_000, Math.max(1, Number.parseInt(q.page, 10) || 1)), size: Number(q.size) || 50,
  });
  const loadVendor = async id => (await getVendor(pool, { ...scope, vendorId: id, today: ctx.today })) ?? (() => { throw new HttpError(404, 'Vendor not found'); })();
  const formLists = async (vendorId = null) => ({ ...(await baseLists()), cur: await partyCurrencyChoices(pool, { ...scope, table: 'vendor', id: vendorId }) });
  const baseLists = async () => {
    const [terms, expenseAccounts] = await Promise.all([listTerms(pool, scope), accountsOfTypes(pool, { ...scope, types: EXPENSE_TYPES })]);
    return { terms, expenseAccounts, hasKey: Boolean(key()) };
  };

  // ---- list ----
  if (path === '/vendors' && req.method === 'GET') {
    const f = filtersFrom(query);
    const [bar, list] = await Promise.all([vendorSummaryBar(pool, { ...scope, today: ctx.today }),
      listVendors(pool, { ...scope, today: ctx.today, search: f.search, sort: f.sort, dir: f.dir, includeInactive: f.inactive, show: f.show, page: f.page, pageSize: f.size })]);
    page(vendorsPage({ ...base(), flash: takeFlash(), bar, list, filters: f }));
    return true;
  }
  if (path === '/vendors.csv' && req.method === 'GET') {
    const f = filtersFrom(query);
    const { rows } = await listVendors(pool, { ...scope, today: ctx.today, search: f.search, show: f.show, includeInactive: f.inactive, pageSize: 300, sort: 'name' });
    const lines = [['Vendor', 'Company', 'Email', 'Phone', 'Address', '1099 tracking', 'Open balance', 'Overdue', 'Active'].join(',')];
    for (const v of rows) {
      lines.push([v.display_name, v.company_name, v.email, v.phone, formatAddress(v.billing_address), v.track_1099 ? 'Yes' : 'No',
        (v.open_cents / 100).toFixed(2), (v.overdue_cents / 100).toFixed(2), v.active ? 'Yes' : 'No'].map(csvCell).join(','));
    }
    send(res, 200, `${lines.join('\r\n')}\r\n`, { ...extra, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="vendors-${ctx.today}.csv"` });
    return true;
  }

  // ---- create ----
  if (path === '/vendors/new' && req.method === 'GET') {
    page(vendorForm({ ...base(), ...(await formLists()), v: { ...NEW_VENDOR_VALUES } }));
    return true;
  }
  if (path === '/vendors' && req.method === 'POST') {
    const v = vendorFormValues(form);
    try {
      const opening = String(form.get('openingBalance') ?? '').trim();
      const asOf = String(form.get('openingAsOf') ?? '').trim() || ctx.today;
      let openingCents = 0;
      if (opening) {
        openingCents = parseMoney(opening) ?? (() => { throw new ValidationError('Opening balance should be an amount like 1250.00.'); })();
        if (!isIsoDate(asOf)) throw new ValidationError('Enter the date the opening balance is as of.');
      }
      const afterCreate = openingCents > 0 ? async (tx, vendorId) => {
        const sys = await systemAccounts(tx, ctx.orgId, ctx.entityId);
        await writeVendorDoc(tx, { ...scope, actor, type: 'bill', vendorId, txnDate: asOf, docNumber: 'Opening balance', systemKind: 'opening_balance',
          categoryLines: [{ accountId: sys.opening_equity, description: 'Opening balance', amount: (openingCents / 100).toFixed(2) }] });
      } : null;
      const id = await saveVendor(pool, { ...scope, fields: v, key: key(), actor, afterCreate });
      go(`/vendors/${id}`, 'ok', `Vendor ${v.displayName.trim()} created.`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      page(vendorForm({ ...base(), ...(await formLists()), v: { ...v, bankRouting: '', bankAccount: '', taxId: '' }, error: error.message }), 422);
    }
    return true;
  }

  // ---- import ----
  if (path === '/vendors/import') {
    const headers = IMPORT_HEADERS;
    if (req.method === 'GET') { page(importPage({ ...base(), headers })); return true; }
    const upload = files.find(f => f.field === 'file' && f.data.length);
    const csv = upload ? upload.data.toString('utf8') : String(form.get('csv') ?? '');
    if (csv.length > 2_000_000) throw new HttpError(413, 'That file is too large to import.');
    try {
      if (form.get('step') === 'import') {
        const { created, skipped } = await importVendors(pool, { ...scope, csv, actor });
        go('/vendors', 'ok', `${created} vendor${created === 1 ? '' : 's'} imported${skipped ? `; ${skipped} row${skipped === 1 ? '' : 's'} skipped` : ''}.`);
        return true;
      }
      if (!csv.trim()) throw new ValidationError('Choose a CSV file or paste the rows.');
      page(importPage({ ...base(), headers, csv, preview: await previewVendorImport(pool, { ...scope, csv }) }));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      page(importPage({ ...base(), headers, csv, error: error.message }), 422);
    }
    return true;
  }

  // ---- batch ----
  if (path === '/vendors/batch' && req.method === 'POST') {
    const ids = [...new Set(form.getAll('ids').map(idParam).filter(Boolean))].slice(0, BATCH_MAX);
    if (!ids.length) { go('/vendors', 'error', 'Select at least one vendor.'); return true; }
    if (form.get('action') === 'inactive') {
      const n = await setVendorsActive(pool, { ...scope, vendorIds: ids, active: false, actor });
      go('/vendors', 'ok', `${n} vendor${n === 1 ? '' : 's'} made inactive.`);
      return true;
    }
    if (form.get('action') === 'email') {
      const all = await vendorChoices(pool, { ...scope, includeInactive: true });
      page(batchEmailPage({ ...base(), vendors: all.filter(v => ids.includes(v.vendor_id)) }));
      return true;
    }
    throw new HttpError(400, 'Unknown batch action');
  }
  if (path === '/vendors/email' && req.method === 'POST') {
    const ids = [...new Set(form.getAll('ids').map(idParam).filter(Boolean))].slice(0, BATCH_MAX);
    const all = await vendorChoices(pool, { ...scope, includeInactive: true });
    const vendors = all.filter(v => ids.includes(v.vendor_id));
    const v = { subject: String(form.get('subject') ?? '').trim().slice(0, 200), body: String(form.get('body') ?? '').trim().slice(0, 20000) };
    if (!v.subject || !v.body) { page(batchEmailPage({ ...base(), vendors, v, error: 'Add a subject and a message.' }), 422); return true; }
    const mailer = await h.companyMailer();
    const counts = { sent: 0, logged: 0, failed: 0 };
    for (const x of vendors.filter(y => y.email)) {
      counts[await deliver(pool, mailer, { orgId: ctx.orgId, vendorId: x.vendor_id, to: x.email, subject: v.subject, text: v.body, actor,
        activityKind: 'email_sent', activitySummary: `Email “${v.subject}”` })] += 1;
    }
    const parts = [counts.sent && `${counts.sent} emailed`, counts.logged && `${counts.logged} recorded (email isn’t set up in Settings → Email)`,
      counts.failed && `${counts.failed} failed`].filter(Boolean);
    go('/vendors', counts.failed ? 'error' : 'ok', `${parts.join(', ') || 'Nobody to email'}.`);
    return true;
  }

  // ---- one vendor ----
  m = /^\/vendors\/(\d{1,18})(\/edit|\/merge|\/active|\/inactive|\/documents|\/bank-verified)?$/.exec(path);
  if (!m) return false;
  const vendor = await loadVendor(Number(m[1]));
  const id = vendor.vendor_id;

  if (!m[2] && req.method === 'GET') {
    const tab = VENDOR_TABS.some(([k]) => k === query.tab) ? query.tab : 'transactions';
    await showVendor(vendor, tab);
    return true;
  }
  if (m[2] === '/edit' && req.method === 'GET') {
    page(vendorForm({ ...base(), ...(await formLists(vendor.vendor_id)), vendor, v: vendorToValues(vendor) }));
    return true;
  }
  if (!m[2] && req.method === 'POST') {
    const v = vendorFormValues(form);
    try {
      await saveVendor(pool, { ...scope, vendorId: id, fields: v, key: key(), actor });
      go(`/vendors/${id}?tab=details`, 'ok', 'Vendor saved.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      page(vendorForm({ ...base(), ...(await formLists(vendor.vendor_id)), vendor, v: { ...v, bankRouting: '', bankAccount: '', taxId: '' }, error: error.message }), 422);
    }
    return true;
  }
  if (m[2] === '/bank-verified' && req.method === 'POST') {
    await markBankVerified(pool, { ...scope, vendorId: id, actor });
    go(`/vendors/${id}`, 'ok', 'Bank details marked as confirmed.');
    return true;
  }
  if ((m[2] === '/active' || m[2] === '/inactive') && req.method === 'POST') {
    await setVendorsActive(pool, { ...scope, vendorIds: [id], active: m[2] === '/active', actor });
    go(`/vendors/${id}`, 'ok', `${vendor.display_name} is now ${m[2] === '/active' ? 'active' : 'inactive'}.`);
    return true;
  }
  if (m[2] === '/merge') {
    const show = async (error = null, status = 200) => page(mergePage({ ...base(), vendor, error,
      choices: await vendorChoices(pool, { ...scope, includeInactive: true }), counts: await mergeCounts(pool, { orgId: ctx.orgId, vendorId: id }) }), status);
    if (req.method === 'GET') { await show(); return true; }
    try {
      const into = idParam(form.get('into')) ?? (() => { throw new ValidationError('Choose the vendor to keep.'); })();
      const r = await mergeVendors(pool, { ...scope, fromId: id, intoId: into, actor });
      go(`/vendors/${into}?tab=activity`, 'ok', `${r.from.display_name} merged into ${r.into.display_name}.`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await show(error.message, 422);
    }
    return true;
  }
  if (m[2] === '/documents' && req.method === 'POST') {
    try {
      await addDocument(pool, { ...scope, vendorId: id, txnId: idParam(form.get('txn_id')), file: files.find(f => f.field === 'file'), note: form.get('note'), actor });
      go(`/vendors/${id}?tab=documents`, 'ok', 'Document added.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await showVendor(vendor, 'documents', { uploadError: error.message }, 422);
    }
    return true;
  }
  throw new HttpError(405, 'Method not allowed');

  async function showVendor(v, tab, more = {}, status = 200) {
    const [activity, documents, txnChoices, txnData, templates, request] = await Promise.all([
      tab === 'activity' ? listVendorActivity(pool, { orgId: ctx.orgId, vendorId: v.vendor_id }) : [],
      tab === 'documents' ? listDocuments(pool, { orgId: ctx.orgId, vendorId: v.vendor_id }) : [],
      tab === 'documents' ? pool.query(
        `SELECT txn_id, type, doc_number, payment_ref, txn_date FROM txn WHERE org_id = $1 AND vendor_id = $2 ORDER BY txn_date DESC, txn_id DESC LIMIT 200`,
        [ctx.orgId, v.vendor_id]).then(r => r.rows) : [],
      vendorTxnData(h, v, tab),
      tab === 'recurring' ? listTemplates(pool, { orgId: ctx.orgId, vendorId: v.vendor_id }) : [],
      latestRequest(pool, { orgId: ctx.orgId, vendorId: v.vendor_id }),
    ]);
    page(vendorPage({ ...base(), flash: takeFlash(), timeZone: ctx.timeZone, today: ctx.today, vendor: v, tab, routing: vendorRouting(v, key()),
      activity, documents, txnChoices, ...txnData, templates, recurringTab: vendorRecurringList,
      pendingRequest: pendingRequestBanner({ vendor: v, request }), ...more }), status);
  }
}
